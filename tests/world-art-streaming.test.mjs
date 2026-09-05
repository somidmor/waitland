import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createCentralMeadowGeometry, createWaitingWorld } from "../app/world-art.ts";
import { advancePitState, createInitialPitState, getStoneDescriptor } from "../shared/world.ts";

function groundHits(world, x, z) {
  world.root.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
  return raycaster.intersectObject(world.ground);
}

function completedPit(pit, now) {
  return advancePitState({ ...pit, count: pit.capacity - 1 }, now);
}

test("meadow has a real opening which follows the growing pit and closes beneath its monument", () => {
  const scene = new THREE.Scene();
  const world = createWaitingWorld(scene);
  const initial = createInitialPitState(1_783_123_200_000);
  world.setPit(initial);
  assert.equal(groundHits(world, 0, 0).length, 0, "ground must not cover the pit floor");
  assert.ok(groundHits(world, 0, 10).length > 0, "ground remains available for walking");
  const floor = world.root.getObjectByName("pit-floor");
  assert.ok(floor.geometry.boundingBox.max.y * floor.parent.scale.y < -1);

  world.update(1);
  const next = completedPit(initial, 1_783_209_600_000);
  world.setPit(next);
  assert.ok(groundHits(world, 0, 0).length > 0, "the completed excavation has solid ground");
  assert.equal(groundHits(world, next.center.x, next.center.z).length, 0);
  const active = world.root.getObjectByName("active-pit");
  assert.equal(active.position.x, next.center.x);
  assert.ok(active.scale.x > 1, "the new excavation is larger");
  const monument = world.root.getObjectByName("monument-1");
  assert.ok(monument instanceof THREE.Group);
  assert.equal(world.monuments.get(1), monument);
  assert.equal(monument.userData.monument.name, "A little patience");
  assert.equal(monument.userData.monument.stoneCount, 100);
  assert.equal(monument.userData.monument.completedAt, 1_783_209_600_000);
  assert.ok(monument.userData.labelHeight > 5, "DOM labels receive a stable world anchor above the sculpture");
  let spriteCount = 0;
  monument.traverse((object) => { if (object instanceof THREE.Sprite) spriteCount += 1; });
  assert.equal(spriteCount, 0, "monument text belongs to the readable screen-space overlay");
  assert.ok(monument.getObjectByName("stone-sculpture").children.length > 3);
  world.update(3);
  assert.equal(monument.scale.x, 1, "the new statue finishes its reveal animation");
  world.dispose();
});

test("recycled stones preserve their mesh and stay independently pickable", () => {
  const world = createWaitingWorld(new THREE.Scene());
  const first = getStoneDescriptor(0);
  const stone = world.setStone(first);
  assert.equal(stone.userData.stoneId, first.id);
  world.highlightStone(first.id);
  world.update(2);
  const marker = world.root.getObjectByName("stone-selection-ring");
  assert.equal(marker.visible, true);
  assert.equal(marker.position.x, first.x);
  const recycled = getStoneDescriptor(0, 1);
  assert.equal(world.setStone(recycled, false), stone);
  world.update(3);
  assert.equal(world.stones.size, 1);
  assert.equal(marker.visible, false);
  world.setStone(recycled, true);
  world.update(4);
  assert.equal(marker.visible, true);
  assert.equal(marker.position.x, recycled.x);
  assert.equal(marker.position.z, recycled.z);
  world.dispose();
});

test("long walks keep scenery bounded and the ground follows the player", () => {
  const scene = new THREE.Scene();
  const originalBackground = new THREE.Color(0x123456);
  scene.background = originalBackground;
  const world = createWaitingWorld(scene);
  const countObjects = () => {
    let count = 0;
    world.root.traverse(() => { count += 1; });
    return count;
  };
  const initialObjects = countObjects();
  for (let index = 0; index < 30; index += 1) {
    world.update(index, index * 1_000, -index * 1_000);
    assert.equal(countObjects(), initialObjects);
    world.root.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) assert.ok(object.count <= object.instanceMatrix.count);
    });
  }
  assert.ok(groundHits(world, 29_000, -29_000).length > 0);
  world.dispose();
  world.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(scene.background, originalBackground);
  assert.equal(scene.fog, null);
});

test("old monuments are retired without disposing active pickable stone geometry", () => {
  const world = createWaitingWorld(new THREE.Scene());
  const stone = world.setStone(getStoneDescriptor(0));
  let stoneDisposals = 0;
  stone.geometry.addEventListener("dispose", () => { stoneDisposals += 1; });
  let pit = createInitialPitState(1_783_123_200_000);
  for (let round = 0; round < 10; round += 1) {
    pit = completedPit(pit, pit.startedAt + 1_000);
    world.setPit(pit);
  }
  const monuments = world.root.getObjectByName("completed-monuments");
  assert.equal(monuments.children.length, 8);
  assert.equal(world.root.getObjectByName("monument-1"), undefined);
  assert.equal(stoneDisposals, 0);
  world.dispose();
  assert.equal(stoneDisposals, 1);
});

test("central meadow preview maintains normalized UVs and upward normals", () => {
  const geometry = createCentralMeadowGeometry();
  const uv = geometry.getAttribute("uv");
  const normal = geometry.getAttribute("normal");
  for (let index = 0; index < uv.count; index += 1) {
    assert.ok(uv.getX(index) >= 0 && uv.getX(index) <= 1);
    assert.ok(uv.getY(index) >= 0 && uv.getY(index) <= 1);
    assert.ok(normal.getY(index) > 0.99);
  }
  geometry.dispose();
});
