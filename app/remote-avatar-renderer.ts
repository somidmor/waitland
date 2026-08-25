import * as THREE from "three";
import {
  createAvatarAppearance,
  hairStyleMetrics,
  type AvatarAppearance,
} from "./avatar-design";

export const MAX_REMOTE_PLAYERS = 64;
const DEPARTURE_DURATION_MS = 2_650;

export interface RemotePlayerProfile {
  name: string;
  city?: string;
  countryCode?: string;
  waitingFor?: string;
}

export interface RemotePlayerSnapshot {
  id: string;
  x: number;
  z: number;
  y?: number;
  yaw: number;
  vx?: number;
  vz?: number;
  moving?: boolean;
  carryingStone?: boolean;
  /** Retained for one protocol generation so old sleepers depart gracefully. */
  sleeping?: boolean;
  updatedAt?: number;
  teleport?: boolean;
  profile?: RemotePlayerProfile;
  speech?: string;
  speechExpiresAt?: number;
  appearance?: Partial<AvatarAppearance>;
}

export interface RemoteViewport {
  width: number;
  height: number;
}

export interface RemoteAvatarAnchor {
  id: string;
  screenX: number;
  screenY: number;
  distance: number;
  departing: boolean;
  profile?: RemotePlayerProfile;
  speech?: string;
  speechExpiresAt?: number;
}

export interface RemoteAvatarRendererOptions {
  maxPlayers?: number;
  interpolationDelayMs?: number;
  extrapolationLimitMs?: number;
  maxRenderDistance?: number;
  detailDistance?: number;
  staleAwakeAfterMs?: number;
}

export type RemoteOverlayCallback = (anchors: readonly RemoteAvatarAnchor[]) => void;

interface TimedSample {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  moving: boolean;
  carryingStone: boolean;
}

interface RenderPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  moving: boolean;
  carryingStone: boolean;
}

interface RemotePlayerState {
  id: string;
  samples: TimedSample[];
  lastReceivedAt: number;
  lastRenderedX: number;
  lastRenderedZ: number;
  hasRendered: boolean;
  walkPhase: number;
  departureAt?: number;
  profile?: RemotePlayerProfile;
  speech?: string;
  speechExpiresAt?: number;
  appearance: AvatarAppearance;
  sweaterColor: THREE.Color;
  skinColor: THREE.Color;
  hairColor: THREE.Color;
  trouserColor: THREE.Color;
  shoeColor: THREE.Color;
  pose: RenderPose;
  anchor: RemoteAvatarAnchor;
}

const UP = new THREE.Vector3(0, 1, 0);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerpAngle(from: number, to: number, amount: number) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function makeInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function makeWingGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.02);
  shape.bezierCurveTo(0.34, 0.56, 0.94, 0.84, 1.36, 0.68);
  shape.bezierCurveTo(1.22, 0.48, 1.08, 0.39, 0.94, 0.37);
  shape.bezierCurveTo(1.04, 0.22, 0.91, 0.12, 0.73, 0.17);
  shape.bezierCurveTo(0.72, 0.01, 0.54, -0.06, 0.39, 0.06);
  shape.bezierCurveTo(0.28, -0.06, 0.12, -0.04, 0, 0.02);
  const geometry = new THREE.ShapeGeometry(shape, 8);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A bounded, instanced storybook-character renderer. Richer silhouettes add a
 * fixed number of draw calls, not one object hierarchy per connected person.
 */
export class RemoteAvatarRenderer {
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly players = new Map<string, RemotePlayerState>();
  private readonly visibleAnchors: RemoteAvatarAnchor[] = [];

  private readonly bodyGeometry = new THREE.CapsuleGeometry(0.48, 0.72, 6, 11);
  private readonly headGeometry = new THREE.SphereGeometry(0.45, 14, 11);
  private readonly limbGeometry = new THREE.CapsuleGeometry(0.13, 0.55, 4, 8);
  private readonly shoeGeometry = new THREE.SphereGeometry(0.18, 9, 7);
  private readonly hairGeometry = new THREE.SphereGeometry(
    0.47,
    14,
    9,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.64,
  );
  private readonly bunGeometry = new THREE.SphereGeometry(0.28, 10, 8);
  private readonly eyeGeometry = new THREE.SphereGeometry(0.038, 7, 5);
  private readonly glassesGeometry = new THREE.TorusGeometry(0.105, 0.018, 5, 12);
  private readonly shadowGeometry = new THREE.CircleGeometry(0.68, 18);
  private readonly stoneGeometry = new THREE.DodecahedronGeometry(0.34, 0);
  private readonly wingGeometry = makeWingGeometry();
  private readonly moteGeometry = new THREE.SphereGeometry(0.052, 6, 4);

  private readonly sweaterMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, vertexColors: true });
  private readonly skinMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, vertexColors: true });
  private readonly hairMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, vertexColors: true });
  private readonly trouserMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, vertexColors: true });
  private readonly shoeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, vertexColors: true });
  private readonly faceMaterial = new THREE.MeshBasicMaterial({ color: 0x2b211b });
  private readonly glassesMaterial = new THREE.MeshBasicMaterial({ color: 0x342d27 });
  private readonly shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x302714, transparent: true, opacity: 0.17, depthWrite: false });
  private readonly stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x8f887a, roughness: 0.98 });
  private readonly wingMaterial = new THREE.MeshStandardMaterial({ color: 0xfff9e9, emissive: 0x6b552b, emissiveIntensity: 0.08, roughness: 0.88, side: THREE.DoubleSide });
  private readonly moteMaterial = new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.78, depthWrite: false });

  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly hairCaps: THREE.InstancedMesh;
  private readonly hairBuns: THREE.InstancedMesh;
  private readonly leftLegs: THREE.InstancedMesh;
  private readonly rightLegs: THREE.InstancedMesh;
  private readonly leftArms: THREE.InstancedMesh;
  private readonly rightArms: THREE.InstancedMesh;
  private readonly leftShoes: THREE.InstancedMesh;
  private readonly rightShoes: THREE.InstancedMesh;
  private readonly leftEyes: THREE.InstancedMesh;
  private readonly rightEyes: THREE.InstancedMesh;
  private readonly leftGlasses: THREE.InstancedMesh;
  private readonly rightGlasses: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;
  private readonly stones: THREE.InstancedMesh;
  private readonly leftWings: THREE.InstancedMesh;
  private readonly rightWings: THREE.InstancedMesh;
  private readonly motes: THREE.InstancedMesh;
  private readonly allMeshes: THREE.InstancedMesh[];

  private readonly capacity: number;
  private readonly interpolationDelayMs: number;
  private readonly extrapolationLimitMs: number;
  private readonly maxRenderDistanceSquared: number;
  private readonly detailDistanceSquared: number;
  private readonly staleAwakeAfterMs: number;

  private clockOffsetMs: number | undefined;
  private disposed = false;

  private readonly rootMatrix = new THREE.Matrix4();
  private readonly localMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly rootQuaternion = new THREE.Quaternion();
  private readonly tempEuler = new THREE.Euler();
  private readonly projected = new THREE.Vector3();

  constructor(scene: THREE.Scene, options: RemoteAvatarRendererOptions = {}) {
    this.scene = scene;
    this.capacity = clamp(Math.floor(options.maxPlayers ?? MAX_REMOTE_PLAYERS), 1, MAX_REMOTE_PLAYERS);
    this.interpolationDelayMs = Math.max(0, options.interpolationDelayMs ?? 100);
    this.extrapolationLimitMs = Math.max(0, options.extrapolationLimitMs ?? 160);
    const maxDistance = Math.max(8, options.maxRenderDistance ?? 62);
    const detailDistance = Math.min(maxDistance, Math.max(5, options.detailDistance ?? 34));
    this.maxRenderDistanceSquared = maxDistance * maxDistance;
    this.detailDistanceSquared = detailDistance * detailDistance;
    this.staleAwakeAfterMs = Math.max(5_000, options.staleAwakeAfterMs ?? 30_000);

    this.bodies = makeInstancedMesh(this.bodyGeometry, this.sweaterMaterial, this.capacity);
    this.heads = makeInstancedMesh(this.headGeometry, this.skinMaterial, this.capacity);
    this.hairCaps = makeInstancedMesh(this.hairGeometry, this.hairMaterial, this.capacity);
    this.hairBuns = makeInstancedMesh(this.bunGeometry, this.hairMaterial, this.capacity);
    this.leftLegs = makeInstancedMesh(this.limbGeometry, this.trouserMaterial, this.capacity);
    this.rightLegs = makeInstancedMesh(this.limbGeometry, this.trouserMaterial, this.capacity);
    this.leftArms = makeInstancedMesh(this.limbGeometry, this.sweaterMaterial, this.capacity);
    this.rightArms = makeInstancedMesh(this.limbGeometry, this.sweaterMaterial, this.capacity);
    this.leftShoes = makeInstancedMesh(this.shoeGeometry, this.shoeMaterial, this.capacity);
    this.rightShoes = makeInstancedMesh(this.shoeGeometry, this.shoeMaterial, this.capacity);
    this.leftEyes = makeInstancedMesh(this.eyeGeometry, this.faceMaterial, this.capacity);
    this.rightEyes = makeInstancedMesh(this.eyeGeometry, this.faceMaterial, this.capacity);
    this.leftGlasses = makeInstancedMesh(this.glassesGeometry, this.glassesMaterial, this.capacity);
    this.rightGlasses = makeInstancedMesh(this.glassesGeometry, this.glassesMaterial, this.capacity);
    this.shadows = makeInstancedMesh(this.shadowGeometry, this.shadowMaterial, this.capacity);
    this.stones = makeInstancedMesh(this.stoneGeometry, this.stoneMaterial, this.capacity);
    this.leftWings = makeInstancedMesh(this.wingGeometry, this.wingMaterial, this.capacity);
    this.rightWings = makeInstancedMesh(this.wingGeometry, this.wingMaterial, this.capacity);
    this.motes = makeInstancedMesh(this.moteGeometry, this.moteMaterial, this.capacity * 4);
    this.shadows.renderOrder = -1;
    this.motes.renderOrder = 2;

    this.allMeshes = [
      this.shadows,
      this.bodies,
      this.heads,
      this.hairCaps,
      this.hairBuns,
      this.leftLegs,
      this.rightLegs,
      this.leftArms,
      this.rightArms,
      this.leftShoes,
      this.rightShoes,
      this.leftEyes,
      this.rightEyes,
      this.leftGlasses,
      this.rightGlasses,
      this.stones,
      this.leftWings,
      this.rightWings,
      this.motes,
    ];
    this.root.add(...this.allMeshes);
    this.scene.add(this.root);
  }

  get size() {
    return this.players.size;
  }

  upsert(snapshot: RemotePlayerSnapshot, serverTimeMs?: number) {
    if (this.disposed || !snapshot.id || !Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.z)) return false;
    if (snapshot.sleeping) {
      this.depart(snapshot.id);
      return false;
    }

    const now = performance.now();
    let state = this.players.get(snapshot.id);
    if (!state) {
      if (this.players.size >= this.capacity) {
        let oldest: RemotePlayerState | undefined;
        for (const candidate of this.players.values()) {
          if (!oldest || candidate.lastReceivedAt < oldest.lastReceivedAt) oldest = candidate;
        }
        if (!oldest || (!oldest.departureAt && now - oldest.lastReceivedAt < this.staleAwakeAfterMs)) return false;
        this.players.delete(oldest.id);
      }

      const appearance = createAvatarAppearance(snapshot.id, snapshot.appearance);
      state = {
        id: snapshot.id,
        samples: [],
        lastReceivedAt: now,
        lastRenderedX: snapshot.x,
        lastRenderedZ: snapshot.z,
        hasRendered: false,
        walkPhase: (appearance.sweater % 628) / 100,
        profile: snapshot.profile,
        speech: snapshot.speech,
        speechExpiresAt: snapshot.speechExpiresAt,
        appearance,
        sweaterColor: new THREE.Color(appearance.sweater),
        skinColor: new THREE.Color(appearance.skin),
        hairColor: new THREE.Color(appearance.hair),
        trouserColor: new THREE.Color(appearance.trousers),
        shoeColor: new THREE.Color(appearance.shoes),
        pose: {
          x: snapshot.x,
          y: snapshot.y ?? 0,
          z: snapshot.z,
          yaw: snapshot.yaw,
          vx: snapshot.vx ?? 0,
          vz: snapshot.vz ?? 0,
          moving: Boolean(snapshot.moving),
          carryingStone: Boolean(snapshot.carryingStone),
        },
        anchor: {
          id: snapshot.id,
          screenX: 0,
          screenY: 0,
          distance: 0,
          departing: false,
          profile: snapshot.profile,
          speech: snapshot.speech,
          speechExpiresAt: snapshot.speechExpiresAt,
        },
      };
      this.players.set(snapshot.id, state);
    }

    state.departureAt = undefined;
    state.lastReceivedAt = now;
    state.profile = snapshot.profile ?? state.profile;
    if (snapshot.appearance) {
      const appearance = createAvatarAppearance(snapshot.id, snapshot.appearance);
      state.appearance = appearance;
      state.sweaterColor.setHex(appearance.sweater);
      state.skinColor.setHex(appearance.skin);
      state.hairColor.setHex(appearance.hair);
      state.trouserColor.setHex(appearance.trousers);
      state.shoeColor.setHex(appearance.shoes);
    }
    if (snapshot.speech !== undefined) state.speech = snapshot.speech;
    if (snapshot.speechExpiresAt !== undefined) state.speechExpiresAt = snapshot.speechExpiresAt;

    const sampleTime = this.toLocalTime(snapshot.updatedAt, serverTimeMs, now);
    const sample: TimedSample = {
      time: sampleTime,
      x: snapshot.x,
      y: snapshot.y ?? 0,
      z: snapshot.z,
      yaw: Number.isFinite(snapshot.yaw) ? snapshot.yaw : 0,
      vx: Number.isFinite(snapshot.vx) ? snapshot.vx! : 0,
      vz: Number.isFinite(snapshot.vz) ? snapshot.vz! : 0,
      moving: Boolean(snapshot.moving),
      carryingStone: Boolean(snapshot.carryingStone),
    };
    if (snapshot.teleport) state.samples.length = 0;
    const sameTimeIndex = state.samples.findIndex((existing) => Math.abs(existing.time - sample.time) < 0.01);
    if (sameTimeIndex >= 0) state.samples[sameTimeIndex] = sample;
    else state.samples.push(sample);
    state.samples.sort((left, right) => left.time - right.time);
    if (state.samples.length > 5) state.samples.splice(0, state.samples.length - 5);
    return true;
  }

  replaceSnapshot(snapshots: readonly RemotePlayerSnapshot[], serverTimeMs?: number) {
    if (this.disposed) return;
    const retained = new Set<string>();
    for (const snapshot of snapshots) {
      if (!snapshot?.id || snapshot.sleeping || retained.size >= this.capacity) continue;
      retained.add(snapshot.id);
    }
    for (const [id, state] of this.players) {
      if (!retained.has(id) && state.departureAt === undefined) this.players.delete(id);
    }
    for (const snapshot of snapshots) {
      if (snapshot?.id && retained.has(snapshot.id)) this.upsert(snapshot, serverTimeMs);
    }
  }

  /** Starts the visible goodbye instead of snapping the avatar out of the field. */
  depart(id: string, nowMs = performance.now()) {
    const state = this.players.get(id);
    if (!state) return false;
    if (state.departureAt === undefined) state.departureAt = nowMs;
    state.speech = undefined;
    state.speechExpiresAt = undefined;
    return true;
  }

  remove(id: string) {
    return this.players.delete(id);
  }

  setSpeech(id: string, speech: string, expiresAt?: number) {
    const state = this.players.get(id);
    if (!state || state.departureAt !== undefined) return false;
    state.speech = speech;
    state.speechExpiresAt = expiresAt;
    return true;
  }

  getVisibleAnchors(): readonly RemoteAvatarAnchor[] {
    return this.visibleAnchors;
  }

  update(
    nowMs: number,
    deltaSeconds: number,
    camera: THREE.Camera,
    localPosition: Pick<THREE.Vector3, "x" | "z">,
    viewport: RemoteViewport,
    onOverlay?: RemoteOverlayCallback,
  ) {
    if (this.disposed) return;
    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    const dt = clamp(deltaSeconds, 0, 0.1);
    const renderAt = now - this.interpolationDelayMs;
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);

    let avatarCount = 0;
    let detailCount = 0;
    let stoneCount = 0;
    let wingCount = 0;
    let moteCount = 0;
    let anchorCount = 0;
    const completedDepartures: string[] = [];

    for (const [id, state] of this.players) {
      const latest = state.samples[state.samples.length - 1];
      if (!latest) continue;
      const departing = state.departureAt !== undefined;
      if (!departing && now - state.lastReceivedAt > this.staleAwakeAfterMs) {
        this.players.delete(id);
        continue;
      }

      const departureT = departing ? clamp((now - state.departureAt!) / DEPARTURE_DURATION_MS, 0, 1) : 0;
      if (departureT >= 1) {
        completedDepartures.push(id);
        continue;
      }
      const lift = departing ? easeOutCubic(departureT) * 8.2 : 0;
      const exitScale = departing ? 1 - Math.max(0, (departureT - 0.72) / 0.28) * 0.72 : 1;

      const pose = this.samplePose(state.samples, renderAt, state.pose);
      const dx = pose.x - localPosition.x;
      const dz = pose.z - localPosition.z;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared > this.maxRenderDistanceSquared) continue;

      this.projected.set(pose.x, pose.y + lift + 3.22, pose.z).project(camera);
      const inPaddedView = this.projected.z > -1 && this.projected.z < 1 && Math.abs(this.projected.x) < 1.28 && Math.abs(this.projected.y) < 1.38;
      if (!inPaddedView) continue;

      const renderedDistance = state.hasRendered ? Math.hypot(pose.x - state.lastRenderedX, pose.z - state.lastRenderedZ) : 0;
      const renderedSpeed = dt > 0 ? renderedDistance / dt : 0;
      state.lastRenderedX = pose.x;
      state.lastRenderedZ = pose.z;
      state.hasRendered = true;
      const speed = Math.max(Math.hypot(pose.vx, pose.vz), renderedSpeed);
      const walking = !departing && (pose.moving || speed > 0.12);
      if (walking) state.walkPhase += dt * clamp(speed * 2.05, 5.5, 12.5);

      this.rootQuaternion.setFromAxisAngle(UP, pose.yaw + departureT * 0.34);
      this.tempPosition.set(pose.x, pose.y + lift, pose.z);
      this.tempScale.setScalar(exitScale);
      this.rootMatrix.compose(this.tempPosition, this.rootQuaternion, this.tempScale);

      const swing = walking ? Math.sin(state.walkPhase) : 0;
      const bob = walking ? Math.abs(Math.sin(state.walkPhase)) * 0.048 : 0;
      this.setPart(this.bodies, avatarCount, this.rootMatrix, 0, 1.42 + bob, 0, 0, 0, 0, 1, 1, 1);
      this.bodies.setColorAt(avatarCount, state.sweaterColor);
      this.setPart(this.heads, avatarCount, this.rootMatrix, 0, 2.42 + bob, -0.02, 0, 0, 0, 1, 1.04, 0.98);
      this.heads.setColorAt(avatarCount, state.skinColor);

      const hair = hairStyleMetrics(state.appearance.hairStyle);
      this.setPart(this.hairCaps, avatarCount, this.rootMatrix, 0, 2.51 + hair.capOffsetY + bob, 0.03, 0, 0, 0, 1.04, hair.capY, hair.capZ);
      this.hairCaps.setColorAt(avatarCount, state.hairColor);
      const bunScale = Math.max(0.001, hair.bunScale);
      this.setPart(this.hairBuns, avatarCount, this.rootMatrix, 0, hair.bunY + bob, hair.bunZ, 0, 0, 0, bunScale, bunScale, bunScale);
      this.hairBuns.setColorAt(avatarCount, state.hairColor);

      const shadowScale = departing ? 0.001 : 1;
      this.setPart(
        this.shadows,
        avatarCount,
        this.rootMatrix,
        0,
        0.018,
        0,
        -Math.PI / 2,
        0,
        0,
        shadowScale,
        shadowScale,
        shadowScale,
      );
      avatarCount += 1;

      const detailed = distanceSquared <= this.detailDistanceSquared;
      if (detailed) {
        this.setPart(this.leftLegs, detailCount, this.rootMatrix, -0.22, 0.55, 0, swing * 0.5, 0, 0, 1.08, 1.08, 1.08);
        this.setPart(this.rightLegs, detailCount, this.rootMatrix, 0.22, 0.55, 0, -swing * 0.5, 0, 0, 1.08, 1.08, 1.08);
        this.leftLegs.setColorAt(detailCount, state.trouserColor);
        this.rightLegs.setColorAt(detailCount, state.trouserColor);

        const heldArm = pose.carryingStone ? -0.76 : swing * 0.34;
        this.setPart(this.leftArms, detailCount, this.rootMatrix, -0.57, 1.49 + bob, 0, -swing * 0.34, 0, 0.04, 0.94, 1, 0.94);
        this.setPart(this.rightArms, detailCount, this.rootMatrix, 0.57, 1.49 + bob, 0, heldArm, 0, -0.04, 0.94, 1, 0.94);
        this.leftArms.setColorAt(detailCount, state.sweaterColor);
        this.rightArms.setColorAt(detailCount, state.sweaterColor);

        this.setPart(this.leftShoes, detailCount, this.rootMatrix, -0.22, 0.16, -0.08, swing * 0.2, 0, 0, 1.05, 0.72, 1.28);
        this.setPart(this.rightShoes, detailCount, this.rootMatrix, 0.22, 0.16, -0.08, -swing * 0.2, 0, 0, 1.05, 0.72, 1.28);
        this.leftShoes.setColorAt(detailCount, state.shoeColor);
        this.rightShoes.setColorAt(detailCount, state.shoeColor);

        this.setPart(this.leftEyes, detailCount, this.rootMatrix, -0.16, 2.48 + bob, -0.424, 0, 0, 0, 1, 0.72, 0.58);
        this.setPart(this.rightEyes, detailCount, this.rootMatrix, 0.16, 2.48 + bob, -0.424, 0, 0, 0, 1, 0.72, 0.58);
        const glassesScale = state.appearance.glasses ? 1 : 0.001;
        this.setPart(this.leftGlasses, detailCount, this.rootMatrix, -0.16, 2.48 + bob, -0.45, 0, 0, 0, glassesScale, glassesScale, glassesScale);
        this.setPart(this.rightGlasses, detailCount, this.rootMatrix, 0.16, 2.48 + bob, -0.45, 0, 0, 0, glassesScale, glassesScale, glassesScale);
        detailCount += 1;
      }

      if (detailed && pose.carryingStone && !departing) {
        const spin = now * 0.0006;
        this.setPart(this.stones, stoneCount, this.rootMatrix, 0.58, 1.7 + bob, -0.3, 0.25, spin, 0.1, 1, 0.8, 1.08);
        stoneCount += 1;
      }

      if (departing) {
        const flap = Math.sin(departureT * Math.PI * 12) * 0.34;
        const opening = Math.sin(Math.min(1, departureT * 5) * Math.PI * 0.5);
        const wingScale = 0.72 + opening * 0.54;
        this.setPart(this.leftWings, wingCount, this.rootMatrix, -0.2, 1.77, 0.34, 0, -0.22 - flap, -0.18, -wingScale, wingScale, wingScale);
        this.setPart(this.rightWings, wingCount, this.rootMatrix, 0.2, 1.77, 0.34, 0, 0.22 + flap, 0.18, wingScale, wingScale, wingScale);
        wingCount += 1;

        for (let mote = 0; mote < 4; mote += 1) {
          const phase = departureT * 7 + mote * 1.73;
          const drift = 0.45 + mote * 0.16;
          this.setPart(
            this.motes,
            moteCount,
            this.rootMatrix,
            Math.sin(phase) * drift,
            0.45 + ((departureT * 2.6 + mote * 0.23) % 1) * 2.2,
            0.34 + Math.cos(phase * 0.8) * 0.3,
            0,
            0,
            0,
            0.7 + mote * 0.08,
            0.7 + mote * 0.08,
            0.7 + mote * 0.08,
          );
          moteCount += 1;
        }
      }

      const onScreen = this.projected.z > -1 && this.projected.z < 1 && Math.abs(this.projected.x) <= 1.04 && Math.abs(this.projected.y) <= 1.12;
      if (onScreen) {
        const anchor = state.anchor;
        anchor.screenX = (this.projected.x * 0.5 + 0.5) * width;
        anchor.screenY = (-this.projected.y * 0.5 + 0.5) * height;
        anchor.distance = Math.sqrt(distanceSquared);
        anchor.departing = departing;
        anchor.profile = state.profile;
        anchor.speech = state.speech;
        anchor.speechExpiresAt = state.speechExpiresAt;
        this.visibleAnchors[anchorCount] = anchor;
        anchorCount += 1;
      }
    }

    for (const id of completedDepartures) this.players.delete(id);
    this.visibleAnchors.length = anchorCount;
    this.finishMesh(this.bodies, avatarCount, true);
    this.finishMesh(this.heads, avatarCount, true);
    this.finishMesh(this.hairCaps, avatarCount, true);
    this.finishMesh(this.hairBuns, avatarCount, true);
    this.finishMesh(this.shadows, avatarCount, false);
    this.finishMesh(this.leftLegs, detailCount, true);
    this.finishMesh(this.rightLegs, detailCount, true);
    this.finishMesh(this.leftArms, detailCount, true);
    this.finishMesh(this.rightArms, detailCount, true);
    this.finishMesh(this.leftShoes, detailCount, true);
    this.finishMesh(this.rightShoes, detailCount, true);
    this.finishMesh(this.leftEyes, detailCount, false);
    this.finishMesh(this.rightEyes, detailCount, false);
    this.finishMesh(this.leftGlasses, detailCount, false);
    this.finishMesh(this.rightGlasses, detailCount, false);
    this.finishMesh(this.stones, stoneCount, false);
    this.finishMesh(this.leftWings, wingCount, false);
    this.finishMesh(this.rightWings, wingCount, false);
    this.finishMesh(this.motes, moteCount, false);
    onOverlay?.(this.visibleAnchors);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.players.clear();
    this.visibleAnchors.length = 0;
    for (const geometry of [
      this.bodyGeometry,
      this.headGeometry,
      this.limbGeometry,
      this.shoeGeometry,
      this.hairGeometry,
      this.bunGeometry,
      this.eyeGeometry,
      this.glassesGeometry,
      this.shadowGeometry,
      this.stoneGeometry,
      this.wingGeometry,
      this.moteGeometry,
    ]) geometry.dispose();
    for (const material of [
      this.sweaterMaterial,
      this.skinMaterial,
      this.hairMaterial,
      this.trouserMaterial,
      this.shoeMaterial,
      this.faceMaterial,
      this.glassesMaterial,
      this.shadowMaterial,
      this.stoneMaterial,
      this.wingMaterial,
      this.moteMaterial,
    ]) material.dispose();
  }

  private toLocalTime(snapshotTime: number | undefined, serverTime: number | undefined, now: number) {
    if (Number.isFinite(serverTime)) {
      const observedOffset = now - serverTime!;
      if (this.clockOffsetMs === undefined || Math.abs(observedOffset - this.clockOffsetMs) > 1_000) {
        this.clockOffsetMs = observedOffset;
      } else {
        const amount = observedOffset < this.clockOffsetMs ? 0.2 : 0.025;
        this.clockOffsetMs += (observedOffset - this.clockOffsetMs) * amount;
      }
      return (Number.isFinite(snapshotTime) ? snapshotTime! : serverTime!) + this.clockOffsetMs;
    }
    if (Number.isFinite(snapshotTime)) {
      if (snapshotTime! > 10_000_000_000) return now + (snapshotTime! - Date.now());
      return snapshotTime!;
    }
    return now;
  }

  private samplePose(samples: readonly TimedSample[], renderAt: number, out: RenderPose): RenderPose {
    const first = samples[0];
    const latest = samples[samples.length - 1];
    if (samples.length === 1 || renderAt <= first.time) return this.copySampleToPose(first, out);
    for (let index = 1; index < samples.length; index += 1) {
      const right = samples[index];
      if (right.time < renderAt) continue;
      const left = samples[index - 1];
      const amount = clamp((renderAt - left.time) / Math.max(1, right.time - left.time), 0, 1);
      out.x = THREE.MathUtils.lerp(left.x, right.x, amount);
      out.y = THREE.MathUtils.lerp(left.y, right.y, amount);
      out.z = THREE.MathUtils.lerp(left.z, right.z, amount);
      out.yaw = lerpAngle(left.yaw, right.yaw, amount);
      out.vx = THREE.MathUtils.lerp(left.vx, right.vx, amount);
      out.vz = THREE.MathUtils.lerp(left.vz, right.vz, amount);
      out.moving = amount < 0.5 ? left.moving : right.moving;
      out.carryingStone = amount < 0.5 ? left.carryingStone : right.carryingStone;
      return out;
    }
    const extrapolationSeconds = clamp(renderAt - latest.time, 0, this.extrapolationLimitMs) / 1_000;
    this.copySampleToPose(latest, out);
    out.x += latest.vx * extrapolationSeconds;
    out.z += latest.vz * extrapolationSeconds;
    return out;
  }

  private copySampleToPose(sample: TimedSample, out: RenderPose) {
    out.x = sample.x;
    out.y = sample.y;
    out.z = sample.z;
    out.yaw = sample.yaw;
    out.vx = sample.vx;
    out.vz = sample.vz;
    out.moving = sample.moving;
    out.carryingStone = sample.carryingStone;
    return out;
  }

  private setPart(
    mesh: THREE.InstancedMesh,
    index: number,
    root: THREE.Matrix4,
    x: number,
    y: number,
    z: number,
    rotationX: number,
    rotationY: number,
    rotationZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ) {
    this.tempPosition.set(x, y, z);
    this.tempQuaternion.setFromEuler(this.tempEuler.set(rotationX, rotationY, rotationZ, "XYZ"));
    this.tempScale.set(scaleX, scaleY, scaleZ);
    this.localMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
    this.worldMatrix.multiplyMatrices(root, this.localMatrix);
    mesh.setMatrixAt(index, this.worldMatrix);
  }

  private finishMesh(mesh: THREE.InstancedMesh, count: number, hasColors: boolean) {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;
    mesh.instanceMatrix.needsUpdate = true;
    if (hasColors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
