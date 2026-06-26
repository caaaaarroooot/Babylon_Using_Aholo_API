import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const iobDir = join(root, "public", "models", "iob");
const lodRoot = join(root, "public", "models", "iob-lod");

const IOB_SOURCES = [
  {
    label: "mc-out-main",
    input: join(iobDir, "MC_out_main_edit.splat"),
    output: join(lodRoot, "mc-out-main"),
  },
  {
    label: "mc-in-1f",
    input: join(iobDir, "MC_in_1F_edit.splat"),
    output: join(lodRoot, "mc-in-1f"),
  },
  {
    label: "mc-in-2f",
    input: join(iobDir, "MC_in_2F_edit.splat"),
    output: join(lodRoot, "mc-in-2f"),
  },
  {
    label: "warehouse",
    input: join(iobDir, "260615_MC_3dcam_warehouse_model_1.sog"),
    output: join(lodRoot, "warehouse"),
  },
];

mkdirSync(lodRoot, { recursive: true });

async function generateChunkLod({ label, input, output }) {
  const lodMetaPath = join(output, "lod-meta.json");

  if (!existsSync(input)) {
    console.warn(`[skip] missing input: ${input}`);
    return null;
  }

  if (existsSync(lodMetaPath)) {
    console.log(`[skip] already exists: ${lodMetaPath}`);
    return output;
  }

  const bundleKey = `lod_${label}`;
  console.log(`Aholo chunk-lod [${label}] -> ${output}`);
  mkdirSync(output, { recursive: true });

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
        type: "AutoChunkLod",
        config: {
          input: "cache0",
          output: bundleKey,
          type: "spz",
          maxChunkCounts: 20_000,
        },
      },
      {
        id: "2",
        type: "Write",
        config: { input: bundleKey, output },
      },
    ],
  });

  if (!existsSync(lodMetaPath)) {
    throw new Error(`lod-meta.json was not written: ${lodMetaPath}`);
  }

  console.log(`[ok] ${lodMetaPath}`);
  return output;
}

const manifest = {
  tool: "@manycore/aholo-splat-transform",
  maxChunkCounts: 20_000,
  models: {},
};

for (const source of IOB_SOURCES) {
  const out = await generateChunkLod(source);
  if (out) {
    manifest.models[source.label] = {
      input: source.input,
      lodMeta: `models/iob-lod/${source.label}/lod-meta.json`,
    };
  }
}

writeFileSync(join(lodRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Done:", join(lodRoot, "manifest.json"));
