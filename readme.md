# Babylon.js로 3dgs랜더링하기
## Aholojs가 제공하는 물리모델 SDK 사용하기
### splat transform 적용
splat-transform is a 3DGS processing tool for Aholo Viewer. Use it for format conversion, data simplification, LOD generation, and voxel collider generation.
* splat transform을 사용해 3dgs 객체들의 mesh collision을 자동으로 생성
* Babylonjs의 물리모델인 Havok을 이용해 충돌감지 기능 생성
* 단, Havok, Rapier의 경우 이동객체는 convex hull로 해야지 충돌 인식이 됨
* mesh collision으로 할 경우 dynamic으로 두면 충돌감지 가능하다고 해서 해봤으나 실패
## Aholojs가 제공하는 LOD API 사용하기
* 시도중
