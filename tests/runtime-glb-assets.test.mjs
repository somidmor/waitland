import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WAITLAND_ENVIRONMENT_MANIFEST,
  WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST,
  WAITLAND_PIT_ASSET_MANIFEST,
} from "../app/environment/environment-manifest.ts";
import {
  assertFiniteUnitVertexFrames,
  findRuntimeGlbFiles,
  parseRuntimeGlbBuffer,
  validateRuntimeGlbFile,
} from "../scripts/lib/runtime-glb-validation.mjs";

const ASSET_ROOT = fileURLToPath(new URL("../public/assets/", import.meta.url));

const REFERENCED_ENVIRONMENT_ASSETS = [
  ...Object.values(WAITLAND_ENVIRONMENT_MANIFEST.assets).map((asset) => asset.url),
  WAITLAND_PIT_ASSET_MANIFEST.url,
  WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST.url,
];

const ENVIRONMENT_CONTRACTS = {
  "gameplay-stone.glb": { triangles: 994, doubleSided: false, normalMapped: false },
  "grass-cluster.glb": { triangles: 1_660, doubleSided: true, normalMapped: false },
  "meadow-shrub.glb": { triangles: 5_119, doubleSided: true, normalMapped: false },
  "meadow-tree.glb": { triangles: 9_459, doubleSided: true, normalMapped: true },
  "path-module.glb": { triangles: 4_983, doubleSided: false, normalMapped: false },
  "pit-landmark-v3.glb": { triangles: 11_524, doubleSided: true, normalMapped: false },
  "rock-kit.glb": { triangles: 6_501, doubleSided: false, normalMapped: false },
  "wildflower-cluster.glb": { triangles: 2_703, doubleSided: true, normalMapped: false },
};

function parseWebpDimensions(image, label) {
  assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF", `${label} is not RIFF`);
  assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP", `${label} is not WebP`);
  const chunk = image.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return { width: image.readUIntLE(24, 3) + 1, height: image.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8 ") {
    return { width: image.readUInt16LE(26) & 0x3fff, height: image.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = image.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  assert.fail(`${label} has unsupported WebP chunk '${chunk}'`);
}

test("every shipped runtime GLB is valid, self-contained, and has ordered animation times", async () => {
  const files = await findRuntimeGlbFiles(ASSET_ROOT);
  assert.ok(files.length >= 10, "expected avatar and environment runtime GLBs");
  assert.ok(
    files.some((file) => file.endsWith("/avatars/v2/waitlander-runtime.glb")),
    "the v2 avatar must be covered by the runtime GLB gate",
  );
  assert.ok(
    files.some((file) => file.includes("/environment/v2/")),
    "environment models must be covered by the runtime GLB gate",
  );

  for (const file of files) {
    const result = await validateRuntimeGlbFile(file);
    assert.ok(result.byteLength > 20, `${path.relative(ASSET_ROOT, file)} is unexpectedly small`);
  }
});

test("referenced environment GLBs keep valid vertex frames and mobile material budgets", async () => {
  assert.equal(new Set(REFERENCED_ENVIRONMENT_ASSETS).size, 8);
  for (const assetUrl of REFERENCED_ENVIRONMENT_ASSETS) {
    const file = fileURLToPath(new URL(`../public${assetUrl}`, import.meta.url));
    const parsed = parseRuntimeGlbBuffer(await readFile(file), file);
    const contract = ENVIRONMENT_CONTRACTS[path.basename(file)];
    assert.ok(contract, `missing cleanup contract for ${path.basename(file)}`);
    const frames = assertFiniteUnitVertexFrames(parsed, file);
    assert.ok(frames.normals > 0, `${path.basename(file)} has no vertex normals`);

    let triangleCount = 0;
    for (const mesh of parsed.json.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        assert.equal(primitive.mode ?? 4, 4, "environment assets must use triangles");
        triangleCount += parsed.json.accessors[primitive.indices].count / 3;
        const material = parsed.json.materials[primitive.material];
        assert.equal(material.emissiveTexture, undefined, "black emissive maps must be stripped");
        assert.equal(material.emissiveFactor, undefined, "emissive factors must reset to black");
        assert.equal(material.doubleSided === true, contract.doubleSided);
        assert.equal(material.normalTexture !== undefined, contract.normalMapped);
        assert.equal(primitive.attributes.TANGENT !== undefined, contract.normalMapped);
      }
    }
    assert.equal(triangleCount, contract.triangles, `${path.basename(file)} silhouette topology changed`);
    assert.equal(parsed.json.images?.length, contract.normalMapped ? 3 : 2);

    for (const [imageIndex, image] of (parsed.json.images ?? []).entries()) {
      assert.equal(image.mimeType, "image/webp");
      const view = parsed.json.bufferViews[image.bufferView];
      const bytes = parsed.binary.subarray(
        view.byteOffset ?? 0,
        (view.byteOffset ?? 0) + view.byteLength,
      );
      const dimensions = parseWebpDimensions(bytes, `${path.basename(file)} image ${imageIndex}`);
      assert.ok(dimensions.width <= 512 && dimensions.height <= 512);
    }
  }
});
