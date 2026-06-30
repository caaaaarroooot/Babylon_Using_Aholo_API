/**
 * collision.glb 등 GLB에 spawn_point 노드(Empty)를 주입합니다.
 * Blender에서 Empty를 배치해보낸 것과 동일한 역할입니다.
 *
 * 사용:
 *   node scripts/inject-spawn-point.mjs <collision.glb> [x y z]
 *   node scripts/inject-spawn-point.mjs public/models/iob-voxel/mc-in-1f/collision.glb 2.33 -0.25 -27.14
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const SPAWN_NAME = "spawn_point";

/** 기본 로봇 발 위치 — robotMcIn1F.ts DEFAULT_ROBOT_FOOT_WORLD 와 동기화 */
const DEFAULT_MC_IN_1F_SPAWN = [-10.18, 7.97, 15.52];

function readGlb(path) {
  const buf = readFileSync(path);
  const magic = buf.toString("utf8", 0, 4);
  if (magic !== "glTF") {
    throw new Error(`Not a GLB file: ${path}`);
  }

  let offset = 12;
  const jsonChunkLen = buf.readUInt32LE(offset);
  offset += 8;
  const jsonText = buf.slice(offset, offset + jsonChunkLen).toString("utf8").replace(/\0+$/g, "");
  const json = JSON.parse(jsonText);
  offset += jsonChunkLen;

  let bin = Buffer.alloc(0);
  if (offset + 8 <= buf.length) {
    const binChunkLen = buf.readUInt32LE(offset);
    offset += 8;
    const declared = json.buffers?.[0]?.byteLength ?? binChunkLen;
    bin = buf.slice(offset, offset + declared);
  }

  return { json, bin };
}

function validateGlb(path) {
  const buf = readFileSync(path);
  let offset = 12;
  const jsonChunkLen = buf.readUInt32LE(offset);
  offset += 8;
  const jsonText = buf
    .slice(offset, offset + jsonChunkLen)
    .toString("utf8")
    .replace(/\0+$/g, "")
    .trimEnd();
  JSON.parse(jsonText);
}

function writeGlb(path, json, bin) {
  const jsonStr = JSON.stringify(json);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const paddedBinLen = bin.length + binPad;

  if (json.buffers?.[0]) {
    json.buffers[0].byteLength = paddedBinLen;
  }

  const jsonStrFinal = JSON.stringify(json);
  const jsonBufFinal = Buffer.from(jsonStrFinal);
  const jsonPadFinal = (4 - (jsonBufFinal.length % 4)) % 4;

  const totalLen = 12 + 8 + jsonBufFinal.length + jsonPadFinal + 8 + paddedBinLen;
  const out = Buffer.alloc(totalLen);
  let offset = 0;

  out.write("glTF", offset);
  offset += 4;
  out.writeUInt32LE(2, offset);
  offset += 4;
  out.writeUInt32LE(totalLen, offset);
  offset += 4;

  out.writeUInt32LE(jsonBufFinal.length + jsonPadFinal, offset);
  offset += 4;
  out.writeUInt32LE(0x4e4f534a, offset);
  offset += 4;
  jsonBufFinal.copy(out, offset);
  offset += jsonBufFinal.length;
  for (let i = 0; i < jsonPadFinal; i += 1) {
    out[offset + i] = 0x20;
  }
  offset += jsonPadFinal;

  out.writeUInt32LE(paddedBinLen, offset);
  offset += 4;
  out.writeUInt32LE(0x004e4942, offset);
  offset += 4;
  bin.copy(out, offset);
  offset += bin.length;

  writeFileSync(path, out);
  validateGlb(path);
}

function injectSpawnPoint(json, translation) {
  if (!json.nodes) json.nodes = [];
  if (!json.scenes?.length) {
    json.scenes = [{ nodes: [] }];
    json.scene = 0;
  }

  const meshNodeIndex = json.nodes.findIndex((n) => n.mesh !== undefined);
  if (meshNodeIndex < 0) {
    throw new Error("GLB has no mesh node — cannot attach spawn_point");
  }

  const meshNode = json.nodes[meshNodeIndex];
  if (!meshNode.name) meshNode.name = "collision_mesh";

  let spawnIndex = json.nodes.findIndex(
    (n) => typeof n.name === "string" && n.name.toLowerCase().includes(SPAWN_NAME)
  );

  if (spawnIndex < 0) {
    spawnIndex = json.nodes.length;
    json.nodes.push({
      name: SPAWN_NAME,
      translation: [...translation],
    });
    if (!meshNode.children) meshNode.children = [];
    if (!meshNode.children.includes(spawnIndex)) {
      meshNode.children.push(spawnIndex);
    }
  } else {
    json.nodes[spawnIndex].name = SPAWN_NAME;
    json.nodes[spawnIndex].translation = [...translation];
    if (!meshNode.children?.includes(spawnIndex)) {
      if (!meshNode.children) meshNode.children = [];
      meshNode.children.push(spawnIndex);
    }
  }

  return spawnIndex;
}

const glbArg = process.argv[2];
if (!glbArg) {
  console.error("Usage: node scripts/inject-spawn-point.mjs <collision.glb> [x y z]");
  process.exit(1);
}

const glbPath = resolve(root, glbArg);
if (!existsSync(glbPath)) {
  throw new Error(`File not found: ${glbPath}`);
}

const coords =
  process.argv.length >= 6
    ? process.argv.slice(3, 6).map(Number)
    : DEFAULT_MC_IN_1F_SPAWN;

if (coords.some((v) => Number.isNaN(v))) {
  throw new Error("Spawn coordinates must be numbers");
}

const { json, bin } = readGlb(glbPath);
const spawnIndex = injectSpawnPoint(json, coords);
writeGlb(glbPath, json, bin);

console.log(`[ok] ${glbPath}`);
console.log(`  spawn_point (node ${spawnIndex}): [${coords.map((v) => v.toFixed(3)).join(", ")}]`);
