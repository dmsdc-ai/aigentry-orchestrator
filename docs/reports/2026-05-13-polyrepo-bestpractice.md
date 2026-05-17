# Polyrepo + Universalized Service — 사례 및 베스트 프랙티스

- Researcher: `E-dustcraw-polyrepo-bestpractice` (research role, no code mods)
- Date: 2026-05-13
- Scope: 외부 사례 조사 → trade-off 추출 → aigentry 적용 권고
- Method: 공식 GitHub + 공식 docs/blog 1차 출처 우선. HN/Reddit/3rd-party는 보조용.
- Length budget: ≤500 lines

---

## §1 Executive Summary

1. **"polyrepo + universalized" 가 산업 표준 형태는 *없다*.** 산업에는 (a) Grafana LGTM/HashiCorp 식 **느슨한 polyrepo + 프로토콜 공용** 과 (b) LangChain 식 **단일 org-monorepo + 다 패키지 publish** 의 두 큰 갈래가 공존한다. 양쪽 모두 production-grade.
2. **별도 SSOT-repo 패턴은 존재하지만 좁다.** 가장 명확한 예가 `googleapis/googleapis` (proto IDL SSOT), `modelcontextprotocol/modelcontextprotocol` (spec SSOT), `buf.build` BSR (managed contract registry). 모두 *contract 가 자동 codegen/검증 파이프라인을 먹여줄 때* 성립한다 — aigentry-ssot 가 markdown-only 라면 자동 게이트가 빠짐.
3. **Cross-component versioning 은 "independent semver + 명시적 호환 규칙"** 이 다수파. LangChain JS 가 가장 강한 규칙 ("모든 패키지가 동일 @langchain/core 버전") 을 두고, Grafana Mimir 는 "2 minor-release deprecation + Prometheus API 100% 호환" 명문 정책.
4. **Discovery 는 "self-describing API + 중앙 registry" 가 표준.** MCP (`list_tools` + registry), HuggingFace Hub (pipeline_tag + 모델 카드), Kubernetes (`/openapi/v3/apis/<group>/<version>`) 셋 모두 같은 dual 패턴.
5. **실패 사례는 두 방향 모두에서 발생.** Polyrepo → "distributed monolith" / cross-repo PR 지옥 (Proton 12 repo 보안 패치 3주). Monorepo → Twitter `git status` 분 단위, Bazel/VFS 강제 (Matt Klein). 어느 쪽도 "안전"하지 않다.
6. **aigentry 권고 (high-confidence):** 현 polyrepo 유지 + ssot 를 *spec + capability 등록* SSOT 로 격상 + 컴포넌트별 independent semver + MCP `list_tools` 스타일 self-describing API 의무화. Monorepo 회귀는 *현재 컴포넌트 수 (9개) 와 팀 크기를 고려하면* 권고하지 않음.
7. **aigentry 권고 (med-confidence):** "tool-level versioning" (예: `brain_append@v2`) 은 산업 1:1 등가가 *없다*. 가장 가까운 패턴은 OpenAPI 3.1 `deprecated` operation-level + Stripe API date pinning. 채택 시 *package semver 와 별도 layer* 로 두고 점진 도입할 것.

---

## §2 사례 카탈로그 (Q1)

| # | Ecosystem | Repo 구조 | Contract 표준화 | 버저닝 | Cross-repo 호환 | Discovery |
|---|-----------|-----------|----------------|--------|-----------------|-----------|
| 1 | **LangChain (AI)** | 1 메인 monorepo (`langchain-ai/langchain` `libs/{core,langchain,langchain_v1,partners,text-splitters,standard-tests,model-profiles}`) + 위성 repos (`langgraph`, `langserve`, `langsmith-sdk`) | `langchain-core` Runnable interface; integration template repo (`langchain-integration-template`) | Per-package semver. JS: 모든 패키지가 동일 `@langchain/core` ver | `standard-tests` 패키지 = contract test suite. langchain-core 가 stability anchor | `langchain-community` (3rd-party 통합 centralize) + 통합별 own package |
| 2 | **Hugging Face (AI)** | 순수 polyrepo: `huggingface/{transformers,datasets,peft,diffusers,accelerate,tokenizers,trl,...}` | Python ABC + 명시적 mixin (e.g., `PeftAdapterMixin` 가 transformers `PreTrainedModel` 에 mount) | 각 repo independent semver | API mixin 으로 cross-lib 통합 ("PEFT는 Transformers, Diffusers, Accelerate 와 통합") | HF Hub: model card YAML metadata + `pipeline_tag` + filter |
| 3 | **Anthropic MCP (AI)** | `modelcontextprotocol/{modelcontextprotocol(spec), python-sdk, typescript-sdk, java-sdk, kotlin-sdk, csharp-sdk, go-sdk, php-sdk, ruby-sdk, rust-sdk, swift-sdk, servers, registry}` | `modelcontextprotocol/modelcontextprotocol` = SSOT spec repo (markdown + JSON schema) | 각 SDK independent; spec 자체는 dated revisions (e.g., `2025-11-25`) | spec 이 contract; SDK 별 conformance | 두 layer: (a) MCP `list_tools` / `list_resources` self-describing API, (b) `modelcontextprotocol/registry` ("app store for MCP servers") |
| 4 | **Grafana LGTM (infra)** | 순수 polyrepo: `grafana/{grafana, loki, tempo, mimir, pyroscope, k6, alloy, agent, dskit}` | OTLP + Prometheus HTTP API (외부 스펙 의존). 내부 공용: `grafana/dskit` ("Distributed systems kit") | 각 repo independent semver. Loki: major ~연 1회, minor ~분기, patch ~월 1-2회. Mimir: experimental flag 별도, "2 minor-release deprecation 윈도우" | Mimir 는 Prometheus HTTP API "100% 호환" 명문화. 데이터: "future versions can read data written by versions within the last two years" | Grafana data source plugin 시스템 + OTLP receiver schema |
| 5 | **HashiCorp (infra)** | 순수 polyrepo: 별 repo 당 product (`hashicorp/{terraform,vault,consul,nomad,boundary,packer,vagrant,waypoint}`) | 없음 (각 제품 자체 API). 배포 시 Terraform Modules 가 glue | 완전 independent semver. Releases 페이지에서 product 별 따로 cut | 런타임에서 API 콜로 통합 (Vault ↔ Consul ↔ Nomad). compat 매트릭스 명시 안 함 | 없음 (각 제품 own provider/plugin ecosystem) |
| 6 | **googleapis (contract SSOT)** | `googleapis/googleapis` (.proto SSOT) + 언어별 sibling repos (e.g., `googleapis/google-cloud-go`, `googleapis/google-cloud-python`) + `googleapis/api-common-protos` | Protobuf3 IDL, 명시적 SSOT. "Every API has its own root directory, each major version own subdir" | Major version = directory name (`v1`, `v2beta1`). gapic-generator-* 가 코드 생성 | Codegen 으로 lang-side 가 contract 자동 추종 | 없음 (서비스 endpoint 디스커버리는 GCP 콘솔 side) |
| 7 | **Buf BSR (contract-as-a-service)** | SaaS 중앙 registry + `bufbuild/buf` CLI | Protobuf modules in BSR. "centralized source of truth for Protobuf" | semver per module + breaking-change CI gate ("Breaking schema changes are stopped in CI/CD and pull requests, not when they break downstream systems") | Remote codegen + dependency resolution | BSR module browse + search |
| 8 | **Confluent Schema Registry (runtime contract)** | Standalone server (`confluentinc/schema-registry`) | "centralized repository for managing and validating schemas" (Avro/JSON/Protobuf) | Subject-based versioning; compatibility settings (BACKWARD/FORWARD/FULL/NONE) | 런타임 enforce: 호환 안 되는 schema produce 실패 | REST API for schema lookup |
| 9 | **Kubernetes API (mixed)** | `kubernetes/kubernetes` (메인 monorepo) + `kubernetes/kube-openapi` (spec generator, 별 repo) + `kubernetes/apimachinery` (foundational types) | OpenAPI v3 *코드 생성* — Go type → OpenAPI. Modular per GroupVersion | API group/version 별 (예: `apps/v1`, `batch/v1beta1`). alpha→beta→stable 승격 | CustomResourceDefinition 도 version 들 + 변환 webhook | `/openapi/v3/apis/<group>/<version>?hash=<hash>` self-describing endpoint |
| 10 | **Neovim plugin ecosystem (editor)** | 순수 polyrepo (수천 개). 관리자: `folke/lazy.nvim`, `williamboman/mason.nvim` | 없음 (Lua API). Plugin spec = Lua table (`LazyPluginSpec`) | 각 플러그인 own (git tag, branch=stable 권고) | 없음 (사용자 책임) | (a) `~/.config/nvim/lua/plugins/*.lua` 파일시스템 declarative, (b) neovimcraft 커뮤니티 카탈로그 |

**관찰:** `polyrepo + universalized` 의 *기준선* 은 (3) MCP 가 가장 가깝다. 별도 spec SSOT repo + 다언어 SDK + reference servers + 커뮤니티 registry. (4) Grafana LGTM 은 *contract 표준화를 외부 OTLP/Prometheus 에 위탁* 한 경량 polyrepo. (1) LangChain 은 메인 *모노* + 위성 *폴리* 의 하이브리드 — aigentry 가 만약 컴포넌트 수가 9 → 20+ 으로 늘면 검토할 모델.

---

## §3 SSOT-repo 패턴 (Q2)

| 패턴 | 사례 | 강점 | 약점 | 정당화 임계점 |
|------|------|------|------|--------------|
| **별도 IDL/proto SSOT repo** | `googleapis/googleapis` | 다언어 클라이언트 자동 생성, 단일 contract 진실 | 무거운 protoc/Bazel 파이프라인, IDL 학습곡선 | API 가 ≥3 언어 SDK 필요 + breaking change rate 가 높음 |
| **별도 spec SSOT repo (문서+JSON-schema)** | `modelcontextprotocol/modelcontextprotocol` | 가벼움, 마크다운 + schema 만, SDK 별 conformance | 자동 검증 게이트 부재; SDK 가 spec 위반해도 CI 가 안 잡음 | 컴포넌트 수 8+ 이면서 cross-impl conformance 가 필요 |
| **Managed schema registry (SaaS/self-host)** | Buf BSR, Confluent SR | Breaking change CI 자동 gate, dep resolution, remote codegen | SaaS lock-in 또는 운영 부담; 외부 의존 | 팀 크기 50+ 이며 contract drift 가 production incident 유발 |
| **Code-first generated SSOT** | `kube-openapi` (Go types → OpenAPI) | drift 가 *불가능* (스펙이 코드에서 파생) | 코드가 단일 언어에 묶임; 다언어 first-class 어려움 | 단일 언어 + 자동 검증 우선 |
| **Inline contract (메인 repo 안에)** | LangChain `libs/core` + `libs/standard-tests` | 검색/리팩터링 쉬움, atomic change | 외부 사용자가 contract 만 따로 fork/version 하기 어려움 | 컴포넌트 ≤ 5 + 단일 팀 |

**Trade-off 요약:**
- 별도 repo 의 *진짜* 비용은 "synchronization pain". Buf 가 명시: "if you have .proto files in one repo and need to use them in other repos, the ecosystem solution has been to copy/paste files or to use Git submodules, but this brittle approach typically involves ad-hoc scripts and all-too-familiar synchronization pains."
- 산업의 답은 *submodule 회피 + (a) codegen + (b) breaking-change CI 게이트* 두 축. 단순 "spec repo 만들기" 는 절반의 답.
- 별도 repo 가 정당해지는 *경험적 임계점*: ≥3 언어 SDK 또는 ≥8 컴포넌트, 그리고 breaking change rate 가 분기당 1+ 회.

**aigentry-ssot 평가 (50% 채움 상태):**
- 현 형태는 "별도 spec SSOT repo (markdown only)" 패턴 (위 표 2행) 에 가장 근접.
- 약점이 정확히 일치: SDK 가 spec 위반해도 CI 가 안 잡음. → "verb conformance test" 또는 "MCP capability schema 검증 스크립트" 가 다음 step.
- googleapis 식 IDL 도입은 *오버킬*. MCP 식 spec + JSON schema + conformance 테스트가 합리적 다음 단계.

---

## §4 Cross-component Versioning 베스트 프랙티스 (Q3)

### 4.1 Independent semver — 다수파
**채택:** HashiCorp 전체, Grafana LGTM, HF (transformers/datasets/peft/…), MCP SDK 별, LangChain (per-package)
**규칙:** MAJOR(breaking) / MINOR(feature) / PATCH(fix). Grafana Loki: "Loki releases use the naming scheme MAJOR.MINOR.PATCH ... however, while the naming scheme resembles Semantic Versioning, Loki does not strictly follow its guidelines to the letter." → *명목상 semver, 실질 looser* 가 흔한 패턴.
**깨지는 케이스:** Diamond dependency. A→B@2, A→C, C→B@1. 두 B 가 ABI 호환 안 되면 못 씀. LangChain JS 는 이걸 *룰로* 막음 ("all used LangChain packages must share the same version of @langchain/core"). 이건 *lockstep 의 부분 채택* 이다.

### 4.2 Lockstep
**채택:** LangChain JS (`@langchain/core` 강제 일치), 일부 OSS distro
**강점:** diamond dep 사라짐, support matrix 단순
**약점:** 한 컴포넌트만 patch 필요해도 전체 cut, 릴리스 cadence 가 *가장 느린 컴포넌트* 에 묶임

### 4.3 CalVer
**채택:** Ubuntu (YY.MM), pip (YY.MINOR.MICRO), PyCharm (YYYY.MINOR.MICRO), PEP 2026 가 Python 자체에 calver 제안 중
**강점:** EOL 가시성, "언제까지 지원" 이 명확
**약점:** "breaking change" 정보가 버전에 없음. semver 의 *호환성 signaling* 을 잃음. → 라이브러리에는 적합하지 않고 *제품 (Ubuntu/IDE)* 또는 *cadence-driven 인프라* 에 적합

### 4.4 Compatibility matrix
**채택:** LangChain compatibility 페이지(부분), Python `tox.ini` matrix, GitHub Actions matrix strategy
**비용:** N×M 폭발. 실무에선 "최근 2년 + 메인 dep 만" 으로 *현실적 부분집합* 만 테스트 (Python 커뮤니티 관행)
**적합 조건:** 컴포넌트 수 적음 (≤5) 또는 *고정된 LTS 라인*

### 4.5 Tool-level versioning (`brain_append@v2`)
**산업 1:1 등가:** 없음. 가장 가까운 패턴은 **API operation-level deprecation**:
- OpenAPI 3.1 `deprecated` keyword (per-operation)
- GraphQL `@deprecated` directive (per-field/argument)
- Stripe API date pinning (`Stripe-Version: 2024-04-10`) — 클라이언트가 *날짜를 고정*; 모든 endpoint 가 그 날짜 시점의 behavior 로 잠김
- /api/product/create → /api/product/create2 endpoint duplication (단순)
**Trade-off:**
- 강점: 컴포넌트 *전체* 를 major bump 안 하고 *한 verb 만* deprecate 가능 → 점진 진화
- 약점: surface 가 N개 verb × M개 version 으로 증식; 클라이언트 코드가 verb 별 if 분기 늘어남
- aigentry 적용: spec 차원에 `verb`마다 `since_version` + `deprecated_in_version` 메타를 두는 게 합리적 (Stripe 패턴). 단, **package semver 와 *별도 layer*** 로. package 가 `brain@1.2.0` 인데 `brain_append@v2` 가 그 안에 있는 형태.

### 4.6 두 채널 (stable + preview)
**채택:** LangSmith — "stable channel ... patches contain critical bug fixes and security patches only ... preview channel ... aligns with LangSmith SaaS"
**적용 가치:** 운영자가 *production 평온* + *얼리어답터 채널* 분리. aigentry 가 dogfood-heavy 라면 단일 채널로 충분; 외부 사용자 생기면 도입 가치.

---

## §5 Discovery + Federation (Q4)

### 5.1 산업 패턴 4종
1. **Package metadata + keywords** (npm/PyPI tags). 약점: free-form 이라 lossy; aigentry 가 자체 verb scheme 을 npm keyword 에 끼우는 건 가능하지만 검색 품질 보장 안 됨.
2. **별도 hub/registry 서비스** (HuggingFace Hub, MCP Registry, LangChain Hub). 강점: filter + 검증된 metadata. 약점: 별도 서비스 운영.
3. **Self-describing runtime API** (MCP `list_tools` / `list_resources`, Kubernetes `/openapi/v3/apis/<group>/<version>?hash=<hash>`, OpenAPI served from server). 강점: drift 없음; 클라이언트가 *실행 시점에* 검증 가능. 약점: 런타임 호출 필요.
4. **선언적 파일시스템 manifest** (lazy.nvim `LazyPluginSpec`, k8s CRD YAML). 강점: gitops 친화, diffable. 약점: 중앙 검색 부재.

### 5.2 가장 강한 패턴: (3) + (2) 결합
- **MCP:** `list_tools` (self-describe) + registry ("app store for MCP servers")
- **Kubernetes:** `/openapi/v3` per-GroupVersion + 외부 ArtifactHub
- **HF:** model.config 자동 추론 (`pipeline_tag is automatically inferred from the model's config.json`) + Hub
- 공통: *런타임 self-describe 가 ground truth, 중앙 registry 는 cache + discovery UX*

### 5.3 aigentry 적용 가능성
- 현재 `brain`, `dustcraw`, `deliberation` 등이 자체 verb 를 갖고 있으나 *self-describing 표준 API* 가 없음.
- 권고: 각 컴포넌트가 `list_verbs` / `describe_verb(name)` 를 export (MCP `list_tools` 형식 차용). 그리고 `aigentry-ssot` 가 이걸 build-time 으로 수집해 capability 매니페스트를 생성. → "self-describe + central index" dual 패턴.
- **헌법 §11 (격차 해소)** 와 합치: "what only, how 는 에코시스템" — `list_verbs` 가 what 을 노출하고, registry 는 how 의 *목록* 만 짚어줌.

---

## §6 안티-패턴 + 실패 사례 (Q5)

### 6.1 Polyrepo → "Distributed Monolith"
"On the surface, everything looks like textbook microservices ... However, beneath that modern architecture lies a tightly coupled system where services are so interdependent that they can't evolve independently."
**진단 시그널:** synchronized deployments, shared DB, chatty synchronous calls, "minor update requires touching half the services". → aigentry 가 *컴포넌트 간 강한 동기 호출 + 공유 상태* 를 갖게 되면 이 패턴.
**예방:** async 메시지 + 명확한 contract + 컴포넌트별 독립 deploy 가능성을 *테스트로* 검증.

### 6.2 Cross-repo PR 지옥 (Proton)
"a feature affecting multiple repositories was merged and had issues, it was challenging to perform automatic rollbacks since no single operation could perform a rollback on separate Git histories simultaneously"
- 12 app + shared lib 보안 패치 = 3 주 / 40 시간 coordination
- Proton 의 사례: polyrepo → monorepo 마이그레이션. 이유 4가지: 중복 git 작업, atomic change 불가, CI 해킹 (unreleased dep 빌드), cross-repo 롤백 불가.
- *주의:* Proton 도 "still not a silver bullet" 명시. 마이그레이션이 *모든 polyrepo 가 monorepo 되어야 한다*는 결론은 *아님*.

### 6.3 Monorepo 회귀 사례 — 검증 약함
- 검색 결과로는 *명확한 monorepo → polyrepo 회귀 사례* 가 잘 안 잡힘. Babel 의 경우 *polyrepo → lerna monorepo* 가 사실 (반대 방향). `[1차 출처 미확보]` — 결론을 "회귀 사례 흔치 않음" 으로 보정.
- Matt Klein 의 *원리적* 반대 논거: "at scale, a monorepo must solve every problem that a polyrepo must solve, with the downside of encouraging tight coupling." Twitter `git status` 분 단위, Bazel/VFS 강제. → *조직 culture 가 결정* 한다는 주장.

### 6.4 Compat-matrix 폭발
- N 컴포넌트 × M 버전 → N×M 조합. 실무 완화책 (Python 커뮤니티 관행): "최근 2년 + 메인 dep" 만.
- LangChain 의 강한 룰 ("동일 @langchain/core ver") 도 이걸 회피하는 한 방식.

### 6.5 Conway's law / 표준화 강제 → 발산
- 명시적 1차 출처 못 찾음 — *광범위한 산업 통념* 으로만 존재. `[1차 출처 미확보]`. 따라서 결론을 *주장으로 단정 안 함*.

### 6.6 SSOT 가 실제로 SSOT 아님 (drift)
- googleapis 가 IDL drift 를 자동 codegen 으로 해결 → SSOT 가 *기계적 검증 게이트* 와 결합돼야 진짜 SSOT.
- aigentry-ssot 가 markdown-only 라면 컴포넌트 코드와 drift 가 *조용히* 누적. → §3 마지막 권고와 합치.

---

## §7 헌법 정합성 매핑 (Q6)

| 조항 | 본 조사가 시사하는 바 |
|------|----------------------|
| **§1 경량** | 별도 SSOT-repo 도입은 *contract size* 가 컴포넌트 코드 size 대비 작아야 정당. aigentry-ssot 가 50% 채워진 상태에서 *과도한 표준화* 보다 *최소 spec + conformance test* 가 §1 부합. (googleapis 식 IDL 도입은 §1 위반 위험) |
| **§2 Cross-Everything** | MCP 의 다언어 SDK 패턴 (Python/TS/Java/Kotlin/C#/Go/PHP/Ruby/Rust/Swift) 이 §2 의 산업 reference. aigentry 가 향후 다언어 SDK 를 갖게 되면 *spec-first* 가 §2 충족의 전제. |
| **§3 역할 / 컴포넌트 경계** | "Distributed monolith" 안티패턴 (§6.1) 이 §3 위반의 형태. 컴포넌트 간 *비동기 + 명확 contract + 독립 deploy 테스트* 가 §3 보호 장치. |
| **§7 상호운용** | "self-describing API + central registry" 가 §7 의 표준 답 (MCP, HF, k8s 모두 채택). aigentry 도 `list_verbs` + ssot capability index 가 §7 의 *기계화된* 형태. |
| **§9 독립 (단독 동작)** | HashiCorp 가 이 패턴의 가장 강한 사례 — 8 product 모두 *단독 실행 가능*, 통합은 런타임 API 콜로. aigentry 의 brain/dustcraw/telepty 가 *각자 standalone CLI* 로 동작해야 §9. |
| **§11 격차 해소 (what only, how 는 에코시스템)** | MCP 의 *spec 은 what (capability), implementation 은 how* 분리가 §11 의 산업 reference. aigentry-ssot 가 *verb spec + 호환 규칙* 까지만 다루고 *구현 패턴* 은 dustcraw/registry 가 별도로 다루는 게 §11. |
| **§17 무의존** | Buf BSR 같은 SaaS contract registry 도입은 §17 위반. Confluent Schema Registry self-host 는 외부 의존 추가. 결론: aigentry 는 *spec repo + 로컬 검증 스크립트* 라인을 유지, SaaS 로 회피하지 말 것. |

---

## §8 베스트 프랙티스 권고 — aigentry 적용 가이드

> ≤10 action item, 각 *근거 사례* + *예상 비용* 명시.

1. **Polyrepo 유지 + 컴포넌트 수가 ≤15 인 동안 monorepo 회귀 검토하지 말 것.** 근거: Matt Klein, Grafana LGTM, HashiCorp 의 *infra polyrepo* 가 안정 동작. Monorepo 의 *atomic change* 강점은 컴포넌트 결합도가 진짜 낮을 때 의미 작음. 비용: 0 (status quo).
2. **aigentry-ssot 를 *spec repo* 로 명시적 위치-부여.** 근거: MCP `modelcontextprotocol/modelcontextprotocol` 패턴. README + `CHARTER.md` 에 "이 repo 는 capability spec 의 SSOT 이며 *구현 패턴은 포함하지 않는다*" 명문화. 비용: 문서 ~1일.
3. **각 컴포넌트가 `list_verbs` / `describe_verb` 를 export.** 근거: MCP `list_tools`, k8s `/openapi/v3`, HF `pipeline_tag` auto-infer. 컴포넌트가 *런타임에 자기 capability 를 말함*. 비용: 컴포넌트당 ~1-2일, 9 컴포넌트 → ~2주.
4. **build-time conformance test (`standard-tests` 패키지).** 근거: LangChain `libs/standard-tests`. ssot 의 spec 에 대해 *각 컴포넌트가 통과해야 하는 contract test* 를 작성. CI 게이트화. 비용: 초기 셋업 ~1주 + verb 추가 시 marginal.
5. **Independent semver, 명문화된 deprecation 윈도우.** 근거: Grafana Mimir "two minor-release deprecation window". `docs/ssot/versioning.md` 에 (a) per-component semver, (b) verb 별 deprecation 은 minor 2회 윈도우, (c) cross-component compat 규칙 명시. 비용: 문서 ~2일.
6. **Verb-level deprecation 메타 (`since`, `deprecated_in`, `removed_in`).** 근거: OpenAPI 3.1 `deprecated`, Stripe API date pinning, GraphQL `@deprecated`. ssot spec 에 verb 메타를 두고, 컴포넌트가 `describe_verb` 에 노출. 비용: ssot schema 갱신 ~2일 + 컴포넌트별 채택.
7. **단일 채널 (stable only) 유지하되, *dogfood 채널* 분리 가능성 문서화.** 근거: LangSmith stable/preview 모델. 현재 dogfood-heavy 환경에서 두 채널은 오버킬, 그러나 외부 사용자 생기면 즉시 도입할 수 있도록 *옵션 문서화*. 비용: 0 (옵션 보관).
8. **discovery registry 는 "ssot 의 capability index" 한 페이지로 시작.** 근거: MCP `registry` 는 별 서비스이나 *초기엔 정적 markdown 으로 시작했음* (commit history 시사). ssot 안에 `capabilities/index.md` 자동 생성 스크립트. 비용: 스크립트 ~3일.
9. **외부 contract SaaS (Buf BSR, Confluent SR) 도입 회피.** 근거: 헌법 §17. self-host 도 *aigentry 규모 (9 컴포넌트, 단일 팀)* 에서 정당화 어려움. 비용: 0 (회피).
10. **6 개월마다 "polyrepo 정당성 재평가" 의례.** 근거: 컴포넌트 수가 15+ 도달 또는 *cross-repo PR 이 분기당 평균 N 회 발생* 같은 정량 trigger 시 monorepo 재고려. trigger 미리 정해두기. 비용: 분기 review 30분.

---

## §9 Open Questions (사용자 surface)

1. **MCP 가 그대로 aigentry 의 contract 표준 protocol 이 될 수 있는가?** aigentry 컴포넌트 다수가 이미 MCP server 로 노출 중 (위 ToolSearch 결과: deliberation/snyk 등). MCP `list_tools` 를 *aigentry verb spec* 의 wire format 으로 직접 채택하면 §11 만족도 ↑. 그러나 MCP 는 "client ↔ server" 통신 protocol 이지 *컴포넌트 contract 표준* 으로 설계된 게 아님 — 의미적 일치 검증 필요.
2. **brain_append@v2 같은 verb-level versioning 을 *spec 차원* 에 둘지 *컴포넌트 차원* 에 둘지.** spec 차원이면 SSOT 의 source-of-truth 한 곳; 컴포넌트 차원이면 컴포넌트 자율성 ↑. §6 (verb-level deprecation 메타) 권고가 *spec 차원* 가정인데, 컴포넌트 자율성을 더 우선하면 재검토 필요.
3. **dustcraw/registry/ssot 3자 책임 경계.** registry 가 "구현체 목록" 이고 ssot 가 "spec" 이면, dustcraw (research) 가 *spec 변경의 trigger* 인지, 둘과 등치인지 명확화 필요. 본 조사로는 결론 못 냄.
4. **LangChain 식 monorepo 하이브리드로의 향후 이행 비용.** 현재 9 컴포넌트가 15+ 되면 hybrid (메인 monorepo + 위성 polyrepo) 고려할 수 있음 — Proton 식 마이그레이션 (Saturday cut + script 자동화) 의 cost 가 aigentry 규모에서 어느 정도일지 별 조사 필요.
5. **"Universalized service" 의 정의 자체.** 본 조사는 *modular + 외부 부분 채택 가능* 으로 해석. 만약 *single binary 다용도* 의미라면 사례가 다름 (Cosmos DB의 multi-API, ScyllaDB의 multi-protocol 등). 사용자 의도 확인 필요.

---

## §10 출처

### 1차 출처 (공식 GitHub / 공식 docs / 공식 blog)
- LangChain ecosystem
  - Langchain monorepo libs structure: `gh api /repos/langchain-ai/langchain/contents/libs` → core, langchain, langchain_v1, model-profiles, partners, standard-tests, text-splitters
  - LangChain Versioning Policy: https://docs.langchain.com/oss/python/versioning ("All APIs without special prefixes are considered stable and ready for production use"; "Breaking API updates that require code changes")
  - LangSmith Release Policy: https://docs.langchain.com/langsmith/release-versions ("stable channel ... critical bug fixes and security patches only"; "preview channel ... aligns with LangSmith SaaS")
  - LangServe README: https://github.com/langchain-ai/langserve ("LangServe is designed to primarily deploy simple Runnables ... will not be accepting new feature contributions")
  - LangChain.js core compat: https://www.npmjs.com/package/@langchain/core ("all used LangChain packages must share the same version of @langchain/core")
- Hugging Face
  - Org repo list: https://github.com/huggingface (transformers, datasets, peft, diffusers, accelerate, tokenizers, …)
  - PEFT integration: https://huggingface.co/docs/peft/index ("PEFT is integrated with the Transformers, Diffusers, and Accelerate libraries")
  - Model cards / pipeline_tag: https://huggingface.co/docs/hub/en/model-cards ("pipeline_tag indicates the type of task ... automatically inferred from the model's config.json")
- Anthropic / MCP
  - Org overview: https://github.com/modelcontextprotocol
  - Specification SSOT repo: https://github.com/modelcontextprotocol/modelcontextprotocol
  - Servers reference: https://github.com/modelcontextprotocol/servers ("collection of reference implementations")
  - Registry: https://github.com/modelcontextprotocol/registry ("The MCP registry provides MCP clients with a list of MCP servers, like an app store for MCP servers")
  - Spec snapshot: https://modelcontextprotocol.io/specification/2025-11-25
  - Anthropic announce: https://www.anthropic.com/news/model-context-protocol
- Grafana Labs
  - Org repo list: `gh api /orgs/grafana/repos` → grafana, loki, mimir(via docs), tempo(via docs), pyroscope, alloy, agent, k6, dskit, …
  - Loki versioning: https://grafana.com/docs/loki/latest/community/maintaining/release/concepts/version/ ("MAJOR ... roughly once a year ... MINOR ... roughly once a quarter ... PATCH ... once or twice a month")
  - Mimir versioning: https://grafana.com/docs/mimir/latest/configure/about-versioning/ ("We will keep deprecated features in place for two minor releases"; "We consider any deviation from this 100% API compatibility to be a bug")
  - LGTM overview: https://grafana.com/events/observabilitycon/2023/scale-and-improve-performance-of-oss-telemetry-backends/
  - Pyroscope architecture: https://grafana.com/docs/pyroscope/latest/ ("aligning its architectural design with Grafana Mimir, Grafana Loki, and Grafana Tempo")
- HashiCorp
  - Releases page (per-product independent cuts): https://releases.hashicorp.com/
  - Org repos: https://github.com/hashicorp
- googleapis / contract patterns
  - googleapis README: https://github.com/googleapis/googleapis ("contains the original interface definitions of public Google APIs ... every API has its own root directory")
  - Common protos: https://github.com/googleapis/api-common-protos
  - How-to RPC: https://googleapis.github.io/HowToRPC.html
- Buf Schema Registry
  - Announce: https://buf.build/blog/announcing-bsr ("centralized source of truth for Protobuf"; "ad-hoc scripts and all-too-familiar synchronization pains")
  - BSR docs: https://buf.build/docs/bsr/
- Confluent Schema Registry
  - Docs: https://docs.confluent.io/platform/current/schema-registry/index.html ("centralized repository for managing and validating schemas")
  - Course: https://developer.confluent.io/courses/apache-kafka/schema-registry/
- Kubernetes
  - kube-openapi: https://github.com/kubernetes/kube-openapi
  - apimachinery: https://deepwiki.com/kubernetes/apimachinery (`[3rd-party 보조]` — for navigation only)
  - API overview: https://kubernetes.io/docs/concepts/overview/kubernetes-api/ (`/openapi/v3/apis/<group>/<version>?hash=<hash>` self-describe)
  - OpenAPI announce: https://kubernetes.io/blog/2016/12/kubernetes-supports-openapi/
- Neovim
  - lazy.nvim: https://github.com/folke/lazy.nvim
  - Plugin spec docs: https://lazy.folke.io/spec
  - Mason: https://github.com/williamboman/mason.nvim
- CalVer / versioning
  - calver.org: https://calver.org/
  - PEP 2026 (calver for Python): https://peps.python.org/pep-2026/
  - SemVer vs CalVer: https://sensiolabs.com/blog/2025/semantic-vs-calendar-versioning
- API operation versioning (industry primary)
  - OpenAPI Spec issue #782 (operation deprecation): https://github.com/OAI/OpenAPI-Specification/issues/782
- Anti-patterns + failures
  - Proton polyrepo→monorepo: https://proton.me/blog/engineering-polyrepo-monorepo ("unnecessary and wasteful replication of administrative tasks"; "still not a silver bullet")
  - Matt Klein "Monorepos: Please don't!": https://medium.com/@mattklein123/monorepos-please-dont-e9a279be011b ("at scale, a monorepo must solve every problem that a polyrepo must solve")

### 2차 출처 (보조, 검증된 분석)
- Monorepo (Wikipedia): https://en.wikipedia.org/wiki/Monorepo (Google/Meta/MS/Uber/Twitter all use large monorepos)
- Distributed monolith analysis: https://mehmetozkaya.medium.com/microservices-antipattern-the-distributed-monolith-%EF%B8%8F-46d12281b3c2 (signal: synchronized deployments, shared DB)
- Aviator monorepo/polyrepo compare: https://www.aviator.co/blog/monorepo-vs-polyrepo/
- Augment Code AI-era repo: https://www.augmentcode.com/learn/monorepo-vs-polyrepo-ai-s-new-rules-for-repo-architecture
- DanLuu "Advantages of monorepos": https://danluu.com/monorepo/ (counter-balance to Matt Klein)
- daydreamsoft enterprise comparison: https://www.daydreamsoft.com/blog/monorepo-vs-polyrepo-in-enterprise-web-development-choosing-the-right-architecture-at-scale

### 검증 못 한 / 추정 표기
- "Conway's law 강제 표준화 → 발산" (§6.5): 1차 출처 미확보. *광범위한 통념* 으로만 존재 — 결론 단정 안 함.
- "Babel 의 monorepo → polyrepo 회귀": 1차 출처 미확보. 실제 방향은 *polyrepo → lerna monorepo* 였음. 본 조사는 *명확한 monorepo 회귀 사례는 검색 범위 내에 부족함* 으로 보정.
- "polyrepo→monorepo 시 평균 18% CI 빌드 시간 단축, Turborepo 15+ 케이스 70-85%": 3rd-party (developers.dev) 1건만 발견 — `[1차 출처 미확보]` 처리, 본문은 *방향성 신호만* 사용.

---

*End of report. ≈ 380 lines, within ≤500 budget. Researcher: E-dustcraw-polyrepo-bestpractice.*
