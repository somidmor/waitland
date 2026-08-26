import assert from "node:assert/strict";
import test from "node:test";
import {
  createPitFloorGeometry,
  createPitLipGeometry,
  createPitTurfGeometry,
  createPitWallGeometry,
} from "../app/pit-geometry.ts";
import { PIT_RADIUS } from "../shared/world.ts";

function horizontalRadii(geometry, start, count) {
  const positions = geometry.getAttribute("position");
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return Math.hypot(positions.getX(index), positions.getZ(index));
  });
}

test("pit is an irregular shallow excavation rather than a raised torus", () => {
  const floor = createPitFloorGeometry();
  const wall = createPitWallGeometry();
  const lip = createPitLipGeometry();
  const turf = createPitTurfGeometry();

  for (const geometry of [floor, wall, lip, turf]) {
    assert.ok(geometry.index?.count, `${geometry.name} must be indexed`);
    assert.ok(geometry.getAttribute("uv"), `${geometry.name} must accept the earth texture`);
    assert.ok(geometry.getAttribute("normal"), `${geometry.name} must react to world lighting`);
  }

  const outerRadii = horizontalRadii(turf, 0, 72);
  assert.ok(Math.max(...outerRadii) - Math.min(...outerRadii) > 0.4);
  assert.ok(
    Math.min(...outerRadii) > PIT_RADIUS + 0.55,
    "turf fringe overlaps the meadow edge",
  );
  assert.ok(
    (lip.boundingBox?.max.y ?? 1) < 0.04,
    "earth profile stays recessed instead of becoming a raised ring",
  );

  assert.ok((floor.boundingBox?.min.y ?? 0) < -0.8, "floor is visibly recessed");
  assert.ok(
    floor.getAttribute("normal").getY(0) > 0.9,
    "pit floor faces the gameplay camera instead of being back-face culled",
  );
  assert.ok((wall.boundingBox?.max.y ?? -1) > -0.2, "wall meets the meadow cut");
  assert.ok((wall.boundingBox?.min.y ?? 0) < -0.8, "wall reaches the pit floor");

  floor.dispose();
  wall.dispose();
  lip.dispose();
  turf.dispose();
});
