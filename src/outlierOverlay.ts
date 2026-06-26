import { AbstractMesh, ImportMeshAsync, Scene } from "@babylonjs/core";

const SPLAT_LOAD_OPTIONS = {
  pluginOptions: { splat: { flipY: true } },
};

export type OutlierOverlay = {
  mesh: AbstractMesh;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

function syncOverlayTransform(splatMesh: AbstractMesh, outlierMesh: AbstractMesh) {
  splatMesh.computeWorldMatrix(true);
  outlierMesh.position.copyFrom(splatMesh.absolutePosition);
  outlierMesh.scaling.copyFrom(splatMesh.scaling);
  if (splatMesh.rotationQuaternion) {
    outlierMesh.rotationQuaternion = splatMesh.rotationQuaternion.clone();
  } else {
    outlierMesh.rotationQuaternion = null;
    outlierMesh.rotation.copyFrom(splatMesh.rotation);
  }
}

export async function attachOutlierSplatOverlay(
  scene: Scene,
  splatMesh: AbstractMesh,
  outlierSpzUrl: string
): Promise<OutlierOverlay> {
  const result = await ImportMeshAsync(outlierSpzUrl, scene, SPLAT_LOAD_OPTIONS);
  const mesh = result.meshes[0];
  if (!mesh) {
    throw new Error(`outlier splat not found: ${outlierSpzUrl}`);
  }

  mesh.name = "warehouseOutliers";
  mesh.renderingGroupId = 3;
  syncOverlayTransform(splatMesh, mesh);

  const syncObserver = scene.onBeforeRenderObservable.add(() => {
    syncOverlayTransform(splatMesh, mesh);
  });

  return {
    mesh,
    setVisible(visible: boolean) {
      mesh.isVisible = visible;
    },
    dispose() {
      scene.onBeforeRenderObservable.remove(syncObserver);
      mesh.dispose(false, true);
    },
  };
}
