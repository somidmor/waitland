import * as THREE from "three";

export const AVATAR_APPEARANCE_VERSION = 1 as const;

export type AvatarHairStyle = "crop" | "bob" | "bun" | "beanie";

/**
 * A deliberately small, serializable appearance contract. Today every avatar
 * is derived from a stable player seed. Later the exact same object can be
 * stored in a profile and edited without changing the renderer or protocol.
 */
export type AvatarAppearance = {
  version: typeof AVATAR_APPEARANCE_VERSION;
  skin: number;
  hair: number;
  sweater: number;
  trousers: number;
  shoes: number;
  hairStyle: AvatarHairStyle;
  glasses: boolean;
};

const SKIN = [0x5a3828, 0x7a4b34, 0x9d6547, 0xbb7f5c, 0xd49b72, 0xe6bb93] as const;
const HAIR = [0x231712, 0x35231a, 0x4a2b1c, 0x6c4027, 0x8c5b32, 0x17191a] as const;
const SWEATERS = [
  0x3f5b3f,
  0x53756a,
  0xa25e43,
  0xc58a42,
  0x65799a,
  0x8d6f8f,
  0xd1b75d,
  0x6c7545,
] as const;
const TROUSERS = [0x33403a, 0x394959, 0x55483c, 0x4e5540, 0x6c5a48] as const;
const SHOES = [0x241d19, 0x382a22, 0x51402f, 0x313537] as const;
const HAIR_STYLES: AvatarHairStyle[] = ["crop", "bob", "bun", "beanie"];

export function avatarSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mix(value: number) {
  let next = value >>> 0;
  next ^= next >>> 16;
  next = Math.imul(next, 0x7feb352d);
  next ^= next >>> 15;
  next = Math.imul(next, 0x846ca68b);
  return (next ^ (next >>> 16)) >>> 0;
}

function pick<T>(values: readonly T[], seed: number, offset: number) {
  return values[mix(seed + Math.imul(offset, 0x9e3779b1)) % values.length];
}

export function createAvatarAppearance(
  seedValue: string,
  override: Partial<AvatarAppearance> = {},
): AvatarAppearance {
  const seed = avatarSeed(seedValue || "waitland-wanderer");
  return {
    version: AVATAR_APPEARANCE_VERSION,
    skin: pick(SKIN, seed, 1),
    hair: pick(HAIR, seed, 2),
    sweater: pick(SWEATERS, seed, 3),
    trousers: pick(TROUSERS, seed, 4),
    shoes: pick(SHOES, seed, 5),
    hairStyle: pick(HAIR_STYLES, seed, 6),
    glasses: mix(seed + 7) % 5 === 0,
    ...override,
  };
}

/** Shared hair proportions used by both the local hierarchy and instanced remotes. */
export function hairStyleMetrics(style: AvatarHairStyle) {
  switch (style) {
    case "bob":
      return { capY: 0.9, capZ: 1.08, capOffsetY: -0.02, bunScale: 0, bunY: 2.48, bunZ: 0.34 };
    case "bun":
      return { capY: 0.7, capZ: 1.02, capOffsetY: 0.06, bunScale: 0.42, bunY: 2.84, bunZ: 0.1 };
    case "beanie":
      return { capY: 0.78, capZ: 1.02, capOffsetY: 0.11, bunScale: 0.2, bunY: 2.78, bunZ: 0.02 };
    default:
      return { capY: 0.65, capZ: 1, capOffsetY: 0.1, bunScale: 0, bunY: 2.48, bunZ: 0.34 };
  }
}

export function colorFrom(value: number) {
  return new THREE.Color(value);
}
