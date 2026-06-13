# 구조 감사 — aigentry-orchestrator (2026-06-10)

- **감사자**: architect 세션 `audit-orchestrator-structure` (Fable 5, 읽기 전용)
- **대상**: `aigentry-orchestrator` @ HEAD (bin/ ~6.4k LOC bash·py·mjs, src/ ~3.4k LOC TS, ADR 27건)
- **방법**: 3-way 병렬 탐색(bin/ 역할·경계, src/ 의존그래프·추상화, ADR/AGENTS.md 대조) 후 핵심 주장 전수 재검증(grep/read). 모든 지적은 file:line 증거 기반.
- **범위 외**: 코드 수정 없음(architect §3). 권고의 구현은 coder 위임 대상.

---

## 헤드라인 — 상위 3 구조 리스크

### R1. spawn-validation/gate 레이어가 프로덕션 경로에 미배선 — 문서는 "하드 enforcement 활성" 주장 (MAJOR, §1 + ADR/문서 불일치)

`src/gate/` Class A/B/C 전체와 `src/session/validate-spawn.ts`(G1–G6 + P1, 403 LOC)는
**테스트 외 호출자가 0개**다.

- 증거: `gatedTeleptyInject` / `gatedCmuxSpawn` / `gatedCliDirectSpawn` / `validateAgentPrompt` / `gateMcpToolCall` / `enforceSpawn` 심볼을 `bin/`, `scripts/`, `.claude/` 전체에서 grep → 매치 0 (docs/와 src/·tests/ 자기참조뿐).
- 실제 dispatch 경로: `bin/dispatch.sh:322` → `bin/boot-prepare.mjs` → dist에서 import하는 것은 `resolve-instructions.js`, `boot-adapter/index.js`, `types.js` 뿐 (`bin/boot-prepare.mjs:482-488`). `validate-spawn.js`·`gate/*`는 로드되지 않음.
- 반면 `AGENTS.md:9`는 "**하드 enforcement 활성 (ADR §6 #11 hard-fail flip)**"을 선언하고, `docs/gate-architecture.md`·`docs/specs/2026-05-12-hard-fail-flip.md`도 enforcement를 기정사실로 기술.

**판정**: 빌드·테스트·문서화까지 끝난 ~1,000+ LOC(validate-spawn 403 + permission-manager 174 + role-capabilities + gate ~450)가 실제 spawn 경로에서 우회되는 휴면 레이어. §1(한 번도 안 쓰는 추상화) 위반인 동시에, 문서가 보안 게이트를 "활성"으로 오기술하는 것이 더 위험하다 — 운영자는 capability 게이팅이 걸려 있다고 믿지만 실제로는 어떤 spawn도 차단되지 않는다.

**권고**: 둘 중 하나를 명시적으로 선택. (a) `boot-prepare.mjs`(또는 dispatch.sh의 spawn 직전)에 `enforceSpawn()` 호출을 배선해 문서 주장과 일치시키거나, (b) 배선 전까지 AGENTS.md:9 및 gate-architecture.md에 "구현·테스트 완료, 프로덕션 배선 미완(UPSTREAM/WIRING-GAP)"을 명기. coder 위임 1건 + 문서 패치 1건.

### R2. Role/Capability 레지스트리 양방향 거울 — SSOT 부재 (MAJOR, §4)

`@dmsdc-ai/aigentry-ssot`는 orchestrator의 role/capability 타입·레지스트리에 대응하는 export를 제공하고, 그 docstring은 orchestrator의 해당 타입/레지스트리를 "Mirrors"한다고 자인한다. *(ssot 내부 export 이름·dist 경로 상세는 공개 위생상 redact — tq#622)*

- 이 repo는 같은 데이터를 `src/session/types.ts:39-54`(CAPABILITIES)와 `src/session/role-capabilities.ts:21+`(ROLE_CAPABILITIES)에 **로컬 재정의**.
- src/ 전체에서 ssot를 import하는 파일은 `src/session/inject-parser.ts:27` 단 1개.

**판정**: "ssot"라는 이름의 패키지가 있는데 orchestrator와 서로를 거울이라 주장하는 쌍방 수동 동기화 — §4 single-source-of-truth 위반의 교과서적 형태. capability 테이블은 보안 관련 데이터라 drift 시 G5 subset 검증이 조용히 어긋난다.

**권고**: 방향을 하나로 고정. ssot 패키지를 source로 삼아 `src/session/types.ts`가 re-export(`export { Role, ROLES, ... } from "@dmsdc-ai/aigentry-ssot"`)하고 `role-capabilities.ts`는 `ROLE_CAPABILITY_SUBSET`를 소비. 즉시 전환이 어려우면 최소한 양측 동기화 assert 테스트 1개 추가. coder 위임.

### R3. bin/ 스크립트 간 유틸 중복 — 공유 lib 부재 (MAJOR 1 + MINOR 2, §4)

| 중복 항목 | 위치 | 심각도 |
|---|---|---|
| `telepty_list_json()` (fail-loud JSON 검증 + daemon/binary version-mismatch 처리 #400) | `bin/session-reconciler.sh:395-403`, `bin/session-cleanup.sh:72-92`, `bin/lib/workspace-host.sh:75,324`(inline) | **major** |
| `now_iso()` (동일 4-line) | `bin/session-reconciler.sh:100`, `bin/dispatch-tracker.sh:48`, `bin/dispatch-cleanup-scheduler.sh:53`, `bin/ask.sh:48`, `bin/session-comms-auditor.sh:39` — 5회 | minor |
| `json_get()` (dotted-path JSON 탐색, 동일 구현) | `bin/session-reconciler.sh:145-165`, `bin/dispatch-tracker.sh:99-119` | minor |

**판정**: telepty 출력 포맷/에러 시맨틱이 바뀌면 3곳을 고쳐야 하고, 한 곳만 고치면 version-skew 버그가 잠복한다. `bin/lib/workspace-host.sh`라는 공유 lib 선례가 이미 있으므로 패턴 확장만 하면 된다.

**권고**: `bin/lib/telepty-helpers.sh` + `bin/lib/common.sh` 신설, 5개 스크립트가 source. coder 위임 (외과적: 함수 추출만, 동작 변경 금지).

---

## 1. 역할 침범 (§3) — **0건**

orchestrator의 역할(지휘/위임/세션 조율) 밖 구현은 발견되지 않았다.

- `bin/open-session.sh`는 devkit 코드처럼 보이지만 **symlink**다 → `/Users/duckyoungkim/projects/aigentry-devkit/bin/open-session.sh` (`ls -l` 확인). ADR `2026-05-05-telepty-devkit-boundary` 준수. 위반 아님.
- telepty/cmux 호출은 전부 CLI 경유 thin call: `bin/dispatch.sh:242`(`telepty inject`), `bin/session-cleanup.sh:130-158`(`telepty allow` kill + API DELETE), `bin/lib/workspace-host.sh:92,110,124,133,150,160,229`(`cmux` CLI). 소켓/상태 재구현 없음.
- 코드 분석/빌드/테스트 실행 로직 없음. `bin/snyk-scan.sh`는 위임 코더용 래퍼(86 LOC)로 적정.
- probe/policy 분리(`bin/session-probe.py` 326 LOC 관측 전용 / `bin/policy.py` 181 LOC 판단 전용)는 §3 정신에 부합하는 깨끗한 분리.

단, `AGENTS.md:3`의 자기서술 "**코드 없음** — 지휘자이지 연주자가 아님"은 ~10k LOC repo 현실과 어긋난다(§6 문서 불일치 D2 참조). 여기 있는 코드는 전부 *오케스트레이션 인프라*(자기 도메인)라 §3 위반은 아니지만, 자기서술이 낡았다.

## 2. 경계 위반 (§4) — 3건

R2(ssot enum 거울, major), R3(telepty_list_json ×3, major; now_iso ×5 / json_get ×2, minor). 상세는 헤드라인 참조.

그 외 확인된 **비위반**:
- `src/session/persistence/`(atomic-write, index-lock, canonical-bytes, crash-recovery)는 ssot/logger가 제공하지 않는 저수준 I/O 프리미티브 — 중복 아님 (ssot는 타입/계약 패키지, I/O 없음).
- `src/telemetry/logger-emit.ts`는 `@dmsdc-ai/aigentry-logger.emit()` 위의 순수 facade(A1 subtype 매핑 + env 발견 + non-blocking). 재구현 아님.

## 3. 결합도/응집도 — God-file 0건 (후보 2건 검토 후 기각)

| 파일 | LOC | 책임 수 | 판정 |
|---|---|---|---|
| `bin/session-reconciler.sh` | 748 | 8 (registry loop :322-357, Layer-D tick :622, AUTO_REPORT fallback :601-609, comms-audit :611-619, orphan sweep :626-717, workspace-host :719-746, surface-orphaned :486-524, surface-mismatched :526-565) | **응집 OK** — 전부 단일 60s reconcile tick의 actuation. 내부 중복 없음 |
| `bin/dispatch-tracker.sh` | 638 | 7 (registry :144-232, stuck-check :251-327, redispatch :363-390, git AUTO_REPORT :443-480, AUTO_HOLD :495-559, status/prune :594-621, backoff :432-451) | **응집 OK** — 단일 dispatch-health 책임 |
| `bin/lib/workspace-host.sh` | 480 | adapter seam (cmux/warp/headless × 7 contract methods, 단일 `_wh_adapter()` 디스패처) | **모범 사례** — §4·§17(headless graceful degradation) 동시 충족 |
| `src/` 전 모듈 | ≤419 | — | god-module 없음. validate-spawn/persist-context/boot-adapter 모두 단일 워크플로우 응집 |

단, reconciler 책임이 8개에 도달한 점은 추세 관찰 대상 — 다음 책임 추가 시 phase별 파일 분리 검토 권고(지금 분리는 §1 위반 소지, 권고 보류).

## 4. 순환 의존 — 1건 (minor, 무해)

- `src/session/boot-adapter/spawner.ts:4` ↔ `src/session/boot-adapter/types.ts:5` — 양방향 모두 `import type` (타입 전용, 런타임 cycle 없음). TS 컴파일/실행에 영향 없음.
- 그 외 src/ 내부 상대 import 전수 추적 결과 cycle 없음. 패키지 수준(@dmsdc-ai logger·ssot ← orchestrator)도 단방향.
- **권고(선택)**: 공유 타입을 types.ts로 단방향 이동하면 cycle 자체 제거 가능. 우선순위 낮음.

## 5. 추상화 경계 / 오버엔지니어링 (§1) — 2건

| 항목 | 증거 | 심각도 |
|---|---|---|
| `src/gate/` Class A/B/C 전체가 테스트 전용 (= R1) | 프로덕션 호출자 0 (grep 전수) | **major** |
| `bin/cmux-inject.sh` dead code | 자기 참조 외 0 참조; 2026-03-21 작성 — Rule 32 dispatch-helper 강제 이전 유물. `telepty inject` 경로로 대체됨 | minor |

**기각된 후보** (검토 후 정당하다고 판단):
- `boot-adapter` 패턴 (claude/codex/gemini): 3 어댑터가 실질적으로 상이(claude=flag 기반 `--append-system-prompt-file`·redirect 없음 28 LOC / codex=`CODEX_HOME` redirect + AGENTS.md 컨텍스트 50 LOC / gemini=`GEMINI_CLI_HOME` + `.gemini` subdir 58 LOC). 템플릿 중복 아닌 실차이 — 패턴 정당.
- `virtual-fs.ts`: 실호출 2곳(boot-fs, resolve-instructions/project-id 타입) + 테스트 주입(memoryBootFs)용 경량 추상화 — 정당.
- `role-capabilities.ts`: 추상화가 아닌 정적 데이터 — 정당 (단 R2의 SSOT 문제는 별건).

**권고**: `cmux-inject.sh` 삭제는 별도 cleanup 태스크로 등록(Rule 29 — 본 감사에서 직접 삭제 안 함).

## 6. ADR/문서 준수 — ADR 위반 0건, 문서 불일치 3건

**준수 확인** (주요 ADR 8건 코드 대조):
2026-05-05 telepty-devkit 경계(open-session symlink ✓), 2026-05-12 cwd-role 분리(boot-prepare 샌드박스 + `AIGENTRY_TARGET_CWD` ✓ — 본 세션 자체가 그 증거), 2026-05-20 lifecycle 3-layer(reconciler/cleanup-scheduler/session-cleanup ✓), 2026-05-27·05-30 surface ownership(workspace-host 단일 seam ✓), 2026-06-06 orchestration sequence(step→스크립트 매핑 ✓), 2026-06-07 comms guardrail(ask.sh envelope + comms-auditor ✓).

**불일치**:

| # | 내용 | 증거 | 심각도 |
|---|---|---|---|
| D1 | AGENTS.md:9 "하드 enforcement 활성" vs validate-spawn 프로덕션 미배선 (= R1) | `bin/boot-prepare.mjs:482-488` import 목록에 validate-spawn 부재 | **major** |
| D2 | AGENTS.md:3 "코드 없음" vs bin 6.4k + src 3.4k LOC | `AGENTS.md:3` | minor |
| D3 | `state/lessons.json` fallback이 2026-04-08 이후 미갱신 (AGENTS.md Rule 7-1 fallback 경로) | stat mtime 2026-04-08 | minor |

**오탐 정정**: 탐색 단계에서 "AGENTS.md:9가 참조하는 `state/draft/2026-05-12-rule4-amendment-draft.md` 부재" 주장이 나왔으나 **재검증 결과 파일 존재** — 불일치 아님. (감사 자체도 §13 자기비판 대상.)

---

## 종합 판정

구조 건강도 **양호**. 역할(§3)·ADR 준수는 깨끗하고, thin-wrapper 원칙과 adapter seam(workspace-host) 등 §4 모범 사례도 있다. 핵심 리스크는 단 하나의 패턴에 수렴한다: **"만들고 테스트하고 문서화했지만 배선하지 않은" gate 레이어(R1)** — 기능 부재보다 *문서가 활성이라 주장하는 보안 게이트의 휴면*이 문제다. R2(ssot 거울)와 함께 처리하면 capability 체계 전체가 단일 소스 + 실배선으로 정리된다.

### 권고 우선순위 (전부 coder/문서 위임 대상 — architect는 권고만)

1. **P0**: R1 — `enforceSpawn()` 프로덕션 배선 또는 AGENTS.md "WIRING-GAP" 명기 (선택 자체는 orchestrator 결정 필요)
2. **P1**: R2 — Role/Capability를 ssot 패키지 단일 소스로 재export 전환 (+동기화 테스트)
3. **P1**: R3 — `bin/lib/telepty-helpers.sh`·`common.sh` 추출
4. **P2**: D2/D3 문서 갱신, `cmux-inject.sh` cleanup 태스크 등록, spawner↔types 타입 cycle 해소(선택)
