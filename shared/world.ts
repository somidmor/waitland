/** Rules shared by the browser predictor and the authoritative room worker. */
export const WORLD_PROTOCOL_VERSION = 1;
export const PIT_CAPACITY = 100;
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

export const RECENT_MONUMENT_LIMIT = 8;

export type PitLayout = {
  center: { x: number; z: number };
  radius: number;
  wallRadius: number;
  throwRadius: number;
};

export type PitMonument = {
  round: number;
  name: string;
  stoneCount: number;
  center: { x: number; z: number };
  radius: number;
  startedAt: number;
  completedAt: number;
};

export type PitState = PitLayout & {
  round: number;
  count: number;
  capacity: number;
  totalStones: number;
  startedAt: number;
  monuments: PitMonument[];
};

/** Each new excavation is larger, with enough room between its neighbours. */
export function getPitLayout(round = 1): PitLayout {
  const safeRound = Number.isSafeInteger(round) && round > 0 ? round : 1;
  const radius = PIT_RADIUS + 4.4 * (1 - 1 / safeRound);
  return {
    center: { x: (safeRound - 1) * 26, z: 0 },
    radius,
    wallRadius: radius + (PIT_WALL_RADIUS - PIT_RADIUS),
    throwRadius: radius + (PIT_THROW_RADIUS - PIT_RADIUS),
  };
}

export function getPitCapacity(round = 1) {
  return PIT_CAPACITY * Math.max(1, Math.trunc(round));
}

export function createInitialPitState(now = Date.now()): PitState {
  return { ...getPitLayout(1), round: 1, count: 0, capacity: PIT_CAPACITY, totalStones: 0, startedAt: now, monuments: [] };
}

const MONUMENT_NAMES = ["A little patience", "Time well spent", "Together, for a while", "The in-between", "One stone at a time", "While we waited", "A moment shared", "Still becoming"];

/** A single deposit either advances this pit or creates a dated monument. */
export function advancePitState(pit: PitState, now = Date.now()): PitState {
  const totalStones = pit.totalStones + 1;
  if (pit.count + 1 < pit.capacity) return { ...pit, count: pit.count + 1, totalStones };
  const monument: PitMonument = {
    round: pit.round,
    name: MONUMENT_NAMES[(pit.round - 1) % MONUMENT_NAMES.length],
    stoneCount: pit.capacity,
    center: { ...pit.center },
    radius: pit.radius,
    startedAt: pit.startedAt,
    completedAt: Math.max(pit.startedAt, now),
  };
  const round = pit.round + 1;
  return {
    ...getPitLayout(round), round, count: 0, capacity: getPitCapacity(round),
    totalStones, startedAt: monument.completedAt,
    monuments: [...pit.monuments, monument].slice(-RECENT_MONUMENT_LIMIT),
  };
}

/** Preserve deposits made by the original 1,000-stone prototype. */
export function migrateLegacyPitState(count: number, now = Date.now()): PitState {
  let pit = createInitialPitState(now);
  const deposits = Number.isFinite(count) ? Math.max(0, Math.min(1_000, Math.trunc(count))) : 0;
  for (let index = 0; index < deposits; index += 1) pit = advancePitState(pit, now);
  return pit;
}

/** Reject malformed snapshots before either geometry or gameplay consumes them. */
export function isPitState(value: unknown): value is PitState {
  if (!value || typeof value !== "object") return false;
  const pit = value as PitState;
  if (!Number.isSafeInteger(pit.round) || pit.round < 1 || pit.round > 10_000_000 ||
      !Number.isSafeInteger(pit.count) || pit.count < 0 || pit.count >= getPitCapacity(pit.round) ||
      pit.capacity !== getPitCapacity(pit.round) || !Number.isSafeInteger(pit.totalStones) ||
      pit.totalStones !== PIT_CAPACITY * (pit.round - 1) * pit.round / 2 + pit.count ||
      !Number.isSafeInteger(pit.startedAt) || pit.startedAt < 0 ||
      !Array.isArray(pit.monuments) || pit.monuments.length > RECENT_MONUMENT_LIMIT) return false;
  const layout = getPitLayout(pit.round);
  if (!pit.center || pit.center.x !== layout.center.x || pit.center.z !== layout.center.z ||
      pit.radius !== layout.radius || pit.wallRadius !== layout.wallRadius || pit.throwRadius !== layout.throwRadius) return false;
  return pit.monuments.every((monument, index) => {
    if (!monument || typeof monument !== "object" ||
        !Number.isSafeInteger(monument.round) || monument.round < 1 || monument.round >= pit.round ||
        (index > 0 && monument.round <= pit.monuments[index - 1].round) ||
        typeof monument.name !== "string" || monument.name.length > 80 ||
        monument.stoneCount !== getPitCapacity(monument.round) ||
        !Number.isSafeInteger(monument.startedAt) || monument.startedAt < 0 ||
        !Number.isSafeInteger(monument.completedAt) || monument.completedAt < monument.startedAt) return false;
    const prior = getPitLayout(monument.round);
    return Boolean(monument.center && monument.center.x === prior.center.x && monument.center.z === prior.center.z && monument.radius === prior.radius);
  });
}

export function parsePitState(value: unknown): PitState | null {
  return isPitState(value) ? value : null;
}

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
export function getStoneDescriptor(index: number, generation = 0, pit: PitLayout = getPitLayout()): StoneDescriptor {
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
    x: pit.center.x + x * pit.wallRadius / PIT_WALL_RADIUS,
    z: pit.center.z + z * pit.wallRadius / PIT_WALL_RADIUS,
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

export function clampPositionOutsidePit(x: number, z: number, pit: PitLayout = getPitLayout()) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  const dx = finiteX - pit.center.x;
  const dz = finiteZ - pit.center.z;
  const radius = Math.hypot(dx, dz);
  if (radius < pit.wallRadius) {
    if (radius < 0.001) return { x: pit.center.x, z: pit.center.z + pit.wallRadius };
    const scale = pit.wallRadius / radius;
    return { x: pit.center.x + dx * scale, z: pit.center.z + dz * scale };
  }
  return { x: finiteX, z: finiteZ };
}

export function isNearPitStonePosition(x: number, z: number, pit: PitLayout = getPitLayout()) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const radius = Math.hypot(x - pit.center.x, z - pit.center.z);
  return radius >= pit.wallRadius && radius <= NEAR_PIT_STONE_RADIUS * pit.wallRadius / PIT_WALL_RADIUS;
}

/** Heading whose gameplay -Z forward axis points from a world pose to the pit. */
export function headingTowardPit(x: number, z: number, pit: PitLayout = getPitLayout()) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  if (Math.hypot(finiteX - pit.center.x, finiteZ - pit.center.z) < 0.001) return 0;
  return Math.atan2(finiteX - pit.center.x, finiteZ - pit.center.z);
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
  pit: PitLayout = getPitLayout(),
) {
  const finiteX = Number.isFinite(x) ? x : 0;
  const finiteZ = Number.isFinite(z) ? z : 18;
  const finiteHeading = Number.isFinite(heading) ? heading : 0;
  const finiteDistance = Number.isFinite(distance) ? Math.max(0, distance) : STONE_THROW_DISTANCE;
  return clampPositionOutsidePit(
    finiteX - Math.sin(finiteHeading) * finiteDistance,
    finiteZ - Math.cos(finiteHeading) * finiteDistance,
    pit,
  );
}
