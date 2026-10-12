# ADR — Account/device identity and authoritative shared task queue for environment continuity (task #2026101204, ES-01 + ES-03 + ES-08 linkage)

Status: **proposed** (architect, 2026-10-12). Specs:
`docs/specs/2026-10-12-env-continuity-identity.md` (ES-01) and
`docs/specs/2026-10-12-env-continuity-shared-queue.md` (ES-03, with ES-08 §12). Interface with ES-02/ES-04: the
shared invariants I1–I12 in `aigentry-orchestrator-wt-1204-ctxws`
`docs/specs/2026-10-13-env-continuity-interface-invariants.md` (A12; revision 2 of 2026-10-13 changes ES-01's
side only in I8, where a newly revoked device has **all** its items re-checked, and in N-U4, where a same-uid
process can sign endorsements; revision 3 of 2026-10-13 adds `age_recipient_seq` to the signed recipient so a
replayed older value is refused (I5), and makes ES-04 read the device list through brain's `trust refresh` (I12); revision 4 of 2026-10-13 changes ES-01's side only in wording: readers count an `expired` device, which re-binds with the same key, as a possible holder, so `*_UNRECOVERABLE_KEY` requires every other device to be revoked (I11, N-U1); no ES-01 rule changes; revision 5 of 2026-10-13 also changes ES-01's side only in wording: the reader's seq floor is the highest seq it has verified, pinned or in a notice, and the root and local anchors are confirmed only on a terminal through brain's `trust bootstrap` / `trust anchor` (I4, I5); no ES-01 rule changes; revision 6 of 2026-10-13 **changes ES-01**: bootstrap, anchors, endorsements and recipient-change acceptance become one signed approval primitive owned by ES-01 (A15; ES-01 §3.3, §8.2; invariants §B.1 "Approval"), and the terminal is one channel among three, not the trust boundary; revision 7 of 2026-10-13 **changes ES-01**: `scope` carries every `device_id`, recipient hash and the root id, the registry computes a bootstrap's set itself, the keeper adds `preview_approval`, `approve(request_id, expected_sha256)` and `signed_approvals`, and an `endorse` stays valid across its target's later seqs (A16); revision 8 of 2026-10-13 **changes ES-01**: each device's `status` is bound in the bootstrap digest, a denial stands until the user clears it, the registry refuses a stale bootstrap scope and an approver equal to the target and rate-limits request creation, `login` prints the local fingerprint, and a Kkoma device signs only under KK-4 (A17); revision 9 of 2026-10-13 **changes ES-01**: an `endorse` / `recipient_accept` request carries the target's signed `age_recipient` and is refused (422 / 409) when bound to values other than the target's current ones, denials are keyed by the target's fingerprint and attributed, `can_approve` changes are attributed, `aigentry-devkit approve` compares the request with its own fresh list and treats "no" as a local decline, and KK-4 binds the key's use to per-use OS authentication (A18); revision 10 of 2026-10-13 **changes ES-01**: an approval record copies and lists `scope`, the residual of an `account` `recipient_accept` is stated and D-ID-6 (e) asks the user whether that kind is allowed (decision bundle 2l, recommended (B) "no"; the registry then refuses it), `age_recipient_seq` is bounded to 1 … 2^31−1, `aigentry-devkit approve` reads brain's list snapshot, deny attribution and the KK-4 key attributes are named (A19)). Technical
choices are for the orchestrator to accept (Rule 24 / Rule 47 §1). The items in §5 touch
Rule 47 categories and need the user. **The canonical task-ID issuance scheme is not
decided here** (orchestrator guardrail 2026-10-12 13:59Z); it is D-Q-1.

## 1. Context (measured, file:line in the specs)

- The registry already has GitHub OAuth accounts (`users`, one tenant per user), JWT
  HS256 web tokens in cookies only, Redis-only revocation, and tenant-scoped API keys. The
  JWT path then substitutes *any* tenant API key, which drops user identity
  (`aigentry-registry/src/aigentry/api/v1/auth.py:71-82`). There is no device entity and
  no CLI login.
- devkit ships two binaries, `aigentry-devkit` and `aigentry-devkit-bootstrap`
  (`package.json:19-20`). The new commands go into `aigentry-devkit`; the build plan's
  `aigentry login` is renamed to `aigentry-devkit login`. devkit stores the registry API
  key in plaintext in `env.sh`/`env.ps1` and `install-state.json`.
- The orchestrator queue is a per-host, gitignored JSON file. Its only writer-side safety is
  a single-host atomic rename (`src/dispatch/cli.ts:869-881`). Linux ids are date-form
  integers. No id-allocator rule exists anywhere measured, and the Mac ledger could not be
  read.
- telesession already defines idempotent request records and an explicit "not
  exactly-once" stance (`API-CONTRACT-TELESESSION.md:141-147, 180-182`).

## 2. Decisions (technical — proposed for orchestrator acceptance)

| # | Decision | Spec |
|---|---|---|
| A1 | Build identity **on the existing registry account** (`users.id` = user_id). Add a `devices` entity with a server-issued UUID. No new OAuth provider or GitHub scope | ES-01 §2-3 |
| A2 | Register devices with a **device-code login** (RFC 8628 shape). The human step is the existing GitHub browser login, on any machine, so headless hosts need no GUI | ES-01 §4 |
| A3 | **Ed25519 device key** generated on the device. Every token exchange carries a proof-of-possession signature. Uses Node built-in crypto and the registry's existing `cryptography`, so no new dependency (제17조) | ES-01 §4-6 |
| A4 | Short **bearer access JWT** (`type=device_access`) plus a rotated refresh token with **reuse detection**. Revocation is **durable in Postgres** and checked (`FOR SHARE` against the revoke's `FOR UPDATE`) in the request transaction for every ES-0x request, reads included; no Redis dependency | ES-01 §5, §7.2 |
| A5 | The isolation key is **`user_id` on every row**, filtered in the same SQL statement. Not-owned = not-found (404). Admin role does not cross users. The tenant API key is not accepted on ES-0x endpoints | ES-01 §7 |
| A6 | Store the authoritative queue in **registry Postgres**, opt-in, with local-only mode unchanged | ES-03 §1, §11 |
| A7 | **Single-statement transactional claim**; per-task monotonic fencing token; server-clock leases with client-side `lease_remaining_s` and a safety margin; expired holders are refused even before anyone re-claims | ES-03 §4.2, §5 |
| A8 | **Idempotency keys** on all mutations, with telesession's semantics (dedupe / conflict / in-flight) stored in the effect's transaction | ES-03 §7 |
| A9 | **Reconnect/recreate, never live process migration.** Fenced work is preserved as evidence and never auto-merged | ES-03 §6, §9 |
| A10 | Keep the local `task-queue.json` shape as a **single-writer cache**, so the gate, `tq-*` and the release maintainer keep working. The gate adds alias resolution and a read-only lease view (mode-independent exit 11 held / 12 unavailable; exit 6 is already taken in `cli.ts`); the claim is a separate lease step before spawn | ES-03 §3.6, §11 |
| A12 | **One trust/revocation model shared with ES-02/ES-04**: ES-01 implements the ES-01 column of the interface invariants I1–I12 (ES-01 §8.1). The obligations are: the registry refuses an `age_recipient` whose signature does not verify or whose signed `age_recipient_seq` is not greater than the stored one, and readers refuse a lower `age_recipient_seq` than the highest they have verified, pinned or in a notice (I5); revoked rows keep keys, `created_at` and `revoked_at` (I3, I11); a revoke reaches Git-stored data only through each client's next list fetch (I8, I10); the canonical signed fingerprint form (I4) | two spec sets patched separately kept diverging (ctxws round 4, idq round 2 `interface_check`) |
| A15 | **Approvals are an ES-01 primitive** (interface invariants revision 6, §B.1 "Approval"; ES-01 §3.3, §8.2, §9, D-ID-6; ES-03 §5.1 `approve` / `request_approval`): a bootstrap, local anchor, endorsement or recipient-change acceptance is a registry record bound to approver (device key or account + second factor), target and scope (device id, fingerprint, `age_recipient_seq`, scope digest), freshness (server-clock window, nonce) and single use, listed for audit. Channels (terminal on a device that can approve, registry approval page, Kkoma/mobile) all produce it; brain, ES-04 and MCP only request and verify. The approver of a device is never that device while another active device exists. Residual: an approval proves the key or account, not the person (N-U4); a fresh device's first decision stays TOFU against the registry (N-U3) | a terminal answer does not show that a person approved (joint review round 5, blocking 1; user design feedback 2026-10-13 17:42Z), and a terminal-only confirmation conflicts with the product goal of managing devices from Kkoma/mobile (decision bundle 2i) |
| A16 | **Approval binding (interface invariants revision 7; ES-01 §3.3, §8.1 R1, §8.2, §9, D-ID-6; ES-03 §5.1)**: `scope` holds every `device_id`, fingerprint, recipient seq and hash of the set plus the root id, and `scope_digest` is computed from exactly those; every channel recomputes it and the registry computes a bootstrap's set from its own table; the keeper signs only the request its caller previewed (`preview_approval`, then `approve(request_id, expected_sha256)`), keeps a local log (`signed_approvals`) that readers use to audit approvals made in this device's name; an `endorse` binds the target's fingerprint for validity, its recipient seq and hash only for pinning. A Kkoma device gives `device` approvals only under KK-1..KK-3 | joint review round 6 blocking 1–3: a compromised registry could serve the display and the signer different bodies, `scope` had no ids to recompute the digest, and seq-bound endorsements dropped a device from every reader's trusted set at each re-login. The caller still supplies no payload and the prefix allowlist is unchanged |
| A17 | **Bootstrap release path and Kkoma input (interface invariants revision 8; ES-01 §3.3, §7.4, §8, §8.2, §9, D-ID-6 (b))**: the bootstrap `scope` and `scope_digest` carry each device's `status`, so a bootstrap pins recipients exactly for the devices that were `active` when the approver compared them; a denied request stands until the user clears it with the browser session (`clear-denial`, never a device bearer) or the target is revoked; request creation is rate-limited per device bearer; the registry refuses a stale bootstrap scope (409 `approval_scope_stale`) and an `endorse`/`recipient_accept` approved by its target; `aigentry-devkit login` prints `fingerprint_local`; a Kkoma device gives `device` approvals only under KK-1..KK-4, KK-4 being a user verification on its own approval screen for every signature | joint review round 7 blocking 1–2 and non-blocking 1, 4, 6, 8. A recipient comparison against devices that had no release path (revoked, expired, untrusted) blocked every later bootstrap; the reader-side rules are in the invariants doc, and ES-01 binds `status` so they are checkable. A denial that every refresh undid made a stray or hostile device prompt the user forever (approval fatigue). Kkoma relays agent replies, and its `device` approval is the only remote `endorse`, so it needs the same input discipline as the terminal and the account channel |
| A18 | **Own-list check and a target-signed seq floor (interface invariants revision 9; ES-01 §3.3, §8.1 R2, §8.2, §9, D-ID-6 (b)(d))**: `aigentry-devkit approve` (and a Kkoma device, KK-3) compares the request with its own fresh list before the pin comparison and refuses a difference with no override; an `endorse` / `recipient_accept` request carries the target's `age_recipient` and `age_recipient_sig`, copied by the registry, which refuses (422) a request and (409) an approval whose bound fp, seq or hash are not the target's current ones; readers raise a device's seq floor only to values that device signed; denials are keyed by `(action, reader, target, target_fp)` (`recipient_accept`: target, fp, recipient hash) and record `denied_by_device_id` and `denied_channel`; `can_approve` changes record their actor; a terminal "no" is a local decline (no keeper `deny`); KK-4's verification gates the key per use at the OS level; D-ID-6 (d) states that under its current wording a denial lapses after 24 h and cites bundle 2k | joint review round 8 blocking 1–2 and non-blocking 1–3, 5–8. Revision 8 let the bootstrap approver sign a `scope` recipient it never compared with its pin, so a registry that served the approver's list and the preview different values could pin a denied recipient on a fresh reader; and any `device` approver could bind an arbitrary seq and so remove the target from every reader's recipient set for good. Both fixes reuse values the approver or the target already holds instead of adding exceptions. A local decline keeps an agent-driven terminal from creating standing denials; attribution lets the user find the device to revoke |
| A19 | **Account recipient acceptance, approval records with `scope`, and the approver's list snapshot (interface invariants revision 10; ES-01 §3.1, §3.3, §8, §8.1 R2, §8.2, §9, D-ID-6 (b)(e); ES-03 §5.1 "Authority")**: approvals copy every request column, `scope` included, and the list returns it, so the target-signed values that readers' I5 seq floor reads outlive the request's 24 h purge; an `account` `recipient_accept` is a registry assertion that a compromised registry can forge (stated residual), and whether it is allowed is D-ID-6 (e), pending user decision, recommended (B) "no" with the registry refusing it (422); `age_recipient_seq` is validated against 1 … 2^31−1 before any write; `aigentry-devkit approve` reads the list snapshot written by `aigentry-brain trust refresh` (used only when not older than the printed `server_time`) and fetches no list itself; deny attribution per channel; KK-4's checkable key attributes and the passcode guidance text | joint review round 9 blocking 1–3 and non-blocking 1–5, 7. (B) is offered, not chosen: it trades the approval page's coverage of key rotations (bundle 2i) for I5 under registry compromise, which is the user's call (Rule 47: authentication / permission). Copying `scope` into the record reuses data the device row already keeps (D-ID-5). Reading brain's snapshot keeps one evaluator (I12) |
| A13 | **The lease keeper is the only signer and device-list fetcher**: `sign(prefix, payload)` with an allowlist of ES-02/ES-04 prefixes (ES-01 prefixes refused), `public_key`/`fingerprint`, `register_age_recipient`, `device_list`, `device_me`, `request_approval`, and `approve` (signs only a pending request's canonical string; called by `aigentry-devkit approve`, A15); brain and the ES-04 CLI are callers; a 제15조 contract (ES-03 §5.1, invariant I12) | idq round 2 blocking 1: ES-01 R1 named a keeper operation that ES-03 never defined; brain must not read the key store |
| A14 | **Device routes take the client IP from the socket peer**; forwarded headers are read only from configured trusted-proxy CIDRs (default none); the device-route limiter is independent of `RATE_LIMIT_ENABLED` (ES-01 §7.4). Error-path writes that must persist (reuse revoke, rejection events, `rejected` receipts) commit before an error body is returned (ES-01 §5, ES-03 §10, §12.2). The claim idempotency key is per dispatch attempt and a stored claim is replayed only while its lease is live (ES-03 §3.6, §7). The gate's offline cache exception is removed (ES-03 §3.6(4)) | idq round 2 blocking 2–6 |
| A11 | **ES-08**: dedupe on the `owner/repo#N` alias; durable receipt in the same transaction; issue content is stored as an untrusted blob, never in `desc` or instructions; no outward GitHub action in this release | ES-03 §12 |

## 3. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Git-file queue (synced `task-queue.json`) | Six concrete failures: clean auto-merge producing a double claim, claim unconfirmed until push, no CAS for fencing, client-set clocks, no per-user isolation with permanent history, manual offline divergence (ES-03 §1.1) |
| Reuse the web JWT cookies in the CLI | The cookie path is browser-only (`oauth.py:94-113,166`); the 7-day refresh is too short for devices that sleep; there is no proof of possession |
| Reuse tenant API keys as device credentials | No user or device identity (`api_key.py:21-31`), admin-created, no per-device revoke UX. Copying a key between machines is exactly what the requirements forbid (secrets must not be auto-copied) |
| GitHub's own device flow / new GitHub scopes | Needs a new OAuth app configuration and scope approval (not approved). Proves a GitHub identity but not possession of an aigentry device key |
| OS keystore through a native addon (e.g. keytar) | External native dependency (제17조, 제1조). OS-shipped CLIs/APIs are enough, with a file fallback |
| Redis as the lease store | Revocation already shows Redis is TTL/volatile (`revocation_service.py`). Leases and fences must survive restarts and sit in the same transaction as the task row |
| New network daemon/relay for queue sync (server-side or cross-host) | The registry API suffices for sync. A new network service is a network/ops change and adds weight (제1조). Not rejected: a device-local, user-level **lease keeper** with no listening network port (ES-03 §5.1), because a one-shot `dispatch.sh` and an agent-CLI orchestrator cannot heartbeat a 600 s lease; it is a new operational component and therefore decision D-Q-9 |
| A keeper `sign` operation over caller-chosen bytes with any prefix | a same-uid caller could then mint ES-01 proofs and age-recipient signatures; the allowlist keeps ES-01 prefixes keeper-internal (A13) |
| brain reads the ES-01 key store itself | contradicts "the keeper is the only reader" and spreads the key to a second process (A13, I12) |
| Keep `get_real_ip` (forwarded headers trusted unconditionally) for device routes | a client rotates the header to reset per-IP limits and to choose the network prefix shown on the approval page (`main.py:75-86`) |
| Keep the gate's offline cache exception and add an offline local attach | adds a second lease path that works without the server; removing the exception is simpler, and `--no-task` stays the escape hatch |
| Global id counter across users | Leaks activity volume across users and makes cross-user guessing meaningful. If a server counter is chosen at all (P-A), it is per-queue |

## 4. Constitutional review (위헌 심사)

- **제6조 주권 (local-first, opt-in sync):** satisfied only because account mode is opt-in,
  self-hosting is supported, local-only mode is unchanged, and full export exists. If a
  future change made the server queue mandatory, it would violate 제6조.
- **제17조 무의존:** satisfied. Ed25519 comes from Node crypto and Python `cryptography`
  (already a dependency). Key storage uses OS-shipped tools (`security`, PowerShell
  DPAPI) with a file fallback.
- **제15조 SSOT:** the `/api/v1/devices/*` and `/api/v1/queues/*` contracts, and the keeper's
  local protocol (ES-03 §5.1, consumed by brain and the orchestrator), must be registered in
  aigentry-ssot and approved by registry, devkit, brain and orchestrator before
  implementation. Not done here.
- **제4조 경계** (`tooling/instructions/CONSTITUTION.md:68-75`: client adapter only, no
  duplicate implementation, single source of truth). Identity, lease, fencing and the
  store are registry logic. devkit holds the client and key store. The orchestrator holds
  the gate/cache client. That part holds under every D-Q-1 option. Task-ID issuance depends
  on the option, so the verdict is given per proposal:
  - **P-A:** compliant. Issuance is registry logic; the orchestrator issues nothing.
  - **P-B:** the Mac orchestrator becomes the issuer, and other devices call it ("Mac
    allocator API"). Issuance is then core logic in the orchestrator, and the registry
    holds a second, mirror authority for the same IDs. That is two sources of truth for
    one fact, which 제4조(3) forbids unless the split is explicit. Admissible only if the
    allocator API is registered as an orchestrator contract in aigentry-ssot (제15조), the
    registry is declared a mirror that enforces uniqueness only, and the mirror reconcile
    is specified. Otherwise it violates 제4조.
  - **P-C:** every host runs a per-host counter, so issuance logic lives in a client on
    each host, and the registry only validates ranges and uniqueness. This is one
    implementation deployed many times, not a duplicate, provided the counter lives in
    exactly one client component (the devkit lease keeper, ES-03 §5.1) and nowhere in the
    orchestrator's gate. Admissible on that condition. A second counter anywhere else
    violates 제4조(3).
  The architect does not rank these. The boundary cost is an input to D-Q-1.
- **제14조 안전 가드:** migration, deletion and auto-reassignment are gated (§5).

## 5. Open decisions for the user (Rule 47)

| Id | Question | Category | Recommended default | Blocks |
|---|---|---|---|---|
| D-ID-1 | Device token lifetimes and the active-device cap | privacy / permission | access 15 min; refresh idle 30 d / absolute 90 d; rotation; proof checked first; previous-token retry re-rotates, older token with valid proof → revoke (ES-01 §5); at most 20 active devices per user | ES-01 impl |
| D-ID-2 | (a) Device secret storage location; (b) whether to move the existing brain age key (`~/.config/sops/age/keys.txt`, 0600 plain file; ES-02's proposed `age_recipient`) into the ES-01 store | privacy / permission | macOS Keychain via `security -i` with the secret on stdin (conditional on ES-09 verification; else re-decide), file store on macOS only with explicit `--keystore file`; Linux 0600 file under `~/.config/aigentry/device/`; Windows DPAPI file via PowerShell reading stdin; never env/state files, never argv. (b) do not move in this release: brain owns the key and its readers (제4조), and moving it risks the only decryption key; record the gap and leave it to a brain-side task | ES-01 impl |
| D-ID-3 | Enable the new device credential type + endpoints on a deployed registry | permission expansion / production deploy | ship disabled (`DEVICE_AUTH_ENABLED=false`); enable per instance after ES-09 isolation PASS | ES-01/03 rollout |
| D-ID-4 | Every opted-in device talks to the registry over HTTPS | network change / personal-data transfer | only to the registry URL chosen at install; no new relay | ES-01/03 rollout |
| D-ID-5 | Retention of revoked/expired device rows and device authorizations | personal data | expired kept; revoked: `os`/`client_version`/`last_seen_at` cleared after 90 d, refresh hashes cleared at revoke, keys, `created_at`, `revoked_at` and all other columns kept for the account's life (ES-02/ES-04 signature, endorsement and recovery-order checks, interface invariants I3/I11); authorizations purged 24 h after terminal | ES-01 impl |
| D-ID-6 | Approvals: (a) second factor for `account` approvals and the first-device options; (b) Kkoma/mobile as an ES-01 device with its own key; (c) `can_approve` default; (d) retention of approval requests and approvals; (e) whether an `account` approval may accept a recipient change (ES-01 §10) | authentication / permission / personal data | (a) WebAuthn passkey; first device offered its own terminal approval and an account approval; (b) yes, key in the platform store; a `device`-approving build must meet KK-1..KK-4 (KK-4: user verification on Kkoma's own approval screen for every signature, never from a relayed message, notification, deep link, automation or orchestrator/agent interface; an obligation, not an option), otherwise `account` approvals only; (c) revised: `login` asks on an interactive console (default no), off with no interactive console (likely the agent-driven first device), Kkoma on, turned on later with browser + second factor; (d) requests 24 h after a terminal state, approvals for the account's life; (e) (B) no: a forged `account` `recipient_accept` would put a recipient the user never accepted into use on every reader; cost: key rotations need a `device` approver (Kkoma as a trusted device, or a trusted computer's terminal) | approval endpoints enablement (D-ID-3); decision bundle 2i, 2l |
| D-Q-1 | **Canonical task-ID issuance:** P-A server counter / P-B Mac ledger + mirror / P-C partitioned ranges, and whether to migrate | operational data change; network change if P-B | **none adopted.** First: read the Mac ledger, run the mapping dry-run, agree a freeze (ES-03 §3.4). ES-03 §3.4 summarises the trade-offs with no ranking. Consequences that come with an option: P-B's new cross-host ID-request path (a network change that conflicts with D-ID-4 unless approved with P-B); the 제4조 boundary cost of P-B/P-C (§4) | ES-03 ids, migration, gate change |
| D-Q-2 | Registry Postgres as authoritative store for opted-in users | operational data / personal-data transfer | yes, opt-in, self-hostable | ES-03 impl |
| D-Q-3 | Execute the migration (M3/M5) | operational data change | only after D-Q-1 and the user's review of `mapping.json` | cutover |
| D-Q-4 | Server retention of notes/events | personal data | queue lifetime, export on demand | ES-03 impl |
| D-Q-5 | Default `reassign_policy` (autonomous takeover by Linux) | permission | `auto` for tasks Linux is configured to serve, else `manual` | ES-03 ops |
| D-Q-6 | Real macOS/Windows hosts or runners for the BLOCKED matrix rows | cost | none procured without approval; quote first; rows stay BLOCKED and support is stated Linux-only meanwhile | ES-09 cross-platform rows |
| D-Q-7 | Hosted Postgres storage for opted-in users on the cloud registry | cost / personal-data transfer | measure cost per user before enabling; per-user quota (proposal 100 MiB) | cloud rollout |
| D-Q-8 | Retention of ES-08 untrusted blobs and intake receipts (third-party authors' text) | personal data | blob deleted 90 d after the task is terminal; receipts metadata-only | ES-08 impl |
| D-Q-9 | Run the devkit lease keeper (new user-level resident process, ES-03 §5.1); it is also the only signer and list fetcher for ES-02/ES-04 (A13) | operational change | on-demand start (incl. by brain and ES-04), idle exit, no boot-time service or auto-restart | ES-03 impl; ES-01 local fingerprint; ES-02/ES-04 writes |

Separately approved items stay out of scope: new auth scopes/credentials, network changes,
restarts/relay activation (task approval 2026-10-12 13:47Z).

## 6. Consequences

- (+) One account sees one queue from any device. Concurrent claim and stale completion
  are structurally impossible to *record*. A lost device can be revoked.
- (+) The existing release projection and local-only users are unaffected. The gate's existing
  exit codes keep their meaning; exits 11 and 12 are added, in account mode only (A10).
- (−) ES-02/ES-04 writes and the local fingerprint depend on the lease keeper (A13). If D-Q-9 is
  declined, no checkpoint or capture can be signed.
- (−) An offline device cannot dispatch an account-mode task, even one it holds a lease for
  (A14). The escape hatches are `--no-task` and leaving account mode.
- (−) A registry outage stops claims and new ids under P-A. Work continues only inside
  live leases.
- (−) External side effects of fenced workers are not undone; reconcile only surfaces them.
- (−) Two pre-existing registry weaknesses remain until their own tasks: plaintext API
  key in devkit state, and OAuth state values in logs. The 32-bit `github_id` is noted.
- (−) The Mac ledger is the critical unknown for ids (D-Q-1).

## 7. Inputs for the cost re-estimate (replaces nothing; feeds the 32–64 agent-day placeholder)

Learned from source (not schedules):

- **Identity (3–6 placeholder):** the reusable base is larger than assumed (accounts,
  JWT, Redis, `cryptography` present). The slowapi `Limiter` exists but is not wired
  (no middleware; ES-01 §1.4), so per-route limits on `/devices/*` and their
  fail-closed behaviour are new work. The new surface is still real: 2
  tables, about 7 endpoints, an approval page in the frontend (a frontend dir exists and
  was **not read**), bearer auth dependency, refresh family, a per-OS key store in devkit
  (3 OS paths), and 4 CLI commands. G2 is closed only for the new ES-0x endpoints
  (a new dependency, `get_current_device`); the shared `get_current_user_or_key` is not
  changed, so this spec carries no regression risk from G2. The general G2 fix is a
  separate registry issue and is not priced here. **Estimate pressure: upper half.**
- **Queue (5–10 placeholder):** about 7 tables, about 11 operations, a sync/cache client,
  gate changes in `cli.ts` (resolve + lease view + exit 11/12 + lease step with exit-hook detach + event ledger), the devkit lease keeper (resident process, local socket/pipe, ES-03 §5.1), and the reconcile
  path. The store import M1–M5 (backup, mapper, dry-run, review, import) is needed under
  **every** D-Q-1 option once D-Q-2 is adopted. P-C only avoids renumbering existing ids;
  P-A/P-B add the Mac seed/issuer read and renumbering or provisional handling. The
  lease keeper (ES-03 §5.1) and the ES-08 retry outbox are new client work under every
  option. **Upper half under P-A/P-B; mid-range under P-C.**
- **ES-08 contract:** small (one table, alias kind, fence wrapper for refs), because
  activation is out of scope.
- **Verification (ES-09):** the matrix needs real 2–3 devices and a real registry. Mac
  offline and no Windows runner were measured. The per-OS key-store rows (ID-11, Q-17)
  cannot be closed on Linux alone.
- **Cross-component approvals (제15조 SSOT)** add calendar latency that the placeholder
  does not include.
- **Not measured:** registry deployment state, frontend code, Mac ledger, Postgres
  config. Each could move the estimate.
