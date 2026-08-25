"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import * as THREE from "three";
import {
  CARRY_SPEED,
  FIELD_RADIUS,
  FIELD_STONE_COUNT,
  getStoneDescriptor,
  PIT_CAPACITY,
  PIT_THROW_RADIUS,
  PIT_WALL_RADIUS,
  WALK_SPEED,
} from "../shared/world";
import { countryCodeToFlag, type WaitingPitProps } from "./profile";
import {
  RealtimeClient,
  type ActionResultMessage,
  type ChatMessage,
  type RealtimeConnectionState,
  type RealtimePlayer,
  type RealtimePlayerDelta,
  type RealtimeStatus,
  type RealtimeStone,
} from "./realtime-client";
import {
  RemoteAvatarRenderer,
  type RemoteAvatarAnchor,
  type RemotePlayerSnapshot,
} from "./remote-avatar-renderer";
import { createProceduralAvatar, type RiggedAvatarRuntime } from "./avatar";
import { createAvatarAppearance } from "./avatar-design";
import { WAITLANDER_RUNTIME_MANIFEST } from "./avatar/waitlander-manifest";
import { CompassIcon, EditIcon, PeopleIcon, SendIcon, StoneIcon } from "./ui-icons";
import {
  attachEnvironmentMaterialTextures,
  createStorybookWorld,
  ENVIRONMENT_TEXTURE_PATHS,
} from "./world-art";

const CAPACITY = PIT_CAPACITY;
const PIT_RADIUS = 4.6;
const STORAGE_KEY = "waiting-pit-stones-v1";
const REMOTE_SPEECH_TTL_MS = 7_000;

type ActionMode = "none" | "pickup" | "throw";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readStoredStoneCount() {
  try {
    return clamp(
      Number.parseInt(window.localStorage.getItem(STORAGE_KEY) ?? "0", 10) || 0,
      0,
      CAPACITY,
    );
  } catch {
    return 0;
  }
}

function toRemoteSnapshot(
  player: RealtimePlayer,
  speech?: Pick<ChatMessage, "text" | "expiresAt">,
): RemotePlayerSnapshot {
  return {
    id: player.id,
    x: player.x,
    z: player.z,
    yaw: player.heading,
    vx: player.vx,
    vz: player.vz,
    moving: Math.hypot(player.vx ?? 0, player.vz ?? 0) > 0.12,
    carryingStone: Boolean(player.carrying),
    profile: {
      name: player.profile.name,
      city: player.profile.city,
      countryCode: player.profile.countryCode,
      waitingFor: player.profile.waitReason,
    },
    speech: speech?.text,
    speechExpiresAt: speech?.expiresAt,
  };
}

function networkLabel(status: RealtimeStatus, onlineCount: number) {
  const { state, reason } = status;
  if (state === "online") return `${onlineCount.toLocaleString()} here`;
  if (state === "connecting") return status.attempt ? "Rejoining…" : "Joining…";
  if (state === "offline") {
    if (reason?.includes("offline")) return "You’re offline";
    if (reason?.includes("busy")) return "Busy · retrying";
    if (reason?.includes("slow")) return "Slow · retrying";
    if (reason?.includes("waking")) return "Waking up…";
    return "Reconnecting…";
  }
  if (state === "replaced") return "Open elsewhere";
  if (state === "incompatible") return "Refresh needed";
  return "Solo";
}

export default function WaitingPit({ profile, onEditProfile }: WaitingPitProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const joystickRef = useRef<HTMLDivElement>(null);
  const joystickThumbRef = useRef<HTMLDivElement>(null);
  const joystickInput = useRef({ x: 0, y: 0 });
  const joystickPointer = useRef<number | null>(null);
  const performActionRef = useRef<() => void>(() => undefined);
  const playerOverlayRef = useRef<HTMLDivElement>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const profileRef = useRef(profile);

  const [count, setCount] = useState(0);
  const [actionMode, setActionMode] = useState<ActionMode>("none");
  const [distanceToPit, setDistanceToPit] = useState(13);
  const [message, setMessage] = useState("Walk to a stone");
  const [hasMoved, setHasMoved] = useState(false);
  const [chatText, setChatText] = useState("");
  const [speech, setSpeech] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<RealtimeStatus>({
    state: "connecting",
    attempt: 0,
    reason: "Joining the field…",
  });
  const connectionState: RealtimeConnectionState = connectionStatus.state;
  const [onlineCount, setOnlineCount] = useState(1);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  useEffect(() => {
    profileRef.current = profile;
    realtimeRef.current?.setProfile(profile);
  }, [profile]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const gameMount: HTMLDivElement = mount;

    let disposed = false;
    let animationFrame = 0;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    const respawnTimers = new Set<ReturnType<typeof setTimeout>>();
    let lastDistanceLabel = -1;
    let lastActionMode: ActionMode = "none";
    let movedOnce = false;
    let viewportWidth = 1;
    let viewportHeight = 1;

    const storedCount = readStoredStoneCount();
    let currentStoneCount = storedCount;
    setCount(storedCount);

    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.Fog(0xe8bb78, 42, 118);

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 160);
    camera.position.set(0, 12, 36);

    let renderer: THREE.WebGLRenderer | null = null;
    let worldFallback: HTMLDivElement | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setClearColor(0xf0c98b, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.domElement.className = "world-canvas";
      renderer.domElement.setAttribute(
        "aria-label",
        "A peaceful 3D meadow with a circular pit and scattered stones",
      );
      mount.appendChild(renderer.domElement);
    } catch {
      // Some automated and accessibility browsers intentionally disable WebGL.
      // Keep the multiplayer HUD usable and testable instead of crashing the
      // whole route; ordinary phones and desktops continue through WebGL.
      worldFallback = document.createElement("div");
      worldFallback.className = "world-fallback";
      worldFallback.setAttribute("role", "img");
      worldFallback.setAttribute("aria-label", "A warm meadow stretching toward the central stone pit");
      mount.appendChild(worldFallback);
    }

    scene.add(new THREE.HemisphereLight(0xffe8bd, 0x535637, 2.35));
    const sun = new THREE.DirectionalLight(0xffd89a, 3.65);
    sun.position.set(-24, 31, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    scene.add(sun);

    const storybookWorld = createStorybookWorld(scene);

    const pitGroup = new THREE.Group();
    scene.add(pitGroup);

    const pitFloorMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b5136,
      roughness: 1,
      metalness: 0,
    });
    const pitFloor = new THREE.Mesh(
      new THREE.CircleGeometry(PIT_RADIUS + 0.04, 64),
      pitFloorMaterial,
    );
    pitFloor.rotation.x = -Math.PI / 2;
    pitFloor.position.y = -0.34;
    pitFloor.receiveShadow = true;
    pitGroup.add(pitFloor);

    const pitRimMaterial = new THREE.MeshStandardMaterial({
      color: 0x977149,
      roughness: 1,
      metalness: 0,
    });
    const pitWallGeometry = new THREE.CylinderGeometry(
      5.02,
      PIT_RADIUS + 0.04,
      0.72,
      64,
      1,
      true,
    );
    const pitWallMaterial = new THREE.MeshStandardMaterial({
      color: 0x745238,
      roughness: 1,
      metalness: 0,
      // Cylinder normals face away from the excavation. Render the inward
      // surface so the wall remains visible from the gameplay camera.
      side: THREE.BackSide,
    });
    const pitWall = new THREE.Mesh(pitWallGeometry, pitWallMaterial);
    pitWall.position.y = 0.02;
    pitWall.receiveShadow = true;
    pitGroup.add(pitWall);

    const pitRim = new THREE.Mesh(new THREE.TorusGeometry(5.14, 0.74, 10, 64), pitRimMaterial);
    pitRim.rotation.x = Math.PI / 2;
    pitRim.position.y = 0.28;
    pitRim.castShadow = true;
    pitRim.receiveShadow = true;
    pitGroup.add(pitRim);

    const innerRimMaterial = new THREE.MeshBasicMaterial({
      color: 0xd0a96f,
      transparent: true,
      opacity: 0.46,
    });
    const innerRim = new THREE.Mesh(new THREE.TorusGeometry(4.48, 0.1, 7, 64), innerRimMaterial);
    innerRim.rotation.x = Math.PI / 2;
    innerRim.position.y = 0.47;
    pitGroup.add(innerRim);

    const rimClumpGeometry = new THREE.DodecahedronGeometry(0.72, 0);
    const rimClumpMaterial = new THREE.MeshStandardMaterial({
      color: 0xa17b4f,
      roughness: 1,
      metalness: 0,
    });
    const rimClumps = new THREE.InstancedMesh(rimClumpGeometry, rimClumpMaterial, 30);
    const rimClumpTransform = new THREE.Object3D();
    for (let index = 0; index < rimClumps.count; index += 1) {
      const angle = (index / rimClumps.count) * Math.PI * 2;
      const wave = Math.sin(index * 4.71) * 0.18;
      rimClumpTransform.position.set(
        Math.cos(angle) * (5.23 + wave),
        0.28 + Math.sin(index * 1.83) * 0.08,
        Math.sin(angle) * (5.23 + wave),
      );
      rimClumpTransform.rotation.set(index * 0.31, -angle, index * 0.17);
      rimClumpTransform.scale.set(0.82 + (index % 3) * 0.12, 0.52 + (index % 4) * 0.07, 1.12);
      rimClumpTransform.updateMatrix();
      rimClumps.setMatrixAt(index, rimClumpTransform.matrix);
    }
    rimClumps.instanceMatrix.needsUpdate = true;
    rimClumps.receiveShadow = true;
    rimClumps.castShadow = false;
    pitGroup.add(rimClumps);

    const pitTextureBinding = attachEnvironmentMaterialTextures(
      [
        { material: pitFloorMaterial, texturedColor: 0x8a755c },
        { material: pitWallMaterial, texturedColor: 0x92704f },
        { material: pitRimMaterial, texturedColor: 0xc7a475 },
        { material: rimClumpMaterial, texturedColor: 0xb99668 },
      ],
      ENVIRONMENT_TEXTURE_PATHS.pit,
      { repeat: 3, normalScale: 0.38 },
    );

    const stoneGeometry = new THREE.DodecahedronGeometry(0.38, 0);
    const stoneMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x8c8b82, roughness: 0.94 }),
      new THREE.MeshStandardMaterial({ color: 0x747873, roughness: 0.96 }),
      new THREE.MeshStandardMaterial({ color: 0xa0927e, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0x676b69, roughness: 0.98 }),
    ];

    function shapeStone(stone: THREE.Mesh, index: number, generation = 0) {
      const descriptor = getStoneDescriptor(index, generation);
      stone.scale.set(descriptor.scaleX, descriptor.scaleY, descriptor.scaleZ);
      stone.rotation.set(
        descriptor.rotationX,
        descriptor.rotationY,
        descriptor.rotationZ,
      );
      // Eighty-four independently animated field stones remain separate meshes,
      // but skipping their shadow pass avoids doubling their mobile draw cost.
      stone.castShadow = false;
      stone.receiveShadow = true;
    }

    function createStone(index: number, generation = 0) {
      const descriptor = getStoneDescriptor(index, generation);
      const stone = new THREE.Mesh(
        stoneGeometry,
        stoneMaterials[descriptor.material],
      );
      shapeStone(stone, index, generation);
      stone.userData.available = true;
      stone.userData.stoneId = descriptor.id;
      stone.userData.generation = generation;
      return stone;
    }

    const rocks: THREE.Mesh[] = [];
    for (let i = 0; i < FIELD_STONE_COUNT; i += 1) {
      const descriptor = getStoneDescriptor(i);
      const stone = createStone(i);
      stone.position.set(descriptor.x, 0.3, descriptor.z);
      scene.add(stone);
      rocks.push(stone);
    }

    const pitPileMeshes = stoneMaterials.map((material) => {
      const mesh = new THREE.InstancedMesh(stoneGeometry, material, 180);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      pitGroup.add(mesh);
      return mesh;
    });
    const pitPileTransform = new THREE.Object3D();
    function reconcilePitPile(nextCount: number) {
      const visibleCount = Math.min(nextCount, 180);
      const materialCounts = [0, 0, 0, 0];
      for (let i = 0; i < visibleCount; i += 1) {
        const generation = 1_000 + Math.floor(i / FIELD_STONE_COUNT);
        const descriptor = getStoneDescriptor(i % FIELD_STONE_COUNT, generation);
        const normalized = i / Math.max(1, visibleCount);
        const radius =
          Math.sqrt(Math.abs(descriptor.x) / FIELD_RADIUS) * (3.9 - normalized * 0.35);
        const angle = descriptor.rotationY * Math.PI;
        const lift = Math.max(0, (nextCount / CAPACITY) * 2.25 - radius * 0.18);
        pitPileTransform.position.set(
          Math.cos(angle) * radius,
          -0.1 + lift,
          Math.sin(angle) * radius,
        );
        pitPileTransform.rotation.set(
          descriptor.rotationX,
          descriptor.rotationY,
          descriptor.rotationZ,
        );
        pitPileTransform.scale.set(
          descriptor.scaleX,
          descriptor.scaleY,
          descriptor.scaleZ,
        );
        pitPileTransform.updateMatrix();
        const materialIndex = descriptor.material;
        pitPileMeshes[materialIndex].setMatrixAt(
          materialCounts[materialIndex],
          pitPileTransform.matrix,
        );
        materialCounts[materialIndex] += 1;
      }
      for (let index = 0; index < pitPileMeshes.length; index += 1) {
        const mesh = pitPileMeshes[index];
        mesh.count = materialCounts[index];
        mesh.visible = mesh.count > 0;
        if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
    }
    reconcilePitPile(storedCount);

    const player = new THREE.Group();
    player.position.set(0, 0, 18);
    player.rotation.y = 0;
    scene.add(player);

    const localAvatar = createProceduralAvatar({
      seed: `${profileRef.current.name}:${profileRef.current.city}`,
      name: "local-player-avatar",
      castShadow: true,
      groundShadow: true,
    });
    player.add(localAvatar.root);
    gameMount.dataset.avatarRenderer = "procedural";

    const riggedAvatarController = new AbortController();
    let riggedAvatar: RiggedAvatarRuntime | null = null;
    void (async () => {
      try {
        const { loadRiggedAvatar } = await import("./avatar/rigged-avatar-runtime.ts");
        const result = await loadRiggedAvatar(WAITLANDER_RUNTIME_MANIFEST, {
          signal: riggedAvatarController.signal,
          initialMotion: { moving: false, speed: 0, carryingStone: false },
          castShadow: true,
          receiveShadow: false,
        });
        if (!result.ok) return;
        if (disposed) {
          result.avatar.dispose();
          return;
        }
        riggedAvatar = result.avatar;
        player.add(result.avatar.root);
        localAvatar.root.visible = false;
        gameMount.dataset.avatarRenderer = "rigged";
      } catch {
        // The procedural avatar is already visible and remains the complete
        // offline/error fallback when the authored asset cannot be loaded.
      }
    })();

    function applyLocalAppearance(seed: string) {
      localAvatar.setAppearance(createAvatarAppearance(seed));
    }
    applyLocalAppearance(`${profileRef.current.name}:${profileRef.current.city}`);

    const keys = new Set<string>();
    let nearestRock: THREE.Mesh | null = null;
    let heldRock: THREE.Mesh | null = null;
    let pickupPending = false;
    let isThrowing = false;
    let walkTime = 0;
    let activeThrow:
      | {
          stone: THREE.Mesh;
          start: THREE.Vector3;
          end: THREE.Vector3;
          elapsed: number;
          duration: number;
          landsInPit: boolean;
        }
      | undefined;

    const worldForward = new THREE.Vector3(0, 0, -1);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const cameraForward = new THREE.Vector3(0, 0, -1);
    const cameraRight = new THREE.Vector3(1, 0, 0);
    const desiredCameraPosition = new THREE.Vector3();
    const cameraLookTarget = new THREE.Vector3();
    const speechAnchor = new THREE.Vector3();
    const heldRockAnchorPosition = new THREE.Vector3();
    const remoteRenderer = new RemoteAvatarRenderer(scene, {
      maxPlayers: 64,
      interpolationDelayMs: 100,
      extrapolationLimitMs: 160,
      maxRenderDistance: 62,
      detailDistance: 30,
      // Presence is socket-owned. Idle people should remain visible without
      // manufacturing movement heartbeats that keep the room awake.
      staleAwakeAfterMs: 24 * 60 * 60 * 1_000,
    });
    const remotePlayers = new Map<string, RealtimePlayer>();
    const remoteOverlays = new Map<
      string,
      {
        root: HTMLDivElement;
        speech: HTMLDivElement;
        name: HTMLElement;
        detail: HTMLSpanElement;
      }
    >();
    const pendingActions = new Map<
      string,
      {
        kind: "pickup" | "throw";
        stone: THREE.Mesh;
        originalPosition: THREE.Vector3;
      }
    >();
    const deferredStoneStates = new Map<string, RealtimeStone>();
    let selfId = "";
    let sharedWorld = false;
    let multiplayerBlockReason: "replaced" | "incompatible" | null = null;
    let lastMoving = false;
    let lastNetworkHeading = player.rotation.y;
    let lastRemoteOverlayAt = 0;
    let serverClockOffsetMs: number | undefined;
    let hasAuthoritativePitCount = false;

    function flashMessage(nextMessage: string, duration = 1_600) {
      setMessage(nextMessage);
      if (messageTimer) clearTimeout(messageTimer);
      messageTimer = setTimeout(() => {
        if (pickupPending) setMessage("Picking it up…");
        else if (heldRock) setMessage("Take it to the pit");
        else setMessage("Walk to a stone");
      }, duration);
    }

    function setMode(nextMode: ActionMode) {
      if (lastActionMode === nextMode) return;
      lastActionMode = nextMode;
      setActionMode(nextMode);
    }

    function applyPitCount(nextCount: number, options: { authoritative?: boolean } = {}) {
      const bounded = clamp(Math.trunc(nextCount), 0, CAPACITY);
      // The pit only grows. Fanout and action acknowledgements can cross in
      // flight, so ordinary shared updates must never roll back a newer count.
      // The first welcome is the one exception: it replaces local solo/stale
      // state. Later reconnect welcomes can race a newer action acknowledgement,
      // so they stay monotonic like every other shared update.
      const replaceLocalSnapshot = Boolean(options.authoritative) && !hasAuthoritativePitCount;
      const next =
        sharedWorld && !replaceLocalSnapshot
          ? Math.max(currentStoneCount, bounded)
          : bounded;
      if (options.authoritative) hasAuthoritativePitCount = true;
      if (next === currentStoneCount) return;
      currentStoneCount = next;
      setCount(next);
      reconcilePitPile(next);
    }

    function observeServerClock(serverTime: number) {
      if (!Number.isFinite(serverTime)) return;
      const observedOffset = Date.now() - serverTime;
      if (
        serverClockOffsetMs === undefined ||
        Math.abs(observedOffset - serverClockOffsetMs) > 60_000
      ) {
        serverClockOffsetMs = observedOffset;
        return;
      }
      // Prefer low-latency samples while still following gradual clock drift.
      const amount = observedOffset < serverClockOffsetMs ? 0.2 : 0.025;
      serverClockOffsetMs += (observedOffset - serverClockOffsetMs) * amount;
    }

    function localSpeechExpiration(serverExpiration: number) {
      const now = Date.now();
      const estimatedTtl =
        Number.isFinite(serverExpiration) && serverClockOffsetMs !== undefined
          ? serverExpiration + serverClockOffsetMs - now
          : REMOTE_SPEECH_TTL_MS;
      return now + clamp(estimatedTtl, 500, REMOTE_SPEECH_TTL_MS);
    }

    function removeRemoteOverlay(playerId: string) {
      const overlay = remoteOverlays.get(playerId);
      if (!overlay) return;
      overlay.root.remove();
      remoteOverlays.delete(playerId);
    }

    function ensureRemoteOverlay(anchor: RemoteAvatarAnchor) {
      let overlay = remoteOverlays.get(anchor.id);
      if (!overlay) {
        const root = document.createElement("div");
        root.className = "player-overlay remote-player-overlay";
        root.dataset.playerId = anchor.id;

        const speechSlot = document.createElement("div");
        speechSlot.className = "speech-slot";
        const nameplate = document.createElement("div");
        nameplate.className = "avatar-nameplate";
        const name = document.createElement("strong");
        const detail = document.createElement("span");
        nameplate.append(name, detail);
        root.append(speechSlot, nameplate);
        gameMount.appendChild(root);
        overlay = { root, speech: speechSlot, name, detail };
        remoteOverlays.set(anchor.id, overlay);
      }

      const remoteProfile = anchor.profile;
      const remoteFlag = countryCodeToFlag(remoteProfile?.countryCode ?? "");
      const nextName = `${remoteFlag} ${remoteProfile?.name ?? "Someone"}`;
      const city = remoteProfile?.city?.trim();
      const nextDetail = anchor.departing
        ? "Heading back to real life"
        : `${city ? `${city} · ` : ""}Waiting for ${remoteProfile?.waitingFor ?? "something"}`;
      if (overlay.name.textContent !== nextName) overlay.name.textContent = nextName;
      if (overlay.detail.textContent !== nextDetail) overlay.detail.textContent = nextDetail;
      const speechIsLive =
        Boolean(anchor.speech) &&
        (!anchor.speechExpiresAt || anchor.speechExpiresAt > Date.now());
      if (speechIsLive) {
        let bubble = overlay.speech.firstElementChild as HTMLDivElement | null;
        if (!bubble) {
          bubble = document.createElement("div");
          bubble.className = "speech-bubble";
          overlay.speech.appendChild(bubble);
        }
        const nextSpeech = anchor.speech ?? "";
        if (bubble.textContent !== nextSpeech) bubble.textContent = nextSpeech;
      } else {
        overlay.speech.replaceChildren();
      }
      return overlay;
    }

    function updateRemoteOverlays(anchors: readonly RemoteAvatarAnchor[]) {
      const now = performance.now();
      if (now - lastRemoteOverlayAt < 1000 / 30) return;
      lastRemoteOverlayAt = now;
      for (const overlay of remoteOverlays.values()) overlay.root.style.visibility = "hidden";
      const wallClock = Date.now();
      const nearest = [...anchors]
        .sort((a, b) => {
          const aSpeaking = Boolean(
            a.speech && (!a.speechExpiresAt || a.speechExpiresAt > wallClock),
          );
          const bSpeaking = Boolean(
            b.speech && (!b.speechExpiresAt || b.speechExpiresAt > wallClock),
          );
          if (aSpeaking !== bSpeaking) return aSpeaking ? -1 : 1;
          return a.distance - b.distance;
        })
        .slice(0, 12);
      const visibleIds = new Set(nearest.map((anchor) => anchor.id));
      for (const anchor of nearest) {
        const overlay = ensureRemoteOverlay(anchor);
        overlay.root.style.visibility = "visible";
        overlay.root.style.opacity = String(clamp(1 - Math.max(0, anchor.distance - 34) / 28, 0.28, 1));
        overlay.root.style.transform = `translate3d(${anchor.screenX}px, ${anchor.screenY}px, 0) translate(-50%, -100%)`;
      }
      for (const playerId of remoteOverlays.keys()) {
        if (!remotePlayers.has(playerId) && !visibleIds.has(playerId)) removeRemoteOverlay(playerId);
      }
    }

    function syncRemotePlayers(players: RealtimePlayer[], serverTime: number) {
      const acceptedSelf = players.find((candidate) => candidate.id === selfId);
      if (acceptedSelf) {
        const correctionDistance = Math.hypot(
          acceptedSelf.x - player.position.x,
          acceptedSelf.z - player.position.z,
        );
        const correction = correctionDistance > 2.4 ? 1 : 0.16;
        player.position.x += (acceptedSelf.x - player.position.x) * correction;
        player.position.z += (acceptedSelf.z - player.position.z) * correction;
      }
      const nextPlayers = players
        .filter((candidate) => candidate.id !== selfId && !candidate.sleeping)
        .slice(0, 64);
      remotePlayers.clear();
      for (const candidate of nextPlayers) remotePlayers.set(candidate.id, candidate);
      remoteRenderer.replaceSnapshot(
        nextPlayers.map((candidate) => toRemoteSnapshot(candidate)),
        serverTime,
      );
      for (const playerId of remoteOverlays.keys()) {
        if (!remotePlayers.has(playerId)) removeRemoteOverlay(playerId);
      }
      setOnlineCount(1 + nextPlayers.length);
    }

    function applyRemotePlayerDeltas(players: RealtimePlayerDelta[], serverTime: number) {
      const acceptedSelf = players.find((candidate) => candidate.id === selfId);
      if (acceptedSelf) {
        const correctionDistance = Math.hypot(
          acceptedSelf.x - player.position.x,
          acceptedSelf.z - player.position.z,
        );
        const correction = correctionDistance > 2.4 ? 1 : 0.16;
        player.position.x += (acceptedSelf.x - player.position.x) * correction;
        player.position.z += (acceptedSelf.z - player.position.z) * correction;
      }
      for (const candidate of players) {
        if (candidate.id === selfId) continue;
        if (candidate.sleeping) {
          if (remotePlayers.delete(candidate.id)) {
            remoteRenderer.depart(candidate.id);
          }
          continue;
        }
        const existing = remotePlayers.get(candidate.id);
        if (!candidate.profile && !existing) continue;
        const merged: RealtimePlayer = {
          ...(existing ?? (candidate as RealtimePlayer)),
          ...candidate,
          profile: candidate.profile ?? existing!.profile,
        };
        if (!remotePlayers.has(candidate.id) && remotePlayers.size >= 64) continue;
        remotePlayers.set(candidate.id, merged);
        remoteRenderer.upsert(toRemoteSnapshot(merged), serverTime);
      }
      setOnlineCount(1 + remotePlayers.size);
    }

    function applyStoneState(stoneState: RealtimeStone) {
      const stone = rocks.find((candidate) => candidate.userData.stoneId === stoneState.id);
      if (!stone) return;
      if (stone === heldRock || stone === activeThrow?.stone) {
        deferredStoneStates.set(stoneState.id, stoneState);
        return;
      }
      deferredStoneStates.delete(stoneState.id);
      if (typeof stoneState.generation === "number") {
        const index = Number.parseInt(stoneState.id.replace("stone-", ""), 10);
        const generation = Math.max(0, Math.trunc(stoneState.generation));
        const descriptor = getStoneDescriptor(Number.isFinite(index) ? index : 0, generation);
        stone.userData.generation = generation;
        stone.scale.set(descriptor.scaleX, descriptor.scaleY, descriptor.scaleZ);
        stone.rotation.set(
          descriptor.rotationX,
          descriptor.rotationY,
          descriptor.rotationZ,
        );
        stone.material = stoneMaterials[descriptor.material];
      }
      if (stoneState.holderId) {
        stone.userData.available = false;
        stone.visible = false;
        return;
      }
      scene.attach(stone);
      stone.position.set(stoneState.x, 0.3, stoneState.z);
      stone.visible = true;
      stone.userData.available = true;
    }

    function reconcileAuthoritativeSelf(
      acceptedSelf: RealtimePlayer | undefined,
      stoneStates: RealtimeStone[],
    ) {
      pendingActions.clear();
      deferredStoneStates.clear();
      pickupPending = false;
      if (activeThrow) {
        scene.attach(activeThrow.stone);
        activeThrow.stone.visible = true;
        activeThrow = undefined;
        isThrowing = false;
      }
      if (heldRock) {
        scene.attach(heldRock);
        heldRock.visible = true;
        heldRock = null;
      }

      for (const stoneState of stoneStates) applyStoneState(stoneState);

      const carriedId =
        acceptedSelf && typeof acceptedSelf.carrying === "string"
          ? acceptedSelf.carrying
          : null;
      if (carriedId) {
        const authoritativeStone = rocks.find(
          (candidate) => candidate.userData.stoneId === carriedId,
        );
        if (authoritativeStone) {
          authoritativeStone.visible = true;
          authoritativeStone.userData.available = false;
          player.attach(authoritativeStone);
          authoritativeStone.position.set(0.58, 1.65, -0.28);
          authoritativeStone.rotation.set(0.25, 0.4, 0.1);
          heldRock = authoritativeStone;
        }
      }
      setMode(heldRock ? "throw" : "none");
    }

    function handleActionResult(result: ActionResultMessage) {
      const pending = pendingActions.get(result.id);
      if (pending) pendingActions.delete(result.id);
      if (pending?.kind === "pickup") pickupPending = false;
      if (typeof result.count === "number") applyPitCount(result.count);
      if (
        pending?.kind === "throw" &&
        result.ok &&
        result.deposited === false &&
        activeThrow?.stone === pending.stone
      ) {
        activeThrow.landsInPit = false;
        const forward = worldForward.clone().applyQuaternion(player.quaternion).normalize();
        activeThrow.end.set(
          player.position.x + forward.x * 7.5,
          0.3,
          player.position.z + forward.z * 7.5,
        );
      }
      if (
        pending?.kind === "throw" &&
        result.ok &&
        result.deposited === true &&
        activeThrow?.stone === pending.stone
      ) {
        activeThrow.landsInPit = true;
        activeThrow.end.set(
          (Math.random() - 0.5) * 4.4,
          0.34,
          (Math.random() - 0.5) * 4.4,
        );
      }
      if (!pending) return;
      if (result.ok) {
        if (pending.kind === "pickup" && heldRock === pending.stone) {
          setMode("throw");
          flashMessage("Take it to the pit");
        }
        if (result.kind === "throw" && result.deposited === false) {
          flashMessage(result.reason === "pit-full" ? "The pit is full" : "A little closer");
        }
        return;
      }

      if (pending.kind === "pickup" && heldRock === pending.stone) {
        heldRock = null;
        scene.attach(pending.stone);
        pending.stone.position.copy(pending.originalPosition);
        pending.stone.visible = true;
        pending.stone.userData.available = true;
        setMode("none");
        const deferred = deferredStoneStates.get(
          String(pending.stone.userData.stoneId ?? ""),
        );
        if (deferred) applyStoneState(deferred);
      }
      if (
        pending.kind === "throw" &&
        ["action-rate-limited", "room-busy"].includes(result.reason ?? "")
      ) {
        if (activeThrow?.stone === pending.stone) activeThrow = undefined;
        isThrowing = false;
        pending.stone.visible = true;
        pending.stone.userData.available = false;
        player.attach(pending.stone);
        pending.stone.position.set(0.58, 1.65, -0.28);
        pending.stone.rotation.set(0.25, 0.4, 0.1);
        heldRock = pending.stone;
        setMode("throw");
      }
      if (
        pending.kind === "throw" &&
        ["action-failed", "not-carrying"].includes(result.reason ?? "")
      ) {
        realtime.sleep("authoritative resync");
        window.setTimeout(() => realtime.wake(), 0);
      }
      flashMessage(
        result.reason === "stone-unavailable" ? "Someone got there first" : "Try again",
      );
    }

    function consumeStoneVisually(stone: THREE.Mesh, respawnLocally = true) {
      stone.userData.available = false;
      stone.visible = false;
      scene.attach(stone);
      if (!respawnLocally) return;
      const respawnTimer = setTimeout(() => {
        respawnTimers.delete(respawnTimer);
        if (disposed) return;
        const stoneId = String(stone.userData.stoneId ?? "");
        const index = Number.parseInt(stoneId.replace("stone-", ""), 10);
        const generation = Math.max(0, Number(stone.userData.generation) || 0) + 1;
        const descriptor = getStoneDescriptor(Number.isFinite(index) ? index : 0, generation);
        stone.userData.generation = generation;
        stone.position.set(descriptor.x, 0.3, descriptor.z);
        stone.scale.set(descriptor.scaleX, descriptor.scaleY, descriptor.scaleZ);
        stone.rotation.set(
          descriptor.rotationX,
          descriptor.rotationY,
          descriptor.rotationZ,
        );
        stone.visible = true;
        stone.userData.available = true;
      }, 1_200);
      respawnTimers.add(respawnTimer);
    }

    function addStoneToPit(stone: THREE.Mesh) {
      if (sharedWorld) {
        consumeStoneVisually(stone, false);
        flashMessage("Added to the pit");
        return;
      }

      const next = clamp(currentStoneCount + 1, 0, CAPACITY);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Keep the current session playable when storage is unavailable.
      }
      applyPitCount(next);
      consumeStoneVisually(stone);
      flashMessage(next >= CAPACITY ? "The pit is full" : `Stone ${next} of ${CAPACITY.toLocaleString()}`);
    }

    const realtime = new RealtimeClient({
      profile: profileRef.current,
      onStatus: (status) => {
        if (disposed) return;
        setConnectionStatus(status);
        if (status.state === "online") {
          sharedWorld = true;
          multiplayerBlockReason = null;
        } else if (status.state === "replaced") {
          multiplayerBlockReason = "replaced";
          setMode("none");
          flashMessage("This field is open in another tab", 4_000);
        } else if (status.state === "incompatible") {
          multiplayerBlockReason = "incompatible";
          setMode("none");
          flashMessage("Refresh to join this field", 4_000);
        }
      },
      onWelcome: (welcome) => {
        if (disposed) return;
        sharedWorld = true;
        selfId = welcome.selfId;
        applyLocalAppearance(selfId);
        observeServerClock(welcome.serverTime);
        applyPitCount(welcome.count, { authoritative: true });
        const self = welcome.players.find((candidate) => candidate.id === welcome.selfId);
        if (self) {
          player.position.set(self.x, 0, self.z);
          player.rotation.y = self.heading;
        }
        reconcileAuthoritativeSelf(self, welcome.stones ?? []);
        syncRemotePlayers(welcome.players, welcome.serverTime);
      },
      onFrame: (frame) => {
        if (disposed) return;
        observeServerClock(frame.serverTime);
        applyRemotePlayerDeltas(frame.players, frame.serverTime);
      },
      onChat: (chat) => {
        if (disposed || chat.playerId === selfId) return;
        const remote = remotePlayers.get(chat.playerId);
        if (!remote) return;
        remoteRenderer.setSpeech(
          chat.playerId,
          chat.text,
          localSpeechExpiration(chat.expiresAt),
        );
        setLiveAnnouncement(`${remote.profile.name}: ${chat.text}`);
      },
      onStone: (message) => {
        if (disposed) return;
        if (message.op === "upsert" && message.stone) applyStoneState(message.stone);
        if (message.op === "remove" && message.stoneId) {
          const stone = rocks.find(
            (candidate) => candidate.userData.stoneId === message.stoneId,
          );
          if (stone && stone !== heldRock && stone !== activeThrow?.stone) {
            stone.visible = false;
            stone.userData.available = false;
          }
        }
      },
      onPit: (pit) => {
        if (!disposed) applyPitCount(pit.count);
      },
      onAction: (result) => {
        if (!disposed) handleActionResult(result);
      },
      onPlayer: (event) => {
        if (disposed || event.playerId === selfId) return;
        if (event.t === "player_leave") {
          const departing = remotePlayers.get(event.playerId);
          remotePlayers.delete(event.playerId);
          remoteRenderer.depart(event.playerId);
          if (departing) setOnlineCount(1 + remotePlayers.size);
        } else if (event.player) {
          if (event.player.sleeping) {
            remotePlayers.delete(event.player.id);
            remoteRenderer.depart(event.player.id);
            setOnlineCount(1 + remotePlayers.size);
            return;
          }
          remotePlayers.set(event.player.id, event.player);
          remoteRenderer.upsert(toRemoteSnapshot(event.player));
        }
      },
      onError: (error) => {
        if (disposed) return;
        if (error.source === "server" && error.code === "chat-rate-limited") {
          setSpeech("");
          flashMessage("Wait a moment before speaking again", 2_400);
        } else if (error.source === "server" && !error.recoverable) {
          multiplayerBlockReason = "incompatible";
          setConnectionStatus({
            state: "incompatible",
            attempt: 0,
            reason: "Multiplayer needs a refresh",
          });
          setMode("none");
          flashMessage("Multiplayer needs a refresh", 2_400);
        }
      },
    });
    realtimeRef.current = realtime;

    function performAction() {
      if (disposed || isThrowing) return;
      if (multiplayerBlockReason) {
        flashMessage(
          multiplayerBlockReason === "incompatible"
            ? "Refresh to join this field"
            : "Continue in the other tab",
          2_400,
        );
        return;
      }

      if (!heldRock && nearestRock) {
        const originalPosition = nearestRock.position.clone();
        const stoneId = String(nearestRock.userData.stoneId ?? "");
        const actionId = sharedWorld ? realtimeRef.current?.pickup(stoneId) : undefined;
        if (sharedWorld && !actionId) {
          flashMessage("Reconnecting…");
          return;
        }
        heldRock = nearestRock;
        heldRock.userData.available = false;
        player.attach(heldRock);
        heldRock.position.set(0.58, 1.65, -0.28);
        heldRock.rotation.set(0.25, 0.4, 0.1);
        if (actionId) {
          pickupPending = true;
          pendingActions.set(actionId, {
            kind: "pickup",
            stone: heldRock,
            originalPosition,
          });
        }
        setMode(pickupPending ? "none" : "throw");
        flashMessage(pickupPending ? "Picking it up…" : "Take it to the pit");
        return;
      }

      if (!heldRock) return;
      if (pickupPending) return;

      const stone = heldRock;
      const stoneId = String(stone.userData.stoneId ?? "");
      const actionId = sharedWorld ? realtimeRef.current?.throwStone(stoneId) : undefined;
      if (sharedWorld && !actionId) {
        flashMessage("Reconnecting…");
        return;
      }
      heldRock = null;
      isThrowing = true;
      riggedAvatar?.playInteraction({ restart: true });
      scene.attach(stone);

      const start = stone.position.clone();
      const distance = Math.hypot(player.position.x, player.position.z);
      const closeEnoughToPit = distance <= PIT_THROW_RADIUS;
      const forward = worldForward.clone().applyQuaternion(player.quaternion).normalize();
      const end = closeEnoughToPit
        ? new THREE.Vector3((Math.random() - 0.5) * 4.4, 0.34, (Math.random() - 0.5) * 4.4)
        : new THREE.Vector3(
            player.position.x + forward.x * 7.5,
            0.3,
            player.position.z + forward.z * 7.5,
          );

      activeThrow = {
        stone,
        start,
        end,
        elapsed: 0,
        duration: closeEnoughToPit ? 0.72 : 0.62,
        landsInPit: closeEnoughToPit,
      };
      if (actionId) {
        pendingActions.set(actionId, {
          kind: "throw",
          stone,
          originalPosition: start.clone(),
        });
      }
      setMode("none");
      setMessage(closeEnoughToPit ? "" : "A little closer");
    }
    performActionRef.current = performAction;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, button, select, a, [contenteditable='true']")
      ) {
        return;
      }

      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      keys.add(event.code);
      if ((event.code === "Space" || event.code === "KeyE") && !event.repeat) performAction();
    }

    function onKeyUp(event: KeyboardEvent) {
      keys.delete(event.code);
    }

    function releaseInputs() {
      keys.clear();
      joystickPointer.current = null;
      joystickInput.current = { x: 0, y: 0 };
      if (joystickThumbRef.current) {
        joystickThumbRef.current.style.transform = "translate3d(0, 0, 0)";
      }
      // Send even when the last animation frame already observed a stop: that
      // zero-velocity update may still be waiting in the movement throttle.
      if (sharedWorld && realtime.isOnline) {
        realtime.sendMovementImmediately({
          x: player.position.x,
          z: player.position.z,
          heading: player.rotation.y,
          vx: 0,
          vz: 0,
        });
        lastNetworkHeading = player.rotation.y;
      }
      lastMoving = false;
    }

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") {
        releaseInputs();
      }
    }

    function onPageHide() {
      releaseInputs();
    }

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseInputs);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Register the game lifecycle hooks before starting the transport so the
    // final zero-velocity pose is queued before its own pagehide sleep handler.
    void realtime.start();

    function resize() {
      viewportWidth = gameMount.clientWidth;
      viewportHeight = gameMount.clientHeight;
      renderer?.setSize(viewportWidth, viewportHeight, false);
      camera.aspect = viewportWidth / Math.max(1, viewportHeight);
      camera.updateProjectionMatrix();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const clock = new THREE.Clock();
    function animate() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const positionBeforeX = player.position.x;
      const positionBeforeZ = player.position.z;

      const keyX =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
        (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      const keyY =
        (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
        (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
      const inputX = clamp(keyX + joystickInput.current.x, -1, 1);
      const inputY = clamp(keyY + joystickInput.current.y, -1, 1);
      const inputLength = Math.hypot(inputX, inputY);

      if (inputLength > 0.08) {
        if (!movedOnce) {
          movedOnce = true;
          setHasMoved(true);
        }
        const normalizedX = inputX / Math.max(1, inputLength);
        const normalizedY = inputY / Math.max(1, inputLength);
        camera.getWorldDirection(cameraForward);
        cameraForward.y = 0;
        if (cameraForward.lengthSq() < 0.001) cameraForward.set(0, 0, -1);
        else cameraForward.normalize();
        cameraRight.crossVectors(cameraForward, worldUp).normalize();
        const movementX = cameraRight.x * normalizedX + cameraForward.x * normalizedY;
        const movementZ = cameraRight.z * normalizedX + cameraForward.z * normalizedY;
        const speed = heldRock ? CARRY_SPEED : WALK_SPEED;
        const nextX = player.position.x + movementX * speed * dt;
        const nextZ = player.position.z + movementZ * speed * dt;
        const nextDistanceFromCenter = Math.hypot(nextX, nextZ);

        if (nextDistanceFromCenter < PIT_WALL_RADIUS) {
          const safeScale = PIT_WALL_RADIUS / Math.max(nextDistanceFromCenter, 0.001);
          player.position.x = nextX * safeScale;
          player.position.z = nextZ * safeScale;
        } else if (nextDistanceFromCenter <= FIELD_RADIUS) {
          player.position.x = nextX;
          player.position.z = nextZ;
        }

        const targetRotation = Math.atan2(-movementX, -movementZ);
        let rotationDelta = targetRotation - player.rotation.y;
        rotationDelta = Math.atan2(Math.sin(rotationDelta), Math.cos(rotationDelta));
        player.rotation.y += rotationDelta * Math.min(1, dt * 12);

        walkTime += dt * 10.5;
      }

      const avatarMoving = inputLength > 0.08;
      if (riggedAvatar) {
        riggedAvatar.update(dt, {
          moving: avatarMoving,
          speed: avatarMoving ? 1 : 0,
          carryingStone: Boolean(heldRock),
        });
      } else {
        localAvatar.updatePose({
          walkPhase: walkTime,
          moving: avatarMoving,
          speed: avatarMoving ? 1 : 0,
          carryingStone: Boolean(heldRock),
        });
      }

      if (heldRock) {
        const heldItemAnchor = riggedAvatar?.anchors.heldItem ?? localAvatar.anchors.heldItem;
        player.updateMatrixWorld(true);
        heldItemAnchor.getWorldPosition(heldRockAnchorPosition);
        player.worldToLocal(heldRockAnchorPosition);
        heldRock.position.lerp(heldRockAnchorPosition, Math.min(1, dt * 18));
        heldRock.rotation.y += dt * 0.6;
      }

      const displacementX = player.position.x - positionBeforeX;
      const displacementZ = player.position.z - positionBeforeZ;
      const movingNow = Math.hypot(displacementX, displacementZ) > 0.0001;
      const headingDelta = Math.atan2(
        Math.sin(player.rotation.y - lastNetworkHeading),
        Math.cos(player.rotation.y - lastNetworkHeading),
      );
      const headingChanged = Math.abs(headingDelta) > 0.03;
      if (sharedWorld && (movingNow || lastMoving || headingChanged)) {
        realtime.sendMovement({
          x: player.position.x,
          z: player.position.z,
          heading: player.rotation.y,
          vx: dt > 0 ? displacementX / dt : 0,
          vz: dt > 0 ? displacementZ / dt : 0,
        });
        lastNetworkHeading = player.rotation.y;
      }
      lastMoving = movingNow;

      nearestRock = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      if (!heldRock && !isThrowing) {
        for (const rock of rocks) {
          if (!rock.userData.available || rock.parent !== scene) continue;
          const distance = Math.hypot(
            rock.position.x - player.position.x,
            rock.position.z - player.position.z,
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestRock = rock;
          }
        }
      }

      if (multiplayerBlockReason) setMode("none");
      else if (heldRock && !pickupPending) setMode("throw");
      else if (heldRock) setMode("none");
      else if (nearestRock && nearestDistance <= 1.85) setMode("pickup");
      else setMode("none");
      if (nearestDistance > 1.85 && !heldRock) nearestRock = null;

      if (activeThrow) {
        activeThrow.elapsed += dt;
        const t = clamp(activeThrow.elapsed / activeThrow.duration, 0, 1);
        activeThrow.stone.position.lerpVectors(activeThrow.start, activeThrow.end, t);
        activeThrow.stone.position.y += Math.sin(t * Math.PI) * (activeThrow.landsInPit ? 3.5 : 2.3);
        activeThrow.stone.rotation.x += dt * 8;
        activeThrow.stone.rotation.z += dt * 5;

        if (t >= 1) {
          const completedStone = activeThrow.stone;
          completedStone.position.copy(activeThrow.end);
          if (activeThrow.landsInPit) addStoneToPit(completedStone);
          else completedStone.userData.available = true;
          activeThrow = undefined;
          isThrowing = false;
          const deferred = deferredStoneStates.get(
            String(completedStone.userData.stoneId ?? ""),
          );
          if (deferred) applyStoneState(deferred);
        }
      }

      const pitDistance = Math.max(0, Math.round(Math.hypot(player.position.x, player.position.z) - 5.2));
      if (pitDistance !== lastDistanceLabel) {
        lastDistanceLabel = pitDistance;
        setDistanceToPit(pitDistance);
      }

      const distanceFromPit = Math.max(0.001, Math.hypot(player.position.x, player.position.z));
      const outwardX = player.position.x / distanceFromPit;
      const outwardZ = player.position.z / distanceFromPit;
      desiredCameraPosition.set(
        player.position.x + outwardX * 18,
        player.position.y + 12,
        player.position.z + outwardZ * 18,
      );
      camera.position.lerp(desiredCameraPosition, 1 - Math.pow(0.001, dt));
      // Keep the pit and path in the composition while placing the hero in the
      // lower third. Movement is mapped through this camera yaw above, so the
      // joystick remains screen-relative as the view orbits the objective.
      const lookAhead = Math.min(distanceFromPit * 0.5, 12);
      cameraLookTarget.set(
        player.position.x - outwardX * lookAhead,
        1.8,
        player.position.z - outwardZ * lookAhead,
      );
      camera.lookAt(cameraLookTarget);
      camera.updateMatrixWorld();
      storybookWorld.update(clock.elapsedTime);

      remoteRenderer.update(
        performance.now(),
        dt,
        camera,
        player.position,
        { width: viewportWidth, height: viewportHeight },
        updateRemoteOverlays,
      );

      const playerOverlay = playerOverlayRef.current;
      if (playerOverlay) {
        speechAnchor.set(player.position.x, 3.22, player.position.z).project(camera);
        const onScreen =
          speechAnchor.z > -1 &&
          speechAnchor.z < 1 &&
          Math.abs(speechAnchor.x) < 1.15 &&
          Math.abs(speechAnchor.y) < 1.15;

        playerOverlay.style.visibility = onScreen ? "visible" : "hidden";
        if (onScreen) {
          const overlayX = (speechAnchor.x * 0.5 + 0.5) * viewportWidth;
          const overlayY = (-speechAnchor.y * 0.5 + 0.5) * viewportHeight;
          playerOverlay.style.transform = `translate3d(${overlayX}px, ${overlayY}px, 0) translate(-50%, -100%)`;
        }
      }

      renderer?.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    }
    animate();

    return () => {
      disposed = true;
      performActionRef.current = () => undefined;
      window.cancelAnimationFrame(animationFrame);
      if (messageTimer) clearTimeout(messageTimer);
      respawnTimers.forEach((timer) => clearTimeout(timer));
      respawnTimers.clear();
      if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
      riggedAvatarController.abort();
      realtime.destroy();
      if (realtimeRef.current === realtime) realtimeRef.current = null;
      remoteRenderer.dispose();
      remoteOverlays.forEach((overlay) => overlay.root.remove());
      remoteOverlays.clear();
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseInputs);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      storybookWorld.dispose();
      pitTextureBinding.dispose();
      stoneGeometry.dispose();
      stoneMaterials.forEach((material) => material.dispose());
      pitFloor.geometry.dispose();
      pitFloorMaterial.dispose();
      pitWallGeometry.dispose();
      pitWallMaterial.dispose();
      pitRim.geometry.dispose();
      pitRimMaterial.dispose();
      innerRim.geometry.dispose();
      innerRimMaterial.dispose();
      rimClumpGeometry.dispose();
      rimClumpMaterial.dispose();
      riggedAvatar?.dispose();
      localAvatar.dispose();
      renderer?.dispose();
      if (renderer?.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      worldFallback?.remove();
    };
  }, []);

  function updateJoystick(clientX: number, clientY: number) {
    const joystick = joystickRef.current;
    const thumb = joystickThumbRef.current;
    if (!joystick || !thumb) return;
    const rect = joystick.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const maxDistance = rect.width * 0.31;
    const distance = Math.hypot(dx, dy);
    const scale = distance > maxDistance ? maxDistance / distance : 1;
    const limitedX = dx * scale;
    const limitedY = dy * scale;
    joystickInput.current = { x: limitedX / maxDistance, y: -limitedY / maxDistance };
    thumb.style.transform = `translate3d(${limitedX}px, ${limitedY}px, 0)`;
  }

  function resetJoystick() {
    joystickPointer.current = null;
    joystickInput.current = { x: 0, y: 0 };
    if (joystickThumbRef.current) {
      joystickThumbRef.current.style.transform = "translate3d(0, 0, 0)";
    }
  }

  function submitSpeech(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextSpeech = chatText.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!nextSpeech) return;

    if (connectionState === "replaced") {
      setMessage("Continue in the other tab");
      return;
    }
    if (connectionState === "incompatible") {
      setMessage("Refresh to join multiplayer");
      return;
    }
    if (connectionState === "connecting" || connectionState === "offline") {
      setMessage("Message not sent — reconnecting");
      return;
    }
    if (connectionState === "online" && !realtimeRef.current?.sendChat(nextSpeech)) {
      setMessage("Message not sent — reconnecting");
      return;
    }

    setSpeech(nextSpeech);
    setChatText("");
    if (window.matchMedia("(pointer: coarse)").matches) {
      event.currentTarget.querySelector("input")?.blur();
    }
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = setTimeout(() => {
      setSpeech("");
      speechTimerRef.current = null;
    }, 7_000);
  }

  const progress = Math.min(100, (count / CAPACITY) * 100);
  const flag = countryCodeToFlag(profile.countryCode);
  const chatUnavailable =
    connectionState === "connecting" ||
    connectionState === "offline" ||
    connectionState === "replaced" ||
    connectionState === "incompatible";

  return (
    <main className="game-shell">
      <div ref={mountRef} className="world" />

      <div
        ref={playerOverlayRef}
        className="player-overlay"
      >
        <div className="speech-slot" role="status" aria-live="polite">
          {speech ? <div className="speech-bubble">{speech}</div> : null}
        </div>
        <div className="avatar-nameplate">
          <strong>{profile.name} · {profile.city} <span aria-hidden="true">{flag}</span></strong>
          <span>Waiting for {profile.reasonText}</span>
        </div>
      </div>

      <header className="game-header" aria-label="Pit progress">
        <div className="hud-left">
          <button
            type="button"
            className="identity-button"
            onClick={(event) => onEditProfile(event.currentTarget)}
            aria-label="Edit your name, city, and waiting reason"
          >
            <span className="identity-copy">
              <span className="brand-name">Waitland</span>
              <span className="identity-line">
                <span aria-hidden="true">{flag}</span>
                <span>{profile.name}</span>
                <span aria-hidden="true">·</span>
                <span>{profile.city}</span>
              </span>
            </span>
            <span className="profile-edit-icon" aria-hidden="true">
              <EditIcon />
            </span>
          </button>

          <div className="counter-card">
            <div className="counter-copy">
              <span>Pit 1</span>
              <strong>{count.toLocaleString()} / {CAPACITY.toLocaleString()} rocks</strong>
            </div>
            <div className="progress-track" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className={`network-presence is-${connectionState}`} aria-live="polite">
          <PeopleIcon className="people-icon" />
          <span title={connectionStatus.reason}>
            {networkLabel(connectionStatus, onlineCount)}
          </span>
          <span className="network-dot" aria-hidden="true" />
        </div>
      </header>

      <div className={`game-hint ${hasMoved ? "is-subtle" : ""}`} aria-live="polite">
        {message || "Keep going"}
      </div>

      <div className="pit-direction" aria-label={`The pit is ${distanceToPit} metres away`}>
        <CompassIcon className="pit-arrow" />
        <span>{distanceToPit}m to pit</span>
      </div>

      <form className="chat-form" onSubmit={submitSpeech}>
        <input
          type="text"
          value={chatText}
          maxLength={80}
          enterKeyHint="send"
          autoComplete="off"
          disabled={chatUnavailable}
          aria-label="Say something"
          placeholder="Say something…"
          onChange={(event) => setChatText(event.target.value)}
        />
        <button
          type="submit"
          disabled={!chatText.trim() || chatUnavailable}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </form>

      <div className="controls-layer">
        <div
          ref={joystickRef}
          className="joystick"
          role="group"
          aria-label="Movement control"
          onPointerDown={(event) => {
            joystickPointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            updateJoystick(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (joystickPointer.current === event.pointerId) {
              updateJoystick(event.clientX, event.clientY);
            }
          }}
          onPointerUp={resetJoystick}
          onPointerCancel={resetJoystick}
          onLostPointerCapture={resetJoystick}
        >
          <span className="joystick-direction is-up" aria-hidden="true">⌃</span>
          <span className="joystick-direction is-right" aria-hidden="true">›</span>
          <span className="joystick-direction is-down" aria-hidden="true">⌄</span>
          <span className="joystick-direction is-left" aria-hidden="true">‹</span>
          <div ref={joystickThumbRef} className="joystick-thumb">
            <span aria-hidden="true" />
          </div>
        </div>

        <button
          type="button"
          className={`action-button action-${actionMode}`}
          disabled={
            actionMode === "none" ||
            connectionState === "replaced" ||
            connectionState === "incompatible"
          }
          onClick={() => performActionRef.current()}
          aria-label={
            actionMode === "pickup"
              ? "Pick up stone"
              : actionMode === "throw"
                ? "Throw stone"
                : "Move closer to a stone"
          }
        >
          <span className="action-icon" aria-hidden="true">
            <span className="action-stone">
              <StoneIcon />
            </span>
            {actionMode === "throw" ? <span className="throw-mark">↗</span> : null}
          </span>
          <span className="action-label">
            {actionMode === "pickup" ? "Pick up" : actionMode === "throw" ? "Throw" : "Find one"}
          </span>
        </button>
      </div>

      <p className="desktop-help">WASD to walk · Space to act</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </p>
    </main>
  );
}
