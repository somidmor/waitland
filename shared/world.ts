/** Rules shared by the browser predictor and the authoritative room worker. */
export const WORLD_PROTOCOL_VERSION = 1;
export const PIT_CAPACITY = 1_000;
export const PIT_RADIUS = 3.6;
export const PIT_WALL_RADIUS = 4.85;
/** Visual landmark radius; movement is intentionally not bounded by it. */
export const FIELD_RADIUS = 72;
export const PICKUP_RADIUS = 1.85;
export const PIT_THROW_RADIUS = 12.5;
export const STONE_THROW_DISTANCE = 7.5;
export const WALK_SPEED = 5.55;
export const CARRY_SPEED = 4.8;
export const FIELD_STONE_COUNT = 84;
export const MIN_NEAR_PIT_STONES = 10;
/** A generous reserve keeps ten available even while several people carry one. */
export const NEAR_PIT_STONE_POOL_COUNT = 24;
export const NEAR_PIT_STONE_RADIUS = 22;
export const STONE_SPAWN_MIN_RADIUS = 7.2;
export const STONE_FIELD_MAX_RADIUS = 66;
const FORCED_NEAR_STONE_GENERATION_BASE = 0x4000_0000;
const MAX_STONE_GENERATION = 0x7fff_ffff;
export const WORLD_SEED = 0x5750_5431;

export type StoneDescriptor = {
  id: string;
  x: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  material: number;
  generation: number;
};

function mix32(value: number) {
  let next = value | 0;
  next = Math.imul(next ^ (next >>> 16), 0x21f0aaad);
  next = Math.imul(next ^ (next >>> 15), 0x735a2d97);
  return (next ^ (next >>> 15)) >>> 0;
}

function randomFor(index: number, generation: number) {
  let state = mix32(WORLD_SEED ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(generation + 1, 0x85ebca6b));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STARTER_POSITIONS = [
  [-1.9, 15.1],
  [2.4, 14.6],
  [3.4, 18.2],
] as const;

/**
 * Returns the same stone on every client and room worker. A consumed stone can
 * be recycled by increasing its generation.
 */
export function getStoneDescriptor(index: number, generation = 0): StoneDescriptor {
  const safeIndex = Math.max(0, Math.min(FIELD_STONE_COUNT - 1, Math.trunc(index)));
  const safeGeneration = Number.isFinite(generation)
    ? Math.max(0, Math.min(MAX_STONE_GENERATION, Math.trunc(generation)))
    : 0;
  const random = randomFor(safeIndex, safeGeneration);
  const starter = safeGeneration === 0 ? STARTER_POSITIONS[safeIndex] : undefined;

  let x = starter?.[0] ?? 0;
  let z = starter?.[1] ?? 0;
  if (!starter) {
    // Rejection sampling is deterministic and keeps the arrival point clear.
    do {
      const nearPitReserve =
        safeIndex < NEAR_PIT_STONE_POOL_COUNT ||
        safeGeneration >= FORCED_NEAR_STONE_GENERATION_BASE;
      const minimumRadius = nearPitReserve
        ? STONE_SPAWN_MIN_RADIUS
        : NEAR_PIT_STONE_RADIUS + 3;
      const maximumRadius = nearPitReserve
        ? NEAR_PIT_STONE_RADIUS
        : STONE_FIELD_MAX_RADIUS;
      const radius = minimumRadius + random() * (maximumRadius - minimumRadius);
      const angle = random() * Math.PI * 2;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
    } while (Math.hypot(x, z - 18) < 3.5);
  }

  const scale = safeIndex < 3 && safeGeneration === 0 ? 1.05 : 0.82 + random() * 0.4;
  return {
    id: `stone-${safeIndex}`,
    x,
    z,
    scaleX: scale * (0.75 + random() * 0.45),
    scaleY: scale * (0.58 + random() * 0.34),
    scaleZ: scale * (0.8 + random() * 0.42),
    rotationX: random() * 2,
    rotationY: random() * 2,
    rotationZ: random() * 2,
    material: Math.floor(random() * 4),
    generation: safeGeneration,
  };
}

/** Encodes a deterministic near-pit recycle without adding state to the wire format. */
export function getNextNearbyStoneGeneration(generation: number) {
  const safeGeneration = Number.isFinite(generation)
    ? Math.max(0, Math.min(MAX_STONE_GENERATION, Math.trunc(generation)))
    : 0;
  const sequence =
    safeGeneration >= FORCED_NEAR_STONE_GENERATION_BASE
      ? safeGeneration - FORCED_NEAR_STONE_GENERATION_BASE
      : safeGeneration;
  const range = MAX_STONE_GENERATION - FORCED_NEAR_STONE_GENERATION_BASE + 1;
  return FORCED_NEAR_STONE_GENERATION_BASE + ((sequence + 1) % range);
}

export function parseStoneIndex(stoneId: string) {
  const match = /^stone-(\d{1,3})$/.exec(stoneId);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return index >= 0 && index < FIELD_STONE_COUNT ? index : null;
}

export function clampPositionOutsidePit(x: number, z: number) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  const radius = Math.hypot(finiteX, finiteZ);
  if (radius < PIT_WALL_RADIUS) {
    if (radius < 0.001) return { x: 0, z: PIT_WALL_RADIUS };
    const scale = PIT_WALL_RADIUS / Math.max(radius, 0.001);
    return { x: finiteX * scale, z: finiteZ * scale };
  }
  return { x: finiteX, z: finiteZ };
}

export function isNearPitStonePosition(x: number, z: number) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const radius = Math.hypot(x, z);
  return radius >= PIT_WALL_RADIUS && radius <= NEAR_PIT_STONE_RADIUS;
}

/** Heading whose gameplay -Z forward axis points from a world pose to the pit. */
export function headingTowardPit(x: number, z: number) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  if (Math.hypot(finiteX, finiteZ) < 0.001) return 0;
  return Math.atan2(finiteX, finiteZ);
}

/**
 * Shared landing prediction for a non-deposited throw. The server captures the
 * action-time pose and the browser uses the same calculation, so an async pit
 * acknowledgement cannot make the stone snap back to the avatar's later pose.
 */
export function getForwardStonePosition(
  x: number,
  z: number,
  heading: number,
  distance = STONE_THROW_DISTANCE,
) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  const finiteHeading = Number.isFinite(heading) ? heading : 0;
  const finiteDistance = Number.isFinite(distance) ? Math.max(0, distance) : STONE_THROW_DISTANCE;
  return clampPositionOutsidePit(
    finiteX - Math.sin(finiteHeading) * finiteDistance,
    finiteZ - Math.cos(finiteHeading) * finiteDistance,
  );
}
