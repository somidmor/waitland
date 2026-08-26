import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  bakeSinglePrimitiveEnvironmentGeometry,
  clearEnvironmentAssetCache,
  environmentAssetCacheKey,
  loadEnvironmentAsset,
  mountEnvironmentAsset,
} from "../app/environment/environment-asset-runtime.ts";
import {
  WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST,
  WAITLAND_GAMEPLAY_STONE_SIZE,
  WAITLAND_ENVIRONMENT_MANIFEST,
  WAITLAND_PIT_ASSET_MANIFEST,
  WAITLAND_PIT_OUTER_FOOTPRINT,
} from "../app/environment/environment-manifest.ts";
import { PIT_WALL_RADIUS } from "../shared/world.ts";

function manifest(version = 1) {
  return {
    schemaVersion: 1,
    assetId: "test-environment-prop",
    assetVersion: version,
    url: `/environment/test-prop-v${version}.glb`,
    normalization: {
      targetSize: 4,
      measure: "height",
      ground: true,
      centerXZ: true,
    },
    rendering: { castShadow: true, receiveShadow: true },
  };
}

function sourceScene() {
  const root = new THREE.Group();
  root.position.set(4, 2, -3);
  const trunkGeometry = new THREE.BoxGeometry(2, 4, 2);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x6f5137 });
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunk.name = "trunk";
  trunk.position.set(1, 2, 0);
  root.add(trunk);

  const crownGeometry = new THREE.BoxGeometry(3, 2, 2.5);
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x71805a });
  const crown = new THREE.Mesh(crownGeometry, crownMaterial);
  crown.name = "crown";
  crown.position.set(1.5, 5, 0.5);
  root.add(crown);

  return { root, trunkGeometry, crownGeometry };
}

test("v2 environment manifest keeps generated filenames and dense-cluster budgets stable", () => {
  const assets = WAITLAND_ENVIRONMENT_MANIFEST.assets;
  assert.deepEqual(
    Object.values(assets).map((asset) => asset.url),
    [
      "/assets/environment/v2/meadow-tree.glb",
      "/assets/environment/v2/grass-cluster.glb",
      "/assets/environment/v2/wildflower-cluster.glb",
      "/assets/environment/v2/path-module.glb",
      "/assets/environment/v2/rock-kit.glb",
      "/assets/environment/v2/meadow-shrub.glb",
    ],
  );
  assert.equal(assets.grass.placement.instancesPerChunk, 24);
  assert.ok(assets.grass.placement.instancesPerChunk < 72);
  assert.equal(assets.flowers.placement.instancesPerChunk, 9);
  assert.equal(
    WAITLAND_PIT_ASSET_MANIFEST.url,
    "/assets/environment/v2/pit-landmark-v3.glb",
  );
  assert.equal(
    WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST.url,
    "/assets/environment/v2/gameplay-stone.glb",
  );
  assert.equal(WAITLAND_PIT_OUTER_FOOTPRINT, PIT_WALL_RADIUS * 2);
  assert.equal(
    WAITLAND_PIT_ASSET_MANIFEST.normalization.targetSize,
    PIT_WALL_RADIUS * 2,
  );
  assert.equal(WAITLAND_PIT_ASSET_MANIFEST.normalization.ground, false);
  assert.equal(
    WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST.normalization.targetSize,
    WAITLAND_GAMEPLAY_STONE_SIZE,
  );
  assert.equal(WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST.normalization.ground, false);
  assert.ok(!Object.values(assets).includes(WAITLAND_PIT_ASSET_MANIFEST));
});

test("the shipped authored pit and gameplay stone are valid local GLB assets", async () => {
  for (const assetManifest of [
    WAITLAND_PIT_ASSET_MANIFEST,
    WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST,
  ]) {
    const bytes = await readFile(
      new URL(`../public${assetManifest.url}`, import.meta.url),
    );
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
    assert.ok(bytes.byteLength > 32_000);
  }
});

test("environment loader normalizes arbitrary bounds and pools every authored primitive", async () => {
  clearEnvironmentAssetCache();
  const source = sourceScene();
  const assetManifest = manifest();
  let loadCount = 0;
  let geometryDisposals = 0;
  source.trunkGeometry.addEventListener("dispose", () => {
    geometryDisposals += 1;
  });
  source.crownGeometry.addEventListener("dispose", () => {
    geometryDisposals += 1;
  });

  const result = await loadEnvironmentAsset(assetManifest, {
    useCache: false,
    loaderFactory: () => ({
      async loadAsync() {
        loadCount += 1;
        return { scene: source.root, animations: [] };
      },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(loadCount, 1);
  assert.equal(result.cacheKey, environmentAssetCacheKey(assetManifest));
  assert.equal(result.asset.template.primitives.length, 2);
  assert.ok(Math.abs(result.asset.template.normalizedSize.y - 4) < 0.000001);
  const normalizedCenter = result.asset.template.normalizedBounds.getCenter(
    new THREE.Vector3(),
  );
  assert.ok(Math.abs(normalizedCenter.x) < 0.000001);
  assert.ok(Math.abs(normalizedCenter.z) < 0.000001);
  assert.ok(Math.abs(result.asset.template.normalizedBounds.min.y) < 0.000001);

  const pool = result.asset.createInstancedPool(2, "test-authored-pool");
  assert.equal(pool.meshes.length, 2);
  const firstPlacement = new THREE.Matrix4().makeTranslation(10, 0, -5);
  const secondPlacement = new THREE.Matrix4().compose(
    new THREE.Vector3(-2, 1, 7),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
    new THREE.Vector3(1.2, 1.2, 1.2),
  );
  pool.setMatrixAt(0, firstPlacement);
  pool.setMatrixAt(1, secondPlacement);
  pool.commit(2);
  assert.ok(pool.meshes.every((mesh) => mesh.count === 2));
  assert.ok(pool.meshes.every((mesh) => mesh.castShadow && mesh.receiveShadow));

  const actual = new THREE.Matrix4();
  pool.meshes[1].getMatrixAt(1, actual);
  const expected = secondPlacement
    .clone()
    .multiply(result.asset.template.primitives[1].matrix);
  assert.ok(
    actual.elements.every((value, index) => Math.abs(value - expected.elements[index]) < 1e-6),
  );

  pool.dispose();
  assert.equal(geometryDisposals, 0, "instance pools never dispose shared template geometry");
  result.asset.dispose();
  assert.equal(geometryDisposals, 2, "an uncached lease releases source resources exactly once");
});

test("a normalized authored landmark hides visual fallbacks only while mounted", async () => {
  clearEnvironmentAssetCache();
  const geometry = new THREE.CylinderGeometry(5, 4.5, 0.8, 12, 1, true);
  const material = new THREE.MeshStandardMaterial({ color: 0x8b6f4c });
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(3, -1.2, -2);
  source.add(mesh);
  const result = await loadEnvironmentAsset(WAITLAND_PIT_ASSET_MANIFEST, {
    useCache: false,
    loaderFactory: () => ({
      async loadAsync() {
        return { scene: source, animations: [] };
      },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const normalized = result.asset.template.normalizedBounds;
  const normalizedSize = normalized.getSize(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(normalizedSize.x, normalizedSize.z) - PIT_WALL_RADIUS * 2) < 1e-6);
  assert.ok(
    Math.abs(normalized.min.y - -1.6 * result.asset.template.scale) < 1e-6,
    "authored pit preserves its below-grade source pivot for hybrid mounting",
  );

  const parent = new THREE.Group();
  const wallFallback = new THREE.Group();
  const lipFallback = new THREE.Group();
  parent.add(wallFallback, lipFallback);
  const mounted = mountEnvironmentAsset(parent, result.asset, {
    name: "test-authored-pit",
    fallbackObjects: [wallFallback, lipFallback],
  });
  assert.equal(wallFallback.visible, false);
  assert.equal(lipFallback.visible, false);
  assert.equal(mounted.root.parent, parent);
  assert.ok(mounted.root.children.every((child) => child.visible));

  mounted.dispose();
  assert.equal(wallFallback.visible, true);
  assert.equal(lipFallback.visible, true);
  assert.equal(mounted.root.parent, null);
  result.asset.dispose();
});

test("the mutable gameplay stone bakes its normalized authored transform", async () => {
  const source = new THREE.Group();
  const sourceGeometry = new THREE.BoxGeometry(2, 1, 1.5);
  const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d1c4 });
  const stone = new THREE.Mesh(sourceGeometry, sourceMaterial);
  stone.position.set(7, 2, -4);
  source.add(stone);
  const result = await loadEnvironmentAsset(WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST, {
    useCache: false,
    loaderFactory: () => ({
      async loadAsync() {
        return { scene: source, animations: [] };
      },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const baked = bakeSinglePrimitiveEnvironmentGeometry(result.asset.template);
  const bakedSize = baked.boundingBox.getSize(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(bakedSize.x, bakedSize.y, bakedSize.z) - WAITLAND_GAMEPLAY_STONE_SIZE) < 1e-6);
  assert.notEqual(baked, sourceGeometry);
  baked.dispose();
  result.asset.dispose();
});

test("a failed authored load leaves the visible fallback untouched", async () => {
  const fallback = new THREE.Group();
  const parent = new THREE.Group();
  parent.add(fallback);
  const result = await loadEnvironmentAsset(
    { ...WAITLAND_PIT_ASSET_MANIFEST, assetVersion: "missing-test" },
    {
      useCache: false,
      loaderFactory: () => ({
        async loadAsync() {
          throw new Error("missing test asset");
        },
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(fallback.visible, true);
  assert.equal(fallback.parent, parent);
});

test("the live scene has no statue visual or statue asset path", async () => {
  const sceneSource = await readFile(
    new URL("../app/waiting-pit.tsx", import.meta.url),
    "utf8",
  );
  const manifestSource = await readFile(
    new URL("../app/environment/environment-manifest.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sceneSource, /statue/i);
  assert.doesNotMatch(manifestSource, /statue/i);
});

test("an aborted in-flight environment load cannot install or leak its late GLB", async () => {
  const source = sourceScene();
  let resolveLoad;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let geometryDisposals = 0;
  source.trunkGeometry.addEventListener("dispose", () => {
    geometryDisposals += 1;
  });
  source.crownGeometry.addEventListener("dispose", () => {
    geometryDisposals += 1;
  });
  const controller = new AbortController();
  const pending = loadEnvironmentAsset(manifest(2), {
    useCache: false,
    signal: controller.signal,
    loaderFactory: () => ({
      loadAsync() {
        markStarted();
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      },
    }),
  });

  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "aborted");
  resolveLoad({ scene: source.root, animations: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(geometryDisposals, 2, "a late result is released after its last consumer aborts");
});
