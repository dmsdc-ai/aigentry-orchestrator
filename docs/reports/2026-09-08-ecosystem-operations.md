# 에코시스템 운영 현황 감사 (install/release/observability/config-auth/lifecycle)

- 태스크: #1141 (umbrella #526의 현재 소스 리프레시). #1140 architecture assessor와 병렬.
- 역할: analyst (read-only). 코드 수정·빌드·테스트·설치·네트워크/레지스트리 조회 없음.
- **측정 창: 2026-09-08T13:36:15Z(첫 명령, 로그됨) ~ 13:47:09Z(1차 커밋 `066558b`).**
  2차 정정 판독은 13:48Z~13:52Z. (초판이 적었던 "13:56Z"는 로그에 없는 미래 시각이었다 — 철회.)
- 작업 워크트리: `/Users/duckyoungkim/.aigentry/worktrees/ec1141`, 브랜치 `docs/1141-ecosystem-operations`
- 산출물: 본 파일 1개만 커밋

---

## 0. 이 보고서가 무엇을 근거로 삼는가 (먼저 읽을 것)

### 0.1 커밋된 내용 vs 작업 트리 — 초판의 가장 큰 결함

초판은 각 발견에 저장소 HEAD SHA를 붙여 마치 그것이 인용 내용의 출처인 것처럼 적었다. **틀렸다.**
감사 대상 저장소는 전부 dirty였고, 특히 `aigentry-devkit`(HEAD `bb7876b`, dirty=51)은 인용한
파일 중 상당수가 HEAD와 다르다. 이번 판에서는 `git show HEAD:<path>`로 blob을 직접 비교해
**모든 인용에 [HEAD 확인] / [작업트리 전용] / [미추적] 태그를 붙였다.**

| 인용 파일 | HEAD 상태 | 작업 트리 | 이 보고서의 취급 |
|---|---|---|---|
| `devkit/package.json` | 동일(clean) | 동일 | **[HEAD 확인]** |
| `devkit/config/installer-manifest.json` | 동일(clean) | 동일 | **[HEAD 확인]** |
| `devkit/.github/workflows/*` | 동일(clean) | 동일 | **[HEAD 확인]** |
| `devkit/install.sh` | 951줄 | **1013줄 (M)** | 라인번호 병기, 사실별로 HEAD 재확인 |
| `devkit/install.ps1` | 453줄 | **506줄 (M)** | 동일 |
| `devkit/config/modules/*.adapter.json` | 7개 전부 (M) | — | **[작업트리 전용]** |
| `devkit/lib/install-fallback.js` | **HEAD에 없음** (`git cat-file -e` 실패) | 존재 | **[미추적]** |
| `ecosystem.json` (6사본) | clean | 동일 | **[HEAD 확인]** |

이 표 자체가 하나의 관찰이다 — **devkit의 설치 경로 리팩터가 커밋되지 않은 채 진행 중이고,
그 핵심 파일(`lib/install-fallback.js`)은 git에 아예 없는데 `package.json`의 `files`는
`lib/**`를 게시 대상에 포함한다.** 초판은 이 미추적 파일의 동작을 저장소의 동작인 양 서술했다.

### 0.2 센 것(counted universe)과 열거 정정

`/Users/duckyoungkim/projects/` 하위 **54개** 디렉터리를 직접 열거했다. aigentry 계열 **23개**.
`ecosystem.json`은 표시용 매니페스트(6개 모듈)이므로 열거 근거로 쓰지 않았다.

초판의 중첩 패키지 열거는 `-maxdepth 2`로 수행되어 **틀렸다**("3개"). depth 4 재열거 결과
루트 외 중첩 매니페스트는 **9개**(빌드 산출물 `.next/` 3개 별도):

```
aigentry-aterm/npm/aterm/package.json            ← 초판이 "package.json 없음"이라 한 바로 그것
aigentry-aterm/npm/aterm-darwin-arm64/package.json
aigentry-amplify/packages/core, packages/channels
aigentry-brain/packages/signaling-server
aigentry-registry/bridge, frontend
aigentry-ssot/pkg
```
Rust/Python: `aigentry-aterm/Cargo.toml` + 크레이트 3개, `aigentry-registry/pyproject.toml`.

**`@dmsdc-ai/aterm`는 존재한다.** `aigentry-aterm/npm/aterm/package.json` = name
`@dmsdc-ai/aterm`, version **0.2.13**, license **MIT**,
`optionalDependencies: {@dmsdc-ai/aterm-darwin-arm64: 0.2.13}`,
`peerDependencies: {@dmsdc-ai/aigentry: ">=0.1.0"}`,
`dependencies: {@dmsdc-ai/aigentry-devkit: ">=0.0.19", @dmsdc-ai/aigentry-telepty: ">=0.1.88"}`.

**`NOGIT` ≠ 소스 이용 불가.** 초판은 5개 디렉터리를 "소스 이용 불가"로 처분했는데 전부 읽을 수
있는 파일을 갖고 있다 — architect 26개, design 14개, tester 59개, sandbox 75개, builder 4개.
올바른 처분은 **"미열람(not-inspected) / 버전 프로버넌스 없음"**이다.

**cmux와 WTM은 설치/릴리스 경로 밖이 아니다.** WTM은 설치기가 `$HOME/.local/lib/wtm`로 복사하고
PATH에 심링크한다(`install.sh:405-491` [작업트리], HEAD에도 동일 블록 존재 `:360-446`).
cmux는 `install.sh`에 등장하지 않지만 세션 spawn 표면의 살아있는 의존이다(#544에서 submit 경로만
바뀌었을 뿐 spawn 표면은 유지). 둘 다 **"심층 감사 범위 밖의 인접 의존"**으로 재분류한다.

**패키지 그래프가 완전하다고 주장하지 않는다.** 위 열거는 파일시스템 walk의 결과이고,
workspace 선언·private 링크·게시 여부를 교차 검증하지 않았다.

### 0.3 측정하지 않은 것 — 아래 결론에 절대 포함되지 않음

- **npm 레지스트리 요청을 한 건도 실행하지 않았다.** 게시 버전·게시 여부·태그 존재를 주장하지 않는다.
  로컬 `package-lock.json`의 `resolved`/`integrity`는 **락파일 작성 시점의 기록**일 뿐이다.
  **로컬 package.json 버전이 서로 같거나 다르다는 사실은 호환성 판정도, 레지스트리 신탁도 아니다.**
- **설치/업그레이드/언인스톨을 실행하지 않았다.** 파일 모드·ACL·실제 노출을 측정하지 않았다.
  확인한 것은 **소스가 어떤 스키마로 무엇을 쓰는가**뿐이다.
- **GitHub Actions 실행 이력을 조회하지 않았다.** 워크플로 YAML이 *무엇을 호출하도록 정의되어
  있는가*만 읽었다. **"테스트가 실행된 적 없다"는 주장은 할 수 없고, 하지 않는다.**
- **실행 중 데몬/서비스에 접속하지 않았다.** 보안 스캔·인증 프로브·익스플로잇 없음(Snyk N/A).
- 상속받은 과거 수치는 하나도 헤드라인으로 승격하지 않았다.

---

## 1. 총평

### 1.1 지켜야 할 강점

**(a) telepty의 인증 계층은 사고 이력을 근거로 고쳐져 있다.** `daemon.js` 주석이 #815(토큰이
이름 기준·멱등 발급이라 재등록만으로 남의 토큰을 받던 결함 → 최초 등록 1회 발급 + destroy 시
폐기), #47 P4(provenance nonce 동일 결함 통합), #45(fan-out 상한), #43(감사 스파인)을 명시한다.
브라우저 origin 허용목록 기본값은 비어 있고(= 전면 거부, `daemon.js:255-258`),
`createAuthMiddleware`가 `app.use` 전역 등록(`:391`)이며 그 앞 라우트는 `/api/health` 하나로
`{status, version}`만 반환한다(`:386-388`). **이 읽기 범위에서 결함 근거를 찾지 못했다** —
없다고 증명한 것은 아니다.

**(b) telepty 테스트 열거에 드리프트가 없다.** `package.json` `test`가 열거한 124개 =
디스크 124개, 누락 0, 유령 0. "테스트 러너 실제 포함"에서 telepty는 결함이 아니다.

**(c) orchestrator/telepty release.yml은 참조할 만한 패턴이다.** orchestrator
`release.yml:3-15`가 사고 이력("런북이 태그가 퍼블리시했다고 주장했지만 3개 버전이 태그 없이
손으로 올라갔다")을 적고, 태그↔package.json 일치 게이트(`:48-59`), 시크릿 부재=실패,
레지스트리 되읽기, 동시 실행 큐잉(`:26-28`)을 둔다. **이 파일들이 실제로 그렇게 동작했는지는
실행 이력을 안 봤으므로 모른다.**

**(d) 설치기 실패 정책이 데이터로 선언되어 있다.** `installer-manifest.json`의
`failure_policy: hard|soft`, 어댑터 fallback 체인, 에러 분류별 재시도/halt 표.

**(e) 시크릿 인용·보호 습관이 존재한다.** env fan-out은 `printf %q` 인용 후
`chmod 600`(`install.sh:265,269` — **[HEAD 확인]**, HEAD에서도 같은 라인). 문제는 이 습관이
같은 값의 다른 기록 지점에는 적용되지 않았다는 것(F2).

### 1.2 가장 영향이 큰 계통적 약점

한 문장: **품질 규율이 저장소별로 각자 발명되고, 폭발 반경이 큰 곳(설치기)에 가장 낮은 기준이
선언되어 있으며, 설치 경로 자체가 커밋되지 않은 리팩터 한가운데 있다.**

- **경로 분기**: 메타 패키지 / 모듈별 README 명령 / devkit 프로파일 — 셋이 서로 다른 버전 제약을
  선언한다(F1, F5). 어느 것이 정본인지 소스가 말하지 않는다.
- **매니페스트 다중화**: `ecosystem.json`(표시용, 6사본), `installer-manifest.json`(프로파일/
  호환성), `config/modules/*.adapter.json`(작업트리에서만 채워진 설치 체인)이 공존하고 값이 어긋난다(F5, F6).
- **선언된 게이트의 얕음**: devkit CI/release가 호출하도록 정의한 것은 `--help` 한 줄이다(F4).

### 1.3 최소 개선안

**지금(외과적).**
1. `install-state.json` 스키마에서 `api_key` 값 필드 제거 (F2). — 단, 스키마 소비자 확인이 선행.
2. `@dmsdc-ai/aigentry` 의존성 range 재산정 (F1) — 단, 목표 버전은 레지스트리 확인 후 결정.
3. Windows 설치기의 `orchestrator-role` 침묵 제거 (F3) → **#663의 "명시적 미지원 문서화" 선택지**.
4. devkit `lib/install-fallback.js`와 어댑터 변경분의 커밋 여부 결정 (F5의 선행 조건).

**다음.**
5. devkit `npm test` 진입점이 기존 4스위트를 호출하도록 연결 (F4) — baseline 확보 후.
6. `ecosystem.json` 재생성 시 dependencies range·게시 상태 모순을 검증 (F6, F1 재발 방지).
7. 설치 실패 시 진행 상태 저널링 (F8) — 단순 `trap` 1줄이 아니라 멱등성 테스트 포함.

**보류.**
- `installer-manifest.json` ↔ adapter 통합 — 설치기 재작성급. F5는 커밋 상태 정리로 충분.
- ssot/registry 중첩 구조 평탄화 — 릴리스 프로버넌스가 먼저. 의존성/마이그레이션 증거 없음.
- 저장소 통폐합·프레임워크 교체 — 이번 감사에 근거 없음.

### 1.4 도입하지 말아야 할 것

- **전 저장소 CI 템플릿 살포.** 성숙도·공개 여부가 제각각이다. 필요한 건 *게시되는 것*의 증명.
- **telepty 테스트 목록을 glob으로 변경.** 드리프트 0 실측. 실행 순서/격리 전제만 깨진다.
- **메타 패키지 버전 자동 범프 봇.** 원인은 자동화 부재가 아니라 검증 부재다.
- **설치기 전면 재작성.** §1(경량)·Rule 29 위반. F3은 수 줄로 막힌다.
- **초판이 제안했던 "F2+F8 한 PR", "F4+F7 한 태스크" 묶음.** 파일이 같다는 이유로 시크릿 보호와
  설치 롤백을 묶으면 수용 기준이 섞인다. 테스트 진입점 누락과 6개 저장소 릴리스 자동화도
  소유자와 수용 기준이 다르다. **분리한다** (§3 표 참조).

---

## 2. 발견 사항 (8건)

---

### F1 — 메타 패키지 `@dmsdc-ai/aigentry`의 의존성 range가 같은 디스크의 소스 버전보다 낮다 (재발)

- **심각도 High / 확신도 High(로컬 매니페스트 대조에 한해) / 신규성 낮음 — 재발 증거**
- **증거** [HEAD 확인] `aigentry/package.json`:

  | 메타 range | semver 해석 | 같은 디스크 로컬 소스 |
  |---|---|---|
  | `aigentry-devkit ^0.0.22` | `>=0.0.22 <0.0.23` | 0.1.14 |
  | `aigentry-brain ^0.2.8` | `>=0.2.8 <0.3.0` | 0.3.1 |
  | `aigentry-telepty ^0.6.6` | `>=0.6.6 <0.7.0` | 0.8.3 |
  | `aigentry-deliberation ^0.0.47` | 정확히 0.0.47 | 0.0.47 |
  | `@dmsdc-ai/aterm ^0.2.14` | `>=0.2.14 <0.3.0` | **0.2.13** (`npm/aterm/package.json`) |

  `README.md:20`이 `npm i -g @dmsdc-ai/aigentry`를 1순위 명령으로 제시한다.
  `bin/aigentry.js:56`은 모듈 누락 시 같은 명령 재실행을 안내한다.
  aterm 쪽은 반대 방향 제약을 건다 — `peerDependencies: {@dmsdc-ai/aigentry: ">=0.1.0"}`,
  `dependencies: {devkit ">=0.0.19", telepty ">=0.1.88"}` (하한만, 상한 없음).
- **현재 영향(주장 범위 한정)**: 메타 range의 상한이 로컬 소스 버전보다 낮다는 **정적 사실**.
  실제로 어떤 버전이 설치되는지는 레지스트리 상태에 달렸고 **측정하지 않았다.** 따라서
  "메타 설치자는 telepty 0.6.x를 쓴다"는 초판 서술은 **철회**한다. 말할 수 있는 것은
  "선언된 상한이 로컬 소스보다 낮다"까지다. 또한 로컬 aterm 0.2.13은 메타가 요구하는
  `^0.2.14`를 **만족하지 못한다** — 로컬끼리도 자기모순이다.
- **근본 원인**: 표 재생성(`scripts/gen-readme.mjs`; git log `f959b29`/`c15c8df`/`afa9449`/
  `fb15731`/`7b97bd1` — 5회 연속 "표 갱신")과 `dependencies` 점검이 연결되어 있지 않다.
- **최소 수정**: range 재산정 + `gen-readme.mjs`에 "표 버전과 range가 모순이면 exit 1" 검증.
  **목표 버전은 레지스트리 확인 후 결정** — 이 보고서는 목표값을 지정하지 않는다.
- **수용/재현(수정 전)**: 순수 로컬 검증 — `aigentry/package.json`의 각 range와 대응 저장소
  로컬 `package.json` version을 semver로 대조해 불만족 항목이 ≥1임을 출력. 수정 후 0.
  (설치 실행·레지스트리 조회는 이 게이트에 포함하지 않는다.)
- **소유**: `aigentry` / release
- **롤아웃/롤백**: 메타 patch 릴리스 1회. 롤백 = range 복원.
- **태스크 매핑 — dedup 근거**:
  - **`ux-public-front-door` (done)** 이 이미 같은 결함을 기록했다: *"meta pkg stale pins
    (telepty ^0.1.83 vs 0.6.6)"*. 오늘 측정치는 `^0.6.6 vs 0.8.3` — **핀이 한 번 갱신됐다가 다시
    낡았다.** 즉 본 건은 신규 발견이 아니라 **날짜가 찍힌 재발**이다.
  - **#62 (done)** 은 메타 패키지 생성 자체(NOTE: `v0.1.0 aigentry meta`),
    **#64 (done)** 은 aterm→메타 의존 전환(NOTE: `v0.1.55 meta dep`) — 위 aterm 역방향 제약이
    이 스코프다.
  - **#1136 (delegated)** 은 스펙에 npm/install/README+ecosystem 생성 소스를 **명시적으로 포함**한다.
  - **권고: NEW를 만들지 말 것.** ①`ux-public-front-door`/#62/#64에 **2026-09-08 재발 증거**를
    날짜와 함께 부기, ②재발 방지(생성 스크립트 검증)는 **#1136의 확장**으로 처리.
    별도 태스크는 #1136과 수용 기준이 겹쳐 중복이 된다.

---

### F2 — 설치기가 레지스트리 API 키를 state 파일에 평문 필드로 기록하는 스키마 (양 OS)

- **심각도 High / 확신도: 스키마 High, 실제 노출 미측정**
- **증거**
  - bash [**HEAD 확인** — `git show HEAD:install.sh` 에서도 동일 라인]:
    `install.sh:245` `api_key: omitEmpty(env.REGISTRY_API_KEY || "")`,
    값 전달 `:205`, heredoc 시작 `:210`, 파일 기록 `:255`
    (`fs.writeFileSync(targetPath, JSON.stringify(state, null, 2))`).
  - ps1 [작업트리; HEAD 453줄본 미대조]: `install.ps1:161` `api_key = $RegistryApiKey`,
    `:172` `Set-Content -Path $DevkitStateFile`.
  - 대조군: env fan-out은 `printf %q` + `chmod 600`(`install.sh:265,269` [HEAD 확인]).
  - `install.sh` 전체 `chmod` 3곳(`:269` env, `:447` HUD, `:488` WTM) — state 파일 없음.
    `install.ps1` 전체 `Acl|icacls|SetAccessControl` 0건.
  - 경로: `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/install-state.json`(`:24-25`),
    완료 배너가 경로 출력(`:1005`).
- **현재 영향(주장 범위 한정)**: **소스가 선언하는 스키마상** 같은 시크릿이 두 파일에 기록되는데
  보호 코드는 한쪽에만 있다. **실제 파일 모드·ACL·노출 여부는 설치를 실행하지 않았으므로
  측정하지 않았다.** 초판의 "umask 022에서 0644로 생성된다"는 **추론이었고 철회**한다.
- **근본 원인**: state 파일이 관측용 메타데이터로 설계됐는데 값 전달용 필드가 섞였고, 보호는
  값 전달용 파일에만 붙었다.
- **최소 수정**: `install.sh:245` / `install.ps1:161`의 값 필드를 **존재 여부 불리언**으로 대체.
  단순 필드 삭제는 스키마 소비자를 깨뜨릴 수 있다 — `install.sh:982`가 같은 파일에 orchestrator
  status를 **병합**하므로 소비자가 최소 1곳 존재한다.
- **수용/재현(수정 전) — 실환경 금지**:
  - 격리 HOME + **더미 자격증명** + 의존 스텁(실제 전역 npm 설치·데몬 기동 없이 phase 7만
    도달하는 하니스)에서 state 파일을 생성.
  - 판정은 **JSON 파싱으로**: `state.registry.api_key` 필드가 존재하고 그 값이 주입한 더미
    문자열과 일치하는가. **`grep api_key`를 쓰지 말 것** — 대체 필드명 `api_key_present`가
    같은 부분문자열을 포함해 위양성이 난다.
  - 수정 후: 금지 필드 부재 + 더미 문자열이 파일 어디에도 없음 + 기존 소비자(`:982` 병합) 통과.
  - 파일 모드/ACL 측정은 **별도 항목**으로 분리(이번 감사 미측정).
- **롤백 주의**: **노출 필드를 되살리는 것을 롤백 경로로 쓰지 말 것.** 롤백은 소비자 호환을
  유지한 채 필드를 되돌리는 마이그레이션이어야 하며, 리댁션 로직에는 테스트가 필요하다.
- **소유**: `aigentry-devkit` / coder
- **태스크 매핑**: **NEW 후보(단독)**. **#884와 중복 아님** — #884는 *공용 npm 토큰의 90일 만료
  추적*(자격증명 수명)이고, 본 건은 *설치기가 다른 자격증명을 기록하는 스키마*다. 소유 저장소,
  자격증명 종류, 수용 기준이 모두 다르다. **F8과 묶지 않는다** — 같은 파일을 건드린다는 것은
  묶을 이유가 아니며 수용 기준(리댁션 vs 저널링 멱등성)이 다르다.

---

### F3 — Windows 설치기에 `orchestrator-role` 처리가 없고 프로파일은 선택 가능하다

- **심각도 High / 확신도 High(HEAD·작업트리 양쪽 확인)**
- **증거**
  - `grep -c orchestrator install.ps1` → **0**. **HEAD 453줄본에서도 0** (`git show` 확인).
  - `install.sh:791` `header "Phase 8. Orchestrator Role"` [작업트리] / HEAD `:729` 동일 헤더.
  - `install.ps1:483` `Write-Header "Phase 8. Cross-platform Notes"` — 같은 phase 번호가 다른
    의미로 쓰이고, `Should-RunPhase 8` 가드 없이 무조건 출력.
  - `installer-manifest.json` [HEAD 확인]의 `orchestrator` / `ecosystem-full` 프로파일은
    components에 `orchestrator-role`을 포함. ps1의 `Test-ComponentSelected`가 이 이름을
    조회하는 지점이 없다.
  - `install.ps1:489-501` 완료 배너에 orchestrator 항목 없음.
- **현재 영향(주장 범위 한정)**: **소스 동작상** Windows에서 해당 프로파일을 선택해도 ps1에
  대응 처리가 없고 경고 경로도 없다. 실제 Windows 실행은 하지 않았다.
- **근본 원인**: 두 설치기가 phase 번호만 공유하고 phase 내용 일치를 검증하는 장치가 없다.
- **최소 수정**: **#663이 제시한 두 선택지 중 "명시적 미지원 문서화"**가 최소 경로 —
  `Test-ComponentSelected "orchestrator-role"` 시 경고 + state에 `status: unsupported` 기록.
  포팅은 별도 결정 사항.
- **수용/재현(수정 전)**: pwsh에서 `$env:AIGENTRY_INSTALL_PROFILE="orchestrator"` 로 실행 시
  경고 없음 + state에 orchestrator 키 없음. 수정 후 경고 1줄 + `unsupported` 기록.
- **소유**: `aigentry-devkit` / coder
- **태스크 매핑**: **#663을 UPDATE — NEW 금지.** #663(pending, P1, 2026-07-05)의 본문이
  *"install.ps1 parity — Windows orchestrator 프로파일 포팅 or 명시적 미지원 문서화"*로
  **정확히 이 건**이며, NOTE에 *"orchestrator install.sh 27회 vs ps1 0회"*까지 기록되어 있다.
  본 감사의 기여는 **2026-09-08 재확인 + HEAD/작업트리 양쪽에서 0건 + 완료 배너가 누락을 숨긴다는
  추가 증거**다. 초판이 이를 NEW로 제안한 것은 오류이며 철회한다.

---

### F4 — devkit의 CI/release 워크플로가 호출하도록 **정의한** 것은 `--help` 한 줄이다

- **심각도 High / 확신도: 워크플로 정의 High, 실행 이력 미확인**
- **증거** [모두 HEAD 확인 — 워크플로·package.json은 clean]
  - `ci.yml:30-31` — 3 OS × Node 3버전 = 9잡, 스텝은 `node bin/aigentry-devkit.js --help` 하나.
  - `release.yml:21` — publish 앞 validate 잡도 동일. 태그↔package.json 일치 게이트 없음,
    레지스트리 되읽기 없음. `release.yml:35-37` README 재생성은 `continue-on-error: true`.
  - `package.json` `test` = `node bin/aigentry-devkit.js --help`. 실제 스위트는 별도 스크립트명:
    `test:scaffold-project`, `test:scaffold-install-hooks`, `test:logger-emit`, `test:skills-drift`.
    **두 워크플로 어디에도 이 네 스크립트를 호출하는 스텝이 없다.**
  - 스위트 실체: `tests/scaffold-project/v1/` 9 spec, `tests/scaffold-install-hooks/v1/` 5,
    `tests/logger-emit/v1/` 1, `tests/skills-drift/v1/` 1 = 16파일.
    `test(`/`it(` **grep 매칭 43건** — 이는 **정적 문자열 매칭 수이지 실행된 케이스 수가 아니다**
    (초판의 "43 cases" 표현 철회). 실제 케이스 수는 실행해야 알 수 있고, 실행하지 않았다.
  - `tests/install-fallback.test.js`와 `tests/exec-mode/`는 **미추적(`??`)**이다.
- **현재 영향(주장 범위 한정)**: **워크플로 정의상** 해당 스위트를 실행하는 경로가 없다.
  **"한 번도 실행된 적 없다"는 주장은 하지 않는다** — Actions 실행 이력을 조회하지 않았고,
  로컬/수동 실행 여부도 모른다. 다만 uninstall / dry-run-no-writes / malformed-settings /
  sentinel-drift / skills-drift 같은 **비파괴·데이터 보존 검증**이 자동 게이트에 걸려 있지 않다.
- **근본 원인**: `test`가 스모크로 자리를 잡은 뒤 추가된 스위트가 진입점을 갱신하지 않았다.
- **최소 수정**: `test`를 4스위트 체인으로 교체하고 ci.yml/release.yml 스텝을 `npm test`로 변경.
- **수용/재현(수정 전)**: `grep -n "test:" .github/workflows/*.yml` 이 0건임을 보인다.
  **선행 조건**: 4스위트의 현재 통과/실패 baseline을 먼저 로컬에서 확보해야 한다 — 붉으면
  CI가 즉시 막힌다. baseline이 붉으면 그 자체가 별도 태스크다.
- **소유**: `aigentry-devkit` / coder + tester
- **태스크 매핑**: **NEW 후보(단독)**. **F7과 묶지 않는다** — 본 건은 *한 저장소의 테스트 진입점*
  (소유: devkit, 수용: `npm test`가 스위트를 호출)이고 F7은 *여러 저장소의 릴리스 프로버넌스*
  (소유: 각 저장소, 수용: 태그 게이트 존재)다. 초판의 묶음 제안은 철회한다.
  #1136과는 스코프가 다르다(#1136은 오케스트레이터 워크플로 생산화 + npm/install/README 생성).

---

### F5 — 커밋되지 않은 설치 경로 리팩터로 로그 문자열과 실행 인자가 어긋난다 (작업트리 한정)

- **심각도 Medium / 확신도: 파일 상태 High, 런타임 결과 미측정**
- **초판에서 철회하는 두 주장**:
  1. ~~"어댑터가 `latest`를 쓰므로 설치 결과 자체는 정상"~~ — **철회.** `latest` 해석 실패,
     미지 버전, CLI 출력 형식 차이, OS별 `sort` 동작 등 실패 경로가 있고 어느 것도 측정하지 않았다.
  2. ~~"호환성 게이트는 구조적으로 항상 통과한다"~~ — **철회.** 근거로 삼은 것은 *로컬 소스
     버전 간 비교*였고, 그것은 호환성·레지스트리 신탁이 아니다. 설치된 버전을 관측한 적이 없다.
- **성립하는 유일한 주장**: **작업 트리 상태에서 로그가 출력하는 spec과 실행 경로가 전달할
  인자가 다르다.**
- **증거**
  - **HEAD `bb7876b`** [git show]: `install.sh:462-465` —
    `TELEPTY_SPEC="${TELEPTY_PACKAGE}@${TELEPTY_VERSION}"` → `info "Installing $TELEPTY_SPEC"` →
    **`npm install -g "$TELEPTY_SPEC"`**. 즉 **HEAD에서는 로그와 실행 인자가 일치**하며,
    값은 `installer-manifest.json`의 `0.1.45`다.
  - **작업 트리**: `install.sh:506-510` 이 `TELEPTY_SPEC`을 계산·출력한 뒤
    `run_install_fallback "telepty"`를 호출한다. 그 구현
    `lib/install-fallback.js`는 **HEAD에 없는 미추적 파일**이고,
    `readAdapterFallback()`(`:67-81`)이 읽는 `config/modules/telepty.adapter.json`은
    **HEAD에서 fallback 체인이 `[]`(빈 배열)**, 작업 트리에서만
    `[{kind:"npm-global", package:"@dmsdc-ai/aigentry-telepty", version:"latest"}]`이다.
    최종 실행문은 `lib/install-fallback.js:342` `npm install -g ${pkg}@${version}`.
  - 즉 **작업 트리에서 `TELEPTY_SPEC`은 로그 외에 쓰이지 않는다.** `DUSTCRAW_SPEC`도 같은 구조
    (`install.sh:647,655`).
  - 어댑터 7개 전부 (M), `lib/install-fallback.js`·`tests/install-fallback.test.js` 미추적.
- **현재 영향**: 사고 조사 시 설치 로그가 실행된 인자를 대변하지 못한다(작업 트리 기준).
  더 중요한 사실은 **설치 경로의 핵심 구현이 버전 관리 밖에 있다**는 것이다 — `package.json`의
  `files`가 `lib/**`를 게시 대상에 포함하므로 로컬 트리에서 게시하면 git에 없는 코드가 나간다.
- **근본 원인**: 설치 소스를 manifest→adapter로 옮기는 리팩터가 진행 중이며 커밋되지 않았다.
- **최소 수정**: **코드 수정 이전에 커밋 상태 결정이 먼저다.** 리팩터를 커밋하든 되돌리든 한 뒤,
  spec 계산·출력을 실제 실행 경로와 일치시킨다.
- **수용/재현(수정 전)**: `git status --porcelain lib/ config/modules/` 가 미추적/수정을 보이고,
  `git show HEAD:config/modules/telepty.adapter.json` 의 체인이 작업 트리와 다름을 보인다.
  런타임 대조는 격리 하니스가 필요하므로 이 게이트에 넣지 않는다.
- **소유**: `aigentry-devkit` / coder
- **태스크 매핑**: **NEW 후보(단독)**, 성격은 "미커밋 설치 경로 정리". F1/F6과 원인이 다르다
  (저것은 문서 생성, 이것은 버전 관리 상태).

---

### F6 — 표시용 `ecosystem.json`이 6개 저장소에 바이트 동일 복제된 채 로컬 소스와 어긋난다

- **심각도 Medium / 확신도: 로컬 대조 High, 게시 상태 미측정**
- **증거** [HEAD 확인 — 6사본 모두 clean]: sha256 `722f3d5d9844…`, 55줄, mtime 2026-07-26.
  위치 `aigentry`, `-telepty`, `-devkit`, `-brain`, `-deliberation`, `-orchestrator`.
  매니페스트 주석이 스스로 "바이트 동일 vendored, 변경 시
  `aigentry-devkit/scripts/sync-readme-tooling.mjs`로 갱신"이라 선언한다.

  | ecosystem.json | 로컬 소스 |
  |---|---|
  | telepty `0.7.1` | `aigentry-telepty/package.json` 0.8.3 |
  | orchestrator package `aigentry-orchestrator`, version `—`, `published: false` | name `@dmsdc-ai/aigentry-orchestrator`, version 0.2.0, 태그 푸시 시 publish하는 release.yml 보유 |
  | aterm `@dmsdc-ai/aterm` 0.2.14 UNLICENSED (주석: 게시본은 UNLICENSED, 로컬 HEAD는 MIT 0.2.13 의도) | `npm/aterm/package.json` 0.2.13 **MIT** — **매니페스트 주석이 이 차이를 이미 정확히 기록하고 있다** |
  | brain 0.3.1 / deliberation 0.0.47 / devkit 0.1.14 | 일치 |

  인접 결함: `installer-manifest.json`의 bridge 항목은 `package: "@aigentry/bridge"`인데
  `aigentry-bridge/package.json` 실제 이름은 `@dmsdc-ai/aigentry-bridge` — 스코프 불일치.
  작업 트리 어댑터가 `{kind:"skip"}`이라 현재 도달하지 않는 경로다(HEAD 어댑터는 빈 체인).
- **현재 영향(주장 범위 한정)**: 공개 README 표가 로컬 소스와 다른 값을 표시한다.
  **게시된 실제 버전·라이선스는 조회하지 않았다.** 위 대조는 전부 로컬 대 로컬이다.
  aterm 행은 매니페스트가 이미 불일치를 주석으로 인정하고 있으므로 "발견"이 아니라 "미해소 기록"이다.
- **근본 원인**: 표 갱신이 수동 트리거이고 릴리스 파이프라인과 연결되어 있지 않다.
- **최소 수정**: 재생성 스크립트에 range·게시 상태 모순 검증 추가(F1 재발 방지와 같은 자리).
- **수용/재현(수정 전)**: 6사본의 telepty version과 `aigentry-telepty/package.json` version이
  다름을 출력 → 수정 후 동일.
- **소유**: `aigentry-devkit`(생성 스크립트) + 각 릴리스 저장소 / release
- **태스크 매핑**: **#1136의 확장으로 처리 권고 — NEW 금지.** #1136 스펙이 npm/install/README
  +ecosystem 생성 소스를 명시적으로 포함하므로, 별도 태스크는 수용 기준이 겹친다.
  F1과 같은 스크립트를 건드리므로 **F1의 재발 방지 항목과 한 단위**로 다룬다.

---

### F7 — 게시 경로에 있는 저장소 다수에 릴리스 워크플로 **파일이 없다**

- **심각도 Medium-High / 확신도: 파일 유무 High, 게시·프로버넌스 실태 미측정**
- **증거** [워크플로 디렉터리 실측]

  | 저장소 | 워크플로 파일 | 태그↔버전 게이트 | 레지스트리 되읽기 | NPM_TOKEN 참조 |
  |---|---|---|---|---|
  | aigentry-telepty | readme-regen, release, test-install | ✅ | ✅ | ✅ |
  | aigentry-orchestrator | ci, readme-regen, release | ✅ | ✅ | ✅ |
  | aigentry-devkit | ci, release | ❌ | ❌ | ✅ |
  | aigentry-brain | ci, release | ❌ | ❌ | ✅ |
  | aigentry-deliberation | ci, release | ❌ | ❌ | ✅ |
  | aigentry | readme-regen 만 | ❌ | ❌ | ❌ |
  | -logger / -ssot / -hooks / -context / -bridge / -dustcraw / -amplify | **파일 없음** | — | — | — |

  `aigentry-orchestrator/package.json`은 `@dmsdc-ai/aigentry-logger ^0.2.0`,
  `@dmsdc-ai/aigentry-ssot ^1.0.0`을 런타임 의존으로 선언하고, 그 `package-lock.json`은 두
  패키지를 registry tarball URL로 resolve한 기록을 갖는다(락파일 작성 시점 기록).
  `aigentry-ssot`는 패키지 본체가 `pkg/`에 있어 루트에 package.json이 없다.
- **주장 범위 한정 — 초판에서 좁히는 것**:
  - **"워크플로가 없다 = 릴리스/프로버넌스 증거가 전혀 없다"가 아니다.** 태그, 서명, CHANGELOG,
    수동 런북, npm provenance 등 다른 증거원을 조회하지 않았다. 확인한 것은 **`.github/workflows`
    디렉터리에 파일이 있느냐**뿐이다.
  - **"게시되었다"고 단정하지 않는다.** logger/ssot는 락파일 기록이 있고, dustcraw/amplify는
    어댑터가 이름을 가리킬 뿐이다.
  - **NPM_TOKEN 5개는 *워크플로 파일에서 관찰된 참조 수*이며, 계정 토큰의 실제 폭발 반경 증명이
    아니다.** 토큰이 하나인지 여럿인지, 스코프가 무엇인지 확인하지 않았다(초판 표현 철회).
- **현재 영향**: 게시 산출물을 커밋에 귀속시키는 **자동화된** 증거가 위 표의 ❌ 칸에 없다.
- **근본 원인**: 릴리스 규율이 telepty→orchestrator로 한 번 복사됐을 뿐 전파 메커니즘이 없다.
- **최소 수정**: 전 저장소 살포가 아니라 **npm 게시 경로에 있는 것으로 한정** — 우선 guard 잡
  (태그↔package.json 일치 + 시크릿 부재=실패)만 이식. 되읽기 증명은 2단계.
- **수용/재현(수정 전)**: 저장소별 `ls .github/workflows`와 `grep -l TAG_VERSION` 결과가 위 표와
  일치함을 보인다. 수정 후 대상 저장소에 guard 잡 존재.
- **소유**: 각 저장소 / release. 패턴 원본은 `aigentry-orchestrator`.
- **태스크 매핑**: **NEW 후보(단독)**. **#884와 중복 아님, 확장도 아님** — #884는 토큰 만료 추적,
  본 건은 워크플로 게이트 부재. 다만 #884에 **"NPM_TOKEN을 참조하는 워크플로 파일이 5개
  저장소에 있다"(2026-09-08 관찰)**를 사실로만 부기할 것을 권고한다(폭발 반경 결론은 금지).
  **F4와 묶지 않는다**(§F4 참조).

---

### F8 — 설치기에 되돌림 경로가 없고, 실패 시점의 진행 상태가 기록되지 않는다

- **심각도 Medium / 확신도: 소스 구조 High, 실패 실태 미측정**
- **증거**
  - `install.sh` `trap` 등록 **0건**(작업트리 1013줄, HEAD 951줄 양쪽). `backup`/`restore`/
    `rollback` 식별자 0건. 대조적으로 `install.ps1`은 `trap|finally` 5건 — **정리 규율이 OS 간
    비대칭**이다.
  - `install.sh:2` `set -euo pipefail`.
  - `die` 5곳(`:329, :511, :514, :545, :557` [작업트리]). `:511/:514/:545`는 phase 1이 이미
    `$HOME/.claude` 하위와 `$HOME/.local/lib/wtm`에 쓴 뒤, 그리고 전역 설치 시도 뒤에 발화한다.
  - 복구 수단은 전진 재개뿐 — `AIGENTRY_INSTALL_RESUME`(`:22, :318-329, :344`)은 시작 phase를
    앞당길 뿐 되돌리지 않는다. `install.sh` 안에 uninstall 경로 없음.
  - state 기록은 phase 7(`:779-782`)에서 처음 일어난다 → **소스 흐름상 phase 2~6 실패 시
    state 파일이 생성되지 않는다.**
  - 대조 규율: `telepty/scripts/preuninstall.js:4-15`는 무엇을 정리하고 무엇을 남기는지,
    왜 절대 실패하면 안 되는지를 명시하고 상태 디렉터리는 명시적 `telepty uninstall`에 위임한다.
- **현재 영향(주장 범위 한정)**: **소스 흐름상** 중도 실패가 되돌려지지 않고 진행 지점이 남지
  않는다. 실제 실패를 재현하지 않았으므로 "이 조건에서 반드시 이렇게 깨진다"고 말하지 않는다.
- **근본 원인**: 전진 재개는 데이터로 설계됐지만 역방향 상태 전이가 설계 대상이 아니었다.
- **최소 수정 — 초판의 "trap 1줄" 제안은 철회**: `trap ... EXIT` 한 줄은 **안전이 입증되지 않았다.**
  `set -e` 하에서 EXIT 트랩이 부분 초기화 변수로 state를 쓰면 기존 state를 손상시킬 수 있고,
  `:982`의 병합 소비자와 충돌할 수 있다. 필요한 것은 **멱등적 실패 저널링**이며 최소 셋은:
  ① 부분 상태 기록이 기존 파일을 파괴하지 않음(멱등성 테스트), ② 스키마 소비자(`:982`) 호환,
  ③ F2의 리댁션 규칙과 충돌 없음. 즉 **테스트가 딸린 변경**이지 한 줄 패치가 아니다.
- **수용/재현(수정 전) — 실환경 금지**: 격리 HOME + 스텁 의존으로 phase 2를 강제 실패시킨 뒤
  state 파일 부재를 보인다. 수정 후 파일 존재 + 완료 phase 기록 + **재실행 시 손상 없음**.
- **소유**: `aigentry-devkit` / coder
- **태스크 매핑**: **NEW 후보(단독)**. **F2와 묶지 않는다** — 같은 파일을 건드린다는 것은 묶을
  이유가 아니고, 수용 기준(리댁션 vs 저널링 멱등성)과 위험 프로파일이 다르다. 초판의 묶음 철회.
  #534(session-cleanup 고아 프로세스), #895(aterm 데몬 재시작)와 무관.

---

## 3. 태스크 매핑 — 신규 후보 5건, 확장·부기 4건

**확장/부기로 처리(신규 만들지 않음).**

| 발견 | 처리 | 근거 |
|---|---|---|
| F1 | `ux-public-front-door`(done)·#62(done)·#64(done)에 **2026-09-08 재발 증거 부기** + 재발 방지는 **#1136 확장** | front-door가 동일 결함(`telepty ^0.1.83 vs 0.6.6`)을 이미 기록. 오늘은 `^0.6.6 vs 0.8.3` — 갱신 후 재악화. #1136이 npm/install/README+ecosystem 생성 소스를 명시 포함 |
| F3 | **#663 UPDATE** | #663 본문이 "install.ps1 parity — Windows orchestrator 포팅 or 명시적 미지원 문서화"로 정확히 동일. NOTE에 "install.sh 27회 vs ps1 0회" 기록됨. 기여는 2026-09-08 재확인 + HEAD/작업트리 양쪽 0건 + 완료 배너가 누락을 숨김 |
| F6 | **#1136 확장**(F1 재발 방지와 한 단위) | 같은 생성 스크립트, 같은 수용 기준 |
| — | #884에 사실 1줄 부기 | "NPM_TOKEN 참조 워크플로 파일 5개"(관찰). 폭발 반경 결론은 붙이지 않음 |

**신규 후보 5건 — 각각 소유자·수용 기준이 달라 분리한다.**

| 발견 | 제목 | 소유 | 수용 기준 축 | 왜 기존 것의 확장이 아닌가 |
|---|---|---|---|---|
| F2 | 설치기 state 파일 시크릿 필드 리댁션 | aigentry-devkit / coder | JSON 금지 필드 부재 + 소비자 호환 + 리댁션 테스트 | #884는 토큰 *수명*, 본 건은 설치기가 기록하는 *다른 자격증명의 스키마* |
| F4 | devkit 테스트 진입점이 기존 4스위트를 호출 | aigentry-devkit / coder+tester | `npm test`가 스위트를 호출 + baseline 확보 | #1136은 오케스트레이터 워크플로 생산화. 저장소·산출물이 다름 |
| F5 | 미커밋 설치 경로 리팩터 정리(로그·실행 인자 일치) | aigentry-devkit / coder | 커밋 상태 결정 + spec↔실행 인자 일치 | F1/F6은 문서 생성, 본 건은 버전 관리 상태 |
| F7 | npm 게시 경로 저장소에 릴리스 guard 잡 이식 | 각 저장소 / release (조정: orchestrator) | 대상 저장소에 태그↔버전 게이트 존재 | F4는 한 저장소의 테스트 진입점. 소유자 수·수용 기준이 다름 |
| F8 | 설치 실패 시 멱등적 진행 저널링 | aigentry-devkit / coder | 부분 기록이 기존 state 비파괴 + 재실행 안전 | F2와 파일만 같고 수용 기준·위험이 다름 |

> F5는 "미커밋 상태 정리"라 태스크 등록 여부 자체가
> 오케스트레이터 판단 사항이다. **태스크 ID는 만들지 않았다.**

**건드리지 않은 기존 스코프.** #1128(inbound HOLD 유실, delegated) — 전달 경로 재진단 없음.
#1133(model-router) — 무관. #1137/#1138(포트폴리오 triage, done) — 행 단위 재triage 없음
(`state/task-queue.json` 최상위 `updated_at=2026-07-30` vs 행 `2026-09-08` 관찰만 #1139에 이관).
#526 — 본 보고서가 그 트리거의 현재 소스 리프레시이며 새 EPIC을 만들지 않았다.
#534/#895 — 현재 유효성 재검증 안 함, "현재도 발생 중"이라 주장하지 않는다.
`sec-wire-enforce-spawn` / `struct-injection-and-drift` — 읽기 범위에서 현재 증거를 찾지 못했으나
**없다고 단정하지 않는다**(spawn 검증 본문·injection 인용 경로 전체를 읽지 않음). 미측정.

---

## 부록 A. 저장소 인벤토리와 처분 (정정판)

측정: 2026-09-08T13:36Z 직접 열거, 54개 디렉터리.

### A.1 aigentry 계열 23개

| 저장소 | git | HEAD | dirty | 매니페스트 | 처분 |
|---|---|---|---|---|---|
| aigentry | ✅ | f959b29 | 4 | `@dmsdc-ai/aigentry` 0.1.1 | **심층** (F1, F6) |
| aigentry-devkit | ✅ | bb7876b | 51 | `@dmsdc-ai/aigentry-devkit` 0.1.14 | **심층** (F2~F5, F7, F8) — HEAD/작업트리 blob 대조 수행 |
| aigentry-telepty | ✅ | 997ea7c | 13 | 0.8.3 | **심층** (강점 근거, F6, F7) |
| aigentry-orchestrator | ✅ | ca93cb6 | 10 | 0.2.0 | **심층** (릴리스 대조군, F6, F7) |
| aigentry-brain | ✅ | 0ffa6ee | 6 | 0.3.1 (+ `packages/signaling-server`) | 매니페스트+워크플로 |
| aigentry-deliberation | ✅ | b009549 | 3 | 0.0.47 | 매니페스트+워크플로 |
| aigentry-aterm | ✅ | 9b4cec5 | 8 | **`npm/aterm` = `@dmsdc-ai/aterm` 0.2.13 MIT** (+ `npm/aterm-darwin-arm64`, Cargo 워크스페이스 4) | 매니페스트 — **초판 "package.json 없음" 정정** |
| aigentry-logger | ✅ | f4f62e3 | 1 | 0.2.0 | 매니페스트만 — 워크플로 파일 0 (F7) |
| aigentry-ssot | ✅ | 42afae4 | 3 | 루트 없음 / `pkg/` = 1.0.0 | 매니페스트만, 중첩 (F7) |
| aigentry-bridge | ✅ | 5eabef0 | 11 | `@dmsdc-ai/aigentry-bridge` 0.1.0 | 매니페스트만 — 어댑터 이름 불일치 (F6) |
| aigentry-dustcraw | ✅ | c0af3c9 | 14 | 0.4.0 | 매니페스트만 (F7) |
| aigentry-amplify | ✅ | b555848 | 7 | 0.0.1 (+ `packages/core`, `packages/channels`) | 매니페스트만 (F7) |
| aigentry-hooks | ✅ | 507393e | 7 | 0.0.2 | 매니페스트만 — 워크플로 파일 0 |
| aigentry-context | ✅ | eb23360 | 3 | 0.0.1 | 매니페스트만 — 워크플로 파일 0 |
| aigentry-analyst | ✅ | 8a45a84 | 3 | `aigentry-analyst` 1.0.0 (스코프 없음) | 매니페스트만 — 최종 커밋 2026-04-09 |
| aigentry-registry | ✅ | ac221cd | 3 | `pyproject.toml` + `bridge`, `frontend` | 매니페스트만 — 중첩 2 (+`.next/` 산출물 3 제외) |
| aigentry-starter | ✅ | c310f28 | 4 | 없음 | 미열람 — 매니페스트 없음 |
| aigentry-forum | ✅ | f1fc896 | 1 | 없음 | 미열람 — 최종 커밋 2026-03-01 |
| aigentry-architect | ❌ NOGIT | — | — | 없음 | **미열람 / 버전 프로버넌스 없음** (읽을 수 있는 파일 26개 존재) |
| aigentry-design | ❌ NOGIT | — | — | 없음 | **미열람 / 프로버넌스 없음** (14개) |
| aigentry-tester | ❌ NOGIT | — | — | 없음 | **미열람 / 프로버넌스 없음** (59개) |
| aigentry-sandbox | ❌ NOGIT | — | — | 없음 | **미열람 / 프로버넌스 없음** (75개) |
| aigentry-builder | ❌ NOGIT | — | — | 없음 | **미열람 / 프로버넌스 없음** (4개) |

> NOGIT 5개는 **읽을 수 있는 파일을 갖고 있다.** 초판의 "소스 이용 불가" 처분은 오류이며
> 정정한다. 폐기 대상인지 미초기화인지는 판단하지 않았다(증거 없음).

### A.2 인접 의존 — "설치/릴리스 경로 밖"이 아님

- **WTM** (`aigentry-devkit/tools/wtm`) — 설치기가 `$HOME/.local/lib/wtm`로 복사하고 PATH에
  심링크(`install.sh:405-491` [작업트리] / HEAD `:360-446`). **설치 경로 안**, 심층 감사만 안 함.
- **cmux** — `install.sh`에 등장하지 않으나 세션 spawn 표면의 살아있는 의존(#544는 submit 경로만
  변경). **인접 의존**, 심층 감사 범위 밖.
- **superpowers / claude-workspace-skills** — 스킬 공급 인접. 심층 감사 밖.

### A.3 범위 제외 (사유 명시)

- 터미널 업스트림 8: alacritty, contour, ghostty, kitty, rio, wezterm, winit, zellij — 서드파티.
- claude-code 참조 4: fork, murraytom, sourcemap, system-prompts — 읽기용.
- 제품/실험 14: aases, animal-hospital, benchmarks, cambrian-spore, claurst, common-ai,
  constitution, n8n-video, nexaforge, ppt-maker, shipfast, syc-ai, voicecode, youtube-scraper.
- 기타: testbed, wtm(위 A.2에서 별도 처분).

### A.4 엣지 케이스

- **중첩 매니페스트 9개**(§0.2) + `.next/` 빌드 산출물 3개(제외). 루트만 보는 도구는 전부 놓친다.
- **`ecosystem.json`은 6/23만 담는다** — 표시용, 열거 근거 아님.
- **워크트리 77개**(`~/.aigentry/worktrees/`) — 작업 공간, 저장소로 세지 않음.
- **`~/.aigentry/repo/`** — 메모리 프로파일 3파일. 저장소 아님.
- **dirty**: 감사 대상 git 저장소 18개 전부 dirty. 어떤 파일도 되돌리거나 수정하지 않았다.
- **패키지 그래프 완전성 주장 없음**(§0.2).

---

## 부록 B. 재현 명령 (전부 읽기 전용)

```bash
# 0.1 커밋 vs 작업트리 (모든 devkit 인용의 전제)
cd ~/projects/aigentry-devkit
git status --porcelain | grep -E 'install\.(sh|ps1)|config/modules|lib/'
git cat-file -e HEAD:lib/install-fallback.js || echo "NOT IN HEAD"
git show HEAD:install.sh | grep -n 'api_key: omitEmpty\|npm install -g\|chmod '
git show HEAD:config/modules/telepty.adapter.json
# F1
python3 -c "import json;print(json.load(open('$HOME/projects/aigentry/package.json'))['dependencies'])"
python3 -c "import json;print(json.load(open('$HOME/projects/aigentry-aterm/npm/aterm/package.json')))"
# F2  (grep api_key 금지 — api_key_present 위양성)
python3 -c "import json,sys;s=json.load(open(sys.argv[1]));print('api_key' in s.get('registry',{}))" <state.json>
# F3
grep -c orchestrator install.ps1;  git show HEAD:install.ps1 | grep -c orchestrator
# F4
grep -n 'test:' .github/workflows/*.yml   # -> 0건
# F6
for f in ~/projects/aigentry*/ecosystem.json; do shasum -a 256 "$f"; done
# F7
for r in ~/projects/aigentry ~/projects/aigentry-*; do echo "$r: $(ls "$r/.github/workflows" 2>/dev/null | tr '\n' ' ')"; done
# F8
grep -c '^[[:space:]]*trap ' install.sh   # -> 0
# 0.2 중첩 매니페스트 (초판의 -maxdepth 2 오류 정정)
find ~/projects/aigentry ~/projects/aigentry-* -maxdepth 4 -name package.json -not -path '*/node_modules/*'
```
