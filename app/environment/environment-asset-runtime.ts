import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const ENVIRONMENT_ASSET_MANIFEST_SCHEMA_VERSION = 1 as const;

export type EnvironmentAssetMeasure = "height" | "footprint" | "max";

export type EnvironmentAssetManifest = {
  schemaVersion: typeof ENVIRONMENT_ASSET_MANIFEST_SCHEMA_VERSION;
  assetId: string;
  assetVersion: string | number;
  url: string;
  cacheKey?: string;
  normalization: {
    /** Uniform target extent in world units. */
    targetSize: number;
    /** Height, largest X/Z extent, or largest extent on any axis. */
    measure: EnvironmentAssetMeasure;
    ground?: boolean;
    centerXZ?: boolean;
    /** Applied before bounds are measured, for source-axis correction. */
    rotation?: readonly [number, number, number];
  };
  rendering?: {
    castShadow?: boolean;
    receiveShadow?: boolean;
  };
};

export type EnvironmentGltfLoader = Pick<GLTFLoader, "loadAsync">;

export type EnvironmentAssetLoadOptions = {
  loaderFactory?: () => EnvironmentGltfLoader;
  useCache?: boolean;
  signal?: AbortSignal;
};

export type EnvironmentAssetPrimitive = {
  readonly name: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material | readonly THREE.Material[];
  /** Normalization plus the authored mesh-node transform. */
  readonly matrix: THREE.Matrix4;
};

export type EnvironmentAssetTemplate = {
  readonly manifest: EnvironmentAssetManifest;
  readonly primitives: readonly EnvironmentAssetPrimitive[];
  readonly sourceBounds: THREE.Box3;
  readonly normalizedBounds: THREE.Box3;
  readonly normalizedSize: THREE.Vector3;
  readonly scale: number;
};

export type EnvironmentInstancedPool = {
  readonly root: THREE.Group;
  readonly meshes: readonly THREE.InstancedMesh[];
  readonly capacity: number;
  setMatrixAt: (index: number, matrix: THREE.Matrix4) => void;
  commit: (count: number) => void;
  dispose: () => void;
};

export type EnvironmentAssetLease = {
  readonly template: EnvironmentAssetTemplate;
  createInstancedPool: (capacity: number, name?: string) => EnvironmentInstancedPool;
  dispose: () => void;
};

export type MountedEnvironmentAsset = {
  readonly root: THREE.Group;
  dispose: () => void;
};

export type EnvironmentAssetLoadFailureReason =
  | "invalid-manifest"
  | "aborted"
  | "load-failed"
  | "invalid-model";

export type EnvironmentAssetLoadResult =
  | { ok: true; asset: EnvironmentAssetLease; cacheKey: string }
  | {
      ok: false;
      reason: EnvironmentAssetLoadFailureReason;
      error: Error;
      manifest: EnvironmentAssetManifest;
    };

type LoadedSource = {
  scene: THREE.Object3D;
  template: EnvironmentAssetTemplate;
};

type CacheEntry = {
  key: string;
  promise: Promise<LoadedSource>;
  loaded?: LoadedSource;
  references: number;
  pendingConsumers: number;
  disposeWhenUnused: boolean;
  disposed: boolean;
};

class EnvironmentAssetError extends Error {
  readonly reason: EnvironmentAssetLoadFailureReason;

  constructor(reason: EnvironmentAssetLoadFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnvironmentAssetError";
    this.reason = reason;
  }
}

const templateCache = new Map<string, CacheEntry>();

function errorFrom(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function validateManifest(manifest: EnvironmentAssetManifest) {
  if (!manifest || manifest.schemaVersion !== ENVIRONMENT_ASSET_MANIFEST_SCHEMA_VERSION) {
    return "Unsupported or missing environment-asset manifest schema version.";
  }
  if (typeof manifest.assetId !== "string" || !manifest.assetId.trim()) {
    return "The environment-asset manifest needs an assetId.";
  }
  const validVersion =
    (typeof manifest.assetVersion === "string" && Boolean(manifest.assetVersion.trim())) ||
    (typeof manifest.assetVersion === "number" && Number.isFinite(manifest.assetVersion));
  if (!validVersion) return "The environment-asset manifest needs an assetVersion.";
  if (typeof manifest.url !== "string" || !manifest.url.trim()) {
    return "The environment-asset manifest needs a GLB URL.";
  }
  const normalization = manifest.normalization;
  if (
    !normalization ||
    !Number.isFinite(normalization.targetSize) ||
    !(normalization.targetSize > 0) ||
    !["height", "footprint", "max"].includes(normalization.measure)
  ) {
    return "Environment normalization needs a positive targetSize and a supported measure.";
  }
  if (
    normalization.rotation !== undefined &&
    (!Array.isArray(normalization.rotation) ||
      normalization.rotation.length !== 3 ||
      normalization.rotation.some((value) => !Number.isFinite(value)))
  ) {
    return "normalization.rotation must be a finite Euler triplet.";
  }
  return undefined;
}

export function environmentAssetCacheKey(manifest: EnvironmentAssetManifest) {
  return (
    manifest.cacheKey?.trim() ||
    `${manifest.schemaVersion}:${manifest.assetId}@${manifest.assetVersion}:${manifest.url}`
  );
}

function orientedBoundsFor(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  target: THREE.Box3,
) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
  const bounds = geometry.boundingBox.clone().applyMatrix4(matrix);
  target.union(bounds);
}

function measurement(size: THREE.Vector3, measure: EnvironmentAssetMeasure) {
  if (measure === "height") return size.y;
  if (measure === "footprint") return Math.max(size.x, size.z);
  return Math.max(size.x, size.y, size.z);
}

/**
 * Extracts each authored mesh/material primitive and bakes only node transforms
 * into its instance base matrix. Geometry/material data stays shared.
 */
export function extractNormalizedEnvironmentTemplate(
  scene: THREE.Object3D,
  manifest: EnvironmentAssetManifest,
): EnvironmentAssetTemplate {
  const validationError = validateManifest(manifest);
  if (validationError) {
    throw new EnvironmentAssetError("invalid-manifest", validationError);
  }

  scene.updateWorldMatrix(true, true);
  const rotation = manifest.normalization.rotation ?? [0, 0, 0];
  const orientation = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(rotation[0], rotation[1], rotation[2], "XYZ"),
  );
  const sources: Array<{
    name: string;
    geometry: THREE.BufferGeometry;
    material: THREE.Material | readonly THREE.Material[];
    matrix: THREE.Matrix4;
  }> = [];
  const sourceBounds = new THREE.Box3().makeEmpty();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !mesh.material) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      throw new EnvironmentAssetError(
        "invalid-model",
        `Environment asset ${manifest.assetId} contains a skinned mesh (${mesh.name}).`,
      );
    }
    const matrix = orientation.clone().multiply(mesh.matrixWorld);
    orientedBoundsFor(mesh.geometry, matrix, sourceBounds);
    sources.push({
      name: mesh.name || `${manifest.assetId}-primitive-${sources.length}`,
      geometry: mesh.geometry,
      material: mesh.material,
      matrix,
    });
  });

  if (sources.length === 0 || sourceBounds.isEmpty()) {
    throw new EnvironmentAssetError(
      "invalid-model",
      `Environment GLB ${manifest.url} contains no renderable mesh primitives.`,
    );
  }

  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const measuredSize = measurement(sourceSize, manifest.normalization.measure);
  if (!Number.isFinite(measuredSize) || measuredSize <= Number.EPSILON) {
    throw new EnvironmentAssetError(
      "invalid-model",
      `Environment GLB ${manifest.url} has degenerate bounds.`,
    );
  }

  const scale = manifest.normalization.targetSize / measuredSize;
  const center = sourceBounds.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(
    manifest.normalization.centerXZ === false ? 0 : -center.x,
    manifest.normalization.ground === false ? 0 : -sourceBounds.min.y,
    manifest.normalization.centerXZ === false ? 0 : -center.z,
  );
  const normalization = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));

  const normalizedBounds = new THREE.Box3().makeEmpty();
  const primitives = sources.map((source) => {
    const matrix = normalization.clone().multiply(source.matrix);
    orientedBoundsFor(source.geometry, matrix, normalizedBounds);
    return {
      name: source.name,
      geometry: source.geometry,
      material: source.material,
      matrix,
    } satisfies EnvironmentAssetPrimitive;
  });

  return {
    manifest,
    primitives,
    sourceBounds,
    normalizedBounds,
    normalizedSize: normalizedBounds.getSize(new THREE.Vector3()),
    scale,
  };
}

function collectAndDisposeSource(source: LoadedSource) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const primitive of source.template.primitives) {
    geometries.add(primitive.geometry);
    const primitiveMaterials = Array.isArray(primitive.material)
      ? primitive.material
      : [primitive.material];
    for (const material of primitiveMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  }
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function maybeDisposeEntry(entry: CacheEntry) {
  if (
    !entry.disposeWhenUnused ||
    entry.disposed ||
    entry.references > 0 ||
    entry.pendingConsumers > 0 ||
    !entry.loaded
  ) {
    return;
  }
  entry.disposed = true;
  collectAndDisposeSource(entry.loaded);
}

function createEntry(
  manifest: EnvironmentAssetManifest,
  loaderFactory: (() => EnvironmentGltfLoader) | undefined,
  disposeWhenUnused: boolean,
) {
  const key = environmentAssetCacheKey(manifest);
  const entry: CacheEntry = {
    key,
    promise: undefined as unknown as Promise<LoadedSource>,
    references: 0,
    pendingConsumers: 0,
    disposeWhenUnused,
    disposed: false,
  };
  entry.promise = Promise.resolve()
    .then(() => (loaderFactory ? loaderFactory() : new GLTFLoader()))
    .then((loader) => loader.loadAsync(manifest.url))
    .then((gltf: GLTF) => {
      if (!gltf.scene) {
        throw new EnvironmentAssetError(
          "invalid-model",
          `Environment GLB ${manifest.url} did not contain a default scene.`,
        );
      }
      const loaded = {
        scene: gltf.scene,
        template: extractNormalizedEnvironmentTemplate(gltf.scene, manifest),
      };
      entry.loaded = loaded;
      maybeDisposeEntry(entry);
      return loaded;
    })
    .catch((error) => {
      if (templateCache.get(key) === entry) templateCache.delete(key);
      throw error;
    });
  return entry;
}

function acquireEntry(manifest: EnvironmentAssetManifest, options: EnvironmentAssetLoadOptions) {
  const key = environmentAssetCacheKey(manifest);
  if (options.useCache === false) {
    return createEntry(manifest, options.loaderFactory, true);
  }
  const cached = templateCache.get(key);
  if (cached) return cached;
  const entry = createEntry(manifest, options.loaderFactory, false);
  templateCache.set(key, entry);
  return entry;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new EnvironmentAssetError("aborted", "Environment load aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new EnvironmentAssetError("aborted", "Environment load aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function createInstancedPool(
  template: EnvironmentAssetTemplate,
  capacity: number,
  name = `${template.manifest.assetId}-instances`,
): EnvironmentInstancedPool {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error("Environment instance-pool capacity must be a positive integer.");
  }
  const root = new THREE.Group();
  root.name = name;
  const meshes = template.primitives.map((primitive, primitiveIndex) => {
    const mesh = new THREE.InstancedMesh(
      primitive.geometry,
      primitive.material as THREE.Material | THREE.Material[],
      capacity,
    );
    mesh.name = `${name}:primitive-${primitiveIndex}:${primitive.name}`;
    mesh.castShadow = template.manifest.rendering?.castShadow ?? false;
    mesh.receiveShadow = template.manifest.rendering?.receiveShadow ?? true;
    mesh.frustumCulled = true;
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });
  const composed = new THREE.Matrix4();
  let disposed = false;

  return {
    root,
    meshes,
    capacity,
    setMatrixAt(index, matrix) {
      if (disposed) return;
      if (!Number.isInteger(index) || index < 0 || index >= capacity) {
        throw new RangeError(`Environment instance index ${index} exceeds capacity ${capacity}.`);
      }
      for (let primitiveIndex = 0; primitiveIndex < meshes.length; primitiveIndex += 1) {
        composed.multiplyMatrices(matrix, template.primitives[primitiveIndex].matrix);
        meshes[primitiveIndex].setMatrixAt(index, composed);
      }
    },
    commit(count) {
      if (disposed) return;
      const safeCount = Math.max(0, Math.min(capacity, Math.floor(count)));
      for (const mesh of meshes) {
        mesh.count = safeCount;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove(...meshes);
      for (const mesh of meshes) mesh.dispose();
    },
  };
}

/**
 * Mounts one normalized authored prop and only then hides its procedural visual
 * fallback. A failed load never calls this helper, so fallback presentation is
 * preserved. Disposing reverses the visibility swap without touching shared
 * decoded GLB resources.
 */
export function mountEnvironmentAsset(
  parent: THREE.Object3D,
  asset: EnvironmentAssetLease,
  options: {
    name?: string;
    matrix?: THREE.Matrix4;
    fallbackObjects?: readonly THREE.Object3D[];
  } = {},
): MountedEnvironmentAsset {
  const pool = asset.createInstancedPool(1, options.name);
  pool.setMatrixAt(0, options.matrix ?? new THREE.Matrix4());
  pool.commit(1);
  parent.add(pool.root);
  for (const fallback of options.fallbackObjects ?? []) fallback.visible = false;
  let disposed = false;

  return {
    root: pool.root,
    dispose() {
      if (disposed) return;
      disposed = true;
      parent.remove(pool.root);
      pool.dispose();
      for (const fallback of options.fallbackObjects ?? []) fallback.visible = true;
    },
  };
}

/**
 * Produces one independently disposable geometry with the asset's normalized
 * node transform baked in. This is intended for gameplay props that must stay
 * ordinary mutable meshes (for example a rock reparented from field to hand to
 * projectile) while still sharing one decoded source asset and texture set.
 */
export function bakeSinglePrimitiveEnvironmentGeometry(
  template: EnvironmentAssetTemplate,
): THREE.BufferGeometry {
  if (template.primitives.length !== 1) {
    throw new EnvironmentAssetError(
      "invalid-model",
      `Environment asset ${template.manifest.assetId} needs exactly one primitive for a mutable gameplay mesh.`,
    );
  }
  const primitive = template.primitives[0];
  const geometry = primitive.geometry.clone();
  geometry.name = `${template.manifest.assetId}-normalized-gameplay-geometry`;
  geometry.applyMatrix4(primitive.matrix);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function loadEnvironmentAsset(
  manifest: EnvironmentAssetManifest,
  options: EnvironmentAssetLoadOptions = {},
): Promise<EnvironmentAssetLoadResult> {
  const validationError = validateManifest(manifest);
  if (validationError) {
    return {
      ok: false,
      reason: "invalid-manifest",
      error: new Error(validationError),
      manifest,
    };
  }
  if (options.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      error: new Error("Environment load aborted."),
      manifest,
    };
  }

  const entry = acquireEntry(manifest, options);
  entry.pendingConsumers += 1;
  try {
    const loaded = await awaitWithAbort(entry.promise, options.signal);
    entry.references += 1;
    let released = false;
    const lease: EnvironmentAssetLease = {
      template: loaded.template,
      createInstancedPool(capacity, name) {
        return createInstancedPool(loaded.template, capacity, name);
      },
      dispose() {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        maybeDisposeEntry(entry);
      },
    };
    return { ok: true, asset: lease, cacheKey: entry.key };
  } catch (error) {
    const reason =
      error instanceof EnvironmentAssetError ? error.reason : "load-failed";
    return { ok: false, reason, error: errorFrom(error), manifest };
  } finally {
    entry.pendingConsumers = Math.max(0, entry.pendingConsumers - 1);
    maybeDisposeEntry(entry);
  }
}

/** Evicts one decoded model or the complete bounded environment cache. */
export function clearEnvironmentAssetCache(cacheKey?: string) {
  const entries = cacheKey
    ? ([templateCache.get(cacheKey)].filter(Boolean) as CacheEntry[])
    : [...templateCache.values()];
  for (const entry of entries) {
    if (templateCache.get(entry.key) === entry) templateCache.delete(entry.key);
    entry.disposeWhenUnused = true;
    maybeDisposeEntry(entry);
  }
  return entries.length;
}
