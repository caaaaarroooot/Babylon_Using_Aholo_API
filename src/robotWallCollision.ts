import { AbstractMesh, Matrix, Vector3 } from "@babylonjs/core";
import {
  buildVoxelGridCells,
  type VoxelGridCell,
} from "./voxelGridBuckets";

/** 로봇 hull — robotRoot(발) 기준 */
export const ROBOT_HULL_HALF = new Vector3(0.29, 0.16, 0.41);
const ROBOT_HULL_CENTER_Y = 0.16;
/** 이 높이 이하 셀은 바닥(지지면) — 수평 이동 차단에서 제외 */
const FLOOR_CELL_TOP_MARGIN = 0.1;

function aabbIntersects(
  aMin: Vector3,
  aMax: Vector3,
  bMin: Vector3,
  bMax: Vector3
): boolean {
  return (
    aMin.x <= bMax.x &&
    aMax.x >= bMin.x &&
    aMin.y <= bMax.y &&
    aMax.y >= bMin.y &&
    aMin.z <= bMax.z &&
    aMax.z >= bMin.z
  );
}

function cellWorldBounds(cell: VoxelGridCell, worldMatrix: Matrix): { min: Vector3; max: Vector3 } {
  const localMin = cell.center.subtract(cell.half);
  const localMax = cell.center.add(cell.half);
  const corners = [
    new Vector3(localMin.x, localMin.y, localMin.z),
    new Vector3(localMax.x, localMin.y, localMin.z),
    new Vector3(localMin.x, localMax.y, localMin.z),
    new Vector3(localMax.x, localMax.y, localMin.z),
    new Vector3(localMin.x, localMin.y, localMax.z),
    new Vector3(localMax.x, localMin.y, localMax.z),
    new Vector3(localMin.x, localMax.y, localMax.z),
    new Vector3(localMax.x, localMax.y, localMax.z),
  ];

  let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const corner of corners) {
    const world = Vector3.TransformCoordinates(corner, worldMatrix);
    min = Vector3.Minimize(min, world);
    max = Vector3.Maximize(max, world);
  }
  return { min, max };
}

function robotProbeAabb(
  footX: number,
  footY: number,
  footZ: number
): { min: Vector3; max: Vector3 } {
  const centerY = footY + ROBOT_HULL_CENTER_Y;
  const min = new Vector3(
    footX - ROBOT_HULL_HALF.x,
    centerY - ROBOT_HULL_HALF.y,
    footZ - ROBOT_HULL_HALF.z
  );
  const max = new Vector3(
    footX + ROBOT_HULL_HALF.x,
    centerY + ROBOT_HULL_HALF.y,
    footZ + ROBOT_HULL_HALF.z
  );
  return { min, max };
}

export type RobotWallGrid = {
  cells: VoxelGridCell[];
  collisionRoot: AbstractMesh;
};

export function buildRobotWallGrid(collisionRoot: AbstractMesh): RobotWallGrid {
  collisionRoot.computeWorldMatrix(true);
  const cells = buildVoxelGridCells(collisionRoot, {
    cellSize: new Vector3(2, 0.5, 2),
    maxCells: 3500,
  });
  return { cells, collisionRoot };
}

/** 몸통 높이 대역 — 바닥 복셀 제외, 벽/장애물만 */
export function isRobotWallBlockedAt(
  grid: RobotWallGrid,
  footX: number,
  footY: number,
  footZ: number
): boolean {
  if (grid.cells.length === 0) return false;

  grid.collisionRoot.computeWorldMatrix(true);
  const worldMatrix = grid.collisionRoot.getWorldMatrix();
  const probe = robotProbeAabb(footX, footY, footZ);
  const probeFloorCutoff = probe.min.y + FLOOR_CELL_TOP_MARGIN;

  for (const cell of grid.cells) {
    const world = cellWorldBounds(cell, worldMatrix);
    if (world.max.y < probeFloorCutoff) continue;
    if (aabbIntersects(probe.min, probe.max, world.min, world.max)) {
      return true;
    }
  }
  return false;
}

/** 진행 방향 180° 반구 — dot > 0 이면 차단 */
export function isIntentInBlockedHemisphere(
  intentXZ: Vector3,
  blockedDirXZ: Vector3 | null
): boolean {
  if (!blockedDirXZ || intentXZ.lengthSquared() < 1e-12) return false;
  const intent = intentXZ.clone();
  intent.y = 0;
  intent.normalize();
  return Vector3.Dot(intent, blockedDirXZ) > 0.02;
}

export function normalizeIntentXZ(delta: Vector3): Vector3 | null {
  const xz = new Vector3(delta.x, 0, delta.z);
  if (xz.lengthSquared() < 1e-12) return null;
  return xz.normalize();
}
