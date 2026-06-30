/**
 * Aholo Voxel collision.glb 인덱스 버퍼 선두 오염 수리.
 *
 * 일부 1F 출력에서 indices 앞 24바이트(6×float)가 POSITION처럼 들어가
 * 첫 삼각형이 gigant vertex index → 와이어 스파게티 / physics 오류를 만듭니다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PREFIX_BYTES = 24;
const INDEX_PREFIX_COUNT = 6;

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.toString("utf8", 0, 4) !== "glTF") {
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
    offset += 8;
    const declared = json.buffers?.[0]?.byteLength ?? buf.length - offset;
    bin = Buffer.from(buf.slice(offset, offset + declared));
  }

  return { json, bin };
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

  writeFileSync(path, out);
}

function findPositionAndIndexAccessors(json) {
  const posAcc = json.accessors?.find(
    (a) => a.type === "VEC3" && a.componentType === 5126
  );
  const idxAcc = json.accessors?.find(
    (a) => a.type === "SCALAR" && a.componentType === 5125
  );
  return { posAcc, idxAcc };
}

function indexBufferOffset(json, idxAcc) {
  const bv = json.bufferViews[idxAcc.bufferView];
  return (bv.byteOffset || 0) + (idxAcc.byteOffset || 0);
}

export function validateCollisionGlb(json, bin) {
  const { posAcc, idxAcc } = findPositionAndIndexAccessors(json);
  if (!posAcc || !idxAcc) {
    return { ok: false, reason: "missing POSITION or indices accessor" };
  }

  const iOff = indexBufferOffset(json, idxAcc);
  let bad = 0;
  let maxIdx = 0;
  for (let i = 0; i < idxAcc.count; i += 1) {
    const vi = bin.readUInt32LE(iOff + i * 4);
    if (vi > maxIdx) maxIdx = vi;
    if (vi >= posAcc.count) bad += 1;
  }

  return {
    ok: bad === 0,
    vertCount: posAcc.count,
    indexCount: idxAcc.count,
    badIndices: bad,
    maxIdx,
  };
}

export function detectIndexPrefixCorruption(json, bin) {
  const { posAcc, idxAcc } = findPositionAndIndexAccessors(json);
  if (!posAcc || !idxAcc) return null;

  const iOff = indexBufferOffset(json, idxAcc);
  if (idxAcc.count <= INDEX_PREFIX_COUNT) return null;

  const firstIdx = bin.readUInt32LE(iOff);
  if (firstIdx < posAcc.count) return null;

  const repairedFirst = bin.readUInt32LE(iOff + INDEX_PREFIX_BYTES);
  const repairedSecond = bin.readUInt32LE(iOff + INDEX_PREFIX_BYTES + 4);
  const repairedThird = bin.readUInt32LE(iOff + INDEX_PREFIX_BYTES + 8);
  if (
    repairedFirst >= posAcc.count ||
    repairedSecond >= posAcc.count ||
    repairedThird >= posAcc.count
  ) {
    return null;
  }

  return { skipBytes: INDEX_PREFIX_BYTES, skipIndices: INDEX_PREFIX_COUNT };
}

export function repairCollisionGlb(json, bin) {
  const corruption = detectIndexPrefixCorruption(json, bin);
  if (!corruption) {
    return { json, bin, repaired: false };
  }

  const { idxAcc } = findPositionAndIndexAccessors(json);
  const idxBv = json.bufferViews[idxAcc.bufferView];
  const idxStart = idxBv.byteOffset || 0;

  const repairedBin = Buffer.concat([
    bin.slice(0, idxStart),
    bin.slice(idxStart + corruption.skipBytes),
  ]);

  idxBv.byteLength -= corruption.skipBytes;
  idxAcc.count -= corruption.skipIndices;
  if (json.buffers?.[0]) {
    json.buffers[0].byteLength = repairedBin.length;
  }

  return { json, bin: repairedBin, repaired: true, corruption };
}

export function repairCollisionGlbFile(path) {
  const { json, bin } = readGlb(path);
  const before = validateCollisionGlb(json, bin);
  const { json: outJson, bin: outBin, repaired, corruption } = repairCollisionGlb(json, bin);
  const after = validateCollisionGlb(outJson, outBin);

  if (repaired) {
    writeGlb(path, outJson, outBin);
  }

  return { before, after, repaired, corruption, path };
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const glbArg = isCli ? process.argv[2] : null;
if (glbArg) {
  const glbPath = resolve(glbArg);
  if (!existsSync(glbPath)) {
    throw new Error(`File not found: ${glbPath}`);
  }

  const result = repairCollisionGlbFile(glbPath);
  if (result.repaired) {
    console.log(`[repair] ${glbPath}`);
    console.log(
      `  stripped ${result.corruption.skipBytes}B prefix` +
        ` (${result.corruption.skipIndices} bad indices)`
    );
    console.log(
      `  indices: bad ${result.before.badIndices} -> ${result.after.badIndices}` +
        ` · maxIdx ${result.before.maxIdx} -> ${result.after.maxIdx}`
    );
  } else if (result.after.ok) {
    console.log(`[ok] ${glbPath} — indices valid (${result.after.vertCount}v)`);
  } else {
    console.warn(`[warn] ${glbPath} — still invalid:`, result.after);
    process.exitCode = 1;
  }
}
