import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { GaussianSplattingMesh } from "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ParseSpz } from "@babylonjs/loaders/SPLAT/spz";
import {
  PerspectiveCamera,
  SplatUtils,
  Vector3 as AholoVector3,
} from "@manycore/aholo-viewer";

type LodMeta = SplatUtils.LodMeta;
type LodSplat = SplatUtils.LodSplat;

type LodNodeState = { targetLevel: number };
type LodInternals = { nodes?: LodNodeState[] };

type ParsedChunkFile = {
  data: ArrayBuffer;
  sh?: Uint8Array[];
  rowCount: number;
};

export interface AholoLodStats {
  loadedCount: number;
  totalCount: number;
}

export interface AholoLodBridge {
  stats: AholoLodStats;
  tick(camera: ArcRotateCamera): void;
  destroy(): void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getAspectRatio(camera: ArcRotateCamera): number {
  const engine = camera.getEngine();
  const h = Math.max(1, engine.getRenderHeight());
  return engine.getRenderWidth() / h;
}

function syncAholoCamera(
  babylonCamera: ArcRotateCamera,
  aholoCamera: PerspectiveCamera,
  mesh: GaussianSplattingMesh,
): void {
  mesh.computeWorldMatrix(true);
  const worldInv = mesh.getWorldMatrix().clone();
  worldInv.invert();

  const posWorld = babylonCamera.globalPosition;
  const targetWorld = babylonCamera.target;
  const pos = Vector3.TransformCoordinates(posWorld, worldInv);
  const target = Vector3.TransformCoordinates(targetWorld, worldInv);

  aholoCamera.fov = babylonCamera.fov;
  aholoCamera.aspect = getAspectRatio(babylonCamera);
  aholoCamera.near = babylonCamera.minZ;
  aholoCamera.far = babylonCamera.maxZ;
  aholoCamera.position.set(pos.x, pos.y, pos.z);
  aholoCamera.lookAt(new AholoVector3(target.x, target.y, target.z));
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}): ${url}`);
  }
  return res.arrayBuffer();
}

async function maybeGunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return buffer;
  if (typeof DecompressionStream === "undefined") return buffer;

  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function getFileRowCounts(meta: LodMeta): number[] {
  const counts = new Array(meta.files.length).fill(0);
  for (const node of meta.tree) {
    for (const lod of node.lods) {
      counts[lod.file] = Math.max(counts[lod.file], lod.offset + lod.count);
    }
  }
  return counts;
}

function makeSelectionKey(
  selection: Array<{ file: number; offset: number; count: number }>,
): string {
  return selection.map((s) => `${s.file}:${s.offset}:${s.count}`).join("|");
}

async function parseChunkFile(
  scene: Scene,
  url: string,
  rowCount: number,
): Promise<ParsedChunkFile> {
  const compressed = await fetchArrayBuffer(url);
  const source = await maybeGunzip(compressed);
  const parsed = await ParseSpz(source, scene, { flipY: false });
  return {
    data: parsed.data,
    sh: parsed.sh,
    rowCount,
  };
}

export async function fetchLodMeta(url: string): Promise<LodMeta> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`lod-meta fetch failed (${res.status}): ${url}`);
  }
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(`lod-meta is not JSON: ${url}`);
  }
  const meta = JSON.parse(text) as LodMeta;
  if (meta.type !== "lod-splat") {
    throw new Error(`Invalid lod-meta type: ${meta.type}`);
  }
  return meta;
}

export function createEmptyGaussianSplatMesh(
  scene: Scene,
  name: string,
): GaussianSplattingMesh {
  return new GaussianSplattingMesh(name, undefined, scene);
}

export function createAholoLodBridge(
  scene: Scene,
  mesh: GaussianSplattingMesh,
  lodMetaUrl: string,
  lodMeta: LodMeta,
  options?: { maxBudget?: number; minLevel?: number },
): AholoLodBridge {
  const baseUrl = lodMetaUrl.slice(0, lodMetaUrl.lastIndexOf("/") + 1);
  const fileRowCounts = getFileRowCounts(lodMeta);
  const stats: AholoLodStats = { loadedCount: 0, totalCount: lodMeta.counts };
  const parsedFileCache = new Map<number, Promise<ParsedChunkFile>>();
  const scheduler = new SplatUtils.LodSplat(lodMeta, {
    maxBudget:
      options?.maxBudget ?? Math.max(30000, Math.floor(lodMeta.counts * 0.6)),
    minLevel: options?.minLevel ?? 0,
    hysteresisTicks: 6,
    backgroundPenalty: 0.3,
    outsidePenalty: 2.2,
    behindPenalty: 1.5,
    schedulerParallelCounts: 3,
  }) as unknown as LodSplat;
  const aholoCamera = new PerspectiveCamera();

  let disposed = false;
  let applying = false;
  let pending = false;
  let lastSelectionKey = "";

  const loadParsedFile = (fileIdx: number): Promise<ParsedChunkFile> => {
    const cached = parsedFileCache.get(fileIdx);
    if (cached) return cached;
    const p = parseChunkFile(
      scene,
      `${baseUrl}${lodMeta.files[fileIdx]}`,
      fileRowCounts[fileIdx],
    );
    parsedFileCache.set(fileIdx, p);
    return p;
  };

  const applySelection = async () => {
    if (disposed || applying) {
      pending = true;
      return;
    }
    applying = true;

    try {
      const internals = scheduler as unknown as LodInternals;
      const nodes = internals.nodes ?? [];
      const selection: Array<{ file: number; offset: number; count: number }> =
        [];
      for (let i = 0; i < lodMeta.tree.length; i++) {
        const node = lodMeta.tree[i];
        const target = clamp(
          nodes[i]?.targetLevel ?? node.lods.length - 1,
          0,
          node.lods.length - 1,
        );
        selection.push(node.lods[target]);
      }

      const key = makeSelectionKey(selection);
      if (key === lastSelectionKey) {
        stats.loadedCount = selection.reduce((acc, s) => acc + s.count, 0);
        return;
      }

      const parsedList = await Promise.all(
        Array.from(new Set(selection.map((s) => s.file))).map(
          async (fileIdx) => [fileIdx, await loadParsedFile(fileIdx)],
        ),
      );
      const parsedMap = new Map<number, ParsedChunkFile>(
        parsedList as Array<[number, ParsedChunkFile]>,
      );

      //   const totalRows = selection.reduce((acc, s) => acc + s.count, 0);
      //   const firstParsed = parsedMap.get(selection[0]?.file);
      //   if (!firstParsed) return;
      const totalRows = selection.reduce((acc, s) => acc + s.count, 0);

      // 진짜 점(rowCount)이 1개라도 있는 정상적인 청크를 찾습니다.
      const validSelection = selection.find((s) => {
        const p = parsedMap.get(s.file);
        return p && p.rowCount > 0;
      });
      const firstParsed = validSelection
        ? parsedMap.get(validSelection.file)
        : null;

      // 그릴 데이터가 하나도 없으면 그냥 종료
      if (!firstParsed || totalRows === 0) {
        applying = false;
        return;
      }
      const baseStride = Math.floor(
        new Uint8Array(firstParsed.data).byteLength /
          Math.max(1, firstParsed.rowCount),
      );
      const mergedData = new Uint8Array(totalRows * baseStride);
      let mergedSh: Uint8Array[] | undefined;
      let cursor = 0;

      for (const sel of selection) {
        const parsed = parsedMap.get(sel.file);
        if (!parsed || parsed.rowCount === 0 || sel.count === 0) continue;

        const srcData = new Uint8Array(parsed.data);

        // 🔥 핵심 1: 각 청크마다 지멋대로인 크기를 믿지 않고, 첫 번째 청크에서 정한 기준 보폭(baseStride)으로 강제 통일합니다.
        const rowStride = baseStride;
        const start = sel.offset * rowStride;
        let end = start + sel.count * rowStride;

        // 🔥 핵심 2: 만약 삐져나가면? 버리는(skip) 게 아니라, 실제 있는 데이터까지만 부드럽게 잘라서 씁니다.
        if (end > srcData.byteLength) {
          end = srcData.byteLength;
        }

        const dataToWrite = srcData.subarray(start, end);
        const targetOffset = cursor * baseStride;

        // 상자 크기를 초과하면 더 이상 담지 않고 중단 (안전장치)
        if (targetOffset + dataToWrite.length > mergedData.length) {
          break;
        }

        mergedData.set(dataToWrite, targetOffset);

        // SH(빛 반사) 데이터 처리
        if (parsed.sh && parsed.sh.length > 0 && mergedSh) {
          for (let c = 0; c < parsed.sh.length; c++) {
            const src = parsed.sh[c];
            const dst = mergedSh[c];

            const shStride = Math.floor(
              src.length / Math.max(1, parsed.rowCount),
            );
            const shStart = sel.offset * shStride;
            let shEnd = shStart + sel.count * shStride;

            if (shEnd > src.length) shEnd = src.length; // SH도 초과하면 자름

            const shToWrite = src.subarray(shStart, shEnd);
            const shTargetOffset = cursor * shStride;

            if (shTargetOffset + shToWrite.length <= dst.length) {
              dst.set(shToWrite, shTargetOffset);
            }
          }
        }

        // 🔥 핵심 3: 예측값이 아니라 "실제로 성공적으로 복사한 점의 개수"만큼만 커서를 이동시킵니다.
        cursor += Math.floor(dataToWrite.length / baseStride);
      }

      //   await mesh.updateDataAsync(mergedData.buffer, mergedSh);
      //   stats.loadedCount = totalRows;
      let finalDataBuffer = mergedData.buffer;
      let finalSh = mergedSh;

      // 방어막 때문에 불량 청크를 스킵해서 상자가 덜 채워졌다면?
      if (cursor < totalRows) {
        // 딱 채워진 부분(cursor)까지만 버퍼를 잘라냅니다. (하얀 안개 차단)
        finalDataBuffer = mergedData.buffer.slice(0, cursor * baseStride);

        if (mergedSh) {
          finalSh = mergedSh.map((shArr) => {
            const shStride = Math.floor(shArr.length / totalRows);
            return shArr.slice(0, cursor * shStride); // SH 데이터도 꽉 찬 곳까지만 컷!
          });
        }
      }

      await mesh.updateDataAsync(finalDataBuffer, finalSh);
      stats.loadedCount = cursor; // 진짜로 살아남아서 화면에 그린 개수만 기록
      lastSelectionKey = key;
      lastSelectionKey = key;
    } finally {
      applying = false;
      if (pending && !disposed) {
        pending = false;
        void applySelection();
      }
    }
  };

  return {
    stats,
    tick(camera: ArcRotateCamera) {
      if (disposed) return;
      syncAholoCamera(camera, aholoCamera, mesh);
      scheduler.tick(aholoCamera);

      // 🔥 엔진이 살아있는지, 데드락에 걸렸는지 확인하는 로그
      console.log(
        `[LoD Tick] applying 상태: ${applying}, pending 상태: ${pending}`,
      );

      void applySelection();
    },
    destroy() {
      disposed = true;
      scheduler.destroy();
    },
  };
}
