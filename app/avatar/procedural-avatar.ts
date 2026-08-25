import * as THREE from "three";
import {
  createAvatarAppearance,
  type AvatarAccessoryId,
  type AvatarAppearance,
  type AvatarBaseId,
  type AvatarBottomId,
  type AvatarHairId,
  type AvatarShoeId,
  type AvatarTopId,
} from "../avatar-design.ts";

export type ProceduralAvatarPose = {
  /** Absolute animation time keeps the pose deterministic across frame rates. */
  elapsedSeconds?: number;
  /** Optional caller-owned phase, useful when synchronizing network avatars. */
  walkPhase?: number;
  moving?: boolean;
  /** Normalized 0..1 locomotion intensity. */
  speed?: number;
  carryingStone?: boolean;
  /** Overrides the generated walk bob when supplied. */
  bob?: number;
  lookYaw?: number;
  lookPitch?: number;
  lean?: number;
};

export type ProceduralAvatarMaterials = Readonly<{
  skin: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  top: THREE.MeshStandardMaterial;
  topAccent: THREE.MeshStandardMaterial;
  bottom: THREE.MeshStandardMaterial;
  bottomAccent: THREE.MeshStandardMaterial;
  shoes: THREE.MeshStandardMaterial;
  shoeAccent: THREE.MeshStandardMaterial;
  accessory: THREE.MeshStandardMaterial;
  accessoryAccent: THREE.MeshStandardMaterial;
  face: THREE.MeshBasicMaterial;
  cheeks: THREE.MeshBasicMaterial;
  shadow: THREE.MeshBasicMaterial;
}>;

export type ProceduralAvatarAnchors = Readonly<{
  head: THREE.Group;
  heldItem: THREE.Group;
  speech: THREE.Group;
}>;

export type ProceduralAvatar = {
  readonly root: THREE.Group;
  readonly materials: ProceduralAvatarMaterials;
  readonly anchors: ProceduralAvatarAnchors;
  readonly appearance: AvatarAppearance;
  setAppearance: (appearance: Partial<AvatarAppearance>) => AvatarAppearance;
  updatePose: (pose: ProceduralAvatarPose) => void;
  dispose: () => void;
};

export type ProceduralAvatarOptions = {
  seed?: string;
  appearance?: Partial<AvatarAppearance>;
  name?: string;
  scale?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  groundShadow?: boolean;
};

type ModuleRegistry<Id extends string> = Map<Id, THREE.Object3D[]>;

const BASE_SCALE: Record<AvatarBaseId, readonly [number, number, number]> = {
  "soft-rounded": [1, 1, 1],
  "compact-sturdy": [1.08, 0.96, 1.04],
  "gentle-tall": [0.92, 1.06, 0.96],
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function owns(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function showModule<Id extends string>(registry: ModuleRegistry<Id>, activeId: Id) {
  for (const [id, objects] of registry) {
    const visible = id === activeId;
    for (const object of objects) object.visible = visible;
  }
}

/**
 * Builds one low-poly local avatar. All variants share one compact rig and one
 * material set; inactive modules are hidden and therefore add no draw calls.
 * Remote crowds should continue to use the instanced renderer.
 */
export function createProceduralAvatar(options: ProceduralAvatarOptions = {}): ProceduralAvatar {
  const seed = options.seed?.trim() || "waitland-wanderer";
  let appearance = createAvatarAppearance(seed, options.appearance);
  let disposed = false;

  const geometries = new Set<THREE.BufferGeometry>();
  const disposableMaterials = new Set<THREE.Material>();
  const rememberMaterial = <T extends THREE.Material>(material: T) => {
    disposableMaterials.add(material);
    return material;
  };

  const materials: ProceduralAvatarMaterials = {
    skin: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.94, metalness: 0 }),
    ),
    hair: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.hair, roughness: 0.98, metalness: 0 }),
    ),
    top: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.sweater, roughness: 0.97, metalness: 0 }),
    ),
    topAccent: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.sweater, roughness: 1, metalness: 0 }),
    ),
    bottom: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.trousers, roughness: 0.98, metalness: 0 }),
    ),
    bottomAccent: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.trousers, roughness: 1, metalness: 0 }),
    ),
    shoes: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.shoes, roughness: 0.98, metalness: 0 }),
    ),
    shoeAccent: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.shoes, roughness: 1, metalness: 0 }),
    ),
    accessory: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: 0x654a37, roughness: 0.98, metalness: 0 }),
    ),
    accessoryAccent: rememberMaterial(
      new THREE.MeshStandardMaterial({ color: appearance.sweater, roughness: 1, metalness: 0 }),
    ),
    face: rememberMaterial(new THREE.MeshBasicMaterial({ color: 0x2b211b })),
    cheeks: rememberMaterial(
      new THREE.MeshBasicMaterial({ color: 0xc97963, transparent: true, opacity: 0.3 }),
    ),
    shadow: rememberMaterial(
      new THREE.MeshBasicMaterial({
        color: 0x302714,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    ),
  };

  const root = new THREE.Group();
  root.name = options.name ?? "waitland-procedural-avatar";
  root.scale.setScalar(options.scale ?? 1);

  const poseRoot = new THREE.Group();
  poseRoot.name = "avatar-pose-root";
  root.add(poseRoot);

  const silhouette = new THREE.Group();
  silhouette.name = "avatar-silhouette";
  poseRoot.add(silhouette);

  const makeGroup = (parent: THREE.Object3D, name: string) => {
    const group = new THREE.Group();
    group.name = name;
    parent.add(group);
    return group;
  };

  const makeMesh = <G extends THREE.BufferGeometry, M extends THREE.Material>(
    parent: THREE.Object3D,
    geometry: G,
    material: M,
    name: string,
  ) => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? false;
    parent.add(mesh);
    return mesh;
  };

  const leftArm = makeGroup(silhouette, "left-arm-rig");
  const rightArm = makeGroup(silhouette, "right-arm-rig");
  leftArm.position.set(-0.55, 1.78, 0);
  rightArm.position.set(0.55, 1.78, 0);

  const leftLeg = makeGroup(silhouette, "left-leg-rig");
  const rightLeg = makeGroup(silhouette, "right-leg-rig");
  leftLeg.position.set(-0.2, 0.92, 0);
  rightLeg.position.set(0.2, 0.92, 0);

  const handGeometry = new THREE.SphereGeometry(0.145, 10, 7);
  const leftHand = makeMesh(leftArm, handGeometry, materials.skin, "left-hand");
  const rightHand = makeMesh(rightArm, handGeometry, materials.skin, "right-hand");
  leftHand.position.set(0, -0.73, -0.015);
  rightHand.position.copy(leftHand.position);
  leftHand.scale.set(0.92, 1.04, 0.9);
  rightHand.scale.copy(leftHand.scale);

  const head = makeGroup(silhouette, "head-rig");
  head.position.set(0, 2.42, -0.02);
  const headMesh = makeMesh(
    head,
    new THREE.SphereGeometry(0.45, 16, 12),
    materials.skin,
    "head",
  );
  headMesh.scale.set(1, 1.02, 0.98);

  const eyeGeometry = new THREE.SphereGeometry(0.038, 8, 6);
  for (const side of [-1, 1]) {
    const eye = makeMesh(head, eyeGeometry, materials.face, side < 0 ? "left-eye" : "right-eye");
    eye.position.set(side * 0.16, 0.06, -0.424);
    eye.scale.set(1, 0.72, 0.58);

    const cheek = makeMesh(
      head,
      new THREE.SphereGeometry(0.052, 7, 5),
      materials.cheeks,
      side < 0 ? "left-cheek" : "right-cheek",
    );
    cheek.position.set(side * 0.245, -0.055, -0.405);
    cheek.scale.set(1.25, 0.55, 0.35);
    cheek.castShadow = false;
  }

  const nose = makeMesh(
    head,
    new THREE.SphereGeometry(0.034, 7, 5),
    materials.skin,
    "nose",
  );
  nose.position.set(0, -0.005, -0.443);
  nose.scale.set(0.72, 0.9, 0.65);

  const smile = makeMesh(
    head,
    new THREE.TorusGeometry(0.085, 0.012, 4, 10, Math.PI * 0.82),
    materials.face,
    "smile",
  );
  smile.position.set(0, -0.105, -0.425);
  smile.rotation.z = Math.PI * 0.09;
  smile.castShadow = false;

  const speechAnchor = makeGroup(silhouette, "speech-anchor");
  speechAnchor.position.set(0, 3.2, 0);
  const heldItemAnchor = makeGroup(silhouette, "held-item-anchor");
  heldItemAnchor.position.set(0.58, 1.7, -0.3);

  if (options.groundShadow ?? true) {
    const shadow = makeMesh(
      root,
      new THREE.CircleGeometry(0.68, 20),
      materials.shadow,
      "avatar-ground-shadow",
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.018;
    shadow.castShadow = false;
  }

  const topModules: ModuleRegistry<AvatarTopId> = new Map();
  const bottomModules: ModuleRegistry<AvatarBottomId> = new Map();
  const shoeModules: ModuleRegistry<AvatarShoeId> = new Map();
  const hairModules: ModuleRegistry<AvatarHairId> = new Map();
  const accessoryModules: ModuleRegistry<AvatarAccessoryId> = new Map();

  const makeSleeve = (
    parent: THREE.Group,
    id: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    y: number,
  ) => {
    const sleeve = makeGroup(parent, id);
    const mesh = makeMesh(sleeve, geometry, material, `${id}-mesh`);
    mesh.position.y = y;
    return sleeve;
  };

  // Knit sweater: the simple, rounded Waitland silhouette.
  {
    const body = makeGroup(silhouette, "top-knit-sweater");
    const torso = makeMesh(
      body,
      new THREE.CapsuleGeometry(0.48, 0.72, 6, 12),
      materials.top,
      "knit-sweater-torso",
    );
    torso.position.y = 1.42;
    torso.scale.z = 0.9;
    const collar = makeMesh(
      body,
      new THREE.TorusGeometry(0.22, 0.035, 5, 13),
      materials.topAccent,
      "knit-sweater-collar",
    );
    collar.position.set(0, 1.91, -0.01);
    collar.rotation.x = Math.PI / 2;
    collar.scale.z = 0.82;

    const sleeveGeometry = new THREE.CapsuleGeometry(0.13, 0.52, 4, 8);
    const leftSleeve = makeSleeve(leftArm, "left-knit-sleeve", sleeveGeometry, materials.top, -0.34);
    const rightSleeve = makeSleeve(rightArm, "right-knit-sleeve", sleeveGeometry, materials.top, -0.34);
    topModules.set("knit-sweater", [body, leftSleeve, rightSleeve]);
  }

  // Hoodie: chunkier torso, visible hood, and a tiny front pocket.
  {
    const body = makeGroup(silhouette, "top-soft-hoodie");
    const torso = makeMesh(
      body,
      new THREE.CapsuleGeometry(0.5, 0.68, 6, 12),
      materials.top,
      "soft-hoodie-torso",
    );
    torso.position.y = 1.42;
    torso.scale.z = 0.92;
    const hood = makeMesh(
      body,
      new THREE.SphereGeometry(0.53, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.67),
      materials.topAccent,
      "soft-hoodie-hood",
    );
    hood.position.set(0, 2.12, 0.14);
    hood.rotation.x = Math.PI;
    hood.scale.set(1, 0.82, 0.8);
    const pocket = makeMesh(
      body,
      new THREE.BoxGeometry(0.48, 0.2, 0.08, 2, 1, 1),
      materials.topAccent,
      "soft-hoodie-pocket",
    );
    pocket.position.set(0, 1.28, -0.43);
    pocket.rotation.x = -0.08;

    const sleeveGeometry = new THREE.CapsuleGeometry(0.145, 0.52, 4, 8);
    const leftSleeve = makeSleeve(leftArm, "left-hoodie-sleeve", sleeveGeometry, materials.top, -0.34);
    const rightSleeve = makeSleeve(rightArm, "right-hoodie-sleeve", sleeveGeometry, materials.top, -0.34);
    topModules.set("soft-hoodie", [body, leftSleeve, rightSleeve]);
  }

  // Camp shirt: a lighter short-sleeved option with subtle front panels.
  {
    const body = makeGroup(silhouette, "top-camp-shirt");
    const torso = makeMesh(
      body,
      new THREE.CapsuleGeometry(0.47, 0.68, 6, 12),
      materials.top,
      "camp-shirt-torso",
    );
    torso.position.y = 1.43;
    torso.scale.z = 0.88;
    for (const side of [-1, 1]) {
      const panel = makeMesh(
        body,
        new THREE.BoxGeometry(0.035, 0.66, 0.035),
        materials.topAccent,
        side < 0 ? "left-shirt-seam" : "right-shirt-seam",
      );
      panel.position.set(side * 0.075, 1.46, -0.435);
    }

    const sleeveGeometry = new THREE.CapsuleGeometry(0.14, 0.2, 4, 8);
    const forearmGeometry = new THREE.CapsuleGeometry(0.115, 0.25, 4, 8);
    const leftSleeve = makeSleeve(leftArm, "left-shirt-sleeve", sleeveGeometry, materials.top, -0.17);
    const rightSleeve = makeSleeve(rightArm, "right-shirt-sleeve", sleeveGeometry, materials.top, -0.17);
    makeSleeve(leftSleeve, "left-shirt-forearm", forearmGeometry, materials.skin, -0.37);
    makeSleeve(rightSleeve, "right-shirt-forearm", forearmGeometry, materials.skin, -0.37);
    topModules.set("camp-shirt", [body, leftSleeve, rightSleeve]);
  }

  // Tapered trousers.
  {
    const legGeometry = new THREE.CapsuleGeometry(0.13, 0.6, 4, 8);
    const left = makeGroup(leftLeg, "left-tapered-trouser");
    const right = makeGroup(rightLeg, "right-tapered-trouser");
    const leftMesh = makeMesh(left, legGeometry, materials.bottom, "left-tapered-trouser-mesh");
    const rightMesh = makeMesh(right, legGeometry, materials.bottom, "right-tapered-trouser-mesh");
    leftMesh.position.y = -0.39;
    rightMesh.position.y = -0.39;
    bottomModules.set("tapered-trousers", [left, right]);
  }

  // Cuffed trousers.
  {
    const legGeometry = new THREE.CapsuleGeometry(0.14, 0.56, 4, 8);
    const cuffGeometry = new THREE.CylinderGeometry(0.155, 0.15, 0.12, 9);
    const left = makeGroup(leftLeg, "left-cuffed-trouser");
    const right = makeGroup(rightLeg, "right-cuffed-trouser");
    for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
      const leg = makeMesh(group, legGeometry, materials.bottom, `${side}-cuffed-trouser-mesh`);
      leg.position.y = -0.36;
      const cuff = makeMesh(group, cuffGeometry, materials.bottomAccent, `${side}-trouser-cuff`);
      cuff.position.y = -0.72;
    }
    bottomModules.set("cuffed-trousers", [left, right]);
  }

  // Shorts retain a small skin-colored calf so the topology stays rig-compatible.
  {
    const shortsGeometry = new THREE.CapsuleGeometry(0.155, 0.2, 4, 8);
    const calfGeometry = new THREE.CapsuleGeometry(0.115, 0.25, 4, 8);
    const left = makeGroup(leftLeg, "left-walking-short");
    const right = makeGroup(rightLeg, "right-walking-short");
    for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
      const shorts = makeMesh(group, shortsGeometry, materials.bottom, `${side}-walking-short-mesh`);
      shorts.position.y = -0.2;
      const calf = makeMesh(group, calfGeometry, materials.skin, `${side}-calf`);
      calf.position.y = -0.57;
    }
    bottomModules.set("walking-shorts", [left, right]);
  }

  // Shoe modules stay under the leg pivots so walk animation needs no special cases.
  {
    const geometry = new THREE.SphereGeometry(0.18, 10, 8);
    const left = makeGroup(leftLeg, "left-walking-shoe");
    const right = makeGroup(rightLeg, "right-walking-shoe");
    for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
      const shoe = makeMesh(group, geometry, materials.shoes, `${side}-walking-shoe-mesh`);
      shoe.position.set(0, -0.77, -0.08);
      shoe.scale.set(1.05, 0.72, 1.28);
    }
    shoeModules.set("walking-shoes", [left, right]);
  }

  {
    const footGeometry = new THREE.SphereGeometry(0.18, 10, 8);
    const ankleGeometry = new THREE.CylinderGeometry(0.16, 0.17, 0.27, 9);
    const left = makeGroup(leftLeg, "left-ankle-boot");
    const right = makeGroup(rightLeg, "right-ankle-boot");
    for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
      const ankle = makeMesh(group, ankleGeometry, materials.shoes, `${side}-boot-ankle`);
      ankle.position.y = -0.7;
      const foot = makeMesh(group, footGeometry, materials.shoes, `${side}-boot-foot`);
      foot.position.set(0, -0.82, -0.095);
      foot.scale.set(1.08, 0.68, 1.35);
    }
    shoeModules.set("ankle-boots", [left, right]);
  }

  {
    const footGeometry = new THREE.SphereGeometry(0.18, 10, 8);
    const soleGeometry = new THREE.BoxGeometry(0.32, 0.07, 0.4, 2, 1, 2);
    const left = makeGroup(leftLeg, "left-soft-sneaker");
    const right = makeGroup(rightLeg, "right-soft-sneaker");
    for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
      const foot = makeMesh(group, footGeometry, materials.shoes, `${side}-sneaker-foot`);
      foot.position.set(0, -0.78, -0.08);
      foot.scale.set(1.05, 0.66, 1.3);
      const sole = makeMesh(group, soleGeometry, materials.shoeAccent, `${side}-sneaker-sole`);
      sole.position.set(0, -0.9, -0.095);
    }
    shoeModules.set("soft-sneakers", [left, right]);
  }

  const hairCapGeometry = new THREE.SphereGeometry(
    0.47,
    14,
    9,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.64,
  );

  // Soft crop.
  {
    const group = makeGroup(head, "hair-soft-crop");
    const cap = makeMesh(group, hairCapGeometry, materials.hair, "soft-crop-cap");
    cap.position.set(0, 0.19, 0.05);
    cap.scale.set(1.04, 0.65, 1);
    hairModules.set("soft-crop", [group]);
  }

  // Rounded bob with separate side locks, still using inexpensive primitives.
  {
    const group = makeGroup(head, "hair-rounded-bob");
    const cap = makeMesh(group, hairCapGeometry, materials.hair, "rounded-bob-cap");
    cap.position.set(0, 0.07, 0.05);
    cap.scale.set(1.04, 0.9, 1.08);
    const lockGeometry = new THREE.SphereGeometry(0.24, 10, 7);
    for (const side of [-1, 1]) {
      const lock = makeMesh(group, lockGeometry, materials.hair, side < 0 ? "left-bob-lock" : "right-bob-lock");
      lock.position.set(side * 0.34, -0.045, 0.04);
      lock.scale.set(0.72, 1.28, 0.82);
    }
    hairModules.set("rounded-bob", [group]);
  }

  // Top bun.
  {
    const group = makeGroup(head, "hair-top-bun");
    const cap = makeMesh(group, hairCapGeometry, materials.hair, "top-bun-cap");
    cap.position.set(0, 0.25, 0.05);
    cap.scale.set(1.04, 0.7, 1.02);
    const bun = makeMesh(
      group,
      new THREE.SphereGeometry(0.28, 11, 8),
      materials.hair,
      "top-bun-knot",
    );
    bun.position.set(0, 0.42, 0.12);
    bun.scale.setScalar(0.78);
    hairModules.set("top-bun", [group]);
  }

  // Beanie includes a small hair fringe so hair color remains meaningful.
  {
    const group = makeGroup(head, "hair-knit-beanie");
    const fringe = makeMesh(group, hairCapGeometry, materials.hair, "beanie-hair-fringe");
    fringe.position.set(0, 0.13, 0.035);
    fringe.scale.set(1.02, 0.55, 1.01);
    const hat = makeMesh(
      group,
      new THREE.SphereGeometry(0.49, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.6),
      materials.accessoryAccent,
      "beanie-crown",
    );
    hat.position.set(0, 0.24, 0.04);
    hat.scale.set(1.02, 0.82, 1.02);
    const brim = makeMesh(
      group,
      new THREE.TorusGeometry(0.405, 0.055, 5, 14),
      materials.accessoryAccent,
      "beanie-brim",
    );
    brim.position.set(0, 0.18, 0.005);
    brim.rotation.x = Math.PI / 2;
    brim.scale.z = 0.9;
    const pom = makeMesh(
      group,
      new THREE.SphereGeometry(0.105, 8, 6),
      materials.accessoryAccent,
      "beanie-pom",
    );
    pom.position.set(0, 0.69, 0.05);
    hairModules.set("knit-beanie", [group]);
  }

  // Round glasses.
  {
    const group = makeGroup(head, "accessory-round-glasses");
    const rimGeometry = new THREE.TorusGeometry(0.105, 0.018, 5, 12);
    for (const side of [-1, 1]) {
      const rim = makeMesh(group, rimGeometry, materials.face, side < 0 ? "left-glasses-rim" : "right-glasses-rim");
      rim.position.set(side * 0.16, 0.06, -0.45);
      rim.castShadow = false;
    }
    const bridge = makeMesh(
      group,
      new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6),
      materials.face,
      "glasses-bridge",
    );
    bridge.position.set(0, 0.06, -0.45);
    bridge.rotation.z = Math.PI / 2;
    bridge.castShadow = false;
    accessoryModules.set("round-glasses", [group]);
  }

  // Soft scarf.
  {
    const group = makeGroup(silhouette, "accessory-soft-scarf");
    const wrap = makeMesh(
      group,
      new THREE.TorusGeometry(0.3, 0.085, 6, 16),
      materials.accessoryAccent,
      "soft-scarf-wrap",
    );
    wrap.position.set(0, 1.98, 0);
    wrap.rotation.x = Math.PI / 2;
    wrap.scale.z = 0.76;
    const tail = makeMesh(
      group,
      new THREE.CapsuleGeometry(0.075, 0.38, 4, 7),
      materials.accessoryAccent,
      "soft-scarf-tail",
    );
    tail.position.set(0.2, 1.7, -0.38);
    tail.rotation.z = -0.16;
    accessoryModules.set("soft-scarf", [group]);
  }

  // Crossbody bag.
  {
    const group = makeGroup(silhouette, "accessory-crossbody-bag");
    const strapCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.34, 1.84, -0.43),
      new THREE.Vector3(-0.05, 1.54, -0.47),
      new THREE.Vector3(0.28, 1.16, -0.45),
    ]);
    makeMesh(
      group,
      new THREE.TubeGeometry(strapCurve, 12, 0.023, 5, false),
      materials.accessory,
      "crossbody-strap",
    );
    const bag = makeMesh(
      group,
      new THREE.BoxGeometry(0.38, 0.32, 0.15, 2, 2, 1),
      materials.accessory,
      "crossbody-bag",
    );
    bag.position.set(0.3, 1.07, -0.43);
    bag.rotation.z = -0.06;
    const flap = makeMesh(
      group,
      new THREE.BoxGeometry(0.32, 0.08, 0.025),
      materials.shoeAccent,
      "crossbody-bag-flap",
    );
    flap.position.set(0.3, 1.15, -0.515);
    flap.rotation.z = -0.06;
    accessoryModules.set("crossbody-bag", [group]);
  }

  function applyAppearance() {
    const scale = BASE_SCALE[appearance.baseId];
    silhouette.scale.set(scale[0], scale[1], scale[2]);

    materials.skin.color.setHex(appearance.skin);
    materials.hair.color.setHex(appearance.hair);
    materials.top.color.setHex(appearance.sweater);
    materials.topAccent.color.setHex(appearance.sweater).offsetHSL(0, -0.02, 0.1);
    materials.bottom.color.setHex(appearance.trousers);
    materials.bottomAccent.color.setHex(appearance.trousers).offsetHSL(0, -0.02, 0.08);
    materials.shoes.color.setHex(appearance.shoes);
    materials.shoeAccent.color.setHex(appearance.shoes).offsetHSL(0, -0.05, 0.12);
    materials.accessoryAccent.color.setHex(appearance.sweater).offsetHSL(0.015, 0.02, 0.08);

    showModule(topModules, appearance.topId);
    showModule(bottomModules, appearance.bottomId);
    showModule(shoeModules, appearance.shoeId);
    showModule(hairModules, appearance.hairId);
    for (const [id, objects] of accessoryModules) {
      const visible = appearance.accessoryIds.includes(id);
      for (const object of objects) object.visible = visible;
    }
  }

  function setAppearance(patch: Partial<AvatarAppearance>) {
    if (disposed) return appearance;
    const merged: Partial<AvatarAppearance> = { ...appearance, ...patch };

    // A patched legacy alias must be allowed to select/customize its new ID,
    // and a patched ID must be allowed to regenerate its legacy alias.
    const colorPairs = [
      ["skin", "skinToneId"],
      ["hair", "hairColorId"],
      ["sweater", "topColorId"],
      ["trousers", "bottomColorId"],
      ["shoes", "shoeColorId"],
    ] as const;
    for (const [legacyKey, idKey] of colorPairs) {
      if (owns(patch, legacyKey) && !owns(patch, idKey)) delete merged[idKey];
      if (owns(patch, idKey) && !owns(patch, legacyKey)) delete merged[legacyKey];
    }
    if (owns(patch, "hairStyle") && !owns(patch, "hairId")) delete merged.hairId;
    if (owns(patch, "hairId") && !owns(patch, "hairStyle")) delete merged.hairStyle;
    if (owns(patch, "glasses") && !owns(patch, "accessoryIds")) {
      const accessoryIds: AvatarAccessoryId[] = appearance.accessoryIds.filter(
        (id) => id !== "round-glasses",
      );
      if (patch.glasses) accessoryIds.unshift("round-glasses");
      merged.accessoryIds = accessoryIds;
      delete merged.glasses;
    }
    if (owns(patch, "accessoryIds") && !owns(patch, "glasses")) delete merged.glasses;

    appearance = createAvatarAppearance(seed, merged);
    applyAppearance();
    return appearance;
  }

  function updatePose(pose: ProceduralAvatarPose) {
    if (disposed) return;
    const moving = Boolean(pose.moving);
    const walkAmount = moving ? clamp(pose.speed ?? 1, 0, 1) : 0;
    const phase = pose.walkPhase ?? (pose.elapsedSeconds ?? 0) * 10.5;
    const swing = Math.sin(phase) * walkAmount;
    const carrying = Boolean(pose.carryingStone);
    const bob = pose.bob ?? Math.abs(Math.sin(phase)) * 0.048 * walkAmount;

    poseRoot.position.y = bob;
    poseRoot.rotation.z = (pose.lean ?? 0) - swing * 0.018;
    leftLeg.rotation.set(swing * 0.52, 0, 0);
    rightLeg.rotation.set(-swing * 0.52, 0, 0);
    leftArm.rotation.set(-swing * 0.38, 0, 0.04);
    rightArm.rotation.set(carrying ? -0.76 : swing * 0.38, 0, -0.04);
    head.rotation.set(
      clamp(pose.lookPitch ?? 0, -0.24, 0.24),
      clamp(pose.lookYaw ?? 0, -0.6, 0.6),
      swing * 0.012,
    );
    heldItemAnchor.visible = carrying;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    root.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of disposableMaterials) material.dispose();
    geometries.clear();
    disposableMaterials.clear();
  }

  applyAppearance();
  updatePose({});

  return {
    root,
    materials,
    anchors: { head, heldItem: heldItemAnchor, speech: speechAnchor },
    get appearance() {
      return appearance;
    },
    setAppearance,
    updatePose,
    dispose,
  };
}
