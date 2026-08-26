#!/usr/bin/env node

/**
 * Minimal, dependency-free repair pass for Meshy environment GLBs.
 *
 * Geometry positions, indices, UVs, and silhouette are preserved exactly. Only
 * invalid vertex normals are replaced from adjacent triangle faces, while
 * material flags and unused texture slots are cleaned before glTF Transform's
 * prune/resize/tangent passes compact the file.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseRuntimeGlbBuffer } from "./lib/runtime-glb-validation.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

const COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};

const COMPONENT_BYTES = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function parseArgs(argv) {
  const positional = [];
  const options = { stripNormalMap: false, frontSide: false, repairTangents: false };
  for (const argument of argv) {
    if (argument === "--strip-normal-map") options.stripNormalMap = true;
    else if (argument === "--front-side") options.frontSide = true;
    else if (argument === "--repair-tangents") options.repairTangents = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option '${argument}'`);
    else positional.push(argument);
  }
  if (positional.length !== 2) {
    throw new Error(
      "Usage: node scripts/repair-environment-glb.mjs INPUT OUTPUT " +
        "[--strip-normal-map] [--front-side] [--repair-tangents]",
    );
  }
  return { input: positional[0], output: positional[1], ...options };
}

function readComponent(buffer, offset, componentType, normalized) {
  let value;
  if (componentType === 5120) value = buffer.readInt8(offset);
  else if (componentType === 5121) value = buffer.readUInt8(offset);
  else if (componentType === 5122) value = buffer.readInt16LE(offset);
  else if (componentType === 5123) value = buffer.readUInt16LE(offset);
  else if (componentType === 5125) value = buffer.readUInt32LE(offset);
  else if (componentType === 5126) value = buffer.readFloatLE(offset);
  else throw new Error(`Unsupported accessor component type ${componentType}`);
  if (!normalized) return value;
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  throw new Error(`Unsupported normalized accessor component type ${componentType}`);
}

function writeNormalizedComponent(buffer, offset, componentType, value) {
  const safe = Math.max(-1, Math.min(1, value));
  if (componentType === 5120) buffer.writeInt8(Math.round(safe * 127), offset);
  else if (componentType === 5122) buffer.writeInt16LE(Math.round(safe * 32767), offset);
  else if (componentType === 5126) buffer.writeFloatLE(safe, offset);
  else throw new Error(`Unsupported normal component type ${componentType}`);
}

function accessorReader(json, binary, accessorIndex, expectedType) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== expectedType || accessor.sparse) {
    throw new Error(`Accessor ${accessorIndex} must be a non-sparse ${expectedType}`);
  }
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) {
    throw new Error(`Accessor ${accessorIndex} must use the embedded BIN buffer`);
  }
  const itemSize = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!itemSize || !componentBytes) throw new Error(`Accessor ${accessorIndex} is unsupported`);
  const stride = view.byteStride ?? itemSize * componentBytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return {
    accessor,
    componentBytes,
    itemSize,
    read(index, component = 0) {
      return readComponent(
        binary,
        start + index * stride + component * componentBytes,
        accessor.componentType,
        accessor.normalized === true,
      );
    },
    writeNormalized(index, component, value) {
      writeNormalizedComponent(
        binary,
        start + index * stride + component * componentBytes,
        accessor.componentType,
        value,
      );
    },
  };
}

function repairPrimitiveNormals(json, binary, primitive) {
  if ((primitive.mode ?? 4) !== 4) throw new Error("Only triangle primitives are supported");
  const positions = accessorReader(json, binary, primitive.attributes.POSITION, "VEC3");
  const normals = accessorReader(json, binary, primitive.attributes.NORMAL, "VEC3");
  if (positions.accessor.count !== normals.accessor.count) {
    throw new Error("POSITION and NORMAL counts do not match");
  }
  const indices = primitive.indices === undefined
    ? undefined
    : accessorReader(json, binary, primitive.indices, "SCALAR");
  const indexCount = indices?.accessor.count ?? positions.accessor.count;
  if (indexCount % 3 !== 0) throw new Error("Triangle index count must be divisible by three");

  const sums = new Float64Array(positions.accessor.count * 3);
  const fallback = new Float64Array(positions.accessor.count * 3);
  let degenerateTriangles = 0;
  for (let offset = 0; offset < indexCount; offset += 3) {
    const a = indices ? indices.read(offset) : offset;
    const b = indices ? indices.read(offset + 1) : offset + 1;
    const c = indices ? indices.read(offset + 2) : offset + 2;
    const ax = positions.read(a, 0);
    const ay = positions.read(a, 1);
    const az = positions.read(a, 2);
    const abx = positions.read(b, 0) - ax;
    const aby = positions.read(b, 1) - ay;
    const abz = positions.read(b, 2) - az;
    const acx = positions.read(c, 0) - ax;
    const acy = positions.read(c, 1) - ay;
    const acz = positions.read(c, 2) - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length < 1e-12) {
      degenerateTriangles += 1;
      continue;
    }
    for (const index of [a, b, c]) {
      sums[index * 3] += nx;
      sums[index * 3 + 1] += ny;
      sums[index * 3 + 2] += nz;
      if (fallback[index * 3] === 0 && fallback[index * 3 + 1] === 0 && fallback[index * 3 + 2] === 0) {
        fallback[index * 3] = nx / length;
        fallback[index * 3 + 1] = ny / length;
        fallback[index * 3 + 2] = nz / length;
      }
    }
  }
  if (degenerateTriangles > 0) {
    throw new Error(
      `Found ${degenerateTriangles} degenerate triangles; remove them in the source asset before repair`,
    );
  }

  let repairedNormals = 0;
  for (let index = 0; index < normals.accessor.count; index += 1) {
    const existingLength = Math.hypot(
      normals.read(index, 0),
      normals.read(index, 1),
      normals.read(index, 2),
    );
    if (Number.isFinite(existingLength) && existingLength > 1e-6) continue;
    let nx = sums[index * 3];
    let ny = sums[index * 3 + 1];
    let nz = sums[index * 3 + 2];
    let length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length < 1e-12) {
      nx = fallback[index * 3];
      ny = fallback[index * 3 + 1];
      nz = fallback[index * 3 + 2];
      length = Math.hypot(nx, ny, nz);
    }
    if (!Number.isFinite(length) || length < 1e-12) {
      throw new Error(`Vertex ${index} has no usable adjacent face normal`);
    }
    normals.writeNormalized(index, 0, nx / length);
    normals.writeNormalized(index, 1, ny / length);
    normals.writeNormalized(index, 2, nz / length);
    repairedNormals += 1;
  }
  return { repairedNormals, triangles: indexCount / 3 };
}

function repairPrimitiveTangents(json, binary, primitive) {
  const tangentIndex = primitive.attributes.TANGENT;
  if (tangentIndex === undefined) return 0;
  const tangents = accessorReader(json, binary, tangentIndex, "VEC4");
  const normals = accessorReader(json, binary, primitive.attributes.NORMAL, "VEC3");
  if (tangents.accessor.count !== normals.accessor.count) {
    throw new Error("TANGENT and NORMAL counts do not match");
  }

  let repairedTangents = 0;
  for (let index = 0; index < tangents.accessor.count; index += 1) {
    const tx = tangents.read(index, 0);
    const ty = tangents.read(index, 1);
    const tz = tangents.read(index, 2);
    const tw = tangents.read(index, 3);
    const tangentLength = Math.hypot(tx, ty, tz);
    if (
      Number.isFinite(tangentLength) &&
      tangentLength > 1e-6 &&
      Number.isFinite(tw) &&
      Math.abs(tw) > 0.5
    ) {
      continue;
    }

    const nx = normals.read(index, 0);
    const ny = normals.read(index, 1);
    const nz = normals.read(index, 2);
    const normalLength = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(normalLength) || normalLength < 1e-6) {
      throw new Error(`Vertex ${index} has no normal for tangent fallback`);
    }
    const ux = nx / normalLength;
    const uy = ny / normalLength;
    const uz = nz / normalLength;
    // UV-degenerate Meshy faces have no unique tangent direction. Choose a
    // stable orthonormal basis so the normal map remains portable and finite.
    const axisX = Math.abs(uy) < 0.9 ? 0 : 1;
    const axisY = Math.abs(uy) < 0.9 ? 1 : 0;
    const fx = axisY * uz;
    const fy = -axisX * uz;
    const fz = axisX * uy - axisY * ux;
    const fallbackLength = Math.hypot(fx, fy, fz);
    tangents.writeNormalized(index, 0, fx / fallbackLength);
    tangents.writeNormalized(index, 1, fy / fallbackLength);
    tangents.writeNormalized(index, 2, fz / fallbackLength);
    tangents.writeNormalized(index, 3, Number.isFinite(tw) && tw < 0 ? -1 : 1);
    repairedTangents += 1;
  }
  return repairedTangents;
}

function pad4(buffer, byte = 0) {
  const padding = (4 - (buffer.byteLength % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, byte)]);
}

function encodeGlb(json, binary) {
  const jsonBuffer = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binaryBuffer = pad4(binary);
  const totalLength = 12 + 8 + jsonBuffer.byteLength + 8 + binaryBuffer.byteLength;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonBuffer.byteLength, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  jsonBuffer.copy(output, 20);
  const binaryHeader = 20 + jsonBuffer.byteLength;
  output.writeUInt32LE(binaryBuffer.byteLength, binaryHeader);
  output.writeUInt32LE(BIN_CHUNK_TYPE, binaryHeader + 4);
  binaryBuffer.copy(output, binaryHeader + 8);
  return output;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input);
  const output = path.resolve(args.output);
  const parsed = parseRuntimeGlbBuffer(fs.readFileSync(input), input);
  if (!parsed.binary) throw new Error(`${input} has no embedded BIN chunk`);
  const json = structuredClone(parsed.json);
  const binary = Buffer.from(parsed.binary);
  let repairedNormals = 0;
  let repairedTangents = 0;
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const result = repairPrimitiveNormals(json, binary, primitive);
      repairedNormals += result.repairedNormals;
      triangles += result.triangles;
      if (args.repairTangents) {
        repairedTangents += repairPrimitiveTangents(json, binary, primitive);
      }
    }
  }

  for (const material of json.materials ?? []) {
    delete material.emissiveTexture;
    delete material.emissiveFactor;
    if (args.stripNormalMap) delete material.normalTexture;
    if (args.frontSide) delete material.doubleSided;
    else material.doubleSided = true;
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, encodeGlb(json, binary));
  console.log(JSON.stringify({
    input: path.relative(process.cwd(), input),
    output: path.relative(process.cwd(), output),
    repairedNormals,
    repairedTangents,
    triangles,
    strippedEmissiveMaps: json.materials?.length ?? 0,
    strippedNormalMaps: args.stripNormalMap ? json.materials?.length ?? 0 : 0,
    frontSideMaterials: args.frontSide ? json.materials?.length ?? 0 : 0,
  }));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
