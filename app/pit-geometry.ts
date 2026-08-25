import * as THREE from "three";
import { PIT_RADIUS } from "../shared/world.ts";

export const PIT_EDGE_SEGMENTS = 72;
export const PIT_LIP_OUTER_RADIUS = PIT_RADIUS + 0.92;
export const PIT_LIP_OUTER_PHASE = 1.65;

export function pitEdgeRadius(index: number, baseRadius: number, phase = 0) {
  const angle = (index / PIT_EDGE_SEGMENTS) * Math.PI * 2;
  return (
    baseRadius +
    Math.sin(angle * 3 + phase) * 0.2 +
    Math.sin(angle * 7 - phase * 0.7) * 0.11 +
    Math.cos(angle * 11 + phase * 1.3) * 0.055
  );
}

/** A shallow, irregular excavation matching the reference instead of a torus. */
export function createPitFloorGeometry() {
  const floorY = -0.86;
  const positions = [0, floorY, 0];
  const uvs = [0.5, 0.5];
  const indices: number[] = [];

  for (let index = 0; index < PIT_EDGE_SEGMENTS; index += 1) {
    const angle = (index / PIT_EDGE_SEGMENTS) * Math.PI * 2;
    const radius = pitEdgeRadius(index, PIT_RADIUS - 0.34, 0.9);
    const x = Math.cos(angle) * radius * 1.035;
    const z = Math.sin(angle) * radius;
    positions.push(x, floorY + Math.sin(angle * 5) * 0.018, z);
    uvs.push(0.5 + x / (PIT_RADIUS * 2), 0.5 + z / (PIT_RADIUS * 2));
    indices.push(0, ((index + 1) % PIT_EDGE_SEGMENTS) + 1, index + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "waitland-pit-floor";
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export function createPitWallGeometry() {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let index = 0; index <= PIT_EDGE_SEGMENTS; index += 1) {
    const wrapped = index % PIT_EDGE_SEGMENTS;
    const angle = (wrapped / PIT_EDGE_SEGMENTS) * Math.PI * 2;
    const topRadius = pitEdgeRadius(wrapped, PIT_RADIUS, 0.35);
    const bottomRadius = pitEdgeRadius(wrapped, PIT_RADIUS - 0.34, 0.9);
    positions.push(
      Math.cos(angle) * topRadius * 1.035,
      -0.14 + Math.sin(angle * 5 + 0.4) * 0.045,
      Math.sin(angle) * topRadius,
      Math.cos(angle) * bottomRadius * 1.035,
      -0.86,
      Math.sin(angle) * bottomRadius,
    );
    const u = index / PIT_EDGE_SEGMENTS;
    uvs.push(u, 1, u, 0);
  }

  for (let index = 0; index < PIT_EDGE_SEGMENTS; index += 1) {
    const top = index * 2;
    const nextTop = top + 2;
    indices.push(top, top + 1, nextTop, nextTop, top + 1, nextTop + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "waitland-pit-wall";
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export function createPitLipGeometry() {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const bands = [
    { radius: PIT_LIP_OUTER_RADIUS, phase: PIT_LIP_OUTER_PHASE, height: -0.018 },
    { radius: PIT_RADIUS + 0.43, phase: 1.1, height: -0.055 },
    { radius: PIT_RADIUS, phase: 0.35, height: -0.14 },
  ] as const;

  for (let band = 0; band < bands.length; band += 1) {
    const profile = bands[band];
    for (let index = 0; index <= PIT_EDGE_SEGMENTS; index += 1) {
      const wrapped = index % PIT_EDGE_SEGMENTS;
      const angle = (wrapped / PIT_EDGE_SEGMENTS) * Math.PI * 2;
      const radius = pitEdgeRadius(wrapped, profile.radius, profile.phase);
      const x = Math.cos(angle) * radius * 1.035;
      const z = Math.sin(angle) * radius;
      const edgeRoughness = band === 1 ? Math.sin(angle * 13 + 0.7) * 0.045 : 0;
      positions.push(x, profile.height + edgeRoughness, z);
      uvs.push(index / PIT_EDGE_SEGMENTS, band / (bands.length - 1));
    }
  }

  const stride = PIT_EDGE_SEGMENTS + 1;
  for (let band = 0; band < bands.length - 1; band += 1) {
    for (let index = 0; index < PIT_EDGE_SEGMENTS; index += 1) {
      const outer = band * stride + index;
      const inner = (band + 1) * stride + index;
      indices.push(outer, inner, outer + 1, outer + 1, inner, inner + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "waitland-pit-earth-lip";
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
