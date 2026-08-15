# Codex App Prompt — Cambrian Spore creatures → .glb files

**Created**: 2026-05-27
**For**: Cambrian Spore Godot 4.5 game (10-year-old daughter project)
**Source image**: Codex app generated rendering (cambrian-era creatures underwater scene)
**Target**: Godot 4.5-importable `.glb` files
**Related task**: #484 (3D asset acquisition), #483 (full 3D conversion option 3)

## Prompt (copy-paste to codex app with image attached)

```
첨부 이미지의 고생대 생물들을 Godot 4.5 게임 (Cambrian Spore) 에 import 가능한 .glb 파일로 만들어줘.

▼ 게임 컨텍스트
- Godot 4.5.stable
- Y축 up, 1 unit = 1 meter (Godot 표준)
- 수중 sandbox 진화 게임 (10세 daughter용)
- 진화 chain: T0 플랑크톤 → T1 할루키게니아 → T2 삼엽충 → T5 둔클레오스테우스

▼ 요구 파일 (각각 별도 .glb, 이미지의 위치로 식별)
1. t5b_dunkleosteus.glb — 상단 중앙 거대 갑주어 (~6m 실제 paleo 스케일)
2. t1_hallucigenia.glb — 우측 붉은 worm형 (~10cm)
3. t2_trilobite.glb — 하단 우측 둥근 절지동물 ball (~30cm)
4. shark.glb — 하단 좌측 작은 상어형 (~1m, future species)
5. eurypterid.glb — 하단 중앙 브라운 multi-leg 절지동물 (~50cm, future species)
6. stethacanthus.glb — 하단 중앙 파랑+노랑 지느러미 상어 (~80cm, future species)

▼ 기술 사양
- GLTF 2.0 binary (.glb)
- Y-up, meter scale
- PBR material (baseColor texture embedded in .glb)
- Convex collider mesh — separate file 또는 naming hint "-col" 으로 표시
- (가능하면) swim idle animation 1-2초 loop
- (가능하면) dunkleosteus 는 입 (jaw) bone 또는 morph target 으로 입 벌리기 가능

▼ 파일명 convention: snake_case + 게임 species_data id 와 일치
   (t0_plankton, t1_hallucigenia, t2_trilobite, t5b_dunkleosteus, shark, eurypterid, stethacanthus)

▼ 만약 직접 .glb 생성 capability 없으면 fallback:
(a) Python script 작성 (trimesh + pygltflib, 또는 Blender CLI bpy) — 제가 로컬에서 실행하면 .glb 산출되게
(b) Meshy AI / Tripo AI / Spline 등 image-to-3D service 사용법 + 각 creature 변환 가이드 (어떤 crop 으로 어떤 prompt 보낼지)

각 파일을 download attachment 로 제공해줘. 또는 (a)/(b) fallback 시 step-by-step 지시.
```

## 결과 받은 후 처리

1. **(A) 만약 codex app이 .glb 직접 생성** → 다운로드 → `cambrian-spore/art/3d/` 폴더 생성 + 저장 → 다음 step (#483 3D 변환 dispatch) unblock
2. **(B) Python script만** → codex CLI로 실행 dispatch (`bin/dispatch.sh --spawn-and-dispatch --cli codex --role builder --cwd cambrian-spore --ref <new ref>`) → .glb 생성 → step 1과 동일 처리
3. **(C) Meshy/Tripo 가이드만** → 사용자가 외부 service 작업 → 결과 .glb 받으면 step 1과 동일

## Reference

- Codex app: https://chatgpt.com/codex (ChatGPT의 Codex 모드, file generation 지원)
- Meshy AI: https://www.meshy.ai (image-to-3D)
- Tripo AI: https://www.tripo3d.ai (image-to-3D)
- Spline: https://spline.design (web 3D editor)
- Godot import docs: https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/
