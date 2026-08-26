"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import * as THREE from "three";
import {
  CARRY_SPEED,
  clampPositionOutsidePit,
  FIELD_RADIUS,
  FIELD_STONE_COUNT,
  getForwardStonePosition,
  getStoneDescriptor,
  PIT_CAPACITY,
  PIT_RADIUS,
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
  type RemoteStoneRelease,
} from "./remote-avatar-renderer";
import { createProceduralAvatar, type RiggedAvatarRuntime } from "./avatar";
import { createAvatarAppearance } from "./avatar-design";
import { WAITLANDER_RUNTIME_MANIFEST } from "./avatar/waitlander-manifest";
import {
  bakeSinglePrimitiveEnvironmentGeometry,
  clearEnvironmentAssetCache,
  environmentAssetCacheKey,
  loadEnvironmentAsset,
  type EnvironmentAssetLease,
} from "./environment/environment-asset-runtime";
import {
  WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST,
  WAITLAND_PIT_ASSET_MANIFEST,
} from "./environment/environment-manifest";
import {
  createPitFloorGeometry,
  createPitLipGeometry,
  createPitTurfGeometry,
  createPitWallGeometry,
} from "./pit-geometry";
import { CompassIcon, PeopleIcon, SendIcon, StoneIcon } from "./ui-icons";
import {
  attachEnvironmentMaterialTextures,
  createStorybookWorld,
  ENVIRONMENT_TEXTURE_PATHS,
} from "./world-art";

const CAPACITY = PIT_CAPACITY;
const STORAGE_KEY = "waiting-pit-stones-v1";
const REMOTE_SPEECH_TTL_MS = 7_000;
const STONE_RENDER_DISTANCE_SQUARED = 25 * 25;
const AUTHORED_PIT_CONTENT_LIFT = 0.05;
const PIT_BASE_STONE_COUNT = 84;

type ActionMode = "none" | "pickup" | "throw";
type StoneMaterial = THREE.Material | THREE.Material[];

const AUTHORED_STONE_TINTS = [0xa9c0c1, 0x91aaa7, 0xb0b5aa, 0x899b9a] as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cloneAuthoredStoneMaterials(
  source: THREE.Material | readonly THREE.Material[],
): StoneMaterial[] {
  const isMultiMaterial = Array.isArray(source);
  const sourceMaterials: readonly THREE.Material[] = isMultiMaterial
    ? source
    : [source as THREE.Material];
  return AUTHORED_STONE_TINTS.map((tint) => {
    const variants = sourceMaterials.map((material) => {
      const variant = material.clone();
      if (variant instanceof THREE.MeshStandardMaterial) {
        // Meshy's PBR maps carry the stone detail. A light, deterministic base
        // tint creates variety without multiplying the texture down to black.
        variant.color.setHex(tint);
        variant.roughness = Math.max(0.78, variant.roughness);
        variant.metalness = Math.min(0.08, variant.metalness);
      }
      variant.needsUpdate = true;
      return variant;
    });
    return isMultiMaterial ? variants : variants[0];
  });
}

function applyAuthoredPitSurface(
  source: THREE.Material | readonly THREE.Material[],
  targets: readonly {
    material: THREE.MeshStandardMaterial;
    tint: THREE.ColorRepresentation;
  }[],
) {
  const sourceMaterials: readonly THREE.Material[] = Array.isArray(source)
    ? source
    : [source as THREE.Material];
  const authored = sourceMaterials.find(
    (material): material is THREE.MeshStandardMaterial =>
      material instanceof THREE.MeshStandardMaterial,
  );
  if (!authored) return false;

  for (const target of targets) {
    // Meshy supplies the physical response while the purpose-built tileable
    // earth image keeps the procedural excavation's UVs visually coherent.
    // A generated atlas is not stretched around the whole gameplay-owned rim.
    if (authored.normalMap) target.material.normalMap = authored.normalMap;
    target.material.roughnessMap = authored.roughnessMap;
    target.material.metalnessMap = authored.metalnessMap;
    target.material.aoMap = authored.aoMap;
    target.material.normalScale.copy(authored.normalScale);
    target.material.color.set(target.tint);
    target.material.roughness = Math.max(0.88, authored.roughness);
    target.material.metalness = Math.min(0.04, authored.metalness);
    target.material.needsUpdate = true;
  }
  return true;
}

function disposeStoneMaterials(materials: readonly StoneMaterial[]) {
  const unique = new Set<THREE.Material>();
  for (const material of materials) {
    if (Array.isArray(material)) material.forEach((entry) => unique.add(entry));
    else unique.add(material);
  }
  unique.forEach((material) => material.dispose());
}

function randomPitLanding() {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * (PIT_RADIUS - 0.48);
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    -0.56,
    Math.sin(angle) * radius,
  );
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
    scene.fog = new THREE.Fog(0xd9b77d, 52, 132);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 160);
    camera.position.set(0, 11.6, 36);

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
      renderer.toneMappingExposure = 0.95;
      renderer.domElement.className = "world-canvas";
      renderer.domElement.setAttribute(
        "aria-label",
        "A peaceful 3D meadow with an irregular pit and scattered stones",
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

    scene.add(new THREE.HemisphereLight(0xffe6c4, 0x6e5b3d, 1));
    const sun = new THREE.DirectionalLight(0xffc77e, 3.2);
    sun.position.set(-22, 30, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 2;
    scene.add(sun);

    const storybookWorld = createStorybookWorld(scene);
    const authoredAssetController = new AbortController();
    let authoredPitLease: EnvironmentAssetLease | null = null;
    let authoredPitCacheKey = environmentAssetCacheKey(WAITLAND_PIT_ASSET_MANIFEST);
    let authoredStoneLease: EnvironmentAssetLease | null = null;
    let authoredStoneCacheKey = environmentAssetCacheKey(
      WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST,
    );
    let authoredStoneGeometry: THREE.BufferGeometry | null = null;
    let authoredStoneMaterials: StoneMaterial[] | null = null;

    const pitGroup = new THREE.Group();
    pitGroup.name = "waitland-pit";
    scene.add(pitGroup);
    const pitContentsGroup = new THREE.Group();
    pitContentsGroup.name = "waitland-pit-recessed-contents";
    pitGroup.add(pitContentsGroup);

    const pitFloorMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b392c,
      roughness: 1,
      metalness: 0,
    });
    const pitFloorGeometry = createPitFloorGeometry();
    const pitFloor = new THREE.Mesh(pitFloorGeometry, pitFloorMaterial);
    pitFloor.receiveShadow = true;
    pitContentsGroup.add(pitFloor);

    const pitWallMaterial = new THREE.MeshStandardMaterial({
      color: 0x654735,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const pitWallGeometry = createPitWallGeometry();
    const pitWall = new THREE.Mesh(pitWallGeometry, pitWallMaterial);
    pitWall.castShadow = true;
    pitWall.receiveShadow = true;
    pitGroup.add(pitWall);

    const pitLipMaterial = new THREE.MeshStandardMaterial({
      color: 0x8e6845,
      roughness: 1,
      metalness: 0,
    });
    const pitLipGeometry = createPitLipGeometry();
    const pitLip = new THREE.Mesh(pitLipGeometry, pitLipMaterial);
    pitLip.castShadow = true;
    pitLip.receiveShadow = true;
    pitGroup.add(pitLip);

    const pitTurfMaterial = new THREE.MeshStandardMaterial({
      color: 0xd7d8ad,
      roughness: 1,
      metalness: 0,
    });
    const pitTurfGeometry = createPitTurfGeometry();
    const pitTurf = new THREE.Mesh(pitTurfGeometry, pitTurfMaterial);
    pitTurf.castShadow = true;
    pitTurf.receiveShadow = true;
    pitGroup.add(pitTurf);

    const pitClodGeometry = new THREE.DodecahedronGeometry(0.4, 0);
    const pitClods = new THREE.InstancedMesh(pitClodGeometry, pitLipMaterial, 8);
    const pitClodTransform = new THREE.Object3D();
    for (let index = 0; index < pitClods.count; index += 1) {
      const angle = (index / pitClods.count) * Math.PI * 2 + Math.sin(index * 2.3) * 0.08;
      const radius = PIT_RADIUS + 0.46 + Math.sin(index * 4.17) * 0.2;
      pitClodTransform.position.set(
        Math.cos(angle) * radius * 1.035,
        -0.035 + (index % 3) * 0.012,
        Math.sin(angle) * radius,
      );
      // Keep torn sod clods flush with the ground. Tilting a strongly flattened
      // dodecahedron creates black needle silhouettes at phone scale.
      pitClodTransform.rotation.set(0, -angle, 0);
      pitClodTransform.scale.set(
        0.72 + (index % 4) * 0.09,
        0.12 + (index % 3) * 0.035,
        0.86 + (index % 5) * 0.07,
      );
      pitClodTransform.updateMatrix();
      pitClods.setMatrixAt(index, pitClodTransform.matrix);
    }
    pitClods.instanceMatrix.needsUpdate = true;
    pitClods.receiveShadow = true;
    pitGroup.add(pitClods);

    const pitTextureBinding = attachEnvironmentMaterialTextures(
      [
        { material: pitFloorMaterial, texturedColor: 0x745d49 },
        { material: pitWallMaterial, texturedColor: 0x8f755d },
        { material: pitLipMaterial, texturedColor: 0xb49a76 },
      ],
      ENVIRONMENT_TEXTURE_PATHS.pit,
      { repeat: 3, normalScale: 0.38 },
    );
    const pitTurfTextureBinding = attachEnvironmentMaterialTextures(
      [{ material: pitTurfMaterial, texturedColor: 0xe4e3bd }],
      ENVIRONMENT_TEXTURE_PATHS.grass,
      { repeat: 3, normalScale: 0.2 },
    );

    gameMount.dataset.pitRenderer = "procedural-fallback";
    void (async () => {
      const result = await loadEnvironmentAsset(WAITLAND_PIT_ASSET_MANIFEST, {
        signal: authoredAssetController.signal,
      });
      if (!result.ok) return;
      if (disposed) {
        result.asset.dispose();
        clearEnvironmentAssetCache(result.cacheKey);
        return;
      }
      try {
        const sourceMaterial = result.asset.template.primitives[0]?.material;
        if (
          !sourceMaterial ||
          !applyAuthoredPitSurface(sourceMaterial, [
            { material: pitWallMaterial, tint: 0x9a826a },
            { material: pitLipMaterial, tint: 0xbca781 },
          ])
        ) {
          throw new Error("The authored pit has no reusable PBR surface material.");
        }
        authoredPitLease = result.asset;
        authoredPitCacheKey = result.cacheKey;
        pitContentsGroup.position.y = AUTHORED_PIT_CONTENT_LIFT;
        // The irregular opening and collision remain code-owned while Meshy's
        // PBR surface supplies the authored earth detail. This avoids turning
        // an excavation into the raised bowl silhouette common to image-to-3D.
        gameMount.dataset.pitRenderer = "meshy";
      } catch {
        // The dark recessed floor and complete procedural excavation remain
        // visible if the authored file is malformed or cannot be mounted.
        result.asset.dispose();
        clearEnvironmentAssetCache(result.cacheKey);
      }
    })();

    const stoneGeometry = new THREE.DodecahedronGeometry(0.38, 0);
    const stoneMaterials: StoneMaterial[] = [
      new THREE.MeshStandardMaterial({ color: 0x8c8b82, roughness: 0.94 }),
      new THREE.MeshStandardMaterial({ color: 0x747873, roughness: 0.96 }),
      new THREE.MeshStandardMaterial({ color: 0xa0927e, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0x676b69, roughness: 0.98 }),
    ];
    let activeStoneGeometry: THREE.BufferGeometry = stoneGeometry;
    let activeStoneMaterials = stoneMaterials;

    const stoneBedGeometry = new THREE.IcosahedronGeometry(0.42, 1);
    const stoneBedMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.98,
      metalness: 0,
    });
    const stoneBedColors = [
      new THREE.Color(0x5d5a52),
      new THREE.Color(0x6c6357),
      new THREE.Color(0x52544f),
      new THREE.Color(0x756a59),
      new THREE.Color(0x625b50),
    ];
    const embeddedGravel = new THREE.InstancedMesh(
      stoneBedGeometry,
      stoneBedMaterial,
      PIT_BASE_STONE_COUNT,
    );
    const gravelTransform = new THREE.Object3D();
    for (let index = 0; index < embeddedGravel.count; index += 1) {
      const angle = index * 2.399963229728653;
      const radius = 0.3 + Math.sqrt(((index * 37) % 101) / 101) * (PIT_RADIUS - 0.72);
      const scale = 0.72 + ((index * 19) % 9) * 0.026;
      gravelTransform.position.set(
        Math.cos(angle) * radius,
        -0.66 + (index % 4) * 0.032,
        Math.sin(angle) * radius,
      );
      gravelTransform.rotation.set(angle * 0.31, angle, angle * 0.17);
      gravelTransform.scale.set(scale * 1.14, scale * 0.56, scale);
      gravelTransform.updateMatrix();
      embeddedGravel.setMatrixAt(index, gravelTransform.matrix);
      embeddedGravel.setColorAt(index, stoneBedColors[index % stoneBedColors.length]);
    }
    embeddedGravel.instanceMatrix.needsUpdate = true;
    if (embeddedGravel.instanceColor) embeddedGravel.instanceColor.needsUpdate = true;
    embeddedGravel.receiveShadow = true;
    pitContentsGroup.add(embeddedGravel);

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
        activeStoneGeometry,
        activeStoneMaterials[descriptor.material],
      );
      shapeStone(stone, index, generation);
      stone.userData.available = true;
      stone.userData.stoneId = descriptor.id;
      stone.userData.generation = generation;
      stone.userData.stoneIndex = index;
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

    const pitPileMeshes: THREE.InstancedMesh<THREE.BufferGeometry, StoneMaterial>[] =
      stoneMaterials.map((material) => {
      const mesh = new THREE.InstancedMesh(activeStoneGeometry, material, 180);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      pitContentsGroup.add(mesh);
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
          Math.sqrt(Math.abs(descriptor.x) / FIELD_RADIUS) *
          (PIT_RADIUS - 0.46 - normalized * 0.24);
        const angle = descriptor.rotationY * Math.PI;
        const lift = Math.max(0, (nextCount / CAPACITY) * 2.25 - radius * 0.18);
        pitPileTransform.position.set(
          Math.cos(angle) * radius,
          -0.55 + lift,
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

    gameMount.dataset.stoneRenderer = "procedural-fallback";
    void (async () => {
      const result = await loadEnvironmentAsset(WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST, {
        signal: authoredAssetController.signal,
      });
      if (!result.ok) return;
      let geometry: THREE.BufferGeometry | null = null;
      let materials: StoneMaterial[] | null = null;
      try {
        geometry = bakeSinglePrimitiveEnvironmentGeometry(result.asset.template);
        materials = cloneAuthoredStoneMaterials(result.asset.template.primitives[0].material);
      } catch {
        geometry?.dispose();
        if (materials) disposeStoneMaterials(materials);
        result.asset.dispose();
        clearEnvironmentAssetCache(result.cacheKey);
        return;
      }
      if (disposed) {
        geometry.dispose();
        disposeStoneMaterials(materials);
        result.asset.dispose();
        clearEnvironmentAssetCache(result.cacheKey);
        return;
      }

      authoredStoneLease = result.asset;
      authoredStoneCacheKey = result.cacheKey;
      authoredStoneGeometry = geometry;
      authoredStoneMaterials = materials;
      activeStoneGeometry = geometry;
      activeStoneMaterials = materials;

      for (const rock of rocks) {
        const stoneIndex = Math.max(0, Math.trunc(Number(rock.userData.stoneIndex) || 0));
        const generation = Math.max(0, Math.trunc(Number(rock.userData.generation) || 0));
        const descriptor = getStoneDescriptor(stoneIndex, generation);
        rock.geometry = geometry;
        rock.material = materials[descriptor.material];
      }
      for (let index = 0; index < pitPileMeshes.length; index += 1) {
        pitPileMeshes[index].geometry = geometry;
        pitPileMeshes[index].material = materials[index];
      }
      gameMount.dataset.stoneRenderer = "meshy";
    })();

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
    let pickupAnimating = false;
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
          forwardEnd: THREE.Vector3;
          awaitingAuthority: boolean;
          released: boolean;
          releaseElapsed: number;
          releaseTimeout: number;
        }
      | undefined;
    const remoteThrows = new Map<
      string,
      {
        stone: THREE.Mesh;
        start: THREE.Vector3;
        end: THREE.Vector3;
        elapsed: number;
        duration: number;
        landsInPit: boolean;
        finalState: RealtimeStone;
      }
    >();

    const worldUp = new THREE.Vector3(0, 1, 0);
    const cameraForward = new THREE.Vector3(0, 0, -1);
    const cameraRight = new THREE.Vector3(1, 0, 0);
    const desiredCameraPosition = new THREE.Vector3();
    const cameraLookTarget = new THREE.Vector3();
    const speechAnchor = new THREE.Vector3();
    const heldRockAnchorPosition = new THREE.Vector3();
    const heldRockAnchorQuaternion = new THREE.Quaternion();
    const sceneWorldQuaternion = new THREE.Quaternion();
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
    const deferredRemoteStoneStates = new Map<string, RealtimeStone>();
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
      const city = remoteProfile?.city?.trim();
      const nextName = `${remoteProfile?.name ?? "Someone"}${city ? ` · ${city}` : ""}${remoteFlag ? ` ${remoteFlag}` : ""}`;
      const nextDetail = anchor.departing
        ? "Heading back to real life"
        : `Waiting for ${remoteProfile?.waitingFor ?? "something"}`;
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

    function beginRemoteThrow(
      stone: THREE.Mesh,
      stoneState: RealtimeStone,
      previousGeneration: number,
      release?: RemoteStoneRelease,
    ) {
      const finalState = deferredRemoteStoneStates.get(stoneState.id) ?? stoneState;
      deferredRemoteStoneStates.delete(stoneState.id);
      if (!release) {
        applyStoneState(finalState, { skipRemoteRelease: true });
        return;
      }

      scene.updateWorldMatrix(true, false);
      scene.attach(stone);
      stone.position.copy(scene.worldToLocal(release.position.clone()));
      scene.getWorldQuaternion(sceneWorldQuaternion).invert();
      stone.quaternion.copy(sceneWorldQuaternion).multiply(release.quaternion);
      stone.visible = true;
      stone.userData.available = false;

      const nextGeneration = Math.max(0, Math.trunc(finalState.generation ?? previousGeneration));
      const landsInPit = nextGeneration > previousGeneration;
      remoteThrows.set(stoneState.id, {
        stone,
        start: stone.position.clone(),
        end: landsInPit
          ? randomPitLanding()
          : new THREE.Vector3(finalState.x, 0.3, finalState.z),
        elapsed: 0,
        duration: landsInPit ? 0.72 : 0.65,
        landsInPit,
        finalState,
      });
    }

    function applyStoneState(
      stoneState: RealtimeStone,
      options: { skipRemoteRelease?: boolean } = {},
    ) {
      const stone = rocks.find((candidate) => candidate.userData.stoneId === stoneState.id);
      if (!stone) return;
      if (remoteThrows.has(stoneState.id) && !options.skipRemoteRelease) {
        deferredRemoteStoneStates.set(stoneState.id, stoneState);
        return;
      }
      const previousHolderId =
        typeof stone.userData.authoritativeHolderId === "string"
          ? stone.userData.authoritativeHolderId
          : null;
      const previousGeneration = Math.max(0, Math.trunc(Number(stone.userData.generation) || 0));
      stone.userData.authoritativeHolderId = stoneState.holderId;
      if (stone === heldRock || stone === activeThrow?.stone) {
        deferredStoneStates.set(stoneState.id, stoneState);
        return;
      }
      if (
        !options.skipRemoteRelease &&
        !stoneState.holderId &&
        previousHolderId &&
        previousHolderId !== selfId &&
        remoteRenderer.deferStoneRelease(previousHolderId, (release) =>
          beginRemoteThrow(stone, stoneState, previousGeneration, release),
        )
      ) {
        deferredRemoteStoneStates.set(stoneState.id, stoneState);
        stone.userData.available = false;
        stone.visible = false;
        return;
      }
      deferredStoneStates.delete(stoneState.id);
      deferredRemoteStoneStates.delete(stoneState.id);
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
        stone.material = activeStoneMaterials[descriptor.material];
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
      deferredRemoteStoneStates.clear();
      remoteThrows.clear();
      pickupPending = false;
      pickupAnimating = false;
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
        (result.ok || result.reason === "pit-unavailable") &&
        activeThrow?.stone === pending.stone
      ) {
        const throwAnimation = activeThrow;
        const animationHadFinished =
          throwAnimation.released && throwAnimation.elapsed >= throwAnimation.duration;
        const priorEnd = throwAnimation.end.clone();
        if (result.deposited === true) {
          throwAnimation.landsInPit = true;
          throwAnimation.end.copy(randomPitLanding());
        } else {
          throwAnimation.landsInPit = false;
          const authoritative = deferredStoneStates.get(
            String(pending.stone.userData.stoneId ?? ""),
          );
          throwAnimation.end.copy(
            authoritative && !authoritative.holderId
              ? new THREE.Vector3(authoritative.x, 0.3, authoritative.z)
              : throwAnimation.forwardEnd,
          );
        }
        throwAnimation.awaitingAuthority = false;
        // If durable persistence delayed the acknowledgement beyond the first
        // arc, animate a short correction instead of teleporting to its target.
        if (animationHadFinished && priorEnd.distanceTo(throwAnimation.end) > 0.05) {
          throwAnimation.start.copy(throwAnimation.stone.position);
          throwAnimation.elapsed = 0;
          throwAnimation.duration = 0.28;
        }
      }
      if (!pending) return;
      if (result.ok) {
        if (pending.kind === "pickup" && heldRock === pending.stone) {
          if (!pickupAnimating) setMode("throw");
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

    function releaseActiveThrow(stone: THREE.Mesh) {
      const throwAnimation = activeThrow;
      if (!throwAnimation || throwAnimation.stone !== stone || throwAnimation.released) return;

      const heldItemAnchor = riggedAvatar?.anchors.heldItem ?? localAvatar.anchors.heldItem;
      player.updateMatrixWorld(true);
      heldItemAnchor.getWorldPosition(heldRockAnchorPosition);
      heldItemAnchor.getWorldQuaternion(heldRockAnchorQuaternion);
      scene.updateWorldMatrix(true, false);
      scene.attach(stone);
      stone.position.copy(scene.worldToLocal(heldRockAnchorPosition));
      scene.getWorldQuaternion(sceneWorldQuaternion).invert();
      stone.quaternion.copy(sceneWorldQuaternion).multiply(heldRockAnchorQuaternion);

      throwAnimation.start.copy(stone.position);
      throwAnimation.elapsed = 0;
      throwAnimation.released = true;
      if (heldRock === stone) heldRock = null;
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
      if (disposed || isThrowing || pickupAnimating) return;
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
        pickupAnimating =
          riggedAvatar?.playInteraction({
            kind: "pickup",
            restart: true,
            onComplete: () => {
              pickupAnimating = false;
              if (heldRock && !pickupPending && !isThrowing) setMode("throw");
            },
          }) ?? false;
        if (actionId) {
          pickupPending = true;
          pendingActions.set(actionId, {
            kind: "pickup",
            stone: heldRock,
            originalPosition,
          });
        }
        setMode(pickupPending || pickupAnimating ? "none" : "throw");
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
      isThrowing = true;
      const distance = Math.hypot(player.position.x, player.position.z);
      const closeEnoughToPit = distance <= PIT_THROW_RADIUS;
      const forwardLanding = getForwardStonePosition(
        player.position.x,
        player.position.z,
        player.rotation.y,
      );
      const forwardEnd = new THREE.Vector3(forwardLanding.x, 0.3, forwardLanding.z);
      const end = closeEnoughToPit
        ? randomPitLanding()
        : forwardEnd.clone();

      activeThrow = {
        stone,
        start: new THREE.Vector3(),
        end,
        elapsed: 0,
        duration: closeEnoughToPit ? 0.72 : 0.62,
        landsInPit: closeEnoughToPit,
        forwardEnd,
        awaitingAuthority: Boolean(actionId),
        released: false,
        releaseElapsed: 0,
        releaseTimeout: 0.2,
      };
      const throwPlayed =
        riggedAvatar?.playInteraction({
          kind: "throw",
          restart: true,
          onRelease: () => releaseActiveThrow(stone),
          onComplete: () => releaseActiveThrow(stone),
        }) ?? false;
      activeThrow.releaseTimeout = throwPlayed ? 0.95 : 0.2;
      if (actionId) {
        pendingActions.set(actionId, {
          kind: "throw",
          stone,
          originalPosition: stone.position.clone(),
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
      const inputLength = isThrowing || pickupAnimating ? 0 : Math.hypot(inputX, inputY);

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
        const safePosition = clampPositionOutsidePit(nextX, nextZ);
        player.position.x = safePosition.x;
        player.position.z = safePosition.z;

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
      for (const rock of rocks) {
        if (!rock.userData.available || rock.parent !== scene) continue;
        const deltaX = rock.position.x - player.position.x;
        const deltaZ = rock.position.z - player.position.z;
        rock.visible = deltaX * deltaX + deltaZ * deltaZ <= STONE_RENDER_DISTANCE_SQUARED;
      }

      if (multiplayerBlockReason || isThrowing || pickupAnimating) setMode("none");
      else if (heldRock && !pickupPending) setMode("throw");
      else if (heldRock) setMode("none");
      else if (nearestRock && nearestDistance <= 1.85) setMode("pickup");
      else setMode("none");
      if (nearestDistance > 1.85 && !heldRock) nearestRock = null;

      if (activeThrow) {
        if (!activeThrow.released) {
          activeThrow.releaseElapsed += dt;
          if (activeThrow.releaseElapsed >= activeThrow.releaseTimeout) {
            releaseActiveThrow(activeThrow.stone);
          }
        }
      }

      if (activeThrow?.released) {
        activeThrow.elapsed += dt;
        const t = clamp(activeThrow.elapsed / activeThrow.duration, 0, 1);
        activeThrow.stone.position.lerpVectors(activeThrow.start, activeThrow.end, t);
        activeThrow.stone.position.y += Math.sin(t * Math.PI) * (activeThrow.landsInPit ? 3.5 : 2.3);
        activeThrow.stone.rotation.x += dt * 8;
        activeThrow.stone.rotation.z += dt * 5;

        const authorityWaitExpired = activeThrow.elapsed >= 2.5;
        if (t >= 1 && (!activeThrow.awaitingAuthority || authorityWaitExpired)) {
          const wasAwaitingAuthority = activeThrow.awaitingAuthority;
          const completedStone = activeThrow.stone;
          completedStone.position.copy(activeThrow.end);
          if (activeThrow.landsInPit) addStoneToPit(completedStone);
          else completedStone.userData.available = !wasAwaitingAuthority;
          activeThrow = undefined;
          isThrowing = false;
          const deferred = deferredStoneStates.get(
            String(completedStone.userData.stoneId ?? ""),
          );
          if (deferred) applyStoneState(deferred);
        }
      }

      for (const [stoneId, throwAnimation] of remoteThrows) {
        throwAnimation.elapsed += dt;
        const t = clamp(throwAnimation.elapsed / throwAnimation.duration, 0, 1);
        throwAnimation.stone.position.lerpVectors(throwAnimation.start, throwAnimation.end, t);
        throwAnimation.stone.position.y +=
          Math.sin(t * Math.PI) * (throwAnimation.landsInPit ? 3.5 : 2.3);
        throwAnimation.stone.rotation.x += dt * 8;
        throwAnimation.stone.rotation.z += dt * 5;
        if (t < 1) continue;

        const finalState = deferredRemoteStoneStates.get(stoneId) ?? throwAnimation.finalState;
        remoteThrows.delete(stoneId);
        deferredRemoteStoneStates.delete(stoneId);
        applyStoneState(finalState, { skipRemoteRelease: true });
      }

      const pitDistance = Math.max(
        0,
        Math.round(Math.hypot(player.position.x, player.position.z) - PIT_WALL_RADIUS),
      );
      if (pitDistance !== lastDistanceLabel) {
        lastDistanceLabel = pitDistance;
        setDistanceToPit(pitDistance);
      }

      const distanceFromPit = Math.max(0.001, Math.hypot(player.position.x, player.position.z));
      const outwardX = player.position.x / distanceFromPit;
      const outwardZ = player.position.z / distanceFromPit;
      desiredCameraPosition.set(
        player.position.x + outwardX * 18.2,
        player.position.y + 11.6,
        player.position.z + outwardZ * 18.2,
      );
      camera.position.lerp(desiredCameraPosition, 1 - Math.pow(0.001, dt));
      // Keep the pit and path in the composition while placing the hero in the
      // lower third. Movement is mapped through this camera yaw above, so the
      // joystick remains screen-relative as the view orbits the objective.
      const lookAhead = Math.min(distanceFromPit * 0.5, 12);
      cameraLookTarget.set(
        player.position.x - outwardX * lookAhead,
        1.15,
        player.position.z - outwardZ * lookAhead,
      );
      camera.lookAt(cameraLookTarget);
      camera.updateMatrixWorld();
      storybookWorld.update(clock.elapsedTime, player.position.x, player.position.z);

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
      authoredAssetController.abort();
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
      authoredPitLease?.dispose();
      authoredStoneGeometry?.dispose();
      if (authoredStoneMaterials) disposeStoneMaterials(authoredStoneMaterials);
      authoredStoneLease?.dispose();
      clearEnvironmentAssetCache(authoredPitCacheKey);
      clearEnvironmentAssetCache(authoredStoneCacheKey);
      pitTextureBinding.dispose();
      pitTurfTextureBinding.dispose();
      embeddedGravel.dispose();
      stoneBedGeometry.dispose();
      stoneBedMaterial.dispose();
      pitClods.dispose();
      pitPileMeshes.forEach((mesh) => mesh.dispose());
      stoneGeometry.dispose();
      disposeStoneMaterials(stoneMaterials);
      pitFloorGeometry.dispose();
      pitFloorMaterial.dispose();
      pitWallGeometry.dispose();
      pitWallMaterial.dispose();
      pitLipGeometry.dispose();
      pitClodGeometry.dispose();
      pitLipMaterial.dispose();
      pitTurfGeometry.dispose();
      pitTurfMaterial.dispose();
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
          <span className="sr-only">Waiting for {profile.reasonText}</span>
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

      <div
        className={`pit-direction ${distanceToPit <= 32 ? "is-hidden" : ""}`}
        aria-label={`The pit is ${distanceToPit} metres away`}
      >
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
          <span className="sr-only">
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
