import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  //   createAholoLodBridge,
  createAholoMultiMeshBridge,
  createEmptyGaussianSplatMesh,
  fetchLodMeta,
  type AholoLodBridge,
  // } from "./aholoLodBridge";
} from "./aholoMultiMeshBridge";
import { tuneSplatMesh } from "./renderPerformance";

const SPLAT_LOAD_OPTIONS = {
  pluginOptions: { splat: { flipY: true } },
};

/** 대형 현장 — LoD 있을 때 화면 Gaussian 상한 */
const LOD_BUDGET_RATIO = 0.15;

export type LoadedGaussian = {
  mesh: AbstractMesh;
  lodBridge: AholoLodBridge | null;
};

export async function loadGaussianDirect(
  scene: Scene,
  def: { name: string; url: string },
  options?: { flipScaleY?: boolean },
): Promise<AbstractMesh> {
  const result = await ImportMeshAsync(def.url, scene, SPLAT_LOAD_OPTIONS);
  const mesh = result.meshes[0];
  if (!mesh) {
    throw new Error(`Gaussian asset has no mesh: ${def.url}`);
  }
  mesh.name = def.name;
  if (options?.flipScaleY) {
    mesh.scaling.y *= -1;
  }
  tuneSplatMesh(mesh, false);
  return mesh;
}

export async function loadGaussianWithLodFallback(
  scene: Scene,
  _camera: ArcRotateCamera,
  def: { name: string; url: string; lodMetaUrl: string },
): Promise<LoadedGaussian> {
  try {
    const lodMeta = await fetchLodMeta(def.lodMetaUrl);
    const mesh = createEmptyGaussianSplatMesh(scene, def.name);
    mesh.scaling.y *= -1;
    mesh.name = def.name;

    const calculatedBudget = Math.max(
      18_000,
      Math.floor(lodMeta.counts * LOD_BUDGET_RATIO),
    );

    // 2. 콘솔에 모델 이름, 계산된 예산, 전체 갯수를 예쁘게 띄워줍니다.
    console.log(
      `🔥 [LoD Budget] ${def.name} 모델 -> maxBudget: ${calculatedBudget} (전체 점: ${lodMeta.counts}개)`,
    );

    const lodBridge = createAholoMultiMeshBridge(
      scene,
      mesh,
      def.lodMetaUrl,
      lodMeta,
      {
        //   maxBudget: Math.min(
        //     28_000,
        //     Math.max(18_000, Math.floor(lodMeta.counts * LOD_BUDGET_RATIO))
        //   ),
        maxBudget: calculatedBudget,
      },
    );
    tuneSplatMesh(mesh, true);
    return { mesh, lodBridge };
  } catch (err) {
    console.warn(`[splat] LoD unavailable (${def.name}), direct load:`, err);
  }

  const mesh = await loadGaussianDirect(scene, def, {
    flipScaleY: def.url.toLowerCase().endsWith(".sog"),
  });
  return { mesh, lodBridge: null };
}
