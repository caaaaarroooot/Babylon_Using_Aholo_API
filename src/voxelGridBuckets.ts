import { AbstractMesh, Mesh, Vector3, VertexBuffer } from "@babylonjs/core";

export type CellBounds = { min: Vector3; max: Vector3 };

export type VoxelGridCell = {
  bounds: CellBounds;
  center: Vector3;
  half: Vector3;
};

export function collectGeometryMeshes(root: AbstractMesh): Mesh[] {
  const meshes: Mesh[] = [];
  const candidates = [root, ...root.getChildMeshes(true)];
  for (const node of candidates) {
    if (!(node instanceof Mesh) || node.getTotalVertices() <= 0) continue;
    if (node.name.toLowerCase().includes("spawn_point")) continue;
    meshes.push(node);
  }
  return meshes;
}

export function countGeometryVertices(root: AbstractMesh): number {
  return collectGeometryMeshes(root).reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
}

/** collision root 로컬 좌표 기준 — splat sync 시 parent transform만 따름 */
export function bucketTrianglesLocal(
  meshes: Mesh[],
  cellSize: Vector3
): Map<string, CellBounds> {
  const buckets = new Map<string, CellBounds>();

  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) continue;

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];

      const v0 = new Vector3(
        positions[i0 * 3],
        positions[i0 * 3 + 1],
        positions[i0 * 3 + 2]
      );
      const v1 = new Vector3(
        positions[i1 * 3],
        positions[i1 * 3 + 1],
        positions[i1 * 3 + 2]
      );
      const v2 = new Vector3(
        positions[i2 * 3],
        positions[i2 * 3 + 1],
        positions[i2 * 3 + 2]
      );

      const triMin = Vector3.Minimize(Vector3.Minimize(v0, v1), v2);
      const triMax = Vector3.Maximize(Vector3.Maximize(v0, v1), v2);
      const cx = (triMin.x + triMax.x) * 0.5;
      const cy = (triMin.y + triMax.y) * 0.5;
      const cz = (triMin.z + triMax.z) * 0.5;

      const ix = Math.floor(cx / cellSize.x);
      const iy = Math.floor(cy / cellSize.y);
      const iz = Math.floor(cz / cellSize.z);
      const key = `${ix},${iy},${iz}`;

      const cell = buckets.get(key);
      if (!cell) {
        buckets.set(key, { min: triMin.clone(), max: triMax.clone() });
      } else {
        cell.min = Vector3.Minimize(cell.min, triMin);
        cell.max = Vector3.Maximize(cell.max, triMax);
      }
    }
  }

  return buckets;
}

export function rankVoxelGridCells(
  buckets: Map<string, CellBounds>,
  maxCells: number,
  cellSize = new Vector3(2, 0.5, 2)
): VoxelGridCell[] {
  const ranked = [...buckets.entries()]
    .sort(
      (a, b) =>
        (b[1].max.x - b[1].min.x) * (b[1].max.z - b[1].min.z) -
        (a[1].max.x - a[1].min.x) * (a[1].max.z - a[1].min.z)
    )
    .slice(0, maxCells);

  return ranked.map(([, bounds]) => {
    const extent = bounds.max.subtract(bounds.min);
    const half = new Vector3(
      Math.max(extent.x * 0.5, cellSize.x * 0.04),
      Math.max(extent.y * 0.5, cellSize.y * 0.04),
      Math.max(extent.z * 0.5, cellSize.z * 0.04)
    );
    const center = bounds.min.add(extent.scale(0.5));
    return { bounds, center, half };
  });
}

export function buildVoxelGridCells(
  root: AbstractMesh,
  options?: { cellSize?: Vector3; maxCells?: number }
): VoxelGridCell[] {
  const cellSize = options?.cellSize ?? new Vector3(2, 0.5, 2);
  const maxCells = options?.maxCells ?? 2500;
  const meshes = collectGeometryMeshes(root);
  if (meshes.length === 0) return [];

  const buckets = bucketTrianglesLocal(meshes, cellSize);
  return rankVoxelGridCells(buckets, maxCells, cellSize);
}
