# Daemon recurrence: task #751

Analyst: da751-analyst (original, commit `f41bca2`). **Revision: da751b-analyst, 2026-09-10 — evidence qualification only.** No fixes, tests, runtime
probes or restarts were performed for this revision. Does not replace `docs/reports/2026-09-10-session-observation-gap.md`.

**What this revision changed.** The original timeline and source reading are largely sound and are retained. Its *causal* language was not: it
declared the 11:32Z onset explained ("not a crash", "a serving daemon was SIGKILL'd by CLI", "refute crash/SIGTERM") on evidence that cannot carry
that, and it misstated four source predicates. **The initial cause of the 11:32Z outage is UNKNOWN.**

Labels — **R**: re-read this revision from a retained raw file. **X**: original-author claim from ephemeral command output, raw capture NOT retained,
not independently verified. **S**: installed source, re-read this revision. **O**: orchestrator observation. **H**: hypothesis.

## Currentness

- Worktree `evidence/751-daemon-recurrence` HEAD `f41bca26133052ee939675e76749c6c143ef6df8` (the original report commit; the parent `17a6681` named in
  the first revision is no longer HEAD). Local `main` `45aa5fb58dc401b157de58d97d10a057ea98c4d4`, `origin/main`
  `a536cd8b303f6781ccccc9f4817aa8a6c0416845`. **The report exists on neither main nor origin/main** (`git cat-file -e`: absent on both) —
  branch-local.
- Installed telepty == sibling checkout `/Users/duckyoungkim/projects/aigentry-telepty`, v`0.8.3`, HEAD `997ea7c7d98b1dbc420e2e6de95d455a150e1b2c`.
  Re-hashed this revision, unchanged since the original: cli.js `7bd030dd…c5911`, daemon.js `a99e5887…64ae`, daemon-control.js `ff9f3603…af06b`,
  src/supervisor.js `c4ef40e8…b2e8562` (full digests of all four, and of the retained raw copies, in `state/evidence/751/MANIFEST.md`). Same tree as
  now — **not proof that this tree was resident during the incident.**
- X: the launchd job state at 11:47:19Z (pid 52465, `runs=345`, last signal `Killed: 9`, min runtime 10, KeepAlive true), the runningboardd
  termination record and the `lsof` listener row all came from ephemeral `launchctl print` / `log show` / `lsof` runs. **No raw capture was retained,
  and this revision did not re-run them** — re-running yields a new snapshot, not the historical record. Every launchd/runningboardd row below is
  therefore an original-author claim.
- Loopback bind + `TELEPTY_NO_TAILNET_AUTO=1` are configured, not a cause. Protected orchestrator/codex ancestors untouched; no kickstart/list/inject
  used to measure, this revision included.

## Raw evidence retention

Copies and capture-time hashes: `state/evidence/751/MANIFEST.md` (untracked on purpose — `state/*` is gitignored). Retained: the full
`~/.telepty/logs/daemon-restart.log` (sha256 `f3e6c4fd…a8d67`, 56 lines); `~/.telepty/supervisor-defer.json` (`4410fb23…09f7b`); a bounded excerpt of
`~/Library/Logs/aigentry-orchestrator/telepty-daemon.log` lines 64590-64740 (source sha256 at capture `e83a6231…2ad2f3e6`). That stdout log is
append-only and grew during this review (4940264 → 4940994 B), which is why the excerpt and hash are pinned. Redaction check on the excerpt for
token/bearer/authorization/secret/password/api-key/jwt: 0 hits — no prompt or session payload is retained. Not recoverable and therefore not retained:
the launchd, runningboardd and lsof rows above.

## Timeline (11:31-11:47Z)

Daemon stdout has no UTC stamps; line order is append order across daemon generations, never a duration.

| Time (UTC) | Src | Fact |
|---|---|---|
| 11:32:17.695 | X | launchd: service inactive + pending spawn |
| 11:32:19.007 | X | spawned telepty **36286**; 11:32:19.044 inactive again (lived ~37ms) |
| 11:32:19-11:33:09 | X | inactive/pending every 10s (attributed to min-runtime throttle) |
| 11:32:24.123 | R | restart-log attempt 1/3 `no-daemon-after-launchd-restart` stopped=0 |
| 11:32:29.029 | R | attempt 1/3 `supervisor-kickstart-failed: launchctl kickstart -k gui/501/com.aigentry.telepty` **stopped=1** |
| 11:32:34-11:33:14 | R | 6 further attempt-failed lines (invocation count below) |
| 11:33:19.107 | X | spawned **37572** (survived) |
| 11:42:14.495 | R | `supervisor-defer.json` written, signature `launchd:3848` (10s defer wait expired) |
| 11:42:22.317 | X | inactive + pending; 11:42:23.626 spawned **47179**, ~37ms later inactive |
| 11:42:28-11:43:18 | R | 7 attempt-failed lines; two carry **stopped=1** (11:42:28.758, 11:42:38.789) |
| 11:43:23.695 | X | spawned **47644** |
| 11:47:09.727 | X | inactive; runningboardd: pid 47644 termination `(2, 9, 9)` = SIGKILL |
| 11:47:11.093 | X | spawned **52465** |

- **R — the restart log is silent at 11:47.** Last entry that day: 11:43:18.800Z. A *successful* restart writes no line at all (only `attempt-failed`
  and `stop-refused` are logged, `cli.js:607`), so the absent line is equally consistent with a CLI restart that succeeded, a `kickstart -k` run
  outside telepty, or any other SIGKILL source. It **does not** identify who killed pid 47644, and that record is 15 min after onset.
- **R — how many callers.** The file's only event type is `attempt-failed` (56/56 lines, 09-07 → 09-10). `supervisor-kickstart-failed` returns
  immediately (`cli.js:757-767`), so such a line can never be followed by a higher attempt number in the same invocation. Wave 1 is `1/3 ×4, 2/3 ×2,
  3/3 ×2` with two `1/3` lines being kickstart-failed ⇒ **≥4 `restartDaemonGraceful` invocations** (wave 2 ⇒ ≥3; two sequences ran 1→2→3 at ~20.1s
  spacing) — a *source-conditioned inference*, not a measurement: it assumes the running implementation matched 997ea7c and that file order reflects
  invocation order. On 09-09 **three lines share the millisecond 09:17:18.996Z** (also 2 at 09:22:57.558Z, 2 at 14:00:24.438Z). A millisecond
  coincidence alone establishes neither a process count nor any causal relation between invocations, and **there is no PID evidence at all** — no
  caller pid, no request id (fields: `event attempt port supervisor stopped failed reason` + ISO ts). The original's "two CLIs" remains a count the
  log cannot support.
- **R — stdout excerpt.** After `[INJECT] pd1148b … bb78139d` + `[SUBMIT]` the next line is `Starting telepty daemon...`, then `restored 1647 tracked
  injection(s)`, persisted-session restore, `[MAILBOX] DeliveryEngine started`, then `listening on http://127.0.0.1:3848` — restore-before-listen is
  visible at runtime, with no duration attached. No `[MAILBOX] DeliveryEngine stopped` precedes it (one does precede the earlier restart at line
  64351, so the marker is real when a graceful stop happens). Whole file: 0 SIGTERM/SIGINT/SIGKILL strings, 160 `Starting telepty daemon...`, 147
  `listening`, 19 `already running` — only one (line 60480) in the singleton-claim form, long before this incident. **Absence of a shutdown message is
  not proof of SIGKILL**: `process.exit(0)` on both collision paths also skips it, and the file has never held a signal string, so the marker
  discriminates nothing here.

## What the code does (S — re-read at 997ea7c)

- **Probe sequence, `ensureDaemonRunning` (`cli.js:1246-1311`):** `getDaemonMeta` ×3 on `/api/meta` (attempt 1 at `probeTimeoutMs()`=1500ms, attempts
  2-3 at ×2=3000ms, backoff 200/400ms); then, only if no `meta.version`, **one** `/api/sessions` at 5000ms; then, only if nothing answered at all,
  **one** `probeDaemonHealth` at `probeTimeoutMs()*3`=4500ms. **Correction: `/api/health` is one request at a 3× deadline, not three requests.** It is
  registered at `daemon.js:386`, before `createAuthMiddleware` (`:391`) — unauthenticated.
- **Absence guard (`cli.js:667-682`):** with `absenceVerdict === true`, **one** `probeDaemonHealth` at 4500ms runs **once, before the retry loop**
  (loop at `:694`) — not before each stop. A 200 writes `event=stop-refused` and returns without stopping. **Correction: "re-check health×3 … skip
  stop if 200" states neither the count nor the placement correctly.**
- **Second, in-loop guard (`cli.js:711-716`):** on supervised installs, after `stopDaemon` and the ≤3s exit wait, `waitForDaemonHealth(1000)` runs; if
  that meta matches version + required capabilities the call **returns success without ever issuing `kickstart -k`**. The original omitted this guard
  entirely.
- **`waitForDaemonHealth` (`cli.js:556-575`) polls `getDaemonMeta` — authenticated `/api/meta` at 1500ms, every 300ms to the deadline; it does not
  poll `/api/health`.** Both the 1000ms and 5000ms waits are meta polls.
- **Stop / restart mechanics:** `stopDaemon` → SIGTERM, 5000ms grace (`daemon-control.js:12,176-198`), then SIGKILL, scoped to the state-file pid and
  the addressed port's owner. Supervisor restart is label-scoped `launchctl kickstart -k gui/<uid>/<label>`, issued through the **synchronous**
  `execFileSync` (`src/supervisor.js:28,179,188` — the local name `execFile` there is an alias for `execFileSync`). `start` first defers 10s
  (`SUPERVISOR_DEFER_MS`, `cli.js:1186`, 300ms poll); on expiry it writes the defer marker (TTL 5min, `src/supervisor.js:43`), and a fresh marker
  makes later CLIs skip the 10s wait.
- **Attempt budget:** the 5s `waitForDaemonHealth` at step (d) is **one component**, not the whole budget — measured inter-attempt spacing in the
  retained log is ≈20.1s (5s SIGTERM grace + ≤3s exit wait + 1s supervised wait + kickstart latency + 5s meta wait + 1-2s backoff). That 5s < the 10s
  min runtime is a source/runtime fact; **"`waitHealth(5000)` always misses the throttle" is not supported** — whether an attempt misses a respawn
  depends on where in the throttle window the kill landed and on call latency, neither measured.
- **`daemon.js` startup order:** singleton claim → on collision prints `already running (pid …)` and `process.exit(0)` (`:501-507`); then
  `restoreTrackedInjections()` (`:3310`), **synchronous**, ~1660 records; then persisted sessions; then `app.listen` (`:5737/5756`). The EADDRINUSE
  loser probes `/api/health`, prints `already running on port …` and exits 0 (`:6176-6191`, #738).
- **Discovery / `list` (`cli.js:966-1029`, `:1936`):** `discoverSessions` always calls `ensureDaemonRunning()` (return value unused). A local
  `/api/sessions` **non-200 throws** and fails the command; the catch at `cli.js:988-992` **rethrows only `isDaemonAnswerError`, so every other
  exception inside that try is swallowed** and contributes zero local sessions. Connect error and timeout are the cases its comment names and the ones
  observed here; the same catch also absorbs a `res.json()` SyntaxError on a malformed 200 and a `sessions.forEach` TypeError on a non-array 200 —
  **source-predicted, untested, not observed here**. A **remote peer** failure stays different: `markCommandFailed()` (exit 1) plus "The session list
  is INCOMPLETE" (`:1022-1027`). `list` then prints `No active sessions found.` and returns, exit 0. Native/cmux workers are never consulted.
- **Existing guards:** #738 defer, #757 no detached spawn under a supervisor, #82 health-200 pre-stop guard, #902 port scoping, #896/#910 title/state
  claim, #916 SIGTERM shutdown. None serialize two `kickstart -k` callers across processes.

## A / B / C

**A — initial 11:32Z exit: UNKNOWN.** Nothing in hand identifies it. The restart log's earliest line is 11:32:24.123Z, *after* the launchd inactive
record at 11:32:17.695Z (X), and carries no caller pid; the SIGKILL record is 15 min later (X). Ranked hypotheses with the correlation each is
missing:

- **H1 — a CLI stop hit a live daemon.** Support: three lines carry `stopped=1` (11:32:29.029, 11:42:28.758, 11:42:38.789), so `stopDaemon` really
  terminated a process during the waves; O: the orchestrator saw a `telepty list` child run `launchctl kickstart -k`. Missing: any record before
  11:32:17.695Z, and any caller-pid/signal trace tying a CLI to the *first* death — every `stopped=1` line is already inside the outage, i.e. evidence
  about amplification, not onset.
- **H2 — the daemon exited on its own** (crash/uncaught/OOM). Not refuted; the "no shutdown message" argument does not touch it (above), and no
  exit-status capture was retained.
- **H3 — a `kickstart -k` from outside telepty.** Not excluded; nothing in the restart log would record it, and the 11:47 SIGKILL notably has no
  restart-log line at all.
- **H4 — sleep / clock / tailnet.** Not measured, not excluded.

**Zero `stop-refused` lines exist in the whole file.** That does *not* show the guard ran and found nothing: the other two `restartDaemonGraceful`
callers (`cli.js:947` repair, and the version/capability `restart` verdict) never pass `absenceVerdict`, so they reach the stop with no guard and no
log line either way. To settle A: caller pid + request id in `daemon-restart.log`, a record of *which* probe failed, a success-path log line, and any
signal/exit capture before 11:32:17.695Z. None exist today.

**B — amplification: supported hypothesis, NOT confirmed.** Source shows only what the code *can* do: each attempt **may** stop the addressed daemon and then issue a label-scoped `kickstart -k`, with no cross-process lock. That invocations actually **overlapped** on 09-10 is a *source-conditioned inference* from interleaved log lines, not something source can confirm — source describes a single invocation, and the log carries no caller pid or request id. **May, not will:** three checks return before the first `kickstart -k` is ever issued — the pre-loop `/api/health` 200 guard (before any stop), and, inside the attempt, the 1s `/api/meta` supervised-restore wait and the surviving-port-owner check. The credential-refusal branch is **not** one of them: it sits after `waitForDaemonHealth(5000)`, i.e. after that attempt's kickstart, and only prevents a further retry. Not confirmed: that this held the listener down for minutes (no timing proof a kill landed on a *serving* daemon), and the
~37ms child deaths. On those the original named singleton-claim and EADDRINUSE, each of which prints a distinctive line after `Starting telepty
daemon...` (`cli.js:1918`); **no such line appears in the excerpt window, but that stdout is unsequenced and carries no PIDs, so nothing in it can be
attributed to pid 36286 or 47179.** That is *absence of correlated PID/timing proof*, not counter-evidence — without a line-to-child mapping it can
neither support nor refute an identified cause. Settling B needs a controlled repro or correlated per-process timing, not this log.

**C — false empty list: confirmed in source, observed in helpers, repro still owed.** The chain is exact (above): local-unreachable → swallowed → `No
active sessions found.` exit 0 while cmux workers live. O: an inject during the gap failed with session-missing / kickstart-failed exit 1 (pi1149). A
repro must separate three cases the output cannot: (i) local daemon unavailable, (ii) local daemon healthy and genuinely empty, (iii) remote-only
partial discovery — (iii) already exits nonzero with a banner, (i) and (ii) are indistinguishable. pd 11:44:15Z session-death is a SIGTERM of the
**worker** (duration 771s), not the daemon. Gate `decision-reconciler-07ee3a9fd7ca` reuse belongs to classifier C of the prior report.

## Mitigation

**Operational, evidence-backed:** do not use `telepty list` / `inject` / `daemon restart` / `launchctl kickstart -k` to *check* an outage — the
discovery path these commands take reaches `ensureDaemonRunning` (`cli.js:967`), whose `start` verdict can reach a stop plus `kickstart -k`. Scoped to
the list/inject/discovery paths measured here — **not** a claim that every telepty command ensures; `help` and the `daemon` entry were not measured.
Read state with `launchctl print`, `lsof -nP -iTCP:3848` and native cmux. Leave `supervisor-defer.json` alone unless a coder owns it.

**Candidate directions — NOT approved remedies, none validated here, for the architect to contract:** cross-process serialization of supervised
restarts (a new dependency and a cross-OS contract — the architect's call, not this report's); start-if-needed instead of kill-and-replace; a
`waitForDaemonHealth` ceiling related to the supervisor's throttle; `list`/`inject` exiting nonzero `daemon-unavailable` on a *local-unreachable*
discovery instead of printing "no sessions". **Explicitly withdrawn from the original: moving `app.listen` before the ledger restore** — untested; the
restore is synchronous, so it would keep blocking the event loop; and serving `/api/*` before the ledger and session maps are populated exposes
uninitialized state. It is an architecture proposal, not the smallest proven fix. Do not re-implement #738/#757/#82 by name.

## Isolated tester fixture (not run)

Owner: `cli.js` `ensureDaemonRunning`/`restartDaemonGraceful`, `src/supervisor.js`, `daemon.js` restore-vs-listen, `cli.js` `discoverSessions`
empty-list. Private port + fake supervisor (KeepAlive, min-runtime, `kickstart -k` = SIGKILL+respawn); fixture daemon delays restore, then listens,
health only after listen; ≥2 overlapping CLI `list` processes. Expected RED: overlapping `kickstart-failed` + `no-daemon-after-launchd-restart`;
`list` prints `No active sessions found` exit 0 while a live child exists. Controls: #82 health-200 still refuses the kill *and writes*
`stop-refused`; #738 no detached orphan; #757 no detached spawn under a supervisor; single-CLI genuine absence still starts; inject after bind still
works. **Limit:** an isolated model validates the source path and the candidate mechanism (B) only; it **cannot settle the historical 11:32Z cause
(A)** — reproducing a mechanism is not attributing this incident. Historical A needs new correlated event evidence (caller pid, request id, a
success-path log line, a pre-11:32:17.695Z signal/exit capture). Not run.

## Bottom line

**미확인:** 11:32Z 최초 중단의 원인은 **모름**. 11:47 SIGKILL 기록은 15분 뒤이고, restart 로그에는 11:47 항목이 아예 없으며(성공 경로는 로그를 남기지 않음) 호출자 pid·요청 id가 없어 최초 사건과 어떤 CLI도 연결되지
않는다. launchd/runningboardd 근거는 원 작성자 주장이며 원본 캡처가 남아 있지 않다. 직전 판본의 "크래시가 아니다", "살아있는 데몬을 CLI가 SIGKILL했다"는 단정은 철회한다.

**확인:** (1) 호출 겹침 자체가 **소스로 확인되는 사실이 아니다** — 로그 줄 인터리브에서 나온 소스 조건부 추론이며(소스는 단일 invocation만 기술), "최소 4회"도 측정이 아니라 같은 추론(구현 동일·시간 순서 가정)이다. PID 증거는 전혀 없고 밀리초 일치만으로 프로세스 수나 인과를 세울 수 없다. (2) 소스상 각 시도는 addressed 데몬을 정지시킨 뒤 label-scoped `kickstart -k`를 실행할 **수 있다**(반드시가 아님 — 첫 kickstart 전에 반환하는 것은 루프 전 `/api/health` 200 가드, 루프 안 1s `/api/meta` 복구 대기, 포트 소유자 확인 셋뿐이다. 자격 거부 분기는 `waitHealth(5000)` 뒤, 즉 그 시도의 kickstart 이후라 재시도만 막는다); 프로세스 간 락은 없다. (3) `cli.js:988-992`의 catch는 `isDaemonAnswerError`만 재던지므로 **그 외 모든 예외가 삼켜진다** — 이번 사건에서 관측된 것은 연결 불가/타임아웃이고, 잘못된 200 본문의 SyntaxError나
배열이 아닌 200의 TypeError는 소스상 예측되지만 미검증이다(원격 피어 실패는 여전히 exit 1 + INCOMPLETE). (4) restore가 listen보다 먼저이고 동기다. **가설:** 동시 시도가 중단을 실제로 연장했는지(B),
~37ms 자식의 사인(stdout은 순서·PID가 없어 특정 자식에 귀속 불가 — 반증이 아니라 상관 증거 부재), `waitHealth(5000)`의 스로틀 상시 미스 여부(측정 안 됨). **다음:** 픽스처는 메커니즘 검증용이며 역사적 A는
가릴 수 없다(테스터 소관). 운영 중 list/inject/discovery 경로로 재측정 금지. `app.listen` 재배치는 승인된 처방이 아니다.
