import {
  AbstractMesh,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import {
  PhysicsMotionType,
  PhysicsShapeType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { HavokCollisionTracker } from "./havokCollision";
import {
  buildVoxelGridCells,
  countGeometryVertices,
} from "./voxelGridBuckets";

const OBJECT_CATEGORY = 0x1;

/** Havok MESH 콜라이더로 넣기엔 큰 메시 — 이 이상이면 그리드 프록시 사용 */
export const HAVOK_MESH_VERTEX_LIMIT = 65_535;

/**
 * 대형 voxel collision → Havok BOX 그리드로 근사 (WASM OOM 방지).
 */
export function attachVoxelGridPhysics(
  scene: Scene,
  collisionRoot: AbstractMesh,
  tracker: HavokCollisionTracker,
  options?: { cellSize?: Vector3; maxCells?: number }
): PhysicsBody {
  const cellSize = options?.cellSize ?? new Vector3(2, 0.5, 2);
  const maxCells = options?.maxCells ?? 3500;

  collisionRoot.computeWorldMatrix(true);
  const cells = buildVoxelGridCells(collisionRoot, { cellSize, maxCells });

  const anchor = new TransformNode("voxelPhysicsAnchor", scene);
  anchor.parent = collisionRoot;
  anchor.position.setAll(0);
  anchor.rotationQuaternion = null;
  anchor.rotation.setAll(0);
  anchor.scaling.setAll(1);

  collisionRoot.computeWorldMatrix(true);
  const invWorld = collisionRoot.getWorldMatrix().clone();
  invWorld.invert();

  const body = new PhysicsBody(anchor, PhysicsMotionType.STATIC, false, scene);

  const container = new PhysicsShape(
    { type: PhysicsShapeType.CONTAINER, parameters: {} },
    scene
  );

  for (const cell of cells) {
    const localCenter = Vector3.TransformCoordinates(cell.center, invWorld);

    const boxShape = new PhysicsShape(
      { type: PhysicsShapeType.BOX, parameters: { extents: cell.half } },
      scene
    );
    container.addChild(boxShape, localCenter, Quaternion.Identity());
  }

  container.filterMembershipMask = OBJECT_CATEGORY;
  container.filterCollideMask = OBJECT_CATEGORY;
  body.shape = container;
  tracker.registerBody(body, "fixed");

  console.info(
    `[physics] voxel grid proxy: ${cells.length} cells (${countGeometryVertices(collisionRoot).toLocaleString()} verts source)`
  );

  return body;
}

export function attachStaticVoxelPhysics(
  scene: Scene,
  collisionRoot: AbstractMesh,
  tracker: HavokCollisionTracker,
  attachMeshCollider: (
    root: AbstractMesh
  ) => { body: PhysicsBody }
): PhysicsBody {
  const verts = countGeometryVertices(collisionRoot);
  if (verts > HAVOK_MESH_VERTEX_LIMIT) {
    console.warn(
      `[physics] collision mesh too large (${verts.toLocaleString()} verts) — using grid proxy`
    );
    return attachVoxelGridPhysics(scene, collisionRoot, tracker);
  }
  return attachMeshCollider(collisionRoot).body;
}

export { countGeometryVertices as countCollisionVertices };
