import * as THREE from "three";
import { FIELD_RADIUS } from "../shared/world";

type Disposable = { dispose: () => void };

export type StorybookWorld = {
  update: (elapsedSeconds: number) => void;
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
  const warmSoil = new THREE.Color(0xa68a59);
  const wornSoil = new THREE.Color(0x8d744a);
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
    const ripple = Math.sin(index * 0.83) * 0.003;

    positions.push(
      point.x + normal.x * leftWidth,
      y + ripple,
      point.z + normal.z * leftWidth,
      point.x - normal.x * rightWidth,
      y - ripple,
      point.z - normal.z * rightWidth,
    );

    if (includeColor) {
      shade.copy(warmSoil).lerp(wornSoil, 0.22 + (Math.sin(index * 0.91) + 1) * 0.16);
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

function makeGuardian() {
  const guardian = new THREE.Group();
  guardian.name = "the-waiting-guardian";
  guardian.position.set(0, 0.1, -34);
  guardian.rotation.y = 0.12;

  const stone = new THREE.MeshStandardMaterial({
    color: 0x938b72,
    roughness: 1,
    metalness: 0,
  });
  const shadowStone = new THREE.MeshStandardMaterial({
    color: 0x746c58,
    roughness: 1,
    metalness: 0,
  });

  const hill = new THREE.Mesh(
    new THREE.SphereGeometry(7.8, 28, 12),
    new THREE.MeshStandardMaterial({ color: 0x7f8654, roughness: 1 }),
  );
  hill.scale.set(1.45, 0.23, 0.7);
  hill.position.y = -1.55;
  hill.receiveShadow = true;
  guardian.add(hill);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 0.72, 10), shadowStone);
  base.position.y = 0.38;
  base.castShadow = true;
  guardian.add(base);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.22, 1.9, 7, 13), stone);
  body.position.y = 2.05;
  body.scale.set(1.18, 1, 0.84);
  body.castShadow = true;
  guardian.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.92, 18, 14), stone);
  head.position.set(0, 4.25, 0);
  head.scale.set(0.94, 1.04, 0.9);
  head.castShadow = true;
  guardian.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.99, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
    shadowStone,
  );
  hair.position.set(0, 4.49, -0.08);
  hair.scale.set(1.03, 0.9, 1.04);
  guardian.add(hair);

  const armGeometry = new THREE.CapsuleGeometry(0.28, 1.5, 5, 9);
  const leftArm = new THREE.Mesh(armGeometry, stone);
  const rightArm = new THREE.Mesh(armGeometry, stone);
  leftArm.position.set(-1.03, 2.35, 0.42);
  rightArm.position.set(1.03, 2.35, 0.42);
  leftArm.rotation.set(-0.22, 0, -0.84);
  rightArm.rotation.set(-0.22, 0, 0.84);
  leftArm.castShadow = true;
  rightArm.castShadow = true;
  guardian.add(leftArm, rightArm);

  const heldStone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.56, 0), shadowStone);
  heldStone.position.set(0, 1.95, 0.95);
  heldStone.scale.set(1.08, 0.86, 0.95);
  heldStone.castShadow = true;
  guardian.add(heldStone);

  const eyeGeometry = new THREE.SphereGeometry(0.055, 8, 6);
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x514c40 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye.position.set(side * 0.27, 4.35, 0.79);
    eye.scale.set(1, 0.34, 0.4);
    guardian.add(eye);
  }

  guardian.scale.setScalar(0.88);
  return guardian;
}

/**
 * Adds the warm, low-detail meadow around the interactive layer. All repeated
 * scenery is instanced so the richer art direction stays inexpensive on phones.
 */
export function createStorybookWorld(scene: THREE.Scene): StorybookWorld {
  const random = seededRandom();
  const root = new THREE.Group();
  root.name = "storybook-world";
  scene.add(root);

  const disposable = new Set<Disposable>();
  const remember = <T extends Disposable>(value: T) => {
    disposable.add(value);
    return value;
  };

  const transform = new THREE.Object3D();

  // A slightly warmer outer meadow lets the playable field fall away into the
  // sunlit horizon without a texture or another light pass.
  const groundGeometry = remember(new THREE.CircleGeometry(FIELD_RADIUS + 24, 112));
  const groundMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x9b915d, roughness: 1, metalness: 0 }),
  );
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.y = -0.025;
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  const meadowGeometry = remember(new THREE.CircleGeometry(FIELD_RADIUS + 4, 112));
  const meadowMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x888b4c, roughness: 1, metalness: 0 }),
  );
  const meadow = new THREE.Mesh(meadowGeometry, meadowMaterial);
  meadow.position.y = -0.01;
  meadow.rotation.x = -Math.PI / 2;
  meadow.receiveShadow = true;
  root.add(meadow);

  // The path deliberately curls around the pit's collision radius before
  // continuing toward the guardian. It is visual guidance, not geometry that
  // movement or multiplayer state needs to know about.
  const pathPoints = [
    new THREE.Vector3(-5.5, 0, FIELD_RADIUS + 7),
    new THREE.Vector3(-3.5, 0, 53),
    new THREE.Vector3(-1.5, 0, 35),
    new THREE.Vector3(0.2, 0, 22),
    new THREE.Vector3(3.2, 0, 12.5),
    new THREE.Vector3(6.8, 0, 6.4),
    new THREE.Vector3(7.35, 0, -0.5),
    new THREE.Vector3(5.9, 0, -8),
    new THREE.Vector3(2.2, 0, -17.5),
    new THREE.Vector3(0.1, 0, -29.5),
  ];
  const pathWidths = [2.25, 2.05, 1.8, 1.55, 1.4, 1.25, 1.25, 1.35, 1.55, 1.9];
  const pathCurve = new THREE.CatmullRomCurve3(pathPoints, false, "centripetal");
  const pathSamples = Array.from({ length: 72 }, (_, index) =>
    pathCurve.getPointAt(index / 71),
  );

  const pathEdgeGeometry = remember(
    makePathRibbonGeometry(pathCurve, pathWidths, 1.18, 0.012, false),
  );
  const pathEdgeMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x9a855d, roughness: 1, metalness: 0 }),
  );
  const pathEdge = new THREE.Mesh(pathEdgeGeometry, pathEdgeMaterial);
  pathEdge.receiveShadow = true;
  root.add(pathEdge);

  const pathGeometry = remember(
    makePathRibbonGeometry(pathCurve, pathWidths, 1, 0.021, true),
  );
  const pathMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    }),
  );
  const path = new THREE.Mesh(pathGeometry, pathMaterial);
  path.receiveShadow = true;
  root.add(path);

  const meadowPoint = (minRadius: number, maxRadius: number, pathClearance: number) => {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const radius = minRadius + random() * (maxRadius - minRadius);
      const angle = random() * Math.PI * 2;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      if (!isNearPath(x, z, pathSamples, pathClearance)) break;
    }
    return { x, z };
  };

  const patchGeometry = remember(new THREE.CircleGeometry(1, 18));
  patchGeometry.rotateX(-Math.PI / 2);
  const patchMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      vertexColors: true,
      toneMapped: false,
    }),
  );
  const patches = new THREE.InstancedMesh(patchGeometry, patchMaterial, 68);
  const patchColors = [
    new THREE.Color(0xa49f6a),
    new THREE.Color(0xb0a974),
    new THREE.Color(0xc2b682),
  ];
  for (let index = 0; index < patches.count; index += 1) {
    const point = meadowPoint(7, FIELD_RADIUS + 9, 1.4);
    const size = 1.4 + random() * 4.5;
    setInstance(
      patches,
      index,
      transform,
      point.x,
      0.008,
      point.z,
      size,
      1,
      size * (0.38 + random() * 0.52),
      random() * Math.PI,
    );
    patches.setColorAt(index, patchColors[index % patchColors.length]);
  }
  patches.instanceMatrix.needsUpdate = true;
  patches.instanceColor!.needsUpdate = true;
  root.add(patches);

  const grassGeometry = remember(new THREE.CircleGeometry(0.075, 5));
  grassGeometry.rotateX(-Math.PI / 2);
  const grassMaterial = remember(
    // Ground-hugging leaf marks stay legible without the sub-pixel black
    // aliasing produced by thin vertical geometry at the gameplay camera.
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, 320);
  const grassColors = [
    new THREE.Color(0xaaa76c),
    new THREE.Color(0xb7b074),
    new THREE.Color(0xc0b77e),
    new THREE.Color(0xc9be88),
  ];
  for (let index = 0; index < grass.count; index += 1) {
    const point = meadowPoint(6.7, FIELD_RADIUS + 8, 2.25);
    const length = 0.8 + random() * 1.45;
    setInstance(
      grass,
      index,
      transform,
      point.x,
      0.016,
      point.z,
      0.42 + random() * 0.46,
      1,
      length,
      random() * Math.PI,
    );
    grass.setColorAt(index, grassColors[index % grassColors.length]);
  }
  grass.instanceMatrix.needsUpdate = true;
  grass.instanceColor!.needsUpdate = true;
  root.add(grass);

  const flowerGeometry = remember(new THREE.CircleGeometry(0.065, 8));
  flowerGeometry.rotateX(-Math.PI / 2);
  const flowerMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffedc2,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const flowerClusterCount = 24;
  const flowersPerCluster = 12;
  const flowerCenters = Array.from({ length: flowerClusterCount }, () =>
    meadowPoint(9, FIELD_RADIUS + 4, 3.2),
  );
  const flowers = new THREE.InstancedMesh(
    flowerGeometry,
    flowerMaterial,
    flowerClusterCount * flowersPerCluster,
  );
  for (let index = 0; index < flowers.count; index += 1) {
    const center = flowerCenters[Math.floor(index / flowersPerCluster)];
    const scatterAngle = random() * Math.PI * 2;
    const scatterRadius = Math.sqrt(random()) * 2.6;
    let x = center.x + Math.cos(scatterAngle) * scatterRadius;
    let z = center.z + Math.sin(scatterAngle) * scatterRadius;
    if (isNearPath(x, z, pathSamples, 2.1)) {
      x = center.x;
      z = center.z;
    }
    const size = 0.7 + random() * 0.72;
    setInstance(
      flowers,
      index,
      transform,
      x,
      0.024,
      z,
      size,
      size * 0.7,
      size,
    );
  }
  flowers.instanceMatrix.needsUpdate = true;
  root.add(flowers);

  // Distant ridges share one low-poly sphere and one vertex-coloured material,
  // so two depth layers still cost a single scenery draw call.
  const hillGeometry = remember(new THREE.SphereGeometry(1, 18, 9));
  const hillMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true }),
  );
  const hills = new THREE.InstancedMesh(hillGeometry, hillMaterial, 28);
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
    const angle = (layerIndex / (hills.count / 2)) * Math.PI * 2 + (far ? 0.32 : 0.08);
    const radius = far
      ? FIELD_RADIUS + 43 + (layerIndex % 3) * 6
      : FIELD_RADIUS + 15 + (layerIndex % 3) * 4;
    setInstance(
      hills,
      index,
      transform,
      Math.cos(angle) * radius,
      far ? -2.3 : -3.1,
      Math.sin(angle) * radius,
      (far ? 21 : 14) + random() * (far ? 15 : 12),
      (far ? 7 : 4.7) + random() * (far ? 4.8 : 3.4),
      (far ? 16 : 11) + random() * (far ? 12 : 9),
      random() * Math.PI,
    );
    const palette = far ? farHillColors : nearHillColors;
    hills.setColorAt(index, palette[layerIndex % palette.length]);
  }
  hills.instanceMatrix.needsUpdate = true;
  hills.instanceColor!.needsUpdate = true;
  hills.receiveShadow = true;
  root.add(hills);

  // Tiny perimeter groves add the layered miniature silhouette seen in the
  // reference while keeping trunks and foliage in just two instanced batches.
  const treeCount = 30;
  const treePlacements: Array<{ x: number; z: number; size: number }> = [];
  for (let index = 0; index < treeCount; index += 1) {
    const grove = Math.floor(index / 3);
    const slot = index % 3;
    const angle = (grove / 10) * Math.PI * 2 + 0.21 + (slot - 1) * 0.045;
    const radius = FIELD_RADIUS + 7 + (grove % 3) * 5 + slot * 1.8;
    const jitteredAngle = angle + (random() - 0.5) * 0.025;
    const jitteredRadius = radius + (random() - 0.5) * 2.2;
    treePlacements.push({
      x: Math.cos(jitteredAngle) * jitteredRadius,
      z: Math.sin(jitteredAngle) * jitteredRadius,
      size: 0.78 + random() * 0.62,
    });
  }

  const trunkGeometry = remember(new THREE.CylinderGeometry(0.14, 0.23, 1.4, 6));
  const trunkMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x665239, roughness: 1 }),
  );
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, treeCount);
  for (let index = 0; index < treePlacements.length; index += 1) {
    const tree = treePlacements[index];
    setInstance(
      trunks,
      index,
      transform,
      tree.x,
      tree.size * 0.7,
      tree.z,
      tree.size * 0.9,
      tree.size,
      tree.size * 0.9,
      random() * Math.PI,
    );
  }
  trunks.instanceMatrix.needsUpdate = true;
  root.add(trunks);

  const bushCount = 28;
  const foliageGeometry = remember(new THREE.DodecahedronGeometry(1, 0));
  const foliageMaterial = remember(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      vertexColors: true,
      emissive: 0x4d5336,
      emissiveIntensity: 0.16,
    }),
  );
  const foliage = new THREE.InstancedMesh(
    foliageGeometry,
    foliageMaterial,
    treeCount * 2 + bushCount,
  );
  const foliageColors = [
    new THREE.Color(0x71805a),
    new THREE.Color(0x839063),
    new THREE.Color(0x94976b),
    new THREE.Color(0xa49e73),
  ];
  let foliageIndex = 0;
  for (const tree of treePlacements) {
    setInstance(
      foliage,
      foliageIndex,
      transform,
      tree.x - tree.size * 0.16,
      tree.size * 1.48,
      tree.z,
      tree.size * 0.82,
      tree.size * 0.72,
      tree.size * 0.78,
      random() * Math.PI,
    );
    foliage.setColorAt(foliageIndex, foliageColors[foliageIndex % foliageColors.length]);
    foliageIndex += 1;
    setInstance(
      foliage,
      foliageIndex,
      transform,
      tree.x + tree.size * 0.18,
      tree.size * 2.02,
      tree.z - tree.size * 0.06,
      tree.size * 0.62,
      tree.size * 0.66,
      tree.size * 0.6,
      random() * Math.PI,
    );
    foliage.setColorAt(foliageIndex, foliageColors[foliageIndex % foliageColors.length]);
    foliageIndex += 1;
  }
  for (let index = 0; index < bushCount; index += 1) {
    const point = meadowPoint(37, FIELD_RADIUS + 2, 3.2);
    const size = 0.42 + random() * 0.58;
    setInstance(
      foliage,
      foliageIndex,
      transform,
      point.x,
      size * 0.58,
      point.z,
      size * (1.15 + random() * 0.35),
      size * (0.7 + random() * 0.28),
      size,
      random() * Math.PI,
    );
    foliage.setColorAt(foliageIndex, foliageColors[(index + 1) % foliageColors.length]);
    foliageIndex += 1;
  }
  foliage.instanceMatrix.needsUpdate = true;
  foliage.instanceColor!.needsUpdate = true;
  root.add(foliage);

  // These rocks sit beyond the playable radius, so they read as landscape
  // clusters without competing with interactive field stones.
  const decorativeRockGeometry = remember(new THREE.DodecahedronGeometry(0.46, 0));
  const decorativeRockMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true }),
  );
  const decorativeRocks = new THREE.InstancedMesh(
    decorativeRockGeometry,
    decorativeRockMaterial,
    54,
  );
  const decorativeRockColors = [
    new THREE.Color(0x837a60),
    new THREE.Color(0x999071),
    new THREE.Color(0x746f58),
  ];
  for (let index = 0; index < decorativeRocks.count; index += 1) {
    const cluster = Math.floor(index / 6);
    const angle = (cluster / 9) * Math.PI * 2 + 0.42;
    const radius = FIELD_RADIUS + 6 + (cluster % 3) * 3;
    const x = Math.cos(angle) * radius + (random() - 0.5) * 4.2;
    const z = Math.sin(angle) * radius + (random() - 0.5) * 4.2;
    const size = 0.46 + random() * 1.05;
    transform.position.set(x, size * 0.19, z);
    transform.scale.set(size * (0.75 + random() * 0.45), size * 0.62, size);
    transform.rotation.set(random() * 1.4, random() * Math.PI, random() * 1.4);
    transform.updateMatrix();
    decorativeRocks.setMatrixAt(index, transform.matrix);
    decorativeRocks.setColorAt(
      index,
      decorativeRockColors[index % decorativeRockColors.length],
    );
  }
  decorativeRocks.instanceMatrix.needsUpdate = true;
  decorativeRocks.instanceColor!.needsUpdate = true;
  decorativeRocks.receiveShadow = true;
  root.add(decorativeRocks);

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
  const haze = new THREE.InstancedMesh(cloudGeometry, hazeMaterial, 16);
  haze.frustumCulled = false;
  for (let index = 0; index < haze.count; index += 1) {
    const cluster = Math.floor(index / 2);
    const petal = index % 2;
    const angle = (cluster / 8) * Math.PI * 2 + 0.44;
    const radius = FIELD_RADIUS + 36 + petal * 6;
    setInstance(
      haze,
      index,
      transform,
      Math.cos(angle) * radius - Math.sin(angle) * (petal - 0.5) * 10,
      4.1 + (cluster % 3) * 0.75,
      Math.sin(angle) * radius + Math.cos(angle) * (petal - 0.5) * 10,
      10 + (cluster % 2) * 3,
      1.45 + petal * 0.5,
      4.5 + (cluster % 3),
      -angle,
    );
  }
  haze.instanceMatrix.needsUpdate = true;
  haze.renderOrder = -3;
  root.add(haze);

  const cloudMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffe9bd,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      fog: true,
    }),
  );
  const clouds = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, 32);
  clouds.frustumCulled = false;
  for (let index = 0; index < clouds.count; index += 1) {
    const cluster = Math.floor(index / 4);
    const petal = index % 4;
    const angle = (cluster / 8) * Math.PI * 2 + 0.18;
    const radius = FIELD_RADIUS + 33 + (cluster % 2) * 7;
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
  root.add(clouds);

  const guardian = makeGuardian();
  root.add(guardian);
  guardian.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) disposable.add(mesh.geometry);
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) disposable.add(material);
  });

  const cloudBaseY = clouds.position.y;
  const hazeBaseY = haze.position.y;
  return {
    update(elapsedSeconds) {
      clouds.position.y = cloudBaseY + Math.sin(elapsedSeconds * 0.16) * 0.16;
      clouds.rotation.y = Math.sin(elapsedSeconds * 0.025) * 0.006;
      haze.position.y = hazeBaseY + Math.sin(elapsedSeconds * 0.1 + 0.8) * 0.08;
      haze.rotation.y = -Math.sin(elapsedSeconds * 0.018) * 0.004;
      guardian.rotation.y = 0.12 + Math.sin(elapsedSeconds * 0.08) * 0.018;
    },
    dispose() {
      scene.remove(root);
      disposable.forEach((item) => item.dispose());
    },
  };
}
