# Task-loop ingress validation — 2026-09-11

**Result:** persisted Codex rollout records and the telepty inject audit do **not** jointly expose a stable delivery identity that binds event source, target thread, and prompt bytes. Isolated synthetic checks (TAP 13/13) show parser/join ambiguity. Timestamp order in existing rollouts is **not** a measurement of durable visibility before the first tool call. This does not implement a production task loop and does not approve a classifier.

**Task** #1151 · **Role** tester · **Worker** `iv1151-tester` · **Branch** `test/1151-ingress-validation`  
**Worktree** `/Users/duckyoungkim/.aigentry/worktrees/iv1151`  
**Written** 2026-09-11 UTC

Labels: **S** = inspected existing artifact or installed source; **F** = synthetic fixture / parser outcome; **U** = unmeasured without a controlled runtime trial.

No production code was edited. No daemon probe, live inject, transcript mutation, app boot, model API call, install, or build.

---

## Checkout and currentness (S)

| Ref | SHA / value |
|---|---|
| This worktree HEAD | `6b82b89a85f4dc2382186da1bdf4700015d4ae93` (`chore(1151): reject unsafe loop contract and dispatch scoped revision`) |
| Merge-base with local `main` | `6b82b89a85f4dc2382186da1bdf4700015d4ae93` (HEAD is an ancestor of local main) |
| Local `main` | `a49ebf0d17ef8c4ccfcb1e466ae42bf83eaaaf58` (`chore(1151): delegate isolated ingress validation and reap design worker`) |
| `origin/main` | `a536cd8b303f6781ccccc9f4817aa8a6c0416845` |
| `codex --version` | `codex-cli 0.153.4` (`/opt/homebrew/bin/codex`) |
| Installed telepty | `@dmsdc-ai/aigentry-telepty@0.8.3` via Node v20.20.0 |
| Sibling telepty HEAD | `997ea7c7d98b1dbc420e2e6de95d455a150e1b2c` (2026-09-08, `0.8.3`) |
| `command -v telepty` | `~/.nvm/versions/node/v20.20.0/bin/telepty` → `0.8.3` |
| Daemon-state (read file only; no probe) | version `0.8.3`, `startedAt` `2026-09-11T00:45:18.835Z`, pid `10225`, port `3848` |

Installed vs sibling `src/audit/inject-log.js` and `src/audit/provenance.js` are byte-identical. This is on-disk correspondence, not proof of incident-time residency.

| Artifact | SHA-256 | bytes |
|---|---|---|
| installed `cli.js` | `7bd030dd714fb4b34a35aecbd2264337d62cd6cb8fb71d9ed109195e617c5911` | 221085 |
| installed `daemon.js` | `a99e58872ed4d969f23d25bce6abf97eb6d01691657dd892699d6a591e0464ae` | 311224 |
| installed `src/audit/inject-log.js` | `297522746ef1c92a39cbef58682ec3412e4cccdb140a83b6ad2c1d473d14dd0b` | 10649 |
| installed `src/audit/provenance.js` | `dd4968e4ad2b5ae134094d91a57eb7346e33a87c78bd3f43a0cd60320b4538d9` | 4149 |
| `~/.telepty/logs/injects.jsonl` | `79f588efee328106e8cfb5c687668dfb325812247c9f768d34e4a944f940bfa7` | 1738728 |
| `~/.config/aigentry-telepty/tracked-injections.json` | `e1f48318164841782011fc4e34066d84c0d8d579287e7ecd72646517fbcc810b` | 18941592 |
| `~/.codex/session_index.jsonl` | `19fe79ed86c9072a5f55bf05b774a796f315fbbd618da1d2ee0e6cbfceaaf20a` | 8231 |
| `~/.codex/history.jsonl` | `fb2b55ce8c4ec56a5240bf2b8d0682b775e1f317f288dbbd5e27fac35be00234` | 1084899 |

`injects.jsonl` had **no** rotated siblings (`injects.jsonl.1` … `.5` absent). Live size 1.7 MiB is below the installed writer's 50 MiB rotation threshold. Rotation behavior was exercised only on synthetic files (F).

---

## 1. What persisted records expose (S)

Verdicts are **observed** / **absent** / **unknown**. Prompt bodies, previews, nonces, and transcripts were not printed or copied into this report.

### 1.1 Telepty inject audit (`~/.telepty/logs/injects.jsonl`)

- Lines parsed: **3179**, JSON errors: **0**, schema `v=1` on every line.
- Span: `ts` `2026-06-09T12:25:32.897Z` → `2026-09-11T00:42:36.482Z`.
- Top-level keys on every line: `v`, `ts`, `inject_id`, `kind`, `source`, `claimed_from`, `verified_sender_sid`, `spoof_suspected`, `to`, `to_alias`, `origin`, `origin_host`, `ref_path`, `payload_sha256`, `payload_bytes`, `payload_preview`, `delivery_result`. Extra keys on 2099/3179: `verified_sender_epoch`, `verified_sender_generation`. Nesting depth: 0. No `payload` body field.

| Field | Cardinality / values | Binding implication |
|---|---|---|
| `inject_id` | 2919 distinct / 3179 rows; 51 ids reused (max 7). Pair `(inject_id, to)` unique 3179/3179 | **Observed** delivery row id only as `(inject_id, to)`. `inject_id` alone is not unique under fan-out (`kind` multicast 32, broadcast 280). |
| `kind` / `source` | identical on every row: inject 2867, multicast 32, broadcast 280 | **Observed** telepty door. Not a human-vs-inject Codex source. |
| `to` | 401 distinct telepty SIDs; `to_alias` always null | **Observed** telepty session target. |
| `delivery_result` | success 2972, `failed:STALE` 170, `blocked:malformed-envelope` 25, `queued` 12 | **Observed** audit outcome, including `queued`. |
| `payload_sha256` | 2664 distinct; 100 hashes reused (max 83). `payload_preview` **always null**. `ref_path` **always null**. `payload_bytes` min 0 (13 zeros) max 18937 | **Observed** hash-only content fingerprint of the audit `payload` (installed `daemon.js` comments that this hash is the RAW prompt, not a provenance banner). Not a delivery id. |
| `claimed_from` / `verified_sender_sid` | claimed null 352; verified null 1862; `spoof_suspected` true 412 | **Observed** when present; **absent** on a large fraction. |
| `origin` | `trusted-local` 3179/3179 | **Observed** coarse origin label only. |

Installed `buildAuditLine` (hash `29752274…`) is the writer of this shape. Default redaction: `payload_preview=null`.

### 1.2 Observation ledger (`tracked-injections.json`)

- `schema_version` 2, `generation` 110, `injections` map length **1710**.
- Map key equals `inject_id` on 1710/1710.
- Record keys: `capability`, `created_at`, `inject_id`, `last_observation`, `observation_seq`, `observations`, `session_epoch`, `session_epoch_reason`, `session_id`, `tracking_state`, `transport_source`.
- `tracking_state`: superseded 1374, tracked 174, aborted 162.
- `inject_id` overlap with audit: both 1703, audit-only 1216, track-only 7.
- `session_id` overlap with audit `to`: 174 of 175 tracked SIDs.
- `last_observation.kind` = `daemon_restart_observed` on **1710/1710** (trigger `daemon_restart`). Historical `observations[]` still hold other kinds (79760 items), including `output_observed` 9545, `inject_parked` 4, `inject_delivery_dropped` 6. `bytes_written` present on **17** items, **all 0**, **none positive**. `consumption_status` when present: `not_established` 19213.
- Capability flags (all 1710): `turn_boundary=unavailable`, `capability_delivery=unavailable` (`816_not_implemented`), `outcome_protocol=unavailable` (`stage_b_deferred_to_0.9.0`).

The ledger is a second store keyed by `inject_id` + telepty `session_id`. It does **not** currently present a positive `bytes_written` or a turn-boundary fact.

### 1.3 Codex rollout records (`~/.codex/sessions/**/rollout-*.jsonl`)

- Files: **381**. Date buckets 2026-02-05 → 2026-09-10.
- Newest-15 event `type` values: `session_meta`, `event_msg`, `response_item`, `world_state`, `turn_context`, `token_usage_record`, `compacted`.
- `session_meta.payload` keys (newest 80): `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, plus usually `session_id`, `thread_source`, `history_mode`, `context_window`. `cli_version` includes `0.153.4` (28/80) through older alphas. `originator`: `codex-tui` 72, `codex_exec` 6, `Codex Desktop` 2. `source`: `cli` 72, `exec` 6, `vscode` 2. `model_provider`: `openai` 80/80.
- Filename UUID equals `payload.id` 80/80 and `payload.session_id` 79/80 (1 missing `session_id`).
- `event_msg` / `response_item` `payload.type=user_message` keys: `type`, `message`, `images`, `local_images`, `text_elements` (and often `audio`, `local_audio`). **No** `inject_id`, `kind`, `source`, `delivery_result`, `payload_sha256`, `nonce`.
- Tool-call payload types present: `function_call`, `custom_tool_call` with `call_id` / `name`. No inject correlation field.
- Banner markers `telepty:provenance` / `telepty:end` / fence: **0** of 649 user texts in 60 scanned files; **0** of 1661 `history.jsonl` rows.

### 1.4 Codex session index and history

- `session_index.jsonl`: 60 rows, keys `id`, `thread_name`, `updated_at`. Unique `id` 33 (index is not 1:1 with files). Unique `thread_name` 21; **5** names have multiplicity (max 23). **27** ids appear with more than one distinct `thread_name`. Index ids ⊆ file UUIDs (33); files not in index: 348.
- `history.jsonl`: 1661 rows, keys `session_id`, `ts` (int), `text`. No inject fields.

### 1.5 ID-space join (S)

| Left | Right | Intersection |
|---|---|---|
| Codex file UUIDs (381) | audit `to` (401) | **0** |
| Codex file UUIDs | tracked `session_id` (175) | **0** |
| Codex file UUIDs | session_index `id` (33) | 33 |
| user-text sha256 in 60 scanned rollouts (435 distinct) | audit `payload_sha256` (2664) | **188** |
| history.jsonl text sha256 | audit `payload_sha256` | **196** |

A hash intersection means some byte strings exist in both stores. It is **not** an `inject_id` binding. Live audit already has 100 colliding hashes (max 83).

### 1.6 Acceptance question 1 — summary

| Question | Verdict |
|---|---|
| Stable delivery ID | **Observed** in telepty audit as `inject_id` (UUID) and unique as `(inject_id, to)`. **Absent** from Codex `user_message` / `session_index` / `history.jsonl`. Fan-out reuses `inject_id`. Hash is not a delivery ID. |
| Exact event source | **Observed** in audit (`kind`/`source` = inject\|multicast\|broadcast). **Absent** on Codex user records (no source field; all scanned user texts unbannered). Human vs inject is **absent** in Codex. |
| Target thread/session | **Observed** separately: telepty `to` / ledger `session_id` vs Codex `session_id` / filename UUID / `session_index.id`. **ID spaces disjoint (0 overlap)**. `thread_name` is **ambiguous** (duplicates). |
| Prompt-content binding | **Partial / collision-prone**: audit hash-only (`payload_preview` always null); Codex stores `message`/`text` with no `inject_id`. Sha join **observed** as many-to-many. ID join **absent**. |

---

## 2. Synthetic fixture outcomes (F)

Not runtime provenance security. Not a loop implementation. Installed `inject-log.js` / `provenance.js` used as the audit parser/writer under test. Fixture bodies are `SYNTHETIC_*` strings only.

### Command (recorded TAP run)

- Cwd: `/Users/duckyoungkim/.aigentry/worktrees/iv1151`
- Argv: `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test --test-reporter tap dist/evidence/iv1151/test-ingress-ambiguity.cjs`
- Node: `v20.20.0`
- Start UTC: `2026-09-11T00:51:29.243324+00:00`; finish UTC: `2026-09-11T00:51:29.348661+00:00`
- TAP `# duration_ms 58.146125`; wrapper wall ~0.07s (`time -p` on stderr)
- Exit: **0**
- An earlier identical invocation also exited 0 (13/13) before TAP was redirected; the recorded files are this captured run.

`.cjs` extension is required because this package.json has `"type": "module"`.

### TAP (unmodified)

```
TAP version 13
ok 1 - audit schema v1 exposes inject_id, source, to, sha; omits payload body
ok 2 - fan-out reuses inject_id so inject_id alone is not a unique delivery row
ok 3 - two appended deliveries of the same text stay two rows; sha grouping collapses them
ok 4 - repeated readInjectLog of one file is stable; does not invent a second delivery
ok 5 - Codex user_message fixture has no inject_id, source, or delivery_result field
ok 6 - human and inject identical unbannered text cannot be attributed by Codex fields
ok 7 - missing audit: Codex user text with no inject_id cannot join to an empty log
ok 8 - delayed audit: later sha match is not an inject_id binding
ok 9 - queued unbannered delivery: audit can say queued; Codex body has no banner
ok 10 - live-file read after size rotation misses rotated records
ok 11 - in-memory overflow drops oldest appends: delayed/missing audit rows
ok 12 - duplicate thread_name selects multiple Codex sessions; telepty to matches none
ok 13 - sha join of identical text across two Codex threads is many-to-many, not a delivery id
1..13
# tests 13
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 58.146125
```

Named failures: none. `ok` lines: 13. `not ok` lines: 0.

TEST_REPORT totals below count these 13 executed tests only. Live-log inventory in §1 is not a test.

### Outcomes vs requested cases

| Case | Outcome |
|---|---|
| Repeated log reads vs two appended deliveries of the same text | Re-read of one line is stable (same `inject_id` + sha). Two appends of identical text keep **two** rows with distinct `inject_id` and **one** sha. Grouping by sha collapses; grouping by `inject_id` does not. |
| Human / inject identical text | `applyProvenance` with `capable:false` leaves body unbannered. Codex `user_message` has no source field. Candidate sources remain `{human, inject}`. |
| Missing / delayed audit | Empty log: sha join 0 and id join 0. After a later audit append with the same text: sha join 1, **id join still 0** (Codex fixture has no `inject_id`). Writer `queueMax` overflow drops oldest in-memory rows (`ov-0` absent, `ov-5` kept). |
| Queued unbannered delivery | Audit `delivery_result` distinguishes `queued` vs `success` for the same sha. Codex fixture has no `delivery_result` and no banner. |
| Truncation / rotation | Size rotation creates `injects.jsonl.1`. `readInjectLog(live)` does not see rotated-only `inject_id`s. Live-file read is an incomplete audit. |
| Ambiguous thread selection | Two `session_index` rows share `thread_name` → 2 candidates. Audit `to` (telepty SID) matches **0** Codex ids. Sha join of the same text across two Codex `session_id`s hits **both** audit rows. |

### Evidence files (ignored `dist/`)

| Path | SHA-256 | bytes |
|---|---|---|
| `dist/evidence/iv1151/test-ingress-ambiguity.cjs` | `440cfe1a38b6d56f90e199a9d68ca0ba30e4a7f598f33372436b5b3134cbdb1e` | 14014 |
| `dist/evidence/iv1151/stdout.txt` | `fce009233084fd8b07b56e432478fa11a6ba7302e53d910970ff25b000b2a6e9` | 2759 |
| `dist/evidence/iv1151/stderr.txt` | `dbf2dffb987a1dc82eb5b11a8bea0fa2a361f2f051dbeb7bc7454eedaac2d63f` | 29 (`time -p` only) |
| `dist/evidence/iv1151/fixtures/two-appended-same-text.jsonl` | `ddd4aa0f00e2f2ad306f252411a966fa9bc698cb9896fd8ac54cc1460a45142c` | 1004 |
| `dist/evidence/iv1151/fixtures/codex-user-message.jsonl` | `c5443dcc90d0d3b61282ef8e94c409b71cd139dd4365563a1b4ac7da219aac96` | 176 |
| `dist/evidence/iv1151/fixtures/human-inject-identical.jsonl` | `2407858320c558a4d097a26bce9758b42e1170ee463afcc00e972b6755947637` | 640 |
| `dist/evidence/iv1151/fixtures/queued-unbannered.jsonl` | `087efe524a435ed9c55f5dbb32dbabf5a00d0dc46600bdc4e4d799c9df340339` | 1091 |
| `dist/evidence/iv1151/fixtures/rotation-live.jsonl` | `2bdf8e6a76e2924b2c3fb2939b7f83879a1f9cf4e2f9e7dbddca3a03873a404d` | 504 |
| `dist/evidence/iv1151/fixtures/rotation-rotated-1.jsonl` | `8313e236ff5d1abf9f05a324f13a25962664c9b5b48925c2d968625ff0fdf800` | 504 |
| `dist/evidence/iv1151/fixtures/ambiguous-thread-index.jsonl` | `e476363fa3ef63ae426ec7b9589024c4ef0eeaf62ce7d17b4508a7e73c65828b` | 242 |

Snyk Code scan of `test-ingress-ambiguity.cjs`: **0 issues**.

---

## 3. Record timing (S) — durable visibility before first tool call

**Unresolved / unmeasured.**

What existing artifacts **do** show:

- In 60 scanned rollouts: first `user_message` timestamp precedes first `function_call`/`custom_tool_call` in **51** files; **0** files have a tool before the first user message; **9** have no tool event. Where both exist, gap min 3.723 s, p50 6.334 s, max 119.282 s.
- Audit `ts` is the inject-audit write time. Codex `timestamp` is the rollout event time. No shared id ties a specific audit row to a specific `user_message`.
- Ledger `capability.turn_boundary=unavailable` on 1710/1710. `bytes_written` never positive in the current file.
- Installed `createAuditWriter.append` is fire-and-forget (no fsync on the delivery path). That is source, not a runtime fsync measurement of Codex.

A timestamp/order correlation after the fact does **not** prove the user bytes were durable on disk before the first tool call began. Measuring that requires a controlled copy of the rollout file at inject-return, which this task forbade.

---

## 4. Smallest exact follow-up experiment

**Not authorized by this task. Do not run it until the orchestrator opens that gate.**

| Item | Exact |
|---|---|
| Owner | tester (execution) after orchestrator authorization. Builder not required: `codex` 0.153.4 and `telepty` 0.8.3 are already installed. |
| Transport | one `telepty inject --submit-force` into the telepty SID that owns a **throwaway** Codex TUI PTY (the inject HTTP/CLI door). |
| Files | (1) new `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` created by that session; (2) the new line in `~/.telepty/logs/injects.jsonl`; (3) two copies of the rollout taken by the tester. |
| Watermark | a unique synthetic string unused in any prior prompt; never a real user transcript. |
| Steps | 1. Start one throwaway `codex` in an empty tmp cwd; do not type. 2. Read `session_meta.payload.session_id` from the new rollout (read-only). 3. Inject the watermark to that session's telepty SID. 4. On inject CLI exit, **immediately** `cp` the rollout and sha256 the copy. 5. Wait until the first `payload.type` in `{function_call,custom_tool_call}` exists; `cp` again. 6. Test whether copy-at-inject-return already contains a `user_message` whose sha256 equals the audit `payload_sha256` for that `inject_id`. |
| Pass/fail meaning | Copy-at-inject-return **lacks** the line → durable visibility-before-tool is false on this host for this door. Copy **has** the line → first positive measurement for this host; not a general proof. |
| Out of scope | R3 architecture, classifier approval, replacing chat UX with a terminal-only control path, mutating global config, restarting the daemon. |

---

## 5. Limits

- Tests demonstrate information ambiguity and installed parser/writer behavior on synthetic fixtures. They do not prove runtime provenance security.
- Hash intersection on live files is a content-fingerprint overlap, not attribution.
- Daemon pid/port were read from `daemon-state.json`; no `/api` call and no `telepty list`.
- `tracked-injections.json` is a live file; the hash is the bytes at measurement time.
- No proposed classifier is approved.
- NOT RUN: npm test, app boot, live inject, send-key, daemon restart, model API, build, dependency install.

---

## TEST_REPORT (executed tests only)

`TEST_REPORT: iv1151-tester | suite=dist/evidence/iv1151/test-ingress-ambiguity.cjs | total=13 | passed=13 | failed=0 | skipped=0 | duration_ms=58`
