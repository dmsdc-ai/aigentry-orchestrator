# SMOKE-REPORT — tq#597: 클린 환경 설치/딜리버 검증

- **일시**: 2026-06-10 (KST 23:02~23:10)
- **검증 대상**: npm 발행본 `@dmsdc-ai/aigentry-telepty@0.6.2`, `@dmsdc-ai/aigentry-brain@0.2.7` (로컬 repo 아님)
- **환경**: Docker (colima) / `node:20` 컨테이너 = Debian 12 bookworm, node v20.20.2, npm 10.8.2, aarch64
- **모드**: VERIFY — 제품 코드 fix 없음, 발견은 본 리포트로 보고
- **호스트 비접촉**: 호스트 telepty(3848)/`~/.telepty`/`~/.aigentry` 미접촉. 검증 전부 컨테이너 내부.
  (발행 tarball 검사는 `/private/tmp/smoke-597`에 `npm pack`으로 read-only 수행)

## 시나리오별 결과

| # | 시나리오 | 판정 | 명령 수 | 소요 | 비고 |
|---|---|---|---|---|---|
| T1 | telepty 설치 (`npm i -g`) | **PASS** | **1** | 4.6s | exit 0. node-pty **프리빌트 사용**(linux-arm64/x64, darwin, win32 모두 동봉) — 빌드 도구 불필요. 경고: `npm warn deprecated uuid@9.0.1` 1건(코스메틱) |
| T2 | 데몬 기동 (`telepty daemon`) | **PASS** | 1 | ~2s | `/api/health` → `{"status":"ok","version":"0.6.2"}`. `/api/meta` 정상. 첫 실행 출력 깔끔(배너 2줄). ⚠️ **`0.0.0.0` 바인딩**(아래 리스크 #3) |
| T3 | 기본 동작 (spawn→list→inject→read-screen) | **PASS** | 4 | <10s | `spawn --id smoke-bash bash` → list에 CONNECTED 표시 → `inject "echo SMOKE_INJECT_OK_597"` → read-screen에서 실행 결과 확인. 전부 1회 성공 |
| T4 | brain 설치 (`npm i -g`) | **PASS** | 1 | 6.9s | exit 0. `aigentry-brain health`/`stats` 정상 동작(빈 프로파일). 경고: `deprecated boolean@3.2.0` 1건. 마이너: `--version`이 버전 대신 usage 출력 |
| T5 | backup/restore | **PARTIAL** | 3 (tar/rm/tar) | <5s | 직관(tar)으로는 성공·**문서로는 불가**. 상세 아래 |
| T6 | uninstall (`npm rm -g` ×2) | **PARTIAL** | 1 | 0.2s | 바이너리 깨끗이 제거. **잔여물**: ① 상태 디렉토리 3개(`~/.telepty`, `~/.aigentry`, `~/.config/aigentry-telepty`) ② **실행 중 데몬이 살아남아 3848 응답 지속** ③ (macOS+install.sh 경로 한정) launchd plist `com.aigentry.telepty.plist` unload 안 됨 |
| T7 | 멀티-CLI (claude/codex 래핑) | **N/T (불가)** | — | — | 컨테이너에 claude/codex CLI 없음. **고객 머신 전제조건으로 명기 필요** — 본 스모크 범위에서 검증 불가 항목으로만 기록 |

### T5 상세 (offer 'recovery workflow' 항목)
- 백업: `tar -czf backup.tgz -C ~ .telepty .aigentry .config/aigentry-telepty` → 삭제 → 복원 → 데몬 재기동: **성공**. authToken/`sessions.json`/brain mailbox 바이트 동일 복원, 데몬 health ok.
- 한계 1: **라이브 세션은 복원 안 됨** — `sessions.json`에 레코드는 있으나 재기동 후 `telepty list` = "No active sessions found" (PTY 프로세스는 당연히 소멸; 단, 레코드 기반 재spawn 같은 복구 UX 없음).
- 한계 2: **백업/복원 절차 문서 부재** — telepty/brain README 양쪽 모두 backup/restore/recovery 절차 0건(grep 일치 항목은 전부 무관한 문구). 고객이 백업할 디렉토리 3개를 스스로 알아내야 함.

## 고객 전제조건 (확정 목록)
1. **Node.js 20.x** (npm 동봉) — 검증 기준 v20.20.2. node-pty 프리빌트가 OS/아키 매칭되면 빌드 도구 불필요 (linux-arm64/x64, darwin-arm64/x64, win32 프리빌트 동봉 확인).
2. **OS**: Linux(Debian 계열 검증됨) / macOS (launchd 자동기동은 install.sh 경로). Windows는 프리빌트 존재하나 본 스모크 미검증.
3. **npm 글로벌 설치 권한** (root 또는 user-prefix 설정).
4. **래핑 대상 CLI는 별도 설치 필수**: claude/codex/gemini 등은 telepty가 설치해주지 않음 — 딜리버 체크리스트에 "고객 머신에 대상 CLI 사전 설치" 명기 필요 (T7).
5. 포트 3848 가용 (또는 PORT 환경변수 별도 지정).

## 환불-리스크 항목

| # | 리스크 | 심각도 | fix 필요 repo | 제안 |
|---|---|---|---|---|
| 1 | **backup/restore 절차 문서 부재** (offer가 'recovery workflow'를 팔면서 제품 문서에 절차 0건) | **HIGH** (offer-제품 불일치) | aigentry-telepty, aigentry-brain | README/딜리버 문서에 "백업 대상 = `~/.telepty`, `~/.aigentry`, `~/.config/aigentry-telepty`" + tar 원라이너 + 복원 후 데몬 재기동 절차 명기. 장기적으로 `telepty backup/restore` 서브커맨드 |
| 2 | **uninstall 잔여물**: 데몬 프로세스 생존(언인스톨 후에도 3848 응답), 상태 디렉토리 3개 잔존, (macOS) launchd plist 미해제 | MED | aigentry-telepty | npm `preuninstall` 훅에서 데몬 graceful stop + launchctl unload. 문서에 "완전 제거" 섹션 |
| 3 | **데몬 `0.0.0.0` 바인딩 기본값** — 고객 LAN에 데몬 노출(authToken 있으나 표면적 증가) | MED (보안 인상) | aigentry-telepty | 기본 `127.0.0.1`, cross-machine 필요 시 opt-in. B2B 보안 질문지에서 감점 요인 |
| 4 | deprecated 의존성 경고 2건(uuid@9, boolean@3.2.0)이 고객 첫 설치 화면에 노출 | LOW (인상) | telepty(uuid), brain(boolean) | 의존성 범프. 첫인상 노이즈 제거 |
| 5 | `aigentry-brain --version` 미동작(usage 출력) | LOW | aigentry-brain | version 플래그 처리 추가 |
| 6 | 멀티-CLI 실동작은 클린 환경에서 미검증(T7 N/T) | MED (커버리지 공백) | (프로세스) | 딜리버 전 고객-유사 머신(claude CLI 설치된 macOS VM)에서 1회 리허설 권장 |

**1-command 게이트**: 충족. 설치 = 패키지당 정확히 1 명령(`npm i -g`), 의존성 충돌 0, 수동 개입 0. 동작 상태까지 2 명령(설치+데몬). 기준치(3 명령 초과 시 환불률 ~75%) 대비 여유 있음.

## 종합 판정: 7일 딜리버 가능 — **Y (조건부)**

**근거 (Y)**: 설치 경로가 견고함 — 1-command, 5~7초, 프리빌트로 빌드 도구 불요, postinstall 에러 0, 데몬·기본 동작(inject 루프) 즉시 성공. 핵심 설치 리스크(node-pty 네이티브 빌드)가 프리빌트로 해소돼 있음이 확인됨.

**조건 (딜리버 7일 내 처리 권장)**:
1. 리스크 #1 (recovery 문서) — offer 항목인데 문서가 없음. 문서 1장이면 해소 가능 → 딜리버 패키지에 포함.
2. 리스크 #6 — claude CLI가 실존하는 머신에서 멀티-CLI 래핑 리허설 1회.
3. 리스크 #2, #3은 고객 질문 나올 수 있는 항목으로 답변 준비(또는 패치).

---
*tester(smoke-597-clean-install), Fable 5, VERIFY mode — 제품 코드 무수정. 모든 판정은 컨테이너 내 실제 명령 출력 기반.*
