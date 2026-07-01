import {
  AbstractMesh,
  ArcRotateCamera,
  ImportMeshAsync,
  Mesh,
  MeshBuilder,
  Node,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import {
  attachHavokCollider,
  enableHavokPhysics,
  HavokCollisionTracker,
} from "./havokCollision";
import { attachStaticVoxelPhysics } from "./voxelPhysicsProxy";
import { MC_IN_1F_INTERIOR } from "./mcIn1FInterior";
import {
  resolveRobotFloorYAt,
  resolveSpawnOnVoxelFloor,
  type VoxelSpawnResult,
} from "./voxelSpawn";
import {
  buildRobotWallGrid,
  isIntentInBlockedHemisphere,
  isRobotWallBlockedAt,
  normalizeIntentXZ,
//   type RobotWallGrid,
} from "./robotWallCollision";

const HUSKY_URL = "/models/iob/husky_comp_2.glb";
/** GLB 루트에 이미 scale 0.001 적용됨 — 추가 mm 변환 금지 */
const HUSKY_VISUAL_SCALE = 1.0;
const HUSKY_VISUAL_Y_OFFSET = -0.1;
/** hull 바닥과 voxel 바닥 사이 간격 — 0이면 바닥 voxel과 항상 overlap → 전방향 이동 불가 */
const HULL_FLOOR_CLEARANCE = 0.05;
const DEFAULTS_EYE = 1.45;
/** 건물 AABB 기준 radius(0.12×span)는 0.6m까지 줄어 카메라가 로봇 안에 박힘 */
const ROBOT_CAMERA_RADIUS = 4.5;
const ROBOT_CAMERA_RADIUS_MIN = 1.8;
const ROBOT_CAMERA_RADIUS_MAX = 14;
const ROBOT_CAMERA_BETA = 1.12;
/** 기본 로봇 발 위치 (월드 좌표) */
export const DEFAULT_ROBOT_FOOT_WORLD = new Vector3(-10.18, 7.97, 15.52);
/** collision.glb spawn_point fallback (inject-spawn-point.mjs 와 동기화) */
const FALLBACK_SPAWN_LOCAL = DEFAULT_ROBOT_FOOT_WORLD.clone();
const MOVE_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
const LOOK_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright"]);
const VERTICAL_SPEED_SCALE = 0.85;
const ROBOT_TURN_SPEED = 1.8;
const HEMISPHERE_DOT_THRESHOLD = 0.02;
/** Husky/축 기준 — 좌(A방향)가 W 전진이 되도록 90° 보정 */
const ROBOT_MOVE_HEADING_OFFSET = -Math.PI / 2;

export type RobotMcIn1FSession = {
  dispose(): void;
};

type CreateRobotSessionOptions = {
  scene: Scene;
  camera: ArcRotateCamera;
  canvas: HTMLCanvasElement;
  splatMesh: AbstractMesh;
  collisionGlbUrl: string;
  /** 월드 XZ(+Y 힌트) — 로봇 하단 중앙(발) 기준점 */
  spawnFootWorld?: Vector3;
  /** 텔레포트 시 현재 시점(각도·거리) 유지 */
  cameraFollow?: { alpha: number; beta: number; radius: number };
  onStatus?: (blocked: boolean) => void;
};

function robotForwardFromHeading(heading: number, out: Vector3): void {
  out.set(Math.sin(heading), 0, Math.cos(heading));
}

function robotRightFromHeading(heading: number, out: Vector3): void {
  out.set(Math.cos(heading), 0, -Math.sin(heading));
}

function syncToSplat(splatMesh: AbstractMesh, node: AbstractMesh) {
  splatMesh.computeWorldMatrix(true);
  node.position.copyFrom(splatMesh.absolutePosition);
  node.scaling.copyFrom(splatMesh.scaling);
  if (splatMesh.rotationQuaternion) {
    node.rotationQuaternion = splatMesh.rotationQuaternion.clone();
  } else {
    node.rotationQuaternion = null;
    node.rotation.copyFrom(splatMesh.rotation);
  }
}

function syncPhysicsBody(root: TransformNode, body: PhysicsBody) {
  root.computeWorldMatrix(true);
  const rotation =
    root.absoluteRotationQuaternion ?? Quaternion.FromRotationMatrix(root.getWorldMatrix());
  body.setTargetTransform(root.absolutePosition, rotation);
}

function getWorldBounds(mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true);
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
  return { min, max };
}

type CollisionTemplate = {
  template: AbstractMesh;
  /** collision_mesh 기준 spawn_point 로컬 좌표 (clone 전에 추출) */
  spawnLocal: Vector3 | null;
};

function isSpawnPointName(name: string): boolean {
  return name.toLowerCase().includes("spawn_point");
}

function findSpawnPointNode(
  loaded: ISceneLoaderAsyncResult,
  root: AbstractMesh
): TransformNode | null {
  for (const node of loaded.transformNodes ?? []) {
    if (isSpawnPointName(node.name)) return node;
  }

  for (const node of root.getChildTransformNodes(true)) {
    if (isSpawnPointName(node.name)) return node;
  }

  const stack: Node[] = [...root.getChildren()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isSpawnPointName(node.name) && node instanceof TransformNode) {
      return node;
    }
    stack.push(...node.getChildren());
  }

  return null;
}

async function loadCollisionTemplate(scene: Scene, url: string): Promise<CollisionTemplate> {
  const loaded = await ImportMeshAsync(url, scene);
  const template = loaded.meshes[0];
  if (!template) {
    throw new Error(`collision template not found: ${url}`);
  }

  const spawnNode = findSpawnPointNode(loaded, template);
  const spawnLocal = spawnNode?.position.clone() ?? FALLBACK_SPAWN_LOCAL.clone();
  if (!spawnNode) {
    console.warn(
      `[robot] spawn_point 노드 없음 — GLB 기본 로컬 좌표 사용 (${spawnLocal.toString()})`
    );
  } else {
    console.info(`[robot] spawn_point 로컬 좌표: ${spawnLocal.toString()}`);
  }

  template.setEnabled(false);
  return { template, spawnLocal };
}

function attachStaticVoxelBody(
  scene: Scene,
  splatMesh: AbstractMesh,
  collision: CollisionTemplate,
  tracker: HavokCollisionTracker
): { root: AbstractMesh; body: PhysicsBody } {
  const { template } = collision;
  const root = template.clone("mcIn1F_physicsVoxel", null);
  if (!root) {
    throw new Error("failed to clone voxel physics template");
  }
  root.setEnabled(true);
  root.isVisible = false;
  scene.addMesh(root);

  for (const child of root.getChildMeshes(false)) {
    child.isVisible = false;
    child.isPickable = false;
  }

  syncToSplat(splatMesh, root);
  root.computeWorldMatrix(true);

  const body = attachStaticVoxelPhysics(scene, root, tracker, (physicsRoot) =>
    attachHavokCollider(scene, physicsRoot as Mesh, false, { entityId: "fixed" }, tracker)
  );
  return { root, body };
}

function attachRobotHull(
  scene: Scene,
  robotRoot: TransformNode,
  tracker: HavokCollisionTracker
): { body: PhysicsBody; hull: Mesh } {
  const hull = MeshBuilder.CreateBox(
    "robotHull",
    { width: 0.58, height: 0.32, depth: 0.82 },
    scene
  );
  hull.parent = robotRoot;
  // robotRoot = 하단 중앙(발) — hull 중심을 높이의 절반에 둠
  hull.position.y = 0.16;
  hull.isVisible = false;
  hull.isPickable = false;

  const { body } = attachHavokCollider(scene, hull, true, { entityId: "movable" }, tracker);
  return { body, hull };
}

function getRobotFootWorldY(robotRoot: TransformNode): number {
  return robotRoot.position.y;
}

function setRobotFootOnFloor(robotRoot: TransformNode, floorY: number): void {
  robotRoot.position.y = floorY + HULL_FLOOR_CLEARANCE;
}

function snapCameraToRobotFollow(
  camera: ArcRotateCamera,
  robotX: number,
  robotZ: number,
  eyeY: number,
  follow?: { alpha: number; beta: number; radius: number }
): void {
  if (follow) {
    camera.alpha = follow.alpha;
    camera.beta = follow.beta;
    camera.radius = follow.radius;
  } else {
    camera.alpha = MC_IN_1F_INTERIOR.alpha;
    camera.beta = ROBOT_CAMERA_BETA;
    camera.radius = ROBOT_CAMERA_RADIUS;
  }
  camera.lowerRadiusLimit = ROBOT_CAMERA_RADIUS_MIN;
  camera.upperRadiusLimit = ROBOT_CAMERA_RADIUS_MAX;
  camera.setTarget(new Vector3(robotX, eyeY, robotZ));
  camera.panningSensibility = 0;
}

function resolveSpawnAtFoot(
  staticVoxelRoot: AbstractMesh,
  footWorld: Vector3
): VoxelSpawnResult | null {
  const floorY = resolveRobotFloorYAt(
    staticVoxelRoot,
    footWorld.x,
    footWorld.z,
    footWorld.y
  );
  if (floorY === null) {
    console.warn(
      `[robot] Ctrl+Shift spawn — floor sample 없음 (${footWorld.x.toFixed(2)}, ${footWorld.z.toFixed(2)})`
    );
    return null;
  }

  const footY = floorY + HULL_FLOOR_CLEARANCE;
  console.info(
    `[robot] foot spawn → world (${footWorld.x.toFixed(2)}, ${footY.toFixed(2)}, ${footWorld.z.toFixed(2)})`
  );
  return {
    position: new Vector3(footWorld.x, footY, footWorld.z),
    floorY,
    eyeY: floorY + DEFAULTS_EYE,
    hitCount: 1,
    cellCount: 1,
  };
}

async function loadHusky(scene: Scene, robotRoot: TransformNode): Promise<AbstractMesh> {
  const result = await ImportMeshAsync(HUSKY_URL, scene);
  const huskyModel = result.meshes[0];
  if (!huskyModel) {
    throw new Error(`Husky model not found: ${HUSKY_URL}`);
  }

  huskyModel.parent = robotRoot;
  huskyModel.name = "huskyModel";
  huskyModel.position.y = HUSKY_VISUAL_Y_OFFSET;
  for (const mesh of result.meshes) {
    mesh.isPickable = false;
  }

  if (HUSKY_VISUAL_SCALE !== 1) {
    huskyModel.scaling.scaleInPlace(HUSKY_VISUAL_SCALE);
  }

  return huskyModel;
}

function findSpawnPointInCollision(root: AbstractMesh): TransformNode | null {
  const nodes = root.getChildTransformNodes(true);
  const hit = nodes.find((n) => n.name.toLowerCase().includes("spawn_point"));
  if (hit) return hit;
  if (root.name.toLowerCase().includes("spawn_point")) {
    return root as TransformNode;
  }
  return null;
}

function resolveRobotSpawn(
  staticVoxelRoot: AbstractMesh,
  spawnLocal: Vector3 | null,
  min: Vector3,
  max: Vector3,
  extent: Vector3
): VoxelSpawnResult {
  const resolveFromWorldCandidate = (
    world: Vector3,
    sourceLabel: string,
    hintLocalY?: number
  ): VoxelSpawnResult | null => {
    const x = world.x;
    const z = world.z;
    const floorY = resolveRobotFloorYAt(staticVoxelRoot, x, z, hintLocalY);
    if (floorY === null) {
      console.warn(
        `[robot] ${sourceLabel} 좌표에 floor sample 없음 — densest-floor fallback 사용`
      );
      return null;
    }
    console.info(
      `[robot] ${sourceLabel} → world (${x.toFixed(2)}, ${floorY.toFixed(2)}, ${z.toFixed(2)})`
    );
    return {
      position: new Vector3(x, floorY + HULL_FLOOR_CLEARANCE, z),
      floorY,
      eyeY: floorY + DEFAULTS_EYE,
      hitCount: 1,
      cellCount: 1,
    };
  };

  if (spawnLocal) {
    staticVoxelRoot.computeWorldMatrix(true);
    const world = Vector3.TransformCoordinates(spawnLocal, staticVoxelRoot.getWorldMatrix());
    const fromLocal = resolveFromWorldCandidate(world, "GLB spawn_point(local)", spawnLocal.y);
    if (fromLocal) return fromLocal;
  }

  const spawnPointNode = findSpawnPointInCollision(staticVoxelRoot);

  if (spawnPointNode) {
    spawnPointNode.computeWorldMatrix(true);
    const custom = spawnPointNode.absolutePosition;
    const fromNode = resolveFromWorldCandidate(custom, `GLB spawn_point(node:${spawnPointNode.name})`);
    if (fromNode) return fromNode;
  }

  return (
    resolveSpawnOnVoxelFloor(staticVoxelRoot, { mode: "densest-floor" }) ??
    (() => {
      console.warn("[robot] spawn_point·voxel 없음 — AABB fallback");
      const floorY = min.y + extent.y * MC_IN_1F_INTERIOR.floorHeightRatio;
      const eyeY = floorY + DEFAULTS_EYE;
      const x = (min.x + max.x) * 0.5;
      const z = (min.z + max.z) * 0.5;
      return {
        position: new Vector3(x, floorY + HULL_FLOOR_CLEARANCE, z),
        floorY,
        eyeY,
        hitCount: 0,
        cellCount: 0,
      };
    })()
  );
}

export async function createRobotMcIn1FSession(
  options: CreateRobotSessionOptions
): Promise<RobotMcIn1FSession> {
  const {
    scene,
    camera,
    canvas,
    splatMesh,
    collisionGlbUrl,
    spawnFootWorld,
    cameraFollow,
    onStatus,
  } = options;

  await enableHavokPhysics(scene);

  const tracker = new HavokCollisionTracker();
  const collisionTemplate = await loadCollisionTemplate(scene, collisionGlbUrl);
  const { root: staticVoxelRoot } = attachStaticVoxelBody(
    scene,
    splatMesh,
    collisionTemplate,
    tracker
  );

  const robotRoot = new TransformNode("robotRoot", scene);
  await loadHusky(scene, robotRoot);

  const { body: robotBody } = attachRobotHull(scene, robotRoot, tracker);

  const { min, max } = getWorldBounds(staticVoxelRoot);
  const extent = max.subtract(min);

  const footWorld = spawnFootWorld ?? DEFAULT_ROBOT_FOOT_WORLD;
  const voxelSpawn =
    resolveSpawnAtFoot(staticVoxelRoot, footWorld) ??
    resolveRobotSpawn(staticVoxelRoot, collisionTemplate.spawnLocal, min, max, extent);

  if (!voxelSpawn) {
    throw new Error("로봇 스폰 위치에 바닥 복셀이 없습니다.");
  }

  const lockedTargetY = voxelSpawn.eyeY;

  robotRoot.position.copyFrom(voxelSpawn.position);
  let robotHeading = cameraFollow?.alpha ?? camera.alpha;
  robotRoot.rotationQuaternion = null;
  robotRoot.rotation.y = robotHeading;
  syncPhysicsBody(robotRoot, robotBody);

  const wallGrid = buildRobotWallGrid(staticVoxelRoot);

  snapCameraToRobotFollow(
    camera,
    voxelSpawn.position.x,
    voxelSpawn.position.z,
    lockedTargetY,
    cameraFollow
  );

  if (voxelSpawn.hitCount > 0) {
    console.info(
      `[robot] foot xyz=(${voxelSpawn.position.x.toFixed(2)}, ${getRobotFootWorldY(robotRoot).toFixed(2)}, ${voxelSpawn.position.z.toFixed(2)}) cells=${voxelSpawn.cellCount} samples=${voxelSpawn.hitCount}`
    );
  }

  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (!MOVE_KEYS.has(key) && !LOOK_KEYS.has(key)) return;
    keys.add(key);
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("click", () => canvas.focus());

  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();
  let lastBlocked = false;
  let blockedDirXZ: Vector3 | null = null;

  const applyRobotMove = (
    originX: number,
    originY: number,
    originZ: number,
    delta: Vector3
  ): { moved: boolean; blocked: boolean } => {
    if (delta.lengthSquared() < 1e-12) {
      return { moved: false, blocked: false };
    }

    const intentXZ = normalizeIntentXZ(delta);
    const retreating =
      intentXZ !== null &&
      blockedDirXZ !== null &&
      Vector3.Dot(intentXZ, blockedDirXZ) < -HEMISPHERE_DOT_THRESHOLD;

    if (
      intentXZ !== null &&
      blockedDirXZ !== null &&
      isIntentInBlockedHemisphere(intentXZ, blockedDirXZ)
    ) {
      return { moved: false, blocked: true };
    }

    const nextX = originX + delta.x;
    const nextY = originY + delta.y;
    const nextZ = originZ + delta.z;

    const horizontalBlocked =
      intentXZ !== null &&
      isRobotWallBlockedAt(wallGrid, nextX, nextY, nextZ);

    if (horizontalBlocked && !retreating) {
      blockedDirXZ = intentXZ!.clone();
      return { moved: false, blocked: true };
    }

    if (Math.abs(delta.y) > 0 && isRobotWallBlockedAt(wallGrid, nextX, nextY, nextZ)) {
      return { moved: false, blocked: true };
    }

    robotRoot.position.set(nextX, nextY, nextZ);
    syncPhysicsBody(robotRoot, robotBody);

    if (!isRobotWallBlockedAt(wallGrid, nextX, nextY, nextZ)) {
      blockedDirXZ = null;
    }

    return { moved: true, blocked: false };
  };

  const beforeObserver = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const speed = 1.8 * dt;
    const turn = ROBOT_TURN_SPEED * dt;
    const camTurn = 1.4 * dt;

    if (keys.has("arrowleft")) robotHeading += turn;
    if (keys.has("arrowright")) robotHeading -= turn;
    robotRoot.rotation.y = robotHeading;

    if (keys.has("arrowup")) camera.beta = Math.max(0.25, camera.beta - camTurn);
    if (keys.has("arrowdown")) camera.beta = Math.min(Math.PI / 2.1, camera.beta + camTurn);

    robotForwardFromHeading(robotHeading + ROBOT_MOVE_HEADING_OFFSET, forward);
    robotRightFromHeading(robotHeading + ROBOT_MOVE_HEADING_OFFSET, right);

    move.setAll(0);
    if (keys.has("w")) move.addInPlace(forward.scale(speed));
    if (keys.has("s")) move.addInPlace(forward.scale(-speed));
    if (keys.has("d")) move.addInPlace(right.scale(speed));
    if (keys.has("a")) move.addInPlace(right.scale(-speed));
    if (keys.has("e")) move.y += speed * VERTICAL_SPEED_SCALE;
    if (keys.has("q")) move.y -= speed * VERTICAL_SPEED_SCALE;

    const originX = robotRoot.position.x;
    const originZ = robotRoot.position.z;
    const originY = robotRoot.position.y;
    const verticalInput = keys.has("q") || keys.has("e");

    const { blocked } = applyRobotMove(originX, originY, originZ, move);

    if (!verticalInput) {
      const floorAt = resolveRobotFloorYAt(
        staticVoxelRoot,
        robotRoot.position.x,
        robotRoot.position.z
      );
      if (floorAt !== null) {
        setRobotFootOnFloor(robotRoot, floorAt);
      }
    }
    syncPhysicsBody(robotRoot, robotBody);

    const eyeY = robotRoot.position.y + DEFAULTS_EYE - HULL_FLOOR_CLEARANCE;
    camera.setTarget(new Vector3(robotRoot.position.x, eyeY, robotRoot.position.z));

    if (blocked !== lastBlocked) {
      lastBlocked = blocked;
      onStatus?.(blocked);
    }
  });

  return {
    dispose() {
      scene.onBeforeRenderObservable.remove(beforeObserver);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      robotBody.dispose();
      robotRoot.dispose(false, true);
      staticVoxelRoot.dispose(false, true);
      collisionTemplate.template.dispose(false, true);
      camera.panningSensibility = 40;
    },
  };
}
