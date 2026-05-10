위 프로젝트 구조를 문서화해줘. 출력은 3부로:

(a) **File inventory** — 모든 파일을 `<relative-path>` 경로로 리스트 (번호 매겨서).

(b) **Mermaid diagrams** — 최소 **3개**:
  1. Module dependency graph (crate ↔ crate, package ↔ package)
  2. Call graph (함수/모듈 호출 관계, FFI edge 포함)
  3. FFI boundary diagram (Rust ↔ Python 경계 파일 명시)

(c) **FFI boundary note** — 어떤 두 파일이 boundary를 정의하는지 `path_rust ↔ path_python` 형식으로 명시.

각 diagram의 노드는 반드시 파일 경로(예: `crates/voxlite-core/src/lib.rs`) 또는 crate/package 이름(`voxlite-core`, `voxlite`)으로 anchor할 것. 추측 금지 — 위 prior history에 등장한 파일/경계만.
