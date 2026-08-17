# #899 T5 disposition — `bin/inject-handler.sh` → exec shim + `src/inject-handler/cli.ts`

Track `ih899`. Worktree `~/.aigentry/worktrees/ih899`, branch `feat/899-t5-ih899`, base
`c95fb34`. Nothing implemented yet — this is the Phase-1 measurement, per the [SAWP]
envelope. **One decision is blocking (§8).**

Baseline BEFORE (on this worktree, unmodified): `npm test` 225/225 pass, 0 fail.
`tests/dispatch/run-all.sh` in progress at write time; recorded in the report.

---

## 1. Guard split — sourced vs invoked

`grep -rnE '^[[:space:]]*(\.|source)[[:space:]].*inject-handler\.sh' .` → **zero matches**,
repo-wide (tests, bin, src, docs). **So there is NO `__probe` surface**, same as tranche 4.

Invokers, all subprocess, all in `tests/dispatch/`:

| caller | shape |
|---|---|
| `T17_lifecycle_3layer.sh:24` | `"$HANDLER" --body-file <md>` with `SCHEDULER_SH` stubbed — 3-layer end-to-end |
| `T18_test_report_handoff.sh:17` | `"$HANDLER" --body-file` — tester→orch R5a handoff |
| `T24_inject_handler_test_report.sh:10` | `"$HANDLER" --body-file`, fenced + markdown + **malformed must exit non-zero** |
| `T83_legacy_report_envelope_is_not_outcome.sh:34` | `"$HANDLER" --sid sid-A --body-file` — report arm, no outcome authority |

`bin/init/manifest.mjs:31` ships the file into a control workspace.

**There are zero production callers.** Nothing in `bin/`, `src/`, `package.json` or launchd
reaches it; `docs/adr/2026-07-26-hitl-gate-primitive.md:52` recorded this and it still
holds. Blast radius of any contract change here is the four guards above plus a workspace
operator running it by hand.

## 2. Sourced libs

The script sources **nothing** (zero `.`/`source` lines). So, as in tranches 4:
no `bash -c '. "$1"; fn "$2"'` door, no `bin/wh-cli.sh` verb. Nothing to open.

## 3. Subprocess children

**Stay children, byte-identical argv:**

| child | sites | why it stays |
|---|---|---|
| `bin/dispatch-registry.py observe` | `:107`, `:114` (report arm) | python, out of scope |
| `bin/dispatch-cleanup-scheduler.sh` | `:119` `schedule`, `:134` `schedule`, `:147` `defer`, `:153` `cancel` | already a TS shim (T4). In-process would fork its fail-CLOSED `requireInt` and its keep_alive gate |
| `bin/emit-telemetry.mjs` | 5 emit sites via `emit_telemetry()` | precedent `src/dispatch/cli.ts:102` — `spawnSync(..., {stdio:"ignore"})` inside try/catch, exactly what `>/dev/null 2>&1 \|\| true` did |

**Absorbed in-process (they were implementation, not contract):**

| child | count | replacement |
|---|---|---|
| `node --input-type=module -e '…'` parser bridge (`:73-85`) | 1 | direct `import { parseInject }` from `src/session/inject-parser` |
| `python3 -c 'import json…'` field reads | 10 | in-process JSON |
| `date -u +%Y-%m-%dT%H:%M:%SZ`, `date -u +%Y-%m-%d` | 2 | `toISOString()` slicing, as siblings do |
| `mktemp` (body spool + atomic test-report tmp) | 2 | `fs.mkdtempSync` / `${target}.tmp.<rand>` + `rename` |

## 4. Env seams

Preserved with identical defaults: `DISPATCH_STATE_DIR`, `TEST_REPORTS_DIR`,
`DISPATCH_REGISTRY_PY`, `SCHEDULER_SH`, `EMIT_TELEMETRY_MJS`. All five are overridden by
guards today (`tests/dispatch/lib.sh:130`, T17:38, T18:20, T24:14, T83:33).

**`INJECT_PARSER_JS` disappears** (deviation, Rule 38). Measured: it is referenced at
exactly one place in the tree — its own defaulting line, `bin/inject-handler.sh:32`. No
guard, no script, no doc overrides it. Once `cli.ts` imports `parseInject` at compile time
there is no path to point at, and keeping a runtime `import()` of an arbitrary env-supplied
JS file would be a *new* code-execution seam nothing uses. Consequence: the
`exit 2 — compiled parser not found at <path>` arm (`:67-70`) is replaced by
`bin/lib/node-shim.sh`'s own **exit 2** for a missing `dist/…/cli.js` — same code, different
wording; no guard asserts the wording.

## 5. Contract lines (what the port must keep byte-identical)

stdout, one per arm — `:125` report (incl. the literal `outcome_protocol_unavailable`, which
T83 greps), `:138` cleanup-request, `:151` extend-lifetime defer, `:157` extend-lifetime
cancel, `:165` hold, `:187` test-report.

stderr + exit: `:57` `inject-handler: unknown <flag>` → **4**; `:68` parser missing → **2**;
`:90` `inject-handler: parse failed: <err>` → **1**; `:101` `--sid required for REPORT
envelopes …` → **1**; `:190` `inject-handler: unrecognized kind=<k>` → **1**. Recognized
envelope → **0**.

`--help` / `-h` = `sed -n '2,20p' "$0"` → **19 lines**, `# ` prefixes included, truncated
mid-Usage-block after `#   inject-handler.sh < body.txt`. Operators have been reading exactly
that, so `src/inject-handler/usage.ts` reproduces those 19 lines verbatim (scheduler
precedent). `usage.ts` is warranted here: unlike comms-auditor, this script *does* read argv.

Also contract: `--body-file` absent → body is read from **stdin**.

## 6. Platform branches

The bash has **zero** OS arms — no `uname`, no `$OSTYPE`, no darwin/linux fork. `date -u`
and `mktemp` are used in their POSIX-portable spellings only. So the port carries **zero**
`process.platform` branches.

## 7. Latent defects (measured, reproduced)

**D1 — the in-scope fix (task #928, already decided).** REPRODUCED on this worktree:
a fenced `cleanup-request` with `"grace_seconds":"not-a-number"` (which
`validateCleanupRequest`, `src/session/inject-parser.ts:173-179`, does not type-check at all)
→ handler prints `[inject-handler] cleanup-request target=victim-1 transport=json-fenced`
and **exits 0**, while `cleanup-pending.json` is byte-unchanged and `victim-1` was never
scheduled. The scheduler now refuses (rc 1) instead of truncating the queue, but `:134`'s
`>/dev/null 2>&1 || true` eats both the message and the code. Same shape at `:147` for
`defer_minutes` — that one *is* type-checked as `number` by the parser (`:181-186`), so its
gap is **range**, not type: `defer_minutes: -100000` passes every check and pulls a
scheduled cleanup earlier; `grace_seconds: -100000` writes a `scheduled_cleanup_time` in the
past, i.e. an unauthenticated inject can make the next Layer-D tick retire a live session
immediately. `requireInt` in the scheduler enforces integer-ness and **no bounds**
(`src/cleanup-scheduler/cli.ts:183-188`), so bounds have to land here.

**D2 — NEW, and the reason for the HOLD (§8b). Arbitrary-path file write from an
unauthenticated inject payload.** `:168-183`: `sid` comes from `payload.session_id`, which
`validateTestReport` checks only as `typeof === "string"`
(`src/session/inject-parser.ts:189-190`), and is pasted straight into
`target_file="$TEST_REPORTS_DIR/$date_dir/${sid}.json"`, then `mv`'d into place.
REPRODUCED: `"session_id": "../../../pwned"` wrote `<scratch>/pwned.json` — outside
`TEST_REPORTS_DIR` — rc 0, and stdout printed the traversing path as if it were normal.
The attacker controls both the destination (any existing directory, filename forced to end
`.json`) and the content (the payload is echoed verbatim), and `mv` overwrites. Reachable
targets include `state/dispatch/active.json`, `state/dispatch/cleanup-pending.json` and
`~/.telepty/config.json`. Exact precedent: comms-auditor D1 fixed this same shape
(`thread_id` containing `/`) as a path-traversal vector.

**D3 — reproduce, not fix.** Telemetry `--payload-json` is built with `printf '%s'`, so any
`"` in `reason`/`target` emits invalid JSON. REPRODUCED: `reason: a"b` →
`--payload-json {"target":"t3","reason":"a"b",…}`. Non-fatal (emit is `|| true`) but the
record is lost. Out of this task's decided scope — naming it for a ticket.

**D4 — reproduce.** A JSON `null` field renders as python's `None` and flows on as the
literal string `"None"` (`p.get("reason","")` only defaults a *missing* key). With D1's
validation a `None` grace is rejected properly; a `None` reason still reaches the scheduler.

**D5 — reproduce.** `--body-file /nonexistent` prints a raw node `ENOENT` stack trace on
stderr instead of a handler diagnostic, exit 1. Code is right, message is not the script's.

## 8. Blocking — two decisions

**(a) The "same alert path" in the #928 fix is under-determined, because the measurement
came back empty.** The dispatch says to "emit the same alert path the script uses for other
malformed payloads (measure which)". Measured: **this script has no alert path.** Its only
response to a malformed payload is one stderr line and a non-zero exit (`:90`, `:190`), and
`T24:64-71` pins that shape ("malformed TestReport silently accepted" is a FAIL). The
fleet-wide `state/dispatch/alerts.log` convention exists (`src/tracker/cli.ts:222`,
`src/reconciler/cli.ts:314`, `bin/orchestrator-bridge-auditor.sh:69`) but **this script has
never written to it**. Two readings, and they differ in what a caller sees:

1. *stderr + exit 1* — matches the script's own precedent, but flips cleanup-request /
   extend-lifetime from exit 0 to exit 1 and contradicts the header line "The handler exits
   0 on any recognized envelope", which `--help` prints to operators.
2. *stderr + `alerts.log`, exit 0 unchanged* — no exit-code contract change, and it is the
   only artefact anyone would actually see, since nothing in production reads this handler's
   stderr.

**Recommendation — take both halves, split by cause:**

* *Rejected field* (not an integer, or out of bounds): refuse the envelope before any
  scheduler call — one stderr line naming the field and value, one
  `INJECT_PAYLOAD_REJECTED field=<f> kind=<k> target=<t>` line in `$STATE_DIR/alerts.log`,
  **exit 1**. This is a malformed payload, so T24's precedent governs.
* *Scheduler non-zero on an otherwise valid envelope*: one stderr line with the verb and rc,
  one `CLEANUP_SCHEDULE_FAILED verb=<v> target=<t> rc=<n>` line in `alerts.log`, **exit 0
  kept** — the envelope *was* recognized, so the header's contract line stays true and the
  failure stops being silent.
* Bounds: `grace_seconds` integer in `0..86400`, `defer_minutes` integer in `0..1440`
  (24h either way; default grace is 60s). These are my numbers, not measured from anything —
  say if you want different ones.

**(b) D2 (§7) is security at a trust boundary — asking for GO to fix it in this port rather
than reproduce it.** The dispatch's standing rule sends data-loss/security defects to a HOLD
with the measurement rather than to a silent fix, and this one was found *after* the #928
scope was set, so it is not covered by "this is the one behaviour change". Proposed fix,
if GO: refuse a `session_id` that is not a single safe path segment (no `/`, not `.`/`..`,
no NUL) — one stderr line, same `INJECT_PAYLOAD_REJECTED` alert line, exit 1, no file
written. Cheaper than sanitising, and it is the comms-auditor D1 shape.
If you prefer, the alternative is: reproduce D2 as-is, name it in the shim header, and file
it as its own ticket — I will not fix it silently either way.

## 9. Plan after GO

`bin/inject-handler.sh` → exec shim over `bin/lib/node-shim.sh`;
`src/inject-handler/cli.ts` + `src/inject-handler/usage.ts`; **T124** parity (RED-first on
D1, and non-vacuous — it passes on the original bash at `c95fb34` with the parity flag and
fails on the original without it), **T125** workspace-layout shim; `EXPECTED_GUARDS`
122 → 124 in `tests/dispatch/run-all.sh` (**counted**: `ls tests/dispatch/T*.sh | wc -l`
= 122 on `c95fb34`; highest existing number is T123, so 124/125 are free). No manifest
change — no bin file is added. `bin/lib/workspace-host.sh` untouched.
