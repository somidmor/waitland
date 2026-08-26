#!/usr/bin/env node

/**
 * Retargets a Meshy Prime Text-to-Motion FBX clip onto Waitland's compact
 * production skeleton, then appends the result to the optimized v1 GLB.
 *
 * The GLB is extended at the binary-container level so its WebP texture,
 * quantized geometry, materials, skin, and existing clips remain byte-for-byte
 * unchanged. Only new animation accessors/buffer views are appended.
 *
 * Usage:
 *   node scripts/build-waitlander-v2.mjs
 *   node scripts/build-waitlander-v2.mjs --candidate overarm --output path.glb
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

import {
  AnimationMixer,
  Box3,
  LoadingManager,
  LoopOnce,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  assertStrictAnimationInputs,
  parseRuntimeGlbBuffer,
} from "./lib/runtime-glb-validation.mjs";

const ROOT = process.cwd();
const DEFAULT_BASE = "public/assets/avatars/v1/waitlander-runtime.glb";
const DEFAULT_OUTPUT = "public/assets/avatars/v2/waitlander-runtime.glb";
const DEFAULT_QA_DIR = "meshy_output/motion-retarget";
const CLIP_NAME = "Waitland_Professional_Overarm_Throw";

const CANDIDATES = {
  overarm: {
    file: "meshy_output/20260825_163352_professional-overarm-stone-thr_01a03b45/overarm-throw-prime.fbx",
    taskId: "01a03b45-3acb-7c02-a091-eeacf1de344a",
    description: "right-handed overarm stone throw",
  },
  underarm: {
    file: "meshy_output/20260825_163352_professional-two-hand-underarm_01a03b45/underarm-toss-prime.fbx",
    taskId: "01a03b45-3f77-7c04-9a6d-ed6ce1a550b0",
    description: "two-handed underarm stone toss",
  },
  chest: {
    file: "meshy_output/20260825_163352_professional-two-hand-chest-st_01a03b45/chest-throw-prime.fbx",
    taskId: "01a03b45-443e-7c07-b3ff-800d0d51ff59",
    description: "two-handed chest stone throw",
  },
};

// Waitland intentionally ships a compact hand-less game rig. Finger motion is
// discarded, while every gameplay-relevant joint is mapped explicitly.
const BONE_MAP = [
  ["Hips", "Pelvis"],
  ["LeftUpLeg", "L_Hip"],
  ["LeftLeg", "L_Knee"],
  ["LeftFoot", "L_Ankle"],
  ["LeftToeBase", "L_Foot"],
  ["RightUpLeg", "R_Hip"],
  ["RightLeg", "R_Knee"],
  ["RightFoot", "R_Ankle"],
  ["RightToeBase", "R_Foot"],
  ["Spine02", "Spine1"],
  ["Spine01", "Spine2"],
  ["Spine", "Spine3"],
  ["LeftShoulder", "L_Collar"],
  ["LeftArm", "L_Shoulder"],
  ["LeftForeArm", "L_Elbow"],
  ["LeftHand", "L_Wrist"],
  ["RightShoulder", "R_Collar"],
  ["RightArm", "R_Shoulder"],
  ["RightForeArm", "R_Elbow"],
  ["RightHand", "R_Wrist"],
  ["neck", "Neck"],
  ["Head", "Head"],
];

const SKELETON_EDGES = [
  ["Hips", "LeftUpLeg"],
  ["LeftUpLeg", "LeftLeg"],
  ["LeftLeg", "LeftFoot"],
  ["LeftFoot", "LeftToeBase"],
  ["Hips", "RightUpLeg"],
  ["RightUpLeg", "RightLeg"],
  ["RightLeg", "RightFoot"],
  ["RightFoot", "RightToeBase"],
  ["Hips", "Spine02"],
  ["Spine02", "Spine01"],
  ["Spine01", "Spine"],
  ["Spine", "neck"],
  ["neck", "Head"],
  ["Spine", "LeftShoulder"],
  ["LeftShoulder", "LeftArm"],
  ["LeftArm", "LeftForeArm"],
  ["LeftForeArm", "LeftHand"],
  ["Spine", "RightShoulder"],
  ["RightShoulder", "RightArm"],
  ["RightArm", "RightForeArm"],
  ["RightForeArm", "RightHand"],
];

function parseArgs(argv) {
  const args = {
    candidate: "overarm",
    base: DEFAULT_BASE,
    output: DEFAULT_OUTPUT,
    qaDir: DEFAULT_QA_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--candidate" || flag === "--base" || flag === "--output" || flag === "--qa-dir") {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const key = flag === "--qa-dir" ? "qaDir" : flag.slice(2);
      args[key] = value;
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log("Usage: node scripts/build-waitlander-v2.mjs [--candidate overarm|underarm|chest] [--base FILE] [--output FILE] [--qa-dir DIR]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!CANDIDATES[args.candidate]) {
    throw new Error(`Unknown candidate '${args.candidate}'. Choose: ${Object.keys(CANDIDATES).join(", ")}`);
  }
  return args;
}

function absolute(file) {
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`${label} not found: ${file}`);
  }
}

// FBXLoader discovers embedded image blobs even though the motion textures are
// irrelevant. A no-op loader keeps this offline build independent of the DOM.
class DummyTextureLoader {
  constructor() {
    this.path = "";
  }

  setPath(value) {
    this.path = value;
    return this;
  }

  load() {
    return new Texture();
  }
}

function createFbxLoader() {
  globalThis.window ??= globalThis;
  const manager = new LoadingManager();
  manager.addHandler(/\.(png|jpe?g|webp|tga)$/i, new DummyTextureLoader());
  return new FBXLoader(manager);
}

async function loadFbx(file) {
  const data = fs.readFileSync(file);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return createFbxLoader().parse(arrayBuffer, "");
}

async function loadGlbForSkeleton(file) {
  // GLTFLoader only needs image dimensions while parsing this offline asset.
  // The original encoded WebP remains untouched because output is assembled
  // directly from the GLB chunks rather than exported through a canvas.
  globalThis.self ??= globalThis;
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
  const data = fs.readFileSync(file);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });
}

function collectNamed(root, name) {
  const matches = [];
  root.traverse((node) => {
    if (node.name === name) matches.push(node);
  });
  return matches;
}

function findOuterSourceBone(root, name) {
  const matches = collectNamed(root, name).filter((node) => node.isBone);
  const outer = matches.find((node) => node.parent?.name !== name);
  if (!outer) throw new Error(`Source bone '${name}' was not found`);
  return outer;
}

function findTargetBone(scene, name) {
  const matches = collectNamed(scene, name).filter((node) => node.isBone);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one target bone '${name}', found ${matches.length}`);
  }
  return matches[0];
}

function cloneRestPose(targetScene, targetBones) {
  targetScene.updateMatrixWorld(true);
  return new Map(
    targetBones.map((bone) => [
      bone.name,
      {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
        worldQuaternion: bone.getWorldQuaternion(new Quaternion()),
      },
    ]),
  );
}

function restoreTargetPose(targetScene, targetBones, restPose) {
  for (const bone of targetBones) {
    const rest = restPose.get(bone.name);
    bone.position.copy(rest.position);
    bone.quaternion.copy(rest.quaternion);
    bone.scale.copy(rest.scale);
  }
  targetScene.updateMatrixWorld(true);
}

function mappedChainLength(bones, names) {
  return names.slice(1).reduce((sum, name) => sum + bones.get(name).position.length(), 0);
}

function computeMotionScale(targetBones, sourceBones) {
  const targetLeft = mappedChainLength(targetBones, ["Hips", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"]);
  const targetRight = mappedChainLength(targetBones, ["Hips", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]);
  const sourceLeft = mappedChainLength(sourceBones, ["Pelvis", "L_Hip", "L_Knee", "L_Ankle", "L_Foot"]);
  const sourceRight = mappedChainLength(sourceBones, ["Pelvis", "R_Hip", "R_Knee", "R_Ankle", "R_Foot"]);
  return ((targetLeft / sourceLeft) + (targetRight / sourceRight)) / 2;
}

function ensureQuaternionContinuity(previous, current) {
  if (previous && previous.dot(current) < 0) {
    current.set(-current.x, -current.y, -current.z, -current.w);
  }
  return current;
}

function vecToArray(vector, digits = 6) {
  return vector.toArray().map((value) => Number(value.toFixed(digits)));
}

function strictSampleTimesForClip(clip) {
  const sourceTimes = clip.tracks.reduce((best, track) => (
    track.times.length > best.length ? track.times : best
  ), new Float32Array());
  const sampleTimes = [];
  let previous = -Infinity;
  for (const time of sourceTimes) {
    if (!Number.isFinite(time)) {
      throw new Error(`Motion clip '${clip.name}' contains a non-finite sample time`);
    }
    if (time < previous) {
      throw new Error(`Motion clip '${clip.name}' contains out-of-order sample times`);
    }
    // Meshy FBX exports can repeat an identical key at a frame boundary. The
    // values are sampled through AnimationMixer, so one copy preserves the pose
    // while keeping the exported glTF accessor strictly increasing.
    if (time > previous) sampleTimes.push(time);
    previous = time;
  }
  if (sampleTimes.length < 2) throw new Error("Motion clip has fewer than two unique samples");
  return Float32Array.from(sampleTimes);
}

function analyzeSourceClip(sourceRoot, sourceBones, clip) {
  const mixer = new AnimationMixer(sourceRoot);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const sampleTimes = strictSampleTimesForClip(clip);
  const pelvis = sourceBones.get("Pelvis");
  const leftWrist = sourceBones.get("L_Wrist");
  const rightWrist = sourceBones.get("R_Wrist");
  const pelvisPositions = [];
  const leftRelative = [];
  const rightRelative = [];

  for (const time of sampleTimes) {
    mixer.setTime(time);
    sourceRoot.updateMatrixWorld(true);
    const pelvisPosition = pelvis.getWorldPosition(new Vector3());
    pelvisPositions.push(pelvisPosition.clone());
    leftRelative.push(leftWrist.getWorldPosition(new Vector3()).sub(pelvisPosition));
    rightRelative.push(rightWrist.getWorldPosition(new Vector3()).sub(pelvisPosition));
  }

  const start = pelvisPositions[0];
  const end = pelvisPositions.at(-1);
  const horizontalDisplacement = new Vector3(end.x - start.x, 0, end.z - start.z);

  function peakSpeed(samples) {
    let peak = { speed: 0, time: 0 };
    for (let index = 1; index < samples.length; index += 1) {
      const deltaTime = sampleTimes[index] - sampleTimes[index - 1];
      const speed = samples[index].distanceTo(samples[index - 1]) / deltaTime;
      if (speed > peak.speed) peak = { speed, time: sampleTimes[index] };
    }
    return peak;
  }

  const handSeparation = leftRelative.map((left, index) => left.distanceTo(rightRelative[index]));
  const rightHeight = rightRelative.map((position) => position.y);
  const leftHeight = leftRelative.map((position) => position.y);
  const rightPeak = peakSpeed(rightRelative);
  const leftPeak = peakSpeed(leftRelative);

  mixer.stopAllAction();
  return {
    durationSeconds: clip.duration,
    frames: sampleTimes.length,
    tracks: clip.tracks.length,
    scaleTracks: clip.tracks.filter((track) => track.name.endsWith(".scale")).length,
    horizontalRootTravelCm: Number(horizontalDisplacement.length().toFixed(3)),
    rootTravelVectorCm: vecToArray(horizontalDisplacement, 3),
    rightHandPeakSpeedCmPerSecond: Number(rightPeak.speed.toFixed(3)),
    rightHandPeakSpeedAtSeconds: Number(rightPeak.time.toFixed(3)),
    leftHandPeakSpeedCmPerSecond: Number(leftPeak.speed.toFixed(3)),
    leftHandPeakSpeedAtSeconds: Number(leftPeak.time.toFixed(3)),
    minimumHandSeparationCm: Number(Math.min(...handSeparation).toFixed(3)),
    maximumHandSeparationCm: Number(Math.max(...handSeparation).toFixed(3)),
    rightHandHeightRangeCm: [Math.min(...rightHeight), Math.max(...rightHeight)].map((value) => Number(value.toFixed(3))),
    leftHandHeightRangeCm: [Math.min(...leftHeight), Math.max(...leftHeight)].map((value) => Number(value.toFixed(3))),
  };
}

function retargetClip({ targetScene, sourceRoot, clip }) {
  const targetBones = new Map(BONE_MAP.map(([target]) => [target, findTargetBone(targetScene, target)]));
  const sourceBones = new Map(BONE_MAP.map(([, source]) => [source, findOuterSourceBone(sourceRoot, source)]));
  const targetRest = cloneRestPose(targetScene, [...targetBones.values()]);

  sourceRoot.updateMatrixWorld(true);
  const sourceRestWorld = new Map(
    [...sourceBones.entries()].map(([name, bone]) => [name, bone.getWorldQuaternion(new Quaternion())]),
  );

  const motionScale = computeMotionScale(targetBones, sourceBones);
  const sampleTimes = strictSampleTimesForClip(clip);

  const rotations = new Map(BONE_MAP.map(([target]) => [target, new Float32Array(sampleTimes.length * 4)]));
  const rootTranslations = new Float32Array(sampleTimes.length * 3);
  const poseFrames = [];
  const previousQuaternions = new Map();
  const mixer = new AnimationMixer(sourceRoot);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const sourcePelvis = sourceBones.get("Pelvis");
  let sourceStartPosition;

  for (let frame = 0; frame < sampleTimes.length; frame += 1) {
    mixer.setTime(sampleTimes[frame]);
    sourceRoot.updateMatrixWorld(true);
    const sourcePelvisPosition = sourcePelvis.getWorldPosition(new Vector3());
    sourceStartPosition ??= sourcePelvisPosition.clone();

    restoreTargetPose(targetScene, [...targetBones.values()], targetRest);
    const targetHips = targetBones.get("Hips");
    const targetHipsRest = targetRest.get("Hips");
    // Deliberately retain only vertical bounce/crouch. Gameplay owns X/Z.
    targetHips.position.set(
      targetHipsRest.position.x,
      targetHipsRest.position.y + (sourcePelvisPosition.y - sourceStartPosition.y) * motionScale,
      targetHipsRest.position.z,
    );
    targetScene.updateMatrixWorld(true);

    for (const [targetName, sourceName] of BONE_MAP) {
      const targetBone = targetBones.get(targetName);
      const sourceBone = sourceBones.get(sourceName);
      const sourceAnimatedWorld = sourceBone.getWorldQuaternion(new Quaternion());
      const sourceRestInverse = sourceRestWorld.get(sourceName).clone().invert();
      const worldDelta = sourceAnimatedWorld.multiply(sourceRestInverse);
      const desiredWorld = worldDelta.multiply(targetRest.get(targetName).worldQuaternion);
      const parentWorldInverse = targetBone.parent.getWorldQuaternion(new Quaternion()).invert();
      const local = ensureQuaternionContinuity(
        previousQuaternions.get(targetName),
        parentWorldInverse.multiply(desiredWorld).normalize(),
      );
      targetBone.quaternion.copy(local);
      previousQuaternions.set(targetName, local.clone());
      targetBone.updateMatrixWorld(true);
      local.toArray(rotations.get(targetName), frame * 4);
    }

    targetHips.position.toArray(rootTranslations, frame * 3);
    targetScene.updateMatrixWorld(true);
    const positions = {};
    for (const [targetName] of BONE_MAP) {
      positions[targetName] = vecToArray(targetBones.get(targetName).getWorldPosition(new Vector3()));
    }
    poseFrames.push(positions);
  }

  mixer.stopAllAction();
  restoreTargetPose(targetScene, [...targetBones.values()], targetRest);
  return {
    duration: sampleTimes.at(-1),
    times: sampleTimes,
    rotations,
    rootTranslations,
    poseFrames,
    motionScale,
  };
}

function parseGlb(file) {
  const parsed = parseRuntimeGlbBuffer(fs.readFileSync(file), file);
  if (!parsed.binary) throw new Error(`${file} is missing its BIN chunk`);
  return parsed;
}

function encodeFloat32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index], index * 4);
  }
  return buffer;
}

function pad4(buffer, byte = 0) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, byte)]);
}

function appendAnimationToGlb(baseFile, outputFile, animation, candidate) {
  const parsed = parseGlb(baseFile);
  const json = structuredClone(parsed.json);
  json.bufferViews ??= [];
  json.accessors ??= [];
  json.animations ??= [];
  json.animations = json.animations.filter((item) => item.name !== CLIP_NAME);

  const declaredLength = json.buffers[0].byteLength;
  let binary = pad4(parsed.binary.subarray(0, declaredLength));

  function addAccessor(values, type, includeRange = false) {
    const data = encodeFloat32(values);
    const byteOffset = binary.length;
    binary = Buffer.concat([binary, data]);
    const bufferView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length });
    const itemSize = type === "SCALAR" ? 1 : Number(type.slice(3));
    const accessor = {
      bufferView,
      componentType: 5126,
      count: values.length / itemSize,
      type,
    };
    if (includeRange) {
      accessor.min = [Math.min(...values)];
      accessor.max = [Math.max(...values)];
    }
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  }

  const timeAccessor = addAccessor(animation.times, "SCALAR", true);
  const nodeByName = new Map(json.nodes.map((node, index) => [node.name, index]));
  const samplers = [];
  const channels = [];

  function addChannel(targetName, targetPath, values, type) {
    const node = nodeByName.get(targetName);
    if (node === undefined) throw new Error(`GLB node '${targetName}' was not found`);
    const sampler = samplers.length;
    samplers.push({ input: timeAccessor, output: addAccessor(values, type), interpolation: "LINEAR" });
    channels.push({ sampler, target: { node, path: targetPath } });
  }

  addChannel("Hips", "translation", animation.rootTranslations, "VEC3");
  for (const [targetName] of BONE_MAP) {
    addChannel(targetName, "rotation", animation.rotations.get(targetName), "VEC4");
  }

  json.animations.push({
    name: CLIP_NAME,
    samplers,
    channels,
    extras: {
      generator: "scripts/build-waitlander-v2.mjs",
      source: "Meshy Text-to-Motion Prime",
      sourceTaskId: candidate.taskId,
      sourceDescription: candidate.description,
      retarget: "bind-pose global rotation delta",
      horizontalRootMotion: "removed",
      scaleTracks: "removed; canonical bind scale preserved",
    },
  });

  binary = pad4(binary);
  json.buffers[0].byteLength = binary.length;
  const jsonBuffer = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const totalLength = 12 + 8 + jsonBuffer.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, Buffer.concat([header, jsonHeader, jsonBuffer, binaryHeader, binary]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function writePng(file, width, height, rgba) {
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function putPixel(image, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
  image[offset] = color[0];
  image[offset + 1] = color[1];
  image[offset + 2] = color[2];
  image[offset + 3] = color[3] ?? 255;
}

function drawDisc(image, width, height, x, y, radius, color) {
  for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py += 1) {
    for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px += 1) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) {
        putPixel(image, width, height, px, py, color);
      }
    }
  }
}

function drawLine(image, width, height, x0, y0, x1, y1, color, thickness = 3) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let step = 0; step <= steps; step += 1) {
    const amount = step / steps;
    drawDisc(
      image,
      width,
      height,
      x0 + (x1 - x0) * amount,
      y0 + (y1 - y0) * amount,
      thickness / 2,
      color,
    );
  }
}

function fillRect(image, width, height, x, y, rectWidth, rectHeight, color) {
  for (let py = y; py < y + rectHeight; py += 1) {
    for (let px = x; px < x + rectWidth; px += 1) putPixel(image, width, height, px, py, color);
  }
}

function renderCandidatePreview(file, candidates) {
  const columns = 10;
  const cellWidth = 112;
  const cellHeight = 172;
  const width = columns * cellWidth;
  const height = candidates.length * 2 * cellHeight;
  const image = Buffer.alloc(width * height * 4);
  fillRect(image, width, height, 0, 0, width, height, [247, 239, 219, 255]);
  const colors = [
    [151, 75, 37, 255],
    [42, 101, 89, 255],
    [99, 76, 129, 255],
  ];

  candidates.forEach((candidate, candidateIndex) => {
    const indices = Array.from({ length: columns }, (_, index) => (
      Math.round((candidate.animation.poseFrames.length - 1) * index / (columns - 1))
    ));
    for (let viewIndex = 0; viewIndex < 2; viewIndex += 1) {
      const row = candidateIndex * 2 + viewIndex;
      const background = viewIndex === 0 ? [242, 227, 198, 255] : [232, 222, 199, 255];
      fillRect(image, width, height, 0, row * cellHeight, width, cellHeight, background);
      for (let column = 0; column < columns; column += 1) {
        const frame = candidate.animation.poseFrames[indices[column]];
        const centerX = column * cellWidth + cellWidth / 2;
        const floorY = row * cellHeight + cellHeight - 11;
        const scale = 142;
        const project = (name) => {
          const position = frame[name];
          return [centerX + position[viewIndex === 0 ? 0 : 2] * scale, floorY - position[1] * scale];
        };
        drawLine(image, width, height, column * cellWidth + 5, floorY, (column + 1) * cellWidth - 5, floorY, [186, 161, 117, 255], 1);
        for (const [from, to] of SKELETON_EDGES) {
          const start = project(from);
          const end = project(to);
          drawLine(image, width, height, start[0], start[1], end[0], end[1], colors[candidateIndex], 3);
        }
        for (const name of ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot"]) {
          const point = project(name);
          drawDisc(image, width, height, point[0], point[1], name === "Head" ? 5 : 3, [47, 38, 29, 255]);
        }
      }
    }
  });
  writePng(file, width, height, image);
}

function inspectAnimation(animation) {
  const root = animation.rootTranslations;
  const rootX = [];
  const rootY = [];
  const rootZ = [];
  for (let offset = 0; offset < root.length; offset += 3) {
    rootX.push(root[offset]);
    rootY.push(root[offset + 1]);
    rootZ.push(root[offset + 2]);
  }
  let quaternionNormRange = [Infinity, -Infinity];
  for (const values of animation.rotations.values()) {
    for (let offset = 0; offset < values.length; offset += 4) {
      const norm = Math.hypot(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
      quaternionNormRange = [Math.min(quaternionNormRange[0], norm), Math.max(quaternionNormRange[1], norm)];
    }
  }
  const allPositions = animation.poseFrames.flatMap((frame) => Object.values(frame));
  const bounds = {
    min: [0, 1, 2].map((axis) => Math.min(...allPositions.map((position) => position[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...allPositions.map((position) => position[axis]))),
  };
  return {
    durationSeconds: animation.duration,
    frames: animation.times.length,
    exportedTracks: animation.rotations.size + 1,
    rotationTracks: animation.rotations.size,
    translationTracks: 1,
    scaleTracks: 0,
    motionScale: Number(animation.motionScale.toFixed(6)),
    rootXRange: [Math.min(...rootX), Math.max(...rootX)].map((value) => Number(value.toFixed(6))),
    rootYRange: [Math.min(...rootY), Math.max(...rootY)].map((value) => Number(value.toFixed(6))),
    rootZRange: [Math.min(...rootZ), Math.max(...rootZ)].map((value) => Number(value.toFixed(6))),
    quaternionNormRange: quaternionNormRange.map((value) => Number(value.toFixed(8))),
    jointBoundsMeters: {
      min: bounds.min.map((value) => Number(value.toFixed(6))),
      max: bounds.max.map((value) => Number(value.toFixed(6))),
    },
  };
}

async function verifyOutput({ baseFile, outputFile }) {
  const base = parseGlb(baseFile);
  const output = parseGlb(outputFile);
  const strictAnimationInputs = assertStrictAnimationInputs(output, outputFile);
  const unchanged = ["nodes", "skins", "meshes", "materials", "textures", "images"].every(
    (key) => JSON.stringify(base.json[key]) === JSON.stringify(output.json[key]),
  );
  const binaryPrefixUnchanged = output.binary.subarray(0, base.json.buffers[0].byteLength)
    .equals(base.binary.subarray(0, base.json.buffers[0].byteLength));
  if (!unchanged || !binaryPrefixUnchanged) {
    throw new Error("Base mesh/skin/material/texture data changed while appending animation");
  }

  const gltf = await loadGlbForSkeleton(outputFile);
  const clip = gltf.animations.find((animation) => animation.name === CLIP_NAME);
  if (!clip) throw new Error(`Reloaded GLB is missing '${CLIP_NAME}'`);
  const rootTrack = clip.tracks.find((track) => track.name === "Hips.position");
  if (!rootTrack) throw new Error("Reloaded professional clip is missing Hips.position");
  const xValues = [];
  const zValues = [];
  for (let offset = 0; offset < rootTrack.values.length; offset += 3) {
    xValues.push(rootTrack.values[offset]);
    zValues.push(rootTrack.values[offset + 2]);
  }
  const noHorizontalTravel = Math.max(...xValues) - Math.min(...xValues) < 1e-6
    && Math.max(...zValues) - Math.min(...zValues) < 1e-6;
  const noScaleTracks = clip.tracks.every((track) => !track.name.endsWith(".scale"));
  const finite = clip.tracks.every((track) => [...track.times, ...track.values].every(Number.isFinite));
  if (!noHorizontalTravel || !noScaleTracks || !finite) {
    throw new Error("Reloaded animation failed root-motion, scale-track, or finite-value validation");
  }

  const skinnedMeshes = [];
  gltf.scene.traverse((node) => {
    if (node.isSkinnedMesh) skinnedMeshes.push(node);
  });
  if (skinnedMeshes.length !== 1) {
    throw new Error(`Expected one skinned mesh after reload, found ${skinnedMeshes.length}`);
  }
  const skinnedMesh = skinnedMeshes[0];
  const mixer = new AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const deformedWorldBounds = new Box3();
  for (let index = 0; index <= 12; index += 1) {
    mixer.setTime(clip.duration * index / 12);
    gltf.scene.updateMatrixWorld(true);
    skinnedMesh.skeleton.update();
    skinnedMesh.computeBoundingBox();
    deformedWorldBounds.union(skinnedMesh.boundingBox.clone().applyMatrix4(skinnedMesh.matrixWorld));
  }
  const deformedSize = deformedWorldBounds.getSize(new Vector3());
  const saneDeformedBounds = [
    ...deformedWorldBounds.min.toArray(),
    ...deformedWorldBounds.max.toArray(),
    ...deformedSize.toArray(),
  ].every(Number.isFinite) && Math.max(...deformedSize.toArray()) < 5;
  if (!saneDeformedBounds) throw new Error("Reloaded animation produced invalid or exploded skinned-mesh bounds");
  return {
    loadedWithThree: true,
    clipNames: gltf.animations.map((animation) => animation.name),
    selectedClipDurationSeconds: clip.duration,
    selectedClipTracks: clip.tracks.length,
    noHorizontalRootTravel: noHorizontalTravel,
    noScaleTracks,
    finiteAnimationData: finite,
    strictlyIncreasingAnimationInputs: true,
    validatedAnimationSamplers: strictAnimationInputs.samplers,
    canonicalAssetSectionsUnchanged: unchanged,
    originalBinaryPrefixUnchanged: binaryPrefixUnchanged,
    deformedMeshBoundsMeters: {
      min: vecToArray(deformedWorldBounds.min),
      max: vecToArray(deformedWorldBounds.max),
      size: vecToArray(deformedSize),
    },
    saneDeformedMeshBounds: saneDeformedBounds,
    baseBytes: fs.statSync(baseFile).size,
    outputBytes: fs.statSync(outputFile).size,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseFile = absolute(args.base);
  const outputFile = absolute(args.output);
  const qaDir = absolute(args.qaDir);
  requireFile(baseFile, "Base runtime GLB");
  for (const candidate of Object.values(CANDIDATES)) requireFile(absolute(candidate.file), "Motion FBX");
  fs.mkdirSync(qaDir, { recursive: true });

  const targetGltf = await loadGlbForSkeleton(baseFile);
  const candidateResults = [];
  for (const [key, candidate] of Object.entries(CANDIDATES)) {
    const sourceRoot = await loadFbx(absolute(candidate.file));
    if (sourceRoot.animations.length !== 1) {
      throw new Error(`${key} FBX should contain one animation, found ${sourceRoot.animations.length}`);
    }
    const clip = sourceRoot.animations[0];
    const sourceBones = new Map(BONE_MAP.map(([, source]) => [source, findOuterSourceBone(sourceRoot, source)]));
    const sourceAnalysis = analyzeSourceClip(sourceRoot, sourceBones, clip);
    const animation = retargetClip({ targetScene: targetGltf.scene, sourceRoot, clip });
    candidateResults.push({
      key,
      taskId: candidate.taskId,
      description: candidate.description,
      source: sourceAnalysis,
      retargeted: inspectAnimation(animation),
      animation,
    });
  }

  const selected = candidateResults.find((result) => result.key === args.candidate);
  appendAnimationToGlb(baseFile, outputFile, selected.animation, CANDIDATES[args.candidate]);
  const previewFile = path.join(qaDir, "candidate-retarget-preview.png");
  renderCandidatePreview(previewFile, candidateResults);
  const verification = await verifyOutput({ baseFile, outputFile });
  const report = {
    generatedAt: new Date().toISOString(),
    selectedCandidate: selected.key,
    selectionReason: args.candidate === "overarm"
      ? "The overarm candidate is the only single-hand motion compatible with Waitland's current right-hand held-item anchor; its horizontal source travel is removed during export."
      : `The '${args.candidate}' candidate was explicitly selected with --candidate; horizontal source travel is removed during export.`,
    outputClipName: CLIP_NAME,
    baseFile: path.relative(ROOT, baseFile),
    outputFile: path.relative(ROOT, outputFile),
    previewFile: path.relative(ROOT, previewFile),
    candidates: candidateResults.map((result) => ({
      key: result.key,
      taskId: result.taskId,
      description: result.description,
      source: result.source,
      retargeted: result.retargeted,
    })),
    verification,
  };
  const reportFile = path.join(qaDir, "report.json");
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
