# ES-01 — Account + device identity for environment continuity (task #2026101204)

**Status:** CONTRACT SPEC ONLY. No code, no migration run, no credential created, no network
change. Parent task #2026101204 ("동일 계정으로 다른 머신에서 개발 작업 이어가기"), child ES-01
(runtime alias #2026101207). Decisions and rejected alternatives: ADR
`docs/adr/2026-10-12-env-continuity-identity-and-queue.md`. Consumer of this contract:
ES-03 `docs/specs/2026-10-12-env-continuity-shared-queue.md`.

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
  `expires_at` — `models/api_key.py:79-89`. **No `user_id`.** Raw key format `aig_<64 hex>`
  (`services/auth/api_key_service.py:20`).
- `get_current_user_or_key` accepts a JWT cookie but then returns **any active API key of
  the same tenant** (`api/v1/auth.py:71-82`). The user identity is dropped at that point.
- `user_sessions` are tied to an API key, not a user, 24 h (`models/user_session.py:45-58`,
  `services/auth/session_service.py:11`).
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

- Only the `aigentry-devkit` binary is shipped (`aigentry-devkit/package.json:18-21`);
  commands are dispatched in `bin/aigentry-devkit.js:754-830`. There is no `login` or
  `device` command.
- The registry API key is written **in plaintext** to the env fan-out file
  (`install.sh:261-269`, file `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/env.sh`
  mode 600 — `install.sh:24-26`) **and** to `install-state.json`
  (`install.sh:242-246`). On Windows the same key goes to `env.ps1` and
  `install-state.json` without an ACL step (`install.ps1:17-19, 160-164, 176-184`).

### 1.6 Gaps this spec closes

| # | Gap | Evidence |
|---|---|---|
| G1 | No device entity, no CLI login | no `device` model in `src/aigentry/models/`; §1.5 |
| G2 | JWT path loses the user (tenant-key substitution) | `auth.py:71-82` |
| G3 | Revocation is Redis-only and TTL-bounded; a lost device cannot be revoked durably | `revocation_service.py:17-22` |
| G4 | JWTs are cookie-only; a CLI cannot present them | `oauth.py:94-113, 166` |
| G5 | Refresh rotation has no reuse detection | `oauth.py:186-191` |
| G6 | API keys are tenant-scoped, carry no user/device | `api_key.py:79-89` |

Observed but **not** fixed here (mentioned only, Rule 29): plaintext API key in devkit
state files (§1.5); OAuth callback logs the CSRF state values (`oauth.py:59-72`);
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
| `public_key` | bytea(32), unique | raw Ed25519 public key |
| `status` | varchar(16) | `active` \| `revoked` \| `expired` |
| `refresh_family_id` | UUID | current refresh family |
| `refresh_hash` | char(64) | sha256 of the *current* refresh token; previous one is not kept |
| `refresh_idle_expires_at` | timestamptz | sliding |
| `refresh_abs_expires_at` | timestamptz | absolute, set at registration / re-login |
| `client_version` | varchar(32) | devkit version string |
| `created_at`, `last_seen_at`, `revoked_at` | timestamptz | |
| `revoked_reason` | varchar(32) | `user` \| `refresh_reuse` \| `idle_expiry` \| `admin_disable_user` |
| `revoked_by_device_id` | UUID null | which device issued the revoke (audit) |

Constraint: `(user_id, name)` unique among `status='active'` (partial unique index).

### 3.2 `device_authorizations` (device-code login, short-lived)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID pk | |
| `device_code_hash` | char(64) unique | sha256 of the 32-byte random device code |
| `user_code_hash` | char(64) unique among pending | sha256 of normalized user code |
| `public_key` | bytea(32) | key the device will be bound to |
| `requested_name`, `os`, `client_version` | | shown to the user on approval |
| `status` | varchar(16) | `pending` \| `approved` \| `denied` \| `consumed` \| `expired` |
| `user_id` | UUID null | set on approval |
| `expires_at` | timestamptz | created + 600 s |
| `poll_interval_s` | int | 5, raised by `slow_down` |
| `last_poll_at`, `created_at` | timestamptz | |

Rows are purged 24 h after a terminal state. Raw device/user codes are never stored.

No existing table is altered. `users`, `tenants`, `api_keys`, `user_sessions` are
unchanged.

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
                                                                      OAuth (oauth.py:28-128)
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
- The approval page must display the device's name/os/version and the time of the request;
  approval requires an explicit click (no auto-approve, no approve-by-link).
- `approve` and `deny` require the browser JWT (`type=access`, not revoked) **and** a
  custom header (`X-Aigentry-Intent: device-approve`) so a cross-site form post cannot
  approve (the cookies are `samesite=lax` — `oauth.py:94-102`).
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
- Rotation with **reuse detection** (closes G5): the server keeps only the current hash. If
  a request presents a token whose family matches but hash does not, the device is set
  `revoked` with `revoked_reason=refresh_reuse` and every live device access `jti` for that
  device is added to the Redis revoke list. The legitimate holder must log in again.
- Idle expiry sets `status=expired` (not revoked); `aigentry-devkit login` re-binds the
  **same** device row if the same public key proves possession, so history and lease
  attribution survive a long absence (the Mac case).
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
| macOS | login Keychain via `/usr/bin/security add-generic-password -s aigentry-device -a <device_id>` | file store if Keychain is locked/unavailable (e.g. SSH-only session), with a warning | `~/.config/aigentry/device/` for the non-secret metadata |
| Linux | file store: dir `0700`, files `0600`, owner check on every read, refuse if group/world bits are set | Secret Service via `secret-tool` **only** when explicitly requested (`--keystore secret-service`); headless hosts usually have no unlocked keyring | `${XDG_CONFIG_HOME:-~/.config}/aigentry/device/` |
| Windows | file encrypted with DPAPI `CurrentUser` scope via PowerShell `System.Security.Cryptography.ProtectedData` (ships with Windows PowerShell 5.1) + owner-only ACL | none — refuse login if DPAPI unavailable | `%USERPROFILE%\.config\aigentry\device\` (matches devkit's state-dir convention, `install.ps1:17`) |

The file store holds `device.json` (non-secret: ids, URL, key_alg, created_at) and
`secret.json` (private key + refresh token). Writes are tmp + fsync + rename (same pattern
as telesession `src/store.js:316-330`). Copying the directory to another machine is
*detected*, not prevented: the server sees one device key used from two places only if
refresh reuse fires (§5); there is no hardware binding in this release (§11).

Open question that stays with the user (D-ID-2): Keychain-by-default on macOS vs a uniform
file store everywhere. Recommended: Keychain on macOS, because it is OS-shipped and protects
the key at rest. The file store is the fallback.

## 7. Authorization and isolation rules

### 7.1 New dependency `get_current_device` (registry)

1. Read `Authorization: Bearer`; decode with existing `decode_token` (`oauth_service.py:167-169`).
2. Require `type == "device_access"`; reject `access`/`refresh` web tokens on device
   endpoints and device tokens on cookie endpoints.
3. Redis revoke check as today; **if Redis is unreachable, fail closed (503)** for device
   endpoints (today's web path silently falls through — `auth.py:83-84`).
4. Return `(user_id, device_id, tenant_id)`. Never substitute an API key (G2).

### 7.2 Durable revoke check

Every ES-03 mutation (`create/claim/heartbeat/release/complete`) and every ES-02/ES-04
write loads `devices` by `(id = did, user_id = sub)` **inside the same transaction** and
requires `status='active'`. Revoke therefore takes effect immediately for writes. Reads
are bounded by the 15-min access lifetime. Also, revoke adds the device's live access
`jti`s to Redis so reads stop as well while Redis is up.

### 7.3 Resource isolation table

Every row the feature stores carries `owner_user_id`. Every query includes
`owner_user_id = :caller_user_id` in the **same SQL statement** that selects the row
(never "load then check").

| Resource | Owner column | Who can read | Who can write | Cross-user response |
|---|---|---|---|---|
| `devices` | `user_id` | owner (any of own devices, browser session) | owner (rename/revoke) | 404 |
| `device_authorizations` | `user_id` after approval | nobody via API except the polling device by `device_code` | approve/deny: logged-in user | uniform `expired_token` / 404 |
| ES-03 queues, tasks, aliases, events, leases | `owner_user_id` | owner's active devices | owner's active devices | 404 |
| ES-08 intake receipts | `owner_user_id` | owner's devices | intake adapter acting as an owner device | 404 |
| ES-02 checkpoints, ES-04 captures (defined by their specs) | `owner_user_id` | owner's devices | owner's devices | 404 |

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
  and `/devices/deny` (5 per browser session per 10 min), and `/devices/token` (60/min per
  `device_id`, and 30/min per IP for unknown ids). `/devices/token` also enforces the poll
  `interval` (else `slow_down`). The decorators use the `main.py` `Limiter` (Redis store,
  `main.py:93`).
  - The global `SlowAPIMiddleware` is **not** switched on: that would change every existing
    endpoint, which is a production behaviour change outside this spec. The general fix
    belongs to the registry rate-limiter issue.
  - **Limiter store down** (Redis unreachable): `/devices/authorize|approve|deny|token`
    **fail closed** with 503 `rate_limit_unavailable`. They never fall through to "no
    limit". Other ES-0x endpoints do not depend on Redis (§7.1).
  - Test rows ID-12 (limits enforced) and ID-13 (store down → 503) in §15.
- Logs: `user_id`/`device_id` only; never codes, tokens, public keys in full (first 8 hex
  for correlation), never the GitHub login of another user.

## 8. Registry API (new, all under `/api/v1/devices`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /authorize` | none (rate-limited) | start device-code login (§4) |
| `POST /approve`, `POST /deny` | browser JWT cookie + intent header | bind code to user |
| `POST /token` | device_code + proof, or refresh + proof | issue / rotate tokens |
| `GET /` | device bearer or browser cookie | list caller's devices: id, name, os, status, created_at, last_seen_at, `current: bool` |
| `GET /me` | device bearer | this device + user (`user_id`, `github_login`) |
| `PATCH /{id}` | device bearer or browser | rename (own only) |
| `DELETE /{id}` | device bearer or browser | revoke (own only; self allowed) — idempotent, 204 also when already revoked |

Errors use the RFC 8628 names for the token endpoint (`authorization_pending`,
`slow_down`, `access_denied`, `expired_token`) and `invalid_grant` for bad refresh/proof.

Per 제15조 these request/response schemas are registered in aigentry-ssot before
implementation; the registry owns the server, devkit owns the client.

## 9. CLI surface (devkit; `aigentry-devkit` is the only shipped binary — `package.json:18-21`)

| Command | Flags | Behaviour | Exit codes |
|---|---|---|---|
| `aigentry-devkit login` | `--registry <url>` (default from install state `registry.api_url`), `--name <device-name>`, `--open`, `--keystore auto\|file\|keychain\|secret-service`, `--json` | §4 flow; re-binds an `expired` device with the same key; refuses if a different user is already logged in on this device dir unless `--switch-user` | 0 ok, 2 usage, 3 denied/expired code, 4 network unknown, 5 keystore unavailable |
| `aigentry-devkit logout` | `--revoke`, `--json` | deletes local secret; `--revoke` first calls `DELETE /devices/{self}` (local delete still happens if revoke fails; prints `revoke: unknown`) | 0, 4 |
| `aigentry-devkit whoami` | `--json` | user login, user_id, device_id/name, registry, token freshness | 0, 1 not logged in |
| `aigentry-devkit device list` | `--json`, `--all` (include revoked/expired) | own devices, current marked | 0, 1, 4 |
| `aigentry-devkit device revoke <device-id>` | `--yes`, `--json` | revoke one of own devices (lost-device path); confirmation required without `--yes` | 0, 1, 4 |
| `aigentry-devkit device rename <device-id> <name>` | `--json` | | 0, 1, 4 |

`--json` output never contains tokens, codes or key bytes. The registry UI gets the same
list/revoke on the existing settings page (`oauth.py:90` redirects there after login),
which is the lost-device path when no other CLI device is at hand.

The installer (`install.sh` phase 6 `registry-wiring`, `install.sh:666-725`; `install.ps1`)
gains an optional "log this device in now?" step that runs `aigentry-devkit login`. It
**does not** write any device secret into `env.sh`, `env.ps1` or `install-state.json`.

## 10. Decisions needed (Rule 47)

| Id | Decision | Category | Recommended default |
|---|---|---|---|
| D-ID-1 | Token lifetimes | privacy / permission | access 15 min; refresh idle 30 d, absolute 90 d; rotation + reuse → revoke |
| D-ID-2 | Device secret storage location | privacy / permission | macOS Keychain (`security`), Linux 0600 file under `~/.config/aigentry/device/`, Windows DPAPI file; never env/state files |
| D-ID-3 | Enabling device credentials on a deployed registry (new credential type + new endpoints) | permission expansion / production deploy | ship behind `DEVICE_AUTH_ENABLED=false`; enable per instance after ES-09 isolation tests pass |
| D-ID-4 | Devices talk to the registry over its existing HTTPS endpoint (new client→server traffic from every device) | network change / personal-data transfer | allowed only to the registry URL the user chose at install (cloud or self-hosted); no new relay |

## 11. What this does NOT guarantee

- No hardware binding: a copied device directory works until refresh reuse is detected.
- Read access after revoke may last up to 15 min if Redis is unavailable (writes stop
  immediately — §7.2).
- No secret of any kind (API keys, `.env`, SSH keys, cloud credentials) is synchronised by
  identity. ES-04 shares only env **names** and supply paths.
- Identity does not move processes; a device that comes back reconnects and recreates its
  state (ES-03 §9 fencing rejects its stale work).

## 12. New vs reused

| Reused unchanged | New |
|---|---|
| `users`, `tenants`, GitHub OAuth web flow, JWT signing key/algorithm, `decode_token`, Redis revoke list, the `main.py` slowapi `Limiter` object (not its unwired defaults), request transaction, `cryptography`/PyJWT | `devices`, `device_authorizations`, `/api/v1/devices/*`, `get_current_device`, `device_access` token type, refresh family/reuse detection, per-route rate limits on `/devices/*`, device-approve page, devkit `login/logout/whoami/device *`, per-OS key store |

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

Matrix rows are the user's (requirements §검증 매트릭스). IDs are stable for ES-09.

| AC | Criterion | Matrix row |
|---|---|---|
| ID-1 | Device A and device B logged in as the same user get the same `user_id` and distinct `device_id`s; both see each other in `device list` | two machines same account |
| ID-2 | A fresh install on a third machine completes `login` without copying any file from A/B and sees the same account | third fresh device |
| ID-3 | User Y's device token gets 404 (identical body) on every `devices` and ES-03 resource of user X, including guessed ids, and never sees X's rows in lists | other account isolation |
| ID-4 | After `device revoke`, the revoked device's next write is rejected in the same transaction; its refresh fails with `invalid_grant` | other account isolation (revoke) |
| ID-5 | Replaying a rotated refresh token revokes the device (`refresh_reuse`) | stale completion fencing (credential analogue) |
| ID-6 | `device_code` without the matching private-key proof never yields tokens | duplicate message |
| ID-7 | A device that has been offline past the access TTL refreshes on reconnect without user action. A device that has been offline past idle expiry gets `expired` and re-binds to the same `device_id` with `login` | partition/reconnect |
| ID-8 | Killing the CLI during `login` polling leaves no partial secret file; rerun succeeds or code expires | process kill |
| ID-9 | Registry restart: issued tokens stay valid (stateless JWT + DB device row); pending authorizations survive until `expires_at` | origin restart |
| ID-10 | No token/code/key bytes in logs, `--json`, telemetry, `env.sh`, `install-state.json`; secret files have the per-OS protection in §6 | other account isolation (secrets) |
| ID-11 | Per-OS key store behaviour verified on real macOS, Linux and Windows. A Linux-only fixture PASS is **not** reported as cross-platform | per-OS verification |
| ID-12 | Per-route limits of §7.4 enforced: 11th `/devices/authorize` from one IP in a minute → 429; 6th wrong `user_code` in 10 min → 429; existing non-device endpoints show no new limit (global middleware still off) | other account isolation (enumeration) |
| ID-13 | Limiter store (Redis) unreachable: `/devices/authorize|approve|deny|token` → 503 `rate_limit_unavailable`, never served unlimited | origin restart (dependency down) |
