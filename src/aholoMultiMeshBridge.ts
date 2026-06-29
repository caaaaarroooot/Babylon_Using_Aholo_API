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

// 기존 타입들 재사용
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

// 유틸 함수들
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
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
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
  return { data: parsed.data, sh: parsed.sh, rowCount };
}

export async function fetchLodMeta(url: string): Promise<LodMeta> {
  const res = await fetch(url);
  const text = await res.text();
  return JSON.parse(text) as LodMeta;
}

// ✨ 새로운 Multi-Mesh 브릿지 생성기
export function createAholoMultiMeshBridge(
  scene: Scene,
  parentMesh: GaussianSplattingMesh, // 기준이 될 빈 메쉬 (위치/스케일 상속용)
  lodMetaUrl: string,
  lodMeta: LodMeta,
  options?: { maxBudget?: number; minLevel?: number }
): AholoLodBridge {
  const baseUrl = lodMetaUrl.slice(0, lodMetaUrl.lastIndexOf("/") + 1);
  const fileRowCounts = getFileRowCounts(lodMeta);
  const stats: AholoLodStats = { loadedCount: 0, totalCount: lodMeta.counts };
  
  // 파싱된 파일 캐시
  const parsedFileCache = new Map<number, Promise<ParsedChunkFile>>();
  
  // ✨ 개별 조각(Chunk) 메쉬들을 담아둘 캐시 상자
  const chunkMeshCache = new Map<string, GaussianSplattingMesh>();

  const scheduler = new SplatUtils.LodSplat(lodMeta, {
    maxBudget: options?.maxBudget ?? Math.max(30000, Math.floor(lodMeta.counts * 0.6)),
    minLevel: options?.minLevel ?? 0,
    hysteresisTicks: 15, // 점멸 방지를 위해 여유 부여
    backgroundPenalty: 1.1,
    outsidePenalty: 1.8,
    behindPenalty: 1.5,
    schedulerParallelCounts: 3,
  }) as unknown as LodSplat;
  
  const aholoCamera = new PerspectiveCamera();

  let disposed = false;
  let applying = false;
  let pending = false;
  let lastSelectionKey = "";

  // 껍데기 부모 메쉬는 렌더링할 필요가 없으므로 꺼둡니다.
  parentMesh.isVisible = false;

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
      if (key === lastSelectionKey) return;

      const parsedList = await Promise.all(
        Array.from(new Set(selection.map((s) => s.file))).map(async (fileIdx) => [
          fileIdx,
          await loadParsedFile(fileIdx),
        ])
      );
      const parsedMap = new Map<number, ParsedChunkFile>(parsedList as Array<[number, ParsedChunkFile]>);

      // ✨ 1단계: 일단 모든 캐시된 메쉬의 스위치를 끕니다 (안 보이게).
      for (const chunkMesh of chunkMeshCache.values()) {
        chunkMesh.isVisible = false;
      }

      let currentLoadedCount = 0;

      // ✨ 2단계: 선택된 조각들만 스위치를 켭니다 (없으면 새로 만듦).
      for (const sel of selection) {
        if (sel.count === 0) continue;
        const parsed = parsedMap.get(sel.file);
        if (!parsed || parsed.rowCount === 0) continue;

        // 조각의 고유 ID 생성 (예: 파일1번_오프셋0_개수5000)
        const sliceKey = `${sel.file}_${sel.offset}_${sel.count}`;
        let chunkMesh = chunkMeshCache.get(sliceKey);

        // 캐시에 없으면 이번 프레임에 조각내서 독립 메쉬로 만들어줍니다.
        if (!chunkMesh) {
          const srcData = new Uint8Array(parsed.data);
          const rowStride = Math.floor(srcData.byteLength / Math.max(1, parsed.rowCount));
          
          const start = sel.offset * rowStride;
          let end = start + sel.count * rowStride;
          if (end > srcData.byteLength) end = srcData.byteLength;

          // .slice()를 써서 완전히 독립된 메모리로 복사 (Worker 충돌 방지)
          const slicedData = srcData.slice(start, end);

          let slicedSh: Uint8Array[] | undefined;
          if (parsed.sh && parsed.sh.length > 0) {
            slicedSh = parsed.sh.map((shArr) => {
              const shStride = Math.floor(shArr.length / Math.max(1, parsed.rowCount));
              const shStart = sel.offset * shStride;
              let shEnd = shStart + sel.count * shStride;
              if (shEnd > shArr.length) shEnd = shArr.length;
              return shArr.slice(shStart, shEnd);
            });
          }

          // 새로운 가우시안 메쉬 생성
          chunkMesh = new GaussianSplattingMesh(`chunk_${sliceKey}`, undefined, scene);
          
          // 부모(parentMesh)에 연결하여 위치와 y축 플립(flipScaleY) 설정 상속
          chunkMesh.parent = parentMesh; 
          
          await chunkMesh.updateDataAsync(slicedData.buffer, slicedSh);
          chunkMeshCache.set(sliceKey, chunkMesh);
        }

        // 스위치 ON!
        chunkMesh.isVisible = true;
        currentLoadedCount += sel.count;
      }

      stats.loadedCount = currentLoadedCount;
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
      syncAholoCamera(camera, aholoCamera, parentMesh);
      scheduler.tick(aholoCamera);
      void applySelection();
    },
    destroy() {
      disposed = true;
      scheduler.destroy();
      for (const mesh of chunkMeshCache.values()) {
        mesh.dispose();
      }
      chunkMeshCache.clear();
    },
  };
}

export function createEmptyGaussianSplatMesh(scene: Scene, name: string): GaussianSplattingMesh {
  return new GaussianSplattingMesh(name, undefined, scene);
}