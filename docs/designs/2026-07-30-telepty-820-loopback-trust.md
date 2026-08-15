# Design — #820: the PTY byte stream is unprotected on loopback

**Phase 1 deliverable (design only). No production code written. Repo touched READ-ONLY.**
Author: architect `s820-s820-viewer-path` · Target: `aigentry-telepty` @ `ca44782` (0.7.1 + #815)

---

## 0. What I verified, and how

Everything below is measured on a daemon **I** spawned (`PORT=0`, temp `HOME`), never the production
daemon on `:3848`. Probe: `<scratch>/probe-820.js`; patched copy under `<scratch>/patched/`
(rsync of the repo + symlinked `node_modules`, repo itself unmodified).

| Probe | current `main` | with the Stage-1 patch |
|---|---|---|
| owner bridge connects (`?owner=1` + token) | OPEN | OPEN |
| **attacker WS upgrade, no credential** | **ACCEPTED** | **REFUSED 401** |
| **attacker reads the owner's PTY bytes** | **LEAKED** (received the secret verbatim) | no-leak |
| **attacker `{type:'input'}` → owner `{type:'inject'}`** | **INJECTED** | no-inject |
| `GET /screen`, no credential | **HTTP 200, secret in body** | HTTP 401 |
| `POST /inject`, no credential | **HTTP 200** | HTTP 401 |
| `GET /api/sessions`, no credential | **HTTP 200** (cwd, command, ids) | HTTP 401 |
| credentialed viewer (`attach`) | OPEN, reads output | OPEN, reads output |
| `read-screen` with token | HTTP 200 | HTTP 200 |

The dispatch's three paths are confirmed. Two more sit on the same enabler and are **worse**:
`POST /api/sessions/:id/inject` writes to any PTY with no credential (so does
`POST /api/sessions/spawn` → `pty.spawn` with attacker-controlled `command`/`cwd`), and
`GET /api/sessions` discloses every session's id, command and cwd. This is already on record
internally: `aigentry-orchestrator/docs/reports/2026-07-02-ecosystem-deep-analysis.md` §A ranks it
CRITICAL. #820 is the byte-stream face of it, not a separate bug.

---

## 1. The trust model I recommend

### 1.1 The rule

> **Reachability is not authentication.** `isAllowedPeer()` answers *may this address open a
> connection* (network policy). The token answers *may this caller act* (authentication). Today the
> first is used as the second. Loopback stops being a credential; the explicitly-configured peer
> allowlist keeps its pass.

Concretely, both entrances get the identical predicate:

```js
// src/protocol/http-auth.js — createAuthMiddleware
if (!isLoopbackAddress(clientIp) && isAllowedPeer(clientIp)) return next();  // explicit opt-in peer
if (token === EXPECTED_TOKEN) return next();
if (bearerJwtValid) return next();
return 401;

// src/transport/websocket.js — handleUpgrade
const peerTrusted = !isLoopbackAddress(remoteAddr) && isAllowedPeer(remoteAddr);
if (!peerTrusted && token !== expectedToken && !wsJwtValid) → 401
```

Plus one exported helper `isLoopbackAddress(ip)` (`127.0.0.0/8`, `::1`, `::ffff:` normalised).
**Six lines of behaviour change across two files** — the diff I probed. Order stays:
origin guard → peer policy → credential → route, so #806's "a stolen credential cannot buy a
disallowed origin" property is untouched.

### 1.2 Why this layer

The token is already minted (`auth.js`), already persisted, already attached by **every** CLI call
(`cli.js:174-181` `fetchWithAuth`, and `?token=` on all four WS dial sites: `cli.js:865`, `1803`,
`2294`, `3773`). Nothing new is issued, distributed or rotated. The daemon has been checking a
credential this whole time; the check was simply unreachable for local callers. That the same change
would have pre-empted both #806 and #815's vector is the signal that it is the right layer.

### 1.3 What the boundary actually becomes — stated honestly

The token lives in `~/.telepty/config.json`, **mode `0600` inside a `0700` directory** (verified on
this host; written that way by `auth.js:11,29`). So the fix moves the boundary from:

- **before:** *anyone who can open a TCP socket to `127.0.0.1:3848`* → to
- **after:** *anyone who can read the invoking user's `$HOME/.telepty/config.json`* (≈ the uid
  boundary, plus root).

**It does not stop a same-uid process.** An agent's shell tool, a build script, an `npm postinstall`
— the dispatch's stated adversary — runs as the user and can `cat` that file. Calling this a fix for
"any local process" would be false, and I am not going to claim it.

What it *is*, precisely:

1. **It makes the network surface no weaker than the filesystem surface.** Today, reaching the port
   beats owning the file: a process that is *denied* `$HOME` still gets full PTY read/write. That
   inversion is the defect shape, and it is closed.
2. It is a **real** boundary against: different-uid local processes (other humans, service accounts,
   CI runners), anything sandboxed with a different `HOME`, container/VM neighbours sharing the host
   loopback, and any port-forward endpoint that is not this user.
3. It closes the **whole** local surface at once — spawn-RCE, inject, kill, DELETE, session
   enumeration — not only the three paths in the ticket.
4. Against same-uid it raises cost from *zero* (open a socket) to *a filesystem read that is
   auditable and blockable by OS sandboxing* (macOS TCC/sandbox profiles, Linux LSM). That is a
   lever the current design does not offer at all.

This is the same residual BOUNDARY.md already records for #815 ("not against a local process that
can read the owner's bearer"), one level out: **same-uid is not a boundary telepty can create.**
Only the OS can, and the fix is a precondition for ever using it. BOUNDARY.md must say so — see §3
Stage 1(e).

### 1.4 Read vs write — argued, not assumed

The dispatch asks whether the viewer's `{type:'input'}` → `inject` forwarding should be held to a
stricter standard than reading. **No — one gate, for a load-bearing reason:**
`POST /api/sessions/:id/inject` already writes to any PTY behind that same single middleware
(probe: HTTP 200, no credential), and `POST /api/sessions/spawn` is outright RCE behind it. A
stricter WS-write rule while the HTTP write door stays token-only buys **nothing** — an attacker
takes the cheaper door. Asymmetry here would be security theatre with a maintenance cost.

Two genuine asymmetries I did find, both **out of scope for the P0 and worth tracking**:

- **(a) WS-forwarded input is unaudited.** `websocket.js:292-294` forwards a viewer's input straight
  to the owner as `inject`. It bypasses everything the HTTP path applies: `classifyPeerLaneInject`
  (#533 peer-lane block), `auditAppend` (#47 P5), and provenance labelling. So the two write paths
  carry equal authority but unequal accountability — after Stage 1 that is an *audit* gap, not an
  *authz* gap. Fix belongs with whoever owns the audit log; it is not #820.
- **(b) `?token=` in the WS query string** lands in URLs, logs and `ps`. Pre-existing on all four
  dial sites; moving it to a header is a coordinated CLI+daemon change with no bearing on #820.
  Note it, do not fold it in.

### 1.5 Rejected, with reasons

| Option | Why rejected |
|---|---|
| **Require the session bearer (#815 credential) for viewer/screen** | Wrong shape, as the dispatch says: every legitimate reader is a *different* process reading *someone else's* session. `read-screen` from the orchestrator would need the target's bearer — i.e. hand every reader the victim's write credential. Strictly worse. |
| **Unix domain socket, `0700` parent** | Yields the *same* uid boundary as a `0600` file, with no secret to steal — but breaks every `curl 127.0.0.1:3848` consumer, the tailnet listener, and cross-host HTTP peers. Large blast radius for zero boundary gain. Keep as the long-term direction *if* the shared secret is ever dropped; not now. |
| **Peer-uid check on the TCP socket (`SO_PEERCRED`)** | Not portable: peer credentials on loopback **TCP** exist on neither macOS nor Linux (that is a UDS facility). Cannot be built as specified. |
| **Per-consumer capability tokens with scopes** (orchestrator gets read-only) | The correct least-privilege end state, but it does not raise the same-uid floor at all (any same-uid process reads whichever file holds the scoped token), and it is a multi-repo credential-distribution project. Defer until a multi-uid deployment actually exists. |
| **Trust a claimed name / `from` field** | Exactly the defect #815 removed. Never. |
| **Do nothing, document the boundary** | Leaves the network surface strictly weaker than the filesystem surface, and leaves LAN-exposed daemons (§3 Stage 2) fully open. Not defensible for a daemon whose workload is arbitrary-code-executing agents. |

**Failure mode: closed.** Every branch ends in `401`/`403`. A missing/omitted allowlist keeps
`createOriginGuard`'s default-deny. A malformed allowlist entry is already skipped rather than
widening (`buildAllowBlockList`). No path degrades to "trust the claimed name".

---

## 2. Blast-radius inventory (my own grep, both repos)

### 2.1 `aigentry-telepty` — breaks under Stage 1

| # | Caller | Evidence | Impact | Fix |
|---|---|---|---|---|
| T1 | **`test-support/daemon-harness.js`** | `:162` `request()` sends no token; `:181` readiness `fetch(/api/sessions)`; `:291` `connect()` WS with no token | **18 test files** go red at once | Read `authToken` from `${homeDir}/.telepty/config.json` after start; add the header in `request()` and `?token=` in `connect()`. Point the readiness probe at `/api/health` (unauthenticated, registered *before* the middleware at `daemon.js:311/316`). ~8 lines, one file. |
| T2 | **`test-support/bridge-pipe-harness.js`** | `:74`, `:122`, `:125`, `:127` raw `fetch`, no token | **3 test files** | Same: read the token from its `makeHome()` dir, add the header. |
| T3 | `test/loopback-drive-by-guard.test.js` | `:70-81` asserts an origin-less token-less loopback POST → **200**; `:84-94` same for reads; `:113-123`; `:173-180` origin-less WS upgrade must open | 4 assertions encode the defect as intended behaviour | Add the token to each; keep the *origin* assertions untouched (they are #806's contract). |
| T4 | Tests with their own `fetch`/`WebSocket` | `cross-host-inject`, `daemon-lifecycle-55`, `dupid-flap-kill-stick-56`, `kickstart-race-738`, `session-token-issuance-815`, `ws-autoregister-identity-754`, `daemon.test.js` (partly tokened) | red where token-less | Mechanical; 8 of the 12 raw-fetch files already send `x-telepty-token`. |
| T5 | `.claude/commands/telepty.md`, `telepty-manual-test.md`, `.gemini/skills/telepty/SKILL.md` | already `-H "x-telepty-token: $TOKEN"` | **none** | verify only |

**Does not break:** `cli.js` (all HTTP via `fetchWithAuth`; all four WS dials carry `?token=`) —
so `attach`, `read-screen`, `inject`, `list`, `kill` are unaffected. `daemon-control.js:236-255`
probes `/api/health`, which is registered before the middleware. `cross-machine.js` **SSH** transport
is remote *command execution* over ControlMaster (`ssh <host> telepty …`, `:166-180`), so the remote
CLI presents the remote host's own token to the remote daemon — untouched. `mcp-server/` reaches the
daemon through the CLI. `src/supervisor.js`, `src/cli/session-view.js`, `interactive-terminal.js`:
no direct daemon I/O.

**Deliberately unaffected by Stage 1 (see Stage 2):** cross-host `attach` and HTTP peers. A
cross-host attach sends the *local* token to a *remote* daemon (`cli.js:865/2294`), which today only
works because `isAllowedPeer` returns `true` for every IP when the allowlist is empty
(`http-auth.js:92-93`). Those callers arrive **non-loopback**, so Stage 1 leaves them exactly as they
are. `connect-http --token` already exists for the peer case (`cross-machine.js:392,431,466`).

**A comment that is not true today:** `http-auth.js:144` "(SSH tunnels arrive as localhost)". No
`ssh -L` / `LocalForward` exists anywhere in the repo or docs — I grepped. The shipped SSH transport
does not tunnel HTTP. So the loopback bypass is not load-bearing for any shipped cross-host path; a
*hand-rolled* `ssh -L` forward would break, and its user would need to supply the remote token
(which is the point of an auth boundary). Fix the comment in the same commit.

### 2.2 `aigentry-orchestrator` — breaks under Stage 1

| # | Caller | Evidence | Impact | Fix |
|---|---|---|---|---|
| O1 | `bin/session-cleanup.sh:222-224` | `curl -X DELETE http://127.0.0.1:${TELEPTY_PORT:-3848}/api/sessions/$sid`, no token | 401 → registry entries leak; logs `"$http (unexpected; manual verify)"` — at least loud | Add `-H "x-telepty-token: $(jq -r .authToken ~/.telepty/config.json)"`, or route via `telepty` CLI. |
| O2 | `bin/dispatch-tracker.sh:493-500` | `curl .../api/inject-observations/${inject_id}`, no token | **401 is silently mis-read as `observation_endpoint_absent`** (`:505-507` treats every non-200 as absence) → the tracker degrades to "no evidence" with no error. Worst failure shape in the inventory: quiet. | Same header, **and** distinguish 401 from 404 so a credential fault can never masquerade as a missing endpoint. |
| O3 | `docs/specs/2026-06-06-bus-event-consumer.md:100,138,202` | specifies future consumers as bare `curl 127.0.0.1:${TELEPTY_PORT:-3848}` | not code yet — would ship broken | Amend the spec to require the header. |

`/api/inject-observations/:id` **does not exist in 0.7.1 or `main`** — it is the sibling Stage-A
worker's new endpoint. It is therefore a *new* consumer of loopback trust being written right now
(§5).

### 2.3 `aigentry-aterm` — the GUI, and it breaks hard (resolved 2026-07-30; orchestrator grep + my read)

`cmux`: **no consumers.** `aigentry-aterm`: **three files, and not one of them sends a token** — I
grepped for `token` across all three and the only hits are `ATERM_TELEPTY_PORT`. Different language,
different release cadence, so this cannot be fixed in the same commit. **Do not edit that repo** (per
the orchestrator); this is the specification of what it must send.

| File | Call | Post-fix |
|---|---|---|
| `aterm-core/src/telepty_bridge.rs:35,299,326` | `GET /api/sessions` | **401** — session list dies |
| `aterm-core/src/telepty_bridge.rs:158,274` | `POST /api/sessions/register` | **401** — aterm-spawned sessions never register |
| `aterm-core/src/telepty_bridge.rs:350` | `GET/DELETE /api/sessions/:id` | **401** |
| `macos/Sources/AppDelegate.swift:362,381,1364` | `GET /api/sessions[/:name]` | **401** |
| `macos/Sources/TeleptyBusClient.swift:130` | **`ws://127.0.0.1:3848/api/bus`** | **401 at upgrade** — the GUI event stream goes dark. `handleUpgrade` gates `/api/bus` on the same predicate as the viewer socket, so this is hit by Stage 1, not only Stage 2. |
| `aterm-core/src/telepty_bridge.rs:121-128` | `GET /api/health` (version detect) | **unaffected** — stays unauthenticated |

**What aterm must do:** read `authToken` from `~/.telepty/config.json` (JSON parse, no new dependency
in either language) and send `x-telepty-token` on every HTTP call; for the bus socket, either the same
header on the `URLRequest` or `?token=` on the URL — `handleUpgrade` accepts both. It **cannot** use
the `TELEPTY_AUTH_TOKEN` env override (§3 Stage 1.6): a GUI launched from Finder inherits no shell
environment. That is the whole integration surface — `/api/health` needs nothing.

**Sequencing:** aterm's update must ship **before or with** the telepty 0.8.0 upgrade on any machine
running the GUI. It is safe to land first (a token an old daemon ignores).

---

## 3. Staged plan

### Stage 1 — loopback stops being a credential (the #820 fix) · **must be atomic**

One commit, and it *has* to be one commit, because the consumer fixes and the daemon change cannot
be split without a red window:

1. `src/protocol/http-auth.js` — add `isLoopbackAddress()`, export it, invert the middleware branch.
2. `src/transport/websocket.js` — same predicate in `handleUpgrade` (upgrade covers viewer **and**
   `/api/bus`).
3. `test-support/daemon-harness.js` + `test-support/bridge-pipe-harness.js` — token plumbing (T1, T2).
4. Test-file updates (T3, T4) + the new regression tests in §4.
5. `BOUNDARY.md` — new section: what the loopback gate proves, and the explicit **same-uid residual**
   (§1.3). Fix the false `ssh -L` comment at `http-auth.js:144`.

**Cross-repo coupling:** O1 and O2 are in a different repo and *cannot* be atomic with the daemon
change. Land them **first** — they are harmless against an unpatched daemon (a token that is merely
ignored). Order: **orchestrator (O1, O2) → telepty Stage 1.** Same for cmux/aterm if §2.3 finds
anything.

### Stage 2 — the peer allowlist stops being a credential · separate change, separate release note

`isAllowedPeer` returns `true` for *every* address when `TELEPTY_PEER_ALLOWLIST` is empty
(`http-auth.js:92-93`), and the middleware uses it *before* auth. So a daemon started with
`TELEPTY_BIND=0.0.0.0` is fully open to the entire LAN with **no credential** — the comment
"allow all *authenticated*" describes an intent the call site does not implement. Only #50's
loopback-by-default bind hides it.

**DECISION 2026-07-30 (orchestrator): pulled INTO the 0.8.0 release as #823 P0. Not deferred, not
opt-in.** Verified live on this host: `curl http://100.72.155.21:3848/api/sessions` with no token →
**HTTP 200**. The tailnet auto-bind opens a second listener and the empty allowlist makes every
address free, so any tailnet device can enumerate, inject, spawn and kill uncredentialed. Rationale
for same-release: the 0.8.0 window already includes a daemon stop/start, and shipping a release that
hardens loopback while leaving the tailnet open would be indefensible to anyone reading the diff.

**Design:**

1. **`isAllowedPeer` becomes a reachability filter, never a credential**, applied *before* the
   credential check and now able only to **narrow**:
   `if (!isAllowedPeer(clientIp)) return 403;` then the credential check runs for **every** address,
   loopback included. With Stage 2 in, §1.1's `!isLoopbackAddress(...) && isAllowedPeer(...)` bypass
   is deleted rather than added to — Stage 1's shape is a strict subset, which is why the two compose
   cleanly in one release.
2. **Empty allowlist keeps meaning "no IP restriction"**, not deny-all. Turning empty into deny-all
   would break tailnet reachability entirely — a second, needless break. Reachability policy and
   authentication stay separate concepts; that separation *is* the fix.
3. **Fix the comment at `http-auth.js:92-93`** ("No allowlist = allow all authenticated") — it
   describes an intent the call site never implemented, and per the orchestrator that mismatch is how
   this survived review. It becomes: *empty allowlist = no IP restriction; authentication is enforced
   separately and unconditionally.*
4. **Cross-host `attach` keeps working for a caller that HAS the token.** Today `cli.js:865,2294`
   send `getAuthToken()` — the **local** token — to a **remote** daemon, which only works because the
   remote trusts any IP. Each node has its own random token, so the local one is simply wrong for the
   peer. Resolution order for a cross-host target: **peer token from `peers.json`** (`entry.token`,
   already written by `connect-http --token`, `cross-machine.js:431`) → else the local token → else
   401. Same resolution in `fetchWithAuth` for cross-host HTTP, so `list`/`inject`/`read-screen`
   against a peer follow the same rule as `attach`. Contained to `cli.js`; no protocol change.
5. **Migration for cross-host users:** one command per peer —
   `telepty connect-http <host> --token <that host's authToken>`. This is the only user-visible
   migration in the release, and it is exactly the "you now need a credential" property being bought.
6. **`TELEPTY_AUTH_TOKEN` env override in `auth.js:getConfig()`** — one line
   (`process.env.TELEPTY_AUTH_TOKEN || config.authToken`), read by daemon and CLI alike since both go
   through `getConfig()`. Gives operators a deliberate shared-fleet token instead of forcing per-peer
   plumbing, and **shrinks the test blast radius**: the harnesses (T1, T2) can set a known token in
   the spawn env instead of reading `config.json` back off disk. Note the scratchpad e2e scripts
   already *set* `TELEPTY_AUTH_TOKEN` as if this existed; today it does nothing.

**Regression tests, additional to §4** (all RED on `main` for the reason the orchestrator measured):
(14) `GET /api/sessions` from a **non-loopback** address with no token and an empty allowlist → 401
*(main: 200)*; (15) same address **with** the token → 200; (16) an address outside a **non-empty**
allowlist → **403 even with a valid token** (reachability narrows, never widens); (17) cross-host
`attach` resolves the peer token from `peers.json` and upgrades, while a peer with no stored token
gets a clean 401 rather than a hang.

### Stage 3 — follow-ups, tracked not scheduled

§1.4(a) audit the WS input→inject path; §1.4(b) move `?token=` to a header; #817 cross-machine sender
identity (untouched here, as instructed).

---

## 4. Regression tests — RED against current `main`, with the reason

Home: a new `test/loopback-not-a-credential-820.test.js`, on `daemon-harness` (isolated `HOME`,
`PORT=0`). Every case below was executed by hand in the probe, so the expected values are measured,
not predicted.

**Refusals (1-5): RED on `main` for one shared reason** — `http-auth.js:143-145` /
`websocket.js:402` return `next()`/upgrade before the token is consulted, so each currently gets
`200`/`OPEN` where the test demands `401`.

1. **Uncredentialed viewer is refused read.** Owner bridge (token, `?owner=1`) connects and sends
   `{type:'output', data:'<canary>'}`. A second WS to the same session **with no token** must fail
   the upgrade with **401**, and must not observe `<canary>`. *(main: upgrade ACCEPTED, canary
   LEAKED.)* Assert both — refusing the upgrade is the mechanism, non-observation is the property.
2. **Uncredentialed `{type:'input'}` is refused write.** Same, plus: even if a socket is somehow held,
   the owner must receive **no** `{type:'inject'}` frame. *(main: INJECTED.)*
3. **`GET /api/sessions/:id/screen` without a token → 401**, body carries no PTY bytes.
   *(main: 200 + secret in body.)*
4. **`POST /api/sessions/:id/inject` without a token → 401**, and the delivery path never runs
   (assert via the injects spy, as `loopback-drive-by-guard.test.js:67` does). *(main: 200.)*
   Not in the ticket; same enabler, cheaper for an attacker than the WS path.
5. **`GET /api/sessions` without a token → 401** — session ids, `command` and `cwd` are disclosure.
   *(main: 200.)*
6. **`POST /api/sessions/spawn` without a token → 401.** *(main: 200 → `pty.spawn` with caller-chosen
   `command`/`cwd`.)* The highest-severity instance of the same enabler; if a later refactor
   re-opens loopback, this is the assertion that screams.

**Legitimate callers (7-11): GREEN on `main` and GREEN after — these are the anti-regression half.**
They must be written even though they do not go red; their job is to fail if the fix over-tightens.

7. **`attach`**: WS with `?token=<authToken>` upgrades and receives the owner's `output` frames.
   *(verified GREEN on both sides of the patch.)*
8. **`read-screen`**: `GET /screen` with `x-telepty-token` → 200 with content. *(verified.)*
9. **Orchestrator polling**: `GET /api/sessions`, `GET /api/pendingReports/:id` with the header → 200.
10. **Owner bridge**: `?owner=1&token=…` claims ownership and #815's close-4003 gate still fires for
    a wrong `x-telepty-session-token` — i.e. Stage 1 did not disturb #815.
11. **Cross-host / allowlisted peer**: with `TELEPTY_PEER_ALLOWLIST` naming a non-loopback CIDR, a
    request from an address in it still passes **without** a token (Stage 1 explicitly preserves
    this). Unit-level on `createAuthMiddleware` with a synthetic `req.ip`, in the style of
    `test/http-auth.test.js:58-122` — no real second host needed.
12. **`/api/health` stays unauthenticated** — `daemon-control.js:236` port-ownership probe and
    `cross-machine.js:398` `connect-http` both depend on it. *(GREEN both sides; a test because it is
    an easy accident.)*

**Browser guard unbroken (13):** re-run `loopback-drive-by-guard.test.js`'s origin assertions with a
valid token attached — a disallowed `Origin` must still be **403**, never 200. Ordering property from
#806: origin is checked *before* credentials.

---

## 5. Version impact

**Breaking for anyone who talks to the daemon directly without a token — and that is the entire
point.** Not breaking for anyone using the `telepty` CLI, which has always sent the token.

- **Semver:** MINOR is defensible for `0.8.0` under a security-fix banner, since the *supported*
  interface (the CLI) is unchanged and the removed behaviour is the vulnerability. Prefer to call it
  **BREAKING in the CHANGELOG** anyway — the repo already precedents this for the #50 bind change
  ("BREAKING: cross-machine peers … need the opt-in").
- **Who must act:** anyone with a hand-rolled `curl 127.0.0.1:3848/api/...`. Migration is one header:
  `-H "x-telepty-token: $(jq -r .authToken ~/.telepty/config.json)"`. Inside this ecosystem that is
  exactly O1, O2, O3 plus whatever §2.3 turns up.
- **`/api/health` stays open**, so liveness probes and `connect-http` discovery are unaffected.
- **Daemon restart:** none required beyond the normal upgrade. No credential is minted, rotated or
  migrated; `~/.telepty/config.json` is untouched. A **mixed fleet is safe**: an old client against a
  new daemon fails closed with 401; a new client against an old daemon works (the extra header is
  ignored).
- **Disclosure:** per the dispatch, nothing public before the fix ships. The CHANGELOG line should
  name the *behaviour* ("loopback callers must now present the daemon token") without the exploit
  recipe, and the ecosystem report §A stays internal until the owner decides.

---

## 6. Sequencing flags for the 0.8.0 Stage-A work (orchestrator: read this before scheduling)

The completion-heuristics removal reaches `daemon.js`, `websocket.js`, `cli.js`, `session-state.js`,
`src/report-enforcement.js`. My change is designed to apply **on top** of it. Overlaps:

1. **`src/transport/websocket.js` — same file, different regions.** Mine: `handleUpgrade`
   (`:390-419`) + the import line (`:5`). Stage A's is almost certainly the message handler
   (`output`/`ready`/`fireAutoReport`, `:242-289`). Low textual conflict risk, but **do not run them
   in parallel** — sequence Stage A first, then rebase this.
2. **`daemon.js` — I touch it not at all.** Stage 1 lives entirely in `http-auth.js` +
   `websocket.js`. No contention.
3. **`bin/dispatch-tracker.sh` (`/api/inject-observations/:id`) is a NEW token-less loopback
   consumer** being written right now, and its non-200 handling (`:501-507`) folds a 401 into
   `observation_endpoint_absent`. If Stage A lands as drafted and Stage 1 lands after it, the
   tracker goes **silently** evidence-blind. Cheapest fix is in Stage A's own patch: send the header
   and treat 401 distinctly. **This is the one place the two changes are genuinely coupled.**
4. **`test-support/daemon-harness.js`** is touched by Stage 1 (token plumbing) and is likely touched
   by Stage A too (new endpoint helpers). Same-file, high-traffic — sequence, do not parallelise.
5. `cli.js`: Stage A edits it; Stage 1 does not (it already sends the token everywhere).

---

## 8. Does anything in Stage 3 become UNSAFE once Stage 1+2 ship? (asked 2026-07-30)

Two of the three change class. One does not.

### 8.1 YES — the WS `input`→`inject` path is unaudited AND unguarded. Fold it into 0.8.0.

`websocket.js:292-294` forwards a viewer's `{type:'input'}` straight to the owner as `{type:'inject'}`.
It bypasses everything the HTTP write path applies: `auditAppend` (#47 P5), `classifyPeerLaneInject`
(#533's *hard block* on out-of-policy peer→peer injects), and provenance labelling.

Why it stops being merely untidy the moment Stage 1+2 ship: **today the audit log is obviously
incomplete, because anything on the box can write without a credential — nobody can read it as a
record.** After the fix every writer is authenticated, so an operator will reasonably read the inject
log as *the* record of who typed into a session, and the #533 block as *the* enforcement point. Both
would then be names claiming more than their measurement — the exact defect class 0.8.0 exists to
remove. The fix creates the false confidence; that is what makes it unsafe rather than untidy.

Concretely: an agent holding the token (i.e. any of them, post-fix) bypasses the entire #533
peer-lane guardrail by opening a viewer socket instead of calling `POST /inject`. The guardrail reads
as enforced; it is one WS frame away from being optional.

Cheapest honest fix, in order of preference:
1. Route WS-forwarded input through the same `auditAppend` + `classifyPeerLaneInject` as the HTTP
   path (source `ws-viewer`), so authority and accountability match. Small, and it is where the code
   wants to end up.
2. If (1) cannot make the window: at minimum `auditAppend` the frame with a distinct source, so the
   log is *complete* even while the policy check is not. Then the log can be trusted as a record.
3. If neither ships: **the CHANGELOG must not describe the inject audit log as complete, and #533
   must not be described as an enforced block.** Silence here is the failure mode.

### 8.2 YES, small — `/api/health` becomes the only unauthenticated endpoint on a network-facing listener

After Stage 2 the tailnet listener still answers `/api/health` → `{status, version}` to any device
with no credential: unauthenticated fleet fingerprinting for a known-vuln version, exactly during the
window where 0.8.0 is the patch everyone needs.

**Do not "fix" it by dropping `version`** — I checked, and `aterm-core/src/telepty_bridge.rs:121-128`
detects the daemon version from precisely that field, so removing it breaks the GUI a second way, and
`daemon-control.js:253` + `cross-machine.js:398` need the endpoint itself open. Recommendation: keep
both, and **state the residual** ("`/api/health` is deliberately unauthenticated and discloses the
version") next to the boundary paragraph in BOUNDARY.md. An accepted, written-down exposure beats a
silent one; if it ever needs closing, the answer is binding health to loopback only, not deleting the
field aterm reads.

### 8.3 NO — `?token=` in the WS query string stays a Stage 3 tidy-up

It becomes *more valuable to steal* (the token is now load-bearing) but not more *exposed*: tailnet
traffic is WireGuard-encrypted node-to-node, and `connect-http` over a plain LAN is no worse than
today's state of needing no credential at all. Moving it to a header is a coordinated CLI+daemon
change with real breakage risk and no security delta inside this release. Keep it in Stage 3.

*(One I chased and discarded rather than report: browser paths that carry no `Origin` header —
`<img>`, `<script>`, top-level navigation — do slip past #806's guard, but every state-changing
endpoint is POST/DELETE (browsers **do** send `Origin` on those) and the GET-only endpoints are
read-only with responses a page cannot read. Not exploitable, and Stage 1 requires a token there
anyway. Noted so nobody re-derives it.)*

### 8.4 Verbatim, for BOUNDARY.md (per the orchestrator)

> Same-uid is not a boundary telepty can create; only the OS can, and this fix is the precondition
> for ever using it.

---

## 7. Open decisions for the orchestrator

1. **Stage 2 timing** — do we ship the LAN-open fix (`TELEPTY_BIND=0.0.0.0` + empty allowlist = no
   credential) in 0.8.0 behind an opt-in env, or defer wholesale? It breaks cross-host `attach`,
   which needs a per-peer token design first.
2. **§2.3 scope** — I did not grep `cmux` / `aigentry-aterm`. Assign it, or accept the risk of a GUI
   consumer breaking on upgrade.
3. **Disclosure timing and CHANGELOG wording** — owner's call, per the dispatch.
