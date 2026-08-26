export * from "../avatar-design.ts";

export {
  createProceduralAvatar,
  type ProceduralAvatar,
  type ProceduralAvatarAnchors,
  type ProceduralAvatarMaterials,
  type ProceduralAvatarOptions,
  type ProceduralAvatarPose,
} from "./procedural-avatar.ts";

// Keep the loader's runtime values out of the procedural avatar bundle. Load
// `./rigged-avatar-runtime.ts` dynamically when a manifest-backed GLB is used.
export type {
  RiggedAvatarActiveAnimation,
  RiggedAvatarAnchorSpec,
  RiggedAvatarAnimationSlot,
  RiggedAvatarBoneRole,
  RiggedAvatarBoneTransform,
  RiggedAvatarClipSelector,
  RiggedAvatarFailureReason,
  RiggedAvatarInteractionEvent,
  RiggedAvatarInteractionKind,
  RiggedAvatarInteractionOptions,
  RiggedAvatarLoadFailure,
  RiggedAvatarLoadOptions,
  RiggedAvatarLoadResult,
  RiggedAvatarLoadSuccess,
  RiggedAvatarLoader,
  RiggedAvatarManifest,
  RiggedAvatarMotion,
  RiggedAvatarPosture,
  RiggedAvatarPreloadResult,
  RiggedAvatarResolvedClips,
  RiggedAvatarRuntime,
} from "./rigged-avatar-runtime.ts";
