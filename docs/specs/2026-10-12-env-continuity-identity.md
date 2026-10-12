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
| `age_recipient_sig` | bytea(64) null | Ed25519 signature by this device's key over `"aigentry-age-recipient-v1\|" + hex(public_key) + "\|" + age_recipient`. It is bound to `public_key`, not `device_id`, because the device signs at `/devices/authorize`, before any `device_id` exists. The key never changes for a row, so the binding is just as strong. The registry cannot substitute the recipient without breaking the signature |
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

Constraint: `(user_id, name)` unique among `status='active'` (partial unique index).

### 3.2 `device_authorizations` (device-code login, short-lived)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID pk | |
| `device_code_hash` | char(64) unique | sha256 of the 32-byte random device code |
| `user_code_hash` | char(64) unique among pending | sha256 of normalized user code |
| `public_key` | bytea(32) | key the device will be bound to |
| `requested_name`, `os`, `client_version` | | shown to the user on approval |
| `request_net_prefix` | varchar(48) | requester IP truncated to /24 (IPv4) or /48 (IPv6); shown on approval; purged with the row |
| `age_recipient`, `age_recipient_sig` | | optional; copied to `devices` on consumption (§8.1) |
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
     state to check.
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
| `GET /` | device bearer or browser cookie | list caller's devices: id, name, os, status, created_at, last_seen_at, `current: bool`; with `include=keys&all=true` (device bearer only) also `revoked_at`, `public_key`, `age_recipient`, `age_recipient_sig`, `age_recipient_set_at`, `server_time` and revoked/expired devices (§8.1) |
| `GET /me` | device bearer | this device + user (`user_id`, `github_id`, `github_login`) |
| `PUT /me/age-recipient` | device bearer | set or rotate this device's signed age recipient (§8.1) |
| `PATCH /{id}` | device bearer or browser | rename (own only) |
| `DELETE /{id}` | device bearer or browser | revoke (own only; self allowed) — idempotent, 204 also when already revoked |

Errors use the RFC 8628 names for the token endpoint (`authorization_pending`,
`slow_down`, `access_denied`, `expired_token`) and `invalid_grant` for bad refresh/proof.

### 8.1 Interface for ES-02 / ES-04 (their "Requirements on ES-01", ES-02 §5.5 R1–R7)

| # | Provided by ES-01 |
|---|---|
| R1 signing key | the device's Ed25519 key (§3.1). ES-01 signs only with prefix `aigentry-device-v1\|` (and `aigentry-age-recipient-v1\|`). ES-02/ES-04 use their own prefixes. The key store (§6) exposes a *sign* operation through the lease keeper (ES-03 §5.1); key bytes never leave the store |
| R2 age recipient | `age_recipient` + `age_recipient_sig` per device (§3.1), sent with `/devices/authorize` or set later by `PUT /devices/me/age-recipient` (device bearer, new signed value = rotation). Generated on the device. The private half follows the same store rules as the device key (§6) |
| R3 authenticated device list | `GET /devices?include=keys&all=true` (owner's device bearer only, §7.2) returns per device: `id, name, os, status, created_at, revoked_at, public_key, age_recipient, age_recipient_sig, age_recipient_set_at`, revoked and expired devices included, plus `server_time`. Over TLS to the registry URL of D-ID-4. Integrity rests on the registry (R5) |
| R4 revoke time | `revoked_at`: server clock, set once, never cleared or moved; revoked rows are never re-bound, and logging in again creates a new `device_id` with a new key (§5). `expired` is not revoked: `revoked_at` stays null and the device's signatures stay valid. Retention: D-ID-5 |
| R5 trust model | **Model:** the registry is the **key directory** and is trusted for membership. A compromised registry could add a device key and so become a recipient of new records. **What ES-01 provides for the mitigation:** stable `device_id`; an immutable `public_key` per id; a fingerprint (first 8 bytes of sha256 of `public_key`, hex, shown by `device list`); the signed recipient (R2); and server-clock `created_at` and `revoked_at` that are never moved (§3.1). Clients pin `id + fingerprints`. A pinned device whose `public_key`, `created_at` or `revoked_at` changes in a later list is treated as a registry fault, not as an update, and is surfaced (R6). **Endorsement validity, using ES-01 timestamps:** an endorsement is valid only if the endorsed device's server-clock `created_at` **precedes** the endorser's `revoked_at` (or the endorser has no `revoked_at`). An endorsement by a device dated after that device's `revoked_at` is void. Revoking a device does not revoke the devices it endorsed. The user's first device (earliest `created_at`) is self-trusted. Endorsements are signed with the endorser's device key through the R1 sign operation, under an ES-02 prefix. The endorsement file, its storage in the brain repo, and whether endorsement is required (decision D-9) belong to ES-02. ES-01 adds no server-side endorsement and does not make the registry the judge of trust. Because `created_at`/`revoked_at` are registry assertions, they are as trustworthy as the registry under this model; pinning makes later changes visible but cannot prove the first value |
| R6 change notice | The list makes every change ES-02 must announce observable, so a client can diff it against its pinned set: **addition** (a new `device_id`), **key change** (new `age_recipient`/`age_recipient_sig`, with `age_recipient_set_at`; `public_key` never changes for an id), **revoke** (`status`, `revoked_at`). The list carries the fields the notice must show: `name`, `os`, `created_at`, fingerprints. Every list response includes `server_time`, so the client can show freshness. Showing the notice (CLI/MCP, `recipients_changed`) before the new set is used for writes, with removals taking effect immediately, is the client's job (ES-02) |
| R7 Git-stored data | ES-01 §7.2/§7.3 no longer claim registry-transaction enforcement for brain-Git data; readers verify against R3 |
| GitHub binding (ES-02 §5.2) | `GET /devices/me` returns `github_id` (stable) and `github_login` of the user, so a client can check that the brain repo's GitHub owner is the same account. The binding is the existing `users.github_id` (§1.1); nothing new is stored |

Per 제15조 these request/response schemas are registered in aigentry-ssot before
implementation; the registry owns the server, devkit owns the client.

## 9. CLI surface (devkit; hosted in the `aigentry-devkit` binary, one of the two shipped — `package.json:19-20`)

The build plan's names `aigentry login` / `aigentry device …` are **renamed** to
`aigentry-devkit login` / `aigentry-devkit device …`, because no `aigentry` binary is
shipped by devkit. `aigentry-devkit-bootstrap` gets no new command.

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
| D-ID-1 | Token lifetimes | privacy / permission | access 15 min; refresh idle 30 d, absolute 90 d; rotation; proof checked first; previous-token retry re-rotates; older token with valid proof → revoke (§5) |
| D-ID-2 | Device secret storage location | privacy / permission | macOS Keychain via `security -i` with the secret on stdin (conditional on ES-09 verifying that path, §6), file store on macOS only with explicit `--keystore file`; Linux 0600 file under `~/.config/aigentry/device/`; Windows DPAPI file via PowerShell reading stdin; never env/state files, never argv |
| D-ID-3 | Enabling device credentials on a deployed registry (new credential type + new endpoints) | permission expansion / production deploy | ship behind `DEVICE_AUTH_ENABLED=false`; enable per instance after ES-09 isolation tests pass |
| D-ID-4 | Devices talk to the registry over its existing HTTPS endpoint (new client→server traffic from every device) | network change / personal-data transfer | allowed only to the registry URL the user chose at install (cloud or self-hosted); no new relay |
| D-ID-5 | Retention of `revoked`/`expired` device rows (`name`, `os`, `client_version`, `last_seen_at`, keys, `revoked_at`) and of `device_authorizations` (incl. request network prefix, §4) | personal data | `expired` rows kept as they are (they can re-bind, §5). `revoked` rows: `os`, `client_version`, `last_seen_at` cleared 90 days after `revoked_at`; `id`, `name`, `public_key`, `age_recipient`, `status`, `revoked_at` kept for the account's life, because ES-02/ES-04 readers verify old signatures against them (§8.1); all rows deleted with the account. `device_authorizations` purged 24 h after a terminal state (§3.2) |

## 11. What this does NOT guarantee

- No hardware binding: a copied device directory works until refresh reuse is detected.
- Revoke stops every registry ES-0x request, read or write, that starts after the revoke
  commits (§7.2), with or without Redis. It cannot stop a request already in flight, or
  reads of data the device already holds locally or can fetch from storage outside the
  registry (brain Git repo, ES-02 §5.3 "Known limit").
- No secret of any kind (API keys, `.env`, SSH keys, cloud credentials) is synchronised by
  identity. ES-04 shares only env **names** and supply paths.
- Identity does not move processes; a device that comes back reconnects and recreates its
  state (ES-03 §9 fencing rejects its stale work).

## 12. New vs reused

| Reused unchanged | New |
|---|---|
| `users`, `tenants`, GitHub OAuth web flow, JWT signing key/algorithm, `decode_token`, Redis (as the limiter store only; device revoke does not use the Redis revoke list, §7.2), the `main.py` slowapi `Limiter` object (not its unwired defaults), request transaction, `cryptography`/PyJWT | `devices`, `device_authorizations`, `/api/v1/devices/*`, `get_current_device`, `device_access` token type, refresh family/reuse detection, per-route rate limits on `/devices/*`, device-approve page, devkit `login/logout/whoami/device *`, per-OS key store |

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
| ID-5 | With a valid proof, presenting a token older than the previous one (rotate twice, then replay the first) revokes the device (`refresh_reuse`) | *supplementary* (credential analogue of stale completion fencing; Q-10 covers the row) |
| ID-6 | `device_code` without the matching private-key proof never yields tokens | *supplementary* (Q-11 covers duplicate message) |
| ID-7 | A device that has been offline past the access TTL refreshes on reconnect without user action. A device that has been offline past idle expiry gets `expired` and re-binds to the same `device_id` with `login` | partition/reconnect |
| ID-8 | Killing the CLI during `login` polling leaves no partial secret file; rerun succeeds or code expires | process kill |
| ID-9 | Registry restart: issued tokens stay valid (stateless JWT + DB device row); pending authorizations survive until `expires_at` | origin restart |
| ID-10 | No token/code/key bytes in logs, `--json`, telemetry, `env.sh`, `install-state.json`; secret files have the per-OS protection in §6; **no secret in the argv or environment of any spawned process** (sampled `ps -o args` / `/proc/*/cmdline` / `/proc/*/environ` during `login`, refresh and logout; Windows: process command lines via WMI) | other account isolation (secrets) |
| ID-11 | Per-OS key store behaviour verified on real macOS, Linux and Windows, including the stdin-only secret transport of §6 | per-OS verification |
| ID-12 | Per-route limits of §7.4 enforced: 11th `/devices/authorize` from one IP in a minute → 429; 6th wrong `user_code` in 10 min → 429; existing non-device endpoints show no new limit (global middleware still off) | other account isolation (enumeration) |
| ID-13 | Limiter store (Redis) unreachable: `/devices/authorize`, `/approve`, `/deny`, `/token` → 503 `rate_limit_unavailable`, never served unlimited | origin restart (dependency down) |
| ID-14 | Refresh response dropped, then the client retries with the same (previous) token, immediately and again after > 1 h: both retries yield a new pair, the device stays `active`, `refresh_retry` events recorded | late ACK (credential analogue) |
| ID-15 | Refresh for a known `device_id` with a garbage or stale token and **no valid proof** → `invalid_grant`; the device row is unchanged (status, hashes) | other account isolation (revoke by stranger) |
| ID-16 | After `device revoke` (and with Redis stopped, to show independence): the revoked device's `GET /devices`, `GET /devices/me`, ES-03 `list`, `get`, `events`, `resolve` and `export` → 401 `device_inactive`; its lease keeper's reconcile/sync gets no data; a request racing the revoke either completes before it or is refused | revoked device: sync refused |
| ID-17 | A `role=admin` user (`ADMIN_GITHUB_IDS`) gets 404 on every ES-0x resource of another user, read and write | other account isolation (admin) |
| ID-18 | `X-API-Key` (valid tenant key) on every ES-0x endpoint → 401; the same key still works on an existing endpoint | other account isolation (tenant key) |
| ID-19 | `POST /devices/approve` with a valid browser cookie but without `X-Aigentry-Intent: device-approve` → 403 and the authorization stays `pending`; a cross-origin form post cannot approve | other account isolation (approval CSRF) |
| ID-20 | Approval page shows name/os/version, request time and network prefix; the 21st active device → `device_limit` | other account isolation (device-code phishing) |
| ID-21 | `GET /devices?include=keys&all=true` returns keys, signed age recipients and `revoked_at` for active **and** revoked devices; a tampered `age_recipient` fails its signature check against `public_key`; `revoked_at` never changes after revoke; `created_at` is unchanged by an `expired` re-bind; idle expiry leaves `revoked_reason`/`revoked_at` null; logging in again after a revoke yields a new `device_id` | revoked device (ES-02/ES-04 reader inputs) |

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
| ID-1 | same `user_id`, distinct `device_id`, mutual listing | key-store protection per OS (ID-11); network faults | H2 (no) | implementation; **Mac offline** |
| ID-2 | login with no copied file; sign-up via first GitHub login | restore of work (ES-02 CK-03, Q-3) | H3 (no) | implementation; Mac offline; third host not measured as available |
| ID-3 | identical 404 body/status/code path across not-found and not-owned | timing side channels | F1 (yes) | implementation |
| ID-4 | write refused in-transaction after revoke; refresh `invalid_grant` | reads (ID-16) | F1 (yes) | implementation |
| ID-5 | reuse with valid proof → revoke | the user's stale-completion row (Q-10) | F1 (yes) | implementation |
| ID-6 | proof required for code exchange | duplicate message (Q-11) | F1 (yes) | implementation |
| ID-7 | refresh after access TTL; idle expiry → re-bind same row (short TTL settings) | a real Mac sleep/wake (Q-6) | F1 (yes, protocol only) | implementation |
| ID-8 | no partial secret on kill (Linux file store) | Keychain/DPAPI atomicity (ID-11) | F1 (Linux part only) | implementation |
| ID-9 | tokens and pending authorizations survive restart | deployed-instance restart behaviour | F1 (yes) | implementation |
| ID-10 | no secret in files/logs/argv/env on Linux | macOS/Windows argv/env (ID-11) | F1 (Linux part only) | implementation |
| ID-11 | Keychain via `security -i` stdin, DPAPI via PowerShell stdin, Linux file store; ID-8/ID-10 per OS | — | OS3 (no) | **BLOCKED**: Mac offline; no Windows runner (D-Q-6) |
| ID-12 | per-route limits enforced; no global limit added | distributed (multi-IP) abuse | F1 (yes) | implementation |
| ID-13 | fail-closed on limiter store loss | partial Redis degradation (latency) | F1 (yes) | implementation |
| ID-14 | lost refresh response never revokes | client crash between receipt and fsync on Keychain/DPAPI | F1 (yes) | implementation |
| ID-15 | no revoke without proof | — | F1 (yes) | implementation |
| ID-16 | revoke stops reads and writes, independent of Redis; race ordering | data outside the registry (ES-02 brain Git, ES-02 CK-11) | F1 (yes) | implementation |
| ID-17 | admin does not cross users | admin features (none in this release) | F1 (yes) | implementation |
| ID-18 | tenant API key refused on ES-0x, unchanged elsewhere | G2 on existing endpoints (registry issue) | F1 (yes) | implementation |
| ID-19 | intent header required; CSRF form refused | phishing of a willing user (§4 approval display) | F1 (yes, HTTP client; no GUI typing) | implementation |
| ID-20 | approval display fields; device cap | whether a user notices a phishing prompt | F1 (yes) | implementation |
| ID-21 | list contents and immutability for ES-02/ES-04 readers | reader-side verification itself (ES-02 CK-11) | F1 (yes) | implementation |
