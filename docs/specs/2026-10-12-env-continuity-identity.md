# ES-01 — Account + device identity for environment continuity (task #2026101204)

**Status:** CONTRACT SPEC ONLY. No code, no migration run, no credential created, no network
change. Parent task #2026101204 ("동일 계정으로 다른 머신에서 개발 작업 이어가기"), child ES-01
(runtime alias #2026101207). Decisions and rejected alternatives: ADR
`docs/adr/2026-10-12-env-continuity-identity-and-queue.md`. Consumer of this contract:
ES-03 `docs/specs/2026-10-12-env-continuity-shared-queue.md`. Trust, recipients, revocation effects on Git-stored
data, signing and the device list follow the interface invariants I1–I12 shared with ES-02/ES-04
(`aigentry-orchestrator-wt-1204-ctxws` `docs/specs/2026-10-13-env-continuity-interface-invariants.md`). Each
invariant names its ES-01 obligation; §8.1 implements them. Revision 6 (2026-10-13) adds the signed **approval**
primitive that the invariants now use for bootstrap, anchors, endorsements and recipient-change acceptance (§3.3,
§8.2; invariants §B.1 "Approval", I4, I5, I11, I12). Revision 8 (reconciliation cycle 8, invariants revision 8)
binds each device's `status` in the bootstrap digest, makes denials stand until the user clears them, refuses a
stale bootstrap scope and an approver equal to the target, rate-limits request creation, makes `login` print the
local fingerprint, and adds the Kkoma input obligation KK-4 (§3.3, §7.4, §8.2, §9, D-ID-6 (b)). Revision 9
(reconciliation cycle 9, invariants revision 9) copies the target's signed `age_recipient` into an `endorse` /
`recipient_accept` request, refuses such a request (422) or its approval (409) when its bound values are not the
target's current ones, keys denials by the target's fingerprint, records who denied and who changed `can_approve`,
makes `aigentry-devkit approve` compare the request with its own fresh list and treat "no" as a local decline, and
binds KK-4 to per-use OS authentication of Kkoma's key (§3.3, §8.1 R2, §8.2, §9, D-ID-6 (b)(d)). Revision 10
(reconciliation cycle 10, invariants revision 10) copies `scope` into the approval record and lists it, states the
residual of an `account` `recipient_accept` and adds D-ID-6 (e) (decision bundle 2l, pending user decision;
recommended default (B): the registry refuses that kind), bounds `age_recipient_seq` to 1 … 2^31−1, makes
`aigentry-devkit approve` read the list snapshot that `aigentry-brain trust refresh` writes, and names the KK-4 key
attributes (§3.1, §3.3, §8, §8.1 R2, §8.2, §9, D-ID-6 (b)(e), ID-24). Revision 11 (reconciliation cycle 11,
invariants revision 11) leaves `scope`'s display fields (`name`, `os`, `created_at`) out of the approval record, so
no `os` outlives D-ID-5's 90-day clear; states the two-computer cost of D-ID-6 (e) (B); drops the "same rule"
rationale for (B); and spells out the snapshot retry (§3.3, §8.2, §9, D-ID-6 (e), ID-24 (n)).

**Measured:** 2026-10-12 by reading source at the commits below (Rule 39 — every claim
re-read, not taken from the requirements or the build-plan draft).

| Repo (read-only) | HEAD read | Notes |
|---|---|---|
| aigentry-registry | `ac221cd` | auth, models, alembic, config, main |
| aigentry-devkit | `604f2b5` | CLI entry, install.sh, install.ps1 |
| aigentry-telesession | `90d88aa` (main) | PR #3 commit `b7effec` is **not** in this checkout — not read |
| orchestrator (this clone) | `71cc2da` | dispatch gate, release projection, rules |

**Not measured:** whether any registry instance is deployed, its version, its
`JWT_SECRET_KEY`/Redis/Postgres configuration, its TLS front, or whether GitHub OAuth is
configured in production. No network was used. Everything below is a source-level
contract; deployed behaviour is an ES-09 verification item.

---

## 0. Scope and non-goals

In scope: a stable `(user_id, device_id)` identity on top of the existing registry
account, device registration via a device-code login, device key material per OS, list /
rename / revoke, server-side isolation and enumeration prevention, token lifetimes, the
devkit CLI surface, migration for existing users, rollback.

Not in scope (explicit): new OAuth providers, new GitHub OAuth scopes, team/shared
workspaces (one owner per resource in this release), syncing any secret between devices,
live process migration (continuity is **reconnect/recreate only**), ES-02/ES-04 payload
formats.

Approval boundary (user approval 2026-10-12 13:47Z, task row `approval.not_approved`):
new auth scopes/credentials, network changes, operational restarts are **not** approved.
This spec therefore *defines* the device credential; issuing it in any deployed registry
is a separate Rule 47 decision (§10, D-ID-1..4).

## 1. What exists today (measured)

### 1.1 Accounts

- `users` table: `id UUID pk`, `github_id INTEGER unique`, `github_login`, `email`,
  `avatar_url`, `tenant_id FK tenants`, `role` default `writer`, `is_active`,
  `created_at`, `last_login_at` — model `src/aigentry/models/user.py:16-29`, migration
  `alembic/versions/20260309_000001_add_users_table_for_github_oauth.py:22-37`.
- First GitHub login creates **one tenant per user** (`slug = gh-<login>`) and the user in
  it — `services/auth/oauth_service.py:102-133`. Role is `admin` only for ids listed in
  `ADMIN_GITHUB_IDS`, else `writer` — `oauth_service.py:111-120`.
- GitHub OAuth web flow: `GET /api/v1/auth/github` → GitHub → `GET /api/v1/auth/github/callback`
  (`api/v1/oauth.py:28-128`, mounted at `/api/v1/auth` — `api/router.py:100`). Scope
  requested from GitHub is `read:user user:email` (`oauth_service.py:29`). CSRF state is a
  10-minute httpOnly cookie (`oauth.py:31-44`, checked at `:57-73`).

### 1.2 Tokens

- JWT HS256 signed with `JWT_SECRET_KEY` (`config.py:116-117`). Access: claims
  `sub, jti, github_id, github_login, role, tenant_id, exp, type=access`, lifetime
  `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` default 60 (`oauth_service.py:139-152`,
  `config.py:118-120`). Refresh: `sub, jti, exp, type=refresh`, default 7 days
  (`oauth_service.py:155-164`, `config.py:121`).
- Tokens travel **only as cookies**: `access_token` (path `/`, 1 h) and `refresh_token`
  (path `/api/v1/auth`, 7 d), httpOnly/secure/samesite (`oauth.py:94-113`). `/refresh`
  reads only the cookie (`oauth.py:166`). There is no bearer-header path for JWTs.
- Refresh rotates and revokes the old refresh `jti` (`oauth.py:186-191`). There is **no
  reuse detection** (a replayed old refresh token is only rejected while its Redis entry
  lives) and no token family.
- Revocation is a Redis key `revoke:<jti>` with TTL = remaining token life
  (`services/auth/revocation_service.py:10-29`). Not durable in Postgres.

### 1.3 API keys and sessions

- `api_keys`: `tenant_id`, `key_hash` (sha256), `name`, `role`, `is_active`,
  `expires_at` — `models/api_key.py:21-31`. **No `user_id`.** Raw key format `aig_<64 hex>`
  (`services/auth/api_key_service.py:20`).
- `get_current_user_or_key` accepts a JWT cookie but then returns **any active API key of
  the same tenant** (`api/v1/auth.py:71-82`). The user identity is dropped at that point.
- `user_sessions` are tied to an API key, not a user, 24 h (`models/user_session.py:21-25`,
  `services/auth/session_service.py:13`).
- Unauthenticated `POST /api/v1/tenants/bootstrap` creates the first tenant + admin key and
  is refused once any tenant exists (`api/v1/tenants.py:34-70`). devkit's self-hosted mode
  calls it (`aigentry-devkit/install.sh:699-707`).

### 1.4 Infrastructure that can be reused

- Request-scoped transaction: commit on success, rollback on exception
  (`db/session.py:10-20`). Postgres via asyncpg (`config.py:16-18`).
- slowapi is a dependency, but **default limits do not run** (re-measured 2026-10-12). `main.py:90-95`
  builds a `Limiter` with `default_limits=[settings.rate_limit_default]` (`100/minute`,
  `config.py:91-92`), storage `settings.redis_url` (`main.py:93`). It is attached to
  `app.state` with an exception handler (`main.py:107-108`). No `SlowAPIMiddleware` is
  registered: the only middlewares are `RequestLogMiddleware`, `CORSMiddleware` and
  `SecurityHeadersMiddleware` (`main.py:191-203`). Default limits apply only through the
  middleware, so no route has a default limit. The only `@limiter.limit` in `src/aigentry` is
  `api/v1/repositories.py:80`. It uses a **separate** `Limiter` instance with no `storage_uri`
  (`repositories.py:26`). Inference, not run: that instance uses slowapi's in-memory default.
  The orchestrator has filed this as the "registry rate-limiter issue". This spec does not fix
  it (§7.4).
- `cryptography>=43` and `PyJWT>=2.8` are already dependencies (`pyproject.toml:36-37`), so
  Ed25519 verification needs no new library.
- Alembic has a single head `20260319_000002` (computed from all `down_revision` values in
  `alembic/versions/`).

### 1.5 Client side (devkit)

- Two binaries are shipped: `aigentry-devkit` and `aigentry-devkit-bootstrap`
  (`aigentry-devkit/package.json:19-20`). Commands of the first are dispatched in
  `bin/aigentry-devkit.js:754-830`. There is no `login` or `device` command.
- The registry API key is written **in plaintext** to the env fan-out file
  (`install.sh:261-269`, file `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/env.sh`
  mode 600 — `install.sh:24-26`) **and** to `install-state.json`
  (`install.sh:242-246`). On Windows the same key goes to `env.ps1` and
  `install-state.json` without an ACL step (`install.ps1:17-19, 160-164, 176-184`).

### 1.6 Gaps this spec closes

| # | Gap | Evidence |
|---|---|---|
| G1 | No device entity, no CLI login | no `device` model in `src/aigentry/models/`; §1.5 |
| G2 | JWT path loses the user (tenant-key substitution). Closed **only for the new ES-0x endpoints** (§7.1). `get_current_user_or_key` stays unchanged for existing endpoints; the general fix belongs to a separate registry issue | `auth.py:71-82` |
| G3 | Revocation is Redis-only and TTL-bounded; a lost device cannot be revoked durably | `revocation_service.py:17-22` |
| G4 | JWTs are cookie-only; a CLI cannot present them | `oauth.py:94-113, 166` |
| G5 | Refresh rotation has no reuse detection | `oauth.py:186-191` |
| G6 | API keys are tenant-scoped, carry no user/device | `api_key.py:21-31` |

Observed but **not** fixed here (mentioned only, Rule 29): plaintext API key in devkit
state files (§1.5), with `install-state.json` written with no `chmod`, so its mode follows
the umask (`install.sh:255`); OAuth callback logs the CSRF state values (`oauth.py:59-72`);
`users.github_id` is a 32-bit `Integer` (`user.py:19`). Each needs its own task.

## 2. Identity model

```
user (existing users.id, UUID)          ← the account; one GitHub identity
 └─ tenant (existing, 1:1 with user today — oauth_service.py:102-109)
     └─ device (NEW)                     ← one installation on one OS user account
          ├─ device key pair (Ed25519)   ← private half never leaves the device
          └─ refresh-token family        ← rotated, server-side hash only
```

- **user_id** = existing `users.id`. Not re-keyed, not copied.
- **device_id** = server-issued UUIDv4, returned once at registration. A device is one
  *installation* for one OS user on one machine. Two OS users on one machine = two devices.
  Reinstalling without the old key material = a new device (the old one is listed and can
  be revoked).
- The isolation key for every ES-0x resource is **`user_id`**. `tenant_id` is stored too
  (existing quotas, future team scope) but is never sufficient for access by itself
  (contrast G2).

## 3. Data model (new alembic revision, `down_revision = "20260319_000002"`)

### 3.1 `devices`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID pk | server-generated |
| `user_id` | UUID FK users.id, not null, index | owner |
| `tenant_id` | UUID FK tenants.id, not null | copied from user at registration |
| `name` | varchar(64) | user-chosen, default `<os>-<short random>`; never the hostname unless the user typed it |
| `os` | varchar(16) | `macos` \| `linux` \| `windows` \| `other` (client-reported, informational) |
| `key_alg` | varchar(16) | `ed25519` (only value in this release) |
| `public_key` | bytea(32), unique | raw Ed25519 public key. Stays bound to the row after revoke, so a revoked device logs in again only with a **new** key pair and gets a new `device_id` (§5) |
| `age_recipient` | varchar(128) null | X25519 age recipient (`age1…`) for ES-02/ES-04 encryption (§8.1) |
| `age_recipient_sig` | bytea(64) null | Ed25519 signature by this device's key over `"aigentry-age-recipient-v1\|" + hex(public_key) + "\|" + age_recipient_seq + "\|" + age_recipient` (`age_recipient_seq` in decimal). It is bound to `public_key`, not `device_id`, because the device signs at `/devices/authorize`, before any `device_id` exists. The key never changes for a row, so the binding is just as strong. The registry cannot substitute the recipient without breaking the signature. It can replay an older validly signed value, but that value carries a lower `age_recipient_seq`, which readers refuse (§8.1 R2, R5; invariant I5) |
| `age_recipient_seq` | int null | rotation counter of the signed recipient: `1` for the first value, +1 for each rotation; signed together with the recipient. The registry refuses a value whose `age_recipient_seq` is not greater than the stored one (§8). Range 1 … 2^31−1 (fits `int`): the registry validates every client-supplied seq (`/authorize`, `PUT /me/age-recipient`, approval-request bound fields) against it **before any database write** and refuses one outside it with 422 (revision 10); readers parse it as a canonical decimal string, never through a floating-point number, and treat a listed value outside the range as a registry fault (interface invariants I5) |
| `age_recipient_set_at` | timestamptz null | server clock; set whenever a new signed recipient is stored (rotation is visible to R6 diffs) |
| `status` | varchar(16) | `active` \| `revoked` \| `expired` |
| `refresh_family_id` | UUID | current refresh family |
| `refresh_hash` | char(64) | sha256 of the *current* refresh token (issued, not yet presented) |
| `refresh_prev_hash` | char(64) null | sha256 of the token whose presentation produced the current one (§5 retry rule) |
| `refresh_rotated_at` | timestamptz null | when `refresh_prev_hash` last changed |
| `refresh_idle_expires_at` | timestamptz | sliding |
| `refresh_abs_expires_at` | timestamptz | absolute, set at registration / re-login |
| `client_version` | varchar(32) | devkit version string |
| `created_at` | timestamptz | **server clock**, set once when the device row is created (token exchange, §4). Never moved: an `expired` re-bind (§5) keeps it. ES-02 endorsement validity depends on it (§8.1 R5) |
| `revoked_at` | timestamptz null | **server clock**, set once by revoke, never cleared or moved (§8.1 R4) |
| `last_seen_at` | timestamptz | |
| `revoked_reason` | varchar(32) null | set only when `status='revoked'`: `user` \| `refresh_reuse` \| `admin_disable_user`. Idle expiry is **not** a revoke: it sets `status='expired'` and leaves `revoked_reason` and `revoked_at` null (§5) |
| `revoked_by_device_id` | UUID null | which device issued the revoke (audit) |
| `can_approve` | bool | whether this device's key may approve (§3.3, §8.2; default D-ID-6 (c)) |

Constraint: `(user_id, name)` unique among `status='active'` (partial unique index).

### 3.2 `device_authorizations` (device-code login, short-lived)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID pk | |
| `device_code_hash` | char(64) unique | sha256 of the 32-byte random device code |
| `user_code_hash` | char(64) unique among pending | sha256 of normalized user code |
| `public_key` | bytea(32) | key the device will be bound to |
| `requested_name`, `os`, `client_version` | | shown to the user on approval |
| `request_net_prefix` | varchar(48) | requester IP, taken from the trusted client-IP source of §7.4 (never from a client-supplied header unless the socket peer is a configured trusted proxy), truncated to /24 (IPv4) or /48 (IPv6); shown on approval; purged with the row |
| `age_recipient`, `age_recipient_sig`, `age_recipient_seq` | | optional (`age_recipient_seq` = 1); copied to `devices` on consumption (§8.1) |
| `status` | varchar(16) | `pending` \| `approved` \| `denied` \| `consumed` \| `expired` |
| `user_id` | UUID null | set on approval |
| `expires_at` | timestamptz | created + 600 s |
| `poll_interval_s` | int | 5, raised by `slow_down` |
| `last_poll_at`, `created_at` | timestamptz | |

Rows are purged 24 h after a terminal state. Raw device/user codes are never stored.

No existing table is altered. `users`, `tenants`, `api_keys`, `user_sessions` are
unchanged.

### 3.3 `approval_requests` and `approvals` (interface invariants §B.1 "Approval"; revisions 6–7)

An approval is the one primitive by which a user confirms a trust input: a device's **bootstrap**, a local
**anchor**, an **endorsement**, or the **acceptance of a recipient change**. ES-01 owns its format, storage and
server-side checks. Readers (ES-02 brain, ES-04) verify it from the device list (§8.2) and never create it.

`approval_requests` (harmless; confers nothing):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (v4) | `request_id` |
| `user_id` | FK → users.id | owner (§7.3) |
| `nonce` | char(32) | 128 random bits, server-generated; consumed by the one approval or denial |
| `action` | varchar(16) | `bootstrap` \| `anchor` \| `endorse` \| `recipient_accept` |
| `reader_device_id` | UUID null | the device the approval applies to (`bootstrap`, `anchor`); null for `endorse` / `recipient_accept` |
| `target_device_id`, `target_fp`, `target_age_recipient_seq`, `target_age_recipient_sha256` | | the bound target (fingerprint in the canonical signed form, §8.1 FP); for `bootstrap`, the reader itself |
| `scope_digest` | char(64) | for `bootstrap`: SHA-256 of the UTF-8 lines `device_id\|fp\|status\|age_recipient_seq\|age_recipient_sha256` of every device of the set to pin (`status` as listed: `active`, `expired` or `revoked`; revision 8), sorted by `device_id`, each ending in `\n`, then the line `root\|<root device_id>` (interface invariants §B.1 "Request"); empty otherwise |
| `scope` | jsonb | for `bootstrap`: `root_device_id` and, per device of the set, `device_id`, `fp`, `status`, `age_recipient_seq`, `age_recipient_sha256` plus the display fields `name`, `os`, `created_at`; for the other actions the same entry for the target, plus, for `endorse` / `recipient_accept`, the target's `age_recipient` and `age_recipient_sig` at the bound seq, copied by the registry from the device row at creation (revision 9; readers count the bound seq in their I5 seq floor only when that signature verifies, §8.1 R2). Every channel recomputes `scope_digest` from it (or checks the target entry against the bound fields) and refuses a mismatch (`APPROVAL_SCOPE_MISMATCH`); the registry checks it at creation (§8.2) |
| `requested_by_device_id` | UUID | the device bearer that created it |
| `issued_at`, `expires_at` | timestamptz | **server clock**; `expires_at` = `issued_at` + validity window (technical, proposed 15 min) |
| `state` | varchar(16) | `pending` \| `approved` \| `denied` \| `expired` |
| `denial_cleared_at` | timestamptz null | **server clock**; set when the user clears a standing denial (§8.2); null while it stands |
| `denied_by_device_id`, `denied_channel` | UUID null, varchar(16) null | revision 9: on a denial, the device whose bearer denied it (null = the browser session) and the channel (`approval_page`, `mobile`, `api`); shown in the history (§8.2) |

At most one `pending` request per `(user_id, action, reader_device_id, target_device_id, target_age_recipient_seq,
scope_digest)`; a duplicate create returns the existing one. A `denied` request with `denial_cleared_at` null
**stands** for its **denial key**: a create with that key returns it instead of a new request (§8.2). The denial key
is `(user_id, action, reader_device_id, target_device_id, target_fp)` for `bootstrap`, `anchor` and `endorse`, and
`(user_id, recipient_accept, target_device_id, target_fp, target_age_recipient_sha256)` for `recipient_accept`
(revision 9: a seq bump with the same key or recipient is not a new question). How long a denied request is kept is
D-ID-6 (d), pending user decision: bundle 2k proposes keeping it while the denial stands; under the current (d)
wording (requests purged 24 h after a terminal state) a denial lapses 24 h after it is made.

`approvals` (append-only; never updated or deleted while retained, D-ID-6 (d)):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (v4) | `approval_id` |
| `request_id` | FK, unique | one approval per request |
| every request column, `scope` included except its display fields | | copied, so the record verifies on its own; `scope` carries, for an `endorse` / `recipient_accept`, the target's copied `age_recipient` and `age_recipient_sig`, which readers' I5 seq floor reads, so they stay listed after the request is purged (D-ID-6 (d)); revision 10. Revision 11: the copy omits `scope`'s display fields `name`, `os` and `created_at`; it keeps `root_device_id` and, per device, `device_id`, `fp`, `status`, `age_recipient_seq`, `age_recipient_sha256` (the `scope_digest` lines, which never held a display field, so the digest still recomputes from the copy) and the target's `age_recipient` / `age_recipient_sig`. No reader reads a display field from a record (a `bootstrap` reader recomputes `S` from its own list, V3). Every copied field belongs to a column D-ID-5's default keeps on the device row for the account's life (a recipient value or hash may be an earlier seq's, the same class: a public key with its signature), so the copy adds no data class and no retention of personal data beyond D-ID-5; `os`, which D-ID-5 clears 90 days after `revoked_at`, is not copied. Chosen over clearing copied fields later, because records are append-only and the display fields are no floor or binding input. If the D-ID-5 decision clears a field the copy keeps, D-ID-6 (d) must cover the copy too (both pending user decision, bundle 2d) |
| `approver_kind` | varchar(8) | `device` \| `account` |
| `approver_device_id`, `sig` | UUID, bytea | kind `device`: Ed25519 over `"aigentry-approval-v1\|" + user_id + "\|" + request_id + "\|" + nonce + "\|" + action + "\|" + reader_device_id + "\|" + target_device_id + "\|" + target_fp + "\|" + target_age_recipient_seq + "\|" + target_age_recipient_sha256 + "\|" + scope_digest + "\|" + expires_at` (null as empty string; `expires_at` as RFC 3339 UTC), signed only inside the keeper's `approve` (§8.1 R1) |
| `second_factor` | varchar(16) null | kind `account`: the method used (D-ID-6 (a)); never a secret |
| `channel` | varchar(16) | `terminal` \| `approval_page` \| `mobile` (informational) |
| `approved_at` | timestamptz | **server clock**, set once |

`devices` gains `can_approve` (bool). Turning it **off** is allowed to any of the owner's device bearers or the browser
session; turning it **on** requires the account session plus the second factor (§8.2). The default is D-ID-6 (c).
Every change is recorded in the history with its actor (device id, or the browser session), channel and server time
(revision 9), so the user can tell which device switched approval off.

## 4. Device registration (device-code style login)

Modelled on the RFC 8628 device authorization grant, reusing the **existing** GitHub
browser login for the human step. No new GitHub scope, no GitHub device flow.

```
CLI (device)                         registry                         browser (any machine)
 1 generate Ed25519 key pair (local, §6)
 2 POST /api/v1/devices/authorize  ─▶ create device_authorizations row
   {public_key, name, os, client_version}
   ◀─ {device_code, user_code "BCDF-GHJK", verification_uri, expires_in 600, interval 5}
 3 print verification_uri + user_code (no browser launch by default)
                                                                    4 user opens URI, logs in
                                                                      with the EXISTING GitHub
                                                                      OAuth (oauth.py:28-128);
                                                                      first login = sign-up
                                                                    5 enters user_code; page shows
                                                                      name/os/version; Approve
                                       ◀─ POST /api/v1/devices/approve {user_code}
                                          (cookie JWT, user identity from sub — NOT via
                                           get_current_user_or_key, see G2)
 6 poll POST /api/v1/devices/token
   {grant_type: device_code, device_code, proof}
   ◀─ authorization_pending | slow_down | access_denied | expired_token
   ◀─ 200 {device_id, user_id, access_token, refresh_token, expires_in}
```

Rules:

- `user_code`: 8 characters from the 20-letter consonant alphabet `BCDFGHJKLMNPQRSTVWXZ`
  (≈2.6·10¹⁰ space), shown as `XXXX-XXXX`, case- and dash-insensitive on input.
- `proof` = Ed25519 signature by the new private key over
  `"aigentry-device-v1|" + device_code + "|" + ts` with `ts` within ±300 s. Proves the
  poller holds the key that the user approved (a leaked `device_code` alone is useless).
- The approval page must display the device's name/os/version, the time of the request
  and its network prefix (`request_net_prefix`), with a warning to approve only a code
  the user started themselves (device-code phishing). Approval requires an explicit click
  (no auto-approve, no approve-by-link). A user may have at most **20** `active` devices
  (proposal, part of D-ID-1); approval beyond that → `device_limit`, revoke one first.
- Sign-up (AC1 "가입") is the existing first GitHub login (`find_or_create_user`,
  `oauth_service.py:84-136`), performed during the approval step. No separate sign-up
  endpoint exists or is added.
- `approve` and `deny` require the browser JWT (`type=access`, not revoked) **and** a
  custom header (`X-Aigentry-Intent: device-approve`) so a cross-site form post cannot
  approve. The cookies are `samesite=lax` when set at login (`oauth.py:94-113`), but
  `/refresh` re-sets them `samesite="strict"` without `domain` (`oauth.py:194-211`). The
  header requirement does not depend on either. If the approval page is served from
  another origin, `X-Aigentry-Intent` must be added to CORS `allow_headers`, which today
  lists only `Content-Type, Authorization, X-API-Key, X-Request-ID` (`main.py:194-200`).
- Wrong `user_code` attempts: 5 per browser session per 10 min, then 429.
  `/devices/authorize` is limited to 10/min per IP. Both are **new** per-route limits
  (§7.4); none exists today (§1.4). Codes are single-use; `consumed` on first successful
  token exchange.
- Headless machines (the always-on Linux orchestrator) do step 4–5 on any other device that
  has a browser. Nothing is typed into a GUI on the headless host.
- `--open` may launch the platform browser; default is print-only (requirements: no GUI
  typing / cmux dependency).

## 5. Tokens and lifetimes (**decision needed — Rule 47 privacy/permission, D-ID-1**)

| Token | Format | Recommended default | Where checked |
|---|---|---|---|
| Device access token | JWT HS256 (existing key), claims `sub=user_id, did=device_id, tid=tenant_id, jti, exp, type=device_access` | **15 min** (new setting `DEVICE_ACCESS_TOKEN_EXPIRE_MINUTES`) | signature/exp/type on every request; device row on every ES-03 mutation (§7.2) |
| Device refresh token | 32 random bytes, base64url; server stores sha256 only | **idle 30 days, absolute 90 days**; rotated on every use | `/devices/token` with `grant_type=refresh_token` |
| Device key pair | Ed25519 | no expiry; dies with revoke | proof on every refresh |

- Access tokens are presented as `Authorization: Bearer` (closes G4). The cookie path for
  browsers is unchanged.
- Refresh = `{grant_type: refresh_token, refresh_token, device_id, proof}` with proof over
  `"aigentry-device-v1|refresh|" + device_id + "|" + ts`. A stolen refresh token without the
  private key cannot be used.
- Rotation with **reuse detection** (closes G5). A refresh whose *response* was lost
  (partition, late ACK) is retried with the old token. That retry must not revoke the
  device, and nobody without the device key may trigger a revoke. The server therefore
  checks in this order, in one transaction holding the device row `FOR UPDATE`:
  1. Load the device by `device_id`. Unknown, `revoked` or `expired` → `invalid_grant`,
     uniform body, no state change.
  2. **Verify `proof` first**: Ed25519 over `"aigentry-device-v1|refresh|" + device_id +
     "|" + ts` with the row's `public_key`, `ts` within ±300 s. Failure → `invalid_grant`,
     **no state change, no revoke, no reuse classification**, counted against the
     per-`device_id` limit (§7.4). Knowing a `device_id` (lists, logs, lease view) is
     therefore not enough to revoke a device.
  3. `sha256(token) = refresh_hash` (normal case) → rotate: `refresh_prev_hash :=
     refresh_hash`, `refresh_hash := sha256(new)`, `refresh_rotated_at := now()`.
  4. `sha256(token) = refresh_prev_hash` → **retry of a lost response**. Presenting the
     previous token proves that the current one has never been presented, because
     presenting it would have moved it into `refresh_prev_hash`. The server re-rotates:
     a new pair is issued, `refresh_hash` is replaced (the unseen pair dies), and
     `refresh_prev_hash` is unchanged. No revoke at any age; event `refresh_retry`. The
     client keeps the same `Idempotency-Key` across these retries (ES-03 §7 style), so
     audit groups them.
  5. Any other hash, with a valid proof → **reuse**. Someone holding the device key
     presented a token older than the previous one. That is the copied-device-directory
     case: two holders alternate and one ends up presenting a superseded token. The
     device is set `revoked`, `revoked_reason=refresh_reuse`. The server holds no other
     state to check. **This revoke must persist although the presenter gets an error.**
     The request session rolls back on any exception (`db/session.py:15-20`), and FastAPI
     errors are normally raised. So the handler commits the revoke and then *returns* the
     `invalid_grant` body as a response, without raising. The same rule covers every
     write that must survive an error response (ES-03 §10 rejection events). ID-5 asserts
     the row is `revoked` after the error response.
  - Pattern: refresh-token rotation with reuse detection, sender-constrained by the
    device key, as in the OAuth 2.0 Security BCP (RFC 9700 §4.14.2) and RFC 6749 §10.4.
    Accepting the immediately previous token as a retry is the "previous token stays
    valid until the new one is used" variant of rotation grace periods. Cited from the
    architect's knowledge; these documents were **not re-read** in this cycle (no network).
  - Because revoke is checked durably on every request (§7.2), no Redis entry is needed to
    stop the device's live access tokens.
- Idle expiry sets `status=expired` (not revoked); `aigentry-devkit login` re-binds the
  **same** device row if the same public key proves possession, so history and lease
  attribution survive a long absence (the Mac case). A **revoked** row is never re-bound:
  `revoked_at` is set once by the server clock and never cleared or moved, and logging in
  again needs a new key pair and creates a new `device_id`.
- Why not reuse the 60 min / 7 day web defaults: a CLI device is long-lived and offline
  for days, so it needs a longer refresh than the browser's 7 days. To compensate, the
  access token is shorter and proof-of-possession is required.

## 6. Key material per OS (**decision needed — Rule 47 privacy/permission, D-ID-2**)

Stored items: Ed25519 private key, current refresh token, cached access token + exp,
`device_id`, `user_id`, registry URL. Nothing else. Never in env vars, never in
`install-state.json`, never in `env.sh`/`env.ps1`, never in logs, telemetry, ES-02
checkpoints, ES-04 captures, or task records.

Recommended default (only OS-shipped tools — Constitution 제17조, no native addon):

| OS | Default store | Fallback | Path / mechanism |
|---|---|---|---|
| macOS | login Keychain via `/usr/bin/security -i`, with the `add-generic-password -U -s aigentry-device -a <device_id> -w <secret>` command line written to the child's **stdin** (argv is only `security -i`); read back with `find-generic-password -s … -a … -w` on stdout | none automatic. If the Keychain is locked/unavailable (e.g. SSH-only session), `login` exits 5 and names the explicit `--keystore file` opt-in; it never downgrades silently | `~/.config/aigentry/device/` for the non-secret metadata |
| Linux | file store: dir `0700`, files `0600`, owner check on every read, refuse if group/world bits are set (no helper process) | Secret Service via `secret-tool store`, which reads the secret from stdin, **only** when explicitly requested (`--keystore secret-service`); headless hosts usually have no unlocked keyring | `${XDG_CONFIG_HOME:-~/.config}/aigentry/device/` |
| Windows | file encrypted with DPAPI `CurrentUser` scope via PowerShell `System.Security.Cryptography.ProtectedData` (ships with Windows PowerShell 5.1) + owner-only ACL. PowerShell is started as `powershell -NoProfile -NonInteractive -Command -`; the script arrives on stdin and the secret is read inside it with `[Console]::In.ReadLine()`, never placed in `-Command`/`-EncodedCommand` arguments | none — refuse login if DPAPI unavailable | `%USERPROFILE%\.config\aigentry\device\` (matches devkit's state-dir convention, `install.ps1:17`) |

The file store holds `device.json` (non-secret: ids, URL, key_alg, created_at) and
`secret.json` (private key + refresh token). Writes are tmp + fsync + rename (same pattern
as telesession `src/store.js:316-330`). Copying the directory to another machine is
*detected*, not prevented: the server sees one device key used from two places only if
refresh reuse fires (§5); there is no hardware binding in this release (§11).

**Secret transport to helper processes (all OSes).** A secret reaches a spawned process
only on its **stdin** (or a pipe the parent writes). It never goes in argv, which other
local users can read through `ps` / `/proc/<pid>/cmdline` / WMI. It never goes in env vars
(`/proc/<pid>/environ` is readable by the same user and is inherited by children). It
never goes in a temp file. A helper whose only interface takes the secret in argv is not
used. That rules out `security add-generic-password … -w <secret>` as a direct argv call;
the same command is sent through `security -i` stdin instead. Reading back goes the other
way: the secret arrives on the helper's stdout pipe, and the parent never echoes it.

**Not measured:** `security -i` was not run on a macOS host (the Mac is offline). Its
handling of piped stdin (no tty echo, no history file, exit status per command) is
documented tool behaviour that the architect has not verified here. PowerShell's stdin
script mode and `[Console]::In` were not run on Windows either. ID-10 and ID-11 cover
both. **If ES-09 cannot verify the macOS stdin path, the macOS default is not safe as
recommended and D-ID-2 must be decided again** (choices: file store on macOS too; or
Keychain via a different OS-shipped interface).

**Finding (C6, not decided here):** the age private half that ES-02/ES-04 use as the device's `age_recipient` is today brain's plain `0600` file `~/.config/sops/age/keys.txt` (`AgeCrypto.ts:24`, measured by ES-02, not re-measured here). It is outside the store above on every OS. Whether to move it is D-ID-2 sub-question (b).

Open question that stays with the user (D-ID-2): Keychain-by-default on macOS vs a uniform
file store everywhere. Recommended: Keychain on macOS through `security -i` stdin,
conditional on the verification above, because it is OS-shipped and protects the key at
rest. The file store is used on macOS only with an explicit `--keystore file`.

## 7. Authorization and isolation rules

### 7.1 New dependency `get_current_device` (registry)

1. Read `Authorization: Bearer`; decode with existing `decode_token` (`oauth_service.py:167-169`).
2. Require `type == "device_access"`; reject `access`/`refresh` web tokens on device
   endpoints and device tokens on cookie endpoints.
3. Durable device check (§7.2) on **every** request. Reads and writes are treated the same.
   There is no Redis lookup on this path, so a Redis outage cannot open it. Today's web
   path silently falls through on a Redis error (`auth.py:83-84`); this one has nothing to
   fall through to.
4. Return `(user_id, device_id, tenant_id)`. Never substitute an API key (G2).

### 7.2 Durable revoke check (every ES-0x request)

Every request on a registry ES-0x endpoint loads the device in the request's transaction,
**reads included** (`get`, `list`, `events`, `resolve`, `export`, `GET /devices`, `GET
/devices/me`):
`SELECT status FROM devices WHERE id = :did AND user_id = :sub FOR SHARE`. It requires
`status = 'active'`, else 401 `device_inactive`. This is one primary-key lookup.
`DELETE /devices/{id}` (revoke) sets `status='revoked'` and `revoked_at = now()` under
`SELECT … FOR UPDATE`. Under READ COMMITTED, a plain `SELECT` would not serialise against a
concurrent revoke. With `FOR SHARE` against `FOR UPDATE`, every ES-0x transaction either
commits before the revoke or sees `revoked`.

So: **a request whose transaction starts after the revoke commits is refused, read or
write.** The 15-min access lifetime and Redis do not matter to device tokens. The
`refresh_token` grant is refused by §5 step 1.

Data that never reaches the registry is outside this check. ES-02 checkpoints and ES-04
captures stored in the user's brain Git repo are such data, and their revoke enforcement
is reader-side: readers verify the writer against the authenticated device list (§8.1,
ES-02 §5.4).

### 7.3 Resource isolation table

Every row the feature stores carries `owner_user_id`. Every query includes
`owner_user_id = :caller_user_id` in the **same SQL statement** that selects the row
(never "load then check").

| Resource | Owner column | Who can read | Who can write | Cross-user response |
|---|---|---|---|---|
| `devices` | `user_id` | owner (any of own devices, browser session) | owner (rename/revoke) | 404 |
| `approval_requests`, `approvals` (§3.3) | `user_id` | owner's devices (any status that can still authenticate) and browser session | create request: owner's active device bearer; approve/deny: §8.2 | 404 |
| `device_authorizations` | `user_id` after approval | nobody via API except the polling device by `device_code` | approve/deny: logged-in user | uniform `expired_token` / 404 |
| ES-03 queues, tasks, aliases, events, leases | `owner_user_id` | owner's active devices | owner's active devices | 404 |
| ES-08 intake receipts | `owner_user_id` | owner's devices | intake adapter acting as an owner device | 404 |
| ES-02 checkpoints, ES-04 captures (defined by their specs) | only if stored in the registry: `owner_user_id` | registry-stored: owner's active devices (§7.2). Brain-Git-stored: not a registry resource; readers verify the writer against the device list (§8.1, ES-02 §5.4) | same split | registry-stored: 404 |

`role=admin` (`oauth_service.py:120`) **does not** grant read or write on another user's
rows for any resource in this table. Admin operations across users are not provided in
this release.

X-API-Key (tenant-scoped, no user — G6) is **not accepted** on any ES-0x endpoint.
Existing endpoints keep accepting it unchanged.

### 7.4 Enumeration prevention

- Not-found and not-owned return the **same** status, body and code path (single
  user-filtered query → 404 `{"detail":"Not found"}`). No 403 for "exists but not yours".
- Device ids are UUIDv4. ES-03 task ids are guessable integers under every issuance
  proposal (ES-03 §3, undecided — D-Q-1). Every task lookup is therefore scoped by
  `(queue_id, owner_user_id)`, so a guessed id can only ever resolve inside the caller's
  own queue.
- `list` endpoints return only the caller's rows; counts and pagination cursors are
  computed after the owner filter.
- `/devices/authorize` and `/devices/token` responses never reveal whether a user exists.
  `/devices/token` with an unknown `device_code` returns `expired_token`, exactly as for
  an expired one.
- Rate limits (**proposal; new work**, because no limit runs today, §1.4): add per-route
  `@limiter.limit` decorators on `/devices/authorize` (10/min per IP), `/devices/approve`
  and `/devices/deny` (5 per browser session per 10 min), `/devices/token` (60/min per
  `device_id`, and 30/min per IP for unknown ids), and `POST /devices/approval-requests` (technical value, proposed
  30/min per device bearer; revision 8, against approval fatigue, interface invariants N-U4). `/devices/token` also enforces the poll
  `interval` (else `slow_down`). The decorators use a **separate device-route `Limiter`** on the
  same Redis store (`main.py:93`), with its own key function and `enabled=True`.
  - **Client IP source.** The existing `get_real_ip` returns `CF-Connecting-IP` or the first
    `X-Forwarded-For` value unconditionally (`main.py:75-86`), so a client could rotate a
    header to reset its per-IP count. For `/devices/*` and for `request_net_prefix` (§3.2) the
    client IP is the **socket peer** (`request.client.host`). Forwarded headers are read only
    when the socket peer is inside a configured `TRUSTED_PROXY_CIDRS` list, and then the
    right-most address not in that list is used. The default list is empty, so headers are
    ignored (orchestrator technical decision recorded in the decision bundle: "신뢰 프록시 설정
    기본값(헤더 불신)"). Whether a deployed front strips these headers was not measured.
  - **Not switchable off by `RATE_LIMIT_ENABLED`.** The existing `Limiter` follows
    `enabled=settings.rate_limit_enabled` (`main.py:94`). The device-route limiter does not,
    so turning that flag off cannot remove the `/devices/*` limits or their fail-closed rule.
  - The global `SlowAPIMiddleware` is **not** switched on: that would change every existing
    endpoint, which is a production behaviour change outside this spec. The general fix
    belongs to the registry rate-limiter issue.
  - **Limiter store down** (Redis unreachable): `/devices/authorize|approve|deny|token` and
    `POST /devices/approval-requests` **fail closed** with 503 `rate_limit_unavailable`. They never fall through to "no
    limit". Other ES-0x endpoints do not depend on Redis (§7.1). Implementation note:
    slowapi raises on a storage error unless errors are swallowed (`swallow_errors` defaults
    to false; from knowledge, not run), so the 503 needs an explicit exception handler for
    the device-route limiter; swallowing errors would be fail-open and is not allowed.
  - Test rows ID-12 (limits enforced) and ID-13 (store down → 503) in §15.
- Logs: `user_id`/`device_id` only; never codes, tokens, public keys in full (first 8 hex
  for correlation), never the GitHub login of another user.

## 8. Registry API (new, all under `/api/v1/devices`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /authorize` | none (rate-limited) | start device-code login (§4) |
| `POST /approve`, `POST /deny` | browser JWT cookie + intent header | bind code to user |
| `POST /token` | device_code + proof, or refresh + proof | issue / rotate tokens |
| `GET /` | device bearer or browser cookie | list caller's devices: id, name, os, status, created_at, last_seen_at, `current: bool`; every row carries `fingerprint` (server-recorded, computed by the registry from the stored `public_key`, format §8.1 FP); with `include=keys&all=true` (device bearer only) also `revoked_at`, `public_key`, `age_recipient`, `age_recipient_sig`, `age_recipient_seq`, `age_recipient_set_at`, `can_approve`, `server_time` and revoked/expired devices (§8.1); with `include=keys,approvals&all=true` also every retained approval record of the user (§8.2) |
| `GET /me` | device bearer | this device + user (`user_id`, `github_id`, `github_login`) |
| `PUT /me/age-recipient` | device bearer | set or rotate this device's signed age recipient (§8.1). The registry refuses an `age_recipient_seq` outside 1 … 2^31−1 with 422 `age_recipient_seq_out_of_range` before any write (§3.1), verifies `age_recipient_sig` against the row's `public_key` and refuses a bad signature with 422 `age_recipient_sig_invalid` and an `age_recipient_seq` that is not greater than the stored one with 409 `age_recipient_seq_stale`; `/authorize` does the same for the optional pair (defence in depth only; readers verify again, invariant I5) |
| `POST /approval-requests` | device bearer | create an approval request (§3.3, §8.2); for `bootstrap` the registry computes the set and root itself and refuses a mismatching `scope` or digest; confers nothing |
| `GET /approval-requests` | device bearer or browser | the caller's pending requests and approval history (§8.2) |
| `POST /approval-requests/{id}/approve` | device bearer + approver signature, or browser JWT + intent header + second factor | approve once (§8.2) |
| `POST /approval-requests/{id}/deny` | device bearer or browser JWT + intent header | deny once; consumes the nonce; the denial stands until cleared (availability only, §8.2) |
| `POST /approval-requests/{id}/clear-denial` | browser JWT + intent header (the approval page, or Kkoma's account session); never a device bearer | clear a standing denial, so the next refresh may request again (§8.2) |
| `PUT /{id}/can-approve` | off: device bearer or browser; on: browser JWT + intent header + second factor | set `can_approve` (§3.3, §8.2) |
| `PATCH /{id}` | device bearer or browser | rename (own only) |
| `DELETE /{id}` | device bearer or browser | revoke (own only; self allowed) — idempotent, 204 also when already revoked |

Errors use the RFC 8628 names for the token endpoint (`authorization_pending`,
`slow_down`, `access_denied`, `expired_token`) and `invalid_grant` for bad refresh/proof.

### 8.1 Interface for ES-02 / ES-04 (their "Requirements on ES-01", ES-02 §5.5 R1–R7)

| # | Provided by ES-01 |
|---|---|
| R1 signing key (invariant I12) | the device's Ed25519 key (§3.1). The private key is used **only inside the devkit lease keeper** (ES-03 §5.1), the only process that reads the key store (§6). The keeper offers its local callers: `sign(prefix, payload)` with the prefix allowlist `aigentry-checkpoint-v1\|`, `aigentry-capture-v1\|` (any other prefix → `SIGN_PREFIX_REFUSED`); `public_key()` and `fingerprint()` (row FP); `device_list()` (the R3 list with `server_time` and approval records) and `device_me()`; `request_approval(action, fields)` (creates an approval request, §8.2); `preview_approval(request_id)` (the request's canonical `aigentry-approval-v1\|` string, its SHA-256 and the parsed fields with `scope`); `signed_approvals()` (the keeper's local log of `request_id` and canonical-string SHA-256 of every approval it signed, for the readers' self-audit). ES-01's own prefixes `aigentry-device-v1\|`, `aigentry-age-recipient-v1\|` and `aigentry-approval-v1\|` are **never** offered through `sign`; the keeper uses them only inside its own `login`, refresh, `register_age_recipient` and `approve(request_id, expected_sha256)` operations; `approve` signs only when the request it fetches again has a canonical string with that SHA-256 (`APPROVAL_REQUEST_CHANGED` otherwise). `preview_approval` and `approve` are called by `aigentry-devkit approve` (§9), never by brain or ES-04. The `aigentry-endorsement-v1\|` prefix of earlier revisions is withdrawn (an endorsement is an `endorse` approval). Callers include brain (ES-02 writer, reader and pre-push gate) and the ES-04 CLI; they start the keeper on demand. Key bytes never leave the keeper. If the keeper is unavailable, ES-02/ES-04 write nothing (I12). ID-23 |
| R2 age recipient (invariant I5) | `age_recipient` + `age_recipient_sig` per device (§3.1), sent with `/devices/authorize` or set later by `PUT /devices/me/age-recipient` (device bearer, new signed value = rotation). Each value carries `age_recipient_seq` inside the signed string (§3.1): `1` at `/authorize`, the stored value + 1 for a rotation. Signing: only the keeper signs `aigentry-age-recipient-v1\|`, inside `register_age_recipient(age_recipient)`, called by `login` or by the recipient's owner (brain) with the public recipient string; the keeper checks the `age1…` format, reads the current `age_recipient_seq` through `device_me()`, signs with the next value and sends it. The registry **refuses** a recipient whose signature does not verify against the row's `public_key` (§8, 422). That is defence in depth: the trust basis is the reader-side check of I5. A client uses a device's `age_recipient` only when the signature verifies against the device's **pinned** `public_key`, its `age_recipient_seq` is not lower than the highest this reader has verified for the device, pinned, in a notice, or bound in a `device` approval naming it whose signature and approver pass V1, V4 and V6 on that reader **and whose `scope` entry carries the device's own `age_recipient` and `age_recipient_sig` for that seq, verifying with its pinned `public_key` (listed one, with the bound fp, if unpinned) and hashing to the bound value**, so the floor rises only to a value the device itself signed (interface invariants I5; revision 8, narrowed in revision 9) (lower, or equal with a different recipient, is a registry fault: a replayed older value), and a change is used only after an approval valid on that reader (`recipient_accept`, of kind `device` under the recommended D-ID-6 (e) (B) and also `account` under (A), which a compromised registry can forge, interface invariants I5; or the `bootstrap` / `endorse` approval that pins the device; a `bootstrap` pins recipients only for devices `active` in its scope; I5, §8.2). A higher seq with the same recipient, as `login` registers after an `expired` re-bind, is not a change. **Finding (C6):** ES-02 proposes that the recipient be the device's **existing** brain age key pair, stored as a plain `0600` file at `~/.config/sops/age/keys.txt` (`AgeCrypto.ts:24`; re-measured 2026-10-13 by the reconciliation cycle at brain `0ffa6ee`). It is not new key material. That file does not meet the §6 store rules on macOS (Keychain) or Windows (DPAPI). ES-01 therefore makes **no** claim that the age private half meets §6. Where it lives is D-ID-2 sub-question (b), §10. A same-uid process that can call `register_age_recipient` can also read that `0600` file, so the operation widens nothing beyond the OS-user boundary (interface non-claim N-U4) |
| R3 authenticated device list | `GET /devices?include=keys,approvals&all=true` (owner's device bearer only, §7.2) returns per device: `id, name, os, status, created_at, revoked_at, public_key, age_recipient, age_recipient_sig, age_recipient_seq, age_recipient_set_at, can_approve`, revoked and expired devices included, plus `server_time` and every retained approval record of the user (§3.3, §8.2). Over TLS to the registry URL of D-ID-4. Integrity rests on the registry (R5) |
| R4 revoke time | `revoked_at`: server clock, set once, never cleared or moved; revoked rows are never re-bound, and logging in again creates a new `device_id` with a new key (§5). `expired` is not revoked: `revoked_at` stays null and the device's signatures stay valid. Retention: D-ID-5 |
| R5 trust model (invariants I3, I4, I6, I11) | **Model:** the registry is the **key directory** and is trusted for membership. A compromised registry could add a device key and so become a recipient of new records. **What ES-01 provides for the mitigation:** stable `device_id`; an immutable `public_key` per id; the device fingerprint (format: §8.1 row FP); the signed recipient (R2); and server-clock `created_at` and `revoked_at` that are never moved (§3.1). Clients pin `id + fingerprints + verified age_recipient + age_recipient_seq`. A pinned device whose `public_key`, `created_at` or `revoked_at` changes in a later list, or that disappears from it, is treated as a registry fault, not as an update, and is surfaced (R6); a revoke is never undone (I3). **Endorsement validity, using ES-01 timestamps:** an endorsement is valid only if the endorsed device's server-clock `created_at` **precedes** the endorser's `revoked_at` (or the endorser has no `revoked_at`). An endorsement by a device dated after that device's `revoked_at` is void. An endorsement by a revoked device counts only if the reader saw it (server-clock `first_seen_by`) before the revoke; no other path, and no reference, makes it count (I6). Revoking a device does not revoke the devices it endorsed on readers that had already counted the endorsement. The trust anchors (own device, root = earliest `created_at` revoked or not, local anchors; the root and local anchors enter a reader only through a `bootstrap` or `anchor` approval valid on that reader, §8.2, I4) and the scoped recovery trigger are defined by I4/I11 and ES-02 §5.6, under ES-02 decision D-9 (pending user decision; decision bundle 2h default). ES-01 supplies the `created_at` order the trigger uses, and the `status` the readers' key-state codes use: an `expired` device re-binds with the same `device_id` and key (§5, ID-7), so a reader counts it as a possible holder of records it cannot decrypt; only `revoked` (never re-bound, R4) is final, so a reader reports `*_UNRECOVERABLE_KEY` only when every other device in the list is revoked (I11, interface non-claim N-U1). An endorsement is an `endorse` approval (§3.3, §8.2): signed with the endorser's device key inside the keeper's `approve` under `aigentry-approval-v1\|`, over the canonical signed fingerprint form (row FP), stored as an approval record and listed with R3. The reader rules (ES-02 §5.6 E1–E4) and whether endorsement is required (D-9) belong to ES-02. ES-01 stores and checks approvals as defence in depth; it does not make the registry the judge of trust: readers verify every approval themselves (interface invariants §B.1 V1–V6). Because `created_at`/`revoked_at` are registry assertions, they are as trustworthy as the registry under this model; pinning makes later changes visible but cannot prove the first value (non-claim N-U3) |
| R6 change notice | The list makes every change ES-02 must announce observable, so a client can diff it against its pinned set: **addition** (a new `device_id`), **key change** (new `age_recipient`/`age_recipient_sig`, with `age_recipient_set_at`; `public_key` never changes for an id), **revoke** (`status`, `revoked_at`). The list carries the fields the notice must show: `name`, `os`, `created_at`, fingerprints. Every list response includes `server_time`, so the client can show freshness. Recording the notice, requesting the approval (§8.2) and using a new recipient only after a valid approval, with removals taking effect immediately, is the client's job (ES-02) |
| R7 Git-stored data | ES-01 §7.2/§7.3 no longer claim registry-transaction enforcement for brain-Git data; readers verify against R3 |
| Revoke semantics for Git-stored data (invariants I6, I8, I10) | `DELETE /devices/{id}` sets `revoked_at` once (server clock) and stops every registry ES-0x request that starts after it commits (§7.2), including the revoked device's own `device_list()`. For brain-Git data the revoke takes effect **on each client at that client's next successful list fetch**: the device leaves the recipient set at once, every unpushed object (new records, checkpoint rekey siblings, captures) is re-wrapped before any push (I10), and **all** its items are re-checked, those that now fail being demoted (I8). Ciphertext pushed before that fetch stays readable by the revoked device, and so does its Git access (interface non-claims N-U2, ES-02 §5.3, D-8). ES-01 claims nothing about brain-Git data beyond supplying `revoked_at` and `server_time` |
| GitHub binding (ES-02 §5.2) | `GET /devices/me` returns `github_id` (stable) and `github_login` of the user, so a client can check that the brain repo's GitHub owner is the same account. The binding is the existing `users.github_id` (§1.1); nothing new is stored |
| FP device fingerprint (C10; ES-01 owns this format, ES-02 cites it) | **Format:** `aigfp1:` followed by the first 16 bytes (128 bits) of `SHA-256("aigentry-device-fingerprint-v1\|" ‖ raw 32-byte Ed25519 public_key)`, as 32 lowercase hex digits in 8 groups of 4 separated by `-` (e.g. `aigfp1:3f2a-…-9c01`). Comparison ignores case and `-`. **Canonical signed form** (used inside signatures, e.g. ES-02 `endorsed_key_fp`): `aigfp1:` followed by the 32 lowercase hex digits with no `-`; a signer never signs the grouped display form. 128 bits, because the comparison guards against a registry that could choose a substitute key; the earlier 8-byte form is withdrawn. **Two sources, never mixed:** `fingerprint` in the registry list is the **server-recorded** value. The **local** value is computed by the client from the public half of the key in its own key store (§6), through the lease keeper's `public_key()` / `fingerprint()` operation (R1, ES-03 §5.1), and is **never** taken from any registry response. **Display:** `aigentry-devkit device list` and `whoami` (the build plan's `aigentry device list`, renamed §9) show both values for the current device, plus `fingerprint_match`. Other devices show only the server-recorded value. A user compares them out of band: the local value shown on device A, against the value device B's list shows for A (ES-02 §5.6 recovery). On a mismatch the CLI warns on stderr and exits 6 `KEY_MISMATCH`. Nothing is changed automatically. The browser settings page shows only server-recorded values, because it holds no device key |

Per 제15조 these request/response schemas are registered in aigentry-ssot before
implementation; the registry owns the server, devkit owns the client.

### 8.2 Approvals (interface invariants §B.1 "Approval", I4, I5, I11, I12; revisions 6–7)

An approval is the one way a user confirms a trust input: a **bootstrap**, a local **anchor**, an **endorsement**,
or the **acceptance of a recipient change**. ES-01 owns the format (§3.3), the endpoints (§8) and the server-side
checks. The trust basis is the reader-side check (invariants §B.1 V1–V6); everything below is defence in depth plus
the audit record. Brain, ES-04 and MCP tools request approvals and verify them from the list. They never create one.

**Request.** `POST /approval-requests` (device bearer, through the keeper's `request_approval`, ES-03 §5.1) with
`action` and the bound fields of §3.3. The registry sets `nonce`, `issued_at`, `expires_at` (server clock; validity
window a technical value, proposed 15 min) and `requested_by_device_id`, and refuses (422) a `bootstrap` or `anchor`
request whose `reader_device_id` is not the caller. For a `bootstrap` it computes the set (every device of the user,
revoked and expired included) and the root (earliest `created_at`) from its own `devices` table, and refuses (422
`approval_scope_mismatch`) a request whose `scope` entries or `scope_digest` differ from that set (defence in depth;
readers recompute it themselves, V3). For an `endorse` or `recipient_accept` it refuses (422
`approval_scope_mismatch`, validated before any database write; a seq outside 1 … 2^31−1 can never equal a stored one, §3.1) a request whose `target_fp`, `target_age_recipient_seq` or `target_age_recipient_sha256`
differs from the target's stored current values, and copies the target's `age_recipient` and `age_recipient_sig` into
the `scope` entry (revision 9; interface invariants I5). A duplicate pending request returns the existing one, and a standing denial
(§3.3) is returned instead of a new request. Request creation is rate-limited per device bearer (§7.4).

**Approve.** `POST /approval-requests/{id}/approve` with `channel`, in one of two kinds:
- `device`: device bearer of the approver **and** `sig`, the approver's Ed25519 signature over the §3.3 canonical
  string, made only inside the keeper's `approve(request_id, expected_sha256)`. The keeper builds that string from
  the pending request as the registry returns it, and signs only when it hashes to `expected_sha256`, the value its
  caller obtained from `preview_approval(request_id)` and displayed; the caller supplies no payload (ES-03 §5.1). A
  registry that serves the display and the signer different bodies therefore obtains no signature.
- `account`: browser JWT, the intent header `X-Aigentry-Intent: trust-approve` (as §4 for device approval, so a
  cross-site post cannot approve), and a fresh second factor. The method is D-ID-6 (a), pending user decision.

In one transaction the registry refuses, writing nothing:
- a request that is not `pending` → 409 `approval_consumed` (single use; a replay);
- `now > expires_at` → 410 `approval_expired` (the request becomes `expired`);
- a `device` signature that does not verify against the approver's stored `public_key` → 422 `approval_sig_invalid`
  (a signature over another device, fp, seq or digest fails here);
- an approver that is not `active`, has `can_approve: false`, or belongs to another user → 403 / 404 (§7.4);
- a `bootstrap` whose `scope` (device ids, fps, statuses, recipient seqs and hashes, root) no longer equals the set
  the registry computes from its own `devices` table now → 409 `approval_scope_stale` (the request becomes
  `expired`; the reader requests again), so a user never approves a request every reader would reject (V3); the
  same 409 for an `endorse` or `recipient_accept` whose bound fp, seq or hash no longer equals the target's stored
  current values (revision 9);
- an `endorse` or `recipient_accept` whose approver is the target device → 422 `approval_kind_not_allowed`;
- a kind or approver the action does not allow (interface invariants §B.1 approver rules) → 422
  `approval_kind_not_allowed`. For a `bootstrap` the registry checks the approver against the request's `scope`
  device ids (§3.3), and refuses an approver outside them, `r` itself, or an `account` approval, while `scope` lists
  another `active` device. For
  an `endorse`, only `device` kind. For an `anchor`, the approver is the candidate or `account`;
- an `account` `recipient_accept` while D-ID-6 (e) is (B), the recommended default (pending user decision; decision
  bundle 2l) → 422 `approval_kind_not_allowed` (defence in depth; readers refuse it under V6). Under alternative (A)
  it is accepted, and the stated residual applies: a compromised registry can forge such an approval, so every
  reader would use any recipient value the target's key signed, a denied one included (interface invariants §B.1
  "`account` `recipient_accept`", I5, N-U3);
- `account` kind without a verified second factor → 401 `second_factor_required`.

Otherwise it sets `state='approved'` with `UPDATE … WHERE id = :id AND state = 'pending' AND now() <= expires_at`
(one winner under concurrency) and inserts the `approvals` row with server-clock `approved_at`.
`POST …/deny` consumes the nonce the same way and records `denied`. **A denial stands** (revision 8; interface
invariants §B.1 "Request"): until the user clears it (`POST …/clear-denial`, browser session with the intent header,
never a device bearer) or the target is revoked, a create with the same denial key (§3.3: the target's fp, and for a
`recipient_accept` the recipient hash) returns the denied request, so refreshes and seq bumps do not re-prompt the
user after a "no"; a rotation to another recipient is a new key. The denial records `denied_by_device_id` and
`denied_channel`: through the browser session (the approval page's "deny" action, or Kkoma's "deny" action on its
request list while signed in to the account) `denied_by_device_id` is null and the channel `approval_page` or
`mobile`; through a device bearer (Kkoma's own, or any device's) it is that device and the channel `mobile` or `api`
(revision 10). A "no" in `aigentry-devkit approve` or on a Kkoma approval screen is a local decline and calls no
`deny` (the keeper has none, ES-03 §5.1), so that code path creates no standing denial whoever drives it. Any own device bearer, an agent's included, can deny through `POST …/deny`, and can switch `can_approve` off (below);
both only remove authority. An agent that polls the pending requests can deny each one as soon as it is re-created,
so this lasts until the user revokes the device whose bearer does it, which the history's attribution identifies;
it never makes an approval (availability residual, interface non-claim N-U4).

**List.** `GET /devices?include=keys,approvals&all=true` returns every retained approval record of the user with every
request field, `scope` included without its display fields (§3.3, revision 11), so readers verify each one on their own and keep the I5 seq-floor input after the
request is purged (R3; revision 10). `GET /approval-requests` gives the channels the pending
requests (with the display `scope`) and the history: action, target, approver, kind, channel, `approved_at`, and for a denial `denied_by_device_id`,
`denied_channel`, plus every `can_approve` change with its actor. The
browser settings page and Kkoma show the same history. This is the user-visible audit.

**`can_approve`** (per device). Turning it off is allowed to any of the owner's device bearers and to the browser
session. Turning it on needs the browser session plus the second factor, so an agent holding one device's bearer
cannot enable approval on another device. The default for new devices is D-ID-6 (c), pending user decision.

**Channels.** All of them produce the same record:
- the terminal on a device that can approve (`aigentry-devkit approve`, §9; its input discipline, including the
  Windows console form, is in interfaces §B.1 "Channels");
- the registry approval page (the §4 page; `account` kind);
- Kkoma/mobile (`device` kind when it is registered as a device holding its own key and meets the Kkoma-device
  obligations KK-1..KK-4 of interface invariants §B.1 "Channels": keeper discipline for its key, its own trust state
  (creating the requests its state makes due), the terminal channel's checks, override and refusal codes, and
  **KK-4**: each `device` signature, and each override, only after a user verification (platform biometric or device
  passcode) on Kkoma's own approval screen that has shown the preview fields, never from a chat or agent message, a
  notification action, a deep link carrying the answer, accessibility or automation input, or any interface the
  orchestrator or agents can reach; the verification gates the key's use at the OS level, per use (an iOS Keychain
  item with a user-presence access control, an Android Keystore key requiring authentication for every use;
  revision 9, from knowledge), not only an app-screen check, checkable by the key attributes interface invariants
  KK-4 names (revision 10: Android `isUserAuthenticationRequired()` with zero validity duration, attested; iOS
  `.userPresence` / `.biometryCurrentSet` with reuse duration 0, key bytes read per signature, never cached, zeroed
  after use); otherwise `account`; D-ID-6 (b)). Kkoma can approve a later
  device's bootstrap and endorsements only while it is trusted on every device: registered first, or endorsed once
  from a trusted computer's terminal (interface invariants §B.1 "Product consequence").

**What an approval proves.** That the approver device's key, or the account with its second factor, approved this
exact target, scope and seq inside the window, once. It does **not** prove that a person acted: a program that
drives that device's terminal, or that can call its keeper, approves the same way (interface non-claim N-U4). The
mitigations are the record itself, `can_approve`, revoke (§5), and the rule that the approver of a device is never
that device while another active device exists (invariants §B.1). An `account` approval proves only what the
registry asserts: a compromised registry can forge one, so it is cryptographic evidence of nothing, and under
D-ID-6 (e) (A) a forged `account` `recipient_accept` would put a recipient the user never accepted into use on every
reader (revision 10).

## 9. CLI surface (devkit; hosted in the `aigentry-devkit` binary, one of the two shipped — `package.json:19-20`)

The build plan's names `aigentry login` / `aigentry device …` are **renamed** to
`aigentry-devkit login` / `aigentry-devkit device …`, because no `aigentry` binary is
shipped by devkit. `aigentry-devkit-bootstrap` gets no new command.

| Command | Flags | Behaviour | Exit codes |
|---|---|---|---|
| `aigentry-devkit login` | `--registry <url>` (default from install state `registry.api_url`), `--name <device-name>`, `--open`, `--keystore auto\|file\|keychain\|secret-service`, `--json` | §4 flow; re-binds an `expired` device with the same key; refuses if a different user is already logged in on this device dir unless `--switch-user`; on success prints this device's `device_id` and `fingerprint_local` (from the keeper, §8.1 FP), which the user compares with the fingerprint an approver shows for this device's `bootstrap` or `endorse` (revision 8) | 0 ok, 2 usage, 3 denied/expired code, 4 network unknown, 5 keystore unavailable |
| `aigentry-devkit logout` | `--revoke`, `--json` | deletes local secret; `--revoke` first calls `DELETE /devices/{self}` (local delete still happens if revoke fails; prints `revoke: unknown`) | 0, 4 |
| `aigentry-devkit whoami` | `--json` | user login, user_id, device_id/name, registry, token freshness, `fingerprint_local`, `fingerprint_server`, `fingerprint_match` (§8.1 FP) | 0, 1 not logged in, 4, 6 key mismatch |
| `aigentry-devkit device list` | `--json`, `--all` (include revoked/expired) | own devices, current marked; server-recorded `fingerprint` per device; for the current device also `fingerprint_local` (from its own key store, never from the server) and `fingerprint_match` (§8.1 FP) | 0, 1, 4, 6 key mismatch |
| `aigentry-devkit device revoke <device-id>` | `--yes`, `--json` | revoke one of own devices (lost-device path); confirmation required without `--yes` | 0, 1, 4 |
| `aigentry-devkit device rename <device-id> <name>` | `--json` | | 0, 1, 4 |
| `aigentry-devkit approve [<request_id>]` | `--json` (output only) | terminal channel of §8.2. Without an id it lists the pending requests. With an id it obtains the request **only** through the keeper's `preview_approval(request_id)` and shows those fields (action, target name/os/`created_at`, fingerprint, `age_recipient_seq`; for `bootstrap` every device of `scope` and the root). It recomputes `scope_digest` from `scope` (for the other actions, checks the `scope` entry against the bound target fields) and refuses a mismatch (`APPROVAL_SCOPE_MISMATCH`). It then runs `aigentry-brain trust refresh` (interface invariants BR-6; that refresh also creates this device's due requests) and reads, read-only under the `aig` it printed, `trust-state.json`, whose list snapshot (`device_list`: per listed device fp, status, `created_at`, `revoked_at`, seq, recipient hash and brain's recipient check, plus root, `trusted` and the hold set) is the only data the checks below use, and only when its `server_time` is not earlier than the printed one (otherwise exit 7, "trust state older than this refresh (retry)"; this retry is the same command **with** the same id again, unlike the scope-mismatch retry below; revision 11); it fetches no list of its own and evaluates no signature (revision 10). So this command needs `aigentry-brain` installed and bootstrapped on the same computer. It compares the request with that snapshot (revision 9, own-list check): for `bootstrap` the digest of the set recomputed from this device's own list, otherwise the target's entry; a difference is refused with no override (`APPROVAL_SCOPE_MISMATCH`, "scope differs from this device's list (registry fault or stale; retry)"); "retry" means running this command without an id, which lists the request that refresh created for the current list (the old one can no longer be approved: 409). For `bootstrap` and `endorse` it then runs the pin comparison of interface invariants §B.1 "Channels" against this device's trust state. It refuses (`APPROVAL_SCOPE_MISMATCH`, no override) a device whose fp or `created_at` differs from its pin, a pinned non-revoked device missing from a `bootstrap` scope, a `root_device_id` other than this device's root anchor, and a device that is `active` in the scope and trusted here whose scope recipient hash differs from this device's pin or has none pinned (since the scope equals this device's list, exactly when this device's own recipient hold condition holds for it, or a registry fault); that refusal names the device's `recipient_accept` request, which exists because the same condition creates it ("approve it first, or revoke that device"; this device can approve it here, and the account only under D-ID-6 (e) (A); a standing denial is named with "clear the denial"). Revoked, expired and untrusted devices are compared by fp and `created_at` only. The device the request is about is shown with its fp for comparison with that device's `whoami`/`login` output; any other `active` or `expired` device it does not trust is refused unless the user types that device's name after its fp is shown. It refuses `endorse` on a device with no `root` anchor (`APPROVAL_NOT_BOOTSTRAPPED`). It then asks under the input discipline of invariants §B.1 "Channels" (`isatty(2)`, answer from `/dev/tty`, on Windows `CONIN$`; never stdin, argument, flag or environment) and calls the keeper's `approve(request_id, expected_sha256)` with the previewed hash (`APPROVAL_REQUEST_CHANGED` if the registry now returns another body). A "no" is a local decline: nothing is signed and no denial is recorded (revision 9). When this device also has the target's pending `endorse` (a new device's `bootstrap` approved here), it may show both previews and take one answer for both; each is signed separately. There is no `--yes` | 0 approved, 1 not logged in, 3 declined (local; no denial recorded), 4 network unknown, 7 refused (no terminal, scope mismatch, request changed, not bootstrapped, `can_approve` off, trust state older than the refresh, `aigentry-brain` missing or its refresh failed) |
| `aigentry-devkit approvals` | `--json`, `--all` | approval history of the account (§8.2) | 0, 1, 4 |
| `aigentry-devkit device can-approve <device-id> on\|off` | `--json` | `off` directly; `on` prints the approval-page URL, because it needs the second factor (§8.2) | 0, 1, 4 |

`--json` output never contains tokens, codes or key bytes. The registry UI gets the same
list/revoke on the existing settings page (`oauth.py:90` redirects there after login),
which is the lost-device path when no other CLI device is at hand.

The installer (`install.sh` phase 6 `registry-wiring`, `install.sh:666-725`; `install.ps1`)
gains an optional "log this device in now?" step that runs `aigentry-devkit login`. It
**does not** write any device secret into `env.sh`, `env.ps1` or `install-state.json`.

## 10. Decisions needed (Rule 47)

| Id | Decision | Category | Recommended default |
|---|---|---|---|
| D-ID-1 | Token lifetimes, and the active-device cap | privacy / permission | access 15 min; refresh idle 30 d, absolute 90 d; rotation; proof checked first; previous-token retry re-rotates; older token with valid proof → revoke (§5); at most 20 `active` devices per user (§4) |
| D-ID-2 | (a) Device secret storage location; (b) **sub-question:** whether to move the existing brain age private key (`~/.config/sops/age/keys.txt`, `0600` plain file, `AgeCrypto.ts:24`; ES-02's proposed `age_recipient`) into the ES-01 store (§6, §8.1 R2) | privacy / permission | macOS Keychain via `security -i` with the secret on stdin (conditional on ES-09 verifying that path, §6), file store on macOS only with explicit `--keystore file`; Linux 0600 file under `~/.config/aigentry/device/`; Windows DPAPI file via PowerShell reading stdin; never env/state files, never argv (a). **(b) recommended: do not move it in this release**; keep brain's file in place and record that it does not meet §6 on macOS/Windows. Reason: brain owns that key and its reader (제4조); `sops` and brain read the file path directly. Moving it would change another component's decryption path and risk losing the only key that decrypts existing memory records. A move, or OS-store support, belongs to a brain-side task coordinated with ES-02 |
| D-ID-3 | Enabling device credentials on a deployed registry (new credential type + new endpoints) | permission expansion / production deploy | ship behind `DEVICE_AUTH_ENABLED=false`; enable per instance after ES-09 isolation tests pass |
| D-ID-4 | Devices talk to the registry over its existing HTTPS endpoint (new client→server traffic from every device) | network change / personal-data transfer | allowed only to the registry URL the user chose at install (cloud or self-hosted); no new relay |
| D-ID-5 | Retention of `revoked`/`expired` device rows (`name`, `os`, `client_version`, `last_seen_at`, keys, `revoked_at`) and of `device_authorizations` (incl. request network prefix, §4) | personal data | `expired` rows kept as they are (they can re-bind, §5). `revoked` rows: `os`, `client_version`, `last_seen_at` cleared 90 days after `revoked_at`; `id`, `name`, `public_key`, `age_recipient`, `age_recipient_sig`, `age_recipient_seq`, `status`, `created_at`, `revoked_at` kept for the account's life (`created_at` because ES-02 endorsement validity compares it with the endorser's `revoked_at`), because ES-02/ES-04 readers verify old signatures against them (§8.1); all rows deleted with the account. `device_authorizations` purged 24 h after a terminal state (§3.2). Every other `devices` column (`age_recipient_set_at`, `revoked_reason`, `revoked_by_device_id`, `key_alg`, `tenant_id`, `user_id`) is kept with the row; the refresh hashes and family id are cleared at revoke, because no reader needs them. After the 90 days the R6 notice for that device shows `os: unknown` |
| D-ID-6 | Approvals (§3.3, §8.2; decision bundle 2i): (a) the second factor for `account` approvals, and which options a user's first device (or a lone survivor) is offered; (b) whether Kkoma/mobile registers as an ES-01 device holding its own key (then it gives `device` approvals, including a second device's bootstrap and endorsements), and where that key is kept; (c) the `can_approve` default for new devices; (d) retention of `approval_requests` and `approvals`; (e) whether an `account` approval may accept a recipient change (`recipient_accept`; decision bundle 2l; revision 10) | authentication / permission / personal data | (a) WebAuthn passkey with user verification on the approval page and in Kkoma, verified with the existing `cryptography` dependency; GitHub re-authentication is **not** recommended, because a live GitHub browser session can complete it without a prompt. First device: both its own terminal approval and an `account` approval are offered; a first device that starts with `can_approve` off ((c), no interactive console) has only the `account` approval until approval is turned on for it. (b) yes: Kkoma logs in with the §4 flow, keeps its key in the platform key store, meets KK-1..KK-4 (interface invariants §B.1 "Channels"; KK-4, user verification on Kkoma's own approval screen for every `device` signature and never from a relayed message, notification, deep link, automation or orchestrator/agent interface, is an **obligation** of a `device`-approving build, not part of this recommendation), and gives `account` approvals only until then (a build that cannot meet KK-4 stays `account`-only, so it cannot endorse); revision 9: KK-4's verification gates the key's use per use at the OS level (iOS Keychain item with a user-presence access control, no Ed25519 in the Secure Enclave; Android Keystore per-use authentication, Ed25519 from API 33; from knowledge), and whether the device passcode may stand in for biometrics is part of this decision (recommended: allowed, as KK-4 names it; a passcode is easier to observe than a biometric; when the passcode is used, Kkoma's approval screen tells the user it is the discouraged path, decision bundle 2j (b)); it manages later devices alone only when it is trusted on every device (registered first, or endorsed once from a trusted computer's terminal; bundle 2i). (c) revised in revision 7: `aigentry-devkit login` asks on an interactive console (default answer no); with no interactive console attached (an agent-driven or unattended install, likely the always-on first device) the device starts with `false`; Kkoma `true`; any device can be turned on later with the browser + second factor. Previous recommendation (`true` for an account's first device) dropped because the first device is likely the agent-driven host, where N-U4 is widest. Consequence: with a computer first and Kkoma later, the one-time terminal step starts with turning `can_approve` on for that computer. (d) requests purged 24 h after a terminal state (under this wording a standing denial lapses 24 h after it is made; decision bundle 2k proposes keeping a denied request while its denial stands and purging it 24 h after it is cleared); approvals kept for the account's life (later fresh devices verify `bootstrap`/`endorse` records, readers' I5 seq floor reads their copied `scope`, and they are the audit), deleted with the account; a shorter approval retention would lose only that floor input, an inconsistency detector (no safety effect). (e) **(B) recommended: no** — an `account` approval is a registry record that a compromised registry can forge, so under (A) every reader would use any recipient value the target's key signed, a denied rotation included (interface invariants §B.1 "`account` `recipient_accept`"); under (B) a recipient change needs a `device` approver. "Never" is the safe form: the bootstrap-style condition "only when no `device` approver exists", evaluated on listed statuses, would be met by a registry that lists the reader and its other trusted devices `expired`, so it is not an equivalent (revision 11, round-10 non-blocking 1). UX cost of (B): a user whose Kkoma is not a trusted device approves key rotations (and the return of an `expired` device that a reader holds for) only from a trusted computer's terminal, which needs `aigentry-brain` there and `can_approve` on. With only two computers and no Kkoma device, that terminal is the **holding computer's own**: each computer's rotation is approved only in a terminal on the other one (revision 11, round-10 blocking 2). If that computer runs Windows, its terminal channel is unverified (ES-02 CK-28 (j) BLOCKED until a Windows runner, D-Q-6), so no verified path exists, and for a Windows-only user with two computers (B) makes Kkoma registered as a device (b), or (A), a de-facto requirement (bundle 2i, 2l) |

## 11. What this does NOT guarantee

- No hardware binding: a copied device directory works until refresh reuse is detected.
- Revoke stops every registry ES-0x request, read or write, that starts after the revoke
  commits (§7.2), with or without Redis. It cannot stop a request already in flight, or
  reads of data the device already holds locally or can fetch from storage outside the
  registry (brain Git repo, ES-02 §5.3 "Known limit").
- No secret of any kind (API keys, `.env`, SSH keys, cloud credentials) is synchronised by
  identity. ES-04 shares only env **names** and supply paths.
- An approval (§8.2) proves which key or account approved, not that a person did: a program that drives an
  approval-capable device's terminal, or calls its keeper, approves the same way (interface non-claim N-U4).
- Identity does not move processes; a device that comes back reconnects and recreates its
  state (ES-03 §9 fencing rejects its stale work).

## 12. New vs reused

| Reused unchanged | New |
|---|---|
| `users`, `tenants`, GitHub OAuth web flow, JWT signing key/algorithm, `decode_token`, Redis (as the limiter store only; device revoke does not use the Redis revoke list, §7.2), the `main.py` slowapi `Limiter` object (not its unwired defaults), request transaction, `cryptography`/PyJWT | `devices`, `device_authorizations`, `/api/v1/devices/*`, `get_current_device`, `device_access` token type, refresh family/reuse detection, per-route rate limits on `/devices/*`, device-approve page, devkit `login/logout/whoami/device *`, per-OS key store; `approval_requests`, `approvals`, `devices.can_approve`, `/approval-requests*`, `aigentry-devkit approve` / `approvals` / `device can-approve`, keeper `approve` / `request_approval` (§8.2) |

## 13. Migration for existing users

- Existing GitHub users: nothing to migrate. Their first `aigentry-devkit login`
  creates a device under their existing `users.id`.
- Existing API-key-only installs (devkit `registry.mode=cloud|self_hosted` with
  `AIGENTRY_API_KEY`): keep working for every existing endpoint. To use ES-02/03/04 they run
  `login` once; the API key is neither converted nor deleted. Users who never log in remain
  in **local-only mode** (local `state/task-queue.json` stays authoritative — ES-03 §11).
- Self-hosted registries with only a bootstrap tenant/admin key and no GitHub OAuth
  configured (`github_client_id` empty — `config.py:107`) cannot run the browser step.
  Supporting them would need another approval path (e.g. approve with an admin API key),
  and that would be a new credential path. It is **not** in this release; it is listed as
  an open item in the ADR.

## 14. Rollback

1. Set `DEVICE_AUTH_ENABLED=false` → `/api/v1/devices/*` return 404, `device_access` tokens
   are rejected; ES-03 endpoints return 503 `device_auth_disabled`; clients fall back to
   local-only mode and keep their local cache (ES-03 §11).
2. Data is kept (not dropped) on flag-off. A schema downgrade (`alembic downgrade` of the
   new revision) drops only the two new tables and requires a prior export (ES-03 §10.6)
   because it is an operational-data deletion (Rule 47).
3. Clients: `aigentry-devkit logout` removes local secrets. Older devkit versions ignore
   the device directory.

## 15. Acceptance criteria → test matrix rows

Matrix rows are the user's (requirements §검증 매트릭스). IDs are stable for ES-09. Rows
marked *supplementary* are analogues and are **not** coverage of the named user row.

| AC | Criterion | Matrix row |
|---|---|---|
| ID-1 | Device A and device B logged in as the same user get the same `user_id` and distinct `device_id`s; both see each other in `device list` | two machines same account |
| ID-2 | A fresh install on a third machine completes `login` without copying any file from A/B and sees the same account. For a GitHub user with no registry account yet, the approval step's GitHub login is the sign-up (`oauth_service.py:84-136`) | third fresh device |
| ID-3 | User Y's device token gets 404 (identical body) on every `devices` and ES-03 resource of user X, including guessed ids, and never sees X's rows in lists | other account isolation |
| ID-4 | After `device revoke`, the revoked device's next write is rejected in the same transaction; its refresh fails with `invalid_grant` | other account isolation (revoke) |
| ID-5 | With a valid proof, presenting a token older than the previous one (rotate twice, then replay the first) revokes the device (`refresh_reuse`); after the `invalid_grant` response the row **is** `revoked` with `revoked_reason=refresh_reuse` (the error response did not roll it back, §5 step 5) | *supplementary* (credential analogue of stale completion fencing; Q-10 covers the row) |
| ID-6 | `device_code` without the matching private-key proof never yields tokens | *supplementary* (Q-11 covers duplicate message) |
| ID-7 | A device that has been offline past the access TTL refreshes on reconnect without user action. A device that has been offline past idle expiry gets `expired` and re-binds to the same `device_id` with `login` | partition/reconnect |
| ID-8 | Killing the CLI during `login` polling leaves no partial secret file; rerun succeeds or code expires | process kill |
| ID-9 | Registry restart: issued tokens stay valid (stateless JWT + DB device row); pending authorizations survive until `expires_at` | origin restart |
| ID-10 | No token/code/key bytes in logs, `--json`, telemetry, `env.sh`, `install-state.json`; secret files have the per-OS protection in §6; **no secret in the argv or environment of any spawned process** (sampled `ps -o args` / `/proc/*/cmdline` / `/proc/*/environ` during `login`, refresh and logout; Windows: process command lines via WMI) | other account isolation (secrets) |
| ID-11 | Per-OS key store behaviour verified on real macOS, Linux and Windows, including the stdin-only secret transport of §6 | per-OS verification |
| ID-12 | Per-route limits of §7.4 enforced: 11th `/devices/authorize` from one IP in a minute → 429, also when every request carries a different `X-Forwarded-For` / `CF-Connecting-IP` value from a peer outside `TRUSTED_PROXY_CIDRS`; 6th wrong `user_code` in 10 min → 429; with `RATE_LIMIT_ENABLED=false` the `/devices/*` limits still apply; existing non-device endpoints show no new limit (global middleware still off) | other account isolation (enumeration) |
| ID-13 | Limiter store (Redis) unreachable: `/devices/authorize`, `/approve`, `/deny`, `/token` → 503 `rate_limit_unavailable`, never served unlimited | origin restart (dependency down) |
| ID-14 | Refresh response dropped, then the client retries with the same (previous) token, immediately and again after > 1 h: both retries yield a new pair, the device stays `active`, `refresh_retry` events recorded | late ACK (credential analogue) |
| ID-15 | Refresh for a known `device_id` with a garbage or stale token and **no valid proof** → `invalid_grant`; the device row is unchanged (status, hashes) | other account isolation (revoke by stranger) |
| ID-16 | After `device revoke` (and with Redis stopped, to show independence): the revoked device's `GET /devices`, `GET /devices/me`, ES-03 `list`, `get`, `events`, `resolve` and `export` → 401 `device_inactive`; its lease keeper's reconcile/sync gets no data; a request racing the revoke either completes before it or is refused | revoked device: sync refused |
| ID-17 | A `role=admin` user (`ADMIN_GITHUB_IDS`) gets 404 on every ES-0x resource of another user, read and write | other account isolation (admin) |
| ID-18 | `X-API-Key` (valid tenant key) on every ES-0x endpoint → 401; the same key still works on an existing endpoint | other account isolation (tenant key) |
| ID-19 | `POST /devices/approve` with a valid browser cookie but without `X-Aigentry-Intent: device-approve` → 403 and the authorization stays `pending`; a cross-origin form post cannot approve | other account isolation (approval CSRF) |
| ID-20 | Approval page shows name/os/version, request time and network prefix; a spoofed `X-Forwarded-For` from an untrusted peer does not change the displayed prefix (it is the socket peer's); the 21st active device → `device_limit` | other account isolation (device-code phishing) |
| ID-21 | `GET /devices?include=keys,approvals&all=true` returns keys, signed age recipients and `revoked_at` for active **and** revoked devices; a tampered `age_recipient` fails its signature check against `public_key`, and `PUT /devices/me/age-recipient` or `/authorize` with a bad signature → 422 `age_recipient_sig_invalid`, nothing stored; a replay of an earlier validly signed value (`age_recipient_seq` not greater than the stored one) → 409 `age_recipient_seq_stale`, nothing stored; `revoked_at` never changes after revoke; `created_at` is unchanged by an `expired` re-bind; idle expiry leaves `revoked_reason`/`revoked_at` null; logging in again after a revoke yields a new `device_id` | revoked device (ES-02/ES-04 reader inputs) |
| ID-22 | Fingerprint (§8.1 FP): for the current device `device list`/`whoami` show `fingerprint_local` computed from the local key and `fingerprint_server` from the list, both in `aigfp1:` format; equal for an honest registry; a fixture registry that serves a substituted `public_key` yields `fingerprint_match=false`, a stderr warning and exit 6; the local value never changes when the server response changes; known-answer vector for the format | other account isolation (key substitution) |
| ID-23 | Keeper signing and list (§8.1 R1; interface invariant I12): (a) a local caller asks `sign` with `aigentry-device-v1\|`, `aigentry-age-recipient-v1\|` and an unknown prefix → `SIGN_PREFIX_REFUSED` each, nothing signed; `sign` with `aigentry-checkpoint-v1\|` returns a signature that verifies with the device's `public_key`; (b) the calling process (a fixture standing in for brain) opens no file under the device directory and receives no key bytes over the socket (protocol capture); (c) `register_age_recipient` with a malformed recipient → refused; with a valid one → the registry stores it with a verifying signature; (d) `device_list()` returns the R3 list with `server_time`; after the device is revoked, its `device_list()` → 401 `device_inactive` | revoked device (ES-02/ES-04 signer and list inputs) |
| ID-24 | Approval primitive (§3.3, §8.2; interface invariants §B.1 "Approval", I4, I5, I12): (a) a device bearer creates a `bootstrap` request for itself → `pending` with server `issued_at`/`expires_at` and a fresh nonce; for another `reader_device_id` → 422; a duplicate → the same request; (b) a valid `device` approval → `approved`, one `approvals` row with server `approved_at`, listed with `include=approvals`; a second approve of the same request (replay) → 409 `approval_consumed`, nothing written; two concurrent approves → exactly one wins; (c) an approve after `expires_at` (fixture clock) → 410 `approval_expired`, nothing written; (d) signatures over another `target_device_id`, `target_fp`, `target_age_recipient_seq` or `scope_digest` → 422 `approval_sig_invalid`; (e) approver revoked, or `can_approve: false` → 403; an `account` approval of an `endorse` → 422 `approval_kind_not_allowed`; an `account` approval of a `bootstrap` whose `scope` lists another active device, or `r` approving its own such bootstrap → 422; an `endorse` or `recipient_accept` approved by its own target device → 422 `approval_kind_not_allowed`; an `account` approval of a `recipient_accept` with D-ID-6 (e) set to (B) → 422 `approval_kind_not_allowed`, and with (A) → `approved` (the residual's precondition); an `account` approval without a second factor, or without the intent header → 401 / 403; (f) `can-approve on` with a device bearer only → 403, with browser + second factor → set; `off` with any own device bearer → set; (g) the keeper's `sign` with `aigentry-approval-v1\|` → `SIGN_PREFIX_REFUSED`; `approve(request_id, expected_sha256)` signs exactly the canonical string of the pending request, whose hash equals the previewed one (protocol capture; the caller cannot supply a payload); `aigentry-devkit approve` with stderr piped or the answer on stdin → exit 7, no approval; under a fixture pseudo-terminal with the answer typed → approved (the documented N-U4 residual, not a defence); (h) the same `aigentry-devkit approve` discipline on Windows (`CONIN$`, console handle; no console → exit 7); (i) user Y's device or browser approving user X's request → 404, identical body; (j) the stub registry serves `preview_approval` one body and the keeper's re-fetch in `approve(request_id, expected_sha256)` another → `APPROVAL_REQUEST_CHANGED`, no signature, nothing sent; the same body twice → signed, and `signed_approvals()` lists its `request_id` and hash; (k) a `bootstrap` whose `scope` does not hash to its `scope_digest` → `aigentry-devkit approve` exit 7 `APPROVAL_SCOPE_MISMATCH` before asking; a `bootstrap` request created with a `scope` or digest that differs from the registry's own device set → 422 `approval_scope_mismatch`; an approver outside the `scope` device ids → 422; (l) standing denial and rate: deny an `endorse` request; creating the same `(action, reader, target, target_fp)` again (any device bearer), also at a higher seq, returns the denied request, and the record carries `denied_by_device_id` and `denied_channel`; a denied `recipient_accept` returns for a later seq with the same hash; a `can_approve` change is listed with its actor; `clear-denial` with a device bearer → 403, with the browser session + intent header → cleared, and the next create makes a new `pending` request; a `recipient_accept` create for another hash is new; creates beyond the per-bearer limit → 429, and with the limiter store down → 503; (m) stale scope: a `bootstrap` request is created, then one device of its set re-registers its recipient (seq + 1), and in a variant another device is revoked (status change; the digest covers `status`) → approve → 409 `approval_scope_stale`, nothing written, request `expired`; (n) bound target values (revision 9): an `endorse` or `recipient_accept` request bound to (B, seq 2^53, hash x), or to a fp other than B's → 422 `approval_scope_mismatch`, refused before any database write (also `PUT /me/age-recipient` with seq 2^53 → 422 `age_recipient_seq_out_of_range`, no DB error, no 500); a valid request's `scope` entry carries B's stored `age_recipient` and `age_recipient_sig`; it is approved, and after the request is purged (fixture clock + 24 h) the listed approval record still carries `scope` with them (revision 10), and a listed `bootstrap` approval record's `scope` carries no `name`, `os` or `created_at` while its digest still recomputes from it (revision 11); B re-registers (seq + 1) between request and approve → 409 `approval_scope_stale`; `aigentry-devkit approve` of a `bootstrap` whose `scope` differs from this device's own fresh list (stub list B = (1, h), preview B = (2, h′)) → exit 7 `APPROVAL_SCOPE_MISMATCH` before asking, no approval; a "no" → exit 3, request still `pending`, no denial | revoked device (approval replay, staleness, wrong target) |

### 15.1 Testability per row (criterion 4)

Environments:
- **F1:** one Linux host, a local registry fixture (Postgres + Redis), several simulated
  devices (separate key directories or OS users), and a fault proxy that can drop
  responses. A PASS here is reported as **"Linux fixture"**. It never counts as
  cross-platform, cross-host or real-endpoint.
- **H2 / H3:** two or three real hosts, one of them the Mac, because the requirement pairs
  the always-on Linux host with the Mac. A Linux-only host set may run the row, but that
  result is recorded as partial evidence ("Linux hosts only") and does not close it.
- **OS3:** real macOS, Linux and Windows hosts.
- A deployed registry (real endpoint) is needed only for the D-ID-3 enablement check. It
  is not a row here.

Status today for **every** row: **NOT RUN**. No implementation exists, and this is a spec.

| Row | Measures | Does not measure | Env (Linux-only counts?) | Blocked on (today) |
|---|---|---|---|---|
| ID-1 | same `user_id`, distinct `device_id`, mutual listing | key-store protection per OS (ID-11); network faults | H2 (no) | **BLOCKED**: Mac offline; implementation |
| ID-2 | login with no copied file; sign-up via first GitHub login | restore of work (ES-02 CK-03, Q-3) | H3 (no) | **BLOCKED**: Mac offline; third host not measured as available; implementation |
| ID-3 | identical 404 body/status/code path across not-found and not-owned | timing side channels | F1 (yes) | implementation |
| ID-4 | write refused in-transaction after revoke; refresh `invalid_grant` | reads (ID-16) | F1 (yes) | implementation |
| ID-5 | reuse with valid proof → revoke, persisted despite the error response | the user's stale-completion row (Q-10) | F1 (yes) | implementation |
| ID-6 | proof required for code exchange | duplicate message (Q-11) | F1 (yes) | implementation |
| ID-7 | refresh after access TTL; idle expiry → re-bind same row (short TTL settings) | a real Mac sleep/wake (Q-6) | F1 (yes, protocol only) | implementation |
| ID-8 | no partial secret on kill (Linux file store) | Keychain/DPAPI atomicity (ID-11) | F1 (Linux part only) | implementation |
| ID-9 | tokens and pending authorizations survive restart | deployed-instance restart behaviour | F1 (yes) | implementation |
| ID-10 | no secret in files/logs/argv/env on Linux | macOS/Windows argv/env (ID-11) | F1 (Linux part only) | implementation |
| ID-11 | Keychain via `security -i` stdin, DPAPI via PowerShell stdin, Linux file store; ID-8/ID-10 per OS | — | OS3 (no) | **BLOCKED**: Mac offline; no Windows runner (D-Q-6) |
| ID-12 | per-route limits enforced, keyed by the trusted client IP, independent of `RATE_LIMIT_ENABLED`; no global limit added | distributed (multi-IP) abuse; a deployed front's header handling | F1 (yes) | implementation |
| ID-13 | fail-closed on limiter store loss | partial Redis degradation (latency) | F1 (yes) | implementation |
| ID-14 | lost refresh response never revokes | client crash between receipt and fsync on Keychain/DPAPI | F1 (yes) | implementation |
| ID-15 | no revoke without proof | — | F1 (yes) | implementation |
| ID-16 | revoke stops reads and writes, independent of Redis; race ordering | data outside the registry (ES-02 brain Git, ES-02 CK-11) | F1 (yes) | implementation |
| ID-17 | admin does not cross users | admin features (none in this release) | F1 (yes) | implementation |
| ID-18 | tenant API key refused on ES-0x, unchanged elsewhere | G2 on existing endpoints (registry issue) | F1 (yes) | implementation |
| ID-19 | intent header required; CSRF form refused | phishing of a willing user (§4 approval display) | F1 (yes, HTTP client; no GUI typing) | implementation |
| ID-20 | approval display fields; device cap | whether a user notices a phishing prompt | F1 (yes) | implementation |
| ID-21 | list contents and immutability for ES-02/ES-04 readers | reader-side verification itself (ES-02 CK-11) | F1 (yes) | implementation |
| ID-22 | local vs server fingerprint, format, mismatch exit | whether the user actually compares out of band | F1 (yes) | implementation |
| ID-23 | keeper prefix allowlist, no key bytes to callers, recipient registration, list through the keeper | other same-uid processes using the keeper (OS-user boundary, interface non-claim N-U4); macOS/Windows keeper (ES-03 Q-17) | F1 (yes, Linux keeper) | implementation; D-Q-9 |
| ID-24 | (a)–(g), (i)–(n): request binding, single use, expiry, signature binding to device/fp/seq/digest, approver rules incl. approver ≠ target, `can_approve`, prefix refusal, the terminal channel's discipline against incidental runs, display = signed body, scope digest recomputation, standing denials (fp-keyed, attributed) and request rate, stale-scope refusal, bound target values, `scope` in the listed record after the request's purge and the own-list check (n), the `account` `recipient_accept` refusal under D-ID-6 (e) (B) (e) | whether a person, rather than a program driving the terminal or calling the keeper, approved (N-U4); a compromised or equivocating registry (N-U3); the real passkey / Kkoma channels (D-ID-6) | F1 (yes, Linux keeper; (h) no) | implementation; (h) **BLOCKED**: no Windows runner (D-Q-6) |
