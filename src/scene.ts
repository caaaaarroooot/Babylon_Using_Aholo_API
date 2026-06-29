import {
  AbstractMesh,
  ArcRotateCamera,
  Color4,
  Engine,
  HemisphericLight,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { AholoLodBridge } from "./aholoLodBridge";
import { setupKeyboardCameraControls } from "./cameraControls";
import {
  formatPerfLabel,
  setupVisibilityRenderGate,
  tuneEnginePerformance,
} from "./renderPerformance";
import { setupLodStatusHud } from "./lodStatusHud";
import { setupPerfHud } from "./perfHud";
import { loadGaussianDirect, loadGaussianWithLodFallback } from "./splatLoader";
import {
  createSyncedCamera,
  disableSplitView,
  enableSplitView,
  LAYER_ALL,
  LAYER_DIRECT,
  LAYER_LOD,
  LAYER_SPLIT_BOTH,
  setMeshRenderLayer,
  syncArcRotateCamera,
} from "./splitView";
import type { VoxelOverlay } from "./voxelOverlay";
import { attachVoxelOverlay } from "./voxelOverlay";

type SceneId = "warehouse" | "mcIn1F" | "mcIn1FLod";
type CompareSet = "warehouse" | "mcIn1F";

const WAREHOUSE_SOG = {
  name: "warehouse",
  url: "/models/iob/260615_MC_3dcam_warehouse_model_1.sog",
  lodMetaUrl: "/models/iob-lod/warehouse/lod-meta.json",
};

const MC_IN_1F = {
  name: "mcIn1F",
  url: "/models/iob/MC_in_1F_edit.splat",
};

const MC_IN_1F_LOD = {
  name: "mcIn1FLod",
  url: "/models/iob/MC_in_1F_edit.splat",
  lodMetaUrl: "/models/iob-lod/mc-in-1f/lod-meta.json",
};

const SCENE_LABELS: Record<SceneId, string> = {
  warehouse: "3Dcam 창고",
  mcIn1F: "1층 내부",
  mcIn1FLod: "1층 내부 (Chunk LoD)",
};

const WAREHOUSE_COLLISION_GLB = "/models/iob-voxel/warehouse/collision.glb";
const MC_IN_1F_COLLISION_GLB = "/models/iob-voxel/mc-in-1f/collision.glb";

type InteriorCameraPreset = {
  alpha: number;
  beta: number;
  targetHeightRatio: number;
  radiusRatio: number;
  lowerRadiusScale: number;
  upperRadiusScale: number;
};

const WAREHOUSE_CAMERA: InteriorCameraPreset = {
  alpha: -Math.PI / 2,
  beta: Math.PI / 2.05,
  targetHeightRatio: 0.38,
  radiusRatio: 0.42,
  lowerRadiusScale: 0.15,
  upperRadiusScale: 2.5,
};

/** 1층 — collision 볼륨 안쪽에서 시작 */
const MC_IN_1F_CAMERA: InteriorCameraPreset = {
  alpha: -Math.PI / 2,
  beta: Math.PI / 2.05,
  targetHeightRatio: 0.32,
  radiusRatio: 0.12,
  lowerRadiusScale: 0.06,
  upperRadiusScale: 0.5,
};

function getCompareSet(sceneId: SceneId): CompareSet {
  return sceneId === "warehouse" ? "warehouse" : "mcIn1F";
}

function frameInteriorCamera(
  camera: ArcRotateCamera,
  boundsMesh: AbstractMesh,
  preset: InteriorCameraPreset
) {
  boundsMesh.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = boundsMesh.getBoundingInfo().boundingBox;
  const extent = max.subtract(min);

  const target = new Vector3(
    (min.x + max.x) * 0.5,
    min.y + extent.y * preset.targetHeightRatio,
    (min.z + max.z) * 0.5
  );

  const horizontalSpan = Math.max(Math.min(extent.x, extent.z), 0.5);
  const radius = Math.max(horizontalSpan * preset.radiusRatio, 0.6);

  camera.alpha = preset.alpha;
  camera.beta = preset.beta;
  camera.setTarget(target);
  camera.radius = radius;
  camera.lowerRadiusLimit = Math.max(horizontalSpan * preset.lowerRadiusScale, 0.35);
  camera.upperRadiusLimit = Math.max(horizontalSpan * preset.upperRadiusScale, radius * 1.8);
}

function setHudText(title: string, detail: string) {
  const titleEl = document.getElementById("collision-title");
  const detailEl = document.getElementById("collision-detail");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
}

function setSplitLabelsVisible(visible: boolean) {
  const labels = document.getElementById("split-labels");
  const divider = document.getElementById("split-divider");
  if (labels) labels.hidden = !visible;
  if (divider) divider.hidden = !visible;
}

export async function createScene(canvas: HTMLCanvasElement) {
  const engine = new Engine(canvas, true, {
    adaptToDeviceRatio: true,
    powerPreference: "default",
    antialias: true,
  });

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.1, 0.18, 1);

  const camera = new ArcRotateCamera(
    "camera",
    WAREHOUSE_CAMERA.alpha,
    WAREHOUSE_CAMERA.beta,
    8,
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 20;
  camera.minZ = 0.1;
  camera.lowerRadiusLimit = 1;
  camera.upperRadiusLimit = 500;

  const rightCamera = createSyncedCamera("cameraRight", camera, scene);

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  let activeScene: SceneId = "warehouse";
  let splitCompareEnabled = false;

  let warehouseMesh: AbstractMesh;
  let warehouseLodBridge: AholoLodBridge | null;
  let warehouseDirectMesh: AbstractMesh | null = null;
  let warehouseDirectLoadPromise: Promise<AbstractMesh> | null = null;

  let mcIn1FMesh: AbstractMesh | null = null;
  let mcIn1FLoadPromise: Promise<AbstractMesh> | null = null;
  let mcIn1FLodMesh: AbstractMesh | null = null;
  let mcIn1FLodBridge: AholoLodBridge | null = null;
  let mcIn1FLodLoadPromise: Promise<AbstractMesh> | null = null;

  let warehouseCollision: VoxelOverlay | null = null;
  let mcIn1FCollision: VoxelOverlay | null = null;
  let mcIn1FCollisionAnchor: AbstractMesh | null = null;
  let mcIn1FCollisionLoadPromise: Promise<VoxelOverlay | null> | null = null;
  let warehouseCollisionNote = "collision mesh 없음 — npm run preprocess:warehouse:voxel";
  let mcIn1FCollisionNote = "collision mesh 없음 — npm run preprocess:mc-in-1f:voxel";

  const setOverlayLayer = (overlay: VoxelOverlay, layer: number) => {
    setMeshRenderLayer(overlay.root, layer);
    for (const mesh of overlay.meshes) {
      setMeshRenderLayer(mesh, layer);
    }
  };

  const getActiveCollisionSet = (): CompareSet | null => {
    if (activeScene === "warehouse" || activeScene === "mcIn1F" || activeScene === "mcIn1FLod") {
      return getCompareSet(activeScene);
    }
    return null;
  };

  const isCollisionChecked = () => collisionToggle?.checked ?? false;

  const refreshCollisionDisplay = () => {
    const set = getActiveCollisionSet();
    const checked = isCollisionChecked();

    warehouseCollision?.setVisible(set === "warehouse" && checked);
    mcIn1FCollision?.setVisible(set === "mcIn1F" && checked);

    if (!set || !checked) return;

    const overlay = set === "warehouse" ? warehouseCollision : mcIn1FCollision;
    if (!overlay) return;

    if (splitCompareEnabled) {
      const layer = set === "mcIn1F" ? LAYER_SPLIT_BOTH : LAYER_LOD;
      setOverlayLayer(overlay, layer);
    } else {
      setOverlayLayer(overlay, LAYER_ALL);
    }
  };

  const allSplatMeshes = (): AbstractMesh[] =>
    [warehouseMesh, warehouseDirectMesh, mcIn1FMesh, mcIn1FLodMesh].filter(
      (mesh): mesh is AbstractMesh => mesh !== null
    );

  const getCompareLodBridge = (): AholoLodBridge | null => {
    const compareSet = getCompareSet(activeScene);
    return compareSet === "warehouse" ? warehouseLodBridge : mcIn1FLodBridge;
  };

  const getActiveLodBridge = (): AholoLodBridge | null => {
    if (splitCompareEnabled) return getCompareLodBridge();
    if (activeScene === "warehouse") return warehouseLodBridge;
    if (activeScene === "mcIn1FLod") return mcIn1FLodBridge;
    return null;
  };

  const updateSceneHud = () => {
    const lodBridge = getActiveLodBridge();
    const hasLod = lodBridge !== null;
    const compareSet = getCompareSet(activeScene);
    const sceneLabel = SCENE_LABELS[activeScene];

    if (splitCompareEnabled) {
      const collisionHint =
        getActiveCollisionSet() === "mcIn1F" && mcIn1FCollision
          ? " · collision 와이어 (좌·우)"
          : "";
      setHudText(
        `${sceneLabel} · 화면 분할`,
        `좌 Chunk LoD · 우 직접 로드 · 카메라 동기화${collisionHint} · ${formatPerfLabel(hasLod)}`
      );
      tuneEnginePerformance(engine, hasLod);
      return;
    }

    if (activeScene === "warehouse") {
      const lodNote = hasLod ? "Chunk LoD 적용" : "LoD 없음";
      setHudText(
        SCENE_LABELS.warehouse,
        `${lodNote} · ${warehouseCollisionNote} · ${formatPerfLabel(hasLod)}`
      );
    } else if (activeScene === "mcIn1FLod") {
      const lodNote = hasLod ? "Chunk LoD 적용" : "LoD 없음 (preprocess:iob 권장)";
      setHudText(
        SCENE_LABELS.mcIn1FLod,
        `${lodNote} · ${mcIn1FCollisionNote} · ${formatPerfLabel(hasLod)}`
      );
    } else {
      setHudText(
        SCENE_LABELS.mcIn1F,
        `LoD 없음 · 직접 로드 · ${mcIn1FCollisionNote} · ${formatPerfLabel(false)}`
      );
    }

    tuneEnginePerformance(engine, hasLod);
  };

  const setCollisionPanelVisible = (visible: boolean) => {
    const fieldset = document.getElementById("collision-toggles");
    if (fieldset) fieldset.hidden = !visible;
  };

  const hideAllSplats = () => {
    for (const mesh of allSplatMeshes()) {
      mesh.isVisible = false;
      mesh.layerMask = LAYER_ALL;
    }
  };

  const getFramingBoundsMesh = (focusMesh: AbstractMesh): AbstractMesh => {
    if (getCompareSet(activeScene) === "mcIn1F" && mcIn1FCollision) {
      return mcIn1FCollision.root;
    }
    return focusMesh;
  };

  const getFramingPreset = (): InteriorCameraPreset =>
    getCompareSet(activeScene) === "mcIn1F" ? MC_IN_1F_CAMERA : WAREHOUSE_CAMERA;

  const frameCamerasForScene = (
    focusMesh: AbstractMesh,
    primary: ArcRotateCamera,
    secondary: ArcRotateCamera | null = null
  ) => {
    const boundsMesh = getFramingBoundsMesh(focusMesh);
    const preset = getFramingPreset();
    frameInteriorCamera(primary, boundsMesh, preset);
    if (secondary) frameInteriorCamera(secondary, boundsMesh, preset);
  };

  const scheduleCameraRefine = (
    focusMesh: AbstractMesh,
    primary: ArcRotateCamera,
    secondary: ArcRotateCamera | null
  ) => {
    let frames = 0;
    const observer = scene.onAfterRenderObservable.add(() => {
      frames += 1;
      if (frames >= 3) {
        frameCamerasForScene(focusMesh, primary, secondary);
        scene.onAfterRenderObservable.remove(observer);
      }
    });
  };

  const applySingleView = (focusMesh: AbstractMesh) => {
    disableSplitView(scene, camera);
    setSplitLabelsVisible(false);
    hideAllSplats();

    if (activeScene === "warehouse") {
      warehouseMesh.isVisible = true;
    } else if (activeScene === "mcIn1F") {
      mcIn1FMesh!.isVisible = true;
    } else {
      mcIn1FLodMesh!.isVisible = true;
    }

    refreshCollisionDisplay();
    frameCamerasForScene(focusMesh, camera);
    scheduleCameraRefine(focusMesh, camera, null);
    updateSceneHud();
    setCollisionPanelVisible(getActiveCollisionSet() !== null);
  };

  const applySplitView = async () => {
    const compareSet = getCompareSet(activeScene);
    const label = compareSet === "warehouse" ? SCENE_LABELS.warehouse : SCENE_LABELS.mcIn1F;
    setHudText(`${label} · 화면 분할`, "좌우 비교용 모델 로딩 중...");

    const pair =
      compareSet === "warehouse"
        ? {
            lodMesh: warehouseMesh,
            directMesh: await ensureWarehouseDirect(),
          }
        : {
            lodMesh: await ensureMcIn1FLod(),
            directMesh: await ensureMcIn1F(),
          };

    hideAllSplats();
    pair.lodMesh.isVisible = true;
    pair.directMesh.isVisible = true;
    setMeshRenderLayer(pair.lodMesh, LAYER_LOD);
    setMeshRenderLayer(pair.directMesh, LAYER_DIRECT);

    if (compareSet === "mcIn1F") {
      await ensureMcIn1FCollision();
    }

    refreshCollisionDisplay();

    syncArcRotateCamera(camera, rightCamera);
    enableSplitView(scene, camera, rightCamera);
    setSplitLabelsVisible(true);

    frameCamerasForScene(pair.lodMesh, camera, rightCamera);
    scheduleCameraRefine(pair.lodMesh, camera, rightCamera);

    updateSceneHud();
    setCollisionPanelVisible(true);
  };

  const applyDisplayState = async (focusMesh?: AbstractMesh) => {
    if (splitCompareEnabled) {
      await applySplitView();
      return;
    }

    if (activeScene === "mcIn1F" || activeScene === "mcIn1FLod") {
      await ensureMcIn1FCollision();
    }

    let mesh = focusMesh ?? warehouseMesh;
    if (activeScene === "mcIn1F") mesh = mcIn1FMesh ?? mesh;
    if (activeScene === "mcIn1FLod") mesh = mcIn1FLodMesh ?? mesh;
    applySingleView(mesh);
  };

  setHudText("로딩 중...", "3Dcam 창고 SOG 불러오는 중...");

  const warehouseLoaded = await loadGaussianWithLodFallback(scene, camera, WAREHOUSE_SOG);
  warehouseMesh = warehouseLoaded.mesh;
  warehouseLodBridge = warehouseLoaded.lodBridge;
  warehouseMesh.renderingGroupId = 0;

  frameInteriorCamera(camera, warehouseMesh, WAREHOUSE_CAMERA);
  scheduleCameraRefine(warehouseMesh, camera, null);
  setupKeyboardCameraControls(scene, camera, canvas);
  setupLodStatusHud(scene, getActiveLodBridge);
  setupPerfHud(scene, engine, getActiveLodBridge);

  scene.onBeforeRenderObservable.add(() => {
    if (splitCompareEnabled) {
      syncArcRotateCamera(camera, rightCamera);
    }
    const lodBridge = getActiveLodBridge();
    if (lodBridge) lodBridge.tick(camera);
  });

  const collisionToggle = document.getElementById("toggle-collision") as HTMLInputElement | null;
  try {
    warehouseCollision = await attachVoxelOverlay(scene, warehouseMesh, WAREHOUSE_COLLISION_GLB, {
      label: "warehouseCollision",
    });
    warehouseCollisionNote = "반투명 collision 와이어 (voxel mesh)";
    if (collisionToggle) {
      collisionToggle.checked = true;
    }
  } catch (err) {
    console.warn("[collision] warehouse", err);
  }

  collisionToggle?.addEventListener("change", () => {
    refreshCollisionDisplay();
    if (activeScene === "warehouse" || splitCompareEnabled) {
      warehouseMesh.isVisible = true;
    }
  });

  if (collisionToggle && !warehouseCollision && !mcIn1FCollision) {
    collisionToggle.disabled = true;
    collisionToggle.checked = false;
  } else if (collisionToggle && warehouseCollision) {
    warehouseCollision.setVisible(true);
  }

  const resolveMcIn1FCollisionAnchor = async (): Promise<AbstractMesh> => {
    if (splitCompareEnabled || activeScene === "mcIn1FLod") {
      return mcIn1FLodMesh ?? (await ensureMcIn1FLod());
    }
    return mcIn1FMesh ?? (await ensureMcIn1F());
  };

  const ensureMcIn1FCollision = async (): Promise<VoxelOverlay | null> => {
    let anchor: AbstractMesh;
    try {
      anchor = await resolveMcIn1FCollisionAnchor();
    } catch {
      return null;
    }

    if (mcIn1FCollision && mcIn1FCollisionAnchor === anchor) {
      return mcIn1FCollision;
    }

    if (mcIn1FCollision) {
      mcIn1FCollision.dispose();
      mcIn1FCollision = null;
      mcIn1FCollisionLoadPromise = null;
    }

    if (!mcIn1FCollisionLoadPromise) {
      mcIn1FCollisionLoadPromise = (async () => {
        const overlay = await attachVoxelOverlay(scene, anchor, MC_IN_1F_COLLISION_GLB, {
          label: "mcIn1FCollision",
        });
        mcIn1FCollision = overlay;
        mcIn1FCollisionAnchor = anchor;
        mcIn1FCollisionNote = "반투명 collision 와이어 (1층 voxel)";
        overlay.setVisible(false);
        if (collisionToggle) collisionToggle.disabled = false;
        return overlay;
      })().catch((err) => {
        console.warn("[collision] mc-in-1f", err);
        mcIn1FCollisionNote = "collision 없음 — npm run preprocess:mc-in-1f:voxel";
        mcIn1FCollisionLoadPromise = null;
        mcIn1FCollisionAnchor = null;
        return null;
      });
    }
    return mcIn1FCollisionLoadPromise;
  };

  updateSceneHud();

  const ensureWarehouseDirect = async (): Promise<AbstractMesh> => {
    if (warehouseDirectMesh) return warehouseDirectMesh;
    if (!warehouseDirectLoadPromise) {
      warehouseDirectLoadPromise = (async () => {
        const mesh = await loadGaussianDirect(
          scene,
          { name: "warehouseDirect", url: WAREHOUSE_SOG.url },
          { flipScaleY: true }
        );
        mesh.isVisible = false;
        mesh.renderingGroupId = 0;
        warehouseDirectMesh = mesh;
        return mesh;
      })().catch((err) => {
        warehouseDirectLoadPromise = null;
        throw err;
      });
    }
    return warehouseDirectLoadPromise;
  };

  const ensureMcIn1F = async (): Promise<AbstractMesh> => {
    if (mcIn1FMesh) return mcIn1FMesh;
    if (!mcIn1FLoadPromise) {
      mcIn1FLoadPromise = (async () => {
        const mesh = await loadGaussianDirect(scene, MC_IN_1F);
        mesh.isVisible = false;
        mesh.renderingGroupId = 0;
        mcIn1FMesh = mesh;
        return mesh;
      })().catch((err) => {
        mcIn1FLoadPromise = null;
        throw err;
      });
    }
    return mcIn1FLoadPromise;
  };

  const ensureMcIn1FLod = async (): Promise<AbstractMesh> => {
    if (mcIn1FLodMesh) return mcIn1FLodMesh;
    if (!mcIn1FLodLoadPromise) {
      mcIn1FLodLoadPromise = (async () => {
        const loaded = await loadGaussianWithLodFallback(scene, camera, MC_IN_1F_LOD);
        loaded.mesh.isVisible = false;
        loaded.mesh.renderingGroupId = 0;
        mcIn1FLodMesh = loaded.mesh;
        mcIn1FLodBridge = loaded.lodBridge;
        return loaded.mesh;
      })().catch((err) => {
        mcIn1FLodLoadPromise = null;
        throw err;
      });
    }
    return mcIn1FLodLoadPromise;
  };

  const resetSceneRadios = (sceneId: SceneId) => {
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="scene-id"]')) {
      radio.checked = radio.value === sceneId;
    }
  };

  const switchScene = async (next: SceneId) => {
    if (next === activeScene && !splitCompareEnabled) return;

    try {
      if (next === "mcIn1F") {
        await ensureMcIn1F();
        await ensureMcIn1FCollision();
      }
      if (next === "mcIn1FLod") await ensureMcIn1FLod();

      activeScene = next;
      await applyDisplayState();
    } catch (err) {
      console.error("[scene] switch failed:", err);
      activeScene = "warehouse";
      splitCompareEnabled = false;
      const splitToggle = document.getElementById("toggle-split-compare") as HTMLInputElement | null;
      if (splitToggle) splitToggle.checked = false;
      resetSceneRadios("warehouse");
      applySingleView(warehouseMesh);
      setHudText(SCENE_LABELS.warehouse, `장면 로드 실패 — ${String(err)}`);
    }
  };

  document.querySelectorAll<HTMLInputElement>('input[name="scene-id"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      void switchScene(radio.value as SceneId);
    });
  });

  const splitToggle = document.getElementById("toggle-split-compare") as HTMLInputElement | null;
  splitToggle?.addEventListener("change", () => {
    splitCompareEnabled = splitToggle.checked;
    void applyDisplayState().catch((err) => {
      console.error("[scene] split compare failed:", err);
      splitCompareEnabled = false;
      splitToggle.checked = false;
      void applyDisplayState();
      setHudText(SCENE_LABELS[activeScene], `화면 분할 실패 — ${String(err)}`);
    });
  });

  const render = () => scene.render();
  engine.runRenderLoop(render);
  setupVisibilityRenderGate(engine, render);

  canvas.focus();
  window.addEventListener("resize", () => engine.resize());
}
