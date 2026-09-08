# 종료 태스크 포트폴리오 증거 감사 — 2026-09-08

## 요약 및 판단 (집행·취소 승인 아님)

완료 장부 776건을 모두 제품 완료로 읽으면 안 된다. 이번 1차 감사는 종료 파티션 779행을 빠짐없이 분류했고, 최근 위험 변경은 소스와 보고서까지 읽었다. 과거 전 행의 코드·테스트·배포를 재감사한 결과는 아니다.

- 기준: `/Users/duckyoungkim/projects/aigentry-orchestrator/state/task-queue.json`, Git `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632`의 JSON `tasks` 배열.
- 최초 main HEAD(2026-09-08T13:21:45.540360+00:00): `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632`; 집계 시각 2026-09-08T13:25:15.314172+00:00 현재 main HEAD: `c33bea46c71a67e23adac39a3da197539346784f`.
- 작업 브랜치 `docs/1138-portfolio-closed`, 작업 경로 `/Users/duckyoungkim/.aigentry/worktrees/qa1138`; 착수 시 git status는 깨끗했다.
- 구조화 파서: 전체 1,136행/문자열 정규화 ID 1,136개, done 776 + cancelled 3 + 기타 357 = 1,136. 선택 779행/고유 ID 779, 중복 0, 누락 0.
- live는 별도 읽기: 1138행; {'done': 776, 'pending': 298, 'delegated': 11, 'in_progress': 21, 'blocked': 10, 'cancelled': 3, 'blocked-by-observation': 10, 'awaiting-user': 9}. 기준 밖 추가 ID 1137,1138; 기준 행 상태 변경 0건. 분모는 779 유지.
- active.json은 같은 관측 시각 구조만 집계: generation 16073, dispatches 84; outcome {'unknown': 84}. 세션 부재·unknown을 완료 증명에 쓰지 않았다.

| 분류 | 행 수 |
|---|---:|
| RECORDED_DONE_EVIDENCE_LOCATED | 410 |
| RECORDED_DONE_UNVERIFIED | 365 |
| PARTIAL_OR_CONTRADICTED | 1 |
| SUPERSEDED_WITH_EVIDENCE | 0 |
| CANCELLED_REVIEWED | 3 |

합계 779 = 776 + 3. SUPERSEDED는 의도적 보수 판정으로 0건: 옛 커밋 폐기와 태스크 전체 대체를 혼동하지 않았다.

### 증거의 의미와 실제 측정 범위
- L0는 기준 장부만 읽은 것. L1은 인용 경로/보존 shared ref의 파일 존재만 확인한 것. L2는 노트의 7–40자리 토큰을 관련 로컬 저장소의 `git log --all`에 대조해 유일한 커밋 객체를 찾은 것. 객체에는 과거 base/선행 변경도 섞일 수 있어 완료 증명이 아니다.
- L3는 아래 심층 항목에서 실제 소스/문서 본문을 읽은 것. 부록은 낮은 공통 기준 L1/L2로 표기한다. EVIDENCE_LOCATED는 증거 위치 확인이며 구현·테스트·병합·출시·활성화·수락 전체 완료 판정이 아니다.
- 노트 커밋 객체를 찾은 행 318건, 인용 파일을 찾은 행 235건(중복 포함). 각 행 최대 커밋 1개·경로 1개를 표시. 커밋 없는 오래된 태스크의 모든 히스토리 내용을 의미 검색하지는 않았다.
- 후보 저장소는 장부에 명시된 로컬 sibling 이름으로 제한하고 태스크별 명시 저장소/telepty/aterm 문맥에 매핑했다. 정확한 저장소 경로와 SHA는 부록에 기록. 공유 파일은 노트의 shared 해시 접두사와 유일 매칭한 경우에만 인용했다.
- 실행·테스트·빌드·설치·네트워크·데몬 상태 조회·앱/저장 데이터 접근/변경은 하지 않았다. CI/npm/GitHub/원격 반영 주장은 이번에 재측정하지 않았다. docs-only이므로 Snyk N/A.

### 이미 한 일과 잔여 의무
1. **#1131 부팅 CLI 선택 구현 위치 확인.** `/Users/duckyoungkim/projects/aigentry-orchestrator/src/orchestrator-boot/cli.ts:203,296,644`에서 환경 선택·잘못된 값 거부·codex resume 인자를 확인. 커밋 `8120836aeb91a5c1d6ddd884dd76b1378b84948c`의 3파일 변경 확인. 실행 테스트 결과는 장부 주장이고 실제 부팅·신규 설치·역할 로딩은 미측정; #1131의 수락 증거로 남긴다.
2. **#1124/#1125/#1127/#1099 telepty 변경은 출시와 활성화를 분리.** `/Users/duckyoungkim/projects/aigentry-telepty/src/bind-port.js:5-13`의 TELEPTY_PORT→PORT→3848, `src/screen-ansi.js:25,31`의 ESC/BEL 제한, `.github/workflows/release.yml:286-349`의 세 가지 publish 결과·25회/900초 정책을 소스에서 확인. #1125는 부록 커밋 객체 수준이다. #1130 npm 0.8.3/CI 결과는 장부 기록만 확인했으며 현재 설치·실행 버전을 추정하지 않았다.
3. **#1099 초기 원인 가설 정정 유지.** 커밋 본문과 현재 소스는 APC의 탐욕 문제가 아닌 OSC-BEL 경계 문제를 가리킨다. grok 실증 캡처 부재는 명시돼 있다. 잔여 증상 검증은 기존 **#1129 pending**; #1099 전체를 되풀이하는 새 수정 작업은 불필요하다.
4. **#1134 검사 단계 완료 ≠ #1132 후보 수락.** `/Users/duckyoungkim/projects/animal-hospital/docs/reports/2026-09-08-ah1134-build6-verification.md` 본문과 `4c566c36fcd6dd81ed1558be60516b2546f81ec7`을 읽음. 보고서는 Mirror 48/48, Press 46/46, BootGate PASS, 후보 sweep 8/8을 기록하지만 PhantomProbe 후보 per-press 동작·씬 객체 참조 동등성은 명시적으로 미입증. 원시 로그/바이너리/해시는 이번에 재검사하지 않았다. 다음 검증·최종 수락 소관은 **#1132 delegated**.
5. **#1135 분석 완료, 구현은 #1136/#1133.** `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-09-08-workflow-efficiency-analysis.md`와 정정 커밋 `0541a29adacedf57443a6c347188fc5d900d0f1a` 본문 확인. 가동/유휴 비율·60만 토큰·2/3 비중·상한 강등 0 목표는 철회돼 있다. 과거 보고의 수치를 현재 통계로 재사용하지 않는다. 두 기존 architect 작업을 유지하고 중복 구현하지 않는다.
6. **과거 잔여 노트를 최신 상태로 오독하지 않기.** #1057/#1078의 재생성·스탬프 부채에는 기존 **#1087 done**, D0에는 **#1086 done** 기록이 있다. #1087은 특정 이전 트리의 스윕이며 현재 전수 통과를 증명하지 않는다. 이관 기록과 부록 객체까지만 확인; 무조건 새 태스크를 만들지 않는다.
7. **#1058 관측 불일치.** 최종 장부에 runner의 save_hash와 live sha256 접두사가 다르다는 후속 관측이 남아 있어 PARTIAL_OR_CONTRADICTED로 보수 분류. 이것은 데이터 손상 증거가 아니며 함수 의미/대상/알고리즘은 미확정. 기존 **#1058**에 확인 의무를 연결한다. 원시 저장 파일 접근/복원/청소는 하지 않았다.

### 불필요한 재개와 취소의 한계
- #295는 MCP 통일 래핑을 취소하고 discoverability를 #297(done)으로 넘겼다는 원장 사유를 검토했다. 취소를 뒤집어 래핑을 재개할 근거는 없다. #297 산출물은 부록 수준으로 구분한다.
- #530은 원인 가설 수정 뒤 Stop-hook 제안이 moot라는 취소 기록이다. 자동 보고가 완전히 보장된다는 독립 증거는 아니다. #528/#531 관련 기존 범위와 대조해야 한다.
- #618은 중복 bridge/구버전 문제와 사용자 재시작 의존(#617/#539)이 남은 취소 기록이다. 취소≠운영 해결; 현재 PID/버전 상태는 미측정이다.

### 거짓 완료 위험·우선순위
- 먼저 #1132의 후보 수락 공백, #1129의 실제 증상 증거, #1058의 관측 지표 의미를 기존 소관에서 다룬다. 과거 P0/P1 표기를 현재 긴급도로 그대로 쓰지 않는다.
- 다음은 출시/병합과 실제 데몬·bridge 활성화 차이(#1130/#618), 보고서의 테스트 숫자와 원시 로그 재측정 차이(#1134), 과거 스윕과 현재 트리 차이(#1087)다.
- 레거시 EVIDENCE_LOCATED도 일괄 수락 금지. UNVERIFIED는 실패 판정이 아니라 회수하지 못한 증거이며, 오래된 작업의 재실행·취소 승인도 아니다.

## 전수 부록

각 행은 기준 상태 그대로다. 관련 행 링크는 의존성 확정이 아닌 기존 장부 참조 후보이며, 외부 이슈 번호와 내부 ID가 겹칠 수 있으므로 수동 확인을 명시했다.

| ID | 원래 상태 | 분류 | 증거 등급/출처 | 다음 행동 또는 기존 소관 |
|---|---|---|---|---|
| 6 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=6 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 8 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=8 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 9 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=9 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 10 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=10 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 12 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=12 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 14 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=14 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 15 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@28f94b0dcd898a4c0fe4a7ed3b211d748844f43d` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 21 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=21 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 22 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=22 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 23 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=23 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 24 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=24 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 25 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=25 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 30 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@c98a0fbbb6e489732e3596135777b49388278bc8`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/aterm-5platform-architecture.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 31 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/aterm-5platform-architecture.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 32 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=32 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 33 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 34 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=34 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 35 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=35 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 36 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=36 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 37 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=37 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 38 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=38 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 39 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=39 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 40 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=40 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 41 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=41 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 42 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=42 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 43 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=43 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 47 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=47 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 48 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=48 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 53 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=53 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 54 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=54 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 55 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=55 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 56 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=56 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 57 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=57 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 58 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=58 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 59 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=59 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 60 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=60 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 61 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=61 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 62 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=62 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 64 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=64 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 65 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=65 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 66 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@8487cb276dd7092107648c7c1086c054844bdfb3` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 67 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=67 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 68 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=68 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 69 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/submit-gate.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 70 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=70 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 71 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=71 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 75 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=75 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 79 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=79 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 80 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=80 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 81 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=81 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 82 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=82 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 83 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=83 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 84 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=84 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 85 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=85 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 86 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=86 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 87 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=87 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 88 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=88 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 89 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=89 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 90 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=90 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 91 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=91 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 92 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=92 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 93 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=93 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 94 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=94 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 95 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=95 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 96 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=96 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 97 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=97 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 98 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=98 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 99 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=99 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 100 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=100 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 101 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=101 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 102 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=102 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 103 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=103 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 104 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=104 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 105 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=105 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 106 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=106 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 107 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=107 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 108 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=108 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 109 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=109 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 110 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=110 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 112 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=112 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 113 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=113 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 114 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=114 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 115 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=115 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 116 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=116 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 117 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=117 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 118 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=118 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 119 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=119 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 120 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=120 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 121 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=121 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 122 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=122 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 123 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=123 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 124 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=124 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 126 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=126 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 127 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=127 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 128 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=128 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 129 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=129 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 130 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@05f4ad8bb0be6892b7add23dbde22e8d3126d5d5`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/snyk-scan.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 131 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=131 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 133 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=133 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 134 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=134 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 135 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=135 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 136 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=136 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 138 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=138 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 139 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=139 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 142 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=142 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 143 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=143 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 145 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=145 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 146 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=146 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 149 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=149 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 150 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=150 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 152 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=152 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 153 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=153 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 154 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=154 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 156 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/superpowers/plans/2026-04-19-context-compact-switching.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 157 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=157 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 158 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=158 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 159 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=159 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 160 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=160 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 162 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=162 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 163 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=163 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 164 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=164 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 165 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=165 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 166 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=166 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 169 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/submit-gate.js` | 기존 관련 행 #167(pending),#621(pending)의 의존성 수동 확인 |
| 171 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/adr/2026-05-04-phase6-conclusion.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 173 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=173 (장부만; 독립 증거 미확인) | 기존 관련 행 #309(pending)의 의존성 수동 확인 |
| 175 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=175 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 176 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=176 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 177 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=177 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 179 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=179 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 180 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=180 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 181 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=181 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 183 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=183 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 185 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=185 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 186 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=186 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 190 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=190 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 192 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=192 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 193 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=193 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 194 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=194 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 195 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=195 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 197 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=197 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 198 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=198 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 199 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=199 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 200 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=200 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 201 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=201 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 202 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=202 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 203 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=203 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 204 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=204 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 205 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=205 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 206 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=206 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 207 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=207 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 208 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=208 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 209 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=209 (장부만; 독립 증거 미확인) | 기존 관련 행 #215(pending)의 의존성 수동 확인 |
| 210 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=210 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 211 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=211 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 212 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=212 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 213 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=213 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 214 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=214 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 216 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=216 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 217 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=217 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 218 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=218 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 219 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=219 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 220 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=220 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 221 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=221 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 222 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=222 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 223 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=223 (장부만; 독립 증거 미확인) | 기존 관련 행 #236(pending)의 의존성 수동 확인 |
| 224 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=224 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 225 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=225 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 226 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=226 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 227 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=227 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 228 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=228 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 229 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=229 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 230 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=230 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 231 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=231 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 232 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=232 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 237 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=237 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 239 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=239 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 240 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=240 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 241 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=241 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 242 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-brain@341379e10b190f3a472759e972446dad7d4e7312` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 243 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=243 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 246 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=246 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 247 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@103d0091911b48159d7e41912ed0a56e68847299` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 248 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=248 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 249 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=249 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 250 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=250 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 251 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=251 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 252 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=252 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 253 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=253 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 254 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=254 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 255 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=255 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 256 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=256 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 257 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=257 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 258 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=258 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 259 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=259 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 261 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=261 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 262 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=262 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 263 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=263 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 264 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=264 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 272 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@28f94b0dcd898a4c0fe4a7ed3b211d748844f43d` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 273 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=273 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 274 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=274 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 276 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-brain@5ea47180f1b3ead523b466e025f0323a7493a064` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 278 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=278 (장부만; 독립 증거 미확인) | 기존 관련 행 #271(pending)의 의존성 수동 확인 |
| 282 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 287 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=287 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 293 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` | 기존 관련 행 #292(pending)의 의존성 수동 확인 |
| 294 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/superpowers/specs/2026-04-19-context-compact-switching-design.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 295 | cancelled | CANCELLED_REVIEWED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=295 (장부만; 독립 증거 미확인) | #297 done: discoverability 문서 대체; MCP 래핑 재개 불필요 |
| 296 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=296 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 297 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-devkit/docs/ecosystem-contract.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 299 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=299 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 300 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=300 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 301 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=301 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 303 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=303 (장부만; 독립 증거 미확인) | 기존 관련 행 #298(in_progress)의 의존성 수동 확인 |
| 304 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=304 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 307 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=307 (장부만; 독립 증거 미확인) | 기존 관련 행 #298(in_progress)의 의존성 수동 확인 |
| 308 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-devkit/bin/aigentry-devkit.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 311 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=311 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 312 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=312 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 313 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/superpowers/reviews/2026-04-19-codex-synthesis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 317 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 318 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 320 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=320 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 321 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=321 (장부만; 독립 증거 미확인) | 기존 관련 행 #322(pending)의 의존성 수동 확인 |
| 325 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=325 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 326 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 327 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@62f6cd0a854cb2183563521260c6b20e4f3409b0` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 329 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` | 기존 관련 행 #328(pending),#298(in_progress),#266(pending)의 의존성 수동 확인 |
| 330 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 331 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=331 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 332 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/adr/2026-05-04-phase6-conclusion.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 333 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=333 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 334 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@0ecd08b584b67e1996fbcfb1611a0631e53962cd` | 기존 관련 행 #26(pending)의 의존성 수동 확인 |
| 335 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=335 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 336 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=336 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 337 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=337 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 338 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@bd33898372853b3f971f4f8f693d9e7e5b3b73fa` | 기존 관련 행 #20(delegated)의 의존성 수동 확인 |
| 339 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-devkit/docs/superpowers/specs/2026-04-26-codex-trust-prompt-fix.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 340 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=340 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 341 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=341 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 342 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=342 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 343 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=343 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 344 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=344 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 346 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 347 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b7bbf1ba85a3198c3df4741bedae31f0993e4dc5` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 348 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 기존 관련 행 #608(delegated)의 의존성 수동 확인 |
| 350 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=350 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 351 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=351 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 355 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@61d63c134b50c147825414be4cacdc4526f99dc8`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-05-aterm-cross-llm-synthesis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 356 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@ba6acbd8fa9315a25ab1522252c21279b577d0cf`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-05-aterm-cross-llm-synthesis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 361 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@afcbc7762e28aeaef4c45eaebd8d819508d4ae29`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/aterm-5platform-architecture.md` | 기존 관련 행 #309(pending)의 의존성 수동 확인 |
| 364 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=364 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 365 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-aterm/docs/reports/2026-05-06-aterm-phase1-chunk2-review.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 369 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-aterm/docs/reports/2026-05-09-aterm-phase1-postcleanup-test.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 370 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=370 (장부만; 독립 증거 미확인) | 기존 관련 행 #196(pending)의 의존성 수동 확인 |
| 373 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=373 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 374 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 386 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-claude.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 387 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=387 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 388 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 390 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=390 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 391 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=391 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 392 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=392 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 393 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=393 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 394 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=394 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 396 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@23015b2b0cc8684d1047afbbf25ceaf65e546dbd`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/templates/dispatch-ref-template.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 397 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@23015b2b0cc8684d1047afbbf25ceaf65e546dbd` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 399 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=399 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 400 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@5067704a45b0cc49a720a00674232bb78dbee059`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 403 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=403 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 405 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@64ab3d8a3416d11dcb43a09cdd3bb9523736fa14`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 기존 관련 행 #26(pending),#408(pending)의 의존성 수동 확인 |
| 406 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 407 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch-tracker.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 411 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@cbc375051121c825ad943449aed9954f7b10e460` | 기존 관련 행 #28(delegated)의 의존성 수동 확인 |
| 412 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@de0fb9c43d176e015726f2755116b0ebeb9efa53`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/prompt-symbol-registry.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 414 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=414 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 415 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 416 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=416 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 418 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=418 (장부만; 독립 증거 미확인) | 기존 관련 행 #20(delegated),#29(pending)의 의존성 수동 확인 |
| 419 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@874d14a254e4d405650ac2bba896ce77e89a870a`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/win-resolve-executable.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 420 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=420 (장부만; 독립 증거 미확인) | 기존 관련 행 #29(pending)의 의존성 수동 확인 |
| 421 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 기존 관련 행 #410(pending)의 의존성 수동 확인 |
| 422 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c89801f1348f706b11be2e2bbb282eb9e8f72134` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 423 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=423 (장부만; 독립 증거 미확인) | 기존 관련 행 #52(in_progress)의 의존성 수동 확인 |
| 424 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=424 (장부만; 독립 증거 미확인) | 기존 관련 행 #20(delegated)의 의존성 수동 확인 |
| 425 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=425 (장부만; 독립 증거 미확인) | 기존 관련 행 #371(pending)의 의존성 수동 확인 |
| 426 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=426 (장부만; 독립 증거 미확인) | 기존 관련 행 #372(pending)의 의존성 수동 확인 |
| 427 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-23-agentic-architecture-external-review.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 428 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-23-agentic-migration-cost.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 429 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-23-agentic-standards-compatibility.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 431 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@60302398c8332a58e275a847cf5f899833106960`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/session/boot-prepare.test.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 432 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-23-agentic-migration-cost.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 433 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/session/inject-parser.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 434 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 435 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-23-agentic-migration-cost.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 437 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=437 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 438 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=438 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 441 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-ssot@6d285ef75b525c992347946688c56d4011a95b43` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 446 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 447 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/cambrian-spore@25a0e468f2a6db0ae200cb7ec6184d38b0ac8294` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 448 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 449 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=449 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 450 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b04b79da3ca407e15e11867417926f0c5b9de897` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 451 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=451 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 452 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@9190c08e0023ac4e33f033351b98861b867db8ab`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-24-herdr-vs-aterm-comparison.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 453 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@30800b343be7c8ea505128937fcb3103a7d651bd`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/templates/dispatch-ref-template.md` | 기존 관련 행 #467(pending)의 의존성 수동 확인 |
| 456 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@f941f523c749a34927323e9c4ae3d0e2ebaa6482`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-24-herdr-vs-aterm-comparison.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 457 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=457 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 460 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7a0928597daa7f26efb03617c36f4481532c2cab` | 기존 관련 행 #467(pending)의 의존성 수동 확인 |
| 461 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-25-deliberation-sh-deprecation-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 462 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-brain@9a36659d1e8b2e9d9dd7b6496cf9d8e5ca784263` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 468 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=468 (장부만; 독립 증거 미확인) | 기존 관련 행 #688(pending)의 의존성 수동 확인 |
| 469 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@900c3ae4126825405686923e963fbfa18d381875` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 470 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@900c3ae4126825405686923e963fbfa18d381875` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 471 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@900c3ae4126825405686923e963fbfa18d381875` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 472 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@900c3ae4126825405686923e963fbfa18d381875`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/prompt-symbol-registry.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 473 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@33d57897d500362dc0f7d13895382b15649d4b2e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 475 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=475 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 476 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 478 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/cambrian-spore@a338bbc9d1bff9b758b5e1f3f853e0c4aef05a63`; L1 경로 존재: `/Users/duckyoungkim/projects/cambrian-spore/docs/CONTEXT.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 480 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c5a663b999d5615a9dcadcda757d6b7d5efd0594` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 481 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=481 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 485 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-27-codex-21s-exit-root-cause.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 486 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 487 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/adr/2026-05-27-cmux-telepty-session-boundary.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 488 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=488 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 489 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 490 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/report-enforcement.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 491 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c5a663b999d5615a9dcadcda757d6b7d5efd0594` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 492 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@3505d73a686392651f2a70bdc5044c011fb9fd62` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 497 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/lifecycle-surface-acceptance.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 498 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@8169a51c279f0185506b63ce6a150ae564c95e34`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/daemon-restart-fallback-15.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 500 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=500 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 505 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/cambrian-spore@25a0e468f2a6db0ae200cb7ec6184d38b0ac8294` | 기존 관련 행 #504(pending)의 의존성 수동 확인 |
| 507 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ff7ea714804045c24ee8b54b8f90599201b6e7db`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 509 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=509 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 510 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/transport/websocket.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 512 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=512 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 513 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=513 (장부만; 독립 증거 미확인) | 기존 관련 행 #753(pending)의 의존성 수동 확인 |
| 514 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=514 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 515 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/cmux/docs/specs/2026-06-06-sidebar-session-info.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 516 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-06-06-cmux-adaptor-prune-status.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 517 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=517 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 518 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/install-instructions.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 519 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/install-instructions.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 520 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-logger/docs/2026-06-06-publish-strategy.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 521 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=521 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 523 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 525 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/dispatch/run-all.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 530 | cancelled | CANCELLED_REVIEWED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=530 (장부만; 독립 증거 미확인) | #528·#531 참조; 자동 보고 효과 독립 검증 안 됨 |
| 531 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=531 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 532 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@81466ae6bec7218c2054e82141e9d06f239ff554` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 533 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@06127cc8ef8036f4a849a16e8de0dcafc79c02c4` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 535 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7a8165a1503f0fadeab9005fbfc3f13f88298bab` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 536 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@8ff0910c8d6933a46b7b35ba5d5069fe89e0c4ce` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 537 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@0b51f5e8cb1a344fed086931051c6f2da91deedf` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 538 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=538 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 539 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@f65c13116c8f7413858ae50ea617fb233bcc6815` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 540 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a573c1792b785eaa7ff30283b559c09fb7c28200` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 541 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a573c1792b785eaa7ff30283b559c09fb7c28200` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 542 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a573c1792b785eaa7ff30283b559c09fb7c28200` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 543 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=543 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 544 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@2898cece6f006ff9b5e4a1da3de835f8cefda2ef`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/adr/2026-06-07-submit-via-pty-context-layer.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 545 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e3a7c4fbfbbd0d28e62d150d581347a18c90f4c4` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 546 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@440008a09e27a3d097814b81994bc9261147e961` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 547 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@31ae8228c957a2365bd1845eb459806545bc8586` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 548 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@63942de83855b85916907caa716a0a95b6d1a323` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 549 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9b76a4dbc2e625be642c5dc53bf9e9df4eff8d36` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 550 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@b613234a73edf00828bf502b5c6438c09e5d82bf` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 552 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@bc085f96c7a801507065422500e146be8d0acc3e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 553 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-devkit@b1dc3cdd0659bedb8ccc7e4915704bb8485d43c2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 554 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7b3257dac6f7058accef490fba3423b8a45cafd5`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/gate/class-b-validator.test.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 555 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@658dae5bdde5f71e323bd77ce9a13858067b4c60` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 556 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/session/permission-manager.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 557 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@cd8c3eb862fe94326f67721a213244daaed9f8bb` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 558 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@561c2a223d5cd7f1f7ad0deddbaf9a212ee66eb8` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 559 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@f4b99fd243c0fea01b28a661e04e4ed4ead4ff48` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 560 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=560 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 561 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@53db8367355e423fe6b5235bcea05353d152ba9e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 563 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@f3d273daf3908917bd19d5890097c9ab4cbe8fb4`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/install-service-generation.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 564 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@d6b578463d901f375de78803457b61bc5520e709`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/specs/2026-06-08-broker-mvp-implementation.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 565 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@49a4291028a4cc02fa34388f0b4f696a4a672f67`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/reports/2026-06-09-565-ci-triage.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 566 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=566 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 567 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=567 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 568 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@3f5e5f20757c51f7094dfa7c169c68d9c57edde7` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 569 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@4507b9db8ef8c33d973c2187c17670195c9a718f` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 570 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c86874774c29d49ba7a3e73039970a3759e685b6` | 기존 관련 행 #2(pending),#44(pending),#45(pending)의 의존성 수동 확인 |
| 571 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c86874774c29d49ba7a3e73039970a3759e685b6` | 기존 관련 행 #44(pending),#45(pending),#46(pending)의 의존성 수동 확인 |
| 572 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c86874774c29d49ba7a3e73039970a3759e685b6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/win-resolve-executable.js` | 기존 관련 행 #44(pending),#45(pending),#46(pending)의 의존성 수동 확인 |
| 573 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b7e5697e93efd5f8539a207877a084f868b620c0`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/specs/2026-06-09-inject-audit-provenance.md` | 기존 관련 행 #45(pending)의 의존성 수동 확인 |
| 574 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@3bed18f9b55a9f07474c345bbe4848e115e42669`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 기존 관련 행 #44(pending),#45(pending)의 의존성 수동 확인 |
| 575 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ec50a3e71bf87a852c4a54fb3109ee571361a9d6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/specs/2026-06-09-inject-audit-provenance.md` | 기존 관련 행 #45(pending)의 의존성 수동 확인 |
| 576 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@dd5a535fced54bb3cc50c26857dbca2beb42d9f2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/reports/2026-06-09-565-ci-triage.md` | 기존 관련 행 #577(pending)의 의존성 수동 확인 |
| 578 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@6f0441fb4e8535799cc9d48e6b70b3972755ecfc` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 579 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=579 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 580 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 581 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 582 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 583 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 584 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 585 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 587 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7b29fb7fc339319ac5e1e8dab5116639bded6c21`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 기존 관련 행 #586(awaiting-user),#590(pending)의 의존성 수동 확인 |
| 588 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@1702b17d170ecc196f0d9feccf58923d7694e517`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-structure-audit.md` | 기존 관련 행 #586(awaiting-user)의 의존성 수동 확인 |
| 594 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-market-research-monetization.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 597 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-10-smoke-597-clean-install.md` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 600 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=600 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 601 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=601 (장부만; 독립 증거 미확인) | 기존 관련 행 #45(pending)의 의존성 수동 확인 |
| 603 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@f4641b73ae51939d0667fb482472dec397dd1402` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 604 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@f4641b73ae51939d0667fb482472dec397dd1402` | 기존 관련 행 #49(pending),#50(pending)의 의존성 수동 확인 |
| 606 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@d3ac30241bc036a3a52ced6097965ca45535d4bd` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 610 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=610 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 611 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@529b7c2fd0d66df6c0c7fb9f2f6c6566c94ea286` | 기존 관련 행 #608(delegated)의 의존성 수동 확인 |
| 612 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=612 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 613 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-devkit@ba879d992a9c9c422481931bb5526fceebb1c1ef`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh` | 기존 관련 행 #608(delegated)의 의존성 수동 확인 |
| 614 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@5f5119d6ee141ee9776f3bbd34bc4805f0fc8923` | 기존 관련 행 #608(delegated)의 의존성 수동 확인 |
| 615 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e4d839ce3547106702844b59a3e33587a168505a` | 기존 관련 행 #52(in_progress)의 의존성 수동 확인 |
| 616 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=616 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 617 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=617 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 618 | cancelled | CANCELLED_REVIEWED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=618 (장부만; 독립 증거 미확인) | #617 done·#539: bridge 갱신 결과 미확인; 취소≠해결 |
| 619 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@36f399a34b9bea8e7b9f0633d7b7e085b1a3b4f1` | 기존 관련 행 #52(in_progress)의 의존성 수동 확인 |
| 620 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@9d834e79b01fd5f61f42bae94cefb14c890a7f1e`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-boot.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 622 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@69c463b7e4ae4d5aaaa8937f7d81190f39bb209f`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-06-13-public-hygiene-inventory.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 624 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@d9cd311efbf69957e7f4efb238418b0688db0f29`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/submit-gate.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 627 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=627 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 629 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@18270a386c17f045190b41ac554e851ef1dac73a` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 630 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@0e161421ee37c1b61f7aa88c62a079f4fea9daa6` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 631 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@95e8e3e814f9398776c6ea693e8c70d2b0e86ad3` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 632 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=632 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 633 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=633 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 635 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a624dd508efc945b0381618cb245f322be6a8e3e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 636 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@d1dde930c3b9335e5f91ddeb151bdc7ca9432c14` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 637 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a624dd508efc945b0381618cb245f322be6a8e3e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 639 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@4185ab5c5d6fc30a71e3e60d957bac726a085744` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 640 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=640 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 641 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=641 (장부만; 독립 증거 미확인) | 기존 관련 행 #638(delegated)의 의존성 수동 확인 |
| 642 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=642 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 645 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@023e65bc3eca28d43b36d835cccec6c1c67ce50d` | 기존 관련 행 #577(pending)의 의존성 수동 확인 |
| 646 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=646 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 649 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@808ef40f0cb23ef97724bd00cf355e7251f3e81b` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 650 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` | 기존 관련 행 #596(awaiting-user)의 의존성 수동 확인 |
| 651 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@850d79179291386a0cb1594a593bcfdf3fb182db` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 654 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=654 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 666 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 674 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@567d4080e64f207ce7b9ae83de451977c8c4dc6b` | 기존 관련 행 #50(pending),#672(in_progress),#643(awaiting-user)의 의존성 수동 확인 |
| 678 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@0ecd08b584b67e1996fbcfb1611a0631e53962cd` | 기존 관련 행 #672(in_progress)의 의존성 수동 확인 |
| 679 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/prompt-symbol-registry.js` | 기존 관련 행 #413(pending)의 의존성 수동 확인 |
| 682 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=682 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 685 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=685 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 687 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@1991d6f21430b7fe99bb638a235580bc6a281fdb` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 689 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=689 (장부만; 독립 증거 미확인) | 기존 관련 행 #693(blocked-by-observation)의 의존성 수동 확인 |
| 690 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@80ec09a248b7bcf33a558f81ed484462e2bcdd2f`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-report-target.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 691 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e81d13931d8e1801b90bb2261ac003e55c48bf10` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 692 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/submit-busy-dispatch-694.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 694 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e81d13931d8e1801b90bb2261ac003e55c48bf10` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 695 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry@562d4419488b675fc1e38a2b12715fad288214d6` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 697 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=697 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 698 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=698 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 703 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 704 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=704 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 706 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a42a11dd2d503c2f1b082675434ea500c75dfb01` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 707 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=707 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 708 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=708 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 710 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=710 (장부만; 독립 증거 미확인) | 기존 관련 행 #700(pending)의 의존성 수동 확인 |
| 712 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@995ffecf5a42d53f4b80c164682f56954a626677` | 기존 관련 행 #713(blocked-by-observation)의 의존성 수동 확인 |
| 714 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9f9e20d5b48f9f1d6aba3d09c888a1fc11033573` | 기존 관련 행 #713(blocked-by-observation),#700(pending)의 의존성 수동 확인 |
| 715 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a0303a1d96a198789e24ef479485b8a2811d9b6d`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/screen-ansi.js` | 기존 관련 행 #713(blocked-by-observation)의 의존성 수동 확인 |
| 716 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e6559d0ddd5b7941657b6463f36ba12db61574b4` | 기존 관련 행 #713(blocked-by-observation)의 의존성 수동 확인 |
| 718 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@143bd85955e670be395d967775fe15f2ad15faa7` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 719 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@060276bd0a366123d61aaf00c30fdbf20e63f4c2` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 720 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@78569bdea38a21f97decee5d3e4339409c4cac5e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 721 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@204d3a62fa4ca1552b1d76409566ba09ab3f2522` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 722 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b0a71fca85272140daa6d10aedc8821e9881196f` | 기존 관련 행 #713(blocked-by-observation)의 의존성 수동 확인 |
| 724 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@65d9fd0ca1e4ee1d2e32e8e9c24ada282ac6311f` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 725 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9f897fc8824517df7e6af9b74f71e41188eac059` | 기존 관련 행 #731(pending)의 의존성 수동 확인 |
| 727 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@48a3a2fc3c19ab4966b3ecd9d8a487d25313957d` | 기존 관련 행 #723(blocked-by-observation)의 의존성 수동 확인 |
| 729 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@f29903120b8192b99028b820e882c9207b16fc8c`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 730 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@de0fb9c43d176e015726f2755116b0ebeb9efa53` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 732 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=732 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 733 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=733 (장부만; 독립 증거 미확인) | 기존 관련 행 #44(pending)의 의존성 수동 확인 |
| 734 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@b4ccd098aa38da2e68650c3fb6bc03b6a1a5c54d` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 736 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@6e7bee31ee438ca9078a3ab8e60418267d1f3551` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 737 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=737 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 738 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a241820da4c5196313c4b9fdc91557807539ebcc`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/supervisor.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 739 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@03359b868b206120384cee299bdbcb920b370ec6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-devkit/bin/aigentry-devkit.js` | 기존 관련 행 #735(blocked-by-observation),#747(pending)의 의존성 수동 확인 |
| 740 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1dc3591e87418807163f50de867c750f1fb9fcc5`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/hitl.sh` | 기존 관련 행 #755(pending)의 의존성 수동 확인 |
| 744 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/hitl.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 745 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@9882e365d873c459379dfc5eb4b00c013d440c02` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 746 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=746 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 749 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-devkit/bin/aigentry-devkit.js` | 기존 관련 행 #761(pending)의 의존성 수동 확인 |
| 750 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@8bfaa921ec20193345cecfffbd4e696cfffd1446` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 751 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=751 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 752 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e3a22f944562215e7326892cb3850d08cc1f1c64` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 754 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@33d57897d500362dc0f7d13895382b15649d4b2e`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/transport/websocket.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 756 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@db78a5fb80d249c13c166d61de6cdf189f178360` | 기존 관련 행 #735(blocked-by-observation)의 의존성 수동 확인 |
| 757 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b04b79da3ca407e15e11867417926f0c5b9de897` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 759 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=759 (장부만; 독립 증거 미확인) | 기존 관련 행 #766(in_progress)의 의존성 수동 확인 |
| 760 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@dcf4d17ad47711ae9c61ebee0309f2469a9ad138` | 기존 관련 행 #743(pending)의 의존성 수동 확인 |
| 762 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=762 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 763 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=763 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 764 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@652a252ea7b4381298f305b510ba25e93eecc129` | 기존 관련 행 #767(pending)의 의존성 수동 확인 |
| 768 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ac065469e3caf2f4f2c7fb9b409a59e7c9a776b8`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/cli.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 769 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-26-ecosystem-cleanup-audit.md` | 기존 관련 행 #780(pending),#790(pending)의 의존성 수동 확인 |
| 771 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@3d7a4a637f4b31f106b3107f02eab9ac28452460` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 772 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-brain@1be0365ec2f7b81b10025e35099c0c2e2162b424` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 773 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-devkit@0d6f9d76aaf3ec9be661cdfc16bc228d3d6adb29` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 774 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@954031397c4274c458cb8c6031497fb89ced290a` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 775 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@bd115ff6e78437317dd96fa6b44ecc4b77721c7c` | 기존 관련 행 #655(pending)의 의존성 수동 확인 |
| 776 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-dustcraw@c0af3c931d1eb13db1cdd96faee3fa6e006997d1` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 777 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-deliberation@da6144dbc08e10c17addbb2c33439bdc89b983d8` | 기존 관련 행 #781(pending)의 의존성 수동 확인 |
| 778 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-context@eb233609a43bb27f9f09b47bcbc020a7d9ac35cd` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 779 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-ssot@42afae4716fbb7baf15cc08615142f7d240eb585` | 기존 관련 행 #780(pending)의 의존성 수동 확인 |
| 793 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@6db5d06e30b986fd4002f7eb36f71426aa2b19bd` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 794 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=794 (장부만; 독립 증거 미확인) | 기존 관련 행 #795(delegated)의 의존성 수동 확인 |
| 797 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=797 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 798 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=798 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 799 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=799 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 800 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=800 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 801 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@472fdc4c741fab3f8bd32f469f3fbc01b8969289` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 802 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=802 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 804 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ac065469e3caf2f4f2c7fb9b409a59e7c9a776b8` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 805 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=805 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 806 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@850d79179291386a0cb1594a593bcfdf3fb182db` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 807 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@291243629c206c7566a2c97e1655251e41f8a419`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/prompt-symbol-registry.js` | 기존 관련 행 #52(in_progress)의 의존성 수동 확인 |
| 808 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-report-target.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 810 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@2effa19df3977b839f213c96a32f54478aa0e517`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/dispatch/T67_orchestrator_report_target.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 815 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ca447823ecaed466741e6a75434a644a6b9a00bd`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/protocol/http-auth.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 820 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@87be6f75bff562ba2ea840edec64f4020f38f4f6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/transport/websocket.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 823 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@87be6f75bff562ba2ea840edec64f4020f38f4f6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/protocol/http-auth.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 824 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@448b81d6761d94dd841b25e9fc2e0d2c2a8e629f`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 825 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@6f2603c76ffa2e252552622aa017185aabbefbcc` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 826 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@87be6f75bff562ba2ea840edec64f4020f38f4f6` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 829 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@95ee69bef23ec4a05dc550c9f91ecc4c5eb9e950` | 기존 관련 행 #822(pending)의 의존성 수동 확인 |
| 830 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=830 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 831 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@bfd2bec6bc4f328268ceaa15bfebdcc0b17f4451`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 832 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@aefdc31c809538836731b7b36df7b44efdeb0aa8` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 833 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@e05c9a1d17b3c59dc9931523cfb2491a110d023d` | 기존 관련 행 #822(pending),#828(pending)의 의존성 수동 확인 |
| 835 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a9a5c6480dadc58f8e0adc4da7ca621c398fbbcb`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-08-01-silent-absence-sweep.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 837 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a5cff2f9a6a01865ab7639eb29f6dc508e37643b` | 기존 관련 행 #888(pending)의 의존성 수동 확인 |
| 838 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b53ac5caca5a4c5b6193dffdcb349f4292fd4c88`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 839 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b55b835c15fe574c3985ca8557b0a9bb7f68ae11`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/session-store/persistence.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 840 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 842 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ca447823ecaed466741e6a75434a644a6b9a00bd` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 843 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=843 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 844 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@8e59c287605ded691f5782e8beebe4563278ea41` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 846 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=846 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 847 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@9434a4146a4cfbe962aefc11ec813da8dfaf6359`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-reconciler.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 848 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@6f2603c76ffa2e252552622aa017185aabbefbcc`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/transport/websocket.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 850 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a5cff2f9a6a01865ab7639eb29f6dc508e37643b` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 852 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 기존 관련 행 #845(pending),#2(pending)의 의존성 수동 확인 |
| 853 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 854 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=854 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 855 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/enforce-submit-gate.test.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 856 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/lifecycle-surface-acceptance.test.js` | 기존 관련 행 #577(pending)의 의존성 수동 확인 |
| 857 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=857 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 859 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@39bb6ec2776a2584881db5717cd53be82fe47e9b` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 860 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@bada1d4d6df35f23f6ce540088e38f552a922a57`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-08-15-r3-final-gate-review.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 861 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@263cdff315ae37c91cfd0a9ebea031a0e5b7858f`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-08-15-r3-final-gate-review.md` | 기존 관련 행 #865(pending)의 의존성 수동 확인 |
| 862 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=862 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 863 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9d78f451da665f41180286a308b012b733adbf92` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 866 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=866 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 867 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@78beda66b8f6839dfa3186ed3027efb0307d106f` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 869 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9003c0108e0fa143f9dfe69b8bd700677dc57dbe` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 870 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@ed2a4335a15e5b2a13ecfb752776234fc7daec69`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-08-15-r4-delta-gate-review.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 872 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 873 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=873 (장부만; 독립 증거 미확인) | 기존 관련 행 #865(pending)의 의존성 수동 확인 |
| 874 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@104ee365c933c23bbb13357158769af1f4e427e8` | 기존 관련 행 #63(pending),#876(pending)의 의존성 수동 확인 |
| 875 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=875 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 877 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@81f3b0ed766001ffb3061a58ca52c6ffd64ff744`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 878 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@2333c996667c27e127e48013b75cc55806c3255a`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/observation-tracking-endpoint-60.test.js` | 기존 관련 행 #63(pending)의 의존성 수동 확인 |
| 880 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@804374b9d87a9ba113cdc373bca324f2bd48e118`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/test/enforce-report.test.js` | 기존 관련 행 #63(pending)의 의존성 수동 확인 |
| 885 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@dde4b87bdc72b37d79fa67a66b1f9097f625a4ba`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 886 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=886 (장부만; 독립 증거 미확인) | 기존 관련 행 #2(pending),#895(pending)의 의존성 수동 확인 |
| 887 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-aterm@9b4cec5878ac48dec10c09e71a58918a3cc9c89c` | 기존 관련 행 #354(pending)의 의존성 수동 확인 |
| 894 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@855aa6bdef9387691f30fc93866d054a1afcff48` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 896 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@fe70465949505ab20d3fb32843f6e179b01a4041` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 897 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@4902bfd9f4991049cc431f7a337afc49860c4533` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 899 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1088ad7d56b82389e8cc10492f1a39d22199a782`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 기존 관련 행 #927(pending),#929(pending)의 의존성 수동 확인 |
| 900 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@629300679e8b3881d4740663776c0441570f19f0` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 901 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=901 (장부만; 독립 증거 미확인) | 기존 관련 행 #908(pending)의 의존성 수동 확인 |
| 902 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@f787c4047d9cf129f96aab94c5e913687cb6b987`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/specs/2026-08-16-sweep-scoping.md` | 기존 관련 행 #44(pending)의 의존성 수동 확인 |
| 903 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a5cff2f9a6a01865ab7639eb29f6dc508e37643b` | 기존 관련 행 #63(pending),#906(pending)의 의존성 수동 확인 |
| 904 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@b17ac742f2e911ec0a2f4dd49eea6c74c6fc913b` | 기존 관련 행 #743(pending),#13(pending)의 의존성 수동 확인 |
| 905 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a9e2385ff6271fe60f6464d4338cdb5752a2dd0d`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-boot.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 907 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/runbooks/2026-08-16-orchestrator-restart.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 909 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@d7a277747e4584e676f52227ad716d84d1134042`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/tracker/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 910 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c10f3e7d68ca66355ec4c7cc99a69dec444e0401` | 기존 관련 행 #72(pending)의 의존성 수동 확인 |
| 911 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/docs/research/2026-08-16-probe-funnel-frequency.md` | 기존 관련 행 #919(pending)의 의존성 수동 확인 |
| 912 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=912 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 913 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=913 (장부만; 독립 증거 미확인) | 기존 관련 행 #147(pending)의 의존성 수동 확인 |
| 914 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@4a69fdbe83fe313511695611ebdc07476e063d88` | 기존 관련 행 #52(in_progress)의 의존성 수동 확인 |
| 915 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@4a69fdbe83fe313511695611ebdc07476e063d88` | 기존 관련 행 #918(pending)의 의존성 수동 확인 |
| 916 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=916 (장부만; 독립 증거 미확인) | 기존 관련 행 #77(pending)의 의존성 수동 확인 |
| 917 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@9e9814805244edbbacee3573afd8efccb2c665fd` | 기존 관련 행 #879(pending),#73(pending)의 의존성 수동 확인 |
| 920 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=920 (장부만; 독립 증거 미확인) | 기존 관련 행 #2(pending),#921(pending),#922(pending)의 의존성 수동 확인 |
| 923 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=923 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 924 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@f152e03b0361215e23551f2e98438a69540b8f0b` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 925 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1abd53b08dc9c587134723519536c5ab49840b22`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/hitl.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 926 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@ce774d8296cc2a706907b9e54e5eb69051e64cdc`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/lib/workspace-host.sh` | 기존 관련 행 #29(pending)의 의존성 수동 확인 |
| 928 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@e2c3a365c53b707e1d551ebf6fb223263978c2ca`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/inject-handler.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 930 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1a4e2bd0c7954cf8770454b3c51a6df8ed1131e2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/hitl/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 931 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1a4e2bd0c7954cf8770454b3c51a6df8ed1131e2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/hitl/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 932 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1a4e2bd0c7954cf8770454b3c51a6df8ed1131e2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/session/inject-parser.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 933 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1a4e2bd0c7954cf8770454b3c51a6df8ed1131e2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/dispatch/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 934 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@cc29eb65dc6008cfe9c58f8c289398832a83ee5d`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-boot.sh` | 기존 관련 행 #28(delegated)의 의존성 수동 확인 |
| 935 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@1a4e2bd0c7954cf8770454b3c51a6df8ed1131e2`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/hitl/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 938 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8f00cfbce5c7da59c037f20f41da7b9ae21996a2`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/docs/playtest/2026-08-22-rebuild-gate-FAIL.md` | 기존 관련 행 #936(pending)의 의존성 수동 확인 |
| 939 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@92e313180e208916caaa0744657ad1ff663160c8` | 기존 관련 행 #949(in_progress)의 의존성 수동 확인 |
| 940 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a19829c0c6ec5cbb7d81199813e288b36e6176b0` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 941 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@87decdab710724c3af7c3ed2ed56a75acc9ca6fc`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-boot.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 943 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=943 (장부만; 독립 증거 미확인) | 기존 관련 행 #942(pending)의 의존성 수동 확인 |
| 944 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=944 (장부만; 독립 증거 미확인) | 기존 관련 행 #936(pending)의 의존성 수동 확인 |
| 945 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@9eda7babc0dd8e34cfe906c7e83a030ccf493388` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 946 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@5c9992ccf7f10612ed953ce1704042b651462c12` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 948 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@641819dc7b02a1299d2802067a2ae3ce583621ae` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 951 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a7c95686cde3fbc776cfb507e206a04bd4b23050` | 기존 관련 행 #937(pending),#952(pending)의 의존성 수동 확인 |
| 956 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=956 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 960 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@61179b24bcec039094cec5fad1f473edb3c2142b`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/dispatch/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 975 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@5f78b5c05df5d5559028f34cc01acf1352b4de56` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 976 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8addc9cb81c026611e272809daa384808378b26c`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/docs/reports/2026-08-23-951-rows1and3-impl-note.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 977 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=977 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 979 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a9237d09bebb088549d4de3ec96930650697f8ef` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 980 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@44bc214dbbc11787c8462859ef29920df0baf790` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 981 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@ef0d4221e1761de39ba58bdc8985a1a7566ae548` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 982 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@b4366291b73ebebd74aa0a39495cf230e996ca67` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 983 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=983 (장부만; 독립 증거 미확인) | 기존 관련 행 #937(pending)의 의존성 수동 확인 |
| 984 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=984 (장부만; 독립 증거 미확인) | 기존 관련 행 #937(pending)의 의존성 수동 확인 |
| 985 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@efb0cff21a157b26fe5cd83c62f879985deb53d3` | 기존 관련 행 #958(pending)의 의존성 수동 확인 |
| 986 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@712e9baf2b73b73dab4939bf235d74ae9761b23c` | 기존 관련 행 #957(pending)의 의존성 수동 확인 |
| 987 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@98034f50e3ddfcfc6c0ef1465c072d51321a0d53` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 989 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@3a6660e267f227ae300ddab2fda53643eaaf6dac`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 990 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a1391e4ee894d0bf533409119a78d5279a3048ca` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 991 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a266440c3a97d5dce4d68fa2e5ab1997f062af9e` | 기존 관련 행 #993(pending),#995(pending)의 의존성 수동 확인 |
| 994 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@190c3fd5b0190d12e7b52398b4c818855c164854`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/Assets/Editor/M5Build.cs` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 997 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@e7aff8391c8bfc5bbded59bf0f0774c31d387a41` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 998 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@e7aff8391c8bfc5bbded59bf0f0774c31d387a41` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 999 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=999 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1001 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1001 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1002 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1002 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1003 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@e7aff8391c8bfc5bbded59bf0f0774c31d387a41` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1004 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1004 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1006 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1006 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1007 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@b4366291b73ebebd74aa0a39495cf230e996ca67` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1008 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1008 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1010 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@3a6660e267f227ae300ddab2fda53643eaaf6dac`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1011 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1011 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1012 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8c0c1b1375e3f83c909965ac9cd8ee356968aa42` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1013 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1013 (장부만; 독립 증거 미확인) | 기존 관련 행 #1009(pending)의 의존성 수동 확인 |
| 1014 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1014 (장부만; 독립 증거 미확인) | 기존 관련 행 #1009(pending)의 의존성 수동 확인 |
| 1015 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1015 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1016 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@33f0af067b5386bcc84afcd85d0ae8d75d440184`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1017 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1017 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1018 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@a266440c3a97d5dce4d68fa2e5ab1997f062af9e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1019 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@96cc84733f6e775bf506ce47354f24fac0d3c8aa` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1020 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1020 (장부만; 독립 증거 미확인) | 기존 관련 행 #1009(pending)의 의존성 수동 확인 |
| 1021 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1021 (장부만; 독립 증거 미확인) | 기존 관련 행 #1000(pending)의 의존성 수동 확인 |
| 1022 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@6b488e81169ebd9f1b0fb4c09e0fddd6b9d71d10` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1023 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1023 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1024 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1024 (장부만; 독립 증거 미확인) | 기존 관련 행 #988(pending)의 의존성 수동 확인 |
| 1025 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@da02a06231383b710944d70dd6f27aaf0ac6d48e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1026 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1026 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1027 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1030 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1030 (장부만; 독립 증거 미확인) | 기존 관련 행 #1000(pending)의 의존성 수동 확인 |
| 1031 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1031 (장부만; 독립 증거 미확인) | 기존 관련 행 #1000(pending),#1067(pending)의 의존성 수동 확인 |
| 1032 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1032 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1033 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@da02a06231383b710944d70dd6f27aaf0ac6d48e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1034 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@b120b78ec58d333780d1fedfda82c5da57bef890`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/45b3c8b3ae7883c55a435a34eb781b5a02aa0395e4c2174bddc0baec8020032c.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1036 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@da02a06231383b710944d70dd6f27aaf0ac6d48e` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1037 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1037 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1038 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1038 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1039 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1039 (장부만; 독립 증거 미확인) | 기존 관련 행 #972(pending)의 의존성 수동 확인 |
| 1040 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@d34354f95cd06c52eb36faeca9f450d08e7c3f22` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1041 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1041 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1042 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1042 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1043 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1043 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1044 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1044 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1045 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1045 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1046 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1046 (장부만; 독립 증거 미확인) | 기존 관련 행 #937(pending)의 의존성 수동 확인 |
| 1048 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1048 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1049 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1049 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1050 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@c7d308d3ccdec228402a8ab91a12318d1d399ba5` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1051 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@99c17c29b3a627c202429ae9ba356fadbfc14afb` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1052 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1052 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1053 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@1555ad16f5e0e4b498407e13f4fd37e3e7fd3e59` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1054 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1055 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@29840f40beee22e70246bfff917e807298fae724`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 기존 관련 행 #993(pending)의 의존성 수동 확인 |
| 1056 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@99c17c29b3a627c202429ae9ba356fadbfc14afb` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1057 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@51e8dd861f932c67d74850447b47b198729115f8`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/708e4b033c61570e4bfdb19a040180da01897dc68f5012c7a6cd485286340562.md` | #1087 재생성/스윕으로 이관; #1086 D0 수정; 현재 전체 통과 미측정 |
| 1058 | done | PARTIAL_OR_CONTRADICTED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@99c17c29b3a627c202429ae9ba356fadbfc14afb`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/probe-sweep.sh` | #1058: save_hash 관측 의미 확인; 삭제/재실행 승인 아님 |
| 1059 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1060 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/rules.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1068 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a536cd8b303f6781ccccc9f4817aa8a6c0416845` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1069 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@2bf07464a86f820944a7eaf2350632dee66d58a9`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/install-instructions.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1070 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@a91d75a1c3b3e63612d83fad7461a553eb07fd08`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/a2dd91cc15a4a44ae3160406984691539247fa04769527d79bd1f50363939f28.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1071 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1071 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1072 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@30474c13ab0d3e2241ceef1bc16e1b351a1a6d82` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1073 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@d6a101418cf3c49434c9e36e5073aa87f26a33ed`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/f7f09ea514955f980e8764838c31f3146b82e06798e1c8a5be30c6e268b062d1.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1074 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@5ef13e7022664a772c7346b1965a4c1923e25251`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1075 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@04f811c3a77ac4daa8816e83bd30c0282a6d7adf`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/reconciler/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1077 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8f088ce0487b1e6d613eab1aa5a4938957687caa`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/1686f0046567e90fa6c23f1fdf201c22986d44e88038d2b1ebca3088c39cf37b.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1078 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@5c6eaa197f6b8630d31dd6fb84d58287bfcd15d0`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/snyk-scan.sh` | #1087 재스탬프/후속 검증 기록 참조 |
| 1080 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1080 (장부만; 독립 증거 미확인) | 기존 관련 행 #1079(pending)의 의존성 수동 확인 |
| 1081 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1081 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1082 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@29f2fa64596fb6006ac39da107718ef7cdc1fef6`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/model-profiles/model-routing-profile.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1083 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@35da993fe980e10833313d8563f4bd9a47db1502`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/dispatch/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1084 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@818bf1122d959610998097b84ac8c6022e9d9716`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/5082cde199ab1024deba4215a3c0d136f27898c099952478cd67fd5a2695e992.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1085 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@f95b06f939c5287d1d4466419e716f95037e6282`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/unity-run.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1086 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8f088ce0487b1e6d613eab1aa5a4938957687caa`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/d7ce73a1e33234dddc903b4e1b67ec53c0f90ab9c88cc13426a6a51b03520cbc.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1087 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@8f088ce0487b1e6d613eab1aa5a4938957687caa`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/ce0d9f76f62a9884b6a63ed027ea39da1f74503584c3a524556e2e83eb2a6cd2.md` | 기존 관련 행 #993(pending),#995(pending)의 의존성 수동 확인 |
| 1088 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=1088 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 1089 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@0bbe972e9be6b1bdd7d6cad00e66cbf009042010`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/Assets/_Project/Scripts/QA/Px628PressDriver.cs` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1090 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@dd41969109bfb539ecc43a45794c44db7e3acb59`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/a6a408066b2043380dd687900544c4ee30ad5478e7996d4c971d5ee8e4b2ab1d.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1091 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@4825df564e7a23ab4d500be3772f99d9c56e889c`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/cleanup/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1092 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7d4b4ee04dec9ff925554ce2d2ff8ba2fefca26e`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/dispatch/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1093 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@7af135aba8e4df8aa710c9a90c82a3d8b7c056fc`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/cd0443e1ac0d3e797b92cacab6c9d1ee78c5e2f390c63b04887518a57efab89b.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1094 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@666beeb58f4c9308ddbdcfd9fdcf1efbd4e9bfe1`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/tools/probe-sweep.sh` | 기존 관련 행 #1076(blocked)의 의존성 수동 확인 |
| 1095 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@182f4a77ead82963bff39d3c8d5dc2408e6c5abb`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/83c3e567dd49dc6c5ef98b045be7a959f094671021e400978601ea11533ee964.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1096 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@7a651fc58bba6bf0fefd5fabe3bb107440b8bb20`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/8ae759e87667a1ce6342e50d3b7375da73a0912dbf944149b96545b9e6c65cfa.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1097 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@5f92a4a346364982cf5732e4cd582a8026add726`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/de7a8f8a549cdfe3d850e561d24077a52e9af374447369b5988f1e4123404614.md` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 1098 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@b597c0edf190278afc935cc296eb099af62a5c68`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/0bd8c50974d804301d3dc97bf4b17c2dd91e3fab2dea389d09fdada931577a66.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1099 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@3324282f6923ab0ba2c89ddbab71cc21da75cd46`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/screen-ansi.js` | #1129 pending: grok 원시 캡처로 증상 재검증 |
| 1100 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@e4be8e4413110361362648aabc282c08a8ad89e8`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/c4ada3bc07174a76f3c8f4600f3c65bbdac7d134e3614fa396fd324e3fea6243.md` | 기존 관련 행 #1067(pending)의 의존성 수동 확인 |
| 1101 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@b96e040f1f4480ea845038fe00534910e65e97c9`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/5a9055adb7dd56adc3f5e36717a54d55fe8c20d142aa71991d858c9daef28488.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1102 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@666beeb58f4c9308ddbdcfd9fdcf1efbd4e9bfe1`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/def616df949a983f860efb52ff673cc373e76b48d3eb500baf60fbc072b5326a.md` | 기존 관련 행 #2(pending),#1076(blocked)의 의존성 수동 확인 |
| 1103 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@46b8418dca564a5ce0cbae7dafb8862b5e6106c9`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/38d31c2a919aa18fca9ad44bf870e40aaede53ed8697d572df1ccd673462a7d5.md` | 기존 관련 행 #2(pending)의 의존성 수동 확인 |
| 1104 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/96e47896bbe8ad5c63959bd5905243fc8f2f2abc542fcdddb6e4cc84365999ff.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1105 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@5cc631eb969b52a1d14ac2d58c8ab017d7904281`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-cleanup.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1106 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@96032a141c507fd49cd75cdcd0bb1e15ddd17bf5`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/Assets/_Project/Scripts/QA/HotbarProbe.cs` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1107 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@f83c9d7278ce66406199813173d2865f3cba2786`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/c1ab22f56056fb445db51fc3e7033bcc44c1c55aa7934fa9eefe3212f18632a9.md` | 기존 관련 행 #1076(blocked)의 의존성 수동 확인 |
| 1108 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@2819219c807959dd74ffd90485343e5111dd7102`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/cleanup/cli.ts` | 기존 관련 행 #1111(pending),#527(pending),#534(pending)의 의존성 수동 확인 |
| 1109 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@6e77b058046376f22cb6ebb83d805749a6881e31`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/a01617ae2f2d3b220cc2301721146da0b9192f083b0133b4d9822e1a4f42ea96.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1110 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@f5db05738f53c96e9c9202178fe790c8cada1c01`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/dispatch/cli.ts` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1112 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@b4597bc94a18b089ddc2339674a421fc03ccc915`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/1b248082877f6c635e0fe122b90cdf5acc6944f08e9bebacefc0e1e79f081112.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1113 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@caac40332044c701fd669ad5528a66bc4de3c1c7`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/2d5a0c46eaff3ea73b47f4086c57d7b5e5e6e30b138696bf7316f777b2c71193.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1114 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@da23c03fbddd2d43092ccb6f00c14bbe70566231`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/dispatch/run-all.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1115 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@2a8f1d0e2bc0d76af0c87cf72e0de4c9f167c403`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/0bcc13d7f42a313de9c4ad72d18ba053505cb4a3721def4f85149674423955e9.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1116 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@707120159976b4f7bf7ece6df7b4ce16d13f5c7c`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/04f8bbdfd063354770ad5885c25f75838687300b7246e732089463f2b6bbf810.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1117 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@6ee78678735c927f4231361dac1a6c219ae181c1`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/71417822ee68174f8d4162bc18fce086b255d2d83db70a7e3ff6a9cb0a68fe51.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1118 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/51f734f4f6fbbd6246f0bcf8ac70ae53c306e95e46a7be812d3e088322264030.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1119 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@e7e809871edec997e25bed82ff6e049416d8b044`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/b348e77b44960d48dfee2fe92153c928abbf48f300665a0e6e67580abf996cc5.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1120 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@c504f894f3c7025d8f5ad54c45c748036012d99b`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/e5f68cdd5dd4e50ebc5b0a57c3978e458817696a88caebe47449e7491211373e.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1121 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@c5f2219672c9e810e32cfbfb13e6365ccbd4c102`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/e0834c25e8d567ab26edd9419e2711be74a877bd0644cedeb30c96a382e89370.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1122 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@b08e244ed636e0ae293f9e0c8dde2aac41323d9f`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/completion-observation.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1123 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@b4f1bd7e35647ad58d6a4ec46a5a6c6c6fd9c74e`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/01504318e7ec23751381061a7d8fe3205b5573e83f79743f01d15bf781fabaf5.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1124 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@6221254ebd07d34eaf54377458ab5e7ad0581d56`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/bind-port.js` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1125 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@d4621417e98a9984f827e4ac352cbd67b340984d`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/1ad2d426cfc3ca2a60872af6d187906bc827e9452a6ec338ff4a6612dc98f406.md` | #1125: item 4 보류; 후속 별도 ID 확인 안 됨 |
| 1126 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@a79aca9583352ccdd91c5239c69762400d00d734`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/ee93526229107f57c477e26ad242f26b24ea4ef403e9bccd2b0549210edd6c3c.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1127 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@499dd57ca8494aaa316fc06a3a6cf25e97356d77`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/b0e1ba8285150d69bc6c7e3999d33049e00962f12ef6aeb4703d70c1a5f39c7f.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 1130 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@499dd57ca8494aaa316fc06a3a6cf25e97356d77`; L1 경로 존재: `/Users/duckyoungkim/.telepty/shared/c4ba6e693b88c26bec5e67bf008c92751bc795e19b77cdbedf0a73b1c198b358.md` | #1130: 배포는 장부 주장; 현재 데몬 활성화 미측정; #1129 |
| 1131 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@8120836aeb91a5c1d6ddd884dd76b1378b84948c`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/orchestrator-boot.sh` | #1131: 실제 부팅·신규 설치·역할 로딩 미측정 |
| 1134 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@4c566c36fcd6dd81ed1558be60516b2546f81ec7` | #1132: PhantomProbe 후보 런타임·씬 의미 동등성·최종 수락 |
| 1135 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@0541a29adacedf57443a6c347188fc5d900d0f1a` | #1136·#1133: 분석 후 구현/설계 소관 |
| 115b | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=115b (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 515b | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=515b (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 516b | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=516b (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 517b | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-telepty/src/submit-gate.js` | 기존 관련 행 #528(pending),#743(pending)의 의존성 수동 확인 |
| 522b | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@329324004076c9474eb89200d6eea18014da0774`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/tests/dispatch/T23_workspace_host_adapter.sh` | 기존 관련 행 #522(pending)의 의존성 수동 확인 |
| 524b | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/session-reconciler.sh` | 기존 관련 행 #796(pending)의 의존성 수동 확인 |
| 528b | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch-tracker.sh` | 기존 관련 행 #528(pending)의 의존성 수동 확인 |
| 529b | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=529b (장부만; 독립 증거 미확인) | 기존 관련 행 #528(pending)의 의존성 수동 확인 |
| 642.2 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@de88a961842b84feae8c1d1495c11e2e80b4e5ac` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 646-x1 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=646-x1 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| 650.1 | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-05-ecosystem-clean-repos-fable5.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| 690.1 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-orchestrator@80ec09a248b7bcf33a558f81ed484462e2bcdd2f` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| ah-art-pass | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@4ca8f6afc520e79cbf92a22366a887268d877b9c`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/docs/art/asset-kit.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| ah-fix-anchor | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=ah-fix-anchor (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| ah-fix-black | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=ah-fix-black (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| ah-game-overall | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@9924d405eff7afb5e3708b8908857baa2564e53e`; L1 경로 존재: `/Users/duckyoungkim/projects/animal-hospital/docs/SPEC.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| ah-m5 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=ah-m5 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| ah-m6 | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/animal-hospital@fb75cc39697bc4b8f3c664ab7db0593567db20ef` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| ah-rebuild-clean | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=ah-rebuild-clean (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| aigentry-ecosystem-analysis | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| fable5-safeguard-fallback-investigation | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=fable5-safeguard-fallback-investigation (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| s3-dispatch-surface-incident-recovery | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=s3-dispatch-surface-incident-recovery (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| sec-telepty-loopback-auth | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@850d79179291386a0cb1594a593bcfdf3fb182db`; L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| spawn-statusline-model-unify | done | RECORDED_DONE_EVIDENCE_LOCATED | L1 경로 존재: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/dispatch.sh` | 본문·완료 범위 대조 필요; 실행/배포/수락 미검증 |
| syc-05 | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=syc-05 (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| syc-05-poc | done | RECORDED_DONE_UNVERIFIED | L0: `5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json` id=syc-05-poc (장부만; 독립 증거 미확인) | 명시적 미검증: 원 증거 회수 후 판정 |
| ux-public-front-door | done | RECORDED_DONE_EVIDENCE_LOCATED | L2 객체: `/Users/duckyoungkim/projects/aigentry-telepty@60d3918aa16c2ff21f766caf7555635d726082b3` | 기존 관련 행 #643(awaiting-user),#644(pending),#367(pending)의 의존성 수동 확인 |
