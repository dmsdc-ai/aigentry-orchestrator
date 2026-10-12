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
- Revision 5 (reconciliation cycle 5, 2026-10-13, after joint review round 4 of ES-01/03 `638daee` and ES-02/04/07
  `628242f`): pins, anchors and endorsements are written only by `aigentry-brain trust bootstrap|anchor|endorse` under
  one terminal rule, which "Shown" also uses (an answer read from the controlling terminal); every other path, the
  sync pass and every MCP tool included, only reports `TRUST_BOOTSTRAP_REQUIRED` / `TRUST_ANCHOR_REQUIRED`, and until
  the bootstrap is confirmed checkpoint and capture pushes are held (§B.1 "Terminal rule", "Confirmation"; I4, I5,
  I11, N-U3); the rekey pair uses the pinned seq, so a same-recipient re-registration re-arms nothing (§B.2, I5);
  `H` excludes devices with no recipient (I11); reader's own rotation (I5); MCP notice text carries no
  registry-supplied names (§B.1).
- Revision 6 (reconciliation cycle 6, 2026-10-13, after joint review round 5 of ES-01/03 `19a577d` and ES-02/04/07
  `654fdbe`, and the user's design feedback relayed by the orchestrator, 17:42Z): **the terminal is no longer the
  trust boundary.** A terminal answer does not prove that a person approved anything: an agent can drive a
  pseudo-terminal (`script`), and so can a telepty-admitted caller (measured by joint review round 5). Bootstrap,
  local anchors, endorsements and recipient-change acceptance are now one **signed approval primitive owned by
  ES-01** (§B.1 "Approval"). It binds the approver, the target and scope, freshness and single use, and every
  approval is a record in the registry list. All channels produce the same primitive: a terminal on a trusted
  device, the registry approval page, Kkoma/mobile. Brain, ES-04 and MCP only request approvals and verify them from
  a fresh list; they never create one. The terminal rule becomes the input discipline of one channel (§B.1
  "Channels"), with a Windows form. Endorsement files in the brain repo are replaced by `endorse` approval records.
  "Shown" is replaced by "approved" (I5). I4, I5, I11, I12, BR-6, N-U3 and N-U4 are re-derived. The residuals are
  stated: a bootstrap is still trust-on-first-use against the registry, and an agent that can reach the keeper of an
  approval-capable device can approve.
- Revision 7 (reconciliation cycle 7, 2026-10-13, after joint review round 6 of ES-01/03 `d2ef9e0` and ES-02/04/07
  `766a29c`): (1) V3 is split by action: an `endorse` is valid while the target's key is unchanged, and its bound
  recipient seq and hash decide only whether it also pins the target's recipient, so a same-key re-login keeps the
  device trusted with no notice and a rotation is held until a `recipient_accept` (I5); (2) `scope` carries every
  `device_id`, recipient hash and the root id, the approver recomputes `scope_digest`, and the keeper signs only the
  request the channel displayed (`preview_approval`, `approve(request_id, expected_sha256)`); each device audits its
  own approvals (§B.1 "Approval", "Channels", I12); (3) Kkoma-only management is stated exactly (Kkoma ∈ `T` on every
  device: registered first, or endorsed once from a trusted computer's terminal), and a Kkoma device has defined
  obligations (§B.1 "Channels", "Product consequence"); plus the round-6 non-blocking items (anchor candidates must
  be pinned, V6 "active at `approved_at`", deny and `can_approve` availability, registry-computed `S`).
- Revision 8 (reconciliation cycle 8, 2026-10-13, after joint review round 7 of ES-01/03 `35c4d78` and ES-02/04/07
  `5771e44`): (1) the bootstrap approver compares a recipient only for a device that is `active` in `S` and in its
  own `T`, and refuses only while its **own** I5 hold condition holds for that device, which is exactly the
  condition under which its own refresh creates that device's `recipient_accept` request; a `bootstrap` pins a
  recipient only for the devices whose status in `S` is `active`, and the status is bound in `scope_digest`; so a
  device that rotated and was then revoked, expired, or rotated while untrusted on the approver never blocks a
  bootstrap (§B.1 "Request", approver table, "Channels", I5); (2) a Kkoma device signs only after a user
  verification on its own approval screen, never from a message, notification, deep link, automation or an
  interface reachable by the orchestrator or agents (KK-4); plus the round-7 non-blocking items (standing denials,
  the bootstrap override narrowed and fingerprint-based, audit of untrusted bootstrap approvers, the per-computer
  terminal step and the `whoami` check stated, seq floor from approvals, own-key check, self-audit wording).
- Revision 9 (reconciliation cycle 9, 2026-10-13, after joint review round 8 of ES-01/03 `f7c021a` and ES-02/04/07
  `7bf102d`): (1) every `device` channel compares the request with **its own fresh list** before the pin comparison
  (for a `bootstrap` the digest of `S` recomputed from that list, otherwise the target's entry) and refuses a
  difference with no override, so the recipient a bootstrap pins on a fresh reader is the value the approver
  verified and compared with its own pin (§B.1 "Channels", KK-3, I5); (2) the I5 seq floor counts a seq bound in a
  `device` approval only when the record carries the target's own signed `age_recipient` for that seq, so the floor
  rises only to values the target signed, and the registry refuses an `endorse` / `recipient_accept` bound to values
  other than the target's current ones (§B.1 "Request", I5); plus the round-8 non-blocking items (denial key by
  fingerprint, denial and `can_approve` attribution, retention of denials, KK-4 at the OS key level, terminal "no" is
  local, four more CLI steps, status / `revoked_at` consistency).
- Revision 10 (reconciliation cycle 10, 2026-10-13, after joint review round 9 of ES-01/03 `ec25a35` and ES-02/04/07
  `12abfb4`): (1) the residual of an `account` `recipient_accept` is stated (a compromised registry can forge one
  and so make every reader use any recipient value the target's key signed, a denied one included; only `device`
  approvals are cryptographic), and whether `account` may approve a recipient change at all is D-ID-6 (e) /
  decision bundle 2l, pending user decision, recommended default (B) "never" (§B.1 approver rules, V6, I5, N-U3,
  N-U4, trace (16)); (2) an approval record carries and lists `scope`, so the copied target `age_recipient` /
  `age_recipient_sig` that I5's seq floor reads survive the request's purge (§B.1 "Approval"); (3) every trust
  refresh writes a **list snapshot** into the trust state (per device fp, status, seq, recipient hash and check
  result, plus root, `T` and the hold set), which is the only data the channels' own-list check and pin comparison
  read (§B.1 "Channels", KK-2, BR-6); plus the round-9 non-blocking items (the floor is an inconsistency detector,
  seq range, retry and stale-endorse costs, deny wording, KK-4 attributes, 422 inside a refresh, a terminal approver
  needs brain).
- Revision 11 (reconciliation cycle 11, 2026-10-13, after joint review round 10 of ES-01/03 `fea3531` and ES-02/04/07
  `54c2a74`; no invariant changed): (1) CK-21 (f4) now restores B's (2, h′) listing before the approval it expects,
  and its steps are no longer written into (f5)'s setup (ES-02 CK-21); (2) under D-ID-6 (e) (B), a user with two
  computers and no Kkoma `device` approves each computer's key rotation only in a terminal on the other one, which on
  Windows is unverified; "Platform scope", the (B) UX cost, "CLI steps that remain" and the consent texts say so
  (CK-21 (k), trace (19)); (3) an approval record copies `scope` without its display fields (`name`, `os`,
  `created_at`), so no `os` outlives D-ID-5's 90-day clear (§B.1 "Approval"); plus round-10 non-blocking 1, 3, 5
  and 6.
- Why: the trust/revocation rules were patched case by case in two spec sets, and every review round found a new
  gap between them. This document is the **single model** both sets cite. A rule in ES-01, ES-02 or ES-04 that
  touches trust, recipients, revocation, anchors or pushes must cite an invariant here. If it contradicts one,
  the invariant wins and the spec is defective.
- Specs bound by it:
  - ES-01 `docs/specs/2026-10-12-env-continuity-identity.md` and ES-03 §5.1 (lease keeper), both in clone
    `aigentry-orchestrator-wt-1204-idq`;
  - ES-02 `docs/specs/2026-10-12-env-continuity-context-checkpoint.md` and ES-04
    `docs/specs/2026-10-12-env-continuity-workspace-capture.md`, both in this clone.
- Cited by both ADRs (`docs/adr/2026-10-12-env-continuity-context-and-workspace.md` A13, A16, A17, A18, A19,
  `docs/adr/2026-10-12-env-continuity-identity-and-queue.md` A12, A15, A16).
- Reading convention: Part A = FINDINGS (measured), Part B = PROPOSALS (each needs user review where it touches a
  Rule 47 item; those items are cited as "pending user decision" with the decision-bundle default).

# PART A — FINDINGS

## A.1 Brain push paths (measured 2026-10-13, aigentry-brain `main` @ `0ffa6ee`, read-only)

A repo-wide search for push call sites (`git push`, `.push()`, `['push'`, `simple-git`) found exactly two code paths
that push the brain repo:

| # | Path | What it pushes | Reached from |
|---|---|---|---|
| P1 | `GitBackend.push()` = simple-git `push -u origin <branch>` with branch `main`, 30 s timeout (`src/backend/GitBackend.ts:186-191`, `:19`) | everything committed on `main` | (a) `PushPullManager.executePush` (`src/sync/PushPullManager.ts:166-168`), entered through `enqueuePush` (`:161-163`). `enqueuePush` is called by `AutoCommitter` after its own `git add .` commit (`src/sync/AutoCommitter.ts:39`, `:56`), by pull-failure recovery (`PushPullManager.ts:153`), and by `BootstrapOrchestrator.push` (`src/mcp/BootstrapOrchestrator.ts:39-42`). That in turn serves the `brain_sync_push` MCP tool (`src/mcp/BrainMcpServer.ts:432-439` → `BrainContract.syncPush` `src/contract/BrainContract.ts:501-505`) and `SyncLifecycle.schedulePush` after every write tool (`src/sync/SyncLifecycle.ts:120-125`, `:181-182`). There is also a retry timer (`PushPullManager.ts:180`). (b) The TOFU recipient sync after every pull (`GitBackend.ts:87`), which commits with `git add .` and pushes (`:162-166`) |
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
| `L` | the last successful list fetch: `GET /devices?include=keys,approvals&all=true`, owner-filtered, with `server_time` `S(L)` and the user's approval records (§B.1 "Approval") | ES-01 §8 / §8.1 R3, §8.2, fetched through the keeper (I12) |
| `D` | devices in `L`. Each `d` has `id`, `public_key` (immutable), `fp = aigfp1(public_key)`, `status ∈ {active, expired, revoked}`, `created_at` (server, set once), `revoked_at` (server, set once, may be null), `age_recipient`, `age_recipient_sig`, `age_recipient_set_at` | ES-01 §3.1 |
| `Pin` | per reader: `id → {public_key, fp, created_at, revoked_at, age_recipient, age_recipient_seq, first_seen_by}` for every device the reader has trusted | the reader's **trust state** (I3) |
| `A` | anchors: (a) `r` itself; (b) the root, meaning the device with the earliest `created_at` in `L`, revoked or not, pinned by a valid `bootstrap` approval; (c) local anchors added on `r` by a valid `anchor` approval (I11). Both only under "Approval" below. The bootstrap is **confirmed** exactly when the trust state holds a `root` anchor | trust state |
| `E` | endorsements: the `endorse` approval records in `L` (§B.1 "Approval"), each with a reader-side state | registry list + trust state |
| `T` | **trusted**: the least fixpoint reachable from `A` over endorsements counted by E1–E4 (ES-02 §5.6) | computed |
| `R` | **recipient**: see I5 | computed |
| `X` | items: checkpoint records and capture manifests. Each item has a writer `w(x)`, a server-clock `first_seen_by(x)` (`null` = provisional) and a state `∈ {provisional, accepted, *_UNANCHORED, DEMOTED:<code>, QUARANTINED:<reason>, pending_key, unrecoverable_key}` | trust state (I3) |
| `H` | possible holders, for a file `r` cannot decrypt: devices other than `r` that are in `L`, or pinned and missing from `L`, that are **not revoked** (`active` or `expired`; for a pinned device missing from `L`, its pinned `revoked_at` is null) and that have an `age_recipient` in `L` or a pinned one (a device that never registered a recipient cannot hold a file) | computed (I11) |
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

**Approval** (I4, I5, I11; owned by ES-01 §8.2). Four inputs change trust: the **bootstrap** (the root and the first
pins), a **local anchor**, an **endorsement**, and the **acceptance of a recipient change** (an addition's recipient or
a validly signed rotation). Each is written into a reader's trust state **only** when that reader finds a **valid
approval** for it in a fresh list. An approval is a registry record created for one approval request:

- **Request** (harmless; confers nothing): `request_id`, `nonce` (server-generated, 128 bits), `action ∈ {bootstrap,
  anchor, endorse, recipient_accept}`, `reader_device_id` (the device the approval applies to: `r` for `bootstrap`
  and `anchor`; null for `endorse` and `recipient_accept`, which apply to every reader), `target_device_id`,
  `target_fp`, `target_age_recipient_seq`, `target_age_recipient_sha256`, `scope_digest` (for `bootstrap`: SHA-256 of
  the UTF-8 lines `device_id|fp|status|age_recipient_seq|age_recipient_sha256` of every device of the set `S` to be
  pinned, sorted by `device_id`, each ending in `\n`, followed by the line `root|<root device_id>`; empty otherwise; a
  device without a recipient has empty seq and hash fields; `status ∈ {active, expired, revoked}` as listed),
  `scope` (for `bootstrap`: `root_device_id` and, per device of `S`, `device_id`, `fp`, `status`,
  `age_recipient_seq`, `age_recipient_sha256` and the display fields `name`, `os`, server `created_at`; for the
  other actions the same per-device entry for the target, plus, for an `endorse` or `recipient_accept`, the target's
  `age_recipient` and `age_recipient_sig` at the bound seq, which the registry copies from the device row when it
  creates the request; I5's seq floor uses them), `requested_by`, server-clock
  `issued_at` and `expires_at` = `issued_at` + the validity window (technical value, proposed 15 minutes). Every
  channel recomputes `scope_digest` from `scope` and refuses a mismatch, and for the other actions checks that the
  `scope` entry equals the bound target fields (`APPROVAL_SCOPE_MISMATCH`), so what it displays is what the signature
  covers. For a `bootstrap` the registry computes `S` and the root from its own `devices` table when the request is
  created and refuses a request whose `scope` or digest differs; for an `endorse` or `recipient_accept` it refuses
  (422) a request whose bound `target_fp`, seq or hash differs from the target's stored current values (defence in
  depth; ES-01 §8.2). Brain creates
  requests through the keeper (I12): in every trust refresh while a condition holds (no `root` anchor; I11's trigger;
  an untrusted active device, the device itself included when it is not reachable from its root and local anchors;
  for a `recipient_accept` of `(d, seq)`: exactly while I5's **hold condition** holds for `d` on this reader, i.e.
  `d ∈ T(r)`, `d` is `active`, `d ≠ r`, and `d`'s verified listed recipient differs from `r`'s pin or `r` has none;
  a change of a revoked, expired or untrusted device creates no request), and again when the previous request has
  expired. The registry keeps at most one pending request per `(action, reader_device_id, target_device_id,
  target_age_recipient_seq, scope_digest)`. **A denial stands** (round-7 non-blocking 1): for the **denial key**
  the registry returns the denied request instead of creating a new one, until the user clears the denial on the
  approval page or in Kkoma (account session; a device bearer cannot clear it) or the target is revoked. The denial
  key is `(action, reader_device_id, target_device_id, target_fp)` for `bootstrap`, `anchor` and `endorse`, and
  `(recipient_accept, target_device_id, target_fp, target_age_recipient_sha256)` for `recipient_accept` (round-8
  non-blocking 1): a seq bump of the same key, or the same recipient re-registered at a later seq, is not a new
  question; a rotation to another recipient is. A device does not escape a denial by bumping its own seq. A stolen
  account session can still create new prompts by registering new devices, which no denial key closes. A denial
  records who made it: `denied_by` (the device whose bearer denied it, or `browser`) and the channel; the approval
  history shows them (round-8 non-blocking 2). A `device` channel's "no" is a **local decline only**: it records no
  denial, and the keeper has no deny operation (round-8 non-blocking 6), so the `aigentry-devkit approve` code path
  creates no standing denial, whoever drives it; an agent that holds any own device bearer can still deny through
  `POST …/deny` (availability residual, N-U4). Denials come from the approval page's "deny" action, Kkoma's "deny"
  action on its request list (distinct from its approval screen's "no", which is a local decline), or a device
  bearer's `POST …/deny` (ES-01 §8.2). Attribution (round-9 non-blocking 4): through an account session (the
  approval page, or Kkoma signed in to the account) `denied_by` is `browser` and the channel `approval_page` or
  `mobile`; through a device bearer (Kkoma's own, or any device's) it is that device and the channel `mobile` or
  `api`. How
  long a denied request is kept is D-ID-6 (d), pending user decision (bundle 2k proposes keeping it while the denial
  stands); under the current D-ID-6 (d) wording (requests purged 24 h after a terminal state) a denial lapses 24 h
  after it is made (round-8 non-blocking 3). Brain reports a standing denial with its `request_id` and the text
  "denied earlier; clear the denial in Kkoma or on the approval page to be asked again, or revoke the device".
  `POST /approval-requests` is rate-limited per device bearer (ES-01 §7.4; technical value).
- **Approval** (append-only, never edited): every request field, `scope` included **without its display fields**
  `name`, `os` and `created_at` (round-9 blocking 2: the copied target `age_recipient` / `age_recipient_sig` that
  I5's seq floor reads must stay in the listed record after the request is purged, D-ID-6 (d). Round-10 blocking 3:
  the copy keeps `root_device_id` and, per device, the `scope_digest` line fields, which never included a display
  field, plus the target's `age_recipient` / `age_recipient_sig`; no reader reads a display field from a record.
  Every copied field belongs to a column D-ID-5's default keeps on the device row for the account's life, so the
  copy adds no personal-data retention beyond D-ID-5; `os`, which D-ID-5 clears 90 days after `revoked_at`, is not
  copied. Leaving fields out is chosen over clearing them later, because records are append-only and the display
  fields are no floor or binding input. Both D-ID-5 and D-ID-6 (d) are pending user decision, bundle 2d), plus `approval_id`, `approver_kind ∈ {device,
  account}`, `approver_device_id` and `sig` (kind `device`), `second_factor` (kind `account`: the method used,
  never its secret), `channel ∈ {terminal, approval_page, mobile}` (informational), and server-clock `approved_at`.
  `sig` = the approver device's key, signed **only inside the keeper's `approve(request_id, expected_sha256)`
  operation**, and only when the request it fetches has the canonical string the channel displayed (I12), over
  `"aigentry-approval-v1|" + user_id + "|" + request_id + "|" + nonce + "|" + action + "|" + reader_device_id + "|" +
  target_device_id + "|" + target_fp + "|" + target_age_recipient_seq + "|" + target_age_recipient_sha256 + "|" +
  scope_digest + "|" + expires_at` (null fields as the empty string; fingerprints in the canonical `aigfp1:` form).
  The registry accepts at most one approval or denial per request and consumes its `nonce`. It refuses an approval
  after `expires_at`, one whose device signature does not verify, one from a device that is not `active` or has
  `can_approve: false`, one whose kind the action does not allow, an `endorse` or `recipient_accept` whose approver
  is the target, a `bootstrap` whose `scope` no longer equals the set the registry computes now (`approval_scope_stale`,
  so a user never approves a request the reader would reject under V3), an `endorse` or `recipient_accept` whose
  bound fp, seq or hash no longer equals the target's stored current values (`approval_scope_stale`, the same 409),
  and an account approval without a second
  factor (defence in depth, never the trust basis; ES-01 §8.2).

**Approver rules** (per action; the only place where approval authority is defined):

| Action | Binds | Effect on reader `r` when valid | A `device` approver must be | `account` kind |
|---|---|---|---|---|
| `bootstrap` | `r`, `r`'s fp, `scope_digest` of `S` (ids, fps, statuses, recipient seqs and hashes) and the root | pins every device of `S` (fp, `created_at`, `revoked_at`) and the root; pins a recipient, at its bound seq and hash, **only for the devices whose status in `S` is `active`** (a revoked or expired device gets no recipient pin; one that returns goes through I5's "no pinned one" path); records the `root` anchor | an `active` device of `S` **other than `r`**; `r` itself only when `S` has no `active` device other than `r` | only when `S` has no `active` device other than `r` (a user's first device, a lone survivor) |
| `anchor` | `r`, candidate `c`, `c`'s fp | adds `c` as a local anchor | the candidate `c`, never `r` | yes (I11's trigger already means that no active trusted device other than `r` exists to sign) |
| `endorse` | target `d`, `d`'s fp, recipient seq and hash | counts as the endorsement `e → d` (ES-02 §5.6 E1–E4) while `d`'s key is the bound fp, whatever `d`'s seq is now (V3); pins `d`'s recipient only when `d` has none pinned and its verified listed recipient has the bound hash (at the bound seq; a higher listed seq with that hash is not a change, I5); otherwise `d`'s recipient waits for a `recipient_accept` | the endorser `e`, with `e ∈ T(r)`, `e ≠ d` | **never**: membership is what a compromised registry would forge (ES-01 R5) |
| `recipient_accept` | target `d`, fp, seq, recipient hash | sets `d`'s pinned `age_recipient` and seq to the bound values | `e ∈ T(r)`, `e ≠ d` (`r` itself included) | **D-ID-6 (e), pending user decision** (decision bundle 2l). Recommended default **(B): never**, as for `endorse`. "Never" is the safe form: the bootstrap-style condition "only when no `device` approver exists", evaluated on listed statuses, would be met by a registry that lists the reader and its other trusted devices `expired`, so it is not an equivalent (round-10 non-blocking 1). Alternative (A): yes; the value must still carry a valid `age_recipient_sig` by `d`'s pinned key (I5), so an account approval accepts only a value `d`'s key signed, **but a compromised registry can forge that approval** (residual below) |

Why `r` never approves for itself when another device could: the approver must hold a key that is **not** on the
device being trusted, so that an agent driving `r` (its terminal, its keeper or its MCP tools) cannot trust `r`'s view
on its own. The exception is the case where no such key exists:
- **A user's first device, or a lone survivor** (`S` has no `active` device other than `r`). The options are
  (i) `r`'s own terminal channel (`device` kind, `r` as approver), or (ii) an `account` approval with a second factor
  on the approval page or in Kkoma. Which ones are offered is D-ID-6 (a), pending user decision; the recommended
  default is both.
- Residual of (i): an agent that drives `r`'s terminal or calls `r`'s keeper can bootstrap `r` (N-U4). What it can
  pin is only the `S` the registry listed, which has no other active device.
- Residual of (ii): the approval is a registry assertion (N-U3). The second factor binds it to the account holder
  only as far as the registry is honest.
- Either way, a later device that joins is trusted only through an `endorse` approval by a device in `T`.

**`account` `recipient_accept`** (round-9 blocking 1; D-ID-6 (e), decision bundle 2l, pending user decision).
- **Residual under (A)**, stated wherever a recipient change is said to wait for an approval (I5, N-U3, N-U4, ES-02
  §5.6, ES-03 §5.1 "Authority"): an `account` approval is a registry record whose only reader-side check is that
  `second_factor` is present (V6). A compromised registry can therefore forge an `account` `recipient_accept` and
  make every reader pin and encrypt to **any recipient value the target's key signed**: a rotation the user denied,
  a same-uid `register_age_recipient` on the target, or a value signed with a stolen target key. Once a reader such
  as A has applied it, A's pin is the forged value, so A's own-list check and pin comparison pass a fresh device's
  `bootstrap` with that value and the fresh device pins it too (trace (16)). The self-audit does not see it (it
  covers `device` approvals), and the approval history that would show an acceptance the user never gave is served
  by the same registry. **Only `device` approvals are cryptographic.**
- **(B), recommended default:** no `account` `recipient_accept` is valid on any reader (V6), and the registry refuses
  one (422 `approval_kind_not_allowed`, defence in depth). A recipient change is then accepted only by a `device`
  approver `e ∈ T(r)`, `e ≠ d`, so the forgery above confers nothing, and I5 holds against a compromised registry
  except for N-U3's first decision and N-U4's reach. Every reader that holds a request is itself such an approver,
  and so is a bootstrap approver whose refusal names the request (it approves that request on the same channel).
- **UX cost of (B)**: a user whose Kkoma is not a device (D-ID-6 (b)), or is not in `T` everywhere, approves every
  key rotation (and every returning `expired` device that a reader holds for, I5) only from a terminal on a trusted
  device that has `aigentry-brain` installed (§B.1 "Channels"); a host with `can_approve` off needs it turned on
  first (browser + second factor). The approval page alone no longer covers a recipient change. **Two computers,
  no Kkoma `device`** (round-10 blocking 2): the only approver `e ∈ T(r)`, `e ≠ d` of one computer's rotation is
  the other computer, i.e. the reader that holds it. So each rotation of laptop L is approved in a terminal on host
  H itself (SSH or a telepty session; `can_approve` turned on first if off, D-ID-6 (c)), and each rotation of H on
  L. If that computer runs Windows, its terminal channel is unverified (CK-28 (j) BLOCKED until a Windows runner,
  D-Q-6), so no verified release path exists: for a user whose only other computer is Windows (a Windows-only
  user with two computers in particular), (B) makes Kkoma registered as a device (D-ID-6 (b)) or (A) a de-facto
  requirement. This is a UX constraint for the user (bundle 2i, 2l), not decided here (trace (19), CK-21 (k)).
- Until the user decides, the specs use (B) for every rule and test, and every place that relies on it says so. The
  (A) variant of each affected test row documents the residual instead (CK-21 (f7)).

An endorser must itself hold a `root` anchor: every `device` channel (the terminal, a Kkoma device) refuses to
approve an `endorse` request on a device that has not been bootstrapped (`APPROVAL_NOT_BOOTSTRAPPED`), and readers
count it only when `e ∈ T(r)`.

**Validity on reader `r`.** An approval `a` in `r`'s fresh list is **valid on `r`** only if all of these hold:
- V1 (user): `a` is in `U`'s owner-filtered list (I1).
- V2 (request): for `bootstrap` and `anchor`, `a.reader_device_id = r`, and `a.nonce` is the nonce of a request
  that `r` itself created and has not consumed (kept in `r`'s trust state).
- V3 (scope), by action. In every action `target_fp` = `aigfp1` of the target's listed `public_key` and equals its
  pin, if pinned. Further:
  - `endorse`: nothing else. The bound `target_age_recipient_seq` and hash never decide validity; they decide only
    whether the endorsement also pins `d`'s recipient (approver table). So the edge survives every later seq of `d`:
    a same-key re-login (not a change, I5) and a rotation (held until a `recipient_accept`, I5) leave `d ∈ T`.
    A **pending** `endorse` request, however, is bound to `d`'s seq at creation, so a same-key re-login before it is
    approved makes the registry refuse its approval (409 `approval_scope_stale`, request `expired`), and the next
    refresh requests again at the new seq (round-9 non-blocking 3; cost accepted: one more prompt, CK-28 (s)).
  - `recipient_accept`: `target_age_recipient_seq` and hash = the target's verified listed recipient (strict).
  - `bootstrap`: `scope_digest` = the digest `r` stored with its request **and** the digest of `S` recomputed from
    this fresh list (strict; it covers every status, recipient seq and hash), and `target_fp` = `r`'s **local**
    fingerprint from its keeper (`fingerprint()`); a refresh that finds `r`'s own listed key ≠ its local key reports
    a registry fault, as I5 does for `r`'s own recipient. UX cost, accepted: a re-login, expiry or revoke of any
    device of `S` between the request and its application forces a new request and a new approval (the registry
    refuses to approve such a stale request, so no approval is wasted on it).
  - `anchor`: the candidate is pinned on `r` (every device older than `r` was in `r`'s bootstrap `S`, so an older
    candidate that `r` has not pinned is a registry fault, R6, and gets no request).
  A changed list means a new request, never a stretched approval.
- V4 (freshness): `issued_at ≤ approved_at ≤ expires_at`, all server clock in the record (I2).
- V5 (single use): `a.approval_id` is not in `r`'s consumed set. A `bootstrap` or `anchor` approval is consumed
  when applied. An `endorse` approval is a standing statement about the edge `(e, d, fp)`; applying it again changes
  nothing, and a later seq of `d` does not void it (V3). A `recipient_accept` approval is a statement about
  `(d, fp, seq, hash)`; applying it again changes nothing, one whose seq is below `d`'s pinned seq is superseded
  (skipped, no notice), and any other one that does not match the verified listed value fails V3.
- V6 (approver): kind `device`: the approver is listed, its `revoked_at` is null or later than `approved_at` (an
  `expired` approver's key stays its key, ES-01 §8.1 R4; that it was `active` and `can_approve: true` at
  `approved_at` is a registry check, defence in depth), it satisfies the table above, and `sig` verifies with its
  **pinned** `public_key` (with its listed key only for a `bootstrap` approver in `S`, which `r` cannot have pinned
  yet; N-U3); kind `account`: the table allows it and `second_factor` is present (for `recipient_accept` the table
  allows it only under D-ID-6 (e) alternative (A); under the recommended (B) an `account` `recipient_accept` fails
  V6).
An approval that fails any check confers nothing. The failure is reported (`APPROVAL_INVALID:<V#>`) and never
deleted. A failed V6 signature check against a pin is a registry fault (R6).

**Audit.** Every approval is a registry record that all channels list (the account's approval history: action,
target, approver, kind, channel, `approved_at`). Every reader reports, as a registry-fault notice, a `device`
approval whose signature fails against its pin, or whose approver is not in its `T` while the approval names one of
its trusted devices or is a `bootstrap` (`APPROVAL_APPROVER_UNTRUSTED`; a `bootstrap` scope holds every device of
the user, so a forged bootstrap of any fresh device is reported by every genuine device that does not trust its
approver). **Self-audit:** every device's trust refresh also compares
the `device` approvals in its list that name **itself** as approver with its keeper's local log of what it signed
(`signed_approvals()`, ES-03 §5.1: `request_id` and the SHA-256 of the canonical string), and reports every one that
is not in the log, or whose canonical string hashes differently, as a registry fault (`APPROVAL_NOT_SIGNED_HERE`).
For a `device` approval the registry cannot forge a signature that verifies against a pinned key, so
`APPROVAL_NOT_SIGNED_HERE` detects a valid signature made with this device's key outside its keeper (a stolen key),
or the loss of the keeper's log; an approval signed by a key the reader does not trust is reported as
`APPROVAL_APPROVER_UNTRUSTED` above. Both are visible only on the devices the registry shows the record to; one
that shows different lists to different devices (equivocation) is not caught (N-U3).

**Channels** (all produce the same record; none is the trust boundary):
- **Terminal** on a device that can approve: `aigentry-devkit approve <request_id>` (ES-01 §9). It obtains the
  request **only** from the keeper's `preview_approval(request_id)` (the canonical string, its SHA-256 and the parsed
  fields with `scope`; ES-03 §5.1), never from a separate fetch, and displays those fields. It recomputes
  `scope_digest` from `scope` (for the other actions, checks the `scope` entry against the bound target fields) and
  refuses a mismatch (`APPROVAL_SCOPE_MISMATCH`). It then runs `aigentry-brain trust refresh` (whose run also
  creates this device's due requests, BR-6) and reads, read-only through its printed `aig` (as ES-04 does),
  `<aig>/trust-state.json`. **Data source** (round-9 blocking 3): every check below reads only that file: its pins,
  its `root` anchor and its **list snapshot** (`device_list`, BR-6: per listed device `id`, `fp`, `status`,
  `created_at`, `revoked_at`, `age_recipient_seq`, `age_recipient_sha256` and brain's `recipient_check`, plus the
  computed `root`, `trusted` = `T` and `hold` = the I5 hold set), and only when the snapshot's `server_time` is **not
  earlier than** the `server_time` the refresh printed (a concurrent refresh can only have made it fresher);
  otherwise it refuses, exit 7, reason "trust state older than this refresh (retry)"; this retry is the same
  command **with** the same id again (round-10 non-blocking 5), unlike the scope-mismatch retry below. It makes no list fetch of its
  own and evaluates no signature, so brain stays the only evaluator (I12) and the list it checks is the one brain
  evaluated. **Own-list check** (round-8 blocking 1): it compares
  the request with that snapshot, before the pin comparison: for a `bootstrap` it recomputes the digest of `S` (every listed
  device, revoked and expired included, and the root = the snapshot's `root`, the earliest `created_at`) from the snapshot; for an `endorse`
  or `recipient_accept`, the target's entry (fp, status, seq, hash). A difference is refused with no override:
  `APPROVAL_SCOPE_MISMATCH`, reason "scope differs from this device's list (registry fault or stale; retry)".
  "Retry" means: run `aigentry-devkit approve` **without** an id, which lists the pending requests; when the
  difference was a change of the list, the refresh this command ran has already created a request for the current
  list, and the old one can no longer be approved (the registry refuses it, 409, and marks it `expired`)
  (round-9 non-blocking 3, 7). Under
  an honest registry this costs nothing, because the registry already refuses to approve a stale scope (409). So
  every recipient value the channel shows and signs is the value this device itself listed and checked. For a
  `bootstrap` or `endorse` request it then runs the **pin comparison** against this device's own trust state. It
  refuses (`APPROVAL_SCOPE_MISMATCH`), with no override:
  - a device whose fp or `created_at` differs from its pin; for a `bootstrap`, a pinned device that is not revoked
    and is missing from `S`, and a `root_device_id` that differs from this device's own `root` anchor;
  - for a `bootstrap`, a device that is `active` in `S` **and** in this device's `T` (the snapshot's `trusted`) whose
    recipient hash in `scope` differs from this device's pin, or that has none pinned (for this device itself:
    differs from its local key, which the snapshot shows as this device's `recipient_check` `fault:own_key`).
    Because `scope` equals this device's own list (own-list check), that is exactly this device's **own** I5 hold
    condition for it, or a registry fault (below). The refusal
    names that device's `recipient_accept` request, which the same condition makes this device's refresh create
    (§B.1 "Request"; it is in the snapshot's `hold`), and says "approve it first (any `device` channel, this one
    included; the account only under D-ID-6 (e) (A)), or revoke that device"; both are
    always possible. A standing denial of that request is named with the same text and "clear the denial". Also
    such a device whose listed recipient is a registry fault on this device (the snapshot's `recipient_check` is
    `fault:<reason>`: signature or seq, I5; for this device itself, a listed value ≠ its local key): reason "registry fault", released only when the registry lists a
    consistent value (availability under a faulty registry is not promised, N-U3).
  Every other device of `S` (revoked, expired, or not in this device's `T`) is compared by fp and `created_at`
  only. A revoked or expired one gets no recipient pin from this bootstrap (approver table), so its recipient is
  irrelevant here. The device the request is about (the bootstrap's reader, the endorse's target) is shown with
  its fp, which the user compares with that device's own `aigentry-devkit whoami` (or `login`) output, and needs no
  override. Every other `active` or `expired` device of `S` that this device does not trust is refused unless the
  user overrides it by name after the channel has shown its fp, `created_at` and recipient hash. A revoked device
  that this device does not trust needs no override: it is never re-bound (ES-01 §8.1 R4), never in `R`, `H` or an
  I11 candidate set, its endorsements cannot count on a fresh reader (E4), and the root is checked above. After the answer it calls the keeper's
  `approve(request_id, expected_sha256)` with the previewed hash; the keeper signs only if the request it fetches
  again has that canonical string (`APPROVAL_REQUEST_CHANGED` otherwise), so a registry that serves the display and
  the signer different bodies obtains no signature. When the same approver also has the target's pending `endorse`
  request (a new device's `bootstrap` approved from `e`, then `e → d`), the channel may show both previews and take
  one answer for both; each is still its own request, preview, hash and signature. A "no" is a local decline: the
  command exits without signing and records no denial (§B.1 "Request"). **Input discipline:** the command asks only when `isatty(2)` is true and reads the
  answer from the controlling terminal (`/dev/tty`), never from stdin, an argument, a flag or an environment
  variable. This discipline stops incidental runs (measured 2026-10-13 in one agent CLI's shell tool: fds 0–2 are not
  terminals and `/dev/tty` cannot be opened). It does not stop a program that drives a terminal (joint review
  round 5: `printf 'y\n' | script -qc … /dev/null` answers on `/dev/tty`; N-U4).
  **On Windows** (`process.platform === 'win32'`) the discipline reads: `isatty(2)` means that the standard-error
  handle is a console handle (`GetConsoleMode` succeeds, which is what Node's `tty.isatty(2)` reports there), and the
  answer is read from the console input buffer opened by name, `CONIN$`, never from stdin, whether or not stdin is
  redirected. A process without an attached console cannot open `CONIN$` and approves nothing. A shell that gives its
  programs pipes instead of a console (e.g. mintty without ConPTY) fails the check, and the command says to use a
  console window or another channel. Brain's `src/shared/TtyLog.ts:11` already maps terminal output to `CON` on
  Windows; the read and the console check are new. All of this is from knowledge, not run.
- **Registry approval page**: the ES-01 web page that already approves device authorizations (ES-01 §4), signed in to
  the account. It produces `account` approvals with a second factor (method: D-ID-6, pending user decision). It
  cannot produce a `device` approval, because it holds no device key.
- **Kkoma/mobile**: produces `device` approvals when the app is registered as an ES-01 device that holds its own key,
  and `account` approvals (same second factor) otherwise. Whether Kkoma registers as a device, and where its key is
  kept, is D-ID-6 (b) (pending user decision). **A Kkoma device's obligations** (requirements on the Kkoma app, which
  these specs do not implement; KK-1..KK-4), so that its `device` approvals are neither registry-trusting nor
  completed without the user:
  - KK-1 (key): its device key is used only inside the app's own approval flow, with the keeper's discipline: no
    general signing of `aigentry-approval-v1|`, a signature only over a request it previewed and fetched again with
    the same canonical-string hash, and a local log of what it signed for the self-audit (I12, §B.1 "Audit").
  - KK-2 (trust state): it keeps its own trust state with the content of I3 (pins, `root` anchor, consumed
    approvals) and the list snapshot of BR-6 written by its own refresh, which is the only data its KK-3 checks
    read, applied only from approvals valid on it (V1–V6), and it is bootstrapped like any reader. Its
    trust state stays on the phone. Being a device holding no `age_recipient`, it is never in `R` or `H` and never in I5's hold condition
    (which concerns a verified recipient that differs from its pin, or a verified one with no pin). As a reader it
    creates the requests its own state makes due (§B.1 "Request"), a `recipient_accept` included while its own I5
    hold condition holds for a device, so its KK-3 refusal always names an existing request.
  - KK-3 (checks): before it signs, it runs the terminal channel's checks with the same refusal codes
    (`APPROVAL_SCOPE_MISMATCH` incl. the digest recomputation, the own-list check against its own fresh list (KK-2),
    which comes before the pin comparison and has no override, and the pin comparison; `APPROVAL_NOT_BOOTSTRAPPED`),
    shows the same fields, fingerprints included, and offers the same override (by name, after showing the fp,
    `created_at` and recipient hash), which is a user action under KK-4.
  - KK-4 (input): each `device` signature, and each override, requires a **user verification** (platform biometric
    or device passcode) on Kkoma's own approval screen, given after that screen has shown the preview fields. It is
    never completed from a chat or agent message, a notification action, a deep link that carries the answer,
    accessibility or automation input, or any interface reachable by the orchestrator or by agents (Kkoma relays
    agent replies to the user, requirement l.12, l.44; that stream can open the approval screen, never answer it).
    This is the Kkoma counterpart of the terminal channel's input discipline and of the account channel's second
    factor; like them it does not tell a person from a program that controls the phone itself (N-U4). The user
    verification gates the **key's use at the OS level, per use**, not only the app's screen (round-8 non-blocking
    5): on iOS the key is a Keychain item whose access control requires user presence (`userPresence` or biometry)
    at every read (the Secure Enclave holds no Ed25519 key); on Android a Keystore key with user authentication
    required for every use (`setUserAuthenticationRequired(true)` with per-use authentication; Ed25519 in the
    Keystore needs API level 33 or later). An app-screen check alone does not meet KK-4, because any in-app code path
    that reaches the key would then sign without it. **Checkable attributes** (round-9 non-blocking 5): on Android,
    `KeyInfo.isUserAuthenticationRequired()` is true with a zero validity duration (authentication per operation,
    through a `BiometricPrompt` `CryptoObject`), shown by key attestation; on iOS, the item's `SecAccessControl`
    carries `.userPresence` or `.biometryCurrentSet`, and the `LAContext` used has
    `touchIDAuthenticationAllowableReuseDuration` = 0. On iOS the key bytes are read into app memory at each use, so
    KK-4 also requires that they are read per signature, never cached and zeroed after use; a code path that keeps
    the bytes of one legitimate read signs later without a prompt, which readers cannot detect, so the iOS form is
    weaker than a hardware-bound Android key (stated residual). Whether the device passcode may stand in for biometrics is D-ID-6 (b), pending user
    decision (recommended default: allowed, as KK-4 already names it; a passcode is easier to observe than a
    biometric); under that default, when the verification falls back to the passcode, the approval screen tells
    the user that this is the discouraged path (decision bundle 2j (b)). These platform facts are from knowledge, not measured, and no Kkoma code was read.
  Readers cannot verify that an approver ran these checks (as for the terminal channel). A Kkoma build that does not
  meet KK-1..KK-4 must give only `account` approvals (which carry the account's own second factor); its `device`
  approvals would sign what the registry shows, or what a relayed message asked for, which is why account
  endorsements are forbidden.
- **Product consequence** (decision bundle 2i). Approving from the phone or the browser alone covers a first device, a
  lone survivor and an anchor, and a recipient change only under D-ID-6 (e) alternative (A) (decision bundle 2l;
  under the recommended (B) a recipient change needs a `device` approver, as an endorsement does; with two computers
  and no Kkoma `device`, that approver is the computer holding the change, on its own terminal, §B.1 "UX cost of (B)").
  A later device's bootstrap and every endorsement need a `device`
  approver `e` with `e ∈ T(r)` on every reader `r`. **Kkoma-only management holds iff Kkoma is a device (D-ID-6 (b))
  and Kkoma ∈ `T` on every device.** Kkoma reaches that in exactly two ways:
  - **Kkoma registered first** (the account's first device, so it is the root everywhere): it bootstraps itself (its
    own `device` approval or an `account` approval, `S` = {Kkoma}), and every later device is bootstrapped and
    endorsed from Kkoma. No terminal is ever needed. Cost: if the phone is later revoked, the root is revoked, and
    every later fresh device anchors once (I11, permanent).
  - **A computer registered first** (the expected order: install on the always-on host or a laptop, Kkoma later):
    Kkoma enters `T` only through an `endorse` by a trusted device other than Kkoma, never the account, and its own
    bootstrap needs a `device` approver of its `S` other than itself. While that computer is the only other active
    device, that is a **one-time terminal step on that computer**: `aigentry-devkit approve` for Kkoma's `bootstrap`
    and for the computer's `endorse` of Kkoma (one answer may cover both). If that computer has `can_approve: false`
    (the N-U4 mitigation for agent-driven hosts; D-ID-6 (c)), the user first turns it on with the browser and the
    second factor, then runs the command in a terminal on that host (SSH or a telepty session), and may turn it off
    again. After that step every later device is managed from Kkoma alone.
  **CLI steps that remain** (round-7 non-blocking 4; each stated, none a quiet requirement cut):
  - **Each computer added before Kkoma is trusted** needs the same terminal step: its `bootstrap` and an `endorse`
    of it need a `device` approver in `T`, and until Kkoma is in `T` everywhere only a trusted computer is one. So
    with computers A and B registered before Kkoma, B is approved from a terminal on A, and Kkoma then once from a
    terminal on A or B. The step is "one-time" only when Kkoma is registered right after the first computer.
  - **Every `endorse`, and every `bootstrap` of a device that is not the account's first, needs a fingerprint
    comparison** with that device's own value (for a `bootstrap` the device the request is about is checked only
    this way, with no override; §B.1 "Channels"), which is printed only on
    that device: `aigentry-devkit login` prints `fingerprint_local` when it finishes, and `aigentry-devkit whoami`
    prints it again (ES-01 §9); a Kkoma device shows its own in the app. For a device that has no screen of its own (a headless host reached over SSH or a
    telepty session), that is reading one command's output in that session. It is the only defence against a
    registry that serves the approver the same altered request (N-U3).
  - **Every anchor recovery** (I11) needs the user to compare the candidate's local fingerprint, shown by the
    candidate's channel, with the value the fresh device shows for the candidate: `aigentry-devkit device list` on
    the fresh device (ES-02 §5.6 recovery step 2; a Kkoma device shows it in the app). That is one command on the
    fresh device per anchor (round-8 non-blocking 7).
  - **The remedy for a registry fault on a device's own recipient** (its listed `age_recipient` ≠ its local key,
    I5) is `aigentry-devkit login` on that device, which registers the local key again (N-U4).
  - **The remedy for a device bootstrapped without the user** is to delete `<aig>/trust-state.json` on that device
    (a file step; deleting or re-cloning the brain repo does the same, I3) and approve its new `bootstrap` request
    yourself (N-U4).
  - **A headless first computer** with `can_approve` off (the recommended D-ID-6 (c) default with no interactive
    console) cannot approve its own bootstrap: its bootstrap is an `account` approval (approval page or Kkoma, with
    the second factor), unless the user first turns `can_approve` on for it (browser + second factor) and approves
    in its terminal. D-ID-6 (a)'s "own terminal approval" option is then unavailable on that device.
  - **A terminal approver needs `aigentry-brain` installed and bootstrapped on that computer** (round-9
    non-blocking 7): `aigentry-devkit approve` runs `aigentry-brain trust refresh` and reads its trust state (above),
    so a computer with devkit alone cannot approve from its terminal. This is a CLI/installation fact of the terminal
    channel; the approval page and a Kkoma device do not need it.
  - **Under D-ID-6 (e) (B)** (recommended, pending; decision bundle 2l), every key rotation of a device, and every
    return of an `expired` device that a reader holds for (I5), is approved on a `device` channel: Kkoma as a device
    in `T`, or one of the terminal steps above. **With two computers and no Kkoma `device`** (round-10 blocking 2)
    that terminal is on the computer that holds the change: turn `can_approve` on for it (browser + second factor)
    if it is off, run `aigentry-devkit approve` in a terminal on it (SSH or a telepty session), and optionally turn
    approval off again; each rotation of either computer repeats this on the other. On a Windows holder this path
    is unverified (CK-28 (j) BLOCKED), so such a user needs Kkoma as a device, or (A) (§B.1 "UX cost of (B)").
  - **After a "retry" refusal** the user runs `aigentry-devkit approve` without an id to find the re-created request
    (above).
  These are the places where a terminal can still be required. They are UX constraints for the user to decide in 2i
  (register Kkoma first, or accept the terminal steps), not a requirement cut.
Brain, ES-04 and every MCP tool only **request** approvals and **verify** them from a fresh list. No brain or ES-04
command and no MCP tool creates an approval, and the keeper's general `sign` refuses the approval prefix (I12).
**Platform scope.** Because any channel can approve, a device needs no terminal of its own for **its own** approvals:
a Windows device, or an always-on host driven only through agent sessions, is bootstrapped and endorsed from
another channel. It can still be the only approver of **another** device's change (round-10 blocking 2): under
D-ID-6 (e) (B) (recommended, pending; bundle 2l), with two computers and no Kkoma `device`, each computer's key
rotation (and return from `expired` that the other holds for) is approved only on the other computer's own terminal,
so the always-on host or the Windows device needs a terminal session of its own then (§B.1 "UX cost of (B)"); under
(A) the approval page covers it. A device that approves from its own terminal needs `aigentry-brain` installed there
(§B.1 "Channels"). What stays
Windows-specific is the terminal channel's console discipline on a Windows approver, the keeper's named pipe (ES-03
§5.1, Q-17) and the DPAPI key store (ES-01 §6, ID-11). All three are unverified, because no Windows runner exists
(D-Q-6, pending user decision; bundle 4c default "quote first"). Their rows (ES-01 ID-11, ID-24 (h); ES-03 Q-17;
ES-02 CK-28 (j)) are BLOCKED, and nothing here claims Windows support.

**Notices** (R6). Every addition, key change, revoke, registry fault and pending request is a notice in the trust
state, keyed by `(kind, device_id, age_recipient_seq)` and linked to its `request_id`. A notice is informational and
gates nothing; what gates is a missing approval (I5). Brain MCP tool results carry open notices and the
`TRUST_*_REQUIRED` / `RECIPIENT_CHANGE_UNAPPROVED` codes in a fixed template: the kind, `device_id`, fingerprint,
`age_recipient_seq` and `request_id`, with no registry- or device-supplied `name` or `os`. The template ends with:
"approve request `<request_id>` in Kkoma, on the registry approval page, or with `aigentry-devkit approve
<request_id>` in a terminal on a device that can approve. An agent must not approve it or answer that command;
brain cannot tell a person from a program that drives a terminal or holds a device key (N-U4). Checkpoint and
capture uploads are held until then." For a `recipient_accept` under D-ID-6 (e) (B) the template names only Kkoma and the terminal (no approval page). The other channels show the same data with names.

**Before the bootstrap.** Until a valid `bootstrap` approval is applied: `A` = {`r`}, nothing is pinned, `T` = {`r`}, no
item of another writer is accepted, I11's trigger does not fire, and the gate holds every checkpoint and capture
push (reason `TRUST_BOOTSTRAP_REQUIRED`). Nothing is encrypted to an unapproved set, and no capture is pushed readable
only by `r`. This applies to every fresh device, a user's first device included, because the root is taken from the
list. A `bootstrap` approval for a device whose trust state already has a `root` anchor is not applied
(`APPROVAL_INVALID:V2`: such a device creates no bootstrap request). After a trust-state loss the device is fresh
again (I3).

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
| trust refresh | brain only (`aigentry-brain trust refresh`, BR-6); the list itself through the keeper (I12). ES-04 calls the command and reads the persisted result | new `L`; under the trust-state lock: assigns `first_seen_by`, re-evaluates (I8), applies every approval that is valid on this reader (§B.1 "Approval", V1–V6), runs the self-audit of its own approvals (§B.1 "Audit"), computes `T` and `R`, records R6 notices, creates the approval requests that are due (through the keeper), writes the trust state |
| revoke | ES-01 `DELETE /devices/{id}` | sets `revoked_at` once; takes effect for `r` at `r`'s next fresh list (I8, I10) |
| bootstrap | the user, on any channel, approving `r`'s `bootstrap` request (§B.1 "Approval"); applied by `r`'s next trust refresh | pins the set `S` computed from a fresh list and the root; adds the `root` anchor. Before it, the device reports `TRUST_BOOTSTRAP_REQUIRED` and holds checkpoint and capture pushes |
| endorse | the user, approving an `endorse` request with endorser device `e` (terminal on `e`, or Kkoma when it is `e` and meets KK-1..KK-4; §B.1 "Approval", "Channels"); signed inside the keeper's `approve(request_id, expected_sha256)` (I12) | adds a record to `E`; counted on readers per E1–E4 |
| write | ES-02 `brain_checkpoint_write`, ES-04 capture | signed through the keeper; encrypted to `R`; state `written` in the outbox (local only) |
| rekey | ES-02 only, on an active device after a fresh list in which `R` holds a recipient `(device_id, age_recipient_seq)` not in the persisted `rekeyed_for` set (a new recipient, or a rotation once approved, I5), for its own `accepted` records. The seq is the **pinned** one, which changes only with an approved change of `age_recipient` (I5), so a re-registration of the same recipient with a higher seq re-arms nothing | writes one sibling of each unchanged signed record to the outbox (`written`; its `<n>` is assigned at push, I10 (ii)); adds those `(device_id, age_recipient_seq)` pairs to `rekeyed_for` once every sibling is written; it leaves the device only through push (I10). Cost: every active holder writes one sibling per accepted record per new pair; a sibling follows its record's retention class (ES-02 §8). Captures are never rekeyed (N-U5) |
| push | the pre-push gate (I10), and nothing else | fresh list → re-evaluate → reference check (I9) → re-wrap to `R` → commit → push |
| pull | brain P1/P2 pull, ES-04 fetch by id | new blobs enter the local tree; brain records them in `observed` under the trust-state lock; `first_seen_by` waits for the next fresh list. A pulled tracked path under `.aigentry/`, or a tracked symlink at or under `checkpoints/` or `trust/`, is `CHECKPOINT_REPO_TAMPERED`: reported, never read as state, never followed (I3). A pull that git refuses because a pulled commit holds an invalid path (e.g. a tree entry under `.git/`) is reported the same way (BR-5) |
| re-evaluate | every fresh list | I8 |
| rebuild index | after corruption or `kill -9` | rebuilds only the cache (cursor, heads); never the trust state (I3) |
| anchor-recover | the user, approving `r`'s `anchor` request (§B.1 "Approval"), which brain creates only when I11 fires | adds a local anchor to `A` on `r` only |

## B.3 Invariants

Each invariant names the ES-01 obligation (or "none"), the ES-02/ES-04 obligation, and the test rows in each spec.
"Rows" lists the spec row and case. Columns *Measures / Does not measure / Runnable now / Blocked on* are in each
spec's matrix (ES-01 §15.1, ES-02 §12, ES-04 §8). Every row cited here is a Linux fixture or BLOCKED. A Linux-fixture PASS
proves only that row's *Measures* column and never counts as cross-platform or real-endpoint PASS (requirement line 52).
No row has been run; nothing is implemented. I9 has no ES-01 row, because it involves no ES-01 data.

| # | Invariant | ES-01 obligation | ES-02 / ES-04 obligation | Tests |
|---|---|---|---|---|
| I1 | **Per user.** Trust, acceptance and recipients are computed only from `U`'s own authenticated list. An item under another `user_key` / `user_id` never counts. | The list is owner-filtered in the same SQL statement (§7.3); device bearer only; 404 for not-owned (§7.4) | ES-02 §5.4 rule 4, E1; ES-04 §6.1 `RESTORE_USER_MISMATCH` | ES-01 ID-3, ID-21; ES-02 CK-04, CK-21 (d); ES-04 WS-10 (a)(b) |
| I2 | **Server clock only.** Every decision that *accepts*, *trusts* or *anchors* uses only ES-01 `created_at`, `revoked_at`, and `first_seen_by` derived from `server_time`. Writer-clock fields (record / manifest `created_at`) are **never used to accept or anchor**; an approval carries only server-clock times (`issued_at`, `expires_at`, `approved_at`). They may only reject (`created_at ≥ revoked_at` → `*_DEVICE_REVOKED`). | `created_at`, `revoked_at` server clock, set once, never moved; `server_time` in every list response (§3.1, §8.1 R4, R6) | ES-02 §5.4 rule 5, E3, §4.2; ES-04 §6.1 | ES-01 ID-21; ES-02 CK-11 (iv-a); ES-04 WS-10 (e) |
| I3 | **Pins are monotone and durable.** A change of a pinned `fp`, `created_at`, `revoked_at` or verified `age_recipient` that is not a validly signed rotation (I5), or a disappearing `revoked_at`, or a pinned device missing from a later list, is a registry fault. So is a listed `status` that disagrees with `revoked_at` (round-8 non-blocking 8): `status: revoked` with a null `revoked_at` or one later than `S(L)`, or a `revoked_at` with `status` ≠ `revoked`. Such a device is treated as revoked (removals never hold), with `revoked_at` = the listed value when it is not later than `S(L)`, else `S(L)`. It is surfaced (R6). For `revoked_at` the earlier of pinned and listed is used, and a revoke is never undone; every other pinned field keeps its pinned value. A pinned device missing from the list leaves `T` (I8). Pins, anchors, endorsement states, outstanding approval requests, consumed approvals, the list snapshot of the last refresh (BR-6) and every item's `first_seen_by` / state / `restored_at` live in **one trust state per device**, at `<aig>/trust-state.json` in the brain repo's Git directory (§B.1 "Local state"), never in the work tree and never behind `.gitignore` (BR-5). Brain is its **only writer**: every write is a read-modify-write under the trust-state lock (BR-6), committed atomically (tmp → fsync → rename). It is never rebuilt from the repo or the registry, and no repo file is ever read as trust state: a pulled tracked path under `.aigentry/` is `CHECKPOINT_REPO_TAMPERED` (reported, never read). If it is lost or corrupt, the device is a fresh device: a new `bootstrap` request and approval, all `first_seen_by` from the next fresh list, no item accepted until then. | `public_key` immutable per id; revoked rows kept with `created_at`, `revoked_at`, `public_key`, `age_recipient`, `age_recipient_sig` for the account's life (D-ID-5, pending user decision; bundle 2d default) | ES-02 §4.1/§4.2 trust state and its location, §5.4 trust refresh, §8 retention; ES-04 consumes the same trust state read-only, after asking brain to refresh it (ES-04 §4 step 5, §6.1), and keeps only its own seen-ref item list (`<aig>/capture-seen.json`) | ES-01 ID-21; ES-02 CK-06 (trust state survives `kill -9`; deleted trust state → fresh-device behaviour), CK-21 (c), CK-27 (pulled tracked state path; pulled `.gitignore` edit; concurrent writers); ES-04 WS-10 (h) |
| I4 | **Trust.** `T` is the least fixpoint from `A` over endorsements counted by E1–E4. Nothing else confers trust: not a registry listing, a repo file, a **reference**, a writer-clock field, or another user's list. A local anchor is added only when I11 allows it. **The anchors and the endorsements themselves are inputs only through approvals that are valid on the reader** (§B.1 "Approval", V1–V6 and the approver rules): the root and the first pins only by a `bootstrap` approval, a local anchor only by an `anchor` approval, an endorsement only by an `endorse` approval signed by the endorser. No terminal, MCP tool, sync pass, flag or channel confers trust by itself; a channel only produces an approval record, which the reader checks. The sync pass, the gate, P2, ES-04 and every MCP tool only request approvals and report `TRUST_BOOTSTRAP_REQUIRED` / `TRUST_ANCHOR_REQUIRED`; before the bootstrap `T` = {`r`}. | FP format and the canonical signed form (`aigfp1:` + 32 lowercase hex, no dashes) (§8.1 FP); `fingerprint_local` from the keeper's `public_key` operation, never from a registry response (I12); the approval request and approval endpoints, the approval records in the list, `can_approve`, and the registry-side refusals (§8.2); `scope` with every `device_id`, status and the root id, registry-computed `S`, standing denials and the stale-scope refusal (§3.3, §8.2); the keeper's `preview_approval`, `approve(request_id, expected_sha256)` and `signed_approvals` (ES-03 §5.1) | ES-02 §5.6 E1–E4 (endorsements are `endorse` approvals; E4 uses the record's server-clock `approved_at`), bootstrap and recovery by approval, self-audit, §5.4 gate step 1 (bootstrap hold); ES-04 §6.1 uses `T` from the trust state and reports, never approves | ES-01 ID-22, ID-24 incl. (j) different bodies to display and keeper, (k) `scope` not hashing to the digest; ES-02 CK-11 (iv), CK-21 (d)(e), CK-03 (h) MCP-only bootstrap and anchor, CK-28 (approval primitive, incl. (m) substituted body, (n) self-audit, (o) Kkoma input discipline KK-4, (p) standing denial, (q) own listed key ≠ local key), CK-29 (product path with Kkoma, incl. two computers before Kkoma and the `whoami` comparison); ES-04 WS-10 (e), WS-11 MCP-only variant |
| I5 | **Recipient.** `d ∈ R` ⟺ `d ∈ T` ∧ `status = active` ∧ learned under a fresh list ∧ `age_recipient_sig` verifies with `d`'s **pinned** `public_key` over `"aigentry-age-recipient-v1|" + hex(public_key) + "|" + age_recipient_seq + "|" + age_recipient` ∧ `age_recipient_seq` ≥ the highest seq this reader has verified for `d`, pinned, in a notice, or bound in a `device` approval naming `d` as target whose signature and approver pass V1, V4 and V6 on this reader (an `endorse` or `recipient_accept`, valid or not under V3; round-7 non-blocking 5) **and whose `scope` entry carries `d`'s `age_recipient` and `age_recipient_sig` for that seq, that signature verifying with `d`'s pinned `public_key` (its listed one, with the bound `target_fp`, if unpinned) and that `age_recipient` having the bound SHA-256**, so the floor rises only to a value `d` itself signed (round-8 blocking 2; an approval without them raises nothing, and a `device` record with a non-empty bound seq whose copied values are missing or do not verify is recorded as a registry-fault notice, R6, its validity unaffected; the floor is an **inconsistency detector** only, because a malicious registry can omit the record or its unsigned copy, round-9 non-blocking 1) (lower, or equal with a different `age_recipient`, is a replayed older value: a registry fault) ∧ the `age_recipient` **equals the pinned one**. The pinned `age_recipient` and its seq are set or changed **only by an approval valid on the reader** (§B.1 "Approval"): a `bootstrap` approval (for the devices whose status in `S` is `active`, at the bound seq and hash), an `endorse` approval (for an endorsed device with no pin, only when its verified listed recipient has the bound hash; at the bound seq), or a `recipient_accept` approval (for a validly signed rotation, at the bound seq; kind `device` only under the recommended D-ID-6 (e) (B), §B.1 approver rules). A listed `age_recipient_seq` outside 1 … 2^31−1, or not in canonical decimal, is a registry fault (ES-01 §3.1; round-9 non-blocking 2). Trust and recipient are separate: an endorsement keeps `d ∈ T` across every later seq of `d` (§B.1 V3), and only the recipient waits for an approval. A verified value with a higher seq and the pinned `age_recipient` (e.g. `login` re-registering the same key, which signs seq + 1) is **not a change**: no notice, no hold, and the pin keeps its seq. A refresh that finds no such approval records the notice and leaves the pin as it is; it creates the `recipient_accept` request exactly while the hold condition below holds for `d` (§B.1 "Request"), so a change of a revoked, expired or untrusted device is a notice only, and every bootstrap approver's "approve it first" refusal names a request that exists (§B.1 "Channels"). **While some `d ∈ T` with `status = active` has a verified `age_recipient` that differs from its pin, or has no pinned one, the gate holds every checkpoint and capture push** (`CHECKPOINT_PUSH_HELD` / `CAPTURE_PUSH_HELD`, reason `RECIPIENT_CHANGE_UNAPPROVED`; outbox objects stay `written`; the profile push continues), so a change is neither used nor silently left out before a user has approved it. **Residual** (round-9 blocking 1): under D-ID-6 (e) alternative (A) a compromised registry can forge an `account` `recipient_accept`, and every reader then uses any recipient value the target's key signed, a denied one included (§B.1 "`account` `recipient_accept`", trace (16)); under the recommended (B) only a `device` approval, which the registry cannot forge, changes a pin. Removals (revoke, leaving `T`, `status ≠ active`, a signature or seq fault) take effect at once and never hold. An `expired` device that re-binds with its pinned recipient is not a change. A reader that bootstrapped while a device was `expired` has no recipient pin for it, so when that device logs in again, even with an unchanged key, that reader holds and requests a `recipient_accept` for it (one approval on any `device` channel, the account too only under D-ID-6 (e) (A); round-8 non-blocking 4, cost accepted). The reader itself uses its **local** age public key, never the registry's value, and is **not** in the hold condition (`d ≠ r`); a verified registry value equal to that local key updates `r`'s own pin without a notice (its own rotation); any other value is a registry fault. Before the bootstrap is confirmed (§B.1 "Before the bootstrap") nothing is pinned and the gate holds every checkpoint and capture push (`TRUST_BOOTSTRAP_REQUIRED`). A signature failure removes `d` from `R` and raises a registry-fault notice. Only `R` receives new records and captures. | Store and return `age_recipient_sig` and `age_recipient_seq`, and the `recipient_accept` approval records (§8.2); copy the target's `age_recipient` and `age_recipient_sig` into an `endorse` / `recipient_accept` request's `scope` entry at creation, copy `scope` into the approval record and list it (without its display fields, revision 11), so it outlives the request's purge (revision 10), refuse `age_recipient_seq` outside 1 … 2^31−1 before any write (422), refuse (422) such a request whose bound fp, seq or hash differs from the target's stored current values and (409) its approval once they have moved (§3.3, §8.2); the registry **refuses** `/devices/authorize` and `PUT /devices/me/age-recipient` when the signature does not verify or the seq is not greater than the stored one (defence in depth, never the trust basis); only the keeper signs this prefix (I12) | ES-02 §4.1, §5.4 trust refresh and gate step 1, §5.6 "Recipient" and the bootstrap bullet (own-list check); ES-04 §4 step 4 (R from the refreshed trust state), step 5 (hold) | ES-01 ID-21, ID-23 (c), ID-24 (n) bound values ≠ target's and `scope` in the listed record after the request's purge, (e) `account` `recipient_accept` refused under (B); ES-02 CK-21 (f), (f3) replay, (f5) seq floor from a `device` approval, (f7) forged `account` `recipient_accept` under (A) and (B), (k) two computers without a Kkoma `device` under (B), CK-28 (r) the channel reads only the list snapshot, (f6) a `device` approval bound to a seq the target never signed, CK-28 (m) list and preview disagree on a recipient, CK-21 (j6) the same on K, (f4) rotation held until a `recipient_accept` approval, CK-11b addition pinned only by its `endorse` approval, CK-03 (h) no pin before a `bootstrap` approval, CK-28 (wrong seq, replay, stale), CK-24 (h) same-recipient re-registration, CK-21 (h) same-key re-login and (i) rotation, each on an old and a fresh reader, CK-21 (j) rotation then revoke / expiry / rotation of an untrusted device, each followed by a fresh device's bootstrap on a terminal approver and on Kkoma; ES-04 WS-16 (f), (j) incl. the brain-pass-first variant, WS-11 MCP-only variant |
| I6 | **Acceptance under revocation.** An item `x` of a writer with `revoked_at` is accepted only if `created_at(x) < revoked_at` (necessary, never sufficient) **and** `first_seen_by(f) < revoked_at`, where `f` is the file (path + Git blob id; for a capture, the ref's commit id) from which this reader decrypted and verified `x`. **Acceptance is per file read; no bound transfers between files.** A rekey sibling, a conflict sibling or a re-pushed blob carries its own `first_seen_by`. A record seen earlier only as ciphertext (`pending_key`) is anchored by that early bound only if that same file later decrypts. Two files that decrypt to one `checkpoint_id` with different `content_sha256` are `CHECKPOINT_KEY_CONFLICT`, both surfaced, and neither inherits from the other. The writer signature covers `user_id\|checkpoint_id\|content_sha256` and is verified on the file read, so a forged sibling either fails it or is a different signed content judged by its own late bound. **No reference anchors anything**: being listed in `parents`, `resumed_from`, `workspace_capture_id` or `checkpoint_id` of any record confers nothing on any reader. Otherwise `*_REVOKED_WRITER_UNANCHORED`, restored only by an explicit user choice on that reader. That choice is local: it changes nothing on other readers. | `revoked_at` server clock, never moved (§8.1 R4) | ES-02 §4.2 (per-file `first_seen_by`, no inheritance), §5.4 rule 5 (reference clause deleted), E4; ES-04 §6.1 (per-commit bound) | ES-01 ID-21; ES-02 CK-11 (ii), (vi-c), CK-23; ES-04 WS-10 (c)(g) incl. the (g) reference variant |
| I7 | **Stale cache.** Items observed with no successful list fetch since are `provisional`. *May*: list, and restore labelled `provisional (device list as of …)`, a record whose writer is already confirmed trusted and non-revoked in the cache. *May not*: count an endorsement, apply any approval, add a trusted device, recipient or anchor, anchor anything, or be pushed past the gate (I9, I10). | `server_time` in every list response | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ES-01 ID-23 (d) (`server_time` in the list through the keeper); ES-02 CK-11 (vi) before refresh; ES-04 WS-10 (g) before refresh |
| I8 | **Re-evaluation.** Every fresh list, in order: assigns `first_seen_by`; recomputes `T` and `R`; and re-checks items. For a device whose `revoked_at` is new, it re-checks **all** of its items, so the writer-clock test (I2) also rejects an item first seen before the revoke but dated ≥ `revoked_at`, and old and fresh readers agree. For a device that **left `T`** without a revoke, it re-checks **all** of its items, which become `*_WRITER_UNKNOWN`. Failures are demoted (`DEMOTED:<code>`), never deleted. A demoted item leaves the heads, an earlier restore is reported with `restored_at`, and the cascade runs through endorsements. | list carries every state change (§8.1 R6) | ES-02 §5.4 "Re-evaluation"; ES-04 §6.1 | ES-01 ID-21, ID-23 (d); ES-02 CK-11 (vi) after refresh, (vii), CK-25; ES-04 WS-10 (g) after refresh |
| I9 | **References do not travel unaccepted.** At the gate, after the fresh list and I8, a record or capture whose refs point to an item that is **not** `accepted` on the writer (provisional, `*_UNANCHORED` even if user-restored, demoted, quarantined, unknown) is **held** (`CHECKPOINT_REFERENCE_HELD` / `CAPTURE_REFERENCE_HELD`; state stays `written`). It is released when the item becomes accepted, or when the user confirms the push after the disclosure "this continuation contains content from `<id>`, which your devices do not accept (`<code>`); it will be pushed under this device's signature. Other devices will still not accept `<id>`". The confirmation is per referenced item and never changes that item's state anywhere (I6). Items written by the writer itself are accepted on it. A `workspace_capture_id` counts as accepted on brain's gate only when it names a capture the writer itself wrote; brain reads no ES-04 state. On the ES-04 gate the state of a `checkpoint_id` is read from the trust state **written by the trust refresh this gate run requested** (BR-6), never from an older saved state; without that refresh the capture is held (`CAPTURE_PUSH_HELD`). | none (no ES-01 data involved) | ES-02 §5.4 gate step 3; ES-04 §4 step 5 | ES-02 CK-11 (vi-c), CK-26; ES-04 WS-16 (g), (j) |
| I10 | **Every push is gated.** No push sends a checkpoint or capture object encrypted to a device outside `R` of a fresh list. (i) **Every** writer of a checkpoint file (a new record, a rekey sibling, the one-time import) writes only to the outbox `<aig>/checkpoint-outbox/` in the Git directory, which no `git add` can stage whatever `.gitignore` says (§B.1, A.3). A checkpoint file that is not on `origin/main` is under `checkpoints/`, in the work tree or in a local commit, **only during a gated push attempt**. "Not on `origin/main`" means added or modified: `git diff --name-only --diff-filter=d origin/main..HEAD -- checkpoints/` (deletions, e.g. retention expiry, are not leftovers). If the attempt fails or crashes, the range is rebuilt and the file returns to the outbox: on failure at once, after a crash by the gate's startup check, which also moves back any uncommitted file under `checkpoints/`. Outside that window neither `origin/main..HEAD` nor the uncommitted work tree holds a `checkpoints/` path that is not on `origin/main`. (ii) Each gated push holds the one repo lock (BR-1) from its trust refresh to the end of the push: trust refresh (fresh list → I8) → hold while a recipient change is unapproved (I5) or a symlink is at or under `checkpoints/` or `trust/` in `HEAD` or the work tree (BR-5) → leftover check → I9 (new records only) → drop every rekey sibling whose record is no longer `accepted` → **re-wrap every outbox object, new record or rekey sibling, to `R`** (the gate keeps no record of earlier recipients) → assign each sibling's `<n>` after the pull, never overwriting a path that exists (an existing path with equal `content_sha256` is a no-op) → move into `checkpoints/`, opening every path component without following symlinks → commit → push. (iii) If the list cannot be fetched, the push is held (D-8 (b), pending user decision; bundle 2g default "hold"). (iv) Every brain push path (A.1: P1 with all its callers, P2) runs the gate, or refuses to push while `origin/main..HEAD` adds or modifies a path under `checkpoints/`. (v) An unpushed capture is kept outside `refs/`, in a capture outbox inside the brain repo's Git directory (ES-04 §4 step 5), which no `git add` can stage. The ES-04 gate holds `<aig>/capture.lock`, creates its local ref only inside a gated attempt and deletes it if the push fails, so a user's `git push --mirror` or `refs/*` refspec finds no unpushed capture outside that window. After a crash the window lasts until the next ES-04 run (captures are explicit commands, so possibly days); what a mirror push sends in it is wrapped to `R` of the crashed attempt's fresh list, the same residual as a checkpoint crash. **Until brain implements (iv) for every measured path, and BR-5/BR-6, checkpoint upload is disabled and the rekey pass does not run**: records stay `sync: local_only` (reason `push_gate_missing`), whatever the D-7 opt-in says. It is not "guarded". | the list fetch through the keeper (I12); `server_time` | ES-02 §4.4, §5.3 rekey pass, §5.4 gate; ES-04 §4 step 5; brain requirements BR-1..BR-3, BR-5 (B.5) | ES-02 CK-20 (a)–(d), (e) P2 `sync --tick`, (f) crash window, CK-24 (rekey sibling, uncommitted leftover, lock, (e) demoted after step 1, (f) `<n>` collision, (g) retention), CK-27 (b) pulled `.gitignore` edit, (d) pulled tracked symlink; ES-04 WS-16 (e), (i) mirror push and crash window; ES-01 ID-23 (d) (list through the keeper) |
| I11 | **Recovery is scoped.** `TRUST_ANCHOR_REQUIRED` is raised only when all hold: (0) the bootstrap is confirmed (before it, `TRUST_BOOTSTRAP_REQUIRED` is reported instead, §B.1 "Before the bootstrap"); (1) a fresh list in this pass; (2) `T` has no active device other than `r`; (3) `L` lists at least one active device `c ≠ r` with `created_at(c) < created_at(r)` (an older candidate), which `r` pinned in its bootstrap (an older listed device that `r` has not pinned is a registry fault, R6, and no candidate; §B.1 V3). Brain then creates one `anchor` request per candidate and reports only those candidates; the anchor is added only by a valid `anchor` approval (§B.1 "Approval": approver the candidate or the account, never `r`). Otherwise there is no prompt. On a device that is *older* than every untrusted active device, those devices get the normal `endorse` request (R6). With **no** active device other than `r` (a user's first device, or a **lone survivor** whose others are all revoked, expired or lost), there is no prompt and `r` proceeds as the only active trusted device; an `expired` older device that re-binds becomes an active candidate, and the trigger then fires. **Key-state codes are defined only by what `r` can compute** from its fresh list and its own key, because age stanzas do not name recipients and no recipient list is stored. They use `H` (§B.1), the **non-revoked** devices other than `r` that have a recipient, listed or pinned and missing: an `expired` device re-binds with the same `device_id` and key (ES-01 §5, ID-7) and may still hold and rekey the record; only `revoked` is terminal (ES-01 §8.1 R4). For a file `r` cannot decrypt: `H` empty → `CHECKPOINT_UNRECOVERABLE_KEY` / `RESTORE_UNRECOVERABLE_KEY` (non-claim N-U1), and that file keeps the code (state `unrecoverable_key`; it is not re-computed when a device registers later, because a later device can receive the record only from a non-revoked holder, and there was none). That state is assigned only after the bootstrap is confirmed, so its `L` was the list whose set `S` (every device listed, revoked and expired included) the user approved; before it, such a file stays `pending_key` and no key-state code is computed (N-U3); otherwise a checkpoint is `CHECKPOINT_PENDING_KEY`, listing the devices of `H` with the text "readable here only if one of them holds it and re-wraps it for this device; this device cannot tell whether any of them can", plus, for each `expired` one, "may become readable after `<name>` logs in again (`aigentry-devkit login`)", and never a promise that it will resolve. A capture is then `RESTORE_NOT_A_RECIPIENT` (terminal, N-U5). A root revoke is **permanent**: the root is the earliest `created_at`, revoked or not, and revoked rows are kept, so every later fresh device without a non-revoked chain must anchor once. | `created_at` server clock, set once, kept for revoked rows (D-ID-5, pending user decision); `status` tells `expired` (re-binds the same row and key, §5) from `revoked` (never re-bound, R4), and the list includes both (R3) | ES-02 §5.6 bootstrap and recovery, §5.3 (codes; rekey cursor per `(device_id, age_recipient_seq)`); ES-04 §6.1 / WS-11 | ES-01 ID-7, ID-21; ES-02 CK-03 (c)(d)(e)(f)(g)(h)(i), CK-21 (g), CK-24 (h) rotation and same-recipient control; ES-04 WS-11 (variants incl. expired peer, pinned-but-missing peer, MCP-only) |
| I12 | **One signer, one list fetcher, one trust-state writer.** The device private key is used only inside the devkit lease keeper (ES-03 §5.1). The keeper offers `sign(prefix, payload)` with the prefix allowlist `aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|`, and refuses every other prefix. `aigentry-device-v1\|`, `aigentry-age-recipient-v1\|` and `aigentry-approval-v1\|` are signed only inside the keeper's own `login`, refresh, `register_age_recipient` and `approve(request_id, expected_sha256)` operations; `approve` signs only when the request it fetches has a canonical string with the SHA-256 the caller previewed through `preview_approval(request_id)` (the caller still supplies no payload), and logs what it signed (`signed_approvals()`); `preview_approval` and `approve` are called only by the terminal channel (`aigentry-devkit approve`, §B.1 "Channels"), never by brain or ES-04; there is no `deny` operation (a terminal "no" is a local decline, §B.1 "Request"). It also offers `public_key()` / `fingerprint()`, `device_list()` (proxied `GET /devices?include=keys,approvals&all=true` with `server_time`), `device_me()`, `request_approval(action, fields)` and `signed_approvals()`. Brain (ES-02) and the ES-04 CLI are callers and start the keeper on demand; brain also calls `request_approval` and `signed_approvals` (self-audit). On a Kkoma device the app's own key store has the same discipline (KK-1). ES-04 uses `sign` only: it obtains the list and the trust state through brain's trust refresh (BR-6), and brain is the only writer of the trust state. If the keeper is unavailable, no record or capture is written and no checkpoint or capture push runs (brain's profile push is not affected): `CHECKPOINT_IDENTITY_MISSING` / `CAPTURE_IDENTITY_MISSING`. Running the keeper is D-Q-9 (pending user decision; bundle 4d default "on demand"). | ES-01 §8.1 R1, FP; ES-03 §5.1 operations, callers, D-Q-9 "Blocks" | ES-02 §5.1 precondition "sign operation available", §5.4 trust refresh; ES-04 §4 step 1, step 5 | ES-01 ID-23 (a)(b), ID-24 (g) approval prefix refused by `sign`, (j) changed body refused by `approve`; ES-02 CK-22, CK-27 (c), CK-28 (m)(n); ES-04 WS-16 (h), (j) |

**B.3 — verified by author (revision 11, 2026-10-13).** Revision 11 changes no invariant and no rule in the table
above: its only rule-text change is ES-01 §3.3 (the approval record omits `scope`'s display fields), which no
invariant reads; the rest is the CK-21 (f4) setup, the CK-21 (k) row, traces (19)–(20) and the two-computer cost of
(B) in prose. Basis: ES-01/ES-03 in clone `aigentry-orchestrator-wt-1204-idq` (revision-11 commit on top of
`fea3531`) and ES-02/ES-04 in this clone. Revision 10's own entry follows.
**B.3 — verified by author (revision 10, 2026-10-13).** Re-run of the table above after this cycle's edits, against
ES-01/ES-03 in clone `aigentry-orchestrator-wt-1204-idq` (revision-10 commit on top of `ec25a35`: ES-01 §3.3
`approvals` copy `scope`, §8.2 List returns it, `account` `recipient_accept` refused under D-ID-6 (e) (B), deny
wording and attribution, seq range; §9 `approve` reads the BR-6 list snapshot; D-ID-6 (b)(e); ID-24 (e)(n); ES-03
§5.1 "Authority" residual) and ES-02/ES-04 in this clone. Revision 9's own basis was the revision-9 commit
(`ec25a35`) on top of `f7c021a`: ES-01 §3.3 target
`age_recipient`/`age_recipient_sig` in the `scope` entry, denial key by fingerprint, `denied_by` and `can_approve`
attribution, retention note; §8.1 R2 floor wording; §8.2 422/409 on bound target values; §9 `approve` own-list check
and local decline; D-ID-6 (b)(d); ID-24 (l)(n); the keeper's `preview_approval` / `approve(request_id,
expected_sha256)` / `signed_approvals` unchanged, no `deny` operation) and ES-02/ES-04 in this clone.
Revision-6 traces (the approval primitive; (2) and (3) corrected in revision 7):
- (1) Fresh C, reached only through MCP calls and brain sync passes; the registry lists a fake root R′ with the
  earliest `created_at`. Every pass reports `TRUST_BOOTSTRAP_REQUIRED` and creates a `bootstrap` request with the
  digest of `S` ∋ R′. Nothing is pinned, `T` = {C}, R′ is in neither `T` nor `R`, and pushes are held. MCP has no tool
  that approves, and the keeper's `sign` refuses the approval prefix.
- (2) If the user approves on a genuine trusted device A's terminal, A displays only what `preview_approval`
  returned, recomputes the digest from the displayed `scope` (ids, fps, seqs, hashes, root) and compares it with its
  pins, so R′ is refused (`APPROVAL_SCOPE_MISMATCH`). If the registry serves A's display one body and A's keeper
  another, the keeper's hash check refuses (`APPROVAL_REQUEST_CHANGED`) and nothing is signed. If it serves both the
  same altered body, A signs exactly what A displayed and compared: a `scope` that does not hash to its digest is
  refused; a digest of `S′ ∋ R′` shows R′, which A refuses unless the user overrides R′ by name after seeing its fp
  (revision 8: the new device C itself no longer needs an override, so an override is asked only for an extra
  device and is not a routine step; a revoked R′ is inert and a fake root is refused without override, because
  `root_device_id` must equal A's own root anchor); an `endorse` for X instead of D shows X's fingerprint, which the
  user compares with D's `whoami`. C applies an approval only if its digest equals C's own (V3). If the registry
  forges an approval by R′ itself (R′ ∈ `S`), C accepts it: this is the trust-on-first-use residual (N-U3). The
  forged record is in the list; A, which does not trust R′, reports it as `APPROVAL_APPROVER_UNTRUSTED` (revision 8:
  the audit covers every `bootstrap` by an untrusted approver) unless the registry equivocates.
- (3) Replay of C's consumed `bootstrap` approval fails V5. The same approval applied on another device fails V2.
  After `expires_at`, the registry refuses the approval and the reader fails V4. A `recipient_accept` for B at seq 1
  when B lists a different recipient at seq 2 fails V3, unless it is the value already pinned (then a no-op, V5). An `endorse` A → B made at seq 1
  still counts when B lists seq 2 (V3 binds only the fp).
- (4) An `account` approval for an `endorse` request fails the approver rules (never allowed). For a `bootstrap`
  with another active device in `S`, it fails V6.
- (5) An agent on an approval-capable device calls the keeper's `approve` directly (or drives `aigentry-devkit
  approve` through `script` or telepty). The approval is valid: this is the N-U4 residual. It is visible in the
  approval history with that device as approver, and `can_approve: false` on agent hosts removes it.
- (6) An agent that drives only fresh C (its terminal, keeper and MCP tools), while the user's A is active: C's
  `bootstrap` approval must come from a device of `S` other than C. C's own signature fails the approver rules (V6),
  and an `account` approval fails them too, because `S` holds A. The same agent on C cannot approve an `anchor` for
  C (approver must be the candidate). Only an agent that also reaches A's keeper, or the account with its second
  factor, can (N-U4).
Revision-7 traces:
- (7) Same-key re-login. Reader A counted A → B (bound seq 1, hash h) and pinned B at (1, h). Mac B idles to
  `expired` and logs in again: B lists (2, h). On A, V3 for the `endorse` checks only B's fp (unchanged), so B stays
  in `T`; I5: verified, same recipient, higher seq → not a change; no notice, no request, no hold, I8 demotes nothing.
  Fresh reader C bootstraps afterwards: `S` holds B at (2, h), the bootstrap pins it there, and A → B counts on C
  (fp only), so B ∈ `T(C)` and ∈ `R(C)` with no hold. A reader D that counts A → B for the first time with B unpinned
  pins (1, h) because the listed hash is h; (2, h) is then not a change (CK-21 (h)).
- (8) Rotation. B rotates to (3, h′) (validly signed). On A, B stays in `T` (fp unchanged), its verified recipient
  differs from the pin → `RECIPIENT_CHANGE_UNAPPROVED` hold and a `recipient_accept` request for (B, 3, h′); the
  user approves it on any channel (a `device` channel under D-ID-6 (e) (B), revision 10); A pins (3, h′) and releases. A fresh reader C that requests its bootstrap while
  (3, h′) is not yet accepted: B is `active` in `S` and in `T(A)` and A's own hold condition holds for B, so the
  terminal channel on A refuses C's `S` and names the `recipient_accept` request for (B, 3) that A's own refresh
  created; C stays held (`TRUST_BOOTSTRAP_REQUIRED`); after that request is approved C's bootstrap is approved, pins
  B at (3, h′), and A → B counts on C (CK-21 (i)). Revision 8 removes the cases where no such request exists
  (traces (10)–(12)). The rotation is never used before an approval on any reader that
  bootstrapped through a pin-holding approver; an `account` bootstrap (first device, lone survivor) has no pins to
  compare (N-U3).
- (9) Kkoma join orders. Computer M first: M is the root. Kkoma K registers; K's `bootstrap` needs a `device`
  approver of `S` other than K (M); M → K needs `e ∈ T`, `e ≠` K, never the account (M). Both are one terminal
  session on M (`can_approve` on M, turned on with the browser and second factor if it was off). A later device D:
  its bootstrap and K → D from K alone; every reader counts K → D because M → K counts. K first: K is the root,
  bootstraps itself, and approves every later device; no terminal (CK-29).
Revision-8 traces (the release path of I5 for a fresh reader, joint round 7 blocking 1; approvers A = a terminal on
a trusted computer, K = a Kkoma device meeting KK-1..KK-4; both pinned B at (1, h)):
- (10) Rotate, then revoke before acceptance. B registers (2, h′); A and K record the notice, and while B is active
  and trusted their refreshes create the request for (B, 2) and hold pushes. The user revokes B instead. On A and K
  the hold condition no longer holds (B not active): removals never hold, the request is no longer re-created, B
  leaves `R` at once. Fresh C's `S` lists B `revoked` at (2, h′). A and K compare B by fp and `created_at` only
  (B is not `active` in `S`); B is revoked, so no override is asked. C's bootstrap is approved; C pins B's fp,
  `created_at` and `revoked_at`, no recipient for B. I5's release path is reached: nothing waits on B anywhere.
- (11) Rotate, then expire. As (10), but B goes `expired`. A and K: no hold, no request (B not active); C's `S`
  lists B `expired`; A and K compare fp only; if B ∉ `T(A)` it is shown for an override, otherwise no question. C
  pins no recipient for B. B logs in again: `login` re-registers its local key, (3, h′). Now on A: B active,
  trusted, verified h′ ≠ pin h → hold + request (B, 3); on C: B active, trusted (A → B counts, fp only), no pinned
  recipient → hold + the same deduplicated request. One approval on any `device` channel releases both (`recipient_accept`
  approver `e ∈ T`, `e ≠ B`; the account only under D-ID-6 (e) (A)). Reachable.
- (12) Rotate while untrusted on the approver. B is pinned on A (in A's bootstrap `S`) but not in `T(A)` (never
  endorsed, or its only endorser was revoked and not re-endorsed), and B registers (2, h′). A: no hold for B (not
  in `T`), no request. C's `S` lists B `active` at (2, h′). A compares B's fp and `created_at`, and asks the
  override for B, showing its fp and recipient hash; if the user overrides, C pins B at (2, h′), and B is in `T(C)`
  only through an endorsement (which the user approves after comparing fps). If not, the approval is declined and
  the user can endorse or revoke B first. No branch waits on a request that does not exist.
- (13) Trusted active rotation on the approver itself and on K: as trace (8); K's own refresh created the request
  (KK-2), so K's refusal names it. With the request denied earlier (standing denial), both name it with "clear the
  denial", which the user can do on the page or in Kkoma; or the user revokes B, which leads to (10).
In every case the bootstrap is reachable by a user action that is always available (approve the named request,
clear its denial, override, or revoke). Corrected in revision 9 (round-8 blocking 1): the revision-8 text claimed
that a recipient is pinned on C only when the approver compared it with its own accepted pin, but nothing compared
the `scope` value C pins with the approver's pin when the approver's own hold condition did not hold. With the
own-list check, a recipient is pinned on C for a device `active` in `S` only when (i) the `scope` value equals the
approver's own fresh list and (ii) for a device in the approver's `T`, it equals the approver's accepted pin (else
refused), or, for one outside it, the user overrode that device after seeing its hash.
Revision-9 traces (round-8 blocking 1 and 2, re-run against the new rules):
- (14) List/preview split (blocking 1). A and K pinned B at (1, h); B has a validly signed (2, h′) that the user
  denied (or that a same-uid `register_age_recipient` or a stolen B key made). The registry serves A's
  `device_list()` B = (1, h) and A's `preview_approval` a `bootstrap` for fresh C whose `scope` lists B = (2, h′)
  with a matching digest. A recomputes the digest of `S` from its own fresh list (B at (1, h)), which differs →
  `APPROVAL_SCOPE_MISMATCH` "scope differs from this device's list", exit 7, no override, nothing signed. If the
  registry instead serves A's list B = (2, h′) too, the list and the scope agree, and the pin comparison finds B
  active, trusted, hash h′ ≠ pin h → refused, naming the (standing-denied) `recipient_accept` request. Either way
  C pins nothing for B and stays `TRUST_BOOTSTRAP_REQUIRED`. The same on K (KK-2, KK-3). Only a registry that
  shows C a set other than the one it shows every genuine approver (equivocation, N-U3) gets past this, and then
  C's V3 fails unless C sees that same set. Corrected in revision 10 (round-9 blocking 1): "either way" holds only
  while A's pin is h; under D-ID-6 (e) (A) a forged `account` `recipient_accept` moves A's pin to h′ first (trace
  (16)). Revision 10 also names the data the check reads: A's list snapshot (BR-6), used only when its
  `server_time` is not earlier than the one A's refresh printed; a second fetch that returns another list is never
  consulted (CK-28 (r)).
- (15) Seq floor raised by an agent (blocking 2). An agent on trusted M (`can_approve` on), or a holder of M's
  key and bearer, asks `request_approval(recipient_accept, {target B, seq 2^53, sha x})`: the registry refuses it
  (422: the bound values are not B's stored ones). A stub that forges such a request and M's approval anyway, or a
  compromised registry: the record's `scope` entry cannot carry a B-signed `age_recipient` at seq 2^53 with hash
  x (B never signed one; the registry cannot forge B's signature), so readers do not count it in B's floor; it is
  an approval for a value B does not list, so it also fails V3 and confers nothing. B's floor, pin and membership in
  `R` are unchanged on every reader, old and fresh. An `endorse` bound to (B, 2^53, x) is likewise refused by the
  registry; forged, it still counts as an endorsement (V3 binds the fp only, M ∈ `T`, the N-U4 reach) but raises no
  floor. The replay check of round-7 non-blocking 5 is kept: a genuine `recipient_accept` for (B, 2, h′)
  carries B's own signature over (2, h′) in its listed record (which keeps `scope` after the request's purge,
  revision 10), so an unpinned reader G served B's older (1, h) still has floor 2 → fault. It is an inconsistency
  detector (e.g. a partial restore of the registry's `devices` table), not a defence against a malicious registry,
  which can omit the record or its unsigned copy (round-9 non-blocking 1).
  What remains: whoever holds B's own key can sign any seq for B, which is a compromise of B itself (revoke B).
Revision-10 traces (round-9 blocking 1–3, re-run against the new rules):
- (16) Forged `account` `recipient_accept` (blocking 1). A and K pinned B at (1, h); B lists a validly signed
  (2, h′) whose `recipient_accept` the user denied (or a same-uid `register_age_recipient` on B, or a stolen B key,
  made it). The compromised registry inserts an `account` `recipient_accept` for (B, 2, h′) with a `second_factor`
  string into every reader's list.
  - Under D-ID-6 (e) **(A)**: V1–V6 pass on A and K (V3: the bound values are B's verified listed ones; V6: kind
    allowed, `second_factor` present); A and K pin (2, h′), release their hold and encrypt to h′. A fresh C's
    bootstrap then passes A's own-list check and pin comparison (A's pin is h′), and C pins h′ too. No check sees it;
    the self-audit covers `device` approvals only. **I5 does not hold against a compromised registry under (A)**:
    this is the stated residual (§B.1 "`account` `recipient_accept`", N-U3), documented by CK-21 (f7).
  - Under **(B)** (recommended): the record fails V6 on every reader (`APPROVAL_INVALID:V6`), nothing is pinned, the
    hold and the `recipient_accept` request stay, and A's and K's refusal of C's bootstrap still names the denied
    request (trace (14)). The registry can forge no `device` approval, because `sig` must verify with the pinned
    key of an approver in `T(r)` (V6). What remains is N-U4 (an agent on an approval-capable device approves a
    genuine request) and N-U3 (a reader with no pin for B).
- (17) Approval record after the request's purge (blocking 2). A `device` `recipient_accept` for (B, 2, h′) by A is
  approved; 24 h later the request row is purged (D-ID-6 (d)). The listed approval record still carries `scope`
  with B's signed (2, h′) (ES-01 §3.3, §8.2 List), so an unpinned reader G served (1, h) has floor 2 → registry
  fault (CK-21 (f5), ID-24 (n)). A registry that strips the copy: G's floor does not rise, G records a registry-fault
  notice for the record, and nothing else changes (V3 and the pin use the verified listed value).
- (18) The channel's data (blocking 3). A runs `aigentry-devkit approve` for C's `bootstrap`: the refresh prints
  `server_time` t; A's channel reads `trust-state.json`, whose snapshot has `server_time` t (or later, after a
  concurrent refresh); it recomputes the digest from the snapshot, compares B's entry with `trusted`, `hold` and
  the pins, and asks. A stale or replaced file with `server_time` < t → refused, exit 7, "retry". The channel never
  fetches the list itself and evaluates no signature (I12; CK-28 (r)).
Revision-11 traces (round-10 blocking 1 and 2; no rule changed):
- (19) Two computers, no Kkoma `device`, under (B). H (always-on, `can_approve` off, D-ID-6 (c)) and L trust each
  other. L rotates to (2, h′). On H: L active, trusted, verified h′ ≠ pin → hold and a `recipient_accept` request
  for (L, 2). The approvers `e ∈ T(H)`, `e ≠ L` are {H}: L's own approval is refused (approver = target; 422, V6),
  an `account` one too (422, V6 under (B)). H's `aigentry-devkit approve` is refused while `can_approve` is off (exit
  7, nothing signed); after the user turns it on (browser + second factor), it approves on H's terminal, H's refresh
  pins (2, h′) and releases. A release path always exists, so no deadlock, but it needs H's own terminal; for a
  Windows H that terminal is CK-28 (j) BLOCKED, so there is no verified path (stated UX constraint, §B.1 "UX cost of
  (B)"; CK-21 (k)).
- (20) CK-21 (f4) re-run. While the stub serves B at (1, h), A's own-list check compares the bound (2, h′) with
  A's snapshot entry (1, h) and refuses (exit 7 `APPROVAL_SCOPE_MISMATCH`, nothing signed); an honest registry
  would also 409. After the stub serves (2, h′) again, A's checks pass, R's V3 finds the bound values equal to B's
  verified listed ones, and R pins seq 2. A served approval bound to (1, h) confers nothing on R: it is not B's
  verified listed value (V3), and it equals R's pin (at most a no-op, V5).
Rules are cited by section. "Counter-example" is the attack or case the author traced through those rules.
This column is the author's own check, not a review verdict (Rule 39). The reviewer re-checks it.

| # | ES-01 / ES-03 rule(s) | ES-02 / ES-04 rule(s) | Test rows | Counter-example traced → outcome |
|---|---|---|---|---|
| I1 | ES-01 §7.1 device bearer, §7.3 owner filter, §7.4 identical 404, §8.1 R3 | ES-02 §5.4 rules 2, 4; §5.6 E1; ES-04 §6.1 `RESTORE_USER_MISMATCH` | ID-3, ID-17, ID-18, ID-21; CK-04, CK-21 (d); WS-10 (a)(b) | U2 pushes into U1's repo → writer not in U1's list → `*_WRITER_UNKNOWN`. Holds |
| I2 | ES-01 §3.1 `created_at`/`revoked_at`, §8.1 R3 `server_time`, R4 | ES-02 §4.2 `first_seen_by`, §5.4 rule 5, §5.6 E3; ES-04 §6.1 | ID-21; CK-11 (iv-a), CK-25; WS-10 (e) | Backdated item → accepted only through a per-file server bound. Holds |
| I3 | ES-01 §3.1 immutable `public_key`, §8.1 R5 (change or disappearance = fault), D-ID-5 | ES-02 §4.1/§4.2 `<aig>/trust-state.json` (Git directory), §5.4 trust refresh and lock, §8; ES-04 §6.1 (reads it after a refresh; `RESTORE_TRUST_STATE_MISSING`) | ID-21; CK-06, CK-21 (c), CK-11 (vii), CK-27; WS-10 (h) | Registry clears `revoked_at` → earlier value used, B stays revoked. Trust state deleted → fresh device; ES-04 stops and points to the pending `bootstrap` request. Joint round 2 Exp1 (revoked B pushes a force-added `.aigentry/trust-state.json`; re-run in A.3) → the pulled file lands in the work tree, which brain never reads; `CHECKPOINT_REPO_TAMPERED`; `<aig>/trust-state.json` unchanged. A brain MCP pass, a P2 tick, a refresh that applies an approval and an ES-04-requested refresh at once → serialized by the trust-state lock, no lost update. Revision 9: a revoked R′ listed with a null or future `revoked_at`, or an active device listed with a `revoked_at` → registry fault, treated as revoked at the listed value or `S(L)`, never in `R`, `H` or I11's candidates (CK-21 (c)). Revision 10: the list snapshot (BR-6) is part of the one trust state, written by brain under the lock in the same atomic write; the terminal channel only reads it, and a snapshot older than the printed `server_time` is refused (trace (18)). Holds |
| I4 | ES-01 §3.3 `scope` (ids, hashes, root), §8.1 FP, R1 (`fingerprint()` via the keeper), R5, §8.2 approvals and registry-computed `S`; ES-03 §5.1 `preview_approval`, `approve(request_id, expected_sha256)`, `signed_approvals` | ES-02 §5.6 anchors, E1–E4, bootstrap and recovery by approval, self-audit (§B.1 "Approval", "Audit", "Channels"); ES-04 §6.1 (reports, never approves) | ID-22, ID-24 (j)(k); CK-11 (iv), CK-21 (d)(e), CK-27 (a), CK-03 (h), CK-28 (m)(n), CK-29; WS-10 (e)(f), WS-11 MCP-only variant | Cycle, reference, registry listing → no trust. A pulled file with a forged `anchors` entry → never read (I3). An agent-made `endorse` approval on an approval-capable device → N-U4 (stated, visible in the history, not prevented). Fake root at a fresh device's first fetch → traces (1)–(2) above. Round-6 blocking 2 (registry serves B's CLI an `endorse` of D and B's keeper an `endorse` of X) → the keeper's hash check refuses, nothing signed (ID-24 (j), CK-28 (m)); both served X → B displays X's fp, which is what B signs, and the user's comparison with D's `whoami` fails; an approval listed with B as approver that B's keeper did not sign → `APPROVAL_NOT_SIGNED_HERE` on B (CK-28 (n)). A Kkoma device signs only after KK-1..KK-4. Revision 8: a relayed agent message, a notification action or a deep link asks Kkoma to approve an `endorse` → the approval screen opens at most; no signature without the user verification on that screen (KK-4, CK-28 (o)); a Kkoma build without KK-4 gives only `account` approvals, which cannot endorse. A forged `bootstrap` of fresh C by R′ → reported on every genuine device that does not trust R′ (Audit, revision 8). Revision 9: a `scope` that differs from the approver's own fresh list → refused before the pin comparison, no override (trace (14)); a terminal or Kkoma "no" records no denial, so an agent-driven terminal cannot create a standing denial; a denial is keyed by the target's fp, so a seq bump does not re-prompt. Revision 10: the own-list check and pin comparison read only the BR-6 snapshot of the refresh the channel ran, never a second fetch (trace (18), CK-28 (r)); a forged `account` `recipient_accept` does not touch `T` (it changes a pin only, I5, trace (16)). Holds within N-U3 (first decision; the user's fingerprint comparison) and N-U4 |
| I5 | ES-01 §3.1 `age_recipient_sig`, §3.3 `scope_digest` (incl. recipient hashes), §8 (422), §8.1 R2, §8.2 `recipient_accept`; ES-03 §5.1 `register_age_recipient` | ES-02 §4.1, §4.2 `notices`, §5.4 trust refresh and gate step 1, §5.6 "Recipient" and E2; ES-04 §4 steps 4, 5 | ID-21, ID-23 (c), ID-24; CK-21 (f)(f2)(f3)(f4)(h)(i), CK-11b, CK-24 (h), CK-28; WS-16 (f), (j) | Substituted recipient without a valid signature → not in `R`. Registry replays B's older validly signed recipient → its seq is below the highest verified one → registry fault, B not in `R` (CK-21 (f3)). Joint round 3 scenario: B rotates (seq 2, possibly a same-uid agent); A's AutoCommitter debounce starts a push → the gate's refresh finds no `recipient_accept` approval for (B, 2), keeps the pin at seq 1, creates the request, sees an active trusted device whose verified recipient differs from its pin → `CHECKPOINT_PUSH_HELD` (`RECIPIENT_CHANGE_UNAPPROVED`); no blob is wrapped to either key of B; after the user approves (B, 2) on any channel, the next refresh on A sets pin = seq 2 and the next push wraps to it (CK-21 (f4)). An approval by B itself → refused (approver ≠ target). An approval bound to seq 1 replayed for seq 2 → V3. The same with D added by an `endorse` approval (CK-11b): D is pinned at the bound seq when its listed recipient has the bound hash; if D rotated meanwhile, D is trusted, unpinned and held until a `recipient_accept`. Round-6 blocking 1: same-key re-login of B (seq + 1) → the endorsement still counts (V3 binds the fp only), not a change, no notice, no hold, nothing demoted, on an old and a fresh reader (trace (7), CK-21 (h)); rotation → B stays trusted, held until `recipient_accept` (trace (8), CK-21 (i)); CK-21 (f2) now expects that hold. Rollback of the unapproved seq 2 to seq 1 → below the highest verified seq (the notice's) → fault. ES-04 after a brain pass → still unapproved → `CAPTURE_PUSH_HELD`, then pushes after the approval (WS-16 (j)). B's `expired` re-bind re-registers the same recipient at seq + 1 → not a change: no request, no hold (CK-24 (h) control). R's own key regenerated and registered → R is not in the hold condition; its self-pin follows its local key. Before the bootstrap → nothing pinned, pushes held (CK-03 (h)). Revision 8 (joint round 7 blocking 1): rotate then revoke, rotate then expire, rotate while untrusted on the approver, each before acceptance, then a fresh device's bootstrap on A and on K → traces (10)–(13): the bootstrap is approvable in every case, and C pins a recipient only for a device `active` in the digest-bound `S` that the approver compared with its own accepted pin or the user overrode (CK-21 (j)). Unpinned old reader G served B's older (1, h) after B's (2, h′) was accepted by a `device` `recipient_accept` in the same list → the bound seq 2 is the floor → registry fault, B ∉ `R(G)` (round-7 non-blocking 5). Revision 9: registry serves A's list B = (1, h) and the bootstrap preview B = (2, h′) → own-list check refuses, no override, C pins nothing (trace (14), CK-28 (m), CK-21 (j6)); agent-made or forged `device` approval bound to (B, 2^53, x) → registry 422; forged → no B-signed value for that seq in the record → floor unchanged, B ∈ `R` (trace (15), CK-21 (f6), ID-24 (n)); NB5 replay case unchanged (the genuine approval carries B's signed (2, h′)). Revision 10: registry forges an `account` `recipient_accept` for B's denied (2, h′) → under D-ID-6 (e) (A) applied on every reader and passed on to a fresh reader's bootstrap (**stated residual**, CK-21 (f7)); under the recommended (B) `APPROVAL_INVALID:V6` everywhere, pins, hold and request unchanged (trace (16)); the approval record keeps `scope` after the request's purge, so the floor input exists against a conforming ES-01 (trace (17), ID-24 (n)); seq 2^53 → 422 before any write (range 1 … 2^31−1). Revision 11: two computers without a Kkoma `device` under (B) → only the holding computer's own terminal approves the other's rotation (trace (19), CK-21 (k)); CK-21 (f4) re-run with its approval reachable (trace (20)); the approval record's `scope` without display fields still carries every floor input. Holds under (B) within N-U3 and N-U4; under (A) holds only against an honest registry (stated) |
| I6 | ES-01 §8.1 R4, R5 ("no other path, and no reference") | ES-02 §4.2 (per-file bound, `seen` keyed by file, no inheritance), §5.4 rule 5, §5.6 E4; ES-04 §6.1 (bound per ref commit; a checkpoint reference anchors nothing) | ID-21; CK-11 (ii)(vi-c), CK-23, CK-27 (a); WS-10 (c)(g) incl. the reference variant | Exp1 with forged `observed`/`seen` → never read (I3). Joint-review scenario: C holds B's P as `pending_key` (S1 < T); B pushes a backdated sibling r′ after T → the sibling's own bound S2 > T → `CHECKPOINT_REVOKED_WRITER_UNANCHORED`. Same content re-pushed → also unanchored (D-8 cost). D, which accepted r from P, sees r′ → `CHECKPOINT_KEY_CONFLICT`. Holds |
| I7 | ES-01 §8.1 R3 `server_time`; ES-03 §5.1 `device_list()` | ES-02 §5.4 "Stale-cache window"; ES-04 §6.1 | ID-23 (d); CK-11 (vi); WS-10 (g) | Provisional endorsement → counts for nothing; provisional record continued → held (I9). The rekey pass runs only after a fresh list and only on `accepted` records. Holds |
| I8 | ES-01 §8.1 R6, revoke-semantics row (all items re-checked) | ES-02 §5.4 "Re-evaluation" (all items of a newly revoked device; all items of a device that left `T`); ES-04 §6.1 | ID-21, ID-23 (d); CK-11 (vi)(vii), CK-25; WS-10 (g) | Writer clock ahead, first seen before T → now demoted on the old reader too (non-blocking 9 closed). Holds |
| I9 | none | ES-02 §5.4 gate step 3 (new records only; foreign capture ids held); ES-04 §4 step 5 | CK-11 (vi-c), CK-26, CK-24 (e); WS-16 (g), (j) | Rekey sibling → exempt from step 3, but dropped after step 1 if its record is no longer accepted. A continuation naming another device's capture → held. Capture naming B's record r, B newly revoked, no brain pass since → the ES-04 gate's trust refresh demotes r first → `CAPTURE_REFERENCE_HELD`; brain down → `CAPTURE_PUSH_HELD`. Holds |
| I10 | ES-01 §8.1 R1 (`device_list()` via the keeper), revoke-semantics row; ES-03 §5.1 | ES-02 §4.4, §5.3 rekey pass (outbox only, persisted `rekeyed_for`, disabled with upload), §5.4 gate (Git-directory outbox for every writer, "adds or modifies", uncommitted leftovers, repo lock from step 1, sibling re-check, `<n>` after the pull), §7 import via the outbox; ES-04 §4 step 5 (capture outbox in the Git directory, ref only inside a gated attempt, `capture.lock`, stated crash window); BR-1..BR-3, BR-5 | ID-23 (d); CK-20 (a)–(f), CK-24, CK-27 (b); WS-16 (e)(i) | Joint round 2 Exp2 (pulled `.gitignore` negates the outbox entry; re-run in A.3) → the outbox is in the Git directory, so `git add .` / `add -A` cannot stage it (CK-27 (b)). Retention-expiry commit → deletions only, not a leftover. Two rekeyers pick the same `<n>` → the second picks the next free `<n>` after its pull. Joint-review round 1 scenario: A's cache lists B, the rekey pass runs → siblings only in the outbox; AutoCommitter / P2 / manual push carry no `checkpoints/` path; the gate re-wraps to the fresh R. Crash between move and commit → start-up check before any commit. `git push --mirror` → no unpushed capture ref. Pulled tracked symlink `checkpoints/v1 -> ../.git/aigentry` → `CHECKPOINT_REPO_TAMPERED`, gate holds, no move follows it (CK-27 (d)). Pulled `.git/` tree entry → pull refused, reported, sync stops (availability only; CK-27 (e)). Residual: crash window, stated (CK-20 (f), CK-24 (b), WS-16 (i)). Holds |
| I11 | ES-01 §3.1 `created_at`, `status`, §5 idle expiry re-binds the same row and key, §8.1 R4, D-ID-5 | ES-02 §5.3 (codes from `H`; rekey cursor per `(device_id, age_recipient_seq)`), §5.6 trigger (candidate pinned), steps and permanence; ES-04 §5 / §6.1 (`RESTORE_NOT_A_RECIPIENT` terminal, `RESTORE_UNRECOVERABLE_KEY` only when `H` is empty) | ID-7, ID-21; CK-03 (c)–(g), CK-21 (b)(g), CK-11 (v), CK-24 (h); WS-11 | Joint round 3 scenario: A revoked, Mac B `expired`, fresh C → `H` = {B} → `CHECKPOINT_PENDING_KEY` listing B with the re-login hint, never `UNRECOVERABLE_KEY`; B logs in again → active older candidate → `TRUST_ANCHOR_REQUIRED` on C → anchor → B's rekey pass → records restore on C (CK-03 (g)); control B revoked → `UNRECOVERABLE_KEY`, and a later fresh E does not turn C's report into `PENDING_KEY` (sticky). Rotation: B loses its key file and registers seq 2 → once (B, 2) is approved, `(B, 2)` ∉ `rekeyed_for` → A's pass re-wraps its accepted records → B reads its older records (CK-24 (h)); the `PENDING_KEY` text no longer says "automatic after that device syncs". CK-03 (e) on E: A's records → `CHECKPOINT_PENDING_KEY` listing C with the "cannot tell" text, never a promise (E cannot know that C holds them as unrecoverable). Active non-recipient B, r encrypted to {A}, A revoked, fresh C → `CHECKPOINT_PENDING_KEY` listing B, same text (CK-03 (f)). Fresh C after an anchor: B's old captures stay `RESTORE_NOT_A_RECIPIENT` (no wait promised), and a new capture restores (WS-11 now tests only specified behaviour). Pinned, unrevoked B missing from C's list → B ∈ `H` → `PENDING_KEY` / `RESTORE_NOT_A_RECIPIENT`, never `*_UNRECOVERABLE_KEY` (CK-03 (i), WS-11). A queue-only device with no recipient → not in `H`. Before C's bootstrap → `pending_key`, no sticky code (the registry-omission case of joint round 4, non-blocking 5). Revision 7 (round-6 non-blocking 1): the registry lists a fake older device F′ and forges an `account` anchor approval for it → F′ is not pinned on C (not in C's bootstrap `S`) → registry fault, no candidate, no request, the approval fails V3; a forged `anchor` can only re-anchor a genuine pinned device. Endorsements re-made after recovery survive later seq bumps (V3). Holds |
| I12 | ES-01 §8.1 R1, FP, §8.2; ES-03 §5.1 identity operations (`preview_approval`, `approve(request_id, expected_sha256)`, `signed_approvals`, `request_approval`), "Authority", D-Q-9; KK-1 for a Kkoma device | ES-02 §5.1, §4.4, §5.6 self-audit; ES-04 §4 step 1 | ID-23 (a)(b), ID-24 (g)(j); CK-22, CK-27 (c), CK-28 (g)(m)(n); WS-16 (h), (j) | Keeper down → no record, capture or checkpoint/capture push, no request and no terminal approval; the profile push continues. `sign("aigentry-approval-v1|…")` → `SIGN_PREFIX_REFUSED`. `approve(request_id, expected_sha256)` with a body changed after the preview → `APPROVAL_REQUEST_CHANGED`, nothing signed (ID-24 (j)). ES-04 writes no trust-state byte (file-access audit, WS-16 (j)). Revision 10: `aigentry-devkit approve` makes no `device_list()` call and evaluates no recipient signature; it reads brain's snapshot (protocol capture, CK-28 (r)). Holds |

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
| (n) A headless refresh (gate, MCP sync pass) recorded `shown_at` while deferring the display, so a rotated or newly endorsed recipient was used in the same push before any user saw it (joint review round 3, blocking 1) | §B.1 "Shown", I5 (pin changes only when shown; unshown change holds the push), BR-6; superseded by (r) | ES-02 §5.4 "MCP and the gate show them at the next CLI/MCP interaction) and records `shown_at`"; I5 "recorded … by the trust refresh that showed it to the caller" |
| (o) `*_UNRECOVERABLE_KEY` ("this will not change") was assigned while an `expired` device, which re-binds with the same key, could still hold the records (joint review round 3, blocking 2) | I11 `H` = non-revoked devices; N-U1; sticky once computed (non-blocking 7) | "no active device other than `r`" as the code condition; "revoked or lost" in the N-U1 message |
| (p) An age-key rotation never re-armed the rekey pass, and the `PENDING_KEY` text promised "automatic after that device syncs" (joint review round 3, blocking 3) | §B.2 rekey keyed by `(device_id, age_recipient_seq)`; ES-02 §5.3 text | `rekeyed_for` as a device-id list; "(automatic after that device syncs)" |
| (q) The bootstrap and anchor confirmations, which set the root, the local anchors and the first pins, had no defined channel, and ES-02 ran the bootstrap "in its first sync pass", a channel that never counts as shown (joint review round 4, blocking 1) | §B.1 "Terminal rule" and "Confirmation", I4, I5, I11 (0), N-U3; superseded by (r) | ES-02 §5.6 "Brain runs the bootstrap in its first sync pass"; "The user confirms on C" without a command |
| (r) The terminal was the trust boundary, but a terminal answer does not prove that a person approved: `printf 'y\n' \| script -qc …` and telepty `spawn`/`inject` answer on the controlling terminal (joint review round 5, blocking 1; the user's design feedback, 17:42Z). Every confirmation was also tied to a terminal on the reader itself, so an always-on or Windows host waited indefinitely | §B.1 "Approval" (signed approval primitive owned by ES-01; V1–V6; approver rules; audit), I4, I5, I11, I12, N-U3, N-U4 | §B.1 "Terminal rule", "Shown", "Confirmation"; `aigentry-brain trust bootstrap\|anchor\|endorse`; `shown_at`; `RECIPIENT_CHANGE_UNSHOWN`; endorsement files `trust/v1/…endorse.json` and the `aigentry-endorsement-v1\|` prefix on `sign` |

## B.5 Requirements on aigentry-brain (not decided here; a brain-side task)

| # | Requirement | Measured basis |
|---|---|---|
| BR-1 | One gate function runs before **every** push of the brain repo: P1 `GitBackend.push` (and therefore every caller in A.1 P1 (a)/(b)), and P2 `SyncTick`'s push (`SyncTick.ts:173`). A path that cannot run it must refuse to push while `origin/main..HEAD` adds or modifies a path under `checkpoints/` (`--diff-filter=d`; deletions are not refused), and report why. **One cross-process repo lock** is held by the gate from its trust refresh to the end of its push, and by every other path that stages, commits or resets in the brain repo (`AutoCommitter`, pull-failure recovery, the TOFU commit, P2 if it is kept). The mechanism is brain's choice | A.1 (no lock today) |
| BR-2 | Startup check, before any commit or push path runs and under the BR-1 lock: if `origin/main..HEAD` adds or modifies a path under `checkpoints/` (crash inside a gated attempt), rebuild the range with `reset --soft origin/main` and move those files back to the outbox; move any uncommitted file under `checkpoints/` that is not on `origin/main` back to the outbox too (crash between the move and the commit) | I10 (i) |
| BR-3 | A repo-local `pre-push` hook that runs the gate is optional belt-and-braces only. It is never counted as coverage, because a global `core.hooksPath` disables it (A.1) | `hooks/index.ts:53` |
| BR-5 | **No security state behind `.gitignore`.** Brain keeps the trust state, its lock, the checkpoint index and the checkpoint outbox in the brain repo's Git directory (`<aig>`, §B.1 "Local state"), never in the work tree, and never relies on `.gitignore` for any file whose disclosure or replacement changes trust, acceptance or recipients. Brain never reads security state from a work-tree path. After every pull it reports a tracked path under `.aigentry/`, or a tracked symlink at or under `checkpoints/` or `trust/` or at `memory-profile.enc.json` (the TOFU write follows symlinks, `GitBackend.ts:162`), as `CHECKPOINT_REPO_TAMPERED` (commit and path named; the file is not read, followed or deleted). While such a symlink is in `HEAD` or the work tree, the gate holds checkpoint pushes, and every gate move opens each path component without following symlinks. A pull that git refuses because a pulled commit holds an invalid path (a tree entry under `.git/`) is reported as `CHECKPOINT_REPO_TAMPERED` "pull refused: invalid path in `<commit>`"; every later pull and brain's recovery fail the same way, so sync stops on every reader until the user repairs the remote (an availability attack, ES-02 §5.3 known limit) | A.3 (Exp1, Exp2, control); joint review round 3 (`.git/` tree entry refused, the pull stays wedged; tracked symlink into `.git/aigentry` reaches `<aig>`) |
| BR-6 | **One trust-state writer and `aigentry-brain trust refresh`.** Every write of the trust state (sync pass observation, trust refresh, gate, P2 if it runs the gate) is a read-modify-write under one cross-process trust-state lock (`<aig>/trust-state.lock`). Lock order: repo lock (BR-1) before trust-state lock, never the reverse. `aigentry-brain trust refresh`: takes the lock, fetches the list (with approval records) through the keeper, assigns `first_seen_by`, applies every approval valid on this device (§B.1 "Approval", V1–V6), compares the approvals naming this device as approver with the keeper's `signed_approvals()` (§B.1 "Audit"), runs the I8 re-evaluation, computes `T` and `R`, records R6 notices, creates the approval requests that are due through the keeper's `request_approval` (a 422 or 409 from it, i.e. a race with a rotation, is recorded as a notice and the refresh continues; the next refresh requests again with the new values, so it never fails the refresh or holds a gate by itself; round-9 non-blocking 6), writes the trust state with its **list snapshot** (below), releases the lock, and prints `{"server_time": …, "aig": "<absolute <aig> path>"}` on success (non-zero exit otherwise). Every refresh does the same, whoever runs it (gate, MCP sync pass, P2, the CLI, ES-04), and none needs a terminal. Brain creates no approval: it has no `trust bootstrap`, `trust anchor` or `trust endorse` command, no MCP tool, flag or form that approves, and it never calls the keeper's `approve`. Its MCP results carry `TRUST_BOOTSTRAP_REQUIRED` / `TRUST_ANCHOR_REQUIRED` / `RECIPIENT_CHANGE_UNAPPROVED` with the request id while they apply (§B.1 "Notices"). ES-04 calls it before every capture push and preview, reads `trust-state.json` under the printed `aig`, and uses it only when its `device_list.server_time` is **not earlier than** the printed one (a concurrent refresh can only have made it fresher; I9 holds for any list at least that fresh). **List snapshot** (round-9 blocking 3): the trust state's `device_list` holds, for the list this refresh fetched, `server_time`, `fetched_at`, and per listed device `id`, `fp`, `status`, `created_at`, `revoked_at`, `age_recipient_seq`, `age_recipient_sha256` (of the listed value) and `recipient_check` (`verified` \| `none` \| `fault:<reason>`, brain's I5 result; for this device itself `fault:own_key` when the listed value ≠ its local key), plus `root` (the earliest `created_at`), `trusted` (= `T`) and `hold` (the I5 hold set: `device_id`, seq, hash, `request_id`). It is written in the same atomic write as the rest of the trust state. The terminal channel (`aigentry-devkit approve`) reads it the same way as ES-04, read-only, with the same `server_time` rule, for its own-list check and pin comparison, and fetches no list of its own; a Kkoma device keeps the same snapshot (KK-2). Why a snapshot rather than a second fetch plus a brain evaluator call: the check must compare the request with the list brain evaluated, and one file written under the lock is that list; a second fetch could differ from it and would need a second evaluator. The mechanism is brain's choice | review non-blocking 8 (four writers today); blocking 3; joint round 5 blocking 1; round-9 blocking 3. Re-measured 2026-10-13 (brain `0ffa6ee`): `src/` has no trust state, device list or trust refresh today (search for `trust-state`, `trustState`, `trust refresh`, `device_list`, `deviceList`: no hits), so the snapshot is new; brain's only recipient list is `_aigentry.recipients` in the work-tree `memory-profile.enc.json` (`GitBackend.ts:129-136`, TOFU); its atomic-write helper is tmp → rename without fsync (`src/shared/AtomicWrite.ts:5-11`), so I3's tmp → fsync → rename needs more than that helper; P2's lock is a PID file `~/.aigentry/sync.lock` (`SyncTick.ts:11`, `:35-52`) that serialises P2 runs only, not a trust-state or repo lock (A.1 unchanged) |
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
  restored by any device, now or later. A lost device that is not revoked is not something a reader can tell from a
  signed-out one; only the revoked case is reported as unrecoverable (below). Data stays readable on devices that already hold a decrypted copy. New devices
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
- **N-U3 (TOFU).** A fresh device's first trust decision and every local anchor rest on the registry's list and on
  the approval the user gives for them (D-9, pending user decision; bundle 2h default). The device has nothing pinned
  yet, so it checks a `bootstrap` approver's signature against the key the **list** gives for that approver (§B.1 V6).
  A registry compromised at that moment can therefore list a fake device R′, put it in `S` and forge R′'s approval,
  and the fresh device accepts it. What the primitive adds against that registry:
  - a genuine trusted approver recomputes the digest from the `scope` it displays, refuses a `scope` that differs
    from its own fresh list (revision 9; no override), compares `S` with its own pins
    and its own root anchor and refuses a changed fp, `created_at` or root, or a missing pinned device, with no
    override (`APPROVAL_SCOPE_MISMATCH`); an extra `active` or `expired` device R′ it does not trust is refused unless
    the user overrides R′ by name after seeing its fp (an override the user should give only for a device they just
    added and compared with its `whoami`; the new device itself needs none); its keeper signs only the request it
    displayed (`APPROVAL_REQUEST_CHANGED`), so the registry cannot swap the body under a genuine approval;
  - an altered request breaks the digest (V3);
  - a forged approval by a device a genuine device does not trust is reported there when it names one of its
    trusted devices or is a `bootstrap` (`APPROVAL_APPROVER_UNTRUSTED`), and the named approver reports one its
    keeper did not sign (`APPROVAL_NOT_SIGNED_HERE`);
  - the registry computes `S` itself at request creation (defence in depth only).
  None of these helps against a registry that **equivocates** (shows the fresh device and the trusted devices
  different lists). Nor does it help when the user approves on a channel without pins (the approval page,
  Kkoma that is not a device, or a Kkoma build that does not meet KK-1..KK-4) without comparing fingerprints. An
  `endorse` swapped for another target still shows that target's fingerprint, which the user must compare with the
  new device's `whoami`; the channel cannot do that comparison for a device it does not yet trust. An `account` approval is a registry assertion; it is
  accepted for a first device, a lone survivor and anchors (§B.1 approver rules), where no trusted device
  exists to sign, and, only under D-ID-6 (e) alternative (A) (decision bundle 2l, pending user decision), for a
  `recipient_accept`. Under (A) a compromised registry can forge an `account` `recipient_accept` and so make every
  reader use any recipient value the target's key signed, including a denied rotation, a same-uid
  `register_age_recipient` on the target, or a stolen target key's value; only `device` approvals are cryptographic
  (round-9 blocking 1; trace (16)). Under the recommended (B) no `account` `recipient_accept` is valid. The comparison is of device keys, not of age recipients: `age_recipient_seq` protects only a reader
  that already holds a pin or a seq bound in a `device` approval for that device (I5), so a compromised registry
  can serve a reader with no pin for a device (a fresh reader, or an old reader for a later-joined device) that
  device's older, validly signed recipient, and no approval catches it unless a later seq is bound in an approval
  in the same list. That approval floor is an inconsistency detector (e.g. after a partial restore of the
  registry's `devices` table), not protection against this registry, which can omit the record or its unsigned copy
  (round-9 non-blocking 1). The `bootstrap` scope shows each device's `age_recipient_seq`; nothing more
  is claimed. Until a valid approval arrives, the device pins nothing, accepts no other writer's item and holds its
  checkpoint and capture pushes (I5). A registry that omits a device from `S` is caught only if the user notices the
  omission in the scope; `*_UNRECOVERABLE_KEY` is assigned only after the bootstrap (I11).
- **N-U4 (who can approve).** Brain verifies **that** an approval is valid. It cannot tell **who** acted. Neither can
  any channel's input discipline: a terminal answer does not tell a person from a program that drives a terminal.
  - Same-uid processes: the keeper accepts calls from any same-uid process (ES-03 §5.1 "Authority"), including an
    unconfined agent CLI. On a device with `can_approve: true`, such a process can call the keeper's `approve`
    directly, or run `aigentry-devkit approve` under a pseudo-terminal and type the answer. Joint review round 5
    measured `printf 'y\n' | script -qc '<cmd>' /dev/null` delivering `y` on `/dev/tty` from one agent CLI's shell
    tool.
  - Telepty-admitted callers: on hosts whose terminals are telepty sessions (requirement line 12), every caller the
    telepty daemon admits can spawn a command in a PTY and inject the answer, including peers on other hosts. While
    `TELEPTY_PEER_ALLOWLIST` is empty that is every host that can reach it (orchestrator design record
    `docs/designs/2026-07-30-telepty-820-loopback-trust.md`, telepty `ca44782`; whether #820 Stage 1/2 has shipped
    was not measured).
  - Remote channels: whoever holds the account session and its second factor can approve on the approval page or in
    Kkoma.
  - A Kkoma device's key: it is an approval reach like a terminal device with `can_approve: true`, and it can
    `endorse`. KK-4 narrows it to a user verification on Kkoma's own approval screen, so neither the agent-reply
    stream Kkoma relays, a notification action, a deep link, automation input, nor any interface the orchestrator
    or agents can call completes a signature. What remains is whoever controls the unlocked phone and passes its
    user verification, and a Kkoma build that breaks KK-4 (readers cannot tell; §B.1 "Channels"). "A program that
    controls the phone" includes remote control and mirroring of the phone: iPhone Mirroring from a Mac that an
    agent drives, Android screen-control apps, `scrcpy` (from knowledge, not measured). Where the verification is a
    biometric, such a program cannot give it; where the device passcode is accepted (D-ID-6 (b), pending), a
    program that types it can.

  So a prompt-injected agent with any of these reaches can bootstrap a device against a set that a compromised
  registry chose. It can also endorse a registry-listed device, which then becomes a recipient everywhere, and accept
  a rotation. It cannot remove a device from `R` by binding an approval to a seq that device never signed: the
  registry refuses such a request, and readers count only target-signed values in the seq floor (I5, trace (15)). The device-key and terminal checks only stop *incidental* paths: MCP tools, sync passes, pipes,
  stdin, flags and environment variables approve nothing (CK-03 (h), CK-28).
  **What the model itself narrows** (no setting needed):
  - the approver for a device is never that device while another active device exists (§B.1 approver rules), so
    an agent confined to the new device cannot trust it;
  - the keeper's prefix allowlist: `sign` refuses `aigentry-approval-v1|`, so no caller obtains an approval
    signature over a payload it chose; `approve(request_id, expected_sha256)` signs only the canonical string the
    keeper builds from the registry's pending request, and only when it hashes to the previewed value (I12);
  - each approval is single-use and bound to one target, seq and scope (V2–V5), so one agent-made approval cannot be
    reused for another device or a later rotation.

  **Mitigations, all on the user's side:**
  - an operating rule that agents never approve or answer an approval (stated in every MCP template, §B.1
    "Notices");
  - `can_approve: false` on hosts that agents drive (an always-on orchestrator host), so that approvals come from a
    phone or a laptop (D-ID-6 (c), pending user decision; recommended default: `login` asks on an interactive
    console, default answer no, and with no interactive console attached the device starts with it off, so the
    likely agent-driven first device does not approve by default; with a computer first and Kkoma later this makes
    the one-time terminal step of §B.1 "Product consequence" start with turning it on);
  - Kkoma registered as a device (D-ID-6 (b), pending), whose every signature needs a user verification on its own
    approval screen (KK-4, an obligation on a compliant build, not a setting);
  - telepty's peer allowlist and token kept in place (telepty #820);
  - the approval history, which lists every approval with its approver and channel;
  - revoking on suspicion: revoke a device you did not add (`aigentry-devkit device revoke`, I8), or delete
    `<aig>/trust-state.json` on a device that was bootstrapped without you, which makes it fresh (I3), and approve
    its new request yourself.

  **Availability residual** (round-6 non-blocking 3): any own device bearer, an agent on any device included, can
  deny a pending request and can switch `can_approve` off on any of the user's devices (ES-01 §8.2). Both only
  remove authority, never add it: a denial stands until the user clears it on the approval page or in Kkoma (§B.1
  "Request"), and `can_approve` is turned on again with the browser and the second factor. Round-8 non-blocking 2:
  an agent holding any own device bearer can poll `GET /approval-requests` and deny every request as soon as a
  refresh re-creates it after the user cleared the denial, and can switch `can_approve` off on every device, Kkoma
  included. That lasts until the user **revokes the device whose bearer does it**, not merely until the user clears
  the denial. The user finds that device in the approval history: every denial records `denied_by` and the channel,
  and every `can_approve` change records its actor and channel (ES-01 §3.3). An agent can therefore delay approvals
  until that device is revoked, never make one. Not restricted further, because restricting deny or `off` to fewer
  callers would add an authority rule that protects only availability.
  **Approval fatigue** (round-7 non-blocking 1): a device the user does not want trusted (a stray registration, or
  one made with a stolen account session) makes every trusted device and itself request an `endorse` for it in every
  refresh. Before revision 8 a denial was undone at the next refresh, so the prompt returned after every "no". Now
  one denial stands for that device key (keyed by its fp, so a seq bump does not re-prompt; for a
  `recipient_accept`, for that recipient), the registry rate-limits request creation per device bearer, and the
  durable answer stays "revoke a device you did not add". What remains: one prompt per unwanted device key (or per
  rotation to a new recipient), new prompts from a stolen account session that registers new devices, and a user
  who approves out of habit.
  **Bootstrap livelock** (round-7 non-blocking 6): a same-uid process that calls `register_age_recipient` in a loop
  on any device changes that device's seq, so every pending `bootstrap` digest goes stale and fresh devices cannot
  be bootstrapped while it runs (the registry refuses the stale approvals, so none is wasted). Availability only;
  remedy: stop the process or revoke that device.
  **Seq ceiling** (round-10 non-blocking 3): the keeper signs "the current seq read through `device_me()` + 1"
  (ES-01 §8.1 R2), so a compromised registry that reports 2^31−2 makes it sign the device's genuine recipient at
  2^31−1 (not a change on readers). Every later rotation or re-registration of that device is then refused (422
  `age_recipient_seq_out_of_range`, which the keeper and `aigentry-devkit login` report as the error), so
  `login` no longer repairs a later own-key fault on it. Remedy: register that computer as a new device
  (`aigentry-devkit logout --revoke`, then `login`; a revoked row is never re-bound, ES-01 §8.1 R4). A registry
  that reports a lower seq makes the keeper sign below readers' floor, a registry fault on readers. Availability
  only; a keeper-local high-water mark is not added.

  The same boundary covers local files: a same-uid process can edit `<aig>/trust-state.json` itself (add a `root`
  anchor or pins), write under `checkpoints/` or into `<aig>/checkpoint-outbox/`, and run `git push`. I3 and I10 hold
  for brain's and ES-04's code paths and for the user's ordinary pushes of what those paths left, not against a
  same-uid process that writes its own state or pushes its own files. A same-uid process can also read brain's `0600`
  age key file, so `register_age_recipient` widens nothing. A rogue `register_age_recipient` on device `r` itself makes
  the registry value differ from `r`'s local key, which is a registry fault on `r` (I5) and holds nothing on `r`. The
  remedy is to re-register the local key (`aigentry-devkit login` signs it at the next seq). On the other devices the
  rogue value waits for a `recipient_accept` approval (I5): under D-ID-6 (e) (B) a `device` one, which an agent can
  give only through an approval-capable device (above); under (A) also an `account` one, which a compromised
  registry can forge (N-U3).
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
format (no recipient names) is from knowledge. Revision 4 measured only the `--git-common-dir` resolution (§B.1).
Revision 5 measured, in one agent CLI's shell tool on this host, that fds 0–2 are not terminals and `/dev/tty` cannot
be opened (ENXIO); other agent CLIs, and pty-backed agent shells, were not measured. Revision 6 measured nothing new.
The `script` answer is joint review round 5's measurement. Telepty `spawn`/`inject` and peer admission come from the
orchestrator's design record (telepty `ca44782`), not run. The Windows console discipline (`GetConsoleMode`,
`CONIN$`) and node-pty's controlling-terminal behaviour are from knowledge. No registry approval endpoint, approval
page or Kkoma approval exists to measure. No spec tests were run. Revision 7 re-measured only `GitBackend.ts:87`
(the TOFU `syncRecipients()` call after a pull; `:86` is its comment; brain `0ffa6ee`). The Kkoma app was not read
(no Kkoma code is in the readable set), so KK-1..KK-3 are requirements, not findings. Revision 8 measured nothing
new: it changes rules only (no brain push path or trust-state claim changed, so no brain line was re-read). KK-4 is a
requirement on an app that was not read; its premise that Kkoma relays agent replies to the user is the requirement
doc (l.12, l.44), not code. Revision 9 measured nothing new either: it changes rules only (no brain push path or
trust-state location changed). The KK-4 platform facts (iOS Keychain access control with user presence, no
Ed25519 in the Secure Enclave, Android Keystore per-use authentication and Ed25519 from API 33, phone mirroring and
remote-control tools) are from knowledge, not measured. Revision 10 re-measured the brain trust-state basis of BR-6
(brain `0ffa6ee`: no trust-state, device-list or trust-refresh code in `src/`; `GitBackend.ts:129-136`;
`src/shared/AtomicWrite.ts:5-11`; `SyncTick.ts:11`, `:35-52`); no push path was re-read, because none changed. The
KK-4 attributes (Android `KeyInfo`, `BiometricPrompt`, attestation; iOS `SecAccessControl`, `LAContext` reuse
duration) and the PostgreSQL `int` range are from knowledge. Revision 11 measured nothing new: it changes the
approval record's copied fields and text only (no brain push path or trust-state claim changed, so no brain line was
re-read).
