import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { Scene } from "@babylonjs/core/scene";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";

export const LAYER_LOD = 0x1;
export const LAYER_DIRECT = 0x2;
/** 화면 분할 시 좌·우 모두에 표시 */
export const LAYER_SPLIT_BOTH = LAYER_LOD | LAYER_DIRECT;
export const LAYER_ALL = 0xffffffff;

export function syncArcRotateCamera(source: ArcRotateCamera, target: ArcRotateCamera): void {
  target.alpha = source.alpha;
  target.beta = source.beta;
  target.radius = source.radius;
  target.target.copyFrom(source.target);
  target.minZ = source.minZ;
  target.maxZ = source.maxZ;
  target.fov = source.fov;
}

export function setMeshRenderLayer(mesh: AbstractMesh, layer: number): void {
  mesh.layerMask = layer;
  for (const child of mesh.getChildMeshes(false)) {
    setMeshRenderLayer(child, layer);
  }
}

export function enableSplitView(
  scene: Scene,
  primary: ArcRotateCamera,
  secondary: ArcRotateCamera
): void {
  primary.viewport = new Viewport(0, 0, 0.5, 1);
  secondary.viewport = new Viewport(0.5, 0, 0.5, 1);
  primary.layerMask = LAYER_LOD;
  secondary.layerMask = LAYER_DIRECT;
  scene.activeCameras = [primary, secondary];
}

export function disableSplitView(scene: Scene, primary: ArcRotateCamera): void {
  primary.viewport = new Viewport(0, 0, 1, 1);
  primary.layerMask = LAYER_ALL;
  scene.activeCameras = [primary];
}

export function createSyncedCamera(
  name: string,
  primary: ArcRotateCamera,
  scene: Scene
): ArcRotateCamera {
  const secondary = new ArcRotateCamera(
    name,
    primary.alpha,
    primary.beta,
    primary.radius,
    primary.target.clone(),
    scene
  );
  secondary.wheelPrecision = primary.wheelPrecision;
  secondary.minZ = primary.minZ;
  secondary.maxZ = primary.maxZ;
  secondary.lowerRadiusLimit = primary.lowerRadiusLimit;
  secondary.upperRadiusLimit = primary.upperRadiusLimit;
  secondary.inputs.clear();
  syncArcRotateCamera(primary, secondary);
  return secondary;
}
