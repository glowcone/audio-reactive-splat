#!/usr/bin/env python3
"""
Convert a 3D Gaussian Splat PLY into a real triangle MESH.

A gaussian-splat PLY is NOT a mesh: it's ~1M oriented, colored ellipsoids
(x/y/z + f_dc + opacity + scale + rot). To get a mesh you have to run surface
reconstruction on the splat centers. This script:

  1. reads the splat centers (x,y,z) and DC color, drops low-opacity splats
  2. estimates normals
  3. runs Poisson surface reconstruction (watertight) OR Ball-Pivoting
  4. transfers vertex colors from the nearest splat
  5. writes an OBJ + GLB mesh

FBX itself is a closed Autodesk format that open3d cannot write, so we export a
mesh open3d *can* write, then you convert that to FBX with Blender (one line,
see README / --print-fbx-cmd). GLB->FBX is lossless for geometry + color.

Usage:
    pip install open3d numpy plyfile
    python splat_to_mesh.py ../gaussian/point_cloud_1.ply -o out/mesh \
        --method poisson --depth 10 --min-opacity 0.1
    python splat_to_mesh.py ... --print-fbx-cmd     # show Blender FBX command
"""
import argparse, os, sys
import numpy as np

C0 = 0.28209479177387814  # SH band-0 constant: rgb = 0.5 + C0 * f_dc


def load_splats(path, min_opacity):
    from plyfile import PlyData
    ply = PlyData.read(path)
    v = ply["vertex"].data
    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float64)

    if "opacity" in v.dtype.names:
        alpha = 1.0 / (1.0 + np.exp(-v["opacity"]))  # sigmoid
        keep = alpha >= min_opacity
    else:
        keep = np.ones(len(xyz), dtype=bool)

    rgb = None
    if all(c in v.dtype.names for c in ("f_dc_0", "f_dc_1", "f_dc_2")):
        rgb = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1)
        rgb = np.clip(0.5 + C0 * rgb, 0.0, 1.0)

    xyz = xyz[keep]
    if rgb is not None:
        rgb = rgb[keep]
    print(f"  loaded {len(v):,} splats -> {len(xyz):,} kept "
          f"(opacity >= {min_opacity})")
    return xyz, rgb


def build_pcd(xyz, rgb):
    import open3d as o3d
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)
    if rgb is not None:
        pcd.colors = o3d.utility.Vector3dVector(rgb)
    # normals are required for reconstruction
    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamKNN(knn=30))
    pcd.orient_normals_consistent_tangent_plane(30)
    return pcd


def reconstruct(pcd, method, depth, density_quantile):
    import open3d as o3d
    if method == "poisson":
        mesh, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=depth)
        # Poisson invents geometry in empty regions; trim low-density verts.
        dens = np.asarray(dens)
        thr = np.quantile(dens, density_quantile)
        mesh.remove_vertices_by_mask(dens < thr)
    elif method == "bpa":
        d = np.mean(pcd.compute_nearest_neighbor_distance())
        radii = [d * r for r in (1.0, 2.0, 4.0)]
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
            pcd, o3d.utility.DoubleVector(radii))
    else:
        raise ValueError(method)
    mesh.compute_vertex_normals()
    mesh.remove_duplicated_vertices()
    mesh.remove_degenerate_triangles()
    print(f"  mesh: {len(mesh.vertices):,} verts, "
          f"{len(mesh.triangles):,} tris")
    return mesh


def transfer_color(mesh, pcd):
    """Poisson output has no color; copy from nearest input splat."""
    import open3d as o3d
    if not pcd.has_colors():
        return
    kdt = o3d.geometry.KDTreeFlann(pcd)
    src = np.asarray(pcd.colors)
    verts = np.asarray(mesh.vertices)
    out = np.zeros((len(verts), 3))
    for i, p in enumerate(verts):
        _, idx, _ = kdt.search_knn_vector_3d(p, 1)
        out[i] = src[idx[0]]
    mesh.vertex_colors = o3d.utility.Vector3dVector(out)


FBX_CMD = (
    'blender --background --python-expr "'
    "import bpy,sys; "
    "bpy.ops.wm.read_factory_settings(use_empty=True); "
    "bpy.ops.import_scene.gltf(filepath='{glb}'); "
    "bpy.ops.export_scene.fbx(filepath='{fbx}', path_mode='COPY', "
    "embed_textures=True)"
    '"'
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ply")
    ap.add_argument("-o", "--out", default="out/mesh",
                    help="output path prefix (no extension)")
    ap.add_argument("--method", choices=["poisson", "bpa"], default="poisson")
    ap.add_argument("--depth", type=int, default=10,
                    help="Poisson octree depth (higher = more detail, slower)")
    ap.add_argument("--min-opacity", type=float, default=0.1)
    ap.add_argument("--density-quantile", type=float, default=0.05,
                    help="trim this fraction of lowest-density Poisson verts")
    ap.add_argument("--up", choices=["keep", "zup-to-yup"], default="zup-to-yup",
                    help="axis convention of the output. The PLY is Z-up; "
                         "'zup-to-yup' (default) rotates -90° about X so it's "
                         "upright in Y-up tools (glTF/GLB, Unity, three.js). "
                         "Use 'keep' to leave raw Z-up coords.")
    ap.add_argument("--print-fbx-cmd", action="store_true")
    args = ap.parse_args()

    try:
        import open3d  # noqa
    except ImportError:
        sys.exit("Missing deps. Run: pip install open3d numpy plyfile")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    print("Reading splats…")
    xyz, rgb = load_splats(args.ply, args.min_opacity)
    print("Estimating normals…")
    pcd = build_pcd(xyz, rgb)
    print(f"Reconstructing ({args.method})…")
    mesh = reconstruct(pcd, args.method, args.depth, args.density_quantile)
    if args.method == "poisson":
        print("Transferring color…")
        transfer_color(mesh, pcd)

    import open3d as o3d
    if args.up == "zup-to-yup":
        # -90° about X: (x, y, z) -> (x, z, -y). Makes Z-up data upright in Y-up tools.
        R = np.array([[1, 0, 0, 0],
                      [0, 0, 1, 0],
                      [0, -1, 0, 0],
                      [0, 0, 0, 1]], dtype=np.float64)
        mesh.transform(R)
        mesh.compute_vertex_normals()
        print("Rotated Z-up -> Y-up")

    obj, glb = args.out + ".obj", args.out + ".glb"
    o3d.io.write_triangle_mesh(obj, mesh)
    o3d.io.write_triangle_mesh(glb, mesh)
    print(f"Wrote {obj} and {glb}")

    fbx = args.out + ".fbx"
    cmd = FBX_CMD.format(glb=os.path.abspath(glb), fbx=os.path.abspath(fbx))
    if args.print_fbx_cmd:
        print("\nTo produce FBX (needs Blender installed):\n" + cmd)
    else:
        print("\nFor FBX, run this (needs Blender), or pass --print-fbx-cmd:\n"
              + cmd)


if __name__ == "__main__":
    main()
