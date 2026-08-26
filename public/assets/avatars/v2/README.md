# Waitlander runtime v2

`waitlander-runtime.glb` preserves the complete optimized v1 character and
adds one bind-pose-retargeted Meshy Prime motion:

- `Waitland_Professional_Overarm_Throw` — 2.9667 seconds, 90 samples,
  22 rotation tracks plus one hips translation track.
- Horizontal hips travel is removed so gameplay remains authoritative over
  world position.
- No animation scale tracks are exported; the v1 bind scale is unchanged.
- The source motion's right-wrist velocity peaks at approximately 1.084
  seconds (36.5% of the clip), which is the recommended stone-release marker.

## Source provenance

All raw inputs are retained in the ignored `meshy_output/` workspace. The
selected source is Meshy Text-to-Motion Prime task
`01a03b45-3acb-7c02-a091-eeacf1de344a` (`overarm-throw-prime.fbx`). The two
evaluated alternatives were:

- underarm: `01a03b45-3f77-7c04-9a6d-ed6ce1a550b0`
- chest throw: `01a03b45-443e-7c07-b3ff-800d0d51ff59`

The overarm motion was selected because it is the only single-handed candidate
that matches Waitland's current right-hand held-item anchor. Its much larger
source root translation is intentionally removed by the build.

## Rebuild and verification

From the repository root, with the three FBX source files present at their
recorded `meshy_output/` paths:

```sh
node scripts/build-waitlander-v2.mjs
```

The build script compares all candidates, writes an ignored skeleton preview
and JSON report to `meshy_output/motion-retarget/`, appends the selected clip to
the existing GLB without re-encoding its mesh or WebP texture, then reloads the
result with Three.js. It verifies finite, strictly increasing animation inputs,
fixed horizontal root motion, unchanged canonical mesh/skin/material data,
unchanged original BIN bytes, and bounded CPU-skinned geometry across the
animation.

Current artifact:

- size: 986,948 bytes
- SHA-256: `1864100b929b6c1168b44c4562827c79fd6e0ab8fbe38af5c6ff98596a975e3e`
- deformed world bounds across verification samples: 1.079 × 1.572 × 0.803 m
