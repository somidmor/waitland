import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { RemoteAvatarRenderer } from "../app/remote-avatar-renderer.ts";

test("remote avatar instance tints are not multiplied by missing vertex colors", () => {
  const scene = new THREE.Scene();
  const renderer = new RemoteAvatarRenderer(scene, {
    interpolationDelayMs: 0,
    maxRenderDistance: 20,
    detailDistance: 20,
    maxRiggedPlayers: 0,
  });
  renderer.upsert({
    id: "remote-color-check",
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    moving: false,
    appearance: {
      skin: 0xd8a277,
      hair: 0x5b3c2b,
      sweater: 0x58775b,
      trousers: 0x4d6170,
      shoes: 0x6b4b36,
    },
  });

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 1.5, 0);
  camera.updateMatrixWorld(true);
  renderer.update(
    performance.now(),
    1 / 60,
    camera,
    { x: 0, z: 0 },
    { width: 600, height: 600 },
  );

  const tintedMeshes = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh) || object.count === 0 || !object.instanceColor) {
      return;
    }
    tintedMeshes.push(object);
  });
  assert.ok(tintedMeshes.length >= 10, "expected colored body and clothing instances");
  for (const mesh of tintedMeshes) {
    assert.equal(mesh.geometry.getAttribute("color"), undefined);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) assert.equal(material.vertexColors, false);
    const tint = new THREE.Color();
    mesh.getColorAt(0, tint);
    assert.ok(tint.r + tint.g + tint.b > 0.05, "instance tint must remain non-black");
  }

  renderer.dispose();
});
