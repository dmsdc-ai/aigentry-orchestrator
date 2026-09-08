# aigentry 에코시스템 아키텍처 현황 감사 (#1140)

- 측정 시각: **2026-09-08T13:36Z ~ 13:52Z** (UTC)
- 세션: `ec1140-architect` / role `architect` / worktree `/Users/duckyoungkim/.aigentry/worktrees/ec1140` / branch `docs/1140-ecosystem-architecture`
- 성격: **#526 EPIC 의 current-source refresh**. 신규 overhaul epic 아님. #1141 operations analyst 와 병렬.
- 권한: 읽기 전용 분석. 코드/설정/task-queue 변경 없음. 본 리포트 1개 파일만 커밋.

---

## 0. 측정 우주(counted universe)와 제외 범위

**포함**: `~/projects/` 1-depth 에서 이름이 `aigentry` 또는 `aigentry-*` 인 디렉터리 — **22개** (`ls -1d` 직접 열거, ecosystem.json/rg 미사용).
중첩 패키지 디렉터리는 별도 disposition 부여(부록 B).

**미측정(명시)**:
- **npm 레지스트리 실제 게시 버전** — 네트워크 조회 금지 범위. 본 리포트의 모든 버전 비교는 **로컬 소스 대 로컬 소스**뿐이다. "레지스트리에 X가 있다/없다"는 주장은 하지 않는다.
- **런타임 실행 관측** — 데몬/앱 실행 금지. 프로세스·트래픽·성능 수치 없음. 런타임 근거가 필요한 판단은 #1141 analyst 몫.
- **원격 브랜치/CI 상태** — `git fetch` 미실행. HEAD/branch/dirty 는 전부 로컬 상태.
- **비-`aigentry*` 이름의 연관 저장소** — 열거 대상 외. 단 참조로 발견된 내부 모듈(ssot/context/bridge/hooks/logger/registry)은 전부 위 22개 안에 존재함을 확인.

---

## 1. Executive verdict

### 1.1 지켜야 할 강점

1. **경계가 실제로 지켜지고 있다.** orchestrator → telepty 는 JS import 가 아니라 **PATH 상의 CLI 호출**이다(`bin/*.sh` 20+ 사이트가 `command -v telepty`). 매니페스트 의존성 = 런타임 결합이라는 흔한 오해가 여기선 사실이 아니고, transport 교체 가능성이 살아 있다. 헌법 §1(경량) 을 실제로 만족하는 몇 안 되는 지점.
2. **4-layer 지시문 합성이 작동한다.** `resolveInstructions()`(orchestrator `src/session/resolve-instructions.ts:130`)는 layer 순서를 강제 정렬하고 각 layer 의 `content_sha256` + `effective_prompt_digest` 를 남긴다. 본 세션 자체가 common+role 2-layer 로 부팅된 것이 실증이다. 감사 가능한(auditable) 프롬프트 합성은 이 생태계의 진짜 자산이다.
3. **벤더링 파이프라인은 실제로 동작한다.** `ecosystem.json` 6개 사본이 **전부 byte-identical**(sha256 `722f3d5d9844…`). #793 이 한 일은 실제로 됐다. 문제는 배포가 아니라 **게이트 부재**(§F4).
4. **telepty 의 변경 이력 품질.** CHANGELOG 가 근본원인·측정치·회귀 테스트 파일명까지 기록한다(#721/#732/#760 항목). 이 규율은 다른 repo 로 확산시킬 가치가 있다.
5. **컷 웨이브(#769 Phase C)가 실제로 LOC 를 줄였다.** registry −46,904 / ssot −15,953 / dustcraw −3,053. 삭제를 실행할 수 있는 조직이라는 증거.

### 1.2 최고 임팩트 체계적 약점

**한 문장: 설치 표면(install surface)이 자기가 설치하는 생태계와 좌표가 어긋나 있다.**

세 개의 독립 파일이 서로 다른, 그리고 전부 현재 소스와 불일치하는 패키지 좌표를 들고 있다 — devkit `installer-manifest.json`(telepty 0.1.45), devkit `modules/*.adapter.json`(telepty 0.1.45, bridge `@aigentry/bridge`), 메타 패키지 `aigentry/package.json`(telepty `^0.6.6`). **공개 사용자가 밟는 모든 진입 경로가 현재 생태계가 아닌 것을 설치한다.** 이건 헌법 §17(무의존 — "공개 사용자가 aigentry 단독 설치로 코어 기능 전부") 의 정면 위반이며, 내부 dogfooding 이 전원 소스 트리 위에서 도는 탓에 관측되지 않는다.

두 번째 축은 **SSOT 다중화**다. 역할 정의가 두 곳(instructions/roles vs role artifact repo)에, 생태계 목록이 두 곳(ecosystem.json 6개 vs 실제 22개)에, bridge 구현이 두 곳(standalone vs registry 내부)에 있고, 각 쌍은 **드리프트를 감지하는 게이트가 없다**.

### 1.3 최소 개선안

| 시점 | 항목 | 근거 |
|---|---|---|
| **NOW** | F1 telepty 핀 0.1.45 → 하한 없는 실패 (설치가 곧 깨진 제품) | 프로토콜 전체가 동작 불가 |
| **NOW** | F2 `@aigentry/bridge` 미보유 스코프 install_command 제거 | 공급망 위험 클래스 |
| **NEXT** | F3 메타 패키지 range 정정, F5 role SSOT 단일화 | 공개 진입점 / 워커 규칙 도달성 |
| **NEXT** | F4 ecosystem.json 커버리지 게이트 | 드리프트 재발 차단 |
| **DEFER** | F6 게이트 wire-or-delete(#655), F7 context 아카이브(#662), F8 bridge 소유권 | 결정 비용 > 현재 피해 |

### 1.4 도입하지 말 것 (그리고 이유)

- **"통합 aigentry 프레임워크/모노레포"** — 22개 repo 를 하나로 합치자는 제안은 이 감사에서 나오지 않는다. 현재 결합은 CLI/PATH 경계로 이미 느슨하고(§1.1-1), 합치면 §1 경량 위반. 문제는 구조가 아니라 **좌표 정합성**이며 그건 3개 JSON 파일 수정으로 끝난다.
- **새 "install orchestration" 추상화 레이어** — `install-fallback.js` 가 이미 npm-global / npm-ephemeral / local-runtime / wiring 4종을 처리한다. 필요한 건 새 계층이 아니라 기존 매니페스트의 값 수정.
- **ecosystem.json 스키마 확장(22개 전부 등재 + 상태 필드 추가)** — 등재 자체가 목적이 되면 또 다른 stale SSOT 를 만든다. 커버리지 **게이트**(CI 체크)가 등재 확대보다 싸고 확실하다(§F4).
- **aigentry-forum 부활** — deliberation 이 `demo/forum/` 을 자체 벤더링했고 README 가 그쪽을 가리킨다. standalone repo 는 이미 대체됐다. 되살리면 세 번째 SSOT.
- **역할 repo(architect/builder/tester/design) 를 git 화해서 유지** — F5 의 결론은 "버전관리하라"가 아니라 "도달하지 못하는 규칙을 도달하는 곳으로 옮겨라"다. 먼저 병합, 그 다음 남는 게 있으면 그때 repo 논의.

---

## 2. Findings (8)

> 형식: ID | 심각도 / 신뢰도(별도) | 현재 피해 vs 가설 위험 | 근본원인 | 최소 수정 | 수정 전 재현/수용 기준 | 소유 repo·role | 의존/롤아웃/롤백 | 기존 task 매핑

---

### ECO-1140-01 — devkit 설치가 `--submit-force` 이전 telepty 를 고정 설치

- **심각도 CRITICAL / 신뢰도 HIGH**
- **증거**
  - `aigentry-devkit@bb7876b config/installer-manifest.json:109` → `components.telepty.install.version = "0.1.45"`
  - `aigentry-devkit@bb7876b config/modules/telepty.adapter.json:18` → `install_command: npm install -g @dmsdc-ai/aigentry-telepty@0.1.45`
  - `aigentry-devkit@bb7876b lib/install-fallback.js:342` → `npm install -g ${pkg}@${version}` (매니페스트 값을 그대로 exec, `latest` fallback 은 `entry.version` 부재 시에만)
  - `aigentry-telepty@997ea7c CHANGELOG.md:1970-1972` → `## [0.3.3] — 2026-05-02 / ### Added — inject --submit-force`
  - 로컬 telepty `package.json` version = **0.8.3**
- **현재 피해(가설 아님)**: 이 생태계의 보고·에스컬레이션 프로토콜 전체가 `telepty inject --ref --submit --submit-force` 이다 — 본 dispatch 스펙의 HOLD/REPORT 명령, `bin/ask.sh:158`, 역할 지시문 `instructions/roles/*.md` 전부. `--submit-force` 는 0.3.3 에서 도입됐고 설치본은 0.1.45 다. **깨끗한 머신에서 devkit 로 설치하면 REPORT 인젝트가 인자 파싱 단계에서 실패한다.** 내부 개발자는 전원 소스 트리/전역 최신본을 쓰므로 이 경로를 밟지 않아 관측되지 않았다.
- **근본원인**: 설치 좌표를 exact-version 으로 박아두고, 해당 값이 `telepty --version` 비교(`install.sh:519-531`)에서 **warn 으로만** 처리된다 — 즉 자기가 방금 설치한 구버전을 스스로 경고하고 진행한다. 버전 소스가 telepty 저장소가 아니라 devkit 안의 상수라서 telepty 릴리스와 함께 움직이지 않는다.
- **최소 수정**: `installer-manifest.json:109` 와 `telepty.adapter.json:18` 의 `0.1.45` 를 **하한 range**(예: `^0.8.0`) 또는 `latest` 로 바꾸고, `install.sh:527` 의 `warn` 을 **`die`** 로 승격. 코드 변경 없음, JSON 2줄 + shell 1줄.
- **수정 전 재현**: 격리 환경(`aigentry-sandbox/npm-test/`)에서 `AIGENTRY_INSTALL_MANIFEST` 기본값으로 install.sh phase 2 실행 → `telepty --version` 이 0.1.x 를 출력하고 `telepty inject --submit-force --help` 가 unknown option 으로 종료하면 재현 성립. **수용 기준**: 동일 절차에서 설치본이 target 미만이면 phase 2 가 non-zero 로 종료.
- **소유**: `aigentry-devkit` / builder(적용) + coder(수정)
- **의존/롤아웃/롤백**: 선행 의존 없음. 롤아웃 = devkit 패치 릴리스. 롤백 = JSON 값 원복(1 커밋 revert).
- **task 매핑**: **NEW 후보**. dedup 근거 — 전체 task-queue(1138건, done 포함)에서 `0.1.45` / `installer-manifest` 정규식 매치 **0건**. #793(done)은 ecosystem.json 전파만 다뤘고 installer manifest 는 건드리지 않았다. #671(logger accuracy) / #783(ssot contracts stale, "0.0.39 pin도 stale" 언급)은 다른 파일·다른 pin 이므로 중복 아님.

---

### ECO-1140-02 — 설치 어댑터가 존재하지 않는 스코프와 비공개 패키지를 설치하려 한다

- **심각도 HIGH / 신뢰도 HIGH**
- **증거**
  - `config/modules/bridge.adapter.json:17` → `npm install -g @aigentry/bridge`
  - `config/installer-manifest.json:224` → `"package": "@aigentry/bridge"`
  - 생태계 전체 `package.json` 에서 `"name": "@aigentry/..."` 매치 **0건**(node_modules 제외 grep). 실제 이름은 `@dmsdc-ai/aigentry-bridge`(standalone) 또는 unscoped `aigentry-bridge`(registry 내부).
  - `config/modules/amplify.adapter.json:17` → `npm install -g @dmsdc-ai/aigentry-amplify` / 그러나 `aigentry-amplify/package.json:4` = `"private": true`
  - `config/modules/dustcraw.adapter.json:17` → `@dmsdc-ai/aigentry-dustcraw@0.3.1` / 로컬 dustcraw = **0.4.0**
- **현재 피해 vs 가설**: dustcraw 0.3.1 핀은 **현재 피해**(구버전 설치, failure_policy=soft 라 조용히 진행). amplify 는 `private:true` 이므로 설치 시도가 반드시 실패 — soft 정책이라 조용히 degraded. `@aigentry/bridge` 는 **가설 위험이되 클래스가 나쁘다**: 우리가 보유하지 않은 스코프 이름을 `npm install -g` 로 실행하는 코드가 리포에 커밋돼 있다. 누군가 그 좌표를 점유하면 전역 설치가 그대로 실행된다. (본 감사는 레지스트리를 조회하지 않았으므로 현재 점유 여부는 **미측정**.)
- **근본원인**: 어댑터 JSON 이 실제 패키지 매니페스트를 참조하지 않고 손으로 적힌 문자열이다. 이름/공개여부/버전 어느 것도 교차검증되지 않는다.
- **최소 수정**: (a) `@aigentry/bridge` 두 곳을 **빈 문자열로 비활성화**(registry.adapter.json 이 이미 `install_command: ""` 선례를 가짐) — 소유권이 F8 에서 정해지기 전엔 설치하지 않는 것이 정답. (b) amplify 어댑터를 동일하게 비활성화하거나 `private` 해제 결정 전까지 프로파일에서 제외. (c) dustcraw 핀 제거.
- **수정 전 재현**: `node lib/install-fallback.js bridge --verbose` 의 출력 `cmd` 문자열이 `@aigentry/bridge` 를 포함하는지 확인(설치 실행 없이 dry 출력만). **수용 기준**: 어댑터의 모든 `install_command` 패키지명이 생태계 내 실재 `package.json` `name` 과 일치하고, `private:true` 패키지가 어떤 프로파일에도 없을 것.
- **소유**: `aigentry-devkit` / coder
- **의존/롤아웃/롤백**: F1 과 같은 파일군 — **한 PR 로 묶는 것이 최소 비용**. 롤백 = JSON revert.
- **task 매핑**: **NEW 후보**(F1 과 동일 PR 권장). dedup — `@aigentry/` 문자열은 task-queue 전체에 0건. #662(휴면 repo 정리)는 archive 판단이고 이건 설치 표면 수정이라 별건.

---

### ECO-1140-03 — 메타 패키지 `@dmsdc-ai/aigentry` 의 range 가 현재 세대를 영구히 배제한다

- **심각도 HIGH / 신뢰도 HIGH**
- **증거** — `aigentry@f959b29 package.json` (version 0.1.1):

  | 선언 range | 로컬 소스 version | npm caret 해석 | 도달 가능? |
  |---|---|---|---|
  | `@dmsdc-ai/aigentry-telepty: ^0.6.6` | **0.8.3** | `>=0.6.6 <0.7.0` | ❌ |
  | `@dmsdc-ai/aigentry-brain: ^0.2.8` | **0.3.1** | `>=0.2.8 <0.3.0` | ❌ |
  | `@dmsdc-ai/aigentry-devkit: ^0.0.22` | **0.1.14** | `>=0.0.22 <0.0.23` (0.0.x 는 patch 고정) | ❌ |
  | `@dmsdc-ai/aigentry-deliberation: ^0.0.47` | 0.0.47 | `=0.0.47` | ✅(고정) |
  | `@dmsdc-ai/aterm: ^0.2.14` | 로컬 npm 매니페스트 없음(Cargo only) | — | **미측정** |
- **현재 피해**: 메타 패키지 설명이 "installs the entire aigentry ecosystem" 인데, 3/5 의존이 **caret 규칙상 현재 세대로 절대 올라갈 수 없는** range 다. 헌법 §17 이 약속한 "공개 사용자는 aigentry 단독 설치" 경로가 구세대를 배포한다. 또한 orchestrator/ssot/logger/hooks 는 메타 패키지에 아예 없어 "entire ecosystem" 이라는 설명 자체가 부정확.
- **근본원인**: 0.x 대역에서 caret 이 minor 를 고정한다는 semver 규칙과, 릴리스 시 메타 패키지 range 를 갱신하는 절차의 부재가 겹쳤다. F1/F4 와 동일한 근본 패턴 — **버전 좌표가 여러 파일에 손으로 복제되고 게이트가 없다**.
- **최소 수정**: 4개 range 를 각 패키지의 현재 로컬 minor 기준으로 올리고(`^0.8.0` / `^0.3.0` / `^0.1.14` / `^0.0.47`), description 을 실제 포함 범위로 정정. 아직 **레지스트리 확인이 선행 조건**(§0 미측정 범위) — 갱신 전 `npm view` 로 실제 게시본을 확인해야 하며 그건 이 세션 권한 밖이다.
- **수정 전 재현**: `npm install @dmsdc-ai/aigentry` 후 `node -e 'require("@dmsdc-ai/aigentry-telepty/package.json").version'` 이 0.6.x 계열이면 재현. (레지스트리 접근 필요 — 본 세션 미실행.) **수용 기준**: 설치 후 각 하위 패키지 version 이 `ecosystem.json` 행과 일치.
- **소유**: `aigentry`(메타) / coder + builder(퍼블리시)
- **의존/롤아웃/롤백**: **F4 선행 권장**(ecosystem.json 이 정확해야 range 의 정답을 안다). 롤아웃 = 메타 패키지 patch 릴리스. 롤백 = 이전 버전 deprecate 없이 재퍼블리시.
- **task 매핑**: **NEW 후보**. dedup — task-queue 전체에서 메타 패키지 정규식 매치 0건. #884(release credential operations)는 자격증명 운영이지 range 정정이 아님.

---

### ECO-1140-04 — `ecosystem.json` 이 "canonical SSOT" 를 자칭하나 22개 중 6개만 덮고, 값도 stale

- **심각도 MEDIUM / 신뢰도 HIGH**
- **증거**
  - 6개 사본 sha256 전부 `722f3d5d9844…` — 배포는 정상.
  - `_comment` = "Canonical aigentry ecosystem manifest. Source of truth…"
  - `modules[]` = telepty / brain / deliberation / devkit / aterm / orchestrator = **6개**. 파일시스템 열거 결과 = **22개**.
  - telepty 행 `"version": "0.7.1"` vs 로컬 `aigentry-telepty/package.json` = **0.8.3**. orchestrator 행 `"package": "aigentry-orchestrator"`, `"version": "—"` vs 실제 `@dmsdc-ai/aigentry-orchestrator` **0.2.0**.
- **현재 피해**: README 생태계 표를 이 파일에서 생성한다(`_comment`). 즉 **공개 문서가 두 세대 뒤 버전과 잘못된 패키지명을 노출**한다. 또한 "source of truth" 라는 문구가 16개 디렉터리의 부재를 정상으로 보이게 만들어, 본 감사 이전 audit 들이 6개 기준으로 결론을 낸 원인일 가능성이 높다.
- **근본원인**: #793 이 **동기화(sync)** 를 한 번 수행했지만 **게이트(check)** 를 남기지 않았다. 동기화는 이벤트, 게이트는 상태다. telepty 0.7.1→0.8.3 두 릴리스가 지나는 동안 아무것도 실패하지 않았다.
- **최소 수정**: `sync-readme-tooling.mjs` 에 `--check` 모드 추가(각 `modules[].version` 을 해당 repo `package.json` 과 대조, 불일치 시 exit 1) + telepty/orchestrator 행 값 정정. **커버리지 확대는 하지 않는다** — §1.4 참조. 대신 `_comment` 의 "Source of truth" 를 "README 표 생성용 published-module 목록"으로 정정해 범위를 정직하게 만든다.
- **수정 전 재현**: `grep -A2 '"name": "telepty"' ecosystem.json` 의 version 과 `aigentry-telepty/package.json` 의 version 을 비교 → 0.7.1 ≠ 0.8.3. **수용 기준**: `--check` 가 현재 트리에서 exit 1, 값 정정 후 exit 0.
- **소유**: `aigentry-devkit`(스크립트) + 6개 벤더 사본 / coder
- **의존/롤아웃/롤백**: F3 의 선행. 롤아웃 = devkit 스크립트 + 6 repo 사본 재생성(#793 과 동일 절차, 이미 검증된 경로). 롤백 = 사본 revert.
- **task 매핑**: **#793 은 done 이므로 재개 대상 아님 → NEW 후보**(게이트 추가는 #793 의 범위 밖). #266/#267(E-eco-sync SSOT 일원화)와는 대상이 다름 — 그쪽은 skills/helpers/templates 이고 이건 모듈 버전 표. 단 **#267 의 하위로 등록하는 것도 합리적**이며 orchestrator 판단에 맡긴다.

---

### ECO-1140-05 — 역할 규칙 SSOT 이분화: role artifact repo 의 규칙은 dispatch 워커에 구조적으로 도달 불가

- **심각도 HIGH / 신뢰도 HIGH**
- **증거**
  - 주입 경로: `~/.aigentry/instructions/roles/` = 9개 파일(analyst, architect, builder, coder, logger, orchestrator, researcher, reviewer, tester). `architect.md` = **30줄**.
  - 별도 경로: `~/projects/aigentry-architect/` = `CLAUDE.md`(82줄) + `AGENTS.md` + `docs/` + `references/`, 총 **26 파일**. CLAUDE.md 는 "실제 규칙은 AGENTS.md §1-§8", "§5 INVARIANTS — 10항목, 위반 시 산출물 전면 폐기", "§6 FAILED APPROACHES" 를 선언.
  - 도달 불가의 원인: `aigentry-orchestrator@ca93cb6 bin/boot-prepare.mjs:576` 주석 — `cwd: sandboxCwd, // resolveInstructions reads project_id from cwd; sandbox = no project layer`. #431 role-sandbox 는 워커 cwd 를 `~/.aigentry/role-sandbox/<sid>/` 로 고정하고 "no project CLAUDE.md auto-loaded" 를 계약으로 명시.
  - **자기 실증**: 본 세션(architect)의 시스템 프롬프트는 common + role 2-layer 이며 `instructions/roles/architect.md` 30줄만 포함한다. `aigentry-architect/AGENTS.md §5/§6` 은 **로드되지 않았다**.
  - 동일 구조의 repo 4개가 **git 미초기화**: architect(26 파일), builder(4), design(13), tester(59). 총 102 파일이 버전관리·백업 0.
- **현재 피해**: "위반 시 산출물 전면 폐기" 급 INVARIANT 와 축적된 FAILED APPROACHES 가 **정의된 곳과 강제되는 곳이 다르다**. 워커는 30줄만 받고, 82+줄은 아무도 읽지 않는 디스크에 있다. 문서는 강제가 아니라는 이 프로젝트 자신의 교훈이 여기 그대로 적용된다.
- **근본원인**: role artifact repo 는 #431 role-sandbox **이전** 모델(세션이 역할 repo 로 cd 하는 구조)의 잔재다. sandbox 도입이 로딩 경로를 끊었으나 내용 이관이 따라오지 않았다.
- **최소 수정**: `aigentry-architect/AGENTS.md` 의 §5 INVARIANTS + §6 FAILED APPROACHES **만** `instructions/roles/architect.md` 로 병합(나머지 참조 문서는 그대로 둔다). 4개 역할 중 **architect 1개로 파일럿**, digest 로 로드 확인 후 확대. repo git 화는 이 수정에 **선행하지 않는다**(§1.4).
- **수정 전 재현**: architect role 로 워커를 dispatch 하고 시스템 프롬프트에 `INVARIANTS` 문자열이 포함되는지 확인 → 현재 0건. **수용 기준**: 병합 후 동일 dispatch 의 `effective_prompt` 에 해당 문자열이 존재하고 `resolveInstructions` 가 새 `content_sha256` 을 기록.
- **소유**: `aigentry-orchestrator`(instructions tree) + `aigentry-architect` / architect(설계) → coder(적용)
- **의존/롤아웃/롤백**: 독립. 롤아웃 = MD 병합 1건. 롤백 = MD revert(다음 dispatch 부터 즉시 반영, 상태 없음).
- **task 매핑**: **#292**(Track E20 3-Layer 구조 명시화 — "Layer1 SSOT template in devkit + Layer2 role artifact repo + Layer3 ephemeral session, 이번 세션 architect 에 부분 적용") 를 **UPDATE**. dedup — #292 가 정확히 이 3층 구조를 다루고 architect 를 언급한다. 본 감사는 그 구조가 **Layer2→Layer3 로딩이 #431 에 의해 끊겼다**는 측정 증거를 추가한다. #279(E14 모호 프로젝트 분류)는 분류 설문이라 별건.

---

### ECO-1140-06 — spawn 게이트 커널이 여전히 완전 고립 (dormant island)

- **심각도 MEDIUM / 신뢰도 HIGH**
- **증거** (`aigentry-orchestrator@ca93cb6`)
  - `src/gate/` = 7 파일 / `src/gate/*.ts` + `src/gate/*/*.ts` 합계 **1,072 LOC**(index 40, common, class-a/{telepty,cli_direct,cmux}, class-b/agent-tool-validator 124, class-c/mcp-deliberation-adapter 123).
  - `src/gate/index.ts` 를 import 하는 파일 **0개** (`grep -rn "gate/index\|from \"\.\./\.\./gate" src bin` → 무결과, 잘림 없음).
  - `validate-spawn.ts` 참조는 전부 `src/gate/` 내부 3건 + **주석 4건**. `bin/` 의 실제 spawn 경로(`open-session.sh`, `dispatch.sh`, `session-start.sh`, `boot-prepare.mjs`)에는 호출 0건.
- **현재 피해 vs 가설**: **현재 피해는 유지비뿐**이다 — 1,072 LOC 가 컴파일·리뷰·리팩토링 대상이면서 아무 것도 막지 않는다. "게이트가 있으니 안전하다"는 오해를 만드는 것이 실제 위험이며, 이는 `sec-wire-enforce-spawn`(open-session.sh 가 bypassPermissions 기본) 과 정확히 맞물린다 — 게이트가 배선됐다면 그 티켓이 존재하지 않았을 것이다.
- **근본원인**: 커널을 먼저 만들고 배선을 나중에 하기로 한 결정이 미결로 남았다. ADR-MF §4.3 의 `SpawnRequest` 타입까지 존재하는데 진입점이 없다.
- **최소 수정**: **결정 자체가 산출물**이다 — wire 아니면 delete. architect 관점 권고: **class-a/telepty 1개만 `bin/open-session.sh` 진입부에 배선**(가장 넓은 spawn 경로 1곳)하고 나머지 class-b/c 는 삭제. 전면 배선은 §1 위반이고 전면 삭제는 `sec-wire-enforce-spawn` 을 무방비로 남긴다.
- **수정 전 재현**: `grep -rn "gate/index" src bin` → 0건이 곧 재현. **수용 기준**: 배선 후 권한 초과 SpawnRequest 가 non-zero 로 거부되는 케이스 1개.
- **소유**: `aigentry-orchestrator` / architect(결정) → coder(배선/삭제)
- **의존/롤아웃/롤백**: `sec-wire-enforce-spawn` 과 **동일 결정 하나**. 분리 진행하면 두 번 판단해야 한다. 롤백 = 배선 1줄 제거.
- **task 매핑**: **#655 UPDATE** ("spawn 게이트 wire-or-delete — dormant ~1726 LOC TS kernel(src/gate, validate-spawn, permission-manager) 결정"). dedup — 정확히 동일 대상. 본 감사 기여: **2026-09-08 기준 여전히 importer 0** 확인, 그리고 LOC 를 **1,726 → src/gate 1,072 (+validate-spawn/permission-manager 별도)** 로 현행 측정치 갱신. `sec-wire-enforce-spawn` 을 #655 의 종속으로 묶을 것을 권고.

---

### ECO-1140-07 — `aigentry-context` 는 소비자 0이며 brain 이 같은 기능을 보유

- **심각도 MEDIUM / 신뢰도 HIGH**
- **증거**
  - `aigentry-context@eb23360` = 1,436 LOC, version 0.0.1, dependencies `{}`. 모듈: `src/{tokens.js,index.js,mcp-server.js}`, `src/projector/{index,relevance,snip-projection}.js`, `src/compressor/{index,dedup,snip-compact}.js`.
  - **소비자 0.** 생태계 grep 이 반환한 유일한 외부 히트는 `aigentry-devkit/lib/scaffold/install-hooks/claude.js:41` 의 `aigentry-context-ref-v1.sh` 와 `gemini.js:9` 의 `aigentry-context-ref-v1.js` — 이는 **dispatch context-ref 훅 파일명**이며 `@dmsdc-ai/aigentry-context` 패키지와 무관하다. **문자열 일치에 의한 false-positive caller**.
  - 중복: `aigentry-brain@0ffa6ee src/context/{ContextPacker.ts, EntryScoring.ts, ContextRestoreService.ts}` — packing / scoring / restore 로 context 의 projector(relevance) + compressor 와 기능이 겹친다.
  - `git remote -v` = 공백 → **원격 없음, 로컬-only 히스토리**.
- **현재 피해 vs 가설**: 현재 피해는 **거의 없다**(아무도 안 쓴다). 위험은 두 가지 — (a) 로컬-only 히스토리라 디스크 사고 시 소실(#790), (b) 향후 "context 압축 어디에 넣지?" 질문이 나올 때 답이 둘이라 잘못된 쪽에 구현이 쌓인다.
- **근본원인**: brain 의 `src/context/` 가 나중에 자라면서 별도 패키지의 존재 이유를 흡수했으나 회수 결정이 없었다.
- **최소 수정**: **아카이브 전 원격 push 가 선행**(#790). 그 다음 `aigentry-context` 를 archive 표시. 코드 이식은 불필요 — brain 이 이미 갖고 있으므로 "흡수"는 이미 완료된 상태다.
- **수정 전 재현**: `grep -rn "@dmsdc-ai/aigentry-context" ~/projects --include=package.json | grep -v node_modules` → self 1건 외 0건. **수용 기준**: archive 후 어떤 repo 의 빌드/테스트도 실패하지 않을 것.
- **소유**: `aigentry-context` / architect(결정) → builder(archive)
- **의존/롤아웃/롤백**: **#790(원격 생성+push) 선행 필수** — 원격 없이 archive 하면 되돌릴 수 없다. 롤백 = archive 해제.
- **task 매핑**: **#662 UPDATE** ("휴면 repo 정리 — sandbox(0파일) 삭제, aigentry-context archive(brain 흡수), registry/dustcraw/amplify archive 검토"). dedup — 정확히 동일. **본 감사가 정정하는 stale 헤드라인**: #662 의 "sandbox(0파일)" 은 **틀렸다** — `aigentry-sandbox` 는 **71 파일 / 15MB**(npm-test/pack·install, telepty 격리 데이터, osc133 evidence 로그)이며, 격리 설치 테스트 환경으로서 **F1 의 재현 절차가 바로 이 디렉터리를 필요로 한다**. "0파일이므로 삭제" 근거는 무효. #790 을 #662 의 선행 의존으로 명시할 것을 권고.

---

### ECO-1140-08 — `aigentry-bridge`: 원격 없음 + 이름 충돌 + 사실상 미착수

- **심각도 MEDIUM / 신뢰도 HIGH**
- **증거**
  - `aigentry-bridge` HEAD = `5eabef0 2026-04-01 init: scaffold aigentry-bridge project` — **최초 커밋이 유일 커밋**, 이후 5개월 무변경. dirty **11**.
  - `git remote -v` = 공백 → **원격 없음**. 미커밋 11건 + 로컬-only 히스토리 = 백업 0.
  - `package.json` name = `@dmsdc-ai/aigentry-bridge` 0.1.0, deps `{}`, 1,105 LOC(테스트 fixture 포함).
  - 동시에 `aigentry-registry/bridge/package.json` name = **`aigentry-bridge`**(unscoped) 0.1.1, deps `{ws:^8.17.0}`, 995 LOC, `src/executors/claude.ts` 등 실제 구현 보유. registry 본체가 `src/aigentry/services/bridge/registry.py` 와 테스트 2종으로 이를 사용.
  - devkit 어댑터는 **제3의 이름** `@aigentry/bridge` 를 가리킨다(F2).
- **현재 피해 vs 가설**: 현재 피해 = 소유권 미정의. 세 이름(`@dmsdc-ai/aigentry-bridge`, `aigentry-bridge`, `@aigentry/bridge`)이 "bridge" 를 주장하는데 살아 있는 구현은 registry 안의 것 하나뿐이다. 가설 위험 = standalone 의 로컬-only 히스토리 소실.
- **근본원인**: standalone repo 를 먼저 scaffold 하고, 실제 필요는 registry 내부에서 해결되면서 standalone 이 고아가 됐다. 회수 결정 없음.
- **최소 수정**: (1) standalone 에 원격 생성 + push(#790 과 동형, context 와 **같은 PR/절차로 묶으면 비용 1회**), (2) archive, (3) devkit 어댑터는 F2 에서 이미 비활성화. registry 내부 구현이 정식 소유자임을 `ecosystem-contract` 성격 문서 1줄로 기록.
- **수정 전 재현**: `git -C aigentry-bridge remote -v` 무출력 + `git log --oneline` 1줄 = 재현. **수용 기준**: push 후 origin/main 이 로컬 HEAD 와 일치, archive 후 registry 테스트 통과 유지.
- **소유**: `aigentry-bridge` / architect(결정) → builder(원격·archive)
- **의존/롤아웃/롤백**: F2 와 묶어 진행. 롤백 = archive 해제.
- **task 매핑**: **#279 UPDATE**(Track E14 Phase A 설문이 forum/hooks/registry/starter/ssot/design/amplify/context/sandbox/**bridge** 10개 분류를 이미 대상으로 함) 또는 **#662 에 bridge 행 추가**. dedup — #790 은 context 전용이라 bridge 를 덮지 않으며, bridge 의 원격 부재는 **어떤 기존 task 에도 없다**. 최소 중복 경로는 **#790 의 범위를 "원격 없는 repo 전부(context + bridge)" 로 UPDATE** 하는 것.

---

## 3. 관측된 교차 패턴 (findings 를 관통하는 것)

1. **버전 좌표가 손으로 4곳에 복제된다** — installer-manifest, modules/*.adapter.json, 메타 package.json, ecosystem.json. 넷 다 서로 다르고 넷 다 소스와 다르다(F1/F2/F3/F4). **어느 하나를 고쳐도 나머지 셋이 다시 드리프트한다.** 단일 게이트(F4 의 `--check`)를 네 파일 전부로 확대하는 것이 최소 구조 개선이다.
2. **"동기화했다"와 "게이트가 있다"의 혼동** — #793 은 sync 를 수행하고 done 처리됐으나 두 릴리스 만에 다시 벌어졌다. 이 프로젝트의 lesson("문서는 강제가 아니다")이 sync 에도 동일하게 적용된다.
3. **dogfooding 이 공개 경로를 덮지 않는다** — F1/F2/F3 는 전부 "깨끗한 머신에서 설치"에서만 드러난다. 내부는 소스 트리로 돈다. `aigentry-sandbox/npm-test/` 가 이미 존재하지만 CI 로 묶여 있지 않다.
4. **미커밋 WIP 가 감사 신뢰도를 갉는다** — devkit **dirty 51**(#593 이 이미 티켓화), dustcraw 14, telepty 13, bridge 11. 본 감사의 devkit 관련 결론(F1/F2/F4)은 **커밋된 HEAD 기준**이며, 51개 미커밋 변경이 이미 일부를 고쳤을 가능성은 배제하지 못한다 — 이는 #593 의 "거버넌스 리스크, audit false-finding 원인" 이라는 표현이 정확함을 재확인한다.

---

## 4. 부록 A — 저장소 인벤토리 (22개, 전부 disposition 부여)

`~/projects/` 1-depth, 이름 `aigentry` 또는 `aigentry-*`. 측정 2026-09-08T13:36Z.
검사 깊이: **D**=deep(소스 라인 단위 확인) / **M**=manifest+구조만 / **S**=표면(존재·크기·git 만)

| # | repo | HEAD | branch | dirty | remote | manifest / 언어 | 역할 | 깊이 | disposition |
|---|---|---|---|---|---|---|---|:-:|---|
| 1 | aigentry | f959b29 (2026-07-26) | main | 4 | ✅ | package.json `@dmsdc-ai/aigentry` 0.1.1 / JS | 메타 설치 패키지 | D | F3 |
| 2 | aigentry-amplify | b555848 (2026-07-26) | main | 7 | ✅ | package.json 0.0.1 **private:true** / TS 워크스페이스 | 콘텐츠/마케팅 | M | F2(설치경로), #662 archive 검토 |
| 3 | aigentry-analyst | 8a45a84 (**2026-04-09**) | main | 3 | ✅ | package.json `aigentry-analyst` 1.0.0 / JS+MCP | analyst role MCP | M | 외부 소비자 0, 5개월 무변경 — #279 분류 대상 |
| 4 | aigentry-architect | **NO GIT** | — | — | ❌ | 없음 (26 파일, 364K) | architect role artifact | D | **F5** |
| 5 | aigentry-aterm | 9b4cec5 (2026-08-15) | main | 8 | ✅ (aterm.git) | Cargo workspace 3 crates(전부 0.1.0) + Swift / **npm package.json 없음** | 터미널 런처 | M | ecosystem.json 은 npm 0.2.14 UNLICENSED 주장 — 로컬 검증 불가(**미측정**), #782 브랜치 표류 |
| 6 | aigentry-brain | 0ffa6ee (2026-08-16) | main | 6 | ✅ | package.json 0.3.1 / TS+MCP | 영속 메모리 | D | 활성. `src/context/` 가 #7 을 흡수(F7) |
| 7 | aigentry-bridge | 5eabef0 (**2026-04-01, init 커밋 유일**) | main | 11 | ❌ **없음** | package.json `@dmsdc-ai/aigentry-bridge` 0.1.0 / JS | CLI 원격제어 SDK | D | **F8** |
| 8 | aigentry-builder | **NO GIT** | — | — | ❌ | 없음 (4 파일, 28K) | builder role artifact | S | **F5** |
| 9 | aigentry-context | eb23360 (2026-07-26) | main | 3 | ❌ **없음** | package.json 0.0.1 / JS+MCP, 1,436 LOC | 컨텍스트 압축/투영 | D | **F7** (#662/#790) |
| 10 | aigentry-deliberation | b009549 (2026-07-26) | main | 3 | ✅ | package.json 0.0.47 / JS+MCP | 다중 AI 토론 | M | 활성. `demo/forum/` 자체 벤더 → #14 대체 |
| 11 | aigentry-design | **NO GIT** | — | — | ❌ | 없음 (13 파일, 224K) | design role artifact | S | **F5** |
| 12 | aigentry-devkit | bb7876b (2026-07-26) | main | **51** | ✅ | package.json 0.1.14 / JS | 설치/스캐폴드 | D | **F1/F2/F4** + #593(WIP) |
| 13 | aigentry-dustcraw | c0af3c9 (2026-07-26) | main | 14 | ✅ | package.json 0.4.0 / TS | 외부 리서치 | M | F2(어댑터가 0.3.1 핀), #662 검토 |
| 14 | aigentry-forum | f1fc896 (**2026-03-01**) | main | 1 | ✅ | 없음 (index.html + assets) | 토론 시각화 | M | **소비자 0**. deliberation 이 `demo/forum/` 로 자체 벤더링(README:55,58) → **대체됨**. §1.4: 부활 금지, #279 분류 대상 |
| 15 | aigentry-hooks | 507393e (2026-07-26) | main | 7 | ✅ | package.json 0.0.2 / JS | 훅 런너 | M | 외부 소비자 = devkit **테스트 1건**뿐. #279 분류 대상 |
| 16 | aigentry-logger | f4f62e3 (2026-06-06) | main | 1 | ✅ | package.json 0.2.0 / JS | 텔레메트리 | M | **실사용**: orchestrator `src/telemetry/logger-emit.ts:18-19`, brain, deliberation, devkit 4곳 import. #527/#671 |
| 17 | aigentry-orchestrator | ca93cb6 (**2026-09-08**) | main | 10 | ✅ | package.json 0.2.0 / TS+shell | 컨트롤 타워 | D | **F5/F6**. 가장 활발 |
| 18 | aigentry-registry | ac221cd (2026-07-26) | main | 3 | ✅ | pyproject `aigentry` 0.2.0 / **Python** + 내부 TS bridge | 에이전트 레지스트리 | M | 유일한 Python 축. 내부 `bridge/` 가 F8 의 실소유자 |
| 19 | aigentry-sandbox | **NO GIT** | — | — | ❌ | 없음 (**71 파일, 15M**) | 격리 테스트 환경 | D | **#662 의 "0파일" 주장 반증**. F1 재현 인프라로 보존 권고 |
| 20 | aigentry-ssot | 42afae4 (2026-07-26) | main | 3 | ✅ | `pkg/package.json` `@dmsdc-ai/aigentry-ssot` 1.0.0 / TS | 계약 스키마 | M | **실사용**: orchestrator `src/session/inject-parser.ts:27` import, logger 의존. #783/#785 |
| 21 | aigentry-starter | c310f28 (**2026-04-01**) | main | 4 | ✅ | 없음 (템플릿/컨트랙트 트리) | 신규 프로젝트 시드 | S | 5개월 무변경. #279 분류 대상 |
| 22 | aigentry-telepty | 997ea7c (**2026-09-08**) | main | 13 | ✅ | package.json 0.8.3 / JS | PTY 전송 | D | 활성. **F1 의 피해자** |

**요약**: git 없음 4 / 원격 없음 2(bridge, context) / 5개월+ 무변경 5(analyst, bridge, forum, starter, + design·builder 는 git 부재로 판정 불가) / 오늘 변경 2(orchestrator, telepty).

## 부록 B — 중첩 패키지 disposition

| 경로 | 매니페스트 | disposition |
|---|---|---|
| `aigentry-ssot/pkg/` | `@dmsdc-ai/aigentry-ssot` 1.0.0, deps `{}` | **실제 배포 단위**. 루트가 아니라 여기가 패키지 — #785(prepare 훅 부재) 대상 |
| `aigentry-amplify/packages/core` | `@aigentry-amplify/core` 0.0.1 | workspace 내부. 루트 private:true 라 미배포 |
| `aigentry-amplify/packages/channels` | `@aigentry-amplify/channels` 0.0.1, dep `core:workspace:*` | 동상 |
| `aigentry-registry/bridge/` | **`aigentry-bridge`(unscoped) 0.1.1**, dep `ws` | **F8 의 실소유 구현**. Python repo 안의 TS 패키지 |
| `aigentry-aterm/{aterm-core,aterm-session,aterm-ipc}` | Cargo 0.1.0 ×3 | Rust workspace 멤버. npm 배포 단위와 버전 체계 불일치(§부록A #5) |
| `aigentry-brain/aigentry-brain/` | 없음 | **파일 0개인 빈 중첩 디렉터리** (`find -type f` 무결과). 잔재 — 삭제 후보이나 별도 finding 승격 안 함 |

## 부록 C — 의존성 엣지 (런타임 import 검증 기준)

**R**=런타임 JS import 확인 / **C**=CLI/PATH 경계(import 아님) / **M**=매니페스트 선언만, 호출부 미확인

| from | to | 종류 | 증거 |
|---|---|:-:|---|
| orchestrator | logger | **R** | `src/telemetry/logger-emit.ts:18-19` `import { emit as loggerEmit }` |
| orchestrator | ssot | **R** | `src/session/inject-parser.ts:27` |
| orchestrator | telepty | **C** | `bin/*.sh` ×20 `command -v telepty`. package.json 은 `^0.8.0` 선언하나 **JS import 0건** |
| brain | logger | **R** | `src/telemetry/logger-emit.ts` + 테스트 |
| deliberation | logger | **R** | `logger-emit.js` |
| devkit | logger | **R** | `lib/logger-emit.js` |
| logger | ssot | **M** | package.json dep. #671 이 "ssot→devDep 강등" 을 이미 제안 |
| registry(py) | registry/bridge(ts) | **R** | `src/aigentry/services/bridge/registry.py` + 테스트 2종 |
| dustcraw | registry | **M/R** | `src/registry/RegistryClient.ts`, `src/decision-gate/*` — HTTP 클라이언트(런타임 호출은 **미측정**, 네트워크 금지) |
| meta aigentry | aterm/telepty/devkit/brain/deliberation | **M** | package.json only. **F3 — range 3/5 도달 불가** |
| devkit(설치기) | telepty/brain/dustcraw/amplify/bridge | **M** | 어댑터 JSON. **F1/F2 — 좌표 불일치** |

**사이클**: 실제 유향 경로 기준 **0건**. logger→ssot 는 단방향이고 ssot 는 deps `{}` 이다. orchestrator↔telepty 도 C 경계라 코드 사이클 아님. (매니페스트만 보면 사이클처럼 보이는 쌍은 없었다.)

---

## 5. task 매핑 요약 (등록은 orchestrator 권한)

| finding | 심각도 | 제안 | 기존 ID |
|---|---|---|---|
| ECO-1140-01 telepty@0.1.45 핀 | CRITICAL | **NEW** | 없음(정규식 0건) |
| ECO-1140-02 `@aigentry/bridge`·private·stale 핀 | HIGH | **NEW**(01과 동일 PR) | 없음 |
| ECO-1140-03 메타 패키지 range | HIGH | **NEW** | 없음 |
| ECO-1140-04 ecosystem.json 게이트 | MEDIUM | **NEW** 또는 #267 하위 | #793=done(재개 불가) |
| ECO-1140-05 role SSOT 이분화 | HIGH | **UPDATE** | **#292** |
| ECO-1140-06 spawn 게이트 dormant | MEDIUM | **UPDATE**(현행 측정치 갱신 + `sec-wire-enforce-spawn` 종속화) | **#655** |
| ECO-1140-07 context 휴면·brain 중복 | MEDIUM | **UPDATE**(+"sandbox 0파일" 정정, #790 선행 명시) | **#662**, **#790** |
| ECO-1140-08 bridge 원격 부재·이름 충돌 | MEDIUM | **UPDATE**(#790 범위를 "원격 없는 repo 전부" 로 확대) | **#790** / #279 |

**#526 EPIC 에 대하여**: 본 감사는 #526 이 기다리던 current-source refresh 를 수행했다. 결과는 "대대적 overhaul 필요" 가 아니라 **"3개 JSON 파일의 좌표 정정 + 게이트 1개"** 다. #526 은 F1~F4 를 하위로 묶어 **범위를 축소하여 재정의**할 것을 권고한다 — 이것이 §1(경량) 에 부합한다.

**발명된 ID 없음.** 위 기존 ID 는 전부 `state/task-queue.json`(schema_version 기준, tasks 1138 / open 357) 에서 직접 읽었다.
