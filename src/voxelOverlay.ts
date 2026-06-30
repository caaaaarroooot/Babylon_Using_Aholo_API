import {
  AbstractMesh,
  Color3,
  Color4,
  ImportMeshAsync,
  Mesh,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";

/** Aholo voxel 면 — 거의 투명, 엣지만 선명하게 */
const VOXEL_FILL_ALPHA = 0.03;
const VOXEL_EDGE_ALPHA = 0.92;
const VOXEL_EDGE_WIDTH = 0.55;

export type VoxelOverlay = {
  root: AbstractMesh;
  meshes: AbstractMesh[];
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

export type VoxelOverlayOptions = {
  label?: string;
  color?: Color3;
  edgeWidth?: number;
  /** 매 프레임 따라갈 splat (장면 전환 시 동적) */
  resolveSplatMesh?: () => AbstractMesh | null;
  syncTransform?: (splatMesh: AbstractMesh, colliderRoot: AbstractMesh) => void;
};

function paintAholoVoxelMesh(
  mesh: AbstractMesh,
  color: Color3,
  edgeWidth: number
): void {
  const mat = new StandardMaterial(`${mesh.name}_voxelVis`, mesh.getScene());
  mat.diffuseColor = color.scale(0.5);
  mat.emissiveColor = color.scale(0.85);
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  mat.alpha = VOXEL_FILL_ALPHA;
  mat.wireframe = false;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.renderingGroupId = 2;

  if (!(mesh instanceof Mesh)) return;

  try {
    mesh.enableEdgesRendering();
    mesh.edgesWidth = edgeWidth;
    mesh.edgesColor = new Color4(color.r, color.g, color.b, VOXEL_EDGE_ALPHA);
  } catch (err) {
    console.warn(`[collision] edges failed for ${mesh.name}:`, err);
    mat.alpha = 0.08;
  }
}

function collectOverlayMeshes(colliderRoot: AbstractMesh): Mesh[] {
  const out: Mesh[] = [];
  const candidates = [colliderRoot, ...colliderRoot.getChildMeshes(true)];
  for (const node of candidates) {
    if (!(node instanceof Mesh) || node.getTotalVertices() <= 0) continue;
    if (node.name.toLowerCase().includes("spawn_point")) continue;
    out.push(node);
  }
  return out;
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

async function loadOverlayTemplate(scene: Scene, collisionGlbUrl: string) {
  console.info(`[collision] Aholo voxel wire: ${collisionGlbUrl}`);
  const loaded = await ImportMeshAsync(collisionGlbUrl, scene);
  const template = loaded.meshes[0];
  if (!template) {
    throw new Error(`collision mesh not found: ${collisionGlbUrl}`);
  }
  return template;
}

export async function attachVoxelOverlay(
  scene: Scene,
  splatMesh: AbstractMesh,
  collisionGlbUrl: string,
  options?: VoxelOverlayOptions
): Promise<VoxelOverlay> {
  const label = options?.label ?? "voxelOverlay";
  const color = options?.color ?? new Color3(0.15, 0.75, 1.0);
  const edgeWidth = options?.edgeWidth ?? VOXEL_EDGE_WIDTH;

  const template = await loadOverlayTemplate(scene, collisionGlbUrl);
  template.setEnabled(false);

  const root = template.clone(`${label}_collisionRoot`, null);
  if (!root) {
    throw new Error(`failed to clone collision template: ${collisionGlbUrl}`);
  }

  root.setEnabled(true);
  root.isVisible = true;
  scene.addMesh(root);

  const meshes = collectOverlayMeshes(root);
  if (meshes.length === 0) {
    throw new Error(`collision mesh has no geometry: ${collisionGlbUrl}`);
  }

  const vertTotal = meshes.reduce((n, m) => n + m.getTotalVertices(), 0);
  console.info(
    `[collision] Aholo voxel ${meshes.length} part(s), ${vertTotal.toLocaleString()}v:`,
    meshes.map((m) => m.name).join(", ")
  );

  for (const mesh of meshes) {
    mesh.setEnabled(true);
    mesh.isVisible = true;
    paintAholoVoxelMesh(mesh, color, edgeWidth);
  }

  const applySync = (splat: AbstractMesh) => {
    (options?.syncTransform ?? syncColliderTransform)(splat, root);
  };

  applySync(splatMesh);
  const syncObserver = scene.onBeforeRenderObservable.add(() => {
    const anchor = options?.resolveSplatMesh?.() ?? splatMesh;
    if (!anchor) return;
    applySync(anchor);
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
