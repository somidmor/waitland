import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const ACCESSOR_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function isEmbeddedUri(uri) {
  return typeof uri === "string" && uri.startsWith("data:");
}

export function parseRuntimeGlbBuffer(input, label = "runtime GLB") {
  const file = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (file.byteLength < 20) fail(label, "file is too short to contain a GLB");
  if (file.readUInt32LE(0) !== GLB_MAGIC) fail(label, "missing glTF binary magic");
  if (file.readUInt32LE(4) !== GLB_VERSION) fail(label, "must use glTF 2.0");
  if (file.readUInt32LE(8) !== file.byteLength) {
    fail(label, `declared byte length ${file.readUInt32LE(8)} does not match ${file.byteLength}`);
  }

  let json;
  let binary;
  let chunkIndex = 0;
  for (let offset = 12; offset < file.byteLength;) {
    if (offset + 8 > file.byteLength) fail(label, "truncated chunk header");
    const byteLength = file.readUInt32LE(offset);
    const type = file.readUInt32LE(offset + 4);
    const end = offset + 8 + byteLength;
    if (byteLength % 4 !== 0) fail(label, `chunk ${chunkIndex} is not four-byte aligned`);
    if (end > file.byteLength) fail(label, `chunk ${chunkIndex} extends past the file`);
    const data = file.subarray(offset + 8, end);

    if (type === JSON_CHUNK_TYPE) {
      if (chunkIndex !== 0) fail(label, "JSON must be the first GLB chunk");
      if (json) fail(label, "contains more than one JSON chunk");
      try {
        json = JSON.parse(data.toString("utf8").replace(/[\u0000\u0020]+$/, ""));
      } catch (error) {
        fail(label, `contains invalid JSON (${error.message})`);
      }
    } else if (type === BIN_CHUNK_TYPE) {
      if (binary) fail(label, "contains more than one BIN chunk");
      binary = Buffer.from(data);
    }

    offset = end;
    chunkIndex += 1;
  }

  if (!json) fail(label, "is missing its JSON chunk");
  if (json.asset?.version !== "2.0") fail(label, "JSON asset.version must be 2.0");
  return { file, json, binary };
}

export function assertRuntimeGlbSelfContained(parsed, label = "runtime GLB") {
  const { json, binary } = parsed;
  const buffers = json.buffers ?? [];
  const images = json.images ?? [];

  buffers.forEach((buffer, index) => {
    if (buffer.uri !== undefined && !isEmbeddedUri(buffer.uri)) {
      fail(label, `buffer ${index} references external URI '${buffer.uri}'`);
    }
    if (buffer.uri === undefined) {
      if (index !== 0 || !binary) {
        fail(label, `buffer ${index} is not backed by an embedded BIN chunk`);
      }
      if (!Number.isInteger(buffer.byteLength) || buffer.byteLength < 0) {
        fail(label, `buffer ${index} has an invalid byteLength`);
      }
      if (buffer.byteLength > binary.byteLength) {
        fail(label, `buffer ${index} exceeds the embedded BIN chunk`);
      }
    }
  });

  images.forEach((image, index) => {
    if (image.uri !== undefined && !isEmbeddedUri(image.uri)) {
      fail(label, `image ${index} references external URI '${image.uri}'`);
    }
    if (image.uri === undefined) {
      if (!Number.isInteger(image.bufferView) || !json.bufferViews?.[image.bufferView]) {
        fail(label, `image ${index} is missing an embedded bufferView`);
      }
    }
  });

  return { buffers: buffers.length, images: images.length };
}

export function readAnimationInputAccessor(parsed, accessorIndex, label = "runtime GLB") {
  const { json, binary } = parsed;
  if (!Number.isInteger(accessorIndex) || !json.accessors?.[accessorIndex]) {
    fail(label, `animation references missing input accessor ${accessorIndex}`);
  }
  const accessor = json.accessors[accessorIndex];
  if (accessor.type !== "SCALAR" || accessor.componentType !== 5126) {
    fail(label, `animation input accessor ${accessorIndex} must be a FLOAT SCALAR`);
  }
  if (accessor.sparse) {
    fail(label, `animation input accessor ${accessorIndex} must not be sparse`);
  }
  if (!Number.isInteger(accessor.count) || accessor.count < 1) {
    fail(label, `animation input accessor ${accessorIndex} has an invalid count`);
  }
  if (!Number.isInteger(accessor.bufferView) || !json.bufferViews?.[accessor.bufferView]) {
    fail(label, `animation input accessor ${accessorIndex} is missing its bufferView`);
  }
  const view = json.bufferViews[accessor.bufferView];
  if ((view.buffer ?? 0) !== 0 || !binary) {
    fail(label, `animation input accessor ${accessorIndex} is not BIN-backed`);
  }

  const stride = view.byteStride ?? 4;
  if (!Number.isInteger(stride) || stride < 4 || stride % 4 !== 0) {
    fail(label, `animation input accessor ${accessorIndex} has invalid stride ${stride}`);
  }
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + (accessor.count - 1) * stride + 4;
  if (!Number.isInteger(start) || start < 0 || end > binary.byteLength) {
    fail(label, `animation input accessor ${accessorIndex} exceeds the BIN chunk`);
  }

  return Array.from({ length: accessor.count }, (_, index) =>
    binary.readFloatLE(start + index * stride),
  );
}

function readAccessorComponent(binary, offset, componentType, normalized) {
  let value;
  if (componentType === 5120) value = binary.readInt8(offset);
  else if (componentType === 5121) value = binary.readUInt8(offset);
  else if (componentType === 5122) value = binary.readInt16LE(offset);
  else if (componentType === 5123) value = binary.readUInt16LE(offset);
  else if (componentType === 5125) value = binary.readUInt32LE(offset);
  else if (componentType === 5126) value = binary.readFloatLE(offset);
  else throw new Error(`Unsupported accessor component type ${componentType}`);
  if (!normalized) return value;
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  throw new Error(`Unsupported normalized accessor component type ${componentType}`);
}

export function readAccessorComponents(parsed, accessorIndex, label = "runtime GLB") {
  const { json, binary } = parsed;
  if (!Number.isInteger(accessorIndex) || !json.accessors?.[accessorIndex]) {
    fail(label, `references missing accessor ${accessorIndex}`);
  }
  const accessor = json.accessors[accessorIndex];
  const componentCount = ACCESSOR_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!componentCount || !componentBytes) {
    fail(label, `accessor ${accessorIndex} has unsupported type or components`);
  }
  if (accessor.sparse) fail(label, `accessor ${accessorIndex} must not be sparse`);
  if (!Number.isInteger(accessor.count) || accessor.count < 1) {
    fail(label, `accessor ${accessorIndex} has an invalid count`);
  }
  if (!Number.isInteger(accessor.bufferView) || !json.bufferViews?.[accessor.bufferView]) {
    fail(label, `accessor ${accessorIndex} is missing its bufferView`);
  }
  const view = json.bufferViews[accessor.bufferView];
  if ((view.buffer ?? 0) !== 0 || !binary) {
    fail(label, `accessor ${accessorIndex} is not BIN-backed`);
  }
  const packedSize = componentCount * componentBytes;
  const stride = view.byteStride ?? packedSize;
  if (!Number.isInteger(stride) || stride < packedSize || stride % componentBytes !== 0) {
    fail(label, `accessor ${accessorIndex} has invalid stride ${stride}`);
  }
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + (accessor.count - 1) * stride + packedSize;
  if (!Number.isInteger(start) || start < 0 || end > binary.byteLength) {
    fail(label, `accessor ${accessorIndex} exceeds the BIN chunk`);
  }

  return Array.from({ length: accessor.count }, (_, index) =>
    Array.from({ length: componentCount }, (_, component) =>
      readAccessorComponent(
        binary,
        start + index * stride + component * componentBytes,
        accessor.componentType,
        accessor.normalized === true,
      ),
    ),
  );
}

export function assertFiniteUnitVertexFrames(parsed, label = "runtime GLB") {
  let normals = 0;
  let tangents = 0;
  for (const [meshIndex, mesh] of (parsed.json.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const normalIndex = primitive.attributes?.NORMAL;
      if (normalIndex !== undefined) {
        const values = readAccessorComponents(parsed, normalIndex, label);
        for (const [index, value] of values.entries()) {
          const length = Math.hypot(value[0], value[1], value[2]);
          if (!Number.isFinite(length) || Math.abs(length - 1) > 0.002) {
            fail(
              label,
              `mesh ${meshIndex} primitive ${primitiveIndex} NORMAL ${index} ` +
                `is non-finite, zero, or non-unit (length ${length})`,
            );
          }
        }
        normals += values.length;
      }

      const tangentIndex = primitive.attributes?.TANGENT;
      if (tangentIndex !== undefined) {
        const values = readAccessorComponents(parsed, tangentIndex, label);
        for (const [index, value] of values.entries()) {
          const length = Math.hypot(value[0], value[1], value[2]);
          if (
            !Number.isFinite(length) ||
            Math.abs(length - 1) > 0.002 ||
            !Number.isFinite(value[3]) ||
            Math.abs(Math.abs(value[3]) - 1) > 0.002
          ) {
            fail(
              label,
              `mesh ${meshIndex} primitive ${primitiveIndex} TANGENT ${index} is invalid`,
            );
          }
        }
        tangents += values.length;
      }
    }
  }
  return { normals, tangents };
}

export function assertStrictAnimationInputs(parsed, label = "runtime GLB") {
  let samplerCount = 0;
  for (const [animationIndex, animation] of (parsed.json.animations ?? []).entries()) {
    for (const [samplerIndex, sampler] of (animation.samplers ?? []).entries()) {
      const values = readAnimationInputAccessor(parsed, sampler.input, label);
      for (let index = 0; index < values.length; index += 1) {
        if (!Number.isFinite(values[index])) {
          fail(label, `animation ${animation.name ?? animationIndex} sampler ${samplerIndex} has a non-finite time`);
        }
        if (index > 0 && values[index] <= values[index - 1]) {
          fail(
            label,
            `animation ${animation.name ?? animationIndex} sampler ${samplerIndex} time ${index} ` +
              `(${values[index]}) is not greater than time ${index - 1} (${values[index - 1]})`,
          );
        }
      }
      samplerCount += 1;
    }
  }
  return { animations: parsed.json.animations?.length ?? 0, samplers: samplerCount };
}

export function validateRuntimeGlbBuffer(input, label = "runtime GLB") {
  const parsed = parseRuntimeGlbBuffer(input, label);
  const embedded = assertRuntimeGlbSelfContained(parsed, label);
  const animation = assertStrictAnimationInputs(parsed, label);
  return {
    byteLength: parsed.file.byteLength,
    ...embedded,
    ...animation,
  };
}

export async function validateRuntimeGlbFile(file) {
  return validateRuntimeGlbBuffer(await readFile(file), file);
}

export async function findRuntimeGlbFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) files.push(file);
    }
  }
  await visit(root);
  return files;
}
