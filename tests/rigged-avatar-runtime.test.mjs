import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  clearRiggedAvatarCache,
  loadRiggedAvatar,
  riggedAvatarCacheKey,
} from "../app/avatar/rigged-avatar-runtime.ts";

function createTemplate() {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 2, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x8b6e4f });
  const vertexCount = geometry.attributes.position.count;
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index += 1) skinWeights[index * 4] = 1;
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

  const body = new THREE.SkinnedMesh(geometry, material);
  body.position.y = 1;
  const hips = new THREE.Bone();
  hips.name = "mixamorig:Hips";
  const rightArm = new THREE.Bone();
  rightArm.name = "mixamorig:RightArm";
  rightArm.position.set(0.4, 1.5, 0);
  hips.add(rightArm);
  body.add(hips);
  body.bind(new THREE.Skeleton([hips, rightArm]));
  scene.add(body);

  return {
    scene,
    geometry,
    animations: [
      new THREE.AnimationClip("Idle", 1, []),
      new THREE.AnimationClip("Meshy | Walking", 0.8, []),
      new THREE.AnimationClip("Female_Crouch_Pick_Throw_Forward", 0.08, []),
    ],
  };
}

function manifest(version = 1) {
  return {
    schemaVersion: 1,
    assetId: "waitlander-basic",
    assetVersion: version,
    url: `/avatars/waitlander-basic-v${version}.glb`,
    animations: {
      walk: ["Walk", "Walking"],
      idle: "Idle",
      interact: "Female_Crouch_Pick_Throw_Forward",
      fadeSeconds: 0.12,
      interactTimeScale: 1.25,
    },
    normalization: { targetHeight: 3, ground: true, centerXZ: true },
    postures: {
      carry: {
        rightUpperArm: { rotation: [0.35, 0, 0], weight: 1 },
      },
    },
  };
}

test("rigged avatar runtime shares decoded data while keeping mixers and materials independent", async () => {
  clearRiggedAvatarCache();
  const source = createTemplate();
  let loadCount = 0;
  const loaderFactory = () => ({
    async loadAsync() {
      loadCount += 1;
      return { scene: source.scene, animations: source.animations };
    },
  });
  const assetManifest = manifest();

  const [firstResult, secondResult] = await Promise.all([
    loadRiggedAvatar(assetManifest, { loaderFactory }),
    loadRiggedAvatar(assetManifest, { loaderFactory }),
  ]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  if (!firstResult.ok || !secondResult.ok) return;

  const first = firstResult.avatar;
  const second = secondResult.avatar;
  assert.equal(loadCount, 1);
  assert.notEqual(first.model, second.model);
  assert.notEqual(first.mixer, second.mixer);
  assert.notEqual(first.materials[0], second.materials[0]);
  const firstSkin = first.model.getObjectByProperty("isSkinnedMesh", true);
  const secondSkin = second.model.getObjectByProperty("isSkinnedMesh", true);
  assert.notEqual(firstSkin?.skeleton, secondSkin?.skeleton);
  assert.notEqual(first.bones.rightUpperArm, second.bones.rightUpperArm);
  assert.ok(Math.abs(first.normalizedHeight - 3) < 0.0001);
  assert.equal(first.activeAnimation, "idle");

  first.update(1 / 60, { moving: true, speed: 1 });
  assert.equal(first.activeAnimation, "walk");
  assert.equal(first.actions.walk?.isRunning(), true);

  assert.equal(first.playInteraction({ timeScale: 2 }), true);
  assert.equal(first.playInteraction(), false, "a running interaction is not restarted implicitly");
  assert.equal(first.activeAnimation, "interact");
  assert.equal(first.actions.interact?.loop, THREE.LoopOnce);
  assert.equal(first.actions.interact?.getEffectiveTimeScale(), 2);
  first.setMotion({ moving: false });
  assert.equal(first.activeAnimation, "interact", "motion changes do not interrupt the one-shot");
  first.update(0.1);
  assert.equal(first.activeAnimation, "idle", "completion returns to the latest motion state");

  first.update(0, { moving: false, carryingStone: true });
  assert.equal(first.anchors.heldItem.visible, true);
  assert.ok(Math.abs(first.bones.rightUpperArm?.quaternion.x ?? 0) > 0.01);
  first.update(0, { carryingStone: false });
  assert.ok(Math.abs(first.bones.rightUpperArm?.quaternion.x ?? 0) < 0.0001);

  let templateGeometryDisposals = 0;
  source.geometry.addEventListener("dispose", () => {
    templateGeometryDisposals += 1;
  });
  assert.equal(first.mixer._listeners.finished.length, 1);
  first.dispose();
  assert.equal(first.mixer._listeners.finished.length, 0, "dispose removes the mixer listener");
  clearRiggedAvatarCache(riggedAvatarCacheKey(assetManifest));
  assert.equal(templateGeometryDisposals, 0, "active clones retain shared template resources");
  second.dispose();
  assert.equal(templateGeometryDisposals, 1, "the last lease releases an evicted template");
});

test("rigged avatar failures are explicit so callers can choose the procedural fallback", async () => {
  const invalid = manifest(2);
  invalid.animations.walk = [];
  const invalidResult = await loadRiggedAvatar(invalid, {
    loaderFactory: () => {
      throw new Error("invalid manifests must not construct a loader");
    },
  });
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) assert.equal(invalidResult.reason, "invalid-manifest");

  const source = createTemplate();
  const missingWalk = manifest(3);
  missingWalk.animations.walk = "A Walk Clip That Is Not Present";
  const missingResult = await loadRiggedAvatar(missingWalk, {
    useCache: false,
    loaderFactory: () => ({
      async loadAsync() {
        return { scene: source.scene, animations: [source.animations[0]] };
      },
    }),
  });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.reason, "missing-walk-animation");

  const legacySource = createTemplate();
  const legacyManifest = manifest(4);
  delete legacyManifest.animations.interact;
  delete legacyManifest.animations.interactTimeScale;
  const legacyResult = await loadRiggedAvatar(legacyManifest, {
    useCache: false,
    loaderFactory: () => ({
      async loadAsync() {
        return { scene: legacySource.scene, animations: legacySource.animations };
      },
    }),
  });
  assert.equal(legacyResult.ok, true);
  if (legacyResult.ok) {
    assert.equal(legacyResult.avatar.playInteraction(), false);
    legacyResult.avatar.dispose();
  }
});
