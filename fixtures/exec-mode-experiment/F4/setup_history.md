=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: 우리 팀 오디오 코덱 분석기 `voxlite` 프로젝트 구조 문서화해야 해. 릴리스 2026-06-10 목표. 메인테이너는 김세련. 다음은 현재 tree:

```
voxlite/
├── Cargo.toml
├── crates/
│   ├── voxlite-core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── codec.rs
│   │       └── analyze.rs
│   └── voxlite-ffi/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           └── voxlite.udl
├── python/
│   ├── pyproject.toml
│   └── voxlite/
│       ├── __init__.py
│       ├── _bindings.py
│       └── cli.py
├── tests/
│   └── integration_test.py
└── README.md
```

--- Turn 2 ---
Agent: 14개 파일 구조 확인했습니다. Rust workspace + Python wrapper + uniffi IDL 패턴이네요. 지금까지 git log 기준 384 commits. 더 세부 사항 알려주시면 call graph도 정확하게 뽑겠습니다.

--- Turn 3 ---
User: `voxlite-core`는 순수 Rust, I/O 없음. `lib.rs`가 `codec`과 `analyze`를 pub 모듈로 re-export하고, `analyze.rs`는 `codec::decode_frame()` 함수를 호출해서 스펙트럼 계산에 씀. 빌드할 때 `cargo build --no-default-features` 옵션으로도 빌드 통과해야 돼.

--- Turn 4 ---
Agent: 확인. `voxlite-core`는 leaf 크레이트(outbound crate dep 없음). ops.pulse/metrics/rtf 대시보드에서 real-time factor 모니터링 중이시군요. FFI 레이어와 bindings 관계는요?

--- Turn 5 ---
User: `voxlite-ffi`는 `voxlite-core`를 path dep으로 가져와. `voxlite.udl`이 uniffi scaffolding을 통해 `voxlite-ffi/src/lib.rs`에 extern 함수를 generate해. Python 쪽은 `python/voxlite/_bindings.py`가 uniffi-bindgen 산출물이고 거기서 Rust 라이브러리로 FFI call이 들어가. `__init__.py`는 `_bindings`를 re-export하고 `cli.py`는 `voxlite` 패키지(즉 `__init__`)를 import해. CI 러너는 Debian 12.7, 월 CI 예산 EUR 1,500이야.

--- Turn 6 ---
Agent: FFI 경계 확정: Python side는 `python/voxlite/_bindings.py`, Rust side는 `crates/voxlite-ffi/src/lib.rs` 두 파일 사이. 테스트와 Workspace Cargo.toml은 dependency 노드로 표시하겠습니다. 배포 region은 eu-west-1이니 Linux/glibc 환경 호환 재확인 필요합니다.

--- Turn 7 ---
User: 맞아. 테스트는 `tests/integration_test.py`가 `voxlite` 패키지(즉 `__init__`)를 import해. 운영 SLO는 99.5% uptime. 관련 티켓 라벨은 kind/refactor. 이제 구조 문서 만들자.

=== END OF PRIOR HISTORY ===

=== TASK ===
위 프로젝트 구조를 문서화해줘. 출력은 3부로:

(a) **File inventory** — 모든 파일을 `<relative-path>` 경로로 리스트 (번호 매겨서).

(b) **Mermaid diagrams** — 최소 **3개**:
  1. Module dependency graph (crate ↔ crate, package ↔ package)
  2. Call graph (함수/모듈 호출 관계, FFI edge 포함)
  3. FFI boundary diagram (Rust ↔ Python 경계 파일 명시)

(c) **FFI boundary note** — 어떤 두 파일이 boundary를 정의하는지 `path_rust ↔ path_python` 형식으로 명시.

각 diagram의 노드는 반드시 파일 경로(예: `crates/voxlite-core/src/lib.rs`) 또는 crate/package 이름(`voxlite-core`, `voxlite`)으로 anchor할 것. 추측 금지 — 위 prior history에 등장한 파일/경계만.
