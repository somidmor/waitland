import type { RiggedAvatarManifest } from "./rigged-avatar-runtime.ts";

/**
 * Versioned production humanoid asset. The local hero and bounded nearby
 * remotes share this decoded template; distant/overflow crowds use instanced
 * procedural LOD geometry.
 */
export const WAITLANDER_RUNTIME_MANIFEST = {
  schemaVersion: 1,
  assetId: "waitlander-base",
  assetVersion: "2.0.0+1864100b",
  url: "/assets/avatars/v2/waitlander-runtime.glb",
  animations: {
    walk: ["walking_man", "walking"],
    idle: ["|Idle|", "idle"],
    pickup: [
      "Male_Bend_Over_Pick_Up",
      "pickup",
      "Female_Crouch_Pick_Throw_Forward",
    ],
    throw: [
      "Waitland_Professional_Overarm_Throw",
      "professional_overarm_throw",
      "Female_Crouch_Pick_Throw_Forward",
    ],
    interact: ["Female_Crouch_Pick_Throw_Forward", "pick_throw"],
    // Pickup still uses the opening of the legacy combined clip. Throw resolves
    // to the dedicated Meshy Prime motion included in the v2 runtime.
    pickupFallbackSegment: [0, 0.42],
    throwFallbackSegment: [0.38, 1],
    fadeSeconds: 0.1,
    walkTimeScale: 0.92,
    pickupTimeScale: 2.2,
    throwTimeScale: 2.2,
    interactTimeScale: 4.5,
    pickupContactProgress: 0.58,
    throwReleaseProgress: 0.365,
    inPlaceInteractions: true,
    lockScale: true,
    rebaseHips: true,
  },
  normalization: {
    targetHeight: 3.78,
    centerXZ: true,
    ground: true,
    sourceForward: "+z",
  },
  anchors: {
    heldItem: { bone: "rightHand" },
    speechPosition: [0, 3.34, 0],
  },
} as const satisfies RiggedAvatarManifest;
