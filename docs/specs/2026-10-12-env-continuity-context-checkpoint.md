# SPEC — ES-02 context checkpoint, incremental sync and restore (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-12). No code. Not an implementation, merge, release or
  install claim (Rule 45 §2, Rule 50 §2).
- Parent: task #2026101204 "동일 계정으로 다른 머신에서 개발 작업 이어가기"; requirement doc
  `state/specs/2026-10-12-environment-sharing-release-requirements.md` acceptance criterion 2 (line 39)
  and verification matrix (lines 48–52); build-plan draft
  `state/draft/2026-10-12-environment-sharing-build-plan-proposal.md` §3 ES-02 (lines 41–45).
- Owners (proposal): aigentry-brain (record store, sync, restore) + orchestrator (checkpoint triggers).
- Depends on: ES-01 (stable `user_id` / `device_id`, device list, revoke; signing key, age recipient
  and trust model per §5.5). Feeds: ES-05 (origin
  checkpoint link), ES-07 (none), ES-04 (a workspace capture may reference a checkpoint id).
- ADR: `docs/adr/2026-10-12-env-continuity-context-and-workspace.md`.
- Measured: 2026-10-12, aigentry-brain `main` @ `0ffa6ee` (read-only), policy follow-up `df315c7`
  (branch `origin/fix/1165-policy-restoration-20261005`, not on `main`). Every file:line below was
  read in this session (Rule 39). Not measured: brain multi-device behaviour on real hosts, registry
  deployment state, Windows/macOS.

---

**Reading convention (orchestrator guardrail 2026-10-12 13:59Z).** Part A (§0) contains only FINDINGS.
Part B (§1–§12) contains only PROPOSALS. Every rule in Part B is a **proposal requiring user review**
unless it is tagged `[REQ]` (restates the requirement doc
`state/specs/2026-10-12-environment-sharing-release-requirements.md`, line cited) or `[EXISTING]`
(restates behaviour/text already present in a cited file) or `[DRAFT]` (taken from the approved
build-plan draft `state/draft/2026-10-12-environment-sharing-build-plan-proposal.md`, line cited — still a
proposal, but already shown to the user). Untagged = new proposal. "Must/never" wording
inside Part B is the proposed contract's wording, not an existing rule.

# PART A — FINDINGS

## 0. Findings

### 0.1 Exists (measured in this session)

| Fact | Source |
|---|---|
| Sync is opt-in: the setup wizard only creates/attaches a remote when `enableSync` is set ("explicit remote consent"); otherwise local-first | brain `src/cli/SetupWizard.ts:54`, `:146-153` |
| Remote = a **private GitHub repo of the user's GitHub account** created via `gh`, or found via git credentials | `SetupWizard.ts:156-213` |
| `SyncEngine` only starts when `config.remoteUrl` is set; else ProfileManager runs local-only | `src/mcp/BootstrapOrchestrator.ts:123-157` |
| The whole memory is **one file** `memory-profile.enc.json` (entries map id→ciphertext); every save rewrites it | `src/core/ProfileFormat.ts:20-29`, `:140-182` |
| Watcher triggers commits only for that profile file name (+`.enc.json`) | `src/sync/SyncEngine.ts:106-124` |
| Git backend: single branch `main`, `pull --rebase`, `git add .`, push `-u origin main`, 30 s timeouts; first clone is `--depth 1` | `src/backend/GitBackend.ts:19`, `:30`, `:79-97`, `:177-191` |
| `SyncBackend` interface has no diff/list/ref primitives (init/pull/commit/push/fetch/rebaseAbort/hasChanges/readFileAtRef/resetToRef) | `src/backend/SyncBackend.ts:1-13` |
| Conflict policy = per-entry version vector, then LWW, then tie-breaks; loser logged, not kept | `src/sync/ConflictResolver.ts:22-61`, `:114-168` |
| Pull failure recovery merges entries and **resets to remote** | `src/sync/PushPullManager.ts:61-159` |
| In that recovery, when the merged entries equal the remote (`entriesEqual`), it calls `resetToRef` (a `--soft` reset) and returns **without committing** | `PushPullManager.ts:142-146`, `GitBackend.ts:217-219` |
| brain's per-device age key pair lives in `~/.config/sops/age/keys.txt`, generated on first use and written with mode 0600 | `src/crypto/AgeCrypto.ts:24`, `:35-50`, `:55-77` |
| Sibling ES-01 spec answers this spec's R1–R7 in its §8.1 (signed `age_recipient`, keyed device list incl. revoked devices, server-clock `created_at`/`revoked_at`, endorsement validity rule, reader-side enforcement for brain-Git data); per-row citations in §5.5 | `aigentry-orchestrator-wt-1204-idq` @ `a6624d8` `docs/specs/2026-10-12-env-continuity-identity.md:463-474` |
| Encryption: age per entry; on encryption failure the writer **silently falls back to plaintext** | `ProfileFormat.ts:160-181` |
| New-device TOFU: a new device adds its recipient but **cannot decrypt** until an existing device re-encrypts. Being online is not enough: an existing device returns early when its own key is already a recipient (`:132`); re-encryption to the merged recipient set happens on that device's **next profile write**. Recipients are a union and never shrink | `GitBackend.ts:104-175` (esp. `:132`, `:150-153`); `ProfileFormat.ts:256-277` |
| Entry schema: `version_vector`, `device_id`, `source_machine_id`, `scope`, `policy`, `structured_payload.type` incl. `session_context` | `src/core/EntrySchema.ts:30-53` |
| Profile schema migration: `CURRENT_SCHEMA_VERSION = 2`, in-place migration on read | `src/core/SchemaMigration.ts:28-44` |
| Retention vocabulary exists (`retention_ttl` "30d"/"24h"/"1y"/"forever") inside `PolicyEnvelope` | `src/policy/PolicyEnvelope.ts`, `src/policy/RetentionParser.ts:6-50` |
| `brain_context_resume` input = `windowTokens`, `mode`, `confidenceThreshold`; output = packed text + metrics JSON; no provenance marking | `src/mcp/BrainMcpServer.ts:270-326` |
| `ContextRestoreService.restore` packs `user`-scope entries by category slots; no notion of original vs summary | `src/context/ContextRestoreService.ts:309-390` |
| `brain_save_session_context` stores one mutable `session_context` entry per project (architecture, decisions, session_history summaries) | `BrainMcpServer.ts:726-769`, `src/contract/BrainContract.ts:899-923` |
| Existing redaction is a tool-argument **allowlist**, not a content secret scanner | `src/capture/capture-tool.ts:38-56` |
| A `redactionViolations` metric exists in the capture shadow evaluator (threshold 0); it counts violations, it does not scan content | `src/capture/shadow-evaluator.ts:13`, `:52` |
| devkit "snapshot restore" (604f2b5) = a local SessionStart(compact) hook that re-reads `$root/.context-snapshot.md` (≤400 lines/32 KiB); no sync | aigentry-devkit `hooks/post-compact-restore.sh:1-16` |

### 0.2 Searched for and not found

- No checkpoint record type, no `(user, device, session, seq)` key, no lineage/parent field, no
  per-record integrity hash, no incremental cursor (`SyncBackend.ts:1-13` has no diff/list primitive).
- No fork detection: concurrent edits of one entry are resolved by version vector then LWW and the loser
  is only logged (`ConflictResolver.ts:49-51`, `:147-163`).
- No original-vs-summary marking in `brain_context_resume` output (`BrainMcpServer.ts:288-311`).
- No fail-closed encryption path (fallback is plaintext, `ProfileFormat.ts:160-181`).
- No content secret scanner in brain `src/` (grep for redact/secret/token found only the argument
  allowlist `capture-tool.ts:38-56` and age key parsing `AgeCrypto.ts:43`).
- No binding between the GitHub account owning the brain repo and an aigentry `user_id` (none in
  `SetupWizard.ts`; registry not read in this dispatch).
- No devkit caller of `brain_get_session_context` / `brain_save_session_context`, despite the tool
  description "Used by devkit for workspace init" (`BrainMcpServer.ts:730`): grep over aigentry-devkit
  for `session_context|getSessionContext` returned nothing.
- `bin/context-compact.sh` (referenced by devkit 604f2b5 commit message) is not present in the
  orchestrator clone at `task-1204-env-continuity-ctxws`. It exists on `origin/release/0.2.5` (commits
  `1d8a600` "context-compact.sh works for every orchestrator CLI", `ac94b35`), i.e. the compaction path
  for non-Claude CLIs (codex/gemini/grok/agy per the 604f2b5 message) is on another branch.
- `~/projects/aigentry/docs/CONSTITUTION.md` is not present in the aigentry checkout (find returned no
  constitution file); Article 1/17 are taken from the session's common instructions only.

### 0.3 Not measured

Brain sync between two real hosts (only the unit/e2e test names in `tests/e2e/e2e.device-sync.test.ts:13-170`
were seen, not run); registry auth deployment and any ES-01 device API; Git-host behaviour for deleted
refs/history; macOS/Windows; size/latency of `ls-tree` on large brain repos; per-CLI availability of a
compaction hook/trigger (only Claude `SessionStart(compact)` and the `context-compact.sh` commit subjects
were seen); tests were not run (SAWP).

# PART B — PROPOSALS (each requires user review unless tagged)

## 1. Non-claims

- N1. `[REQ line 39]` A checkpoint restores **recorded text and structured facts** into a new or resumed CLI session.
  It never claims to restore model internal state (KV cache, hidden reasoning, sampling state) or OS
  process memory, open file descriptors, PTY buffers or environment of the source process.
- N2. `[REQ line 42]` A restored session is a **new session that has read the checkpoint**. Resumption is
  "reconnect/recreate", never live migration.
- N3. `[REQ line 39]` `[DRAFT line 44]` Restore states which facts are original and which are summary; a
  summary is never presented as the original text. New proposal (needs review): only fragments whose raw
  bytes are present and hash-verified may be marked `original` (§6).
- N4. `[REQ line 16]` Remote consent is never bypassed silently by account login. New proposal (needs
  review, decision D-7): uploading conversation-derived checkpoints needs its **own** explicit opt-in,
  separate from brain's `enableSync` memory-sync consent (`SetupWizard.ts:54`); without it records are
  local-only (`sync:"local_only"`). The binding of the brain repo's GitHub account to the ES-01 identity
  (§5.2, D-5) and the writer checks (§5.4) are new proposals too.
- N5. `[REQ line 12]` `[DRAFT line 9, 27]` Works from any terminal on the telepty daemon; no GUI typing,
  no cmux dependency; a copied log file or an SSH connection alone never claims completion. New proposal (needs
  review), applied here:
  triggers, write, sync and restore are invoked only through CLI commands, CLI hooks, brain MCP tools or
  telepty daemon APIs; nothing types into a GUI, reads a cmux pane or scrapes a screen. The only evidence
  that a checkpoint was written/synced/restored is the reader-verified `checkpoint_id` + `content_sha256`
  (§2, §6); a log line, a copied file or a command run over SSH is not evidence.

## 2. Checkpoint record (schema_version 1) — key and field list `[DRAFT line 42]`, `[REQ line 39]`; types/bounds new

One record = one immutable JSON document. Key: `(user_id, device_id, session_ref, seq)`.

| Field | Type | Rule |
|---|---|---|
| `schema` | `"aigentry-checkpoint"` | constant |
| `schema_version` | int | `1` for this spec (§9) |
| `checkpoint_id` | string | `ckpt_<device_id>_<session_ref>_<seq>`; derived, never reused |
| `user_id` | string | ES-01 stable user id; restore refuses a record whose `user_id` ≠ the logged-in user (§5.4) |
| `device_id` | string | ES-01 device id of the writer (must be `active` at write time; enforced by readers, §5.4) |
| `source_session` | object | `{cli: "claude"\|"codex"\|"gemini"\|…, session_ref, project_id, started_at}`; `session_ref` = sha256(cli + native session id)[:16] (no raw session ids in sync paths); `project_id` = git remote URL with credentials stripped, else folder-name hash (same convention as `BrainMcpServer.ts:732`) |
| `seq` | int ≥ 1 | monotonic per `(device_id, session_ref)`; persisted locally with fsync **before** the record is written; never reused |
| `created_at` | ISO-8601 UTC | writer clock; informational, never used for ordering |
| `parents` | string[] | lineage: `[]` for a root; `[prev checkpoint_id]` for a linear step; `[a, b, …]` only for a user-chosen fork resolution (§4.3) |
| `resumed_from` | string\|null | checkpoint id this session was restored from (cross-device continuation); also listed in `parents` for the first checkpoint of the resumed session |
| `trigger` | enum | `manual \| compact \| session_end \| dispatch_report \| interval` |
| `fragments` | Fragment[] | CLI transcript fragments (§3) |
| `summary` | string | ≤ 8 KiB; model- or user-written; always marked `summary` |
| `decisions` | `{text, at?, evidence?: string[]}`[] | ≤ 100 |
| `constraints` | `{text, source: "user"\|"rule"\|"derived"}`[] | ≤ 100 |
| `open_items` | `{text, task_ref?}`[] | ≤ 200; unfinished work |
| `evidence` | `{kind: "commit"\|"file"\|"pr"\|"url"\|"ledger", ref, sha256?}`[] | ≤ 200; refs only, never file bodies |
| `task_refs` | `{task_id, task_version}`[] | ES-03 canonical id + version observed when written (for the two-machine agreement test) |
| `workspace_capture_id` | string\|null | ES-04 capture taken at the same point, if any |
| `privacy` | `{fragment_mode: "hash_summary"\|"raw", redaction: {scanner_version, findings_dropped:int}}` | §3.2 |
| `retention` | `{class: "checkpoint"\|"raw_fragment", ttl: "90d"…}` | §8; uses the `RetentionParser` vocabulary |
| `integrity` | `{alg:"sha256", canonical:"jcs", content_sha256}` | sha256 over the canonical JSON (RFC 8785 JCS) of the record **without** `integrity` and `signature`; verified on every read |
| `signature` | `{alg:"ed25519", device_id, sig}` | writer authentication (§5.4): the writer's ES-01 device key signs `"aigentry-checkpoint-v1\|" + user_id + "\|" + checkpoint_id + "\|" + content_sha256`; verified on every read. `integrity` alone is unkeyed and age gives confidentiality only, so neither authenticates the writer |

Bounds per record: 1 MiB canonical bytes; fragments ≤ 256; raw fragment text ≤ 64 KiB each. A writer
that would exceed a bound splits into consecutive seqs; it never truncates silently (truncation, if
any, is recorded as a fragment with `truncated:true` and the original hash).

### 3. Transcript fragments and privacy modes

```
Fragment = { idx, role: "user"|"assistant"|"tool"|"system", turn_range: [from, to],
             byte_len, sha256, mode: "hash_only"|"summary"|"raw",
             summary?: string (≤ 1 KiB), raw?: string, truncated?: bool }
```

`sha256` is over the exact UTF-8 bytes of the fragment as the CLI produced it (after newline
normalisation to LF) **and after §3.2 redaction**, in every mode — so M1 and M2 never store a hash of
unredacted text, which would be a guessing oracle for short secrets. The hash is **always** stored.
Verifying an M1 fragment against the source transcript therefore re-applies the redaction of the
recorded `scanner_version` first.

#### 3.1 Modes (decision needed — Rule 47 "개인정보 전송", ADR D-1)

| Mode | Stored and synced | Restore fidelity | Privacy exposure |
|---|---|---|---|
| **M1 `hash_summary` (recommended default)** | hash + byte_len + per-fragment summary + record summary/decisions/constraints/open items | restored text is marked `summary`; originals can be **verified** later if the user still has the source transcript, never reproduced | only derived text leaves the device |
| M2 `raw` (opt-in per project) | M1 + redacted raw fragment text | fragments marked `original` when hash verifies (hash is over the redacted text, see §3.2) | conversation text (possibly code, personal data) is copied into the user's private Git remote and its full history |

Recommended default **M1** because: (a) the brain backend is Git — deleting a raw fragment removes it
from `HEAD` only; purging history needs a rewrite + force push of the user's repo, which is an
operational data deletion (Rule 47) and is not under aigentry's control on the Git host; (b) the
requirement asks to state which facts are original vs summary (line 39), which M1 satisfies honestly;
(c) M2 can be enabled later per project without a schema change.

#### 3.2 Secret exclusion (both modes; `[REQ line 49]` secrets excluded from sync — detector set and fail-closed rule are new proposals)

- A content secret scanner runs on **every string value** of the canonical record — not a field list:
  free text (`summary`, `decisions[].text`, `decisions[].evidence`, `constraints`, `open_items`,
  `fragments[].summary`, `fragments[].raw`), refs (`evidence[].ref`, `task_refs`, `resumed_from`) and
  metadata (`source_session.*`, any other string) — **before** integrity, signing and encryption. brain has
  none today (`capture-tool.ts:38-56` is an argument allowlist) — this is new work.
- URL-shaped values (`evidence[]` of kind `url`/`pr`, URLs inside `decisions[].evidence` and other refs)
  have userinfo (`user:pass@`), the query string and the fragment stripped by default, before the scan;
  keeping them is a per-ref user choice recorded in the ref (`keep_query: true`), and the kept part is still
  scanned.
- A hit in free text or a ref is redacted as below. A hit in a key-forming identifier (`user_id`,
  `device_id`, `checkpoint_id`, `source_session.session_ref`/`project_id`) cannot be redacted without breaking
  the key, so the write is refused (`CHECKPOINT_SECRET_IN_IDENTIFIER`, field and detector named only).
- Minimum detector set: private-key PEM blocks, age secret keys (`AGE-SECRET-KEY-`, cf.
  `src/crypto/AgeCrypto.ts:43`), cloud provider key patterns, `Authorization: Bearer`/JWT shapes,
  `password=`/`token=`/`secret=` assignments, high-entropy strings ≥ 32 chars adjacent to such names,
  `.env`-style `NAME=value` lines whose NAME contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or
  `CREDENTIAL` (ES-04 has no env-name deny-list; its §3.1 secret set covers the files themselves).
- A finding replaces the match with `[REDACTED:<detector>]`; in both modes the fragment `sha256` is then
  the hash of the redacted text (§3) and `raw_original_sha256` is omitted (an un-redacted hash of a secret
  is itself a guessing oracle for short secrets). `privacy.redaction.findings_dropped` counts them.
- Scanner findings, error messages and brain logger output name the field and detector only; they
  never carry the matched text (requirement line 49 "로그").
- If the scanner cannot run (missing, crashed, version mismatch) the write **fails closed**
  (`CHECKPOINT_REDACTION_UNAVAILABLE`); no record is written.
- Scanner false negatives are possible; the guarantee is "scanned with detector set vN", never
  "contains no secrets". Tests use synthetic fixture secrets only (Rule 46 §5).

## 4. Storage on the existing brain Git backend

### 4.1 Layout (append-only, one file per record)

```
<brain repo>/                          (existing; memory-profile.enc.json untouched)
  checkpoints/
    v1/<user_key>/<project_key>/<device_id>/<session_ref>/<seq:08d>.ckpt.age
  trust/
    v1/<user_key>/<endorsed_device_id>/<endorser_device_id>.endorse.json   (§5.6)
  .aigentry/checkpoint-index.json      local only, gitignored (cursor + seen set, §4.2)
```

- `user_key`, `project_key` = sha256(...)[:16] of `user_id` / `project_id` (no raw URLs in paths).
  These are unkeyed: for a public repo a dictionary of remote URLs reverses `project_key`; `device_id`,
  `session_ref` and commit timing are visible too. A keyed hash would need a per-user secret shared by all
  devices, which does not exist (device keys are per device, §5.5). This metadata exposure is therefore
  stated in the checkpoint-upload opt-in text (D-7).
- File body = age ciphertext (existing `encryptBlock`, `AgeCrypto.ts`) of the canonical record.
  Recipients = the age public keys of the user's **active, trusted** ES-01 devices (§5.3, §5.5).
- **No plaintext fallback.** Unlike `ProfileFormat.writeToFile` (`ProfileFormat.ts:160-181`), an
  encryption failure aborts the write (`CHECKPOINT_ENCRYPTION_FAILED`).
- Records are immutable. Writers never modify or delete a checkpoint file in place. A path that already
  exists with **identical** bytes (duplicate write, replay after a partition) is an idempotent no-op: no
  new file, no commit, the existing id is returned. A path that already exists with different bytes is an integrity incident (`CHECKPOINT_KEY_CONFLICT`), the new
  record is written as `<seq>.<content_sha256[:8]>.ckpt.age` and both are surfaced at restore.
- Why not brain entries: entries live inside one rewritten file (`ProfileFormat.ts:140-182`) and are
  merged by LWW (`ConflictResolver.ts:49-51`), which would silently drop a concurrent device's
  checkpoint. Unique append-only paths make `pull --rebase` (`GitBackend.ts:83`) conflict-free for
  checkpoints by construction.

### 4.2 Incremental cursor

Local, per device, never synced (`.aigentry/checkpoint-index.json`, added to the backend's ignore
list next to `.aigentry/sync-status.json`, `GitBackend.ts:60-65`):

```
{ "v": 1, "remote_commit": "<sha of origin/main last scanned>",
  "seen": { "<checkpoint_id>": "<content_sha256>" }, "heads": { "<project_key>/<lineage root>": [ids] } }
```

Sync step (after the existing `pull`): (1) fast path — `git diff --name-only <remote_commit>..HEAD --
checkpoints/`; (2) if `remote_commit` is unknown to the repo (shallow clone `--depth 1`,
`GitBackend.ts:30`, or history rewrite) fall back to a full `git ls-tree -r --name-only HEAD
checkpoints/` and diff against `seen`. New paths are decrypted, integrity- and signature-verified (§5.4), added to `seen`,
and lineage heads recomputed. A record that fails decryption stays `pending_key` (not `seen`) and is
retried on the next pass (§5.3); a record that fails integrity is quarantined (`seen` value
`"QUARANTINED:<reason>"`) and reported, never restored.

### 4.3 Conflict policy — lineage fork + user choice (`[DRAFT line 43]`; details new)

- Linear: each new checkpoint of a session lists the previous one in `parents`.
- Fork: two or more records share a parent (e.g. two devices both resumed from checkpoint X, or both
  continued after a partition). The lineage then has several **heads**. Nothing is merged or dropped
  automatically; there is no LWW for checkpoints.
- Restore of a forked lineage returns all heads with device, `created_at`, summary and open-item diff
  and requires an explicit choice (`checkpoint_id`). The chosen continuation writes its next
  checkpoint with `parents: [chosen]` (or `[a, b]` when the user asks to carry both — the record then
  contains the user's merged summary; the originals remain unchanged and reachable).
- Task state is **not** reconciled here: `task_refs` only records what was observed; the authority
  for task version is ES-03.

### 4.4 Required additions to brain (scope for the implementer)

| Addition | Where | Why |
|---|---|---|
| `SyncBackend.diffNames(fromRef, toRef, pathspec)` and `listTree(ref, pathspec)` | `src/backend/SyncBackend.ts:1-13`, `GitBackend.ts` | cursor fast path + shallow-clone fallback |
| `commitPaths(paths, message)` (add only the given paths) | `GitBackend.ts:177-184` uses `git add .` | avoid committing unrelated files; explicit checkpoint commit |
| Checkpoint commit independent of the profile merge outcome | the recovery path returns after `resetToRef` (a `--soft` reset, `GitBackend.ts:217-219`) **without committing** when the merged entries equal the remote (`PushPullManager.ts:142-146`), which would leave checkpoint files staged but uncommitted | checkpoint files are committed by their own `commitPaths` call after every pull/recovery, never as a side effect of the profile merge commit (CK-17) |
| Commit trigger for `checkpoints/**` | `SyncEngine.ts:106-124` watches only profile files | checkpoint writes call `autoCommitter.scheduleCommit()` directly |
| `CheckpointStore` (write/read/verify/list heads) + `CheckpointIndex` (cursor) | new `src/checkpoint/` | §2–§4 |
| Fail-closed encryption path | new; must not reuse `ProfileFormat.writeToFile` fallback | §4.1 |
| Content secret scanner | new `src/checkpoint/redact.ts` (or shared) | §3.2 |
| Recipient set from ES-01 device list | new; replaces TOFU for checkpoints | §5.3 |
| Record signing (writer) + signature/revocation verification and device-list cache (reader) | new `src/checkpoint/`; Ed25519 via Node `crypto` (stdlib) | §5.4, §5.5 |
| MCP tools `brain_checkpoint_write`, `brain_checkpoint_list`; `brain_context_resume` extension | `BrainMcpServer.ts` | §6, §7 |

No new dependency is required: `simple-git`, age and Node stdlib are already used (Article 17).

## 5. Identity, isolation and keys

### 5.1 Writer preconditions
A write requires: ES-01 identity present (`user_id`, `device_id`, device `active`, device signing key
readable); for remote sync, brain sync opt-in (`enableSync`) **and** the separate checkpoint-upload
opt-in (N4, ADR D-7) — else the record is written **local-only** and flagged `sync:"local_only"`; scanner available; encryption available.

Written ≠ synced (the checkpoint analogue of "accepted ≠ completed"). The local index records per record
`sync_state ∈ written` (file fsynced locally) `→ committed` (in a local commit) `→ pushed` (the push
succeeded and a fetch of `origin/main` contains the commit). A trigger or CLI may say "saved on this
device" at `written` and "saved for your other devices" only at `pushed`. Whether another device has
actually read it is not observable by the writer and is never claimed.

### 5.2 Isolation (other account)
Three independent barriers, all required: (1) storage — the brain remote is the user's own private
repo (`SetupWizard.ts:186-213`); (2) crypto — records are encrypted only to that user's device keys;
(3) logic — restore rejects `user_id` mismatch (`CHECKPOINT_USER_MISMATCH`) even if a file is
readable. **Open risk:** the GitHub account that owns the brain repo is not today bound to an
aigentry `user_id`; ES-01 must record that binding, otherwise barrier (1) only isolates GitHub
accounts. Two aigentry users sharing one GitHub account are not supported.

### 5.3 Fresh device (third device) keys
Measured gap: under TOFU a new device cannot decrypt until an **existing device** is online and
re-encrypts (`GitBackend.ts:150-153`). For checkpoints, recipients are taken from the ES-01 active
device list at write time, restricted to trusted devices (§5.5 R5). Consequences, stated honestly:
- Records written **after** the new device registers and becomes trusted are readable on it immediately.
- Records written **before** are readable only after any active device re-wraps them (a background
  "rekey" pass that writes `<seq>.rekey-<n>.ckpt.age` siblings, never modifying originals; an automatic
  write into the user's repo, covered by ADR D-4). Until then
  restore reports `pending_key` with the list of devices that can rekey. The "third device restores
  the same work" test (CK-03) therefore requires either an online existing device or a checkpoint
  written after registration; the test must record which.
- Revoked devices: excluded from recipients of new records; records they sign after `revoked_at` are
  rejected by every reader (§5.4); past ciphertexts stay decryptable by a revoked device that kept a copy
  (crypto cannot revoke the past).
- **Known limit (S1 Git storage).** ES-01 revoke does not remove the revoked machine's access to the brain
  repo: that access is the user's GitHub credential on that machine (`gh` / git credential,
  `SetupWizard.ts:156-213`), outside aigentry's control. Until the user revokes or rotates that credential,
  the revoked device can still pull every ciphertext (and decrypt every record written before the revoke),
  read the plaintext path metadata and commit timing (§4.1), and push commits. Pushed records are rejected
  by readers (§5.4); deleting or overwriting files is an availability attack that readers detect (paths in
  `seen` disappear outside a retention pass and are reported) but cannot prevent. The revoke flow therefore
  includes a required user step — revoke that machine's GitHub credential — and the device list shows
  `git_access: "unknown"` until the user confirms it (decision D-8 in the ADR).

### 5.4 Writer authentication and reader-side verification (`[DRAFT line 36]` device-key signing; rules new)
A reader (sync pass §4.2, restore §6, list) accepts a record only if all hold:
1. integrity verifies (`CHECKPOINT_INTEGRITY_FAILED`);
2. `signature.device_id` == `device_id` == the `device_id` path component, and that device is in the
   authenticated device list of the logged-in `user_id` (§5.5) and trusted (R5, §5.6) — else
   `CHECKPOINT_WRITER_UNKNOWN` (kept unseen and retried after the next list fetch, never restored);
   and the **whole path** equals the path derived from the record — `checkpoints/v1/` +
   sha256(`user_id`)[:16] + `/` + sha256(`source_session.project_id`)[:16] + `/` + `device_id` + `/` +
   `source_session.session_ref` + `/` + `seq` (8 digits), with `checkpoint_id` equal to its derived form and
   only the suffixes `.ckpt.age`, `.<content_sha256[:8]>.ckpt.age` (the 8 hex must match the record),
   `.rekey-<n>.ckpt.age` or the M2 `.raw.age` sibling (§8) — else `CHECKPOINT_PATH_MISMATCH` (quarantined), so a
   valid signed record copied to another project/session/seq path is never restored there;
3. the Ed25519 signature verifies with that device's signing key (`CHECKPOINT_SIGNATURE_INVALID`,
   quarantined);
4. `user_id` equals the logged-in user (`CHECKPOINT_USER_MISMATCH`, §5.2);
5. revocation: if the device has `revoked_at`, a record with `created_at ≥ revoked_at` is rejected
   (`CHECKPOINT_DEVICE_REVOKED`). `created_at` is the writer's clock and a revoked device can backdate it,
   so a record with `created_at < revoked_at` that this reader first sees after `revoked_at` is accepted
   only when anchored — already in this reader's `seen` set before `revoked_at`, or listed in `parents` /
   `resumed_from` of an accepted record signed by a non-revoked device. An unanchored one is
   `CHECKPOINT_REVOKED_WRITER_UNANCHORED`: listed with device and time, never restored as context without
   an explicit user choice. ES-01 `expired` (idle expiry) is not revoked; its signatures stay valid.

Rejection happens on the reader, not at the remote: anyone with push access to the brain repo (a revoked
device that kept its Git credential, or another account given access) can add files, but no reader
accepts them. The reader caches the device list with `fetched_at`; offline it uses the cache, and the
restore output shows `device_list_fetched_at` so a revoke newer than the cache is visibly not yet applied.

Writer side: the recipient set comes from the same cache. The write output and `brain_checkpoint_write`
result show `recipients as of <fetched_at>`; a cache older than 24 h (proposal) adds a warning. Before a
`written`/`committed` record is pushed (§5.1), the writer re-fetches the list; if a recipient was revoked or
lost trust since `fetched_at`, the record is re-encrypted to the current set first (the canonical record and
its signature are unchanged; only the age wrapper of the not-yet-pushed file is replaced). A record already
`pushed` stays readable by that device — the past-ciphertext limit of §5.3.

Anchoring cost: a fresh device has no `seen` set, so every legitimate pre-revoke record of a revoked device
that is not referenced by an accepted record reads `CHECKPOINT_REVOKED_WRITER_UNANCHORED` there and needs an
explicit user choice to restore. This cost is accepted and listed under D-8; a signed "seen-set" attestation
by a trusted device is a possible later mitigation, not proposed now.

### 5.5 Requirements on ES-01 (sibling spec `docs/specs/2026-10-12-env-continuity-identity.md`, read-only)
The "ES-01 spec today" column is a finding (§0.1), read at sibling commit `a6624d8` (`aigentry-orchestrator-wt-1204-idq`,
clean tree); ES-01 answers R1–R7 in its §8.1 (l.463–474).

| # | ES-02/ES-04 needs | ES-01 spec today (`a6624d8`) | Requirement on ES-01 |
|---|---|---|---|
| R1 | per-device signing key | Ed25519 key pair per device, private half never leaves (ES-01 §2, §3.1 `public_key`, §6) | met; ES-02/ES-04 use domain-separated prefixes (`aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|`) distinct from ES-01's `aigentry-device-v1\|` (§4) |
| R2 | per-device age recipient | met: `age_recipient`, `age_recipient_sig` over `"aigentry-age-recipient-v1\|" + hex(public_key) + "\|" + age_recipient`, `age_recipient_set_at` (§3.1 l.167–169); set at `/devices/authorize` or `PUT /devices/me/age-recipient` (§8 l.456, §8.1 R2 l.468). The signature binds `public_key`, not `device_id` (no id exists when the device signs) | add `age_recipient` (X25519) per device, registered at `/devices/authorize` together with an Ed25519 signature over it by the device key, so the registry cannot substitute it without breaking the signature; rotation = a new signed value. Key material (new proposal, needs review): the `age_recipient` is the device's **existing** brain age key pair (`~/.config/sops/age/keys.txt`, `AgeCrypto.ts:24`, created mode 0600 by `ensureKeyFile` `:55-77`), not new key material — brain already needs that identity to decrypt the memory profile, and a second X25519 key held by the same OS user adds no isolation. ES-01 §8.1 R2 says the private half follows the device-key store rules (§6: Keychain on macOS, DPAPI on Windows), which brain's plain 0600 file does not meet on those OSes; whether to move the brain key into the ES-01 store is ES-01's decision (D-ID-2), coordinated, not decided here |
| R3 | authenticated device list with keys and revoke time | met: `GET /devices?include=keys&all=true` (device bearer only) returns `id, name, os, status, created_at, revoked_at, public_key, age_recipient, age_recipient_sig, age_recipient_set_at`, revoked and expired devices, and `server_time` (§8 l.454, §8.1 R3 l.469) | list also returns `public_key`, `age_recipient` + its signature, `revoked_at`, and includes revoked devices for verification (CLI `--all` exists, §9); served only to the owner's device bearer (§7.1) |
| R4 | trustworthy revoke time | met: `created_at` and `revoked_at` are server clock, set once, never moved; an `expired` re-bind keeps `created_at`; idle expiry is not a revoke (`revoked_reason` excludes it) (§3.1 l.178–181, §8.1 R4 l.470) | `revoked_at` is server-clock, set once, never cleared or moved; re-login of a revoked device creates a new `device_id`; the list also exposes each device's server-clock `created_at`, set once and never moved (the §5.6 E3 endorsement test depends on it) |
| R5 | key-directory trust model | met on the ES-01 side: same model, fingerprint (first 8 bytes of sha256 of `public_key`), pinned-value changes surfaced as registry faults, and the endorsement validity rule in the wording used here (§8.1 R5 l.471); endorsement file, storage and D-9 left to ES-02 | stated model: the registry is the key directory and is trusted for membership; a compromised registry could add a device key and become a recipient of new records. Mitigation: each client pins the device set (id + key fingerprints) it last trusted; a device is **trusted** when it is in the registry list **and** carries a valid endorsement signed by an already-trusted device (the user's first device — earliest server-clock `created_at` — is self-trusted); the endorsement is a small signed file in the brain repo (§5.6) written when the user confirms the new device on any trusted device after comparing the fingerprint. **Endorsement validity, using ES-01 timestamps:** an endorsement is valid only if the endorsed device's server-clock `created_at` **precedes** the endorser's `revoked_at` (or the endorser has no `revoked_at`). An endorsement by a device dated after that device's `revoked_at` is void. Revoking a device does not revoke the devices it endorsed. The endorsement's own `created_at` is the endorser's clock and is never used for this test; the §5.4 rule-5 anchoring applies to endorsements too (§5.6 E3–E4). Whether endorsement is required (recommended) or the registry list alone suffices is decision D-9 |
| R6 | user-visible recipient-change notice | met on the ES-01 side: additions, key changes and revokes are observable in the list with `name`, `os`, `created_at`, fingerprints and `server_time`; showing the notice is ES-02's job (§8.1 R6 l.472) | any addition, key change or revoke in the pinned set is shown to the user (device name, os, created_at, fingerprints) at the next CLI/MCP interaction and in the restore metrics (`recipients_changed`) before the new set is used for writes; removals take effect immediately |
| R7 | revoke enforcement for Git-stored data | met: brain-Git-stored checkpoints and captures are "not a registry resource; readers verify the writer against the device list" (§7.2 l.392–395, §7.3 row l.409, §8.1 R7 l.473) | enforcement is the reader-side rule of §5.4; no further change asked of ES-01 |

### 5.6 Endorsement file and reader rules (R5; new proposal, needs review — decision D-9)

```
trust/v1/<user_key>/<endorsed_device_id>/<endorser_device_id>.endorse.json
{ "schema": "aigentry-endorsement", "schema_version": 1, "endorsed_device_id", "endorsed_key_fp",
  "endorser_device_id", "created_at", "sig" }
```

`sig` = the endorser's ES-01 device key over `"aigentry-endorsement-v1|" + user_id + "|" + endorsed_device_id
+ "|" + endorsed_key_fp + "|" + endorser_device_id`; `endorsed_key_fp` is the ES-01 fingerprint of the endorsed
device's `public_key`. The file is signed, not encrypted (ids and a fingerprint only; `user_id` is bound by the
signature, not stored). Endorsements are append-only like records (§4.1). A reader counts an endorsement only
if all hold:
- E1. path binding: the path's `user_key` is the logged-in user's and its two device ids equal the file's
  fields — else `ENDORSEMENT_PATH_MISMATCH` (quarantined);
- E2. the endorser is in the authenticated device list and is itself trusted (a chain back to the self-trusted
  first device; cycles confer nothing); `sig` verifies with the endorser's `public_key`; `endorsed_key_fp`
  matches the endorsed device's listed `public_key` — else `ENDORSEMENT_INVALID`;
- E3. server-clock test (R5): the endorsed device's ES-01 `created_at` precedes the endorser's `revoked_at`
  (or the endorser has no `revoked_at`) — else void, `ENDORSEMENT_AFTER_REVOKE`. The file's `created_at`
  (endorser clock) is informational only and is never compared with `revoked_at`;
- E4. anchoring (the §5.4 rule-5 rule applied to endorsements): if the endorser has `revoked_at` and this
  reader first sees the endorsement after that `revoked_at`, the endorsement counts only when anchored —
  already in this reader's pinned/seen set before `revoked_at`, or the endorsed device is also endorsed by a
  non-revoked trusted device. Otherwise `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`.

A device without a counted endorsement is not trusted: it is not a recipient of new records or captures
(§4.1, ES-04 §4 step 4), its records are `CHECKPOINT_WRITER_UNKNOWN` (ES-04: `RESTORE_WRITER_UNKNOWN`), and
it is listed in the R6 notice so the user can endorse it on a trusted device after comparing fingerprints.
Effect on the round-2 attack: a revoked device B that registers D after its revoke fails E3; one that
registered D before its revoke and pushes a backdated endorsement later fails E4 on every reader that had not
already seen it (CK-11 (iv), WS-10 (e)).

Fresh-device bootstrap (e.g. C in CK-03): C has no pinned set, so its first trust decision is TOFU on the
registry list plus the endorsement chain from the self-trusted first device. Before pinning, C shows the user
the trusted set it computed (per device: name, os, server-clock `created_at`, fingerprint, endorsed by) and
asks the user to compare the fingerprints with `device list` on an already-trusted device; only after that
confirmation does C pin the set and use it. A compromised registry at C's first fetch is therefore caught only
by that comparison (stated limit, D-9).

## 6. Restore via `brain_context_resume` (`[DRAFT line 44]`; interface new)

Backward compatible: without the new input the tool behaves exactly as today
(`BrainMcpServer.ts:270-326`).

New optional input:
```
checkpoint?: { project_id?: string, checkpoint_id?: string,
               select?: "latest_head" | "list_heads" (default "list_heads" when forked, else "latest_head") }
```

Output additions (a new content block placed before the packed memory text, plus a metrics field):

```
[Checkpoint restore] id=<checkpoint_id> device=<device label> created=<ISO> lineage=linear|forked
[original sha256=<8 hex> turns=12-14] <raw text>            ← only M2 and hash verified
[summary — not original; 3 fragments, sha256=<…>] <text>   ← every summary/derived item
[decision] …  [constraint] …  [open] …  [evidence] commit:<sha> …
[unavailable] 2 fragments hash-only (no text stored)
```

metrics JSON gains `checkpoint: {id, verified: bool, lineage: "linear"|"forked", heads: [ids],
provenance_counts: {original, summary, unavailable}, pending_key: bool, device_list_fetched_at,
recipients_changed: bool, rejected: [{id, code}]}` (§5.4, §5.5 R6).

Rules: integrity and the §5.4 writer checks must pass or the record is not restored
(`CHECKPOINT_INTEGRITY_FAILED` / the §5.4 code); a forked
lineage with no explicit `checkpoint_id` returns only the head list (no context text) so the agent asks
the user; the checkpoint block is subject to the same `windowTokens` budget and is packed in the
`conversation_summary` slot (`ContextRestoreService.ts:44-58`), with `open_items` and `constraints`
required (never dropped before memory entries).

## 7. Writers (orchestrator side)

- Triggers: `compact` (alongside the existing `.context-snapshot.md` flow, devkit
  `hooks/post-compact-restore.sh`; for non-Claude CLIs through the orchestrator's `bin/context-compact.sh`
  on `origin/release/0.2.5`, §0.2 — per-CLI hook availability not measured, a CLI without one has no
  `compact` trigger), `session_end` (brain already installs `src/cli/hooks/session-end.sh`),
  `dispatch_report` (a worker's REPORT), `manual` (`aigentry checkpoint` CLI) and an optional
  `interval`.
- Which triggers upload automatically is a Rule 47 개인정보 전송 decision (ADR D-7), because every
  automatic trigger sends conversation-derived data off the device. Recommended default: after the
  separate checkpoint-upload opt-in, `manual` and `session_end` are on; `compact` and `dispatch_report` are
  off until the user enables them; `interval` is off.
- The writer is the CLI-side hook/agent calling `brain_checkpoint_write`; brain owns persistence. The
  orchestrator does not write into the brain repo directly.
- Existing `session_context` entries (`BrainContract.ts:899-923`) are untouched; an optional one-time
  import (run only on an explicit user command — a write into the user's repo, ADR D-4) creates one root checkpoint per project with every item marked `summary` and
  `trigger:"manual"`, `source_session.cli:"legacy"`.

## 8. Retention

| Class | Default | Mechanism |
|---|---|---|
| checkpoint (M1 content) | 90d after the record is no longer a lineage head; heads kept until superseded + 90d | expiry pass deletes the file from `HEAD` in a normal commit |
| raw fragment (M2) | 30d | the M2 writer stores raw text in a sibling `<seq>.raw.age` so it can expire independently of the M1 record |
| local index | rebuildable; no TTL | |

Deletion is from `HEAD` only; Git history and host-side copies remain until the user rewrites history.
This is disclosed in the opt-in text. Retention values are a Rule 47 privacy/retention decision (D-3 in
the ADR).

## 9. Schema versioning and migration

- `schema_version` integer, independent of the brain profile `CURRENT_SCHEMA_VERSION`
  (`SchemaMigration.ts:30`).
- Records are immutable, so migration is **on read** (pure upcast function vN→vN+1), never in-place
  rewrite. The integrity hash is always checked against the stored version's canonical bytes.
- A reader that sees `schema_version` greater than it supports returns the record as
  `unsupported_version` (headers only) and never rewrites or deletes it.
- Adding optional fields is a minor change (same version, readers ignore unknown fields — but unknown
  fields are inside the integrity hash, so they are preserved byte-exact).

## 10. ES-05 link (origin checkpoint)

The telesession ledger already has a field named `checkpoint` that means the **origin agent's read
cursor** (`aigentry-telesession-wt-1110` `docs/specs/2026-10-11-e2e-delivery-protocol.md:82`, `:116`).
To avoid a collision ES-02 ids are linked through a separate optional, immutable request-record field
`origin_checkpoint_id` (set at request creation from the origin session's latest checkpoint head), owned
and implemented by ES-05. ES-02 only guarantees that the id is stable and resolvable by the same user.

## 11. Error codes

`CHECKPOINT_IDENTITY_MISSING`, `CHECKPOINT_DEVICE_REVOKED`, `CHECKPOINT_REDACTION_UNAVAILABLE`,
`CHECKPOINT_ENCRYPTION_FAILED`, `CHECKPOINT_KEY_CONFLICT`, `CHECKPOINT_INTEGRITY_FAILED`,
`CHECKPOINT_USER_MISMATCH`, `CHECKPOINT_PENDING_KEY`, `CHECKPOINT_UNSUPPORTED_VERSION`,
`CHECKPOINT_FORKED_CHOICE_REQUIRED`, `CHECKPOINT_SYNC_LOCAL_ONLY` (informational),
`CHECKPOINT_SECRET_IN_IDENTIFIER`, `CHECKPOINT_PATH_MISMATCH`,
`CHECKPOINT_SIGNATURE_INVALID`, `CHECKPOINT_WRITER_UNKNOWN`, `CHECKPOINT_REVOKED_WRITER_UNANCHORED`;
endorsements (§5.6): `ENDORSEMENT_PATH_MISMATCH`, `ENDORSEMENT_INVALID`, `ENDORSEMENT_AFTER_REVOKE`,
`ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`.
`CHECKPOINT_DEVICE_REVOKED` is a reader-side rejection (§5.4); a cooperating writer may also refuse
early, but that is never the enforcement.

## 12. Acceptance criteria → test matrix

Every row is for the independent tester (ES-09). "Linux fixture" rows never count as cross-platform or
real-endpoint PASS (requirement line 52).

Columns: **Measures** = what a PASS of the row proves; **Does not measure** = what it does not prove;
**Runnable now** = `Linux fixture` (runs on the Linux host alone, with the local/stub dependencies named in
the row, once the implementation exists) or `BLOCKED`; **Blocked on** = the missing dependency. A BLOCKED
row is never reported as PASS (not as "skipped = pass", not by a Linux substitute). A Linux-fixture PASS
proves only its Measures column and is never a cross-platform or real-endpoint PASS (`[REQ line 52]`). No
row has been run; no implementation exists.
Every Linux-fixture row here uses a stub ES-01 identity (a local device list with generated keys), because
writes and reads require ES-01 (§5); none of them measures the real ES-01 integration.

| ID | Criterion (AC) | Setup | Expected | Measures | Does not measure | Runnable now | Blocked on |
|---|---|---|---|---|---|---|---|
| CK-01 | Two machines, same account: checkpoint and task version agree | devices A, B (same user, sync opt-in); A writes checkpoints with `task_refs`; B syncs | B lists the same `checkpoint_id`s with identical `content_sha256`; restored `task_refs[].task_version` equals ES-03's current version or is flagged stale; heads identical on A and B after both sync; after resume on B, `source_session` and `evidence[]` refs equal A's (requirement line 48 evidence-link agreement) | same ids, hashes, heads, `source_session`, evidence refs and task versions on two devices of one user | real Git-host latency; macOS/Windows; ES-03 server behaviour itself | BLOCKED | ES-01 (identity, device keys, device list — ES-02 §5.5); ES-03 task version |
| CK-02 | Incremental cursor | B already synced N records; A writes 3 more | B's pass decrypts exactly 3 new files (counted), `remote_commit` advances; with a shallow clone the `ls-tree` fallback yields the same set | cursor delta = exactly the new files; shallow-clone fallback yields the same set | performance on large brain repos; real Git host | Linux fixture (local bare remote, stub ES-01 list) | — |
| CK-03 | Third fresh device restore | C fresh install + ES-01 login/register; case (a) records written after C registered; case (b) older records with A online for rekey; case (c) older records with A/B offline | (a) restore succeeds once C is trusted (§5.5 R5); (b) succeeds after rekey sibling appears; (c) `CHECKPOINT_PENDING_KEY` listing rekey-capable devices — never empty context reported as success | fresh-device readability rules (a)/(b)/(c) and the honest `PENDING_KEY` report | real install on another OS (ES-06) | BLOCKED | ES-01 (registration, `age_recipient` R2, endorsement R5) |
| CK-04 | Other-account isolation | user U2 on device D2 obtains (by copy) U1's checkpoint file | decrypt fails or `CHECKPOINT_USER_MISMATCH`; U2's list/resume never shows U1 data; no enumeration of U1 project keys through any tool; a record U2 signs and pushes into U1's repo (U2 given push access) is rejected by U1's readers (`CHECKPOINT_WRITER_UNKNOWN`) | the three isolation barriers and reader-side rejection of a foreign writer | GitHub ACL behaviour of a real host; the real ES-01 list | logic variant: Linux fixture (stub ES-01 lists for U1 and U2, local bare remote); real-ES-01 variant: BLOCKED | real-ES-01 variant: ES-01 (two real users, authenticated list R3) |
| CK-05 | Secrets never in checkpoints | fixture transcript with synthetic PEM, age secret key, bearer token, `.env` lines; both modes; an `evidence` ref of kind `url` `https://u:synthpass@host/x?token=<synthetic>` and a `decisions[].evidence` URL with `access_token=<synthetic>`; a `source_session.project_id` whose URL path segment carries a synthetic token (survives credential stripping) | stored plaintext (decrypted by the tester) contains `[REDACTED:*]` and none of the fixture secrets (0 grep hits, also in brain logs and error output); the evidence URLs are stored without userinfo and query; the identifier case → `CHECKPOINT_SECRET_IN_IDENTIFIER`, no file written; scanner disabled → `CHECKPOINT_REDACTION_UNAVAILABLE`, no file written | the detector set catches the fixture secrets in every string field incl. refs and URLs; URL stripping; no matched text in logs; fail-closed when the scanner is missing | false-negative rate on real secrets (guarantee is "scanned with vN") | Linux fixture | — |
| CK-06 | Origin restart | kill the writer between seq fsync and file write; restart | next write uses seq+1 (gap allowed, reuse forbidden); no partial file committed; index rebuilds from tree | seq never reused, no partial commit after `kill -9`, index rebuild | power loss / file-system fsync guarantees | Linux fixture | — |
| CK-07 | Fork + user choice | A and B both resume from X offline, each writes; then sync | both heads visible on both devices; resume without id → `CHECKPOINT_FORKED_CHOICE_REQUIRED` + heads; choosing B's head writes next record with `parents:[B-head]`; A's head preserved | fork detection, head listing, explicit choice, no silent loss | a real partition between two hosts | Linux fixture (two local clones, stub ES-01 list) | real two-host variant: ES-01 |
| CK-08 | Original vs summary marking | M1 and M2 records | M1 restore contains no `[original …]` blocks; M2 marks `original` only when the hash verifies; tampered raw text → that fragment downgraded to `unavailable` and integrity failure reported | provenance marking original/summary/unavailable and tamper downgrade | faithfulness or quality of summaries | Linux fixture | — |
| CK-09 | Integrity | flip one byte of a decrypted-then-re-encrypted record; separately copy a valid signed record to another `project_key`/`session_ref`/`seq` path | `CHECKPOINT_INTEGRITY_FAILED`, record quarantined, other records restore; the copied record → `CHECKPOINT_PATH_MISMATCH`, never restored for the other project | integrity detection and quarantine; path ↔ record binding (§5.4 rule 2) | the signature path (CK-11) | Linux fixture | — |
| CK-10 | Encryption fail-closed | remove age key on writer | `CHECKPOINT_ENCRYPTION_FAILED`; no plaintext file in the repo tree or history | no plaintext fallback on encryption failure | other crypto failure modes (corrupt recipient list) | Linux fixture | — |
| CK-11 | Revoked device (reader-side) | revoke B in ES-01; A writes a new record; B (keeping its Git credential and a modified, non-cooperating client) pushes (i) a record with `created_at` after `revoked_at`, (ii) a record backdated before `revoked_at`, (iii) a record with a forged `device_id` = A, (iv) an endorsement by B, dated before `revoked_at`, of a device D registered in the registry (iv-a) after B's `revoked_at` and (iv-b) before it but never endorsed by a non-revoked device, plus a record signed by D; A and C sync | B is not a recipient of A's new record; A and C reject (i) `CHECKPOINT_DEVICE_REVOKED`, (ii) `CHECKPOINT_REVOKED_WRITER_UNANCHORED` (not restored without a user choice), (iii) `CHECKPOINT_SIGNATURE_INVALID`; (iv) the endorsement is void — (iv-a) `ENDORSEMENT_AFTER_REVOKE`, (iv-b) `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED` — so D is not trusted, not a recipient of A's next record, D's record is `CHECKPOINT_WRITER_UNKNOWN`, and D appears in the R6 notice; none appears as context; device list shows B `git_access: unknown` until the user confirms the credential rotation | reader-side rejection of post-revoke, backdated and forged writers and of backdated endorsements (§5.6 E3/E4) | revocation of the GitHub credential (user step, D-8); prevention of deletions (only detected); the real ES-01 revoke | logic variant: Linux fixture (stub ES-01 list with `created_at`/`revoked_at` set by the fixture, local bare remote, modified client for B); real-ES-01 variant: BLOCKED | real-ES-01 variant: ES-01 (revoke, `revoked_at` R3/R4) |
| CK-11b | Recipient change notice / trust | registry list gains device D that no trusted device endorsed | D is not a recipient and D's records are `CHECKPOINT_WRITER_UNKNOWN`; the notice (R6) is shown; after the user endorses D on A, new records include D | trust endorsement gate and recipient-change notice | a real compromised registry | BLOCKED | ES-01 (list R3, R5, notice R6); decision D-9 |
| CK-12 | Backward compatibility | call `brain_context_resume` without `checkpoint` | identical content items for identical state, compared with the current tool (`BrainMcpServer.ts:288-324`), including the setup hint it may prepend (`:313-321`) | default `brain_context_resume` output unchanged | other brain MCP tools | Linux fixture | — |
| CK-13 | Schema upcast | v1 record read by a v2 reader; v2 record read by a v1 reader | v2 reader upcasts without rewriting; v1 reader returns `unsupported_version`, file unchanged | on-read upcast; newer version left untouched | a real v2 schema (none exists) | Linux fixture | — |
| CK-14 | Non-claim wording | inspect restore text and CLI help | states "context restored from checkpoint; model/process state not restored" (N1/N2) | non-claim wording present | whether an agent behaves as if state were restored | Linux fixture | — |
| CK-15 | Retention | fast-clock fixture | expired non-head records removed from `HEAD`; heads kept; M2 raw sibling removed at 30d while M1 record stays | removal from `HEAD` per class | deletion from Git history or host GC | Linux fixture (fast clock) | — |
| CK-16 | `[REQ line 12]` No GUI / no cmux | cmux not installed, no GUI session (no `DISPLAY`/`WAYLAND_DISPLAY`); `manual` and `session_end` triggers via CLI/MCP on A; sync and `brain_context_resume` on B | same outcome as CK-01; the PASS evidence is only B's verified `checkpoint_id` + `content_sha256`; a log copy or an SSH-run file listing is not accepted as evidence | no GUI/cmux needed; only verified ids/hashes count as evidence | real two hosts; macOS/Windows terminals | Linux fixture (single host, two device dirs, stub ES-01 list) | real two-host variant: ES-01 |
| CK-17 | Recovery path commits checkpoints | a staged checkpoint file while `pull --rebase` fails and the merged profile entries equal the remote (`PushPullManager.ts:142-146`) | the checkpoint file is committed by its own commit and pushed; `sync_state` reaches `pushed`; no checkpoint file left staged-only | checkpoint commit survives the `entriesEqual` recovery branch | other recovery paths of brain sync | Linux fixture (local bare remote) | — |
| CK-18 | `[REQ line 50]` Duplicate write / replay | the same record written twice; identical bytes replayed after a partition | no new file, no new commit, the same `checkpoint_id` returned; different bytes at the same path still → `CHECKPOINT_KEY_CONFLICT` | duplicate write / replay is an idempotent no-op | concurrent writers on two hosts | Linux fixture | — |
| CK-19 | Written ≠ synced | push fails (remote unreachable), later succeeds | `sync_state` stays `committed`; output says "saved on this device", never "saved for your other devices"; after the push `pushed` and only then the second wording | `sync_state` and the wording "saved for your other devices" only at `pushed` | whether another device has read it (not observable, never claimed) | Linux fixture (local bare remote made unreachable) | — |
