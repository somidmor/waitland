import type { RiggedAvatarManifest } from "./rigged-avatar-runtime.ts";

/**
 * Versioned production humanoid asset. The local hero and bounded nearby
 * remotes share this decoded template; distant/overflow crowds use instanced
 * procedural LOD geometry.
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
    lockScale: true,
    rebaseHips: true,
  },
  normalization: {
    targetHeight: 3.05,
    centerXZ: true,
    ground: true,
    sourceForward: "+z",
  },
  anchors: {
    heldItem: { bone: "rightHand" },
    speechPosition: [0, 3.34, 0],
  },
} as const satisfies RiggedAvatarManifest;
