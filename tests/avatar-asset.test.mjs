import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { WAITLANDER_RUNTIME_MANIFEST } from "../app/avatar/waitlander-manifest.ts";

const ASSET_URL = new URL(
  "../public/assets/avatars/v1/waitlander-runtime.glb",
  import.meta.url,
);

async function readGlbJson() {
  const file = await readFile(ASSET_URL);
  assert.equal(file.subarray(0, 4).toString("ascii"), "glTF");
  assert.equal(file.readUInt32LE(4), 2, "runtime asset must use glTF 2.0");
  assert.equal(file.readUInt32LE(8), file.byteLength, "GLB length header must be exact");
  const jsonLength = file.readUInt32LE(12);
  assert.equal(file.subarray(16, 20).toString("ascii"), "JSON");
  return {
    file,
    json: JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8")),
  };
}

test("production avatar is a compact single-mesh mobile GLB", async () => {
  const { file, json } = await readGlbJson();
  assert.ok(file.byteLength < 1_100_000, "avatar must stay below the 1.1 MB budget");
  assert.equal(json.meshes?.length, 1);
  assert.equal(json.materials?.length, 1);
  assert.equal(json.images?.length, 1);
  assert.equal(json.images?.[0]?.mimeType, "image/webp");
  assert.ok(json.extensionsRequired?.includes("KHR_mesh_quantization"));
  assert.ok(json.extensionsRequired?.includes("EXT_texture_webp"));
});

test("production avatar contains the rig and all required motion clips", async () => {
  const { json } = await readGlbJson();
  const nodeNames = new Set(json.nodes?.map((node) => node.name));
  for (const bone of ["Hips", "Spine", "Head", "LeftHand", "RightHand"]) {
    assert.ok(nodeNames.has(bone), `missing humanoid bone ${bone}`);
  }

  const animationNames = json.animations?.map((animation) => animation.name) ?? [];
  assert.ok(animationNames.some((name) => /walking/i.test(name)));
  assert.ok(animationNames.some((name) => /idle/i.test(name)));
  assert.ok(animationNames.some((name) => /pick.*throw/i.test(name)));
});

function readFloatAccessor(file, json, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126, "animation accessor must contain floats");
  const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  assert.ok(componentCount);
  const binOffset = 20 + file.readUInt32LE(12) + 8;
  const stride = view.byteStride ?? componentCount * 4;
  const start = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, row) =>
    Array.from({ length: componentCount }, (_, column) =>
      file.readFloatLE(start + row * stride + column * 4),
    ),
  );
}

function nodeWorldPosition(json, nodeName) {
  const objects = json.nodes.map((node) => {
    const object = new THREE.Object3D();
    if (node.matrix) {
      object.matrix.fromArray(node.matrix);
      object.matrix.decompose(object.position, object.quaternion, object.scale);
    } else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  const childIndexes = new Set();
  json.nodes.forEach((node, index) => {
    for (const childIndex of node.children ?? []) {
      objects[index].add(objects[childIndex]);
      childIndexes.add(childIndex);
    }
  });
  objects.forEach((object, index) => {
    if (!childIndexes.has(index)) object.updateMatrixWorld(true);
  });
  const index = json.nodes.findIndex((node) => node.name === nodeName);
  assert.notEqual(index, -1, `missing node ${nodeName}`);
  return objects[index].getWorldPosition(new THREE.Vector3());
}

test("production manifest corrects the Meshy rig axis and cross-clip scale baselines", async () => {
  const { file, json } = await readGlbJson();
  const head = nodeWorldPosition(json, "Head");
  const headFront = nodeWorldPosition(json, "headfront");
  assert.ok(headFront.z - head.z > 0.1, "the authored face points along +Z");
  assert.equal(WAITLANDER_RUNTIME_MANIFEST.normalization.sourceForward, "+z");

  const hipsIndex = json.nodes.findIndex((node) => node.name === "Hips");
  const idle = json.animations.find((animation) => /idle/i.test(animation.name));
  const walk = json.animations.find((animation) => /walking/i.test(animation.name));
  assert.ok(idle);
  assert.ok(walk);
  const idleScaleChannel = idle.channels.find(
    (channel) => channel.target.node === hipsIndex && channel.target.path === "scale",
  );
  assert.ok(idleScaleChannel);
  const idleScaleValues = readFloatAccessor(
    file,
    json,
    idle.samplers[idleScaleChannel.sampler].output,
  ).flat();
  assert.ok(Math.max(...idleScaleValues) > 1.17, "idle contains the source scale mismatch");

  const hipsPositionChannel = (animation) =>
    animation.channels.find(
      (channel) => channel.target.node === hipsIndex && channel.target.path === "translation",
    );
  const idlePositionChannel = hipsPositionChannel(idle);
  const walkPositionChannel = hipsPositionChannel(walk);
  assert.ok(idlePositionChannel);
  assert.ok(walkPositionChannel);
  const idleHipsY = readFloatAccessor(
    file,
    json,
    idle.samplers[idlePositionChannel.sampler].output,
  )[0][1];
  const walkHipsY = readFloatAccessor(
    file,
    json,
    walk.samplers[walkPositionChannel.sampler].output,
  )[0][1];
  assert.ok(idleHipsY - walkHipsY > 5, "clips contain different Hips position baselines");
  assert.equal(WAITLANDER_RUNTIME_MANIFEST.animations.lockScale, true);
  assert.equal(WAITLANDER_RUNTIME_MANIFEST.animations.rebaseHips, true);
});
