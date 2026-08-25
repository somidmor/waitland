# Waitland runtime avatars

`v1/waitlander-runtime.glb` is the production hero-character mesh generated
from `art-source/avatars/waitland-base-tpose.png` with Meshy 6, then auto-rigged
with Meshy's humanoid rig. The final runtime asset combines Meshy's walk, idle,
and crouch/pick/throw animation tracks against one shared skeleton and mesh.

The shipped GLB is optimized for mobile delivery with glTF Transform:

- one skinned mesh and one material
- 17,342 uploaded vertices / 20,704 triangles
- 1024px WebP texture
- quantized geometry and resampled animation
- three named animation clips in one GLB
- 948,204 bytes on disk

Raw Meshy task files remain in the ignored `meshy_output/` workspace folder.
The procedural avatar modules remain the scalable customization and fallback
layer; this asset is the high-fidelity local-player presentation.
