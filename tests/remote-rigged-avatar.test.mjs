import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createAvatarAppearance } from "../app/avatar-design.ts";
import {
  RemoteAvatarRenderer,
  applyRemoteRiggedAvatarTint,
} from "../app/remote-avatar-renderer.ts";

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 1.5, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function makeFakeRuntime() {
  const root = new THREE.Group();
  const speech = new THREE.Group();
  const heldItem = new THREE.Group();
  const head = new THREE.Group();
  speech.position.set(0, 3.34, 0);
  heldItem.position.set(0.58, 1.7, -0.3);
  root.add(speech, heldItem, head);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const calls = { updates: [], interactions: [], releases: [], disposals: 0 };
  const motion = { moving: false, speed: 0, carryingStone: false };
  const runtime = {
    root,
    materials: [material],
    anchors: { speech, heldItem, head },
    motion,
    update(deltaSeconds, nextMotion = {}) {
      Object.assign(motion, nextMotion);
      root.updateWorldMatrix(true, true);
      calls.updates.push({ deltaSeconds, ...motion });
    },
    playInteraction(options = {}) {
      calls.interactions.push(options.kind ?? "interact");
      if (options.onRelease) calls.releases.push(options.onRelease);
      return true;
    },
    dispose() {
      calls.disposals += 1;
      root.removeFromParent();
      material.dispose();
    },
  };
  return { runtime, calls };
}

function frame(renderer, camera, now = performance.now()) {
  renderer.update(
    now,
    1 / 60,
    camera,
    { x: 0, z: 0 },
    { width: 390, height: 844 },
  );
}

const flushAsyncLoads = () => new Promise((resolve) => setImmediate(resolve));

test("near remote upgrades to the shared rigged model and disposes with its player", async () => {
  const scene = new THREE.Scene();
  const fake = makeFakeRuntime();
  const requestedUrls = [];
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 2,
    mobileRiggedPlayers: 2,
    riggedDistance: 20,
    riggedAvatarLoader: async (manifest) => {
      requestedUrls.push(manifest.url);
      return { ok: true, avatar: fake.runtime, cacheKey: "shared-test-template" };
    },
  });
  renderer.upsert({
    id: "near-player",
    x: 1,
    y: 0,
    z: 0,
    yaw: 0.4,
    vx: 1.2,
    vz: 0,
    moving: true,
  });

  const camera = makeCamera();
  frame(renderer, camera);
  assert.equal(renderer.getRenderMode("near-player"), "loading");
  await flushAsyncLoads();
  assert.deepEqual(requestedUrls, ["/assets/avatars/v2/waitlander-runtime.glb"]);
  assert.equal(renderer.getRenderMode("near-player"), "rigged");
  assert.equal(fake.runtime.root.parent?.name, "remote-rigged-avatars");
  assert.equal(fake.runtime.root.userData.waitlandRemotePlayerId, "near-player");

  frame(renderer, camera, performance.now() + 20);
  assert.ok(fake.calls.updates.length > 0);
  assert.equal(fake.calls.updates.at(-1).moving, true);
  assert.equal(fake.runtime.root.position.x, 1);
  assert.ok(Math.abs(fake.runtime.root.rotation.y - 0.4) < 1e-9);
  const visibleProceduralParts = [];
  scene.traverse((object) => {
    if (object instanceof THREE.InstancedMesh && object.instanceColor && object.count > 0) {
      visibleProceduralParts.push(object);
    }
  });
  assert.equal(visibleProceduralParts.length, 0, "authored remote replaces its procedural fallback");

  assert.equal(renderer.remove("near-player"), true);
  assert.equal(fake.calls.disposals, 1);
  assert.equal(fake.runtime.root.parent, null);
  assert.equal(renderer.getRenderMode("near-player"), undefined);
  renderer.dispose();
});

test("authoritative remote carrying changes play pickup then hold the stone until throw release", async () => {
  const scene = new THREE.Scene();
  const fake = makeFakeRuntime();
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 1,
    mobileRiggedPlayers: 1,
    riggedDistance: 20,
    riggedAvatarLoader: async () => ({
      ok: true,
      avatar: fake.runtime,
      cacheKey: "interaction-template",
    }),
  });
  const camera = makeCamera();
  const startedAt = performance.now();
  renderer.upsert({
    id: "stone-player",
    x: 1,
    z: 0,
    yaw: 0,
    moving: false,
    carryingStone: false,
  });
  frame(renderer, camera, startedAt);
  await flushAsyncLoads();
  frame(renderer, camera, startedAt + 20);

  renderer.upsert({
    id: "stone-player",
    x: 1,
    z: 0,
    yaw: 0,
    moving: false,
    carryingStone: true,
  });
  frame(renderer, camera, startedAt + 40);
  assert.deepEqual(fake.calls.interactions, ["pickup"]);
  assert.equal(renderer.stones.count, 1);
  let authoritativeRelease;
  assert.equal(
    renderer.deferStoneRelease("stone-player", (release) => {
      authoritativeRelease = release;
    }),
    true,
  );

  renderer.upsert({
    id: "stone-player",
    x: 1,
    z: 0,
    yaw: 0,
    moving: false,
    carryingStone: false,
  });
  frame(renderer, camera, startedAt + 60);
  assert.deepEqual(fake.calls.interactions, ["pickup", "throw"]);
  assert.equal(renderer.stones.count, 1, "the authoritative throw keeps the rock on the hand");
  assert.equal(authoritativeRelease, undefined, "world placement waits for the animation beat");

  fake.calls.releases.at(-1)({
    kind: "throw",
    progress: 0.54,
    heldItem: fake.runtime.anchors.heldItem,
  });
  frame(renderer, camera, startedAt + 80);
  assert.equal(renderer.stones.count, 0, "the remote rock leaves the hand at the release marker");
  assert.ok(authoritativeRelease);
  assert.ok(authoritativeRelease.position.distanceTo(new THREE.Vector3(1.58, 1.7, -0.3)) < 0.001);
  renderer.dispose();
});

test("rigged LOD budget selects the nearest visible remote then promotes the next", async () => {
  const scene = new THREE.Scene();
  const loads = [];
  const runtimes = [];
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 1,
    mobileRiggedPlayers: 1,
    riggedDistance: 20,
    riggedAvatarLoader: async (_manifest, options) => {
      const fake = makeFakeRuntime();
      loads.push(options.initialMotion);
      runtimes.push(fake);
      return { ok: true, avatar: fake.runtime, cacheKey: "shared-test-template" };
    },
  });
  renderer.upsert({ id: "nearest", x: 0.5, z: 0, yaw: 0, moving: false });
  renderer.upsert({ id: "next", x: 2.5, z: 0, yaw: 0, moving: false });

  const camera = makeCamera();
  frame(renderer, camera);
  assert.equal(renderer.getRenderMode("nearest"), "loading");
  assert.equal(renderer.getRenderMode("next"), "procedural");
  await flushAsyncLoads();
  assert.equal(renderer.getRenderMode("nearest"), "rigged");
  assert.equal(loads.length, 1);

  renderer.remove("nearest");
  frame(renderer, camera, performance.now() + 20);
  assert.equal(renderer.getRenderMode("next"), "loading");
  await flushAsyncLoads();
  assert.equal(renderer.getRenderMode("next"), "rigged");
  assert.equal(loads.length, 2);
  assert.equal(runtimes[0].calls.disposals, 1);
  renderer.dispose();
  assert.equal(runtimes[1].calls.disposals, 1);
});

test("removing a player cancels an in-flight rigged upgrade and disposes a late result", async () => {
  const scene = new THREE.Scene();
  const fake = makeFakeRuntime();
  let finishLoad;
  let observedSignal;
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 1,
    mobileRiggedPlayers: 1,
    riggedDistance: 20,
    riggedAvatarLoader: (_manifest, options) => {
      observedSignal = options.signal;
      return new Promise((resolve) => {
        finishLoad = () => resolve({ ok: true, avatar: fake.runtime, cacheKey: "late-template" });
      });
    },
  });
  renderer.upsert({ id: "leaving", x: 1, z: 0, yaw: 0, moving: false });
  frame(renderer, makeCamera());
  await Promise.resolve();
  assert.equal(renderer.getRenderMode("leaving"), "loading");

  renderer.remove("leaving");
  assert.equal(observedSignal.aborted, true);
  finishLoad();
  await flushAsyncLoads();
  assert.equal(fake.calls.disposals, 1);
  assert.equal(fake.runtime.root.parent, null);
  renderer.dispose();
});

test("a GLB load failure leaves the complete colored procedural fallback visible", async () => {
  const scene = new THREE.Scene();
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 1,
    mobileRiggedPlayers: 1,
    riggedDistance: 20,
    riggedAvatarLoader: async (manifest) => ({
      ok: false,
      reason: "load-failed",
      error: new Error("test load failure"),
      manifest,
    }),
  });
  renderer.upsert({ id: "fallback", x: 1, z: 0, yaw: 0, moving: false });
  const camera = makeCamera();
  frame(renderer, camera);
  await flushAsyncLoads();
  frame(renderer, camera, performance.now() + 20);
  assert.equal(renderer.getRenderMode("fallback"), "procedural");
  const coloredFallbackParts = [];
  scene.traverse((object) => {
    if (object instanceof THREE.InstancedMesh && object.instanceColor && object.count > 0) {
      coloredFallbackParts.push(object);
    }
  });
  assert.ok(coloredFallbackParts.length >= 10);
  renderer.dispose();
});

test("transient shared GLB failure retries and upgrades every eligible remote", async () => {
  const scene = new THREE.Scene();
  const successfulRuntimes = [makeFakeRuntime(), makeFakeRuntime()];
  let loadAttempts = 0;
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRiggedPlayers: 2,
    mobileRiggedPlayers: 2,
    riggedDistance: 20,
    riggedAvatarLoader: async (manifest) => {
      loadAttempts += 1;
      if (loadAttempts <= 2) {
        return {
          ok: false,
          reason: "load-failed",
          error: new Error("temporary shared asset failure"),
          manifest,
        };
      }
      return {
        ok: true,
        avatar: successfulRuntimes[loadAttempts - 3].runtime,
        cacheKey: "shared-retry-template",
      };
    },
  });
  renderer.upsert({ id: "retry-left", x: -1, z: 0, yaw: 0, moving: false });
  renderer.upsert({ id: "retry-right", x: 1, z: 0, yaw: 0, moving: false });

  const camera = makeCamera();
  const startedAt = performance.now();
  frame(renderer, camera, startedAt);
  assert.equal(renderer.getRenderMode("retry-left"), "loading");
  assert.equal(renderer.getRenderMode("retry-right"), "loading");
  await flushAsyncLoads();
  assert.equal(loadAttempts, 2);
  assert.equal(renderer.getRenderMode("retry-left"), "procedural");
  assert.equal(renderer.getRenderMode("retry-right"), "procedural");

  frame(renderer, camera, startedAt + 100);
  assert.equal(loadAttempts, 2, "backoff prevents a request on every animation frame");
  const fallbackPartsDuringBackoff = [];
  scene.traverse((object) => {
    if (object instanceof THREE.InstancedMesh && object.instanceColor && object.count > 0) {
      fallbackPartsDuringBackoff.push(object);
    }
  });
  assert.ok(fallbackPartsDuringBackoff.length >= 10, "fallback stays visible during backoff");

  frame(renderer, camera, startedAt + 10_000);
  assert.equal(renderer.getRenderMode("retry-left"), "loading");
  assert.equal(renderer.getRenderMode("retry-right"), "loading");
  await flushAsyncLoads();
  assert.equal(loadAttempts, 4);
  assert.equal(renderer.getRenderMode("retry-left"), "rigged");
  assert.equal(renderer.getRenderMode("retry-right"), "rigged");

  frame(renderer, camera, startedAt + 10_020);
  const fallbackPartsAfterSuccess = [];
  scene.traverse((object) => {
    if (object instanceof THREE.InstancedMesh && object.instanceColor && object.count > 0) {
      fallbackPartsAfterSuccess.push(object);
    }
  });
  assert.equal(fallbackPartsAfterSuccess.length, 0, "rigged remotes replace every fallback");
  assert.ok(successfulRuntimes.every(({ runtime }) => runtime.root.visible));

  renderer.dispose();
  assert.ok(successfulRuntimes.every(({ calls }) => calls.disposals === 1));
});

test("visible remotes across the default render range request the authored model", async () => {
  const scene = new THREE.Scene();
  const fake = makeFakeRuntime();
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRenderDistance: 62,
    maxRiggedPlayers: 1,
    mobileRiggedPlayers: 1,
    riggedAvatarLoader: async () => ({
      ok: true,
      avatar: fake.runtime,
      cacheKey: "default-range-template",
    }),
  });
  renderer.upsert({ id: "far-visible", x: 0, z: -44, yaw: 0, moving: false });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
  camera.position.set(0, 5, 8);
  camera.lookAt(0, 1.5, -30);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  frame(renderer, camera);
  assert.equal(renderer.getRenderMode("far-visible"), "loading");
  await flushAsyncLoads();
  assert.equal(renderer.getRenderMode("far-visible"), "rigged");
  renderer.dispose();
});

test("the default compact viewport upgrades every visible remote to the authored model", async () => {
  const scene = new THREE.Scene();
  const runtimes = [];
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    riggedAvatarLoader: async () => {
      const fake = makeFakeRuntime();
      runtimes.push(fake);
      return {
        ok: true,
        avatar: fake.runtime,
        cacheKey: "all-visible-template",
      };
    },
  });
  for (let index = 0; index < 18; index += 1) {
    renderer.upsert({
      id: `visible-${index}`,
      x: (index % 6) - 2.5,
      z: -Math.floor(index / 6) * 1.5,
      yaw: 0,
      moving: false,
    });
  }

  const camera = makeCamera();
  frame(renderer, camera);
  for (let index = 0; index < 18; index += 1) {
    assert.equal(renderer.getRenderMode(`visible-${index}`), "loading");
  }
  await flushAsyncLoads();
  for (let index = 0; index < 18; index += 1) {
    assert.equal(renderer.getRenderMode(`visible-${index}`), "rigged");
  }
  assert.equal(runtimes.length, 18);
  renderer.dispose();
  assert.ok(runtimes.every(({ calls }) => calls.disposals === 1));
});

test("remote GLB tint recovers black material factors and is idempotent", () => {
  const material = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const appearance = createAvatarAppearance("remote-tint");
  const avatar = { materials: [material] };
  applyRemoteRiggedAvatarTint(avatar, appearance);
  const first = material.color.clone();
  assert.ok(first.r + first.g + first.b > 1.4, "valid texture tint must not remain black");
  applyRemoteRiggedAvatarTint(avatar, appearance);
  assert.ok(
    Math.abs(material.color.r - first.r) +
      Math.abs(material.color.g - first.g) +
      Math.abs(material.color.b - first.b) <
      1e-9,
    "reapplying appearance must not compound tint",
  );
  material.dispose();
});

test("zero rigged caps keep the production crowd procedural without starting an asset load", async () => {
  const scene = new THREE.Scene();
  let loads = 0;
  const renderer = new RemoteAvatarRenderer(scene, {
    maxRiggedPlayers: 0,
    mobileRiggedPlayers: 0,
    riggedAvatarLoader: async () => { loads += 1; return { ok: false, reason: "load-failed" }; },
  });
  const camera = makeCamera();
  renderer.upsert({ id: "procedural-visitor", x: 0, z: 0, yaw: 0, moving: false });
  for (let index = 0; index < 3; index += 1) frame(renderer, camera, performance.now() + index * 16);
  await Promise.resolve();
  assert.equal(loads, 0);
  assert.equal(renderer.getRenderMode("procedural-visitor"), "procedural");
  renderer.dispose();
});
