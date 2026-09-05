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
  sky: 0xd7dec4,
  grass: 0xaebb94,
  grassDark: 0x7c9165,
  leaf: 0x4f6b49,
  leafLight: 0x72895b,
  bark: 0x8d7354,
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
  readonly monuments: ReadonlyMap<number, THREE.Group>;
  setStone(descriptor: StoneDescriptor, visible?: boolean): StoneMesh;
  setPit(pit: PitState): void;
  highlightStone(id: string | null): void;
  burst(x: number, z: number, kind?: "deposit" | "monument"): void;
  update(elapsedSeconds: number, playerX?: number, playerZ?: number, viewAngle?: number): void;
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

/** A softly irregular painted shape for moss beds and worn paths. */
function parkPatchGeometry() {
  const geometry = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  for (let index = 1; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const angle = Math.atan2(z, x);
    const radius = 1 + Math.sin(angle * 3 + 0.4) * 0.1 + Math.sin(angle * 5 - 0.8) * 0.045;
    positions.setXYZ(index, x * radius, 0, z * radius);
  }
  geometry.computeBoundingSphere();
  return geometry;
}

function parkPathGeometry(points: readonly THREE.Vector3[], width: number) {
  const curve = new THREE.CatmullRomCurve3([...points]);
  const positions: number[] = [];
  const indices: number[] = [];
  const segments = 64;
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const ripple = 1 + Math.sin(t * 31) * 0.035 + Math.cos(t * 17) * 0.035;
    const halfWidth = width * 0.5 * ripple;
    const normalX = -tangent.z;
    const normalZ = tangent.x;
    positions.push(point.x + normalX * halfWidth, -0.007, point.z + normalZ * halfWidth,
      point.x - normalX * halfWidth, -0.007, point.z - normalZ * halfWidth);
    if (index < segments) {
      const vertex = index * 2;
      indices.push(vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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
  const hemisphere = new THREE.HemisphereLight(0xf0f5f0, 0x637455, 1.55);
  root.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.45);
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
  sun.shadow.radius = 4;
  root.add(sun, sun.target);

  const roughMaterial = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const grassMaterial = roughMaterial(WORLD_COLORS.grass);
  grassMaterial.color.multiply(new THREE.Color().setRGB(0.7, 0.82, 0.88));
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
  const rimPebbles = new THREE.InstancedMesh(rockGeometry, stoneMaterials[2], 11);
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
    const angle = index < 6 ? -2.8 + index * 0.21 : 0.35 + (index - 6) * 0.28;
    const radius = PIT_RADIUS + 0.23 + Math.sin(index * 4.1) * 0.13;
    const size = 0.33 + (index % 4) * 0.075;
    setMatrix(rimPebbles, index, Math.cos(angle) * radius, -0.022, Math.sin(angle) * radius, size * 1.25, size * 0.38, size, angle);
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
    group.userData.monumentRound = monument.round;
    group.position.set(monument.center.x, 0, monument.center.z);
    const style = (monument.round - 1) % 4;
    const monumentStone = roughMaterial([0x847b65, 0x786e5a, 0x95856b, 0x718071][style]);
    const monumentAccent = roughMaterial(0xc0b397);
    const baseMaterial = roughMaterial(0xb9ad91);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(monument.radius * 0.69, monument.radius * 0.78, 0.58, 32), baseMaterial);
    base.position.y = 0.28;
    base.receiveShadow = true;
    base.castShadow = true;
    group.add(base);
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(monument.radius * 0.76, monument.radius * 0.79, 0.15, 32), roughMaterial(0xd5c9aa));
    edge.position.y = 0.1;
    edge.receiveShadow = true;
    group.add(edge);
    const sculpture = new THREE.Group();
    sculpture.name = "stone-sculpture";
    sculpture.position.y = 0.54;
    sculpture.scale.setScalar(Math.min(1.45, 1 + (monument.round - 1) * 0.065));
    group.add(sculpture);
    const piece = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0, accent = false) => {
      const mesh = new THREE.Mesh(rockGeometry.clone(), accent ? monumentAccent : monumentStone);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(0.025, 0.15, tilt);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sculpture.add(mesh);
      return mesh;
    };
    if (style === 0) {
      // The first statue is unmistakably someone resting: folded legs, one
      // hand in the lap, and a tilted head resting against the other hand.
      piece(-0.71, 0.5, 0.45, 2.5, 1, 1.7, -0.15);
      piece(0.71, 0.5, 0.45, 2.5, 1, 1.7, 0.15);
      piece(0.12, 2.04, 0, 2.9, 3.45, 1.85, -0.07);
      piece(-0.22, 4.18, 0.08, 2.15, 2.08, 1.93, -0.15);
      piece(1.12, 1.93, 0.23, 0.85, 2.55, 0.95, 0.31);
      piece(-1.04, 2.48, 0.57, 0.83, 2.42, 0.85, -0.31);
      piece(-0.62, 3.46, 0.6, 0.74, 1.13, 0.85, -0.26);
      piece(0.36, 1.03, 1.04, 1.4, 0.68, 0.9, -0.1, true);
      // Carved closed eyes make the gesture legible in a close-up.
      const faceMaterial = roughMaterial(0x514d3f);
      for (const x of [-0.47, 0.01]) {
        const eye = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.19, 3, 6), faceMaterial);
        eye.rotation.z = Math.PI / 2 - 0.12;
        eye.position.set(x, 4.23, 0.91);
        sculpture.add(eye);
      }
    } else if (style === 1) {
      // Wide, off-centre stones look improbable, like a small act of trust.
      piece(0, 0.47, 0, 4.05, 1.02, 2.7, 0.05);
      piece(-0.46, 1.48, 0.03, 2.36, 1.62, 2.15, -0.19);
      piece(0.36, 2.62, 0.02, 4.1, 1.12, 2.03, 0.13);
      piece(0.81, 3.66, 0, 1.72, 1.54, 1.53, 0.18);
      piece(0.44, 4.75, 0, 2.38, 0.99, 1.46, -0.2);
      piece(-0.03, 5.38, 0, 0.87, 0.73, 0.91, 0, true);
    } else if (style === 2) {
      // The arch has clear negative space, broad shoulders and one keystone.
      for (let index = 0; index < 3; index += 1) {
        piece(-1.57, 0.63 + index * 1.12, 0, 1.84, 1.7, 2.02, -0.06 + index * 0.02);
        piece(1.57, 0.63 + index * 1.12, 0, 1.84, 1.7, 2.02, 0.06 - index * 0.02);
      }
      piece(-0.94, 4.02, 0, 2.65, 1.52, 1.89, -0.36);
      piece(0.94, 4.02, 0, 2.65, 1.52, 1.89, 0.36);
      piece(0, 4.91, 0, 1.46, 1.39, 1.73, 0, true);
    } else {
      // A broad, carved bird gives the park another recognizable silhouette.
      piece(0, 0.43, 0, 3.7, 0.95, 2.75);
      piece(-0.04, 2.04, 0, 3.1, 3.6, 2.5, -0.11);
      piece(0.55, 3.79, 0.02, 2.27, 1.98, 2.03, 0.1);
      piece(1.63, 3.76, 0.15, 1.58, 0.63, 0.8, -0.11, true);
      piece(-0.51, 2.19, 1.04, 1.71, 2.23, 0.49, -0.57, true);
      piece(-1.34, 1.11, -0.15, 2.01, 1.07, 1.01, -0.47);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.095, 8, 6), roughMaterial(0x344738));
      eye.position.set(0.73, 4.02, 0.85);
      sculpture.add(eye);
    }
    group.traverse((object) => { object.userData.monumentRound = monument.round; });
    group.updateMatrixWorld(true);
    group.userData.labelHeight = new THREE.Box3().setFromObject(group).max.y + 0.65;
    monuments.set(monument.round, group);
    monumentRoot.add(group);
    return group;
  };

  // Composition comes from a few planted groves, not uniform random scatter.
  // Geometry and instance capacities stay fixed on long walks.
  const scenery = new THREE.Group();
  scenery.name = "meadow-scenery";
  root.add(scenery);
  const leafGeometry = new THREE.IcosahedronGeometry(1, 1);
  const leafMaterial = roughMaterial(WORLD_COLORS.leaf);
  const trunkGeometry = new THREE.CylinderGeometry(0.15, 0.23, 1, 8);
  const foliage = new THREE.InstancedMesh(leafGeometry, leafMaterial, 84);
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  const trunks = new THREE.InstancedMesh(trunkGeometry, roughMaterial(WORLD_COLORS.bark), 28);
  trunks.castShadow = true;
  const bushes = new THREE.InstancedMesh(leafGeometry, roughMaterial(WORLD_COLORS.leafLight), 72);
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  const patchMaterial = new THREE.MeshBasicMaterial({ color: 0x738a59, transparent: true, opacity: 0.19, depthWrite: false, toneMapped: false });
  const patches = new THREE.InstancedMesh(parkPatchGeometry(), patchMaterial, 64);
  patches.name = "park-moss-beds";
  const shadowMap = shadowTexture();
  const contactMaterial = new THREE.MeshBasicMaterial({ map: shadowMap, color: shadowMap ? 0xffffff : 0x677455, transparent: true, opacity: shadowMap ? 1.25 : 0.15, depthWrite: false });
  const contactGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const sceneryShadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, 100);
  const stoneShadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, 96);
  stoneShadows.count = 0;
  stoneShadows.name = "stone-contact-shadows";
  root.add(stoneShadows);
  foliage.name = "meadow-tree-canopies";
  trunks.name = "meadow-tree-trunks";
  bushes.name = "meadow-bushes";
  sceneryShadows.name = "meadow-contact-shadows";
  scenery.add(patches, sceneryShadows, foliage, trunks, bushes);
  const paths = new THREE.Group();
  paths.name = "park-walking-paths";
  const pathMaterial = roughMaterial(0xc9bc99);
  pathMaterial.color.multiplyScalar(0.83);
  pathMaterial.transparent = true;
  pathMaterial.opacity = 0.65;
  pathMaterial.depthWrite = false;
  root.add(paths);
  const rebuildPaths = () => {
    for (const child of [...paths.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      paths.remove(child);
    }
    const c = currentPit.center;
    const approachZ = currentPit.radius + 3.6;
    const curves: THREE.Vector3[][] = [[
      new THREE.Vector3(c.x + 8, 0, c.z + 34),
      new THREE.Vector3(c.x + 6.5, 0, c.z + 23),
      new THREE.Vector3(c.x + 2.5, 0, c.z + 14),
      new THREE.Vector3(c.x + 0.8, 0, c.z + approachZ),
    ]];
    if (currentPit.monuments.length) {
      const recent = currentPit.monuments.slice(-4);
      curves.push([
        new THREE.Vector3(recent[0].center.x - 4, 0, recent[0].radius + 4.4),
        ...recent.map((monument) => new THREE.Vector3(monument.center.x, 0, monument.radius + 4.4)),
        new THREE.Vector3(c.x - 9, 0, approachZ + 0.5),
        new THREE.Vector3(c.x + 0.8, 0, approachZ),
      ]);
    }
    for (const [index, points] of curves.entries()) {
      const mesh = new THREE.Mesh(parkPathGeometry(points, index ? 2.4 : 2.7), pathMaterial);
      mesh.name = index ? "statue-promenade" : "meadow-entrance-path";
      mesh.receiveShadow = true;
      paths.add(mesh);
      // A worn trail terminates in a rounded patch of soil, never a floating
      // rectangular ribbon end beside the excavation.
      for (const end of [points[0], points[points.length - 1]]) {
        const cap = new THREE.Mesh(parkPatchGeometry(), pathMaterial);
        cap.name = "worn-path-end";
        cap.position.set(end.x, -0.008, end.z);
        cap.scale.set(index ? 1.2 : 1.35, 1, index ? 1.2 : 1.35);
        cap.receiveShadow = true;
        paths.add(cap);
      }
    }
  };
  let sceneryTile = "";
  let sceneryViewAngle = Math.atan2(9, 31);
  const isClear = (x: number, z: number, clearance: number) => {
    if (Math.hypot(x - currentPit.center.x, z - currentPit.center.z) < currentPit.radius + clearance) return false;
    for (const monument of currentPit.monuments) {
      if (Math.hypot(x - monument.center.x, z - monument.center.z) < monument.radius + clearance) return false;
    }
    return true;
  };
  const populateScenery = (playerX: number, playerZ: number) => {
    const tileX = Math.floor(playerX / 48);
    const tileZ = Math.floor(playerZ / 48);
    const viewBucket = Math.round(sceneryViewAngle / 0.08);
    const key = `${tileX}:${tileZ}:${currentPit.round}:${viewBucket}`;
    if (key === sceneryTile) return;
    sceneryTile = key;
    const sites = [currentPit, ...currentPit.monuments.slice().reverse()];
    const groves: { x: number; z: number; size: number; seed: number }[] = [];
    for (const site of sites) {
      if (Math.hypot(playerX - site.center.x, playerZ - site.center.z) > 68) continue;
      const margin = site.radius + 10.2;
      for (let index = 0; index < 8; index += 1) {
        const angle = index / 8 * Math.PI * 2 + 0.18;
        const x = Math.sin(angle) * margin;
        const z = Math.cos(angle) * margin;
        // Fixed park positions are shared by every visitor. Hide the near
        // foreground sector so a crown cannot sit over the local hero.
        const towardCamera = (x * Math.sin(sceneryViewAngle) + z * Math.cos(sceneryViewAngle)) / margin;
        if (towardCamera > 0.14) continue;
        groves.push({ x: site.center.x + x, z: site.center.z + z, size: 0.83 + (index % 3) * 0.12, seed: site.round * 71 + index * 37 });
      }
    }
    // Only travellers outside the sculptural park need the distant grove pool.
    if (!groves.length) {
      for (let index = 0; index < 6; index += 1) {
        const angle = index / 6 * Math.PI * 2 + 0.35;
        groves.push({ x: tileX * 48 + Math.cos(angle) * 38, z: tileZ * 48 + Math.sin(angle) * 38, size: 0.9 + (index % 3) * 0.15, seed: tileX * 673 + tileZ * 137 + index });
      }
    }
    let treeCount = 0;
    let bushCount = 0;
    let patchCount = 0;
    let shadowCount = 0;
    for (const grove of groves.slice(0, 9)) {
      if (!isClear(grove.x, grove.z, 4.5)) continue;
      const random = randomSequence(grove.seed);
      // Broad tonal beds tie each family of trees to a designed place.
      setMatrix(patches, patchCount++, grove.x, -0.015, grove.z, 6.5 * grove.size, 1, 4.7 * grove.size, 0.5 + random());
      setMatrix(patches, patchCount++, grove.x + 2, -0.014, grove.z - 2, 4.9 * grove.size, 1, 5.3 * grove.size, -0.4);
      for (const [index, offset] of [[0, 0], [-2.1, -2.6], [2.55, -1.6]].entries()) {
        if (treeCount >= trunks.instanceMatrix.count) break;
        const size = grove.size * [1.12, 0.78, 0.92][index];
        const x = grove.x + offset[0];
        const z = grove.z + offset[1];
        setMatrix(trunks, treeCount, x, size * 1.75, z, size, size * 3.5, size);
        // Taller hand-carved crowns with an off-centre shoulder, avoiding
        // identical spherical lollipop silhouettes.
        setMatrix(foliage, treeCount * 2, x - size * 0.15, size * 4.35, z, size * 1.65, size * 2.15, size * 1.46, -0.2 + random() * 0.4);
        setMatrix(foliage, treeCount * 2 + 1, x + size * 0.8, size * 3.52, z + size * 0.08, size * 1.13, size * 1.42, size * 1.05, 0.7);
        const tint = new THREE.Color().setHSL(0.23 + random() * 0.035, 0.12, 0.73 + random() * 0.13);
        foliage.setColorAt(treeCount * 2, tint);
        foliage.setColorAt(treeCount * 2 + 1, tint);
        setMatrix(sceneryShadows, shadowCount++, x + 1.4, -0.01, z - 0.4, size * 6.4, 1, size * 4.7);
        treeCount += 1;
      }
      // Shrubs occur in generous uneven families at the edges of groves.
      for (let index = 0; index < 4; index += 1) {
        if (bushCount >= bushes.instanceMatrix.count) break;
        const angle = 0.6 + index * 0.85;
        const size = grove.size * (0.65 + random() * 0.48);
        const x = grove.x + Math.cos(angle) * (3.4 + random());
        const z = grove.z + Math.sin(angle) * 2.8;
        setMatrix(bushes, bushCount++, x, size * 0.65, z, size * 1.35, size * 0.88, size, angle);
        setMatrix(sceneryShadows, shadowCount++, x, -0.009, z, size * 3.5, 1, size * 2.5);
      }
    }
    // Large, quiet color areas shape the meadow while leaving the action clear.
    for (const [x, z, sx, sz, angle] of [[-11, 12, 6.1, 4.2, -0.5], [14, 10, 5.3, 7.4, 0.4], [-18, -19, 9, 5.6, 0.1]]) {
      const px = currentPit.center.x + x;
      const pz = currentPit.center.z + z;
      if (isClear(px, pz, Math.min(sx, sz) * 0.8)) setMatrix(patches, patchCount++, px, -0.016, pz, sx, 1, sz, angle);
    }
    foliage.count = treeCount * 2;
    trunks.count = treeCount;
    bushes.count = bushCount;
    patches.count = patchCount;
    sceneryShadows.count = shadowCount;
    for (const mesh of [foliage, trunks, bushes, patches, sceneryShadows]) {
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
      rebuildPaths();
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
  rebuildPaths();
  populateScenery(0, 0);
  return {
    root,
    ground,
    pitTarget,
    stones,
    monuments,
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
    update(elapsedSeconds, playerX = 0, playerZ = 0, viewAngle = sceneryViewAngle) {
      if (disposed) return;
      elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : elapsed;
      const safeX = Number.isFinite(playerX) ? playerX : 0;
      const safeZ = Number.isFinite(playerZ) ? playerZ : 0;
      if (Number.isFinite(viewAngle)) sceneryViewAngle = viewAngle;
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
