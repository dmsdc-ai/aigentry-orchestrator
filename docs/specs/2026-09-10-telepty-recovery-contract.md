# Telepty daemon recovery & error contract (#751)

**Status**: SPEC, revision 2 — design only; no code, tests, probes, restarts or supervisor calls were run, and
implementation stays blocked until this is approved AND §7's reds fail first against unmodified source. R2 supersedes R1
in place: claim-stealing removed and reclaim made fail-closed (§5), reporting given exact branches incl.
TOCTOU/`--json`/remote-host (§4), deadline model replaced (§6), actuation safety corrected — **R1's fixture was not
fail-closed** (§7). §4 and §5 are separately approvable: §5's reclaim/release race safety is **unresolved**, so it is
not implementation-approved. **Source**: `/Users/duckyoungkim/projects/aigentry-telepty` @ `997ea7c` (`main`, v0.8.3);
every predicate below re-read at R2 time, HEAD still the dispatched SHA, no tracked modifications. That tree is the
*installed* telepty (0.8.3 symlinks) — nothing here merges into or restarts it.

## 1. Measured facts

**Destructive callers, exact** (`restartDaemonGraceful` / `stopDaemon` / `cleanupDaemonProcesses` /
`startDetachedDaemon` / `restartSupervisorDaemon`, non-test): *automatic* — `ensureDaemonRunning`→`doRestart`
(cli.js:1387), `repairLocalDaemon` (941,947); *operator* — `update` (1787), interactive
`update`/`repair-daemon`/`daemon` (1496,1524,1516–1517), `cleanup-daemons` (1856), `daemon start|stop|restart`
(1877,1886,1905–1906); *install-time* — install.js:44, scripts/postinstall.js:104. This contract binds the automatic
pair plus §5's ownership rule, observed by all of the above; no operator command changes meaning.

**Defect predicates**:

- `ensureDaemonRunning` returns `undefined` on every **non-throwing** path — healthy, alive-but-slow and *failed
  restart* alike (cli.js:1379–1394); it throws on `abort` (cli.js:1358,1373). Callers cannot tell success from a failed
  recovery.
- `discoverSessions`'s local arm catches **every** error that is not a `DaemonAnswerError` (cli.js:988–992) — its
  comment says "connect error / timeout only", but the catch is unconditional, so a malformed 200 body (`res.json()`
  SyntaxError, 984) and a 200 whose shape is not an array (`sessions.forEach` TypeError, 985) also degrade to `[]`.
  Local-unreachable is the observed case, not the only hole, and the malformed/invalid-shape behaviour is untested
  today. An answered non-200 does fail correctly (983 → 345–362).
- `list --json` prints `[]` and **returns before** the empty check (1932–1935); otherwise `No active sessions found.`
  prints at 1936 **regardless of `markCommandFailed`** — the existing `peerFailures` path (1013–1024) already exits 1
  while still printing it.
- The local arm hardcodes `127.0.0.1` (cli.js:977) whatever `TELEPTY_HOST` is, while `ensureDaemonRunning` returns
  immediately for a non-local host (1249). `getDiscoveryHosts` (956) is called only from 4554, never here.
- `absenceVerdict`'s health re-confirm runs **once, before** the retry loop (cli.js:678–697); attempts 2–3 call
  `cleanup({port})` (702) on stale evidence, and nothing re-checks between `cleanup` and `kickstart`/spawn (748–763).
- Post-kickstart wait is `waitHealth(5000)` (765) while `deferToSupervisor` waits 10 000 (1186); with three attempts,
  per-attempt backoff (791–796) and independent probe deadlines the path has **no outer bound**.
- No cross-process coordination exists here (§5): two CLIs at the absence verdict each run `cleanup()` and `kickstart
  -k`. The installed plist has `KeepAlive true`, `RunAtLoad true` and **no `PORT` key** → `supervisedPort()` null →
  `supervisorFor`'s `DEFAULT_PORT` fallback (593–604) is the production path.

**Not established, assumed nowhere below**: why the daemon exited or hung at 11:32 — the 11:31–11:44 UTC sequence is an
outcome, not a reproduction, the 11:47 SIGKILL does not explain 11:32, the restart-log lines carry no caller PID so even
"two CLIs" is unproven, and no launchd timing figure is treated as a cause. Scope: **misreporting, unbounded recovery,
overlapping recovery**.

## 2. State vocabulary

| State | Evidence | Destructive action |
|---|---|---|
| `healthy` | meta version + capabilities match | no — `noop` (cli.js:1166) |
| `alive-but-slow` | meta timeout **and** `/api/health` 200 | never on the absence path (678,1174) |
| `refused` / `broken` | 401/403 / 5xx, or a 200 whose body is unreadable or not an array | never — abort (1145) |
| `legacy` / `mismatched` | sessions ok without meta / version or capability mismatch | yes, **deliberate** |
| `absent` | nothing answered on meta, sessions **and** health | yes, guarded |
| `recovering` | another process holds a live §5 claim | no — bounded wait, then re-decide |
| `unavailable` | the local read failed to produce a validated array, or recovery produced no accepted daemon | no — **report** |
| `claim-blocked` | a claim exists that cannot be safely reclaimed | no — named error |

## 3. Invariants

- **I1 — an empty list is a current measurement.** `[]` may print only when *this* command's `/api/sessions` response
  arrived, was 2xx and parsed to an array. Any failed read is `unavailable` **regardless of an earlier healthy verdict**
  — an `ensureDaemonRunning` success is evidence about the past, not permission for a later empty result.
- **I2 — locality and authority.** With `TELEPTY_HOST` non-local a local-arm failure stays non-fatal exactly as today; a
  peer failure never degrades the local verdict, nor a local failure masquerade as a peer one (cli.js:1058 #837,
  1013–1024 #835).
- **I3 — revalidate per destructive step.** `cleanup`, `kickstart`/spawn and each retry require evidence obtained after
  the previous step; between `cleanup` and `kickstart` the port owner and health are re-read, and an accepted healthy
  daemon appearing there aborts the rest and re-decides. A waiting joiner revalidates with the **full** policy
  (`decideDaemonAction` on meta + capabilities), never health alone.
- **I4 — one recovery owner per addressed port, respected by every destructive caller.** A live claim is never stolen by
  any path, `update` and `repair` included; they preserve intent by bounded waiting and then either executing after full
  revalidation or failing with a named `recovery-busy:<pid>` — eventual bounded execution or an honest error, never
  killing another owner's in-flight recovery.
- **I5 — deliberate destruction stays deliberate, gated on identity not liveness.** The version/capability `restart` and
  `repairLocalDaemon` keep stopping a daemon they know is alive — a health 200 must never block an intended update.
  Their guard is "is this still the daemon I decided to replace" (recorded version/pid); the `absenceVerdict` health
  refusal (678) stays opt-in and absence-only.
- **I6 — scope preservation.** Unchanged: port-scoped supervisor gate (593), no detached spawn under a supervisor
  (748–763), surgical `stopDaemon` (daemon-control.js:453), typed credential/version/capability errors (345,1145),
  fail-fast on a surviving port owner. **I7 — bounded**: every recovery runs under one outer deadline (§6). **I8 — every
  refusal to act is spoken**: one named stderr line (never stdout — `list --json` purity, #400) plus one
  `logDaemonRestartEvent` line (607).

## 4. Reporting contract — exact branches for `list`

| Condition | stdout | exit |
|---|---|---|
| host local, local 2xx + array, no peer failure | sessions, or `No active sessions found.` when empty | 0 |
| local read failed (connect/timeout), or recovery ended `unavailable`/`claim-blocked` | **nothing** — empty line and `[]` both suppressed | 1 |
| local answered non-200 | nothing (existing throw, cli.js:983) | 1 |
| local 200 with an unreadable body or a non-array shape | nothing — classified `broken`, not empty | 1 |
| host non-local (remote-only), local arm failed, peers ok | peer sessions, or `No active sessions found.` when empty | 0 |
| any peer failure (partial), local ok | the sessions actually discovered; **never** `No active sessions found.` | 1 |

Both suppressions are new branches at cli.js:1932–1936 (today `markCommandFailed()` sets only the exit code, leaving
both lines printing); `--json` on a failing branch prints nothing rather than a bare `[]` — a deliberate change, §9. The
malformed row needs no new error type: `daemonAnswerError(null)` already tolerates a null answer and says exactly
"returned a response this CLI could not read. Treating it as a failure, not as an empty result." (cli.js:348–350), so
the local arm narrows its catch and throws that instead of swallowing.

## 5. Recovery ownership

**Existing primitives**: `claimDaemonState` (daemon-control.js:80) claims the *daemon*, not a recovery; the
restart-failure marker (333–360) and supervisor defer marker (supervisor.js:44,138–170) are warning suppression and a
negative cache; `acquireLock` (src/mailbox/storage.js:29) is mailbox-scoped with a 500 ms cap and a synchronous
`Atomics.wait` unfit for a seconds-long async hold, and is **not** reworked here; the daemon's port bind
(daemon.js:5737, EADDRINUSE 6179) excludes *daemons*, after the CLI's destructive step. Nothing scopes an in-flight CLI
recovery. **Claim design** — a helper beside the existing markers in `daemon-control.js`; no new dependency, no `flock`,
no framework (§17 무의존); size not estimated:

- **Identity** `{ ownerPid, nonce, port, kind, claimedAt, deadlineAt }`, `nonce` from `crypto.randomUUID()` — the pair
  (`ownerPid`, `nonce`) is the identity, PID alone is not.
- **Atomic publication**: write the complete JSON to a sibling temp file, then `fs.linkSync(tmp, claimPath)` — `EEXIST`
  when a claim exists, so creation and content publication are one step. `O_EXCL`-create-then-write is rejected: it
  publishes an empty file a concurrent reader can see.
- **Read/release**: `lstat` and reject anything not a regular file (symlink included) or unparseable → `claim-blocked`;
  release reads, compares `nonce` and unlinks only on match, since an unconditional unlink can delete a successor's
  claim. The residual read→unlink window is acknowledged; safety does not rest here.
- **Reclaim is fail-closed**: permitted only when *all* hold — file parses, identity fields present,
  `process.kill(ownerPid,0)` throws `ESRCH`, age exceeds TTL; `EPERM`, any other errno, malformed or unreadable content
  ⇒ **no reclaim** and a `claim-blocked` error naming the owner pid and path. Age alone never authorises a reclaim (a
  sleeping host or blocked event loop makes an old claim indistinguishable from a live one), nor does liveness alone
  (PID reuse); where they cannot be separated the design stops rather than guesses, the operator escape hatch being
  deletion of the named file or `cleanup-daemons`.

**UNRESOLVED — reclaim/release race safety; §5 is not implementation-approved.** A fresh liveness or health check is not
atomic fencing: read→unlink on release and probe→decide→act on reclaim are both TOCTOU windows, so nothing above proves
that a mistaken stale-claim unlink cannot be followed by a successor taking the claim and a destructive step landing on
a healthy replacement — re-reading state more often narrows those windows without closing them, and R1's claim that
per-step revalidation makes a mistaken reclaim harmless is withdrawn. Closing this needs a fencing token honoured by the
destructive step itself, or a design that never reclaims; not settled here. So the two halves are separable and not
approved together: the **reporting/error contract** (§4, C) stands alone and can proceed to red first, while **recovery
ownership** (§5, B) is a sketch with open race safety whose red case (§7) is investigation, not the test of an approved
remedy.

## 6. Deadline model and behaviour deltas

One monotonic (`performance.now()`) outer deadline is established per recovery and threaded through every step,
overridable via `TELEPTY_RECOVERY_DEADLINE_MS`; each probe, wait and claim acquisition gets `min(remaining, its own
cap)`, and when `remaining` falls below the per-step floor the recovery stops with `deadline-exhausted` rather than
starting a step it cannot finish. Today no such bound exists (§1). The post-kickstart settle window is a
**model-supported bound, not a readiness guarantee**, and "raise 5 s to 10 s" is explicitly not offered as the remedy;
every existing error, refusal, port-scoping and no-orphan guard is preserved under the new budget.

**Deltas.** **D1** `ensureDaemonRunning` returns `{ state, reason, port }` from §2 on every non-throwing path
(1248–1394), the `abort` throw unchanged. **D2** `discoverSessions` records the local arm's outcome per I1/I2 and `list`
gains §4's branches. **D3** `restartDaemonGraceful` takes the §5 claim, revalidates per step (I3) and runs under §6's
deadline, keeping its retry count, port-owner fail-fast and every existing message. **D4** deliberate callers (§1)
observe a live claim per I4. Unchanged: `decideDaemonAction`'s branches, `deferToSupervisor`'s markers,
`restoreTrackedInjections()`-before-`listen` (daemon.js:3310,5737) — no early-listen reorder.

## 7. Test plan — red first, fail-closed

**Actuation safety precedes any fixture run.** `test-support/block-signals.js` patches only `process.kill` and
`cp.spawn` (argv containing exactly `daemon`) — **not** `execFileSync`/`execSync`/`spawnSync`, which is how
`restartSupervisorDaemon` invokes `launchctl`/`systemctl`/`schtasks` (supervisor.js:183–210) and how `findPortOwnerPid`
/ `findParentProcessInfo` invoke `lsof`/`ps` (daemon-control.js:211,290). `test-support/setup-env.js` isolates `HOME`
(49–50), hiding the macOS plist but **not** systemd detection at the absolute `/etc/systemd/system/telepty.service`
(supervisor.js:80), so on Linux a fixture could reach a real `systemctl restart`. `TELEPTY_NO_SUPERVISOR_DEFER=1` does
force `present:false` (supervisor.js:54, read by both `deferToSupervisor` and `restartDaemonGraceful`) — it is a
detection kill-switch, not merely a defer skip — but one env var is not fail-closed. Required before red runs: (1) a
preload intercepting `execFileSync`/`execSync`/`spawnSync`/`execFile`/`exec`, **denying by default**, allowing only
read-only `lsof`/`ps`, recording every denial; (2) the existing `_detectSupervisor` / `_restartSupervisorDaemon` /
`_cleanupDaemonProcesses` seams (cli.js:640–651) as primary control, env vars as defence in depth; (3) canaries proving
interception works without a production action; (4) distinct expectations per record type — Red C legitimately produces
**`BLOCKED-SPAWN`** lines (the `startDetachedDaemon` fallback), so the assertion is **zero `BLOCKED-SIGNAL`** and zero
supervisor denials, not an empty log (R1 said "empty log"; wrong).

**Red C — `unavailable` reported as success.** Subprocess `cli.js list` against a bound-then-released ephemeral port
under that harness. Real path: `ensureDaemonRunning` → `start` → `restartDaemonGraceful` → spawn denied → failure →
local connect-error → `[]`. Asserts (failing today): exit ≠ 0; stdout carries neither `No active sessions found.` nor
`[]`; stderr names the local daemon unavailable; zero `BLOCKED-SIGNAL`; zero supervisor denials. Companion cases against
the same stub, all currently reported as an empty success: a 200 with an unparseable body, a 200 returning an object
rather than an array, and §4's remote-host row pinned against regression.

**Red B — cross-process overlap.** Two real **child processes** driving the shipped `restartDaemonGraceful` through its
existing seams, synchronised by filesystem barriers on a shared claim path, plus a case killing an owner child mid-hold;
in-process concurrent calls cannot demonstrate cross-process exclusion and are not used. Asserts (failing today): at
most one destructive step per port across the overlap; the joiner revalidates with the full policy, not health alone;
release on success *and* failure; a dead-owner claim reclaimed only under §5's full conjunction;
`EPERM`/malformed/symlink ⇒ `claim-blocked`, never a steal. Its header states the timing model shows *contention only*,
not the incident's cause; no hand-rolled reimplementation — every assertion runs the shipped function.

**Controls, named individually**: `start-path-liveness-82`, `kickstart-race-738`, `supervisor-restart-757`,
`sweep-scoping-902`, `ensure-daemon-running`, `refusal-not-absence-835`, `refusal-classification-844`,
`release-version-invariant-844`, `local-write-peer-independence-837`, `daemon-restart-fallback-15`. **Runner
inclusion**: `package.json`'s `test`/`test:watch`/`test:ci` carry an explicit file list, not a glob — a file not
appended to all three never runs. Red-proof command:

```
node --require ./test-support/setup-env.js --require ./test-support/<new-guard>.js --test \
  test/recovery-contract-751.test.js test/start-path-liveness-82.test.js \
  test/sweep-scoping-902.test.js test/kickstart-race-738.test.js test/ensure-daemon-running.test.js
```

## 8. Ownership and sequencing

One file, one session; nothing runs in parallel before red exists.

| # | File | Change | Owner |
|---|---|---|---|
| 1 | `test-support/<new-guard>.js` | fail-closed actuation interception + canaries (§7) | tester |
| 2 | `test/recovery-contract-751.test.js` | one bounded fixture: Red C + Red B | tester |
| 3 | `package.json` | append it to `test`/`test:watch`/`test:ci` (a **code** change, not a builder edit) | coder |
| 4 | `daemon-control.js` | §5 claim helpers + exports | coder |
| 5 | `cli.js` | D1–D4 + test exports (`discoverSessions` is not exported today) | coder |

Steps 3–5 begin only after red is observed and the exact candidate remedy is confirmed against those same reds in a
tester-owned git-ignored copy; step 4 and §5's part of step 5 additionally wait on the unresolved race-safety question,
so the reporting contract can ship without them; `snyk_code_scan` + rescan-to-clean applies to each coder session.
**Activation**: nothing here merges into the installed symlinked tree, restarts a live daemon, or publishes — a later
release is legitimate under a separate approved builder gate, which this document neither grants nor permanently
forbids.

## 9. Remaining decisions

1. **`list` exit code and stdout suppression (§4)** — scripts reading exit 0 as "nothing to do" change behaviour and
   `--json` stops emitting `[]` on failing branches. Recommended (that silent zero is the misreport #751 is about, and
   #835 set the precedent for refusals), but consumer-visible: needs the owner's confirmation.
2. **`claim-blocked` is a hard stop** — when a claim cannot be safely reclaimed, automatic recovery refuses rather than
   guessing. Confirm that a stuck claim surfacing as a named error, not an auto-break, is the intended trade.
3. **Unresolved, blocking §5 only**: reclaim/release is not fenced. Either a fencing token the destructive step itself
   honours, or a never-reclaim design with an operator-only escape hatch, must be chosen before any ownership code is
   written. §4 does not depend on this.
