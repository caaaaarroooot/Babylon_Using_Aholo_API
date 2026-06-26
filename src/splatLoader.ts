import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  createAholoLodBridge,
  createEmptyGaussianSplatMesh,
  fetchLodMeta,
  type AholoLodBridge,
} from "./aholoLodBridge";
import { tuneSplatMesh } from "./renderPerformance";

const SPLAT_LOAD_OPTIONS = {
  pluginOptions: { splat: { flipY: true } },
};

/** 대형 현장 — LoD 있을 때 화면 Gaussian 상한 */
const LOD_BUDGET_RATIO = 0.1;

export type LoadedGaussian = {
  mesh: AbstractMesh;
  lodBridge: AholoLodBridge | null;
};

export async function loadGaussianWithLodFallback(
  scene: Scene,
  camera: ArcRotateCamera,
  def: { name: string; url: string; lodMetaUrl: string }
): Promise<LoadedGaussian> {
  try {
    const lodMeta = await fetchLodMeta(def.lodMetaUrl);
    const mesh = createEmptyGaussianSplatMesh(scene, def.name);
    mesh.scaling.y *= -1;
    mesh.name = def.name;
    const lodBridge = createAholoLodBridge(scene, mesh, def.lodMetaUrl, lodMeta, {
      maxBudget: Math.min(
        28_000,
        Math.max(18_000, Math.floor(lodMeta.counts * LOD_BUDGET_RATIO))
      ),
    });
    scene.onBeforeRenderObservable.add(() => lodBridge.tick(camera));
    tuneSplatMesh(mesh, true);
    return { mesh, lodBridge };
  } catch (err) {
    console.warn(`[splat] LoD unavailable (${def.name}), direct load:`, err);
  }

  const result = await ImportMeshAsync(def.url, scene, SPLAT_LOAD_OPTIONS);
  const mesh = result.meshes[0];
  if (!mesh) {
    throw new Error(`Gaussian asset has no mesh: ${def.url}`);
  }
  mesh.name = def.name;
  tuneSplatMesh(mesh, false);
  return { mesh, lodBridge: null };
}
