# SPEC — Interface invariants between ES-01 (identity) and ES-02 / ES-04 (checkpoints, workspace capture) (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-13). No code. Not an implementation, merge, release or install claim.
- Revision 2 (reconciliation cycle 2, 2026-10-13, after the joint review of ES-01/03 `aeb78f8` and ES-02/04/07
  `8331a05`): I6 binds `first_seen_by` to the file actually read (no rekey-sibling inheritance); I10 covers the
  rekey pass, the uncommitted work tree, a repo lock and unpushed captures outside `refs/`; captures are never
  rekeyed (N-U5); I3/I8/I12 wording; N-U4 completed; §B.3 author self-check; §B.5 capture-upload answer.
- Why: the trust/revocation rules were patched case by case in two spec sets, and every review round found a new
  gap between them. This document is the **single model** both sets cite. A rule in ES-01, ES-02 or ES-04 that
  touches trust, recipients, revocation, anchors or pushes must cite an invariant here. If it contradicts one,
  the invariant wins and the spec is defective.
- Specs bound by it:
  - ES-01 `docs/specs/2026-10-12-env-continuity-identity.md` and ES-03 §5.1 (lease keeper), both in clone
    `aigentry-orchestrator-wt-1204-idq`;
  - ES-02 `docs/specs/2026-10-12-env-continuity-context-checkpoint.md` and ES-04
    `docs/specs/2026-10-12-env-continuity-workspace-capture.md`, both in this clone.
- Cited by both ADRs (`docs/adr/2026-10-12-env-continuity-context-and-workspace.md` A13,
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

# PART B — PROPOSALS

## B.1 The model (closed: nothing outside these sets confers trust)

Per **reader** device `r` (any device that verifies, restores, or computes recipients). Each set is a function of `r`'s
local trust state and the latest successful device-list fetch.

| Symbol | Definition | Source of truth |
|---|---|---|
| `U` | the logged-in `user_id` | ES-01 token, through the keeper |
| `L` | the last successful list fetch: `GET /devices?include=keys&all=true`, owner-filtered, with `server_time` `S(L)` | ES-01 §8 / §8.1 R3, fetched through the keeper (I12) |
| `D` | devices in `L`. Each `d` has `id`, `public_key` (immutable), `fp = aigfp1(public_key)`, `status ∈ {active, expired, revoked}`, `created_at` (server, set once), `revoked_at` (server, set once, may be null), `age_recipient`, `age_recipient_sig`, `age_recipient_set_at` | ES-01 §3.1 |
| `Pin` | per reader: `id → {fp, created_at, revoked_at, age_recipient, first_seen_by}` for every device the reader has trusted | the reader's **trust state** (I3) |
| `A` | anchors: (a) `r` itself; (b) the root, meaning the device with the earliest `created_at` in `L`, revoked or not, pinned at bootstrap; (c) local anchors the user confirmed on `r` (I11) | trust state |
| `E` | endorsement files `trust/v1/<user_key>/<endorsed>/<endorser>.endorse.json`, each with a reader-side state | brain repo + trust state |
| `T` | **trusted**: the least fixpoint reachable from `A` over endorsements counted by E1–E4 (ES-02 §5.6) | computed |
| `R` | **recipient**: see I5 | computed |
| `X` | items: checkpoint records, capture manifests, and endorsements. Each item has a writer `w(x)`, a server-clock `first_seen_by(x)` (`null` = provisional) and a state `∈ {provisional, accepted, *_UNANCHORED, DEMOTED:<code>, QUARANTINED:<reason>, pending_key}` | trust state (I3) |
| refs | `parents`, `resumed_from` and `workspace_capture_id` in a record; `checkpoint_id` in a capture manifest | item content |
| `accepted_on_writer(x, y)` | item `y` referenced by `x` had state `accepted` on `w(x)` when `w(x)`'s pre-push gate ran (I9) | writer's trust state |

**Fresh list.** A list fetch that succeeded *in the current pass* (sync pass, restore, or gate run).
**`first_seen_by(x)`** = `S(L)` of the first successful fetch that **started after** `x` was in the reader's local tree
(blob observed). It is bound to the path **and** the Git blob id, so it is assigned to ciphertext the reader cannot yet
decrypt (`pending_key`), and a changed blob does not inherit it. **No other file inherits it either**: a rekey sibling,
a conflict sibling or any other path that decrypts to the same `checkpoint_id` is observed and bound in its own
right, and an item read from a file is anchored only by that file's bound (I6).

## B.2 Operations

| Operation | Who | Effect on the model |
|---|---|---|
| register | ES-01 `/devices/authorize` + approve + token | adds `d` to `D` with server `created_at`; nothing in `T` or `R` |
| list refresh | any reader, through the keeper | new `L`; runs re-evaluate (I8) |
| revoke | ES-01 `DELETE /devices/{id}` | sets `revoked_at` once; takes effect for `r` at `r`'s next fresh list (I8, I10) |
| endorse | the user on a device `e ∈ T ∩ active`, after a fingerprint comparison; signed through the keeper (I12) | adds a file to `E`; counted on readers per E1–E4 |
| write | ES-02 `brain_checkpoint_write`, ES-04 capture | signed through the keeper; encrypted to `R`; state `written` in the outbox (local only) |
| rekey | ES-02 only, on an active device after a fresh list, for its own `accepted` records | writes a `<seq>.rekey-<n>.ckpt.age` sibling of the unchanged signed record to the outbox (`written`); it leaves the device only through push (I10). Captures are never rekeyed (N-U5) |
| push | the pre-push gate (I10), and nothing else | fresh list → re-evaluate → reference check (I9) → re-wrap to `R` → commit → push |
| pull | brain P1/P2 pull, ES-04 fetch by id | new blobs enter the local tree; `first_seen_by` waits for the next fresh list |
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
| I3 | **Pins are monotone and durable.** A change of a pinned `fp`, `created_at`, `revoked_at` or verified `age_recipient` that is not a validly signed rotation (I5), or a disappearing `revoked_at`, or a pinned device missing from a later list, is a registry fault. It is surfaced (R6). For `revoked_at` the earlier of pinned and listed is used, and a revoke is never undone; every other pinned field keeps its pinned value. A pinned device missing from the list leaves `T` (I8). Pins, anchors, endorsement states and every item's `first_seen_by` / state / `restored_at` live in **one trust state per device**. It is written atomically (tmp → fsync → rename), and never rebuilt from the repo or the registry. If it is lost or corrupt, the device is a fresh device: bootstrap confirmation again, all `first_seen_by` from the next fresh list, no item accepted until then. | `public_key` immutable per id; revoked rows kept with `created_at`, `revoked_at`, `public_key`, `age_recipient`, `age_recipient_sig` for the account's life (D-ID-5, pending user decision; bundle 2d default) | ES-02 §4.2 trust state, §8 retention; ES-04 consumes the same trust state read-only (owner: brain, ES-02 §5.6) and keeps only its own seen-ref item list | ES-01 ID-21; ES-02 CK-06 (trust state survives `kill -9`; deleted trust state → fresh-device behaviour), CK-21 (c); ES-04 WS-10 (h) |
| I4 | **Trust.** `T` is the least fixpoint from `A` over endorsements counted by E1–E4. Nothing else confers trust: not a registry listing, a repo file, a **reference**, a writer-clock field, or another user's list. A local anchor is added only by the user on that reader, only when I11 allows it, after comparing the fingerprint the anchored device computes from its own key. | FP format and the canonical signed form (`aigfp1:` + 32 lowercase hex, no dashes) (§8.1 FP); `fingerprint_local` from the keeper's `public_key` operation, never from a registry response (I12) | ES-02 §5.6 E1–E4 (E4 has one clause, `first_seen_by`); ES-04 §6.1 uses `T` from the trust state | ES-01 ID-22; ES-02 CK-11 (iv), CK-21 (d)(e); ES-04 WS-10 (e) |
| I5 | **Recipient.** `d ∈ R` ⟺ `d ∈ T` ∧ `status = active` ∧ learned under a fresh list ∧ `age_recipient_sig` verifies with `d`'s **pinned** `public_key` over `"aigentry-age-recipient-v1|" + hex(public_key) + "|" + age_recipient` ∧ (the `age_recipient` equals the pinned one, or the change was shown in the R6 notice before this use). The reader itself uses its **local** age public key, never the registry's value; a differing registry value is a registry fault. A signature failure removes `d` from `R` and raises a registry-fault notice. Only `R` receives new records and captures. | Store and return `age_recipient_sig`; the registry **refuses** `/devices/authorize` and `PUT /devices/me/age-recipient` when the signature does not verify (defence in depth, never the trust basis); only the keeper signs this prefix (I12) | ES-02 §4.1, §5.6 "Recipient"; ES-04 §4 step 4 | ES-01 ID-21, ID-23 (c); ES-02 CK-21 (f); ES-04 WS-16 (f) |
| I6 | **Acceptance under revocation.** An item `x` of a writer with `revoked_at` is accepted only if `created_at(x) < revoked_at` (necessary, never sufficient) **and** `first_seen_by(f) < revoked_at`, where `f` is the file (path + Git blob id; for a capture, the ref's commit id) from which this reader decrypted and verified `x`. **Acceptance is per file read; no bound transfers between files.** A rekey sibling, a conflict sibling or a re-pushed blob carries its own `first_seen_by`. A record seen earlier only as ciphertext (`pending_key`) is anchored by that early bound only if that same file later decrypts. Two files that decrypt to one `checkpoint_id` with different `content_sha256` are `CHECKPOINT_KEY_CONFLICT`, both surfaced, and neither inherits from the other. The writer signature covers `user_id\|checkpoint_id\|content_sha256` and is verified on the file read, so a forged sibling either fails it or is a different signed content judged by its own late bound. **No reference anchors anything**: being listed in `parents`, `resumed_from`, `workspace_capture_id` or `checkpoint_id` of any record confers nothing on any reader. Otherwise `*_REVOKED_WRITER_UNANCHORED`, restored only by an explicit user choice on that reader. That choice is local: it changes nothing on other readers. | `revoked_at` server clock, never moved (§8.1 R4) | ES-02 §4.2 (per-file `first_seen_by`, no inheritance), §5.4 rule 5 (reference clause deleted), E4; ES-04 §6.1 (per-commit bound) | ES-01 ID-21; ES-02 CK-11 (ii), (vi-c), CK-23; ES-04 WS-10 (c)(g) incl. the (g) reference variant |
| I7 | **Stale cache.** Items observed with no successful list fetch since are `provisional`. *May*: list, and restore labelled `provisional (device list as of …)`, a record whose writer is already confirmed trusted and non-revoked in the cache. *May not*: count an endorsement, add a trusted device, recipient or anchor, anchor anything, or be pushed past the gate (I9, I10). | `server_time` in every list response | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ES-01 ID-23 (d) (`server_time` in the list through the keeper); ES-02 CK-11 (vi) before refresh; ES-04 WS-10 (g) before refresh |
| I8 | **Re-evaluation.** Every fresh list, in order: assigns `first_seen_by`; recomputes `T` and `R`; and re-checks items. For a device whose `revoked_at` is new, it re-checks **all** of its items, so the writer-clock test (I2) also rejects an item first seen before the revoke but dated ≥ `revoked_at`, and old and fresh readers agree. For a device that **left `T`** without a revoke, it re-checks **all** of its items, which become `*_WRITER_UNKNOWN`. Failures are demoted (`DEMOTED:<code>`), never deleted. A demoted item leaves the heads, an earlier restore is reported with `restored_at`, and the cascade runs through endorsements. | list carries every state change (§8.1 R6) | ES-02 §5.4 "Re-evaluation"; ES-04 §6.1 | ES-01 ID-21, ID-23 (d); ES-02 CK-11 (vi) after refresh, (vii), CK-25; ES-04 WS-10 (g) after refresh |
| I9 | **References do not travel unaccepted.** At the gate, after the fresh list and I8, a record or capture whose refs point to an item that is **not** `accepted` on the writer (provisional, `*_UNANCHORED` even if user-restored, demoted, quarantined, unknown) is **held** (`CHECKPOINT_REFERENCE_HELD` / `CAPTURE_REFERENCE_HELD`; state stays `written`). It is released when the item becomes accepted, or when the user confirms the push after the disclosure "this continuation contains content from `<id>`, which your devices do not accept (`<code>`); it will be pushed under this device's signature. Other devices will still not accept `<id>`". The confirmation is per referenced item and never changes that item's state anywhere (I6). Items written by the writer itself are accepted on it. A `workspace_capture_id` counts as accepted on brain's gate only when it names a capture the writer itself wrote; brain reads no ES-04 state. | none (no ES-01 data involved) | ES-02 §5.4 gate step 3; ES-04 §4 step 5 | ES-02 CK-11 (vi-c), CK-26; ES-04 WS-16 (g) |
| I10 | **Every push is gated.** No push sends a checkpoint or capture object encrypted to a device outside `R` of a fresh list. (i) **Every** writer of a checkpoint file (a new record, a rekey sibling, the one-time import) writes only to the gitignored outbox. A checkpoint file that is not on `origin/main` is under `checkpoints/`, in the work tree or in a local commit, **only during a gated push attempt**. If the attempt fails or crashes, the range is rebuilt and the file returns to the outbox: on failure at once, after a crash by the gate's startup check, which also moves back any uncommitted file under `checkpoints/`. Outside that window neither `origin/main..HEAD` nor the uncommitted work tree holds a `checkpoints/` path that is not on `origin/main`. (ii) Each gated push holds the one repo lock (BR-1) from the leftover check to the end of the push: fresh list → I8 → I9 (new records only; a rekey sibling carries an already accepted record and adds no reference) → **re-wrap every outbox object, new record or rekey sibling, to `R`** (the gate keeps no record of earlier recipients) → commit → push. (iii) If the list cannot be fetched, the push is held (D-8 (b), pending user decision; bundle 2g default "hold"). (iv) Every brain push path (A.1: P1 with all its callers, P2) runs the gate, or refuses to push while `origin/main..HEAD` touches `checkpoints/`. (v) An unpushed capture is kept outside `refs/`, in a capture outbox inside the brain repo's Git directory (ES-04 §4 step 5), which no `git add` can stage. The ES-04 gate creates its local ref only inside a gated attempt and deletes it if the push fails, so a user's `git push --mirror` or `refs/*` refspec finds no unpushed capture outside that window. **Until brain implements (iv) for every measured path, checkpoint upload is disabled and the rekey pass does not run**: records stay `sync: local_only` (reason `push_gate_missing`), whatever the D-7 opt-in says. It is not "guarded". | the list fetch through the keeper (I12); `server_time` | ES-02 §4.4, §5.3 rekey pass, §5.4 gate; ES-04 §4 step 5; brain requirements BR-1..BR-3 (B.5) | ES-02 CK-20 (a)–(d), (e) P2 `sync --tick`, (f) crash window, CK-24 (rekey sibling, uncommitted leftover, lock); ES-04 WS-16 (e), (i) mirror push; ES-01 ID-23 (d) (list through the keeper) |
| I11 | **Recovery is scoped.** `TRUST_ANCHOR_REQUIRED` is raised only when all hold: (1) a fresh list in this pass; (2) `T` has no active device other than `r`; (3) `L` lists at least one active device `c ≠ r` with `created_at(c) < created_at(r)` (an older candidate). The prompt lists only such candidates. Otherwise there is no prompt. On a device that is *older* than every untrusted active device, those devices appear in the normal R6 endorsement prompt. With **no** active device other than `r` (a user's first device, or a **lone survivor** whose others are all revoked or lost), there is no prompt and `r` proceeds as the only active trusted device. Its records encrypted only to revoked/lost devices are `CHECKPOINT_UNRECOVERABLE_KEY` (non-claim N-U1). A root revoke is **permanent**: the root is the earliest `created_at`, revoked or not, and revoked rows are kept, so every later fresh device without a non-revoked chain must anchor once. | `created_at` server clock, set once, kept for revoked rows (D-ID-5, pending user decision) | ES-02 §5.6 bootstrap and recovery, §5.3; ES-04 §6.1 / WS-11 | ES-01 ID-21; ES-02 CK-03 (d)(e), CK-21 (g); ES-04 WS-11 (variants) |
| I12 | **One signer, one list fetcher.** The device private key is used only inside the devkit lease keeper (ES-03 §5.1). The keeper offers `sign(prefix, payload)` with the prefix allowlist `aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|`, `aigentry-endorsement-v1\|`, and refuses every other prefix. `aigentry-device-v1\|` and `aigentry-age-recipient-v1\|` are signed only inside the keeper's own `login`, refresh and `register_age_recipient` operations. It also offers `public_key()` / `fingerprint()`, `device_list()` (proxied `GET /devices?include=keys&all=true` with `server_time`) and `device_me()`. Brain (ES-02) and the ES-04 CLI are callers and start the keeper on demand. If the keeper is unavailable, no record or capture is written and no checkpoint or capture push runs (brain's profile push is not affected): `CHECKPOINT_IDENTITY_MISSING` / `CAPTURE_IDENTITY_MISSING`. Running the keeper is D-Q-9 (pending user decision; bundle 4d default "on demand"). | ES-01 §8.1 R1, FP; ES-03 §5.1 operations, callers, D-Q-9 "Blocks" | ES-02 §5.1 precondition "sign operation available"; ES-04 §4 step 1 | ES-01 ID-23 (a)(b); ES-02 CK-22; ES-04 WS-16 (h) |

**B.3 — verified by author (revision 2, 2026-10-13).** Re-run of the table above after this cycle's edits, against
ES-01/ES-03 in clone `aigentry-orchestrator-wt-1204-idq` (this cycle's commit on `aeb78f8`) and ES-02/ES-04 in this
clone. Rules are cited by section. "Counter-example" is the attack or case the author traced through those rules.
This column is the author's own check, not a review verdict (Rule 39). The reviewer re-checks it.

| # | ES-01 / ES-03 rule(s) | ES-02 / ES-04 rule(s) | Test rows | Counter-example traced → outcome |
|---|---|---|---|---|
| I1 | ES-01 §7.1 device bearer, §7.3 owner filter, §7.4 identical 404, §8.1 R3 | ES-02 §5.4 rules 2, 4; §5.6 E1; ES-04 §6.1 `RESTORE_USER_MISMATCH` | ID-3, ID-17, ID-18, ID-21; CK-04, CK-21 (d); WS-10 (a)(b) | U2 pushes into U1's repo → writer not in U1's list → `*_WRITER_UNKNOWN`. Holds |
| I2 | ES-01 §3.1 `created_at`/`revoked_at`, §8.1 R3 `server_time`, R4 | ES-02 §4.2 `first_seen_by`, §5.4 rule 5, §5.6 E3; ES-04 §6.1 | ID-21; CK-11 (iv-a), CK-25; WS-10 (e) | Backdated item → accepted only through a per-file server bound. Holds |
| I3 | ES-01 §3.1 immutable `public_key`, §8.1 R5 (change or disappearance = fault), D-ID-5 | ES-02 §4.2 `trust-state.json`, §8; ES-04 §6.1 (reads it; `RESTORE_TRUST_STATE_MISSING`) | ID-21; CK-06, CK-21 (c), CK-11 (vii); WS-10 (h) | Registry clears `revoked_at` → earlier value used, B stays revoked. Trust state deleted → fresh device; ES-04 stops and points to `aigentry-brain trust bootstrap`. Holds |
| I4 | ES-01 §8.1 FP, R1 (`fingerprint()` via the keeper), R5 | ES-02 §5.6 anchors, E1–E4; ES-04 §6.1 | ID-22; CK-11 (iv), CK-21 (d)(e); WS-10 (e)(f) | Cycle, reference, registry listing → no trust. A same-uid endorsement → N-U4 (stated, not prevented). Holds within N-U4 |
| I5 | ES-01 §3.1 `age_recipient_sig`, §8 (422), §8.1 R2; ES-03 §5.1 `register_age_recipient` | ES-02 §4.1, §5.6 "Recipient"; ES-04 §4 step 4 | ID-21, ID-23 (c); CK-21 (f); WS-16 (f) | Substituted recipient without a valid signature → not in `R`. Holds |
| I6 | ES-01 §8.1 R4, R5 ("no other path, and no reference") | ES-02 §4.2 (per-file bound, `seen` keyed by file, no inheritance), §5.4 rule 5, §5.6 E4; ES-04 §6.1 (bound per ref commit; a checkpoint reference anchors nothing) | ID-21; CK-11 (ii)(vi-c), CK-23; WS-10 (c)(g) incl. the reference variant | Joint-review scenario: C holds B's P as `pending_key` (S1 < T); B pushes a backdated sibling r′ after T → the sibling's own bound S2 > T → `CHECKPOINT_REVOKED_WRITER_UNANCHORED`. Same content re-pushed → also unanchored (D-8 cost). D, which accepted r from P, sees r′ → `CHECKPOINT_KEY_CONFLICT`. Holds |
| I7 | ES-01 §8.1 R3 `server_time`; ES-03 §5.1 `device_list()` | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ID-23 (d); CK-11 (vi); WS-10 (g) | Provisional endorsement → counts for nothing; provisional record continued → held (I9). The rekey pass runs only after a fresh list and only on `accepted` records. Holds |
| I8 | ES-01 §8.1 R6, revoke-semantics row (all items re-checked) | ES-02 §5.4 "Re-evaluation" (all items of a newly revoked device; all items of a device that left `T`); ES-04 §6.1 | ID-21, ID-23 (d); CK-11 (vi)(vii), CK-25; WS-10 (g) | Writer clock ahead, first seen before T → now demoted on the old reader too (non-blocking 9 closed). Holds |
| I9 | none | ES-02 §5.4 gate step 3 (new records only; foreign capture ids held); ES-04 §4 step 5 | CK-11 (vi-c), CK-26; WS-16 (g) | Rekey sibling → exempt from step 3 because it carries an already accepted record. A continuation naming another device's capture → held. Holds |
| I10 | ES-01 §8.1 R1 (`device_list()` via the keeper), revoke-semantics row; ES-03 §5.1 | ES-02 §4.4, §5.3 rekey pass (outbox only, disabled with upload), §5.4 gate (outbox for every writer, uncommitted leftovers, repo lock), §7 import via the outbox; ES-04 §4 step 5 (capture outbox in the Git directory, ref only inside a gated attempt); BR-1..BR-3 | ID-23 (d); CK-20 (a)–(f), CK-24; WS-16 (e)(i) | Joint-review scenario: A's cache lists B, the rekey pass runs → siblings only in the outbox; AutoCommitter / P2 / manual push carry no `checkpoints/` path; the gate re-wraps to the fresh R. Crash between move and commit → start-up check before any commit. `git push --mirror` → no unpushed capture ref. Residual: crash window, stated (CK-20 (f), CK-24 (b), WS-16 (i)). Holds |
| I11 | ES-01 §3.1 `created_at`, D-ID-5 | ES-02 §5.3, §5.6 trigger, steps and permanence; ES-04 §5 / §6.1 (`RESTORE_NOT_A_RECIPIENT` terminal, `RESTORE_UNRECOVERABLE_KEY` for the lone survivor) | ID-21; CK-03 (d)(e), CK-21 (b)(g), CK-11 (v); WS-11 | Fresh C after an anchor: B's old captures stay `RESTORE_NOT_A_RECIPIENT` (no wait promised), and a new capture restores (WS-11 now tests only specified behaviour). Holds |
| I12 | ES-01 §8.1 R1, FP; ES-03 §5.1 identity operations, "Authority", D-Q-9 | ES-02 §5.1, §4.4; ES-04 §4 step 1 | ID-23 (a)(b); CK-22; WS-16 (h) | Keeper down → no record, capture or checkpoint/capture push; the profile push continues. Holds |

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

## B.5 Requirements on aigentry-brain (not decided here; a brain-side task)

| # | Requirement | Measured basis |
|---|---|---|
| BR-1 | One gate function runs before **every** push of the brain repo: P1 `GitBackend.push` (and therefore every caller in A.1 P1 (a)/(b)), and P2 `SyncTick`'s push (`SyncTick.ts:173`). A path that cannot run it must refuse to push while `origin/main..HEAD` touches `checkpoints/`, and report why. **One cross-process repo lock** is held by the gate from its leftover check to the end of its push, and by every other path that stages, commits or resets in the brain repo (`AutoCommitter`, pull-failure recovery, the TOFU commit, P2 if it is kept). The mechanism is brain's choice | A.1 (no lock today) |
| BR-2 | Startup check, before any commit or push path runs and under the BR-1 lock: if `origin/main..HEAD` touches `checkpoints/` (crash inside a gated attempt), rebuild the range with `reset --soft origin/main` and move those files back to the outbox; move any uncommitted file under `checkpoints/` that is not on `origin/main` back to the outbox too (crash between the move and the commit) | I10 (i) |
| BR-3 | A repo-local `pre-push` hook that runs the gate is optional belt-and-braces only. It is never counted as coverage, because a global `core.hooksPath` disables it (A.1) | `hooks/index.ts:53` |
| BR-4 (coordination, out of this spec set) | Memory-profile recipients never shrink, so a revoked device decrypts new memory writes (A.2). Requirement line 49 is not met for brain memory by ES-02/ES-04. Raised for the orchestrator: brain-side task or ES-01 follow-up | `ProfileFormat.ts:256-277` |

Until BR-1 and BR-2 are implemented and CK-20 (e)/(f) and CK-24 pass, I10 (iv) keeps checkpoint upload **disabled**
(local-only), and the rekey pass does not run.

**Capture upload (one answer for both spec sets and the decision bundle).** ES-04 capture upload does **not** wait on
BR-1 or BR-2. Brain never pushes `refs/aigentry/*` (A.1), and an unpushed capture lives in an outbox inside the
brain repo's Git directory, outside `refs/` (I10 (v)), so neither brain's `git add` nor a brain push can carry it.
Capture upload waits on: the ES-04 gate (ES-04 §4 step 5), the keeper (I12, D-Q-9), and the user decisions D-2 / D-6 / D-8 (b) (pending user decision;
bundle 1b, 1e, 2g defaults). The decision bundle's 15:50Z note ("checkpoint/capture 업로드는 … BR-1/BR-2 구현 전까지
비활성") is therefore wrong for captures and is reported to the orchestrator for correction.

## B.6 Non-claims

- **N-U1 (unrecoverable key).** Records and captures encrypted only to devices that are all revoked or lost cannot be
  restored by any device, now or later. Data stays readable on devices that already hold a decrypted copy. New devices
  start a new chain from the surviving device. Code `CHECKPOINT_UNRECOVERABLE_KEY` / `RESTORE_UNRECOVERABLE_KEY`, never
  success and never `pending_key`. User-facing message:
  `"<n> saved items were encrypted only to devices you have revoked or lost (<names>). No device you have can open them, and this will not change. A device that already opened them keeps its copy. This device continues from here."`
- **N-U2 (past ciphertext).** Revocation never removes access to ciphertext pushed before the revoked device left `R`,
  or to a revoked machine's Git access (D-8 (a), pending user decision; bundle 2f default).
- **N-U3 (TOFU).** A fresh device's first trust decision and every local anchor rest on the user's fingerprint
  comparison. A compromised registry at that moment is caught only by that comparison (D-9, pending user decision;
  bundle 2h default).
- **N-U4 (same OS user).** The keeper accepts calls from any same-uid process. The OS user is the boundary. A same-uid
  process can also read brain's `0600` age key file, so `register_age_recipient` widens nothing. Every change is
  shown on the other devices before use (I5). Any same-uid process, including an unconfined agent CLI (ES-03 §5.1
  "Authority"), can also call `sign` under `aigentry-endorsement-v1|`. The fingerprint comparison before an
  endorsement (I4) is therefore a step of the user interface, **not** something the keeper enforces: a
  prompt-injected agent could endorse a registry-listed device, which then becomes a recipient on every device after
  the R6 notice. User-facing help for endorsement states this.
- **N-U5 (captures are never rekeyed).** A capture is readable only by the devices that were in `R` when its gated
  push ran. A device that was not gets `RESTORE_NOT_A_RECIPIENT`. That outcome is terminal: it does not change when
  another device comes online. The remedy is a new capture on a device that holds the work (ES-04 §5). With no
  active device other than the reader, the outcome is `RESTORE_UNRECOVERABLE_KEY` (N-U1). An automatic capture rekey
  would re-upload uncommitted code without a capture command, which D-6 (pending user decision; bundle 1e default
  "explicit command only") excludes.

## B.7 Not measured

Real multi-host runs; macOS/Windows; whether a legacy `sync --tick` timer is installed on any host; git's
`core.hooksPath` precedence and `git push --mirror` behaviour (from knowledge); registry or keeper behaviour (none
implemented). No tests were run.
