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

const INTERIOR_CAMERA = {
  alpha: -Math.PI / 2,
  beta: Math.PI / 2.05,
  targetHeightRatio: 0.38,
  radiusRatio: 0.42,
};

function getCompareSet(sceneId: SceneId): CompareSet {
  return sceneId === "warehouse" ? "warehouse" : "mcIn1F";
}

function frameInteriorCamera(camera: ArcRotateCamera, mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
  const extent = max.subtract(min);

  const target = new Vector3(
    (min.x + max.x) * 0.5,
    min.y + extent.y * INTERIOR_CAMERA.targetHeightRatio,
    (min.z + max.z) * 0.5
  );

  const horizontalSpan = Math.max(Math.min(extent.x, extent.z), 0.5);
  const radius = Math.max(horizontalSpan * INTERIOR_CAMERA.radiusRatio, 1.5);
  const maxExtent = Math.max(extent.x, extent.y, extent.z, 1);

  camera.alpha = INTERIOR_CAMERA.alpha;
  camera.beta = INTERIOR_CAMERA.beta;
  camera.setTarget(target);
  camera.radius = radius;
  camera.lowerRadiusLimit = Math.max(radius * 0.15, 0.5);
  camera.upperRadiusLimit = maxExtent * 2.5;
}

function scheduleInteriorCameraRefine(
  primary: ArcRotateCamera,
  secondary: ArcRotateCamera | null,
  mesh: AbstractMesh,
  scene: Scene
) {
  let frames = 0;
  const observer = scene.onAfterRenderObservable.add(() => {
    frames += 1;
    if (frames >= 3) {
      frameInteriorCamera(primary, mesh);
      if (secondary) frameInteriorCamera(secondary, mesh);
      scene.onAfterRenderObservable.remove(observer);
    }
  });
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
    INTERIOR_CAMERA.alpha,
    INTERIOR_CAMERA.beta,
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

  let collisionOverlay: VoxelOverlay | null = null;
  let collisionNote = "collision mesh 없음 — npm run preprocess:warehouse:voxel";

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
      setHudText(
        `${sceneLabel} · 화면 분할`,
        `좌 Chunk LoD · 우 직접 로드 · 카메라 동기화 · ${formatPerfLabel(hasLod)}`
      );
      tuneEnginePerformance(engine, hasLod);
      return;
    }

    if (activeScene === "warehouse") {
      const lodNote = hasLod ? "Chunk LoD 적용" : "LoD 없음";
      setHudText(SCENE_LABELS.warehouse, `${lodNote} · ${collisionNote} · ${formatPerfLabel(hasLod)}`);
    } else if (activeScene === "mcIn1FLod") {
      const lodNote = hasLod ? "Chunk LoD 적용" : "LoD 없음 (preprocess:iob 권장)";
      setHudText(SCENE_LABELS.mcIn1FLod, `${lodNote} · ${formatPerfLabel(hasLod)}`);
    } else {
      setHudText(SCENE_LABELS.mcIn1F, `LoD 없음 · 직접 로드 · ${formatPerfLabel(false)}`);
    }

    tuneEnginePerformance(engine, hasLod);
  };

  const setCollisionPanelVisible = (visible: boolean) => {
    const fieldset = document.getElementById("collision-toggles");
    if (fieldset) fieldset.hidden = !visible;
  };

  const applyCollisionLayers = (layer: number) => {
    if (!collisionOverlay) return;
    setMeshRenderLayer(collisionOverlay.root, layer);
    for (const mesh of collisionOverlay.meshes) {
      setMeshRenderLayer(mesh, layer);
    }
  };

  const hideAllSplats = () => {
    for (const mesh of allSplatMeshes()) {
      mesh.isVisible = false;
      mesh.layerMask = LAYER_ALL;
    }
  };

  const applySingleView = (focusMesh: AbstractMesh) => {
    disableSplitView(scene, camera);
    setSplitLabelsVisible(false);
    hideAllSplats();

    if (activeScene === "warehouse") {
      warehouseMesh.isVisible = true;
      collisionOverlay?.setVisible(true);
      applyCollisionLayers(LAYER_ALL);
    } else if (activeScene === "mcIn1F") {
      mcIn1FMesh!.isVisible = true;
      collisionOverlay?.setVisible(false);
    } else {
      mcIn1FLodMesh!.isVisible = true;
      collisionOverlay?.setVisible(false);
    }

    frameInteriorCamera(camera, focusMesh);
    scheduleInteriorCameraRefine(camera, null, focusMesh, scene);
    updateSceneHud();
    setCollisionPanelVisible(activeScene === "warehouse");
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

    if (compareSet === "warehouse" && collisionOverlay) {
      const collisionToggle = document.getElementById("toggle-collision") as HTMLInputElement | null;
      collisionOverlay.setVisible(collisionToggle?.checked ?? true);
      applyCollisionLayers(LAYER_LOD);
    } else {
      collisionOverlay?.setVisible(false);
    }

    syncArcRotateCamera(camera, rightCamera);
    enableSplitView(scene, camera, rightCamera);
    setSplitLabelsVisible(true);

    frameInteriorCamera(camera, pair.lodMesh);
    frameInteriorCamera(rightCamera, pair.lodMesh);
    scheduleInteriorCameraRefine(camera, rightCamera, pair.lodMesh, scene);

    updateSceneHud();
    setCollisionPanelVisible(compareSet === "warehouse");
  };

  const applyDisplayState = async (focusMesh?: AbstractMesh) => {
    if (splitCompareEnabled) {
      await applySplitView();
      return;
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

  frameInteriorCamera(camera, warehouseMesh);
  scheduleInteriorCameraRefine(camera, null, warehouseMesh, scene);
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
    collisionOverlay = await attachVoxelOverlay(scene, warehouseMesh, WAREHOUSE_COLLISION_GLB, {
      label: "warehouseCollision",
    });
    collisionNote = "반투명 collision 와이어 (voxel mesh)";
    collisionToggle?.addEventListener("change", () => {
      if (activeScene !== "warehouse" && !splitCompareEnabled) return;
      if (getCompareSet(activeScene) !== "warehouse") return;
      collisionOverlay?.setVisible(collisionToggle.checked);
      warehouseMesh.isVisible = true;
    });
    if (collisionToggle) {
      collisionToggle.checked = true;
      collisionOverlay.setVisible(true);
    }
  } catch (err) {
    console.warn("[collision]", err);
    if (collisionToggle) {
      collisionToggle.disabled = true;
      collisionToggle.checked = false;
    }
  }

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
      if (next === "mcIn1F") await ensureMcIn1F();
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
