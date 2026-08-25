import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeletonSafe } from "three/examples/jsm/utils/SkeletonUtils.js";

export const RIGGED_AVATAR_MANIFEST_SCHEMA_VERSION = 1 as const;

export type RiggedAvatarClipSelector = string | readonly string[];
export type RiggedAvatarAnimationSlot =
  | "idle"
  | "walk"
  | "carryIdle"
  | "carryWalk"
  | "interact";
export type RiggedAvatarActiveAnimation = RiggedAvatarAnimationSlot | "rest";

export type RiggedAvatarBoneRole =
  | "hips"
  | "spine"
  | "head"
  | "leftUpperArm"
  | "leftForeArm"
  | "leftHand"
  | "rightUpperArm"
  | "rightForeArm"
  | "rightHand";

export type RiggedAvatarBoneTransform = {
  /** Local Euler offset in radians, applied after animation evaluation. */
  rotation: readonly [number, number, number];
  weight?: number;
};

export type RiggedAvatarPosture = Partial<
  Record<RiggedAvatarBoneRole, RiggedAvatarBoneTransform>
>;

export type RiggedAvatarAnchorSpec = {
  bone?: RiggedAvatarBoneRole;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  fallbackPosition?: readonly [number, number, number];
};

export type RiggedAvatarManifest = {
  schemaVersion: typeof RIGGED_AVATAR_MANIFEST_SCHEMA_VERSION;
  assetId: string;
  /** Bump whenever the shipped GLB changes. It participates in the cache key. */
  assetVersion: string | number;
  url: string;
  /** Override only when the same asset/version URL needs a distinct decode cache. */
  cacheKey?: string;
  animations: {
    /** A rigged runtime requires a walk clip; aliases may be listed in priority order. */
    walk: RiggedAvatarClipSelector;
    idle?: RiggedAvatarClipSelector;
    carryIdle?: RiggedAvatarClipSelector;
    carryWalk?: RiggedAvatarClipSelector;
    /** Optional one-shot pickup/throw or similar interaction clip. */
    interact?: RiggedAvatarClipSelector;
    fadeSeconds?: number;
    walkTimeScale?: number;
    interactTimeScale?: number;
  };
  normalization?: {
    /** Defaults to the procedural character's approximate three-unit height. */
    targetHeight?: number | null;
    scaleMultiplier?: number;
    centerXZ?: boolean;
    ground?: boolean;
    sourceForward?: "-z" | "+z";
  };
  /** Explicit aliases are tried before conservative Mixamo/common-name aliases. */
  bones?: Partial<Record<RiggedAvatarBoneRole, string | readonly string[]>>;
  /** Optional offsets avoid topology assumptions when no dedicated carry clip exists. */
  postures?: {
    idle?: RiggedAvatarPosture;
    carry?: RiggedAvatarPosture;
  };
  anchors?: {
    head?: RiggedAvatarAnchorSpec;
    heldItem?: RiggedAvatarAnchorSpec;
    speechPosition?: readonly [number, number, number];
  };
};

export type RiggedAvatarMotion = {
  moving?: boolean;
  /** Normalized 0..1 locomotion intensity, used only as a playback-rate hint. */
  speed?: number;
  carryingStone?: boolean;
};

export type RiggedAvatarInteractionOptions = {
  timeScale?: number;
  fadeSeconds?: number;
  /** An interaction already in progress is ignored unless restart is true. */
  restart?: boolean;
};

export type RiggedAvatarLoader = Pick<GLTFLoader, "loadAsync">;

export type RiggedAvatarLoadOptions = {
  /** Configure Draco/KTX2/Meshopt by returning a prepared loader. */
  loaderFactory?: () => RiggedAvatarLoader;
  useCache?: boolean;
  signal?: AbortSignal;
  initialMotion?: RiggedAvatarMotion;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export type RiggedAvatarResolvedClips = Readonly<
  Partial<Record<RiggedAvatarAnimationSlot, THREE.AnimationClip>> & {
    walk: THREE.AnimationClip;
  }
>;

export type RiggedAvatarRuntime = {
  readonly manifest: RiggedAvatarManifest;
  readonly root: THREE.Group;
  readonly model: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly clips: RiggedAvatarResolvedClips;
  readonly actions: Readonly<Partial<Record<RiggedAvatarAnimationSlot, THREE.AnimationAction>>>;
  readonly materials: readonly THREE.Material[];
  readonly bones: Readonly<Partial<Record<RiggedAvatarBoneRole, THREE.Bone>>>;
  readonly anchors: Readonly<{
    head: THREE.Group;
    heldItem: THREE.Group;
    speech: THREE.Group;
  }>;
  readonly normalizedHeight: number;
  readonly activeAnimation: RiggedAvatarActiveAnimation;
  readonly motion: Readonly<Required<RiggedAvatarMotion>>;
  setMotion: (motion: RiggedAvatarMotion, fadeSeconds?: number) => void;
  /** Returns false when the manifest has no interaction clip or one is already active. */
  playInteraction: (options?: RiggedAvatarInteractionOptions) => boolean;
  update: (deltaSeconds: number, motion?: RiggedAvatarMotion) => void;
  dispose: () => void;
};

export type RiggedAvatarFailureReason =
  | "invalid-manifest"
  | "aborted"
  | "load-failed"
  | "invalid-model"
  | "missing-walk-animation";

export type RiggedAvatarLoadSuccess = {
  ok: true;
  avatar: RiggedAvatarRuntime;
  cacheKey: string;
};

export type RiggedAvatarLoadFailure = {
  ok: false;
  reason: RiggedAvatarFailureReason;
  error: Error;
  manifest: RiggedAvatarManifest;
};

export type RiggedAvatarLoadResult = RiggedAvatarLoadSuccess | RiggedAvatarLoadFailure;

export type RiggedAvatarPreloadResult =
  | {
      ok: true;
      cacheKey: string;
      animationNames: readonly string[];
    }
  | RiggedAvatarLoadFailure;

type LoadedTemplate = {
  scene: THREE.Object3D;
  animations: readonly THREE.AnimationClip[];
};

type CacheEntry = {
  key: string;
  promise: Promise<LoadedTemplate>;
  template?: LoadedTemplate;
  references: number;
  pendingConsumers: number;
  disposeWhenUnused: boolean;
  disposed: boolean;
};

class RuntimeLoadError extends Error {
  readonly reason: RiggedAvatarFailureReason;

  constructor(
    reason: RiggedAvatarFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RiggedAvatarLoadError";
    this.reason = reason;
  }
}

const templateCache = new Map<string, CacheEntry>();

const DEFAULT_BONE_ALIASES: Record<RiggedAvatarBoneRole, readonly string[]> = {
  hips: ["Hips", "mixamorigHips", "mixamorig:Hips", "Pelvis", "Root"],
  spine: ["Spine", "Spine1", "mixamorigSpine", "mixamorig:Spine"],
  head: ["Head", "mixamorigHead", "mixamorig:Head"],
  leftUpperArm: ["LeftArm", "LeftUpperArm", "mixamorigLeftArm", "mixamorig:LeftArm"],
  leftForeArm: [
    "LeftForeArm",
    "LeftLowerArm",
    "mixamorigLeftForeArm",
    "mixamorig:LeftForeArm",
  ],
  leftHand: ["LeftHand", "mixamorigLeftHand", "mixamorig:LeftHand"],
  rightUpperArm: ["RightArm", "RightUpperArm", "mixamorigRightArm", "mixamorig:RightArm"],
  rightForeArm: [
    "RightForeArm",
    "RightLowerArm",
    "mixamorigRightForeArm",
    "mixamorig:RightForeArm",
  ],
  rightHand: ["RightHand", "mixamorigRightHand", "mixamorig:RightHand"],
};

const BONE_ROLES = Object.keys(DEFAULT_BONE_ALIASES) as RiggedAvatarBoneRole[];
const DEFAULT_IDLE_CLIPS = ["idle", "standingidle", "breathingidle"] as const;

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function errorFrom(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function failure(
  manifest: RiggedAvatarManifest,
  reason: RiggedAvatarFailureReason,
  error: unknown,
): RiggedAvatarLoadFailure {
  return { ok: false, reason, error: errorFrom(error), manifest };
}

function normalizedName(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function selectorValues(selector: unknown) {
  if (typeof selector === "string") return selector.trim() ? [selector] : [];
  if (!Array.isArray(selector)) return [];
  return selector.filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
}

function findClip(
  animations: readonly THREE.AnimationClip[],
  selector: RiggedAvatarClipSelector | undefined,
  automaticNames: readonly string[] = [],
) {
  const requested = selectorValues(selector);
  const candidates = requested.length > 0 ? requested : automaticNames;
  if (candidates.length === 0) return undefined;

  for (const candidate of candidates) {
    const exact = animations.find(
      (clip) => clip.name.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
    );
    if (exact) return exact;
  }

  const normalizedCandidates = candidates.map(normalizedName);
  for (const candidate of normalizedCandidates) {
    const exact = animations.find((clip) => normalizedName(clip.name) === candidate);
    if (exact) return exact;
  }

  for (const candidate of normalizedCandidates) {
    const partial = animations.find((clip) => normalizedName(clip.name).includes(candidate));
    if (partial) return partial;
  }
  return undefined;
}

/** Resolves clip aliases without mutating the cached GLTF animations. */
export function resolveRiggedAvatarClips(
  animations: readonly THREE.AnimationClip[],
  manifest: RiggedAvatarManifest,
): RiggedAvatarResolvedClips {
  const walk = findClip(animations, manifest.animations.walk);
  if (!walk) {
    throw new RuntimeLoadError(
      "missing-walk-animation",
      `Rigged avatar ${manifest.assetId}@${manifest.assetVersion} has no matching walk clip.`,
    );
  }

  return {
    walk,
    idle: findClip(animations, manifest.animations.idle, DEFAULT_IDLE_CLIPS),
    carryIdle: findClip(animations, manifest.animations.carryIdle),
    carryWalk: findClip(animations, manifest.animations.carryWalk),
    interact: findClip(animations, manifest.animations.interact),
  };
}

function validSelector(selector: unknown) {
  return selectorValues(selector).length > 0;
}

function validateManifest(manifest: RiggedAvatarManifest) {
  if (!manifest || manifest.schemaVersion !== RIGGED_AVATAR_MANIFEST_SCHEMA_VERSION) {
    return "Unsupported or missing rigged-avatar manifest schema version.";
  }
  if (typeof manifest.assetId !== "string" || !manifest.assetId.trim()) {
    return "The rigged-avatar manifest needs an assetId.";
  }
  const validVersion =
    (typeof manifest.assetVersion === "string" && Boolean(manifest.assetVersion.trim())) ||
    (typeof manifest.assetVersion === "number" && Number.isFinite(manifest.assetVersion));
  if (!validVersion) {
    return "The rigged-avatar manifest needs an assetVersion.";
  }
  if (typeof manifest.url !== "string" || !manifest.url.trim()) {
    return "The rigged-avatar manifest needs a GLB URL.";
  }
  if (manifest.cacheKey !== undefined && typeof manifest.cacheKey !== "string") {
    return "cacheKey must be a string when supplied.";
  }
  if (
    !manifest.animations ||
    typeof manifest.animations !== "object" ||
    !validSelector(manifest.animations.walk)
  ) {
    return "The rigged-avatar manifest needs at least one walk animation alias.";
  }
  const targetHeight = manifest.normalization?.targetHeight;
  if (
    targetHeight !== undefined &&
    targetHeight !== null &&
    (!Number.isFinite(targetHeight) || !(targetHeight > 0))
  ) {
    return "normalization.targetHeight must be positive or null.";
  }
  const scaleMultiplier = manifest.normalization?.scaleMultiplier;
  if (
    scaleMultiplier !== undefined &&
    (!Number.isFinite(scaleMultiplier) || !(scaleMultiplier > 0))
  ) {
    return "normalization.scaleMultiplier must be positive.";
  }
  return undefined;
}

export function riggedAvatarCacheKey(manifest: RiggedAvatarManifest) {
  return (
    manifest.cacheKey?.trim() ||
    `${manifest.schemaVersion}:${manifest.assetId}@${manifest.assetVersion}:${manifest.url}`
  );
}

function disposeTemplate(template: LoadedTemplate) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  template.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function maybeDisposeEntry(entry: CacheEntry) {
  if (
    !entry.disposeWhenUnused ||
    entry.disposed ||
    entry.references > 0 ||
    entry.pendingConsumers > 0 ||
    !entry.template
  ) {
    return;
  }
  entry.disposed = true;
  disposeTemplate(entry.template);
}

function createCacheEntry(
  key: string,
  url: string,
  loaderFactory: (() => RiggedAvatarLoader) | undefined,
  disposeWhenUnused: boolean,
) {
  const entry: CacheEntry = {
    key,
    promise: undefined as unknown as Promise<LoadedTemplate>,
    references: 0,
    pendingConsumers: 0,
    disposeWhenUnused,
    disposed: false,
  };

  entry.promise = Promise.resolve()
    .then(() => (loaderFactory ? loaderFactory() : new GLTFLoader()))
    .then((loader) => loader.loadAsync(url))
    .then((gltf: GLTF) => {
      if (!gltf.scene) {
        throw new RuntimeLoadError("invalid-model", `GLB ${url} did not contain a default scene.`);
      }
      const template = { scene: gltf.scene, animations: gltf.animations ?? [] };
      entry.template = template;
      maybeDisposeEntry(entry);
      return template;
    })
    .catch((error) => {
      if (templateCache.get(key) === entry) templateCache.delete(key);
      throw error;
    });
  return entry;
}

function acquireCacheEntry(manifest: RiggedAvatarManifest, options: RiggedAvatarLoadOptions) {
  const key = riggedAvatarCacheKey(manifest);
  if (options.useCache === false) {
    return createCacheEntry(key, manifest.url, options.loaderFactory, true);
  }

  const cached = templateCache.get(key);
  if (cached) return cached;
  const entry = createCacheEntry(key, manifest.url, options.loaderFactory, false);
  templateCache.set(key, entry);
  return entry;
}

function reasonFromError(error: unknown): RiggedAvatarFailureReason {
  return error instanceof RuntimeLoadError ? error.reason : "load-failed";
}

/**
 * Evicts decoded templates. Active instances remain valid and release the
 * shared GPU resources when their own `dispose()` calls drop the last lease.
 */
export function clearRiggedAvatarCache(cacheKey?: string) {
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

export async function preloadRiggedAvatar(
  manifest: RiggedAvatarManifest,
  options: Omit<RiggedAvatarLoadOptions, "initialMotion"> = {},
): Promise<RiggedAvatarPreloadResult> {
  const validationError = validateManifest(manifest);
  if (validationError) return failure(manifest, "invalid-manifest", new Error(validationError));
  if (options.signal?.aborted) return failure(manifest, "aborted", new Error("Avatar load aborted."));

  const entry = acquireCacheEntry(manifest, options);
  entry.pendingConsumers += 1;
  try {
    const template = await entry.promise;
    if (options.signal?.aborted) {
      return failure(manifest, "aborted", new Error("Avatar load aborted."));
    }
    resolveRiggedAvatarClips(template.animations, manifest);
    return {
      ok: true,
      cacheKey: entry.key,
      animationNames: template.animations.map((clip) => clip.name),
    };
  } catch (error) {
    return failure(manifest, reasonFromError(error), error);
  } finally {
    entry.pendingConsumers -= 1;
    maybeDisposeEntry(entry);
  }
}

function cloneInstanceMaterials(model: THREE.Object3D) {
  const clones = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const cloneMaterial = (material: THREE.Material) => {
      let clone = clones.get(material);
      if (!clone) {
        clone = material.clone();
        clones.set(material, clone);
      }
      return clone;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(cloneMaterial)
      : cloneMaterial(mesh.material);
  });
  return [...clones.values()];
}

function resolveBones(model: THREE.Object3D, manifest: RiggedAvatarManifest) {
  const allBones: THREE.Bone[] = [];
  model.traverse((object) => {
    const bone = object as THREE.Bone;
    if (bone.isBone) allBones.push(bone);
  });

  const normalizedBones = new Map<string, THREE.Bone>();
  for (const bone of allBones) {
    const key = normalizedName(bone.name);
    if (!normalizedBones.has(key)) normalizedBones.set(key, bone);
  }

  const result: Partial<Record<RiggedAvatarBoneRole, THREE.Bone>> = {};
  for (const role of BONE_ROLES) {
    const explicit = manifest.bones?.[role];
    const candidates = [
      ...(typeof explicit === "string" ? [explicit] : (explicit ?? [])),
      ...DEFAULT_BONE_ALIASES[role],
    ];
    for (const candidate of candidates) {
      const exact = allBones.find((bone) => bone.name === candidate);
      const match = exact ?? normalizedBones.get(normalizedName(candidate));
      if (match) {
        result[role] = match;
        break;
      }
    }
  }
  return result;
}

function normalizeModel(model: THREE.Object3D, manifest: RiggedAvatarManifest) {
  model.updateMatrixWorld(true);
  const sourceBounds = new THREE.Box3().setFromObject(model, true);
  if (sourceBounds.isEmpty()) {
    throw new RuntimeLoadError(
      "invalid-model",
      `Rigged avatar ${manifest.assetId}@${manifest.assetVersion} has no renderable bounds.`,
    );
  }

  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(sourceSize.y) || sourceSize.y <= 1e-5) {
    throw new RuntimeLoadError(
      "invalid-model",
      `Rigged avatar ${manifest.assetId}@${manifest.assetVersion} has invalid height.`,
    );
  }

  const normalization = manifest.normalization;
  const targetHeight = normalization?.targetHeight === undefined ? 3 : normalization.targetHeight;
  const automaticScale = targetHeight === null ? 1 : targetHeight / sourceSize.y;
  const scale = automaticScale * (normalization?.scaleMultiplier ?? 1);
  const center = sourceBounds.getCenter(new THREE.Vector3());

  const content = new THREE.Group();
  content.name = "rigged-avatar-content";
  content.position.set(
    normalization?.centerXZ === false ? 0 : -center.x,
    normalization?.ground === false ? 0 : -sourceBounds.min.y,
    normalization?.centerXZ === false ? 0 : -center.z,
  );
  content.add(model);

  const normalizedRoot = new THREE.Group();
  normalizedRoot.name = "rigged-avatar-normalization";
  normalizedRoot.scale.setScalar(scale);
  if (normalization?.sourceForward === "+z") normalizedRoot.rotation.y = Math.PI;
  normalizedRoot.add(content);
  return { normalizedRoot, normalizedHeight: sourceSize.y * scale };
}

function postureQuaternion(transform: RiggedAvatarBoneTransform) {
  const [x, y, z] = transform.rotation;
  const target = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      Number.isFinite(x) ? x : 0,
      Number.isFinite(y) ? y : 0,
      Number.isFinite(z) ? z : 0,
      "XYZ",
    ),
  );
  return new THREE.Quaternion().slerp(target, clamp(transform.weight ?? 1, 0, 1));
}

function tupleToVector(
  value: readonly [number, number, number] | undefined,
  fallback: readonly [number, number, number],
) {
  const source = value ?? fallback;
  return new THREE.Vector3(
    Number.isFinite(source[0]) ? source[0] : fallback[0],
    Number.isFinite(source[1]) ? source[1] : fallback[1],
    Number.isFinite(source[2]) ? source[2] : fallback[2],
  );
}

function instantiateRuntime(
  entry: CacheEntry,
  template: LoadedTemplate,
  clips: RiggedAvatarResolvedClips,
  manifest: RiggedAvatarManifest,
  options: Pick<RiggedAvatarLoadOptions, "initialMotion" | "castShadow" | "receiveShadow">,
): RiggedAvatarRuntime {
  const cloned = cloneSkeletonSafe(template.scene);
  const instanceMaterials = cloneInstanceMaterials(cloned);
  cloned.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? false;
  });
  let leaseAcquired = false;

  try {
    const { normalizedRoot, normalizedHeight } = normalizeModel(cloned, manifest);
    const root = new THREE.Group();
    root.name = `rigged-avatar:${manifest.assetId}@${manifest.assetVersion}`;
    root.add(normalizedRoot);

    const mixer = new THREE.AnimationMixer(cloned);
    const actions: Partial<Record<RiggedAvatarAnimationSlot, THREE.AnimationAction>> = {};
    for (const slot of ["idle", "walk", "carryIdle", "carryWalk", "interact"] as const) {
      const clip = clips[slot];
      if (!clip) continue;
      // A dedicated clip object prevents an accidental alias from changing a
      // looping locomotion action into LoopOnce.
      const action = mixer.clipAction(slot === "interact" ? clip.clone() : clip, cloned);
      if (slot === "interact") {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      actions[slot] = action;
    }

    const bones = resolveBones(cloned, manifest);
    const headAnchor = new THREE.Group();
    headAnchor.name = "rigged-avatar-head-anchor";
    const heldItemAnchor = new THREE.Group();
    heldItemAnchor.name = "rigged-avatar-held-item-anchor";
    const speechAnchor = new THREE.Group();
    speechAnchor.name = "rigged-avatar-speech-anchor";
    root.add(headAnchor, heldItemAnchor, speechAnchor);

    const defaultSpeechPosition: readonly [number, number, number] = [0, normalizedHeight + 0.24, 0];
    speechAnchor.position.copy(
      tupleToVector(manifest.anchors?.speechPosition, defaultSpeechPosition),
    );

    let activeAnimation: RiggedAvatarActiveAnimation = "rest";
    let activeAction: THREE.AnimationAction | undefined;
    let interactionPlaying = false;
    let motion: Required<RiggedAvatarMotion> = {
      moving: options.initialMotion?.moving ?? false,
      speed: options.initialMotion?.speed ?? 0,
      carryingStone: options.initialMotion?.carryingStone ?? false,
    };
    const appliedPostureOffsets = new Map<THREE.Bone, THREE.Quaternion>();
    let disposed = false;

    const rootWorldQuaternion = new THREE.Quaternion();
    const anchorWorldQuaternion = new THREE.Quaternion();
    const anchorPosition = new THREE.Vector3();
    const anchorOffsetQuaternion = new THREE.Quaternion();

    function desiredAnimation(nextMotion: Required<RiggedAvatarMotion>) {
      if (nextMotion.carryingStone && nextMotion.moving && actions.carryWalk) {
        return "carryWalk" as const;
      }
      if (nextMotion.carryingStone && !nextMotion.moving && actions.carryIdle) {
        return "carryIdle" as const;
      }
      if (nextMotion.moving) return "walk" as const;
      if (actions.idle) return "idle" as const;
      return "rest" as const;
    }

    function transitionToMotion(fadeSeconds = manifest.animations.fadeSeconds ?? 0.18) {
      const desired = desiredAnimation(motion);
      const nextAction = desired === "rest" ? undefined : actions[desired];
      const fade = clamp(fadeSeconds, 0, 2);

      if (nextAction !== activeAction) {
        if (activeAction) activeAction.fadeOut(fade);
        if (nextAction) {
          nextAction.reset().setEffectiveWeight(1).fadeIn(activeAction ? fade : 0).play();
        }
        activeAction = nextAction;
      }
      activeAnimation = desired;

      if (activeAction) {
        const walking = activeAnimation === "walk" || activeAnimation === "carryWalk";
        const speedFactor = walking ? 0.68 + motion.speed * 0.52 : 1;
        const configuredTimeScale = manifest.animations.walkTimeScale;
        const walkTimeScale =
          typeof configuredTimeScale === "number" &&
          Number.isFinite(configuredTimeScale) &&
          configuredTimeScale > 0
            ? configuredTimeScale
            : 1;
        activeAction.setEffectiveTimeScale(
          speedFactor * (walking ? walkTimeScale : 1),
        );
      }
    }

    function setMotion(next: RiggedAvatarMotion, fadeSeconds = manifest.animations.fadeSeconds ?? 0.18) {
      if (disposed) return;
      motion = {
        moving: next.moving ?? motion.moving,
        speed: clamp(next.speed ?? motion.speed, 0, 1),
        carryingStone: next.carryingStone ?? motion.carryingStone,
      };
      heldItemAnchor.visible = motion.carryingStone;
      if (!interactionPlaying) transitionToMotion(fadeSeconds);
    }

    function playInteraction(options: RiggedAvatarInteractionOptions = {}) {
      if (disposed || !actions.interact) return false;
      if (interactionPlaying && !options.restart) return false;

      const interaction = actions.interact;
      const fade = clamp(options.fadeSeconds ?? manifest.animations.fadeSeconds ?? 0.18, 0, 2);
      const configuredTimeScale = options.timeScale ?? manifest.animations.interactTimeScale;
      const timeScale =
        typeof configuredTimeScale === "number" &&
        Number.isFinite(configuredTimeScale) &&
        configuredTimeScale > 0
          ? configuredTimeScale
          : 1;

      if (activeAction && activeAction !== interaction) activeAction.fadeOut(fade);
      interaction
        .reset()
        .setLoop(THREE.LoopOnce, 1)
        .setEffectiveWeight(1)
        .setEffectiveTimeScale(timeScale)
        .fadeIn(activeAction && activeAction !== interaction ? fade : 0)
        .play();
      interaction.clampWhenFinished = true;
      activeAction = interaction;
      activeAnimation = "interact";
      interactionPlaying = true;
      return true;
    }

    function handleMixerFinished(event: { action: THREE.AnimationAction }) {
      if (disposed || !interactionPlaying || event.action !== actions.interact) return;
      interactionPlaying = false;
      transitionToMotion(manifest.animations.fadeSeconds ?? 0.18);
    }

    mixer.addEventListener("finished", handleMixerFinished);

    function removeAppliedPosture() {
      for (const [bone, offset] of appliedPostureOffsets) {
        bone.quaternion.multiply(anchorOffsetQuaternion.copy(offset).invert());
      }
      appliedPostureOffsets.clear();
    }

    function applyPosture() {
      if (interactionPlaying) return;
      const posture = motion.carryingStone
        ? manifest.postures?.carry
        : motion.moving
          ? undefined
          : manifest.postures?.idle;
      if (!posture) return;
      for (const role of BONE_ROLES) {
        const transform = posture[role];
        const bone = bones[role];
        if (!transform || !bone || !Array.isArray(transform.rotation)) continue;
        const offset = postureQuaternion(transform);
        bone.quaternion.multiply(offset);
        appliedPostureOffsets.set(bone, offset);
      }
    }

    function syncAnchor(
      anchor: THREE.Group,
      spec: RiggedAvatarAnchorSpec | undefined,
      defaultBone: RiggedAvatarBoneRole,
      fallback: readonly [number, number, number],
    ) {
      const bone = bones[spec?.bone ?? defaultBone];
      if (!bone) {
        anchor.position.copy(tupleToVector(spec?.fallbackPosition, fallback));
        anchor.rotation.set(0, 0, 0);
        return;
      }

      anchorPosition.copy(tupleToVector(spec?.position, [0, 0, 0]));
      bone.localToWorld(anchorPosition);
      root.worldToLocal(anchorPosition);
      anchor.position.copy(anchorPosition);

      bone.getWorldQuaternion(anchorWorldQuaternion);
      root.getWorldQuaternion(rootWorldQuaternion).invert();
      anchor.quaternion.copy(rootWorldQuaternion).multiply(anchorWorldQuaternion);
      if (spec?.rotation) {
        anchorOffsetQuaternion.setFromEuler(
          new THREE.Euler(
            Number.isFinite(spec.rotation[0]) ? spec.rotation[0] : 0,
            Number.isFinite(spec.rotation[1]) ? spec.rotation[1] : 0,
            Number.isFinite(spec.rotation[2]) ? spec.rotation[2] : 0,
            "XYZ",
          ),
        );
        anchor.quaternion.multiply(anchorOffsetQuaternion);
      }
    }

    function syncAnchors() {
      root.updateWorldMatrix(true, true);
      syncAnchor(headAnchor, manifest.anchors?.head, "head", [0, normalizedHeight * 0.82, 0]);
      syncAnchor(
        heldItemAnchor,
        manifest.anchors?.heldItem,
        "rightHand",
        [0.58, normalizedHeight * 0.57, -0.3],
      );
    }

    function update(deltaSeconds: number, nextMotion?: RiggedAvatarMotion) {
      if (disposed) return;
      removeAppliedPosture();
      if (nextMotion) setMotion(nextMotion);
      mixer.update(clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.1));
      applyPosture();
      cloned.updateMatrixWorld(true);
      syncAnchors();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      removeAppliedPosture();
      interactionPlaying = false;
      mixer.removeEventListener("finished", handleMixerFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
      root.removeFromParent();
      root.clear();
      for (const material of instanceMaterials) material.dispose();
      if (leaseAcquired) {
        entry.references = Math.max(0, entry.references - 1);
        maybeDisposeEntry(entry);
      }
    }

    entry.references += 1;
    leaseAcquired = true;
    setMotion(motion, 0);
    update(0);

    return {
      manifest,
      root,
      model: cloned,
      mixer,
      clips,
      actions,
      materials: instanceMaterials,
      bones,
      anchors: { head: headAnchor, heldItem: heldItemAnchor, speech: speechAnchor },
      normalizedHeight,
      get activeAnimation() {
        return activeAnimation;
      },
      get motion() {
        return motion;
      },
      setMotion,
      playInteraction,
      update,
      dispose,
    };
  } catch (error) {
    for (const material of instanceMaterials) material.dispose();
    if (leaseAcquired) {
      entry.references = Math.max(0, entry.references - 1);
      maybeDisposeEntry(entry);
    }
    throw error;
  }
}

/**
 * Loads and instantiates a skeleton-safe avatar clone. Failures are returned,
 * not thrown, so the caller can immediately construct the procedural fallback.
 */
export async function loadRiggedAvatar(
  manifest: RiggedAvatarManifest,
  options: RiggedAvatarLoadOptions = {},
): Promise<RiggedAvatarLoadResult> {
  const validationError = validateManifest(manifest);
  if (validationError) return failure(manifest, "invalid-manifest", new Error(validationError));
  if (options.signal?.aborted) return failure(manifest, "aborted", new Error("Avatar load aborted."));

  const entry = acquireCacheEntry(manifest, options);
  entry.pendingConsumers += 1;
  try {
    const template = await entry.promise;
    if (options.signal?.aborted) {
      return failure(manifest, "aborted", new Error("Avatar load aborted."));
    }
    const clips = resolveRiggedAvatarClips(template.animations, manifest);
    const avatar = instantiateRuntime(entry, template, clips, manifest, options);
    return { ok: true, avatar, cacheKey: entry.key };
  } catch (error) {
    return failure(manifest, reasonFromError(error), error);
  } finally {
    entry.pendingConsumers -= 1;
    maybeDisposeEntry(entry);
  }
}
