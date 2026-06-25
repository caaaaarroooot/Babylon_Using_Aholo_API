import { Scene, Vector3, AbstractMesh, Mesh, Quaternion, PhysicsViewer } from "@babylonjs/core";
import { ProximityCastResult } from "@babylonjs/core/Physics/proximityCastResult";
import type { IPhysicsShapeProximityCastQuery } from "@babylonjs/core/Physics/physicsShapeProximityCastQuery";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import {
  PhysicsMotionType,
  PhysicsShapeType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";
import type { CollisionHit } from "./collisionDemo";

const OBJECT_CATEGORY = 0x1;

export type EntityId = "fixed" | "movable";

export type PartPhysicsMeta = {
  entityId: EntityId;
};

/**
 * Havok Physics V2 충돌 추적.
 *
 * 1) shapeProximity(maxDistance=0) — Havok 공식 overlap 쿼리 (매 프레임 판정에 사용)
 * 2) getCollisionObservable — 접촉 시작/종료 이벤트 (보조)
 */
export class HavokCollisionTracker {
  private fixedBody?: PhysicsBody;
  private movableBody?: PhysicsBody;
  private readonly proximityInput = new ProximityCastResult();
  private readonly proximityHit = new ProximityCastResult();

  registerBody(body: PhysicsBody, entityId: EntityId) {
    if (entityId === "fixed") this.fixedBody = body;
    else this.movableBody = body;

    body.setCollisionCallbackEnabled(true);
    body.setCollisionEndedCallbackEnabled(true);
  }

  private queryOverlap(probe: PhysicsBody, target: PhysicsBody): boolean {
    const shape = probe.shape;
    if (!shape) return false;

    const scene = probe.transformNode.getScene();
    const plugin = scene?.getPhysicsEngine()?.getPhysicsPlugin();
    if (!plugin || typeof (plugin as HavokPlugin).shapeProximity !== "function") {
      return false;
    }

    const bodyPos = new Vector3();
    const bodyRot = new Quaternion();

    probe.getObjectCenterWorldToRef(bodyPos);
    if (probe.transformNode.absoluteRotationQuaternion) {
      bodyRot.copyFrom(probe.transformNode.absoluteRotationQuaternion);
    } else {
      Quaternion.FromRotationMatrixToRef(probe.transformNode.getWorldMatrix(), bodyRot);
    }

    const query: IPhysicsShapeProximityCastQuery = {
      shape,
      position: bodyPos,
      rotation: bodyRot,
      maxDistance: 0,
      shouldHitTriggers: false,
      ignoreBody: probe,
    };

    this.proximityInput.reset();
    this.proximityHit.reset();
    (plugin as HavokPlugin).shapeProximity(query, this.proximityInput, this.proximityHit);

    return this.proximityHit.hasHit && this.proximityHit.body === target;
  }

  toHit(): CollisionHit {
    if (!this.fixedBody || !this.movableBody) {
      return { intersects: false };
    }

    const intersects =
      this.queryOverlap(this.movableBody, this.fixedBody) ||
      this.queryOverlap(this.fixedBody, this.movableBody);

    return { intersects };
  }
}

export async function enableHavokPhysics(scene: Scene): Promise<void> {
  const havok = await HavokPhysics({
    locateFile: () => havokWasmUrl,
  });
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(Vector3.Zero(), plugin);
  scene.getPhysicsEngine()?.setTimeStep(1 / 60);
}

export function attachHavokCollider(
  scene: Scene,
  colliderRoot: AbstractMesh,
  kinematic: boolean,
  _meta: PartPhysicsMeta,
  tracker: HavokCollisionTracker,
  physicsViewer?: PhysicsViewer,
  showPhysicsDebug = false
): { body: PhysicsBody; debugMesh: AbstractMesh | null } {
  const root = colliderRoot as Mesh;
  root.computeWorldMatrix(true);

  const motionType = kinematic
    ? PhysicsMotionType.ANIMATED
    : PhysicsMotionType.STATIC;

  const body = new PhysicsBody(root, motionType, false, scene);
  body.disablePreStep = kinematic;

  const containerShape = new PhysicsShape(
    {
      type: PhysicsShapeType.CONTAINER,
      parameters: {},
    },
    scene
  );

  const childMeshes = root.getChildMeshes(false);
  const targetMeshes = childMeshes.length > 0 ? childMeshes : [root];

  for (const child of targetMeshes) {
    if (!(child instanceof Mesh)) continue;

    child.computeWorldMatrix(true);
    const localPos = child.position.clone();
    const localRot = child.rotationQuaternion
      ? child.rotationQuaternion.clone()
      : Quaternion.FromEulerVector(child.rotation);

    const shapeType = kinematic
      ? PhysicsShapeType.CONVEX_HULL
      : PhysicsShapeType.MESH;

    const childShape = new PhysicsShape(
      {
        type: shapeType,
        parameters: { mesh: child },
      },
      scene
    );
    containerShape.addChild(childShape, localPos, localRot);
  }

  containerShape.filterMembershipMask = OBJECT_CATEGORY;
  containerShape.filterCollideMask = OBJECT_CATEGORY;
  body.shape = containerShape;

  tracker.registerBody(body, _meta.entityId);

  let debugMesh: AbstractMesh | null = null;
  if (showPhysicsDebug && physicsViewer) {
    debugMesh = physicsViewer.showBody(body);
    if (debugMesh) {
      debugMesh.renderingGroupId = 2;
    }
  }

  return { body, debugMesh };
}
