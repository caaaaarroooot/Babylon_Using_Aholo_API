import {
  AbstractMesh,
  Color3,
  Color4,
  ImportMeshAsync,
  Mesh,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";

/** 면은 거의 투명, 선만 보이게 */
const AHOLO_FILL_ALPHA = 0.04;
const AHOLO_FILL_ALPHA_NO_EDGES = 0.12;
const AHOLO_EDGE_ALPHA = 0.9;
const AHOLO_EDGE_WIDTH = 0.45;
const MAX_VERTICES_FOR_EDGES = 80_000;

export type VoxelOverlay = {
  root: AbstractMesh;
  meshes: AbstractMesh[];
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

function paintCollisionMesh(
  mesh: AbstractMesh,
  color: Color3,
  edgeWidth: number
): boolean {
  const mat = new StandardMaterial(`${mesh.name}_collisionVis`, mesh.getScene());
  mat.diffuseColor = color.scale(0.55);
  mat.emissiveColor = color.scale(0.75);
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.renderingGroupId = 2;

  let hasEdges = false;
  if (mesh instanceof Mesh && mesh.getTotalVertices() <= MAX_VERTICES_FOR_EDGES) {
    try {
      mesh.enableEdgesRendering();
      mesh.edgesWidth = edgeWidth;
      mesh.edgesColor = new Color4(color.r, color.g, color.b, AHOLO_EDGE_ALPHA);
      hasEdges = true;
    } catch (err) {
      console.warn(`[collision] edges skipped for ${mesh.name}:`, err);
    }
  }

  mat.alpha = hasEdges ? AHOLO_FILL_ALPHA : AHOLO_FILL_ALPHA_NO_EDGES;
  return hasEdges;
}

function collectColliderMeshes(colliderRoot: AbstractMesh): AbstractMesh[] {
  const meshes = colliderRoot.getChildMeshes(false);
  if (meshes.length === 0 && colliderRoot.getTotalVertices() > 0) {
    meshes.push(colliderRoot);
  }
  return meshes;
}

function syncColliderTransform(splatMesh: AbstractMesh, colliderRoot: AbstractMesh) {
  splatMesh.computeWorldMatrix(true);
  colliderRoot.position.copyFrom(splatMesh.absolutePosition);
  colliderRoot.scaling.copyFrom(splatMesh.scaling);
  if (splatMesh.rotationQuaternion) {
    colliderRoot.rotationQuaternion = splatMesh.rotationQuaternion.clone();
  } else {
    colliderRoot.rotationQuaternion = null;
    colliderRoot.rotation.copyFrom(splatMesh.rotation);
  }
}

export async function attachVoxelOverlay(
  scene: Scene,
  splatMesh: AbstractMesh,
  collisionGlbUrl: string,
  options?: { label?: string; color?: Color3; edgeWidth?: number }
): Promise<VoxelOverlay> {
  const label = options?.label ?? "voxelOverlay";
  const color = options?.color ?? new Color3(0.15, 0.75, 1.0);
  const edgeWidth = options?.edgeWidth ?? AHOLO_EDGE_WIDTH;

  const loaded = await ImportMeshAsync(collisionGlbUrl, scene);
  const template = loaded.meshes[0];
  if (!template) {
    throw new Error(`collision mesh not found: ${collisionGlbUrl}`);
  }
  template.setEnabled(false);

  const root = template.clone(`${label}_collisionRoot`, null);
  if (!root) {
    throw new Error(`failed to clone collision template: ${collisionGlbUrl}`);
  }

  root.setEnabled(true);
  root.isVisible = true;
  scene.addMesh(root);

  const meshes = collectColliderMeshes(root);
  if (meshes.length === 0) {
    throw new Error(`collision mesh has no geometry: ${collisionGlbUrl}`);
  }

  console.info(
    `[collision] ${meshes.length} part(s):`,
    meshes.map((m) => `${m.name}(${m.getTotalVertices().toLocaleString()}v)`).join(", ")
  );

  for (const mesh of meshes) {
    mesh.setEnabled(true);
    mesh.isVisible = true;
    const hasEdges = paintCollisionMesh(mesh, color, edgeWidth);
    if (!hasEdges) {
      console.warn(
        `[collision] ${mesh.name}: 엣지 생략 (${mesh.getTotalVertices().toLocaleString()}v) — collision.glb 재생성 권장`
      );
    }
  }

  syncColliderTransform(splatMesh, root);
  const syncObserver = scene.onBeforeRenderObservable.add(() => {
    syncColliderTransform(splatMesh, root);
  });

  return {
    root,
    meshes,
    setVisible(visible: boolean) {
      root.isVisible = visible;
      for (const mesh of meshes) {
        mesh.isVisible = visible;
      }
    },
    dispose() {
      scene.onBeforeRenderObservable.remove(syncObserver);
      root.dispose(false, true);
    },
  };
}
