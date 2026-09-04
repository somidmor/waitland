import {
  CARRY_SPEED,
  getPitLayout,
  type PitLayout,
  WALK_SPEED,
  clampPositionOutsidePit,
} from "../../shared/world.ts";
import type { MoveMessage, PublicProfile, StoredPlayer } from "./types.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MARKUP_CHARACTERS = /[<>&]/g;
const MULTIPLE_SPACES = /\s+/g;
const ACTION_ID = /^[A-Za-z0-9_-]{1,48}$/;

export const CHAT_MAX_CHARACTERS = 80;
export const ACTION_HISTORY_LIMIT = 64;
export const PLAYER_RADIUS = 0.62;
export const SLEEP_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MOVEMENT_CREDIT_WINDOW_SECONDS = 0.35;
const MOVEMENT_CREDIT_TOLERANCE_METERS = 0.12;
const POSITION_PRECISION = 1_000;
const MAX_PRECISE_WORLD_COORDINATE = Number.MAX_SAFE_INTEGER / POSITION_PRECISION;
const SPAWN_SEARCH_LIMIT = 512;

function isSafeWorldCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_PRECISE_WORLD_COORDINATE
  );
}

function text(value: unknown, fallback: string, maxCharacters: number) {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, "")
    .replace(MARKUP_CHARACTERS, "")
    .replace(MULTIPLE_SPACES, " ")
    .trim();
  return Array.from(cleaned).slice(0, maxCharacters).join("") || fallback;
}

export function sanitizeProfile(value: unknown): PublicProfile {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawCode = text(input.countryCode, "", 2).toUpperCase();
  const countryCode = /^[A-Z]{2}$/.test(rawCode) ? rawCode : "";
  const generatedFlag =
    !countryCode || countryCode === "XX"
      ? ""
      : String.fromCodePoint(...Array.from(countryCode).map((letter) => 127397 + letter.charCodeAt(0)));

  return {
    name: text(input.name, "", 24),
    city: text(input.city, "", 32),
    countryCode,
    countryFlag: generatedFlag,
    waitReason: text(input.waitReason, "Just waiting", 60),
  };
}

export function sanitizeChat(value: unknown) {
  if (typeof value !== "string") return "";
  return Array.from(
    value
      .normalize("NFKC")
      .replace(CONTROL_CHARACTERS, "")
      .replace(MARKUP_CHARACTERS, "")
      .replace(MULTIPLE_SPACES, " ")
      .trim(),
  )
    .slice(0, CHAT_MAX_CHARACTERS)
    .join("");
}

export function sanitizeActionId(value: unknown) {
  return typeof value === "string" && ACTION_ID.test(value) ? value : null;
}

export function normalizeHeading(value: unknown, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const tau = Math.PI * 2;
  return ((value + Math.PI) % tau + tau) % tau - Math.PI;
}

export type MovementResult = Pick<
  StoredPlayer,
  "x" | "z" | "vx" | "vz" | "heading" | "lastMoveAt" | "lastSeq"
> & {
  movementCredit: number;
  movementCreditAt: number;
};

export function movementCreditCapacity(carrying: boolean) {
  const speed = carrying ? CARRY_SPEED : WALK_SPEED;
  return speed * MOVEMENT_CREDIT_WINDOW_SECONDS + MOVEMENT_CREDIT_TOLERANCE_METERS;
}

export function replenishedMovementCredit(player: StoredPlayer, now: number) {
  const speed = player.carrying ? CARRY_SPEED : WALK_SPEED;
  const capacity = movementCreditCapacity(Boolean(player.carrying));
  const priorCredit = Number.isFinite(player.movementCredit)
    ? Math.max(0, Math.min(capacity, player.movementCredit!))
    : capacity;
  const creditAt = Number.isFinite(player.movementCreditAt)
    ? player.movementCreditAt!
    : player.lastMoveAt;
  return Math.min(capacity, priorCredit + speed * Math.max(0, now - creditAt) / 1_000);
}

/**
 * Validates an untrusted predicted position. Client clocks and velocities are
 * ignored; the server clock bounds displacement and derives velocity.
 */
export function validateMovement(player: StoredPlayer, message: MoveMessage, now: number, pit: PitLayout = getPitLayout()): MovementResult | null {
  if (!Number.isSafeInteger(message.seq) || message.seq <= player.lastSeq) return null;
  if (!isSafeWorldCoordinate(message.x) || !isSafeWorldCoordinate(message.z)) return null;

  const speed = player.carrying ? CARRY_SPEED : WALK_SPEED;
  const replenishedCredit = replenishedMovementCredit(player, now);
  const deltaX = message.x - player.x;
  const deltaZ = message.z - player.z;
  const distance = Math.hypot(deltaX, deltaZ);
  if (!Number.isFinite(distance)) return null;
  const acceptedDistance = Math.min(distance, replenishedCredit);
  const scale = distance > acceptedDistance ? acceptedDistance / distance : 1;
  const boundedX = player.x + deltaX * scale;
  const boundedZ = player.z + deltaZ * scale;
  const safe = clampPositionOutsidePit(boundedX, boundedZ, pit);
  const actualElapsed = Math.max(0.016, (now - player.lastMoveAt) / 1_000);
  const explicitStop =
    typeof message.vx === "number" &&
    Number.isFinite(message.vx) &&
    typeof message.vz === "number" &&
    Number.isFinite(message.vz) &&
    Math.hypot(message.vx, message.vz) < 0.05;

  let velocityX = (safe.x - player.x) / actualElapsed;
  let velocityZ = (safe.z - player.z) / actualElapsed;
  const velocityMagnitude = Math.hypot(velocityX, velocityZ);
  const visualVelocityLimit = speed * 1.15;
  if (velocityMagnitude > visualVelocityLimit) {
    const velocityScale = visualVelocityLimit / velocityMagnitude;
    velocityX *= velocityScale;
    velocityZ *= velocityScale;
  }

  return {
    x: roundPosition(safe.x),
    z: roundPosition(safe.z),
    // Position remains server-bounded. A zero client velocity is trusted only
    // as a stop edge so remotes freeze immediately and the final pose is
    // durably flushed before this quiet socket can hibernate.
    vx: explicitStop ? 0 : roundVelocity(velocityX),
    vz: explicitStop ? 0 : roundVelocity(velocityZ),
    heading: normalizeHeading(message.heading, player.heading),
    lastMoveAt: now,
    lastSeq: message.seq,
    movementCredit: Math.max(0, replenishedCredit - Math.hypot(safe.x - player.x, safe.z - player.z)),
    movementCreditAt: now,
  };
}

export function safeSpawn(actorId: string, occupied: Array<{ x: number; z: number }> = [], pit: PitLayout = getPitLayout()) {
  let hash = 2166136261;
  for (const character of actorId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const baseAngle = ((hash >>> 0) / 4_294_967_296) * Math.PI * 2;
  const baseRadius = pit.wallRadius + 4.5 + ((hash >>> 8) % 300) / 100;
  return findNonStackedPosition(
    pit.center.x + Math.cos(baseAngle) * baseRadius,
    pit.center.z + Math.sin(baseAngle) * baseRadius,
    occupied,
    pit,
  );
}

/** Finds the nearest deterministic free position used by spawn placement. */
export function findNonStackedPosition(
  desiredX: number,
  desiredZ: number,
  occupied: Array<{ x: number; z: number }>,
  pit: PitLayout = getPitLayout(),
) {
  const safe = clampPositionOutsidePit(
    isSafeWorldCoordinate(desiredX) ? desiredX : 0,
    isSafeWorldCoordinate(desiredZ) ? desiredZ : 18,
    pit,
  );
  const minimumDistance = PLAYER_RADIUS * 2.15;
  const buckets = new Map<string, Array<{ x: number; z: number }>>();
  const cell = (value: number) => Math.floor(value / minimumDistance);
  for (const position of occupied) {
    if (!isSafeWorldCoordinate(position.x) || !isSafeWorldCoordinate(position.z)) continue;
    const key = `${cell(position.x)}:${cell(position.z)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(position);
    else buckets.set(key, [position]);
  }
  const isFree = (x: number, z: number) => {
    if (!isSafeWorldCoordinate(x) || !isSafeWorldCoordinate(z)) return false;
    const radius = Math.hypot(x - pit.center.x, z - pit.center.z);
    if (radius < pit.wallRadius + PLAYER_RADIUS) return false;
    const cellX = cell(x);
    const cellZ = cell(z);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
        for (const position of buckets.get(`${cellX + offsetX}:${cellZ + offsetZ}`) || []) {
          if (Math.hypot(x - position.x, z - position.z) < minimumDistance) return false;
        }
      }
    }
    return true;
  };

  if (isFree(safe.x, safe.z)) return { x: roundPosition(safe.x), z: roundPosition(safe.z) };

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let index = 1; index <= SPAWN_SEARCH_LIMIT; index += 1) {
    const radius = minimumDistance * Math.sqrt(index);
    const angle = goldenAngle * index;
    const candidate = clampPositionOutsidePit(
      safe.x + Math.cos(angle) * radius,
      safe.z + Math.sin(angle) * radius,
      pit,
    );
    if (isFree(candidate.x, candidate.z)) {
      return { x: roundPosition(candidate.x), z: roundPosition(candidate.z) };
    }
  }

  // Search cost stays fixed even if storage is corrupted. In an unbounded
  // world this deterministic fallback can simply move beyond the searched
  // cluster instead of scanning a finite map grid.
  const fallbackAngle = occupied.length * goldenAngle;
  const fallbackRadius = minimumDistance * (SPAWN_SEARCH_LIMIT + occupied.length + 1);
  return {
    x: roundPosition(safe.x + Math.cos(fallbackAngle) * fallbackRadius),
    z: roundPosition(safe.z + Math.sin(fallbackAngle) * fallbackRadius),
  };
}

export function publicPlayer(player: StoredPlayer) {
  return {
    id: player.id,
    x: player.x,
    z: player.z,
    vx: player.vx,
    vz: player.vz,
    heading: player.heading,
    carrying: player.carrying,
    sleeping: player.sleeping,
    profile: player.profile,
  };
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now = Date.now(), amount = 1) {
    const elapsed = Math.max(0, now - this.updatedAt) / 1_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}

function roundPosition(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundVelocity(value: number) {
  const bounded = Math.max(-12, Math.min(12, value));
  return Math.round(bounded * 100) / 100;
}
