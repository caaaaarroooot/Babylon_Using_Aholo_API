import type { Scene } from "@babylonjs/core";
import type { AholoLodBridge } from "./aholoLodBridge";

function formatCount(value: number): string {
  return value.toLocaleString("ko-KR");
}

export function setupLodStatusHud(
  scene: Scene,
  getLodBridge: () => AholoLodBridge | null
) {
  const panel = document.getElementById("lod-status");
  const loadedEl = document.getElementById("lod-status-loaded");
  const pctEl = document.getElementById("lod-status-pct");

  if (!panel) return () => {};

  const update = () => {
    const lodBridge = getLodBridge();
    if (!lodBridge) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    const { loadedCount, totalCount } = lodBridge.stats;
    const ratio = totalCount > 0 ? (loadedCount / totalCount) * 100 : 0;

    if (loadedEl) {
      loadedEl.textContent = `${formatCount(loadedCount)} / ${formatCount(totalCount)}`;
    }
    if (pctEl) {
      pctEl.textContent = `${ratio.toFixed(1)}%`;
    }
  };

  update();
  const observer = scene.onBeforeRenderObservable.add(update);

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    panel.hidden = true;
  };
}
