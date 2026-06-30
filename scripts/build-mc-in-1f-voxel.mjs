import { spawn as spawnProc } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAholoVoxelPair } from "./build-aholo-voxel-pair.mjs";
import { repairCollisionGlbFile } from "./repair-collision-glb.mjs";
import {
  computeVoxelResolutionsFromWarehouseRef,
  MC_IN_1F_EXTENTS,
} from "./voxel-resolution.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "public", "models", "iob", "MC_in_1F_edit.splat");
const output = join(root, "public", "models", "iob-voxel", "mc-in-1f");

/** 1보다 작을수록 더 정밀 — 맵 대비 복셀이 크게 느껴지면 0.85~0.9 시도 */
const MC_IN_1F_PHYSICS_FINE_TUNE = 0.88;
const forceRebuild = process.argv.includes("--force");

const resolutions = computeVoxelResolutionsFromWarehouseRef(MC_IN_1F_EXTENTS, {
  physicsFineTune: MC_IN_1F_PHYSICS_FINE_TUNE,
});

console.log("Aholo Voxel (1F interior) -> collision.glb");
console.log("Input:", input);
if (forceRebuild) {
  console.log("[force] 기존 collision 파일 삭제 후 재생성");
}
console.log(
  `[voxel] warehouse 대비 크기 비율 ${(resolutions.sizeRatio * 100).toFixed(1)}%` +
    ` (scene∛≈${resolutions.sceneSpan.toFixed(1)}m, ref∛≈${resolutions.refSpan.toFixed(1)}m)`
);
console.log(
  `[voxel] physics=${resolutions.physicsResolution}m` +
    ` · viz=${resolutions.vizResolution}m` +
    ` (fineTune=${MC_IN_1F_PHYSICS_FINE_TUNE})`
);

const { collisionGlb } = await buildAholoVoxelPair({
  input,
  outputDir: output,
  physicsResolution: resolutions.physicsResolution,
  vizResolution: resolutions.vizResolution,
  voxelConfig: {
    autoDenseBox: true,
  },
  skipIfExists: !forceRebuild,
  buildViz: false,
});

const repair = repairCollisionGlbFile(collisionGlb);
if (repair.repaired) {
  console.log(
    `[repair] index prefix stripped (${repair.corruption.skipBytes}B)` +
      ` · bad ${repair.before.badIndices} -> ${repair.after.badIndices}`
  );
} else if (!repair.after.ok) {
  throw new Error(
    `collision.glb indices still invalid after repair: bad=${repair.after.badIndices}`
  );
}

await new Promise((resolve, reject) => {
  const child = spawnProc(
    process.execPath,
    [join(__dirname, "inject-spawn-point.mjs"), collisionGlb],
    { stdio: "inherit" }
  );
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`spawn inject exit ${code}`))
  );
});

console.log("[ok]", output);
console.log(`  collision.glb (${resolutions.physicsResolution}m, Aholo 원본)`);
console.log("  재생성: node scripts/build-mc-in-1f-voxel.mjs --force");
