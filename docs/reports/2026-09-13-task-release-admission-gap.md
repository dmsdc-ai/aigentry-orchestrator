# #1150 태스크·릴리즈 실행 진입 감사 — rb1150-v1
판정: 실제 task 바인딩 일부는 연결됨. task+release 전 구간 강제/완료/설치 수락은 입증되지 않음. 아래는 구현 제안이며 r2 승인·대체 전역 설계가 아니다.
측정: 2026-09-13T03:18:28Z UTC, `/Users/duckyoungkim/projects/aigentry-orchestrator` 실제 작업 파일. HEAD로 dirty 내용을 대체하지 않았다.
범위: 파일명 rg 선행; 코드/config/test 15개 내용 확인, 릴리즈 계획과 보존 tb1150 r2는 별도 참고 문서이며 r2는 현재 사실 근거가 아니다.
`.github` 부모 열거는 Operation not permitted. controller 안내 후 정확한 `.github/workflows` 열거 3개 및 release.yml 읽기는 성공; ci.yml 내용은 파일 한도상 미측정. 아래 SHA256은 읽은 파일의 후속 해시이며 원자 snapshot 보장은 아니다.

관측된 실제 호출·공백:
- `bin/dispatch.sh:37-46` → compiled `src/dispatch/cli.ts`; `bin/init/manifest.mjs:29`가 shim을 배포 목록에 포함한다. shim 존재만으로 의미 검증은 성립하지 않는다.
- `src/dispatch/cli.ts:1012,1059,1081,1091,1115`: taskGateCheck → spawnWorkspace → prepareEffectiveRef → beginDelivery → inject. effective ref 준비는 아직 spawn 이후다.
- 같은 파일 `:490-496,537-545,603-640`: task id/상태 검사, caller env queue와 warn/off, 자유문구 --no-task 예외가 남는다. release/repo/operation/revision/폐기 검사는 이 gate에 없다.
- 단, --no-task가 최종 실행에 성공한다고 단정 불가: `:932` loadWorkerScope와 `:1021,1083` assertConfinedTarget/stageWorkerRef가 task 일치를 별도로 요구한다.
- `src/session/worker-sandbox.ts:9-31,57-73,191-214`: typed scope의 task/sid 검사, manifest attempt/hash와 running receipt 비교가 실제 호출된다. 과거 “task 전파 없음” 주장은 현재 틀리다. release/operation 및 binding 폐기 세대는 없다.
- `src/dispatch/cli.ts:838-859` registry 전달 argv에 task/release/worker attempt가 없고, `:648-699` ledger는 inject 뒤 queue 전체 read-modify-rename와 상태 승격을 수행한다. atomic rename은 동시 writer 손실을 막지 않는다.
- 재전송 production 호출 2곳: `src/tracker/cli.ts:543`, `src/reconciler/cli.ts:519`는 --no-task를 사용한다. 원래 binding 재검증으로 바꿔야 하며 현재 sandbox 거부 가능성도 회귀 대상이다.
- 보고 수집 호출: `src/reconciler/cli.ts:1281` → tracker report-sweep (`src/tracker/cli.ts:894`) → `src/tracker/report-sweep.ts:239`. `:208-220,281-333`은 헤더/track 분류·복사·cursor 저장이지 인증된 sender/task/release 완료 수락이 아니다.
- `src/tracker/cli.ts:655-725`는 transport observation을 기록하고 불명확하면 HOLD한다. `bin/dispatch-registry.py:228-233,459-461`은 outcome unknown/null만 허용하며 session_epoch도 null이다. raw REPORT/활동/전송 rc 8은 완료 사실이 아니다.
- `rg --files bin src tests` 결과에서 queue-task-binding, workflow-task-writer, tq-write, release-manifest/schema 이름 후보는 0개. 측정 호출에도 해당 writer 연결 없음; 전체 저장소/숨김 파일 부재 주장은 아니다. 구 helper의 새 task 생성 능력도 확인되지 않았다.
- `package.json:11-14` build/prepack/test 명령에는 task/release 검증이 없다. `tests/packaging/smoke-init.sh:38-51,157-159`는 tarball build/install 및 dispatch --help 검사; 실제 dispatch admission 수락 증거가 아니다.
- 추가 관측 `.github/workflows/release.yml:17-19,48-63,109-122,170,206,212-247`: v* tag → version 일치 → npm test/dispatch guards/ship-set/smoke → pack/publish → registry SHA1 비교/설치 version 검사. task/release binding manifest 검증 호출은 없으며 설치된 기능 acceptance도 version 확인으로 대신할 수 없다.

최소 실행 가능한 다음 변경(제안; 새 의존성/별도 shell·Python wrapper 도입 없음):
1. #1150 coder가 #652 소유자와 직렬 통합하여 `src/session/worker-sandbox.ts`의 기존 WorkerScope/WorkerManifest 및 검증 helper를 확장한다. `src/dispatch/cli.ts`의 main/spawnWorkspace/stage 직전에서 같은 helper를 사용한다.
2. 최소 binding: schema_version, task_id, release_group, target_release_ref, repo_id/component, binding_revision; 실행에는 sid+실제 worker attempt+operation+phase, effective_ref_sha256. 기존 task 필드는 명시 변환하며 두 독립 진실값을 두지 않는다.
3. #1136의 가장 작은 선행물은 신뢰 workspace에 연결된 단일 typed 상태 writer의 create-task/bind-target/claim/revoke/dispatch-stamp와 revision CAS이다. release 대상의 open/closed/revoked 상태를 같은 검증 경계에서 읽고 임의 env 경로는 권위로 인정하지 않는다.
4. 위 writer가 측정 경로에 없으므로 schema 필드만 추가해 NOW 활성화 완료를 주장할 수 없다. 먼저 create/bind 및 ledger 단일 writer 전환을 구현·검증하고, 이어 dispatch gate를 활성화한다. 전역 설계 재승인·모델/phase별 승인 루프는 필요 없다.
5. spawn/재사용/ref staging/delivery의 각 효과 전에 누락·wrong task/repo·stale revision·closed/revoked target을 거부한다. 원본 ref만 해시하지 말고 effective ref 준비를 spawn 앞으로 옮겨 그 bytes를 고정한다.
6. 검사와 효과 사이 revoke 경쟁을 숨기지 않는다. writer의 예약/소비 상태 전이와 effect 연계를 정의하고 crash는 unknown으로 보존; 이미 전달된 작업 취소는 #652 실행 경계와 연동 전에는 보장하지 않는다. 일반 off/warn/--no-task 우회를 실행용으로 두지 않는다.
7. #1150이 `bin/dispatch-registry.py` 기존 transaction에 binding back-reference/attempt/operation을 보존하고 tracker/reconciler 재전송 2곳이 원 binding을 재수락하게 한다. dispatch dedup과 report idempotency는 별도이며 SID 재사용은 새 attempt로 fencing한다.
8. #1170 의존: 인증된 transport sender 또는 검증 가능한 서명과 sid/attempt/operation/task/release를 결합한 report_id+payload SHA를 수락한다. 복사된 출력은 evidence-only; 동일 id·동일 hash 재수신은 무효과, 동일 id·다른 hash는 거부. receipt와 semantic ACK를 분리한다.
9. 완료 record에는 phase/outcome, evidence URI+SHA256, source SHA를 둔다. dirty 소스는 commit SHA 외 파일 hash 집합으로 식별한다. 검증자가 evidence를 수락해야 task accepted; registry unknown 제한을 우회해 lifecycle을 완료로 재명명하지 않는다.
10. #1171 integrator가 release 수락을 소유: release_group 아래 repo/component별 target을 두고 planned → included → released → installed-verified를 별도 증거 상태로 관리한다. 모든 package를 0.2.2로 강제하지 않는다.
11. artifact identity는 package/component+version+tarball SHA/integrity+source manifest SHA; included는 candidate 포함 검증, released는 배포 증거, installed-verified는 그 정확한 artifact의 설치 수락으로만 승격한다. doc/evidence-only task는 non-shipping 사유·그룹 참조를 명시하며 가짜 shipped code를 만들지 않는다.
12. 유한 migration: 구 schema를 backup 후 신 schema로 1회 변환, task id/status/note/pending work 보존, unresolved binding 명시. 신규 실행만 재바인딩까지 거부하며 과거 실행권을 복제하지 않는다. 실패 시 원본/증거 보존과 rollback 가능해야 한다.
13. bootstrap의 create-task/create-target은 실행을 내포하지 않는 제한된 동작으로 허용한다. status/help 및 기존 attempt의 자원 회수·복구는 release 선행조건 없이 가능하되 arbitrary ref/command/spawn을 받지 않는다. queue 손상도 일반 bypass 근거가 아니다.

최소 재현·수락(전부 제안, 이번 단계 실행 0):
- #1150 tester: T149(`:78-90,104-164`) 실제 shim fixture를 확장해 missing/stale/closed/revoked target, wrong task/repo, forged env, 중복 task를 검사하고 실패 시 spawn/inject/queue 변경 0을 확인한다.
- T150(`:32-52`) 성공 dispatch ledger fixture에 binding 왕복·동시 revoke/stamp 손실 방지·기존 unrelated row 보존을 추가한다. fresh/reused/retry 모두 실제 `bin/dispatch.sh` 경유, 순수 helper test만으로 종결하지 않는다.
- report 중복/위조 sender/다른 attempt, spawn 후 실패·delivery 기록 후 crash·ACK 유실·재시작을 재현한다. unknown 유지, 중복 효과 0, safe cleanup 성공 및 non-shipping task accepted/미출시 구분을 검사한다.
- runner: `tests/dispatch/run-all.sh:180`는 T*.sh만 실행한다. TS T149/T150는 별도 Node test 대상; `package.json:14` npm test는 scripts/run-tests.mjs로 위임한다. release.yml:110,114가 두 runner를 호출하지만 TS 수집 script 내용은 미측정; tester가 등록/실행 증거를 남겨야 한다.
- #1171 tester: 기존 smoke-init.sh에 위 admission fixture를 설치 workspace shim/실제 tarball 기준으로 이식하고 개발 checkout fallback을 차단한다. init/upgrade 중단·복구·pending 보존·non-shipping·정확한 tarball hash와 component target을 검사한다.
- package/manifest ship-set에 compiled helper 및 참조 자원 포함. #1171은 실제 release.yml의 pack 후/publish(:206) 전에 task/component target·포함 증거·동일 tarball 검증을 연결하고 post-install(:236)에 기능 acceptance를 추가한다. 실패 시 publish 또는 installed-verified 승격을 막는다.
- Advisor 기본 ON/proposal-only, Loop 기본 OFF·명시적 양의 활성화 필요. #1165 server-first 추가 작업 및 #1171의 기존 다음 릴리즈 범위는 보존한다.

릴리즈 pin: main package.json:3=0.2.0; release-1171/package.json:3=0.2.1 실측. 계획 :109-119의 0.2.2는 예정이며 실제 publish/설치 버전·artifact hash는 미측정이다.
현재성 SHA256 (상대경로는 실제 main 작업 디렉터리 기준):
- src/dispatch/cli.ts — ae04bc89e903187978b9777910be3ad3147248f92f3857904130ebf738b41072
- src/session/worker-sandbox.ts — 833278a553af9874cbc466ecfd5d33a0b1b15e579675924b2af9da649c8d11ad
- src/tracker/cli.ts — b2249eb9aee3cd2d24ea18238d2273ab19aff1cb84fa1d29d7a352a3bf3c31db
- src/tracker/report-sweep.ts — 399e24d5cd771aa1d99a430aeaee5a36c3e12d7cc8be7335328b08f1e2d13c51
- src/reconciler/cli.ts — 2bcd5716a8c3ee8dbe99f0a8818eeb1a1b3356567f8c9cf59f6184dcff9ec34b
- bin/dispatch-registry.py — 67f531ef94ef5a40632ced44b927b1968047734244bb911bfe5e80aa9c10b9e2
- bin/dispatch.sh — 150019c9266db514802f331bc2c80aea20f1f7b254210f25c7f8e5a13954829d
- bin/init/manifest.mjs — a28f5b338d68408b2370876cdaf4ed21b873a4203f0f86405ff936a6281c14a4
- package.json — 7fd2b027d604501185ffc6bbe577643011b1fef3760d5a5933b6668c8ea09cff
- tests/dispatch/T149-task-gate-duplicate-id.test.ts — 1725dbb03f235aeac3619920716461b9b9d5cf6663f7a4734ccf771bae2f5197
- tests/dispatch/T150-task-ledger-queue-shape.test.ts — e816dcd2051f485d8e6abcc4085d3f6d06640197bcf1e79675c386dd47257149
- tests/dispatch/run-all.sh — 0ab1318339f2205fc07ee6aeeb46302322799db0044cd655be7c396c8709598e
- tests/packaging/smoke-init.sh — cf6d9e3dd341d7ff6858a21b16afd60e902b601ea80eee2c6d4899e3f1b821e9
- docs/reports/2026-09-12-orchestrator-install-parity-release-plan.md — 3f764b2ddbd7c0560b1525efc8ae8d36a6e6b0a42e8652a5aedd1e1a5ad0323e
- /Users/duckyoungkim/.aigentry/worktrees/release-1171/package.json — 46c09bc84dec07184c3b00d8dcdba3c1d08906dc89784e13788f9c2a2a55900d
- .github/workflows/release.yml — 6913e6b6d51ddfa831491baf165a8c3bd3a3a01929d31b601180d6547d2a23c2 (controller 안내 후 추가 측정)
코드·Git·스크립트·build/test/app·설치·네트워크 실행 없음; Markdown만 변경, Snyk N/A. #1150/#1171은 열린 상태이며 후속 구현/dispatch를 시작하지 않았다.
