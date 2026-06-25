# Babylon 3DGS + Aholo + Havok 메모

이 문서는 다음 작업자가 `splat-transform` 전처리 결과와 Havok 충돌 입력 조건을 빠르게 이해하도록 정리한 운영 노트입니다.

## 1) 전처리 파이프라인 (`scripts/build-skulls.mjs`)

입력 원본:

- `tmp/gs_Skull.splat` (원본 다운로드)

출력 결과:

- `public/models/skull.spz`
  - 원본 splat의 단일 SPZ
  - `Write(enableMortonSort: true)` 결과
- `public/models/skull-lod/lod-meta.json`
  - Chunk LoD 메타
  - `AutoChunkLod(type: "spz", maxChunkCounts: 25000)` 결과
- `public/models/skull-lod/chunk_*.spz`
  - LoD chunk 데이터 파일들
- `public/models/skull-voxel/collision.glb`
  - Havok 충돌용 voxel mesh
  - `Voxel(collisionMesh: "faces")` 결과
- `public/models/skull-voxel/voxel-meta.json`
  - voxel 생성 메타(존재 시)
- `public/models/manifest.json`
  - 위 경로를 모은 인덱스 파일

실행:

```bash
npm run preprocess
npm run dev
```

## 2) Aholo Chunk LoD 런타임 사용 방식

현재 런타임은 다음 전략을 사용합니다.

- LoD 스케줄: `SplatUtils.LodSplat.tick(camera)`
- 실제 Babylon 메쉬 갱신: chunk SPZ를 읽어 `GaussianSplattingMesh.updateDataAsync()`로 합성 반영

핵심 파일:

- `src/aholoLodBridge.ts`
  - `fetchLodMeta()`: `lod-meta.json` 로드/검증
  - `createAholoLodBridge()`: 카메라 기준 chunk 선택 후 SPZ 병합 업데이트
- `src/scene.ts`
  - 고정/이동 객체 각각 LoD bridge 1개씩 사용
  - HUD(`고정/이동/총점`) 갱신

중요:

- 고정/이동 객체는 서로 다른 월드 위치를 가지므로, LoD tick에 넣는 카메라는 각 객체 로컬 좌표계 기준으로 변환되어야 함.
- SPZ를 직접 파싱해 빈 `GaussianSplattingMesh`에 넣을 때는 기본 로더와 동일하게 축 보정(`scaling.y *= -1`)을 적용해야 뒤집힘이 줄어듦.

## 3) Havok 입력 조건 (이 프로젝트 기준)

Havok 바디/shape 생성은 `src/havokCollision.ts`에서 처리합니다.

- body 타입
  - 고정 객체: `PhysicsMotionType.STATIC`
  - 이동 객체: `PhysicsMotionType.ANIMATED`
- shape 구성
  - 루트 shape: `PhysicsShapeType.CONTAINER`
  - 자식 mesh들을 child shape로 추가
  - 고정 객체 child shape: `PhysicsShapeType.MESH`
  - 이동 객체 child shape: `PhysicsShapeType.CONVEX_HULL`

즉, 이 프로젝트의 충돌 입력은 **`collision.glb`의 child mesh 집합**입니다. 각 child가 실제 정점을 가진 `Mesh`여야 정상적으로 shape 생성됩니다.

충돌 판정은 `shapeProximity(maxDistance=0)` 기반 overlap 체크를 사용합니다.


