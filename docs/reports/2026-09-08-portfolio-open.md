# 전체 포트폴리오 미완료 증거 감사 — 2026-09-08

기준의 미완료 357건을 모두 분류했다. **지금 필요한 것은 보고 전달·진행 중 생산화의 수용 검토·게임 후보 검증이며, 오래된 작업을 일괄 구현하거나 취소하는 것이 아니다.** 아래 ACT_NOW는 당장 수행할 분석/검토/선행조건 확인을 포함한다. 구현·배포·취소 승인으로 해석하지 않는다.

## 측정 범위와 정산
- 고정 원본 Q: `/Users/duckyoungkim/.aigentry/worktrees/qa1137`에서 `git show 5301d96d743c23b9f0c2578c6c9afc2cb3bf3632:state/task-queue.json`을 Python JSON 파서로 읽었다. Q#ID는 그 파일 `tasks` 배열의 해당 ID를 뜻한다.
- 전체 1136행 = done 776 + cancelled 3 + 대상 357. 전체 ID를 `str(id)`로 정규화하여 1136개 고유, 대상 357개 고유를 확인했다. `syc-01`, `697.1` 등을 정수 변환/누락하지 않았다.
- 대상 상태: pending 298, in_progress 21, delegated 9, blocked 10, blocked-by-observation 10, awaiting-user 9. 합계 357.
- 분류: ACT_NOW 10, NEXT_DEPENDENCY 53, KEEP_BACKLOG 146, MERGE_CANDIDATE 0, OBSOLETE_CANDIDATE 2, ALREADY_DONE_CANDIDATE 2, UNKNOWN 144. 분류 합계 357. 부록 행 ID 집합 = 대상 ID 집합, 중복/누락/초과 0.
- 실시간 읽기: 2026-09-08T13:22:30Z main `59166914eddcbf535063f7dbac64c56b58e397ec`, 13:24:08Z `ae60ab982a063bc34b64e328347c4952cbc0dc37`, 최종 2026-09-08T13:27:38.002686+00:00 `ec77db07c06429e5e00d3ceedda86e7ebf646a81`. main 경로 `/Users/duckyoungkim/projects/aigentry-orchestrator`.
- 최종 live queue 1138행. 고정 원본과 달라진 ID: 1133, 1136, 1137, 1138. #1137/#1138 감사 작업은 분모에서 제외; #1136 delegated 유지, 노트만 변화. 기준 ID 삭제 0건.
- 13:24:08Z main은 기준의 후손이며 차이 파일은 `state/task-queue.json` 하나였다. 아래 orchestrator 소스 관측은 따라서 기준 소스와 동일하다. 최종 재확인은 검증 기록 참조.
- `state/dispatch/active.json` generation 16070: 84 assignment 행, cleaned 77 / delivery_attempt_started 6 / superseded 1. 이는 태스크 수나 완료 수가 아니다. #1128 및 #1132의 cleaned 행도 outcome=unknown이다.
- 13:22~13:23Z `telepty list` 로컬 관측은 orchestrator, mr1133-architect, wf1136-architect, qa1137-analyst, qa1138-analyst 총 5 CONNECTED. 과거 워커의 부재는 작업 완료 증거가 아니다. 다른 호스트·PID 전수 조사는 하지 않았다.

## 우선 10건: 다음 행동이 준비된 순서
우선도 라벨을 점수로 쓰지 않았다. 오늘 사용자 약속·현재 장애 영향·차단하는 후속 범위·증거 신선도·즉시 가능한 다음 행동을 함께 비교했다. 6~7번은 오래된 자료라 현장 확인의 우선순위이며 구현 우선순위가 아니다.

|순위/ID|현재 영향·선정 이유|구체적 다음 행동 / 의존|담당 역할|승인 경계|신뢰|
|---|---|---|---|---|---|
|1 #1136|오늘 생산화+설치+README 약속, 여러 후속 writer/cleanup 영향|8b19bf9 수정 스펙의 호출자 오류와 settlement 보존 검토; #1133 공용 파일 순서 확정|orchestrator→architect|기존 약속 재승인 불필요; 구현 SPEC 수용 필요, live 자동 교체 금지|높음(소스), 중간(수용)|
|2 #1128|오늘 4 HOLD 장시간 지연 분석, 모든 보고 경로 영향|완료된 진단에서 isolated tester 재현/알림 계약으로 진행; sweep 수집과 턴 통지 분리|tester→architect|현 운영 데몬 재시작 없음; 재현→승인 SPEC→구현|중간(B1; 원로그 미재계수)|
|3 #1133|오늘 router 생산화 약속; capacity/대체 선택은 모든 spawn 영향|진행 중 architect 수정본 회수·원자적 count/claim 및 전체 요구 입력 확인|architect→orchestrator|현재 cap 정책 유지; 구현은 SPEC 수용 뒤|높음(기존 소스), 중간(수정본)|
|4 #1132|아이에게 전달할 build #6 후보, 테스트 완료와 제품 수용 사이 갭|PhantomProbe 계측을 점수화할 TC와 object-reference 보존 장면 비교 범위 정의|architect→coder/tester|후속 범위 확정; live 교체 별도 사용자 승인|중간(B2)|
|5 #1076|사용자가 직접 겪은 E 입력 장애가 상위 요구|#1132 검증 후 실제 누름/거절 이유를 구분하는 재현·로그 수용|analyst/tester|원본 save 보존, 실행/교체 승인 경계 유지|중간(B2+Q)|
|6 syc-04|실사업 수주/출고 양쪽 차단, 회계·증거·카메라 10결정|기영용 결정표 최신화, D-06/07/08부터 현장 확정|orchestrator+현장 사용자|연락·운영 정책 변경은 사용자 몫; 분석을 승인으로 확장 금지|낮음(Q, 6월)|
|7 syc-07|수집 플랫폼이 미정이라 syc-06 구현 차단|Windows PC 접근 준비 사실 확인 후 기존 3프로브 결과 회수 계획|logger/tester|접속정보·로그인 사용자 제공; 원격 실행 이번 감사 제외|낮음(Q, 7월)|
|8 #534|부모만 TERM하는 코드가 여전; cleanup 확장 전 자식 누수 위험|현재 launcher에서 자식 생존 격리 재현 계약; #1136 cleanup과 인터페이스 조율|analyst→tester|kill/cleanup 실행 금지, 승인된 재현 범위로 이관|중간(A5, 실생존 미측정)|
|9 #895|aterm 버전 문자열 불일치가 공유 telepty restart로 이어짐|양방향 mismatch와 비소유 데몬 조건 격리 재현; 소유권 보존 remediation 검토|analyst→architect|실사용 데몬에 재현 금지|높음(A6 소스), 런타임 미측정|
|10 #782|aterm 배포 기준 branch 표류 주장은 릴리스 증거 신뢰 차단|main/작업 branch ancestry와 미병합 변경 대조부터 수행; #52/#352와 범위 연결|analyst→orchestrator|이 감사는 병합·branch 제거 승인 아님|낮음(Q; HEAD만 측정)|

## 이미 끝난 것·불필요 후보·기존 위임 정리
- ALREADY_DONE_CANDIDATE #499: 현재 `bin/boot-prepare.mjs`에 #532 additive codex/gemini sandbox 경로가 있다(A2). 기존 “claude-only” 전제는 현재 소스와 다르다. 이번 세션도 codex role sandbox로 부팅됐지만 Gemini runtime 검증은 하지 않았다. 원래 수용조건 대조 후 큐 종료 후보.
- ALREADY_DONE_CANDIDATE #638: 목표가 원작 패리티 **감사**이며 game main에 감사 보고서와 갱신 카탈로그가 존재한다(B2). 구현 전체 완료 주장이 아니다. 남은 게임 요구는 #628/#949 등으로 유지.
- OBSOLETE_CANDIDATE #643 → 생존 #728: 같은 Show GN 게시 목표·같은 초안 경로를 후속 #728이 직접 `#643 계열`로 명시한다(Q). 오래돼서가 아니라 중복 목표와 후속 이력 때문에 합치기 후보. #728 제목의 전 게이트 완료와 후반 노트의 CI red는 시점 차이이며 현재 게시/CI는 미확인.
- OBSOLETE_CANDIDATE #743 → 생존 #904(done 수집 구현) + #1128(미해결 전달): A1에 durable pull과 reconcile 호출이 존재한다. “새 sweep 추가” 범위는 중복, 오케스트레이터 턴까지의 전달 잔여는 #1128로 보존해야 한다. 일괄 해결/취소 근거로 쓰지 않는다.
- #45 → #63, syc-06 Android → syc-07 PC는 **조건부 대체**다. 선행 결과가 없으므로 불필요 후보로 올리지 않았다. #662/#668 archive, #660 dead-code 주장도 소비자/대체 소스 미검증이라 삭제 근거가 아니다.
- delegated 9건: #20/#28은 동일 옛 dustcraw 세션명만 있고 산출물 미검증(보존); #608은 Phase2 landed 주장·Phase3 잔여; #795는 리뷰 완료 주장·R5/SSOT/W2 잔여; #638 감사 종료 후보; #1128 진단 종료/전체 fix 미완료; #1132 빌드·검증 단계 종료/제품 수용 미완료; #1133/#1136는 현재 architect 유지. 재스폰이나 cleanup을 하지 않았다.
- in_progress 21건 전부 부록에 유지. #298 phase1, #430 P1/P2, #436 R5a, #440 4/5 repos, #52 macOS만 완료라는 기록은 부모 완료가 아니다. #323/#493/#495/#511/#599는 현재 완료 아티팩트 미검증; syc-00/01/02/06은 현장 게이트 잔여; #628/#949는 게임 에픽; #484/#672/#683/#701/#766은 자산·매트릭스·공개정책·배포·interactive 검증 각각 잔여.
- awaiting-user 9건도 같은 대기로 묶지 않는다: #586 설계결정, #593 WIP 소유, #595/#596/#598 사업 채택/인간 세일즈, #643/#728 게시, #697.1 계정 UI, #789 credentials가 서로 다른 경계다. #789 npm 완료 기록이 있어도 signaling deploy가 남는다. 기존 승인 유무를 큐 밖에서 전수 검증하지 않았다.
- MERGE_CANDIDATE 0: 이번에 확인한 두 종료 후보는 main 소스/문서에 이미 있고, #1133/#1136는 아직 검토 중이다. 검증 없이 오래된 branch를 병합 후보로 부르지 않았다.

## 직접 읽은 증거와 미측정
- A1: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/reconciler/cli.ts:1268-1287`, `src/tracker/report-sweep.ts:1-50`. source-level 호출·inbox-first/cursor-second 구현 확인. 설치된 dist와 live tick 실행·4건 원로그의 시간 재계수는 미측정.
- A2: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/boot-prepare.mjs:516-519,626-655`, #532 additive role-context 경로. 소스 존재는 독립 runtime 전수 검증이 아니다.
- A3: `/Users/duckyoungkim/projects/aigentry-orchestrator/package.json`, `.github/workflows/release.yml`, `README.md:28`. manifest 0.2.0, Node>=20, darwin/linux, prepack build, tag pack/publish/registry-sha/clean-version 검증 경로 존재. README는 unpublished. **현재 registry·tarball closure·fresh HOME init/upgrade/uninstall·실제 installed workflow는 미측정**. 존재하는 workflow를 이미 실행된 릴리스로 해석하지 않는다. #1136에서 원본 README template/generated 모두 검증해야 한다.
- A4: `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/model-router.mjs:8,60,94`, `src/dispatch/cli.ts:445,707`. 4096-byte 입력과 emergency fallback 및 queue rename 확인. capacity 전체 race·dist 호출 경로는 미측정.
- A5: `/Users/duckyoungkim/projects/aigentry-orchestrator/src/cleanup/cli.ts:364-404`. parent PID 하나에 TERM, 자기/조상 보호 존재. 주석의 자식도 죽는다는 문장은 실측 증거가 아니다. #534 과거 재현은 Q 귀속.
- A6: `/Users/duckyoungkim/projects/aigentry-aterm` HEAD `9b4cec5878ac48dec10c09e71a58918a3cc9c89c`, `aterm-core/src/telepty_bridge.rs:94-103,191-196`. inst!=dmn이면 `telepty daemon restart`; #895 현재 코드 확인. branch drift, 릴리스, IME·보안 잔여는 미검증.
- B1: `/Users/duckyoungkim/.aigentry/worktrees/in1128/docs/reports/2026-09-08-in1128-inbound-loss-analysis.md` @ `867fe3be73756ecde6b39495d9e7ea1b81de8e7c`. 첫 verdict/provenance 직접 읽음. 0바이트 modal park→TTL 폐기, 수집 20~61초라는 **보고서 귀속**; 원장 자체를 이번에 다시 세지 않았다.
- B2: `/Users/duckyoungkim/projects/animal-hospital` HEAD `fe904606737f348f2a3d0ec6de5acb46b7aea479`; `docs/reports/2026-08-22-parity-audit.md` 원작성 commit `0eaf763a8b90ae320bcd90737901fce182033908`, `docs/reference/namu-wiki-animal-hospital.md`; `docs/reports/2026-09-08-ah1134-build6-verification.md`의 provenance·장면 동등성 정정·probe 범위를 읽었다. 빌드 후보/177파일 재해시, suite 재실행, 게임 실행은 하지 않았다. #1134 후속 4-suite 완료는 Q 노트 귀속.
- B3 live delta: `/Users/duckyoungkim/.aigentry/worktrees/wf1136` HEAD `8b19bf979ad042e0755f85db97e2a71eee10a063`; shared `/Users/duckyoungkim/.telepty/shared/8cb29c95f32128d9061e1ae576b85ff4c7b563f27c4e0a86455761626eed0b7d.md` 읽음. 사용자도 수신 사실을 제공했다. **수신 ≠ 승인 ≠ 구현**. “report-sweep NO production caller”는 A1과 충돌; 13:23경 상위에 inject `5cdc6a50-f4d6-4dea-aa89-357e1c17451c`로 전달. source caller 존재와 turn announcement 미검증으로 구분한다.
- 참고 HEAD만 측정: `/Users/duckyoungkim/projects/aigentry-telepty` `997ea7c7d98b1dbc420e2e6de95d455a150e1b2c`. #417/#455의 옛 release hold를 버전 상승만으로 해제하지 않았다. 원격·npm·Windows·외부 이슈 상태·Obsidian/현장 자료·전 repo dirty 상태·보안 취약점 재스캔은 미측정이다.
- 증거 등급 A=현재 코드 직접 읽음(런타임 보증 아님), B=실제 산출 문서 읽음(내부 주장 재현 아님), Q=고정 큐의 기록만 읽음. Q행에는 산출물 미검증을 명시한다. 높은 영향이 의심되는 #652/#817/#821/#889 등도 현재 재현 증거 없이 확정 장애로 순위 과장하지 않았다.
- 문서만 작성했다. 소스/설정/큐 수정, 테스트/빌드/설치/네트워크 probe/라이프사이클 동작 없음. Snyk N/A(실행 코드 변경 없음). 검증은 JSON 집합·분류 정산·보고서 유일 변경·Git provenance 확인이다.

- 최종 검증 스냅샷 2026-09-08T13:28:40.973101+00:00: main `a35c66894f4034fcec8f93bd2271183657f96047`; 기준 대비 변경 파일은 `state/task-queue.json`, `docs/reports/2026-09-08-portfolio-closed.md`뿐이다. 기준은 main의 조상이며 소스 변경 없음. live 1138행, 상태 {'done': 777, 'pending': 298, 'delegated': 10, 'in_progress': 21, 'blocked': 10, 'cancelled': 3, 'blocked-by-observation': 10, 'awaiting-user': 9}; 변경 ID 1133, 1136, 1137, 1138. 위 첫 live 관측과 구분하며 분모 357은 유지한다.
- 후속 정정 B3: wf1136 `80ad144d87a761b1c750a58866e4b9956c1db4a1` HEAD 확인, shared `/Users/duckyoungkim/.telepty/shared/9e466d4bc1f5929efbfb1787614d3311712c1e34f753c42979ab8d72f330eeff.md` 수신 보고 읽음. 작성자가 기존 호출자 부재 주장을 철회하고 grep→head 절단을 원인으로 밝혔다(작성자 귀속). A1 직접 소스와 일치한다. **정정 수신만 확인; 구현 GO 없음.** 1순위 다음 행동은 정정 반영 확인 후 나머지 수용 검토다.
- 후속 수신 B4: mr1133 HEAD `bec82eb98b3ea824cdf5a0de6761e10378a36dff`, shared `/Users/duckyoungkim/.telepty/shared/fb11e1df8cb4b6d661f0042b7f07f5fc698d46033cda7a56283fa068f00d059f.md` 수신 보고 읽음. 1150-line spec/default cap 보존은 수신 보고·사용자 정보에 근거한다. 전문 1150행 재검토는 하지 않았다. 보고의 current-main `bf127a507d9480c7f40ec73c002c06ae9c60dddd`는 과거 관측이며 이 감사의 current-main이 아니다. **검토 대기, 구현/테스트/발행 없음.** 3순위는 이미 받은 수정본 수용 검토로 갱신한다.

## 부록 — 고정 기준 357행 전수
각 ID는 1회만 나온다. 원상태는 고정 큐 그대로다. Q는 반드시 Q#해당ID를 뜻한다. 분류는 분석 권고이며 큐 상태를 바꾸지 않았다.

|ID|원상태|분류|증거 등급/출처|범위(축약)|다음 행동·생존/의존 ID|
|---|---|---|---|---|---|
|2|pending|KEEP_BACKLOG|Q#2|winit Fix 10 검증 — Linux/Windows IME 동작 확인 (macOS는 Swift 전환으로 불필요)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|20|delegated|KEEP_BACKLOG|Q#20|MD 파일 업데이트 베스트 프랙티스 리서치|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|27|pending|NEXT_DEPENDENCY|Q#27|aterm 4플랫폼 IME 전략 — macOS Swift 완료, Linux/Windows winit 검증, Android Kotlin 네이티브. iOS |#2/#309 플랫폼 결정; 현황 별도 검증|
|28|delegated|KEEP_BACKLOG|Q#28|aterm 기술스택 5플랫폼 종합 조사 결과 반영 — dustcraw-gemini 리서치 완료 대기|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|13|pending|KEEP_BACKLOG|Q#13|logger 실시간 모니터링 구조화|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|26|pending|KEEP_BACKLOG|Q#26|aterm iOS Swift 쉘 (UIWindow + UITextInput + tailscale 원격 PTY). 스펙: docs/aterm-5platfo|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|29|pending|KEEP_BACKLOG|Q#29|aterm Android Kotlin 쉘 (Activity + SurfaceView + InputMethodManager). 스펙: docs/aterm-|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|44|pending|NEXT_DEPENDENCY|Q#44|aterm brain 연동 — devkit/aigentry-mcp 경유로 전환. aterm은 MCP 불필요, AI CLI가 직접 연결|#63 통합 재검토; 현황 별도 검증|
|45|pending|NEXT_DEPENDENCY|Q#45|deliberation MCP → aigentry-mcp 통합으로 대체. 별도 등록 불필요|#63 미완료: 대체는 조건부; 현황 별도 검증|
|46|pending|KEEP_BACKLOG|Q#46|aterm 자동 업데이트 — 새 버전 감지 + 업데이트|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|49|pending|KEEP_BACKLOG|Q#49|skill-creator로 work-breakdown 스킬 검증/개선 — eval 테스트 + 성능 벤치마크 + 표준 구조 적용|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|50|pending|KEEP_BACKLOG|Q#50|Research Ratchet 엔진 — autoresearch 패턴 도입. 메트릭 정의 + 샌드박스 + lessons→설정변경→평가→승인/거부 자동 루프|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|51|pending|KEEP_BACKLOG|Q#51|voicecode ↔ aterm 통합 — 음성 AI CLI 제어 + TTS 출력 요약|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|52|in_progress|NEXT_DEPENDENCY|Q#52|aterm 5플랫폼 배포 체계 — npm wrapper + GitHub Releases + CI/CD 빌드 파이프라인|macOS 일부와 Linux/Windows 배포 증거 분리; 현황 별도 검증|
|63|pending|KEEP_BACKLOG|Q#63|aigentry-mcp 통합 MCP 서버 구현 — brain MCP + deliberation MCP 기능을 단일 패키지로. 태스크/교훈/지식 + 토론/|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|72|pending|UNKNOWN|Q#72|퍼블릭 오케스트레이터 폴더 불필요 확정 — orchestrator는 aterm 시스템 워크스페이스이지 별도 프로젝트가 아님. postinstall의 or|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|73|pending|KEEP_BACKLOG|Q#73|에코시스템 가이드를 brain MCP get_ecosystem_guide tool로 제공 — CLI 무관하게 AI가 에코시스템 사용법 조회. CONSTI|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|74|pending|KEEP_BACKLOG|Q#74|aterm 온보딩 Local LLM 지원 — ollama, llama.cpp 등 커스텀 명령 입력. CLI 선택에 Local LLM 옵션 추가|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|76|pending|KEEP_BACKLOG|Q#76|aterm 동적 서브 세션 라이프사이클 — 계층형 WorkspaceManager + 자동 트리거(컨텍스트 폭발 + 작업량 임계값) + 포그라운드 터미널 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|77|pending|KEEP_BACKLOG|Q#77|aterm 하위 세션 태스크 보드 — sub-folder 세션에도 독립 태스크 보드 제공|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|78|pending|KEEP_BACKLOG|Q#78|voicecode ↔ aterm-core FFI 통합 — 모바일에서 음성 프론트 + 터미널 뷰 통합 앱|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|111|pending|KEEP_BACKLOG|Q#111|aterm 386 Retro 테마 — CRT 스캔라인/비네팅/인광 글로우/플리커 셰이더 + 녹색/호박색 모노크롬. Settings 선택 + aterm -|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|16|pending|KEEP_BACKLOG|Q#16|aterm P3 후속 최적화 (inject condvar, IME RefCell, 커서 블링크)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|151|pending|KEEP_BACKLOG|Q#151|온보딩 UX 디자인 리뷰 반영 — design 세션 14개 권장사항 (must-fix 5 + should-fix 5 + nice-to-have 4). 6|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|155|pending|KEEP_BACKLOG|Q#155|bin/aterm inject hook 강제화 — SAWP envelope + lessons 자동 포함 + 영어 경고. aterm이 메인 개발 환경이 될|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|148|pending|KEEP_BACKLOG|Q#148|오케스트레이터 .aigentry 폴더 커스텀 위치 — 기본 ~/.aigentry/, 사용자가 폴더 지정하면 해당 폴더에 .aigentry/ 생성. 폴더 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|147|pending|KEEP_BACKLOG|Q#147|aterm 내부 통신 프로토콜 설계 — WezTerm Mux pub/sub + cmux JSON-RPC + Alacritty 단순성 조합. telepty|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|144|pending|KEEP_BACKLOG|Q#144|SAWP 점진적 발전 — v1: 현재 6-phase prompt 기반 (v0.0.17). v2: 빌드/테스트 결과 파싱 + 자동 에러 분류. v3: 세션|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|141|pending|KEEP_BACKLOG|Q#141|오케스트레이터 전용 폴더 — ~/.aigentry/orchestrator/ 자동 생성. AGENTS.md(지휘자 규칙) + CLI별 MD + .claud|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|137|pending|UNKNOWN|Q#137|세션 응답 vs inject 명확화 — respond/reply=현재 세션, inject=다른 세션. 자기 세션 inject 경고, 명시적 cross-s|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|132|pending|UNKNOWN|Q#132|기존 프로젝트 MD 보고 규칙 갱신 — devkit v0.0.14 rule 15(보고 vs 자유 토론) 반영됐지만 기존 프로젝트 AGENTS.md/GEM|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|125|pending|KEEP_BACKLOG|Q#125|aterm TUI bg 터미널 배경색 자동 조정 — luminance 비교로 유사 bg를 투명 처리. configurable threshold|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|189|pending|UNKNOWN|Q#189|aterm 텍스트 선택 시 추가 음영 아티팩트 — 드래그 시작 시 의도하지 않은 다른 영역에 음영 표시. 복사에는 미포함 (시각적 아티팩트)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|188|pending|UNKNOWN|Q#188|aterm 세션별 CLI 모델 설정 — 워크스페이스별로 다른 LLM 모델 지정. e.g., orchestrator=opus, builder=sonnet,|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|187|pending|UNKNOWN|Q#187|aterm → logger 구조화 로깅 레이어 — aterm이 구조화된 로그를 logger 세션에 실시간 스트리밍. ad-hoc stderr 캡처 제거|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|184|pending|KEEP_BACKLOG|Q#184|IDE/터미널 경쟁 분석 추가 검토 — Antigravity 직접 테스트, Cursor Agent Mode, Zed AI, Windsurf 추가 분석|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|182|blocked|NEXT_DEPENDENCY|Q#182|RTM closed loop 워크플로우 — REQ→SPEC→TC→TDD→TEST 자동 반복 + matrix.json 추적. 프로덕트 sandbox 내 자|#183 완료 기록과 잔여 RTM 계약 확인; 현황 별도 검증|
|178|pending|UNKNOWN|Q#178|에러 자동 보고 hook — 오케스트레이터 외 모든 세션에서 에러 발생 시 자동으로 오케스트레이터에 inject. PostToolUse Bash exit|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|174|pending|KEEP_BACKLOG|Q#174|aterm 화면 내 프롬프트 네비게이션 — 스크롤백 없이도 프롬프트 간 이동. virtual scroll offset 또는 커서 이동 방식|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|172|pending|KEEP_BACKLOG|Q#172|requirements 전용 세션 — 요구사항 정의 (what). 사용자 요청 → 기능 요구사항 + 수용 기준 + 제약 조건 문서화|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|170|pending|UNKNOWN|Q#170|SAWP 위반 — 구현 세션이 cargo test 실행. 빌드/테스트는 builder/tester만 수행해야 함|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|168|pending|UNKNOWN|Q#168|세션 기반 워크플로우 하네스 — state/playbooks/*.yaml로 워크플로우 정의. 오케스트레이터가 step별 세션 inject→보고 수집→다음|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|167|pending|UNKNOWN|Q#167|TASK_COMPLETE hook 오탐 — /clear 후 ref 읽기 사이 일시적 idle을 '완료'로 오판. 세션이 thinking 시작 전인데 TA|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|161|blocked|NEXT_DEPENDENCY|Q#161|aterm 스플릿 pane 아키텍처 설계 — 6개 터미널 벤치마크 기반. 스플릿 resize 최적화 포함|원본 blocked_by 확인 후 설계 재개; 현황 별도 검증|
|191|pending|UNKNOWN|Q#191|Claude Code bypass permissions에서 .claude/ 디렉토리 Write 시 권한 물어보는 버그 — bypass mode에서도 .c|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|196|pending|KEEP_BACKLOG|Q#196|aterm 앱 아이콘 고도화 — 현재 미니멀 쉐브론 v3 기반으로 추가 개선. 그래디언트 정교화, 글로우 튜닝, 다크/라이트 모드 대응, 앱스토어 가이드|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|215|pending|KEEP_BACKLOG|Q#215|#209-6 Linux GLRenderer 구현 — alacritty 패턴 기반 (Phase 2, macOS 완료 후)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|233|pending|KEEP_BACKLOG|Q#233|aterm Pixel Format + Color Space + Linear Correction 묶음 — bgra8Unorm + Display P3 + s|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|234|pending|KEEP_BACKLOG|Q#234|aterm IOSurface 렌더 타겟 — CAMetalLayer → IOSurface + IOSurfaceLayer. triple buffering 재|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|235|pending|KEEP_BACKLOG|Q#235|aterm OpenType 테이블 직접 파싱 — CTFont API 대신 hhea/OS2/head 직접 읽기. Rust 의존성 추가|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|236|pending|KEEP_BACKLOG|Q#236|aterm 프롬프트 위 패딩 — Gemini CLI bg (52,57,66) vs terminal bg (40,44,52) 차이 12-14 unit. P|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|238|pending|KEEP_BACKLOG|Q#238|aterm 세션당 메모리 추가 최적화 — 현재 31MB/세션, cmux 15MB/세션. 2배 차이|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|244|pending|UNKNOWN|Q#244|Claude Code settings.json 회사 맥북용 graceful mute — aigentry-brain MCP 엔트리 비활성화 또는 disab|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|245|pending|UNKNOWN|Q#245|brain 테스트 4개 pre-existing 실패 fix — seamless-setup.test.ts x3 (PlatformDetector platfo|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|260|pending|UNKNOWN|Q#260|Track C: run-once.sh `if !` 패턴 버그 수정 ($? 소실로 timeout rc=0 오염)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|266|pending|KEEP_BACKLOG|Q#266|Track E1: 전체 aigentry 인프라 T1/T2/T3 분류 감사 — skills, helpers(tq-*/open-session/trust-*)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|267|pending|KEEP_BACKLOG|Q#267|Track E2: SSOT 일원화 구현 — T1/T2 항목을 devkit/templates/ 하위로 이동 후 내 환경에서 심링크(α 옵션). 기존 직접 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|268|pending|KEEP_BACKLOG|Q#268|Track E3: Lazy init 메커니즘 — open-session.sh --role X 첫 호출 시 ~/projects/aigentry-{role}|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|269|pending|KEEP_BACKLOG|Q#269|Track E4: 3-tier 싱크 모델 문서화 + 마이그레이션 가이드 — devkit/docs/ecosystem-sync-model.md 신규. 범용 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|270|pending|KEEP_BACKLOG|Q#270|Track E5: 에코시스템 MD Best-Practice 패턴 표준 확정 — architect MD(이번 세션 산출)를 레퍼런스 구현으로 추출. 패턴 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|271|pending|KEEP_BACKLOG|Q#271|Track E6: analyst MD 리팩터 — new pattern 적용. role 특화: Evidence Pipeline, Logger 연동 프로토콜|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|275|pending|KEEP_BACKLOG|Q#275|Track E10: dustcraw MD 리팩터 — 외부 리서치, deliberation-first, 시드 원칙 유지하며 new pattern 적용|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|277|pending|KEEP_BACKLOG|Q#277|Track E12: aterm MD 리팩터 — 주 소비자 프로젝트. 에코 역할 + 제품 자체 문서 이중 성격. aterm invariants/failed|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|279|pending|KEEP_BACKLOG|Q#279|Track E14: Phase A 설문 — 10개 모호 프로젝트 분류. forum/hooks/registry/starter/ssot/design/ampl|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|280|pending|KEEP_BACKLOG|Q#280|Track E15: Phase B 설문 — 암묵지 8 질문. Role 계층/senior-junior 구분, Role별 CLI 고정 여부, 동일 role |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|281|pending|KEEP_BACKLOG|Q#281|Track E16: 설문 결과 반영 — E14/E15 완료 후 architect MD 재검토 (scope 조정 필요할 수 있음), 에코 taxonomy |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|291|pending|KEEP_BACKLOG|Q#291|Track E19: aigentry 에코 taxonomy 수립 — 22+ aigentry-* 폴더를 4개 카테고리로 명시 분류 (role/service/|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|292|pending|KEEP_BACKLOG|Q#292|Track E20: 3-Layer 구조 명시화 — Layer1(SSOT template in devkit) + Layer2(role artifact re|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|298|in_progress|NEXT_DEPENDENCY|Q#298|Track E26: Multi-session + multi-subagent 하이브리드 오케스트레이션 메커니즘 — 현재 수동 패턴 (real coder s|phase1 완료와 후속 범위 분리; 현황 별도 검증|
|309|pending|KEEP_BACKLOG|Q#309|Track E35: aterm cross-OS 전략 결정 — 현재 Swift+Rust (macOS-only). 옵션: (A) Swift-on-Window|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|310|pending|KEEP_BACKLOG|Q#310|Track E36: brain/deliberation/telepty Windows binary 검증 — 이미 cross-OS capable (TS/Rus|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|314|pending|UNKNOWN|Q#314|🔴 C-3 wtm schema migration: save_handoff + init_context을 nested {version,sessions:{}}|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|315|pending|UNKNOWN|Q#315|🔴 C-4 Claude hook fail-soft: pre-compact.sh + session-start.sh가 malformed stdin / mis|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|316|pending|UNKNOWN|Q#316|🔴 C-5 brain binary detection: ctx-router.sh가 aigentry-brain 우선 탐지 + brain fallback. d|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|319|pending|UNKNOWN|Q#319|🟡 H-9 tq-focus.sh에 ctx-router on-tq-transition call 추가 (.active_focus mutation detect|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|322|pending|UNKNOWN|Q#322|🟡 aigentry-telepty upstream PR: shared-ref에 sender metadata 저장 + read API (provenance|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|323|in_progress|NEXT_DEPENDENCY|Q#323|🟡 H-1/H-2/H-3 platform + session-cleanup edge case 강화: stale pid-less lockdir 복구 / bg|실제 lookup 경로 재현; 현황 별도 검증|
|324|pending|UNKNOWN|Q#324|🟡 Docs 정합성 통합 PR: ecosystem-contract.md tq-focus read-only 수정 / multi-exec.md cleanup|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|328|pending|KEEP_BACKLOG|Q#328|🟡 aigentry context-budget skill 설계 + 구현 — Phase 0 구조 감사 (context-manage는 Phase 1 런타임 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|345|pending|KEEP_BACKLOG|Q#345|ν: Chrome CDP --remote-debugging-port 자동 활성화 (deliberation browser-auto-turn 인프라)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|349|pending|UNKNOWN|Q#349|🟡 task-queue.json 추적 디자인 결정 — 현재 state/task-queue.json은 .gitignore 처리 (untracked)되어 c|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|352|pending|UNKNOWN|Q#352|aterm 0.2.15+ release — Swift IME fix BUILT + COMMITTED (d309067, 2026-05-05). Korean|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|353|pending|UNKNOWN|Q#353|aterm IME 회귀 통합 fix — d309067 commit 후속. (a) Shift+Enter modifier flag loss during IM|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|354|pending|UNKNOWN|Q#354|aterm macOS supply-chain 보안 — DeveloperID notarize + npm postinstall xattr -cr quaran|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|357|pending|KEEP_BACKLOG|Q#357|aterm 대형 파일 분할 — AppDelegate.swift 2522 LOC + lib.rs 2918 LOC. AppDelegate: workspace|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|358|pending|UNKNOWN|Q#358|aterm npm/Cargo dependency 업데이트 — vite >= 7.3.2 (HIGH advisory), picomatch HIGH trans|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|359|pending|UNKNOWN|Q#359|aterm Tailscale boundary ADR — tsnet이 aterm-core에 embedded. cross-machine networking은|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|360|pending|UNKNOWN|Q#360|aterm aterm-bridge.h vs cbindgen ABI drift fix — Swift는 hand-maintained header, Rust는|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|362|pending|UNKNOWN|Q#362|aterm 50 unwrap → Result 전환 + Swift fatalError → recoverable error. Production render|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|363|pending|UNKNOWN|Q#363|aterm 2 cargo regressions on d309067 base — empirical 발견 (tester dogfood 2026-05-06):|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|366|pending|KEEP_BACKLOG|Q#366|aterm Phase 1 post-cleanup memory feedback refresh — feedback_aterm_v3_only.md + feed|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|367|pending|UNKNOWN|Q#367|aterm Phase 1 user dogfood — 사용자가 직접 phase1/cleanup-2026-05-06 branch HEAD 2289d38 (p|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|368|pending|UNKNOWN|Q#368|aterm Phase 1 dogfood 검증 항목 (7 items): (1) GUI 정상 표시 — 윈도우 + 사이드바 (2) PTY 입출력 — termi|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|371|pending|KEEP_BACKLOG|Q#371|telepty #11 — Native autossh support for persistent SSH sessions. Upstream: github.co|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|372|pending|KEEP_BACKLOG|Q#372|telepty #12 — First-class remote AI CLI session: native cwd + resume + bootstrap UI h|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|389|pending|KEEP_BACKLOG|Q#389|aigentry-devkit#3: scaffold install-hooks --dry-run validation (per @unitedideas feed|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|395|pending|UNKNOWN|Q#395|Orchestrator payload sanitization + cadence standard (was telepty#23, closed as misat|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|398|pending|KEEP_BACKLOG|Q#398|v1.0.1 dangling tag cleanup (telepty repo) — destructive remote tag delete|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|401|pending|KEEP_BACKLOG|Q#401|Codify "designer dogfoods spec on own dispatch" pattern (메타 inoculation 원리)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|402|pending|KEEP_BACKLOG|Q#402|Sibling-repo bin/snyk-scan.sh backfill via aigentry scaffold (6 repos)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|404|pending|KEEP_BACKLOG|Q#404|aigentry 에코시스템 전체 폴더구조 정책 설계 (cross-platform / multi-user / cross-machine)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|408|pending|UNKNOWN|Q#408|telepty cli.js 5 pre-existing Snyk findings — 별 follow-up PR|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|409|pending|UNKNOWN|Q#409|telepty Windows session registration debug — PATHEXT 이후 단계|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|410|pending|UNKNOWN|Q#410|telepty Windows allow UX 헌법 §2 정합 — cmux-equivalent backend 추가 (Windows Terminal / co|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|413|pending|UNKNOWN|Q#413|telepty read-screen Korean mojibake on Windows (SSH path)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|417|blocked|NEXT_DEPENDENCY|Q#417|telepty#15 — Daemon version mismatch auto-restart (port owner fallback). Code done (l|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|430|in_progress|NEXT_DEPENDENCY|Q#430|telepty L2 supervisor / SPOF removal — Phase 1 supervisor-core-finish DONE 2026-05-23|P2 push 여부와 P3-P6 잔여 확인; 현황 별도 검증|
|436|in_progress|NEXT_DEPENDENCY|Q#436|R5 — Handoff contracts ssot (STAGED: R5a tester→orch DONE 2026-05-23 + R5b analyst↔lo|R5b/후속 전파; 현황 별도 검증|
|442|pending|KEEP_BACKLOG|Q#442|telepty supervisor-core §8.A3-tree grandchild cascade cleanup test (~100 LOC follow-u|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|443|pending|KEEP_BACKLOG|Q#443|orchestrator spawn-events.ts → logger.emit consolidation (CLDR follow-up to #440 C3 d|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|444|pending|KEEP_BACKLOG|Q#444|aigentry-logger CLI emit shim — bin/aigentry-logger emit --kind X --payload '{...}' (|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|445|pending|UNKNOWN|Q#445|boot-prepare.mjs export AIGENTRY_SESSION_ID + AIGENTRY_ROLE env vars (#440 follow-up)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|440|in_progress|NEXT_DEPENDENCY|Q#440|Logger emitter integration — 4/5 source repos DONE (telepty deferred to post-δ1 P2 fo|telepty 잔여 통합; 현황 별도 검증|
|439|pending|UNKNOWN|Q#439|telepty cleanupDaemonProcesses async HTTP probe wiring (probeTeleptyOnPort follow-up |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|454|blocked-by-observation|NEXT_DEPENDENCY|Q#454|Phase 5a-prime 실사용 관찰 트랙 — Phase 5b dispatch 전 데이터 수집. 5a-prime binary (target/releas|관측 결과 회수; 현황 별도 검증|
|455|blocked-by-observation|NEXT_DEPENDENCY|Q#455|Phase 5b spec + npm publish bundle 트랙 — Phase 5b 가 land 될 때 npm publish 함께 진행. 단독 JS-|#454 관측/플랫폼 패키징; 새 버전만으로 완료 금지; 현황 별도 검증|
|458|pending|KEEP_BACKLOG|Q#458|Dispatch ref template gap: worktree-based trial-fire dispatches need ".venv-exec-mode|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|459|pending|KEEP_BACKLOG|Q#459|ADR phase6-conclusion (docs/adr/2026-05-04-phase6-conclusion.md) appendix: fold 7 aud|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|463|pending|KEEP_BACKLOG|Q#463|brain/deliberate.sh MIGRATE-GAP — port no-MCP multi-CLI + project-context auto-inject|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|464|pending|KEEP_BACKLOG|Q#464|deliberation/auto-deliberate.sh KEEP — lock in skill SKILL.md §C as reference impleme|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|465|pending|KEEP_BACKLOG|Q#465|propose-next-task skill — close L-new-A (conflict_score saturation ceiling): multi-su|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|466|pending|KEEP_BACKLOG|Q#466|propose-next-task skill — close L-new-C (updated_at parse format): bare-date treated |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|467|pending|UNKNOWN|Q#467|Orchestrator --submit-force workaround removal: commit 7a09285 (project state/dispatc|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|474|pending|UNKNOWN|Q#474|telepty pre-existing Snyk findings — 55개 vulnerabilities (이전 코드 기반). 구성: 13 Prototype|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|477|blocked|NEXT_DEPENDENCY|Q#477|Cambrian Spore P0 art — 딸 요구사항 (2026-05-26 18:24 KST 손그림 노트). (1) 플랑크톤 채색 — 현재 PNG가 색|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|479|blocked|NEXT_DEPENDENCY|Q#479|Cambrian Spore P1 — 할루키게니아 + 삼엽충 species PNG + .tres 등록. 딸 요구사항 (2026-05-26 18:24 KST|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|482|pending|KEEP_BACKLOG|Q#482|Cambrian Spore γ decisions implementation (β evolution chain extension + α HUD T5 max|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|483|blocked|NEXT_DEPENDENCY|Q#483|Cambrian Spore 3D Option 3 (Subnautica-style full 3D immersion) 변환. Grilled 2026-05-2|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|484|in_progress|KEEP_BACKLOG|Q#484|Cambrian Spore 3D 자산 (.glb) 확보. Context: 2026-05-27 사용자가 codex app에서 cambrian-era 생물 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|493|in_progress|NEXT_DEPENDENCY|Q#493|Warp first-class terminal support (user decision 2026-05-29: 'warp 터미널도 지원해야돼'). CLDR|#494 Warp 외부 선행조건; 현황 별도 검증|
|494|blocked|NEXT_DEPENDENCY|Q#494|telepty#30 (Warp surface close) + #31 (Warp focus) are NOT buildable until upstream w|로컬 보존 upstream 결과 확인; 네트워크 미측정; 현황 별도 검증|
|495|in_progress|UNKNOWN|Q#495|Extract telepty daemon.js/cli.js lifecycle DECISION logic to exported src/*.js module|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|496|pending|UNKNOWN|Q#496|dispatch.sh robustness — 3 failure modes surfaced during the 2026-05-30 telepty-publi|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|499|pending|ALREADY_DONE_CANDIDATE|A2+Q#532|WHY codex role-sandbox doesn't apply + track a fix. Root cause: the role-sandbox (#43|#532 additive sandbox 소스 존재; codex/gemini 수용기준 대조 후 종료 검토|
|501|pending|UNKNOWN|Q#501|telepty IN-NODE HARDENING (the debt-min path; NO language migration). Re-sequenced by|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|502|pending|UNKNOWN|Q#502|RECURRING: spawned CLAUDE sessions hit `API Error: 400 messages.N.content.M: thinking|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|503|pending|KEEP_BACKLOG|Q#503|Cambrian: reusable headless screenshot harness (extends SceneTree, --headless)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|504|pending|KEEP_BACKLOG|Q#504|Cambrian gameplay B-plus juice 개선 (3-CLI deliberation 합의안, 9개)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|506|pending|KEEP_BACKLOG|Q#506|Cambrian 지도 — 미니맵 HUD + 월드 경계|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|511|in_progress|UNKNOWN|Q#511|Session Reconcile Loop — 1 level-triggered loop(기존 60s launchd Reconciler) + 2 seam(S|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|522|pending|KEEP_BACKLOG|Q#522|[DEFER-ALL] 갭 오케스트레이션 self-improvement 프로그램 (다수 세션/chunk)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|524|pending|UNKNOWN|Q#524|reconciler(com.aigentry.reconciler) BOOTED OUT — Chunk3 register-wiring이 t16 테스트 세션 재|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|526|pending|KEEP_BACKLOG|Q#526|EPIC (user 2026-06-06: '에코시스템 대대적 개선 필요할 듯 + 차후 분석 필요'): major aigentry ecosystem ove|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|527|pending|UNKNOWN|Q#527|aigentry-logger `check:schema-drift` gate SKIPS (exit 0) due to a PRE-EXISTING path b|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|528|pending|KEEP_BACKLOG|Q#528|[DEFER] profile-orchestrator — devkit 8-phase로 orchestrator 설치 가능화 (SPEC only)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|529|pending|KEEP_BACKLOG|Q#529|[DEFER] bus-event-consumer SPEC (telepty bus→AUTO_HOLD/AUTO_REPORT)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|534|pending|ACT_NOW|A5+Q|session-cleanup.sh parent-SIGTERM does NOT reap the claude grandchild → orphaned clau|parent-only kill 이후 자식 생존 격리 재현 스펙|
|562|pending|KEEP_BACKLOG|Q#562|Formalize a DETERMINISTIC spawn-time SELECTOR for role + CLI + target-cwd (+ parallel|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|577|pending|UNKNOWN|Q#577|telepty CI windows-only 잔여 22 (post-#576): broker/ssh path + PTY/TUI timeouts + snipp|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|586|awaiting-user|NEXT_DEPENDENCY|Q#586|에코시스템 구조 감사 종합 — 6 decision (D1-D6) orchestrator 판단 대기 + 권고 우선순위|D1-D6 결정 기록 확인; 현황 별도 검증|
|589|blocked|NEXT_DEPENDENCY|Q#589|웨이브1: devkit install 버그 2건(brain-stub npm files, wtm 경로) + ADR 표준 템플릿|#593 WIP 소유권 및 보존 확인; 현황 별도 검증|
|590|pending|UNKNOWN|Q#590|gate/enforceSpawn 실배선 (warn-mode→hard-fail 점진) — 현재 WIRING-GAP(휴면, 문서만 active였음, #587|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|591|pending|NEXT_DEPENDENCY|Q#591|devkit brain-stub WIP 커밋 시 package.json files 동반 추가 (현재 WIP 미추적 — 커밋되면 npm 배포 누락→fall|#589/#593 설치 아티팩트 확인; 현황 별도 검증|
|592|pending|KEEP_BACKLOG|Q#592|telepty AGENTS.md 모듈 전수(28개) 반영 — #588서 핵심 13개만 반영|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|593|awaiting-user|NEXT_DEPENDENCY|Q#593|devkit main 거대 미커밋 WIP 정리 — install.sh/ps1+AGENTS/CLAUDE/bin/config 17 modified + 38 |기존 WIP 소유자 확인; 폐기 금지; 현황 별도 검증|
|595|awaiting-user|KEEP_BACKLOG|Q#595|수익화 전략 deliberation 합의(3-LLM 만장일치): B2B Dev Shop local-first 유료셋업 wedge + 14일 pre-sel|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|596|awaiting-user|KEEP_BACKLOG|Q#596|[인간 실행] 14일 pre-sell 스프린트 — USD 1,000 셋업 offer + Dev Shop 30 아웃리치(Upwork/LinkedIn) + |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|598|awaiting-user|KEEP_BACKLOG|Q#598|수익화 전략 ADR 작성 — docs/adr/2026-06-10-monetization-strategy.md (wedge-first 합의 결정 기록)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|599|in_progress|NEXT_DEPENDENCY|Q#599|recovery/backup runbook 1장 작성 — telepty(+brain) 백업→복원→재개 절차 (offer "recovery workflow|#602 실제 복원 리허설; 현황 별도 검증|
|602|pending|NEXT_DEPENDENCY|Q#602|실머신 리허설 — claude CLI 실존 머신(이 Mac shadow-HOME)에서 recovery-runbook 절차 그대로 실행 + 멀티-CLI 래|#599 런북 최신화; 현황 별도 검증|
|605|pending|UNKNOWN|Q#605|cmux 신규 workspace pane-ready 타임아웃 회귀 — 3연속 실패(10s/10s/30s), 기존 workspace 정상. dispatch|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|607|pending|UNKNOWN|Q#607|cmux pane-ready 근본 fix — surface 생성을 view.window!=nil 게이트에서 분리 + release-safe os_log |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|608|delegated|NEXT_DEPENDENCY|Q#608|터미널 어댑터 계약 완전 통일 — cmux↔warp 심리스 패리티(§2). spawn을 wh_open() 어댑터로 편입 + 동사×어댑터 매트릭스 + co|Phase2 완료, Phase3 잔여 계약 확인; 현황 별도 검증|
|609|pending|UNKNOWN|Q#609|standalone telepty ghost-탭 — closeSurface=gated no-op(default OFF)로 orchestrator 없는 t|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|621|pending|UNKNOWN|Q#621|#619 잔여 cry-wolf 갭 조사: 0.6.5 데몬(98164, #619 코드 확인)에서도 worker-launcher 세션 t620이 238.8s|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|623|pending|KEEP_BACKLOG|Q#623|Loop-engineering 하네스: 워커 role이 실수/오작업 시 교정이 그 role로 루프백되어 다음 세션이 반복 안 하도록 학습. 검증가능 목표|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|625|pending|KEEP_BACKLOG|Q#625|telepty CLI 명령 스킬 일괄 작성 — 사용자 LLM이 ~42개 telepty 명령 용도를 모름. 스킬 10개뿐, 갭=32개(broker/kill|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|626|pending|UNKNOWN|Q#626|spawn 인프라 불안정 — rapid same-sid cleanup+respawn churn이 telepty bridge를 죽이고 cmux worksp|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|syc-01|in_progress|NEXT_DEPENDENCY|Q#syc-01|[syc-ai] 수주(Sales Order→생산) — gate 프로세스. 카톡/팩스/전화→LLM 맥락분석→카톡/슬랙 사용자확인→수주 gate. 수주→생산|syc-04 D-01 결정; 현황 별도 검증|
|syc-02|in_progress|NEXT_DEPENDENCY|Q#syc-02|[syc-ai] 출고(Shipping) — 핵심 진행. AS-IS(1D 바코드)→TO-BE(2: 고해상도 카메라+AI Agent 4-gate). gate|syc-04 회계/증거/카메라 결정; 현황 별도 검증|
|syc-03|pending|KEEP_BACKLOG|Q#syc-03|[syc-ai] 데이터 파이프라인 — TBD. 생산/출고/수주/IoT/ERP 데이터 수집·정제·저장 단일기반.|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|syc-04|blocked|ACT_NOW|Q#syc-04|[syc-ai] 수주·출고 결정 10건 — 기영(현장)과 논의 후 확정. D-01~05 프로세스룰(일부재고전환/출고완료모드/재고차감타이밍/부분생산완료/g|기영 결정 10건 중 D-06/07/08 현장 확인 준비; 현장 자료 미검증|
|kt-01|pending|KEEP_BACKLOG|Q#kt-01|AI-native local-first 문서 공유 도구 평가·도입 — 프로젝트/프로세스/결정 문서를 팀(기영 등)과 공유. 현재 노션, 나중에 AI-na|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|delib-agy-cliauto-restore|pending|UNKNOWN|Q#delib-agy-cliauto-restore|Restore agy(Antigravity) cli_auto capability when its headless --print flushes stdout|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|delib-ci-crossplatform-flaky|pending|UNKNOWN|Q#delib-ci-crossplatform-flaky|Fix pre-existing flaky cross-platform CI in aigentry-deliberation (ubuntu+windows)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|session-create-kitty-adapter|pending|KEEP_BACKLOG|Q#session-create-kitty-adapter|Add a kitty adapter to bin/lib/workspace-host.sh if kitty visible-spawn is ever neede|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|dispatch-respawn-unique-sid-guard|pending|UNKNOWN|Q#dispatch-respawn-unique-sid-guard|dispatch.sh: guard same-sid respawn shared-fate death (auto-unique suffix or wait-for|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|impulse-monitor-mvp|pending|KEEP_BACKLOG|Q#impulse-monitor-mvp|충동/안정 정도 추적 안드로이드 네이티브 앱(Kotlin/Jetpack Compose, API30+, Room). 메시징 앱(카톡/라인/텔레그램) 메타데|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|garage-cert-sw|pending|KEEP_BACKLOG|Q#garage-cert-sw|차량 차고지 증명제(주차공간 증명 의무)를 국내에서 SW 서비스로 보완 가능한지 검토. 리서치 선행: 국내 현행 제도(적용범위·대상차종·지역 한정성 vs|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|dispatch-lost-on-guard-respawn|pending|UNKNOWN|Q#dispatch-lost-on-guard-respawn|Dispatch silently lost when guard worker-launcher respawns claude (or initial submit |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|wh-headless-fallback-silent-degrade|pending|UNKNOWN|Q#wh-headless-fallback-silent-degrade|wh_open's headless fallback (_wh_headless_open, bin/lib/workspace-host.sh:773) silent|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|sec-wire-enforce-spawn|pending|UNKNOWN|Q#sec-wire-enforce-spawn|[ecosystem-analysis #2 HIGH] WIRING-GAP re-confirmed 3-way + amplifier: every spawn d|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|struct-injection-and-drift|pending|UNKNOWN|Q#struct-injection-and-drift|[ecosystem-analysis #5] shell-injection sites: eval cwd (open-session.sh:118), unquot|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|628|in_progress|NEXT_DEPENDENCY|Q#628|게임(animal-hospital) — 원작 로블록스 '변칙성' 100% 동일 구현 스펙 + 딸 플레이테스트 (구 #628 맥락 복구 완료)|#1076/#1132 수용 후 전체 게임 범위 검토; 현황 별도 검증|
|638|delegated|ALREADY_DONE_CANDIDATE|B2|[animal-hospital] 원작 패리티 갭 감사 — namu.wiki 카탈로그(docs/reference/namu-wiki-animal-hospit|감사 보고서/카탈로그 main 존재; 구현 에픽 #628은 유지|
|syc-06|in_progress|NEXT_DEPENDENCY|Q#syc-06|[syc-ai] 카톡 수주 라이브 게이트웨이 (Track A: 법인 유심+전용 계정+안드로이드 수집기). 사용자 결정 2026-07-03. Phase: |syc-07 PC 스파이크 승자; Android 폐기는 아직 조건부; 현황 별도 검증|
|syc-07|blocked-by-observation|ACT_NOW|Q#syc-07|[syc-ai] T0-PC 캡처 스파이크 실행 — 프로브/런북 준비완료(spikes/pc-collector/, 커밋 0daf54d). Windows PC|사용자가 제공한 PC 접근 준비상태 확인 → 승인된 3프로브; 현황 미검증|
|syc-00|in_progress|NEXT_DEPENDENCY|Q#syc-00|[syc-ai] 카톡 수주 자동화 EPIC 컨텍스트 앵커 — 세영화학(플라스틱 필름 제조; 사용자 가족사업, 3형제 준영/기영/덕영)이 회사별 카톡방으로|syc-07 수집기 검증 + syc-04 현장 결정; 현황 별도 검증|
|643|awaiting-user|OBSOLETE_CANDIDATE|Q#643+Q#728|[telepty] GeekNews(Show GN) 공개 — telepty 소개 글 게시. 사용자 결정 2026-07-04. 선행 게이트: [[ux-pub|동일 게시 작업을 후속 #728로 합칠 후보; 실제 게시 완료는 미검증|
|644|pending|UNKNOWN|Q#644|[orchestrator] workspace-host.sh:727 — 존재하지 않는 "aterm new-session" 호출을 실제 명령 "aterm c|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|643.2|blocked-by-observation|NEXT_DEPENDENCY|Q#643.2|[Stage 2] 오케스트레이션-패턴 writeup (GeekNews) — control-tower + readiness-gated dispatch + |원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|652|pending|UNKNOWN|Q#652|permission-bypass 기본값 축소 — --dangerously-*/bypassPermissions를 sandboxed cwd로 스코프|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|653|pending|UNKNOWN|Q#653|telepty CORS 상태 확인 + 락(explicit origin allowlist)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|655|pending|UNKNOWN|Q#655|spawn 게이트 wire-or-delete — dormant ~1726 LOC TS kernel(src/gate,validate-spawn,permis|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|656|pending|UNKNOWN|Q#656|CLI default flag single-source — [1m] 모델 드리프트 제거|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|657|pending|KEEP_BACKLOG|Q#657|logger-emit 중복 제거 — aigentry-logger subpath export로 통합, deliberation/devkit 로컬 복사 삭제|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|658|pending|UNKNOWN|Q#658|telepty 버전 floor 체크 — dispatch/boot preflight에 최소버전 assert|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|659|pending|KEEP_BACKLOG|Q#659|deliberation 컷 — entitlement 레이어 + ws 의존(node global) + log-rotation 5-knob|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|660|pending|KEEP_BACKLOG|Q#660|aterm dead 경로 컷 ~850 lines — bin/aterm.js, telepty.rs, mailbox/{delivery,notifier}.rs|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|661|pending|KEEP_BACKLOG|Q#661|telepty install 중복 dedup ~180 lines|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|662|pending|KEEP_BACKLOG|Q#662|휴면 repo 정리 — sandbox(0파일) 삭제, aigentry-context archive(brain 흡수), registry/dustcraw/a|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|663|pending|UNKNOWN|Q#663|install.ps1 parity — Windows orchestrator 프로파일 포팅(#518/#521/#613-614) or 명시적 미지원 문서화|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|664|pending|UNKNOWN|Q#664|aterm help 하드코딩 "✅ installed" 블록 제거(status는 이미 fix, help는 잔여)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|665|pending|UNKNOWN|Q#665|entitlement.js가 headline 데모(cross-machine) exit(1) — remote_sessions free 기본 or warn-|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|667|pending|KEEP_BACKLOG|Q#667|AGENTS.md 체크리스트 슬림화 — 39항목 평균 306자/줄 산문화 개선(인라인 ADR/commit/§인용 분리)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|668|pending|KEEP_BACKLOG|Q#668|dustcraw archive 결정 — 21k tracked LOC, 0 consumer, 파이프라인 무출력. core ~640L salvage 노트 후|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|669|pending|KEEP_BACKLOG|Q#669|brain hygiene batch ~1006L + README 진실화 (orphan CLI, 만료 deprecation, 잡파일)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|670|pending|KEEP_BACKLOG|Q#670|amplify de-scope ~925L + 148MB + 정직화 (YouTube 툴체인 relocate, YAML 손수파서, 죽은 템플릿)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|671|pending|KEEP_BACKLOG|Q#671|logger accuracy pass ~33L -1 runtime dep (--version 버그, ssot→devDep, changelog/README|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|672|in_progress|NEXT_DEPENDENCY|Q#672|Telepty 크로스머신·크로스플랫폼 주입 매트릭스 — Mac↔Linux↔Windows 3노드, 전 방향 inject/report 왕복 실증 (오늘)|남은 교차방향 결과/현재 노드 확인; 현황 별도 검증|
|673|pending|UNKNOWN|Q#673|pre-push 가드가 테스트의 temp file:// bare repo push까지 차단 — 실 origin만 가드하도록 수정 (Rule 32 근본fi|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|675|pending|KEEP_BACKLOG|Q#675|MD governance에서 cmux 하드코딩 제거 — 스폰/라이프사이클 규칙을 터미널 추상화(workspace-host 어댑터)로 표현|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|676|pending|UNKNOWN|Q#676|orchestrator-boot.sh 자동 실행 배선 — mandatory singleton 가드를 세션 open 시 자동화(사람 기억 의존 제거)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|677|pending|UNKNOWN|Q#677|telepty→오케스트레이터 결합 제거 (§9 독립) — telepty가 orchestrator/aigentry 개념 몰라야, 범용 primitive로 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|680|pending|UNKNOWN|Q#680|크로스머신 메시지에 UTC 절대 타임스탬프 포함 — 국가간 통신 정합성/상관 보장|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|681|pending|KEEP_BACKLOG|Q#681|telepty send-key/send-input 확장 — 전체 키보드 + 마우스 입력, 인터랙티브 TUI 완전 프로그래매틱 제어|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|683|in_progress|NEXT_DEPENDENCY|Q#683|미사용 public repo → private + caveat 해결|사용자 공개범위 결정 및 #684; 현황 별도 검증|
|684|pending|KEEP_BACKLOG|Q#684|caveat 완결 — org 멤버 기본권한 read/none 강제 (private write 사고 방지)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|686|pending|KEEP_BACKLOG|Q#686|테스트 커버리지 향상 아이디어 심층 리서치 (병렬 4각도 A/B/C/D → deliberation 합성)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|688|pending|UNKNOWN|Q#688|[알려진 한계] continuously-busy 타겟(orchestrator)에 평문 gated submit은 CR quiet-window 없음 — fo|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|693|blocked-by-observation|NEXT_DEPENDENCY|Q#693|[telepty ops P1] WIN-T6T20OIKEMR(.120/100.115.0.120) 노드 stale — 데몬 0.4.2 + orchestrat|접근/노드 상태 재확인; 현황 별도 검증|
|696|pending|UNKNOWN|Q#696|[telepty P2] cli.js 사이블링 4곳 hard process.exit() mid-teardown — #691과 동일 패턴(libuv race|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|699|blocked-by-observation|NEXT_DEPENDENCY|Q#699|[repo] aterm LICENSE 추가 (UNLICENSED→MIT) — public이나 라이선스 없음|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|700|pending|UNKNOWN|Q#700|[telepty P1] cross-host --ref payload 미전송 — tailnet/HTTP peer엔 path 포인터만, 파일 내용 전송 안 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|701|in_progress|NEXT_DEPENDENCY|Q#701|[deploy] Linux/Windows telepty 0.6.10 full-stack(데몬+브릿지) 재시작 + 크로스머신 roundtrip 테스트|현재 노드 버전/bridge 생존 증거부터; 현황 별도 검증|
|702|pending|UNKNOWN|Q#702|[telepty P2] bridge hot-restart/handoff 부재 — 세션 죽이지 않고 브릿지를 새 코드로 재시작 불가(attach=TUI 전|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|705|pending|KEEP_BACKLOG|Q#705|[telepty observability P3] real-idle 감지 latency 4.7s~70s 편차 계측 (C6 long-tail 원인)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|697.1|awaiting-user|NEXT_DEPENDENCY|Q#697.1|[ci] github-actions[bot] ruleset bypass — 4 public repo(devkit/deliberation/aigentry/|사용자 계정 ruleset 결정; 임의 변경 금지; 현황 별도 검증|
|709|pending|KEEP_BACKLOG|Q#709|[deliberation UX] tmux 전광판(모니터 터미널)이 사용자에게 안 뜸 — deliberation_start가 grouped tmux 세션(|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|711|pending|UNKNOWN|Q#711|[telepty hardening] session-state.js:187 poll setInterval .unref() — #645 hang 재발 클래스|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|713|blocked-by-observation|NEXT_DEPENDENCY|Q#713|[telepty bug] Claude Code v2.1.198 fresh-spawn 세션 inject 블랙홀 — 신버전 TUI의 터미널 capabilit|재현 로그/CLI 버전 확인; 현황 별도 검증|
|717|pending|UNKNOWN|Q#717|[telepty] /screen 리드로우-프레임 누적 — ring-concat 방식이라 TUI 리드로우가 반복 텍스트로 쌓임(Booting MC…ooti|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|723|blocked-by-observation|NEXT_DEPENDENCY|Q#723|[orchestrator ops] 오케스트레이터 claude 프로세스 돌연 종료 — 재발 시 transcript jsonl + macOS Console |재발 로그 확보; 현황 별도 검증|
|726|blocked-by-observation|NEXT_DEPENDENCY|Q#726|[데모 확장] 안드로이드(dys-device) 4번째 pane — telepty 크로스머신 주입 통신 가능 여부 검증 + 릴레이 참여|원본 관측/선행조건 회수; 현재 충족 여부 미검증|
|728|awaiting-user|NEXT_DEPENDENCY|Q#728|[GeekNews] telepty Show GN 게시 — v12.1 초안 게이트 전부 충족, 사용자 게시만 남음|현재 CI/설치/게시 여부 확인 후 사용자 게시; 현황 별도 검증|
|731|pending|UNKNOWN|Q#731|[telepty/orchestrator] peer→peer inject ask-envelope UX — JSON 원문이 수신 세션 composer에 노출|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|735|blocked-by-observation|NEXT_DEPENDENCY|Q#735|[telepty deploy] 0.6.17 잔여 2노드 배포 — Linux·Windows 오프라인 보류 (0.6.16→0.6.17 승계)|오프라인 노드 접근 확인; 현황 별도 검증|
|741|pending|UNKNOWN|Q#741|[dispatch.sh] ready-timeout(exit 1) 경로가 dedup mark를 남김 — 재시도가 silent no-op이 되는 잔존 구멍 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|742|pending|UNKNOWN|Q#742|[telepty] require.main 가드 6종이 프로덕션(launchd 'telepty daemon' 경유)에서 전부 dead code — sing|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|743|pending|OBSOLETE_CANDIDATE|A1+Q#904+Q#1128|[orchestrator/telepty] 워커 REPORT inject가 바쁜 orchestrator에 silent 유실 — pull-side share|pull 수집은 #904로 구현; 미해결 턴 전달은 #1128로 통합 후보|
|747|pending|KEEP_BACKLOG|Q#747|[skills] cross-CLI 스킬 전달 후속 ADR — codex 목적지 루프(小) + gemini context-file 메커니즘 설계|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|748|pending|UNKNOWN|Q#748|[devkit] test:scaffold-install-hooks 1/16 pre-existing 실패 — claude version bump repla|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|753|pending|UNKNOWN|Q#753|[telepty] cli.js가 거부된 inject(STALE/DISCONNECTED/SURFACE_MODAL 등)에도 exit 0 — inject &&|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|755|pending|KEEP_BACKLOG|Q#755|[#740 M5] HITL Gate 문서화 — CONTEXT.md 용어(HITL Gate/awaiting_user/AWAIT_USER + spawn-Ga|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|758|pending|UNKNOWN|Q#758|[telepty] 테스트 하네스 데몬 누수 — 호스트에 hung telepty-daemon ~105개 누적, node --test stdio 파이프 점유|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|761|pending|KEEP_BACKLOG|Q#761|[skills] session-create 재라우팅 판정 — orchestrator bin/ 3회 호출로 ADR tiebreak상 repo-coupled|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|765|pending|KEEP_BACKLOG|Q#765|[architect process] adr-template에 "가중 합산 도출식 공개 의무" 추가 — 산술 오류 2건 연속(skill-ownership |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|766|in_progress|NEXT_DEPENDENCY|Q#766|[#759 검증] ambiguity-gate 실발동 라이브 테스트 — 양 분기(interactive plan-mode / worker HOLD) 실세션 |interactive 분기 검증 잔여; 현황 별도 검증|
|767|pending|UNKNOWN|Q#767|[tests] worktree에서 run-all.sh 위양성 실패 반복 — s739x(3건)·w764b(T17/18/24) 2회 재현, main에선 전부|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|770|pending|UNKNOWN|Q#770|[telepty] launcher 세션 identity-blind — command가 worker-launcher.sh라 isKnownAiCli fals|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|780|pending|KEEP_BACKLOG|Q#780|[registry] README MCP 섹션 재지정 + mcp_server.py 스텁 제거 — 현재 README가 스텁을 Claude Desktop에 배|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|781|pending|UNKNOWN|Q#781|[deliberation] 테스트 hermeticity — vitest run이 mock 없이 라이브 GUI auto-surfacing(transport|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|782|pending|ACT_NOW|Q#782|[aterm] 브랜치 표류 해소 — 실질 메인라인 phase1/cleanup-2026-05-06(2.5개월분)을 main으로 승격/병합, origin/m|aterm main/작업 branch 공통조상·diff·미병합 산출물 읽기; 병합은 별도 판단|
|783|pending|KEEP_BACKLOG|Q#783|[ssot] 컷 wave 후 contracts 동기화 — (1) dustcraw-amplify.yaml retire/재플래그 (2) mcp/deliber|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|784|pending|KEEP_BACKLOG|Q#784|[dustcraw] EntityExtractionEngine.extractRegex greedy 병합 — 문장 경계 넘어 대문자 시퀀스 병합(title+|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|785|pending|UNKNOWN|Q#785|[ssot] pkg/package.json prepare 훅 부재 — dist/ gitignored인데 publish가 디스크 상태 그대로 출하|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|786|pending|KEEP_BACKLOG|Q#786|[registry] helm/ vs k8s/ 이중 배포 스택 결정 — k8s는 테스트 대상, helm은 README 문서-only. 하나 은퇴|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|787|pending|KEEP_BACKLOG|Q#787|[registry] mypy가 pyproject dev extras에 없어 로컬에서 CI 게이트(ci.yml:36) 재현 불가|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|788|pending|KEEP_BACKLOG|Q#788|[deliberation] 브라우저 모델명 stale — grok-3/GPT-4.5/Claude-3.5-Opus가 실제 드롭다운 선택을 구동(정합성 버그|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|789|awaiting-user|NEXT_DEPENDENCY|Q#789|[brain] 0.3.0 릴리스 스텝 — (1) rm -rf dist && build (stale dist가 죽은 agent/experiments JS |npm 완료 주장과 Cloudflare 잔여 분리; 자격증명 경계; 현황 별도 검증|
|790|pending|KEEP_BACKLOG|Q#790|[context] git remote 부재 — aigentry-context에 GitHub remote 생성+push (컷 merge eb23360 포함|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|791|pending|KEEP_BACKLOG|Q#791|[orchestrator] 컷 후속 슬라이스 — Spawner.run/RunResult 무호출(~35 LOC), ERR_BOOT_ADAPTER_UNSUP|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|792|pending|KEEP_BACKLOG|Q#792|untracked 잡파일 지식화 후 삭제 — brain 회의록 4건(~3k LOC 유일본)+스크래치, orchestrator agy/grok .err·.|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|795|delegated|NEXT_DEPENDENCY|Q#795|[brain] 구조 개선 설계 — 캡처→축적→sync 파이프라인 재설계 (silent-failure 불가 구조, 거짓 synced 신호 제거). #794|#794 진단 및 R5/SSOT 승인·W2 잔여 재확인; 현황 별도 검증|
|796|pending|UNKNOWN|Q#796|[orchestrator] reconciler HITL error-gate에 resume 액션 기본값 부재 — approve가 resume=none이라 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|803|pending|KEEP_BACKLOG|Q#803|[telepty] #801 후속 — gemini 에러 마커 행 미측정(표에 없음) + CLI 리스타일 시 마커 무효화 감지 수단 부재. 재캡처 스크립트(|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|809|pending|UNKNOWN|Q#809|[orchestrator] session-cleanup.sh가 죽은 워커의 role-sandbox/worktree를 회수하지 않음 — 잔여물 무한 누적 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|811|pending|UNKNOWN|Q#811|[dispatch] verify_delivered()가 치환 전 원본 ref의 head -n1을 화면과 비교 — #690 치환 도입으로 생긴 논리적 불일|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|812|pending|UNKNOWN|Q#812|[tests] 신규 워크트리에서 dispatch suite 3건이 조용히 실패 — gitignored dist/ 미빌드 (베이스라인 오판 함정)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|813|pending|UNKNOWN|Q#813|[telepty] PTY 픽스처 캡처 방법론이 OSC 9 채널에 맹목 — tmux pipe-pane이 스트립, 기존 #760/#801 픽스처 전부 영향|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|814|pending|UNKNOWN|Q#814|[telepty] OSC_133_RE가 실트래픽에서 한 번도 발화한 적 없음 → #545 idleEvidenceReliable 게이트가 프로덕션 dead|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|816|pending|NEXT_DEPENDENCY|Q#816|[telepty] per-dispatch 자격증명을 실행 중인 워커에 전달할 소유자-인증 제어 채널 부재 — #807 Stage B의 A1 증명이 이것에|#807 Stage B 계약; 현황 별도 검증|
|817|pending|NEXT_DEPENDENCY|Q#817|[telepty] 크로스머신 inject에 발신자 신원이 없음 — --from이 SSH로 평문 전달되고 수신 데몬이 origin:trusted-local|#807 발신자 인증 계약; 현황 별도 검증|
|818|pending|NEXT_DEPENDENCY|Q#818|[telepty] #815 잔여 — 미자격 세션의 최초 owner claim 레이스(런처 보유 사전 비밀 필요)|#815 owner claim 증명; 현황 별도 검증|
|819|pending|UNKNOWN|Q#819|[orchestrator] session-reconciler.sh:353 ESCALATE 분기의 [ ] && [ ] && cmd 체인 errexit 위험|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|821|pending|UNKNOWN|Q#821|[telepty] bearer가 자식 env에 spawn-time으로 주입돼 same-uid 프로세스에 노출 — macOS도 노출됨(이전 판단 정정)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|822|pending|UNKNOWN|Q#822|[telepty] npm run test:ci가 로컬에서 종료 불가 — daemon.js를 require하는 모든 테스트 파일이 리스너/인터벌을 상속해 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|827|pending|UNKNOWN|Q#827|[orchestrator] 기존 스위트 실패 9~10건 — boot-adapter self-test 8건이 존재하지 않는 함수(verifyBootSelf|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|828|pending|UNKNOWN|Q#828|[telepty/프로세스] --test-force-exit가 테스트 카운트를 조용히 절단 — 'fail 0'인데 일부 테스트가 아예 실행 안 됨|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|834|pending|UNKNOWN|Q#834|[telepty] flagless로도 결과가 유실되는 두번째 starvation 기전 — 이벤트 루프 포화로 리포터가 flush 못함|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|836|pending|UNKNOWN|Q#836|[orchestrator] 존재하지 않는 세션에 대해 게이트/에스컬레이션이 열림 — ask.sh CONFLICT + reconciler HITL 게이트 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|841|pending|KEEP_BACKLOG|Q#841|[PoC] 에코시스템 지식 온톨로지 — 850 태스크/462 dispatch ref/317k자 노트를 질의 가능하게 (로컬 전용)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|845|pending|UNKNOWN|Q#845|[telepty] tracked-injection ledger가 무한 성장 — 레코드 수 축이 무경계, 관측마다 전체 파일 재작성 + 이중 fsync|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|849|pending|KEEP_BACKLOG|Q#849|[telepty] SPEC FIRST — awaiting approval 헤더가 이미 shipped된 스펙 6+건에 잔류 (계약은 다르지만 같은 결함군)|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|851|pending|KEEP_BACKLOG|Q#851|[telepty] undefined/ 히스토리 재작성 — 사용자 승인 완료, 0.8.0 publish 이후 실행|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|858|pending|UNKNOWN|Q#858|[tooling] codex 세션이 MCP 서버 기동에서 멈춤 — 2회 재현, r3 교차모델 게이트 불발|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|864|pending|UNKNOWN|Q#864|[telepty] parked inject의 성공적 drain이 audit 라인을 남기지 않음 — fA가 지목한 '자연스러운 다음 컷'|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|865|pending|KEEP_BACKLOG|Q#865|[telepty 0.9.0] inject_written 이벤트 이름이 0바이트 park에도 발사 — 필드는 정직해졌으나 이름은 여전히 쓰기를 주장|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|868|pending|UNKNOWN|Q#868|[orchestrator] dispatch.sh가 --extra-flags를 노출하지 않음 — CLI 플래그 조정 시 게이트 경로 우회 강제|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|871|pending|UNKNOWN|Q#871|[운영] repo-symlink 호스트에서는 병합 자체가 배포 — 런북이 병합과 데몬 리로드를 분리된 두 단계로 가정|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|876|pending|KEEP_BACKLOG|Q#876|[telepty] npm 발행을 trusted publishing(OIDC)으로 이전 — 토큰 제거, npm Phase 2 데드라인 2027-01|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|879|pending|UNKNOWN|Q#879|[telepty] Windows CI가 한 번도 완주한 적 없음 — timeout 20분 초과로 cancelled, 그 이전은 failure. 0.8.0|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|881|pending|UNKNOWN|Q#881|[orchestrator] bin/open-session.sh:136 라이브 오염 — 모델명에 리터럴 [1m] 혼입, 복원 완료, 원인 미상|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|882|pending|UNKNOWN|Q#882|[orchestrator] open-session.sh에서 --cwd 전달 시 role config 전체(cli_flags/cli)가 무시됨 — if/e|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|883|pending|UNKNOWN|Q#883|[orchestrator] dispatch-tracker가 레코드 단위로 순회하고 sid 단위로 기록 — 한 sid 2 live 레코드면 하나에 이중 기|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|884|pending|KEEP_BACKLOG|Q#884|[에코시스템] 공용 npm 토큰 회전 추적 — bypass-2FA 토큰은 npm이 90일 수명 강제, 만료 시 전 CI publish + 로컬 publi|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|888|pending|UNKNOWN|Q#888|[orchestrator] hitl.sh:94 — inject 실패가 이제 전파됨(#840 후) → bare abort 대신 의도적 처리(재시도 1회+기|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|889|pending|UNKNOWN|Q#889|[orchestrator] bus 브리지가 .host 필터 없음 — 크로스머신 구성에서 원격 peer의 orphan 신호가 로컬 wh_close를 액추에|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|890|pending|UNKNOWN|Q#890|[telepty] listen이 WS 토큰을 query string으로 — HTTP 액세스 로그에 남을 수 있음 (ob1 flag)|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|891|pending|UNKNOWN|Q#891|[orchestrator] 메인트리 cwd 워커에 오케스트레이터 자신의 커밋이 활동 증거로 오귀속 — #718 변종|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|892|pending|UNKNOWN|Q#892|[aterm/telepty] aterm register가 기존 세션(orchestrator)의 Terminal 메타데이터를 ghostty→aterm으로 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|893|pending|UNKNOWN|Q#893|[telepty] read-screen 1회 ECONNRESET (fetch failed) — #837 fix가 닫은 resolve→write 경로 밖 |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|895|pending|ACT_NOW|A6+Q|[aterm] restart_daemon() 제품 동작 자체가 위험 — aterm이 소유하지 않은 데몬을 버전문자열 불일치(양방향)만으로 재시작, 모든 |버전 불일치만으로 공유 데몬 재시작하는 경로 격리 재현|
|898|pending|UNKNOWN|Q#898|[orchestrator] boot-prepare ensureSandboxTrusted가 오너의 ~/.claude.json을 무락 read-modify-|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|906|pending|UNKNOWN|Q#906|[telepty 0.9.0 PRODUCT] 분류기가 데몬 자신의 PS1 랩을 스피너로 오인 -> thinking 영구 흡수 -> quiet 관측 영원 미|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|908|pending|UNKNOWN|Q#908|[xplat] Windows 실스위트 잔여 실패 33건(4 family) 분류·처분 — boot-prepare launcher.sh 21 / resolv|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|918|pending|KEEP_BACKLOG|Q#918|[telepty CI] release.yml 런-레벨 conclusion이 non-gating test-windows 잡의 timeout-cancel로 |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|919|pending|KEEP_BACKLOG|Q#919|[telepty 관측성] 데몬-관리 깔때기 배너가 CLI stderr에만 출력되어 호스트 어디에도 기록 안 됨 — 진입 빈도를 사후 측정할 수단이 mar|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|921|pending|UNKNOWN|Q#921|[telepty] `telepty disconnect <name>`이 디스크 peers.json을 안 봄 — in-memory activePeers만 조|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|922|pending|KEEP_BACKLOG|Q#922|[brain CI] windows-latest 레그가 main에서 선재 적색 — tests/cli/doctor-timer.test.ts 13건(launc|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|927|pending|UNKNOWN|Q#927|[orchestrator] open-session --auto-cleanup-on-exit silently no-ops when the entrypoin|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|929|pending|UNKNOWN|Q#929|[orchestrator] bin/ask.sh session-comms hardening (3 defects, one file): (1) two-writ|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|936|pending|UNKNOWN|Q#936|[animal-hospital] Generated artifacts must be AUTHORED in the build chain — three inc|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|937|pending|KEEP_BACKLOG|Q#937|[animal-hospital] W1 reception pipeline — the original is a 10-state reception+inspec|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|942|pending|UNKNOWN|Q#942|[telepty] send-key accepts only 'enter', so an orchestrator cannot answer a worker's |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|947|pending|KEEP_BACKLOG|Q#947|[animal-hospital] The project renders in Gamma colour space, so ambient multiplies st|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|949|in_progress|NEXT_DEPENDENCY|Q#949|[animal-hospital] SPATIAL PARITY — the original's floor plan must be reproduced, not |#948 참조 및 치수 미측정 해소; 현황 별도 검증|
|950|pending|KEEP_BACKLOG|Q#950|[animal-hospital] M4bFoldTest is intermittently red under a full sweep — 16/19 once i|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|952|pending|KEEP_BACKLOG|Q#952|[animal-hospital] The original's patients SPEAK — a bottom-centre handwritten yellow |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|953|pending|UNKNOWN|Q#953|[telepty] The -- separator convention is applied inconsistently: spawn never splices |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|954|pending|UNKNOWN|Q#954|[telepty] clean --idle silently ignores --idle unless --older-than is also given — th|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|955|pending|UNKNOWN|Q#955|[telepty] package-lock.json is stale — it lacks the engines node>=20 block package.js|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|957|pending|KEEP_BACKLOG|Q#957|[animal-hospital] Show the player their own 최고 시프트 — we compute it, persist it, gate |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|958|pending|KEEP_BACKLOG|Q#958|[animal-hospital] The original pays in 애니멀 코인 for DISCOVERY, not performance — a best|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|959|pending|UNKNOWN|Q#959|[telepty gh#61 defect 1] `telepty update` prints a success banner and exits 0 after t|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|961|pending|UNKNOWN|Q#961|[telepty] Dead broker client on a hot path — every discoverSessions() calls discoverB|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|962|pending|UNKNOWN|Q#962|[telepty] bypassBootstrapQueue is an unwired seam — daemon.js:2944 branches on it and|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|963|pending|UNKNOWN|Q#963|[telepty gh#43] The inject audit log loses the WHAT for every --ref inject — ref_path|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|964|pending|UNKNOWN|Q#964|[telepty] `telepty injects` is undiscoverable — absent from the global help, so the g|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|965|pending|UNKNOWN|Q#965|[telepty] `telepty broadcast` has no way to exclude the sender — the orchestrator rec|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|966|pending|KEEP_BACKLOG|Q#966|[animal-hospital] Graphics-settings values change without anyone deciding and nothing|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|967|pending|UNKNOWN|Q#967|[telepty gh#43] 38 percent of injects carry a CLAIMED sender that was never verified,|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|968|pending|UNKNOWN|Q#968|[orchestrator] The peer three-round cap is keyed on the CALLER'S SPELLING of the peer|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|969|pending|UNKNOWN|Q#969|[orchestrator ops] The tailnet listener on :3848 is down, so cross-machine workers ha|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|970|pending|KEEP_BACKLOG|Q#970|[animal-hospital] enableFrameTimingStats ships ON with NO READER — nothing in the tre|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|971|pending|KEEP_BACKLOG|Q#971|[animal-hospital] SSAO DepthNormals at radius 0.4 is UNTESTED — the only Depth-vs-Dep|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|972|pending|KEEP_BACKLOG|Q#972|[animal-hospital] The FairyNurse greeter is now noticeably dimmer and harder to pick |현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|973|pending|UNKNOWN|Q#973|[telepty] TASK_COMPLETION_UNKNOWN fired 10 times for one worker in one session and al|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|974|pending|NEXT_DEPENDENCY|Q#974|[orchestrator] Autonomous detection of finished-and-idle worker sessions — the orches|#1136 settlement/검증/cleanup 수용 확인; 현황 별도 검증|
|978|pending|KEEP_BACKLOG|Q#978|[animal-hospital] Two committed documents give different wall band splits — #949 meas|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|988|pending|KEEP_BACKLOG|Q#988|[animal-hospital] Three smaller items owed from the rooms wave — coffee buttons stati|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|992|pending|UNKNOWN|Q#992|[telepty] `telepty list` UNDER-REPORTS live sessions after a daemon restart - reachab|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|993|pending|UNKNOWN|Q#993|[animal-hospital] The test sweep result DEPENDS ON SUITE ORDERING - LightSurfaceTest |현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|995|pending|UNKNOWN|Q#995|[animal-hospital] Scene regeneration mutates a SHARED FONT ASSET as a side effect - '|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|996|pending|UNKNOWN|Q#996|[telepty] When the daemon is down, inject reports 'Session <sid> was not found on any|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|1000|pending|KEEP_BACKLOG|Q#1000|[animal-hospital] HUD parity from the 2026-08-26 reception frame: (1) the original ha|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|1005|pending|KEEP_BACKLOG|Q#1005|[animal-hospital] Assets/_Project/Prefabs/DogPatient.prefab is a legacy 2-primitive g|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|1009|pending|UNKNOWN|Q#1009|[animal-hospital] A REPEATING SHAPE, not a bug: the suite asserts the OUTPUT of a gat|현재 소스/수용 결과 미검증; 원본 주장과 후속 완료 이력 대조|
|1067|pending|KEEP_BACKLOG|Q#1067|[animal-hospital] USER 2026-08-26 design brief 「변칙성 동물병원 게임 최종 기획서」 — TWO QUESTIONS S|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|1076|blocked|ACT_NOW|B2+Q|[animal-hospital] USER 2026-08-30: 'E가 안눌려 (진찰, 직업)' — E does nothing on Inspect and |#1132 수용 및 실제 E 입력 로그 기반 재현; 해결 선언 금지|
|1079|pending|NEXT_DEPENDENCY|Q#1079|An inject can be ENQUEUED to a worker's mailbox and never delivered as a turn — ps981|#1128 전달 재현; 잘못된 자동 resume 별도 보존; 현황 별도 검증|
|1111|pending|KEEP_BACKLOG|Q#1111|[task-queue] Separator normalisation of the status vocabulary after #1108: in_progres|현재 영향·요구 유지 여부 확인 후 재우선화; 산출물 미검증|
|1128|delegated|ACT_NOW|A1+B1|[orchestrator inbound] Four worker HOLD injects (tp1099 08:05, tp1125 08:03, tp1127 0|isolated tester 재현 → modal-safe 알림 SPEC; 새 sweep 중복 구현 금지|
|1129|pending|NEXT_DEPENDENCY|Q#1129|[telepty] Re-open the grok read-screen symptom with EVIDENCE: spawn one grok worker, |원본 outputRing 저장 재현 승인 범위 확인; 현황 별도 검증|
|1132|delegated|ACT_NOW|B2|[animal-hospital] Prepare build #6 carrying #1117 per-press instrumentation; builder |candidate 계측 TC/장면 reference 보존 비교 계약 확정|
|1133|delegated|ACT_NOW|A4+Q|[model-router] USER approved productionization: structured task requirements, executa|bec82eb 수정본 수신; capacity 원자성/입력 누락 검토|
|1136|delegated|ACT_NOW|A1/A3+B3|[workflow-production] USER explicitly authorized productionizing workflow efficiency |수정 스펙 호출자 오류·writer/settlement 계약 검토 → 승인 범위 내 실행|
