import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAholoVoxelPair } from "./build-aholo-voxel-pair.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "public", "models", "iob", "260615_MC_3dcam_warehouse_model_1.sog");
const output = join(root, "public", "models", "iob-voxel", "warehouse");

/** Aholo 로그 scene extents 기준 + 여유 2m */
const WAREHOUSE_VOXEL_BOX = {
  minCorner: [-54, -37, -28],
  maxCorner: [52, 8, 276],
};

console.log("Aholo Voxel (warehouse) -> collision.glb + collision-viz.glb");
console.log("Input:", input);
console.log("Box:", WAREHOUSE_VOXEL_BOX);

await buildAholoVoxelPair({
  input,
  outputDir: output,
  physicsResolution: 0.25,
  vizResolution: 1.0,
  voxelConfig: {
    autoDenseBox: false,
    box: WAREHOUSE_VOXEL_BOX,
  },
});

console.log("[ok]", output);
console.log("  physics: collision.glb (0.25m)");
console.log("  wire viz: collision-viz.glb (1.0m — Aholo voxel 미리보기)");
