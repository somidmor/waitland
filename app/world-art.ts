import * as THREE from "three";
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

const PATCHES_PER_CHUNK = 3;
const GRASS_MARKS_PER_CHUNK = 72;
const FLOWERS_PER_CHUNK = 8;
const TREES_PER_CHUNK = 1;
const BUSHES_PER_CHUNK = 1;
const ROCKS_PER_CHUNK = 2;

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
    pitEdgeRadius(0, PIT_LIP_OUTER_RADIUS, PIT_LIP_OUTER_PHASE) * 1.035,
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
    opening.lineTo(Math.cos(angle) * radius * 1.035, Math.sin(angle) * radius);
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

  const disposable = new Set<Disposable>();
  const remember = <T extends Disposable>(value: T) => {
    disposable.add(value);
    return value;
  };
  const transform = new THREE.Object3D();

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
      [{ material: groundMaterial, texturedColor: 0xcbd6aa }],
      ENVIRONMENT_TEXTURE_PATHS.grass,
      { repeat: 14, normalScale: 0.24 },
    ),
  );

  // This is a faint foot-worn trail, not a road. Meadow marks are allowed
  // close to its edges so the route feels partially reclaimed by grass.
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
  const pathWidths = [0.82, 0.74, 0.68, 0.62, 0.58, 0.58, 0.64, 0.72, 0.84];
  const pathCurve = new THREE.CatmullRomCurve3(pathPoints, false, "centripetal");
  const pathSamples = Array.from({ length: 72 }, (_, index) =>
    pathCurve.getPointAt(index / 71),
  );

  const pathEdgeGeometry = remember(
    makePathRibbonGeometry(pathCurve, pathWidths, 1.28, 0.008, false),
  );
  const pathEdgeMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0x756343,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.065,
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
      opacity: 0.15,
      depthWrite: false,
    }),
  );
  const path = new THREE.Mesh(pathGeometry, pathMaterial);
  path.receiveShadow = true;
  root.add(path);

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
            -0.07, 0, 0, 0.07, 0, 0, 0.045, 0.5, 0, -0.045, 0.5, 0,
            0, 0, -0.07, 0, 0, 0.07, 0, 0.5, 0.045, 0, 0.5, -0.045,
          ],
          3,
        ),
      )
      .setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  );
  grassGeometry.computeVertexNormals();
  const grassMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.66,
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
    new THREE.Color(0x69773f),
    new THREE.Color(0x7d8549),
    new THREE.Color(0x909354),
    new THREE.Color(0xa6a061),
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

        const flowerRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0x8de1));
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

        const treeRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xa4c3));
        for (let slot = 0; slot < TREES_PER_CHUNK; slot += 1) {
          const tree = pointForChunk(chunkX, chunkZ, treeRandom, 18, 2.4);
          const treeVisible = tree.visible && treeRandom() > 0.44;
          const size = treeVisible ? 0.78 + treeRandom() * 0.64 : 0;
          const rotation = treeRandom() * Math.PI;
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

        const bushRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xc271));
        for (let slot = 0; slot < BUSHES_PER_CHUNK; slot += 1) {
          const bush = pointForChunk(chunkX, chunkZ, bushRandom, 13, 1.6);
          const bushVisible = bush.visible && bushRandom() > 0.3;
          const size = bushVisible ? 0.42 + bushRandom() * 0.58 : 0;
          setInstance(
            foliage,
            foliageIndex,
            transform,
            bush.x,
            size * 0.58,
            bush.z,
            size * (1.15 + bushRandom() * 0.35),
            size * (0.7 + bushRandom() * 0.28),
            size,
            bushRandom() * Math.PI,
          );
          foliage.setColorAt(
            foliageIndex,
            foliageColors[Math.floor(bushRandom() * foliageColors.length)],
          );
          foliageIndex += 1;
        }

        const rockRandom = seededRandom(seedForChunk(chunkX, chunkZ, 0xe913));
        for (let slot = 0; slot < ROCKS_PER_CHUNK; slot += 1) {
          const rock = pointForChunk(chunkX, chunkZ, rockRandom, 13.5, 1.7);
          const rockVisible = rock.visible && rockRandom() > 0.26;
          const size = rockVisible ? 0.42 + rockRandom() * 0.94 : 0;
          transform.position.set(rock.x, size * 0.19, rock.z);
          transform.scale.set(
            size * (0.75 + rockRandom() * 0.45),
            size * 0.62,
            size,
          );
          transform.rotation.set(
            rockRandom() * 1.2,
            rockRandom() * Math.PI,
            rockRandom() * 1.2,
          );
          transform.updateMatrix();
          decorativeRocks.setMatrixAt(rockIndex, transform.matrix);
          decorativeRocks.setColorAt(
            rockIndex,
            decorativeRockColors[Math.floor(rockRandom() * decorativeRockColors.length)],
          );
          rockIndex += 1;
        }
      }
    }

    groundTiles.count = groundIndex;
    refreshInstances(groundTiles);
    refreshInstances(patches, true);
    refreshInstances(grass, true);
    refreshInstances(flowers, true);
    refreshInstances(trunks);
    refreshInstances(foliage, true);
    refreshInstances(decorativeRocks, true);
  };

  // The horizon is a camera-relative scenic layer. It follows the traveller,
  // so fixed world coordinates never reveal a perimeter or an empty edge.
  const horizonRoot = new THREE.Group();
  horizonRoot.name = "travelling-horizon";
  root.add(horizonRoot);

  const horizonRandom = seededRandom(0x48ab129d);
  const hillGeometry = remember(new THREE.SphereGeometry(1, 18, 9));
  const hillMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  const hills = new THREE.InstancedMesh(hillGeometry, hillMaterial, 24);
  const nearHillColors = [
    new THREE.Color(0x777946),
    new THREE.Color(0x85834a),
    new THREE.Color(0x938952),
  ];
  const farHillColors = [
    new THREE.Color(0xa49561),
    new THREE.Color(0x9a8e5d),
    new THREE.Color(0xab9a68),
  ];
  for (let index = 0; index < hills.count; index += 1) {
    const far = index >= hills.count / 2;
    const layerIndex = far ? index - hills.count / 2 : index;
    const angle = (layerIndex / (hills.count / 2)) * Math.PI * 2 + (far ? 0.31 : 0.07);
    const radius = far ? 108 + (layerIndex % 3) * 5 : 79 + (layerIndex % 3) * 4;
    setInstance(
      hills,
      index,
      transform,
      Math.cos(angle) * radius,
      far ? -2.4 : -3.1,
      Math.sin(angle) * radius,
      (far ? 20 : 13) + horizonRandom() * (far ? 13 : 10),
      (far ? 6.8 : 4.5) + horizonRandom() * (far ? 4.2 : 3.1),
      (far ? 15 : 10) + horizonRandom() * (far ? 10 : 8),
      horizonRandom() * Math.PI,
    );
    const palette = far ? farHillColors : nearHillColors;
    hills.setColorAt(index, palette[layerIndex % palette.length]);
  }
  hills.instanceMatrix.needsUpdate = true;
  hills.instanceColor!.needsUpdate = true;
  hills.receiveShadow = true;
  hills.frustumCulled = false;
  horizonRoot.add(hills);

  const cloudGeometry = remember(new THREE.SphereGeometry(1, 12, 8));
  const hazeMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xe7bf83,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      fog: true,
    }),
  );
  const haze = new THREE.InstancedMesh(cloudGeometry, hazeMaterial, 12);
  haze.frustumCulled = false;
  for (let index = 0; index < haze.count; index += 1) {
    const cluster = Math.floor(index / 2);
    const petal = index % 2;
    const angle = (cluster / 6) * Math.PI * 2 + 0.44;
    const radius = 86 + petal * 6;
    setInstance(
      haze,
      index,
      transform,
      Math.cos(angle) * radius - Math.sin(angle) * (petal - 0.5) * 9,
      4.1 + (cluster % 3) * 0.75,
      Math.sin(angle) * radius + Math.cos(angle) * (petal - 0.5) * 9,
      10 + (cluster % 2) * 3,
      1.45 + petal * 0.5,
      4.5 + (cluster % 3),
      -angle,
    );
  }
  haze.instanceMatrix.needsUpdate = true;
  haze.renderOrder = -3;
  horizonRoot.add(haze);

  const cloudMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffe9bd,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      fog: true,
    }),
  );
  const clouds = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, 24);
  clouds.frustumCulled = false;
  for (let index = 0; index < clouds.count; index += 1) {
    const cluster = Math.floor(index / 4);
    const petal = index % 4;
    const angle = (cluster / 6) * Math.PI * 2 + 0.18;
    const radius = 82 + (cluster % 2) * 7;
    const size = 1.75 + ((cluster + petal) % 3) * 0.62;
    const tangentOffset = (petal - 1.5) * 2.15;
    setInstance(
      clouds,
      index,
      transform,
      Math.cos(angle) * radius - Math.sin(angle) * tangentOffset,
      13.5 + (petal % 2) * 1.05 + (cluster % 3) * 0.36,
      Math.sin(angle) * radius + Math.cos(angle) * tangentOffset,
      size * 1.58,
      size,
      size,
      -angle,
    );
  }
  clouds.instanceMatrix.needsUpdate = true;
  clouds.renderOrder = -2;
  horizonRoot.add(clouds);

  refreshChunks(0, 0);
  centerChunkX = 0;
  centerChunkZ = 0;

  const cloudBaseY = clouds.position.y;
  const hazeBaseY = haze.position.y;
  return {
    update(elapsedSeconds, playerX = 0, playerZ = 0) {
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
      clouds.position.y = cloudBaseY + Math.sin(elapsedSeconds * 0.16) * 0.16;
      clouds.rotation.y = Math.sin(elapsedSeconds * 0.025) * 0.006;
      haze.position.y = hazeBaseY + Math.sin(elapsedSeconds * 0.1 + 0.8) * 0.08;
      haze.rotation.y = -Math.sin(elapsedSeconds * 0.018) * 0.004;
    },
    dispose() {
      scene.remove(root);
      disposable.forEach((item) => item.dispose());
    },
  };
}
