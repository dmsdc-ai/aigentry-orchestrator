# ADR — Environment continuity: context checkpoints, workspace capture and stage diagnostics (task #2026101204)

Status: **PROPOSED** (architect, 2026-10-12). Nothing here is accepted, implemented, released or
installed. Technical choices are for the orchestrator to decide and record (Rule 47 §1); items in §6
touch Rule 47 human-approval categories and need the user.

Specs: `docs/specs/2026-10-12-env-continuity-context-checkpoint.md` (ES-02),
`docs/specs/2026-10-12-env-continuity-workspace-capture.md` (ES-04),
`docs/specs/2026-10-12-env-continuity-diagnostics.md` (ES-07), and the interface invariants shared with ES-01
`docs/specs/2026-10-13-env-continuity-interface-invariants.md` (I1–I12).
Inputs: `state/specs/2026-10-12-environment-sharing-release-requirements.md` (requirement),
`state/draft/2026-10-12-environment-sharing-build-plan-proposal.md` (approved build-plan draft).

Convention (orchestrator guardrail 2026-10-12 13:59Z): §1 = FINDINGS; §2–§7 = PROPOSALS requiring
review. Tags `[REQ]`/`[DRAFT]`/`[EXISTING]` mark statements that restate an existing source.

## 1. Findings (summary; details with file:line in each spec's Part A)

1. brain sync is opt-in, Git-based, single branch `main`, to a private repo of the user's GitHub
   account; all memory lives in one rewritten encrypted file; conflicts resolve by version vector then
   LWW (brain `SetupWizard.ts:54,146-213`, `GitBackend.ts:19,30,83`, `ProfileFormat.ts:140-182`,
   `ConflictResolver.ts:40-61`).
2. brain encryption falls back to plaintext on failure (`ProfileFormat.ts:160-181`); a new device
   cannot decrypt until an existing device re-encrypts (`GitBackend.ts:150-153`) — on that device's next
   profile write, not merely by being online (`GitBackend.ts:132`, `ProfileFormat.ts:256-277`).
3. brain has no checkpoint record, lineage, cursor, provenance marking or content secret scanner
   (`SyncBackend.ts:1-13`, `BrainMcpServer.ts:270-326`, `capture-tool.ts:38-56`).
4. devkit has no repository/worktree/uncommitted capture and no runtime manifest; 604f2b5 is a local
   post-compaction snapshot reader (`hooks/post-compact-restore.sh:1-16`, `lib/workspace-init.js:1-8`).
   No devkit caller of brain's `session_context` tools was found.
5. telesession PR3 spec defines ledger stages, status vocabulary and "timeout ≠ not delivered"; it
   defines no PTY-write evidence (telepty "submitted" maps only to `transport_accepted`); its ledger field
   `checkpoint` means the origin agent's read cursor (`e2e-delivery-protocol.md:82,109-160,313-319`).
   Whether telepty can observe a PTY write is **not measured** (telepty not read).
6. Not found / not read: registry (auth, device API, storage), the constitution file in the aigentry
   checkout, `bin/context-compact.sh` in the orchestrator clone (it exists on `origin/release/0.2.5`, `1d8a600`/`ac94b35`). Not measured: any real multi-host run,
   macOS/Windows.

## 2. Decisions (proposed)

| # | Decision | Basis |
|---|---|---|
| A1 | Checkpoints are **immutable, append-only, one encrypted file per record** under `checkpoints/v1/…` in the existing brain repo — not brain entries | entries are merged by LWW and stored in one rewritten file (finding 1) → a concurrent device's context would be dropped |
| A2 | Conflict = **lineage fork + explicit user choice**; no automatic merge or LWW for checkpoints | `[DRAFT line 43]`; avoids silent loss |
| A3 | Incremental cursor is local (`remote_commit` + seen set) with `git diff --name-only` fast path and `ls-tree` fallback (shallow clones) | `SyncBackend` lacks primitives; clone is `--depth 1` |
| A4 | Encryption **fail-closed**; recipients = ES-01 active, trusted device keys (not TOFU) for checkpoints and captures | finding 2 |
| A4b | Every checkpoint record and capture manifest is **signed with the writer's ES-01 device key**; readers verify against the authenticated device list (incl. `revoked_at`) and reject unknown, forged or post-revoke writers. Revoke is enforced reader-side, because Git writes never pass through the registry. A trust endorsement counts only if the endorsed device's server-clock `created_at` precedes the endorser's `revoked_at`, and an endorsement by a revoked device first seen after the revoke must be anchored (ES-02 §5.6), so a revoked device cannot extend trust by backdating. Only the server-clock `first_seen_by` anchors; a reference (`parents`, `resumed_from`, `workspace_capture_id`, `checkpoint_id`) never does (A13). Anchoring uses a server-clock first-seen bound (`first_seen_by`, from the list's `server_time`). Items seen under a stale list are provisional and add no trust. Every list refresh re-evaluates them, and failures are demoted, not deleted (ES-02 §4.2, §5.4). Trust is computed per reader from a local anchor set (own device, first device, user-confirmed recovery anchors); "trusted" (chain node, may be revoked) is distinct from "recipient" (trusted, active, confirmed); when every chain runs through a revoked device and an older active device exists, a fresh device recovers by a user-confirmed local anchor (ES-02 §5.6); the trust/revocation invariants are the shared I1–I12 (A13). Requirements on ES-01 are listed in ES-02 §5.5 | `integrity` is unkeyed and age gives no sender authentication; anyone with push access could otherwise write as any device; `[DRAFT line 36]` device-key signing |
| A5 | Transcript storage default = **hash + summary (M1)**; raw (M2) opt-in per project | Git history makes raw deletion impractical; `[REQ line 39]` original-vs-summary marking |
| A6 | Restore through an **optional extension** of `brain_context_resume`; default output unchanged; every restored item marked `original`/`summary`/`unavailable` | `[DRAFT line 44]`, backward compatibility |
| A7 | Workspace capture = git metadata + shelf commit + bundle of unpushed commits, built without touching the user's index/worktree; ignored files never captured; deny-list + content scan + size caps, applied to the unpushed commit range too (a hit refuses that repo's bundle; no-upstream base = merge-base with the remote default branch or a user-named base); symlinks never followed | `[REQ line 41]` |
| A8 | Workspace storage default = **encrypted bundle on per-capture refs in the user's private brain repo (S1)** | no new infra/credentials (Article 1/17); brain pulls only `main`, so refs are not synced by default |
| A9 | Restore default = **new worktree**, after preview, conflict detection and a preserve ref/copy + journal; runtime recreate commands are printed, not run | `[REQ line 41, 51]` no original loss |
| A10 | Diagnostics = read-only derived view attached optionally to `telesession_request_status`; `completed` only from the ledger; access health in a separate object with `implies_request_state:false` | `[REQ line 44]`, `[EXISTING e2e-delivery-protocol.md:142]` |
| A11 | ES-02 ids link to telesession via a separate `origin_checkpoint_id` field owned by ES-05 (never the ledger's `checkpoint` field) | finding 5 naming collision |
| A13 | **One closed trust/revocation model for ES-01, ES-02 and ES-04**: the interface invariants I1–I12 (`docs/specs/2026-10-13-env-continuity-interface-invariants.md`), each with an ES-01 obligation, an ES-02/ES-04 obligation and test rows in each spec. The key rules are these. No reference anchors anything (I6). A writer holds at its gate any record or capture whose references are not accepted on it (I9). A device is a recipient only with an `age_recipient_sig` that verifies against its pinned key (I5). Every brain push path runs the pre-push gate (P1 `GitBackend.push` with all callers, P2 `sync --tick`), and checkpoint upload stays disabled until it does (I10). Anchor recovery fires only with a fresh list, no active trusted peer and an older active candidate; the lone survivor gets an explicit unrecoverable-key outcome (I11, N-U1). Pins, anchors and `first_seen_by` live in one durable trust state per device that is never rebuilt (I3). The lease keeper is the only signer and list fetcher (I12) | four ES-02/04 and two ES-01/03 review rounds found new gaps each time because the two sets were patched separately (round 4 blocking 1–4, idq round 2 blocking 1); `[REQ line 48, 49]` |
| A12 | Shared secret detector set for ES-02 and ES-04, applied to every string value that leaves the device (checkpoint record incl. evidence refs/URLs; capture files, patches, unpushed range and the manifest itself) before signing and encryption; URL userinfo/query stripped by default; fail-closed when unavailable | finding 3; `[REQ line 49]` |
| A14 | **Rekey (revision 2 of the invariants doc).** (a) A checkpoint rekey sibling is a writer like any other: it is written to the outbox, re-wrapped to R of the gate's fresh list, committed only by the gate, and the pass does not run while upload is disabled (I10). (b) On readers, `first_seen_by` belongs to the file actually decrypted; no sibling inherits the original path's bound (I6). (c) **Captures are never rekeyed** (N-U5): a device that was not a recipient when the capture was pushed gets the terminal `RESTORE_NOT_A_RECIPIENT` and the user captures again | joint review blocking 1–3. (a)/(b): a reader that cannot decrypt the original cannot check that a sibling holds the same content, and a rekey writer outside the gate broke I10 (i). (c) chosen over a gated capture rekey because an automatic capture rekey would re-upload uncommitted code without a capture command (D-6 default: explicit command only), and it would add a second ref grammar, a content binding and a gate path for an artefact kept 14 days. Re-capture is one explicit command on a device that holds the work |

## 3. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Store checkpoints as brain `Entry` / extend `session_context` | LWW drops concurrent context; one mutable entry per project (`BrainContract.ts:899-923`); whole-profile rewrite per save |
| Auto-merge forked checkpoints (LWW or text merge) | silently loses or fabricates context; violates "original vs summary" honesty |
| Raw transcript as default | Git history retention, privacy transfer of conversation text (Rule 47) |
| Reuse TOFU recipient sync | fresh device blocked until an old device is online; recipients never shrink on revoke |
| Shelf refs in the **project** remote (S2) | pushes unencrypted uncommitted work to possibly shared/public remotes |
| Registry artifact store (S3) now | needs registry storage, credentials/scopes and cost approval; registry not read; candidate later |
| Restore in place by default | risks overwriting the target's own work |
| Copy `.env` / credentials with encryption | `[REQ line 41]` forbids automatic secret copy |
| Live process/PTY migration, CRIU-style checkpointing | `[REQ line 42]` reconnect/recreate only; non-portable across OSes |
| Diagnostics writing ledger stages or inferring completion from health | `[REQ line 44]`; violates telesession R1/R3 |
| A new daemon or sync service for checkpoints | `[DRAFT line 9]` "새 daemon, 새 전송, 새 자격증명은 만들지 않는다" |
| Keep the reference anchoring clause, made conditional on the writer having accepted the referenced item (review round 4, fix 1 (a)) | a reader cannot verify the writer's past state, so trust would again depend on a second path. I6 + I9 give the same protection with one anchoring rule; the cost is a larger D-8 "unanchored on fresh devices" set |
| Gate only in front of `GitBackend.push` | measured second path P2 `sync --tick` (`SyncTick.ts:173`) bypasses it; the user's own `git push` too. I10 keeps the unpushed range checkpoint-free outside a gated attempt and requires the gate on every brain path |
| A repo-local `pre-push` hook as the gate | a global `core.hooksPath`, which brain's hook installer can recommend (`hooks/index.ts:53`), disables it; kept only as optional belt-and-braces (BR-3) |
| Move the root to the earliest **non-revoked** device after a root revoke | it would end the permanent recovery cost, but it lets a registry-side revoke silently move every fresh device's anchor. Kept: root = earliest `created_at`, revoked or not; the cost is stated (I11) |
| Recovery trigger "no active trusted device other than itself" alone, or plus "reader is not the root" | the first fires on a first device and on an existing device when a new one registers (round 4, blocking 2); the second still fires on a surviving non-root device (B) when a newer fresh device registers after a root revoke. I11 uses "an older active candidate exists" |
| Separate pin sets in brain (ES-02) and devkit (ES-04) | two pin sets on one device can disagree. ES-04 reads the single trust state owned by brain (I3) |
| A rekey sibling inherits the early `first_seen_by` of the path a reader saw as `pending_key` (round 4, non-blocking 3) | the reader cannot decrypt the original, so it cannot tell whether the sibling holds the same content; a revoked writer could push a backdated sibling under the same `checkpoint_id` (joint review blocking 1). Replaced by a per-file bound (A14 (b)) |
| Bind sibling content at observation with a cleartext `content_sha256` + signature header or `.sig` sidecar (joint review fix 1 (b)) | adds plaintext metadata (a hash of every record) to the user's repo and a second binding rule; it saves only the case "seen as ciphertext before a revoke, rekeyed after it", which then behaves like a fresh device (D-8 cost) |
| Gated capture rekey through sibling refs `refs/aigentry/ws/<device_id>/<capture_id>.rekey-<n>` (joint review fix 3 (a)) | automatic re-upload of uncommitted code without a capture command (D-6); new ref grammar, content binding and gate path; re-capture covers the need (A14 (c)) |

## 4. Consequences

- Positive: no new server, transport or credential for ES-02/ES-04; per-user isolation reuses the
  private repo; explicit, testable provenance; no silent context loss.
- Negative / accepted risks: Git host retains deleted data in history/unreachable objects until GC;
  revoked devices can still read past ciphertext they kept; a fresh device needs an online existing
  device (or post-registration writes) to read older **checkpoint** records, and that rekey runs only once
  checkpoint upload is enabled (A14 (a)); a fresh device never reads a capture pushed before it was a
  recipient (`RESTORE_NOT_A_RECIPIENT`, terminal; the user captures again, A14 (c)); brain repo grows with checkpoint files
  (bounded by retention and the 1 MiB record cap) and capture refs (50 MiB cap, newest 5 per device).
- Isolation depends on ES-01 binding the brain repo's GitHub account to the aigentry `user_id` — open.
- A revoked device keeps Git access to the brain repo until the user revokes its GitHub credential
  (outside aigentry). Until then it can pull ciphertext (decrypting everything written before the revoke),
  read path metadata and push. Its new writes are rejected by readers, but deletions/overwrites are only
  detected, not prevented (ES-02 §5.3; D-8).
- The registry is the key directory. Without the endorsement step (D-9), a compromised registry could add
  a recipient and read every new record. With it, a substituted `age_recipient` is caught only because writers
  verify `age_recipient_sig` against the pinned key (I5).
- (A13) Checkpoint upload stays disabled (`sync: local_only`, reason `push_gate_missing`) until brain runs the
  pre-push gate on both measured push paths, with its start-up check and one repo lock (BR-1, BR-2). Users who opt
  in under D-7 before that get local-only checkpoints, and are told why. The rekey pass does not run either.
  Capture upload does not wait on BR-1/BR-2 (invariants doc §B.5).
- Requirement line 49 is **not met for brain memory**: brain's memory-profile recipients never shrink, so a revoked
  device keeps decrypting new memory writes (`ProfileFormat.ts:256-277`; ES-02 N6; invariants doc BR-4). ES-02 and
  ES-04 meet it only for checkpoints and captures. A brain-side task or an ES-01 follow-up is needed.
- (A13) Without references as anchors, a fresh device sees every pre-revoke record of a revoked device as
  `CHECKPOINT_REVOKED_WRITER_UNANCHORED`. Continuations of an unaccepted record wait at the writer's gate for one
  user confirmation per referenced item.
- (A13) ES-02 and ES-04 writes need the devkit lease keeper (ES-03 §5.1, D-Q-9 in the ES-01/03 ADR). If D-Q-9 is
  declined, no checkpoint or capture can be signed.
- (A13) A revoked root makes anchor recovery a permanent per-fresh-device step. A lone survivor's records that were
  encrypted only to revoked/lost devices are unrecoverable (non-claim N-U1).
- brain needs a content secret scanner (new code, false negatives possible; guarantee is "scanned").
- **Linux-only caveat** `[REQ line 52]`: only Linux can be exercised now (Mac offline, line 60); macOS and
  Windows file-system rows (WS-12) and install/reconnect rows remain unverified until real runners exist.
  A Linux fixture PASS is never reported as cross-platform or real-endpoint PASS.
- **Reconnect/recreate, never live migration** `[REQ line 42]`: no model internal state, process memory,
  PTY buffer, running process or port is transferred by ES-02/ES-04.

## 5. Ownership and sequencing (proposal)

ES-01 identity → ES-02 store/scanner/restore (brain) + triggers (orchestrator/devkit hooks) → ES-04
capture/restore CLI (devkit) reusing ES-02 encryption + scanner → ES-07 view after ES-05 ledger merge.
Matches requirement order line 56 and draft release split R-B (draft line 78).

## 6. Open user decisions (Rule 47) with recommended defaults

| ID | Decision | Category | Recommended default |
|---|---|---|---|
| D-1 | Transcript storage mode | 개인정보 전송 | M1 hash+summary; M2 raw opt-in per project, raw TTL 30 d |
| D-2 | Workspace capture storage | 비용 / 개인정보 | S1 encrypted per-capture refs in the user's private brain repo; S3 registry later with its own approval |
| D-3 | Retention | 개인정보 / 운영 데이터 삭제 | checkpoints 90 d after superseded (heads kept); captures 14 d, newest 5 per device, 50 MiB cap; preserve copies kept until user deletes |
| D-4 | Automatic writes in the user's repo: (a) expiry deletion (commits deleting files/refs); (b) non-deletion writes — the background rekey pass (`<seq>.rekey-<n>.ckpt.age` siblings, ES-02 §5.3), the one-time `session_context` import (ES-02 §7), trust endorsements (ES-02 §5.5 R5) | 운영 데이터 변경/삭제 | (a) allowed for aigentry-created paths/refs only, after the user enables sync; history rewrite never automatic. (b) checkpoint rekey allowed automatically under the same limits (adds files only, never modifies). What is approved: after a fresh list in which a device joined the recipient set, the device re-wraps the records it has `accepted` into sibling files in the outbox; they leave the device only through the pre-push gate, encrypted to the gate's fresh recipient set; nothing runs while checkpoint upload is disabled (ES-02 §5.3, A14 (a)). There is **no** capture rekey (A14 (c)). Import and endorsements only on an explicit user command |
| D-5 | Binding the brain repo GitHub account to the aigentry account (ES-01) | 권한 확대 | record binding only; no new GitHub scopes; reuse the user's existing `gh`/git credentials |
| D-6 | Uploading uncommitted code (including unpushed commits) off the device at all | 개인정보 전송 | allowed only by explicit per-capture command; no automatic/periodic capture in this release |
| D-7 | Uploading conversation-derived checkpoints: does it need its own opt-in separate from brain's `enableSync` memory consent (`SetupWizard.ts:54`), and which triggers upload automatically (ES-02 N4, §5.1, §7) | 개인정보 전송 | separate explicit opt-in (login or `enableSync` alone never enables it); automatic triggers `manual` + `session_end` only; `compact` and `dispatch_report` off until enabled; `interval` off. Whatever the user approves, checkpoint upload stays disabled (`sync: local_only`, reason `push_gate_missing`) until brain runs the pre-push gate on every push path (BR-1, BR-2; I10 (iv)); approving D-7 before that sends nothing off the device |
| D-8 | (a) Revoked device's remaining Git access (S1 known limit, ES-02 §5.3); (b) pushing checkpoints/captures when the device list cannot be re-fetched at push time (ES-02 §5.4 pre-push gate) | 개인정보 전송 (a revoked machine can still pull ciphertext and metadata; (b) a stale recipient set may include a device revoked after the last fetch) | (b) hold the checkpoint/capture push until a list fetch succeeds (the profile still syncs; output "saved on this device"); pushing with the cached set only by the user's opt-in, with the `recipients as of` warning. (a) Accept as a stated known limit; the revoke flow includes a required user step "revoke this machine's GitHub credential" and shows `git_access: unknown` until the user confirms; aigentry gets no GitHub scope to do it itself. Accepted cost: on a fresh device, **every** legitimate pre-revoke record of the revoked device reads `CHECKPOINT_REVOKED_WRITER_UNANCHORED` and needs an explicit user choice (ES-02 §5.4; references no longer anchor, A13 / I6). A continuation of such a record is held at the writer's gate until the user confirms once per referenced item (I9). The same holds on a reader that saw such a record only as ciphertext before the revoke and later receives a rekeyed copy: the copy is judged by its own `first_seen_by` (A14 (b)). The (b) default applies on every brain push path; until brain runs the gate on all of them, checkpoint upload is off (I10) |
| D-9 | Key-directory trust: is a registry-listed device a recipient immediately, or only after an existing trusted device endorses it (ES-02 §5.5 R5/R6) | 개인정보 전송 | endorsement required (one confirmation per new device, on any trusted device, after comparing fingerprints; validity by the server-clock rule and anchoring of ES-02 §5.6) + recipient-change notice. A device is a recipient only when its `age_recipient_sig` verifies against its pinned key (I5). Trust-anchor recovery: only when a device, after a fresh list, finds no active trusted device other than itself **and** an older active device exists (e.g. the first device was revoked and every chain runs through it), the user pins one such device as a local anchor on it after comparing the fingerprint that device computes from its own key (I11). This is the same TOFU limit as the fresh-device bootstrap, accepted here; a local anchor is never synced. After a root revoke this is a **permanent** step for every later fresh device. With no other active device (lone survivor) there is no prompt, and data encrypted only to revoked/lost devices is unrecoverable (N-U1). Registry-only is the fallback if the user prefers fewer steps and accepts that a compromised registry can read new records |

Technical items the orchestrator can decide without the user (Rule 47 §1): record layout, cursor design,
JCS canonicalisation, error codes, detector list, freshness defaults.

## 7. Inputs for the cost re-estimate (requirement line 57: context 4–8, workspace 6–12, OS/diagnostics 4–8 agent-days)

| Area | Finding that changes the estimate | Direction |
|---|---|---|
| ES-02 | needs new SyncBackend primitives, CheckpointStore/Index, fail-closed crypto, ES-01-based recipients + rekey pass, MCP tools, `brain_context_resume` extension, secret scanner (none exists), orchestrator/devkit triggers, 20 test rows after fix cycle 1 | upper half or above: **6–9** (scanner shared with ES-04 counted here; 9 exceeds the requirement's 4–8 context bucket) |
| ES-04 | no existing capture code in devkit; bundle/shelf/worktree handling, preview/journal/rollback, runtime manifest detectors for several ecosystems (test rows WS-15/WS-15b added in fix cycle 2), per-OS FS checks | upper half or above: **9–13**; per-OS verification blocked on runners |
| ES-07 | data model only now; PTY hop has no evidence source (telepty not read); depends on PR3 merge | data model + view **2–3** within the 4–8 OS/diagnostics bucket; no reduction of the OS part |
| Cross-cutting | ES-01 user/device + key distribution is a hard prerequisite for both; registry not read — unknown | estimate blocked until ES-01 design |
| Cross-cutting (reconciliation 2026-10-13) | brain-side gate on two push paths + startup check (BR-1/BR-2), trust-state file, reference hold, recipient-signature check, keeper client in brain and ES-04 | add, unestimated; brain-side items belong to a brain task |
| Cross-cutting (fix cycle 1) | record/manifest signing + reader-side verification, device-list cache, trust endorsements, and the ES-01 key interface (`age_recipient`, list fields — ES-02 §5.5) are not in the ES-02/ES-04 ranges above | add, unestimated; ES-01 side belongs to the identity estimate |
| ES-07 (fix cycle 1) | the optional `diagnostics` member of `telesession_request_status` (ES-07 §4) is a telesession-side change not counted above | add, unestimated |

These are planning inputs, not commitments (requirement line 57; draft line 84). The requirement's
32–64 agent-day total stays an unverified placeholder ("근거 불충분 예비치", draft line 84); nothing here
replaces it.
