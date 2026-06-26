import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ColIdx, SplatData } from "@manycore/aholo-splat-transform/dist/SplatData.js";
import { createSplatFile } from "@manycore/aholo-splat-transform/dist/utils/splat.js";
import { filterCluster } from "@manycore/aholo-splat-transform/dist/utils/voxel/filter-cluster.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "public", "models", "iob", "260615_MC_3dcam_warehouse_model_1.sog");
const outputDir = join(root, "public", "models", "iob-outliers", "warehouse");
const outputSpz = join(outputDir, "outliers.spz");
const OUTLIER_ALPHA_SCALE = 0.35;

async function readSplatFile(path) {
  const splat = new SplatData(1);
  const { size } = fs.statSync(path);
  const stream = Readable.toWeb(createReadStream(path));
  await createSplatFile(path).read(stream, size, splat);
  return splat;
}

function cloneRows(data, rows) {
  const out = new SplatData().init(rows.length, data.shDegree);
  for (let c = 0; c < data.table.length; c++) {
    const src = data.table[c];
    const dst = out.table[c];
    for (let i = 0; i < rows.length; i++) {
      dst[i] = src[rows[i]];
    }
  }
  return out;
}

function buildOutlierIndices(original, kept) {
  const keptKeys = new Set();
  const single = { shN: [] };
  for (let i = 0; i < kept.counts; i++) {
    kept.get(i, single);
    keptKeys.add(`${single.x}|${single.y}|${single.z}|${single.a}`);
  }

  const outlierIndices = [];
  for (let i = 0; i < original.counts; i++) {
    original.get(i, single);
    const key = `${single.x}|${single.y}|${single.z}|${single.a}`;
    if (!keptKeys.has(key)) {
      outlierIndices.push(i);
    }
  }
  return outlierIndices;
}

function scaleAlpha(data, factor) {
  const alphaCol = data.table[ColIdx.a];
  for (let i = 0; i < data.counts; i++) {
    alphaCol[i] *= factor;
  }
}

async function writeSplatFile(path, data) {
  const indices = new Uint32Array(data.counts);
  for (let i = 0; i < data.counts; i++) {
    indices[i] = i;
  }
  const file = createSplatFile(path);
  const stream = Writable.toWeb(createWriteStream(path));
  await file.write(stream, data, indices);
}

if (!fs.existsSync(input)) {
  throw new Error(`Input not found: ${input}`);
}

if (fs.existsSync(outputSpz)) {
  console.log(`[skip] already exists: ${outputSpz}`);
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });

console.log("filterCluster -> outlier splat:", outputSpz);
const original = await readSplatFile(input);
console.log(`loaded: ${original.counts.toLocaleString()} gaussians`);

const kept = await filterCluster(
  original,
  { voxelResolution: 1.0, opacityCutoff: 0.999, minContribution: 0.1 },
  { backend: "cpu" }
);
console.log(`kept: ${kept.counts.toLocaleString()} gaussians`);

const outlierIndices = buildOutlierIndices(original, kept);
console.log(`outliers: ${outlierIndices.length.toLocaleString()} gaussians`);

if (outlierIndices.length === 0) {
  console.log("[ok] no outliers to export");
  process.exit(0);
}

const outliers = cloneRows(original, outlierIndices);
scaleAlpha(outliers, OUTLIER_ALPHA_SCALE);
await writeSplatFile(outputSpz, outliers);
console.log("[ok]", outputSpz);
