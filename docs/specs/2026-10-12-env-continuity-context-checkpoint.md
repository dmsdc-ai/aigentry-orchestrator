# SPEC — ES-02 context checkpoint, incremental sync and restore (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-12). No code. Not an implementation, merge, release or
  install claim (Rule 45 §2, Rule 50 §2).
- Parent: task #2026101204 "동일 계정으로 다른 머신에서 개발 작업 이어가기"; requirement doc
  `state/specs/2026-10-12-environment-sharing-release-requirements.md` acceptance criterion 2 (line 39)
  and verification matrix (lines 48–52); build-plan draft
  `state/draft/2026-10-12-environment-sharing-build-plan-proposal.md` §3 ES-02 (lines 41–45).
- Owners (proposal): aigentry-brain (record store, sync, restore) + orchestrator (checkpoint triggers).
- Depends on: ES-01 (stable `user_id` / `device_id`, device list, revoke; signing key, age recipient
  and trust model per §5.5) and the ES-03 §5.1 lease keeper (sign and list operations). Trust, recipients,
  revocation, anchors and pushes follow the interface invariants I1–I12 of
  `docs/specs/2026-10-13-env-continuity-interface-invariants.md` (shared with ES-01 and ES-04). Feeds: ES-05 (origin
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
| Sibling ES-01 spec answers this spec's R1–R7 in its §8.1 (signed `age_recipient`, keyed device list incl. revoked devices, server-clock `created_at`/`revoked_at`, endorsement validity rule, reader-side enforcement for brain-Git data, `aigfp1:` 128-bit fingerprint in row FP); per-row citations in §5.5 | `aigentry-orchestrator-wt-1204-idq` @ `83b2766` `docs/specs/2026-10-12-env-continuity-identity.md` §8.1 (R1–R7, FP) |
| Brain has **two** push paths: P1 `GitBackend.push` (`push -u origin main`), reached from `PushPullManager.enqueuePush` (AutoCommitter, pull-failure recovery, the `brain_sync_push` MCP tool, `SyncLifecycle.schedulePush` after write tools) and from the TOFU recipient sync after every pull; P2 `aigentry-brain sync --tick`, which runs `git add -A`, `commit`, `pull --rebase` and `git push origin main` through `execFileSync`, bypassing `GitBackend`. Neither pushes `refs/aigentry/*`. Full call-site table: interface invariants doc §A.1 | `GitBackend.ts:86`, `:162-166`, `:186-191`; `PushPullManager.ts:153`, `:161-168`; `AutoCommitter.ts:39`, `:56`; `BootstrapOrchestrator.ts:39-42`; `SyncLifecycle.ts:120-125`; `braincli.ts:375-377`; `SyncTick.ts:148-173`; `SeamlessSetup.ts:60` |
| Brain's ignore list is the repo's own tracked `.gitignore`, written once at init and only appended to when an entry's substring is absent; a pulled commit that tracks an ignored path overwrites the local file, and a pulled `.gitignore` edit makes an ignored path committable by `git add .` (re-run 2026-10-13 on git 2.43.0); files under `git rev-parse --git-path aigentry` are reached by neither. Details: interface invariants doc §A.3 | `GitBackend.ts:55`, `:58-78`, `:72`, `:178`; `SyncTick.ts:148` |
| Brain's hook installer can recommend a global `core.hooksPath`, under which a repo-local `pre-push` hook is not run | `src/cli/hooks/index.ts:53` |
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
  local-only (`sync:"local_only"`). The opt-in alone is not enough: **checkpoint upload stays disabled, and the
  rekey pass does not run, until brain runs the pre-push gate on every push path** (BR-1, BR-2 of the interface
  invariants doc; I10 (iv)) **and keeps its security state in the Git directory with one writer** (BR-5, BR-6). Until then every record is `sync:"local_only"` with reason `push_gate_missing`, and the
  opt-in text says so. The binding of the brain repo's GitHub account to the ES-01 identity
  (§5.2, D-5) and the writer checks (§5.4) are new proposals too.
- N5. `[REQ line 12]` `[DRAFT line 9, 27]` Works from any terminal on the telepty daemon; no GUI typing,
  no cmux dependency; a copied log file or an SSH connection alone never claims completion. New proposal (needs
  review), applied here:
  triggers, write, sync and restore are invoked only through CLI commands, CLI hooks, brain MCP tools or
  telepty daemon APIs; nothing types into a GUI, reads a cmux pane or scrapes a screen. The only evidence
  that a checkpoint was written/synced/restored is the reader-verified `checkpoint_id` + `content_sha256`
  (§2, §6); a log line, a copied file or a command run over SSH is not evidence.
- N6. `[REQ line 49]` is **not met for brain memory** by this spec. Brain's memory-profile recipients are a union that
  never shrinks (`ProfileFormat.ts:256-277`), so a revoked device keeps decrypting new memory writes. ES-02 and
  ES-04 change this only for checkpoints and captures. The fix is a brain-side task or an ES-01 follow-up (interface
  invariants doc BR-4), raised to the orchestrator.

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
| `seq` | int ≥ 1 | monotonic per `(device_id, session_ref)`; persisted locally with fsync **before** the record is written; never reused. The counter lives **outside** the brain repo, in `~/.aigentry/brain/checkpoint-seq.json` (next to brain's `last-boot-error.json`, `BootErrorStore.ts:15`), so deleting or re-cloning the repo (which deletes `<aig>`, §4.1) does not reset it; the next value is one more than the maximum of that counter and every `seq` of this `(device_id, session_ref)` in `HEAD` and in the outbox. It is a high-water mark, not security state (gaps allowed) |
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
  `fragments[].summary`, `fragments[].raw`), refs (`evidence[].ref`, `task_refs`) and
  metadata (`source_session.*`, any other string) — **before** integrity, signing and encryption. brain has
  none today (`capture-tool.ts:38-56` is an argument allowlist) — this is new work.
- URL-shaped values (`evidence[]` of kind `url`/`pr`, URLs inside `decisions[].evidence` and other refs)
  have userinfo (`user:pass@`), the query string and the fragment stripped by default, before the scan;
  keeping them is a per-ref user choice recorded in the ref (`keep_query: true`), and the kept part is still
  scanned.
- A hit in free text or a ref is redacted as below. A hit in a key-forming identifier (`user_id`,
  `device_id`, `checkpoint_id`, `source_session.session_ref`/`project_id`) cannot be redacted without breaking
  the key, so the write is refused (`CHECKPOINT_SECRET_IN_IDENTIFIER`, field and detector named only).
- Lineage and hash fields are identifiers too: `parents[]`, `resumed_from`, `workspace_capture_id`,
  `evidence[].sha256` and `fragments[].sha256`. Redacting one would silently break lineage or verification.
  Each is format-validated before the scan (the `checkpoint_id` / ES-04 `capture_id` grammar, or 64 lowercase
  hex), and a detector hit in one refuses the write with the same code.
- Remedy for an identifier refusal: when the hit is in a `project_id` derived from the remote URL, the
  writer offers the documented fallback, the folder-name hash (`BrainMcpServer.ts:732`), and uses it only
  after the user confirms. The lineage under the old `project_key` is not continued; the user is told so. Any
  other identifier hit is reported with the field and detector, and the user must fix the source value.
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
<aig> = $(git rev-parse --path-format=absolute --git-common-dir)/aigentry   run in the brain repo; inside its Git directory, the same from every linked work tree (interface invariants §B.1); never in the work tree
  checkpoint-index.json                local only (rebuildable cache: cursor + heads, §4.2)
  trust-state.json, trust-state.lock   local only (security state, never rebuilt; one writer, §4.2, invariant I3)
  checkpoint-outbox/                   local only (`written` records before the pre-push gate, §5.4)
```

The local-only files are in the Git directory, not in the work tree behind `.gitignore`: brain's ignore list is a
tracked, synced file, so a pulled commit could overwrite an ignored file or make it committable (§0.1; interface
invariants doc §A.3, BR-5). No pull, checkout or `git add` reaches `<aig>`. Brain never reads security state from a
work-tree path. After every pull, a tracked path under `.aigentry/`, or a tracked symlink at or under `checkpoints/`
or `trust/` or at `memory-profile.enc.json`, is reported as `CHECKPOINT_REPO_TAMPERED` (commit and path; R6-style
notice). The file is not read, not followed and not deleted (deleting it would be a write into the user's repo).
While such a symlink is in `HEAD` or the work tree the gate holds checkpoint pushes (§5.4 step 5). A pull that git
refuses because a pulled commit holds an invalid path (a tree entry under `.git/`) is reported with the same code,
"pull refused: invalid path in `<commit>`" (BR-5; §5.3 known limit). Deleting or re-cloning the brain repo
deletes `<aig>`: the device is then a fresh device (§4.2, I3).

- `user_key`, `project_key` = sha256(...)[:16] of `user_id` / `project_id` (no raw URLs in paths).
  These are unkeyed: for a public repo a dictionary of remote URLs reverses `project_key`; `device_id`,
  `session_ref` and commit timing are visible too. A keyed hash would need a per-user secret shared by all
  devices, which does not exist (device keys are per device, §5.5). This metadata exposure is therefore
  stated in the checkpoint-upload opt-in text (D-7).
- File body = age ciphertext (existing `encryptBlock`, `AgeCrypto.ts`) of the canonical record.
  Recipients = the recipient set `R` of §5.6 (interface invariant I5: trusted, active, confirmed, and
  `age_recipient_sig` verified against the pinned `public_key`).
- **No plaintext fallback.** Unlike `ProfileFormat.writeToFile` (`ProfileFormat.ts:160-181`), an
  encryption failure aborts the write (`CHECKPOINT_ENCRYPTION_FAILED`).
- Records are immutable once `pushed` (§5.1). Writers never modify or delete a checkpoint file in place; the
  only exception is the pre-push gate, which replaces the age wrapper of a record that has never left the device
  (§5.4). A path that already
  exists with an **identical decrypted `content_sha256`** (duplicate write, replay after a partition; the ciphertext
  bytes differ because age encryption is randomized) is an idempotent no-op: no
  new file, no commit, the existing id is returned. A path that already exists with a different `content_sha256` is an integrity incident (`CHECKPOINT_KEY_CONFLICT`), the new
  record is written as `<seq>.<content_sha256[:8]>.ckpt.age` and both are surfaced at restore.
- Why not brain entries: entries live inside one rewritten file (`ProfileFormat.ts:140-182`) and are
  merged by LWW (`ConflictResolver.ts:49-51`), which would silently drop a concurrent device's
  checkpoint. Unique append-only paths make `pull --rebase` (`GitBackend.ts:83`) conflict-free for
  checkpoints by construction.

### 4.2 Incremental cursor

Local, per device, never synced. Two files in `<aig>` (§4.1), with different durability (interface invariant I3):

```
<aig>/checkpoint-index.json   (cache; rebuildable from the tree)
{ "v": 1, "remote_commit": "<sha of origin/main last scanned>",
  "heads": { "<project_key>/<lineage root>": [ids] } }

<aig>/trust-state.json        (security state; never rebuilt from the repo or the registry; brain is its only writer)
{ "v": 1,
  "observed": { "<repo path>": { "blob": "<git blob id>", "first_seen_by": "<server ISO>" | null } },
  "seen": { "<repo path>": { "checkpoint_id", "sha256": "<content_sha256>", "blob",
            "state": "accepted" | "provisional" | "pending_key" | "unrecoverable_key" | "<code>_UNANCHORED" | "DEMOTED:<code>" | "QUARANTINED:<reason>",
            "restored_at"?: "<ISO>" } },
  "anchors": [ { "device_id", "fp", "kind": "self" | "root" | "local", "first_seen_by" } ],
  "pinned": { "<device_id>": { "public_key", "fp", "created_at", "revoked_at", "age_recipient", "age_recipient_seq", "first_seen_by" } },
  "endorsements": { "<trust/… path>": { "blob", "state" } },
  "reference_confirmations": [ "<checkpoint_id or capture_id the user confirmed for push, I9>" ],
  "rekeyed_for": [ { "device_id", "age_recipient_seq" } ],   (recipients the rekey pass has completed for, §5.3)
  "notices": [ { "kind": "added" | "key_change" | "revoked" | "registry_fault" | "repo_tampered", "device_id"?, "age_recipient_seq"?, "age_recipient"?, "path"?, "shown_at": "<ISO>" | null } ],
  "recipients": [ { "device_id", "age_recipient" } ],
  "device_list": { "server_time": "<of the last successful fetch>", "fetched_at": "<local>" } }
```

`first_seen_by` is a server-clock upper bound on when this reader first observed an item. It is the
`server_time` of the first successful device-list fetch (ES-01 §8.1 R6: every list response carries
`server_time`) that **started after** the item was in the local tree. `null` = not yet confirmed by such a
fetch (`provisional`, invariant I7). The writer clock is never used for it (I2). It is recorded **per path and Git
blob id at observation** (`observed`), before decryption, and it belongs to that file only (invariant I6):
- A record that is `pending_key` when first seen keeps that file's early bound if **the same file** later decrypts.
- A rekey sibling (`<seq>.rekey-<n>.ckpt.age`, §5.3), a conflict sibling or any other path that decrypts to the same
  `checkpoint_id` is observed and bound in its own right, and inherits nothing from the original path. A reader that
  could not decrypt the original cannot know whether the sibling holds the same content, so a backdated sibling
  forged by a revoked writer is judged by its own (late) bound.
- A path whose blob changes does not inherit it.

`seen` is therefore keyed by file. A record's state is the best state among the files that decrypt to its
`checkpoint_id` with the same `content_sha256`, each judged with its own bound. A file that decrypts to a known
`checkpoint_id` with a different `content_sha256` is `CHECKPOINT_KEY_CONFLICT` (§4.1), and that file is surfaced
with its own state. Records, endorsements, pins and anchors take `first_seen_by` from there (§5.4 rule 5, §5.6 E4).
Cost, accepted under D-8: a reader that saw a later-revoked writer's record only as ciphertext before the revoke
treats the rekeyed copy as `CHECKPOINT_REVOKED_WRITER_UNANCHORED`, the same as a fresh device does.

`trust-state.json` has **one writer, brain** (invariant I12; BR-6). Every write — recording observations after a
pull, the trust refresh (§5.4), the gate, `aigentry-brain trust bootstrap`, anchor recovery, P2 if it runs the gate —
is a read-modify-write under the trust-state lock `<aig>/trust-state.lock`, committed atomically (tmp → fsync →
rename, as ES-04 §6.3 does for its journal). Lock order: the repo lock (BR-1) before the trust-state lock, never the
reverse. Crash recovery never rebuilds it. If it is missing or fails to parse, the device behaves as a fresh device (I3): the §5.6
bootstrap confirmation again, every `first_seen_by` from the next fresh list, and no item accepted before that. Only
`checkpoint-index.json` is rebuilt from the tree (CK-06). ES-04 reads the trust graph (`anchors`, `pinned`,
`endorsements`), `recipients` and `seen` from this file, only after a trust refresh it requested, and never keeps its
own or writes this file (ES-04 §4 step 5, §6.1).

Sync step (after the existing `pull`):
1. Fast path: `git diff --name-only <remote_commit>..HEAD -- checkpoints/ trust/`.
2. If `remote_commit` is unknown to the repo (shallow clone `--depth 1`, `GitBackend.ts:30`, or history
   rewrite), fall back to a full `git ls-tree -r HEAD checkpoints/ trust/` and diff it against `observed`.
   Every new path or changed blob is added to `observed` with `first_seen_by: null`, under the trust-state lock.
3. Run the trust refresh (§5.4; the list through the keeper, invariant I12). It holds the trust-state lock from before
   its fetch starts, so every `observed` entry that is still `null` was observed before the fetch started, and the
   fetch's `server_time` becomes its `first_seen_by`. If the fetch fails, those entries stay `null` and their items
   `provisional`.

New paths are decrypted, integrity- and signature-verified (§5.4), added to `seen`, and lineage heads are
recomputed over `accepted` and `provisional` records only.
- A record that fails decryption is `pending_key` in `seen` (that file's `observed` bound is kept for that file only)
  and is retried on the next pass. What it reports is computed from the fresh list only (§5.3).
- A record that fails integrity is quarantined (state `QUARANTINED:<reason>`) and reported, never restored.

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
| Pre-push recipient gate + outbox, on **every** push path (interface invariant I10; brain requirements BR-1..BR-3 there) | in front of P1 `GitBackend.push` (`GitBackend.ts:186-191`), which covers every caller of `enqueuePush` and the TOFU push (`:162-166`), **and** P2 `SyncTick.ts:173` (`sync --tick`), which either calls the same gate or refuses to push while `origin/main..HEAD` adds or modifies a path under `checkpoints/`; startup check that moves committed-but-unpushed and uncommitted checkpoint files back to the outbox; one cross-process repo lock held by the gate and by every path that stages, commits or resets (`AutoCommitter.ts:38`, `:55`, recovery, TOFU commit, P2 if kept), because brain has none today (only the in-process `inFlight` flag, `AutoCommitter.ts:7`, `:31-32`); outbox, index and trust state in `<aig>` (§4.1), not in the ignore list (`:58-78`), BR-5. A repo-local `pre-push` hook is optional and never counted, because a global `core.hooksPath` (`hooks/index.ts:53`) disables it | §5.4: no push sends a checkpoint encrypted to a non-recipient; hold when the list is unavailable. **Until this exists on P1 and P2, checkpoint upload stays disabled** (`sync: "local_only"`, reason `push_gate_missing`) (CK-20) |
| `aigentry-brain trust refresh` CLI + one trust-state lock (interface invariants BR-6); tamper check after every pull (BR-5) | new, next to `trust bootstrap` (§5.6) | ES-04's gate and preview need a refreshed trust state they cannot write themselves (I3, I9); four processes write the trust state (§4.2) |
| Keeper client: `sign`, `public_key`, `device_list` through the devkit lease keeper | new `src/checkpoint/`; local socket protocol of ES-03 §5.1 | brain never reads the ES-01 key store (invariant I12) |
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
A write requires: ES-01 identity present (`user_id`, `device_id`, device `active`) and the lease keeper's
`sign` operation available (ES-03 §5.1; interface invariant I12; brain never reads the key store), else
`CHECKPOINT_IDENTITY_MISSING`. Remote sync additionally requires brain sync opt-in (`enableSync`), **and** the
separate checkpoint-upload opt-in (N4, ADR D-7), **and** the pre-push gate on every brain push path (I10 (iv), §4.4).
Otherwise the record is written **local-only** and flagged `sync:"local_only"` with the missing condition as reason.
Scanner and encryption must also be available.

Written ≠ synced (the checkpoint analogue of "accepted ≠ completed"). The local index records per record
`sync_state ∈ written` (file fsynced in the local outbox) `→ committed` (moved into `checkpoints/` and
committed by the pre-push gate, §5.4) `→ pushed` (the push succeeded and a fetch of `origin/main` contains the
commit). A trigger or CLI may say "saved on this
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
- Records written **before** are readable only after any active device re-wraps them, by the background rekey
  pass (an automatic write into the user's repo, covered by ADR D-4 (b)). The pass follows invariant I10 like
  any other writer:
  - It runs only right after a fresh list (§4.2 step 3) in which R holds a recipient `(device_id,
    age_recipient_seq)` of a device other than this one that is not in the trust state's persisted `rekeyed_for` set,
    and only on records that are `accepted` on this device. A new recipient and a rotation of an existing one (a new
    `age_recipient_seq`, which enters R only once shown, §5.6 "Recipient") both qualify, so a device that lost and
    regenerated its age key (`AgeCrypto.ts:54-77`) gets its older records re-wrapped too. It never
    rekeys a provisional, unanchored, demoted, quarantined or `pending_key` record. It writes one sibling per record,
    whatever the number of new recipients (the gate wraps it to the whole R). Once every sibling is in the outbox, the
    new `(device_id, age_recipient_seq)` pairs are added to `rekeyed_for` (trust-state lock). A crash or keeper outage before that leaves them out,
    so the next fresh list runs the pass again. After a trust-state loss (I3) the pass runs again for every device
    (stated cost: duplicate siblings, each an idempotent copy).
  - It writes the unchanged signed record as a sibling `<seq>.rekey-<n>.ckpt.age` (file-name grammar §5.4 rule 2)
    into the outbox `<aig>/checkpoint-outbox/`, state `written`, never into `checkpoints/` and never modifying the
    original. `<n>` is assigned by the gate at step 5, after the pull (§5.4).
  - Only `.ckpt.age` records are rekeyed. M2 raw siblings (`.raw.age`, §8) never are, so a device that was not a
    recipient of a raw sibling sees those fragments as `unavailable` (§6) for good.
  - The sibling reaches `origin` only through the pre-push gate (§5.4), which re-wraps it to R of the gate's own
    fresh list (step 4) and commits it (step 5). Gate step 3 does not apply to it: it carries an already accepted
    record and adds no reference.
  - While checkpoint upload is disabled (`push_gate_missing`, §5.4) the pass does not run.
  - On a reader, a sibling is judged with its own `first_seen_by` (§4.2), never the original path's.

- **What a reader reports for a file it cannot decrypt** is computed only from its fresh list and its own key
  (interface invariant I11). Age stanzas do not name recipients and no recipient list is stored, so the reader cannot
  know which devices hold the record. The possible holders `H` are the devices other than this one that the fresh
  list (or a pin, for a device missing from it) shows as **not revoked**, `active` or `expired`: ES-01 lets an
  `expired` device re-bind with the same `device_id` and key (ES-01 §5, ID-7), so it may still hold and rekey the
  record; only `revoked` is final (ES-01 §8.1 R4):
  - `H` empty → `CHECKPOINT_UNRECOVERABLE_KEY` (interface non-claim N-U1), never `pending_key` and never success,
    with its message: no device can open it, now or later; a device that already opened it keeps its copy; this
    device continues from here. The file keeps this code (`seen` state `unrecoverable_key`); a device registered later
    does not reopen it, because it could receive the record only from a non-revoked holder, and there was none;
  - otherwise → `CHECKPOINT_PENDING_KEY`, listing the devices of `H`, with the text "this device is not a recipient
    of `<n>` saved items. They become readable here only if one of `<devices>` holds them and re-wraps them for this
    device. A device that holds them does so at one of its syncs once it has checkpoint upload enabled, is active and
    counts this device as a recipient (also after this device's key changed). This device cannot tell whether any of
    them holds them; if none does, they stay unreadable here." For each `expired` device it adds "`<name>` is signed
    out; they may become readable after it logs in again (`aigentry-devkit login`)". It never says the items will
    become readable, and it may stay so for good (e.g. when the only holder reports them as unrecoverable itself,
    CK-03 (e));
  - without a fresh list → `pending_key`, labelled with `device list as of <fetched_at>`.

  The "third device restores the same work" test (CK-03) therefore requires either an online existing device that
  holds the records or a checkpoint written after registration; the test must record which. A cleartext recipient
  list per file, which would make the unrecoverable case computable on more readers, is not added (ADR §3).
- Revoked devices: excluded from recipients of new records; records they sign after `revoked_at` are
  rejected by every reader (§5.4); past ciphertexts stay decryptable by a revoked device that kept a copy
  (crypto cannot revoke the past).
- **Known limit (S1 Git storage).** ES-01 revoke does not remove the revoked machine's access to the brain
  repo: that access is the user's GitHub credential on that machine (`gh` / git credential,
  `SetupWizard.ts:156-213`), outside aigentry's control. Until the user revokes or rotates that credential,
  the revoked device can still pull every ciphertext (and decrypt every record written before the revoke),
  read the plaintext path metadata and commit timing (§4.1), and push commits. Pushed records are rejected
  by readers (§5.4); deleting or overwriting files is an availability attack that readers detect (paths in
  `seen` disappear outside a retention pass and are reported) but cannot prevent. The same holds for a pushed
  commit whose tree holds an invalid path (an entry under `.git/`): git refuses to check it out, every later pull and
  brain's recovery fail again, and sync stops on every reader (`CHECKPOINT_REPO_TAMPERED` "pull refused: invalid path
  in `<commit>`", §4.1) until the user repairs the remote. The revoke flow therefore
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
   a file name of the grammar `<seq:08d>` [`.<content_sha256[:8]>`] [`.rekey-<n>`] (`.ckpt.age` | `.raw.age`):
   an optional conflict tag (the 8 hex must match the record, §4.1), then an optional rekey tag (§5.3; only before
   `.ckpt.age`, raw siblings are never rekeyed), then the record or the M2 raw sibling (§8). So a rekey of a conflict record is `<seq>.<sha8>.rekey-<n>.ckpt.age`, and
   the raw sibling of a conflict record is `<seq>.<sha8>.raw.age`. Any other name gives `CHECKPOINT_PATH_MISMATCH`
   (quarantined), so a
   valid signed record copied to another project/session/seq path is never restored there;
3. the Ed25519 signature verifies with that device's signing key (`CHECKPOINT_SIGNATURE_INVALID`,
   quarantined);
4. `user_id` equals the logged-in user (`CHECKPOINT_USER_MISMATCH`, §5.2);
5. revocation (interface invariants I2, I6): if the device has `revoked_at`, a record with `created_at ≥ revoked_at`
   is rejected (`CHECKPOINT_DEVICE_REVOKED`). That is the only use of the writer clock, and it can only reject.
   `created_at` is the writer's clock and a revoked device can backdate it, so a record with
   `created_at < revoked_at` is accepted only when anchored: the `first_seen_by` on this reader (§4.2, server
   clock) of the **file it was decrypted from** is earlier than `revoked_at`. No other file's bound counts (a rekey or
   conflict sibling has its own, §4.2; invariant I6). A `null` (provisional) `first_seen_by` never anchors. **No reference
   anchors**: being listed in `parents`, `resumed_from` or `workspace_capture_id` of any record, accepted or not,
   confers nothing. An unanchored record is `CHECKPOINT_REVOKED_WRITER_UNANCHORED`: listed with device and time,
   never restored as context without an explicit user choice. That choice is local to this reader. It changes the
   record's state on no other device, and a continuation written from it is held at this device's pre-push gate
   until the user confirms the push (I9). ES-01 `expired` (idle expiry) is not revoked; its signatures stay valid.

Rejection happens on the reader, not at the remote: anyone with push access to the brain repo (a revoked
device that kept its Git credential, or another account given access) can add files, but no reader
accepts them. The reader caches the device list with `fetched_at`; offline it uses the cache, and the
restore output shows `device_list_fetched_at` so a revoke newer than the cache is visibly not yet applied.

**Stale-cache window (invariant I7).** Items observed while no list fetch has succeeded since are `provisional`
(§4.2).
- A provisional record whose writer is already a confirmed trusted, non-revoked device in the cache may be
  listed and restored. The restore output labels it `provisional (device list as of <fetched_at>)`.
- A provisional endorsement counts for nothing: it neither adds a trusted device nor a recipient.
- A provisional item never anchors (rule 5, §5.6 E4), and a record that references it is held at the gate (I9).

**Trust refresh (invariants I3, I12; brain requirement BR-6).** The list is fetched only as part of a trust refresh,
run by brain alone: in the sync pass (§4.2 step 3), at gate step 1, in restore, and on demand through the new
`aigentry-brain trust refresh` CLI subcommand (same family as `trust bootstrap`, §5.6), which ES-04 calls (ES-04 §4
step 5, §6.1). A refresh takes the trust-state lock before its fetch starts, runs the re-evaluation below, records
new R6 notices (`shown_at: null`), computes `T` and `R`, stores `recipients` and `device_list`, writes the trust state
and releases the lock. **Shown** (interface invariants §B.1, I5): only the CLI subcommands (`trust refresh`, `trust
bootstrap`, the endorse command), and only when their stderr is a terminal (`isatty(2)`), print the notices whose
`shown_at` is null and set `shown_at` in the same write; for a shown addition or rotation they also set the pinned
`age_recipient` and `age_recipient_seq`. The refreshes of the sync pass, the gate and P2 have no terminal and set
nothing. A brain MCP tool result is not a display either (it reaches the agent session, which may not show it, and
under N-U4 may have caused the change): every MCP tool result carries the text of each notice whose `shown_at` is null,
with "run `aigentry-brain trust refresh` in a terminal to review; checkpoint and capture uploads are held until then".
The CLI prints `{"server_time": "<S(L)>", "aig": "<absolute <aig> path>"}` on success and exits non-zero otherwise.

**Re-evaluation on every list refresh (invariant I8).** Each trust refresh whose fetch succeeds does the following, in
order, under the trust-state lock:
1. Gives every `observed` entry with `first_seen_by: null` this fetch's `server_time` (§4.2).
2. Recomputes the trusted and recipient sets (§5.6).
3. Re-checks rule 2, rule 5 and §5.6 E3/E4:
   - for every device whose `revoked_at` is new to this reader, on **all** of its records and endorsements (so a
     record first seen before the revoke but dated ≥ `revoked_at` is rejected here as on a fresh reader);
   - for every device that **left the trusted set** without a revoke, on **all** of its records and endorsements.
     Its records fall to `CHECKPOINT_WRITER_UNKNOWN`.

An item that now fails is **demoted, not deleted**:
- Its index state becomes `DEMOTED:<code>` with the code it would get now: `CHECKPOINT_REVOKED_WRITER_UNANCHORED`,
  `CHECKPOINT_DEVICE_REVOKED`, `CHECKPOINT_WRITER_UNKNOWN`, `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED` or
  `ENDORSEMENT_AFTER_REVOKE`.
- The file is untouched. The record leaves the lineage heads. It is never restored as context again without an
  explicit user choice.
- If it was already restored (`restored_at`), the next CLI/MCP interaction and the restore metrics (`demoted`,
  §6) say "restored at `<restored_at>` under device list as of `<fetched_at>`, since demoted: `<code>`". Text
  that is already in a session cannot be recalled; the notice is the remedy.

A device whose only counted endorsement is demoted leaves the trusted set and the recipient set (R6 notice).
The recomputation cascades to the devices it endorsed and to their records.

Writer side: at write time the record is encrypted to the cached recipient set. The write output and
`brain_checkpoint_write` result show `recipients as of <fetched_at>`; a cache older than 24 h (proposal) adds a
warning. That encryption is provisional: the gate re-wraps every record to the current set before any push (step 4
below), so no record of earlier recipients is kept.

**Pre-push recipient gate (invariants I9, I10).** The gate is the only way a checkpoint file reaches `origin`. It
runs in front of **every** push of the brain repo, on both measured paths: P1 `GitBackend.push`
(`GitBackend.ts:186-191`) with all its callers, and P2 `sync --tick` (`SyncTick.ts:173`). That includes brain's own
profile pushes, because a push sends all unpushed history. A path that cannot run it refuses to push while
`origin/main..HEAD` adds or modifies a path under `checkpoints/` (§4.4, brain requirement BR-1). It runs after the `pull --rebase` succeeded,
so `HEAD` descends from `origin/main`. **Until P1 and P2 both run it, and BR-5/BR-6 exist, checkpoint upload is disabled
and the rekey pass does not run**: records stay `sync: "local_only"` with reason `push_gate_missing` (I10 (iv)).

Every checkpoint file is first written to the outbox `<aig>/checkpoint-outbox/<same relative path>` in the Git
directory (§4.1; state `written`): new records, rekey siblings (§5.3) and the one-time import (§7). No writer creates
a file under `checkpoints/` except gate step 5. Brain's `git add .` (`GitBackend.ts:177-184`) and `git add -A`
(`SyncTick.ts:148`) therefore cannot sweep them into a commit, whatever a pulled `.gitignore` says (CK-27 (b)). A
checkpoint file that is not on `origin/main` (added or modified: `git diff --name-only --diff-filter=d
origin/main..HEAD -- checkpoints/`; a retention deletion is not one) is under `checkpoints/`, in the work tree or a
local commit, **only during a gated push attempt** (I10 (i)). The gate holds the repo lock (§4.4, BR-1) from step 1 to
the end of step 5, so no `AutoCommitter` commit, pull or recovery reset runs in between:
1. Run the trust refresh above (the list through the keeper). Current recipients = R (§5.6). If a recipient change is
   unshown (a trusted active device whose verified `age_recipient` differs from its pin, or has none, with its notice
   `shown_at: null`; I5), or a symlink is at or under `checkpoints/` or `trust/` in `HEAD` or the work tree (§4.1,
   BR-5), **hold**: step 2 still runs, steps 3–5 do not, no checkpoint file enters a commit, the outbox stays
   `written`, the profile is pushed, and the
   output says `CHECKPOINT_PUSH_HELD: saved on this device; RECIPIENT_CHANGE_UNSHOWN — run aigentry-brain trust
   refresh in a terminal` (or `REPO_TAMPERED: symlink <path>`). Otherwise drop from the outbox
   every rekey sibling whose record is no longer `accepted` on this device (the original record is untouched).
2. Startup / leftover check: if `origin/main..HEAD` adds or modifies a path under `checkpoints/` (a crash inside an earlier attempt), rebuild
   the range: `git reset --soft origin/main`, as brain's recovery already does (`GitBackend.ts:217-219`); move the
   range's `checkpoints/` files back to the outbox; commit what remains staged (the profile) as one commit. The old
   commits become unreachable and are never pushed, because a push sends only reachable objects. Any uncommitted file
   under `checkpoints/` that is not on `origin/main` (a crash between step 5's move and its commit) is moved back to
   the outbox too. Brain also runs this check at start-up, before any commit or push path (BR-2).
3. Reference check (I9), for new records only (a rekey sibling carries an already accepted record and adds no
   reference): an outbox record whose `parents`, `resumed_from` or `workspace_capture_id` names an item that is
   not `accepted` on this device is **held** (`CHECKPOINT_REFERENCE_HELD`, stays `written`). The item may be
   provisional, `*_UNANCHORED` (even after an explicit-choice restore), demoted, quarantined or unknown. The hold is
   released when the item becomes accepted, or when the user confirms after the disclosure "this continuation
   contains content from `<id>`, which your devices do not accept (`<code>`); it will be pushed under this device's
   signature. Other devices will still not accept `<id>`." The confirmation is recorded per referenced item
   (`reference_confirmations`, §4.2) and never changes that item's state anywhere (rule 5). Records this device
   wrote itself are accepted on it. For `workspace_capture_id` brain does not read ES-04's state: it counts as
   accepted only when it names a capture this device wrote (`wsc_<this device_id>_<seq>`, ES-04 §2). Any other capture
   is treated as unknown and the record is held.
4. Re-wrap every remaining outbox file, new record or rekey sibling, to R. The canonical record and its signature are unchanged; only the age
   wrapper of a file that has never left the device is replaced (§4.1: immutability starts at `pushed`).
5. Assign each rekey sibling's `<n>`: one more than the highest `<n>` of that record's siblings in `HEAD` and in the
   outbox. Never overwrite a path that exists: a path that exists with an equal decrypted `content_sha256` makes the
   sibling a no-op (dropped); otherwise take the next `<n>`. Move the records into `checkpoints/` with `commitPaths`
   (§4.4), creating and opening every path component without following symlinks (`lstat` / `O_NOFOLLOW`; a symlink
   found there aborts the attempt as a failure below); state `committed`. Push; on success the state becomes `pushed` (§5.1). If another rekeyer pushed the same
   `<n>` first, the push is rejected or its pull conflicts; that is a failure as below, and the retry picks a new `<n>`. On failure, rebuild the range as in step 2 and return the files to the outbox
   (`written`); the profile commits are kept and retried by brain's own retry.

If the list fetch in step 1 fails, the default is **hold** (ADR D-8 (b), pending user decision; decision bundle 2g
default "hold"):
- No checkpoint file enters a commit. The rest (the profile) is pushed.
- The output says `CHECKPOINT_PUSH_HELD: saved on this device; device list unavailable since <fetched_at>`.
- Pushing with the cached set instead is a per-user opt-in under D-8 (b), because it may send data to a device
  revoked after `fetched_at`.

Because every writer uses the outbox and only step 5 moves files out of it, a push path that bypasses the gate (P2 on
a brain version without BR-1, or the user's own `git push`) finds no unpushed checkpoint file in `origin/main..HEAD`
or in the work tree, except after a crash and before the next start-up check. That residual window is covered by
BR-2 and tested by CK-20 (f) and CK-24 (b).

A record already `pushed` stays readable by a device revoked later. That is the past-ciphertext limit of §5.3.
ES-04 applies the same gate to capture refs (ES-04 §4 step 5); brain never pushes `refs/aigentry/*` (§0.1).

Anchoring cost: a fresh device has no `observed` set, so **every** legitimate pre-revoke record of a revoked device
reads `CHECKPOINT_REVOKED_WRITER_UNANCHORED` there and needs an explicit user choice to restore. References no longer
reduce this (I6). The usable continuation is the records that non-revoked devices wrote; they are accepted directly.
This cost is accepted and listed under D-8 (pending user decision). A signed "seen-set" attestation by a trusted
device is a possible later mitigation, not proposed now.

### 5.5 Requirements on ES-01 (sibling spec `docs/specs/2026-10-12-env-continuity-identity.md`, read-only)
The "ES-01 spec today" column is a finding (§0.1), re-read at sibling commit `638daee` (`aigentry-orchestrator-wt-1204-idq`; `6d4759a` changed only the revoke-semantics row, `83b2766` adds `age_recipient_seq`, `638daee` changes only the R5 wording on `expired` holders)
and cited by section only, because the reconciliation cycles of 2026-10-13 edit both sets together. ES-01 answers R1–R7 in
its §8.1. Every row is now also an obligation in the interface invariants doc
(`docs/specs/2026-10-13-env-continuity-interface-invariants.md`, I1–I12); where this table and that doc differ, the doc wins.

| # | ES-02/ES-04 needs | ES-01 spec today (`638daee`) | Requirement on ES-01 |
|---|---|---|---|
| R1 | per-device signing key, used without key bytes leaving the store | met: Ed25519 key pair per device, private half never leaves (ES-01 §2, §3.1 `public_key`, §6); §8.1 R1 and ES-03 §5.1 "Identity operations" define `sign(prefix, payload)` with the three-prefix allowlist and `SIGN_PREFIX_REFUSED`, `public_key()` / `fingerprint()`, `register_age_recipient`, `device_list()` and `device_me()`, and name brain and the ES-04 CLI as callers (ES-01 ID-23) | invariant I12: the lease keeper (ES-03 §5.1) offers `sign(prefix, payload)` with the allowlist `aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|`, `aigentry-endorsement-v1\|` and refuses every other prefix; `public_key()` / `fingerprint()`; `device_list()` and `device_me()`; brain and the ES-04 CLI are named callers and start it on demand. ES-01's own `aigentry-device-v1\|` and `aigentry-age-recipient-v1\|` are signed only inside the keeper (§4) |
| R2 | per-device age recipient | met: `age_recipient`, `age_recipient_sig` over `"aigentry-age-recipient-v1\|" + hex(public_key) + "\|" + age_recipient_seq + "\|" + age_recipient`, `age_recipient_seq` (rotation counter; the registry refuses a value not greater than the stored one, 409), `age_recipient_set_at` (§3.1); set at `/devices/authorize` or `PUT /devices/me/age-recipient` (§8, §8.1 R2), signed only by the keeper's `register_age_recipient`; the registry refuses a recipient whose signature does not verify (§8, 422; ES-01 ID-21). The signature binds `public_key`, not `device_id` (no id exists when the device signs) | add `age_recipient` (X25519) per device, registered at `/devices/authorize` together with an Ed25519 signature over it by the device key, so the registry cannot substitute it without breaking the signature; rotation = a new signed value. The signature only helps if it is checked: under invariant I5 a writer uses a device's `age_recipient` only when the signature verifies against the device's **pinned** `public_key`, and ES-01 refuses to store a recipient whose signature does not verify (defence in depth). Key material (new proposal, needs review): the `age_recipient` is the device's **existing** brain age key pair (`~/.config/sops/age/keys.txt`, `AgeCrypto.ts:24`, created mode 0600 by `ensureKeyFile` `:55-77`), not new key material — brain already needs that identity to decrypt the memory profile, and a second X25519 key held by the same OS user adds no isolation. ES-01 records this proposal as its finding C6 and makes no claim that the age private half meets its §6 key store (§8.1 R2); whether to move the brain key into that store is ES-01's decision (D-ID-2 (b), recommended: not in this release), coordinated, not decided here |
| R3 | authenticated device list with keys and revoke time | met: `GET /devices?include=keys&all=true` (device bearer only) returns `id, name, os, status, created_at, revoked_at, public_key, age_recipient, age_recipient_sig, age_recipient_set_at`, revoked and expired devices, and `server_time` (§8, §8.1 R3) | list also returns `public_key`, `age_recipient` + its signature, `revoked_at`, and includes revoked devices for verification (CLI `--all` exists, §9); served only to the owner's device bearer (§7.1) |
| R4 | trustworthy revoke time | met: `created_at` and `revoked_at` are server clock, set once, never moved; an `expired` re-bind keeps `created_at`; idle expiry is not a revoke (`revoked_reason` excludes it) (§3.1, §8.1 R4); revoked rows keep `created_at` for the account's life (ES-01 §10 D-ID-5) | `revoked_at` is server-clock, set once, never cleared or moved; re-login of a revoked device creates a new `device_id`; the list also exposes each device's server-clock `created_at`, set once and never moved (the §5.6 E3 endorsement test depends on it) |
| R5 | key-directory trust model | met on the ES-01 side: same model; fingerprint per ES-01 §8.1 row FP (`aigfp1:`, first 128 bits of `SHA-256("aigentry-device-fingerprint-v1\|" ‖ public_key)`; the earlier 8-byte form is withdrawn), with `fingerprint_local` / `fingerprint_server` and exit 6 `KEY_MISMATCH`; pinned-value changes surfaced as registry faults, and the endorsement validity rule in the wording used here; the trust anchor is left to ES-02 §5.6 under D-9 (§8.1 R5); endorsement file, storage and D-9 left to ES-02. The canonical **signed** form of the fingerprint (`aigfp1:` + 32 lowercase hex, no dashes) is added by this cycle (ES-01 FP; ES-01/03 round 2, non-blocking 13) | stated model: the registry is the key directory and is trusted for membership; a compromised registry could add a device key and become a recipient of new records. Mitigation: each client pins the device set (id + key fingerprints) it last trusted; a device is **trusted** when it is in the registry list **and** carries a valid endorsement signed by an already-trusted device (trust starts from each reader's local anchor set — its own device, the user's first device by earliest server-clock `created_at`, and user-confirmed recovery anchors, §5.6; "trusted" for chain evaluation is not "recipient"); the endorsement is a small signed file in the brain repo (§5.6) written when the user confirms the new device on any trusted device after comparing the fingerprint. For that comparison and for trust-anchor recovery, `device list` on each device shows its **own** fingerprint computed from its local key, not only the registry's value (coordination C10). **Endorsement validity, using ES-01 timestamps:** an endorsement is valid only if the endorsed device's server-clock `created_at` **precedes** the endorser's `revoked_at` (or the endorser has no `revoked_at`). An endorsement by a device dated after that device's `revoked_at` is void. Revoking a device does not revoke the devices it endorsed. The endorsement's own `created_at` is the endorser's clock and is never used for this test; the §5.4 rule-5 anchoring applies to endorsements too (§5.6 E3–E4). Whether endorsement is required (recommended) or the registry list alone suffices is decision D-9 (pending user decision; decision bundle 2h default "endorsement required") |
| R6 | user-visible recipient-change notice | met on the ES-01 side: additions, key changes and revokes are observable in the list with `name`, `os`, `created_at`, fingerprints and `server_time`; showing the notice is ES-02's job (§8.1 R6); `server_time` also feeds `first_seen_by` (§4.2) | any addition, key change or revoke in the pinned set is shown to the user (device name, os, created_at, fingerprints) on a terminal (§5.4 trust refresh, "Shown"; MCP results and the restore metrics `recipients_changed` carry it until then) before the new set is used for writes, and checkpoint and capture pushes are held until it is (I5); removals take effect immediately |
| R7 | revoke enforcement for Git-stored data | met: brain-Git-stored checkpoints and captures are "not a registry resource; readers verify the writer against the device list" (§7.2, §7.3, §8.1 R7) | enforcement is the reader-side rule of §5.4; no further change asked of ES-01 |

### 5.6 Endorsement file and reader rules (R5; new proposal, needs review — decision D-9)

```
trust/v1/<user_key>/<endorsed_device_id>/<endorser_device_id>.endorse.json
{ "schema": "aigentry-endorsement", "schema_version": 1, "endorsed_device_id", "endorsed_key_fp",
  "endorser_device_id", "created_at", "sig" }
```

`sig` = the endorser's ES-01 device key, through the keeper's `sign` operation (invariant I12), over
`"aigentry-endorsement-v1|" + user_id + "|" + endorsed_device_id + "|" + endorsed_key_fp + "|" + endorser_device_id`;
`endorsed_key_fp` is the ES-01 fingerprint of the endorsed device's `public_key` in its canonical signed form
(`aigfp1:` + 32 lowercase hex, no dashes; ES-01 §8.1 FP). The file is signed, not encrypted (ids and a fingerprint only; `user_id` is bound by the
signature, not stored). Endorsements are append-only like records (§4.1).

**Three different sets.** On each reader:
- *Trusted* = the devices reachable from this reader's anchor set (below) over counted endorsements. This is the
  set used for chain evaluation (E2) and writer verification (§5.4 rule 2). A revoked device can stay trusted as a
  chain node: its endorsements then count only through E3/E4, and its records are accepted only through §5.4
  rule 5.
- *Recipient* (invariant I5) = trusted **and** ES-01 `status: active` **and** confirmed (not learned only under a
  stale list, I7) **and** its `age_recipient_sig` verifies with its **pinned** `public_key` over
  `"aigentry-age-recipient-v1|" + hex(public_key) + "|" + age_recipient_seq + "|" + age_recipient` **and** its
  `age_recipient_seq` is not lower than the highest one this device has verified for it, pinned or in a notice (lower,
  or equal with a different `age_recipient`, is a replayed older value: registry fault) **and** its `age_recipient`
  equals the **pinned** value. The pin is set or changed only when the addition or the validly signed rotation is
  shown on a terminal (bootstrap confirmation or §5.4 "Shown"). While a trusted active device has a verified
  `age_recipient` that differs from its pin, or has none, and its notice is unshown, the gate holds every checkpoint
  push (§5.4 step 1) and ES-04 every capture push (`RECIPIENT_CHANGE_UNSHOWN`); a change is never used, and never
  silently left out, before a user has seen it. An `expired` device that re-binds with its pinned recipient is not a
  change. On a signature failure
  the device is not a recipient and an R6 registry-fault notice is shown. This device always uses its own local age
  public key, never the registry's value for it; a differing registry value is a registry fault. Only recipients
  receive new records and captures.
- *Accepted writer* = a trusted device whose record passes §5.4 rules 1–5.

**Anchor set (per reader, local, never synced).**
- (a) The reader's own device.
- (b) The root: the user's first device (earliest server-clock `created_at` in the list, revoked or not), pinned
  at bootstrap.
- (c) User-confirmed local anchors (trust-anchor recovery, below).

Nothing in the repo or the registry adds an anchor. The trusted set is the least fixpoint from the anchors (a
graph walk), so cycles confer nothing.

A reader counts an endorsement only if all hold:
- E1. path binding: the path's `user_key` is the logged-in user's and its two device ids equal the file's
  fields — else `ENDORSEMENT_PATH_MISMATCH` (quarantined);
- E2. the endorser is in the authenticated device list and is trusted on this reader (reachable from its anchor
  set; a revoked endorser is a chain node only through E3/E4); `sig` verifies with the endorser's `public_key`;
  `endorsed_key_fp` matches the endorsed device's listed `public_key` — else `ENDORSEMENT_INVALID`;
- E3. server-clock test (R5): the endorsed device's ES-01 `created_at` precedes the endorser's `revoked_at`
  (or the endorser has no `revoked_at`) — else void, `ENDORSEMENT_AFTER_REVOKE`. The file's `created_at`
  (endorser clock) is informational only and is never compared with `revoked_at`;
- E4. anchoring (the §5.4 rule-5 rule applied to endorsements, invariant I6): if the endorser has `revoked_at`, the
  endorsement counts only when its `first_seen_by` on this reader (§4.2, server clock; `null` never anchors) is
  earlier than that `revoked_at`. Otherwise `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`. (The earlier second clause,
  "the endorsed device is also endorsed by a non-revoked trusted device", is removed: such a device is trusted
  through that other endorsement anyway, so the clause added nothing but a second path to reason about.)

  The check is repeated on each list refresh (§5.4 re-evaluation). Cost (same as §5.4
  anchoring, D-8): "revoking a device does not revoke the devices it endorsed" holds on readers that had
  already counted the endorsement. On a fresh device, a device endorsed only by a since-revoked device is
  trusted only after one of two things: a non-revoked trusted device endorses it (re-endorsement prompt,
  below), or the fresh device goes through trust-anchor recovery when invariant I11 allows it (below).

A device without a counted endorsement is not trusted: it is not a recipient of new records or captures
(§4.1, ES-04 §4 step 4), its records are `CHECKPOINT_WRITER_UNKNOWN` (ES-04: `RESTORE_WRITER_UNKNOWN`), and
it is listed in the R6 notice so the user can endorse it on a trusted device after comparing fingerprints.
That comparison is a step of the user interface, not something the keeper enforces: any same-uid process,
including an unconfined agent CLI, can have the keeper sign an endorsement (interface non-claim N-U4). The help
text of the endorse command says so.
Effect on the round-2 attack: a revoked device B that registers D after its revoke fails E3; one that
registered D before its revoke and pushes a backdated endorsement later fails E4 on every reader that had not
already seen it (CK-11 (iv), WS-10 (e)).

Fresh-device bootstrap (e.g. C in CK-03): C has no pinned set. Its first trust decision is therefore TOFU on the
registry list plus the endorsement chain from its anchor set (its own device and the root).
- Before pinning, C shows the user the trusted set it computed (per device: name, os, server-clock `created_at`,
  fingerprint, `age_recipient_seq`, endorsed by). The fingerprint comparison covers device keys only; a registry
  that serves an older, validly signed `age_recipient` to a fresh device is not caught by it (interface non-claim
  N-U3).
- It asks the user to compare the fingerprints with the value an already-trusted device computes from its own
  local key. Only after that confirmation does C pin the set and use it.
- A compromised registry at C's first fetch is therefore caught only by that comparison (stated limit, D-9;
  interface non-claim N-U3).
- Whether C then goes to trust-anchor recovery is decided only by the trigger below (invariant I11).
- Brain runs the bootstrap in its first sync pass, and on demand through a new `aigentry-brain trust bootstrap` CLI
  subcommand (new proposal). ES-04, which only reads the trust state, points the user to that command
  (`RESTORE_TRUST_STATE_MISSING`, ES-04 §6.1). Like every trust-state write, the bootstrap runs under the trust-state
  lock (§4.2).

**Trust-anchor recovery (D-9, invariant I11).** Example: fresh device C, where the first device A is revoked and
every chain runs through A.

*Trigger.* A reader raises `TRUST_ANCHOR_REQUIRED` only when all three hold:
1. a device-list fetch succeeded in this pass (a fresh list);
2. its trusted set contains no active device other than itself;
3. the list shows at least one active device other than itself whose server-clock `created_at` is **earlier** than
   its own (an older candidate).

When the trigger does not fire, there is no anchor prompt:
- *Newcomer side.* A user's very first device has no other device. A single-device user's existing device A sees a
  newly registered D as *newer*, so D appears in A's normal R6 endorsement prompt. The same holds for any trusted
  device that is older than every untrusted active device: such devices are endorsed (R6), not anchored. On D
  itself, the root A is trusted and active, so condition 2 fails and D waits for A's endorsement (CK-11b).
- *Lone survivor.* When no active device other than the reader exists (the user's other devices are all revoked,
  expired or lost, e.g. the only device A, also the root, was revoked and fresh C is installed), there is no prompt.
  The reader proceeds as the only active trusted device. A record it cannot decrypt is `CHECKPOINT_UNRECOVERABLE_KEY`
  only when every other device is revoked; while an `expired` (or unrevoked lost) device exists it is
  `CHECKPOINT_PENDING_KEY` with the re-login hint (§5.3; interface invariant I11, non-claim N-U1). An `expired` older
  device that logs in again becomes an active candidate, and the trigger above then fires. Later fresh devices
  anchor on this one through the trigger above.

*Steps*, when the trigger fires (C in the example). C does not stop at `CHECKPOINT_WRITER_UNKNOWN`:
1. C reports `TRUST_ANCHOR_REQUIRED` and lists only the older active candidates (name, os, server-clock
   `created_at`, fingerprint).
2. The user picks one, say B, and compares the fingerprint C shows with the one B computes from its **own local
   key**. B's copy of the registry list is not used for this, because a compromised registry would control both
   sides (ES-01 coordination C10).
3. The user confirms on C. B becomes a local anchor on C, pinned with its `first_seen_by` (§4.2).

Trust then propagates from B as usual:
- B's records are accepted on C.
- B's endorsement of C, written on B when the user confirmed C there, makes C a recipient of B's new records.
- B's older records reach C by B's rekey pass (§5.3).

This is the same TOFU limit as the bootstrap, accepted under D-9. A local anchor is never synced and confers
nothing on other readers. Adding a local anchor outside the trigger is not offered (I4).

**After a root revoke the cost is permanent.** The root is the earliest server-clock `created_at`, revoked or not,
and ES-01 keeps revoked rows for the account's life (D-ID-5). So every later fresh device whose only chains run
through the revoked root anchors once, for as long as the account exists. Re-endorsement among the remaining devices
does not end this. This is stated so that D-9 is an informed choice.

**Re-endorsement prompt (R6).** When the R6 notice shows the revoke of a device X, each trusted active device
lists the active devices whose every counted chain on that device runs through X. It then prompts the user to
endorse them again on that device after a fingerprint comparison. A fresh device then reaches them over a
non-revoked edge (E2), as long as it reaches the endorsing device.

When X is the root, re-endorsement among the remaining devices creates no path from a fresh device's anchors,
because cycles confer nothing. Fresh devices then use trust-anchor recovery.

### 5.7 Trust and revocation invariants (new proposal, needs review — D-8, D-9)

The trust/revocation model is defined **once**, in the interface invariants doc
`docs/specs/2026-10-13-env-continuity-interface-invariants.md` (I1–I12), which ES-01 and ES-04 cite as well. The
earlier T1–T11 list is replaced by it, so the two spec sets cannot drift apart. An implementation or a later change
that breaks an invariant is a defect, even if the individual rules still read as satisfied. ES-04 captures obey the
same invariants with the `RESTORE_*` / `CAPTURE_*` codes (ES-04 §4, §6.1).

| Invariant | Where ES-02 implements it | ES-02 test rows | Replaces |
|---|---|---|---|
| I1 per user | §5.4 rule 4, §5.6 E1 | CK-04, CK-21 (d) | T11 |
| I2 server clock only (writer clock never accepts or anchors; it may only reject) | §5.4 rule 5, §5.6 E3, §4.2 | CK-11 (iv-a) | T6 |
| I3 pins monotone; one durable trust state in the Git directory, one writer, never rebuilt | §4.1, §4.2 `<aig>/trust-state.json`, §5.4 trust refresh, §8 | CK-06, CK-21 (c), CK-27 | T10 |
| I4 trust = fixpoint from anchors over E1–E4; references confer nothing | §5.6 | CK-11 (iv), CK-21 (d)(e) | T1, T2 |
| I5 recipient incl. verified `age_recipient_sig` and `age_recipient_seq`; pin changes only when shown on a terminal; unshown change holds the push | §4.1, §5.4 trust refresh and gate step 1, §5.6 "Recipient" | CK-21 (f), (f4), CK-21 (a), CK-11b | T3 |
| I6 acceptance under revocation, per-file `first_seen_by`, no reference anchoring | §4.2, §5.4 rule 5, §5.6 E4 | CK-11 (ii), (vi-c), CK-23 | T5 |
| I7 stale cache | §5.4 "Stale-cache window" | CK-11 (vi) before refresh | T7 |
| I8 re-evaluation and demotion (incl. a device that left the trusted set) | §5.4 "Re-evaluation" | CK-11 (vi) after refresh, (vii), CK-25 | T8 |
| I9 references do not travel unaccepted | §5.4 gate steps 1, 3 | CK-11 (vi-c), CK-26, CK-24 (e) | — (new) |
| I10 every push gated, rekey siblings included; outbox in the Git directory; repo lock; no-follow moves; upload and rekey disabled until P1 and P2 run the gate and BR-5/BR-6 exist | §4.1, §4.4, §5.3 rekey pass, §5.4 gate | CK-20 (a)–(f), CK-24, CK-27 (b), (d) | T4 |
| I11 recovery scoped; key-state codes computable from non-revoked holders `H` (N-U1), `UNRECOVERABLE` sticky; rekey per `(device_id, age_recipient_seq)`; root revoke permanent | §5.3, §5.6 trigger | CK-03 (c)–(g), CK-21 (b)(g), CK-11 (v), CK-24 (h) | T9 |
| I12 keeper is the only signer and list fetcher; brain the only trust-state writer | §5.1, §4.4, §4.2, §5.4 trust refresh | CK-22, CK-27 (c) | — (new) |

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
provenance_counts: {original, summary, unavailable}, pending_key: bool, unrecoverable: [ids], device_list_fetched_at,
recipients_changed: bool, rejected: [{id, code}], provisional: bool, demoted: [{id, code, restored_at?}]}`
(§5.4, §5.5 R6).

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
  off until the user enables them; `interval` is off. Whatever is chosen, no trigger uploads anything until brain
  runs the pre-push gate on every push path (N4, I10 (iv)): before that, every trigger writes `sync:"local_only"`
  records with reason `push_gate_missing`.
- The writer is the CLI-side hook/agent calling `brain_checkpoint_write`; brain owns persistence. The
  orchestrator does not write into the brain repo directly.
- Existing `session_context` entries (`BrainContract.ts:899-923`) are untouched; an optional one-time
  import (run only on an explicit user command — a write into the user's repo, ADR D-4; written to the outbox and pushed only by the gate, §5.4) creates one root checkpoint per project with every item marked `summary` and
  `trigger:"manual"`, `source_session.cli:"legacy"`. The import signs content it did not author: the memory profile
  has no writer authentication and its recipients never shrink (N6), so a revoked device may have written it. Before
  the import the user sees "this imports text from brain memory, which is not authenticated per device; it will be
  signed by this device and accepted on your other devices" and confirms per project (an I9-style disclosure).

## 8. Retention

| Class | Default | Mechanism |
|---|---|---|
| checkpoint (M1 content) | 90d after the record is no longer a lineage head; heads kept until superseded + 90d | expiry pass deletes the file from `HEAD` in a normal commit, under the repo lock (BR-1). The commit holds only deletions, which the gate and BR-1/BR-2 do not treat as leftovers (§5.4 "added or modified") |
| raw fragment (M2) | 30d | the M2 writer stores raw text in a sibling `<seq>.raw.age` so it can expire independently of the M1 record |
| local index (`<aig>/checkpoint-index.json`) | rebuildable cache; no TTL | rebuilt from the tree |
| trust state (`<aig>/trust-state.json`) | never rebuilt (invariant I3); no TTL. If lost or corrupt, the device behaves as a fresh device: bootstrap confirmation again, `first_seen_by` from the next fresh list (so it anchors less) | atomic write (tmp → fsync → rename) under the trust-state lock (§4.2) |

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
`CHECKPOINT_SIGNATURE_INVALID`, `CHECKPOINT_WRITER_UNKNOWN`, `CHECKPOINT_REVOKED_WRITER_UNANCHORED`,
`CHECKPOINT_PUSH_HELD` (informational; reasons: list unavailable, `RECIPIENT_CHANGE_UNSHOWN`, `REPO_TAMPERED`, §5.4 step 1), `CHECKPOINT_REFERENCE_HELD` (informational, §5.4 gate step 3),
`CHECKPOINT_UNRECOVERABLE_KEY` (§5.3, interface non-claim N-U1), `CHECKPOINT_REPO_TAMPERED` (§4.1, a pulled tracked
path under `.aigentry/`, a tracked symlink at or under `checkpoints/` / `trust/` or at `memory-profile.enc.json`, or a pull refused for an invalid path; never read);
endorsements (§5.6): `ENDORSEMENT_PATH_MISMATCH`, `ENDORSEMENT_INVALID`, `ENDORSEMENT_AFTER_REVOKE`,
`ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`, `TRUST_ANCHOR_REQUIRED`.
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
| CK-03 | Third fresh device restore | C fresh install + ES-01 login/register; case (a) records written after C registered; case (b) older records with A online for rekey; case (c) older records with A/B offline; case (d) first device A revoked before C registers, B endorsed only by A; case (e) lone survivor: A is the user's only device (and the root), A's records are encrypted to A only, A is revoked, fresh C is installed; then a further fresh device E; case (f) active non-recipient peer: A and B active, A's record r encrypted to {A} only (written before B was trusted, never rekeyed), A revoked, fresh C; case (g) expired peer: root A and Mac B, records encrypted to {A, B}; B idle-`expired` (stub list `status: expired`, not revoked), A revoked, fresh C; then B re-binds with the same `device_id` and key (`aigentry-devkit login`); control: B revoked instead of expired | (a) restore succeeds once C is trusted (§5.5 R5); (b) succeeds after rekey sibling appears; (c) `CHECKPOINT_PENDING_KEY` listing the active devices other than C, with the §5.3 text "this device cannot tell whether any of them can" and no promise that the records will become readable — never empty context reported as success; (d) C reports `TRUST_ANCHOR_REQUIRED` (never empty context as success); after the user pins B as a local anchor on C (fingerprint compared with B's locally computed value, §5.6), B's records restore on C (new ones directly, older ones after B's rekey) and C is a recipient of B's next record; (e) C raises **no** `TRUST_ANCHOR_REQUIRED` (no active candidate); A's records are `CHECKPOINT_UNRECOVERABLE_KEY` with the N-U1 message (never `pending_key`, never empty context as success), listed in `unrecoverable`; C's own new records restore; E raises `TRUST_ANCHOR_REQUIRED` listing only C; after E anchors on C, A's records on E are `CHECKPOINT_PENDING_KEY` listing C with the "cannot tell" text (E cannot compute that C holds them as unrecoverable), never `CHECKPOINT_UNRECOVERABLE_KEY`, never success, never a promise; on C, A's records stay `CHECKPOINT_UNRECOVERABLE_KEY` after E registers (sticky, never turned into `PENDING_KEY`); (f) on C, r is `CHECKPOINT_PENDING_KEY` listing B with the same text, and it stays so after B syncs (B never held r); (g) before B re-binds: on C no `TRUST_ANCHOR_REQUIRED` (no active candidate), the records are `CHECKPOINT_PENDING_KEY` listing B with the re-login hint, never `CHECKPOINT_UNRECOVERABLE_KEY`; after B re-binds: C reports `TRUST_ANCHOR_REQUIRED` listing B; after the anchor and B's rekey pass the records restore on C; control: `CHECKPOINT_UNRECOVERABLE_KEY` with the N-U1 message | fresh-device readability rules (a)/(b)/(c), the honest `PENDING_KEY` report, trust-anchor recovery after the root is revoked (d), the lone-survivor outcome (e) and its stickiness, that every key-state code is computed only from the reader's fresh list (e on E, f), and that an `expired` peer is a possible holder, never grounds for `UNRECOVERABLE_KEY` (g) (invariant I11, non-claim N-U1) | real install on another OS (ES-06) | BLOCKED | ES-01 (registration, `age_recipient` R2, endorsement R5); (b) and the older-record part of (d) also brain BR-1/BR-2 (the rekey pass runs only with upload enabled, §5.3) |
| CK-04 | Other-account isolation | user U2 on device D2 obtains (by copy) U1's checkpoint file | decrypt fails or `CHECKPOINT_USER_MISMATCH`; U2's list/resume never shows U1 data; no enumeration of U1 project keys through any tool; a record U2 signs and pushes into U1's repo (U2 given push access) is rejected by U1's readers (`CHECKPOINT_WRITER_UNKNOWN`) | the three isolation barriers and reader-side rejection of a foreign writer | GitHub ACL behaviour of a real host; the real ES-01 list | logic variant: Linux fixture (stub ES-01 lists for U1 and U2, local bare remote); real-ES-01 variant: BLOCKED | real-ES-01 variant: ES-01 (two real users, authenticated list R3) |
| CK-05 | Secrets never in checkpoints | fixture transcript with synthetic PEM, age secret key, bearer token, `.env` lines; both modes; an `evidence` ref of kind `url` `https://u:synthpass@host/x?token=<synthetic>` and a `decisions[].evidence` URL with `access_token=<synthetic>`; a `source_session.project_id` whose URL path segment carries a synthetic token (survives credential stripping) | stored plaintext (decrypted by the tester) contains `[REDACTED:*]` and none of the fixture secrets (0 grep hits, also in brain logs and error output); the evidence URLs are stored without userinfo and query; the identifier case → `CHECKPOINT_SECRET_IN_IDENTIFIER`, no file written; after the user confirms the folder-name fallback, the record is written under the fallback `project_key`; a synthetic token placed in `parents[0]` and one in `evidence[].sha256` → refused with `CHECKPOINT_SECRET_IN_IDENTIFIER`, never `[REDACTED:*]`; scanner disabled → `CHECKPOINT_REDACTION_UNAVAILABLE`, no file written | the detector set catches the fixture secrets in every string field incl. refs and URLs; URL stripping; no matched text in logs; fail-closed when the scanner is missing | false-negative rate on real secrets (guarantee is "scanned with vN") | Linux fixture | — |
| CK-06 | Origin restart | kill the writer between seq fsync and file write; restart. Separately: `kill -9` during a `<aig>/trust-state.json` write; and a variant with `<aig>/trust-state.json` deleted; and a variant where the brain repo is deleted and re-cloned while the session keeps writing | next write uses seq+1 (gap allowed, reuse forbidden), also after the re-clone (the counter in `~/.aigentry/brain/checkpoint-seq.json` survives it, §2); no partial file committed; `checkpoint-index.json` rebuilds from tree; `trust-state.json` is the old or the new version, never partial, and its pins, anchors and `observed` `first_seen_by` values equal those before the kill; deleted variant: the device behaves as a fresh device (bootstrap confirmation shown, no record accepted before the next successful list fetch, earlier `first_seen_by` not reused) | seq never reused, no partial commit after `kill -9`, index rebuild, trust state never partial and never rebuilt (invariant I3) | power loss / file-system fsync guarantees | Linux fixture | — |
| CK-07 | Fork + user choice | A and B both resume from X offline, each writes; then sync | both heads visible on both devices; resume without id → `CHECKPOINT_FORKED_CHOICE_REQUIRED` + heads; choosing B's head writes next record with `parents:[B-head]`; A's head preserved | fork detection, head listing, explicit choice, no silent loss | a real partition between two hosts | Linux fixture (two local clones, stub ES-01 list) | real two-host variant: ES-01 |
| CK-08 | Original vs summary marking | M1 and M2 records | M1 restore contains no `[original …]` blocks; M2 marks `original` only when the hash verifies; tampered raw text → that fragment downgraded to `unavailable` and integrity failure reported | provenance marking original/summary/unavailable and tamper downgrade | faithfulness or quality of summaries | Linux fixture | — |
| CK-09 | Integrity | flip one byte of a decrypted-then-re-encrypted record; separately copy a valid signed record to another `project_key`/`session_ref`/`seq` path | `CHECKPOINT_INTEGRITY_FAILED`, record quarantined, other records restore; the copied record → `CHECKPOINT_PATH_MISMATCH`, never restored for the other project; file names `<seq>.<sha8>.rekey-1.ckpt.age` and `<seq>.<sha8>.raw.age` (matching sha8) are accepted, and `<seq>.rekey-1.<sha8>.ckpt.age` → `CHECKPOINT_PATH_MISMATCH` | integrity detection and quarantine; path ↔ record binding (§5.4 rule 2) | the signature path (CK-11) | Linux fixture | — |
| CK-10 | Encryption fail-closed | remove age key on writer | `CHECKPOINT_ENCRYPTION_FAILED`; no plaintext file in the repo tree or history | no plaintext fallback on encryption failure | other crypto failure modes (corrupt recipient list) | Linux fixture | — |
| CK-11 | Revoked device (reader-side) | revoke B in ES-01; A writes a new record; B (keeping its Git credential and a modified, non-cooperating client) pushes (i) a record with `created_at` after `revoked_at`, (ii) a record backdated before `revoked_at`, (iii) a record with a forged `device_id` = A, (iv) an endorsement by B, dated before `revoked_at`, of a device D registered in the registry (iv-a) after B's `revoked_at` and (iv-b) before it but never endorsed by a non-revoked device, plus a record signed by D; A and C sync; (v) separately: root A revoked, B endorsed only by A (counted on B before the revoke), fresh C with stub keys; (vi) stale-cache window: reader C last fetched the list before B's revoke at T and the stub registry is then unreachable; after T, B pushes (vi-a) a record backdated before T and (vi-b) a backdated endorsement of D (registered before T) plus a record by D; C pulls, restores (vi-a), then the registry becomes reachable and C refreshes; control: a record of B that C confirmed with a fetch before T; (vi-c) continuing (vi-a): after the restore C writes c1 with `resumed_from` and `parents` = (vi-a), then the registry becomes reachable and C syncs; variant: the user restores a `CHECKPOINT_REVOKED_WRITER_UNANCHORED` record by explicit choice and continues from it; second reader A syncs after each; (vii) the stub registry omits a pinned, trusted, never-revoked device F from a later list | B is not a recipient of A's new record; A and C reject (i) `CHECKPOINT_DEVICE_REVOKED`, (ii) `CHECKPOINT_REVOKED_WRITER_UNANCHORED` (not restored without a user choice), (iii) `CHECKPOINT_SIGNATURE_INVALID`; (iv) the endorsement is void — (iv-a) `ENDORSEMENT_AFTER_REVOKE`, (iv-b) `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED` — so D is not trusted, not a recipient of A's next record, D's record is `CHECKPOINT_WRITER_UNKNOWN`, and D appears in the R6 notice; none appears as context; device list shows B `git_access: unknown` until the user confirms the credential rotation; (v) on B, A stays trusted as a chain node (A→B still counts) but is not a recipient; on C, B's records are `CHECKPOINT_WRITER_UNKNOWN` and C reports `TRUST_ANCHOR_REQUIRED`; after the user pins B as a local anchor on C, B's records are accepted on C and B (holding its endorsement of C) encrypts its next record to C; a second fresh device E is still `TRUST_ANCHOR_REQUIRED` (the anchor is not synced); (vi) before the refresh: (vi-a) is `provisional` with `first_seen_by: null` and restores only labelled `provisional (device list as of …)`; the (vi-b) endorsement counts for nothing, so D is neither trusted nor a recipient, and D's record is `CHECKPOINT_WRITER_UNKNOWN`. After the refresh: (vi-a) becomes `DEMOTED:CHECKPOINT_REVOKED_WRITER_UNANCHORED` (file still in the tree, never restored again without a user choice, and `demoted` lists it with its `restored_at`); the endorsement becomes `DEMOTED:ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`; the control record stays accepted (`first_seen_by` < T); (vi-c) after the refresh (vi-a) is demoted on C and c1 is **held** at the gate (`CHECKPOINT_REFERENCE_HELD`, `sync_state: written`, no blob of c1 in the pushed history); after the user confirms with the I9 disclosure, c1 is pushed; on A, c1 is accepted and (vi-a) is still `CHECKPOINT_REVOKED_WRITER_UNANCHORED` (the reference anchored nothing); the explicit-choice variant behaves the same; (vii) a registry-fault notice; F leaves the trusted set and the recipient set; **all** of F's records become `DEMOTED:CHECKPOINT_WRITER_UNKNOWN`, whatever their `first_seen_by` | reader-side rejection of post-revoke, backdated and forged writers and of backdated endorsements (§5.6 E3/E4); trusted ≠ recipient and trust-anchor recovery (v); server-clock `first_seen_by` anchoring, nothing from a stale cache adds trust, re-evaluation and demotion on refresh (vi); no reference anchors, and continuations of unaccepted records are held (vi-c; invariants I6, I9); demotion of a device that left the trusted set without a revoke (vii; I8) | revocation of the GitHub credential (user step, D-8); prevention of deletions (only detected); the real ES-01 revoke | logic variant: Linux fixture (stub ES-01 list with `created_at`/`revoked_at` set by the fixture, local bare remote, modified client for B); real-ES-01 variant: BLOCKED | real-ES-01 variant: ES-01 (revoke, `revoked_at` R3/R4) |
| CK-11b | Recipient change notice / trust | registry list gains device D that no trusted device endorsed; headless variant: a valid endorsement of D written on device A is pulled by device B, and B's next push is started by the AutoCommitter debounce with no CLI command run on B (MCP calls only) | D is not a recipient and D's records are `CHECKPOINT_WRITER_UNKNOWN`; the notice (R6) is shown; after the user endorses D on A, new records include D; headless variant: on B the addition notice has `shown_at: null`, B's checkpoint pushes are `CHECKPOINT_PUSH_HELD` (`RECIPIENT_CHANGE_UNSHOWN`), no pushed blob decrypts with D's key, B's MCP results carry the notice; after `aigentry-brain trust refresh` on a terminal on B, `shown_at` is set and B's next push includes D | trust endorsement gate and recipient-change notice; an addition is not used before a terminal shows it (I5) | a real compromised registry | BLOCKED | ES-01 (list R3, R5, notice R6); decision D-9 |
| CK-12 | Backward compatibility | call `brain_context_resume` without `checkpoint` | identical content items for identical state, compared with the current tool (`BrainMcpServer.ts:288-324`), including the setup hint it may prepend (`:313-321`) | default `brain_context_resume` output unchanged | other brain MCP tools | Linux fixture | — |
| CK-13 | Schema upcast | v1 record read by a v2 reader; v2 record read by a v1 reader | v2 reader upcasts without rewriting; v1 reader returns `unsupported_version`, file unchanged | on-read upcast; newer version left untouched | a real v2 schema (none exists) | Linux fixture | — |
| CK-14 | Non-claim wording | inspect restore text and CLI help | states "context restored from checkpoint; model/process state not restored" (N1/N2) | non-claim wording present | whether an agent behaves as if state were restored | Linux fixture | — |
| CK-15 | Retention | fast-clock fixture | expired non-head records removed from `HEAD`; heads kept; M2 raw sibling removed at 30d while M1 record stays | removal from `HEAD` per class | deletion from Git history or host GC | Linux fixture (fast clock) | — |
| CK-16 | `[REQ line 12]` No GUI / no cmux | cmux not installed, no GUI session (no `DISPLAY`/`WAYLAND_DISPLAY`); `manual` and `session_end` triggers via CLI/MCP on A; sync and `brain_context_resume` on B | same outcome as CK-01; the PASS evidence is only B's verified `checkpoint_id` + `content_sha256`; a log copy or an SSH-run file listing is not accepted as evidence | no GUI/cmux needed; only verified ids/hashes count as evidence | real two hosts; macOS/Windows terminals | Linux fixture (single host, two device dirs, stub ES-01 list) | real two-host variant: ES-01 |
| CK-17 | Recovery path commits checkpoints | a `written` checkpoint record (outbox, §5.4) while `pull --rebase` fails and the merged profile entries equal the remote (`PushPullManager.ts:142-146`) | the pre-push gate commits the checkpoint file by its own commit and pushes it; `sync_state` reaches `pushed`; no checkpoint file left staged-only | checkpoint commit survives the `entriesEqual` recovery branch | other recovery paths of brain sync | Linux fixture (local bare remote) | — |
| CK-18 | `[REQ line 50]` Duplicate write / replay | the same record written twice (two age encryptions, so different ciphertext bytes); the same file replayed after a partition | no new file, no new commit, the same `checkpoint_id` returned, decided by equal decrypted `content_sha256`; a different `content_sha256` at the same path still → `CHECKPOINT_KEY_CONFLICT` | duplicate write / replay is an idempotent no-op | concurrent writers on two hosts | Linux fixture | — |
| CK-19 | Written ≠ synced | push fails (remote unreachable), later succeeds | `sync_state` stays `committed`; output says "saved on this device", never "saved for your other devices"; after the push `pushed` and only then the second wording | `sync_state` and the wording "saved for your other devices" only at `pushed` | whether another device has read it (not observable, never claimed) | Linux fixture (local bare remote made unreachable) | — |
| CK-20 | `[REQ line 49]` Revoked device gets nothing pushed after the revoke (pre-push gate on every push path, §5.4; invariant I10) | A's list cache includes B as a recipient; Git remote unreachable; A writes record r1 (outbox, encrypted to B among others); a fixture crash inside an earlier gated attempt left record r2 committed in `origin/main..HEAD` (both encrypted to B); B is revoked in the stub registry; then (a) remote and registry reachable, A syncs through P1; (b) remote reachable, registry unreachable, A syncs; (c) as (b) with the user's D-8 (b) opt-in to push with the cached set; (d) A writes with a list cache 25 h old; (e) as (a), with the push started by each measured path in turn: `brain_sync_push`, a write tool (`SyncLifecycle.schedulePush`), the AutoCommitter debounce, the TOFU recipient push after a pull, the pull-failure recovery, and P2 `aigentry-brain sync --tick`; control: a brain build without BR-1; (f) crash window: kill the gate after its commit and before its push, then run `git push origin main` by hand before brain restarts; then restart brain | A's write output shows `recipients as of <fetched_at>`; (a) the leftover check moves r2 back to the outbox and rebuilds the range (old commits unreachable); r1 and r2 re-wrapped to the current set; **no object in the pushed history** (`git rev-list --objects origin/main` on the bare remote, every blob under `checkpoints/`) decrypts with B's age key, and r1/r2 decrypt with A's; signatures and `content_sha256` unchanged; (b) `CHECKPOINT_PUSH_HELD`, r1 and r2 in the outbox (`written`), the profile commit pushed, nothing under `checkpoints/` pushed; wording "saved on this device" only; (c) pushed with the `recipients as of` warning; (d) the 24 h warning shown; (e) for every path the result of (a), or (P2 only) a refusal to push while `checkpoints/` is in the range, with the reason shown; control: checkpoint upload disabled (`sync: local_only`, reason `push_gate_missing`) and `sync --tick` finds no checkpoint file in `origin/main..HEAD`; (f) what the manual push sent is encrypted only to the R of that attempt's fresh list (no blob decrypts with B's key); after restart, any file not pushed is back in the outbox (BR-2) and no checkpoint path remains in `origin/main..HEAD` | no object pushed after a revoke is decryptable by the revoked device, on every measured brain push path; unpushed range checkpoint-free outside a gated attempt; hold when the list is unavailable; upload disabled without the gate; writer-side `recipients as of` and 24 h warning | records pushed before the revoke (past-ciphertext limit, §5.3); a device revoked between the gate's fetch and a manual push in the crash window (f); push paths added to brain after `0ffa6ee`; the real ES-01 list; Git-host behaviour | Linux fixture (local bare remote, stub ES-01 list and registry made unreachable, stub keeper) | real-ES-01 variant: ES-01 (revoke, R3/R4); (e)/(f) also need brain BR-1/BR-2 implemented |
| CK-21 | `[REQ line 48, 49]` Trust invariants (I3, I5, I11 of the interface invariants doc) and endorsement checks (§5.6 E1/E2) | (a) reader R pinned root A and B (A→B counted before the revoke); A revoked; device E idle-`expired` (not revoked); R writes a record; (b) root A active, X revoked, B endorsed only by X (counted on A before the revoke), fresh C; (c) the stub registry later changes a pinned device's `created_at`, and in a variant clears revoked B's `revoked_at`; (d) an endorsement file placed under another `user_key`, or whose path device ids differ from its fields; (e) endorsements with a wrong `endorsed_key_fp`, a bad `sig`, and a cycle X→Y, Y→X with neither reachable from an anchor; (f) the stub registry replaces trusted active B's `age_recipient` with a fixture key, (f1) with no or a bad `age_recipient_sig`, (f2) with a valid signature by B's key (a genuine rotation), and in a variant serves a different `age_recipient` for R itself; (f3) after R pinned B's rotated recipient (seq 2), the stub registry serves B's earlier validly signed recipient (seq 1); (f4) headless rotation: B validly rotates (seq 2); R's next push is started by the AutoCommitter debounce with no CLI command run on R (MCP calls only); then a brain MCP sync pass; then the stub registry serves seq 1 again; then the user runs `aigentry-brain trust refresh` in a terminal, then R pushes; (g) no-prompt cases: (g1) a user's first and only device A; (g2) single-device user A, then D registers; (g3) root A revoked, B endorsed by A (counted on B before the revoke), fresh C registers after the revoke | (a) on R, B is trusted (A→B still counts) and A is a trusted chain node; neither A nor E is a recipient of R's record; E's earlier records are accepted; (b) A's R6 notice lists B for re-endorsement. Before it: on C, X→B is `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED` and B's records are `CHECKPOINT_WRITER_UNKNOWN`; no `TRUST_ANCHOR_REQUIRED` is raised, because A is active and trusted on C. After the user endorses B on A: C trusts B with no local anchor; (c) a registry-fault notice; trust is computed with the pinned values; B stays revoked and its post-revoke records stay rejected; (d) `ENDORSEMENT_PATH_MISMATCH`, quarantined; (e) `ENDORSEMENT_INVALID` for each case; X and Y stay untrusted; (f1) B is not a recipient of R's next record, a registry-fault notice is shown, and that record does not decrypt with the fixture key; (f2) the R6 key-change notice is shown before the next write, which then uses the new recipient; R's own record is encrypted to R's local age key, never the served value, and a registry-fault notice is shown; (f3) a registry-fault notice; B is not a recipient of R's next record, which does not decrypt with B's seq-1 key; (f4) the key-change notice has `shown_at: null` and the pin stays at seq 1; every checkpoint push is `CHECKPOINT_PUSH_HELD` (`RECIPIENT_CHANGE_UNSHOWN`), records stay `written`, the profile is pushed, and no pushed blob decrypts with either of B's keys; each MCP result carries the notice; the served seq 1 is a registry fault (below the seq-2 notice); after the terminal refresh, `shown_at` is set, the pin is seq 2, and the next push decrypts with B's new key; (g1) no `TRUST_ANCHOR_REQUIRED`; (g2) on A no `TRUST_ANCHOR_REQUIRED`, D appears in A's R6 endorsement prompt; on D none, and D trusts A (root); (g3) on B no `TRUST_ANCHOR_REQUIRED`, C appears in B's R6 endorsement prompt; on C `TRUST_ANCHOR_REQUIRED` listing only B | trusted ≠ recipient incl. revoked and expired devices; re-endorsement keeps a non-revoked chain for fresh devices; pinned values are monotone and a revoke is never undone; E1/E2 rejections (d)/(e); the recipient condition incl. `age_recipient_sig` and "shown on a terminal before use" (f; I5); the scoped recovery trigger (g; I11) | real registry compromise; the real ES-01 list; whether the user compares fingerprints | Linux fixture (stub ES-01 list with fixture-set `created_at`/`revoked_at`/`status`/`age_recipient`, local bare remote, stub keeper) | real-ES-01 variant: ES-01 (R2–R6) |
| CK-22 | `[REQ line 49]` One signer (invariant I12) | brain writes a checkpoint and an endorsement through the keeper protocol (ES-03 §5.1); a fixture caller asks the keeper to sign with `aigentry-device-v1\|`, with `aigentry-age-recipient-v1\|` and with an unknown prefix; then the keeper is stopped and cannot be started | the record and endorsement signatures verify with the device's `public_key`; the brain process opens no file under the ES-01 device directory (file-access audit of the fixture, e.g. `strace -f -e trace=openat`); each refused prefix → `SIGN_PREFIX_REFUSED`, nothing signed; keeper unavailable → `CHECKPOINT_IDENTITY_MISSING`, no record written, no push started | brain signs only through the keeper; prefix allowlist; fail-closed without the keeper | other same-uid processes calling the keeper (the OS user is the boundary, non-claim N-U4); Keychain/DPAPI stores (ES-01 ID-11) | brain side: Linux fixture (stub keeper implementing the ES-03 §5.1 protocol); real-keeper variant: BLOCKED | real-keeper variant: ES-03 §5.1 keeper implementation; D-Q-9 |
| CK-23 | `[REQ line 48, 49]` A rekey sibling never inherits an earlier bound (invariant I6, §4.2) | reader C holds writer B's record r at path P as `pending_key` (C not a recipient of P), `first_seen_by(P)` = S1 < T; B is revoked at T and keeps its Git credential; after T, B (modified client) pushes the sibling `<seq>.rekey-1.ckpt.age` of P holding a **different** record r′ with the same `checkpoint_id`, `created_at` < T, validly signed by B's key and encrypted to C; C syncs. (v1) as above, but the sibling holds r itself (same `content_sha256`). (v2) control: non-revoked A's rekey pass re-wraps A's own record a, which C holds as `pending_key`, after C enters R. (v3) reader D, a recipient of P, accepted r from P before T, then syncs the r′ sibling | `observed` holds the sibling with its own `first_seen_by` S2 > T; r′ is `CHECKPOINT_REVOKED_WRITER_UNANCHORED` (listed, not restored without a user choice) and P stays `pending_key` with S1; (v1) the same: the rekeyed r is unanchored on C (the cost stated in §4.2); (v2) a's sibling is accepted on C and restores (A is not revoked); (v3) on D, r stays accepted from P, and the sibling decrypting to the same id with a different `content_sha256` is `CHECKPOINT_KEY_CONFLICT`, surfaced and not accepted | per-file `first_seen_by`; no bound transfers between files; differing content under one id is a conflict, never an inheritance | revocation of the GitHub credential (D-8); the real ES-01 revoke | Linux fixture (stub ES-01 list with fixture `revoked_at`, local bare remote, modified client for B, stub keeper) | real-ES-01 variant: ES-01 (revoke R3/R4); (v2) also brain BR-1/BR-2 (the rekey pass runs only with upload enabled) |
| CK-24 | `[REQ line 49]` The rekey pass and every leftover go only through the gate (invariant I10 (i)(ii), §5.3, BR-1/BR-2) | A holds accepted, pushed records r1, r2; A's list cache still lists B as a recipient; a fresh list adds C to R. (a) A's rekey pass runs; before any gated push, the AutoCommitter debounce commits (`git add .`), P2 `sync --tick` of a brain build without BR-1 runs, and the user runs `git push origin main`; then B is revoked and A's gate runs through P1. (b) Kill the gate after step 5 moved the siblings into `checkpoints/` and before its commit; run P2 (no BR-1) and a manual `git push origin main`; then restart brain. (c) Start the gate and an AutoCommitter commit together, 100 times. (d) Checkpoint upload disabled (`push_gate_missing`) when C enters R. (e) A's rekey pass meets a record that is `provisional`, `*_UNANCHORED`, `DEMOTED`, quarantined or `pending_key` on A; variant: a sibling of record b (writer B) is in the outbox, then B is revoked and b's `created_at` ≥ `revoked_at`, and A's gate runs. (f) A and D both rekey record r for C; D pushes `<seq>.rekey-1.ckpt.age` first; separately, A is killed during the pass, and A's keeper is stopped during a second pass. (g) A retention-expiry commit deletes an expired record under `checkpoints/`; then P2 (no BR-1) and the gate run. (h) Rotation: B, already in A's `rekeyed_for` at seq 1, loses `~/.config/sops/age/keys.txt`, brain regenerates it and B registers seq 2; the rotation is shown on A (terminal refresh); control: no rotation, a second fresh list | (a) the siblings exist only in `<aig>/checkpoint-outbox/` (`written`) until the gate runs; no AutoCommitter or P2 commit and no manual push contains a path under `checkpoints/` that is not on `origin/main`; the gate re-wraps the siblings to R of its own fresh list (B excluded after the revoke); no pushed blob under `checkpoints/` decrypts with B's key (`git rev-list --objects origin/main` on the bare remote); the siblings decrypt with C's key, and their signatures and `content_sha256` equal the originals'; r1 and r2 are unchanged; (b) whatever P2 or the manual push sent is encrypted only to R of that attempt's fresh list; after restart, the start-up check (before any commit or push path) returns every unpushed sibling to the outbox, and no `checkpoints/` path that is not on `origin/main` remains in the work tree or in `origin/main..HEAD`; (c) no AutoCommitter commit contains a `checkpoints/` path that is not on `origin/main`, no profile change is lost, and no gate reset overlaps a commit (the repo lock); (d) no sibling is written and C's restore stays `CHECKPOINT_PENDING_KEY` (as CK-03 (c)); (e) none of them is rekeyed; variant: gate step 1 demotes b and drops its sibling from the outbox, nothing of b is pushed; (f) A's sibling is pushed as `rekey-2` (or dropped when `rekey-1` decrypts to the same `content_sha256`), D's file is never modified; after the kill and after the keeper outage C is not in `rekeyed_for` and the next fresh list runs the pass again; (g) the deletion is not treated as a leftover: P2 pushes it, the gate does not rebuild the range; (h) A's next fresh list runs the pass for `(B, 2)`; the siblings decrypt with B's new key, and on B its older records (written by B and by A) restore from them; `rekeyed_for` holds `(B, 1)` and `(B, 2)`; control: no second pass | the rekey pass writes only through the outbox and the gate, with R of a fresh list; a rotation re-arms the pass (h); uncommitted leftovers after a crash; the repo lock; rekey and upload disabled together; sibling re-check after step 1; persisted `rekeyed_for`; `<n>` collision; "added or modified" | a device revoked between the gate's fetch and a manual push in the crash window (b); push paths added to brain after `0ffa6ee`; the real ES-01 list | Linux fixture (local bare remote, stub ES-01 list, stub keeper) | brain BR-1/BR-2 (gate, start-up check, repo lock); real-ES-01 variant: ES-01 (revoke R3/R4) |
| CK-25 | Old and fresh readers agree after a revoke (invariant I8) | B's clock runs ahead; B writes record r with `created_at` ≥ the later `revoked_at` T; reader A accepts r with `first_seen_by` < T; B is revoked at T; A refreshes; fresh reader C syncs | on A, r becomes `DEMOTED:CHECKPOINT_DEVICE_REVOKED` (all of B's items re-checked, not only those first seen after T), leaves the heads and is reported with its `restored_at` if restored; on C, r is `CHECKPOINT_DEVICE_REVOKED`; A and C agree | re-check of all items of a newly revoked device | real clock skew on hosts | Linux fixture (stub ES-01 list, fixture clocks, local bare remote) | — |
| CK-26 | A foreign capture reference is held (invariant I9, §5.4 gate step 3) | A writes record r1 whose `workspace_capture_id` names A's own capture, and record r2 naming a capture written by device B | r1 passes step 3; r2 is `CHECKPOINT_REFERENCE_HELD` (`written`) until the user confirms with the I9 disclosure; brain reads no ES-04 state (file-access audit of the fixture) | capture references judged without ES-04 state | ES-04's own gate (WS-16 (g)) | Linux fixture (stub keeper, stub ES-01 list) | — |
| CK-27 | `[REQ line 48, 49]` No pull and no `.gitignore` reaches the security state (invariants I3, I4, I6, I10, I12; BR-5, BR-6; joint review round 2 Exp1/Exp2, re-run in interface invariants doc §A.3) | A holds a trust state with B revoked at T and an outbox record r1 written while B was still in A's cached R. Revoked B keeps its Git credential. (a) B commits `.aigentry/trust-state.json` with `git add -f` containing `anchors: [{device_id: D, kind: "local"}]`, `pinned` entries, `observed[P].first_seen_by` < T and `seen[P].state: "accepted"` for B's post-revoke record at P, plus `.aigentry/checkpoint-index.json` and `.aigentry/checkpoint-outbox/…`, and pushes; A pulls through P1 and, separately, P2. (b) B pushes a `.gitignore` that drops the brain entries, and in a variant adds `!.aigentry/checkpoint-outbox/`; A pulls, then the AutoCommitter debounce commits, P2 `sync --tick` (brain build without BR-1) runs, the user runs `git push origin main`, and A's gate runs. (c) A's brain MCP sync pass, a P2 tick running the gate, `aigentry-brain trust bootstrap` and two `aigentry-brain trust refresh` calls (one from ES-04) start together, 100 times; a fixture tries to add an `observed` entry while a refresh's fetch is in flight. (d) B pushes a tracked symlink `checkpoints/v1 -> ../.git/aigentry` (and variants under `trust/` and at `memory-profile.enc.json`); A pulls, writes a record, and the gate runs. (e) B pushes a commit whose tree holds `.git/aigentry/planted.json`; A pulls through P1 and P2 | (a) `<aig>/trust-state.json` is byte-identical before and after the pull; `CHECKPOINT_REPO_TAMPERED` names B's commit and each path; D is not trusted, P is `CHECKPOINT_REVOKED_WRITER_UNANCHORED` (or `CHECKPOINT_DEVICE_REVOKED`); the pulled files are not read (file-access audit) and not deleted; (b) no commit A makes contains a file from `<aig>` or any path under `.aigentry/`; r1 reaches `origin` only through the gate; **no pushed blob** (`git rev-list --objects origin/main` on the bare remote) decrypts with B's age key; (c) every write is serialized by the trust-state lock (no lost `observed`, `seen` or `pinned` update; final file equals a serial replay), and the fixture's observation waits for the lock, so its entry keeps `first_seen_by: null` until the next refresh; (d) `CHECKPOINT_REPO_TAMPERED` names the symlink; the gate holds checkpoint pushes while it is in `HEAD`; no file under `<aig>` is created, read or changed through it (file-access audit); (e) the pull is refused by git and reported as `CHECKPOINT_REPO_TAMPERED` "pull refused: invalid path in `<commit>`"; nothing is written under `<aig>`; every later pull reports the same (sync stopped, the stated availability limit) | security state unreachable by pull and `git add`; tamper report; one trust-state writer; `first_seen_by` bound only to entries observed before the fetch started; symlink hold and no-follow moves (d); pull refusal reported (e) | a hosted remote (the fixture pulls from a local bare repo); git's own checkout refusal of tree entries under `.git/` (from knowledge); a same-uid process writing `<aig>` (N-U4) | Linux fixture (local bare remote, stub ES-01 list, stub keeper, modified client for B) | brain BR-5/BR-6 for the brain side; (b)'s gated push also BR-1/BR-2 |
