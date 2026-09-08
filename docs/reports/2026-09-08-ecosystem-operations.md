# 에코시스템 운영 현황 감사 (install/release/observability/config-auth/lifecycle)

- 태스크: #1141 (umbrella #526의 현재 소스 리프레시). #1140 architecture assessor와 병렬.
- 역할: analyst (read-only). 코드 수정·빌드·테스트·설치·네트워크/레지스트리 조회 없음.
- 측정 시각: **2026-09-08T13:36:15Z ~ 13:56Z (UTC)**
- 작업 워크트리: `/Users/duckyoungkim/.aigentry/worktrees/ec1141`, 브랜치 `docs/1141-ecosystem-operations`, HEAD `76a3713`
- 비교 기준 main: `aigentry-orchestrator` HEAD `ca93cb6` (dirty=10), 로컬 dirty 상태는 부록 A에 기록
- 산출물: 본 파일 1개만 커밋

---

## 0. 측정 범위와 측정하지 않은 것 (먼저 읽을 것)

**센 것(counted universe).** `/Users/duckyoungkim/projects/` 하위 디렉터리 **54개**를 직접 열거했다.
그중 aigentry 계열은 **23개**(`aigentry` + `aigentry-*` 22개). 나머지 31개는 터미널 업스트림
(ghostty/kitty/wezterm/zellij/alacritty/rio/contour/winit), claude-code 참조 포크, 제품 프로젝트
(animal-hospital, nexaforge, shipfast 등)로 이번 감사 범위 밖 — 부록 A에 사유와 함께 명시.
`ecosystem.json`은 **표시용 매니페스트**이며 6개 모듈만 담고 있어 열거의 근거로 쓰지 않았다.
중첩 패키지 디렉터리 3개(`aigentry-ssot/pkg`, `aigentry-registry/frontend`, `aigentry-registry/bridge`)를
별도로 찾아 처분을 부여했다. `.aigentry/repo`는 메모리 프로파일 데이터일 뿐 저장소가 아니다.
워크트리 77개는 오케스트레이터 작업 공간이므로 저장소로 세지 않았다.

**측정하지 않은 것 — 아래 결론에 절대 포함되지 않음.**
- **npm 레지스트리 실조회 없음.** "현재 npm에 있는 버전"은 한 줄도 주장하지 않는다. 버전 비교는
  전부 *로컬 package.json ↔ 로컬 package.json / 로컬 manifest* 사이의 비교다. 레지스트리 존재
  증거로 인용한 것은 로컬 `package-lock.json`의 `resolved`+`integrity` 기록뿐이며, 이는 락파일이
  쓰인 시점의 사실이지 현재 레지스트리 상태가 아니다.
- **설치/업그레이드/언인스톨을 실제로 실행하지 않았다.** 설치 스크립트는 소스로만 읽었다.
  "fresh HOME에서 이렇게 된다"는 서술은 전부 코드 경로 추론이며, 각 항목의 재현 게이트에
  실행 방법을 적어 두었다.
- **실행 중 데몬/서비스에 접속하지 않았다.** telepty 데몬, brain, deliberation 런타임의 실제
  동작·로그·성능은 측정 대상이 아니었다.
- **보안 스캔·인증 프로브·익스플로잇 없음.** Snyk 미실행(docs-only). 인증/CORS/spawn 경로는
  소스 읽기만 했고 자격증명 값은 열지 않았다(변수명만 확인).
- **원격(GitHub Actions 실행 이력, 태그, 릴리스) 미조회.** 워크플로 YAML 파일 내용만 읽었다.
- 상속받은 수치(과거 감사의 저장소 수, 휴면율, 보안 결론)는 **하나도 헤드라인으로 승격하지 않았다.**
  본 보고서의 모든 수치는 위 시각에 재측정한 값이다.

---

## 1. 총평 (executive verdict)

### 1.1 지켜야 할 강점

**(a) telepty의 보안·수명주기 규율은 이 생태계에서 가장 성숙하다.** `daemon.js`의 인증 계층은
사고 이력을 코드 주석에 근거로 박아 두고 고쳤다 — #815(토큰 발급이 이름 기준·멱등이라 재등록만
하면 남의 토큰을 받던 결함, 지금은 최초 등록 1회 발급 + 모든 destroy 경로에서 폐기),
#47 P4(provenance nonce가 동일 결함을 공유했고 같은 수명주기로 통합), #45(fan-out blast-radius
상한), #43(inject 감사 스파인, 실패해도 전달을 막지 않음). 브라우저 origin 허용목록은 **기본 비어
있음 = 전면 거부**이고(`daemon.js:255-258`), `createAuthMiddleware`가 `app.use`로 전역
등록(`daemon.js:391`)되어 그 앞에 놓인 라우트는 `/api/health` 하나뿐이며 그마저
`{status, version}`만 반환한다(`daemon.js:386-388`). `app.use(cors())`(`daemon.js:248`)가
느슨해 보이지만 origin 거부는 인증 미들웨어가 담당하는 계층 분리 설계로, **이번 읽기에서 결함으로
볼 근거를 찾지 못했다.**

**(b) telepty 테스트 목록에 드리프트가 없다.** `package.json`의 `test` 스크립트가 테스트 파일을
수작업 열거하는 구조라 누락을 의심했으나, 실측 결과 **열거 124개 / 디스크 124개, 누락 0, 유령 0**.
"테스트 러너 실제 포함" 항목에서 telepty는 결함이 아니다.

**(c) orchestrator와 telepty의 릴리스 게이트는 모범 사례다.**
`aigentry-orchestrator/.github/workflows/release.yml:3-15`는 왜 이렇게 생겼는지를 사고 이력으로
적어 두었다 — "런북이 태그가 퍼블리시했다고 주장했지만 실제로는 3개 버전이 태그 없이 손으로
올라갔다". 그 결과 태그↔package.json 버전 일치 게이트(`:48-59`), 시크릿 부재 = 실패(no-op 아님),
레지스트리에서 되읽어 증명하는 단계, 동시 실행 큐잉(`:26-28`)이 들어 있다.

**(d) 설치기의 실패 정책이 데이터로 선언되어 있다.** `config/installer-manifest.json`의
component별 `failure_policy: hard|soft`와 `config/modules/*.adapter.json`의 fallback 체인
(npm-global → stub → skip)은 하드코딩이 아니라 데이터다. 에러 분류(network/auth/permission/
disk/timeout)별 재시도·halt 정책도 `lib/install-fallback.js:50-61`에 표로 있다.

**(e) 시크릿 취급 습관 자체는 존재한다.** `install.sh`의 env fan-out은 `printf %q`로 인용하고
`chmod 600`을 건다(`install.sh:263-270`). 문제는 이 습관이 **한 파일에만** 적용됐다는 것(F2).

### 1.2 가장 영향이 큰 계통적 약점

한 문장으로: **품질 기준이 저장소마다 각자 발명되고, 폭발 반경이 가장 큰 저장소(devkit = 설치기)에
가장 낮은 기준이 걸려 있다.** orchestrator/telepty가 릴리스 게이트를 만들어 놓았지만 devkit·brain·
deliberation으로 전파되지 않았고(F4/F7), 설치기 자체는 CI에서 `--help`만 돌린다. 그리고 설치
경로가 **세 갈래로 갈라져** 서로 다른 버전·다른 컴포넌트를 설치한다 — 메타 패키지(F1), 모듈별
직접 설치(README), devkit 프로파일(F3/F5). 어느 것이 정본인지 코드가 말해주지 않는다.

두 번째 축은 **매니페스트 다중화**다. `ecosystem.json`(표시용, 6개 저장소에 바이트 동일 복제),
`installer-manifest.json`(프로파일/호환성), `config/modules/*.adapter.json`(실제 설치)이
공존하는데 셋이 서로 어긋나 있고(F5/F6), 어긋난 값이 **사용자 화면에 출력된다**.

### 1.3 최소 개선안 — 지금 / 다음 / 보류

**지금(now, 각 1~10줄 수준의 외과적 변경).**
1. `install-state.json`에서 `api_key` 필드 제거 (F2). 값이 필요한 곳은 이미 `env.sh`(0600)다.
2. `@dmsdc-ai/aigentry` 5개 의존성 range를 현재 로컬 버전에 맞게 올림 (F1).
3. Windows 설치기에서 `orchestrator-role`이 선택됐는데 미지원이면 **경고 후 status를
   `unsupported`로 기록** (F3). 구현 이식이 아니라 침묵 제거가 목표.
4. `install.sh`의 `info "Installing $TELEPTY_SPEC …"` 를 adapter 체인이 실제로 쓸 spec으로
   교체하거나 삭제 (F5).

**다음(next, 1개 PR 규모).**
5. devkit `npm test`가 이미 존재하는 4개 스위트를 실제로 돌리게 하고 ci.yml/release.yml에 연결 (F4).
6. `ecosystem.json` 재생성 스크립트가 표만이 아니라 **메타 패키지 dependencies도 검증**하도록
   확장하거나, 최소한 불일치 시 실패하는 체크 추가 (F6, F1의 재발 방지).
7. `install.sh`에 phase 경계 롤백/`trap` 도입 — 최소한 실패 시 "무엇이 남았는지"를
   state에 기록하고 사용자에게 되돌리는 명령을 출력 (F8).

**보류(defer, 지금 하면 손해).**
- `installer-manifest.json` ↔ `adapter.json` **통합**. 둘 다 소비자가 있고(프로파일 해석 vs
  fallback 체인) 통합은 설치기 전체 재작성이다. F5는 "출력이 거짓말한다"만 고치면 충분하다.
- ssot/registry의 **중첩 패키지 구조 평탄화**. 릴리스 자동화(F7)가 먼저다. 구조 이동은
  의존성/마이그레이션 증거 없이 quick win으로 다룰 일이 아니다.
- 저장소 통폐합·프레임워크 교체 류. 이번 감사에서 그런 판단을 뒷받침할 증거를 수집하지 않았다.

### 1.4 도입하지 말아야 할 아이디어와 이유

- **"모든 저장소에 CI 템플릿 일괄 살포".** logger/ssot/hooks/context/bridge/dustcraw/amplify는
  성숙도와 공개 여부가 제각각이다. F7이 요구하는 건 *퍼블리시되는 것*에 대한 증명이지 전 저장소
  CI가 아니다. 7개 저장소에 도는 워크플로를 만들면 유지 비용만 늘고 아무도 안 본다.
- **telepty 테스트 목록을 glob으로 바꾸기.** 드리프트 0이 실측됐다. 지금 바꾸면 실행 순서와
  격리 전제가 깨질 위험만 새로 생긴다.
- **메타 패키지에 버전 자동 범프 봇.** F1의 원인은 자동화 부재가 아니라 "표만 갱신하고 의존성은
  안 봤다"는 것이다. 재생성 스크립트에 검증 한 줄 추가가 봇보다 싸다.
- **설치기 전면 재작성(예: Node 단일 구현으로 통일).** bash 1013줄 / ps1 506줄의 차이는 F3
  하나로 요약되고, 그건 20줄이면 막는다. 재작성은 §1(경량)과 Rule 29에 정면으로 어긋난다.

---

## 2. 발견 사항 (8건)

각 행: 심각도와 확신도는 **분리해서** 적었다. "현재 영향"은 지금 일어나는 일, "가정된 위험"은
조건이 붙어야 일어나는 일이다.

---

### F1 — 메타 패키지 `@dmsdc-ai/aigentry`의 의존성 range가 생태계를 구세대에 고정

- **심각도 High / 확신도 High(로컬 매니페스트 대조로 확정)**
- **증거**: `/Users/duckyoungkim/projects/aigentry/package.json` (repo HEAD `f959b29`, dirty=4)

  | 메타가 요구 | semver 해석 | 같은 디스크의 로컬 소스 버전 |
  |---|---|---|
  | `@dmsdc-ai/aigentry-devkit: ^0.0.22` | `>=0.0.22 <0.0.23` (사실상 정확히 0.0.22) | **0.1.14** |
  | `@dmsdc-ai/aigentry-brain: ^0.2.8` | `>=0.2.8 <0.3.0` | **0.3.1** |
  | `@dmsdc-ai/aigentry-telepty: ^0.6.6` | `>=0.6.6 <0.7.0` | **0.8.3** |
  | `@dmsdc-ai/aigentry-deliberation: ^0.0.47` | 정확히 0.0.47 | 0.0.47 (일치) |
  | `@dmsdc-ai/aterm: ^0.2.14` | `>=0.2.14 <0.3.0` | 로컬 package.json 없음(Cargo) |

  `README.md:20`이 `npm i -g @dmsdc-ai/aigentry`를 **1순위 설치 명령**으로 제시한다. 반면
  `README.md:86/105/118/129`의 모듈별 설치는 range 없이 최신을 받는다.
  `bin/aigentry.js:56`은 모듈이 빠졌을 때 `npm i -g @dmsdc-ai/aigentry` 재실행을 안내하는데,
  range가 막고 있으므로 재실행해도 상위 버전으로 올라가지 못한다.
- **현재 영향**: 메타 경로 설치자와 모듈별 경로 설치자가 **서로 다른 telepty 메이저 세대**를 쓴다.
  telepty 0.6.x는 0.8.x가 닫은 인증/제출/수명주기 수정(#815/#820/#826/#844/#860/#916 계열 —
  테스트 파일명으로 확인) 이전이다. devkit은 0.0.22 ↔ 0.1.14로 fallback 체인·프로파일·
  orchestrator-role 자체가 존재하지 않던 시대에 고정된다.
- **가정된 위험**: 레지스트리 실제 상태는 측정하지 않았으므로, 게시된 버전이 로컬과 다르면
  체감 격차는 달라질 수 있다. 단 range 상한이 로컬 소스보다 낮다는 사실은 그와 무관하게 성립한다.
- **근본 원인**: `ecosystem.json` 표 재생성(`scripts/gen-readme.mjs`, git log `f959b29`/`c15c8df`/
  `afa9449`/`fb15731`/`7b97bd1` — 5회 연속 "표 갱신" 커밋)은 있는데, 같은 저장소의
  `dependencies`를 함께 보는 단계가 어디에도 없다.
- **최소 수정**: `package.json`의 4개 range를 현재 값으로 상향(1커밋). 재발 방지는 F6과 묶어
  `gen-readme.mjs`에 "표의 버전과 dependencies range가 모순이면 exit 1" 한 블록 추가.
- **수정 전 재현/수용 게이트**: 격리된 HOME에서 `npm ls -g --depth=0` 또는
  `npm i -g @dmsdc-ai/aigentry --dry-run` 결과의 devkit/brain/telepty 버전이 각 모듈 저장소의
  로컬 `package.json` 버전보다 낮음을 보인다. 수정 후 같은 명령에서 셋이 로컬 버전 이상.
- **소유**: `aigentry` (메타 패키지 저장소) / release 역할
- **의존·롤아웃·롤백**: 독립. 메타 패키지 patch 릴리스 1회. 롤백 = 이전 range 복원(무해).
- **태스크 매핑**: **NEW 후보**. #884(npm 토큰 회전)는 자격증명 문제로 무관, #534/#895는
  런타임 수명주기라 무관. 기존 큐 1138행에서 메타 패키지 의존성 range를 다루는 행을 찾지 못했다.

---

### F2 — 레지스트리 API 키가 `install-state.json`에 평문·기본 퍼미션으로 기록 (양 OS 공통)

- **심각도 High / 확신도 High(양쪽 구현 모두 직접 확인)**
- **증거**: `aigentry-devkit` HEAD `bb7876b` (dirty=51)
  - bash: `install.sh:184-215` `write_installer_state()` — `REGISTRY_API_KEY`를 env로 넘겨
    `state.registry.api_key`로 JSON에 기록. 기록 후 `chmod` **없음**.
  - ps1: `install.ps1:161` `api_key = $RegistryApiKey`, `install.ps1:172`
    `Set-Content -Path $DevkitStateFile`. ACL 설정 **없음**.
  - 대조군: env fan-out은 제대로 되어 있다 — `install.sh:263-270`에서 `printf %q` 인용 후
    `chmod 600 "$DEVKIT_ENV_FILE"`.
  - `install.sh` 전체 `chmod` 호출은 3곳뿐: `:269`(env 파일 0600), `:447`(HUD +x),
    `:488`(WTM +x). state 파일은 그 어디에도 없다.
  - `install.ps1` 전체에서 `Acl|icacls|Protect|SetAccessControl` **0건**.
  - 파일 위치: `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/install-state.json`
    (`install.sh:24-25`), 설치 완료 배너가 경로를 그대로 출력(`install.sh:1005`).
- **현재 영향**: `registry-wiring`을 선택하고 API 키를 입력한 설치에서, 키가 **두 곳**에 남는데
  한 곳만 보호된다. 일반 umask 022에서 state 파일은 0644로 생성된다. 다중 사용자 머신·백업·
  dotfiles 동기화·로그 수집기가 그대로 가져간다.
- **가정된 위험**: 단독 사용자 개인 머신이면 실질 노출은 제한적이다. 심각도를 High로 둔 이유는
  "같은 값을 같은 설치기가 한 파일에선 보호하고 다른 파일에선 안 한다"는 **일관성 결손**이 원인
  진단을 어렵게 만들기 때문이다.
- **부수 관찰(같은 뿌리, 별건 아님)**: PowerShell 쪽 env fan-out은 `'$RegistryApiKey'` 단일 인용
  보간이라(`install.ps1:180`) 값에 `'`가 들어가면 파일이 깨진다. bash는 `printf %q`로 안전.
  또한 bash는 `{ … } > "$FILE"` 후 `chmod` 순서라 파일 생성~chmod 사이 짧은 창이 존재
  (`umask 077` 선행이면 사라진다).
- **근본 원인**: state 파일이 "관측용 메타데이터"로 설계됐는데 값 전달용 필드(api_key)가 섞여
  들어갔고, 보호는 값 전달용으로 설계된 env 파일에만 붙었다.
- **최소 수정**: `install.sh:210` 블록과 `install.ps1:161`에서 `api_key` 필드를 제거하고,
  state에는 `api_key_present: true/false`만 남긴다. (필요하다면 추가로 state 파일에도 0600.)
- **수정 전 재현/수용 게이트**: 임시 HOME + `AIGENTRY_API_KEY=<더미>`로
  `AIGENTRY_INSTALL_PROFILE=autoresearch-public bash install.sh --force` 후
  `grep -c api_key ~/.config/aigentry-devkit/install-state.json` → 현재 1, 수정 후 0.
  `stat -f %Lp` 로 퍼미션도 함께 기록.
- **소유**: `aigentry-devkit` / coder
- **의존·롤아웃·롤백**: 독립. state 스키마의 소비자를 먼저 확인해야 함(`install.sh:982`가
  orchestrator status를 같은 파일에 병합하므로 스키마 소비자가 최소 1곳 존재).
  롤백 = 필드 복원.
- **태스크 매핑**: **NEW 후보**. `sec-wire-enforce-spawn`은 spawn 검증 축이라 다르고, #884는
  npm 토큰이라 다르다. 기존 큐에서 devkit state 파일 시크릿을 다루는 행을 찾지 못했다.

---

### F3 — Windows 설치기에 `orchestrator-role`이 아예 존재하지 않는데 프로파일은 선택 가능하고 "완료"로 끝난다

- **심각도 High / 확신도 High(문자열 카운트로 확정)**
- **증거**: `aigentry-devkit` HEAD `bb7876b`
  - `grep -c "orchestrator" install.ps1` → **0**. 경고 문구조차 없다.
  - `install.sh:791` `header "Phase 8. Orchestrator Role"` — clone/build/bin_link/state 기록까지
    약 200줄(`install.sh:791~1000`).
  - `install.ps1:483` `Write-Header "Phase 8. Cross-platform Notes"` — 같은 phase 번호에
    안내문 3줄. 게다가 `Should-RunPhase 8` 가드 없이 **무조건** 출력된다.
  - `installer-manifest.json`의 프로파일 `orchestrator`와 `ecosystem-full`은 components에
    `orchestrator-role`을 포함한다. ps1의 `Test-ComponentSelected`는 이 이름을 조회하는 곳이 없다.
  - `install.ps1:489-501` 완료 배너는 skills/HUD/telepty/deliberation/brain/dustcraw/registry/WTM
    을 나열하고 orchestrator는 언급하지 않는다 → "빠졌다"는 신호가 사용자에게 도달하지 않는다.
- **현재 영향**: Windows에서 `AIGENTRY_INSTALL_PROFILE=orchestrator`로 설치하면 **조용히
  불완전한 설치**가 "Installation Complete!"로 끝난다. `dispatch.sh`/`session-reconciler.sh`
  bin link도, `~/.aigentry/instructions` 트리도 생기지 않는다
  (`orchestrator-role.adapter.json`의 healthcheck가 정확히 그 둘을 본다).
- **가정된 위험**: orchestrator-role의 `failure_policy`는 `soft`이므로 "지원 안 함"이 설계 의도일
  수 있다. 그렇더라도 **선택 가능한데 아무 말이 없는 것**은 의도로 볼 수 없다.
- **근본 원인**: 두 설치기가 phase 번호는 공유하되 phase **내용**의 일치를 검증하는 장치가 없다.
  ps1의 phase 8이 다른 의미로 재사용된 것이 그 증상이다.
- **최소 수정**: `install.ps1`에 `if (Test-ComponentSelected "orchestrator-role") { Write-Warn
  "orchestrator-role is not supported by the Windows installer — install manually" }` 와
  state에 `orchestrator = @{ status = "unsupported" }` 기록. 약 6줄. **기능 이식이 아니다.**
- **수정 전 재현/수용 게이트**: Windows(또는 pwsh)에서
  `$env:AIGENTRY_INSTALL_PROFILE="orchestrator"; ./install.ps1` 실행 후
  `install-state.json`에 orchestrator 키가 없고 stderr에 경고가 없음을 보인다.
  수정 후 경고 1줄 + `status: unsupported` 기록.
- **소유**: `aigentry-devkit` / coder
- **의존·롤아웃·롤백**: 독립, 순수 가산. 롤백 = 블록 제거.
- **태스크 매핑**: **NEW 후보**. #895(aterm daemon ownership), #534(cleanup)와 무관.
  기존 큐에서 Windows 설치기 프로파일 갭 행을 찾지 못했다.

---

### F4 — 폭발 반경이 가장 큰 devkit의 CI/릴리스 게이트가 `--help` 한 줄이고, 이미 있는 테스트 4스위트는 한 번도 실행되지 않는다

- **심각도 High / 확신도 High**
- **증거**: `aigentry-devkit` HEAD `bb7876b`
  - `.github/workflows/ci.yml:30-31` — 3 OS × Node 3버전 = **9개 잡이 전부**
    `node bin/aigentry-devkit.js --help` 만 실행.
  - `.github/workflows/release.yml:21` — 퍼블리시 전 validate 잡도 동일하게 `--help`.
    태그↔package.json 일치 게이트 없음, 레지스트리 되읽기 없음.
    `release.yml:35-37` README 재생성은 `continue-on-error: true`.
  - `package.json` scripts: `test` = `node bin/aigentry-devkit.js --help`.
    실제 스위트는 별도 이름으로만 존재 — `test:scaffold-project`, `test:scaffold-install-hooks`,
    `test:logger-emit`, `test:skills-drift`. **어느 워크플로도 이 4개를 호출하지 않는다.**
  - 존재하는 테스트 실체: `tests/scaffold-project/v1/` 9개 spec(fresh, reapply, uninstall,
    dry-run-no-writes, malformed-settings, sentinel-drift, template-override, non-interactive,
    unknown-cli-flag), `tests/scaffold-install-hooks/v1/` 5개 test, `tests/logger-emit/v1/` 1개,
    `tests/skills-drift/v1/` 1개 — 총 16개 파일, `test(`/`it(` 매칭 **43건**.
  - 대조군: `aigentry-orchestrator/.github/workflows/ci.yml`은 `npm test`(=`tsc -p . &&
    scripts/run-tests.mjs`) + `tests/dispatch/run-all.sh` + packaging 테스트 3종을 돌린다.
- **현재 영향**: 설치기 회귀가 CI를 통과한다. 특히 `uninstall.spec.js`, `dry-run-no-writes.spec.js`,
  `malformed-settings.spec.js`, `sentinel-drift.spec.js`, `skills-drift.test.js` — 즉 **데이터
  보존·비파괴·설정 손상 내성·스킬 드리프트**를 검증하려고 쓴 테스트가 정확히 그 위험이 가장 큰
  저장소에서 잠들어 있다. F2·F3 같은 결함이 CI에 잡히지 않은 이유가 여기에 있다.
- **가정된 위험**: 워크플로 실행 이력을 조회하지 않았으므로 "CI가 실제로 그린이었다"는 주장은
  하지 않는다. YAML이 정의한 커버리지만 근거다.
- **근본 원인**: `test`가 "CLI가 죽지 않는지" 스모크로 먼저 자리를 잡았고, 나중에 추가된 진짜
  스위트들이 별도 스크립트명으로 붙으면서 진입점을 갱신하지 않았다.
- **최소 수정**: `"test": "npm run test:scaffold-project && npm run test:scaffold-install-hooks
  && npm run test:logger-emit && npm run test:skills-drift"` 로 교체하고 ci.yml의 마지막
  스텝을 `npm test`로 변경. release.yml validate도 동일. (약 6줄)
- **수정 전 재현/수용 게이트**: 로컬에서 `npm run test:scaffold-project` 등 4개를 개별 실행해
  현재 통과/실패 baseline을 먼저 기록한다(실패가 남아 있다면 그 자체가 별도 태스크).
  수정 후 `npm test`가 43건을 실행하고 ci.yml 로그에 나타난다.
- **소유**: `aigentry-devkit` / coder + tester
- **의존·롤아웃·롤백**: **선행 조건 있음** — 4개 스위트가 현재 통과하는지 먼저 확인해야 한다.
  붉으면 CI가 즉시 막힌다. 롤백 = `test` 스크립트 원복.
- **태스크 매핑**: **NEW 후보**(F7과 묶어 하나의 "릴리스 게이트 전파" 태스크로 등록 가능).
  #1136(workflow production)은 오케스트레이터 워크플로 축이라 다르고, #1133(model-router)과 무관.

---

### F5 — 설치기가 실제로 설치하지 않는 버전을 화면에 출력하고, 호환성 게이트는 7세대 낡은 값을 본다

- **심각도 Medium / 확신도 High(두 경로 모두 코드로 확정)**
- **증거**: `aigentry-devkit` HEAD `bb7876b`
  - `install.sh:506` `TELEPTY_VERSION="$(manifest_eval "manifest.components.telepty.install.version")"`
    → `installer-manifest.json`이 주는 값은 **`0.1.45`**.
  - `install.sh:509` `info "Installing $TELEPTY_SPEC via install_with_fallback"` — 사용자는
    `@dmsdc-ai/aigentry-telepty@0.1.45` 를 본다.
  - `install.sh:510`이 실제로 호출하는 건 `run_install_fallback "telepty"` →
    `lib/install-fallback.js` → `readAdapterFallback()`(`lib/install-fallback.js:67-81`)이
    읽는 파일은 `config/modules/telepty.adapter.json`이고 그 체인은
    `[{kind:"npm-global", package:"@dmsdc-ai/aigentry-telepty", version:"latest"}]`.
    최종 실행 명령은 `lib/install-fallback.js:342` `npm install -g ${pkg}@${version}` = **`@latest`**.
  - 즉 `TELEPTY_SPEC`은 **로그 문자열 외에 아무 데도 쓰이지 않는다**. `DUSTCRAW_SPEC`도 동일
    구조(`install.sh:647,655`, adapter는 `latest`, manifest는 `0.3.1`).
  - 호환성 게이트: `install.sh:517-531`이 `manifest.compatibility.telepty.target`(=`0.1.45`)와
    설치된 버전을 `sort -V`로 비교한다. 로컬 telepty 소스는 **0.8.3**이므로 이 게이트는
    구조적으로 **항상 통과**한다 — 즉 아무것도 막지 못하는 게이트다.
- **현재 영향**: (1) 설치 로그가 사실이 아니다 — 사고 조사 때 "0.1.45가 설치됐다"는 잘못된
  단서를 준다. (2) 최소 버전 게이트가 존재하는 척만 한다. **설치 결과 자체는 `latest`라 정상**이며,
  따라서 이건 설치 실패가 아니라 **관측성/신뢰 결함**이다.
- **가정된 위험**: 누군가 `installer-manifest.json`의 version을 "고치면 설치가 바뀐다"고 믿고
  수정하면 아무 효과가 없다. 반대로 adapter를 고치면 로그와 더 어긋난다.
- **근본 원인**: 설치 소스가 manifest → adapter로 이동했는데, manifest 쪽의 죽은 필드와 그것을
  읽는 로그/게이트가 함께 제거되지 않았다.
- **최소 수정**: `install.sh:506-509`, `:647-655`의 spec 계산·출력을 삭제하거나
  adapter 체인에서 읽도록 바꾸고, `compatibility.telepty.target`을 실제 최소 지원 버전으로
  갱신하거나 게이트를 제거. (약 10줄)
- **수정 전 재현/수용 게이트**: `node lib/install-fallback.js telepty --dry-run` 출력
  (`version=latest`)과 `install.sh:509`가 출력할 문자열(`@0.1.45`)이 불일치함을 나란히 보인다.
  수정 후 두 값이 동일.
- **소유**: `aigentry-devkit` / coder
- **의존·롤아웃·롤백**: 독립. 로그 문자열 변경이므로 롤백 위험 없음.
- **태스크 매핑**: **NEW 후보**. F6과 원인이 같아(매니페스트 다중화) 하나로 묶어도 무방.

---

### F6 — 표시용 `ecosystem.json`이 6개 저장소에 바이트 동일하게 복제된 채 로컬 소스와 어긋나 있다

- **심각도 Medium / 확신도 High**
- **증거**: 6개 사본 전부 sha256 `722f3d5d9844…`, 55줄, 파일 mtime 2026-07-26 — 위치는
  `aigentry`, `aigentry-telepty`, `aigentry-devkit`, `aigentry-brain`, `aigentry-deliberation`,
  `aigentry-orchestrator`. 매니페스트 주석 스스로 "각 저장소에 바이트 동일하게 vendored,
  버전 변경 시 `aigentry-devkit/scripts/sync-readme-tooling.mjs`로 갱신"이라고 선언한다.
  로컬 소스와의 대조(모두 같은 디스크의 package.json끼리 비교):

  | ecosystem.json 기재 | 로컬 소스 실제 |
  |---|---|
  | telepty `0.7.1` | `aigentry-telepty/package.json` = **0.8.3** |
  | orchestrator package `aigentry-orchestrator`, version `—`, `published: false` | `aigentry-orchestrator/package.json` name = **`@dmsdc-ai/aigentry-orchestrator`**, version **0.2.0**, `release.yml`(태그 푸시 시 npm publish) 보유 |
  | brain `0.3.1`, deliberation `0.0.47`, devkit `0.1.14` | 일치 |

  같은 계열 결함이 어댑터에도 있다: `config/modules/bridge.adapter.json` 이전 단계인
  `installer-manifest.json`의 bridge 항목은 `package: "@aigentry/bridge"`인데
  `aigentry-bridge/package.json`의 실제 이름은 **`@dmsdc-ai/aigentry-bridge`** — 스코프가 다르다.
  오늘 무해한 이유는 adapter 체인이 `{kind:"skip"}` 플레이스홀더라서 그 이름이 쓰이지 않기 때문이다.
- **현재 영향**: README 생태계 표가 telepty를 실제보다 낮게 표시하고, orchestrator를
  "미게시"로 표시한다. 사용자가 보는 공개 문서와 저장소 현실이 어긋난다.
- **가정된 위험**: 레지스트리 실제 게시 버전은 측정하지 않았다. 위 표는 **로컬 대 로컬** 비교다.
  bridge 스코프 오기는 adapter를 npm-global로 바꾸는 순간 404가 된다(현재는 도달 불가 경로).
- **근본 원인**: 표 갱신이 사람 트리거(`sync-readme-tooling.mjs` 수동 실행)이고, 버전이 바뀌는
  릴리스 파이프라인과 연결되어 있지 않다. telepty 0.7.1→0.8.3 릴리스가 표를 끌고 오지 않았다.
- **최소 수정**: telepty/brain/deliberation/devkit/orchestrator의 release.yml에
  "표와 dependencies가 이 태그의 버전과 모순이면 실패" 체크 1스텝 추가, 또는 최소한
  `sync-readme-tooling.mjs`를 릴리스 후 스텝으로 연결. F1의 range 검증도 같은 자리에 넣는다.
- **수정 전 재현/수용 게이트**: `node -e` 한 줄로 6개 사본의 telepty version과
  `aigentry-telepty/package.json`의 version이 다름을 출력 → 수정 후 동일.
- **소유**: `aigentry-devkit`(생성 스크립트 소유) + 각 릴리스 저장소 / release 역할
- **의존·롤아웃·롤백**: F1과 같은 스크립트를 건드린다 → **묶어서 처리 권장**. 문서 생성 경로라
  롤백 위험 낮음.
- **태스크 매핑**: **NEW 후보**, F1과 dedup 하여 한 태스크로 등록 가능(원인 동일: 재생성
  스크립트가 표만 보고 dependencies/게시 상태를 안 본다). #1128/#1133/#1136과 무관.

---

### F7 — 오케스트레이터가 런타임 의존하는 패키지들의 저장소에 릴리스 자동화가 전혀 없다

- **심각도 Medium-High / 확신도 High(워크플로 파일 유무는 확정, 레지스트리 상태는 미측정)**
- **증거**: 13개 aigentry 계열 저장소의 `.github/workflows` 실측

  | 저장소 | 워크플로 | 태그↔버전 게이트 | 레지스트리 되읽기 | NPM_TOKEN |
  |---|---|---|---|---|
  | aigentry-telepty | readme-regen, release, test-install | ✅ | ✅ | ✅ |
  | aigentry-orchestrator | ci, readme-regen, release | ✅ | ✅ | ✅ |
  | aigentry-devkit | ci, release | ❌ | ❌ | ✅ |
  | aigentry-brain | ci, release | ❌ | ❌ | ✅ |
  | aigentry-deliberation | ci, release | ❌ | ❌ | ✅ |
  | aigentry | readme-regen **만** | ❌ | ❌ | ❌ |
  | aigentry-logger / -ssot / -hooks / -context / -bridge / -dustcraw / -amplify | **없음** | — | — | — |

  그런데 `aigentry-orchestrator/package.json`은 `@dmsdc-ai/aigentry-logger ^0.2.0`,
  `@dmsdc-ai/aigentry-ssot ^1.0.0`을 런타임 의존성으로 선언하고,
  `aigentry-orchestrator/package-lock.json`은 두 패키지를 `registry.npmjs.org` tarball URL로
  resolve한 기록을 갖고 있다(락파일 작성 시점의 사실). 즉 **CI도 릴리스 워크플로도 없는 저장소의
  산출물이 오케스트레이터 런타임에 들어간다.** `aigentry-ssot`는 패키지 소스가 중첩
  디렉터리 `pkg/`에 있어 저장소 루트에 package.json조차 없다.
  설치기는 여기에 더해 `dustcraw`/`amplify`를 `npm-global @latest`로 설치한다
  (`config/modules/*.adapter.json`) — 두 저장소 모두 워크플로 0개.
  `aigentry` 메타 패키지 자체도 release.yml이 없어 손으로 퍼블리시된다(F1의 range가 방치된
  이유와 같은 뿌리).
- **현재 영향**: 게시된 산출물을 특정 커밋에 귀속시킬 로컬 증거가 없다. orchestrator release.yml
  주석이 기록한 사고("태그 없이 손으로 3개 버전이 올라갔다")가 **여전히 가능한 저장소가 8개** 남아 있다.
- **가정된 위험**: 이 저장소들의 게시 여부·현재 버전은 레지스트리를 조회하지 않아 확인할 수 없다.
  logger/ssot는 락파일 증거가 있고 나머지는 어댑터가 이름을 가리킬 뿐이다.
- **근본 원인**: 릴리스 품질 기준이 telepty에서 사고로 학습되어 orchestrator로 한 번 복사됐지만,
  전파 메커니즘(공유 워크플로/템플릿/체크리스트)이 없어 거기서 멈췄다.
- **최소 수정**: **전 저장소 살포가 아니라** "npm에 실제로 올라가는 것"으로 범위를 한정 —
  logger, ssot, devkit, brain, deliberation, aigentry(메타) 6개에 orchestrator의 release.yml
  guard 잡(태그↔package.json 일치 + 시크릿 부재=실패)만 이식. 되읽기 증명은 2단계로 미룬다.
- **수정 전 재현/수용 게이트**: 각 저장소에서 `ls .github/workflows` 와 `grep -l TAG_VERSION`
  결과가 위 표와 같음을 보인다. 수정 후 6개 저장소에서 guard 잡이 존재.
- **소유**: 각 저장소 / release 역할. 조정 소유는 `aigentry-orchestrator`(패턴 원본 보유).
- **의존·롤아웃·롤백**: 저장소별 독립. 태그 규약이 없는 저장소는 첫 태그부터 시작해야 하므로
  logger/ssot는 준비 작업이 더 든다. 롤백 = 워크플로 파일 삭제.
- **태스크 매핑**: **#884를 UPDATE 하는 것이 아니라 NEW**. #884는 "공용 npm 토큰 90일 만료 추적"
  으로 자격증명 수명 문제이고, 본 건은 게시 증명 부재다. 다만 **둘은 같은 5개 파이프라인을
  공유한다**(NPM_TOKEN 사용 저장소 = telepty/orchestrator/devkit/brain/deliberation) — #884에
  "영향 범위 = 이 5개 저장소" 사실을 증거로 덧붙일 것을 권장.

---

### F8 — 1013줄 설치기에 롤백 경로가 0개이고, 하드 실패는 부분 설치를 남긴 채 종료한다

- **심각도 Medium / 확신도 High**
- **증거**: `aigentry-devkit` HEAD `bb7876b`
  - `install.sh` `trap` 등록 **0건**(`grep -c '^[[:space:]]*trap ' install.sh` → 0).
    `backup`/`restore`/`rollback` 식별자도 0건. 대조적으로 `install.ps1`은 5건의
    `trap|finally` 매칭을 갖는다 — 즉 **정리 규율이 OS 간에도 비대칭**이다.
  - `install.sh:2` `set -euo pipefail` → 예기치 못한 오류에서 즉시 종료, 정리 없음.
  - `die` 호출 5곳(`:329, :511, :514, :545, :557`). 그중 `:511/:514/:545`는 **phase 2 이후**,
    즉 phase 1에서 이미 스킬·훅·HUD·WTM을 `$HOME/.claude` 하위에 쓴 뒤다.
    `:545`는 `npm install -g`로 전역 설치까지 끝난 뒤 데몬 헬스체크 실패로 죽는다.
  - 복구 수단은 **전진 재개뿐**: `AIGENTRY_INSTALL_RESUME`(`install.sh:22, :318-329, :344`)은
    시작 phase를 앞당길 뿐 되돌리지 않는다. `uninstall` 경로는 `install.sh` 안에 없다.
  - 참고 대조: `aigentry-telepty/scripts/preuninstall.js:4-15`는 정확히 반대 규율을 보여준다 —
    무엇을 정리하고 무엇을 남기는지, 왜 절대 실패하면 안 되는지를 명시하고 상태 디렉터리는
    명시적 `telepty uninstall [--purge]`에 위임한다.
- **현재 영향**: 설치가 중간에 죽으면 사용자 홈에 스킬/훅/MCP 설정/전역 npm 패키지/state 파일이
  섞여 남고, 어디까지 갔는지 알려주는 것은 state 파일 하나뿐인데 그 파일은 phase 7에서야
  기록된다(`install.sh:779-782`). 즉 **phase 2~6에서 죽으면 state 파일조차 없다.**
- **가정된 위험**: 실제 설치를 실행하지 않았으므로 "이 조건에서 반드시 이렇게 깨진다"고는
  말하지 않는다. 위 서술은 코드 경로에서 도출한 것이다.
- **근본 원인**: 설치기가 phase별 전진 재개를 데이터로 잘 설계했지만(`failure_policy`, fallback
  체인, resume), **역방향 상태 전이**를 설계 대상에 넣지 않았다.
- **최소 수정**: 전체 롤백 구현이 아니라 **가시성 먼저** — `trap 'write_installer_state' EXIT`
  한 줄과 `die()`에 "지금까지 완료된 phase / 되돌리는 방법" 출력 추가. phase 1 직후에도 state를
  한 번 쓰게 한다. (약 8줄)
- **수정 전 재현/수용 게이트**: 임시 HOME에서 `AIGENTRY_TELEPTY_URL=http://127.0.0.1:1`
  같은 값으로 phase 2 헬스체크를 강제 실패시킨 뒤
  `test -f ~/.config/aigentry-devkit/install-state.json` → 현재 실패(파일 없음),
  수정 후 성공하고 파일에 완료 phase가 기록됨.
- **소유**: `aigentry-devkit` / coder
- **의존·롤아웃·롤백**: F2(state 스키마)와 같은 파일을 건드린다 → **F2와 같은 PR로 처리 권장**.
- **태스크 매핑**: **NEW 후보**. #534(session-cleanup 고아 프로세스)는 세션 수명주기라 다르고,
  #895(aterm 데몬 재시작)와도 다르다. 기존 큐에서 설치기 롤백 행을 찾지 못했다.

---

## 3. 기존 태스크와의 관계 — 무엇을 새로 만들지 않았는가

- **#1128 (inbound HOLD 유실)** — 이미 delegated 상태이고 진단이 진행 중이다. 본 감사에서
  전달 경로를 재진단하지 않았고, 발견도 없다. 중복 등록하지 않음.
- **#1133 (model-router 제품화)**, **#1136 (workflow 제품화)** — 두 스펙 모두 main에 있으나
  구현 승인 전이다. 본 감사는 두 축을 건드리지 않았다.
- **#1137/#1138 (포트폴리오 triage)** — 완료됨. 그 후속은 #1139 소유. 본 감사에서 task-queue의
  행 단위 상태를 재triage하지 않았다. (관찰 1건만 기록: `state/task-queue.json`의 최상위
  `updated_at`이 `2026-07-30`인데 개별 행은 `2026-09-08`까지 갱신되어 있다. 포트폴리오
  소유 범위이므로 finding으로 승격하지 않고 #1139에 참고로 넘긴다.)
- **#526 (에코시스템 대개조 EPIC)** — 본 보고서가 그 트리거의 현재 소스 리프레시다.
  새 EPIC을 만들지 않았고, F1~F8은 전부 국소·실행가능 델타로 잘랐다.
- **#534 / #895 / #884** — 셋 다 현재 유효성을 재검증하지 않았으므로 "현재도 발생 중"이라고
  주장하지 않는다. #884에 대해서만 F7이 영향 범위 증거(NPM_TOKEN 사용 저장소 5개)를 더한다.
- **`sec-wire-enforce-spawn` / `struct-injection-and-drift`** — 본 감사의 읽기 범위(auth
  미들웨어 등록 순서, origin guard 기본 거부, 감사 로그)에서 이 트랙들이 주장하는 결함의 현재
  증거를 찾지 못했다. **없다고 단정하지 않는다** — spawn 검증 본문과 injection 인용 경로를
  라인 단위로 다 읽지는 않았다. 미측정으로 분류한다.

**신규 등록 후보 요약(태스크 ID는 오케스트레이터가 부여; 본 보고서는 ID를 만들지 않는다).**

| # | 제목 | 소유 저장소 | 권장 묶음 |
|---|---|---|---|
| F1+F6 | 메타 패키지 의존성 range와 ecosystem 표가 소스와 어긋남 — 재생성 시 검증 추가 | aigentry / aigentry-devkit | 1태스크 |
| F2+F8 | devkit install-state.json 시크릿 평문 기록 + 실패 시 상태 미기록 | aigentry-devkit | 1태스크 |
| F3 | Windows 설치기 orchestrator-role 침묵 누락 | aigentry-devkit | 단독 |
| F4+F7 | 릴리스/CI 게이트 전파 — devkit 테스트 진입점 + 게시 저장소 guard 잡 | aigentry-devkit 외 5 | 1태스크(단계 분리) |
| F5 | 설치 로그가 실제 설치 spec과 불일치 + 무효 호환성 게이트 | aigentry-devkit | 단독(F1+F6에 합류 가능) |

---

## 부록 A. 저장소 인벤토리와 처분

측정 기준: 2026-09-08T13:36Z, `/Users/duckyoungkim/projects/` 직접 열거(54개 디렉터리).

### A.1 aigentry 계열 23개 — 전수 처분

| 저장소 | git | HEAD | dirty | 매니페스트 | 처분 |
|---|---|---|---|---|---|
| aigentry | ✅ main | f959b29 | 4 | `@dmsdc-ai/aigentry` 0.1.1 | **심층** (F1, F6) |
| aigentry-devkit | ✅ main | bb7876b | 51 | `@dmsdc-ai/aigentry-devkit` 0.1.14 | **심층** (F2~F5, F7, F8) |
| aigentry-telepty | ✅ main | 997ea7c | 13 | `@dmsdc-ai/aigentry-telepty` 0.8.3 | **심층** (강점 근거, F6, F7) |
| aigentry-orchestrator | ✅ main | ca93cb6 | 10 | `@dmsdc-ai/aigentry-orchestrator` 0.2.0 | **심층** (릴리스 대조군, F6, F7) |
| aigentry-brain | ✅ main | 0ffa6ee | 6 | `@dmsdc-ai/aigentry-brain` 0.3.1 | 매니페스트+워크플로 (F1, F7) |
| aigentry-deliberation | ✅ main | b009549 | 3 | `@dmsdc-ai/aigentry-deliberation` 0.0.47 | 매니페스트+워크플로 (F7) |
| aigentry-logger | ✅ main | f4f62e3 | 1 | `@dmsdc-ai/aigentry-logger` 0.2.0 | 매니페스트만 — 워크플로 0 (F7) |
| aigentry-ssot | ✅ main | 42afae4 | 3 | 루트 없음 / `pkg/` = `@dmsdc-ai/aigentry-ssot` 1.0.0 | 매니페스트만, 중첩 패키지 (F7) |
| aigentry-bridge | ✅ main | 5eabef0 | 11 | `@dmsdc-ai/aigentry-bridge` 0.1.0 | 매니페스트만 — 어댑터 이름 불일치 (F6) |
| aigentry-dustcraw | ✅ main | c0af3c9 | 14 | `@dmsdc-ai/aigentry-dustcraw` 0.4.0 | 매니페스트만 (F5, F7) |
| aigentry-amplify | ✅ main | b555848 | 7 | `@dmsdc-ai/aigentry-amplify` 0.0.1 | 매니페스트만 (F7) |
| aigentry-hooks | ✅ main | 507393e | 7 | `@dmsdc-ai/aigentry-hooks` 0.0.2 | 매니페스트만 — 워크플로 0 |
| aigentry-context | ✅ main | eb23360 | 3 | `@dmsdc-ai/aigentry-context` 0.0.1 | 매니페스트만 — 워크플로 0 |
| aigentry-analyst | ✅ main | 8a45a84 | 3 | `aigentry-analyst` 1.0.0 (스코프 없음) | 매니페스트만 — 최종 커밋 2026-04-09 |
| aigentry-registry | ✅ main | ac221cd | 3 | 루트 pyproject / 중첩 `frontend`,`bridge` package.json | 매니페스트만 — 중첩 2개 |
| aigentry-aterm | ✅ main | 9b4cec5 | 8 | Cargo (package.json 없음) | 매니페스트만 — ecosystem.json이 `@dmsdc-ai/aterm` 0.2.14 UNLICENSED로 기록 |
| aigentry-starter | ✅ main | c310f28 | 4 | 없음 | 소스 미열람 — 매니페스트 부재 |
| aigentry-forum | ✅ main | f1fc896 | 1 | 없음 | 소스 미열람 — 최종 커밋 2026-03-01 |
| aigentry-architect | ❌ NOGIT | — | — | 없음 | **소스 이용 불가**(git 없음, 매니페스트 없음) |
| aigentry-builder | ❌ NOGIT | — | — | 없음 | **소스 이용 불가** |
| aigentry-design | ❌ NOGIT | — | — | 없음 | **소스 이용 불가** |
| aigentry-sandbox | ❌ NOGIT | — | — | 없음 | **소스 이용 불가** |
| aigentry-tester | ❌ NOGIT | — | — | 없음 | **소스 이용 불가** |

> NOGIT 5개(architect/builder/design/sandbox/tester)는 역할 이름과 같지만 git 저장소도
> 매니페스트도 없다. 이번 감사에서는 **"소스 이용 불가"**로만 처분했고, 폐기 대상인지
> 미초기화 상태인지는 판단하지 않았다(증거 없음). #534 정리 태스크의 인접 사안일 수 있다.

### A.2 범위 제외 31개 — 사유

- 터미널 업스트림 포크/참조 8개: `alacritty, contour, ghostty, kitty, rio, wezterm, winit, zellij`
  — 서드파티 업스트림. aigentry 릴리스/설치 경로에 포함되지 않음.
- claude-code 참조 4개: `claude-code-fork, claude-code-murraytom, claude-code-sourcemap,
  claude-code-system-prompts` — 읽기용 참조.
- 도구/스킬 5개: `cmux, superpowers, claude-workspace-skills, wtm, testbed` — 생태계 인접이나
  install/release 경로 밖. `cmux`는 F 대상 아님(#544에서 이미 제출 경로에서 제거됨).
- 제품/실험 14개: `aases, animal-hospital, benchmarks, cambrian-spore, claurst, common-ai,
  constitution, n8n-video, nexaforge, ppt-maker, shipfast, syc-ai, voicecode, youtube-scraper`
  — 소비자 프로젝트. 본 감사의 질문(설치/릴리스/관측성/설정전파/수명주기 경계)에 해당 없음.

### A.3 엣지 케이스

- **중첩 패키지 3개**: `aigentry-ssot/pkg`(= 게시 패키지 본체), `aigentry-registry/frontend`,
  `aigentry-registry/bridge`. 루트 매니페스트만 보는 도구는 전부 놓친다 — `ecosystem.json`이
  ssot를 아예 담고 있지 않은 것과 같은 뿌리.
- **`ecosystem.json`은 6/23만 담는다.** 표시용 매니페스트이며 열거 근거로 쓰지 않았다(§0).
- **워크트리 77개**(`/Users/duckyoungkim/.aigentry/worktrees/`) — 오케스트레이터 작업 공간.
  저장소로 세지 않음.
- **`/Users/duckyoungkim/.aigentry/repo/`** — 메모리 프로파일 3개 파일뿐. 저장소 아님.
- **dirty 상태**: 감사 대상 18개 git 저장소 전부 dirty(1~51 파일). 어떤 파일도 되돌리지 않았고
  열지 않았다. devkit의 dirty=51은 별도 확인이 필요할 수 있으나 본 감사 범위 밖.

---

## 부록 B. 증거 재현 명령 (전부 읽기 전용)

```bash
# F1
python3 -c "import json;print(json.load(open('~/projects/aigentry/package.json'.replace('~','$HOME')))['dependencies'])"
# F2
grep -n chmod ~/projects/aigentry-devkit/install.sh
grep -cn 'Acl\|icacls\|SetAccessControl' ~/projects/aigentry-devkit/install.ps1
# F3
grep -c orchestrator ~/projects/aigentry-devkit/install.ps1   # -> 0
# F4
python3 -c "import json;print(json.load(open('$HOME/projects/aigentry-devkit/package.json'))['scripts'])"
# F5
node ~/projects/aigentry-devkit/lib/install-fallback.js telepty --dry-run
sed -n '506,531p' ~/projects/aigentry-devkit/install.sh
# F6
for f in ~/projects/aigentry*/ecosystem.json; do shasum -a 256 "$f"; done
# F7
for r in ~/projects/aigentry ~/projects/aigentry-*; do echo "$r: $(ls "$r/.github/workflows" 2>/dev/null | tr '\n' ' ')"; done
# F8
grep -c '^[[:space:]]*trap ' ~/projects/aigentry-devkit/install.sh   # -> 0
```
