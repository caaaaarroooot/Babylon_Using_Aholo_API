import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import type { AholoLodBridge } from "./aholoLodBridge";

function formatCount(value: number): string {
  return value.toLocaleString("ko-KR");
}

export function setupPerfHud(
  scene: Scene,
  engine: Engine,
  lodBridge: AholoLodBridge | null
) {
  const panel = document.getElementById("perf-status");
  const fpsEl = document.getElementById("perf-fps");
  const frameEl = document.getElementById("perf-frame");
  const resEl = document.getElementById("perf-resolution");
  const splatEl = document.getElementById("perf-splats");

  if (!panel) return () => {};

  panel.hidden = false;

  const update = () => {
    const fps = engine.getFps();
    const frameMs = engine.getDeltaTime();
    const scale = engine.getHardwareScalingLevel();
    const renderW = engine.getRenderWidth();
    const renderH = engine.getRenderHeight();
    const canvas = engine.getRenderingCanvas();
    const canvasW = canvas?.clientWidth ?? renderW;
    const canvasH = canvas?.clientHeight ?? renderH;
    const resolutionPct = Math.round(100 / scale);

    if (fpsEl) {
      fpsEl.textContent = `${fps.toFixed(0)} fps`;
      fpsEl.dataset.level = fps >= 55 ? "good" : fps >= 35 ? "mid" : "low";
    }
    if (frameEl) {
      frameEl.textContent = `${frameMs.toFixed(1)} ms / 프레임`;
    }
    if (resEl) {
      resEl.textContent = `${renderW}×${renderH} · 캔버스 ${canvasW}×${canvasH} · ${resolutionPct}%`;
    }
    if (splatEl) {
      if (lodBridge) {
        const { loadedCount, totalCount } = lodBridge.stats;
        const pct = totalCount > 0 ? ((loadedCount / totalCount) * 100).toFixed(1) : "0.0";
        splatEl.textContent = `${formatCount(loadedCount)} / ${formatCount(totalCount)} (${pct}%)`;
      } else {
        splatEl.textContent = "직접 로드 (LoD 없음)";
      }
    }
  };

  update();
  const observer = scene.onBeforeRenderObservable.add(update);

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    panel.hidden = true;
  };
}
