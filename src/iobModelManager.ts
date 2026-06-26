import {
  AbstractMesh,
  ArcRotateCamera,
  ImportMeshAsync,
  type Observer,
  Scene,
} from "@babylonjs/core";
import {
  createAholoLodBridge,
  createEmptyGaussianSplatMesh,
  fetchLodMeta,
  type AholoLodBridge,
} from "./aholoLodBridge";

/** 항상 배경에 유지되는 3Dcam 창고 SOG */
export const IOB_BACKGROUND_MODEL = {
  id: "warehouse",
  label: "3Dcam 창고 (배경)",
  url: "/models/iob/260615_MC_3dcam_warehouse_model_1.sog",
  lodMetaUrl: "/models/iob-lod/warehouse/lod-meta.json",
} as const;

export type IobForegroundModelId = "none" | "mcOutMain" | "mcIn1F" | "mcIn2F";

type ForegroundModelDef = {
  id: Exclude<IobForegroundModelId, "none">;
  label: string;
  url: string;
  lodMetaUrl: string;
};

export const IOB_FOREGROUND_MODELS: ForegroundModelDef[] = [
  {
    id: "mcOutMain",
    label: "외부 (MC_out)",
    url: "/models/iob/MC_out_main_edit.splat",
    lodMetaUrl: "/models/iob-lod/mc-out-main/lod-meta.json",
  },
  {
    id: "mcIn1F",
    label: "1층 내부",
    url: "/models/iob/MC_in_1F_edit.splat",
    lodMetaUrl: "/models/iob-lod/mc-in-1f/lod-meta.json",
  },
  {
    id: "mcIn2F",
    label: "2층 내부",
    url: "/models/iob/MC_in_2F_edit.splat",
    lodMetaUrl: "/models/iob-lod/mc-in-2f/lod-meta.json",
  },
];

const HUSKY_URL = "/models/iob/husky_comp_2.glb";
const SPLAT_LOAD_OPTIONS = {
  pluginOptions: { splat: { flipY: true } },
};
const BACKGROUND_LOD_RATIO = 0.1;
const FOREGROUND_LOD_RATIO = 0.1;
const RENDER_GROUP_BACKGROUND = 0;
const RENDER_GROUP_FOREGROUND = 1;
const RENDER_GROUP_OVERLAY = 2;

type LoadedSplatLayer = {
  meshes: AbstractMesh[];
  lodBridge: AholoLodBridge | null;
};

export type LayerLodStats = { loaded: number; total: number } | null;

export class IobModelManager {
  private background: LoadedSplatLayer = { meshes: [], lodBridge: null };
  private foreground: LoadedSplatLayer = { meshes: [], lodBridge: null };
  private renderObserver: Observer<Scene> | null = null;
  private huskyMeshes: AbstractMesh[] = [];
  private currentForegroundId: IobForegroundModelId = "none";
  private backgroundReady = false;
  private loadingForeground = false;

  constructor(
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera
  ) {}

  get currentForeground(): IobForegroundModelId {
    return this.currentForegroundId;
  }

  get isLoadingForeground(): boolean {
    return this.loadingForeground;
  }

  get isBackgroundReady(): boolean {
    return this.backgroundReady;
  }

  get backgroundLodStats(): LayerLodStats {
    return this.layerStats(this.background);
  }

  get foregroundLodStats(): LayerLodStats {
    return this.layerStats(this.foreground);
  }

  private layerStats(layer: LoadedSplatLayer): LayerLodStats {
    if (!layer.lodBridge) return null;
    return {
      loaded: layer.lodBridge.stats.loadedCount,
      total: layer.lodBridge.stats.totalCount,
    };
  }

  private ensureRenderObserver() {
    if (this.renderObserver) return;
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.background.lodBridge?.tick(this.camera);
      this.foreground.lodBridge?.tick(this.camera);
    });
  }

  private clearRenderObserverIfIdle() {
    const needsObserver =
      this.background.lodBridge !== null || this.foreground.lodBridge !== null;
    if (needsObserver || !this.renderObserver) return;
    this.scene.onBeforeRenderObservable.remove(this.renderObserver);
    this.renderObserver = null;
  }

  private disposeLayer(layer: LoadedSplatLayer) {
    layer.lodBridge?.destroy();
    layer.lodBridge = null;
    for (const mesh of layer.meshes) {
      mesh.dispose(false, true);
    }
    layer.meshes = [];
    this.clearRenderObserverIfIdle();
  }

  private clearHusky() {
    for (const mesh of this.huskyMeshes) {
      mesh.dispose(false, true);
    }
    this.huskyMeshes = [];
  }

  private async tryLoadWithLod(
    def: { id: string; label: string; lodMetaUrl: string },
    renderingGroupId: number,
    lodRatio: number
  ): Promise<LoadedSplatLayer | null> {
    try {
      const lodMeta = await fetchLodMeta(def.lodMetaUrl);
      const mesh = createEmptyGaussianSplatMesh(this.scene, def.id);
      mesh.scaling.y *= -1;
      mesh.name = def.id;
      mesh.renderingGroupId = renderingGroupId;
      const lodBridge = createAholoLodBridge(this.scene, mesh, def.lodMetaUrl, lodMeta, {
        maxBudget: Math.max(15_000, Math.floor(lodMeta.counts * lodRatio)),
      });
      return { meshes: [mesh], lodBridge };
    } catch (err) {
      console.warn(`[IOB] LoD skip (${def.label}):`, err);
      return null;
    }
  }

  private async loadSplatLayer(
    def: { id: string; label: string; url: string; lodMetaUrl: string },
    renderingGroupId: number,
    lodRatio: number,
    onProgress?: (message: string) => void
  ): Promise<LoadedSplatLayer> {
    onProgress?.(`${def.label} 로딩 중...`);

    const withLod = await this.tryLoadWithLod(def, renderingGroupId, lodRatio);
    if (withLod) {
      onProgress?.(`${def.label} — Chunk LoD 적용`);
      return withLod;
    }

    const result = await ImportMeshAsync(def.url, this.scene, SPLAT_LOAD_OPTIONS);
    const mesh = result.meshes[0];
    if (!mesh) {
      throw new Error(`Gaussian asset has no mesh: ${def.url}`);
    }
    mesh.name = def.id;
    mesh.renderingGroupId = renderingGroupId;
    onProgress?.(`${def.label} 로드 완료 (LoD 없음 — npm run preprocess:iob 권장)`);
    return { meshes: [mesh], lodBridge: null };
  }

  async loadBackground(onProgress?: (message: string) => void): Promise<AbstractMesh[]> {
    if (this.backgroundReady) {
      return this.background.meshes;
    }

    this.background = await this.loadSplatLayer(
      IOB_BACKGROUND_MODEL,
      RENDER_GROUP_BACKGROUND,
      BACKGROUND_LOD_RATIO,
      onProgress
    );
    this.backgroundReady = true;
    if (this.background.lodBridge) this.ensureRenderObserver();
    return this.background.meshes;
  }

  async showForeground(
    id: IobForegroundModelId,
    onProgress?: (message: string) => void
  ): Promise<AbstractMesh[]> {
    if (this.loadingForeground) return this.foreground.meshes;
    if (this.currentForegroundId === id) return this.foreground.meshes;

    this.loadingForeground = true;
    try {
      this.disposeLayer(this.foreground);
      this.currentForegroundId = id;

      if (id === "none") {
        onProgress?.("전경 없음 — 배경만 표시");
        return [];
      }

      const def = IOB_FOREGROUND_MODELS.find((model) => model.id === id);
      if (!def) {
        throw new Error(`Unknown foreground model: ${id}`);
      }

      this.foreground = await this.loadSplatLayer(
        def,
        RENDER_GROUP_FOREGROUND,
        FOREGROUND_LOD_RATIO,
        onProgress
      );
      if (this.foreground.lodBridge) this.ensureRenderObserver();
      return this.foreground.meshes;
    } finally {
      this.loadingForeground = false;
    }
  }

  async setHuskyVisible(
    visible: boolean,
    onProgress?: (message: string) => void
  ): Promise<AbstractMesh[]> {
    if (!visible) {
      this.clearHusky();
      return [];
    }

    if (this.huskyMeshes.length > 0) {
      return this.huskyMeshes;
    }

    onProgress?.("Husky GLB 로딩 중...");
    const result = await ImportMeshAsync(HUSKY_URL, this.scene);
    if (result.meshes.length === 0) {
      throw new Error(`GLB has no meshes: ${HUSKY_URL}`);
    }
    this.huskyMeshes = result.meshes;
    for (const mesh of this.huskyMeshes) {
      mesh.renderingGroupId = RENDER_GROUP_OVERLAY;
    }
    if (this.huskyMeshes[0]) {
      this.huskyMeshes[0].name = "husky";
    }
    return this.huskyMeshes;
  }

  getActiveMeshes(): AbstractMesh[] {
    return [...this.background.meshes, ...this.foreground.meshes, ...this.huskyMeshes];
  }

  dispose() {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.disposeLayer(this.background);
    this.disposeLayer(this.foreground);
    this.clearHusky();
    this.backgroundReady = false;
    this.currentForegroundId = "none";
  }
}
