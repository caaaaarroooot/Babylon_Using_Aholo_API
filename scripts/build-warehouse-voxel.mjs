import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "public", "models", "iob", "260615_MC_3dcam_warehouse_model_1.sog");
const output = join(root, "public", "models", "iob-voxel", "warehouse");
const collisionGlb = join(output, "collision.glb");

/**
 * Aholo 로그 scene extents 기준 + 여유 2m
 * (이전 box max Z=106 → 실제 씬 Z=273 까지 있어서 뒤쪽 167m 잘림)
 * 260615_MC_3dcam_warehouse_model_1.sog extents:
 *   (-51.44,-34.19,-25.58) ~ (49.16, 5.41, 273.41)
 */
const WAREHOUSE_VOXEL_BOX = {
  minCorner: [-54, -37, -28],
  maxCorner: [52, 8, 276],
};

if (!existsSync(input)) {
  throw new Error(`Input not found: ${input}`);
}

if (existsSync(collisionGlb)) {
  console.log(`[skip] already exists: ${collisionGlb}`);
  console.log("  반쪽만 보이면 collision.glb를 삭제한 뒤 다시 실행하세요.");
  process.exit(0);
}

mkdirSync(output, { recursive: true });

console.log("Aholo Voxel (full scene box + collision faces) ->", output);
console.log("Input:", input);
console.log("Box:", WAREHOUSE_VOXEL_BOX);

await runner({
  version: 1,
  tasks: [
    {
      id: "0",
      type: "Read",
      config: { inputs: [input], output: "cache0" },
    },
    {
      id: "1",
      type: "Voxel",
      config: {
        input: "cache0",
        output,
        backend: "cpu",
        voxelResolution: 0.25,
        opacityCutoff: 0.15,
        collisionMesh: "faces",
        filterCluster: false,
        autoDenseBox: false,
        box: WAREHOUSE_VOXEL_BOX,
      },
    },
  ],
});

if (!existsSync(collisionGlb)) {
  throw new Error(`collision.glb was not written: ${collisionGlb}`);
}

console.log("[ok]", collisionGlb);
