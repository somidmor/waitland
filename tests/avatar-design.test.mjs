import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_CATALOGS,
  createAvatarAppearance,
} from "../app/avatar-design.ts";
import { createProceduralAvatar } from "../app/avatar/index.ts";

function ids(catalog) {
  return new Set(catalog.map((item) => item.id));
}

test("avatar randomization is deterministic and resolves every stable catalog ID", () => {
  const first = createAvatarAppearance("actor-a");
  const second = createAvatarAppearance("actor-a");
  assert.deepEqual(first, second);

  assert.ok(ids(AVATAR_CATALOGS.bases).has(first.baseId));
  assert.ok(ids(AVATAR_CATALOGS.skinTones).has(first.skinToneId));
  assert.ok(ids(AVATAR_CATALOGS.hairStyles).has(first.hairId));
  assert.ok(ids(AVATAR_CATALOGS.hairColors).has(first.hairColorId));
  assert.ok(ids(AVATAR_CATALOGS.tops).has(first.topId));
  assert.ok(ids(AVATAR_CATALOGS.topColors).has(first.topColorId));
  assert.ok(ids(AVATAR_CATALOGS.bottoms).has(first.bottomId));
  assert.ok(ids(AVATAR_CATALOGS.bottomColors).has(first.bottomColorId));
  assert.ok(ids(AVATAR_CATALOGS.shoes).has(first.shoeId));
  assert.ok(ids(AVATAR_CATALOGS.shoeColors).has(first.shoeColorId));
  for (const accessory of first.accessoryIds) {
    assert.ok(ids(AVATAR_CATALOGS.accessories).has(accessory));
  }
});

test("legacy colors remain compatible while invalid part IDs fail closed", () => {
  const custom = createAvatarAppearance("legacy", {
    skin: 0x123456,
    sweater: 0x3f5b3f,
    topId: "not-a-real-top",
  });
  assert.equal(custom.skin, 0x123456);
  assert.equal(custom.skinToneId, "custom");
  assert.equal(custom.topColorId, "forest");
  assert.ok(ids(AVATAR_CATALOGS.tops).has(custom.topId));
});

test("the local avatar facade swaps modules and owns its resources", () => {
  const avatar = createProceduralAvatar({ seed: "preview-avatar" });
  const updated = avatar.setAppearance({
    topId: "soft-hoodie",
    bottomId: "walking-shorts",
    shoeId: "ankle-boots",
    hairId: "top-bun",
    accessoryIds: ["round-glasses", "soft-scarf"],
  });

  assert.equal(updated.topId, "soft-hoodie");
  assert.equal(avatar.root.getObjectByName("top-soft-hoodie")?.visible, true);
  assert.equal(avatar.root.getObjectByName("top-knit-sweater")?.visible, false);
  assert.equal(avatar.root.getObjectByName("accessory-soft-scarf")?.visible, true);
  assert.equal(avatar.root.getObjectByName("accessory-crossbody-bag")?.visible, false);

  avatar.updatePose({ moving: true, walkPhase: Math.PI / 2, carryingStone: true });
  assert.equal(avatar.anchors.heldItem.visible, true);
  assert.notEqual(avatar.root.getObjectByName("left-leg-rig")?.rotation.x, 0);

  avatar.dispose();
  assert.equal(avatar.root.children.length, 0);
});
