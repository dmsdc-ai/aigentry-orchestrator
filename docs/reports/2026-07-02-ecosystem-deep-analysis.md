# aigentry Ecosystem — Deep Analysis (Structural · Security · Usability · Business)

- **Date**: 2026-07-02
- **Author**: analyst session (`ag-ecosystem-analysis`), Claude Fable 5 — **READ-ONLY** pass (this report is the only artifact written)
- **Method**: 5 parallel evidence-gathering passes over the `aigentry-*` repos (code + docs + `git log`), each finding cited to `file:line` / repo. The central technical claim (WIRING-GAP) was additionally verified by hand.
- **Stance** (Constitution §13): critical + constructive + objective. Every risk carries a recommendation; strengths are noted; my own claims are marked FACT vs JUDGMENT and hedged where uncertain.
- Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Executive summary

The aigentry ecosystem is **ship-quality plumbing wrapped around a single-operator research lab**. The transport core (`telepty`) and the devkit installer are genuinely well-engineered and unusually honest about their own limits. Above that line, the system is a macOS-only, cmux-only, Korean-documented orchestration lab that one person runs from memory — and it carries a **critical, currently-live security exposure** that the ecosystem's own threat model (every spawned agent is a permission-bypassed local process) turns into remote-code-execution.

The single most important finding is **not** the flagged WIRING-GAP. It is that the **telepty daemon grants full local control with no authentication** (`src/protocol/http-auth.js:61` trusts all loopback before any token check), while **every session is spawned with permissions bypassed by default**. Together these mean: inject one line of text into any session → arbitrary code execution as the user. The WIRING-GAP (the spawn gate being unwired) is real and confirmed, but it is a *second* missing containment layer on top of an *already-open* front door.

The good news is that the highest-severity issues are small, well-scoped diffs, and the project has already built (and tested) most of the machinery needed to close them — it simply never wired it in.

**Scope surveyed**: `aigentry` (hub), `aigentry-orchestrator`, `aigentry-telepty`, `aigentry-deliberation`, `aigentry-aterm`, `aigentry-brain`, `aigentry-devkit`, `aigentry-logger`, `aigentry-ssot`, `aigentry-registry`, `aigentry-dustcraw`, `aigentry-amplify`, `aigentry-hooks`, `aigentry-bridge`, `aigentry-context`, `aigentry-forum`, `aigentry-starter`, and the session-role folders (`aigentry-{analyst,architect,builder,design,tester,sandbox}`). 22 directories → 17 git repos → 10 published npm packages → **~7 actively maintained**.

---

## 1. STRUCTURAL (architecture)

### 1.1 Findings (evidence-cited)

**The orchestrator is two systems joined by three thin seams.** `bin/` (5,578 LOC shell + 740 LOC mjs + 951 LOC python) is *live actuation* — spawn, inject, cleanup, reconcile. `src/` (3,426 LOC TS) is a *typed validation/persistence library*. Production shell reaches TS at exactly three `dist/` import seams: `boot-prepare.mjs:481` (resolve-instructions + boot-adapter + types), `inject-handler.sh:29` (inject-parser), `emit-telemetry.mjs:42` (logger-emit). (FACT — measured with `wc -l`, import-traced.)

**~52% of `src/` TS is production-dormant** (~1,770 LOC): the entire `src/gate/` (495), `validate-spawn.ts` (403), `permission-manager.ts` (174), `role-capabilities.ts` (52), `persist-context.ts` (291), and `persistence/{atomic-write,index-lock,crash-recovery}` (230). Every caller of these lives in `tests/` or inside `src/gate/` itself. (FACT — grep-verified.)

**The orchestration model is sound.** End-to-end spawn: `dispatch.sh --spawn-and-dispatch` → `boot-prepare.mjs` (role sandbox `~/.aigentry/role-sandbox/<role>-<sid>/` with no CLAUDE.md to avoid cwd contamination; layered role prompt via `resolveInstructions()`; per-CLI boot adapter) → double-wrapped `launcher.sh` → `open-session.sh` → `wh_open` adapter (cmux path wraps in `telepty allow … --auto-restart` behind a 3-part readiness gate) → probe-wait → sha256-dedup → `telepty inject --ref --submit`. The adapter registry (`bin/lib/workspace-host.sh:808`) is a single TSV table (cmux/aterm/tmux/wezterm/iterm/warp/headless) with a 9-verb contract and §17-compliant graceful degradation — genuinely good shell architecture post-#608. (FACT.)

**DRY drift with live behavioral divergence**: CLI default flags are defined in three places — `dispatch.sh:61` (`claude-opus-4-8[1m]`), `open-session.sh:136` (`claude-opus-4-8[1m]`), `boot-prepare.mjs:607` (`claude-opus-4-8` — **missing the `[1m]` suffix**). Role-sandboxed spawns silently get a different model context tier than legacy spawns. (FACT.)

**Cross-repo role duplication (Constitution §3/§4 violations)**: `aigentry-brain/src/context/{ContextPacker,ContextRestoreService,ContextBudgetPolicy}.ts` duplicates the dedicated `aigentry-context` engine (which is dead since 2026-04-07, 2 commits); `aigentry-deliberation/lib/telepty.js` reimplements a telepty wire-protocol client instead of consuming one; `logger-emit.js` was **copy-pasted** into deliberation (commit 2026-06-22 "missing from FILES_TO_COPY broke MCP startup"); `auto-deliberate.sh` exists forked in both brain (263 LOC, deprecated) and deliberation (445 LOC). The ecosystem's own structure audit (`docs/reports/2026-06-10-ecosystem-structure-audit-synthesis.md`) already judged "5 of 6 components fat-implement others' core logic." (FACT.)

**Bin-name collision**: three packages claim the global bin `aigentry` — the hub, `aigentry-devkit`, and `aigentry-brain`. Which one a user gets depends on `npm i -g` order. `aigentry-registry`'s `pyproject.toml` is *also* named `aigentry`. (FACT.)

**Governance over-engineering**: `docs/rules.md` is 519 lines, 28 HARD-RULE markers, numbering 1→33 with gaps (23, 31 missing). `Rule 4-A` alone is ~150 lines of frozen-experiment ADR prose — C1–C6 constraints, B1–B6 branch lattice, TOST p-values (`p_max=8.09e-09`), Welch/Cohen stats — that an LLM operator is told to consult *before choosing how to delegate*. This asks for a determinism a sampled LLM cannot provide; it should be `bin/select-mode.sh` (~30 lines). (FACT + JUDGMENT.)

### 1.2 Risks (severity-ranked)

| Sev | Risk | Evidence |
|---|---|---|
| **HIGH** | 52% of the TS "governance kernel" is dead relative to production — the codebase carries a fully-built, tested enforcement layer that nothing calls (see §2-D) | grep: gate callers only in `tests/` |
| **MED** | Model-default drift → role vs legacy spawns run different context tiers, silently | `boot-prepare.mjs:607` missing `[1m]` |
| **MED** | Duplicated core logic across brain/context/deliberation → divergent bugfixes, §3/§4 breach | brain `src/context/`, deliberation `lib/telepty.js` |
| **MED** | `aigentry` bin/name collision breaks `npm i -g` of any two of three packages | hub/devkit/brain `package.json` bins |
| **MED** | Governance weight (28 HARD rules, 150-line Rule 4-A, 28 ADRs) is operable only by the author | `docs/rules.md`, `AGENTS.md` |
| **LOW** | SPOFs: telepty daemon, cmux daemon (unreliable exit codes, silent ref fallback — `open-session.sh:155`), `state/dispatch/active.json`, the bash+python3+jq+node≥20 interpreter chain | in-code comments |
| **LOW** | Dead code / cruft: `bin/cmux-inject.sh` (ADR G7), `AGENTS.md.pre-slim.*.bak`, `agy/grok/grokd.{out,err}`, `state/` at 17 MB tracked in-tree | repo root |

### 1.3 Recommendations

1. **Wire the gate or delete it** (see §2 rec 2) — resolve the largest single block of dead code by making it load-bearing, not by leaving a tested kernel inert.
2. **Single-source the CLI default flags** — one shell function / one TS constant consumed by all three sites; fixes the `[1m]` drift.
3. **Collapse duplication to owners** (§3/§4): archive `aigentry-context` (brain absorbed it) or fold brain's context code back into it; make deliberation consume a shared telepty client instead of `lib/telepty.js`; move `logger-emit` to a real dependency, not a copy.
4. **Resolve the `aigentry` bin collision** — one package owns the bin; the others expose `aigentry-devkit` / `aigentry-brain` only.
5. **Mechanize governance**: turn Rule 4-A into a script; prune `rules.md` per its own Rule 3 (200–300 line target); mark dormant rules dormant.

### 1.4 Strengths (objectivity)

- The adapter registry (`workspace-host.sh` post-#608) is well-factored: one registry, separated context-probe vs availability-probe, function-dispatch, declared capability fields instead of verb creep.
- Error handling is a consistent "loud degradation" idiom — telemetry never blocks dispatch (`|| true`, §9 독립), boot-prepare failure falls back with a WARNING (never silent), `wh_open` fails loudly with a labelled line.
- Churn concentrates in the operational shell layer + AGENTS.md — the system evolves by incident-driven hardening (readiness barrier = BUG-A, singleton guard = #618, seen-twice debounce = F3). Each guard traces to a numbered real incident. That is disciplined, not speculative, complexity.

---

## 2. SECURITY

Threat-model note: the daemon binds **loopback-only by default** (`daemon.js:290`), so the adversary is a **local process** — which in this ecosystem includes *every spawned AI CLI* (all permission-bypassed) and any browser tab. A prompt-injected agent **is** a local process. That is the whole point of the system, so "local only" is not much of a mitigation here.

### 2.1 Findings (severity-ranked)

**[CRITICAL] A — telepty daemon: unauthenticated localhost = full control.** The global auth middleware trusts any loopback client and returns before the token check: `src/protocol/http-auth.js:61` `if (cleanIp === '127.0.0.1' || ip === '::1') return true;` and `:69` `if (isAllowedPeer(clientIp)) return next();`. The `authToken` (correctly `0o600`, `auth.js:29`) is **irrelevant to local callers**. Reachable with no credential: `POST /api/sessions/spawn` (`daemon.js:2104` `pty.spawn(shell, shellArgs, {cwd, env})` with attacker-controlled `command`/`args`/`cwd`), `POST /api/sessions/:id/inject` (`daemon.js:3132`), `/kill` (`:3499`), `DELETE` (`:3529`), `/broadcast/inject` (`:2580`). *Exploit:* any local process → `POST 127.0.0.1:3848/api/sessions/spawn {command:"bash",args:["-c","…"]}` → RCE as the user, no token. (FACT.)

**[CRITICAL] B — permissions bypassed by default everywhere (amplifier for A).** `open-session.sh:136-138`: claude `--permission-mode bypassPermissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--approval-mode yolo`. Same in `dispatch.sh:61`, `boot-prepare.mjs:611`, `orchestrator-boot.sh:95`, `session-start.sh:126`, and telepty's own `DEFAULT_CLI` (`tui.js:15`, `cli.js:3126`). Every session in the mesh is a shell-capable agent with approvals disabled → injecting one line into any session = RCE. No defense-in-depth: bypass is the default, not opt-in. (FACT.)

**[HIGH] C — wildcard CORS + fixed port → browser drive-by.** `daemon.js:155` `app.use(cors())` → `Access-Control-Allow-Origin: *`; port default fixed `3848`. A page the victim visits can `fetch('http://127.0.0.1:3848/api/sessions/spawn', …)`; the request originates from loopback → trusted (A). *Uncertainty (JUDGMENT):* Chrome Private-Network-Access preflight may block public→loopback POSTs — a partial, browser-dependent mitigation, not a fix. (FACT + hedge.)

**[HIGH] D — the spawn/permission gate is unwired (the flagged WIRING-GAP). CONFIRMED, current.** Independently verified three ways: (1) exhaustive grep for `enforceSpawn|checkSpawnPermissions|gated{Telepty,Cmux,CliDirect}Spawn|validateAgentPrompt|gateMcpToolCall` outside `dist/`/`tests/` returns only definitions + intra-`src/gate/` imports + docs; (2) the production spawn path `dispatch.sh → boot-prepare.mjs → open-session.sh` never imports gate/validate/permission code (`boot-prepare.mjs:481` imports exactly resolve-instructions + boot-adapter + types); (3) `AGENTS.md` documents it verbatim ("WIRING-GAP … zero production callers … 현재 어떤 spawn도 강제 차단되지 않음", commit `e41c64a`). The code itself is *correct* — `DEFAULT_VALIDATION_MODE = "hard-fail"` (`validate-spawn.ts:257`), least-privileged degrade to `logger`, capability-subset logic rejecting expansion — it is simply never invoked. The hard-fail default flip landed in a library nobody calls. (FACT.)

**[HIGH] E — inbox-watcher autonomous bypass executor.** `aigentry-deliberation/inbox-watcher.mjs:248` `spawn('claude', ['--dangerously-skip-permissions','-p', prompt], {cwd: projectDir})` where `prompt`/`projectDir` come from files dropped into a watched directory. *Exploit:* anyone who can write a task file into the inbox gets RCE. (FACT.) *Contrast (mitigation):* the deliberation **MCP** auto-turn spawns are safe — `lib/transport.js:678` uses `claude -p --output-format text` (no bypass) and codex `approval_policy="never"` **with** `sandbox_mode="read-only"`, all as argv arrays (no shell).

**[MEDIUM] F — peer-comms guardrail is advisory-grade; `--from` unauthenticated.** `bin/ask.sh` is just a wrapper over `telepty inject`; nothing forces its use. The daemon's `classifyPeerLaneInject` (`daemon.js:688`) *does* hard-block (contradicting the orchestrator AGENTS.md's "future work" claim) but is bypassable three ways: omit `from` → allow (`:698`); set `from` to an orchestrator sid → always allowed (`:702`, and `from` is unauthenticated); unconfigured orch sid → fail-**open** (`:694`). *Exploit:* session A impersonates the orchestrator to hand session B arbitrary work. (FACT.)

**[MEDIUM] G — command-injection / eval sites.** `open-session.sh:118` `eval cwd="$cwd"` (eval on a config/user path). The **primary** production spawn interpolates unquoted into an inner `bash -c '…'`: `workspace-host.sh:308` `--command "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'"` (a single quote in `$cwd`/`$sid` breaks out); same pattern at `:654`, `:716`, and legacy `open-session.sh:212`. In telepty, `cross-machine.js:165` uses `execSync(\`ssh … ${sshTarget} …\`)` with a peer-derived target, and `:154` `StrictHostKeyChecking=accept-new` (TOFU). (FACT.) *Note:* today these inputs are orchestrator/config-controlled, not a raw remote feed — hence MEDIUM — but they can transitively derive from task content, and there is no sid/cwd validation on the legacy path.

**[MEDIUM] H — cross-machine HTTP peer mode ships token + keystrokes in plaintext.** `cross-machine.js:397` builds `http://…` and attaches the static `x-telepty-token` (`:392`). In HTTP peer mode a LAN sniffer captures the token → full daemon access. *Mitigation (FACT):* the newer **broker** transport (`src/transport/broker-server.js`) is TLS-mandatory with per-node HS256 JWT + `constantTimeEqual` + revocation — the correct model, but default-OFF.

**[LOW] I — "Snyk at inception" is unenforced.** No `snyk` reference in any `.github/workflows`, `git-hooks/`, or `.claude/hooks/` across the three repos. `bin/snyk-scan.sh` exists but nothing invokes it automatically. The policy is an instruction to the model, not a mechanical gate. (FACT — partly by design per AGENTS.md, but there is no backstop if the agent skips it.)

### 2.2 Recommendations (highest-leverage first)

1. **Require the token even for loopback** on state-changing routes (`/spawn`, `/inject`, `/kill`, `DELETE`, `/broadcast`), or gate `/spawn` behind explicit opt-in — **closes A and most of C** with a small diff.
2. **Lock CORS** to an explicit origin allowlist (`daemon.js:155`).
3. **Wire `enforceSpawn`/gate** into `dispatch.sh`/`boot-prepare.mjs` (warn-mode first) and into `/api/sessions/spawn`; stop defaulting every spawn to permission-bypass, or scope the bypass to sandboxed cwds — **closes B + D and activates the dormant 52%**.
4. **Quote/validate** `sid`/`cwd`/`cli_cmd`; drop `eval cwd` and unquoted `bash -c`; replace `cross-machine.js` `execSync` string SSH with `spawnSync('ssh',[argv])`.
5. **Deprecate plaintext `connect-http`** in favor of SSH/broker; make `PEER_ALLOWLIST` mandatory when bound non-loopback; sandbox/authenticate the `inbox-watcher` executor and drop its `--dangerously-skip-permissions`.

### 2.3 Strengths (objectivity)

Loopback-only default bind with an explicit exposure banner (`daemon.js:290`); `#548` destructive-op alias non-cascade; `#45` fan-out cap (`FANOUT_MAX_TARGETS=100`); inject audit spine `~/.telepty/logs/injects.jsonl` (`0600`) with `spoof_suspected` provenance flagging; deliberation auto-turn spawns are shell-safe with a read-only codex sandbox; the broker transport is well-designed (TLS + per-node JWT + constant-time + revocation); the dormant gate code is *correctly written* — it only needs wiring; file perms are sound (`~/.telepty` `0o700`, config `0o600`, no hardcoded secrets, random-uuid token).

---

## 3. USABILITY

Benchmark: Constitution §10 원클릭 ("설치 = 1 command / 최소 질문 / 인프라 비노출"), §2 크로스 (identical UX everywhere), §11 (user says "what", ecosystem solves "how").

### 3.1 Findings

**There are two products.** The **narrow public path** (devkit core profile → telepty + deliberation MCP) is genuinely near one-click and better-engineered than most solo projects. The **flagship the constitution describes** (orchestrated multi-session AI across terminals/machines) is single-author, single-machine (macOS-arm64 + cmux), Korean-documented, and **user #2 cannot reproduce it today**. (JUDGMENT.)

**The advertised "one command" is broken at the front door.** `aigentry/README.md:16` sells `npm i -g @dmsdc-ai/aigentry`, but `bin/aigentry.js` is a ~100-line `status|version|help` shim that installs nothing, and its deps are stale-pinned: `telepty ^0.1.83` (repo at **0.6.6**), `devkit ^0.0.11` (at 0.0.21), `aterm ^0.1.52` (at 0.2.13). Since npm links only the top-level package's bins, `telepty` likely isn't even on PATH. (FACT.)

**The real installer (devkit) is mature.** `install.sh` (1,008 lines): core profile asks **zero questions** (`devkit-core,telepty,deliberation`); fallback chain with error classification (network→retry, auth/permission/disk→HALT), per-attempt logs, degraded-mode brain stub. Real step count to working core: ~3 (Node 18+, one install, restart CLI) — no API keys, no Rust. Failure handling is better than most commercial installers. (FACT.) *But* it prompts for `sudo apt-get` mid-install (`:375`) and `install.ps1` **lacks the orchestrator phase** entirely (bash has it at `:784-978`).

**The ecosystem's own terminal can't host the ecosystem's own sessions.** `_wh_aterm_open` calls `aterm new-session` (`workspace-host.sh:727`) — a subcommand that exists in **neither** `bin/aterm` nor `bin/aterm.js` (grep = 0). The `2>/dev/null` swallow silently falls back every time. And `aterm status` prints a **hardcoded heredoc** claiming brain/telepty/deliberation/devkit are all "✅ installed" unconditionally (`bin/aterm:50`) — a fake status surface that lies to fresh users. cmux (the golden path) is a **third-party macOS-only app** installed by nothing in the ecosystem — colliding with §17 무의존 and §3 (aterm is supposed to be the endpoint). (FACT.)

**A file named `CON` is tracked in git** in `aigentry-brain` (`git ls-files CON` → `CON`; stray `> CON` shell-redirect output). `CON` is a reserved Windows device name → `git clone` on Windows fails/mangles, in a repo that claims Windows support. (FACT.)

**Governance is unoperable by non-authors**: 28 HARD rules, 150-line Rule 4-A, cross-referencing 28 ADRs, Korean-dominant (rules.md 292/519 lines Korean; constitution 157/269). Public READMEs are English; everything *governing behavior* is Korean. A non-Korean user can install the tools but cannot read the ruleset that makes them work together. (FACT.)

### 3.2 Constitution scorecard (JUDGMENT)

| Promise | Reality | Grade |
|---|---|---|
| §10 설치 = 1 command | True for core devkit profile; false for the advertised meta package & flagship | C+ |
| §10 최소 질문 | Core: 0 questions; full profile: ~10 prompts + sudo | B |
| §2 Cross-OS | macOS golden; Linux partial; Windows: no orchestrator phase, `CON` breaks brain clone | D |
| §2 Cross-terminal | cmux (3rd-party) golden; aterm adapter calls nonexistent `new-session` | D |
| §11 user says "what" only | Operator must internalize 28 rules + 28 ADRs, in Korean | F (for anyone but the author) |
| §17 무의존 | Orchestrator's daily surface is external cmux | Violated in practice |
| Failure transparency (Rule 30/32/33) | Real, scripted, improving; transport layer excellent | B+ |

### 3.3 Recommendations

1. **Fix or retract the meta package** — repair the stale pins + bin collision, or delete the "one command installs everything" claim from the README. It is the literal first thing a stranger runs.
2. **Fix `aterm new-session`** (implement it or repoint the adapter) and **delete the fake `aterm status` heredoc** — replace with a real probe.
3. **Delete `CON` from aigentry-brain** (and the untracked `aterm/CON`) to un-break Windows clone.
4. **Replace the stock-template aterm README** (it still describes a Svelte+Vite app that no longer exists).
5. **Translate-or-mechanize the rulebook** — the operator prompt the installer deploys is already English; bring the governing docs to parity or convert live rules into scripts.

### 3.4 Strengths

Install-with-fallback (error classification, HALT-on-auth, structured logs, degraded stubs); telepty self-healing daemon + honest README (the one component a stranger could adopt today and enjoy — `cli.js:452,718`); **institutionalized honesty** (BOUNDARY.md KNOWN DIVERGENCE, WIRING-GAP flags, "Limitations (honest)" sections, Tier-2/`ready_attestation:none` labels — the system documents its own lies, which is rare and valuable); idempotency discipline (skip-by-default installs, dedupe hook merges); the rule→enforcing-script pipeline (Rules 28/32/33 each shipped with a binary).

---

## 4. BUSINESS (사업성)

### 4.1 Findings

**Positioning is fractured across 4–5 categories.** "Sovereign Brain OS" (hub README), "AI Development Runtime" (orchestrator AGENTS.md), "PTY orchestration daemon" (telepty README), "auditable AI decisions engine" (registry README), "One terminal for AI agents" (aterm/amplify). The org's **own** external architecture review rejected the flagship label: *"'AI Development Runtime' as a marketing-tier description is not a runtime domain model"* (`docs/reports/2026-05-23-agentic-architecture-external-review.md:138`). The hub's `architecture.md` still describes a March "3-pillar" (brain/deliberation/registry) with telepty/aterm absent. (FACT.)

**The org has already converged on the right answer — and frozen its brand docs in the old one.** The best-written positioning doc is the most recent: the telepty Show HN draft (narrow hook, self-identifying TAM, honest limitations, pre-emptive "why not tmux"), which matches the 6-10 monetization consensus ("제품 표면 = telepty + brain만"). But `aigentry/README.md` and `architecture.md` remain in the March vision pitch. (FACT + JUDGMENT.)

**Differentiation: the genuinely novel surface is narrow.** Real: (1) **readiness-gated submit** — "the one thing tmux's send-keys structurally can't do," backed by `submit-gate.js` + tests + a real number ("222k submits, 0 failures"); (2) **inject audit ledger** (`injects.jsonl` + verified sender) — the only bridge to the 2027-28 compliance story; (3) **cross-machine daemon without sshd** (Tailnet-native). Commodity (own docs admit it): PTY wrapping, session list, broadcast, agent-state FSM, memory MCP — the herdr comparison concedes *"Herdr wins on public positioning, remote attach, protocol docs, and agent-state breadth"* (AGPL, free). (FACT.)

**Moat: none currently.** No network effects (not multiplayer), low switching cost, no proprietary data (the 222k log is self-dogfood), MIT/ISC. Weekend-cloneable is an overstatement (submit-gate heuristics, 8-state FSM, 650+ tests, ConPTY knowledge = months of attrition) — but "takes months to clone" is lead time, not a moat, and herdr is spending those months in parallel. The only structural moat candidates are the org's own research targets: hosted convenience layer over a sovereign core (Tailscale model), and the audit ledger → neutral third-party trust layer (2027-28). Neither exists yet. (FACT + JUDGMENT.)

**The org's own market research is unusually rigorous — and self-negating.** `docs/reports/2026-06-10-market-research-monetization.md` (24 sources, 17 confirmed / 8 rejected): ① registry (agent trust/audit) = #1 opportunity but demand wave delayed to **2027-28** (EU AI Act high-risk obligations pushed to 2027-12/2028-08); ② brain = platform-absorption risk within 18 months; ③ telepty standalone paid **"nearly impossible"** — *of paying bridges, exactly 1 exists (Omnara $9/mo), 4 are free, 2 shut down (Terragon, Bloop)*; ④ local-first sovereignty alone = weak moat (0 cases of sovereignty-as-paywall); ⑤ 19-repo vertical integration unsupported (value concentrates in 1-2 layers; orchestration-framework revenue vs token revenue = ~1000× gap). (FACT.)

**The monetization decision is sound but stalled at the one step AI can't do.** 3-LLM unanimous synthesis: a **B2B 2–10-person dev-shop, local-first paid setup wedge** ($1,000 fixed, 7-day delivery), B2C explicitly excluded (WTP = 0), product surface = telepty + brain only. Gate: a **14-day pre-sell sprint (code = 0 lines)** — 30 outreach + 5 calls + 1 paid LOI; **no LOI → halt monetization**. Status (`state/task-queue.json`, 2026-07-02): research/smoke/runbook done, but **#596 (pre-sell) = `awaiting-user`, #595/#598 = `awaiting-user-adoption` for 3 weeks**; `docs/adr/2026-06-10-monetization-strategy.md` does not exist. Meanwhile code kept shipping (telepty 0.6.2→0.6.6, logger R4 MVP). (FACT.)

**Strategy and code contradict each other.** `entitlement.js` already ships pro/team feature gates wired into production (`cli.js:2387` `checkEntitlement({feature:'telepty.remote_sessions'})` → `exit(1)` + upgrade URL), with **no purchase/issuance path anywhere in the repos** — and it can `exit(1)` the README's headline feature (cross-machine) on the free tier. This is open-core built *ahead of* the wedge-first strategy that explicitly deferred it. License hygiene is also broken: telepty `LICENSE`=MIT vs `package.json`=ISC; brain/orchestrator/amplify/dustcraw have no LICENSE; aterm metadata says UNLICENSED. (FACT.)

**Distribution = 0, and it was answered with code.** `aigentry-amplify` (a "1 source → N channels" marketing framework, v0.0.1, `private:true`, 2 pieces of content) was built before any audience or launch. Show HN / GeekNews: **drafts only, never posted** — the "anticipated top comments" in the draft are self-authored rebuttals, and the only real HN/GN signal in the repos is about a *competitor* (herdr). npm 30-day downloads: telepty 4,072 / aterm 1,929 / brain 162 — organic fraction unverified. (FACT.)

### 4.2 Risks (severity-ranked)

| Sev | Risk |
|---|---|
| **HIGH** | The wedge strategy is stalled 3 weeks at #596 — the only step AI can't perform (sales). Per the org's own gate, stall = strategy void. Zero validated paying customers exist. |
| **HIGH** | Positioning is split 4–5 ways; the public first-impression docs (hub README/architecture.md) sell a different category than the actual product surface (telepty). |
| **MED** | No moat today; herdr is ahead on public positioning and covering the same surface for free (AGPL). |
| **MED** | `entitlement.js` open-core gates ship with no purchase path and can break the flagship feature on free tier — refund risk if it fires during a paid delivery. |
| **MED** | License mess (MIT/ISC mismatch, missing files, UNLICENSED aterm) blocks credible public launch. |
| **LOW** | 23-repo breadth is a focus problem: even the ~10 product repos exceed the "telepty + brain only" sellable surface the org itself chose. |

### 4.3 Recommendations

1. **Decide #596 now**: execute the 14-day pre-sell, or explicitly declare monetization paused per the consensus's own rule. Three weeks of silence is the de-facto answer; make it explicit.
2. **Unify the public pitch to the wedge**: promote the telepty Show HN framing to the hub README; retire the March "Sovereign Brain OS / 3-pillar" language until a customer has adopted the core.
3. **Reconcile code with strategy**: either wire a purchase path behind `entitlement.js` or disable the gates until the wedge validates; do not ship a pro-gate that can `exit(1)` on cross-machine.
4. **Clean up licensing** before any launch (single license per repo; fix telepty MIT/ISC; add LICENSE to brain/orchestrator/amplify/dustcraw; resolve aterm UNLICENSED).
5. **Define the MSP explicitly**: telepty 0.6.x (with the audit ledger) + ops-convention templates + recovery runbook = the $1,000 setup; the bottleneck is 30 outreach emails, not technology.

### 4.4 Strengths

Evidence-based market research that negates its own hypotheses (rare discipline); a monetization consensus with an explicit kill-gate; an honest-limitations culture (telepty README, recovery runbook); and two *real* narrow technical differentiators (readiness-gated submit, inject audit ledger) that plausibly seed the 2027-28 compliance story.

---

## 5. Top-5 prioritized actions (across all dimensions)

1. **[SECURITY — CRITICAL] Close the telepty local-auth hole.** Require the auth token even on loopback for state-changing routes (`/spawn`, `/inject`, `/kill`, `DELETE`, `/broadcast`) and lock CORS to an explicit origin allowlist. This is a small diff that closes the RCE-from-any-local-process (finding A) and the browser drive-by (C) — the highest-severity, lowest-effort fix in the ecosystem.
2. **[SECURITY/STRUCTURAL — HIGH] Wire the gate and stop blanket permission-bypass.** Invoke `enforceSpawn` in `dispatch.sh`/`boot-prepare.mjs` (warn-mode first) and at `/api/sessions/spawn`; scope `--dangerously-*`/`bypassPermissions` to sandboxed cwds instead of defaulting on. Closes the WIRING-GAP (D) + amplifier (B) and activates the ~52% dormant, already-tested TS kernel.
3. **[BUSINESS — HIGH] Execute or formally kill the 14-day pre-sell (#596).** It is the single human-only, AI-can't-do-it step, stalled 3 weeks; per the org's own gate, no LOI → halt. Decide, don't drift — and unify the public pitch to the telepty wedge while doing so.
4. **[USABILITY — HIGH] Repair the public front door.** Fix or retract the meta package (stale pins + `aigentry` bin collision), fix the `aterm new-session` adapter + the fake `aterm status`, delete the Windows-breaking `CON` file from aigentry-brain, replace the stock-template aterm README, and resolve the license mismatches. These are literally the first six things user #2 hits.
5. **[STRUCTURAL — MED] Cut the sprawl and the injection surface.** Collapse 23 dirs toward the ~7-component core + a `sessions/` role folder + `archive/`; fix the shell-injection sites (`eval cwd`, unquoted `bash -c` at `workspace-host.sh:308`, `execSync` SSH); single-source the drifting CLI defaults; and mechanize/prune the governance debt (Rule 4-A → a 30-line script).

---

## 6. Method & self-critique (objectivity)

- **Confidence is highest** on the WIRING-GAP (hand-verified + self-documented) and finding A (exact `file:line` on the middleware and the spawn endpoint). These are FACTs, not inferences.
- **Confidence is lower** on: the browser-drive-by (C) — modern browsers' Private-Network-Access may blunt it; and on the *organic* fraction of npm downloads (self-install vs real demand is unmeasured — treat the 4k/month as a ceiling, not a signal).
- **What this pass did not do**: run the code, attempt any exploit, measure runtime behavior, or read every file in 23 repos (the ecosystem-survey pass sampled READMEs/AGENTS.md + git dates + LOC, not full source). Severity ratings for security are analyst judgment on a self-owned codebase, not a formal pentest.
- **A caution on my own framing**: I have ranked "close the telepty auth hole" above the flagged WIRING-GAP. That is a deliberate re-prioritization — the dispatch framed the gate as the headline risk, but on the evidence, an *already-open* unauthenticated local RCE dominates a *second missing* containment layer. If the intended threat model excludes local processes entirely (single-user trusted machine), both drop in severity — but that assumption is exactly what "every spawned agent is a permission-bypassed local process" violates.
