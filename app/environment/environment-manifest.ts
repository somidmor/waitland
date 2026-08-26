import type { EnvironmentAssetManifest } from "./environment-asset-runtime.ts";
import { PIT_WALL_RADIUS } from "../../shared/world.ts";

export const WAITLAND_ENVIRONMENT_MANIFEST_VERSION = "2.0.0" as const;
export const WAITLAND_PIT_OUTER_FOOTPRINT = PIT_WALL_RADIUS * 2;
export const WAITLAND_GAMEPLAY_STONE_SIZE = 0.76;

export type WaitlandEnvironmentAssetId =
  | "meadow-tree"
  | "grass-cluster"
  | "wildflower-cluster"
  | "path-module"
  | "rock-kit"
  | "meadow-shrub";

export type WaitlandEnvironmentPlacement = {
  /** Dense authored clusters replace many individual procedural marks. */
  instancesPerChunk: number;
  /** The outer streamed ring remains the deliberately cheap far LOD. */
  authoredChunkRadius: number;
};

export type WaitlandEnvironmentAssetManifest = EnvironmentAssetManifest & {
  assetId: WaitlandEnvironmentAssetId;
  placement: WaitlandEnvironmentPlacement;
};

const environmentAsset = (
  assetId: WaitlandEnvironmentAssetId,
  normalization: EnvironmentAssetManifest["normalization"],
  placement: WaitlandEnvironmentPlacement,
): WaitlandEnvironmentAssetManifest => ({
  schemaVersion: 1,
  assetId,
  assetVersion: WAITLAND_ENVIRONMENT_MANIFEST_VERSION,
  url: `/assets/environment/v2/${assetId}.glb`,
  normalization,
  rendering: {
    castShadow: assetId === "meadow-tree" || assetId === "meadow-shrub",
    receiveShadow: true,
  },
  placement,
});

/**
 * Production Meshy assets for the streamed meadow. File names are stable so a
 * regenerated model only needs an asset-version bump and never leaks into
 * world/gameplay code.
 */
export const WAITLAND_ENVIRONMENT_MANIFEST = {
  schemaVersion: 1,
  environmentId: "waitland-meadow",
  environmentVersion: WAITLAND_ENVIRONMENT_MANIFEST_VERSION,
  assets: {
    tree: environmentAsset(
      "meadow-tree",
      { targetSize: 3.6, measure: "height", ground: true, centerXZ: true },
      { instancesPerChunk: 1, authoredChunkRadius: 2 },
    ),
    grass: environmentAsset(
      "grass-cluster",
      { targetSize: 0.82, measure: "footprint", ground: true, centerXZ: true },
      { instancesPerChunk: 24, authoredChunkRadius: 1 },
    ),
    flowers: environmentAsset(
      "wildflower-cluster",
      { targetSize: 0.62, measure: "footprint", ground: true, centerXZ: true },
      { instancesPerChunk: 9, authoredChunkRadius: 1 },
    ),
    path: environmentAsset(
      "path-module",
      { targetSize: 5.8, measure: "footprint", ground: true, centerXZ: true },
      { instancesPerChunk: 0, authoredChunkRadius: 0 },
    ),
    rocks: environmentAsset(
      "rock-kit",
      { targetSize: 0.65, measure: "max", ground: true, centerXZ: true },
      { instancesPerChunk: 2, authoredChunkRadius: 2 },
    ),
    shrubs: environmentAsset(
      "meadow-shrub",
      { targetSize: 1.05, measure: "max", ground: true, centerXZ: true },
      { instancesPerChunk: 3, authoredChunkRadius: 1 },
    ),
  },
} as const satisfies {
  schemaVersion: 1;
  environmentId: string;
  environmentVersion: string;
  assets: Record<string, WaitlandEnvironmentAssetManifest>;
};

/**
 * The pit remains independently replaceable because gameplay owns its opening,
 * collision and deposit coordinates. The caller supplies the approved Meshy
 * file instead of coupling the streamed meadow to an unreviewed pit filename.
 */
export function createPitEnvironmentAssetManifest(
  url: string,
  assetVersion: string | number,
): EnvironmentAssetManifest {
  return {
    schemaVersion: 1,
    assetId: "waitland-pit-basin",
    assetVersion,
    url,
    normalization: {
      targetSize: WAITLAND_PIT_OUTER_FOOTPRINT,
      measure: "footprint",
      // The generated landmark contains both the flush sod edge and the
      // recessed earth bowl. Centering its source height around terrain keeps
      // the rim flush instead of lifting the whole excavation into a platter.
      ground: false,
      centerXZ: true,
    },
    rendering: { castShadow: true, receiveShadow: true },
  };
}

/** Authored pit PBR source; gameplay owns the exact excavation and collision shape. */
export const WAITLAND_PIT_ASSET_MANIFEST = createPitEnvironmentAssetManifest(
  "/assets/environment/v2/pit-landmark-v3.glb",
  "3.0.0+01a03b67",
);

/**
 * One shared authored stone replaces the primitive gameplay rock everywhere:
 * field spawns, hands/projectiles, embedded gravel and the visible pit pile.
 */
export const WAITLAND_GAMEPLAY_STONE_ASSET_MANIFEST = {
  schemaVersion: 1,
  assetId: "waitland-gameplay-stone",
  assetVersion: WAITLAND_ENVIRONMENT_MANIFEST_VERSION,
  url: "/assets/environment/v2/gameplay-stone.glb",
  normalization: {
    targetSize: WAITLAND_GAMEPLAY_STONE_SIZE,
    measure: "max",
    // Gameplay already owns the stone center and ground clearance. Keeping the
    // generated rock centered prevents field, held and thrown uses from jumping.
    ground: false,
    centerXZ: true,
  },
  rendering: { castShadow: false, receiveShadow: true },
} as const satisfies EnvironmentAssetManifest;
