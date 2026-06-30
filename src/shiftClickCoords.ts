import {
  AbstractMesh,
  ArcRotateCamera,
  Matrix,
  Plane,
  Scene,
  Vector3,
} from "@babylonjs/core";

export type ShiftClickCoordOptions = {
  getCamera: () => ArcRotateCamera;
  getPickMeshes: () => AbstractMesh[];
  getCollisionRoot?: () => AbstractMesh | null;
  getFallbackPlaneY?: () => number | null;
  /** Ctrl+Shift+좌클릭 — 월드 좌표(로봇 발 기준점) */
  onCtrlShiftClick?: (world: Vector3, collisionLocal: Vector3 | null) => void | Promise<void>;
};

function worldToLocal(root: AbstractMesh, world: Vector3): Vector3 {
  root.computeWorldMatrix(true);
  const inv = root.getWorldMatrix().clone();
  inv.invert();
  return Vector3.TransformCoordinates(world, inv);
}

function fmtVec3(v: Vector3): string {
  return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`;
}

function pickWorldPoint(
  scene: Scene,
  camera: ArcRotateCamera,
  pointerX: number,
  pointerY: number,
  meshes: AbstractMesh[]
): { point: Vector3; mesh: AbstractMesh; distance: number } | null {
  const ray = scene.createPickingRay(pointerX, pointerY, Matrix.Identity(), camera, false);

  let closest: { point: Vector3; mesh: AbstractMesh; distance: number } | null = null;
  for (const mesh of meshes) {
    if (!mesh.isEnabled()) continue;
    const hit = ray.intersectsMesh(mesh, false);
    if (!hit.hit || hit.distance === undefined) continue;
    if (!closest || hit.distance < closest.distance) {
      closest = {
        point: ray.origin.add(ray.direction.scale(hit.distance)),
        mesh,
        distance: hit.distance,
      };
    }
  }
  return closest;
}

function pickOnHorizontalPlane(
  scene: Scene,
  camera: ArcRotateCamera,
  pointerX: number,
  pointerY: number,
  planeY: number
): Vector3 | null {
  const ray = scene.createPickingRay(pointerX, pointerY, Matrix.Identity(), camera, false);
  const plane = Plane.FromPositionAndNormal(new Vector3(0, planeY, 0), Vector3.Up());
  const dist = ray.intersectsPlane(plane);
  if (dist === null) return null;
  return ray.origin.add(ray.direction.scale(dist));
}

export function resolvePointerWorldPoint(
  scene: Scene,
  pointerX: number,
  pointerY: number,
  options: Pick<
    ShiftClickCoordOptions,
    "getCamera" | "getPickMeshes" | "getFallbackPlaneY"
  >
): { point: Vector3; meshName: string | null } | null {
  const camera = options.getCamera();
  const hit = pickWorldPoint(scene, camera, pointerX, pointerY, options.getPickMeshes());

  if (hit) {
    return { point: hit.point, meshName: hit.mesh.name };
  }

  const planeY = options.getFallbackPlaneY?.();
  if (planeY === null || planeY === undefined) return null;

  const point = pickOnHorizontalPlane(scene, camera, pointerX, pointerY, planeY);
  return point ? { point, meshName: null } : null;
}

function syncScenePointer(
  scene: Scene,
  canvas: HTMLCanvasElement,
  evt: PointerEvent
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  scene.pointerX = x;
  scene.pointerY = y;
  return { x, y };
}

export function setupShiftClickCoordinateLog(
  scene: Scene,
  canvas: HTMLCanvasElement,
  options: ShiftClickCoordOptions
): () => void {
  const handlePointerDown = (evt: PointerEvent) => {
    if (!evt.shiftKey || evt.button !== 0) return;

    const { x, y } = syncScenePointer(scene, canvas, evt);
    const resolved = resolvePointerWorldPoint(scene, x, y, options);
    if (!resolved) {
      console.warn("[pick] Shift+click — 교차점 없음 (3D 화면 중앙·collision 로드 후 재시도)");
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }

    const { point, meshName } = resolved;
    const collisionRoot = options.getCollisionRoot?.() ?? null;
    const local = collisionRoot ? worldToLocal(collisionRoot, point) : null;

    if (evt.ctrlKey) {
      console.info(`[robot] Ctrl+Shift+click ${fmtVec3(point)}`);
      void options.onCtrlShiftClick?.(point.clone(), local);
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }

    if (collisionRoot && local) {
      console.log(
        `[pick] world ${fmtVec3(point)} · collision-local ${fmtVec3(local)}` +
          (meshName ? ` · ${meshName}` : "")
      );
      console.log(
        `[pick] inject: node scripts/inject-spawn-point.mjs public/models/iob-voxel/mc-in-1f/collision.glb ${local.x.toFixed(3)} ${local.y.toFixed(3)} ${local.z.toFixed(3)}`
      );
    } else {
      console.log(`[pick] world ${fmtVec3(point)}` + (meshName ? ` · ${meshName}` : ""));
    }

    evt.preventDefault();
    evt.stopPropagation();
  };

  canvas.addEventListener("pointerdown", handlePointerDown, { capture: true });

  return () => canvas.removeEventListener("pointerdown", handlePointerDown, { capture: true });
}
