import {
  Color4,
  Engine,
  Scene,
  ArcRotateCamera,
  Color3,
  Vector3,
  HemisphericLight,
  ImportMeshAsync,
  Mesh,
} from "@babylonjs/core";
import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import {
  attachObjectEntity,
  computeSideBySideOffsetX,
  hasCollision,
  setupColliderVisibilityControls,
  setupWasdCollisionDemo,
} from "./collisionDemo";
import { enableHavokPhysics, HavokCollisionTracker } from "./havokCollision";

const SKULL_SPZ = "/models/skull.spz";
/** 통합 Aholo voxel collision (해골+받침대 미분리) */
const UNIFIED_COLLISION_GLB = "/models/skull-voxel/collision.glb";

// ── 이전: 해골/받침대 분리 collision mesh (비활성) ──
// const SKULL_COLLISION_GLB = "/models/skull-part-voxel/collision.glb";
// const GROUND_COLLISION_GLB = "/models/ground-voxel/collision.glb";

export async function createScene(canvas: HTMLCanvasElement) {
  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.1, 0.18, 1);

  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.4,
    5,
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 50;
  camera.minZ = 0.01;
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 15;

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  await enableHavokPhysics(scene);
  const collisionTracker = new HavokCollisionTracker();
  const physicsViewer = new PhysicsViewer(scene);

  const splatLoadOptions = {
    pluginOptions: { splat: { flipY: false } },
  };

  const [fixedResult, movableResult, collisionResult] = await Promise.all([
    ImportMeshAsync(SKULL_SPZ, scene, splatLoadOptions),
    ImportMeshAsync(SKULL_SPZ, scene, splatLoadOptions),
    ImportMeshAsync(UNIFIED_COLLISION_GLB, scene),
  ]);

  const fixedMesh = fixedResult.meshes[0] as Mesh;
  const movableMesh = movableResult.meshes[0] as Mesh;
  fixedMesh.name = "skullFixed";
  movableMesh.name = "skullMovable";

  const movableScale = 0.85;

  fixedMesh.position.set(0, 0, 0);
  movableMesh.scaling.scaleInPlace(movableScale);

  const collisionTemplate = collisionResult.meshes[0];
  collisionTemplate.setEnabled(false);

  const movableOffsetX = computeSideBySideOffsetX(
    collisionTemplate as Mesh,
    movableScale
  );
  movableMesh.position.set(movableOffsetX, 0, 0);

  fixedMesh.refreshBoundingInfo({ applySkeleton: false });
  camera.setTarget(fixedMesh.getBoundingInfo().boundingBox.centerWorld);

  const FIXED_COLOR = new Color3(0.15, 0.75, 1.0);
  const MOVABLE_COLOR = new Color3(1.0, 0.45, 0.05);

  const collisionScene = {
    fixed: attachObjectEntity(
      scene,
      fixedMesh,
      collisionTemplate,
      "고정",
      FIXED_COLOR,
      "fixed",
      collisionTracker,
      physicsViewer
    ),
    movable: attachObjectEntity(
      scene,
      movableMesh,
      collisionTemplate,
      "이동",
      MOVABLE_COLOR,
      "movable",
      collisionTracker,
      physicsViewer
    ),
  };

  const statusEl = document.getElementById("collision-status");
  const titleEl = document.getElementById("collision-title");
  const detailEl = document.getElementById("collision-detail");
  const fixedToggle = document.getElementById("toggle-fixed") as HTMLInputElement;
  const movableToggle = document.getElementById("toggle-movable") as HTMLInputElement;

  setupColliderVisibilityControls(collisionScene, fixedToggle, movableToggle);

  setupWasdCollisionDemo(scene, camera, canvas, collisionScene, collisionTracker, (hit, message) => {
    if (titleEl) titleEl.textContent = message.title;
    if (detailEl) detailEl.textContent = message.detail;
    if (statusEl) {
      statusEl.dataset.state = hasCollision(hit) ? "hit" : "idle";
    }
  });

  canvas.focus();
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}
