import assert from "node:assert/strict";
import test from "node:test";
import { PIT_WALL_RADIUS, WALK_SPEED } from "../../shared/world.ts";
import {
  CHAT_MAX_CHARACTERS,
  TokenBucket,
  findNonStackedPosition,
  sanitizeActionId,
  sanitizeChat,
  sanitizeProfile,
  validateMovement,
} from "../src/domain.ts";
import type { StoredPlayer } from "../src/types.ts";

function player(overrides: Partial<StoredPlayer> = {}): StoredPlayer {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    x: 10,
    z: 10,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping: false,
    profile: {
      name: "Traveler",
      city: "Somewhere",
      countryCode: "XX",
      countryFlag: "🌍",
      waitReason: "Just waiting",
    },
    lastMoveAt: 1_000,
    lastSeenAt: 1_000,
    lastSeq: 4,
    actionHistory: [],
    ...overrides,
  };
}

test("profile fields are normalized, bounded, and the flag is derived", () => {
  const profile = sanitizeProfile({
    name: "  <A>\u0000    very very very very long traveler name ",
    city: " Vancouver ",
    countryCode: "ca",
    countryFlag: "not trusted",
    waitReason: "Waiting   for coffee",
  });
  assert.equal(profile.name.includes("<"), false);
  assert.equal(Array.from(profile.name).length <= 24, true);
  assert.equal(profile.city, "Vancouver");
  assert.equal(profile.countryCode, "CA");
  assert.equal(profile.countryFlag, "🇨🇦");
  assert.equal(profile.waitReason, "Waiting for coffee");
});

test("chat is text-only and capped at 80 Unicode characters", () => {
  const message = sanitizeChat(`  hello <there> ${"🙂".repeat(100)}  `);
  assert.equal(message.includes("<"), false);
  assert.equal(Array.from(message).length, CHAT_MAX_CHARACTERS);
});

test("movement rejects stale sequences and bounds a teleport using server time", () => {
  const current = player();
  assert.equal(validateMovement(current, { t: "move", seq: 4, x: 11, z: 10 }, 1_100), null);
  const accepted = validateMovement(current, { t: "move", seq: 5, x: 1_000, z: 1_000 }, 1_100);
  assert.ok(accepted);
  assert.ok(Math.hypot(accepted.x - current.x, accepted.z - current.z) < 2.2);
});

test("movement slack is a bounded credit, not a per-packet speed bonus", () => {
  const current = player();
  const startX = current.x;
  for (let index = 1; index <= 50; index += 1) {
    const accepted = validateMovement(
      current,
      { t: "move", seq: current.lastSeq + 1, x: 1_000, z: current.z },
      1_000 + index * 100,
    );
    assert.ok(accepted);
    Object.assign(current, accepted);
  }
  assert.ok(current.x - startX <= WALK_SPEED * 5 + 2.1);
});

test("movement cannot cross into the pit", () => {
  const current = player({ x: PIT_WALL_RADIUS, z: 0 });
  const accepted = validateMovement(current, { t: "move", seq: 5, x: 0, z: 0 }, 1_100);
  assert.ok(accepted);
  assert.ok(Math.hypot(accepted.x, accepted.z) >= PIT_WALL_RADIUS - 0.001);
});

test("an explicit zero-velocity edge persists a stationary final pose", () => {
  const accepted = validateMovement(
    player(),
    { t: "move", seq: 5, x: 10.5, z: 10, vx: 0, vz: 0, heading: 0 },
    1_100,
  );
  assert.ok(accepted);
  assert.equal(accepted.vx, 0);
  assert.equal(accepted.vz, 0);
});

test("spawn placement selects the nearest non-stacked safe slot", () => {
  const occupied = [
    { x: 12, z: 12 },
    { x: 13.4, z: 12 },
  ];
  const placement = findNonStackedPosition(12, 12, occupied);
  for (const other of occupied) assert.ok(Math.hypot(placement.x - other.x, placement.z - other.z) > 1.3);
});

test("token bucket permits a burst and then refills", () => {
  const bucket = new TokenBucket(3, 0.3, 0);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), false);
  assert.equal(bucket.take(3_334), true);
});

test("action ids only admit compact opaque identifiers", () => {
  assert.equal(sanitizeActionId("action_123-A"), "action_123-A");
  assert.equal(sanitizeActionId("not valid"), null);
  assert.equal(sanitizeActionId("x".repeat(49)), null);
});
