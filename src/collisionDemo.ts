import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  Mesh,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { attachHavokCollider, HavokCollisionTracker } from "./havokCollision";

/** 고정=Aholo voxel mesh, 이동=physics convex hull wireframe */
export type ColliderVisualMode = "aholo-voxel" | "convex-hull";

const AHOLO_VOXEL_ALPHA = 0.28;
const CONVEX_HULL_ALPHA = 0.45;
const AHOLO_EDGE_ALPHA = 0.85;

export type ColliderPart = {
  colliderRoot: AbstractMesh;
  colliders: AbstractMesh[];
  baseColor: Color3;
  visualMode: ColliderVisualMode;
  physicsBodies: import("@babylonjs/core/Physics/v2/physicsBody").PhysicsBody[];
  physicsDebugMesh?: AbstractMesh | null;
};

/** splat 1개 + Aholo 통합 collision mesh 1개 */
export type ObjectEntity = {
  name: string;
  mesh: AbstractMesh;
  collider: ColliderPart;
};

export type CollisionHit = {
  intersects: boolean;
};

export function hasCollision(hit: CollisionHit): boolean {
  return hit.intersects;
}

export type CollisionScene = {
  fixed: ObjectEntity;
  movable: ObjectEntity;
};

export type CollisionMessage = {
  title: string;
  detail: string;
};

export function formatCollisionMessage(hit: CollisionHit): CollisionMessage {
  if (!hit.intersects) {
    return {
      title: "충돌 없음",
      detail: "WASD: 수평 이동 · Q/E: 수직 이동(하강/상승).",
    };
  }

  return {
    title: "충돌 감지",
    detail: "이동 객체(주황) ↔ 고정 객체(하늘) — Havok shapeProximity overlap",
  };
}

/** Aholo collision template의 로컬 AABB (고정 객체를 원점에 둘 때 기준). */
export function getColliderLocalBounds(mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true);
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  return { min: min.clone(), max: max.clone() };
}

/**
 * 고정(원점)과 이동 객체를 나란히 둘 때, X축 겹침이 없도록 이동 객체 중심 X를 계산한다.
 * voxel mesh는 splat보다 넓고 비대칭이라 고정 간격(예: 3.5)만으로는 시작부터 overlap이 난다.
 */
export function computeSideBySideOffsetX(
  collisionTemplate: AbstractMesh,
  movableScale: number,
  gap = 0.35,
  /** 이동 쪽 CONVEX_HULL이 mesh AABB보다 약간 큼 */
  convexHullMargin = 0.3
): number {
  const { min, max } = getColliderLocalBounds(collisionTemplate);
  return max.x + gap + convexHullMargin - min.x * movableScale;
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

function paintAholoMesh(collider: AbstractMesh, color: Color3, alpha = AHOLO_VOXEL_ALPHA) {
  const mat = new StandardMaterial(`${collider.name}_aholoVis`, collider.getScene());
  mat.diffuseColor = color.scale(0.55);
  mat.emissiveColor = color.scale(0.75);
  mat.alpha = alpha;
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  collider.material = mat;
  collider.isPickable = false;
  collider.renderingGroupId = 2;
  if (collider instanceof Mesh) {
    collider.enableEdgesRendering();
    collider.edgesWidth = 2.5;
    collider.edgesColor = new Color4(color.r, color.g, color.b, AHOLO_EDGE_ALPHA);
  }
}

function tintPhysicsDebugMesh(mesh: AbstractMesh | null | undefined, color: Color3) {
  if (!mesh?.material) return;
  const mat = mesh.material as StandardMaterial;
  mat.emissiveColor = color.scale(0.9);
  mat.diffuseColor = color.scale(0.7);
  mat.alpha = CONVEX_HULL_ALPHA;
  mat.disableDepthWrite = true;
  mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
}

function setPartColor(part: ColliderPart, color: Color3) {
  if (part.visualMode === "aholo-voxel") {
    for (const c of part.colliders) {
      const mat = c.material as StandardMaterial;
      mat.diffuseColor = color;
      mat.emissiveColor = color;
      if (c instanceof Mesh) {
        c.edgesColor = new Color4(color.r, color.g, color.b, AHOLO_EDGE_ALPHA);
      }
    }
    return;
  }
  tintPhysicsDebugMesh(part.physicsDebugMesh, color);
}

function setColliderPartVisible(part: ColliderPart, visible: boolean) {
  if (part.visualMode === "aholo-voxel") {
    for (const c of part.colliders) {
      c.isVisible = visible;
      if (c instanceof Mesh) {
        if (visible) {
          c.enableEdgesRendering();
          c.edgesWidth = 2.5;
        } else {
          c.disableEdgesRendering();
        }
      }
    }
    return;
  }
  if (part.physicsDebugMesh) {
    part.physicsDebugMesh.isVisible = visible;
  }
}

export function setupColliderVisibilityControls(
  collisionScene: CollisionScene,
  fixedCheckbox: HTMLInputElement,
  movableCheckbox: HTMLInputElement
) {
  const apply = () => {
    setColliderPartVisible(collisionScene.fixed.collider, fixedCheckbox.checked);
    setColliderPartVisible(collisionScene.movable.collider, movableCheckbox.checked);
  };

  fixedCheckbox.addEventListener("change", apply);
  movableCheckbox.addEventListener("change", apply);
  apply();
}

function attachCollider(
  scene: Scene,
  splatMesh: AbstractMesh,
  templateRoot: AbstractMesh,
  label: string,
  color: Color3,
  entityId: "fixed" | "movable",
  kinematic: boolean,
  visualMode: ColliderVisualMode,
  tracker: HavokCollisionTracker,
  physicsViewer?: PhysicsViewer
): ColliderPart {
  const colliderRoot = templateRoot.clone(`${label}_aholoRoot`, null);
  if (!colliderRoot) {
    throw new Error(`Failed to clone collider template for ${label}`);
  }
  colliderRoot.setEnabled(true);
  scene.addMesh(colliderRoot);

  const colliders: AbstractMesh[] = colliderRoot.getChildMeshes(false);
  if (colliders.length === 0 && colliderRoot.getTotalVertices() > 0) {
    colliders.push(colliderRoot as Mesh);
  }
  const showAholo = visualMode === "aholo-voxel";
  for (const collider of colliders) {
    collider.setEnabled(true);
    if (showAholo) {
      paintAholoMesh(collider, color);
    } else {
      collider.isVisible = false;
    }
  }

  syncColliderTransform(splatMesh, colliderRoot);
  colliderRoot.computeWorldMatrix(true);

  const { body, debugMesh } = attachHavokCollider(
    scene,
    colliderRoot,
    kinematic,
    { entityId },
    tracker,
    physicsViewer,
    visualMode === "convex-hull"
  );
  if (debugMesh) {
    tintPhysicsDebugMesh(debugMesh, color);
  }

  return {
    colliderRoot,
    colliders,
    baseColor: color.clone(),
    visualMode,
    physicsBodies: [body],
    physicsDebugMesh: debugMesh,
  };
}

export function attachObjectEntity(
  scene: Scene,
  splatMesh: AbstractMesh,
  collisionTemplate: AbstractMesh,
  name: string,
  color: Color3,
  entityId: "fixed" | "movable",
  tracker: HavokCollisionTracker,
  physicsViewer?: PhysicsViewer
): ObjectEntity {
  const visualMode: ColliderVisualMode =
    entityId === "fixed" ? "aholo-voxel" : "convex-hull";

  return {
    name,
    mesh: splatMesh,
    collider: attachCollider(
      scene,
      splatMesh,
      collisionTemplate,
      name,
      color,
      entityId,
      entityId === "movable",
      visualMode,
      tracker,
      physicsViewer
    ),
  };
}

function syncEntity(entity: ObjectEntity) {
  syncColliderTransform(entity.mesh, entity.collider.colliderRoot);
  const root = entity.collider.colliderRoot;
  root.computeWorldMatrix(true);

  const rotation =
    root.absoluteRotationQuaternion ?? Quaternion.FromRotationMatrix(root.getWorldMatrix());

  for (const body of entity.collider.physicsBodies) {
    if (body.getMotionType() === PhysicsMotionType.ANIMATED) {
      body.setTargetTransform(root.absolutePosition, rotation);
    }
  }
}

function applyCollisionVisual(collisionScene: CollisionScene, hit: CollisionHit) {
  const warn = new Color3(1, 0.2, 0.2);

  setPartColor(
    collisionScene.fixed.collider,
    hit.intersects ? warn : collisionScene.fixed.collider.baseColor
  );
  setPartColor(
    collisionScene.movable.collider,
    hit.intersects ? warn : collisionScene.movable.collider.baseColor
  );
}

export function setupWasdCollisionDemo(
  scene: Scene,
  camera: ArcRotateCamera,
  canvas: HTMLCanvasElement,
  collisionScene: CollisionScene,
  tracker: HavokCollisionTracker,
  onCollisionChange: (hit: CollisionHit, message: CollisionMessage) => void
) {
  const keys = new Set<string>();
  canvas.tabIndex = 0;

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (["w", "a", "s", "d", "q", "e"].includes(key)) {
      keys.add(key);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("click", () => canvas.focus());

  let lastHit: CollisionHit = { intersects: false };

  const emit = (hit: CollisionHit) => {
    onCollisionChange(hit, formatCollisionMessage(hit));
  };

  const initialHit = tracker.toHit();
  applyCollisionVisual(collisionScene, initialHit);
  emit(initialHit);

  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();
  const step = new Vector3();

  const observer = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const speed = 2.2 * dt;

    camera.getDirectionToRef(Vector3.Forward(), forward);
    forward.y = 0;
    if (forward.lengthSquared() > 0) forward.normalize();

    camera.getDirectionToRef(Vector3.Right(), right);
    right.y = 0;
    if (right.lengthSquared() > 0) right.normalize();

    move.setAll(0);
    if (keys.has("w")) {
      step.copyFrom(forward).scaleInPlace(speed);
      move.addInPlace(step);
    }
    if (keys.has("s")) {
      step.copyFrom(forward).scaleInPlace(-speed);
      move.addInPlace(step);
    }
    if (keys.has("d")) {
      step.copyFrom(right).scaleInPlace(speed);
      move.addInPlace(step);
    }
    if (keys.has("a")) {
      step.copyFrom(right).scaleInPlace(-speed);
      move.addInPlace(step);
    }
    if (keys.has("e")) {
      move.y += speed;
    }
    if (keys.has("q")) {
      move.y -= speed;
    }

    if (move.lengthSquared() > 0) {
      collisionScene.movable.mesh.position.addInPlace(move);
    }

    syncEntity(collisionScene.fixed);
    syncEntity(collisionScene.movable);
  });

  const afterObserver = scene.onAfterRenderObservable.add(() => {
    const hit = tracker.toHit();
    if (hit.intersects !== lastHit.intersects) {
      lastHit = hit;
      applyCollisionVisual(collisionScene, hit);
      emit(hit);
    }
  });

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    scene.onAfterRenderObservable.remove(afterObserver);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

/*
 * ── 이전: 해골 / 받침대 Y축 분리 충돌 (비활성) ─────────────────────────────
 *
 * export type SkullEntity = {
 *   name: string;
 *   mesh: AbstractMesh;
 *   skull: ColliderPart;   // skull-part-voxel/collision.glb
 *   ground: ColliderPart;  // ground-voxel/collision.glb
 * };
 *
 * export type CollisionHit = {
 *   skullSkull: boolean;
 *   movableSkullFixedGround: boolean;
 *   fixedSkullMovableGround: boolean;
 * };
 *
 * function crossSkullGround(skull, ground) { ... XZ 발자국 + mesh 교차 ... }
 *
 * export function evaluateCollisions(scene) {
 *   return {
 *     skullSkull: partsIntersect(fixed.skull, movable.skull),
 *     movableSkullFixedGround: crossSkullGround(movable.skull, fixed.ground),
 *     fixedSkullMovableGround: crossSkullGround(fixed.skull, movable.ground),
 *   };
 * }
 *
 * 전처리: scripts/build-skulls.mjs 의 SPLIT_Y 밴드로 skull/ground voxel 분리
 * ───────────────────────────────────────────────────────────────────────────
 */
