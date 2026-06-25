import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";

registerBuiltInLoaders();

import { createScene } from "./scene";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const loading = document.getElementById("loading")!;

createScene(canvas)
  .then(() => {
    loading.style.display = "none";
  })
  .catch((err) => {
    loading.textContent = "로드 실패: " + String(err);
    console.error(err);
  });
