import * as THREE from "three";
import {
  createInitialPitState,
  PIT_RADIUS,
  type PitMonument,
  type PitState,
  type StoneDescriptor,
} from "../shared/world.ts";
import {
  createPitFloorGeometry,
  createPitLipGeometry,
  createPitTurfGeometry,
  createPitWallGeometry,
  PIT_EDGE_SEGMENTS,
  PIT_LIP_OUTER_PHASE,
  PIT_LIP_OUTER_RADIUS,
  pitEdgeRadius,
} from "./pit-geometry.ts";

/** One deliberately small palette keeps the action legible on a phone. */
export const WORLD_COLORS = {
  sky: 0xdde6d4,
  grass: 0xa8c19a,
  grassDark: 0x8fa988,
  leaf: 0x78957c,
  leafLight: 0x97b092,
  bark: 0x9e937a,
  earth: 0xb0a185,
  pit: 0x46543d,
  stone: [0xd3c8b4, 0xbeb8a6, 0xe0d3bc, 0xaaa994],
  gold: 0xe8c77c,
} as const;

type Disposable = { dispose(): void };
type StoneMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export type WaitingWorld = {
  root: THREE.Group;
  ground: THREE.Mesh;
  pitTarget: THREE.Mesh;
  stones: Map<string, StoneMesh>;
  setStone(descriptor: StoneDescriptor, visible?: boolean): StoneMesh;
  setPit(pit: PitState): void;
  highlightStone(id: string | null): void;
  burst(x: number, z: number, kind?: "deposit" | "monument"): void;
  update(elapsedSeconds: number, playerX?: number, playerZ?: number): void;
  dispose(): void;
};

function randomSequence(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A real opening, so recessed rocks and the inner wall are never hidden. */
function meadowGeometry(pit: Pick<PitState, "center" | "radius">, originX = 0, originZ = 0, extent = 384) {
  const shape = new THREE.Shape();
  shape.moveTo(originX - extent, -originZ - extent);
  shape.lineTo(originX + extent, -originZ - extent);
  shape.lineTo(originX + extent, -originZ + extent);
  shape.lineTo(originX - extent, -originZ + extent);
  shape.closePath();
  const scale = pit.radius / PIT_RADIUS;
  const holeExtent = (PIT_LIP_OUTER_RADIUS + 0.4) * scale;
  if (Math.abs(pit.center.x - originX) + holeExtent < extent && Math.abs(pit.center.z - originZ) + holeExtent < extent) {
    const hole = new THREE.Path();
    for (let index = 0; index <= PIT_EDGE_SEGMENTS; index += 1) {
      const wrapped = index % PIT_EDGE_SEGMENTS;
      const angle = wrapped / PIT_EDGE_SEGMENTS * Math.PI * 2;
      const radius = pitEdgeRadius(wrapped, PIT_LIP_OUTER_RADIUS, PIT_LIP_OUTER_PHASE) * scale;
      const x = pit.center.x + Math.cos(angle) * radius * 1.035;
      const z = pit.center.z + Math.sin(angle) * radius;
      if (index === 0) hole.moveTo(x, -z);
      else hole.lineTo(x, -z);
    }
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ShapeGeometry(shape, PIT_EDGE_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -0.022, 0);
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let index = 0; index < positions.count; index += 1) {
    uv.setXY(index, (positions.getX(index) - originX + extent) / (extent * 2), (positions.getZ(index) - originZ + extent) / (extent * 2));
  }
  geometry.computeBoundingBox();
  geometry.name = "waitland-meadow-with-pit-opening";
  return geometry;
}

/** Retained for tools that preview the shared pit geometry in isolation. */
export function createCentralMeadowGeometry() {
  return meadowGeometry(createInitialPitState(), 0, 0, 21);
}

function shadowTexture() {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  gradient.addColorStop(0, "rgba(45,61,39,0.32)");
  gradient.addColorStop(0.55, "rgba(45,61,39,0.14)");
  gradient.addColorStop(1, "rgba(45,61,39,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function monumentPlaque(monument: PitMonument) {
  const date = new Date(monument.completedAt).toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
  const label = `${monument.name} · ${monument.stoneCount.toLocaleString("en-US")} stones · ${date}`;
  const group = new THREE.Group();
  group.name = `monument-plaque-${monument.round}`;
  group.userData.label = label;
  group.position.set(0, 0.85, monument.radius * 0.75 + 1.1);
  if (typeof document === "undefined") return group;
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 208;
  const context = canvas.getContext("2d");
  if (!context) return group;
  context.fillStyle = "rgba(252,249,238,0.96)";
  context.beginPath();
  context.roundRect(8, 8, 752, 184, 35);
  context.fill();
  context.fillStyle = "#52654c";
  context.textAlign = "center";
  context.font = "600 40px system-ui, sans-serif";
  context.fillText(monument.name, 384, 80, 692);
  context.fillStyle = "#7a8370";
  context.font = "400 27px system-ui, sans-serif";
  context.fillText(`${monument.stoneCount.toLocaleString("en-US")} stones · ${date}`, 384, 131, 692);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(5.8, 1.57, 1);
  sprite.renderOrder = 3;
  group.add(sprite);
  return group;
}

function disposeObject(root: THREE.Object3D) {
  const disposed = new Set<Disposable>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return;
    if (object instanceof THREE.Mesh) disposed.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      disposed.add(material);
      if ("map" in material && material.map instanceof THREE.Texture) disposed.add(material.map);
    }
  });
  disposed.forEach((item) => item.dispose());
  return disposed;
}

/**
 * Everything except the people is geometry generated locally. No panorama,
 * scenery models, texture downloads, or postprocessing stand between arrival
 * and the first stone. Repeated scenery uses eight bounded instanced meshes.
 */
export function createWaitingWorld(scene: THREE.Scene): WaitingWorld {
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  scene.background = new THREE.Color(WORLD_COLORS.sky);
  scene.fog = new THREE.Fog(WORLD_COLORS.sky, 38, 115);
  const root = new THREE.Group();
  root.name = "waiting-world";
  scene.add(root);
  const hemisphere = new THREE.HemisphereLight(0xfff9e9, 0x829376, 1.75);
  root.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xffefd3, 2.4);
  sun.position.set(-24, 38, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 100;
  sun.shadow.normalBias = 0.04;
  sun.shadow.bias = -0.0001;
  sun.shadow.radius = 3;
  root.add(sun, sun.target);

  const roughMaterial = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const grassMaterial = roughMaterial(WORLD_COLORS.grass);
  let currentPit = createInitialPitState();
  let groundOriginX = 0;
  let groundOriginZ = 0;
  const ground = new THREE.Mesh(meadowGeometry(currentPit), grassMaterial);
  ground.name = "waitland-ground";
  ground.receiveShadow = true;
  root.add(ground);
  const pit = new THREE.Group();
  pit.name = "active-pit";
  root.add(pit);
  // An art-directed floor stays dark even under bright mobile tone mapping.
  // Its radial vertex shading reads as depth before the first rock arrives.
  const floorGeometry = createPitFloorGeometry();
  const floorColors = new Float32Array(floorGeometry.getAttribute("position").count * 3);
  const floorCenter = new THREE.Color(0x34432e);
  const floorEdge = new THREE.Color(WORLD_COLORS.pit);
  for (let index = 0; index < floorColors.length / 3; index += 1) {
    const color = index === 0 ? floorCenter : floorEdge;
    floorColors.set([color.r, color.g, color.b], index * 3);
  }
  floorGeometry.setAttribute("color", new THREE.BufferAttribute(floorColors, 3));
  const floorMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const wallMaterial = roughMaterial(0x776f53);
  wallMaterial.side = THREE.DoubleSide;
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  const wall = new THREE.Mesh(createPitWallGeometry(), wallMaterial);
  const lip = new THREE.Mesh(createPitLipGeometry(), roughMaterial(WORLD_COLORS.earth));
  const turf = new THREE.Mesh(createPitTurfGeometry(), grassMaterial);
  floor.name = "pit-floor";
  wall.name = "pit-wall";
  lip.name = "pit-lip";
  for (const mesh of [floor, wall, lip, turf]) {
    mesh.receiveShadow = true;
    pit.add(mesh);
  }
  const pitTarget = new THREE.Mesh(
    new THREE.CircleGeometry(PIT_RADIUS + 0.75, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  );
  pitTarget.name = "pit-click-target";
  pitTarget.position.y = 0.06;
  pitTarget.userData.pit = true;
  pit.add(pitTarget);

  const rockGeometry = new THREE.IcosahedronGeometry(0.46, 1);
  const rockPositions = rockGeometry.getAttribute("position");
  for (let index = 0; index < rockPositions.count; index += 1) {
    const x = rockPositions.getX(index);
    const y = rockPositions.getY(index);
    const z = rockPositions.getZ(index);
    // Continuous displacement preserves shared vertices and smooth normals.
    const swell = 1 + Math.sin(x * 13 + y * 5) * 0.055 + Math.cos(z * 11 - y * 4) * 0.06;
    rockPositions.setXYZ(index, x * swell, y * swell, z * swell);
  }
  rockGeometry.computeVertexNormals();
  rockGeometry.computeBoundingSphere();
  const stoneMaterials = WORLD_COLORS.stone.map(roughMaterial);
  const stoneRoot = new THREE.Group();
  stoneRoot.name = "pickable-stones";
  root.add(stoneRoot);
  const stones = new Map<string, StoneMesh>();
  const fill = new THREE.InstancedMesh(rockGeometry, stoneMaterials[0], 180);
  fill.name = "pit-contents";
  fill.count = 0;
  fill.receiveShadow = true;
  pit.add(fill);
  const rimPebbles = new THREE.InstancedMesh(rockGeometry, stoneMaterials[2], 26);
  rimPebbles.name = "pit-edge-pebbles";
  const transform = new THREE.Object3D();
  const setMatrix = (mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rotation = 0) => {
    transform.position.set(x, y, z);
    transform.scale.set(sx, sy, sz);
    transform.rotation.set(0, rotation, 0);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  };
  for (let index = 0; index < rimPebbles.count; index += 1) {
    const angle = index / rimPebbles.count * Math.PI * 2;
    const radius = PIT_RADIUS + 0.25 + Math.sin(index * 4.1) * 0.12;
    const size = 0.17 + (index % 4) * 0.05;
    setMatrix(rimPebbles, index, Math.cos(angle) * radius, -0.03, Math.sin(angle) * radius, size * 1.4, size * 0.55, size, angle);
  }
  rimPebbles.instanceMatrix.needsUpdate = true;
  pit.add(rimPebbles);

  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xfff9e8, transparent: true, opacity: 0.82, depthWrite: false });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.76, 48).rotateX(-Math.PI / 2), markerMaterial);
  marker.name = "stone-selection-ring";
  marker.visible = false;
  marker.renderOrder = 1;
  root.add(marker);
  let highlightedId: string | null = null;
  const monumentRoot = new THREE.Group();
  monumentRoot.name = "completed-monuments";
  root.add(monumentRoot);
  const monuments = new Map<number, THREE.Group>();
  const monumentBirths = new Map<number, number>();
  let elapsed = 0;
  let disposed = false;

  const addMonument = (monument: PitMonument) => {
    const group = new THREE.Group();
    group.name = `monument-${monument.round}`;
    group.userData.monument = { ...monument, center: { ...monument.center } };
    group.position.set(monument.center.x, 0, monument.center.z);
    const monumentStone = roughMaterial(0xdfd4be);
    const monumentAccent = roughMaterial(0xb0b9a0);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(monument.radius * 0.8, monument.radius * 0.9, 0.5, 40), roughMaterial(0xc6bfa9));
    base.position.y = 0.22;
    base.receiveShadow = true;
    group.add(base);
    const sculpture = new THREE.Group();
    sculpture.name = "stone-sculpture";
    sculpture.position.y = 0.45;
    group.add(sculpture);
    const piece = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0, accent = false) => {
      // Geometry is owned by each monument, allowing old landmarks to release
      // their resources without disposing the live pickable stone geometry.
      const mesh = new THREE.Mesh(rockGeometry.clone(), accent ? monumentAccent : monumentStone);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(0.09, monument.round * 0.7, tilt);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sculpture.add(mesh);
    };
    const style = (monument.round - 1) % 4;
    if (style === 0) {
      // A patient little stone person, sitting with its hands in its lap.
      piece(-0.62, 0.45, 0.25, 2.1, 0.85, 1.45, -0.12);
      piece(0.62, 0.45, 0.25, 2.1, 0.85, 1.45, 0.12);
      piece(0, 1.35, 0, 2.05, 2.5, 1.35);
      piece(0, 2.95, 0, 1.8, 1.8, 1.6, -0.08);
      piece(-0.87, 1.4, 0.37, 0.65, 1.65, 0.8, -0.48);
      piece(0.87, 1.4, 0.37, 0.65, 1.65, 0.8, 0.48);
      piece(0, 0.99, 0.83, 1.3, 0.55, 0.65, 0, true);
    } else if (style === 1) {
      // An impossible, pleasing balance of smooth river stones.
      piece(0, 0.45, 0, 3.8, 0.9, 2.5);
      piece(-0.13, 1.35, 0, 2.4, 1.25, 1.85, -0.15);
      piece(0.2, 2.27, 0, 3.1, 0.95, 1.6, 0.14);
      piece(-0.2, 3.16, 0, 1.7, 1.2, 1.4, -0.19);
      piece(0.03, 4.04, 0, 1.06, 0.94, 1.03, 0, true);
    } else if (style === 2) {
      // A doorway made together, with daylight visible through the middle.
      for (let index = 0; index < 3; index += 1) {
        piece(-1.35, 0.55 + index * 0.85, 0, 1.7, 1.4, 1.6, 0.08 * (index % 2));
        piece(1.35, 0.55 + index * 0.85, 0, 1.7, 1.4, 1.6, -0.08 * (index % 2));
      }
      piece(-0.79, 3.04, 0, 2.5, 1.17, 1.6, -0.34);
      piece(0.79, 3.04, 0, 2.5, 1.17, 1.6, 0.34);
      piece(0, 3.65, 0, 1.4, 1.13, 1.4, 0, true);
    } else {
      // A friendly stone bird surveying the next patch of waiting.
      piece(0, 0.4, 0, 3.4, 0.9, 2.25);
      piece(0, 1.75, 0, 2.7, 2.85, 1.9);
      piece(0.45, 3.1, 0, 1.9, 1.55, 1.8);
      piece(1.27, 3.03, 0.14, 1.25, 0.4, 0.64, -0.1, true);
      piece(-0.38, 1.94, 0.79, 1.5, 1.9, 0.45, -0.6, true);
      piece(-1.08, 1.14, -0.14, 1.9, 0.9, 0.8, -0.45);
    }
    group.add(monumentPlaque(monument));
    monuments.set(monument.round, group);
    monumentRoot.add(group);
    return group;
  };

  // Fixed instance capacities prevent long walks from growing the scene.
  const scenery = new THREE.Group();
  scenery.name = "meadow-scenery";
  root.add(scenery);
  const leafGeometry = new THREE.IcosahedronGeometry(1, 2);
  const trunkGeometry = new THREE.CylinderGeometry(0.11, 0.2, 1, 7);
  const foliage = new THREE.InstancedMesh(leafGeometry, roughMaterial(WORLD_COLORS.leaf), 84);
  const trunks = new THREE.InstancedMesh(trunkGeometry, roughMaterial(WORLD_COLORS.bark), 28);
  const bushes = new THREE.InstancedMesh(leafGeometry, roughMaterial(WORLD_COLORS.leafLight), 72);
  const grassGeometry = new THREE.BufferGeometry();
  grassGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.12, 0, 0, 0.04, 0.48, 0, 0.1, 0, 0,
    0, 0, -0.12, 0, 0.38, -0.07, 0, 0, 0.13,
  ], 3));
  grassGeometry.computeVertexNormals();
  const tuftMaterial = roughMaterial(WORLD_COLORS.grassDark);
  tuftMaterial.side = THREE.DoubleSide;
  const grass = new THREE.InstancedMesh(grassGeometry, tuftMaterial, 440);
  const flowerGeometry = new THREE.IcosahedronGeometry(0.1, 0);
  const flowers = new THREE.InstancedMesh(flowerGeometry, roughMaterial(0xf3e6bf), 160);
  const shadowMap = shadowTexture();
  const contactMaterial = new THREE.MeshBasicMaterial({ map: shadowMap, color: shadowMap ? 0xffffff : 0x778267, transparent: true, opacity: shadowMap ? 1 : 0.12, depthWrite: false });
  const contactGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const sceneryShadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, 100);
  const stoneShadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, 96);
  stoneShadows.count = 0;
  stoneShadows.name = "stone-contact-shadows";
  root.add(stoneShadows);
  foliage.name = "meadow-tree-canopies";
  trunks.name = "meadow-tree-trunks";
  bushes.name = "meadow-bushes";
  grass.name = "meadow-grass-tufts";
  flowers.name = "meadow-flowers";
  sceneryShadows.name = "meadow-contact-shadows";
  scenery.add(foliage, trunks, bushes, grass, flowers, sceneryShadows);
  let sceneryTile = "";
  const isClear = (x: number, z: number, clearance: number) => {
    if (Math.hypot(x - currentPit.center.x, z - currentPit.center.z) < currentPit.radius + clearance) return false;
    for (const monument of currentPit.monuments) {
      if (Math.hypot(x - monument.center.x, z - monument.center.z) < monument.radius + clearance) return false;
    }
    return true;
  };
  const populateScenery = (playerX: number, playerZ: number) => {
    const tileX = Math.floor(playerX / 24);
    const tileZ = Math.floor(playerZ / 24);
    const key = `${tileX}:${tileZ}:${currentPit.round}`;
    if (key === sceneryTile) return;
    sceneryTile = key;
    const seed = Math.imul(tileX + 673, 0x45d9f3b) ^ Math.imul(tileZ - 137, 0x119de1f3);
    const random = randomSequence(seed);
    const originX = tileX * 24 + 12;
    const originZ = tileZ * 24 + 12;
    let treeCount = 0;
    let bushCount = 0;
    let shadowCount = 0;
    for (let index = 0; index < trunks.instanceMatrix.count; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 29 + random() * 60;
      const x = originX + Math.cos(angle) * radius;
      const z = originZ + Math.sin(angle) * radius;
      if (!isClear(x, z, 20)) continue;
      const size = 1.45 + random() * 1.45;
      setMatrix(trunks, treeCount, x, size * 1.1, z, size, size * 2.2, size);
      setMatrix(foliage, treeCount * 3, x, size * 2.7, z, size * 1.35, size * 1.4, size * 1.2, random() * 2);
      setMatrix(foliage, treeCount * 3 + 1, x - size * 0.68, size * 2.18, z + size * 0.18, size, size * 1.12, size, random() * 2);
      setMatrix(foliage, treeCount * 3 + 2, x + size * 0.77, size * 2.37, z - size * 0.07, size * 0.88, size * 1.04, size * 0.94, random() * 2);
      for (let leaf = 0; leaf < 3; leaf += 1) foliage.setColorAt(treeCount * 3 + leaf, new THREE.Color().setHSL(0.29 + random() * 0.03, 0.17, 0.68 + random() * 0.13));
      setMatrix(sceneryShadows, shadowCount++, x + 0.8, -0.013, z - 0.5, size * 4.8, 1, size * 3.6);
      treeCount += 1;
    }
    for (let index = 0; index < bushes.instanceMatrix.count; index += 1) {
      const x = originX + (random() - 0.5) * 140;
      const z = originZ + (random() - 0.5) * 140;
      if (!isClear(x, z, 19)) continue;
      const size = 0.45 + random() * 0.85;
      setMatrix(bushes, bushCount++, x, size * 0.46, z, size * 1.35, size * 0.72, size, random() * 3);
      setMatrix(sceneryShadows, shadowCount++, x, -0.012, z, size * 3.4, 1, size * 2.8);
    }
    let grassCount = 0;
    let flowerCount = 0;
    for (let index = 0; index < grass.instanceMatrix.count; index += 1) {
      const x = originX + (random() - 0.5) * 122;
      const z = originZ + (random() - 0.5) * 122;
      if (!isClear(x, z, 1.2)) continue;
      const size = 0.6 + random() * 0.75;
      setMatrix(grass, grassCount++, x, 0, z, size, size, size, random() * Math.PI);
      if (random() > 0.63 && flowerCount < flowers.instanceMatrix.count) {
        setMatrix(flowers, flowerCount++, x + 0.06, size * 0.36, z, size, size * 0.6, size);
      }
    }
    foliage.count = treeCount * 3;
    trunks.count = treeCount;
    bushes.count = bushCount;
    grass.count = grassCount;
    flowers.count = flowerCount;
    sceneryShadows.count = shadowCount;
    for (const mesh of [foliage, trunks, bushes, grass, flowers, sceneryShadows]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  };

  const particleGeometry = new THREE.IcosahedronGeometry(0.09, 0);
  const particleMaterial = new THREE.MeshBasicMaterial({ color: 0xfff4d1 });
  const particles = new THREE.InstancedMesh(particleGeometry, particleMaterial, 96);
  particles.name = "celebration-particles";
  particles.count = 0;
  particles.frustumCulled = false;
  root.add(particles);
  const particleStates: { x: number; z: number; vx: number; vz: number; vy: number; born: number; life: number }[] = [];
  const burst = (x: number, z: number, kind: "deposit" | "monument" = "deposit") => {
    const count = kind === "monument" ? 52 : 12;
    const random = randomSequence(Math.floor(elapsed * 1000) + Math.floor(x * 971 + z * 283));
    for (let index = 0; index < count; index += 1) {
      const angle = random() * Math.PI * 2;
      const speed = (kind === "monument" ? 2.8 : 1) * (0.6 + random());
      particleStates.push({ x, z, vx: Math.cos(angle) * speed, vz: Math.sin(angle) * speed, vy: (kind === "monument" ? 5.8 : 3.2) + random() * 2, born: elapsed, life: kind === "monument" ? 2.2 : 1.1 });
    }
    if (particleStates.length > 96) particleStates.splice(0, particleStates.length - 96);
  };

  const setPit = (next: PitState) => {
    const changedLayout = currentPit.round !== next.round || currentPit.radius !== next.radius || currentPit.center.x !== next.center.x || currentPit.center.z !== next.center.z;
    const previousRound = currentPit.round;
    currentPit = { ...next, center: { ...next.center }, monuments: next.monuments.map((monument) => ({ ...monument, center: { ...monument.center } })) };
    pit.position.set(next.center.x, 0, next.center.z);
    pit.scale.set(next.radius / PIT_RADIUS, 1.9, next.radius / PIT_RADIUS);
    pit.userData.round = next.round;
    pit.userData.count = next.count;
    pit.userData.capacity = next.capacity;
    if (changedLayout) {
      ground.geometry.dispose();
      ground.geometry = meadowGeometry(next, groundOriginX, groundOriginZ);
      sceneryTile = "";
    }
    const fraction = Math.max(0, Math.min(1, next.count / Math.max(1, next.capacity)));
    const count = next.count === 0 ? 0 : Math.max(1, Math.round(fraction * 180));
    const random = randomSequence(0x57414954 + next.round);
    for (let index = 0; index < count; index += 1) {
      const angle = index * 2.399963229728653;
      const ring = Math.sqrt((index + 0.5) / 180) * (PIT_RADIUS - 0.57);
      const size = 0.55 + random() * 0.3;
      const y = -0.75 + Math.max(0, fraction - 0.55) * 0.9 + random() * 0.04;
      setMatrix(fill, index, Math.cos(angle) * ring, y, Math.sin(angle) * ring, size, size * 0.62, size, angle);
      fill.setColorAt(index, new THREE.Color(WORLD_COLORS.stone[index % WORLD_COLORS.stone.length]));
    }
    fill.count = count;
    fill.instanceMatrix.needsUpdate = true;
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    fill.computeBoundingSphere();
    const visibleRounds = new Set(next.monuments.map((monument) => monument.round));
    for (const [round, monument] of monuments) {
      if (visibleRounds.has(round)) continue;
      monumentRoot.remove(monument);
      disposeObject(monument);
      monuments.delete(round);
      monumentBirths.delete(round);
    }
    for (const monument of next.monuments) {
      if (monuments.has(monument.round)) continue;
      const group = addMonument(monument);
      if (next.round > previousRound && monument.round === previousRound && elapsed > 0) {
        monumentBirths.set(monument.round, elapsed);
        group.scale.setScalar(0.01);
        burst(monument.center.x, monument.center.z, "monument");
      }
    }
  };

  setPit(currentPit);
  populateScenery(0, 0);
  return {
    root,
    ground,
    pitTarget,
    stones,
    setStone(descriptor, visible = true) {
      let mesh = stones.get(descriptor.id);
      if (!mesh) {
        mesh = new THREE.Mesh(rockGeometry, stoneMaterials[Math.abs(descriptor.material) % stoneMaterials.length]);
        mesh.name = descriptor.id;
        mesh.userData.stoneId = descriptor.id;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        stones.set(descriptor.id, mesh);
        stoneRoot.add(mesh);
      }
      mesh.material = stoneMaterials[Math.abs(descriptor.material) % stoneMaterials.length];
      mesh.position.set(descriptor.x, 0.27 * descriptor.scaleY, descriptor.z);
      mesh.rotation.set(descriptor.rotationX * 0.22, descriptor.rotationY, descriptor.rotationZ * 0.22);
      mesh.scale.set(descriptor.scaleX, descriptor.scaleY, descriptor.scaleZ);
      mesh.visible = visible;
      mesh.userData.descriptor = { ...descriptor };
      return mesh;
    },
    setPit,
    highlightStone(id) {
      highlightedId = id;
      marker.visible = id !== null && !!stones.get(id)?.visible;
    },
    burst,
    update(elapsedSeconds, playerX = 0, playerZ = 0) {
      if (disposed) return;
      elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : elapsed;
      const safeX = Number.isFinite(playerX) ? playerX : 0;
      const safeZ = Number.isFinite(playerZ) ? playerZ : 0;
      sun.position.set(safeX - 24, 38, safeZ + 18);
      sun.target.position.set(safeX, 0, safeZ);
      const nextOriginX = Math.round(safeX / 128) * 128;
      const nextOriginZ = Math.round(safeZ / 128) * 128;
      if (nextOriginX !== groundOriginX || nextOriginZ !== groundOriginZ) {
        groundOriginX = nextOriginX;
        groundOriginZ = nextOriginZ;
        ground.geometry.dispose();
        ground.geometry = meadowGeometry(currentPit, groundOriginX, groundOriginZ);
      }
      populateScenery(safeX, safeZ);
      const selected = highlightedId ? stones.get(highlightedId) : undefined;
      marker.visible = !!selected?.visible;
      if (selected?.visible) {
        marker.position.set(selected.position.x, 0.012, selected.position.z);
        marker.scale.setScalar(1 + Math.sin(elapsed * 3) * 0.045);
        markerMaterial.opacity = 0.68 + Math.sin(elapsed * 3) * 0.12;
      }
      let shadowCount = 0;
      for (const stone of stones.values()) {
        if (!stone.visible || stone.position.y > 0.8 || shadowCount >= stoneShadows.instanceMatrix.count) continue;
        const size = 1.2 * Math.max(stone.scale.x, stone.scale.z);
        setMatrix(stoneShadows, shadowCount++, stone.position.x + 0.09, -0.01, stone.position.z - 0.06, size, 1, size * 0.78);
      }
      stoneShadows.count = shadowCount;
      stoneShadows.instanceMatrix.needsUpdate = true;
      stoneShadows.computeBoundingSphere();
      for (const [round, born] of monumentBirths) {
        const progress = Math.min(1, Math.max(0, (elapsed - born) / 1.65));
        const eased = 1 - Math.pow(1 - progress, 3);
        monuments.get(round)?.scale.setScalar(Math.max(0.01, eased));
        if (progress >= 1) monumentBirths.delete(round);
      }
      let particleCount = 0;
      for (let index = particleStates.length - 1; index >= 0; index -= 1) {
        const particle = particleStates[index];
        const age = elapsed - particle.born;
        if (age > particle.life || age < 0) {
          particleStates.splice(index, 1);
          continue;
        }
        const scale = Math.max(0, 1 - age / particle.life);
        setMatrix(particles, particleCount++, particle.x + particle.vx * age, Math.max(0.03, 0.1 + particle.vy * age - 4.2 * age * age), particle.z + particle.vz * age, scale, scale, scale, age * 3);
      }
      particles.count = particleCount;
      particles.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      const released = disposeObject(root);
      for (const material of stoneMaterials) {
        if (!released.has(material)) material.dispose();
      }
      // InstancedMesh owns renderer-side matrix buffers in addition to geometry.
      root.traverse((object) => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
      sun.shadow.dispose();
      stones.clear();
      monuments.clear();
      particleStates.length = 0;
      scene.background = previousBackground;
      scene.fog = previousFog;
    },
  };
}

export type StorybookWorld = Pick<WaitingWorld, "update" | "dispose">;
export const createStorybookWorld = createWaitingWorld;
