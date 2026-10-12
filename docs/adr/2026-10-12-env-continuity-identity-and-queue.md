# ADR — Account/device identity and authoritative shared task queue for environment continuity (task #2026101204, ES-01 + ES-03 + ES-08 linkage)

Status: **proposed** (architect, 2026-10-12). Specs:
`docs/specs/2026-10-12-env-continuity-identity.md` (ES-01) and
`docs/specs/2026-10-12-env-continuity-shared-queue.md` (ES-03, with ES-08 §12). Technical
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
| Global id counter across users | Leaks activity volume across users and makes cross-user guessing meaningful. If a server counter is chosen at all (P-A), it is per-queue |

## 4. Constitutional review (위헌 심사)

- **제6조 주권 (local-first, opt-in sync):** satisfied only because account mode is opt-in,
  self-hosting is supported, local-only mode is unchanged, and full export exists. If a
  future change made the server queue mandatory, it would violate 제6조.
- **제17조 무의존:** satisfied. Ed25519 comes from Node crypto and Python `cryptography`
  (already a dependency). Key storage uses OS-shipped tools (`security`, PowerShell
  DPAPI) with a file fallback.
- **제15조 SSOT:** the `/api/v1/devices/*` and `/api/v1/queues/*` contracts must be
  registered in aigentry-ssot and approved by registry, devkit and orchestrator before
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
| D-ID-1 | Device token lifetimes | privacy / permission | access 15 min; refresh idle 30 d / absolute 90 d; rotation; proof checked first; previous-token retry re-rotates, older token with valid proof → revoke (ES-01 §5) | ES-01 impl |
| D-ID-2 | (a) Device secret storage location; (b) whether to move the existing brain age key (`~/.config/sops/age/keys.txt`, 0600 plain file; ES-02's proposed `age_recipient`) into the ES-01 store | privacy / permission | macOS Keychain via `security -i` with the secret on stdin (conditional on ES-09 verification; else re-decide), file store on macOS only with explicit `--keystore file`; Linux 0600 file under `~/.config/aigentry/device/`; Windows DPAPI file via PowerShell reading stdin; never env/state files, never argv. (b) do not move in this release: brain owns the key and its readers (제4조), and moving it risks the only decryption key; record the gap and leave it to a brain-side task | ES-01 impl |
| D-ID-3 | Enable the new device credential type + endpoints on a deployed registry | permission expansion / production deploy | ship disabled (`DEVICE_AUTH_ENABLED=false`); enable per instance after ES-09 isolation PASS | ES-01/03 rollout |
| D-ID-4 | Every opted-in device talks to the registry over HTTPS | network change / personal-data transfer | only to the registry URL chosen at install; no new relay | ES-01/03 rollout |
| D-ID-5 | Retention of revoked/expired device rows and device authorizations | personal data | expired kept; revoked: `os`/`client_version`/`last_seen_at` cleared after 90 d, keys + `revoked_at` kept for the account's life (ES-02/ES-04 signature checks); authorizations purged 24 h after terminal | ES-01 impl |
| D-Q-1 | **Canonical task-ID issuance:** P-A server counter / P-B Mac ledger + mirror / P-C partitioned ranges, and whether to migrate | operational data change; network change if P-B | **none adopted.** First: read the Mac ledger, run the mapping dry-run, agree a freeze (ES-03 §3.4). ES-03 §3.4 summarises the trade-offs with no ranking. Consequences that come with an option: P-B's new cross-host ID-request path (a network change that conflicts with D-ID-4 unless approved with P-B); the 제4조 boundary cost of P-B/P-C (§4) | ES-03 ids, migration, gate change |
| D-Q-2 | Registry Postgres as authoritative store for opted-in users | operational data / personal-data transfer | yes, opt-in, self-hostable | ES-03 impl |
| D-Q-3 | Execute the migration (M3/M5) | operational data change | only after D-Q-1 and the user's review of `mapping.json` | cutover |
| D-Q-4 | Server retention of notes/events | personal data | queue lifetime, export on demand | ES-03 impl |
| D-Q-5 | Default `reassign_policy` (autonomous takeover by Linux) | permission | `auto` for tasks Linux is configured to serve, else `manual` | ES-03 ops |
| D-Q-6 | Real macOS/Windows hosts or runners for the BLOCKED matrix rows | cost | none procured without approval; quote first; rows stay BLOCKED and support is stated Linux-only meanwhile | ES-09 cross-platform rows |
| D-Q-7 | Hosted Postgres storage for opted-in users on the cloud registry | cost / personal-data transfer | measure cost per user before enabling; per-user quota (proposal 100 MiB) | cloud rollout |
| D-Q-8 | Retention of ES-08 untrusted blobs and intake receipts (third-party authors' text) | personal data | blob deleted 90 d after the task is terminal; receipts metadata-only | ES-08 impl |
| D-Q-9 | Run the devkit lease keeper (new user-level resident process, ES-03 §5.1) | operational change | on-demand start, idle exit, no boot-time service or auto-restart | ES-03 impl |

Separately approved items stay out of scope: new auth scopes/credentials, network changes,
restarts/relay activation (task approval 2026-10-12 13:47Z).

## 6. Consequences

- (+) One account sees one queue from any device. Concurrent claim and stale completion
  are structurally impossible to *record*. A lost device can be revoked.
- (+) The existing release projection, the gate's exit codes and local-only users are
  unaffected.
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
