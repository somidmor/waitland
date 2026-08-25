# Waitland avatar art direction

These raster sources are development references, not runtime assets. They keep
the first modular character kit visually coherent while the optimized runtime
meshes remain independent from any one generator.

## Files

- `waitland-base-tpose.png` — model-ready, front-facing base humanoid used as
  the image-to-3D source. The base is intentionally neutral and separates the
  hairline, neck, shoulders, waist, wrists, and ankles so future parts have
  stable attachment boundaries.
- `waitland-wardrobe-board.png` — the starter catalog: six hair families, four
  tops, three bottoms, glasses, scarf, cap, and shoes.

Both images were generated with the built-in ImageGen workflow on 2026-08-25.
The supplied mobile mockup was used only as a style and material reference.

## Runtime contract

- One ground-centered humanoid, facing the scene's forward axis.
- Stable string IDs for every part; catalog order must never change an existing
  character.
- One shared scale, rest pose, and set of attachment points.
- Hair and rigid accessories attach at named sockets. Deforming clothing must
  be rebound to the canonical skeleton before it becomes a runtime asset.
- Warm matte skin, clay forms, and tactile knit materials; no baked dramatic
  lighting.
- Raw generator output stays in ignored `meshy_output/`. Only reviewed,
  optimized runtime files belong under `public/assets/avatars/`.
