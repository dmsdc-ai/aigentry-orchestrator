# Recovery Runbook — telepty + brain (백업 · 복원 · 재개)

> **용도**: 유료 셋업 딜리버러블의 "recovery workflow" 문서(고객이 소유). #597 스모크 환불-리스크 #1(HIGH) 해소.
> **검증 근거**: #597 스모크(docker node:20, telepty 0.6.2 / brain 0.2.7)에서 backup→삭제→restore→데몬 재기동을
> 실제 명령으로 확인 — authToken / sessions.json / brain mailbox 바이트 동일 복원, 데몬 health ok.
> **상태**: DRAFT — 실머신 리허설(claude CLI 실존 머신)에서 이 절차를 그대로 실행해 최종 검증 후 v1 승격.

---

## ⚠️ 먼저 알아야 할 한계 (정직하게)

| 복원되는 것 | 복원 안 되는 것 |
|---|---|
| 인증 토큰, 세션 **레코드**, 등록된 peer/relay 설정, brain 메모리/프로파일/mailbox, 설정 | **라이브 PTY 프로세스 자체** — 실행 중이던 에이전트 세션은 머신/데몬이 죽으면 사라진다. 복원 후 `telepty list`는 "No active sessions"이고, 세션은 **다시 spawn**해야 한다. |

즉 이건 "**설정·기억·이력의 백업/복원**"이지 "실행 중 프로세스의 라이브 마이그레이션"이 아니다. 컨텍스트(brain 메모리)와
이력(감사 로그)은 살아남으므로, 재개 시 에이전트에게 "이전 컨텍스트를 brain에서 로드"시키면 작업은 이어진다.

## 백업 대상 (실측 확정 — 이 3개가 telepty/brain의 전체 상태)
```
~/.telepty/                     # 데몬 상태, authToken, sessions.json, 감사 로그(injects.jsonl), peers
~/.aigentry/                    # 세션/role-sandbox/telemetry 등 에코시스템 상태
~/.config/aigentry-telepty/     # 사용자 설정
```
> macOS/Linux 기준. `$HOME` 하위. 민감정보 포함(authToken·감사 로그) → 백업 파일은 0600 + 안전한 위치.

---

## 1. 백업 (Backup)

### 1-1. 안전 백업 (데몬 멈추고 — 일관성 보장, 권장)
```bash
# 1) 데몬·세션을 깨끗이 멈춘다 (라이브 세션은 어차피 복원 안 되므로 OK)
telepty kill --all 2>/dev/null || true     # 활성 세션 정리(있으면)
# 데몬 정지: launchd 관리 시 ↓, 아니면 포트 소유 PID에 TERM
launchctl stop com.aigentry.telepty 2>/dev/null || kill -TERM "$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t 2>/dev/null)" 2>/dev/null || true

# 2) 상태 3종을 한 파일로 (타임스탬프 백업)
STAMP=$(date +%Y%m%d-%H%M%S)
tar -czf "$HOME/aigentry-backup-$STAMP.tgz" -C "$HOME" .telepty .aigentry .config/aigentry-telepty
chmod 600 "$HOME/aigentry-backup-$STAMP.tgz"
echo "backup → $HOME/aigentry-backup-$STAMP.tgz"
```

### 1-2. 핫 백업 (데몬 켜둔 채 — 빠르나 진행 중 쓰기와 경합 가능)
```bash
STAMP=$(date +%Y%m%d-%H%M%S)
tar -czf "$HOME/aigentry-backup-$STAMP.tgz" -C "$HOME" .telepty .aigentry .config/aigentry-telepty
chmod 600 "$HOME/aigentry-backup-$STAMP.tgz"
```
> 핫 백업은 데몬이 파일을 쓰는 순간과 겹치면 미세 불일치 가능. 정기 백업이면 1-1 권장, 빠른 스냅샷이면 1-2.

### 1-3. (선택) 정기 자동 백업
cron/launchd로 1-2를 매일 실행 + 오래된 파일 N개만 보관(rotate). 예:
```bash
# crontab -e — 매일 03:00, 최근 7개만 유지
0 3 * * * tar -czf "$HOME/aigentry-backup-$(date +\%Y\%m\%d).tgz" -C "$HOME" .telepty .aigentry .config/aigentry-telepty && ls -1t "$HOME"/aigentry-backup-*.tgz | tail -n +8 | xargs -r rm
```

---

## 2. 복원 (Restore) — 같은 머신 또는 새 머신

```bash
# 0) (새 머신이면) 먼저 설치 — 1-command
npm i -g @dmsdc-ai/aigentry-telepty @dmsdc-ai/aigentry-brain

# 1) 기존 데몬 정지 (복원 중 쓰기 충돌 방지)
launchctl stop com.aigentry.telepty 2>/dev/null || kill -TERM "$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t 2>/dev/null)" 2>/dev/null || true

# 2) 백업 풀기 (기존 상태를 덮어씀 — 필요시 기존 디렉토리 먼저 따로 보관)
tar -xzf "$HOME/aigentry-backup-<STAMP>.tgz" -C "$HOME"

# 3) 데몬 재기동
telepty daemon &            # 또는 launchd 관리 시: launchctl start com.aigentry.telepty
sleep 2

# 4) 검증
curl -s http://127.0.0.1:3848/api/health    # → {"status":"ok",...}
telepty list                                  # 세션 레코드 확인(라이브 세션은 비어있는 게 정상 — §한계)
aigentry-brain health                         # brain 상태 ok
```

---

## 3. 재개 (Resume) — 작업을 이어가기

복원은 "상태"를 되살릴 뿐, 실행은 다시 시작한다:
```bash
# 1) 필요한 에이전트 세션을 다시 spawn (래핑 대상 CLI는 이 머신에 설치돼 있어야 함 — 전제조건)
telepty allow --id <session-id> claude     # 예시; codex/gemini 등 동일

# 2) 이전 컨텍스트 이어받기 — brain에 보존된 메모리/프로파일을 에이전트가 로드하도록 첫 프롬프트에 지시
#    (감사 이력은 ~/.telepty 의 injects.jsonl 에 보존되어 "이전에 무엇을 했는지" 조회 가능)
telepty injects --tail --to <session-id>   # 직전 작업 이력 확인
```
> 핵심: **brain 메모리 + 감사 이력이 살아있으므로**, 세션을 다시 띄우고 "brain에서 이전 컨텍스트 로드"를 지시하면
> 작업 연속성이 유지된다. 사라지는 건 "실행 중이던 프로세스"뿐, "무엇을 어디까지 했는지"는 남는다.

---

## 4. 머신 이전 (Machine A → B) 체크리스트
1. A에서 §1-1 안전 백업 → `aigentry-backup-*.tgz`를 B로 안전 전송(scp 등; 민감정보 주의).
2. B에서 §2 복원(설치 → 정지 → 풀기 → 재기동 → 검증).
3. B에 **래핑 대상 CLI(claude/codex 등) 설치 + 로그인** 확인 (telepty가 대신 안 해줌 — 전제조건).
4. B에서 §3 재개.

---

## 부록: 완전 제거 (Uninstall) — 고객이 물어볼 항목
> ⚠️ 현재 `npm rm -g`는 잔여물을 남긴다(스모크 #597 / telepty GH#49). 완전 제거 수동 절차:
```bash
# 1) 데몬 정지 + (macOS) launchd 해제
launchctl stop com.aigentry.telepty 2>/dev/null; launchctl unload ~/Library/LaunchAgents/com.aigentry.telepty.plist 2>/dev/null
kill -TERM "$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t 2>/dev/null)" 2>/dev/null || true
# 2) 패키지 제거
npm rm -g @dmsdc-ai/aigentry-telepty @dmsdc-ai/aigentry-brain
# 3) (데이터까지 지우려면) 상태 디렉토리 — 백업 먼저!
#    rm -rf ~/.telepty ~/.aigentry ~/.config/aigentry-telepty ~/Library/LaunchAgents/com.aigentry.telepty.plist
```
> 자동화는 telepty #49(preuninstall 훅)에서 다룬다. 그 전까지는 이 수동 절차가 공식.

---
*근거: #597 스모크 리포트(docs/reports/2026-06-10-smoke-597-clean-install.md). DRAFT — 실머신 리허설 후 v1.*
