import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "@manycore/aholo-splat-transform/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/**
 * Aholo Voxel → collision.glb (physics) + collision-viz.glb (와이어 미리보기)
 */
export async function buildAholoVoxelPair({
  input,
  outputDir,
  physicsResolution,
  vizResolution,
  voxelConfig,
  skipIfExists = true,
  buildViz = true,
}) {
  const collisionGlb = join(outputDir, "collision.glb");
  const collisionVizGlb = join(outputDir, "collision-viz.glb");

  if (!existsSync(input)) {
    throw new Error(`Input not found: ${input}`);
  }

  if (
    skipIfExists &&
    existsSync(collisionGlb) &&
    (!buildViz || existsSync(collisionVizGlb))
  ) {
    console.log(`[skip] already exists: ${collisionGlb}`);
    return { collisionGlb, collisionVizGlb, skipped: true };
  }

  mkdirSync(outputDir, { recursive: true });

  if (!skipIfExists) {
    for (const name of ["collision.glb", "collision-viz.glb", "voxel-meta.json", "voxel.bin"]) {
      rmSync(join(outputDir, name), { force: true });
    }
  }

  const readTask = {
    id: "0",
    type: "Read",
    config: { inputs: [input], output: "cache0" },
  };

  console.log(`[voxel] physics mesh (res=${physicsResolution}) ->`, collisionGlb);
  await runner({
    version: 1,
    tasks: [
      readTask,
      {
        id: "1",
        type: "Voxel",
        config: {
          input: "cache0",
          output: outputDir,
          backend: "cpu",
          voxelResolution: physicsResolution,
          opacityCutoff: 0.15,
          collisionMesh: "faces",
          filterCluster: false,
          ...voxelConfig,
        },
      },
    ],
  });
  if (!existsSync(collisionGlb)) {
    throw new Error(`collision.glb was not written: ${collisionGlb}`);
  }

  if (buildViz && !existsSync(collisionVizGlb)) {
    const vizTmp = join(outputDir, ".viz-build");
    mkdirSync(vizTmp, { recursive: true });
    console.log(`[voxel] viz wire mesh (res=${vizResolution}) ->`, collisionVizGlb);
    await runner({
      version: 1,
      tasks: [
        readTask,
        {
          id: "1",
          type: "Voxel",
          config: {
            input: "cache0",
            output: vizTmp,
            backend: "cpu",
            voxelResolution: vizResolution,
            opacityCutoff: 0.15,
            collisionMesh: "faces",
            filterCluster: false,
            ...voxelConfig,
          },
        },
      ],
    });
    const vizSrc = join(vizTmp, "collision.glb");
    if (!existsSync(vizSrc)) {
      throw new Error(`viz collision.glb was not written: ${vizSrc}`);
    }
    copyFileSync(vizSrc, collisionVizGlb);
    rmSync(vizTmp, { recursive: true, force: true });
  } else if (buildViz) {
    console.log(`[skip] viz mesh exists: ${collisionVizGlb}`);
  }

  return { collisionGlb, collisionVizGlb, skipped: false };
}
