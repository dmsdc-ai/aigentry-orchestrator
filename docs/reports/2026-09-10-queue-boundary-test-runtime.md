# Pinned compiled queue boundary runtime — 2026-09-10

Actual single-file Node 20 execution: **56 discovered, 51 passed, 5 failed, 0 skipped, 0 cancelled, 0 todo; exit 1**. All five failures match the five prior direct Python witnesses. No setup/harness failure or retry. Parent task #1136 remains incomplete; HOLD for bounded fix review, no fix or live activation performed.

## Provenance and currentness

- Worktree: `/Users/duckyoungkim/.aigentry/worktrees/qt1136b`; branch `test/1136-queue-boundary-runtime`.
- Execution HEAD/base: `16358f3fd11fc968ff32c72c6900e6d906c45a93`; report commit is the containing commit. Initial and post-run tracked tree clean; this report is the sole tracked change.
- Test source commit: `c75d360bde57d1f1f5859712931c5b4cb577cb8b`; helper candidate from `d361397a6b3a75e7aa98c2612726ecbef9911cf2`.
- Local main initially `2bfdf107fde86411fd78611fa4c0e406e28a2a4d`; post-run report sample `922c22b092a19abf96bdabfe76110805799922bb`. Main moved independently; no fetch/main writes.
- Against both samples, helper and test are absent from main (`git diff --name-status main HEAD` reports both `A`). Package, lock, tsconfig and runner match sampled main. No repository-wide parity claim.

| Artifact | Git blob | SHA-256 |
| --- | --- | --- |
| `bin/tq-write.py` | `c6654295b5614e18cd3ab4b70e18e6314e48b03f` | `7e6e6dd1ebe210d1a772e382234be4d31d4939e62db5512b3a70a4304a4de417` |
| `tests/dispatch/workflow-task-writer.test.ts` | `46bc236a774ef8c458afd609a5994c01726eefe7` | `be3afa7c4eae51f0f4e0afc509c112fa984c3f741cb90d18a9e1218f5d1adfd2` |
| `dist/tests/dispatch/workflow-task-writer.test.js` | ignored compiled artifact | `d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f` |
| `package.json` | unchanged | `2b56fef3f0924d72bdef42c7e50a4a122ade11173bb979dfc087d63fe9d3465a` |
| `package-lock.json` | unchanged | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` |
| `tsconfig.json` | unchanged | `7f867214418ae3ed617dba351c2d4c99064b8e7afd3b9a0d34ece8cc8a94bc97` |
| `scripts/run-tests.mjs` | unchanged, read only | `5a689e7320ad70c2357f99e4527ce4fade966964f2af2c9218471a08bd35f31b` |

Helper/source/compiled hashes were remeasured before and after execution and matched. Copied the authorized builder artifact from `/Users/duckyoungkim/.aigentry/worktrees/qb1136b/dist/tests/dispatch/workflow-task-writer.test.js` byte-for-byte into a new regular file; no symlink or compilation.

## Execution and isolation

Read TS, compiled JS, helper and runner before test execution; no test import during review. Compiled JS imports Node built-ins only. Its `resolve(import.meta.dirname, '../../..')` resolves to the qt1136b worktree above; helper resolves to that worktree's regular `bin/tq-write.py`, not main or builder checkout. Parent path components were checked against symlinks before copying.

Exact command, cwd as above:

```sh
/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test dist/tests/dispatch/workflow-task-writer.test.js
```

- Measured Node `--version`: `v20.20.0`; selected test Python `/opt/homebrew/bin/python3`, measured `Python 3.14.2`.
- Start UTC: `2026-09-10T11:07:12.514483+00:00`; outer elapsed `14438.452917 ms`; TAP duration `14415.697625 ms`.
- Outer Python subprocess capture with 90-second timeout; timeout did not fire. Node exit 1; wrapper exit 0 means evidence capture completed, not tests passed.
- Complete outer environment: `PATH=/usr/bin:/bin`, `HOME=/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/home`, `TMPDIR=/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/tmp`.
- Retained fixtures create synthetic queue/home/tmp roots and replace child environment with synthetic `TQ`, `AIGENTRY_HOME`, `AIGENTRY_ROOT`, `AIGENTRY_TARGET_CWD`, HOME/TMPDIR and minimal PATH. Fault harness adds `PYTHONDONTWRITEBYTECODE=1`. No inherited credentials/live-state paths or session commands in tests.
- Bounded child calls are joined, including parallel allSettled and locker close. Outer process was joined; `killpg(pid, 0)` returned ProcessLookupError after completion, confirming no remaining process in its group.
- Actual TAP plan `1..56`, tests 56, suites 0, pass 51, fail 5, cancelled/skipped/todo 0. Independently observed execution agrees with source's 29 original + 27 added cases; that source count was not used as discovery evidence.

## Exact failed tests and assertions

| TAP # / exact test name | Actual evidence and failed assertion |
| --- | --- |
| 32 — `note boundary null: clarified missing versus present contract` | Expected exit 4, actual 0. `unchanged=false`; note became `segment` with a new ledger. Strict JSON, mode 0640, no own temp, foreign sentinel retained. |
| 44 — `numeric identity 1000000000000000000000 uses JS text and preserves stored value/type` | JS requested `1e+21`; expected 0, actual 3 `UNKNOWN_TASK`. Queue unchanged; Python harness reports stored ID type/value preserved. |
| 45 — `numeric identity 9007199254740993 uses JS text and preserves stored value/type` | JS requested `9007199254740992`; expected 0, actual 3 `UNKNOWN_TASK`. Queue unchanged; Python harness reports stored ID type/value preserved. |
| 55 — `encoding overflow refuses with 4 MALFORMED_QUEUE unchanged and no own temp` | Expected 4, actual 0; unrelated raw `1e400` yielded `unchanged=false`, `strict=false`, `document=null`. No own temp; mode 0640 and foreign sentinel retained. |
| 56 — `encoding surrogate refuses with 4 MALFORMED_QUEUE unchanged and no own temp` | First failed assertion is cleanBoundary's empty leak list: actual `[".tq-write.plkpy56n.tmp"]`. Captured helper exit 1, UnicodeEncodeError at tq-write.py:179; unchanged=true, mode 0640, foreign sentinel retained. Later exit-4/token/unchanged assertions were not reached. |

These are five `testCodeFailure` / `ERR_ASSERTION` failures, not harness launch/transport failures. Names map one-to-one to prior null, two integer, overflow and surrogate witnesses; no added/missing failure. The current overflow TAP establishes invalid strict JSON after replacement, while the exact Infinity token was prior diagnostic evidence (not printed by this TAP). Surrogate rejection by Python's UTF-8 writer is captured in current TAP. Its own-temp leak is observed before the fixture removes its synthetic directory.

## Passing controls measured in this run

- Original cases 1–29 all pass: preservation of fields/Unicode/newline/ID types; exact replay and reordered argv no-write; payload conflict 6; same/different-row concurrent appends; identical op-id once; focus/note preservation; CAS exactly one winner and stale exit 5; usage/unknown/malformed refusals unchanged.
- `held sidecar lock times out with exit 7, no partial state, then recovers`: passes 10-second minimum assertion, LOCK_TIMEOUT token, unchanged snapshot and recovery; full test duration `10149.123417 ms`. Unusable lock path returns 7 QUEUE_UNAVAILABLE unchanged.
- `note boundary missing/empty/nonempty: clarified missing versus present contract` pass with expected segment/separator; list and number notes return 4 unchanged.
- `numeric identity <literal> uses JS text and preserves stored value/type` passes for `7.0`, `-0`, `642.2`, `690.1`, `697.1`, `1e-7`, `1e-6`, `1e21`, and `"007"`.
- `identity refusal/control <case> requested <text>` passes: ambiguous/7 =>2 unchanged, leadingzero/007 =>0 changing only string row, id:7.0/7.0 =>3 unchanged, id:true/1 =>3 unchanged, id:1e400/Infinity =>4 unchanged.
- `commit fault regular separates precommit refusal from visible replacement` and corresponding `replace` pass: injected precommit error =>7, bytes/inode/timestamps unchanged, no real replacement event or own-temp leak.
- `commit fault directory separates precommit refusal from visible replacement` passes: events `[regular,replaced,directory]`, exit 8 after real replace, visible note and op ledger, exact replay exit 0 with unchanged snapshot.
- All 27 boundary results checked empty own-temp first; only surrogate failed that check. The other 26 then passed foreign sentinel and mode 0640 assertions. Surrogate's diagnostic itself reports foreign/mode preserved, but those two assertions were not reached.

## Retained raw evidence

Ignored directory: `/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/`.

| File | SHA-256 |
| --- | --- |
| `stdout.tap` — complete TAP and assertion diagnostics | `de3337b9a1122a0a06e83ebc646553e38bc19b2487aa3c46dbd4c0efa1ba8a6c` |
| `stderr.txt` — empty outer stderr; child diagnostics are in TAP | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `run.json` — argv/cwd/environment/runtime/exit/timing/isolation | `2ae312c7e1bf06be3edb0261c965b6e5c2e7cf80611619e1013ba21c8c6d915e` |

## Limits and security scope

One exact compiled JS execution only; no deterministic-failure rerun, npm test, runner/guard execution, other suites, builds, installs, source edits, app/daemon/reconciler/model execution, live queue access, remote push, or path-containment implementation. Snapshot checks establish observed bytes/inode/timestamps, not every syscall. Fault injection does not establish real power-loss durability. No candidate fixes or live callers were tested.

Builder's separate report at base 16358f3 records build exit 0 on Node 25.2.1/npm 11.6.2/TS 5.9.3 in 1074.23 ms; this tester did not build. Its shared dependency tree had missing declared telepty and extraneous packages, so no clean-install claim. Historical 29/29 old JS and 22/27 direct Python results remain separate runs; current execution is the new JS's 51/56.

Snyk N/A: report-only tracked change and exact copy of already compiled JS, no authored first-party code changes. Prior tester zero-issue scan covers only `tests/dispatch/workflow-task-writer.test.ts`; helper's separate 2 LOW findings remain unresolved. No inherited waiver, same-file disagreement, new scan or security acceptance claim.

## Separate test-only correction counterpart — 2026-09-10

This section is a new comparison, not a revision of the original 51/56 execution above. **Candidate: 56/56 compiled tests pass; separate focused controls: 2/2 pass. Security gate unmet: isolated candidate scan still reports two findings.** No permanent helper change or security/code DONE claim.

Comparison HEAD was report commit `616da2c99a7429a93d1d3bd4ce3b68ca5ece7c14`; new report commit is the containing commit. Main initially `91534a1ba8baa4c33db4b6bdaec52a4877b87696`, post-comparison sample `2956816046c6a282aca5a20cef8db4d52bd52347`. At the latter sample helper/test remain absent from main and package/lock/config/runner match HEAD. No fetch/main writes. Original helper/TS/current dist JS/baseline TAP hashes rechecked unchanged before and after comparison; original run was reused, not rerun.

Preserved ignored comparison root `C=/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-counterpart`. Fresh `C/original` and `C/candidate` each contain regular-file copies of helper, compiled JS and package.json. Both JS copies retain SHA-256 `d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f`; both package copies retain `2b56fef3f0924d72bdef42c7e50a4a122ade11173bb979dfc087d63fe9d3465a`. Three-parent REPO resolution was checked for both respective synthetic trees. Original helper retains `7e6e6dd1ebe210d1a772e382234be4d31d4939e62db5512b3a70a4304a4de417`; candidate helper after patch/scan is **`12bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca`**.

Only the four proposed transformations were applied via apply_patch to the candidate copy. Complete diff follows; unchanged finite-float canonicalization, bool handling, ambiguity detection, stored rows, locking and OS error branches remain in the copied implementation.

```diff
--- original/bin/tq-write.py
+++ candidate/bin/tq-write.py
@@ -138,4 +138,11 @@
 
 
+def _finite_float(text):
+    value = float(text)
+    if not math.isfinite(value):
+        raise ValueError("non-finite JSON number %s" % text)
+    return value
+
+
 def load(path):
     """Read and shape-check the queue under the held lock. A malformed queue is
@@ -147,5 +154,6 @@
         raise Refusal(7, "QUEUE_UNAVAILABLE", "cannot read queue %s: %s" % (path, exc))
     try:
-        doc = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
+        doc = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant,
+                         parse_float=_finite_float)
     except (UnicodeDecodeError, ValueError) as exc:
         raise Refusal(4, "MALFORMED_QUEUE", "unparseable queue: %s" % exc)
@@ -177,5 +185,5 @@
     try:
         with os.fdopen(fd, "w", encoding="utf-8") as fh:
-            json.dump(doc, fh, indent=2, ensure_ascii=False)
+            json.dump(doc, fh, indent=2, ensure_ascii=False, allow_nan=False)
             fh.write("\n")
             fh.flush()
@@ -183,4 +191,7 @@
         os.chmod(tmp, mode)  # mkstemp is 0600; the queue keeps the mode it had
         os.replace(tmp, path)
+    except (UnicodeError, ValueError) as exc:
+        _unlink(tmp)
+        raise Refusal(4, "MALFORMED_QUEUE", "unrepresentable queue: %s" % exc)
     except OSError as exc:
         _unlink(tmp)  # only ever our own temp; the queue is never truncated or unlinked
@@ -245,8 +256,8 @@
         return value
     if isinstance(value, int):
-        # ponytail: exact for every id JS can represent (|n| <= 2^53); a larger
-        # integer literal would differ from JS's rounded text, so widen here if
-        # ids ever exceed that.
-        return str(value)
+        try:
+            value = float(value)  # Match JS text without changing the stored row.
+        except OverflowError:
+            raise Refusal(4, "MALFORMED_QUEUE", "tasks[%d].id exceeds binary64 range" % index)
     if isinstance(value, float):
         if not math.isfinite(value):
@@ -322,12 +333,7 @@
         raise Refusal(6, "OP_ID_CONFLICT", "op-id %r already recorded a different payload on "
                       "this row" % args.op_id)
-    prior = row.get("note")
-    # JSON null is "no note yet" -- the live queue stores 161 of 1148 rows that
-    # way -- and is treated exactly like an absent key. Any other non-string
-    # note is malformed. HOLD: if null must instead be exit 4, this branch is
-    # the single line to flip.
-    if prior is None:
-        prior = ""
-    elif not isinstance(prior, str):
+    # Only an absent note defaults to empty; present values must be strings.
+    prior = row.get("note", "")
+    if not isinstance(prior, str):
         raise Refusal(4, "MALFORMED_QUEUE", "note is %s, want string" % _kind(prior))
     # Empty prior text yields the segment alone; a leading separator would be
```

### Candidate execution and direct controls

Exact argv: `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test dist/tests/dispatch/workflow-task-writer.test.js`; cwd `C/candidate`. Measured version `v20.20.0`; Python helper executable `/opt/homebrew/bin/python3`. Started `2026-09-10T11:17:19.527037+00:00`, exit 0, outer `14898.745584 ms`, TAP `14876.64575 ms`, outer timeout 90 seconds did not fire. One attempt only. Actual TAP plan `1..56`, 56 ok result lines, zero not-ok lines; pass 56, fail/skipped/cancelled/todo 0, suites 0.

Complete outer env: PATH `/usr/bin:/bin`, HOME `C/evidence/home`, TMPDIR `C/evidence/tmp`, PYTHONDONTWRITEBYTECODE `1` (C expanded to the absolute path). Existing compiled fixtures replace child env with their own synthetic TQ/HOME/TMPDIR/AIGENTRY roots. Candidate subprocesses were joined and process-group disappearance checked; no timeout/setup failure. Compiled TS/JS assertions were unchanged. All five formerly failing named tests now pass, including surrogate exit4/MALFORMED_QUEUE/unchanged/no-own-temp assertions. All prior passing controls remain green, including OS precommit7, postreplace8 with visible ledger/replay0, concurrency, mode0640 and foreign-temp preservation.

Separate focused controls in `C/harness/compare.py` use Node `JSON.parse(raw).tasks.map(row => String(row.id))` on exactly the raw JSON written for the candidate helper. Node oracle bounded at 10s, helper CLI at 15s; separate synthetic env per case; children joined and process groups absent. These two results are NOT added to the compiled total:
- Two distinct integer literals `9007199254740992` and `9007199254740993` both yield JS text `9007199254740992`; request refuses 2 AMBIGUOUS_TASK, byte/inode/mtime/ctime snapshot unchanged; helper elapsed `41.9765 ms`.
- Integer literal `1` followed by 400 zeros yields JS text `Infinity`; request refuses 4 MALFORMED_QUEUE (`tasks[0].id exceeds binary64 range`), snapshot unchanged; helper elapsed `41.7355 ms`.
Both also preserve mode0640/foreign sentinel with zero own-temp leaks. Exact raw fixtures, oracle argv/output and helper stdout/stderr/status/timing are retained in controls.json.

### Actual isolated Snyk scans

Normal authenticated CLI `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/snyk code test <absolute-scope> --json`, cwd equal to scope. Two separate scopes were verified to contain only the named Python file; no auth/config/root-policy/ignore/waiver changes. Both scans completed and were joined.
- Scope `C/candidate/bin`, file `tq-write.py`: exit 1, two `python/PT` Path Traversal/CWE-23 findings, SARIF level `note` (LOW): environment input to `open` at candidate line151 and `os.replace` at line192. These concern the unchanged TQ-path flow and correspond to the previously reported two LOW categories; no fresh original scan/fingerprint equivalence claim. Security gate remains unmet; containment policy was not expanded to chase zero.
- Scope `C/harness`, file `compare.py`: exit 0, zero SnykCode results. This is the separately authored fixture harness scan, not the report or production helper scan.

### Preserved comparison evidence

All paths below are relative to C; original/candidate trees, direct synthetic cases and raw evidence remain available for orchestrator preservation review.

| Artifact | SHA-256 |
| --- | --- |
| `candidate.diff` | `52b5ecb03f3531512e6cc294742cc92e37026f643e7f28b88803f2b276390cf1` |
| `harness/compare.py` | `c5937757e6d29dce18788df5827ad9054c935651e7f7d62f0ac4449d7c4a412b` |
| `evidence/candidate-stdout.tap` | `9899449f79452044f4eacfcf4c110bebbfa96d62b7d6dbaadb2b6662ff190f43` |
| `evidence/candidate-run.json` (full capture/argv/env/exit/timing) | `2a281e24bdd2a9e335b573fa574a63286f2b76380ae52472c7bb578a2860db70` |
| `evidence/controls.json` | `80d0d53e6022ee238c380118ef0637cae3dc18dda0f77653d727e69e40d7aa76` |
| `candidate-snyk.stdout.json` | `84c24fee34046cceb01a786a2480551e621e6bcff8b4a0be930db5d36a3c0c64` |
| `harness-snyk.stdout.json` | `d281816c1bed2bb392dc5590e83ae26468d0bd4a2784c2b3da1c3af5a90e238b` |

Candidate outer stderr and both Snyk stderr files are empty; scan argv/cwd/exit metadata retained as `candidate-snyk-meta.json` and `harness-snyk-meta.json`. Only this report is tracked; no permanent source/test/package/config edit, build, dependency install, other suite, live queue/caller/daemon/model execution or remote push. This confirms the exact copied strategy under these fixtures only: no universal finite-double formatting proof, arbitrary-input completeness, live/race integration, security approval or power-loss guarantee. HOLD for orchestrator permanent-fix authorization and unresolved security gate; parent task remains incomplete.
