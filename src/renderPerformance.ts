import type { Engine } from "@babylonjs/core/Engines/engine";
import { GaussianSplattingMesh } from "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

type PerfPreset = {
  hardwareScaling: number;
  maxFps: number;
  splatViewUpdateThreshold: number;
  disableDepthSort: boolean;
  antialias: boolean;
};

/** LoD 있을 때 — 화질 우선 */
const LOD_PRESET: PerfPreset = {
  hardwareScaling: 1,
  maxFps: 60,
  splatViewUpdateThreshold: 0.0001,
  disableDepthSort: false,
  antialias: true,
};

/** LoD 없을 때 — depth sort 유지(필수), 해상도만 약간 낮춤 */
const DIRECT_PRESET: PerfPreset = {
  hardwareScaling: 1.2,
  maxFps: 45,
  splatViewUpdateThreshold: 0.001,
  disableDepthSort: false,
  antialias: true,
};

export function getPerfPreset(hasLod: boolean): PerfPreset {
  return hasLod ? LOD_PRESET : DIRECT_PRESET;
}

export function tuneEnginePerformance(engine: Engine, hasLod: boolean) {
  const preset = getPerfPreset(hasLod);
  engine.setHardwareScalingLevel(preset.hardwareScaling);
  engine.maxFPS = preset.maxFps;
  return preset;
}

export function tuneSplatMesh(mesh: AbstractMesh, hasLod: boolean) {
  if (!(mesh instanceof GaussianSplattingMesh)) return;
  const preset = getPerfPreset(hasLod);
  mesh.disableDepthSort = preset.disableDepthSort;
  mesh.viewUpdateThreshold = preset.splatViewUpdateThreshold;
}

export function formatPerfLabel(hasLod: boolean): string {
  const preset = getPerfPreset(hasLod);
  const resolution = Math.round(100 / preset.hardwareScaling);
  return hasLod
    ? `화질 모드 · ${preset.maxFps}fps · ${resolution}%`
    : `균형 모드 · ${preset.maxFps}fps · ${resolution}% (preprocess:iob 권장)`;
}

export function setupVisibilityRenderGate(engine: Engine, render: () => void) {
  let active = true;

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (active) {
        active = false;
        engine.stopRenderLoop();
      }
      return;
    }
    if (!active) {
      active = true;
      engine.runRenderLoop(render);
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
