/**
 * Aholo voxelResolution (m) — 장면 크기 대비 창고 기준 비율로 산출
 *
 * voxelResolution 은 **절대 미터 단위** 셀 크기입니다 (작을수록 정밀, mesh 증가).
 * 창고 box 대비 1층 scene extents 비율을 곱해 같은 "밀도 체감"을 맞춥니다.
 */

/** build-warehouse-voxel.mjs 와 동일 */
export const WAREHOUSE_VOXEL_REF = {
  physicsResolution: 0.25,
  vizResolution: 1.0,
  boxMin: [-54, -37, -28],
  boxMax: [52, 8, 276],
};

/** Aholo 1F preprocess 로그 scene extents */
export const MC_IN_1F_EXTENTS = {
  min: [-39.73, -16.28, -22.16],
  max: [16.74, 33.63, 35.75],
};

function spanGeoMean(minCorner, maxCorner) {
  const dx = maxCorner[0] - minCorner[0];
  const dy = maxCorner[1] - minCorner[1];
  const dz = maxCorner[2] - minCorner[2];
  return Math.cbrt(Math.max(dx, 0.01) * Math.max(dy, 0.01) * Math.max(dz, 0.01));
}

function roundResolution(value, step = 0.01) {
  return Math.round(value / step) * step;
}

/**
 * @param {{ min: number[]; max: number[] }} extents
 * @param {{ physicsFineTune?: number; minPhysics?: number; maxPhysics?: number }} [options]
 *   physicsFineTune — 1보다 작으면 더 촘촘 (예: 0.85 → 15% 더 정밀)
 */
export function computeVoxelResolutionsFromWarehouseRef(extents, options = {}) {
  const refSpan = spanGeoMean(WAREHOUSE_VOXEL_REF.boxMin, WAREHOUSE_VOXEL_REF.boxMax);
  const sceneSpan = spanGeoMean(extents.min, extents.max);
  const sizeRatio = sceneSpan / refSpan;

  const vizCoarseFactor = WAREHOUSE_VOXEL_REF.vizResolution / WAREHOUSE_VOXEL_REF.physicsResolution;

  let physicsResolution = WAREHOUSE_VOXEL_REF.physicsResolution * sizeRatio;
  if (options.physicsFineTune !== undefined) {
    physicsResolution *= options.physicsFineTune;
  }

  const minPhysics = options.minPhysics ?? 0.08;
  const maxPhysics = options.maxPhysics ?? 0.25;
  physicsResolution = Math.min(maxPhysics, Math.max(minPhysics, physicsResolution));
  physicsResolution = roundResolution(physicsResolution, 0.01);

  const vizResolution = roundResolution(physicsResolution * vizCoarseFactor, 0.01);

  return {
    physicsResolution,
    vizResolution,
    sceneSpan,
    refSpan,
    sizeRatio,
    vizCoarseFactor,
  };
}
