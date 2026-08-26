import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const STONE_ACTION_URL = new URL(
  "../public/assets/ui/v2/stone-action.png",
  import.meta.url,
);
const GLOBAL_CSS_URL = new URL("../app/globals.css", import.meta.url);

test("stone action art stays mobile-sized, transparent, and connected to the HUD", async () => {
  const [image, css] = await Promise.all([
    readFile(STONE_ACTION_URL),
    readFile(GLOBAL_CSS_URL, "utf8"),
  ]);

  assert.deepEqual(
    image.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "stone action art must remain a PNG",
  );
  assert.equal(image.subarray(12, 16).toString("ascii"), "IHDR");
  assert.ok(image.readUInt32BE(16) <= 256, "stone action art is wider than its mobile budget");
  assert.ok(image.readUInt32BE(20) <= 256, "stone action art is taller than its mobile budget");
  assert.equal(image[24], 8, "stone action art must remain 8-bit");
  assert.equal(image[25], 6, "stone action art must retain an RGBA alpha channel");
  assert.ok(image.byteLength < 128_000, "stone action art exceeds its transfer budget");
  assert.match(
    css,
    /background-image:\s*url\(["']\/assets\/ui\/v2\/stone-action\.png["']\)/,
    "the HUD must reference the optimized stone action art",
  );
});
