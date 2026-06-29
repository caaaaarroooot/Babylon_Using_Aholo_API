import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "public", "models", "iob", "MC_in_1F_edit.splat");
const output = join(root, "public", "models", "iob-voxel", "mc-in-1f");
const collisionGlb = join(output, "collision.glb");

if (!existsSync(input)) {
  throw new Error(`Input not found: ${input}`);
}

if (existsSync(collisionGlb)) {
  console.log(`[skip] already exists: ${collisionGlb}`);
  console.log("  잘못 보이면 collision.glb를 삭제한 뒤 다시 실행하세요.");
  process.exit(0);
}

mkdirSync(output, { recursive: true });

console.log("Aholo Voxel (1F interior, autoDenseBox) ->", output);
console.log("Input:", input);

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
        autoDenseBox: true,
      },
    },
  ],
});

if (!existsSync(collisionGlb)) {
  throw new Error(`collision.glb was not written: ${collisionGlb}`);
}

console.log("[ok]", collisionGlb);
