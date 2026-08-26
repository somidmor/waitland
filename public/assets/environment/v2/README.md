# Waitland environment runtime v2

These GLBs are the optimized Meshy-authored presentation layer for the warm,
miniature meadow. Gameplay collision, the infinite streamed world, stone IDs,
and the global pit state remain code-owned and independent of model topology.

## Landmark and gameplay props

- `pit-landmark-v3.glb` is the reference-led Meshy material source for the
  gameplay-owned irregular excavation. Its generated bowl silhouette is not
  mounted: exact code-owned turf, exposed-earth, wall, floor, and collision
  geometry preserve the shallow open cut shown in the reference. The authored
  PBR response is combined with purpose-built tileable grass and earth images,
  so no UV atlas is stretched around the rim.
  ImageGen source: `art-source/environment/v2/pit-landmark-v3-concept.png`.
  Meshy Image-to-3D task: `01a03b67-b0db-7bd7-aba7-a42ec8c5b39c`.
- `gameplay-stone.glb` is the one normalized mutable stone visual used for
  field spawns, carrying, projectiles, and the deposited pit pile. The permanent
  bed uses a compact rounded instanced geometry so dozens of stones remain soft
  and readable at phone scale. Four
  shared PBR material tints retain deterministic variety without dark/black
  texture multiplication. Meshy Image-to-3D task:
  `01a03b57-2e8e-71ba-8e1e-bc76488df0fb`.

Both assets keep a procedural error/loading fallback. Raw tasks, source models,
and previews remain in the ignored `meshy_output/` workspace.

## Streamed dressing kit

`meadow-tree.glb`, `meadow-shrub.glb`, `grass-cluster.glb`,
`wildflower-cluster.glb`, `path-module.glb`, and `rock-kit.glb` are shared by
the environment streaming runtime. Their paths and normalization contracts are
versioned in `app/environment/environment-manifest.ts`.

## Runtime cleanup contract

The Meshy exports are cleaned without changing a rendered triangle position or
the model silhouette. The current pass found no degenerate triangles. It
replaced only invalid zero-length normals (1,920 tree, 376 path, 132 pit, and 36
wildflower vertices), removed black emissive maps, and pruned their unreferenced
images. Tree and pit textures are reduced from 1024 to 512 pixels; every other
runtime texture was already 512 pixels.

The normal map remains on the larger tree, where its bark and foliage detail is
material. MikkTSpace tangents are generated for it, with a stable orthonormal
fallback where the Meshy UVs have no usable derivative. The other models use
their geometric normals and base/roughness maps instead. Path and pit normal
maps were also removed because their UV-degenerate tangent split increased the
files by 59% and 41% for negligible mapped detail.

| Asset | Triangles | PBR textures | Sides | Runtime bytes | SHA-256 |
| --- | ---: | --- | --- | ---: | --- |
| `gameplay-stone.glb` | 994 | base + roughness | front | 58,632 | `9c917472383b0c8e` |
| `grass-cluster.glb` | 1,660 | base + roughness | double | 134,720 | `615ea5848b7ae415` |
| `meadow-shrub.glb` | 5,119 | base + roughness | double | 190,068 | `9f6905f0679ce145` |
| `meadow-tree.glb` | 9,459 | base + roughness + normal | double | 842,536 | `2d4e91767f719f89` |
| `path-module.glb` | 4,983 | base + roughness | front | 272,552 | `13a5cb1d379a9abe` |
| `pit-landmark-v3.glb` | 11,524 | base + roughness | double | 406,608 | `321c296621142392` |
| `rock-kit.glb` | 6,501 | base + roughness | front | 168,368 | `2413b7b8ec764543` |
| `wildflower-cluster.glb` | 2,703 | base + roughness | double | 189,096 | `5fcd1c490a4abbc1` |

Foliage-bearing assets stay double-sided. Only the closed gameplay stone, rock
kit, and top-facing path use front-face rendering. The rejected legacy pit
iteration is intentionally absent from the runtime directory.

The dependency-free repair step is reproducible with
`scripts/repair-environment-glb.mjs`. After repair, glTF Transform's `prune`,
`resize`, and `tangents` commands compact the output. Run
`npm run assets:validate` and the runtime asset tests after any regeneration.
All eight referenced environment GLBs currently return zero errors and zero
warnings from the official Khronos glTF validator.
