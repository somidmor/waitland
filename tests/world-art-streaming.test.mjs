import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createCentralMeadowGeometry,
  createStorybookWorld,
} from "../app/world-art.ts";

function instanceMatrices(mesh) {
  const matrix = new THREE.Matrix4();
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getMatrixAt(index, matrix);
    return matrix.elements.slice();
  });
}

test("storybook scenery recycles deterministic chunks around long journeys", () => {
  const scene = new THREE.Scene();
  const world = createStorybookWorld(scene);
  const root = scene.getObjectByName("storybook-world");
  const ground = scene.getObjectByName("streamed-meadow-tiles");
  const centralMeadow = scene.getObjectByName("central-pit-meadow");
  const horizon = scene.getObjectByName("travelling-horizon");

  assert.ok(root instanceof THREE.Group);
  assert.ok(ground instanceof THREE.InstancedMesh);
  assert.ok(centralMeadow instanceof THREE.Mesh);
  assert.ok(horizon instanceof THREE.Group);
  assert.equal(ground.count, 48, "the origin tile is replaced by the authored pit tile");

  world.update(2, 1_000, -1_000);
  assert.equal(ground.count, 49, "the fixed seven-by-seven tile pool stays bounded");
  assert.deepEqual(horizon.position.toArray(), [1_000, 0, -1_000]);
  const firstVisit = instanceMatrices(ground);

  world.update(3, 0, 0);
  world.update(4, 1_000, -1_000);
  assert.deepEqual(
    instanceMatrices(ground),
    firstVisit,
    "returning to a chunk must reproduce the same streamed tile layout",
  );

  world.dispose();
  assert.equal(scene.getObjectByName("storybook-world"), undefined);
});

test("central meadow normalizes grass UVs around the irregular pit opening", () => {
  const geometry = createCentralMeadowGeometry();
  const uv = geometry.getAttribute("uv");
  const values = Array.from({ length: uv.count }, (_, index) => [
    uv.getX(index),
    uv.getY(index),
  ]).flat();

  assert.ok(Math.min(...values) >= -0.001);
  assert.ok(Math.max(...values) <= 1.001);
  assert.ok((geometry.boundingBox?.min.x ?? 0) < -20);
  assert.ok((geometry.boundingBox?.max.x ?? 0) > 20);
  geometry.dispose();
});
