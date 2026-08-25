import * as THREE from "three";

export const AVATAR_APPEARANCE_VERSION = 1 as const;

type CatalogOption = {
  readonly id: string;
  readonly label: string;
};

type ColorCatalogOption = CatalogOption & {
  readonly color: number;
};

/**
 * Stable, editor-friendly part catalogs. IDs are serialized; labels are only
 * presentation copy and may change without invalidating saved avatars.
 */
export const AVATAR_BASE_CATALOG = [
  { id: "soft-rounded", label: "Soft rounded" },
  { id: "compact-sturdy", label: "Compact sturdy" },
  { id: "gentle-tall", label: "Gentle tall" },
] as const satisfies readonly CatalogOption[];

export const AVATAR_TOP_CATALOG = [
  { id: "knit-sweater", label: "Knit sweater" },
  { id: "soft-hoodie", label: "Soft hoodie" },
  { id: "camp-shirt", label: "Camp shirt" },
] as const satisfies readonly CatalogOption[];

export const AVATAR_BOTTOM_CATALOG = [
  { id: "tapered-trousers", label: "Tapered trousers" },
  { id: "cuffed-trousers", label: "Cuffed trousers" },
  { id: "walking-shorts", label: "Walking shorts" },
] as const satisfies readonly CatalogOption[];

export const AVATAR_SHOE_CATALOG = [
  { id: "walking-shoes", label: "Walking shoes" },
  { id: "ankle-boots", label: "Ankle boots" },
  { id: "soft-sneakers", label: "Soft sneakers" },
] as const satisfies readonly CatalogOption[];

export type AvatarHairStyle = "crop" | "bob" | "bun" | "beanie";

export const AVATAR_HAIR_CATALOG = [
  { id: "soft-crop", label: "Soft crop", legacyStyle: "crop" },
  { id: "rounded-bob", label: "Rounded bob", legacyStyle: "bob" },
  { id: "top-bun", label: "Top bun", legacyStyle: "bun" },
  { id: "knit-beanie", label: "Knit beanie", legacyStyle: "beanie" },
] as const satisfies readonly (CatalogOption & { readonly legacyStyle: AvatarHairStyle })[];

export const AVATAR_ACCESSORY_CATALOG = [
  { id: "round-glasses", label: "Round glasses" },
  { id: "soft-scarf", label: "Soft scarf" },
  { id: "crossbody-bag", label: "Crossbody bag" },
] as const satisfies readonly CatalogOption[];

export const AVATAR_SKIN_TONE_CATALOG = [
  { id: "deep-umber", label: "Deep umber", color: 0x5a3828 },
  { id: "warm-brown", label: "Warm brown", color: 0x7a4b34 },
  { id: "caramel", label: "Caramel", color: 0x9d6547 },
  { id: "sienna", label: "Sienna", color: 0xbb7f5c },
  { id: "honey", label: "Honey", color: 0xd49b72 },
  { id: "sand", label: "Sand", color: 0xe6bb93 },
] as const satisfies readonly ColorCatalogOption[];

export const AVATAR_HAIR_COLOR_CATALOG = [
  { id: "espresso", label: "Espresso", color: 0x231712 },
  { id: "dark-brown", label: "Dark brown", color: 0x35231a },
  { id: "chestnut", label: "Chestnut", color: 0x4a2b1c },
  { id: "copper-brown", label: "Copper brown", color: 0x6c4027 },
  { id: "warm-auburn", label: "Warm auburn", color: 0x8c5b32 },
  { id: "near-black", label: "Near black", color: 0x17191a },
] as const satisfies readonly ColorCatalogOption[];

export const AVATAR_TOP_COLOR_CATALOG = [
  { id: "forest", label: "Forest", color: 0x3f5b3f },
  { id: "sage", label: "Sage", color: 0x53756a },
  { id: "clay", label: "Clay", color: 0xa25e43 },
  { id: "ochre", label: "Ochre", color: 0xc58a42 },
  { id: "slate-blue", label: "Slate blue", color: 0x65799a },
  { id: "heather", label: "Heather", color: 0x8d6f8f },
  { id: "sunflower", label: "Sunflower", color: 0xd1b75d },
  { id: "olive", label: "Olive", color: 0x6c7545 },
] as const satisfies readonly ColorCatalogOption[];

export const AVATAR_BOTTOM_COLOR_CATALOG = [
  { id: "pine", label: "Pine", color: 0x33403a },
  { id: "blue-grey", label: "Blue grey", color: 0x394959 },
  { id: "earth", label: "Earth", color: 0x55483c },
  { id: "moss", label: "Moss", color: 0x4e5540 },
  { id: "warm-taupe", label: "Warm taupe", color: 0x6c5a48 },
] as const satisfies readonly ColorCatalogOption[];

export const AVATAR_SHOE_COLOR_CATALOG = [
  { id: "charcoal", label: "Charcoal", color: 0x241d19 },
  { id: "dark-leather", label: "Dark leather", color: 0x382a22 },
  { id: "warm-leather", label: "Warm leather", color: 0x51402f },
  { id: "graphite", label: "Graphite", color: 0x313537 },
] as const satisfies readonly ColorCatalogOption[];

export const AVATAR_CATALOGS = {
  bases: AVATAR_BASE_CATALOG,
  skinTones: AVATAR_SKIN_TONE_CATALOG,
  hairStyles: AVATAR_HAIR_CATALOG,
  hairColors: AVATAR_HAIR_COLOR_CATALOG,
  tops: AVATAR_TOP_CATALOG,
  topColors: AVATAR_TOP_COLOR_CATALOG,
  bottoms: AVATAR_BOTTOM_CATALOG,
  bottomColors: AVATAR_BOTTOM_COLOR_CATALOG,
  shoes: AVATAR_SHOE_CATALOG,
  shoeColors: AVATAR_SHOE_COLOR_CATALOG,
  accessories: AVATAR_ACCESSORY_CATALOG,
} as const;

export type AvatarBaseId = (typeof AVATAR_BASE_CATALOG)[number]["id"];
export type AvatarTopId = (typeof AVATAR_TOP_CATALOG)[number]["id"];
export type AvatarBottomId = (typeof AVATAR_BOTTOM_CATALOG)[number]["id"];
export type AvatarShoeId = (typeof AVATAR_SHOE_CATALOG)[number]["id"];
export type AvatarHairId = (typeof AVATAR_HAIR_CATALOG)[number]["id"];
export type AvatarAccessoryId = (typeof AVATAR_ACCESSORY_CATALOG)[number]["id"];
export type AvatarSkinToneId = (typeof AVATAR_SKIN_TONE_CATALOG)[number]["id"] | "custom";
export type AvatarHairColorId = (typeof AVATAR_HAIR_COLOR_CATALOG)[number]["id"] | "custom";
export type AvatarTopColorId = (typeof AVATAR_TOP_COLOR_CATALOG)[number]["id"] | "custom";
export type AvatarBottomColorId = (typeof AVATAR_BOTTOM_COLOR_CATALOG)[number]["id"] | "custom";
export type AvatarShoeColorId = (typeof AVATAR_SHOE_COLOR_CATALOG)[number]["id"] | "custom";

/**
 * A small serializable appearance contract. The `*Id` fields are the stable
 * customization boundary. Numeric colors plus `hairStyle` and `glasses` are
 * retained as renderer aliases for the current local and instanced avatars.
 */
export type AvatarAppearance = {
  version: typeof AVATAR_APPEARANCE_VERSION;
  baseId: AvatarBaseId;
  skinToneId: AvatarSkinToneId;
  hairId: AvatarHairId;
  hairColorId: AvatarHairColorId;
  topId: AvatarTopId;
  topColorId: AvatarTopColorId;
  bottomId: AvatarBottomId;
  bottomColorId: AvatarBottomColorId;
  shoeId: AvatarShoeId;
  shoeColorId: AvatarShoeColorId;
  accessoryIds: readonly AvatarAccessoryId[];
  skin: number;
  hair: number;
  sweater: number;
  trousers: number;
  shoes: number;
  hairStyle: AvatarHairStyle;
  glasses: boolean;
};

const HAIR_STYLES: readonly AvatarHairStyle[] = ["crop", "bob", "bun", "beanie"];

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

function catalogItem<T extends CatalogOption>(catalog: readonly T[], id: unknown) {
  return typeof id === "string" ? catalog.find((item) => item.id === id) : undefined;
}

function validLegacyColor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

function resolveColorSelection(
  catalog: readonly ColorCatalogOption[],
  generated: ColorCatalogOption,
  idOverride: unknown,
  colorOverride: unknown,
) {
  const explicitCatalogItem = catalogItem(catalog, idOverride);
  if (explicitCatalogItem) return { id: explicitCatalogItem.id, color: explicitCatalogItem.color };

  if (validLegacyColor(colorOverride)) {
    const matchingItem = catalog.find((item) => item.color === colorOverride);
    return { id: matchingItem?.id ?? "custom", color: colorOverride };
  }

  return { id: generated.id, color: generated.color };
}

function hairItemForStyle(style: unknown) {
  return HAIR_STYLES.includes(style as AvatarHairStyle)
    ? AVATAR_HAIR_CATALOG.find((item) => item.legacyStyle === style)
    : undefined;
}

function normalizeAccessories(value: unknown): AvatarAccessoryId[] {
  if (!Array.isArray(value)) return [];
  const result: AvatarAccessoryId[] = [];
  for (const candidate of value) {
    if (!catalogItem(AVATAR_ACCESSORY_CATALOG, candidate)) continue;
    const id = candidate as AvatarAccessoryId;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

/**
 * Deterministically creates a complete appearance. New catalog selections use
 * independent hash lanes so adding them does not change established colors,
 * hair styles, or the historical one-in-five glasses selection.
 *
 * Stable IDs are canonical when both an ID and its legacy numeric alias are
 * supplied. A numeric-only legacy override is matched back to its catalog ID,
 * or represented by the `custom` ID when it is outside the built-in palette.
 */
export function createAvatarAppearance(
  seedValue: string,
  override: Partial<AvatarAppearance> = {},
): AvatarAppearance {
  const seed = avatarSeed(seedValue || "waitland-wanderer");

  const generatedSkin = pick(AVATAR_SKIN_TONE_CATALOG, seed, 1);
  const generatedHairColor = pick(AVATAR_HAIR_COLOR_CATALOG, seed, 2);
  const generatedTopColor = pick(AVATAR_TOP_COLOR_CATALOG, seed, 3);
  const generatedBottomColor = pick(AVATAR_BOTTOM_COLOR_CATALOG, seed, 4);
  const generatedShoeColor = pick(AVATAR_SHOE_COLOR_CATALOG, seed, 5);
  const generatedHairStyle = pick(HAIR_STYLES, seed, 6);
  const generatedHair = hairItemForStyle(generatedHairStyle)!;

  const skin = resolveColorSelection(
    AVATAR_SKIN_TONE_CATALOG,
    generatedSkin,
    override.skinToneId,
    override.skin,
  );
  const hairColor = resolveColorSelection(
    AVATAR_HAIR_COLOR_CATALOG,
    generatedHairColor,
    override.hairColorId,
    override.hair,
  );
  const topColor = resolveColorSelection(
    AVATAR_TOP_COLOR_CATALOG,
    generatedTopColor,
    override.topColorId,
    override.sweater,
  );
  const bottomColor = resolveColorSelection(
    AVATAR_BOTTOM_COLOR_CATALOG,
    generatedBottomColor,
    override.bottomColorId,
    override.trousers,
  );
  const shoeColor = resolveColorSelection(
    AVATAR_SHOE_COLOR_CATALOG,
    generatedShoeColor,
    override.shoeColorId,
    override.shoes,
  );

  const hairItem =
    catalogItem(AVATAR_HAIR_CATALOG, override.hairId) ??
    hairItemForStyle(override.hairStyle) ??
    generatedHair;
  const baseId =
    catalogItem(AVATAR_BASE_CATALOG, override.baseId)?.id ??
    pick(AVATAR_BASE_CATALOG, seed, 8).id;
  const topId =
    catalogItem(AVATAR_TOP_CATALOG, override.topId)?.id ?? pick(AVATAR_TOP_CATALOG, seed, 9).id;
  const bottomId =
    catalogItem(AVATAR_BOTTOM_CATALOG, override.bottomId)?.id ??
    pick(AVATAR_BOTTOM_CATALOG, seed, 10).id;
  const shoeId =
    catalogItem(AVATAR_SHOE_CATALOG, override.shoeId)?.id ??
    pick(AVATAR_SHOE_CATALOG, seed, 11).id;

  const generatedGlasses = mix(seed + 7) % 5 === 0;
  let accessoryIds: AvatarAccessoryId[];
  if (override.accessoryIds !== undefined) {
    accessoryIds = normalizeAccessories(override.accessoryIds);
  } else {
    accessoryIds = [];
    if (generatedGlasses) accessoryIds.push("round-glasses");
    if (mix(seed + 12) % 7 === 0) accessoryIds.push("soft-scarf");
    if (mix(seed + 13) % 9 === 0) accessoryIds.push("crossbody-bag");

    if (override.glasses === true && !accessoryIds.includes("round-glasses")) {
      accessoryIds.unshift("round-glasses");
    } else if (override.glasses === false) {
      accessoryIds = accessoryIds.filter((id) => id !== "round-glasses");
    }
  }

  return {
    version: AVATAR_APPEARANCE_VERSION,
    baseId: baseId as AvatarBaseId,
    skinToneId: skin.id as AvatarSkinToneId,
    hairId: hairItem.id,
    hairColorId: hairColor.id as AvatarHairColorId,
    topId: topId as AvatarTopId,
    topColorId: topColor.id as AvatarTopColorId,
    bottomId: bottomId as AvatarBottomId,
    bottomColorId: bottomColor.id as AvatarBottomColorId,
    shoeId: shoeId as AvatarShoeId,
    shoeColorId: shoeColor.id as AvatarShoeColorId,
    accessoryIds,
    skin: skin.color,
    hair: hairColor.color,
    sweater: topColor.color,
    trousers: bottomColor.color,
    shoes: shoeColor.color,
    hairStyle: hairItem.legacyStyle,
    glasses: accessoryIds.includes("round-glasses"),
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
