import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tmpDir = join(root, "tmp");
const modelsDir = join(root, "public", "models");

const SKULL_URL = "https://assets.babylonjs.com/splats/gs_Skull.splat";
const skullInput = join(tmpDir, "gs_Skull.splat");
const skullSpz = join(modelsDir, "skull.spz");
const skullLodDir = join(modelsDir, "skull-lod");
const unifiedDir = join(modelsDir, "skull-voxel");
const manifestPath = join(modelsDir, "manifest.json");

// ── 이전: 해골(상단) / 받침대(하단) Y축 분리 (비활성) ──
// const SPLIT_Y = 0.1;
// const skullPartDir = join(modelsDir, "skull-part-voxel");
// const groundDir = join(modelsDir, "ground-voxel");

mkdirSync(tmpDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

async function downloadSkull() {
  if (existsSync(skullInput)) return;
  console.log("Downloading gs_Skull.splat...");
  const res = await fetch(SKULL_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  if (!res.body) throw new Error("Empty response body");
  await pipeline(res.body, createWriteStream(skullInput));
}

async function convertToSpz() {
  console.log("Aholo splat-transform: .splat -> .spz");
  await runner({
    version: 1,
    tasks: [
      {
        id: "0",
        type: "Read",
        config: { inputs: [skullInput], output: "cache0" },
      },
      {
        id: "1",
        type: "Write",
        config: { input: "cache0", output: skullSpz, enableMortonSort: true },
      },
    ],
  });
}

async function generateChunkLod() {
  console.log("Aholo splat-transform: chunk-lod ->", skullLodDir);
  await runner({
    version: 1,
    tasks: [
      {
        id: "0",
        type: "Read",
        config: { inputs: [skullInput], output: "cache0" },
      },
      {
        id: "1",
        type: "AutoChunkLod",
        config: {
          input: "cache0",
          output: skullLodDir,
          type: "spz",
          maxChunkCounts: 25000,
        },
      },
    ],
  });
}

async function generateVoxel(label, outputDir, box) {
  console.log(`Aholo splat-transform: voxel [${label}] -> ${outputDir}`);
  await runner({
    version: 1,
    tasks: [
      {
        id: "0",
        type: "Read",
        config: { inputs: [skullInput], output: "cache0" },
      },
      {
        id: "1",
        type: "Voxel",
        config: {
          input: "cache0",
          output: outputDir,
          backend: "cpu",
          voxelResolution: 0.04,
          opacityCutoff: 0.15,
          collisionMesh: "faces",
          filterCluster: true,
          autoDenseBox: false,
          box,
        },
      },
    ],
  });
}

await downloadSkull();
await convertToSpz();
await generateChunkLod();

/** 통합 collision mesh — 해골+받침대 분리 없이 전체를 1개 mesh로 */
await generateVoxel("unified", unifiedDir, {
  minCorner: [-2.5, -2.5, -2.5],
  maxCorner: [2.5, 2.5, 2.5],
});

// ── 이전: Y 밴드로 해골/받침대 분리 voxel (비활성) ──
// await generateVoxel("skull", skullPartDir, {
//   minCorner: [-2.5, -2.5, -2.5],
//   maxCorner: [2.5, SPLIT_Y, 2.5],
// });
// await generateVoxel("ground", groundDir, {
//   minCorner: [-2.5, SPLIT_Y, -2.5],
//   maxCorner: [2.5, 2.5, 2.5],
// });

const manifest = {
  source: SKULL_URL,
  spz: "models/skull.spz",
  lodMeta: "models/skull-lod/lod-meta.json",
  collisionGlb: "models/skull-voxel/collision.glb",
  tool: "@manycore/aholo-splat-transform",
  // splitY: SPLIT_Y,
  // skullCollisionGlb: "models/skull-part-voxel/collision.glb",
  // groundCollisionGlb: "models/ground-voxel/collision.glb",
};

if (existsSync(join(unifiedDir, "voxel-meta.json"))) {
  manifest.voxelMeta = JSON.parse(
    readFileSync(join(unifiedDir, "voxel-meta.json"), "utf-8")
  );
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("Done:", manifest);
