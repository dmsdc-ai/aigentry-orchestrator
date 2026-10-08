# aigentry 에코시스템 아키텍처 현황 감사 (#1140)

- 측정 시각 (실측, 추정 없음): 1차 열거 **2026-09-08T13:36:16Z** (`date -u` 기록) → 1차 커밋 `6bd5d78` **13:45:42Z** (`git log %cI`) → rev2 정정 재측정 **13:47Z–13:50Z** → rev3 파일 수 재실측 **13:52Z**
- 세션: `ec1140-architect` / role `architect` / worktree `/Users/duckyoungkim/.aigentry/worktrees/ec1140` / branch `docs/1140-ecosystem-architecture`
- 성격: **#526 EPIC 의 current-source refresh**. 신규 overhaul epic 아님. #1141 operations analyst 와 병렬.
- 권한: 읽기 전용 분석. 코드/설정/task-queue 변경 없음. 본 리포트 1개 파일만 커밋.
- **개정 이력**: rev1 `6bd5d78` → rev2 `8e8c6f9` → **rev3(본 문서)**. rev2 는 오케스트레이터 사실 검토 7개 항목을, rev3 은 #1141 analyst 와의 파일 수 불일치(술어 차이) 및 미승인 제안 표기를 정정. 정정 내역은 §0.2 에 전부 명시하며 **조용한 수정은 하지 않았다**.
- **제안의 지위**: 본 리포트의 모든 신규 티켓 후보(C-1/C-2), 기존 티켓 범위 확대(#790), 수용 기준은 **architect 의 미승인 제안**이다. 등록·승인·범위 확정은 orchestrator 권한이며, 승인 전까지 기존 티켓 범위는 변경되지 않는다.

---

## 0. 측정 우주와 정정 로그

### 0.1 counted universe

**포함**: `fs.readdirSync("~/projects")` 로 직접 열거한, 이름이 `aigentry` 또는 `aigentry-*` 인 1-depth 디렉터리 — **23개**.
그중 **git 미초기화 5개**: architect, builder, design, sandbox, tester.
중첩 패키지는 부록 B 에서 별도 disposition.

**미측정(명시)**:
- **npm 레지스트리 상태 전부** — 게시 여부, 게시 버전, 스코프 소유권, 이름 점유 여부. 네트워크 조회를 하지 않았다. 본 문서의 모든 버전·좌표 진술은 **로컬 소스 파일 대 로컬 소스 파일** 비교이며, 그로부터 도출되는 것은 **불일치(incompatibility risk)** 이지 **설치 실패 관측**이 아니다.
- **실제 설치 실행** — `install.sh` / `install-fallback.js` / `npm install` 을 실행하지 않았다. 설치 결과에 대한 진술 없음.
- **런타임 실행 관측** — 데몬·앱 미실행. 프로세스/트래픽/성능 수치 없음. 런타임 근거가 필요한 판단은 #1141 몫.
- **원격 브랜치·CI·백업** — `git fetch` 미실행. `git remote` 부재는 **해당 repo 에 원격이 설정되지 않았다**는 사실일 뿐이며, **백업이 없다는 증거가 아니다**(외부 백업·복제본 미조사).
- **완전 호출 경로(call-path) 증명** — 본 감사의 소비자 판정은 텍스트 검색 + 매니페스트 파싱 기반이다. 동적 로딩·설정 주입·문서/테스트 경유 소비를 전수 조사하지 않았다.

### 0.2 rev1 → rev2 정정 내역 (오케스트레이터 검토 대응)

| # | rev1 진술 | 실측 결과 | 처리 |
|---|---|---|---|
| 1 | 저장소 22개 / git 없음 4개 / 종료 13:52Z | **23개**(tester 누락) / **5개**(tester 포함) / 13:52Z 는 **커밋 시점 13:45:42Z 기준 미래** = 관측 아닌 추정 | 부록 A 23행 재작성, 헤더 실측 시각으로 교체 |
| 2 | "aterm 은 npm 매니페스트 없음(미측정)" | **`npm/aterm/package.json` 존재** — `@dmsdc-ai/aterm` 0.2.13, MIT, deps devkit≥0.0.19 + telepty≥0.1.88, optional peer `@dmsdc-ai/aigentry`≥0.1.0, optional dep darwin-arm64 | 루트 전용 탐색이 부재의 근거가 될 수 없음. 부록 A·C 정정, **매니페스트 엣지 사이클 1건 신규 기록** |
| 3 | F1 "현재 피해, 가설 아님 / 모든 진입 경로가 깨진다 / 내부는 이 경로를 안 밟는다", F2 "미보유 스코프 = 공급망 취약" | **실행 경로 오판정.** `install.sh:509` → `run_install_fallback` → `install-fallback.js:68-79` 는 **어댑터의 `install.fallback[]`** 를 읽는다. telepty fallback = `version:"latest"`, bridge fallback = `kind:"skip"`. `attach.install_command` 는 **코드 소비자 0**(스키마 정의만). `private:true` 는 게시 보호이지 레지스트리 부재 증명 아님. 로컬 `@aigentry` 패키지 부재는 스코프 소유권과 무관 | F1/F2 전면 재작성·강등, 단정 문구 전부 삭제 |
| 4 | "최소 수정 = 3줄", "`--verbose` 로 dry 확인", "롤백 = 재퍼블리시" | 3줄 근거 없음(soft-policy·optional 모듈·warn/die 미조사). `--verbose` 는 dry 아님 — **`--dry-run` 이 실재**(`install-fallback.js:679,704-716`, 체인 출력 후 `process.exit(0)`, exec 이전 단락). npm 은 기존 버전 재게시 불가 | 수정 규모 주장 철회, `--dry-run` 로 교체, 롤백을 "이전 지원 버전 고지 + 보존 아티팩트" 로 교체 |
| 5 | "dedup 정규식 0건 → NEW" ×4 | **거짓.** #62(메타 패키지 생성), #64(aterm→aigentry 의존), `ux-public-front-door`(**메타 stale pin 명시 기록**), #526(**@aigentry 스코프 전략 dimension 9**), #1136(npm/README/매니페스트 정합성 범위 보유) | 문자열 정규식 → 의미 기반 소유자 비교로 재수행. **신규 후보 4 → 2(+선택 1)**, 나머지 기존 ID 매핑 |
| 6 | "archive/삭제 권고"(context/bridge), "sandbox 삭제 근거 무효" | 매니페스트 소비자만으로 archive 수용 불가. brain 중복은 **기능 동등 미증명**. 원격 부재 ≠ 백업 부재. 게이트 importer 0 은 **완전 호출경로 증명 아님** | 모든 archive/삭제 권고 철회 → "소비자 조사 미완, 판단 보류". sandbox **보존**. #655 warn-first 정책 보존, B/C 삭제 제안 철회 |
| 8 | 파일 수 sandbox 71 / design 13 | **집계 술어 미명시.** 실측: `-type f` = sandbox **75**, design **14**; `.DS_Store` 각 4·1건. rev1/rev2 는 `! -name '.DS_Store'` 를 적용하고도 **그 사실을 표기하지 않았다**. #1141 analyst 의 75/14 는 `-type f` 기준으로 **정확**하며 불일치는 술어 차이 전부 | 부록 A 에 술어 명시 + 양쪽 수치 병기, 심볼릭 링크 별도 표기 |
| 7 | `aigentry-devkit@bb7876b <file>:<line>` 로 일괄 인용 | **혼입.** `installer-manifest.json` 은 HEAD 클린이나, 4개 어댑터·`install.sh` 는 **dirty**, `lib/install-fallback.js` 는 **untracked** — HEAD 에 존재조차 하지 않음 | 모든 증거에 `[HEAD]` / `[WT-dirty]` / `[WT-untracked]` 출처 태그 부착 |

---

## 1. Executive verdict (rev2)

### 1.1 지켜야 할 강점

1. **경계가 실제로 지켜지고 있다.** orchestrator → telepty 는 JS import 가 아니라 PATH 상 CLI 호출이다(`bin/*.sh` 20+ 사이트가 `command -v telepty`). 매니페스트 엣지 = 런타임 결합이라는 오해가 여기선 사실이 아니고 transport 교체 가능성이 살아 있다. §1(경량) 을 실제로 만족.
2. **4-layer 지시문 합성이 작동한다.** `resolveInstructions()`(`src/session/resolve-instructions.ts:130`)가 layer 순서를 강제 정렬하고 layer 별 `content_sha256` + `effective_prompt_digest` 를 남긴다. 본 세션이 common+role 2-layer 로 부팅된 것이 실증. 감사 가능한 프롬프트 합성은 진짜 자산.
3. **설치기가 이미 fallback 체인으로 진화 중이다.** `install-fallback.js` 는 npm-global / npm-ephemeral / local-runtime / skip 을 chain + 분류된 에러(`classifyError`) + `--dry-run` 으로 처리한다. **rev1 이 이 파일의 존재를 놓치고 구경로를 현행으로 오인했다.** 새 추상화가 아니라 이 파일을 완성·커밋하는 것이 정답.
4. **벤더링 파이프라인은 동작한다.** `ecosystem.json` 6개 사본이 byte-identical(sha256 `722f3d5d9844…`). #793 이 한 일은 실제로 됐다.
5. **telepty CHANGELOG 의 기록 규율** — 근본원인·측정치·회귀 테스트 파일명까지 남긴다(#721/#732/#760). 확산 가치 있음.
6. **컷 웨이브(#769 Phase C)** 가 실제 LOC 를 줄였다(registry −46,904 / ssot −15,953 / dustcraw −3,053).

### 1.2 최고 임팩트 체계적 약점 (재진술)

rev1 의 "설치 경로가 깨져 있다"는 **철회한다**. 실측이 지지하는 약점은 더 좁고 더 정확하다:

**버전·좌표가 여러 파일에 손으로 복제되어 있고, 어느 것이 권위인지 코드만 읽어서는 알 수 없다.**
telepty 좌표만 세 곳에 있다 — `installer-manifest.json`(0.1.45, HEAD 클린), 어댑터 `attach.install_command`(0.1.45, **코드 소비자 0**), 어댑터 `install.fallback`(latest, **실제 소비 경로**, 미커밋). 세 값이 다르고, **읽히는 것은 셋 중 하나뿐이며, 그 하나는 커밋되지 않았다.** rev1 이 정확히 이 구조 때문에 오판했다 — 감사자가 오판했다면 유지보수자도 오판한다. 이것이 이 감사의 가장 재현성 높은 발견이다.

두 번째 축은 **미커밋 WIP 의 규모**(#593). devkit dirty 51 에는 어댑터 4개·`install.sh`·`install-fallback.js`·`templates/aigentry-architect/CLAUDE.md` 가 포함된다. 즉 **설치 계약과 역할 템플릿 SSOT 가 동시에 커밋되지 않은 상태**다. HEAD 기준 감사와 실동작이 갈리는 근본 원인이며, #593 의 "audit false-finding 원인" 이라는 표현이 rev1 에서 그대로 실현됐다.

### 1.3 최소 개선안

| 시점 | 항목 | 근거 |
|---|---|---|
| **NOW** | #593 devkit WIP 커밋 — 특히 `install-fallback.js` + 어댑터 4종 | 실동작이 커밋되어야 이후 모든 판단이 재현 가능 |
| **NEXT** | C-1 좌표 권위 단일화(inert 필드 제거 또는 스키마상 deprecated 명시) | 오판 재발 차단 |
| **NEXT** | C-2 버전 드리프트 `--check` 게이트(#1136 in-repo 범위와 경계 구분) | sync 는 이벤트, gate 는 상태 |
| **DEFER** | F5 role SSOT, F6 게이트 결정, F7/F8 소비자 조사 | 조사·결정 비용이 현재 피해보다 큼 |

### 1.4 도입하지 말 것

- **통합 모노레포 / 새 install orchestration 계층** — `install-fallback.js` 가 이미 필요한 일을 한다. 문제는 계층 부재가 아니라 좌표 권위의 모호함.
- **ecosystem.json 을 23개로 확대** — 등재 확대는 또 하나의 stale SSOT 를 만든다. 게이트가 등재보다 싸다.
- **`latest` 또는 "로컬 버전과 정확히 동일" 을 호환성 보장으로 채택** — 둘 다 보장이 아니다. `latest` 는 미래 breaking 을 자동 수용하고, **로컬 버전 동일성(local-version equality)은 레지스트리 상태를 확인하지 않은 추정이므로 호환성 기준이 될 수 없다**. 하한 range 값 확정에는 레지스트리 조회(본 세션 범위 밖)가 선행한다. 아래 C-2 가 제안하는 `--check` 는 **드리프트 탐지 신호**일 뿐 **호환성 판정 기준이 아니며**, 제안 상태이지 승인된 기준이 아니다.
- **aigentry-sandbox 삭제** — 격리 npm-test 환경이다(`-type f` **75**, 15M — 부록 A 술어 참조). #662 의 "0파일" 은 오류이며 **보존**이 정답.
- **spawn 게이트 class-B/C 삭제** — rev1 제안 철회. importer 0 은 완전 호출경로 증명이 아니다.
- **context/bridge 즉시 archive** — rev1 제안 철회. 소비자 조사가 매니페스트 수준에서 멈춰 있다.

---

## 2. Findings (8) — rev2

> 증거 출처 태그: **[HEAD]** = `git show HEAD:` 로 확인한 커밋된 blob / **[WT-dirty]** = 추적 중이나 미커밋 변경 있음 / **[WT-untracked]** = git 에 없음
> 심각도와 신뢰도는 별도 표기. "현재 피해" 는 관측된 것만, 나머지는 "가설 위험" 으로 명시.

---

### ECO-1140-01 — telepty 설치 좌표가 3곳에 다른 값으로 존재하고, 권위 필드가 미커밋

- **심각도 MEDIUM / 신뢰도 HIGH** *(rev1 CRITICAL 에서 강등 — 근거는 아래 "정정")*
- **증거** (`aigentry-devkit`, HEAD `bb7876b`)
  - **[HEAD]** `config/installer-manifest.json:109` → `components.telepty.install.version = "0.1.45"` (`git show HEAD:` 확인, working tree 클린)
  - **[WT-dirty]** `config/modules/telepty.adapter.json:18` `attach.install_command = "npm install -g @dmsdc-ai/aigentry-telepty@0.1.45"` — HEAD blob 과 working tree 모두 동일 값
  - **[WT-dirty]** 같은 파일에 미커밋 추가: `install.fallback = [{kind:"npm-global", package:"@dmsdc-ai/aigentry-telepty", version:"latest"}]`
  - **[WT-untracked]** `lib/install-fallback.js:68-79` `readAdapterFallback()` 은 `config/modules/<c>.adapter.json` 의 **`install.fallback[]` 만** 읽는다. `installer-manifest.json` 도 `attach.install_command` 도 읽지 않는다.
  - **[WT-dirty]** `install.sh:509-510` → `run_install_fallback "telepty"` (fallback 경로)
  - **[HEAD]** `install.sh:461-465` → `npm install -g "$TELEPTY_SPEC"` where `TELEPTY_VERSION = manifest.components.telepty.install.version` — **HEAD 에서는 매니페스트의 0.1.45 가 실행 경로 위에 있다**
  - `attach.install_command` 의 코드 소비자: `config/module-adapter.schema.json:70`(스키마 속성 정의) **1건뿐**, 실행 코드 0건
- **현재 피해 vs 가설 위험**: **관측된 설치 실패 없음.** 설치를 실행하지 않았고 레지스트리도 조회하지 않았다. 관측된 것은 **세 필드의 값 불일치**와 **권위 필드가 커밋되지 않았다**는 사실뿐이다. 가설 위험은 두 갈래 — (a) HEAD 상태로 배포되면 매니페스트의 exact pin 이 실행 경로에 남는다, (b) `attach.install_command` 가 사람이 읽고 손으로 실행할 수 있는 형태로 stale 값을 광고한다.
- **정정(중요)**: rev1 은 이를 CRITICAL "clean install 이 프로토콜을 실행 불가" 로 단정했다. **철회한다.** 실제 소비 경로는 `install.fallback` 의 `latest` 이고, `--submit-force` 도입 이력(telepty CHANGELOG 0.3.3)은 **가설을 지지할 뿐 실패를 관측한 것이 아니다.** 0.1.45 를 설치해보지도, 레지스트리 해석을 확인하지도 않았다. #1141 도 독립적으로 동일한 latest/skip 구분에 도달했다.
- **근본원인**: 좌표가 세 파일에 복제되고, 어느 것이 권위인지 스키마·주석·문서 어디에도 없다. 마이그레이션(구 매니페스트 경로 → 신 fallback 체인)이 진행 중인데 절반이 미커밋이라 두 경로가 공존한다.
- **최소 수정 (규모 미주장)**: (a) `install-fallback.js` + 어댑터 4종을 커밋해 권위 경로를 확정(#593), (b) `installer-manifest.json` 의 telepty exact pin 을 fallback 체인과 정합화, (c) `attach.install_command` 를 스키마에서 deprecated 로 표시하거나 제거. **rev1 의 "3줄" 주장은 철회한다** — soft/optional 모듈 정책과 `install.sh:519-531` 의 warn-vs-die 처리를 함께 검토해야 규모가 정해진다.
- **수정 전 재현 (비실행)**: `node lib/install-fallback.js telepty --dry-run` — 이 모드는 체인을 출력하고 `process.exit(0)` 하며(`install-fallback.js:704-716`) **exec 이전에 단락**한다. 출력의 `version=` 값과 `installer-manifest.json:109` / `attach.install_command` 세 값을 대조하면 불일치가 재현된다. **수용 기준**: 세 값이 일치하거나, 비권위 필드가 스키마상 명시적으로 비활성. 재현 테스트는 **설치기를 스텁**해야 하며 실제 shell 설치를 수행해서는 안 된다.
- **소유**: `aigentry-devkit` / coder
- **의존/롤아웃/롤백**: #593 선행. 롤백은 **npm 재게시가 아니다** — 게시된 버전은 불변이므로, 롤백 경로는 (i) 보존된 이전 아티팩트 지시, (ii) 지원 이전 버전 고지, (iii) 운영자 수동 다운그레이드다.
- **task 매핑**: **#593 UPDATE**(미커밋 WIP 정리 — 이 finding 이 그 거버넌스 리스크의 구체적 실현 사례). 좌표 권위 정리 자체는 **신규 후보 C-1**(§5).

---

### ECO-1140-02 — bridge / amplify 설치 좌표: 실행되지 않는 문자열과 실행되는 체인의 불일치

- **심각도 LOW–MEDIUM / 신뢰도 HIGH** *(rev1 HIGH "공급망 위험" 에서 강등)*
- **증거**
  - **[WT-dirty]** `config/modules/bridge.adapter.json` `install.fallback = [{kind:"skip", message:"bridge is a placeholder — no install action"}]` → **설치 시도 자체가 없다**
  - **[HEAD & WT]** 같은 파일 `attach.install_command = "npm install -g @aigentry/bridge"` — 실행 코드 소비자 0
  - **[HEAD]** `config/installer-manifest.json:224` `"package": "@aigentry/bridge"`
  - **[WT-dirty]** `amplify.adapter.json install.fallback = [{npm-global, @dmsdc-ai/aigentry-amplify, latest}, {skip, "amplify unavailable — …"}]` / `dustcraw` 동형(`latest` + skip)
  - `aigentry-amplify/package.json:4` `"private": true`
- **현재 피해 vs 가설 위험**: **현재 피해 없음.** bridge 는 skip 이라 어떤 좌표로도 설치되지 않는다. amplify/dustcraw 는 `latest` + skip 이라 rev1 이 지적한 stale pin(0.3.1)이 실행 경로에 없다.
- **정정(중요)**: rev1 의 세 단정을 모두 철회한다 — (i) "`@aigentry/bridge` 는 미보유 스코프이므로 공급망 취약": **로컬에 `@aigentry` 패키지가 없다는 사실은 스코프 소유·점유 여부를 전혀 말해주지 않는다**. 레지스트리 미조회. 더구나 **#526 dimension (9) 가 "@aigentry org 전면 이관 전략" 을 명시적으로 보유**하므로 이 문자열은 오타가 아니라 **전략의 선행 흔적일 가능성이 높다**. (ii) "`private:true` 이므로 설치가 반드시 실패": `private` 는 **게시 사고 방지 플래그**이며 레지스트리 부재의 증명이 아니다. (iii) "stale 핀이 설치된다": 실행 체인은 `latest` 다.
- **근본원인**: ECO-1140-01 과 동일 — inert 필드(`attach.install_command`)가 실행 필드와 나란히 살아 있어 독자를 오도한다.
- **최소 수정**: `attach.install_command` 의 지위를 스키마에서 확정(비활성 표기 또는 제거). `@aigentry` 좌표의 유지/변경은 **#526 스코프 전략의 결론에 종속**시키고 여기서 단독 결정하지 않는다.
- **수정 전 재현 (비실행)**: `node lib/install-fallback.js bridge --dry-run` → `[0] kind=skip message="bridge is a placeholder…"` 출력으로 "설치 없음" 이 확인된다. **rev1 이 제안한 `--verbose` 는 dry 모드가 아니므로 사용 금지.** 어떤 재현도 설치기를 스텁해야 한다.
- **소유**: `aigentry-devkit` / coder — 단 좌표 결정권은 **#526**
- **의존/롤아웃/롤백**: #526 스코프 전략 종속. 롤백 = 스키마/JSON revert.
- **task 매핑**: **#526 UPDATE**(dimension 9 에 "devkit 어댑터에 이미 @aigentry 좌표가 존재함" 을 측정 사실로 추가). 별도 신규 티켓 불필요.

---

### ECO-1140-03 — 메타 패키지 range 가 로컬 현행 세대에 도달하지 못한다 (재발)

- **심각도 MEDIUM / 신뢰도 HIGH (로컬 비교 한정)** *(rev1 HIGH 에서 강등 — 레지스트리 미측정)*
- **증거** — `aigentry@f959b29 package.json` [HEAD, working tree 클린]

  | 선언 range | 로컬 소스 version | 0.x caret 해석 | 로컬 현행 도달? |
  |---|---|---|---|
  | telepty `^0.6.6` | 0.8.3 | `>=0.6.6 <0.7.0` | ✗ |
  | brain `^0.2.8` | 0.3.1 | `>=0.2.8 <0.3.0` | ✗ |
  | devkit `^0.0.22` | 0.1.14 | `>=0.0.22 <0.0.23` | ✗ |
  | deliberation `^0.0.47` | 0.0.47 | `=0.0.47` | ✓ |
  | aterm `^0.2.14` | **`npm/aterm/package.json` = 0.2.13** | `>=0.2.14 <0.3.0` | ✗ (로컬이 range 하한 미만) |
- **현재 피해 vs 가설 위험**: **레지스트리를 조회하지 않았으므로 실제 설치 결과는 미측정.** 관측 사실은 "선언 range 가 로컬 소스 버전을 포함하지 않는다" 뿐이다. 실제 게시본이 range 안에 존재할 수도, 존재하지 않을 수도 있다. 가설 위험: §17 이 약속한 단일 명령 공개 설치가 로컬 현행과 다른 세대를 가져올 수 있다.
- **정정**: rev1 은 "aterm 은 npm 매니페스트가 없어 미측정" 이라 했으나 **`npm/aterm/package.json` 이 실재**한다(0.2.13, MIT). 루트 전용 탐색이 부재의 근거가 될 수 없다는 지적이 옳다. 또한 이 매니페스트가 `ecosystem.json` 의 "로컬 HEAD 는 MIT 0.2.13 을 의도" 라는 주석을 **로컬 증거로 뒷받침**한다(게시본 UNLICENSED 여부는 여전히 미측정).
- **근본원인**: 릴리스 시 메타 range 를 갱신하는 절차가 없고, 0.x caret 이 minor 를 고정한다는 규칙이 반복적으로 밟힌다.
- **최소 수정**: range 갱신은 **레지스트리 실제 게시본 확인이 선행**해야 한다(본 세션 범위 밖). `latest` 로의 치환이나 "로컬 버전과 동일" 은 **호환성 보장이 아니므로 채택하지 않는다**(§1.4). 실효 수정은 range 정정 + 재발 방지 게이트의 결합.
- **수정 전 재현**: 로컬 한정 재현 = 위 표의 range/버전 대조(비네트워크). 실제 설치 결과 재현은 레지스트리 접근이 필요하며 **본 세션 미수행**.
- **소유**: `aigentry`(메타) / coder + builder
- **의존/롤아웃/롤백**: 레지스트리 확인 선행. 롤백은 재게시 불가 — 이전 지원 버전 고지 + 보존 아티팩트 경로.
- **task 매핑**: **`ux-public-front-door`(done) 의 재발.** 그 티켓이 동일 결함을 이미 기록했다 — "meta pkg stale pins (telepty ^0.1.83 vs 0.6.6)". **evidence delta**: 핀이 `^0.1.83`→`^0.6.6` 으로 한 번 올라갔으나 로컬은 0.8.3 으로 다시 벌어졌다 = **일회성 repin 으로는 해결되지 않는 계열의 결함**임이 실증됐다. 관련 기존 ID: **#62**(메타 패키지 생성), **#64**(aterm→aigentry 의존 — 부록 C 의 optional peer 엣지의 출처). **재발 티켓 신설 근거**: 원본이 done 이고 그 범위는 6항목 punch list 였으며, 지금 필요한 것은 repin 이 아니라 **드리프트 게이트**다 → 신규 후보 **C-2** 로 통합(§5).

---

### ECO-1140-04 — `ecosystem.json` 은 SSOT 를 자칭하나 23개 중 6개만 덮고 값이 stale

- **심각도 MEDIUM / 신뢰도 HIGH**
- **증거**: 6개 사본 sha256 전부 `722f3d5d9844…`(배포 정상) / `_comment` = "Canonical … Source of truth" / `modules[]` 6개 vs 실제 23개 / telepty 행 `0.7.1` vs 로컬 `0.8.3` / orchestrator 행 `"package":"aigentry-orchestrator"`, `"version":"—"` vs 실제 `@dmsdc-ai/aigentry-orchestrator` 0.2.0
- **현재 피해 vs 가설 위험**: 관측된 피해 = README 생태계 표가 이 파일에서 생성되므로 **공개 문서가 stale 버전·부정확한 패키지명을 노출**한다(파일 내용으로 확인). 가설 = "source of truth" 문구가 17개 디렉터리의 부재를 정상으로 보이게 해 이전 감사들의 6개 기준 결론을 유도했을 가능성.
- **근본원인**: #793 이 **sync 를 1회 수행**했으나 **check 를 남기지 않았다.** telepty 두 릴리스가 지나는 동안 아무것도 실패하지 않았다.
- **최소 수정**: `sync-readme-tooling.mjs` 에 `--check` 모드(모듈 행 version ↔ 해당 repo 매니페스트 대조, 불일치 시 non-zero) + telepty/orchestrator 행 값 정정 + `_comment` 의 "Source of truth" 를 실제 범위("README 표 생성용 published-module 목록")로 정정. **커버리지 확대는 하지 않는다.**
- **#1136 과의 경계 (명시 요구 대응)**: #1136 production spec 의 「npm, installation and README scope」가 **orchestrator 패키지 자신의** `README.tmpl.md` ↔ 생성 README 정합, aspirational claim 금지, install/init/upgrade/uninstall 및 릴리스 게이트를 **이미 소유**한다. 본 finding 이 추가하는 것은 그 범위 밖의 **cross-repo 축**뿐이다 — 6개 벤더 사본 + 5개 형제 repo 의 모듈 버전 표. 즉 **#1136 을 대체하지 않고 additive** 이며, #1136 이 정의할 in-repo 게이트와 **동일 스크립트를 공유하도록 설계**하는 것이 중복을 피하는 길이다.
- **수정 전 재현**: `ecosystem.json` telepty 행(0.7.1) vs `aigentry-telepty/package.json`(0.8.3) 대조 = 재현. **수용 기준(제안)**: `--check` 가 현재 트리에서 non-zero, 값 정정 후 0. **단서** — 이 대조가 검증하는 것은 "표시된 값이 로컬 소스와 일치하는가" 즉 **문서 정합성**이며, **호환성이나 설치 가능성을 판정하지 않는다**(레지스트리 미측정). 로컬 버전 동일성을 호환성 기준으로 승격해서는 안 된다. 본 수용 기준은 **미승인 제안**이다.
- **소유**: `aigentry-devkit`(스크립트) + 6개 벤더 사본 / coder
- **의존/롤아웃/롤백**: #1136 의 in-repo 게이트 설계와 조율. 롤아웃 = #793 과 동일한 검증된 재생성 절차. 롤백 = 사본 revert.
- **task 매핑**: **#1136 에 cross-repo 경계를 명시**(위 문단) + 신규 후보 **C-2**(드리프트 게이트, ECO-1140-03 과 통합). #793 은 done 이며 **재개하지 않는다** — evidence delta 는 본 리포트에 기록되어 있고, 필요한 산출물이 sync 가 아니라 gate 라서 원 티켓 범위와 다르다.

---

### ECO-1140-05 — 역할 규칙 SSOT 이분화: role artifact 규칙이 dispatch 워커에 도달하지 않는다

- **심각도 MEDIUM–HIGH / 신뢰도 HIGH (로딩 경로), MEDIUM (영향 범위)**
- **증거**
  - 주입 경로: `~/.aigentry/instructions/roles/` 9개(analyst, architect, builder, coder, logger, orchestrator, researcher, reviewer, tester). `architect.md` = 30줄
  - 별도 경로: `~/projects/aigentry-architect/` = `CLAUDE.md`(82줄) + `AGENTS.md` + `docs` + `references`, 26 파일. CLAUDE.md 가 "실제 규칙은 AGENTS.md §1-§8", "§5 INVARIANTS — 위반 시 산출물 전면 폐기", "§6 FAILED APPROACHES" 선언
  - 단절 지점: **[HEAD]** `aigentry-orchestrator@ca93cb6 bin/boot-prepare.mjs:576` 주석 `cwd: sandboxCwd, // resolveInstructions reads project_id from cwd; sandbox = no project layer`. #431 role-sandbox 계약이 "no project CLAUDE.md auto-loaded" 를 명시
  - **자기 실증**: 본 세션의 시스템 프롬프트는 common + role 2-layer 이며 `instructions/roles/architect.md` 30줄만 포함. `aigentry-architect/AGENTS.md §5/§6` 미로드
  - **[WT-dirty]** **`aigentry-devkit/templates/aigentry-architect/{AGENTS.md, CLAUDE.md, references}` 존재** — devkit 이 role artifact 의 **템플릿 SSOT 이자 배포 주체**이며, 그 CLAUDE.md 는 현재 **미커밋 변경 상태**
- **현재 피해 vs 가설 위험**: 관측 = 워커 프롬프트에 해당 규칙 문자열이 없다(본 세션으로 실증). 가설 = 그로 인한 실제 위반 발생 여부는 미측정(런타임 관측 범위 밖).
- **정정**: rev1 은 소유를 "orchestrator instructions tree + role repo" 로만 잡았다. **틀렸다** — devkit `templates/` 가 propagation SSOT 이므로, 설치본 `~/.aigentry/instructions/` 에서만 저작하면 **devkit 배포 경로와 갈라진다**. 소유는 **devkit templates 를 포함**해야 한다. 또한 rev1 의 "4개 repo git 없음" 은 **5개**(tester 포함)로 정정.
- **근본원인**: role artifact repo 는 #431 role-sandbox **이전** 모델(세션이 역할 repo 로 cd)의 잔재다. sandbox 도입이 로딩 경로를 끊었으나 내용 이관과 소유권 재배치가 따라오지 않았다.
- **최소 수정**: architect 1개로 파일럿 — `AGENTS.md §5/§6` 만 role 지시문 layer 로 병합하되 **저작 위치는 devkit `templates/` 로 두고 설치본으로 전파**. repo git 화는 선행 조건이 아니다.
- **수정 전 재현**: architect role 워커를 dispatch 하고 `effective_prompt` 에 `INVARIANTS` 문자열 존재 여부 확인 → 현재 0건. **수용 기준**: 병합 후 동일 dispatch 에 문자열이 존재하고 `resolveInstructions` 가 새 `content_sha256` 기록.
- **소유**: `aigentry-devkit`(templates SSOT) + `aigentry-orchestrator`(instructions tree) / architect 설계 → coder 적용
- **의존/롤아웃/롤백**: #593(템플릿 파일이 미커밋) 선행. 롤백 = MD revert, 다음 dispatch 부터 즉시 반영(상태 없음).
- **task 매핑**: **#292 UPDATE**(Track E20 3-Layer — Layer1 SSOT template in devkit / Layer2 role artifact repo / Layer3 ephemeral session). 본 감사 기여 = **Layer2→Layer3 로딩이 #431 로 단절됨**을 실증하고, **Layer1(devkit templates)이 실제 소유자**임을 확인. 신규 티켓 불필요.

---

### ECO-1140-06 — spawn 게이트 커널이 배선되지 않은 채 유지되고 있다

- **심각도 MEDIUM / 신뢰도 MEDIUM** *(rev1 신뢰도 HIGH 에서 강등 — 아래 정정)*
- **증거** (`aigentry-orchestrator@ca93cb6` [HEAD])
  - `src/gate/` 7 파일 합계 **1,072 LOC** (index 40 / common / class-a{telepty,cli_direct,cmux} / class-b agent-tool-validator 124 / class-c mcp-deliberation-adapter 123)
  - `src/gate/index.ts` 를 가리키는 import: 선택 정규식(`gate/index`, `from "../../gate`) 기준 **0건**
  - `validate-spawn.ts` 참조는 `src/gate/` 내부 3건 + 주석 4건. `bin/`(open-session.sh, dispatch.sh, session-start.sh, boot-prepare.mjs)에서 호출 0건
- **현재 피해 vs 가설 위험**: 관측 = 위 정규식 범위에서 진입점이 발견되지 않았다. 가설 = 유지비 및 "게이트가 있으니 안전하다"는 오해.
- **정정(중요)**: rev1 은 (i) importer 0 을 **완전 호출경로 증명**처럼 서술했고 (ii) 그로부터 **class-B/C 삭제**를 권고했다. **둘 다 철회한다.** 선택 정규식 검색은 동적 import·빌드 산출물 경유·설정 주입·테스트 경유 호출을 배제하지 못한다. 삭제 권고의 근거로는 불충분하다. 또한 `sec-wire-enforce-spawn` 의 **warn-first 정책을 보존**해야 하며, 본 감사는 그 정책을 바꿀 근거를 생산하지 않았다.
- **근본원인**: 커널 선(先)구축 / 배선 후(後)결정이 미결로 남았다.
- **최소 수정**: **결정 이전에 조사가 선행**한다 — (a) `dist/` 및 동적 경로 포함 전수 호출경로 확인, (b) 게이트가 막아야 할 실패 케이스 **1건의 재현**과 커버리지 확보. 그 결과가 나오기 전까지 wire/delete 어느 쪽도 권고하지 않는다.
- **수정 전 재현**: 현재로서는 "진입점 미발견" 이 재현될 뿐이며 이는 부재 증명이 아니다. **수용 기준**: 전수 호출경로 조사 결과 + 재현 케이스 1건이 #655 에 첨부될 것.
- **소유**: `aigentry-orchestrator` / architect(결정) → coder
- **의존/롤아웃/롤백**: `sec-wire-enforce-spawn` 과 동일 결정 축. 현 warn-first 정책 유지.
- **task 매핑**: **#655 UPDATE**. 기여 = 2026-09-08 기준 `src/gate` **1,072 LOC** 현행 측정치(기존 기재 ~1,726 은 validate-spawn/permission-manager 포함 수치로 보이며 구성 분해가 필요), 그리고 **결정 전 조사 선행**이라는 조건 추가. 신규 티켓 불필요.

---

### ECO-1140-07 — `aigentry-context`: 소비자 증거가 매니페스트 수준에서 멈춰 있고 brain 과 관심영역이 겹친다

- **심각도 LOW / 신뢰도 LOW–MEDIUM** *(rev1 MEDIUM/HIGH + archive 권고에서 강등)*
- **증거**
  - `aigentry-context@eb23360` = 1,436 LOC, 0.0.1, deps `{}`. `src/{tokens,index,mcp-server}.js`, `src/projector/{index,relevance,snip-projection}.js`, `src/compressor/{index,dedup,snip-compact}.js`
  - 매니페스트/소스 grep 상 외부 소비자 미발견. rev1 이 소비자로 오인했던 `aigentry-devkit/lib/scaffold/install-hooks/claude.js:41`·`gemini.js:9` 의 `aigentry-context-ref-v1.{sh,js}` 는 **dispatch context-ref 훅 파일명**이며 이 패키지와 무관 — **문자열 일치 false-positive**(이 정정은 rev1 에서도 유효)
  - `aigentry-brain@0ffa6ee src/context/` = `ContextPacker.ts`, `EntryScoring.ts`, `ContextRestoreService.ts`, `ContextBudgetPolicy.ts`, `ConfidenceGuard.ts`
  - `git remote -v` 무출력
- **현재 피해 vs 가설 위험**: 관측된 피해 없음.
- **정정(중요)**: rev1 은 "소비자 0 → brain 이 흡수 완료 → archive" 로 결론했다. **철회한다.** (i) 소비자 판정이 **매니페스트 + 텍스트 검색에 그쳤고**, 직접 CLI 호출·MCP 등록·설정·문서·테스트 경유 소비를 전수 조사하지 않았다. (ii) brain 의 `src/context/` 와 context 의 `projector/compressor` 는 **관심영역이 겹칠 뿐 기능 동등이 증명되지 않았다** — `tokens.js`/`dedup.js`/`snip-compact.js` 에 고유 동작이 있는지 확인하지 않았다. (iii) **원격 부재는 백업 부재의 증거가 아니다.**
- **최소 수정**: archive/삭제를 **권고하지 않는다.** 필요한 것은 조사다 — 직접 소비자 전수 확인 + 고유 동작 대조. 그 전까지 현상 유지.
- **수정 전 재현**: 해당 없음(수정 제안 없음). **조사 수용 기준**: 직접 소비자 목록과 brain 대비 고유 동작 표가 #662 에 첨부될 것.
- **소유**: `aigentry-context` / architect(조사)
- **의존/롤아웃/롤백**: 해당 없음.
- **task 매핑**: **#662 UPDATE** + **#790**(원격 생성은 archive 와 무관하게 그 자체로 유효 — 단 아래 ECO-08 의 #790 범위 확대는 **미승인 제안**이다). **#662 의 stale 헤드라인 정정**: "sandbox(0파일) 삭제" 는 **오류** — `aigentry-sandbox` 는 **`-type f` 75 파일 / 15M**(npm-test pack·install, telepty 격리 데이터, osc133 evidence 로그)이며 격리 설치 테스트 환경이다. **보존이 정답이고 삭제 근거는 무효.**

---

### ECO-1140-08 — `aigentry-bridge`: 원격 미설정 + 세 이름이 "bridge" 를 주장

- **심각도 LOW–MEDIUM / 신뢰도 MEDIUM** *(rev1 archive 권고 철회)*
- **증거**
  - `aigentry-bridge` HEAD = `5eabef0 2026-04-01 init: scaffold aigentry-bridge project` (유일 커밋), dirty 11, `git remote -v` 무출력
  - `package.json` = `@dmsdc-ai/aigentry-bridge` 0.1.0, deps `{}`, 1,105 LOC(테스트 fixture 포함)
  - `aigentry-registry/bridge/package.json` = **`aigentry-bridge`(unscoped)** 0.1.1, deps `{ws:^8.17.0}`, 995 LOC, `src/executors/claude.ts` 등. registry 본체가 `src/aigentry/services/bridge/registry.py` + 테스트 2종에서 사용
  - devkit 어댑터는 제3의 이름 `@aigentry/bridge`(ECO-1140-02, #526 스코프 전략 종속)
- **현재 피해 vs 가설 위험**: 관측 = 세 이름의 공존과 원격 미설정. 가설 = 소유권 혼선. **원격 부재를 소실 위험으로 단정하지 않는다**(백업 상태 미조사).
- **정정**: rev1 의 archive 권고 및 "백업 0" 표현을 철회한다.
- **최소 수정**: (a) 원격 설정은 archive 와 분리해 그 자체로 진행 가능, (b) 어느 구현이 정식인지 기록. **archive 는 소비자 조사 전 권고하지 않는다.**
- **수정 전 재현**: `git -C aigentry-bridge remote -v` 무출력 + `git log --oneline` 1줄. **수용 기준**: 원격 설정 후 origin/main 이 로컬 HEAD 와 일치.
- **소유**: `aigentry-bridge` / architect(분류) → builder(원격)
- **의존/롤아웃/롤백**: #526 스코프 전략과 조율. 롤백 = 원격 제거.
- **task 매핑**: **#279 UPDATE**(Track E14 Phase A 설문이 bridge 포함 10개 분류를 이미 소유). #790 에 대해서는 **"범위를 원격 미설정 repo 전부(context + bridge)로 확대" 를 제안한다 — 이는 architect 의 미승인 제안이며 확정된 범위가 아니다.** 확대 여부는 orchestrator 판단이고, 승인 전까지 #790 의 범위는 기존대로 context 단독이다. 신규 티켓 불필요.

---

## 3. 교차 패턴

1. **좌표가 손으로 여러 파일에 복제되고 권위가 표시되지 않는다** — telepty 좌표 3곳(01), bridge 3곳(02·08), 메타 range(03), ecosystem.json(04). **rev1 감사자가 실제로 오판한 지점**이라는 것이 이 패턴의 가장 강한 증거다.
2. **sync 와 gate 의 혼동** — #793 은 sync 를 하고 done 되었으나 두 릴리스 만에 벌어졌고, `ux-public-front-door` 는 메타 핀을 repin 하고 done 되었으나 다시 벌어졌다. **같은 결함이 두 티켓에서 각각 1회성으로 처리됐다.**
3. **미커밋 WIP 가 감사와 실동작을 갈라놓는다** — devkit dirty 51(#593)에 설치 계약(`install-fallback.js` untracked, 어댑터 4종, `install.sh`)과 역할 템플릿(`templates/aigentry-architect/CLAUDE.md`)이 동시에 걸려 있다. rev1 의 오판은 **이 상태의 직접적 결과**다.
4. **부재 증명의 남용** — rev1 은 루트 전용 탐색으로 aterm 매니페스트 부재를, 선택 정규식으로 게이트 호출 부재를, 매니페스트 grep 으로 context 소비자 부재를 각각 단정했다. **세 건 모두 탐색 범위의 한계였다**(1건은 오류로 확인, 2건은 미확정). 이후 감사에서 "미발견" 과 "부재" 를 분리 표기할 것.

---

## 4. 부록

### 부록 A — 저장소 인벤토리 (23개 전수, `fs.readdirSync` 열거)

깊이: **D**=deep(소스 라인 확인) / **M**=manifest+구조 / **S**=표면(존재·크기·git)

**파일 수 집계 술어 (rev3 명시)**: 아래 "파일" 수치는 **`find <dir> -type f`** — 일반 파일만, 도트파일 포함, **심볼릭 링크 제외**(`-type l` 별도 표기), **`.DS_Store` 포함**. rev1/rev2 는 `.DS_Store` 를 제외하고도 표기하지 않아 #1141 analyst 수치와 어긋났다. 아래는 술어를 통일한 재실측이며, 참고로 `.DS_Store` 제외값을 괄호로 병기한다. git 미초기화 5개 디렉터리 실측(2026-09-08T13:52Z):

| dir | `-type f` | `.DS_Store` 제외 | `.DS_Store` | `-type l` | dirs | du -sh |
|---|---:|---:|---:|---:|---:|---:|
| aigentry-sandbox | **75** | 71 | 4 | 2 | 33 | 15M |
| aigentry-tester | **59** | 59 | 0 | 0 | 7 | 25M |
| aigentry-architect | **26** | 26 | 0 | 3 | 6 | 364K |
| aigentry-design | **14** | 13 | 1 | 0 | 9 | 224K |
| aigentry-builder | **4** | 4 | 0 | 0 | 2 | 28K |

**#1141 analyst 와의 대조**: analyst 의 sandbox **75** / design **14** 는 `-type f` 기준으로 **정확하다**. 본 리포트의 71 / 13 은 `.DS_Store` 를 뺀 값이었고 그 사실을 적지 않은 것이 불일치의 전부다 — 측정 대상이 아니라 **술어 차이**이며, 분석 결론에는 영향이 없다. 이하 표는 `-type f` 값을 채택한다.

| # | repo | HEAD | branch | dirty | remote | manifest / 언어 | 역할 | 깊이 | disposition |
|---|---|---|---|---|---|---|---|:-:|---|
| 1 | aigentry | f959b29 (07-26) | main | 4 | ✅ | `@dmsdc-ai/aigentry` 0.1.1 / JS | 메타 설치 패키지 | D | ECO-03 |
| 2 | aigentry-amplify | b555848 (07-26) | main | 7 | ✅ | 0.0.1 `private:true` / TS 워크스페이스 | 콘텐츠 | M | ECO-02(설치 좌표) |
| 3 | aigentry-analyst | 8a45a84 (**04-09**) | main | 3 | ✅ | `aigentry-analyst` 1.0.0 / JS+MCP | analyst role MCP | M | 외부 소비자 미발견(전수 아님), 5개월 무변경 — #279 |
| 4 | aigentry-architect | **NO GIT** | — | — | ❌ | 없음 (26 파일, `-type f`; +심볼릭 3) | architect role artifact | D | **ECO-05** |
| 5 | aigentry-aterm | 9b4cec5 (08-15) | main | 8 | ✅ (aterm.git) | **`npm/aterm/package.json` `@dmsdc-ai/aterm` 0.2.13 MIT** + Cargo workspace 3 crates(0.1.0) + Swift | 터미널 런처 | M | rev1 "npm 매니페스트 없음" **정정**. #782 브랜치 표류 |
| 6 | aigentry-brain | 0ffa6ee (08-16) | main | 6 | ✅ | 0.3.1 / TS+MCP | 영속 메모리 | D | 활성. `src/context/` 관심영역 중복(ECO-07, 동등성 미증명) |
| 7 | aigentry-bridge | 5eabef0 (**04-01, init 유일**) | main | 11 | ❌ | `@dmsdc-ai/aigentry-bridge` 0.1.0 / JS | CLI 원격제어 SDK | D | **ECO-08** |
| 8 | aigentry-builder | **NO GIT** | — | — | ❌ | 없음 (4 파일, `-type f`) | builder role artifact | S | **ECO-05** |
| 9 | aigentry-context | eb23360 (07-26) | main | 3 | ❌ | 0.0.1 / JS+MCP, 1,436 LOC | 컨텍스트 압축/투영 | D | **ECO-07** (조사 필요, archive 권고 없음) |
| 10 | aigentry-deliberation | b009549 (07-26) | main | 3 | ✅ | 0.0.47 / JS+MCP | 다중 AI 토론 | M | 활성. `demo/forum/` 자체 벤더 |
| 11 | aigentry-design | **NO GIT** | — | — | ❌ | 없음 (**14** 파일, `-type f`; .DS_Store 제외 13) | design role artifact | S | **ECO-05** |
| 12 | aigentry-devkit | bb7876b (07-26) | main | **51** | ✅ | 0.1.14 / JS | 설치/스캐폴드 + **templates SSOT** | D | **ECO-01/02/04/05** + #593 |
| 13 | aigentry-dustcraw | c0af3c9 (07-26) | main | 14 | ✅ | 0.4.0 / TS | 외부 리서치 | M | ECO-02(어댑터 latest 로 이미 정정됨) |
| 14 | aigentry-forum | f1fc896 (**03-01**) | main | 1 | ✅ | 없음 (index.html + assets) | 토론 시각화 | M | 외부 소비자 미발견. deliberation 이 `demo/forum/` 벤더링(README:55,58) — #279 분류 대상 |
| 15 | aigentry-hooks | 507393e (07-26) | main | 7 | ✅ | 0.0.2 / JS | 훅 런너 | M | 외부 소비자 = devkit 테스트 1건(전수 아님) — #279 |
| 16 | aigentry-logger | f4f62e3 (06-06) | main | 1 | ✅ | 0.2.0 / JS | 텔레메트리 | M | **실사용**: orchestrator `src/telemetry/logger-emit.ts:18-19`, brain, deliberation, devkit. #527/#671 |
| 17 | aigentry-orchestrator | ca93cb6 (**09-08**) | main | 10 | ✅ | 0.2.0 / TS+shell | 컨트롤 타워 | D | **ECO-05/06**. 최활성 |
| 18 | aigentry-registry | ac221cd (07-26) | main | 3 | ✅ | pyproject `aigentry` 0.2.0 / **Python** + 내부 TS bridge | 레지스트리 | M | 유일 Python 축. 내부 `bridge/` 가 ECO-08 의 실사용 구현 |
| 19 | aigentry-sandbox | **NO GIT** | — | — | ❌ | 없음 (**75 파일, 15M**, `-type f`; .DS_Store 제외 71, +심볼릭 2) | 격리 테스트 환경 | D | **보존.** #662 "0파일" 정정 |
| 20 | aigentry-ssot | 42afae4 (07-26) | main | 3 | ✅ | `pkg/package.json` `@dmsdc-ai/aigentry-ssot` 1.0.0 / TS | 계약 스키마 | M | **실사용**: orchestrator `src/session/inject-parser.ts:27`, logger. #783/#785 |
| 21 | aigentry-starter | c310f28 (**04-01**) | main | 4 | ✅ | 없음 (템플릿 트리) | 프로젝트 시드 | S | 5개월 무변경 — #279 |
| 22 | aigentry-telepty | 997ea7c (**09-08**) | main | 13 | ✅ | 0.8.3 / JS | PTY 전송 | D | 활성 |
| 23 | **aigentry-tester** | **NO GIT** | — | — | ❌ | 없음 (**59 파일, 25M**, `-type f`) | tester role artifact | S | **rev1 누락분.** ECO-05 |

**요약**: git 없음 **5**(architect, builder, design, sandbox, tester) / 원격 미설정 2(bridge, context) / 5개월+ 무변경 4(analyst, bridge, forum, starter; git 없는 4곳은 판정 불가) / 당일 변경 2(orchestrator, telepty).

### 부록 B — 중첩 패키지 disposition

| 경로 | 매니페스트 | disposition |
|---|---|---|
| **`aigentry-aterm/npm/aterm/`** | **`@dmsdc-ai/aterm` 0.2.13, MIT**, deps devkit≥0.0.19 + telepty≥0.1.88, optional peer `@dmsdc-ai/aigentry`≥0.1.0 | **rev1 누락.** 실제 npm 배포 단위. 부록 C 의 optional peer 엣지 출처 |
| `aigentry-aterm/npm/aterm-darwin-arm64/` | 플랫폼 optional dep 패키지 | 위의 optionalDependencies 대상 |
| `aigentry-ssot/pkg/` | `@dmsdc-ai/aigentry-ssot` 1.0.0, deps `{}` | 실제 배포 단위(루트 아님) — #785 |
| `aigentry-amplify/packages/{core,channels}` | `@aigentry-amplify/*` 0.0.1 | workspace 내부. 루트 `private:true` |
| `aigentry-registry/bridge/` | `aigentry-bridge`(unscoped) 0.1.1, dep `ws` | ECO-08 의 실사용 구현 |
| `aigentry-aterm/{aterm-core,aterm-session,aterm-ipc}` | Cargo 0.1.0 ×3 | Rust workspace 멤버(npm 버전 체계와 별개) |
| `aigentry-brain/aigentry-brain/` | 없음 (`find -type f` 무결과) | 빈 중첩 디렉터리. 정보로만 기록, finding 승격 안 함 |

### 부록 C — 의존성 엣지 (측정된 것만)

**R**=런타임 JS import 확인 / **C**=CLI/PATH 경계(import 아님) / **M**=매니페스트 선언만, 호출부 미확인

| from | to | 종류 | 증거 |
|---|---|:-:|---|
| orchestrator | logger | R | `src/telemetry/logger-emit.ts:18-19` |
| orchestrator | ssot | R | `src/session/inject-parser.ts:27` |
| orchestrator | telepty | C | `bin/*.sh` ×20 `command -v telepty`. package.json 은 `^0.8.0` 선언하나 JS import 0건 |
| brain / deliberation / devkit | logger | R | 각 repo `logger-emit.{ts,js}` |
| logger | ssot | M | package.json dep — #671 이 devDep 강등 제안 |
| registry(py) | registry/bridge(ts) | R | `src/aigentry/services/bridge/registry.py` + 테스트 2종 |
| dustcraw | registry | M | `src/registry/RegistryClient.ts` — HTTP 클라이언트, 런타임 호출 **미측정** |
| meta aigentry | aterm, telepty, devkit, brain, deliberation | M | ECO-03 |
| **aterm(npm)** | **devkit ≥0.0.19, telepty ≥0.1.88** | **M** | **rev1 누락.** `npm/aterm/package.json` |
| **aterm(npm)** | **meta aigentry ≥0.1.0 (optional peer)** | **M** | 동상 |
| devkit(설치기) | telepty/brain/dustcraw/amplify/bridge | M | 어댑터 `install.fallback` — ECO-01/02 |

**사이클**: 측정된 엣지 집합 안에서 **매니페스트 수준 사이클 1건** — `meta aigentry → @dmsdc-ai/aterm`(dependencies) 와 `@dmsdc-ai/aterm → @dmsdc-ai/aigentry`(**optional** peerDependencies)가 순환을 이룬다. 이는 **#64("aterm → @dmsdc-ai/aigentry dependency 로 전환", done)의 의도된 결과**로 보이며, optional peer 이므로 npm 설치 그래프에서 강제 순환으로 취급되지 않는다. **런타임 호출 사이클은 주장하지 않는다** — R 등급 엣지 집합 안에는 순환이 없고, aterm 의 런타임 호출은 측정하지 않았다.

---

## 5. task 매핑 (등록은 orchestrator 권한)

### 5.1 기존 ID 로 귀속 (신규 티켓 불필요)

| finding | 기존 ID | 처리 | 근거 |
|---|---|---|---|
| ECO-01 telepty 좌표 3중화 | **#593** | UPDATE | 미커밋 WIP 거버넌스 리스크의 구체적 실현 사례 |
| ECO-02 bridge/amplify 좌표 | **#526** | UPDATE (dimension 9) | `@aigentry` 스코프 전략이 이미 이 좌표를 소유 |
| ECO-03 메타 range | **`ux-public-front-door`(done)**, **#62**, **#64** | 참조 + evidence delta 기록 | 동일 결함의 재발. done 티켓은 **재개하지 않음** |
| ECO-04 ecosystem.json | **#1136**, **#793(done)** | #1136 에 cross-repo 경계 명시 | #1136 이 in-repo README/manifest 정합을 소유 |
| ECO-05 role SSOT | **#292** | UPDATE | Layer1=devkit templates 소유 확인 + Layer2→3 단절 실증 |
| ECO-06 spawn 게이트 | **#655**, `sec-wire-enforce-spawn` | UPDATE | 현행 LOC + "결정 전 조사 선행" 조건. **warn-first 정책 보존** |
| ECO-07 context | **#662**, **#790** | UPDATE | archive 권고 철회, 조사 조건 추가, **sandbox "0파일" 정정** |
| ECO-08 bridge repo | **#279** | UPDATE | #790 범위 확대("원격 미설정 repo 전부")는 **미승인 제안** — 승인 전까지 #790 은 context 단독 |

### 5.2 신규 후보 (2건, 상한 3 이내) — 전부 **미승인 제안**

> 아래 C-1/C-2 는 architect 의 제안이며 승인된 범위가 아니다. 등록·승인은 orchestrator 권한이다.

- **C-1 — 설치 좌표 권위 단일화 (devkit)**
  범위: `installer-manifest.json` 의 컴포넌트 버전 필드, 어댑터 `attach.install_command`, 어댑터 `install.fallback` 셋 중 **권위 필드를 스키마에서 확정**하고 나머지를 비활성/제거. 소유 repo: `aigentry-devkit`.
  dedup 근거: #593 은 "WIP 을 커밋하라" 이지 "어느 필드가 권위인가" 를 정하지 않는다. #526 은 스코프 이름 전략이지 필드 권위가 아니다. #1136 은 orchestrator 패키지 범위다. **세 티켓 어디에도 이 결정이 없다.**
  선행: #593.

- **C-2 — 버전 좌표 드리프트 게이트 (cross-repo)** — **미승인 제안**
  범위: `ecosystem.json` 모듈 행 ↔ 각 repo 매니페스트, 메타 패키지 range ↔ 하위 패키지 버전을 **비네트워크로 대조하는 `--check`** 를 CI 에 배선. ECO-03 과 ECO-04 를 하나로 묶는다(둘 다 "1회 sync 후 재드리프트" 라는 동일 결함 계열).
  **경계(중요)**: 이 게이트는 **로컬 소스 간 표시값 정합성**만 검사한다. **로컬 버전 동일성은 호환성 기준이 아니며**, 이 `--check` 의 통과가 설치 가능·호환을 뜻하지 않는다(레지스트리 미측정). 호환성 판정 기준으로 승격하는 것은 본 리포트의 권고가 아니다.
  dedup 근거: #793 과 `ux-public-front-door` 는 **둘 다 1회성 수정으로 done 처리**되었고 둘 다 재발했다 — 재발이 곧 "게이트가 없다" 는 증거이며, 게이트는 두 티켓 어느 쪽의 범위도 아니었다. **재발 티켓 신설의 명시적 근거는 이것이다.** #1136 과의 경계: #1136 은 orchestrator 패키지 **내부** README/매니페스트 정합을 소유하며, C-2 는 **cross-repo 축만** 추가하고 동일 스크립트를 공유하도록 설계한다.
  선행: 메타 range 실값 확정에는 레지스트리 조회 필요(본 세션 범위 밖).

### 5.3 #526 EPIC 에 대하여

본 감사는 #526 이 기다리던 current-source refresh 를 수행했다. 결과는 "대대적 overhaul" 이 아니라 **#593 커밋 + 좌표 권위 확정(C-1) + 드리프트 게이트(C-2)** 이며, 나머지 6개 finding 은 전부 기존 티켓으로 귀속된다. #526 은 이 3건을 하위로 묶어 **범위를 축소 재정의**할 것을 권고한다(§1 경량).
단, #526 의 dimension (9) @aigentry 스코프 전략은 **ECO-02 의 선결 조건**이므로 그 안에 남겨야 한다.

**발명된 ID 없음.** 인용된 기존 ID 는 전부 `state/task-queue.json`(tasks 1138 / open 357) 을 구조화 파서로 읽어 확인했다.

---

## 6. 남은 한계 (unresolved limits)

1. **레지스트리 전면 미측정** — ECO-01/02/03 의 결론이 "위험" 에서 "피해" 로 승격되려면 게시 버전·스코프 점유 확인이 필요하다. 본 세션 권한 밖.
2. **설치 미실행** — `--dry-run` 은 체인을 보여줄 뿐 설치 결과를 보여주지 않는다. 재현 테스트는 설치기를 스텁해야 한다.
3. **완전 호출경로 미확보** — ECO-06(게이트), ECO-07(context), ECO-08(bridge) 의 소비자 판정은 미완이며, 이 상태로는 **어떤 삭제·archive 결정도 지지하지 않는다.**
4. **devkit WIP 51건의 나머지** — 본 감사는 설치 관련 6개 파일과 템플릿 1개만 diff 했다. 나머지 44건이 다른 finding 에 영향을 줄 가능성은 배제하지 못한다.
5. **brain ↔ context 기능 동등성 미증명**, **원격 부재 ↔ 백업 부재 미조사**, **aterm 런타임 호출 미측정**.
