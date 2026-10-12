# SPEC — Interface invariants between ES-01 (identity) and ES-02 / ES-04 (checkpoints, workspace capture) (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-13). No code. Not an implementation, merge, release or install claim.
- Revision 2 (reconciliation cycle 2, 2026-10-13, after the joint review of ES-01/03 `aeb78f8` and ES-02/04/07
  `8331a05`): I6 binds `first_seen_by` to the file actually read (no rekey-sibling inheritance); I10 covers the
  rekey pass, the uncommitted work tree, a repo lock and unpushed captures outside `refs/`; captures are never
  rekeyed (N-U5); I3/I8/I12 wording; N-U4 completed; §B.3 author self-check; §B.5 capture-upload answer.
- Revision 3 (reconciliation cycle 3, 2026-10-13, after joint review round 2 of ES-01/03 `6d4759a` and ES-02/04/07
  `5311c23`): all local security state moves out of the work tree into the brain repo's Git directory (§B.1 "Local
  state", I3, I10 (i), BR-5, `CHECKPOINT_REPO_TAMPERED`); the key-state codes are defined by what the reader can
  compute (N-U1, I11); brain is the only trust-state writer and exposes `aigentry-brain trust refresh`, which the ES-04
  gate uses (I3, I5, I9, I12, BR-6); `age_recipient_seq` in the signed recipient blocks rollback (I5); persisted
  rekey cursor, gate re-check of rekey siblings, "adds or modifies" instead of "touches" (I10).
- Revision 4 (reconciliation cycle 4, 2026-10-13, after joint review round 3 of ES-01/03 `83b2766` and ES-02/04/07
  `0c8ef58`): "shown" means written to a terminal, and a recipient change that no terminal has shown holds every
  checkpoint and capture push (`RECIPIENT_CHANGE_UNSHOWN`; §B.1 "Shown", I5, BR-6); the key-state codes count
  `expired` devices as possible holders, because they re-bind with the same key, and only an all-revoked set is
  `*_UNRECOVERABLE_KEY`, which then sticks (I11, N-U1); the rekey cursor is keyed by `(device_id,
  age_recipient_seq)`, so a shown rotation re-arms the pass (§B.2, I11); `<aig>` is resolved from the Git common
  directory and printed by brain (§B.1); symlink, pull-refusal and replay notes (BR-5, N-U3).
- Why: the trust/revocation rules were patched case by case in two spec sets, and every review round found a new
  gap between them. This document is the **single model** both sets cite. A rule in ES-01, ES-02 or ES-04 that
  touches trust, recipients, revocation, anchors or pushes must cite an invariant here. If it contradicts one,
  the invariant wins and the spec is defective.
- Specs bound by it:
  - ES-01 `docs/specs/2026-10-12-env-continuity-identity.md` and ES-03 §5.1 (lease keeper), both in clone
    `aigentry-orchestrator-wt-1204-idq`;
  - ES-02 `docs/specs/2026-10-12-env-continuity-context-checkpoint.md` and ES-04
    `docs/specs/2026-10-12-env-continuity-workspace-capture.md`, both in this clone.
- Cited by both ADRs (`docs/adr/2026-10-12-env-continuity-context-and-workspace.md` A13, A16,
  `docs/adr/2026-10-12-env-continuity-identity-and-queue.md` A12).
- Reading convention: Part A = FINDINGS (measured), Part B = PROPOSALS (each needs user review where it touches a
  Rule 47 item; those items are cited as "pending user decision" with the decision-bundle default).

# PART A — FINDINGS

## A.1 Brain push paths (measured 2026-10-13, aigentry-brain `main` @ `0ffa6ee`, read-only)

A repo-wide search for push call sites (`git push`, `.push()`, `['push'`, `simple-git`) found exactly two code paths
that push the brain repo:

| # | Path | What it pushes | Reached from |
|---|---|---|---|
| P1 | `GitBackend.push()` = simple-git `push -u origin <branch>` with branch `main`, 30 s timeout (`src/backend/GitBackend.ts:186-191`, `:19`) | everything committed on `main` | (a) `PushPullManager.executePush` (`src/sync/PushPullManager.ts:166-168`), entered through `enqueuePush` (`:161-163`). `enqueuePush` is called by `AutoCommitter` after its own `git add .` commit (`src/sync/AutoCommitter.ts:39`, `:56`), by pull-failure recovery (`PushPullManager.ts:153`), and by `BootstrapOrchestrator.push` (`src/mcp/BootstrapOrchestrator.ts:39-42`). That in turn serves the `brain_sync_push` MCP tool (`src/mcp/BrainMcpServer.ts:432-439` → `BrainContract.syncPush` `src/contract/BrainContract.ts:501-505`) and `SyncLifecycle.schedulePush` after every write tool (`src/sync/SyncLifecycle.ts:120-125`, `:181-182`). There is also a retry timer (`PushPullManager.ts:180`). (b) The TOFU recipient sync after every pull (`GitBackend.ts:86`), which commits with `git add .` and pushes (`:162-166`) |
| P2 | `aigentry-brain sync --tick` (`src/cli/braincli.ts:87`, `:375-377`) → `src/cli/seamless/SyncTick.ts`: `git add -A` (`:148`), `git commit` (`:149`), `git pull --rebase origin main` (`:162`), `git push origin main` (`:173`), all through `execFileSync`, bypassing `GitBackend` | everything in the work tree that is not ignored, committed on `main` | the OS timer that historical installers wrote (`TICK_COMMAND`, `src/cli/seamless/SeamlessSetup.ts:60`). The removal on old installs is "never fatal" (`:69`), so legacy timers may still run. Whether any is installed on the user's hosts was not measured |

Both paths push only `main`. Neither pushes `refs/aigentry/*` (P1 refspec `<branch>`, P2 refspec `main`), so brain
never sends ES-04 capture refs. The user's own `git push --mirror`, or a push with a `refs/*` refspec, would send
every local ref (git behaviour from knowledge; not run), so I10 (v) keeps an unpushed capture out of `refs/`.

Concurrency (re-measured 2026-10-13, brain `0ffa6ee`): brain has no repository lock. `AutoCommitter` serialises its
own commits with an in-process `inFlight` flag only (`src/sync/AutoCommitter.ts:7`, `:31-32`, `:49-50`), and P2 runs
in a separate process (`execFileSync`, `SyncTick.ts:148-173`). A gate that resets and commits (I10) can therefore race
with them unless one cross-process lock is added (BR-1).

A path outside brain's code also exists: the user's own `git push` in the brain repo. Brain's error text suggests it
(`src/shared/SetupErrors.ts:83`).

Hooks: brain's hook installer can recommend a **global** `core.hooksPath` (`src/cli/hooks/index.ts:53`). When that is
set, git ignores a repo-local `.git/hooks/pre-push`, so a repo-local hook alone cannot be relied on as a gate (git
behaviour from knowledge; not run).

## A.2 Other measured inputs

- Brain's memory-profile recipients are a never-shrinking union (`src/core/ProfileFormat.ts:256-277`;
  `GitBackend.ts:104-175`). A revoked device therefore keeps decrypting *new* memory-profile writes. No spec in
  either set changes this (ES-02/04 round 4, non-blocking 7).
- ES-01 at `35c66a8` signs only `aigentry-device-v1|` and `aigentry-age-recipient-v1|`. It says the key store exposes a
  *sign* operation "through the lease keeper (ES-03 §5.1)". ES-03 §5.1 at `35c66a8` lists no sign, public-key or
  device-list operation, and names only the dispatch gate and the devkit CLI as callers (ES-01/03 round 2, blocking 1).
- ES-01 at `35c66a8` provides `age_recipient_sig` over `"aigentry-age-recipient-v1|" + hex(public_key) + "|" +
  age_recipient` (§3.1) and the `aigfp1:` 128-bit fingerprint (§8.1 FP). ES-02 at `0cfc523` never makes a writer verify
  that signature, and pins only `fp, created_at, revoked_at, first_seen_by` (ES-02/04 round 4, blocking 3).
- Registry `ac221cd`: `get_real_ip` returns `CF-Connecting-IP` or the first `X-Forwarded-For` value unconditionally
  (`src/aigentry/main.py:75-86`). The limiter follows `enabled=settings.rate_limit_enabled` (`:90-95`). The request
  session rolls back on any exception (`src/aigentry/db/session.py:15-20`).

## A.3 Where brain keeps local state (measured 2026-10-13, brain `0ffa6ee`, git 2.43.0)

- Brain's ignore list is the repo's own `.gitignore`, a tracked work-tree file. `ensureGitignore`
  (`src/backend/GitBackend.ts:58-78`) is called once at init (`:55`) and adds an entry only when the substring is
  absent (`:72`), so a negated entry (`!.aigentry/checkpoint-outbox/`) is never repaired. `git add .`
  (`GitBackend.ts:178`) and `git add -A` (`SyncTick.ts:148`) stage whatever that file allows.
- Brain already keeps other per-device files outside the repo: `~/.aigentry/sync-status.json`
  (`src/status/paths.ts:14`), `~/.aigentry/brain/last-boot-error.json` (`src/shared/BootErrorStore.ts:15`). The repo
  itself defaults to `~/.aigentry/repo` (`src/shared/Config.ts:146`).
- Experiment (local scratch repos; A pulls from a sibling clone B, because the sandbox refuses pushes; repeats the
  joint review's Exp1/Exp2):
  - Exp1: B commits `.aigentry/trust-state.json` with `git add -f`. A's `git pull --rebase` exits 0 and A's ignored
    local `.aigentry/trust-state.json` now holds B's content.
  - Exp2: B commits a `.gitignore` with `!.aigentry/checkpoint-outbox/`. After A's pull, `git add .` + commit puts
    `.aigentry/checkpoint-outbox/…/1.ckpt.age` into A's commit, and `git diff --name-only origin/main..HEAD --
    checkpoints/` is empty.
  - Control: files under `git rev-parse --git-path aigentry` (`.git/aigentry/…`) on A were unchanged after both
    pulls, and appeared in no commit. `git update-index --add --cacheinfo …,.git/aigentry/trust-state.json` is
    refused (`--cacheinfo cannot add`). That git also refuses to check out a crafted tree entry under `.git/` is
    from knowledge, not run.

# PART B — PROPOSALS

## B.1 The model (closed: nothing outside these sets confers trust)

Per **reader** device `r` (any device that verifies, restores, or computes recipients). Each set is a function of `r`'s
local trust state and the latest successful device-list fetch.

| Symbol | Definition | Source of truth |
|---|---|---|
| `U` | the logged-in `user_id` | ES-01 token, through the keeper |
| `L` | the last successful list fetch: `GET /devices?include=keys&all=true`, owner-filtered, with `server_time` `S(L)` | ES-01 §8 / §8.1 R3, fetched through the keeper (I12) |
| `D` | devices in `L`. Each `d` has `id`, `public_key` (immutable), `fp = aigfp1(public_key)`, `status ∈ {active, expired, revoked}`, `created_at` (server, set once), `revoked_at` (server, set once, may be null), `age_recipient`, `age_recipient_sig`, `age_recipient_set_at` | ES-01 §3.1 |
| `Pin` | per reader: `id → {public_key, fp, created_at, revoked_at, age_recipient, age_recipient_seq, first_seen_by}` for every device the reader has trusted | the reader's **trust state** (I3) |
| `A` | anchors: (a) `r` itself; (b) the root, meaning the device with the earliest `created_at` in `L`, revoked or not, pinned at bootstrap; (c) local anchors the user confirmed on `r` (I11) | trust state |
| `E` | endorsement files `trust/v1/<user_key>/<endorsed>/<endorser>.endorse.json`, each with a reader-side state | brain repo + trust state |
| `T` | **trusted**: the least fixpoint reachable from `A` over endorsements counted by E1–E4 (ES-02 §5.6) | computed |
| `R` | **recipient**: see I5 | computed |
| `X` | items: checkpoint records, capture manifests, and endorsements. Each item has a writer `w(x)`, a server-clock `first_seen_by(x)` (`null` = provisional) and a state `∈ {provisional, accepted, *_UNANCHORED, DEMOTED:<code>, QUARANTINED:<reason>, pending_key, unrecoverable_key}` | trust state (I3) |
| `H` | possible holders, for a file `r` cannot decrypt: devices other than `r` that are in `L`, or pinned and missing from `L`, and are **not revoked** (`active` or `expired`) | computed (I11) |
| refs | `parents`, `resumed_from` and `workspace_capture_id` in a record; `checkpoint_id` in a capture manifest | item content |
| `accepted_on_writer(x, y)` | item `y` referenced by `x` had state `accepted` on `w(x)` when `w(x)`'s pre-push gate ran (I9) | writer's trust state |

**Fresh list.** A **trust refresh** (BR-6) whose list fetch succeeded *in the current pass* (sync pass, restore,
preview, or gate run). Only brain runs it; ES-04 asks brain to run it (I3, I12).
**`first_seen_by(x)`** = `S(L)` of the first successful fetch that **started after** `x` was in the reader's local tree
(blob observed). The refresh holds the trust-state lock (BR-6) from before its fetch starts until it has written the
result, and recording an observation takes the same lock, so every entry it binds was observed before its fetch
started. It is bound to the path **and** the Git blob id, so it is assigned to ciphertext the reader cannot yet
decrypt (`pending_key`), and a changed blob does not inherit it. **No other file inherits it either**: a rekey sibling,
a conflict sibling or any other path that decrypts to the same `checkpoint_id` is observed and bound in its own
right, and an item read from a file is anchored only by that file's bound (I6).

**Shown** (I5, R6). A notice is **shown** when brain has written its text to a **terminal**: the stderr of an
`aigentry-brain` CLI command (`trust refresh`, `trust bootstrap`, the endorse command, ES-02 §5.6) for which
`isatty(2)` is true, including `trust refresh` run by ES-04 with ES-04's own terminal stderr passed through. Brain sets
`shown_at` in the same trust-state write. Nothing else counts: not a gate run, an MCP sync pass or a P2 tick (no
terminal), and **not an MCP tool result**, which is delivered to an agent session that may not display it and, under
N-U4, may be the process that caused the change. Until a notice is shown, every brain MCP tool result carries its text
with "run `aigentry-brain trust refresh` in a terminal to review; checkpoint and capture uploads are held until then".
A notice is keyed by `(kind, device_id, age_recipient_seq)`, so a later rotation is a new notice.

**Local state** (I3, I10 (i), BR-5). Every local-only file of ES-02 and ES-04 lives in the brain repo's **Git
directory**, `<aig> = $(git rev-parse --path-format=absolute --git-common-dir)/aigentry`, run in the brain repo
(`BRAIN_REPO_PATH`, default `~/.aigentry/repo`, brain `src/shared/Config.ts:146`). The common directory is the same
from the main and from any linked work tree, and `git worktree remove` does not delete it (measured 2026-10-13, git
2.43.0, local scratch; `--git-path aigentry` from a linked work tree resolves to `.git/worktrees/<n>/aigentry`, which
that removal deletes). Brain resolves it and prints it (BR-6); ES-04 uses brain's printed path, never its own guess: the trust
state `<aig>/trust-state.json` and its lock `<aig>/trust-state.lock`, the cache `<aig>/checkpoint-index.json`, the
checkpoint outbox `<aig>/checkpoint-outbox/`, ES-04's capture outbox `<aig>/capture-outbox/`, seen-ref list
`<aig>/capture-seen.json` and lock `<aig>/capture.lock`. No pull, checkout or `git add` reads or writes there,
whatever `.gitignore` says (A.3). Nothing security-relevant is kept in the work tree or depends on `.gitignore`.
Deleting or re-cloning the brain repo deletes this state, and the device is then a fresh device (I3).
## B.2 Operations

| Operation | Who | Effect on the model |
|---|---|---|
| register | ES-01 `/devices/authorize` + approve + token | adds `d` to `D` with server `created_at`; nothing in `T` or `R` |
| trust refresh | brain only (`aigentry-brain trust refresh`, BR-6); the list itself through the keeper (I12). ES-04 calls the command and reads the persisted result | new `L`; under the trust-state lock: assigns `first_seen_by`, re-evaluates (I8), computes `T` and `R`, records R6 notices and prints those whose `shown_at` is null, setting `shown_at` only on a terminal (§B.1 "Shown"), writes the trust state |
| revoke | ES-01 `DELETE /devices/{id}` | sets `revoked_at` once; takes effect for `r` at `r`'s next fresh list (I8, I10) |
| endorse | the user on a device `e ∈ T ∩ active`, after a fingerprint comparison; signed through the keeper (I12) | adds a file to `E`; counted on readers per E1–E4 |
| write | ES-02 `brain_checkpoint_write`, ES-04 capture | signed through the keeper; encrypted to `R`; state `written` in the outbox (local only) |
| rekey | ES-02 only, on an active device after a fresh list in which `R` holds a recipient `(device_id, age_recipient_seq)` not in the persisted `rekeyed_for` set (a new recipient, or a rotation once shown, I5), for its own `accepted` records | writes one sibling of each unchanged signed record to the outbox (`written`; its `<n>` is assigned at push, I10 (ii)); adds those `(device_id, age_recipient_seq)` pairs to `rekeyed_for` once every sibling is written; it leaves the device only through push (I10). Captures are never rekeyed (N-U5) |
| push | the pre-push gate (I10), and nothing else | fresh list → re-evaluate → reference check (I9) → re-wrap to `R` → commit → push |
| pull | brain P1/P2 pull, ES-04 fetch by id | new blobs enter the local tree; brain records them in `observed` under the trust-state lock; `first_seen_by` waits for the next fresh list. A pulled tracked path under `.aigentry/`, or a tracked symlink at or under `checkpoints/` or `trust/`, is `CHECKPOINT_REPO_TAMPERED`: reported, never read as state, never followed (I3). A pull that git refuses because a pulled commit holds an invalid path (e.g. a tree entry under `.git/`) is reported the same way (BR-5) |
| re-evaluate | every fresh list | I8 |
| rebuild index | after corruption or `kill -9` | rebuilds only the cache (cursor, heads); never the trust state (I3) |
| anchor-recover | the user on `r`, only when I11 fires | adds a local anchor to `A` on `r` only |

## B.3 Invariants

Each invariant names the ES-01 obligation (or "none"), the ES-02/ES-04 obligation, and the test rows in each spec.
"Rows" lists the spec row and case. Columns *Measures / Does not measure / Runnable now / Blocked on* are in each
spec's matrix (ES-01 §15.1, ES-02 §12, ES-04 §8). Every row cited here is a Linux fixture or BLOCKED. A Linux-fixture PASS
proves only that row's *Measures* column and never counts as cross-platform or real-endpoint PASS (requirement line 52).
No row has been run; nothing is implemented. I9 has no ES-01 row, because it involves no ES-01 data.

| # | Invariant | ES-01 obligation | ES-02 / ES-04 obligation | Tests |
|---|---|---|---|---|
| I1 | **Per user.** Trust, acceptance and recipients are computed only from `U`'s own authenticated list. An item under another `user_key` / `user_id` never counts. | The list is owner-filtered in the same SQL statement (§7.3); device bearer only; 404 for not-owned (§7.4) | ES-02 §5.4 rule 4, E1; ES-04 §6.1 `RESTORE_USER_MISMATCH` | ES-01 ID-3, ID-21; ES-02 CK-04, CK-21 (d); ES-04 WS-10 (a)(b) |
| I2 | **Server clock only.** Every decision that *accepts*, *trusts* or *anchors* uses only ES-01 `created_at`, `revoked_at`, and `first_seen_by` derived from `server_time`. Writer-clock fields (record / manifest / endorsement `created_at`) are **never used to accept or anchor**. They may only reject (`created_at ≥ revoked_at` → `*_DEVICE_REVOKED`). | `created_at`, `revoked_at` server clock, set once, never moved; `server_time` in every list response (§3.1, §8.1 R4, R6) | ES-02 §5.4 rule 5, E3, §4.2; ES-04 §6.1 | ES-01 ID-21; ES-02 CK-11 (iv-a); ES-04 WS-10 (e) |
| I3 | **Pins are monotone and durable.** A change of a pinned `fp`, `created_at`, `revoked_at` or verified `age_recipient` that is not a validly signed rotation (I5), or a disappearing `revoked_at`, or a pinned device missing from a later list, is a registry fault. It is surfaced (R6). For `revoked_at` the earlier of pinned and listed is used, and a revoke is never undone; every other pinned field keeps its pinned value. A pinned device missing from the list leaves `T` (I8). Pins, anchors, endorsement states and every item's `first_seen_by` / state / `restored_at` live in **one trust state per device**, at `<aig>/trust-state.json` in the brain repo's Git directory (§B.1 "Local state"), never in the work tree and never behind `.gitignore` (BR-5). Brain is its **only writer**: every write is a read-modify-write under the trust-state lock (BR-6), committed atomically (tmp → fsync → rename). It is never rebuilt from the repo or the registry, and no repo file is ever read as trust state: a pulled tracked path under `.aigentry/` is `CHECKPOINT_REPO_TAMPERED` (reported, never read). If it is lost or corrupt, the device is a fresh device: bootstrap confirmation again, all `first_seen_by` from the next fresh list, no item accepted until then. | `public_key` immutable per id; revoked rows kept with `created_at`, `revoked_at`, `public_key`, `age_recipient`, `age_recipient_sig` for the account's life (D-ID-5, pending user decision; bundle 2d default) | ES-02 §4.1/§4.2 trust state and its location, §5.4 trust refresh, §8 retention; ES-04 consumes the same trust state read-only, after asking brain to refresh it (ES-04 §4 step 5, §6.1), and keeps only its own seen-ref item list (`<aig>/capture-seen.json`) | ES-01 ID-21; ES-02 CK-06 (trust state survives `kill -9`; deleted trust state → fresh-device behaviour), CK-21 (c), CK-27 (pulled tracked state path; pulled `.gitignore` edit; concurrent writers); ES-04 WS-10 (h) |
| I4 | **Trust.** `T` is the least fixpoint from `A` over endorsements counted by E1–E4. Nothing else confers trust: not a registry listing, a repo file, a **reference**, a writer-clock field, or another user's list. A local anchor is added only by the user on that reader, only when I11 allows it, after comparing the fingerprint the anchored device computes from its own key. | FP format and the canonical signed form (`aigfp1:` + 32 lowercase hex, no dashes) (§8.1 FP); `fingerprint_local` from the keeper's `public_key` operation, never from a registry response (I12) | ES-02 §5.6 E1–E4 (E4 has one clause, `first_seen_by`); ES-04 §6.1 uses `T` from the trust state | ES-01 ID-22; ES-02 CK-11 (iv), CK-21 (d)(e); ES-04 WS-10 (e) |
| I5 | **Recipient.** `d ∈ R` ⟺ `d ∈ T` ∧ `status = active` ∧ learned under a fresh list ∧ `age_recipient_sig` verifies with `d`'s **pinned** `public_key` over `"aigentry-age-recipient-v1|" + hex(public_key) + "|" + age_recipient_seq + "|" + age_recipient` ∧ `age_recipient_seq` ≥ the highest seq this reader has verified for `d`, pinned or in a notice (lower, or equal with a different `age_recipient`, is a replayed older value: a registry fault) ∧ the `age_recipient` **equals the pinned one**. The pinned `age_recipient` and its seq are set or changed **only when the change is shown** (§B.1 "Shown"): at the bootstrap confirmation, or when the R6 notice of an addition or of a validly signed rotation is written to a terminal. A refresh without a terminal (gate, MCP sync pass, P2 tick, ES-04 without a terminal) records the notice with `shown_at: null` and leaves the pin as it is. **While some `d ∈ T` with `status = active` has a verified `age_recipient` that differs from its pin, or has no pinned one, and its notice is not shown, the gate holds every checkpoint and capture push** (`CHECKPOINT_PUSH_HELD` / `CAPTURE_PUSH_HELD`, reason `RECIPIENT_CHANGE_UNSHOWN`; outbox objects stay `written`; the profile push continues), so a change is neither used nor silently left out before a user has seen it. Removals (revoke, leaving `T`, `status ≠ active`, a signature or seq fault) take effect at once and never hold. An `expired` device that re-binds with its pinned recipient is not a change. The reader itself uses its **local** age public key, never the registry's value; a differing registry value is a registry fault. A signature failure removes `d` from `R` and raises a registry-fault notice. Only `R` receives new records and captures. | Store and return `age_recipient_sig` and `age_recipient_seq`; the registry **refuses** `/devices/authorize` and `PUT /devices/me/age-recipient` when the signature does not verify or the seq is not greater than the stored one (defence in depth, never the trust basis); only the keeper signs this prefix (I12) | ES-02 §4.1, §5.4 trust refresh and gate step 1, §5.6 "Recipient"; ES-04 §4 step 4 (R from the refreshed trust state), step 5 (hold) | ES-01 ID-21, ID-23 (c); ES-02 CK-21 (f), (f3) replay, (f4) headless rotation, CK-11b headless addition; ES-04 WS-16 (f), (j) incl. the brain-pass-first variant |
| I6 | **Acceptance under revocation.** An item `x` of a writer with `revoked_at` is accepted only if `created_at(x) < revoked_at` (necessary, never sufficient) **and** `first_seen_by(f) < revoked_at`, where `f` is the file (path + Git blob id; for a capture, the ref's commit id) from which this reader decrypted and verified `x`. **Acceptance is per file read; no bound transfers between files.** A rekey sibling, a conflict sibling or a re-pushed blob carries its own `first_seen_by`. A record seen earlier only as ciphertext (`pending_key`) is anchored by that early bound only if that same file later decrypts. Two files that decrypt to one `checkpoint_id` with different `content_sha256` are `CHECKPOINT_KEY_CONFLICT`, both surfaced, and neither inherits from the other. The writer signature covers `user_id\|checkpoint_id\|content_sha256` and is verified on the file read, so a forged sibling either fails it or is a different signed content judged by its own late bound. **No reference anchors anything**: being listed in `parents`, `resumed_from`, `workspace_capture_id` or `checkpoint_id` of any record confers nothing on any reader. Otherwise `*_REVOKED_WRITER_UNANCHORED`, restored only by an explicit user choice on that reader. That choice is local: it changes nothing on other readers. | `revoked_at` server clock, never moved (§8.1 R4) | ES-02 §4.2 (per-file `first_seen_by`, no inheritance), §5.4 rule 5 (reference clause deleted), E4; ES-04 §6.1 (per-commit bound) | ES-01 ID-21; ES-02 CK-11 (ii), (vi-c), CK-23; ES-04 WS-10 (c)(g) incl. the (g) reference variant |
| I7 | **Stale cache.** Items observed with no successful list fetch since are `provisional`. *May*: list, and restore labelled `provisional (device list as of …)`, a record whose writer is already confirmed trusted and non-revoked in the cache. *May not*: count an endorsement, add a trusted device, recipient or anchor, anchor anything, or be pushed past the gate (I9, I10). | `server_time` in every list response | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ES-01 ID-23 (d) (`server_time` in the list through the keeper); ES-02 CK-11 (vi) before refresh; ES-04 WS-10 (g) before refresh |
| I8 | **Re-evaluation.** Every fresh list, in order: assigns `first_seen_by`; recomputes `T` and `R`; and re-checks items. For a device whose `revoked_at` is new, it re-checks **all** of its items, so the writer-clock test (I2) also rejects an item first seen before the revoke but dated ≥ `revoked_at`, and old and fresh readers agree. For a device that **left `T`** without a revoke, it re-checks **all** of its items, which become `*_WRITER_UNKNOWN`. Failures are demoted (`DEMOTED:<code>`), never deleted. A demoted item leaves the heads, an earlier restore is reported with `restored_at`, and the cascade runs through endorsements. | list carries every state change (§8.1 R6) | ES-02 §5.4 "Re-evaluation"; ES-04 §6.1 | ES-01 ID-21, ID-23 (d); ES-02 CK-11 (vi) after refresh, (vii), CK-25; ES-04 WS-10 (g) after refresh |
| I9 | **References do not travel unaccepted.** At the gate, after the fresh list and I8, a record or capture whose refs point to an item that is **not** `accepted` on the writer (provisional, `*_UNANCHORED` even if user-restored, demoted, quarantined, unknown) is **held** (`CHECKPOINT_REFERENCE_HELD` / `CAPTURE_REFERENCE_HELD`; state stays `written`). It is released when the item becomes accepted, or when the user confirms the push after the disclosure "this continuation contains content from `<id>`, which your devices do not accept (`<code>`); it will be pushed under this device's signature. Other devices will still not accept `<id>`". The confirmation is per referenced item and never changes that item's state anywhere (I6). Items written by the writer itself are accepted on it. A `workspace_capture_id` counts as accepted on brain's gate only when it names a capture the writer itself wrote; brain reads no ES-04 state. On the ES-04 gate the state of a `checkpoint_id` is read from the trust state **written by the trust refresh this gate run requested** (BR-6), never from an older saved state; without that refresh the capture is held (`CAPTURE_PUSH_HELD`). | none (no ES-01 data involved) | ES-02 §5.4 gate step 3; ES-04 §4 step 5 | ES-02 CK-11 (vi-c), CK-26; ES-04 WS-16 (g), (j) |
| I10 | **Every push is gated.** No push sends a checkpoint or capture object encrypted to a device outside `R` of a fresh list. (i) **Every** writer of a checkpoint file (a new record, a rekey sibling, the one-time import) writes only to the outbox `<aig>/checkpoint-outbox/` in the Git directory, which no `git add` can stage whatever `.gitignore` says (§B.1, A.3). A checkpoint file that is not on `origin/main` is under `checkpoints/`, in the work tree or in a local commit, **only during a gated push attempt**. "Not on `origin/main`" means added or modified: `git diff --name-only --diff-filter=d origin/main..HEAD -- checkpoints/` (deletions, e.g. retention expiry, are not leftovers). If the attempt fails or crashes, the range is rebuilt and the file returns to the outbox: on failure at once, after a crash by the gate's startup check, which also moves back any uncommitted file under `checkpoints/`. Outside that window neither `origin/main..HEAD` nor the uncommitted work tree holds a `checkpoints/` path that is not on `origin/main`. (ii) Each gated push holds the one repo lock (BR-1) from its trust refresh to the end of the push: trust refresh (fresh list → I8) → hold while a recipient change is unshown (I5) or a symlink is at or under `checkpoints/` or `trust/` in `HEAD` or the work tree (BR-5) → leftover check → I9 (new records only) → drop every rekey sibling whose record is no longer `accepted` → **re-wrap every outbox object, new record or rekey sibling, to `R`** (the gate keeps no record of earlier recipients) → assign each sibling's `<n>` after the pull, never overwriting a path that exists (an existing path with equal `content_sha256` is a no-op) → move into `checkpoints/`, opening every path component without following symlinks → commit → push. (iii) If the list cannot be fetched, the push is held (D-8 (b), pending user decision; bundle 2g default "hold"). (iv) Every brain push path (A.1: P1 with all its callers, P2) runs the gate, or refuses to push while `origin/main..HEAD` adds or modifies a path under `checkpoints/`. (v) An unpushed capture is kept outside `refs/`, in a capture outbox inside the brain repo's Git directory (ES-04 §4 step 5), which no `git add` can stage. The ES-04 gate holds `<aig>/capture.lock`, creates its local ref only inside a gated attempt and deletes it if the push fails, so a user's `git push --mirror` or `refs/*` refspec finds no unpushed capture outside that window. After a crash the window lasts until the next ES-04 run (captures are explicit commands, so possibly days); what a mirror push sends in it is wrapped to `R` of the crashed attempt's fresh list, the same residual as a checkpoint crash. **Until brain implements (iv) for every measured path, and BR-5/BR-6, checkpoint upload is disabled and the rekey pass does not run**: records stay `sync: local_only` (reason `push_gate_missing`), whatever the D-7 opt-in says. It is not "guarded". | the list fetch through the keeper (I12); `server_time` | ES-02 §4.4, §5.3 rekey pass, §5.4 gate; ES-04 §4 step 5; brain requirements BR-1..BR-3, BR-5 (B.5) | ES-02 CK-20 (a)–(d), (e) P2 `sync --tick`, (f) crash window, CK-24 (rekey sibling, uncommitted leftover, lock, (e) demoted after step 1, (f) `<n>` collision, (g) retention), CK-27 (b) pulled `.gitignore` edit, (d) pulled tracked symlink; ES-04 WS-16 (e), (i) mirror push and crash window; ES-01 ID-23 (d) (list through the keeper) |
| I11 | **Recovery is scoped.** `TRUST_ANCHOR_REQUIRED` is raised only when all hold: (1) a fresh list in this pass; (2) `T` has no active device other than `r`; (3) `L` lists at least one active device `c ≠ r` with `created_at(c) < created_at(r)` (an older candidate). The prompt lists only such candidates. Otherwise there is no prompt. On a device that is *older* than every untrusted active device, those devices appear in the normal R6 endorsement prompt. With **no** active device other than `r` (a user's first device, or a **lone survivor** whose others are all revoked, expired or lost), there is no prompt and `r` proceeds as the only active trusted device; an `expired` older device that re-binds becomes an active candidate, and the trigger then fires. **Key-state codes are defined only by what `r` can compute** from its fresh list and its own key, because age stanzas do not name recipients and no recipient list is stored. They use `H` (§B.1), the **non-revoked** devices other than `r`: an `expired` device re-binds with the same `device_id` and key (ES-01 §5, ID-7) and may still hold and rekey the record; only `revoked` is terminal (ES-01 §8.1 R4). For a file `r` cannot decrypt: `H` empty → `CHECKPOINT_UNRECOVERABLE_KEY` / `RESTORE_UNRECOVERABLE_KEY` (non-claim N-U1), and that file keeps the code (state `unrecoverable_key`; it is not re-computed when a device registers later, because a later device can receive the record only from a non-revoked holder, and there was none); otherwise a checkpoint is `CHECKPOINT_PENDING_KEY`, listing the devices of `H` with the text "readable here only if one of them holds it and re-wraps it for this device; this device cannot tell whether any of them can", plus, for each `expired` one, "may become readable after `<name>` logs in again (`aigentry-devkit login`)", and never a promise that it will resolve. A capture is then `RESTORE_NOT_A_RECIPIENT` (terminal, N-U5). A root revoke is **permanent**: the root is the earliest `created_at`, revoked or not, and revoked rows are kept, so every later fresh device without a non-revoked chain must anchor once. | `created_at` server clock, set once, kept for revoked rows (D-ID-5, pending user decision); `status` tells `expired` (re-binds the same row and key, §5) from `revoked` (never re-bound, R4), and the list includes both (R3) | ES-02 §5.6 bootstrap and recovery, §5.3 (codes; rekey cursor per `(device_id, age_recipient_seq)`); ES-04 §6.1 / WS-11 | ES-01 ID-7, ID-21; ES-02 CK-03 (c)(d)(e)(f)(g), CK-21 (g), CK-24 (h) rotation; ES-04 WS-11 (variants incl. expired peer) |
| I12 | **One signer, one list fetcher, one trust-state writer.** The device private key is used only inside the devkit lease keeper (ES-03 §5.1). The keeper offers `sign(prefix, payload)` with the prefix allowlist `aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|`, `aigentry-endorsement-v1\|`, and refuses every other prefix. `aigentry-device-v1\|` and `aigentry-age-recipient-v1\|` are signed only inside the keeper's own `login`, refresh and `register_age_recipient` operations. It also offers `public_key()` / `fingerprint()`, `device_list()` (proxied `GET /devices?include=keys&all=true` with `server_time`) and `device_me()`. Brain (ES-02) and the ES-04 CLI are callers and start the keeper on demand. ES-04 uses `sign` only: it obtains the list and the trust state through brain's trust refresh (BR-6), and brain is the only writer of the trust state. If the keeper is unavailable, no record or capture is written and no checkpoint or capture push runs (brain's profile push is not affected): `CHECKPOINT_IDENTITY_MISSING` / `CAPTURE_IDENTITY_MISSING`. Running the keeper is D-Q-9 (pending user decision; bundle 4d default "on demand"). | ES-01 §8.1 R1, FP; ES-03 §5.1 operations, callers, D-Q-9 "Blocks" | ES-02 §5.1 precondition "sign operation available", §5.4 trust refresh; ES-04 §4 step 1, step 5 | ES-01 ID-23 (a)(b); ES-02 CK-22, CK-27 (c); ES-04 WS-16 (h), (j) |

**B.3 — verified by author (revision 4, 2026-10-13).** Re-run of the table above after this cycle's edits, against
ES-01/ES-03 in clone `aigentry-orchestrator-wt-1204-idq` (`638daee`; `83b2766` → `638daee` changes only the R5 wording and the ADR header) and ES-02/ES-04
in this clone. Rules are cited by section. "Counter-example" is the attack or case the author traced through those rules.
This column is the author's own check, not a review verdict (Rule 39). The reviewer re-checks it.

| # | ES-01 / ES-03 rule(s) | ES-02 / ES-04 rule(s) | Test rows | Counter-example traced → outcome |
|---|---|---|---|---|
| I1 | ES-01 §7.1 device bearer, §7.3 owner filter, §7.4 identical 404, §8.1 R3 | ES-02 §5.4 rules 2, 4; §5.6 E1; ES-04 §6.1 `RESTORE_USER_MISMATCH` | ID-3, ID-17, ID-18, ID-21; CK-04, CK-21 (d); WS-10 (a)(b) | U2 pushes into U1's repo → writer not in U1's list → `*_WRITER_UNKNOWN`. Holds |
| I2 | ES-01 §3.1 `created_at`/`revoked_at`, §8.1 R3 `server_time`, R4 | ES-02 §4.2 `first_seen_by`, §5.4 rule 5, §5.6 E3; ES-04 §6.1 | ID-21; CK-11 (iv-a), CK-25; WS-10 (e) | Backdated item → accepted only through a per-file server bound. Holds |
| I3 | ES-01 §3.1 immutable `public_key`, §8.1 R5 (change or disappearance = fault), D-ID-5 | ES-02 §4.1/§4.2 `<aig>/trust-state.json` (Git directory), §5.4 trust refresh and lock, §8; ES-04 §6.1 (reads it after a refresh; `RESTORE_TRUST_STATE_MISSING`) | ID-21; CK-06, CK-21 (c), CK-11 (vii), CK-27; WS-10 (h) | Registry clears `revoked_at` → earlier value used, B stays revoked. Trust state deleted → fresh device; ES-04 stops and points to `aigentry-brain trust bootstrap`. Joint round 2 Exp1 (revoked B pushes a force-added `.aigentry/trust-state.json`; re-run in A.3) → the pulled file lands in the work tree, which brain never reads; `CHECKPOINT_REPO_TAMPERED`; `<aig>/trust-state.json` unchanged. A brain MCP pass, a P2 tick, `trust bootstrap` and an ES-04-requested refresh at once → serialized by the trust-state lock, no lost update. Holds |
| I4 | ES-01 §8.1 FP, R1 (`fingerprint()` via the keeper), R5 | ES-02 §5.6 anchors, E1–E4; ES-04 §6.1 | ID-22; CK-11 (iv), CK-21 (d)(e), CK-27 (a); WS-10 (e)(f) | Cycle, reference, registry listing → no trust. A pulled file with a forged `anchors` entry → never read (I3). A same-uid endorsement → N-U4 (stated, not prevented). Holds within N-U4 |
| I5 | ES-01 §3.1 `age_recipient_sig`, §8 (422), §8.1 R2; ES-03 §5.1 `register_age_recipient` | ES-02 §4.1, §4.2 `notices`, §5.4 trust refresh and gate step 1, §5.6 "Recipient"; ES-04 §4 steps 4, 5 | ID-21, ID-23 (c); CK-21 (f)(f3)(f4), CK-11b; WS-16 (f), (j) | Substituted recipient without a valid signature → not in `R`. Registry replays B's older validly signed recipient → its seq is below the highest verified one → registry fault, B not in `R` (CK-21 (f3)). Joint round 3 scenario: B rotates (seq 2, possibly a same-uid agent); A's AutoCommitter debounce starts a push → the gate's refresh has no terminal, records the notice `shown_at: null`, keeps the pin at seq 1, sees an active trusted device whose verified recipient differs from its pin → `CHECKPOINT_PUSH_HELD` (`RECIPIENT_CHANGE_UNSHOWN`); no blob is wrapped to either key of B; the MCP results carry the notice; after `trust refresh` on a terminal, pin = seq 2 and the next push wraps to it (CK-21 (f4)). The same with a pulled endorsement of D (CK-11b). Rollback of the unshown seq 2 to seq 1 → below the highest verified seq (the notice's) → fault. ES-04 after a brain pass → the notice is still unshown, so ES-04's refresh prints it on its terminal, then pushes (WS-16 (j)). Holds within N-U4 (pseudo-terminal) |
| I6 | ES-01 §8.1 R4, R5 ("no other path, and no reference") | ES-02 §4.2 (per-file bound, `seen` keyed by file, no inheritance), §5.4 rule 5, §5.6 E4; ES-04 §6.1 (bound per ref commit; a checkpoint reference anchors nothing) | ID-21; CK-11 (ii)(vi-c), CK-23, CK-27 (a); WS-10 (c)(g) incl. the reference variant | Exp1 with forged `observed`/`seen` → never read (I3). Joint-review scenario: C holds B's P as `pending_key` (S1 < T); B pushes a backdated sibling r′ after T → the sibling's own bound S2 > T → `CHECKPOINT_REVOKED_WRITER_UNANCHORED`. Same content re-pushed → also unanchored (D-8 cost). D, which accepted r from P, sees r′ → `CHECKPOINT_KEY_CONFLICT`. Holds |
| I7 | ES-01 §8.1 R3 `server_time`; ES-03 §5.1 `device_list()` | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ID-23 (d); CK-11 (vi); WS-10 (g) | Provisional endorsement → counts for nothing; provisional record continued → held (I9). The rekey pass runs only after a fresh list and only on `accepted` records. Holds |
| I8 | ES-01 §8.1 R6, revoke-semantics row (all items re-checked) | ES-02 §5.4 "Re-evaluation" (all items of a newly revoked device; all items of a device that left `T`); ES-04 §6.1 | ID-21, ID-23 (d); CK-11 (vi)(vii), CK-25; WS-10 (g) | Writer clock ahead, first seen before T → now demoted on the old reader too (non-blocking 9 closed). Holds |
| I9 | none | ES-02 §5.4 gate step 3 (new records only; foreign capture ids held); ES-04 §4 step 5 | CK-11 (vi-c), CK-26, CK-24 (e); WS-16 (g), (j) | Rekey sibling → exempt from step 3, but dropped after step 1 if its record is no longer accepted. A continuation naming another device's capture → held. Capture naming B's record r, B newly revoked, no brain pass since → the ES-04 gate's trust refresh demotes r first → `CAPTURE_REFERENCE_HELD`; brain down → `CAPTURE_PUSH_HELD`. Holds |
| I10 | ES-01 §8.1 R1 (`device_list()` via the keeper), revoke-semantics row; ES-03 §5.1 | ES-02 §4.4, §5.3 rekey pass (outbox only, persisted `rekeyed_for`, disabled with upload), §5.4 gate (Git-directory outbox for every writer, "adds or modifies", uncommitted leftovers, repo lock from step 1, sibling re-check, `<n>` after the pull), §7 import via the outbox; ES-04 §4 step 5 (capture outbox in the Git directory, ref only inside a gated attempt, `capture.lock`, stated crash window); BR-1..BR-3, BR-5 | ID-23 (d); CK-20 (a)–(f), CK-24, CK-27 (b); WS-16 (e)(i) | Joint round 2 Exp2 (pulled `.gitignore` negates the outbox entry; re-run in A.3) → the outbox is in the Git directory, so `git add .` / `add -A` cannot stage it (CK-27 (b)). Retention-expiry commit → deletions only, not a leftover. Two rekeyers pick the same `<n>` → the second picks the next free `<n>` after its pull. Joint-review round 1 scenario: A's cache lists B, the rekey pass runs → siblings only in the outbox; AutoCommitter / P2 / manual push carry no `checkpoints/` path; the gate re-wraps to the fresh R. Crash between move and commit → start-up check before any commit. `git push --mirror` → no unpushed capture ref. Pulled tracked symlink `checkpoints/v1 -> ../.git/aigentry` → `CHECKPOINT_REPO_TAMPERED`, gate holds, no move follows it (CK-27 (d)). Pulled `.git/` tree entry → pull refused, reported, sync stops (availability only; CK-27 (e)). Residual: crash window, stated (CK-20 (f), CK-24 (b), WS-16 (i)). Holds |
| I11 | ES-01 §3.1 `created_at`, `status`, §5 idle expiry re-binds the same row and key, §8.1 R4, D-ID-5 | ES-02 §5.3 (codes from `H`; rekey cursor per `(device_id, age_recipient_seq)`), §5.6 trigger, steps and permanence; ES-04 §5 / §6.1 (`RESTORE_NOT_A_RECIPIENT` terminal, `RESTORE_UNRECOVERABLE_KEY` only when `H` is empty) | ID-7, ID-21; CK-03 (c)–(g), CK-21 (b)(g), CK-11 (v), CK-24 (h); WS-11 | Joint round 3 scenario: A revoked, Mac B `expired`, fresh C → `H` = {B} → `CHECKPOINT_PENDING_KEY` listing B with the re-login hint, never `UNRECOVERABLE_KEY`; B logs in again → active older candidate → `TRUST_ANCHOR_REQUIRED` on C → anchor → B's rekey pass → records restore on C (CK-03 (g)); control B revoked → `UNRECOVERABLE_KEY`, and a later fresh E does not turn C's report into `PENDING_KEY` (sticky). Rotation: B loses its key file and registers seq 2 → once shown on A, `(B, 2)` ∉ `rekeyed_for` → A's pass re-wraps its accepted records → B reads its older records (CK-24 (h)); the `PENDING_KEY` text no longer says "automatic after that device syncs". CK-03 (e) on E: A's records → `CHECKPOINT_PENDING_KEY` listing C with the "cannot tell" text, never a promise (E cannot know that C holds them as unrecoverable). Active non-recipient B, r encrypted to {A}, A revoked, fresh C → `CHECKPOINT_PENDING_KEY` listing B, same text (CK-03 (f)). Fresh C after an anchor: B's old captures stay `RESTORE_NOT_A_RECIPIENT` (no wait promised), and a new capture restores (WS-11 now tests only specified behaviour). Holds |
| I12 | ES-01 §8.1 R1, FP; ES-03 §5.1 identity operations, "Authority", D-Q-9 | ES-02 §5.1, §4.4; ES-04 §4 step 1 | ID-23 (a)(b); CK-22, CK-27 (c); WS-16 (h), (j) | Keeper down → no record, capture or checkpoint/capture push; the profile push continues. ES-04 writes no trust-state byte (file-access audit, WS-16 (j)). Holds |

## B.4 Loopholes closed (dispatch items a–f, review findings)

| Loophole | Closed by | What was removed |
|---|---|---|
| (a) A reference laundered a provisional/backdated record into "anchored" (round 4, blocking 1) | I6 (no reference anchors), I9 (writer holds unaccepted references at the gate) | ES-02 §5.4 rule 5 second clause; the T5 "or referenced by an accepted record" clause; ES-02 §5.6 E4 second clause (co-endorsement). That clause was redundant: a device endorsed by a non-revoked trusted device is in `T` through that edge anyway |
| (b) An unverified `age_recipient_sig` allowed recipient substitution (round 4, blocking 3) | I5, mirrored as an ES-01 obligation (registry refusal, keeper-only signing) | — |
| (c) The gate covered only `GitBackend.push`; P2 `sync --tick` bypassed it (round 4, blocking 4; grounding row 7b WRONG) | I10 (iv) + BR-1..BR-3; I10 (i) makes the unpushed range checkpoint-free outside a gated attempt, so an ungated push (P2 on an old brain, or the user's own `git push`) finds nothing to leak there | ES-02 `unpushed.recipients_fp` (the gate always re-wraps); the rule "compare `recipients_fp` with R for committed files" |
| (d) Recovery fired on a first device and on a single-device user's new device; the lone-survivor case had no outcome (round 4, blocking 2) | I11, N-U1 | ES-02 §5.6 "if the computed set has no active device other than C, C goes to trust-anchor recovery" |
| (e) An index rebuild silently dropped pins (round 4, non-blocking 2) | I3 | ES-02 §8 "rebuilt index sets `first_seen_by` from the first fetch after the rebuild" (replaced by the I3 loss rule) |
| (f) Server clock versus writer clock wording (round 4, non-blocking 4) | I2 | — |
| ES-01/03 round 2, blocking 1: no sign operation, brain not a keeper caller | I12 | ES-02 §5.1 "device signing key readable" |
| (g) A `pending_key` record decrypted from a rekey sibling kept the original path's early `first_seen_by`, so a revoked writer could push a forged backdated sibling under the same `checkpoint_id` (joint review, blocking 1) | I6 (per-file bound), B.1 | ES-02 §4.2 "keeps its early bound once it becomes decryptable"; `seen` keyed by `checkpoint_id` (now keyed by file) |
| (h) The rekey pass wrote siblings into `checkpoints/` with no outbox, gate or recipient rule (joint review, blocking 2) | I10 (i)(ii) and the disabled-until-BR-1 clause | ES-02 §5.3 "writes `<seq>.rekey-<n>.ckpt.age` siblings" as a direct write |
| (i) ES-04 WS-11 expected a capture rekey that no rule defined (joint review, blocking 3) | N-U5: captures are never rekeyed; `RESTORE_NOT_A_RECIPIENT` is terminal | ES-04 `RESTORE_PENDING_KEY`; "the fresh-device key gap applies (ES-02 §5.3)" |
| (j) A user's `git push --mirror` could send an unpushed capture ref wrapped to a stale set (joint review, non-blocking 5) | I10 (v) | ES-04 "local ref created" at `written` |
| (k) Trust state, index and outbox lived in the work tree behind brain's tracked, synced `.gitignore`; a pull could overwrite the trust state or make the outbox committable (joint review round 2, blocking 1; A.3) | I3, I10 (i), §B.1 "Local state", BR-5, `CHECKPOINT_REPO_TAMPERED` | the `.aigentry/…` work-tree locations and "added to the backend's ignore list" |
| (l) `CHECKPOINT_UNRECOVERABLE_KEY` was promised in a case the reader cannot compute (joint review round 2, blocking 2) | I11 key-state codes, N-U1 narrowed | N-U1 "never `pending_key`" outside the lone-survivor case; §5.3 "every recipient of the record is revoked or lost" |
| (m) The ES-04 gate was told to run a re-evaluation that writes a trust state it may only read (joint review round 2, blocking 3) | I3 one writer, I9 refreshed state, I12, BR-6 | ES-04 §4 step 5 "runs the ES-02 §5.4 re-evaluation" |
| (n) A headless refresh (gate, MCP sync pass) recorded `shown_at` while deferring the display, so a rotated or newly endorsed recipient was used in the same push before any user saw it (joint review round 3, blocking 1) | §B.1 "Shown", I5 (pin changes only when shown; unshown change holds the push), BR-6 | ES-02 §5.4 "MCP and the gate show them at the next CLI/MCP interaction) and records `shown_at`"; I5 "recorded … by the trust refresh that showed it to the caller" |
| (o) `*_UNRECOVERABLE_KEY` ("this will not change") was assigned while an `expired` device, which re-binds with the same key, could still hold the records (joint review round 3, blocking 2) | I11 `H` = non-revoked devices; N-U1; sticky once computed (non-blocking 7) | "no active device other than `r`" as the code condition; "revoked or lost" in the N-U1 message |
| (p) An age-key rotation never re-armed the rekey pass, and the `PENDING_KEY` text promised "automatic after that device syncs" (joint review round 3, blocking 3) | §B.2 rekey keyed by `(device_id, age_recipient_seq)`; ES-02 §5.3 text | `rekeyed_for` as a device-id list; "(automatic after that device syncs)" |

## B.5 Requirements on aigentry-brain (not decided here; a brain-side task)

| # | Requirement | Measured basis |
|---|---|---|
| BR-1 | One gate function runs before **every** push of the brain repo: P1 `GitBackend.push` (and therefore every caller in A.1 P1 (a)/(b)), and P2 `SyncTick`'s push (`SyncTick.ts:173`). A path that cannot run it must refuse to push while `origin/main..HEAD` adds or modifies a path under `checkpoints/` (`--diff-filter=d`; deletions are not refused), and report why. **One cross-process repo lock** is held by the gate from its trust refresh to the end of its push, and by every other path that stages, commits or resets in the brain repo (`AutoCommitter`, pull-failure recovery, the TOFU commit, P2 if it is kept). The mechanism is brain's choice | A.1 (no lock today) |
| BR-2 | Startup check, before any commit or push path runs and under the BR-1 lock: if `origin/main..HEAD` adds or modifies a path under `checkpoints/` (crash inside a gated attempt), rebuild the range with `reset --soft origin/main` and move those files back to the outbox; move any uncommitted file under `checkpoints/` that is not on `origin/main` back to the outbox too (crash between the move and the commit) | I10 (i) |
| BR-3 | A repo-local `pre-push` hook that runs the gate is optional belt-and-braces only. It is never counted as coverage, because a global `core.hooksPath` disables it (A.1) | `hooks/index.ts:53` |
| BR-5 | **No security state behind `.gitignore`.** Brain keeps the trust state, its lock, the checkpoint index and the checkpoint outbox in the brain repo's Git directory (`<aig>`, §B.1 "Local state"), never in the work tree, and never relies on `.gitignore` for any file whose disclosure or replacement changes trust, acceptance or recipients. Brain never reads security state from a work-tree path. After every pull it reports a tracked path under `.aigentry/`, or a tracked symlink at or under `checkpoints/` or `trust/` or at `memory-profile.enc.json` (the TOFU write follows symlinks, `GitBackend.ts:162`), as `CHECKPOINT_REPO_TAMPERED` (commit and path named; the file is not read, followed or deleted). While such a symlink is in `HEAD` or the work tree, the gate holds checkpoint pushes, and every gate move opens each path component without following symlinks. A pull that git refuses because a pulled commit holds an invalid path (a tree entry under `.git/`) is reported as `CHECKPOINT_REPO_TAMPERED` "pull refused: invalid path in `<commit>`"; every later pull and brain's recovery fail the same way, so sync stops on every reader until the user repairs the remote (an availability attack, ES-02 §5.3 known limit) | A.3 (Exp1, Exp2, control); joint review round 3 (`.git/` tree entry refused, the pull stays wedged; tracked symlink into `.git/aigentry` reaches `<aig>`) |
| BR-6 | **One trust-state writer and `aigentry-brain trust refresh`.** Every write of the trust state (sync pass observation, trust refresh, gate, `trust bootstrap`, anchor recovery, P2 if it runs the gate) is a read-modify-write under one cross-process trust-state lock (`<aig>/trust-state.lock`). Lock order: repo lock (BR-1) before trust-state lock, never the reverse. `aigentry-brain trust refresh` (same CLI family as `trust bootstrap`, ES-02 §5.6): takes the lock, fetches the list through the keeper, assigns `first_seen_by`, runs the I8 re-evaluation, computes `T` and `R`, prints every R6 notice whose `shown_at` is null to its stderr and sets `shown_at` (and the pin, I5) only when that stderr is a terminal (§B.1 "Shown"), writes the trust state, releases the lock, and prints `{"server_time": …, "aig": "<absolute <aig> path>"}` on success (non-zero exit otherwise). Refreshes run by the gate, the MCP sync pass or P2 record notices with `shown_at: null`; brain MCP tool results carry their text until shown. ES-04 calls it before every capture push and preview, reads `trust-state.json` under the printed `aig`, and uses it only when its `device_list.server_time` is **not earlier than** the printed one (a concurrent refresh can only have made it fresher; I9 holds for any list at least that fresh). The mechanism is brain's choice | review non-blocking 8 (four writers today); blocking 3 |
| BR-4 (coordination, out of this spec set) | Memory-profile recipients never shrink, so a revoked device decrypts new memory writes (A.2). Requirement line 49 is not met for brain memory by ES-02/ES-04. Raised for the orchestrator: brain-side task or ES-01 follow-up | `ProfileFormat.ts:256-277` |

Until BR-1, BR-2, BR-5 and BR-6 are implemented and CK-20 (e)/(f), CK-24 and CK-27 pass, I10 (iv) keeps checkpoint
upload **disabled** (local-only), and the rekey pass does not run.

**Capture upload (one answer for both spec sets and the decision bundle; revision 3).** ES-04 capture upload does
**not** wait on BR-1 or BR-2: brain never pushes `refs/aigentry/*` (A.1), and an unpushed capture lives in an outbox
inside the brain repo's Git directory, outside `refs/` (I10 (v)), so neither brain's `git add` nor a brain push can
carry it. It **does** wait on BR-5 and BR-6: the ES-04 gate reads `R` and checkpoint states from brain's trust state,
which must be out of the work tree (BR-5) and refreshed by brain for this push (BR-6). Until both exist, ES-04 holds
every capture push (`CAPTURE_PUSH_HELD`, captures stay `written`, "saved on this device"). Capture upload also waits
on the ES-04 gate (ES-04 §4 step 5), the keeper (I12, D-Q-9), and the user decisions D-2 / D-6 / D-8 (b) (pending user
decision; bundle 1b, 1e, 2g defaults). The decision bundle's 15:50Z note ("checkpoint/capture 업로드는 … BR-1/BR-2 구현
전까지 비활성") is reported to the orchestrator for correction to: checkpoint upload waits on BR-1/BR-2/BR-5/BR-6;
capture upload waits on BR-5/BR-6 (not BR-1/BR-2).

## B.6 Non-claims

- **N-U1 (unrecoverable key).** Records and captures encrypted only to devices that are all revoked or lost cannot be
  restored by any device, now or later. Data stays readable on devices that already hold a decrypted copy. New devices
  start a new chain from the surviving device. A reader can compute this only when its fresh list shows **no
  non-revoked device other than itself** (`H` empty, I11): age stanzas do not name recipients, no recipient list is
  stored, and an `expired` device can re-bind with the same key and rekey, so only `revoked` is final. Then the code
  is `CHECKPOINT_UNRECOVERABLE_KEY` / `RESTORE_UNRECOVERABLE_KEY`, never success and never `pending_key`, and it
  stays (I11). A lost device that is not revoked still counts as a possible holder; revoking it (`aigentry-devkit
  device revoke`) makes the report final. In every other case such a checkpoint reads `CHECKPOINT_PENDING_KEY` with
  the I11 text ("this device cannot tell whether any of them can"; for an `expired` device the re-login hint),
  possibly forever, and a capture reads the terminal `RESTORE_NOT_A_RECIPIENT`; neither promises resolution. A
  cleartext recipient list per file, which would make more cases computable, is not added (ADR §3). Only a revoked
  device's own modified client could still re-wrap such an item; that file is judged on its own and is never
  accepted without the user's choice (I6). User-facing message for the computable case:
  `"<n> saved items were encrypted only to devices you have revoked (<names>). No device you have can open them, and this will not change. A device that already opened them keeps its copy. This device continues from here."`
- **N-U2 (past ciphertext).** Revocation never removes access to ciphertext pushed before the revoked device left `R`,
  or to a revoked machine's Git access (D-8 (a), pending user decision; bundle 2f default).
- **N-U3 (TOFU).** A fresh device's first trust decision and every local anchor rest on the user's fingerprint
  comparison. A compromised registry at that moment is caught only by that comparison (D-9, pending user decision;
  bundle 2h default). That comparison is of device keys, not of age recipients: `age_recipient_seq` protects only a
  reader that already holds a pin, so a compromised registry can serve a fresh reader a device's older, validly
  signed recipient (one the device rotated away from) and the fingerprint comparison does not catch it. The
  bootstrap confirmation shows each device's `age_recipient_seq` (ES-02 §5.6); nothing more is claimed.
- **N-U4 (same OS user).** The keeper accepts calls from any same-uid process. The OS user is the boundary. A same-uid
  process can also read brain's `0600` age key file, so `register_age_recipient` widens nothing. Every change is
  shown on a terminal of each other device before it is used there, and until then checkpoint and capture pushes
  are held (I5); an MCP tool result does not count as shown. A same-uid process on that other device can itself run
  the CLI under a pseudo-terminal, so "shown" also ends at the OS-user boundary. Any same-uid process, including an unconfined agent CLI (ES-03 §5.1
  "Authority"), can also call `sign` under `aigentry-endorsement-v1|`. The fingerprint comparison before an
  endorsement (I4) is therefore a step of the user interface, **not** something the keeper enforces: a
  prompt-injected agent could endorse a registry-listed device, which then becomes a recipient on every device after
  the R6 notice. User-facing help for endorsement states this. The same holds for **I10**: a same-uid process can
  write under `checkpoints/` or into `<aig>/checkpoint-outbox/` and run `git push` itself. I10 holds for brain's and
  ES-04's code paths and for the user's ordinary pushes of what those paths left, not against a same-uid process that
  pushes its own files.
- **N-U5 (captures are never rekeyed).** A capture is readable only by the devices that were in `R` when its gated
  push ran. A device that was not gets `RESTORE_NOT_A_RECIPIENT`. That outcome is terminal: it does not change when
  another device comes online. The remedy is a new capture on a device that holds the work (ES-04 §5). With no
  non-revoked device other than the reader, the outcome is `RESTORE_UNRECOVERABLE_KEY` (N-U1). An automatic capture rekey
  would re-upload uncommitted code without a capture command, which D-6 (pending user decision; bundle 1e default
  "explicit command only") excludes.

## B.7 Not measured

Real multi-host runs; macOS/Windows; whether a legacy `sync --tick` timer is installed on any host; git's
`core.hooksPath` precedence and `git push --mirror` behaviour (from knowledge); registry or keeper behaviour (none
implemented). A.3 pulled from a sibling clone, not from a hosted remote; git's refusal to check out a crafted tree
entry under `.git/` was measured by joint review round 3 (git 2.43.0, local), not by this author; the age stanza
format (no recipient names) is from knowledge. Revision 4 measured only the `--git-common-dir` resolution (§B.1);
whether `isatty(2)` is true for a given agent CLI's shell tool was not measured. No spec tests were run.
