# aigentry 에코시스템 구조 감사 — Cross-Repo 종합

**일자**: 2026-06-10
**범위**: 핵심 6개 repo (orchestrator, telepty, registry, brain, devkit, dustcraw) × 구조/아키텍처 차원
**방법**: 6 architect 세션 병렬 (read-only, 증거 기반, Fable 5), 헌법 §1/§3/§4 기준
**개별 리포트**: 각 repo `docs/reports/2026-06-10-structure-audit.md`

---

## TL;DR — 2대 시스템 테마

### 테마 1: 역할 침범이 에코시스템 전반에 만연 (헌법 §3/§4)
orchestrator를 제외한 **5개 컴포넌트 전부**가 자기 역할을 넘어 다른 컴포넌트의 핵심 로직을 fat 구현했다.
가장 심각한 단일 패턴: **deliberation(심의/결정) 로직이 최소 3곳에 중복 구현** — deliberation 컴포넌트가
SSOT여야 함에도 brain·dustcraw·registry가 각자 재구현. "결정/심의"는 deliberation의 배타적 역할인데 산재.

### 테마 2: 거버넌스(ADR/문서) 신뢰 붕괴 — 6개 전부
구조 결정을 검증할 근거(ADR)가 없거나, 있어도 코드와 모순된다. **구조가 표류해도 감지할 장치가 없는 상태.**

---

## A. 역할 침범 매트릭스 (누가 누구의 역할을 침범했나)

| 침범 repo | → 침범당한 역할(컴포넌트) | 증거 | 심각도 |
|-----------|------------------------|------|--------|
| **brain** (기억) | **deliberation** | `BrainContract` deliberation 상태머신 재구현 (:605-776) + SynthesisSchema | critical |
| **brain** | 자율에이전트 / 메신저 | `NightShift` ~2229 LOC 자율실행, Discord/Telegram 봇 | critical |
| **registry** (면역계) | **dustcraw** | 자율크롤링 `auto_scrape_cycle` 3분 주기 | critical |
| **registry** | **telepty** | bridge CLI 세션 브리징 | critical |
| **registry** | (제품 범위 밖) | 백엔드 ~50%가 game/team/deploy 제품 기능 | major |
| **telepty** (신경계) | (자기 BOUNDARY) | mailbox 브로커급 큐/DLQ ~1000LOC, session-store 디스크 영속, report-enforcement 정책엔진 | critical |
| **dustcraw** (감각기관) | **deliberation / 결정** | `src/decision-gate/` 17파일 3,072 LOC (src ~32%) = 결정 루프 풀 구현 | critical |
| **dustcraw** | **brain** | `DecisionMemoryStore` 기억 관리 + user-scope 직접 조회(isolation 위반) | critical |
| **dustcraw** | **deliberation** | llm-deliberation/LLMProvider/adjudication fat 복제 (심의 경로 2벌) | critical |
| **devkit** (골격계) | **dustcraw** | exec-mode 실험 하니스 tracked 65% = 23.6KLOC | critical |
| **devkit** | telepty/orchestrator | 세션 lifecycle runStart/runStop/runSession (aigentry-devkit.js:899-1318) | major |
| **orchestrator** (지휘자) | — | **역할 침범 0건** (유일하게 청결) | — |

**관통 패턴**: deliberation 로직 3중복(brain/dustcraw/registry), 세션/브리징 로직 3중복(registry/devkit/telepty),
"결정·기억"이 감각기관(dustcraw)에 풀 구현.

## B. 거버넌스 붕괴 (ADR/문서 ↔ 코드 모순)

| repo | 문제 | 심각도 |
|------|------|--------|
| brain / registry / devkit / dustcraw | **docs/adr 자체 부재** — 모든 구조 결정이 무근거 | major |
| **telepty** | ADR-0608(broker)·ADR-0609(provenance)가 'NO implementation' 헤더인데 **구현+테스트 출하됨**; BOUNDARY.md 5개 항목 자체 위반; AGENTS.md 28개 모듈 누락 | major |
| **orchestrator** | AGENTS.md "하드 enforcement 활성" 단언 vs `validate-spawn`/`src/gate` **프로덕션 미배선(휴면)**; "코드 없음" 자기서술 stale | major |
| dustcraw | AGENTS.md:39가 **위헌 DecisionGate를 공식 아키텍처로 명문화**(§3 직접 충돌) | major |

> 주: telepty ADR stale은 이번 주(2026-06-09) broker(#42)/provenance(#43/#47)를 SPEC-FIRST로 land하며
> ADR '구현 금지' 헤더를 갱신하지 않은 데서 비롯. orchestrator gate 휴면도 ADR-MF #15 land 후 미배선.

## C. God-files (단일 파일 과대/관심사 혼재)

| repo | 파일 | LOC | 비고 |
|------|------|-----|------|
| telepty | `daemon.js` | **4154** | ~22개 관심사(전송+정책+상태 혼재) |
| devkit | `exec-mode-grader.py` | **3905** | 92 함수 |
| registry | `mcp_server/server.py` | 1017 | |
| brain | `BrainMcpServer` / `BrainContract` | 996 / 959 | 29-tool / 4도메인 혼재 |
| dustcraw | `DustcrawRuntime` / CLI | 791 / 708 | 협력자 21개 |

(orchestrator: God-file 0 — reconciler 748/tracker 638은 응집 OK 판정)

## D. 구조 외 실제 버그 (즉시 fix 후보)
- **devkit install 계약 파손 2건**: `brain-stub.mjs`가 `brain.adapter.json:30`에서 참조되나 `package.json` files 미포함 → npm 배포 시 fallback 파손; wtm 설치경로(`~/.local/lib/wtm`) vs 소스경로(`~/.wtm/lib`) 모순.

---

## E. orchestrator 결정 대기 (architect들이 명시 위임 — 헌법적 판단)

| # | 결정 | 옵션 |
|---|------|------|
| D1 | **telepty BOUNDARY 모순** (stateful 브로커+정책엔진 vs 'dumb pipe' 선언) | 문서 개정(현실 수용) vs 기능 추출(brain/orchestrator로) |
| D2 | **brain 이벤트 인프라**(WSS + CF Worker) | telepty로 이관 vs ADR 예외 승인 |
| D3 | **orchestrator gate 휴면** (enforceSpawn/src/gate 미배선인데 문서는 "활성") | P0 배선 vs WIRING-GAP 명기(문서 정정) |
| D4 | **dustcraw decision-gate**(src 32%, 위헌이나 AGENTS.md 명문화) | waive(공식 예외 승인) vs deliberation으로 이관 |
| D5 | **registry 역할 헌장 재확정** (백엔드 ~50%가 위임 범위 밖 + 크롤링/브리징 침범) | 역할 재정의 vs 침범 기능 절제/이관 |
| D6 | **deliberation SSOT 강제** (심의/결정 로직 3중복 제거) | deliberation을 단일 진실원으로, 나머지는 thin client |

---

## F. 권고 우선순위 (구현은 별도 coder/아키텍트 dispatch — 본 문서는 종합/판단)

1. **P0 — 거버넌스 복구**: 6 repo에 docs/adr 도입 + telepty stale ADR 헤더 정정 + orchestrator gate 문서-코드 정합(D3). "감지 장치" 부재가 표류의 근본 원인.
2. **P0 — D3 gate 휴면 결정**: 보안 게이트(spawn capability)가 문서상 활성·실제 휴면 = 보안 갭. 배선 or 명시.
3. **P1 — deliberation SSOT(D6)**: 심의/결정 3중복 제거 — 가장 큰 중복·역할 침범 덩어리.
4. **P1 — 역할 절제 로드맵(D1/D4/D5)**: telepty/dustcraw/registry의 침범 기능을 헌법 §3 기준으로 추출 vs 예외 승인 결정.
5. **P2 — God-file 분해**(daemon.js 4154, exec-mode-grader 3905) + devkit install 버그 2건.

> 본 종합은 orchestrator(지휘자)의 판단/플랜 문서다. 실제 코드 변경은 각 결정 확정 후 해당 컴포넌트 세션에 위임한다.
