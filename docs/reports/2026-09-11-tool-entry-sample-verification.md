# Task #1151: independent captured-sample verification

Verdict: **PASS for this captured sample's outer-message visibility during the first tool's Python read. HOLD for review before implementation.** This is isolated evidence validation, not validation of production-loop behavior.

Verification date: 2026-09-11. Worktree: `/Users/duckyoungkim/.aigentry/worktrees/it1151`. Pre-report HEAD, merge base with local main, and local main were all `381ccd7fa549f3c4934a606f621ee72ea9908189`. The report commit is the commit introducing this file; its hash is supplied in the orchestrator notification. No remote freshness assertion. Builder setup/sample references supplied by dispatch: `3de4454` / `88623d0`; conclusions below derive from independently read artifacts, not those author claims.

## Inputs and integrity

Read-only builder inputs under `/Users/duckyoungkim/.aigentry/worktrees/ib1151`: `dist/evidence/ib1151/tool-entry-rollout.jsonl`, `dist/evidence/ib1151/tool-entry-metadata.json`, and `docs/reports/2026-09-11-tool-entry-probe-setup.md`.

| Independently measured input | Bytes | SHA-256 |
| --- | ---: | --- |
| Captured snapshot | 275461 | `b9f64d832e320d67a2c082d5a47d2e8193953a10783c261ddeb653ccb45e13b5` |
| Metadata | 2993 | `78b7a8bdb85e526b9beacd6ce46f964271abc7d7066d6a7b6aa1ee51233ff6e4` |
| Separately read post-capture rollout | 340246 | `e888d0f04f40e0bdd1bc270b5bbab8277d79056d2447863ab846dd15ee0b24a2` |

Both dispatched expected hashes match. Snapshot bytes parse into 71 JSON objects and end with a newline: no partial trailing JSON or malformed record. Metadata is one JSON object. Snapshot and metadata modes are 0600; parent directory mode is 0700. Inputs were not modified. No raw transcript is committed.

The actual snapshot schema includes `response_item/custom_tool_call` with `payload.name = exec`, not an assumed `function_call` record. Counts across all 71 records: one session_meta, one world_state, two turn_context, nine token_usage_record; response_item: ten message, two reasoning, nine custom_tool_call, eight custom_tool_call_output; event_msg: sixteen item_completed, nine token_count, two task_started, one task_complete, one thread_settings_applied. Earlier setup tools belong to the preceding turn.

## Captured event order

Line numbers are one-based. Bound session is `01a08e00-2b54-7f73-a1d7-8dd3695f569a`; the snapshot's session_meta ID matches metadata and its exact source filename. Controlled turn ID is `01a08e02-ac6a-7b62-88c3-03ac7a88c551`.

| Line | UTC timestamp, 2026-09-11 | Actual record |
| ---: | --- | --- |
| 64 | 01:08:55.024 | event_msg/thread_settings_applied |
| 65 | 01:08:55.029 | event_msg/task_started |
| 66 | 01:08:55.042 | turn_context |
| 67 | 01:08:55.081 | response_item/message, role user, outer context reference |
| 68 | 01:08:55.082 | event_msg/item_completed, item UserMessage, matching thread/turn |
| 69 | 01:08:57.870 | event_msg/item_completed, item AgentMessage |
| 70 | 01:08:57.871 | response_item/message, assistant commentary |
| 71 | 01:09:18.143 | response_item/custom_tool_call, name exec; final captured record |

All captured record timestamps are nondecreasing. There is exactly one tool-call record on the controlled turn in the captured bytes. Its input is exactly the `text(await tools.exec_command({cmd: <template literal>, login: false}));` wrapper with one exec_command. After decoding the observed doubled backslashes in that JavaScript literal, the shell command exactly equals metadata's prepared command. The literal contains no interpolation or embedded backtick. Thus the first outer functions.exec and its single inner shell request are verified without executing the captured command.

The outer user message references shared file `566e816cc82cfcbb6eb48728c455bc26151fcceb22728a0432d81aa12eccc725.md`. There is one matching user response_item plus its completed-item representation; those two schema representations are not two transport deliveries. The inner label `IB1151-SAMPLE-01-20260911` is absent from the outer message. Its absence is not a failed dispatch-marker test: file content is not the initial injected text.

## Exact audit correlation

Only the audit row with inject ID `a018d65d-cae6-4e9e-a469-c7dc0982315b` in `~/.telepty/logs/injects.jsonl` was selected for comparison; exactly one matching row was found. Its timestamp is `2026-09-11T01:08:49.909Z`, destination `ib1151-builder`, and delivery_result `success`. Its payload length of 153 bytes and SHA-256 `72c712f4b83a6191ee347c26efa1a554913fb9f125cc039053af3d17b0b33008` exactly match the captured outer user's UTF-8 text. Audit time precedes the captured user record.

This is payload correlation to the specified local audit entry, not a cryptographic binding of the inject ID into the rollout. claimed_from is orchestrator, but verified_sender_sid, verified_sender_epoch and verified_sender_generation are null. spoof_suspected=false does not authenticate a sender or establish a human origin. No prompts, nonces, or raw message bodies are reproduced here.

## Measurement layers and post-capture corroboration

| Layer | Evidence and limit |
| --- | --- |
| First tool invocation | Captured line 71 at 01:09:18.143Z records the outer exec request; this is not a pre-tool callback or shell-process entry timestamp. |
| Inner shell entry | The command request is captured, but exact process entry is unmeasured. Separately, post-capture line 72 reports a completed CommandExecution; its started_at_ms/completed_at_ms are 1789088958235/1789088958236, both later than the Python read. These event fields cannot serve as physical shell-start timing. |
| Python instrumentation entry | Metadata wall time 01:09:18.200376000Z; monotonic 1673992744969625 ns. Taken after importing time, after wrapper, shell and Python startup. |
| Snapshot read start | Wall time 01:09:18.209884000Z; monotonic 1673992754478041 ns. |
| Snapshot read end | Wall time 01:09:18.209959000Z; monotonic 1673992754552791 ns. |

Python entry precedes read start by 9,508,416 monotonic ns; the binary open/read/close bracket lasts 74,750 monotonic ns. Wall-clock differences are 9,508,000 and 75,000 ns. Clock-pair calls are sequential, not simultaneous. The first tool's logged timestamp precedes Python entry. The source may be concurrently appended during the read; the bracket does not timestamp visibility of each byte.

For completion and later ordering, only metadata's exact source path was read: `/Users/duckyoungkim/.codex/sessions/2026/09/11/rollout-2026-09-11T10-06-10-01a08e00-2b54-7f73-a1d7-8dd3695f569a.jsonl`. This later read contained 102 parsed records and began with the entire captured snapshot byte-for-byte. It is separate corroboration, never substituted for captured bytes:

- Line 72: CommandExecution completion at 01:09:18.236Z; line 73: token usage; line 74: first call's matching custom_tool_call_output at 01:09:18.328Z, nested exec_command exit code 0; line 75: token count.
- Line 76: second exec request at 01:09:22.720Z, exactly one exec_command reading the controlled shared reference with cat. Line 78 reports CommandExecution completion; line 79 records its output at 01:09:22.824Z.
- Subsequent outer exec requests are lines 81, 86 and 92, with outputs at 84, 90 and 96. The turn completes at line 102, 01:10:17.262Z. Only one capture-command occurrence appears in this observed controlled turn; no retry is observed in this bounded evidence.

Successful post-capture command completion corroborates execution of the command's environment-thread assertion. The environment value itself was not independently sampled by this tester. Re-reading equal bytes establishes neither transport deduplication nor fsync/crash durability.

## Executed assertions and claim verdicts

Command: `python3 dist/evidence/it1151/check.py` in the tester worktree. This temporary assertion script remains ignored and is not a tracked deliverable. **32 executed checks: 32 passed, 0 failed; measured in-process duration 0.016199 seconds; exit 0.** Exploratory reads are not counted as tests.

The 32 checks cover: snapshot hash; metadata hash; byte counts; complete-record count/newline; thread binding; source path binding; snapshot path binding; outer user reference; inner-label absence; unique outer user record; completed-user thread/turn; eight-record controlled-turn sequence; commentary before tool; exact single-shell/login-false wrapper; restricted JavaScript escaping; decoded command equality; single captured controlled-turn tool; nondecreasing snapshot timestamps; monotonic order; wall-clock order; tool log before Python entry; unique exact audit row; audit payload hash/length; audit target/success; audit before user; absent verified sender identity; later rollout's snapshot prefix; matching successful first output; exact second reference-read call; output before second call; one observed capture-command occurrence; artifact permissions.

| Claim | Verdict | Scope |
| --- | --- | --- |
| Expected artifacts, binding, parse/counts and trailing integrity | PASS | Independently recomputed from supplied local bytes. |
| Controlled outer message is in the captured snapshot | PASS | Matched by reference and exact audit payload hash/length. |
| First tool is prepared exec with one exec_command/login false | PASS | Actual captured custom_tool_call schema and exact decoded command. |
| Capture succeeds before the second tool reads the reference | PASS | Completion and second call require explicitly separate post-capture evidence. |
| Entry/read timestamps are ordered | PASS | Recorded Python measurements and logged events, not shell entry or external clock calibration. |
| Inner label itself was initially injected | FAIL | Absent from the actual outer user text; it is an inner-file label. |
| Universal pre-tool visibility or production-loop correctness | INCONCLUSIVE | One disposable sample, measured within the tool after startup. |
| Exact physical shell entry | INCONCLUSIVE | Not instrumented; completed-event timing is insufficient. |
| Authenticated human input or authenticated inject-ID rollout binding | INCONCLUSIVE | Local payload correlation only; verified sender fields are null. |
| Transport deduplication or fsync/crash durability | INCONCLUSIVE | Neither tested; capture code has no fsync. |

The negative inner-label claim is a bounded evidentiary verdict, not an assertion-suite failure: the suite deliberately checks the correct outer-message interpretation.

Snyk: `/Users/duckyoungkim/.aigentry/worktrees/it1151/bin/snyk-scan.sh --all` executed with cwd `dist/evidence/it1151`, scanning the temporary Python assertion code only; exit 0, reported total issues 0. No application/model execution, build, production changes, daemon restart, live probe, session creation, configuration change, sample retry, or queue mutation occurred. Build result: not run, prohibited by scope.

Next prerequisite: orchestrator review of this narrow result and an explicit approved specification for any broader measurement or implementation. This report provides no authorization or evidence to activate a production loop.
