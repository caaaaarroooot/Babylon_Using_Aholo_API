import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const root = process.cwd();
const input = join(root, "public/models/iob/260615_MC_3dcam_warehouse_model_1.sog");
const output = join(root, "public/models/iob-lod/warehouse");

mkdirSync(output, { recursive: true });
console.log("Input exists:", existsSync(input));
console.log("Writing to:", output);

await runner({
  version: 1,
  tasks: [
    { id: "0", type: "Read", config: { inputs: [input], output: "cache0" } },
    {
      id: "1",
      type: "AutoChunkLod",
      config: { input: "cache0", output: "lodBundle", type: "spz", maxChunkCounts: 20_000 },
    },
    { id: "2", type: "Write", config: { input: "lodBundle", output } },
  ],
});

const lodMeta = join(output, "lod-meta.json");
console.log("lod-meta exists:", existsSync(lodMeta));
console.log("file count:", readdirSync(output).length);
