# Splat Explorer + Panorama

Fly through a 3D Gaussian Splat and capture 360° equirectangular panoramas.

## Run the viewer

Gaussian splat PLYs must be served over HTTP (not `file://`). From this folder:

```bash
python3 -m http.server 8777
```

Then open **http://localhost:8777/viewer/**

- **W A S D** — move · **Space / Ctrl** — up / down · **Shift** — boost
- Move the mouse to look around (click "enter" to lock the pointer)
- **P** or the button — render a 360° panorama at your current spot and download it as a PNG
- Toggle **Flip up** if the scene loads upside-down
- Panorama resolution selectable up to 8K (8192×4096)

The panorama works by rendering the scene to 6 cube faces at your position
(waiting a few frames each so Spark's async splat sort settles), then
reprojecting the cube to an equirectangular PNG in the browser.

Built with [Spark](https://sparkjs.dev) (`@sparkjsdev/spark` 2.1.0) on THREE.js
— loaded from CDN via the importmap in `viewer/index.html`, no build step.

## Splat → mesh → FBX

A splat is **not** a mesh — it's ~889k oriented colored ellipsoids. Turning it
into a mesh requires surface reconstruction, which is inherently lossy
(splats capture appearance, not clean geometry). `tools/splat_to_mesh.py` does it:

```bash
pip install open3d numpy plyfile
python tools/splat_to_mesh.py gaussian/point_cloud_1.ply -o out/mesh \
    --method poisson --depth 10 --min-opacity 0.1
```

Outputs `out/mesh.obj` and `out/mesh.glb` (with vertex colors). Open3D can't
write FBX (closed Autodesk format), so convert the GLB with Blender:

```bash
python tools/splat_to_mesh.py gaussian/point_cloud_1.ply --print-fbx-cmd
# prints a one-line `blender --background ...` command that imports the GLB
# and exports out/mesh.fbx
```

Tuning: raise `--depth` (11–12) for more detail (slower); use `--method bpa`
for a non-watertight mesh that hugs the points more tightly; raise
`--min-opacity` to drop faint/floater splats before reconstruction.
