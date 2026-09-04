import { clampPositionOutsidePit, type PitState } from "../shared/world.ts";

export type GroundPoint = { x: number; z: number };

/** Walk around the excavation when a tapped destination is on the other side. */
export function nextWalkingPosition(from: GroundPoint, target: GroundPoint, distance: number, pit: PitState): GroundPoint {
  let dx = target.x - from.x;
  let dz = target.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001 || distance <= 0) return { ...from };
  const px = from.x - pit.center.x;
  const pz = from.z - pit.center.z;
  const projection = Math.max(0, Math.min(1, -(px * dx + pz * dz) / (length * length)));
  const targetRadius = Math.hypot(target.x - pit.center.x, target.z - pit.center.z);
  const clearance = Math.min(pit.wallRadius + 0.5, targetRadius - 0.001);
  if (Math.hypot(px + dx * projection, pz + dz * projection) < clearance && projection > 0) {
    const start = Math.atan2(pz, px);
    const end = Math.atan2(target.z - pit.center.z, target.x - pit.center.x);
    const angle = Math.atan2(Math.sin(end - start), Math.cos(end - start));
    const waypointAngle = start + (angle < 0 ? -1 : 1) * Math.min(0.55, Math.abs(angle));
    const radius = pit.wallRadius + 1.25;
    dx = pit.center.x + Math.cos(waypointAngle) * radius - from.x;
    dz = pit.center.z + Math.sin(waypointAngle) * radius - from.z;
  }
  const remaining = Math.hypot(dx, dz);
  const step = Math.min(distance, remaining);
  return clampPositionOutsidePit(from.x + dx / remaining * step, from.z + dz / remaining * step, pit);
}

export function pitApproach(from: GroundPoint, pit: PitState): GroundPoint {
  const dx = from.x - pit.center.x;
  const dz = from.z - pit.center.z;
  const distance = Math.hypot(dx, dz);
  const radius = pit.wallRadius + 2;
  if (distance < 0.001) return { x: pit.center.x, z: pit.center.z + radius };
  return { x: pit.center.x + dx / distance * radius, z: pit.center.z + dz / distance * radius };
}
