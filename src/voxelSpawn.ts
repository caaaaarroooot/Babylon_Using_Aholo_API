import {
  AbstractMesh,
  Matrix,
  Mesh,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";

export type VoxelSpawnMode = "densest-floor" | "probe";

export type VoxelSpawnOptions = {
  mode?: VoxelSpawnMode;
  probeXZ?: Vector3;
  sampleRadius?: number;
  sampleGrid?: number;
  gridCellSize?: number;
  minCellSamples?: number;
  topCellsBlend?: number;
  floorBandMinRatio?: number;
  floorBandMaxRatio?: number;
  upwardNormalMin?: number;
  /** true면 아래향 면 제외 — 로봇 바닥(위를 향한 면)만 사용 */
  upwardOnly?: boolean;
  /** 반경 내 floor sample Y 집계 방식 */
  floorYStrategy?: "median" | "min" | "max";
  eyeHeight?: number;
};

export type VoxelSpawnResult = {
  position: Vector3;
  floorY: number;
  eyeY: number;
  hitCount: number;
  cellCount: number;
};

type FloorSample = { x: number; z: number; y: number };

type FloorCell = {
  count: number;
  sumX: number;
  sumZ: number;
  ys: number[];
};

const DEFAULTS = {
  sampleRadius: 1.2,
  sampleGrid: 3,
  gridCellSize: 2,
  minCellSamples: 12,
  topCellsBlend: 6,
  floorBandMinRatio: 0.08,
  floorBandMaxRatio: 0.42,
  upwardNormalMin: 0.45,
  eyeHeight: 1.45,
} as const;

function collectCollisionMeshes(root: AbstractMesh): Mesh[] {
  root.computeWorldMatrix(true);
  const candidates = [root, ...root.getChildMeshes(true)];
  const meshes: Mesh[] = [];
  for (const mesh of candidates) {
    if (!(mesh instanceof Mesh)) continue;
    if (mesh.getTotalVertices() <= 0) continue;
    mesh.refreshBoundingInfo(true);
    meshes.push(mesh);
  }
  return meshes;
}

function worldVertex(
  positions: Float32Array | number[],
  index: number,
  worldMatrix: Matrix
): Vector3 {
  const local = new Vector3(
    positions[index * 3],
    positions[index * 3 + 1],
    positions[index * 3 + 2]
  );
  return Vector3.TransformCoordinates(local, worldMatrix);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function triangleFloorSample(
  v0: Vector3,
  v1: Vector3,
  v2: Vector3,
  normal: Vector3,
  upwardNormalMin: number,
  yMin: number,
  yMax: number,
  upwardOnly = false
): FloorSample | null {
  const facingUp = normal.y >= upwardNormalMin;
  const facingDown = !upwardOnly && normal.y <= -upwardNormalMin;
  if (!facingUp && !facingDown) return null;

  const surfaceY = facingUp
    ? Math.max(v0.y, v1.y, v2.y)
    : Math.min(v0.y, v1.y, v2.y);
  if (surfaceY < yMin || surfaceY > yMax) return null;

  return {
    x: (v0.x + v1.x + v2.x) / 3,
    y: surfaceY,
    z: (v0.z + v1.z + v2.z) / 3,
  };
}

function pickFloorY(hits: number[], strategy: "median" | "min" | "max"): number {
  const sorted = [...hits].sort((a, b) => a - b);
  if (strategy === "min") return sorted[0];
  if (strategy === "max") return sorted[sorted.length - 1];
  return median(sorted);
}

function collectAllFloorSamples(
  meshes: Mesh[],
  yMin: number,
  yMax: number,
  upwardNormalMin: number,
  upwardOnly = false
): FloorSample[] {
  const samples: FloorSample[] = [];

  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) continue;

    mesh.computeWorldMatrix(true);
    const worldMatrix = mesh.getWorldMatrix();

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];

      const v0 = worldVertex(positions, i0, worldMatrix);
      const v1 = worldVertex(positions, i1, worldMatrix);
      const v2 = worldVertex(positions, i2, worldMatrix);

      const edge1 = v1.subtract(v0);
      const edge2 = v2.subtract(v0);
      const normal = Vector3.Cross(edge1, edge2);
      if (normal.lengthSquared() < 1e-12) continue;
      normal.normalize();

      const sample = triangleFloorSample(
        v0,
        v1,
        v2,
        normal,
        upwardNormalMin,
        yMin,
        yMax,
        upwardOnly
      );
      if (sample) samples.push(sample);
    }
  }

  return samples;
}

function collectAllFloorSamplesLocal(
  meshes: Mesh[],
  yMin: number,
  yMax: number,
  upwardNormalMin: number
): FloorSample[] {
  const samples: FloorSample[] = [];

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

      const edge1 = v1.subtract(v0);
      const edge2 = v2.subtract(v0);
      const normal = Vector3.Cross(edge1, edge2);
      if (normal.lengthSquared() < 1e-12) continue;
      normal.normalize();

      const sample = triangleFloorSample(
        v0,
        v1,
        v2,
        normal,
        upwardNormalMin,
        yMin,
        yMax,
        true
      );
      if (sample) samples.push(sample);
    }
  }

  return samples;
}

function getMeshesLocalBounds(meshes: Mesh[]) {
  const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    for (let i = 0; i < positions.length; i += 3) {
      const v = new Vector3(positions[i], positions[i + 1], positions[i + 2]);
      min.copyFrom(Vector3.Minimize(min, v));
      max.copyFrom(Vector3.Maximize(max, v));
    }
  }

  return { min, max };
}

function localFloorYToWorld(
  collisionRoot: AbstractMesh,
  localX: number,
  localFloorY: number,
  localZ: number
): number {
  collisionRoot.computeWorldMatrix(true);
  return Vector3.TransformCoordinates(
    new Vector3(localX, localFloorY, localZ),
    collisionRoot.getWorldMatrix()
  ).y;
}

function sampleFloorYAtLocal(
  meshes: Mesh[],
  localX: number,
  localZ: number,
  hintLocalY?: number
): number | null {
  if (meshes.length === 0) return null;

  const { min, max } = getMeshesLocalBounds(meshes);
  const extentY = max.y - min.y;
  const floorBandMin = min.y + extentY * DEFAULTS.floorBandMinRatio;
  const floorBandMax = min.y + extentY * DEFAULTS.floorBandMaxRatio;

  let samples = collectAllFloorSamplesLocal(
    meshes,
    floorBandMin,
    floorBandMax,
    DEFAULTS.upwardNormalMin
  );
  if (samples.length === 0) {
    samples = collectAllFloorSamplesLocal(
      meshes,
      min.y + extentY * 0.04,
      min.y + extentY * 0.55,
      DEFAULTS.upwardNormalMin
    );
  }

  let best: number | null = null;
  let bestHits = 0;
  for (const sampleRadius of [6, 3.2, 1.2]) {
    const radiusSq = sampleRadius * sampleRadius;
    const hits = collectProbeFloorHits(samples, localX, localZ, radiusSq);
    if (hits.length > bestHits) {
      bestHits = hits.length;
      best = pickFloorY(hits, "max");
    }
  }

  if (best !== null && hintLocalY !== undefined && Number.isFinite(hintLocalY)) {
    if (Math.abs(best - hintLocalY) > 2.5) {
      console.warn(
        `[voxelSpawn] local floor Y=${best.toFixed(2)} vs spawn hint Y=${hintLocalY.toFixed(2)} — hint 사용`
      );
      return hintLocalY;
    }
  }

  if (best !== null) return best;
  return hintLocalY ?? null;
}

function buildFloorGrid(samples: FloorSample[], cellSize: number): Map<string, FloorCell> {
  const grid = new Map<string, FloorCell>();
  for (const sample of samples) {
    const key = `${Math.floor(sample.x / cellSize)},${Math.floor(sample.z / cellSize)}`;
    const cell = grid.get(key) ?? { count: 0, sumX: 0, sumZ: 0, ys: [] };
    cell.count += 1;
    cell.sumX += sample.x;
    cell.sumZ += sample.z;
    cell.ys.push(sample.y);
    grid.set(key, cell);
  }
  return grid;
}

function rankFloorCells(grid: Map<string, FloorCell>, minCellSamples: number) {
  return [...grid.entries()]
    .map(([key, cell]) => ({ key, cell }))
    .filter(({ cell }) => cell.count >= minCellSamples)
    .sort((a, b) => b.cell.count - a.cell.count);
}

function spawnFromCells(
  selected: Array<{ key: string; cell: FloorCell }>,
  eyeHeight: number
): VoxelSpawnResult {
  let weightSum = 0;
  let sumX = 0;
  let sumZ = 0;
  const floorYs: number[] = [];

  for (const { cell } of selected) {
    weightSum += cell.count;
    sumX += cell.sumX;
    sumZ += cell.sumZ;
    floorYs.push(median(cell.ys));
  }

  const spawnX = sumX / weightSum;
  const spawnZ = sumZ / weightSum;
  const floorY = median(floorYs);

  return {
    position: new Vector3(spawnX, floorY, spawnZ),
    floorY,
    eyeY: floorY + eyeHeight,
    hitCount: weightSum,
    cellCount: selected.length,
  };
}

function resolveDensestFloorSpawn(
  samples: FloorSample[],
  cellSize: number,
  minCellSamples: number,
  topCellsBlend: number,
  eyeHeight: number
): VoxelSpawnResult | null {
  if (samples.length === 0) return null;

  const grid = buildFloorGrid(samples, cellSize);
  let ranked = rankFloorCells(grid, minCellSamples);

  if (ranked.length === 0) {
    ranked = rankFloorCells(grid, Math.max(4, Math.floor(minCellSamples * 0.4)));
  }
  if (ranked.length === 0) {
    ranked = [...grid.entries()]
      .map(([key, cell]) => ({ key, cell }))
      .sort((a, b) => b.cell.count - a.cell.count)
      .slice(0, 1);
  }

  const blendCount = Math.max(1, Math.min(topCellsBlend, ranked.length));
  return spawnFromCells(ranked.slice(0, blendCount), eyeHeight);
}

function sampleProbePoints(
  centerX: number,
  centerZ: number,
  radius: number,
  grid: number
): Array<{ x: number; z: number }> {
  const points: Array<{ x: number; z: number }> = [];
  const steps = Math.max(grid, 1);
  const span = radius * 2;
  for (let iz = 0; iz < steps; iz += 1) {
    for (let ix = 0; ix < steps; ix += 1) {
      const tx = steps === 1 ? 0.5 : ix / (steps - 1);
      const tz = steps === 1 ? 0.5 : iz / (steps - 1);
      points.push({
        x: centerX + (tx - 0.5) * span,
        z: centerZ + (tz - 0.5) * span,
      });
    }
  }
  return points;
}

function collectProbeFloorHits(
  samples: FloorSample[],
  probeX: number,
  probeZ: number,
  radiusSq: number
): number[] {
  const hits: number[] = [];
  for (const sample of samples) {
    const dx = sample.x - probeX;
    const dz = sample.z - probeZ;
    if (dx * dx + dz * dz <= radiusSq) {
      hits.push(sample.y);
    }
  }
  return hits;
}

function resolveProbeFloorSpawn(
  samples: FloorSample[],
  collisionRoot: AbstractMesh,
  options: VoxelSpawnOptions,
  eyeHeight: number
): VoxelSpawnResult | null {
  collisionRoot.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = collisionRoot.getBoundingInfo().boundingBox;

  const centerX = options.probeXZ?.x ?? (min.x + max.x) * 0.5;
  const centerZ = options.probeXZ?.z ?? (min.z + max.z) * 0.5;
  const sampleRadius = options.sampleRadius ?? DEFAULTS.sampleRadius;
  const sampleGrid = options.sampleGrid ?? DEFAULTS.sampleGrid;
  const perProbeRadius = sampleGrid > 1 ? sampleRadius / sampleGrid : sampleRadius;
  const radiusSq = perProbeRadius * perProbeRadius;
  const probes = sampleProbePoints(centerX, centerZ, sampleRadius, sampleGrid);

  const floorCandidates: number[] = [];
  for (const probe of probes) {
    const probeHits = collectProbeFloorHits(samples, probe.x, probe.z, radiusSq);
    if (probeHits.length > 0) {
      floorCandidates.push(median(probeHits));
    }
  }

  if (floorCandidates.length === 0) return null;

  const floorY = median(floorCandidates);
  return {
    position: new Vector3(centerX, floorY, centerZ),
    floorY,
    eyeY: floorY + eyeHeight,
    hitCount: floorCandidates.length,
    cellCount: 1,
  };
}

function tryResolveWithBand(
  collisionRoot: AbstractMesh,
  meshes: Mesh[],
  options: VoxelSpawnOptions,
  bandMinRatio: number,
  bandMaxRatio: number
): VoxelSpawnResult | null {
  collisionRoot.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = collisionRoot.getBoundingInfo().boundingBox;
  const extentY = max.y - min.y;
  const floorBandMin = min.y + extentY * bandMinRatio;
  const floorBandMax = min.y + extentY * bandMaxRatio;
  const upwardNormalMin = options.upwardNormalMin ?? DEFAULTS.upwardNormalMin;
  const upwardOnly = options.upwardOnly ?? false;
  const eyeHeight = options.eyeHeight ?? DEFAULTS.eyeHeight;
  const mode = options.mode ?? "densest-floor";

  const samples = collectAllFloorSamples(
    meshes,
    floorBandMin,
    floorBandMax,
    upwardNormalMin,
    upwardOnly
  );
  if (samples.length === 0) return null;

  if (mode === "probe") {
    return resolveProbeFloorSpawn(samples, collisionRoot, options, eyeHeight);
  }

  return resolveDensestFloorSpawn(
    samples,
    options.gridCellSize ?? DEFAULTS.gridCellSize,
    options.minCellSamples ?? DEFAULTS.minCellSamples,
    options.topCellsBlend ?? DEFAULTS.topCellsBlend,
    eyeHeight
  );
}

export function resolveSpawnOnVoxelFloor(
  collisionRoot: AbstractMesh,
  options: VoxelSpawnOptions = {}
): VoxelSpawnResult | null {
  const meshes = collectCollisionMeshes(collisionRoot);
  if (meshes.length === 0) {
    console.warn("[voxelSpawn] no collision meshes with geometry");
    return null;
  }

  const bandMin = options.floorBandMinRatio ?? DEFAULTS.floorBandMinRatio;
  const bandMax = options.floorBandMaxRatio ?? DEFAULTS.floorBandMaxRatio;

  const primary = tryResolveWithBand(collisionRoot, meshes, options, bandMin, bandMax);
  if (primary) return primary;

  const relaxed = tryResolveWithBand(collisionRoot, meshes, options, 0.04, 0.55);
  if (relaxed) {
    console.info("[voxelSpawn] used relaxed floor band");
    return relaxed;
  }

  console.warn("[voxelSpawn] no floor samples — check collision sync / splat scale");
  return null;
}

export function alignHierarchyFeetToFloor(root: TransformNode, floorY: number): void {
  root.computeWorldMatrix(true);
  let bottomY = Number.POSITIVE_INFINITY;
  const meshes = root.getChildMeshes(false);
  const targets = meshes.length > 0 ? meshes : root instanceof Mesh ? [root] : [];
  for (const mesh of targets) {
    mesh.computeWorldMatrix(true);
    bottomY = Math.min(bottomY, mesh.getBoundingInfo().boundingBox.minimumWorld.y);
  }
  if (!Number.isFinite(bottomY)) return;
  root.position.y += floorY - bottomY;
}

export function sampleFloorYAt(
  collisionRoot: AbstractMesh,
  x: number,
  z: number,
  options: Pick<
    VoxelSpawnOptions,
    | "floorBandMinRatio"
    | "floorBandMaxRatio"
    | "upwardNormalMin"
    | "upwardOnly"
    | "floorYStrategy"
    | "sampleRadius"
  > = {}
): number | null {
  const meshes = collectCollisionMeshes(collisionRoot);
  if (meshes.length === 0) return null;

  collisionRoot.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = collisionRoot.getBoundingInfo().boundingBox;
  const extentY = max.y - min.y;
  const floorBandMin = min.y + extentY * (options.floorBandMinRatio ?? DEFAULTS.floorBandMinRatio);
  const floorBandMax = min.y + extentY * (options.floorBandMaxRatio ?? DEFAULTS.floorBandMaxRatio);
  const upwardNormalMin = options.upwardNormalMin ?? DEFAULTS.upwardNormalMin;
  const upwardOnly = options.upwardOnly ?? false;
  const strategy = options.floorYStrategy ?? "median";
  const radius = options.sampleRadius ?? DEFAULTS.sampleRadius;
  const radiusSq = radius * radius;

  let samples = collectAllFloorSamples(
    meshes,
    floorBandMin,
    floorBandMax,
    upwardNormalMin,
    upwardOnly
  );
  if (samples.length === 0) {
    samples = collectAllFloorSamples(
      meshes,
      min.y + extentY * 0.04,
      min.y + extentY * 0.55,
      upwardNormalMin,
      upwardOnly
    );
  }

  const hits = collectProbeFloorHits(samples, x, z, radiusSq);
  if (hits.length === 0) return null;
  return pickFloorY(hits, strategy);
}

/** 로봇용 — collision mesh 로컬 좌표에서 바닥 샘플 후 월드 Y로 변환 (splat Y-flip 대응) */
export function resolveRobotFloorYAt(
  collisionRoot: AbstractMesh,
  worldX: number,
  worldZ: number,
  hintLocalY?: number
): number | null {
  collisionRoot.computeWorldMatrix(true);
  const inv = collisionRoot.getWorldMatrix().clone();
  inv.invert();
  const localProbe = Vector3.TransformCoordinates(new Vector3(worldX, 0, worldZ), inv);

  const meshes = collectCollisionMeshes(collisionRoot);
  const localFloorY = sampleFloorYAtLocal(meshes, localProbe.x, localProbe.z, hintLocalY);
  if (localFloorY === null) return null;

  return localFloorYToWorld(collisionRoot, localProbe.x, localFloorY, localProbe.z);
}
