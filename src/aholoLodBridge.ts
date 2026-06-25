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
  mesh: GaussianSplattingMesh
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

  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
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

function makeSelectionKey(selection: Array<{ file: number; offset: number; count: number }>): string {
  return selection.map((s) => `${s.file}:${s.offset}:${s.count}`).join("|");
}

async function parseChunkFile(
  scene: Scene,
  url: string,
  rowCount: number
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

export function createEmptyGaussianSplatMesh(scene: Scene, name: string): GaussianSplattingMesh {
  return new GaussianSplattingMesh(name, undefined, scene);
}

export function createAholoLodBridge(
  scene: Scene,
  mesh: GaussianSplattingMesh,
  lodMetaUrl: string,
  lodMeta: LodMeta,
  options?: { maxBudget?: number; minLevel?: number }
): AholoLodBridge {
  const baseUrl = lodMetaUrl.slice(0, lodMetaUrl.lastIndexOf("/") + 1);
  const fileRowCounts = getFileRowCounts(lodMeta);
  const stats: AholoLodStats = { loadedCount: 0, totalCount: lodMeta.counts };
  const parsedFileCache = new Map<number, Promise<ParsedChunkFile>>();
  const scheduler = new SplatUtils.LodSplat(lodMeta, {
    maxBudget: options?.maxBudget ?? Math.max(30000, Math.floor(lodMeta.counts * 0.22)),
    minLevel: options?.minLevel ?? 0,
    hysteresisTicks: 6,
    backgroundPenalty: 1.2,
    outsidePenalty: 2.8,
    behindPenalty: 2.0,
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
    const p = parseChunkFile(scene, `${baseUrl}${lodMeta.files[fileIdx]}`, fileRowCounts[fileIdx]);
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
      const selection: Array<{ file: number; offset: number; count: number }> = [];
      for (let i = 0; i < lodMeta.tree.length; i++) {
        const node = lodMeta.tree[i];
        const target = clamp(nodes[i]?.targetLevel ?? node.lods.length - 1, 0, node.lods.length - 1);
        selection.push(node.lods[target]);
      }

      const key = makeSelectionKey(selection);
      if (key === lastSelectionKey) {
        stats.loadedCount = selection.reduce((acc, s) => acc + s.count, 0);
        return;
      }

      const parsedList = await Promise.all(
        Array.from(new Set(selection.map((s) => s.file))).map(async (fileIdx) => [
          fileIdx,
          await loadParsedFile(fileIdx),
        ])
      );
      const parsedMap = new Map<number, ParsedChunkFile>(parsedList as Array<[number, ParsedChunkFile]>);

      const totalRows = selection.reduce((acc, s) => acc + s.count, 0);
      const firstParsed = parsedMap.get(selection[0]?.file);
      if (!firstParsed) return;
      const baseStride = Math.floor(
        new Uint8Array(firstParsed.data).byteLength / Math.max(1, firstParsed.rowCount)
      );
      const mergedData = new Uint8Array(totalRows * baseStride);
      let mergedSh: Uint8Array[] | undefined;
      let cursor = 0;

      for (const sel of selection) {
        const parsed = parsedMap.get(sel.file);
        if (!parsed) continue;

        const srcData = new Uint8Array(parsed.data);
        const rowStride = Math.floor(srcData.byteLength / Math.max(1, parsed.rowCount));
        const start = sel.offset * rowStride;
        const end = start + sel.count * rowStride;
        mergedData.set(srcData.subarray(start, end), cursor * baseStride);

        if (parsed.sh && parsed.sh.length > 0) {
          if (!mergedSh) {
            mergedSh = parsed.sh.map((v) => new Uint8Array(Math.floor((v.length / parsed.rowCount) * totalRows)));
          }
          for (let c = 0; c < parsed.sh.length; c++) {
            const src = parsed.sh[c];
            const dst = mergedSh[c];
            const shStride = Math.floor(src.length / Math.max(1, parsed.rowCount));
            const shStart = sel.offset * shStride;
            const shEnd = shStart + sel.count * shStride;
            dst.set(src.subarray(shStart, shEnd), cursor * shStride);
          }
        }

        cursor += sel.count;
      }

      await mesh.updateDataAsync(mergedData.buffer, mergedSh);
      stats.loadedCount = totalRows;
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
      void applySelection();
    },
    destroy() {
      disposed = true;
      scheduler.destroy();
    },
  };
}
