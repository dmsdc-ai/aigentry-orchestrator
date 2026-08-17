# #899 T5 report — `bin/inject-handler.sh` → exec shim + `src/inject-handler/cli.ts`

Track `ih899`. Branch `feat/899-t5-ih899` off `c95fb34`. Disposition (Phase 1
measurements + the two decisions this implements):
`docs/reports/2026-08-18-899-t5-inject-handler-disposition.md`.

Ninth port in the tranche. 193 lines of bash → a 6-line exec shim over
`bin/lib/node-shim.sh`, `src/inject-handler/cli.ts`, `src/inject-handler/usage.ts`, two
new guards.

---

## 1. Guard split — sourced vs invoked

`grep -rnE '^[[:space:]]*(\.|source)[[:space:]].*inject-handler\.sh' .` → **zero matches
repo-wide**. Sourceability was never used, so nothing was removed for it and **there is
no `__probe` surface**, same as tranche 4's two ports.

Every caller invokes it as a subprocess, and all of them are guards:

| caller | shape | still green |
|---|---|---|
| `tests/dispatch/T17_lifecycle_3layer.sh:24` | `--body-file`, `SCHEDULER_SH` stubbed | PASS |
| `tests/dispatch/T18_test_report_handoff.sh:17` | `--body-file` | PASS |
| `tests/dispatch/T24_inject_handler_test_report.sh:10` | `--body-file`, incl. a malformed-must-exit-non-zero block | PASS |
| `tests/dispatch/T83_legacy_report_envelope_is_not_outcome.sh:34` | `--sid` + `--body-file` | PASS |

`bin/init/manifest.mjs:31` ships the file into a control workspace (unchanged — no bin
file was added, so the manifest is untouched).

**No production caller exists.** Nothing in `bin/`, `src/`, `package.json` or launchd
reaches it. `docs/adr/2026-07-26-hitl-gate-primitive.md:52` recorded that and this port
re-measured it. That is also why the D1 alert path had to be a file rather than stderr
(§5): nothing reads this handler's stderr.

## 2. Doors

**None, and none needed.** The script contained zero `.`/`source` lines, so unlike
tranches 2a/2c there is no `bash -c '. "$1"; fn "$2"'` door and no `bin/wh-cli.sh` verb.

Three children stay children, with byte-identical argv:

| child | call shapes | why it stays a subprocess |
|---|---|---|
| `bin/dispatch-registry.py` | `observe …` ×2 (report arm) | python; out of scope |
| `bin/dispatch-cleanup-scheduler.sh` | `schedule` ×2, `defer`, `cancel` | itself a TS shim (tranche 4); in-process would fork its fail-CLOSED `keep_alive` gate and its `requireInt` |
| `bin/emit-telemetry.mjs` | 5 emissions | precedent `src/dispatch/cli.ts:102` |

Fifteen child processes were absorbed because they were implementation, never contract:
the inline `node --input-type=module -e` parser bridge (1), the `python3 -c` JSON field
reads (10), `date -u` (2), `mktemp` (2).

**One env seam disappeared: `INJECT_PARSER_JS`.** Measured first — it appeared exactly
once in the whole tree, on its own defaulting line, with no override in any guard,
script or doc. `src/session/inject-parser` is a compile-time import now, so there is no
path left to point at, and a runtime `import()` of an env-supplied JS file would be a
*new* code-execution seam nothing uses. Its `exit 2 — compiled parser not found` arm is
replaced by `bin/lib/node-shim.sh`'s own exit 2 with that lib's wording; no guard
asserted the old text. The other five seams (`DISPATCH_STATE_DIR`, `TEST_REPORTS_DIR`,
`DISPATCH_REGISTRY_PY`, `SCHEDULER_SH`, `EMIT_TELEMETRY_MJS`) are unchanged, defaults
included.

## 3. Contract table

Everything below is unchanged from the bash unless the last column says otherwise.
"Pinned by" is the guard that fails if it regresses.

| # | contract | value | pinned by |
|---|---|---|---|
| 1 | `--help` / `-h` | the 19 lines of `sed -n '2,20p'`, truncated mid-Usage-block | T124 A |
| 2 | unknown flag | `inject-handler: unknown <flag>`, exit **4** | T124 B |
| 3 | unparseable body | `inject-handler: parse failed: <err>`, exit **1** | T124 C |
| 4 | REPORT without `--sid` | `--sid required for REPORT envelopes …`, exit **1** | T124 D |
| 5 | missing compiled impl | exit **2** | node-shim.sh (T125 A exercises the resolution) |
| 6 | body source | `--body-file`, else **stdin** | T124 F (stdin), T24/T18 (file) |
| 7 | report stdout | `[inject-handler] report kind=report sid=… transport=… — recorded as an observation; outcome_protocol_unavailable …; scheduler armed` | T124 E, T83 |
| 8 | report registry argv | `observe --sid <s> --kind legacy_report_envelope_observed --field transport=… --field outcome_protocol=unavailable --field reason=stage_b_deferred_to_0.9.0` | T124 E, T83 |
| 9 | report registry argv (D1 basis) | `observe --sid <s> --kind cleanup_scheduled_from_legacy_report_envelope --field basis=legacy_report_envelope` | T124 E, T83 |
| 10 | report Layer-D argv | `schedule <s> --grace-seconds 60 --source legacy-report-envelope` | T124 E, T83 |
| 11 | cleanup-request argv | `schedule <t> --source explicit-request [--reason <r>] [--grace-seconds <g>]`, flags stay optional | T124 F, T17 |
| 12 | cleanup-request stdout | `[inject-handler] cleanup-request target=… transport=…` | T124 F |
| 13 | extend-lifetime argv | `defer <t> --minutes <m> [--reason <r>]` / `cancel <t>` | T124 G, T17 |
| 14 | extend-lifetime stdout | `… defer=<m>m …` / `… cancel-pending …` | T124 G |
| 15 | hold record | `<utc-iso>\t{"ok":true,"kind":…,"transport":…,"payload":…}` appended to `holds.log` | T124 H |
| 16 | hold stdout | `[inject-handler] hold logged transport=…` | T124 H |
| 17 | test-report path | `$TEST_REPORTS_DIR/<YYYY-MM-DD>/<sid>.json`, `--sid` overrides the payload | T124 I, T24, T18 |
| 18 | test-report bytes | 2-space indent, non-ASCII raw, `_transport` appended last, trailing newline, tmp+rename | T124 I, T24 |
| 19 | test-report stdout | `[inject-handler] test-report written sid=… path=… transport=…` | T124 I |
| 20 | telemetry argv | 5 emissions, `--payload-json` string-interpolated (D3 reproduced, `"` still breaks it) | T124 E/F/G |
| 21 | recognized envelope | exit **0** | T124 E-I, L |
| 22 | flag with no value | exit **1** + a stderr line (text is the implementation's — T116 B precedent) | — (locale-dependent in bash) |
| 23 | **rejected numeric field** | stderr naming the field + `INJECT_PAYLOAD_REJECTED` in `alerts.log` + exit **1**, no scheduler call | T124 J, K — **DEVIATION** |
| 24 | **scheduler rc≠0** | stderr with the rc + `CLEANUP_SCHEDULE_FAILED` in `alerts.log`, exit **0** and stdout unchanged | T124 L — **DEVIATION** |
| 25 | **`session_id` shape** | one segment `[A-Za-z0-9._-]+`, not `.`/`..`, ≤128 chars, else as #23 | T124 M — **DEVIATION** |
| 26 | `--body-file` unreadable | exit 1, now a handler diagnostic instead of node's raw ENOENT stack trace | — (code unchanged, text was never the script's) |

`mkdir -p "$STATE_DIR"` ran *before* the argv loop in the shell, so even `--help`
created it. Kept where it was.

## 4. Platform branches

The bash had **zero** OS arms — no `uname`, no `$OSTYPE`, no darwin/linux fork; `date`
and `mktemp` appear only in POSIX-portable spellings. So the port carries **zero**
`process.platform` branches. The PATH hardening stays in bash, byte-identical, because
it is what puts `python3` on PATH for `dispatch-registry.py`'s shebang and `node` on
PATH for the scheduler child — both are launched by the node process.

## 5. The two fixes (Rule 38 deviations)

Both were GO'd on the disposition, both are named in `bin/inject-handler.sh`'s header
and in `src/inject-handler/cli.ts`'s, and both are asserted on **both sides**: T124's
blocks J-M assert the ORIGINAL bash's behaviour under `INJECT_PARITY_ORIGINAL=1` and
the port's without it. Nothing is skipped in either direction, so "the bash did X, the
port does Y" is a measurement rather than a claim.

**D1 (task #928).** `payload.grace_seconds` and `payload.defer_minutes` went from an
unauthenticated envelope into the Layer-D scheduler's argv with no validation, behind
`>/dev/null 2>&1 || true`. Two failures, reproduced:

* a non-integer `grace_seconds` used to truncate the fleet's `cleanup-pending.json` to
  zero bytes; since tranche 4 the scheduler refuses with rc 1 instead — and `|| true`
  ate the refusal, so the envelope's cleanup was **never armed**, the ordinary success
  line still printed and the exit code was still 0;
* a negative `grace_seconds` wrote a `scheduled_cleanup_time` in the past — an
  unauthenticated inject that has the next Layer-D tick retire a live session
  immediately — and a negative `defer_minutes` pulled a pending cleanup *earlier*,
  the opposite of what EXTEND_LIFETIME means. The scheduler validates integer-ness for
  every caller and deliberately no range, because an operator may legitimately say
  `--grace-seconds 999999`; the bounds therefore belong at this trust boundary.

Now: integers in `0..86400` seconds / `0..1440` minutes, or the envelope is refused. The
two failure classes are split because they are different failures — a rejected field is
a malformed payload (exit 1, the shape T24 already required), while a scheduler rc≠0 on
a *recognized* envelope keeps exit 0 and the ordinary stdout line, because "exits 0 on
any recognized envelope" is the contract `--help` prints. Both gain one stderr line and
one `state/dispatch/alerts.log` line, in the fleet's existing format
(`src/tracker/cli.ts:222`, `src/reconciler/cli.ts:314`,
`bin/orchestrator-bridge-auditor.sh:69`).

**D2 (found during this port, GO'd separately).** `payload.session_id` was pasted into
the test-report filename after a `typeof === "string"` check and nothing else, then
`mv`'d into place. Reproduced end to end before the fix: `"session_id":
"../../../pwned"` wrote a `.json` file **outside** `TEST_REPORTS_DIR`, exit 0, with the
traversing path printed on stdout as if normal — attacker-chosen destination *and*
content, `mv` overwriting whatever was there (`state/dispatch/active.json`,
`state/dispatch/cleanup-pending.json`, `~/.telepty/config.json`). A `session_id` must
now be one safe path segment. The refusal reuses `src/hitl/cli.ts:341`'s idiom
(`[A-Za-z0-9._-]+`, which by construction excludes `/`, NUL and every control character,
so a rejected value cannot forge a log line either) plus the `.`/`..` and length checks
a character class cannot express. It is validated even when `--sid` overrides it for the
path: an envelope carrying a traversal is malformed, and whether it happens to be
written is the operator's argv, not the sender's business. T124 block M keeps a canary
file outside `TEST_REPORTS_DIR` and asserts the bash reaches it and the port does not.

Refused rather than sanitised, deliberately: a sanitised `../../x` would silently write
to a file the sender did not name, and a tester whose sid gets mangled should hear about
it rather than lose the handoff into a wrong path. The narrowness is guarded too —
`ih899-coder.v2` still writes (T124 M).

**One deviation is cosmetic and named:** a `reason` that is not a string renders
JSON-style rather than python's `str()` (a JSON `null` reached the scheduler as the
literal `None`, `true` as `True`, an object as `{'a': 1}`). Only `reason` is affected —
`target` is a non-empty string by the parser's own check and the two numeric fields are
now validated. Same call, for the same reason, as the comms-auditor port's D4.

## 6. Guard count

**126, and I landed SECOND.** The parallel worker (`ba899`,
`bin/orchestrator-bridge-auditor.sh`) merged first as PR #21, taking **T127/T128** and
moving `EXPECTED_GUARDS` 122 → 124 for its own two files. This branch was rebased onto
`2b46c99`; **T124/T125 were still free**, so my numbers are unchanged, and
`EXPECTED_GUARDS` is now **126** — counted, not derived:
`ls tests/dispatch/T*.sh | wc -l` = 126 after the rebase (124 on main + T124 + T125).
The two branches were disjoint in every other file.

Baselines. The "before" column is `c95fb34`, this branch's original base, measured on
this worktree before any edit; the "after" column is post-rebase onto `2b46c99`, so its
guard total includes ba899's two:

| | before (`c95fb34`) | after (rebased onto `2b46c99`) |
|---|---|---|
| `npm test` | 225 pass / 0 fail | 225 pass / 0 fail |
| `tests/dispatch/run-all.sh` | 122 passed / 0 failed / 3 skipped (T16 T48 T95) | 126 passed / 0 failed / 3 skipped (T16 T48 T95) |

The pre-rebase run on `c95fb34` + my two guards was 124/124/0 with the same three
skips — i.e. both increments are accounted for, mine and ba899's.

One existing guard caught this port en route and was right to: **T69**
(`registry_single_writer_invariant`) greps `bin/` for the registry filename and refuses
any occurrence outside `bin/dispatch-registry.py`, because a path in a `bin/` file is a
second entrance by construction. The first cut of the shim header named that file as an
example of what D2 could overwrite — prose, not code, but the invariant does not and
should not care. The header now says "the dispatch registry"; the literal paths live in
`src/inject-handler/cli.ts`'s header, which is outside T69's scan by design.

RED-first, re-runnable: T124 passes against the original bash with
`INJECT_PARITY_ORIGINAL=1` and **fails** against it without the flag
(`FAIL[T124]: J port: rc=0 (want 1)`), so it is non-vacuous. T125 fails against the
un-ported tree (`dist/src/inject-handler/cli.js missing`).

## 7. Snyk

`snyk_code_scan` over `src/` → **2 issues, both pre-existing Low Path Traversal in
`src/hitl/cli.ts` (lines 213 and 382)**, the two named as known in the dispatch envelope.
**0 new.** Nothing in `src/inject-handler/`, which is the intended result: the segment
refusal sits upstream of every `path.join` on the test-report arm.

## 8. NOT checked / not done (Rule 38)

* **The parser's own `validateTestReport` still accepts any string as `session_id`**
  (`src/session/inject-parser.ts`). Moving the segment rule there would benefit every
  consumer, and the GO permitted it "if cheap" — it is not. It converts a refusal that
  names the field into a generic `parse failed: unknown envelope kind`, which loses the
  alert and the diagnostic that make D1/D2 visible at all, and the parser is outside
  this task's Rule 29 surface with 225 vitest cases over it. **Named for a ticket, not
  done.** Today the inject-handler is the only consumer that turns the field into a
  path, so the boundary is covered where it is crossed.
* **The telemetry `--payload-json` is still string-interpolated**, so a `"` in a reason
  or target still emits invalid JSON (`reason: a"b` → `{"target":"t3","reason":"a"b",…}`,
  measured). Reproduced byte for byte, `|| true` included; T124 E/F/G pin the exact
  argv. Non-fatal — the emit is best-effort — but the record is lost. Ticket.
* **A failing `dispatch-registry.py observe` is still swallowed.** The GO covered the
  scheduler calls; the registry calls keep `|| true`. Ticket.
* **A JSON `null` field still flows on as a literal string** (D4 on the disposition) —
  reproduced, not fixed.
* `bin/lib/workspace-host.sh` **untouched** (T3b declined).
* The production daemon `:3848`, `~/.telepty/config.json`, the `orchestrator` session
  and launchd were **not** contacted. Both new guards are hermetic: temp state dir from
  `lib.sh`, recorder stubs for all three children, no `telepty`, no `curl`.
* **Not run:** the packaging smoke (`tests/packaging/smoke-init.sh`) — CI runs it, and
  no bin file was added, so the manifest is unchanged. **Not measured:** whether any
  workspace in the field currently has a test-report file whose name came from a
  traversal; D2 was reachable for as long as the arm has existed and this port closes it
  going forward, it does not audit history.
* **Not merged.** Branch + PR only, per the envelope.
