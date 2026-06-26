import { ArcRotateCamera, Scene, Vector3 } from "@babylonjs/core";

const MOVE_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
const LOOK_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright"]);

type KeyboardCameraOptions = {
  moveSpeed?: number;
  lookSpeed?: number;
};

export function setupKeyboardCameraControls(
  scene: Scene,
  camera: ArcRotateCamera,
  canvas: HTMLCanvasElement,
  options: KeyboardCameraOptions = {}
) {
  const moveSpeed = options.moveSpeed ?? 2.5;
  const lookSpeed = options.lookSpeed ?? 1.6;
  const keys = new Set<string>();

  canvas.tabIndex = 0;

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (!MOVE_KEYS.has(key) && !LOOK_KEYS.has(key)) return;
    keys.add(key);
    e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("click", () => canvas.focus());

  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();
  const step = new Vector3();

  const observer = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const walk = moveSpeed * dt;
    const turn = lookSpeed * dt;

    if (keys.has("arrowleft")) camera.alpha -= turn;
    if (keys.has("arrowright")) camera.alpha += turn;
    if (keys.has("arrowup")) camera.beta = Math.max(0.15, camera.beta - turn);
    if (keys.has("arrowdown")) camera.beta = Math.min(Math.PI - 0.15, camera.beta + turn);

    camera.getDirectionToRef(Vector3.Forward(), forward);
    forward.y = 0;
    if (forward.lengthSquared() > 0) forward.normalize();

    camera.getDirectionToRef(Vector3.Right(), right);
    right.y = 0;
    if (right.lengthSquared() > 0) right.normalize();

    move.setAll(0);
    if (keys.has("w")) {
      step.copyFrom(forward).scaleInPlace(walk);
      move.addInPlace(step);
    }
    if (keys.has("s")) {
      step.copyFrom(forward).scaleInPlace(-walk);
      move.addInPlace(step);
    }
    if (keys.has("d")) {
      step.copyFrom(right).scaleInPlace(walk);
      move.addInPlace(step);
    }
    if (keys.has("a")) {
      step.copyFrom(right).scaleInPlace(-walk);
      move.addInPlace(step);
    }
    if (keys.has("e")) move.y += walk;
    if (keys.has("q")) move.y -= walk;

    if (move.lengthSquared() > 0) {
      camera.target.addInPlace(move);
    }
  });

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
