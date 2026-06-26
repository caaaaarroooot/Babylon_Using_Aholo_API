import {
  AbstractMesh,
  ArcRotateCamera,
  Color4,
  Engine,
  HemisphericLight,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { setupKeyboardCameraControls } from "./cameraControls";
import {
  formatPerfLabel,
  setupVisibilityRenderGate,
  tuneEnginePerformance,
} from "./renderPerformance";
import { setupLodStatusHud } from "./lodStatusHud";
import { setupPerfHud } from "./perfHud";
import { loadGaussianWithLodFallback } from "./splatLoader";
import { attachVoxelOverlay } from "./voxelOverlay";

const WAREHOUSE_SOG = {
  name: "warehouse",
  url: "/models/iob/260615_MC_3dcam_warehouse_model_1.sog",
  lodMetaUrl: "/models/iob-lod/warehouse/lod-meta.json",
};

const WAREHOUSE_COLLISION_GLB = "/models/iob-voxel/warehouse/collision.glb";

const INTERIOR_CAMERA = {
  alpha: -Math.PI / 2,
  beta: Math.PI / 2.05,
  targetHeightRatio: 0.38,
  radiusRatio: 0.42,
};

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
  camera: ArcRotateCamera,
  mesh: AbstractMesh,
  scene: Scene
) {
  let frames = 0;
  const observer = scene.onAfterRenderObservable.add(() => {
    frames += 1;
    if (frames >= 3) {
      frameInteriorCamera(camera, mesh);
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

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  setHudText("로딩 중...", "3Dcam 창고 SOG 불러오는 중...");

  const { mesh, lodBridge } = await loadGaussianWithLodFallback(scene, camera, WAREHOUSE_SOG);
  const hasLod = lodBridge !== null;
  tuneEnginePerformance(engine, hasLod);
  mesh.isVisible = true;
  mesh.renderingGroupId = 0;

  frameInteriorCamera(camera, mesh);
  scheduleInteriorCameraRefine(camera, mesh, scene);
  setupKeyboardCameraControls(scene, camera, canvas);
  setupLodStatusHud(scene, lodBridge);
  setupPerfHud(scene, engine, lodBridge);

  let collisionNote = "collision mesh 없음 — npm run preprocess:warehouse:voxel";
  const collisionToggle = document.getElementById("toggle-collision") as HTMLInputElement | null;
  try {
    const overlay = await attachVoxelOverlay(scene, mesh, WAREHOUSE_COLLISION_GLB, {
      label: "warehouseCollision",
    });
    collisionNote = "반투명 collision 와이어 (voxel mesh)";
    collisionToggle?.addEventListener("change", () => {
      overlay.setVisible(collisionToggle.checked);
      mesh.isVisible = true;
    });
    if (collisionToggle) {
      collisionToggle.checked = true;
      overlay.setVisible(true);
    }
  } catch (err) {
    console.warn("[collision]", err);
    if (collisionToggle) {
      collisionToggle.disabled = true;
      collisionToggle.checked = false;
    }
  }

  const lodNote = hasLod ? "Chunk LoD 적용" : "LoD 없음";
  setHudText("3Dcam 창고", `${lodNote} · ${collisionNote} · ${formatPerfLabel(hasLod)}`);

  const render = () => scene.render();
  engine.runRenderLoop(render);
  setupVisibilityRenderGate(engine, render);

  canvas.focus();
  window.addEventListener("resize", () => engine.resize());
}
