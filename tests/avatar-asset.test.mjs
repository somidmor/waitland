import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
