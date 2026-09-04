import assert from "node:assert/strict";
import test from "node:test";
import { nextWalkingPosition, pitApproach } from "../app/game-navigation.ts";
import { createInitialPitState, getPitLayout } from "../shared/world.ts";

test("tapped route walks around the pit and reaches the opposite rock", () => {
  const pit = createInitialPitState(0);
  let position = { x: 0, z: 10 };
  const destination = { x: 0, z: -10 };
  for (let i = 0; i < 1000; i++) {
    position = nextWalkingPosition(position, destination, 0.1, pit);
    assert.ok(Math.hypot(position.x, position.z) >= pit.wallRadius, "cannot enter excavation");
  }
  assert.ok(Math.hypot(position.x - destination.x, position.z - destination.z) < 0.2, "reaches tapped destination");
});

test("routes and throw approach follow a later pit away from the origin", () => {
  const pit = { ...createInitialPitState(0), ...getPitLayout(8), round: 8 };
  const start = { x: pit.center.x - 14, z: 0 };
  const destination = { x: pit.center.x + 14, z: 0 };
  let position = start;
  for (let i = 0; i < 1000; i++) position = nextWalkingPosition(position, destination, 0.1, pit);
  assert.ok(Math.hypot(position.x - destination.x, position.z - destination.z) < 0.2);
  const approach = pitApproach(start, pit);
  assert.ok(Math.hypot(approach.x - pit.center.x, approach.z - pit.center.z) > pit.wallRadius);
  assert.ok(Math.hypot(approach.x - pit.center.x, approach.z - pit.center.z) < pit.throwRadius);
});

test("a tap exactly on the collision boundary terminates instead of orbiting", () => {
  const pit = createInitialPitState(0);
  const target = { x: pit.wallRadius, z: 0 };
  let position = { x: -10, z: 0 };
  for (let i = 0; i < 1000; i++) position = nextWalkingPosition(position, target, 0.1, pit);
  assert.ok(Math.hypot(position.x - target.x, position.z) < 0.2);
  assert.deepEqual(pitApproach({ x: 1, z: 0 }, pit), { x: pit.wallRadius + 2, z: 0 });
});
