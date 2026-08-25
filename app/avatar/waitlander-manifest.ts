import type { RiggedAvatarManifest } from "./rigged-avatar-runtime.ts";

/**
 * Versioned production hero asset. Remote crowds continue to use instanced LOD
 * geometry, while this model gives the local player the authored Meshy rig.
 */
export const WAITLANDER_RUNTIME_MANIFEST = {
  schemaVersion: 1,
  assetId: "waitlander-base",
  assetVersion: "1.0.0+3900935e",
  url: "/assets/avatars/v1/waitlander-runtime.glb",
  animations: {
    walk: ["walking_man", "walking"],
    idle: ["|Idle|", "idle"],
    interact: ["Female_Crouch_Pick_Throw_Forward", "pick_throw"],
    fadeSeconds: 0.16,
    walkTimeScale: 0.92,
    interactTimeScale: 4.5,
  },
  normalization: {
    targetHeight: 3.05,
    centerXZ: true,
    ground: true,
    sourceForward: "-z",
  },
  anchors: {
    heldItem: { bone: "rightHand" },
    speechPosition: [0, 3.34, 0],
  },
} as const satisfies RiggedAvatarManifest;
