import { ArcRotateCamera, Vector3 } from "@babylonjs/core";

/** 1층 실내 — collision/splat AABB 기준 카메라·로봇 스폰 */
export type McIn1FInteriorPreset = {
  alpha: number;
  beta: number;
  /** 카메라 타깃 높이 (AABB 높이 비율) */
  targetHeightRatio: number;
  /** 로봇 바닥 높이 (AABB 높이 비율) — min.y 지면(외부)이 아닌 실내 바닥 */
  floorHeightRatio: number;
  /** 스폰 XZ 미세 조정 (월드 좌표, m) */
  spawnOffsetX: number;
  spawnOffsetZ: number;
  /** 바닥 정렬 후 추가 Y 보정 (m) */
  spawnOffsetY: number;
  radiusRatio: number;
  lowerRadiusScale: number;
  upperRadiusScale: number;
};

export const MC_IN_1F_INTERIOR: McIn1FInteriorPreset = {
  alpha: -Math.PI / 2,
  beta: Math.PI / 2.05,
  targetHeightRatio: 0.32,
  floorHeightRatio: 0.24,
  spawnOffsetX: 0,
  spawnOffsetZ: 0,
  spawnOffsetY: 0,
  radiusRatio: 0.12,
  lowerRadiusScale: 0.06,
  upperRadiusScale: 0.5,
};

export type McIn1FInteriorFrame = {
  floorY: number;
  target: Vector3;
  horizontalSpan: number;
  radius: number;
};

export function frameMcIn1FInterior(
  camera: ArcRotateCamera,
  min: Vector3,
  max: Vector3,
  preset: McIn1FInteriorPreset = MC_IN_1F_INTERIOR
): McIn1FInteriorFrame {
  const extent = max.subtract(min);
  const target = new Vector3(
    (min.x + max.x) * 0.5 + preset.spawnOffsetX,
    min.y + extent.y * preset.targetHeightRatio,
    (min.z + max.z) * 0.5 + preset.spawnOffsetZ
  );
  const horizontalSpan = Math.max(Math.min(extent.x, extent.z), 0.5);
  const radius = Math.max(horizontalSpan * preset.radiusRatio, 0.6);

  camera.alpha = preset.alpha;
  camera.beta = preset.beta;
  camera.setTarget(target);
  camera.radius = radius;
  camera.lowerRadiusLimit = Math.max(horizontalSpan * preset.lowerRadiusScale, 0.35);
  camera.upperRadiusLimit = Math.max(horizontalSpan * preset.upperRadiusScale, radius * 1.8);

  return {
    floorY: min.y + extent.y * preset.floorHeightRatio + preset.spawnOffsetY,
    target,
    horizontalSpan,
    radius,
  };
}
