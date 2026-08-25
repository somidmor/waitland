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

  const groundGeometry = remember(new THREE.CircleGeometry(FIELD_RADIUS + 22, 112));
  const groundMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0x8a8a50, roughness: 1, metalness: 0 }),
  );
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  const patchGeometry = remember(new THREE.CircleGeometry(1, 18));
  patchGeometry.rotateX(-Math.PI / 2);
  const patchMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0x65733f,
      transparent: true,
      opacity: 0.19,
      depthWrite: false,
    }),
  );
  const patches = new THREE.InstancedMesh(patchGeometry, patchMaterial, 52);
  patches.frustumCulled = false;
  const transform = new THREE.Object3D();
  for (let index = 0; index < patches.count; index += 1) {
    const radius = 7 + random() * (FIELD_RADIUS + 8);
    const angle = random() * Math.PI * 2;
    const size = 1.5 + random() * 4.2;
    setInstance(
      patches,
      index,
      transform,
      Math.cos(angle) * radius,
      0.012,
      Math.sin(angle) * radius,
      size,
      1,
      size * (0.42 + random() * 0.48),
      random() * Math.PI,
    );
  }
  patches.instanceMatrix.needsUpdate = true;
  root.add(patches);

  const grassGeometry = remember(new THREE.ConeGeometry(0.035, 0.34, 4));
  const grassMaterial = remember(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true }),
  );
  const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, 620);
  grass.frustumCulled = false;
  const grassColors = [new THREE.Color(0x596335), new THREE.Color(0x6f743a), new THREE.Color(0x858149)];
  for (let index = 0; index < grass.count; index += 1) {
    const radius = 6.7 + random() * (FIELD_RADIUS + 7);
    const angle = random() * Math.PI * 2;
    const height = 0.55 + random() * 1.1;
    setInstance(
      grass,
      index,
      transform,
      Math.cos(angle) * radius,
      0.16 * height,
      Math.sin(angle) * radius,
      0.7 + random() * 0.7,
      height,
      0.7 + random() * 0.7,
      random() * Math.PI,
    );
    grass.setColorAt(index, grassColors[index % grassColors.length]);
  }
  grass.instanceMatrix.needsUpdate = true;
  grass.instanceColor!.needsUpdate = true;
  root.add(grass);

  const flowerGeometry = remember(new THREE.SphereGeometry(0.065, 6, 4));
  const flowerMaterial = remember(
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
  );
  const flowers = new THREE.InstancedMesh(flowerGeometry, flowerMaterial, 250);
  flowers.frustumCulled = false;
  const flowerColors = [
    new THREE.Color(0xf6e4a2),
    new THREE.Color(0xf7eee0),
    new THREE.Color(0xd9ba66),
    new THREE.Color(0xe9c8a4),
  ];
  for (let index = 0; index < flowers.count; index += 1) {
    const radius = 7 + random() * (FIELD_RADIUS + 5);
    const angle = random() * Math.PI * 2;
    const size = 0.72 + random() * 0.7;
    setInstance(
      flowers,
      index,
      transform,
      Math.cos(angle) * radius,
      0.17 + random() * 0.13,
      Math.sin(angle) * radius,
      size,
      size * 0.7,
      size,
    );
    flowers.setColorAt(index, flowerColors[index % flowerColors.length]);
  }
  flowers.instanceMatrix.needsUpdate = true;
  flowers.instanceColor!.needsUpdate = true;
  root.add(flowers);

  const hillGeometry = remember(new THREE.SphereGeometry(1, 18, 9));
  const hillMaterials = [
    remember(new THREE.MeshStandardMaterial({ color: 0x8a8751, roughness: 1 })),
    remember(new THREE.MeshStandardMaterial({ color: 0x797b48, roughness: 1 })),
    remember(new THREE.MeshStandardMaterial({ color: 0x99905a, roughness: 1 })),
  ];
  for (let index = 0; index < 13; index += 1) {
    const angle = (index / 13) * Math.PI * 2 + 0.12;
    const hill = new THREE.Mesh(hillGeometry, hillMaterials[index % hillMaterials.length]);
    const radius = FIELD_RADIUS + 16 + (index % 3) * 5;
    hill.position.set(Math.cos(angle) * radius, -2.8, Math.sin(angle) * radius);
    hill.scale.set(14 + random() * 13, 4.3 + random() * 4, 10 + random() * 10);
    hill.rotation.y = random() * Math.PI;
    hill.receiveShadow = true;
    root.add(hill);
  }

  const cloudGeometry = remember(new THREE.SphereGeometry(1, 12, 8));
  const cloudMaterial = remember(
    new THREE.MeshBasicMaterial({
      color: 0xffe9bd,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      fog: true,
    }),
  );
  const clouds = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, 24);
  clouds.frustumCulled = false;
  for (let index = 0; index < clouds.count; index += 1) {
    const cluster = Math.floor(index / 4);
    const petal = index % 4;
    const baseAngle = 3.45 + cluster * 0.54;
    const baseRadius = 72 + cluster * 4;
    const size = 1.8 + ((cluster + petal) % 3) * 0.6;
    setInstance(
      clouds,
      index,
      transform,
      Math.cos(baseAngle) * baseRadius + (petal - 1.5) * 2.1,
      13 + (petal % 2) * 1.05 + cluster * 0.28,
      Math.sin(baseAngle) * baseRadius,
      size * 1.55,
      size,
      size,
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
  return {
    update(elapsedSeconds) {
      clouds.position.y = cloudBaseY + Math.sin(elapsedSeconds * 0.16) * 0.16;
      guardian.rotation.y = 0.12 + Math.sin(elapsedSeconds * 0.08) * 0.018;
    },
    dispose() {
      scene.remove(root);
      disposable.forEach((item) => item.dispose());
    },
  };
}
