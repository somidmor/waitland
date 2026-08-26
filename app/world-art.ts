import * as THREE from "three";
import type {
  EnvironmentAssetLease,
  EnvironmentInstancedPool,
} from "./environment/environment-asset-runtime.ts";
import { loadEnvironmentAsset } from "./environment/environment-asset-runtime.ts";
import { WAITLAND_ENVIRONMENT_MANIFEST } from "./environment/environment-manifest.ts";
import {
  PIT_EDGE_SEGMENTS,
  PIT_LIP_OUTER_PHASE,
  PIT_LIP_OUTER_RADIUS,
  pitEdgeRadius,
} from "./pit-geometry.ts";

type Disposable = { dispose: () => void };

export const ENVIRONMENT_TEXTURE_PATHS = {
  grass: {
    baseColor: "/assets/environment/v1/meadow-grass-albedo.jpg",
    // Optional future linear channels: meadow-grass-normal.png and
    // meadow-grass-roughness.png. Keep null until those files are authored.
    normal: null,
    roughness: null,
  },
  pit: {
    baseColor: "/assets/environment/v1/pit-earth-albedo.jpg",
    // Optional future linear channels: pit-earth-normal.png and
    // pit-earth-roughness.png. Albedo must never be reused as either channel.
    normal: null,
    roughness: null,
  },
} as const;

type EnvironmentTexturePaths =
  (typeof ENVIRONMENT_TEXTURE_PATHS)[keyof typeof ENVIRONMENT_TEXTURE_PATHS];

export type EnvironmentMaterialTarget = {
  material: THREE.MeshStandardMaterial;
  texturedColor?: THREE.ColorRepresentation;
};

export type EnvironmentTextureBinding = Disposable;

/**
 * Adds an optional tileable material set without weakening the solid-colour
 * fallback. Available channels are shared by every target, loaded only in a
 * browser, and applied together so a missing file never produces a black mesh.
 */
export function attachEnvironmentMaterialTextures(
  targets: readonly EnvironmentMaterialTarget[],
  paths: EnvironmentTexturePaths,
  options: { repeat: number; normalScale: number },
): EnvironmentTextureBinding {
  let disposed = false;
  const textures = new Set<THREE.Texture>();

  if (typeof document === "undefined") {
    return { dispose: () => undefined };
  }

  const loader = new THREE.TextureLoader();
  const load = async (path: string, colorSpace: THREE.ColorSpace) => {
    try {
      const texture = await loader.loadAsync(path);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.setScalar(options.repeat);
      texture.colorSpace = colorSpace;
      texture.anisotropy = 2;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return texture;
    } catch {
      return null;
    }
  };
  const loadOptional = (path: string | null, colorSpace: THREE.ColorSpace) =>
    path ? load(path, colorSpace) : Promise.resolve(null);

  void Promise.all([
    load(paths.baseColor, THREE.SRGBColorSpace),
    loadOptional(paths.normal, THREE.NoColorSpace),
    loadOptional(paths.roughness, THREE.NoColorSpace),
  ]).then(([baseColor, normal, roughness]) => {
    const loaded = [baseColor, normal, roughness].filter(
      (texture): texture is THREE.Texture => texture !== null,
    );
    if (disposed) {
      loaded.forEach((texture) => texture.dispose());
      return;
    }

    loaded.forEach((texture) => textures.add(texture));
    for (const target of targets) {
      if (baseColor) {
        target.material.map = baseColor;
        if (target.texturedColor !== undefined) {
          target.material.color.set(target.texturedColor);
        }
      }
      if (normal) {
        target.material.normalMap = normal;
        target.material.normalScale.setScalar(options.normalScale);
      }
      if (roughness) target.material.roughnessMap = roughness;
      if (loaded.length > 0) target.material.needsUpdate = true;
    }
  });

  return {
    dispose() {
      disposed = true;
      textures.forEach((texture) => texture.dispose());
      textures.clear();
    },
  };
}

export type StorybookWorld = {
  /**
   * Player coordinates are optional for the first frame, but callers should
   * pass them every frame so the bounded scenery pool follows long journeys.
   */
  update: (elapsedSeconds: number, playerX?: number, playerZ?: number) => void;
  dispose: () => void;
};

function seededRandom(seed = 0x57414954) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function setInstance(
  mesh: THREE.InstancedMesh,
  index: number,
  object: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  rotationY = 0,
) {
  object.position.set(x, y, z);
  object.scale.set(scaleX, scaleY, scaleZ);
  object.rotation.set(0, rotationY, 0);
  object.updateMatrix();
  mesh.setMatrixAt(index, object.matrix);
}

function makePathRibbonGeometry(
  curve: THREE.CatmullRomCurve3,
  widths: readonly number[],
  widthScale: number,
  y: number,
  includeColor: boolean,
) {
  const segments = 64;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const warmSoil = new THREE.Color(0x9a845e);
  const wornSoil = new THREE.Color(0x85724f);
  const shade = new THREE.Color();

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    curve.getPointAt(t, point);
    curve.getTangentAt(t, tangent);
    normal.set(-tangent.z, 0, tangent.x).normalize();

    const widthPosition = t * (widths.length - 1);
    const widthIndex = Math.min(widths.length - 2, Math.floor(widthPosition));
    const width = THREE.MathUtils.lerp(
      widths[widthIndex],
      widths[widthIndex + 1],
      widthPosition - widthIndex,
    );
    const leftWidth = width * widthScale * (1 + Math.sin(index * 1.71) * 0.055);
    const rightWidth = width * widthScale * (1 + Math.cos(index * 1.37) * 0.05);
    const ripple = Math.sin(index * 0.83) * 0.002;

    positions.push(
      point.x + normal.x * leftWidth,
      y + ripple,
      point.z + normal.z * leftWidth,
      point.x - normal.x * rightWidth,
      y - ripple,
      point.z - normal.z * rightWidth,
    );

    if (includeColor) {
      shade.copy(warmSoil).lerp(wornSoil, 0.16 + (Math.sin(index * 0.91) + 1) * 0.11);
      colors.push(shade.r, shade.g, shade.b, shade.r, shade.g, shade.b);
    }

    if (index < segments) {
      const vertex = index * 2;
      indices.push(vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (includeColor) {
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function isNearPath(x: number, z: number, samples: readonly THREE.Vector3[], clearance: number) {
  const clearanceSquared = clearance * clearance;
  for (const sample of samples) {
    const dx = x - sample.x;
    const dz = z - sample.z;
    if (dx * dx + dz * dz < clearanceSquared) return true;
  }
  return false;
}

// Seven-by-seven chunks cover the full fog range, while all decoration remains
// a handful of bounded instanced draw calls. New rows are populated under fog
// as the player crosses a chunk boundary and old rows are recycled.
const WORLD_CHUNK_SIZE = 42;
const WORLD_CHUNK_RADIUS = 3;
const WORLD_CHUNK_DIAMETER = WORLD_CHUNK_RADIUS * 2 + 1;
const WORLD_CHUNK_COUNT = WORLD_CHUNK_DIAMETER * WORLD_CHUNK_DIAMETER;
const PIT_MEADOW_CLEARANCE = PIT_LIP_OUTER_RADIUS + 0.2;
const CENTRAL_PIT_OPENING_SCALE = 0.94;

const PATCHES_PER_CHUNK = 3;
const GRASS_MARKS_PER_CHUNK = 480;
const FLOWERS_PER_CHUNK = 22;
const TREES_PER_CHUNK = 1;
const BUSHES_PER_CHUNK = 2;
const ROCKS_PER_CHUNK = 2;

const AUTHORED_PATH_MODULES = 15;

type AuthoredEnvironmentKey = keyof typeof WAITLAND_ENVIRONMENT_MANIFEST.assets;

type InstalledEnvironmentAsset = {
  lease: EnvironmentAssetLease;
  pool: EnvironmentInstancedPool;
};

function mixSeed(value: number) {
  let next = value | 0;
  next = Math.imul(next ^ (next >>> 16), 0x21f0aaad);
  next = Math.imul(next ^ (next >>> 15), 0x735a2d97);
  return (next ^ (next >>> 15)) >>> 0;
}

function seedForChunk(chunkX: number, chunkZ: number, salt: number) {
  return mixSeed(
    Math.imul(chunkX | 0, 0x1f123bb5) ^
      Math.imul(chunkZ | 0, 0x5f356495) ^
      salt,
  );
}

function chunkAt(value: number) {
  return Math.floor((value + WORLD_CHUNK_SIZE / 2) / WORLD_CHUNK_SIZE);
}

export function createCentralMeadowGeometry() {
  const half = WORLD_CHUNK_SIZE / 2 + 0.06;
  const shape = new THREE.Shape();
  shape.moveTo(-half, -half);
  shape.lineTo(half, -half);
  shape.lineTo(half, half);
  shape.lineTo(-half, half);
  shape.closePath();

  const opening = new THREE.Path();
  opening.moveTo(
    pitEdgeRadius(0, PIT_LIP_OUTER_RADIUS, PIT_LIP_OUTER_PHASE) *
      1.035 *
      CENTRAL_PIT_OPENING_SCALE,
    0,
  );
  for (let index = 1; index <= PIT_EDGE_SEGMENTS; index += 1) {
    const wrapped = (PIT_EDGE_SEGMENTS - index) % PIT_EDGE_SEGMENTS;
    const angle = -(index / PIT_EDGE_SEGMENTS) * Math.PI * 2;
    const radius = pitEdgeRadius(
      wrapped,
      PIT_LIP_OUTER_RADIUS,
      PIT_LIP_OUTER_PHASE,
    );
    opening.lineTo(
      Math.cos(angle) * radius * 1.035 * CENTRAL_PIT_OPENING_SCALE,
      Math.sin(angle) * radius * CENTRAL_PIT_OPENING_SCALE,
    );
  }
  opening.closePath();
  shape.holes.push(opening);

  const geometry = new THREE.ShapeGeometry(shape, 48);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  const uvs = new Float32Array(positions.count * 2);
  for (let index = 0; index < positions.count; index += 1) {
    uvs[index * 2] = (positions.getX(index) + half) / (half * 2);
    uvs[index * 2 + 1] = (positions.getZ(index) + half) / (half * 2);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

type ChunkPoint = { x: number; z: number; visible: boolean };

/**
 * Adds a deterministic, visually unbounded miniature meadow. The central pit
 * and its subtle worn approach remain authored at world origin; everything
 * outside that landmark is streamed through a fixed-size instance pool.
 */
export function createStorybookWorld(scene: THREE.Scene): StorybookWorld {
  const root = new THREE.Group();
  root.name = "storybook-world";
  scene.add(root);

  const authoredRoot = new THREE.Group();
  authoredRoot.name = "authored-environment-v2";
  root.add(authoredRoot);
  const authoredAssets: Partial<
    Record<AuthoredEnvironmentKey, InstalledEnvironmentAsset>
  > = {};
  const environmentAbort = new AbortController();
  let worldDisposed = false;

  const disposable = new Set<Disposable>();
  const remember = <T extends Disposable>(value: T) => {
    disposable.add(value);
    return value;
  };
  const transform = new THREE.Object3D();

  const setAuthoredInstance = (
    pool: EnvironmentInstancedPool,
    index: number,
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotationY = 0,
  ) => {
    transform.position.set(x, y, z);
    transform.scale.set(scaleX, scaleY, scaleZ);
    transform.rotation.set(0, rotationY, 0);
    transform.updateMatrix();
    pool.setMatrixAt(index, transform.matrix);
  };

  const groundGeometry = remember(
    new THREE.PlaneGeometry(WORLD_CHUNK_SIZE + 0.12, WORLD_CHUNK_SIZE + 0.12),
  );
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x9b915d, roughness: 1, metalness: 0 }),
  );
  const groundTiles = new THREE.InstancedMesh(
    groundGeometry,
    groundMaterial,
    WORLD_CHUNK_COUNT,
  );
  groundTiles.name = "streamed-meadow-tiles";
  groundTiles.receiveShadow = true;
  groundTiles.frustumCulled = false;
  root.add(groundTiles);

  // The origin tile is a separate square-with-hole so the recessed pit stays
  // genuinely open instead of being hidden behind a large ground plane.
  const centralGroundGeometry = remember(createCentralMeadowGeometry());
  const centralGround = new THREE.Mesh(centralGroundGeometry, groundMaterial);
  centralGround.name = "central-pit-meadow";
  centralGround.position.y = -0.024;
  centralGround.receiveShadow = true;
  root.add(centralGround);

  remember(
    attachEnvironmentMaterialTextures(
      [{ material: groundMaterial, texturedColor: 0xe6e3c1 }],
      ENVIRONMENT_TEXTURE_PATHS.grass,
      { repeat: 14, normalScale: 0.24 },
    ),
  );

  // The reference trail is broad enough to read at phone scale, but its soft
  // edges and meadow detail keep it feeling walked-in rather than paved.
  const pathPoints = [
    new THREE.Vector3(-2.8, 0, 48),
    new THREE.Vector3(-1.7, 0, 35),
    new THREE.Vector3(0.2, 0, 22),
    new THREE.Vector3(2.5, 0, 12.2),
    new THREE.Vector3(6.3, 0, 6.3),
    new THREE.Vector3(7.05, 0, -0.4),
    new THREE.Vector3(5.7, 0, -7.8),
    new THREE.Vector3(2.1, 0, -17.2),
    new THREE.Vector3(0.2, 0, -28),
  ];
  const pathWidths = [1.42, 1.3, 1.16, 1.03, 0.96, 1, 1.1, 1.25, 1.42];
  const pathCurve = new THREE.CatmullRomCurve3(pathPoints, false, "centripetal");
  const pathSamples = Array.from({ length: 72 }, (_, index) =>
    pathCurve.getPointAt(index / 71),
  );

  const pathEdgeGeometry = remember(
    makePathRibbonGeometry(pathCurve, pathWidths, 1.22, 0.008, false),
  );
  const pathEdgeMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0x6f5b3d,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    }),
  );
  const pathEdge = new THREE.Mesh(pathEdgeGeometry, pathEdgeMaterial);
  pathEdge.receiveShadow = true;
  root.add(pathEdge);

  const pathGeometry = remember(
    makePathRibbonGeometry(pathCurve, pathWidths, 1, 0.013, true),
  );
  const pathMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  );
  const path = new THREE.Mesh(pathGeometry, pathMaterial);
  path.receiveShadow = true;
  root.add(path);

  const pathWidthAt = (t: number) => {
    const widthPosition = THREE.MathUtils.clamp(t, 0, 1) * (pathWidths.length - 1);
    const widthIndex = Math.min(pathWidths.length - 2, Math.floor(widthPosition));
    return THREE.MathUtils.lerp(
      pathWidths[widthIndex],
      pathWidths[widthIndex + 1],
      widthPosition - widthIndex,
    );
  };

  const populateAuthoredPath = (pool: EnvironmentInstancedPool) => {
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    for (let index = 0; index < AUTHORED_PATH_MODULES; index += 1) {
      const t = (index + 0.5) / AUTHORED_PATH_MODULES;
      pathCurve.getPointAt(t, point);
      pathCurve.getTangentAt(t, tangent);
      const widthScale = pathWidthAt(t) / 1.1;
      setAuthoredInstance(
        pool,
        index,
        point.x,
        -0.1,
        point.z,
        1.08,
        1,
        widthScale * 0.52,
        Math.atan2(-tangent.z, tangent.x),
      );
    }
    pool.commit(AUTHORED_PATH_MODULES);
  };

  const pointForChunk = (
    chunkX: number,
    chunkZ: number,
    random: () => number,
    pitClearance: number,
    pathClearance: number,
  ): ChunkPoint => {
    let x = chunkX * WORLD_CHUNK_SIZE;
    let z = chunkZ * WORLD_CHUNK_SIZE;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      x = (chunkX + random() - 0.5) * WORLD_CHUNK_SIZE;
      z = (chunkZ + random() - 0.5) * WORLD_CHUNK_SIZE;
      if (Math.hypot(x, z) < pitClearance) continue;
      if (
        pathClearance > 0 &&
        Math.abs(x) < 12 &&
        z > -32 &&
        z < 52 &&
        isNearPath(x, z, pathSamples, pathClearance)
      ) {
        continue;
      }
      return { x, z, visible: true };
    }
    return { x, z, visible: false };
  };

  const patchGeometry = remember(new THREE.CircleGeometry(1, 18));
  patchGeometry.rotateX(-Math.PI / 2);
  const patchMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const patches = new THREE.InstancedMesh(
    patchGeometry,
    patchMaterial,
    WORLD_CHUNK_COUNT * PATCHES_PER_CHUNK,
  );
  patches.frustumCulled = false;
  const patchColors = [
    new THREE.Color(0xa49f6a),
    new THREE.Color(0xb0a974),
    new THREE.Color(0xc2b682),
  ];
  root.add(patches);

  const grassGeometry = remember(
    new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [
            -0.05, 0, 0, 0.05, 0, 0, 0, 0.34, 0,
            0, 0, -0.05, 0, 0, 0.05, 0, 0.34, 0,
            -0.036, 0, -0.036, 0.036, 0, 0.036, 0, 0.3, 0,
          ],
          3,
        ),
      )
      .setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]),
  );
  grassGeometry.computeVertexNormals();
  const grassMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      alphaTest: 0.08,
      depthWrite: false,
    }),
  );
  const grass = new THREE.InstancedMesh(
    grassGeometry,
    grassMaterial,
    WORLD_CHUNK_COUNT * GRASS_MARKS_PER_CHUNK,
  );
  grass.frustumCulled = false;
  const grassColors = [
    new THREE.Color(0x687941),
    new THREE.Color(0x7c8c49),
    new THREE.Color(0x91a052),
    new THREE.Color(0xa7a264),
  ];
  root.add(grass);

  const flowerGeometry = remember(new THREE.CircleGeometry(0.065, 8));
  flowerGeometry.rotateX(-Math.PI / 2);
  const flowerMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const flowers = new THREE.InstancedMesh(
    flowerGeometry,
    flowerMaterial,
    WORLD_CHUNK_COUNT * FLOWERS_PER_CHUNK,
  );
  flowers.frustumCulled = false;
  const flowerColors = [
    new THREE.Color(0xffedc2),
    new THREE.Color(0xf2d979),
    new THREE.Color(0xf7f0d1),
  ];
  root.add(flowers);

  const trunkGeometry = remember(new THREE.CylinderGeometry(0.14, 0.23, 1.4, 6));
  const trunkMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x665239, roughness: 1 }),
  );
  const trunks = new THREE.InstancedMesh(
    trunkGeometry,
    trunkMaterial,
    WORLD_CHUNK_COUNT * TREES_PER_CHUNK,
  );
  trunks.frustumCulled = false;
  root.add(trunks);

  const foliageGeometry = remember(new THREE.DodecahedronGeometry(1, 0));
  const foliageMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      emissive: 0x4d5336,
      emissiveIntensity: 0.14,
    }),
  );
  const foliage = new THREE.InstancedMesh(
    foliageGeometry,
    foliageMaterial,
    WORLD_CHUNK_COUNT * (TREES_PER_CHUNK * 2 + BUSHES_PER_CHUNK),
  );
  foliage.frustumCulled = false;
  const foliageColors = [
    new THREE.Color(0x71805a),
    new THREE.Color(0x839063),
    new THREE.Color(0x94976b),
    new THREE.Color(0xa49e73),
  ];
  root.add(foliage);

  const decorativeRockGeometry = remember(new THREE.DodecahedronGeometry(0.46, 0));
  const decorativeRockMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  const decorativeRocks = new THREE.InstancedMesh(
    decorativeRockGeometry,
    decorativeRockMaterial,
    WORLD_CHUNK_COUNT * ROCKS_PER_CHUNK,
  );
  decorativeRocks.frustumCulled = false;
  decorativeRocks.receiveShadow = true;
  const decorativeRockColors = [
    new THREE.Color(0x837a60),
    new THREE.Color(0x999071),
    new THREE.Color(0x746f58),
  ];
  root.add(decorativeRocks);

  const refreshInstances = (mesh: THREE.InstancedMesh, colors = false) => {
    mesh.instanceMatrix.needsUpdate = true;
    if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  let centerChunkX = Number.NaN;
  let centerChunkZ = Number.NaN;

  const refreshChunks = (nextChunkX: number, nextChunkZ: number) => {
    let groundIndex = 0;
    let patchIndex = 0;
    let grassIndex = 0;
    let flowerIndex = 0;
    let trunkIndex = 0;
    let foliageIndex = 0;
    let rockIndex = 0;
    let authoredGrassIndex = 0;
    let authoredFlowerIndex = 0;
    let authoredTreeIndex = 0;
    let authoredShrubIndex = 0;
    let authoredRockIndex = 0;

    for (
      let chunkZ = nextChunkZ - WORLD_CHUNK_RADIUS;
      chunkZ <= nextChunkZ + WORLD_CHUNK_RADIUS;
      chunkZ += 1
    ) {
      for (
        let chunkX = nextChunkX - WORLD_CHUNK_RADIUS;
        chunkX <= nextChunkX + WORLD_CHUNK_RADIUS;
        chunkX += 1
      ) {
        const chunkLodDistance = Math.max(
          Math.abs(chunkX - nextChunkX),
          Math.abs(chunkZ - nextChunkZ),
        );
        const authoredNear = (asset: AuthoredEnvironmentKey) =>
          Boolean(authoredAssets[asset]) &&
          chunkLodDistance <=
            WAITLAND_ENVIRONMENT_MANIFEST.assets[asset].placement.authoredChunkRadius;

        if (chunkX !== 0 || chunkZ !== 0) {
          setInstance(
            groundTiles,
            groundIndex,
            transform,
            chunkX * WORLD_CHUNK_SIZE,
            -0.025,
            chunkZ * WORLD_CHUNK_SIZE,
            1,
            1,
            1,
          );
          groundIndex += 1;
        }

        const patchRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x2a51));
        for (let slot = 0; slot < PATCHES_PER_CHUNK; slot += 1) {
          const point = pointForChunk(
            chunkX,
            chunkZ,
            patchRandom,
            PIT_MEADOW_CLEARANCE + 0.2,
            0.48,
          );
          const size = point.visible ? 1.35 + patchRandom() * 3.7 : 0;
          setInstance(
            patches,
            patchIndex,
            transform,
            point.x,
            0.008,
            point.z,
            size,
            1,
            size * (0.4 + patchRandom() * 0.48),
            patchRandom() * Math.PI,
          );
          patches.setColorAt(
            patchIndex,
            patchColors[Math.floor(patchRandom() * patchColors.length)],
          );
          patchIndex += 1;
        }

        const grassRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x6ba7));
        const useAuthoredGrass = authoredNear("grass");
        // Cheap crossed blades remain beneath the authored clusters. They are
        // what makes the near field continuous instead of a few isolated props.
        for (let slot = 0; slot < GRASS_MARKS_PER_CHUNK; slot += 1) {
          const point = pointForChunk(
            chunkX,
            chunkZ,
            grassRandom,
            PIT_LIP_OUTER_RADIUS - 0.18,
            0.08,
          );
          const visibleScale = point.visible ? 1 : 0;
          const length = (0.55 + grassRandom() * 1.05) * visibleScale;
          setInstance(
            grass,
            grassIndex,
            transform,
            point.x,
            0.017,
            point.z,
            (0.72 + grassRandom() * 0.55) * visibleScale,
            length,
            (0.72 + grassRandom() * 0.55) * visibleScale,
            grassRandom() * Math.PI,
          );
          grass.setColorAt(
            grassIndex,
            grassColors[Math.floor(grassRandom() * grassColors.length)],
          );
          grassIndex += 1;
        }

        const authoredGrass = authoredAssets.grass?.pool;
        if (authoredGrass && useAuthoredGrass) {
          const clusterRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x6bb9));
          for (
            let slot = 0;
            slot < WAITLAND_ENVIRONMENT_MANIFEST.assets.grass.placement.instancesPerChunk;
            slot += 1
          ) {
            const point = pointForChunk(
              chunkX,
              chunkZ,
              clusterRandom,
              PIT_LIP_OUTER_RADIUS - 0.12,
              0.12,
            );
            if (!point.visible) continue;
            const size = 0.78 + clusterRandom() * 0.5;
            setAuthoredInstance(
              authoredGrass,
              authoredGrassIndex,
              point.x,
              0.012,
              point.z,
              size * (0.88 + clusterRandom() * 0.22),
              size * (0.82 + clusterRandom() * 0.32),
              size * (0.88 + clusterRandom() * 0.22),
              clusterRandom() * Math.PI * 2,
            );
            authoredGrassIndex += 1;
          }
        }

        const flowerRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x8de1));
        const useAuthoredFlowers = authoredNear("flowers");
        // Tiny procedural blooms fill the gaps between Meshy flower accents.
        for (let slot = 0; slot < FLOWERS_PER_CHUNK; slot += 1) {
          const point = pointForChunk(
            chunkX,
            chunkZ,
            flowerRandom,
            PIT_LIP_OUTER_RADIUS + 0.34,
            0.72,
          );
          const size = point.visible ? 0.66 + flowerRandom() * 0.82 : 0;
          setInstance(
            flowers,
            flowerIndex,
            transform,
            point.x,
            0.025,
            point.z,
            size,
            size * 0.72,
            size,
          );
          flowers.setColorAt(
            flowerIndex,
            flowerColors[Math.floor(flowerRandom() * flowerColors.length)],
          );
          flowerIndex += 1;
        }

        const authoredFlowers = authoredAssets.flowers?.pool;
        if (authoredFlowers && useAuthoredFlowers) {
          const clusterRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x8df7));
          for (
            let slot = 0;
            slot < WAITLAND_ENVIRONMENT_MANIFEST.assets.flowers.placement.instancesPerChunk;
            slot += 1
          ) {
            const point = pointForChunk(
              chunkX,
              chunkZ,
              clusterRandom,
              PIT_LIP_OUTER_RADIUS + 0.42,
              0.78,
            );
            if (!point.visible) continue;
            const size = 0.72 + clusterRandom() * 0.38;
            setAuthoredInstance(
              authoredFlowers,
              authoredFlowerIndex,
              point.x,
              0.016,
              point.z,
              size,
              size * (0.88 + clusterRandom() * 0.22),
              size,
              clusterRandom() * Math.PI * 2,
            );
            authoredFlowerIndex += 1;
          }
        }

        const treeRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xa4c3));
        const useAuthoredTrees = authoredNear("tree");
        for (let slot = 0; slot < TREES_PER_CHUNK; slot += 1) {
          const tree = pointForChunk(chunkX, chunkZ, treeRandom, 18, 2.4);
          const treeVisible = tree.visible && treeRandom() > 0.44;
          const size = treeVisible ? 0.78 + treeRandom() * 0.64 : 0;
          const rotation = treeRandom() * Math.PI;
          if (!useAuthoredTrees) {
            setInstance(
              trunks,
              trunkIndex,
              transform,
              tree.x,
              size * 0.7,
              tree.z,
              size * 0.9,
              size,
              size * 0.9,
              rotation,
            );
            trunkIndex += 1;

            setInstance(
              foliage,
              foliageIndex,
              transform,
              tree.x - size * 0.16,
              size * 1.48,
              tree.z,
              size * 0.82,
              size * 0.72,
              size * 0.78,
              rotation,
            );
            foliage.setColorAt(
              foliageIndex,
              foliageColors[Math.floor(treeRandom() * foliageColors.length)],
            );
            foliageIndex += 1;
            setInstance(
              foliage,
              foliageIndex,
              transform,
              tree.x + size * 0.18,
              size * 2.02,
              tree.z - size * 0.06,
              size * 0.62,
              size * 0.66,
              size * 0.6,
              rotation + 0.7,
            );
            foliage.setColorAt(
              foliageIndex,
              foliageColors[Math.floor(treeRandom() * foliageColors.length)],
            );
            foliageIndex += 1;
          }

          const authoredTrees = authoredAssets.tree?.pool;
          if (authoredTrees && useAuthoredTrees && treeVisible) {
            setAuthoredInstance(
              authoredTrees,
              authoredTreeIndex,
              tree.x,
              0.008,
              tree.z,
              size * (0.88 + treeRandom() * 0.16),
              size,
              size * (0.88 + treeRandom() * 0.16),
              rotation,
            );
            authoredTreeIndex += 1;
          }
        }

        const bushRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xc271));
        const useAuthoredShrubs = authoredNear("shrubs");
        for (let slot = 0; slot < BUSHES_PER_CHUNK; slot += 1) {
          const bush = pointForChunk(chunkX, chunkZ, bushRandom, 13, 1.6);
          const bushVisible = bush.visible && bushRandom() > 0.3;
          const size = bushVisible ? 0.42 + bushRandom() * 0.58 : 0;
          const stretchX = 1.15 + bushRandom() * 0.35;
          const stretchY = 0.7 + bushRandom() * 0.28;
          const rotation = bushRandom() * Math.PI;
          if (!useAuthoredShrubs) {
            setInstance(
              foliage,
              foliageIndex,
              transform,
              bush.x,
              size * 0.58,
              bush.z,
              size * stretchX,
              size * stretchY,
              size,
              rotation,
            );
            foliage.setColorAt(
              foliageIndex,
              foliageColors[Math.floor(bushRandom() * foliageColors.length)],
            );
            foliageIndex += 1;
          }

          const authoredShrubs = authoredAssets.shrubs?.pool;
          if (authoredShrubs && useAuthoredShrubs && bushVisible) {
            setAuthoredInstance(
              authoredShrubs,
              authoredShrubIndex,
              bush.x,
              0.01,
              bush.z,
              size * (0.94 + bushRandom() * 0.22),
              size * (0.82 + bushRandom() * 0.28),
              size * (0.94 + bushRandom() * 0.22),
              rotation,
            );
            authoredShrubIndex += 1;
          }
        }

        const rockRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xe913));
        const useAuthoredRocks = authoredNear("rocks");
        for (let slot = 0; slot < ROCKS_PER_CHUNK; slot += 1) {
          const rock = pointForChunk(chunkX, chunkZ, rockRandom, 13.5, 1.7);
          const rockVisible = rock.visible && rockRandom() > 0.26;
          const size = rockVisible ? 0.42 + rockRandom() * 0.94 : 0;
          const stretchX = 0.75 + rockRandom() * 0.45;
          const rotationX = rockRandom() * 1.2;
          const rotationY = rockRandom() * Math.PI;
          const rotationZ = rockRandom() * 1.2;
          if (!useAuthoredRocks) {
            transform.position.set(rock.x, size * 0.19, rock.z);
            transform.scale.set(size * stretchX, size * 0.62, size);
            transform.rotation.set(rotationX, rotationY, rotationZ);
            transform.updateMatrix();
            decorativeRocks.setMatrixAt(rockIndex, transform.matrix);
            decorativeRocks.setColorAt(
              rockIndex,
              decorativeRockColors[
                Math.floor(rockRandom() * decorativeRockColors.length)
              ],
            );
            rockIndex += 1;
          }

          const authoredRocks = authoredAssets.rocks?.pool;
          if (authoredRocks && useAuthoredRocks && rockVisible) {
            setAuthoredInstance(
              authoredRocks,
              authoredRockIndex,
              rock.x,
              0.01,
              rock.z,
              size * stretchX,
              size * (0.78 + rockRandom() * 0.2),
              size * (0.9 + rockRandom() * 0.2),
              rotationY,
            );
            authoredRockIndex += 1;
          }
        }
      }
    }

    groundTiles.count = groundIndex;
    patches.count = patchIndex;
    grass.count = grassIndex;
    flowers.count = flowerIndex;
    trunks.count = trunkIndex;
    foliage.count = foliageIndex;
    decorativeRocks.count = rockIndex;
    refreshInstances(groundTiles);
    refreshInstances(patches, true);
    refreshInstances(grass, true);
    refreshInstances(flowers, true);
    refreshInstances(trunks);
    refreshInstances(foliage, true);
    refreshInstances(decorativeRocks, true);
    authoredAssets.grass?.pool.commit(authoredGrassIndex);
    authoredAssets.flowers?.pool.commit(authoredFlowerIndex);
    authoredAssets.tree?.pool.commit(authoredTreeIndex);
    authoredAssets.shrubs?.pool.commit(authoredShrubIndex);
    authoredAssets.rocks?.pool.commit(authoredRockIndex);
  };

  // Retain a travelling horizon anchor for the streaming contract, but leave
  // it free of spherical hills/clouds. The portrait raster plate now supplies
  // that depth without opaque domes obscuring its painted skyline.
  const horizonRoot = new THREE.Group();
  horizonRoot.name = "travelling-horizon";
  root.add(horizonRoot);

  refreshChunks(0, 0);
  centerChunkX = 0;
  centerChunkZ = 0;

  const installAuthoredAsset = async (key: AuthoredEnvironmentKey) => {
    const manifest = WAITLAND_ENVIRONMENT_MANIFEST.assets[key];
    const result = await loadEnvironmentAsset(manifest, {
      signal: environmentAbort.signal,
    });
    if (!result.ok) return;
    if (worldDisposed) {
      result.asset.dispose();
      return;
    }

    const capacity =
      key === "path"
        ? AUTHORED_PATH_MODULES
        : WORLD_CHUNK_COUNT * manifest.placement.instancesPerChunk;
    const pool = result.asset.createInstancedPool(
      capacity,
      `authored-${manifest.assetId}`,
    );
    authoredAssets[key] = { lease: result.asset, pool };
    authoredRoot.add(pool.root);

    if (key === "path") {
      populateAuthoredPath(pool);
      for (const mesh of pool.meshes) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          material.transparent = true;
          material.opacity = 0.28;
          material.depthWrite = false;
          material.needsUpdate = true;
        }
      }
      // Keep the broad ribbon as the readable trail silhouette. The authored
      // modules add tactile soil and pebble detail without turning it into a
      // pair of narrow raised seams.
      return;
    }
    refreshChunks(centerChunkX, centerChunkZ);
  };

  if (typeof document !== "undefined") {
    for (const key of Object.keys(
      WAITLAND_ENVIRONMENT_MANIFEST.assets,
    ) as AuthoredEnvironmentKey[]) {
      void installAuthoredAsset(key);
    }
  }

  return {
    update(_elapsedSeconds, playerX = 0, playerZ = 0) {
      const safeX = Number.isFinite(playerX) ? playerX : 0;
      const safeZ = Number.isFinite(playerZ) ? playerZ : 0;
      const nextChunkX = chunkAt(safeX);
      const nextChunkZ = chunkAt(safeZ);
      if (nextChunkX !== centerChunkX || nextChunkZ !== centerChunkZ) {
        refreshChunks(nextChunkX, nextChunkZ);
        centerChunkX = nextChunkX;
        centerChunkZ = nextChunkZ;
      }

      horizonRoot.position.set(safeX, 0, safeZ);
    },
    dispose() {
      worldDisposed = true;
      environmentAbort.abort();
      for (const installed of Object.values(authoredAssets)) {
        authoredRoot.remove(installed.pool.root);
        installed.pool.dispose();
        installed.lease.dispose();
      }
      scene.remove(root);
      disposable.forEach((item) => item.dispose());
    },
  };
}
