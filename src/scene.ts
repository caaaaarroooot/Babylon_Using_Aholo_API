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
import { setupShiftClickCoordinateLog } from "./shiftClickCoords";
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
import { createRobotMcIn1FSession, type RobotMcIn1FSession } from "./robotMcIn1F";
import { MC_IN_1F_INTERIOR, frameMcIn1FInterior } from "./mcIn1FInterior";

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

/** 1층 — collision 볼륨 안쪽에서 시작 (frameMcIn1FInterior와 동기화) */
const MC_IN_1F_CAMERA = MC_IN_1F_INTERIOR;

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
  if (preset === MC_IN_1F_CAMERA) {
    frameMcIn1FInterior(camera, min, max);
    return;
  }

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
  let mcIn1FCollisionLoadPromise: Promise<VoxelOverlay | null> | null = null;
  let warehouseCollisionNote = "collision mesh 없음 — npm run preprocess:warehouse:voxel";
  let mcIn1FCollisionNote = "collision mesh 없음 — npm run preprocess:mc-in-1f:voxel";

  let robotSession: RobotMcIn1FSession | null = null;
  let teardownFreeCamera: (() => void) | null = null;

  const isMcIn1FSingleView = () => !splitCompareEnabled && activeScene === "mcIn1F";

  const setRobotPanelVisible = (visible: boolean) => {
    const fieldset = document.getElementById("robot-mode-toggles");
    if (fieldset) fieldset.hidden = !visible;
  };

  const setRobotExitVisible = (visible: boolean) => {
    const panel = document.getElementById("robot-mode-exit");
    if (panel) panel.hidden = !visible;
  };

  const setOverlayLayer = (overlay: VoxelOverlay, layer: number) => {
    setMeshRenderLayer(overlay.root, layer);
    for (const mesh of overlay.meshes) {
      setMeshRenderLayer(mesh, layer);
    }
  };

  const allSplatMeshes = (): AbstractMesh[] =>
    [warehouseMesh, warehouseDirectMesh, mcIn1FMesh, mcIn1FLodMesh].filter(
      (mesh): mesh is AbstractMesh => mesh !== null
    );

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

  const applySingleView = (focusMesh: AbstractMesh, options?: { skipCameraFraming?: boolean }) => {
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
    if (!options?.skipCameraFraming) {
      frameCamerasForScene(focusMesh, camera);
      scheduleCameraRefine(focusMesh, camera, null);
    }
    updateSceneHud();
    setCollisionPanelVisible(getActiveCollisionSet() !== null);
    setRobotPanelVisible(isMcIn1FSingleView() && !robotSession);
  };

  const disableRobotMode = () => {
    const robotToggle = document.getElementById("toggle-robot-mode") as HTMLInputElement | null;
    if (robotSession) {
      robotSession.dispose();
      robotSession = null;
    }
    if (robotToggle) robotToggle.checked = false;
    if (!teardownFreeCamera) {
      teardownFreeCamera = setupKeyboardCameraControls(scene, camera, canvas);
    }
    camera.panningSensibility = 40;
    setRobotExitVisible(false);
    setRobotPanelVisible(isMcIn1FSingleView());
  };

  const enableRobotMode = async (spawnFootWorld?: Vector3) => {
    let cameraFollow: { alpha: number; beta: number; radius: number } | undefined;
    if (robotSession) {
      if (!spawnFootWorld) return;
      cameraFollow = {
        alpha: camera.alpha,
        beta: camera.beta,
        radius: camera.radius,
      };
      robotSession.dispose();
      robotSession = null;
    }
    if (splitCompareEnabled) {
      throw new Error("화면 분할 중에는 로봇 모드를 사용할 수 없습니다.");
    }

    if (activeScene !== "mcIn1F") {
      activeScene = "mcIn1F";
      resetSceneRadios("mcIn1F");
    }

    await ensureMcIn1F();
    await ensureMcIn1FCollision();
    const mesh = mcIn1FMesh;
    if (!mesh) throw new Error("1층 splat 로드 실패");

    applySingleView(mesh, { skipCameraFraming: true });

    if (teardownFreeCamera) {
      teardownFreeCamera();
      teardownFreeCamera = null;
    }

    const robotToggle = document.getElementById("toggle-robot-mode") as HTMLInputElement | null;
    if (robotToggle) robotToggle.checked = true;

    robotSession = await createRobotMcIn1FSession({
      scene,
      camera,
      canvas,
      splatMesh: mesh,
      collisionGlbUrl: MC_IN_1F_COLLISION_GLB,
      spawnFootWorld,
      cameraFollow,
      onStatus: (blocked) => {
        const statusEl = document.getElementById("collision-status");
        if (statusEl) statusEl.dataset.state = blocked ? "hit" : "idle";
        setHudText(
          "1층 · 로봇 조종",
          blocked
            ? "복셀 충돌 — 해당 방향 진행 불가 · 후진/측면 이동 가능"
            : "WASD 로봇 기준 이동 · Q/E 상하 · ←→ 회전 · Ctrl+Shift 텔레포트"
        );
      },
    });

    const hudDetail = spawnFootWorld
      ? "Ctrl+Shift 텔레포트 · WASD 이동 · Q/E 상하 · ←→ 로봇 회전"
      : "WASD 로봇 기준 · Q/E 상하 · ←→ 회전 · Ctrl+Shift 텔레포트";
    setHudText("1층 · 로봇 조종", hudDetail);
    setRobotPanelVisible(false);
    setRobotExitVisible(true);
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
    setRobotPanelVisible(false);
    setRobotExitVisible(false);
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
  teardownFreeCamera = setupKeyboardCameraControls(scene, camera, canvas);
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
    warehouseCollisionNote = "Aholo voxel 와이어 (collision.glb)";
    if (collisionToggle) {
      collisionToggle.checked = false;
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
    warehouseCollision.setVisible(collisionToggle.checked);
  }

  refreshCollisionDisplay();

  /** 1층 직접 로드 vs Chunk LoD — 같은 splat, Y scale 부호만 다름 */
  const syncMcIn1FCollisionTransform = (splatMesh: AbstractMesh, colliderRoot: AbstractMesh) => {
    splatMesh.computeWorldMatrix(true);
    colliderRoot.position.copyFrom(splatMesh.absolutePosition);
    colliderRoot.scaling.copyFrom(splatMesh.scaling);
    if (splatMesh.rotationQuaternion) {
      colliderRoot.rotationQuaternion = splatMesh.rotationQuaternion.clone();
    } else {
      colliderRoot.rotationQuaternion = null;
      colliderRoot.rotation.copyFrom(splatMesh.rotation);
    }
    if (splatMesh.scaling.y > 0) {
      colliderRoot.scaling.y *= -1;
    }
  };

  const getActiveMcIn1FSplatMesh = (): AbstractMesh | null => {
    if (splitCompareEnabled) {
      return mcIn1FLodMesh ?? mcIn1FMesh;
    }
    if (activeScene === "mcIn1FLod") return mcIn1FLodMesh;
    if (activeScene === "mcIn1F") return mcIn1FMesh;
    return null;
  };

  const ensureMcIn1FCollision = async (): Promise<VoxelOverlay | null> => {
    if (mcIn1FCollision) return mcIn1FCollision;

    if (!mcIn1FMesh && !mcIn1FLodMesh) {
      try {
        await ensureMcIn1F();
      } catch {
        try {
          await ensureMcIn1FLod();
        } catch {
          return null;
        }
      }
    }

    const anchor = getActiveMcIn1FSplatMesh() ?? mcIn1FMesh ?? mcIn1FLodMesh;
    if (!anchor) return null;

    if (!mcIn1FCollisionLoadPromise) {
      mcIn1FCollisionLoadPromise = (async () => {
        const overlay = await attachVoxelOverlay(scene, anchor, MC_IN_1F_COLLISION_GLB, {
          label: "mcIn1FCollision",
          resolveSplatMesh: getActiveMcIn1FSplatMesh,
          syncTransform: syncMcIn1FCollisionTransform,
        });
        mcIn1FCollision = overlay;
        mcIn1FCollisionNote = "Aholo voxel 와이어 (collision.glb · 1층 공통)";
        overlay.setVisible(false);
        if (collisionToggle) collisionToggle.disabled = false;
        return overlay;
      })().catch((err) => {
        console.warn("[collision] mc-in-1f", err);
        mcIn1FCollisionNote = "collision 없음 — npm run preprocess:mc-in-1f:voxel";
        mcIn1FCollisionLoadPromise = null;
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
    if (robotSession) disableRobotMode();

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
    if (robotSession) disableRobotMode();
    splitCompareEnabled = splitToggle.checked;
    void applyDisplayState().catch((err) => {
      console.error("[scene] split compare failed:", err);
      splitCompareEnabled = false;
      splitToggle.checked = false;
      void applyDisplayState();
      setHudText(SCENE_LABELS[activeScene], `화면 분할 실패 — ${String(err)}`);
    });
  });

  const robotToggle = document.getElementById("toggle-robot-mode") as HTMLInputElement | null;
  robotToggle?.addEventListener("change", () => {
    if (robotToggle.checked) {
      void enableRobotMode().catch((err) => {
        console.error("[robot]", err);
        disableRobotMode();
        setHudText(SCENE_LABELS.mcIn1F, `로봇 모드 실패 — ${String(err)}`);
      });
    } else {
      disableRobotMode();
      void applyDisplayState();
    }
  });

  const exitRobotMode = () => {
    disableRobotMode();
    void applyDisplayState();
  };

  document.getElementById("btn-exit-robot-mode")?.addEventListener("click", exitRobotMode);

  setRobotPanelVisible(false);
  setRobotExitVisible(false);

  const applyDefaultStartup = async () => {
    resetSceneRadios("mcIn1F");
    await switchScene("mcIn1F");
    if (robotToggle?.checked) {
      await enableRobotMode();
    } else {
      setRobotPanelVisible(isMcIn1FSingleView());
    }
  };

  void applyDefaultStartup().catch((err) => {
    console.error("[scene] default startup failed:", err);
    setHudText(SCENE_LABELS.mcIn1F, `시작 설정 실패 — ${String(err)}`);
    setRobotPanelVisible(isMcIn1FSingleView());
  });

  setupShiftClickCoordinateLog(scene, canvas, {
    getCamera: () => {
      if (splitCompareEnabled && scene.pointerX >= canvas.clientWidth * 0.5) {
        return rightCamera;
      }
      return camera;
    },
    getPickMeshes: () => {
      const set = getActiveCollisionSet();
      if (set === "warehouse" && warehouseCollision) return warehouseCollision.meshes;
      if (set === "mcIn1F" && mcIn1FCollision) return mcIn1FCollision.meshes;
      return [];
    },
    getCollisionRoot: () => {
      const set = getActiveCollisionSet();
      if (set === "mcIn1F" && mcIn1FCollision) return mcIn1FCollision.root;
      if (set === "warehouse" && warehouseCollision) return warehouseCollision.root;
      return null;
    },
    getFallbackPlaneY: () => {
      const focus =
        getActiveMcIn1FSplatMesh() ??
        (activeScene === "warehouse" ? warehouseMesh : null);
      if (!focus) return null;
      focus.computeWorldMatrix(true);
      return focus.getBoundingInfo().boundingBox.minimumWorld.y;
    },
    onCtrlShiftClick: async (world) => {
      if (splitCompareEnabled) {
        console.warn("[robot] Ctrl+Shift+click — 화면 분할 중에는 사용할 수 없습니다.");
        return;
      }
      if (activeScene !== "mcIn1F") {
        console.warn("[robot] Ctrl+Shift+click — 1층 단일 뷰에서만 사용 가능합니다.");
        return;
      }

      try {
        await ensureMcIn1FCollision();
        if (robotSession) {
          console.info(
            `[robot] teleport — 기존 로봇 제거 후 재생성 (${world.x.toFixed(2)}, ${world.y.toFixed(2)}, ${world.z.toFixed(2)})`
          );
        }
        await enableRobotMode(world);
      } catch (err) {
        console.error("[robot] Ctrl+Shift+click spawn failed:", err);
        disableRobotMode();
        setHudText(SCENE_LABELS.mcIn1F, `로봇 텔레포트 실패 — ${String(err)}`);
      }
    },
  });

  const render = () => scene.render();
  engine.runRenderLoop(render);
  setupVisibilityRenderGate(engine, render);

  canvas.focus();
  window.addEventListener("resize", () => engine.resize());
}
