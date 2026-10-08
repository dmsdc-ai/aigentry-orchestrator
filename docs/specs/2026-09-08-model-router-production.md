# #1133 — Production model router: CURRENT-vs-TARGET SPECIFICATION

**Revision 2** (2026-09-08). Revision 1 = `8162f2b662c3e6884a5587fa5fc8a9335537c30b`,
review verdict **ISSUES, no implementation approval**. This revision changes contracts, not
caveats; §16 maps every reviewer issue to the section that now carries it. Nine issues were
raised; **three invalidated a v1 design decision outright** (§8.3 reservations, §13's F1→F2
dependency edge, §5's unreachable tie-break) and are re-specified, not annotated.

**Status:** SPEC ONLY. No `bin/`, `src/`, `tests/` or profile edit; no build, no test
execution, no dispatch, no runtime or live-config change. Implementation is a later,
separately dispatched wave and is **not** approved by this document.

### Measurement basis (re-measured for this revision)

| | |
|---|---|
| Current `main` | **`bf127a507d9480c7f40ec73c002c06ae9c60dddd`** ("chore: recover router revision dispatch and record active spec work") |
| Revision-1 base | `f268d3440e25c0a6124a89dbfef0e1715ac89119` — **verified ancestor** of current `main` (`git merge-base --is-ancestor` → true) |
| `main` moved by | 14 commits, touching **only** `docs/analysis/…`, `docs/specs/…` and `state/task-queue.json` (`git diff --stat f268d34..bf127a5`) |
| Measured sources at **current** `main` | `bin/model-router.mjs` `3737b92…`, `docs/model-profiles/model-routing-profile.md` `a937791…`, `src/dispatch/cli.ts` `c29fe73…`, `tests/dispatch/model-router-fixtures.ts` `d99de5b…` — **byte-identical to `f268d34`** |
| This branch | `docs/1133-model-router-production-spec`, worktree `~/.aigentry/worktrees/mr1133` |

Every source measurement in §1 was taken at `f268d34` and **re-verified unchanged at
`bf127a5`** by blob SHA. Nothing in `bin/`, `src/`, `tests/` or the profile has moved.

---

## 0. §1.2 constitutional answer

> *Can production routing requirements be met by extending existing dispatch/router/profile
> without a new framework or service?*

**YES**, and revision 2 makes the answer stronger rather than weaker: the capacity protocol
that v1 tried to hand-roll (§8.3) now **reuses the repository's existing durable-transaction
primitive** instead of inventing a weaker one.

| Requirement | Existing primitive reused | New runtime? |
|---|---|---|
| Structured task input | `bin/model-router.mjs` argv parser (`:8-12`) | no — flags only |
| Candidate eligibility | `fs.accessSync` + `geminiBinary()` (`src/session/boot-adapter/gemini.ts:16-21`) + profile front matter | no |
| Suitability ordering | pure comparator inside the router | no |
| Bounded LLM tie-break | the existing `spawnSync` classifier seam (`:69-82`) | no |
| **Capacity claim (count+claim serialized)** | **`bin/dispatch-registry.py`'s `_Lock` (`:163-194`) + its `commit()` temp→fsync→rename→dir-fsync (`:255-292`)**, applied to a **separate fixed-literal file**, not to the validated registry | no — **no `SCHEMA_VERSION` bump** |
| Durable defer | `state/task-queue.json` note + a new dispatch exit code (§8.6) | no |
| Selection ledger | `bin/emit-telemetry.mjs --helper dispatch` | no |
| Shadow / rollback | one env var, `AIGENTRY_ROUTER_MODE` (§10) | no |

No service, daemon, framework, scheduler or dependency. Zero `package.json` change
(Article 17). **No line-count claim is offered as a correctness argument anywhere in this
revision** — correctness rests on the protocol in §8.3 and the acceptance cases in §12.

**Still rejected, with the price named:**

* **Reservations as a field on `active.json`.** Would require `SCHEMA_VERSION` 2→3,
  `op_migrate`, a back-compat window and blast radius across every dispatch
  (`validate()` `:197-235` is strict and `commit()` re-validates). §8.3 gets the same
  atomicity from the same lock without touching that schema.
* **A routing daemon or learned scorer.** `bin/dispatch-registry.py:228-231` *refuses* any
  record whose `outcome.state` is not `"unknown"` — "0.8.0 has no writer that may set
  anything else". There is no outcome data to learn from, so any adaptive router would fit
  noise. §10.5 makes an outcome writer a hard precondition for ever revisiting this.

---

## 1. Measured current behaviour

### 1.1 The production path, end to end

```
bin/dispatch.sh (exec shim)
  └─ dist/src/dispatch/cli.js          ← PRODUCTION runs the COMPILED file, not the .ts
       ├─ resolveRoute()      cli.ts:417-449
       │    └─ spawnSync(node bin/model-router.mjs --role R --ref F --candidates 1)
       │         timeout 16000, killSignal SIGKILL, stdio [ignore, pipe, inherit]
       ├─ applyCliCap()       cli.ts:487-503        ← runs AFTER route, BEFORE spawn
       ├─ spawnWorkspace()    cli.ts:951-1022
       ├─ emitTelemetry(dispatch_start)             cli.ts:1077-1088
       └─ taskLedgerUpdate()  cli.ts:668-718        ← the ` | dispatched … ` note stamp
```

Compiled-path check: `dist/src/dispatch/cli.js` contains `|| EMERGENCY_ROUTE` and
`(o.route.candidates || [])` at `:509` and `EMERGENCY_ROUTE = { cli: "claude", … }` at
`:464` — **the artefact production runs agrees with the source read below.** `npm test`
refuses a stale `dist/` (`scripts/run-tests.mjs:37-47`).

### 1.2 What the router sends the classifier — measured on THIS task's own original ref

| Measurement | Value |
|---|---|
| ref total (`~/.telepty/shared/7de0f022….md`, dispatch #1133) | 8757 B |
| ref sent to classifier | 4096 B (**46.8 %**) |
| ref **dropped** | 4661 B (**53.2 %**) |
| profile prose also sent (`front[2]`) | 8309 B |
| ratio profile-prose : task-text-sent | **2.03 : 1** |
| cut position | mid-sentence inside `## Constraints` |
| sections that never reached the router | 8 of 12, including `## Boundary and full capability` (the tool/capability envelope) |

The router chose a model for this task while blind to its capability envelope and its
required tool surface, and spent twice as many prompt bytes on vendor-benchmark prose as on
the task.

Two details beyond the inherited observation set:

* The cut is a **byte** slice of a `Buffer` decoded afterwards (`:59-63`), so a multi-byte
  character straddling offset 4096 decodes to U+FFFD. Refs here contain Korean. On *this*
  ref the boundary was clean (verified) — a latent defect, not an active one.
* Truncation is **silent**: nothing in the decision, telemetry or queue note records that
  the router saw a partial task.

### 1.3 The decision object

`{cli, model, label, decided_by: "llm"|"table", reason, confidence [, candidates]}`.

* `confidence` is validated finite in `[0,1]` (`:87`) and then **never read**. Measured:
  `grep -rn confidence src/` → zero hits. Absent from the telemetry payload
  (`cli.ts:1086` sends only `label, decided_by, reason, capped_cli`) and from the queue
  stamp (`cli.ts:690`). `confidence: 0.01` is accepted exactly like `0.99`. The field is
  **dead**, not merely un-thresholded.
* `candidates` is emitted only under `--candidates` (`:101-105`), ordered
  `[role-table pick, …profile declaration order]` — pinned by T138 and **unrelated to the
  LLM's own ranking**.

### 1.4 Eligibility: there is none

No check that the selected CLI is installed, authenticated, capability-adequate or
permitted, anywhere in route→spawn. `geminiBinary()` (`gemini.ts:16-21`) is the only
`accessSync` in the path and it chooses *between* `agy` and `gemini`; it never gates.
`bin/open-session.sh` has no `command -v` on the CLI. A profile naming an uninstalled CLI
routes to it, spawns a workspace, and fails at the readiness timeout — after the workspace,
the git guard, the launcher and the boot-prepare shadow home have all been written.

### 1.5 Capacity accounting — two measurements, and the difference matters

`liveCliCounts()` (`cli.ts:467-477`) counts **every** `telepty list --json` row whose
command resolves to a CLI kind, including the orchestrator's own row.

**Current (2026-09-08T13:15:57Z), reproducing `cliKindOf()` exactly:**

```
orchestrator      bare     kind=codex
mr1133-architect  worker   kind=claude
wf1136-architect  worker   kind=claude
total: {codex: 1, claude: 2}    worker-only: {claude: 2}
```

**Historical (2026-09-08T12:35Z), NOT current:**

```
total: {codex: 2, claude: 1}    worker-only: {codex: 1, claude: 1}
```

`AIGENTRY_CLI_CAP_CODEX=2` is set in the operator environment, from `~/.env:36`
(measured; the value is a **quota decision by the user**, not a proven worker-only budget).

At the historical sample codex was at cap with one worker; **at the current sample it is
not**. Both are recorded with timestamps because a live count is a sample, and §8.2's
policy question must not be argued from a stale one. What is *structural* — and true in
both samples — is that the orchestrator's own row is counted by `liveCliCounts()`.
What is *not* established is that the user's `=2` was ever meant as a worker-only budget.
§8.2 therefore **preserves today's counting by default**.

### 1.6 The all-capped hole, and a second one

```ts
// cli.ts:497
const pick = (o.route.candidates || []).find((c) => !atCap(c.cli)) || EMERGENCY_ROUTE;
```

* **D5a — all candidates capped.** ⇒ `pick = EMERGENCY_ROUTE` = `claude/claude-opus-5[1m]`,
  spawned **over** the claude cap. `cliCap()`'s own contract says `0 = never auto-route
  there` (`cli.ts:479`). **No test covers this**: all eleven of T140's cap cases leave ≥ 1
  candidate under cap.
* **D5b — the router-unavailable route has no candidates at all.** `resolveRoute`'s catch
  arm (`cli.ts:445-447`) builds a route **without** `candidates`, so `applyCliCap`
  evaluates `(undefined || [])` ⇒ `EMERGENCY_ROUTE` **unconditionally**, whatever the caps
  say. T140's "unavailable router" case sets `AIGENTRY_CLI_CAP_CLAUDE:""`, which is why it
  never saw this.
* `AGENTS.md:147` documents the chain as "역할 기본표 → 프로필 순서 → Opus 5": the docs and
  the code agree with each other and both contradict the `0` contract.

### 1.7 Race: the cap is read, never claimed

`applyCliCap` reads `telepty list` at `cli.ts:489`; the spawned session becomes visible
only after `spawnWorkspace` → `open-session.sh` → daemon registration. Two **simultaneous**
`--spawn-and-dispatch` invocations both observe the pre-spawn count and both proceed.

**Measured startup budget** (this bounds any reservation TTL, §8.3):
registration wait ≤ `REGISTER_TIMEOUT_MS_DEFAULT` = **180 000 ms** (`cli.ts:42`, `:894`),
then readiness wait = `o.timeoutMs` default **30 000 ms**, or **90 000 ms** for codex
(`AIGENTRY_CODEX_READY_TIMEOUT_MS`, `cli.ts:934-936`). Worst case claim→`beginDelivery`
≈ **270 s**. The session becomes *visible in `telepty list`* at registration, i.e. within
the first ≤ 180 s.

### 1.8 Test inventory and runner inclusion

Router-relevant guards, all `node:test` TypeScript, all genuinely executed:
`scripts/run-tests.mjs` recursively collects `dist/tests/**/*.test.js` (`:10-24`), so
`npm test` runs them with no manifest to bump, and CI runs `npm test` on ubuntu + macos
(`.github/workflows/ci.yml:66`).

| Guard | Covers |
|---|---|
| `T138-model-router-fallback.test.ts` (37 L) | 5 classifier-failure modes → role table; `--candidates` order |
| `T139-model-router-selection.test.ts` (106 L) | label→cli/model mapping; bad profile → emergency Opus; role table; **the real profile parses**; Haiku argv + 4KB ceiling |
| `T140-dispatch-model-routing.test.ts` (226 L) | end-to-end dispatch: audit payload, queue stamp, launcher env, 11 cap cases, explicit `--cli`, `--target`, dedup |
| `model-router-fixtures.ts` (81 L) | hermetic fixture; scrubs ambient `AIGENTRY_*` (#1109) |

**Runner-inclusion rule for new work:** a `.test.ts` guard needs nothing; a `T*.sh` guard
needs `EXPECTED_GUARDS=135` bumped at `tests/dispatch/run-all.sh:52` or the suite fails.

**Test-ID allocation, measured 2026-09-08:** the highest existing id under `tests/` is
**T150**. T151+ are free *as of this measurement*; §13 requires the implementer to re-check
at branch time, because concurrent tasks (#1135, #1136) may claim ids first.

Fixture-vs-real divergence: the fixture profile maps `researcher→gemini, logger→grok-4.6`;
the real profile maps `researcher→grok-4.6, logger→gemini`. Deliberate, but it means **no
test asserts the real profile's role table**.

### 1.9 Profile honesty

Front matter carries `measured_at: 2026-09-05` while the `opus-5` row's evidence block is
labelled, in the body, "measured for Fable 5.1 … Opus 5 itself is unmeasured here". The
machine-readable half claims a date the human-readable half disclaims. Every
strength/weakness/best-for line is prose only.

Critically for §4.2: the profile mixes two different kinds of claim in one row — **model
quality** (benchmark numbers, some of them Fable 5.1's) and **CLI capability** (`--worktree`
exists, web search measured working). These have different provenance and different
lifetimes, and today nothing distinguishes them.

### 1.10 Defect register

| ID | Defect | Evidence | Repro |
|---|---|---|---|
| **D1** | 53.2 % of a real task ref never reaches the router; truncation unrecorded | `:60-63`; §1.2 | R1 |
| **D2** | Byte-slice truncation can emit U+FFFD mid-character | `:59-63` | R2 |
| **D3** | `confidence` validated then discarded; no threshold, no sink | `:87`; `grep -rn confidence src/` = 0 | R3 |
| **D4** | Fallback order is role-table-then-declaration-order, unrelated to suitability or to the LLM's ranking | `:101-105`, T138 | R4 |
| **D5a** | All candidates capped ⇒ emergency Opus spawned **over** the claude cap | `cli.ts:497` | R5a |
| **D5b** | Router-unavailable route carries no `candidates` ⇒ emergency Opus unconditional | `cli.ts:445-447` + `:497` | R5b |
| **D6** | No installed / auth / capability / prohibition gate in route→spawn | §1.4 | R6 |
| **D7** | Cap is read-not-claimed; **simultaneous** dispatches both pass | §1.7 | R7 |
| **D8** | Orchestrator's own session is counted in the worker cap; the knob's intent is unrecorded | §1.5 | R8 |
| **D9** | No selection ledger: eligible/excluded set, evidence and its age never recorded | `cli.ts:1086` | R9 |
| **D10** | Profile is unstructured prose; `measured_at` overstates the opus-5 row; capability and model-quality claims are conflated | §1.9 | R10 |
| **D11** | **Profile front matter is closed to extension**: any new top-level key throws, and a throw degrades EVERY dispatch to emergency Opus | §1.12 | R11 |

### 1.11 Reproduction specifications

Deterministic and hermetic on the existing `tests/dispatch/model-router-fixtures.ts`.
`R` = observe the defect at `bf127a5`; `A` = the acceptance case that must make it stop.
**Every R is written and demonstrated RED against unmodified `main` before its fix lands**
(§13 wave order).

| ID | Setup | Run | Current (defective) observation | → |
|---|---|---|---|---|
| **R1** | ref = `"HEAD".padEnd(4096,"x") + "TAIL-REQUIREMENT"` | `f.router(["--ref", f.ref])` | `PROMPT_LOG` has `HEAD`, not `TAIL-REQUIREMENT`; stdout has no truncation field. T139's `MUST-NOT-REACH-CLASSIFIER` assertion pins this as *intended* and must be re-pointed. | A3 |
| **R1b** | ref with a mandatory tool token **only in the middle** (offset ≈ 6 KB of a 12 KB ref) and a **prohibition in the last 500 B** | `f.router(["--ref", f.ref])` | neither reaches the classifier under head-only **or** head+tail clipping; `require` is silently `[]` | A3b, A3c |
| **R2** | ref = `"x"*4095 + "가"` | `f.router(["--ref", f.ref])` | `PROMPT_LOG` ends in U+FFFD | A4 |
| **R3** | `CLASSIFIER_REPLY='{"label":"gemini","reason":"guess","confidence":0.01}'` | `f.router(["--ref", f.ref])` | gemini chosen; `confidence:0.01` in stdout, **absent** from `TELEMETRY_LOG` and the queue note | A5 |
| **R4** | role `coder` (table→`gpt-6-astra`), classifier says `gemini`, `CAP_GEMINI=0` | `f.dispatch([...spawnArgs,"--role","coder"])` | falls to `gpt-6-astra` — the role table's pick, not the classifier's runner-up | A9 |
| **R5a** | `CAP_CODEX=0 CAP_CLAUDE=0 CAP_GROK=0 CAP_GEMINI=0` | `f.dispatch([...spawnArgs,"--role","coder"])` | **exit 0**, spawns `claude/claude-opus-5[1m]` while `CAP_CLAUDE=0` says "never auto-route there" | A10 |
| **R5b** | `DISPATCH_SCRIPT_DIR=f.bin` (router absent) **+** `CAP_CLAUDE=0` | `f.dispatch(f.spawnArgs)` | **exit 0**, spawns claude: catch-arm route has no `candidates` | A11 |
| **R6** | `PATH` without `codex`; role `coder` | `f.dispatch([...spawnArgs,"--role","coder"])` | routes to codex anyway; workspace, git guard, launcher, shadow home all written before failure | A8 |
| **R6b** | `claude` stub exits with the measured "Not logged in · Please run /login" signature; a prior dispatch recorded it 60 s ago | `f.dispatch([...spawnArgs,"--role","architect"])` | routes to claude again immediately; no negative-auth memory exists | A8b |
| **R7** | `CAP_CODEX=2`, `LIVE_SESSIONS` = 1 codex row; **N=4 dispatch child processes released from a common barrier**, `LIVE_SESSIONS` frozen (no stub session is added) | simultaneous start | all 4 observe `live=1 < cap=2` and all 4 spawn ⇒ 5 codex against a cap of 2. **This is the concurrency shape; a sequential test does not reproduce it.** | A12 |
| **R8** | `LIVE_SESSIONS=[{orchestrator,"codex"},{w1,launcher(codex)}]`, `CAP_CODEX=2` | `f.dispatch([...spawnArgs,"--role","coder"])` | capped off codex with one worker live; ledger records neither total nor worker count | A13 |
| **R9** | any successful auto route | inspect `TELEMETRY_LOG` | `route` = `{label, decided_by, reason, capped_cli}` only | A14 |
| **R10** | — | `grep -c "caps:\|best_for:\|cost_rank:" docs/model-profiles/model-routing-profile.md` | `0` | A16 |
| **R11** | add `profile_version: 3` to the **real** profile front matter | `f.router(["--profile", real])` | `stderr: model-router: profile missing or invalid; using table`, route = emergency Opus — **for every role** | A17 |

### 1.12 The profile parser is closed to extension (D11) — static evidence

The parser (`bin/model-router.mjs:36-49`) is not a YAML reader. Its regexes were extracted
verbatim and exercised in isolation (no router invocation — architect boundary). Results:

| Candidate front-matter line | Section | Verdict |
|---|---|---|
| `measured_at: 2026-09-05` | top | **OK** (the only whitelisted top-level scalar) |
| `profile_version: 3` | top | **THROW** `unsupported profile syntax` |
| `schema_version: 1` | top | **THROW** |
| `clis:` (a new section) | top | **THROW** |
| `  claude: {caps: 'mcp worktree'}` | under a non-`table` section | **THROW** |
| `  - {label: opus-5, cli: claude, model: "claude-opus-5[1m]", caps: "mcp worktree subagents", best_for: "design diagnosis", cost_rank: 4, evidence: "ceiling-from-fable-5.1"}` | `models`, **one line** | **OK** → all keys parsed; note `cost_rank` arrives as the **string** `"4"` |
| the same row split across two lines | `models` | **THROW** `invalid profile map` |
| `  - {label: x, …, note: "a # b"}` | `models` | **THROW** — the comment stripper `(^\|\s)#.*$` eats the closing brace |

Three consequences that revision 1 got wrong:

1. **v1's §4.1 example was unparseable** (multi-line) and its `profile_version:` key would
   have thrown. Both are corrected in §4.1.
2. **The dependency edge F1→F2 was backwards.** A profile edit that throws sets
   `failure = "profile missing or invalid"` and routes **every** dispatch to emergency
   Opus. The parser extension (F2) must land **before or atomically with** the profile
   edit (F1). §13 reverses the edge and forbids splitting them across waves.
3. Values must contain no ` #`, and numeric-looking scalars arrive as strings and must be
   coerced **and validated** (`cost_rank` must be an integer 1..9 or the profile is invalid).

T139's "the REAL profile parses" guard would catch a bad edit **in CI**, but only if F1 and
F2 are in the same branch — which §13 now requires.

---

## 2. Target behaviour

The router becomes **deterministic first, explainable always, and never over-cap**. It
receives the task's structure as **validated, complete, machine-supplied requirements**
(prose is advisory only and may be clipped; requirements may not); filters a fixed candidate
list through explicit eligibility gates whose verdicts are `pass｜fail｜unknown` with a
stated policy per gate; orders survivors by lexicographic priority tiers; consults a bounded
LLM **only** to break a genuine tie among substantively-equal candidates, behind an
uncalibrated confidence floor; falls back down the same order; **claims** capacity under a
serialized count+claim transaction before spawning; and when nothing is eligible or
occupancy cannot be established, **defers observably** instead of spawning. Every decision
emits one bounded, privacy-safe ledger record. It ships inert, runs read-only in shadow, and
is switched by one environment variable.

---

## 3. Structured input contract

### 3.1 Requirements are machine-supplied, validated, and complete — prose is advisory

The v1 design let the classifier infer requirements from task prose and then clipped the
prose. That is unfixable by any budget: **any clipping of prose can drop a requirement, and
head+tail drops the middle.** Revision 2 separates the two channels:

* **Requirements channel — authoritative.** `--require`, `--prohibit`, `--task-kind`,
  `--complexity`, `--prefer`, `--prefer-tool`. Supplied by `src/dispatch/cli.ts` (which
  knows role, task id, track, cwd) and by the orchestrator. **Complete by construction**:
  what is not stated here is not a requirement.
* **Prose channel — advisory only.** The task excerpt informs the LLM tie-break's judgement
  and nothing else. It **never** produces a hard constraint, so clipping it can never drop
  one.

**Absent extraction may never mean `require=[]`.** The distinction is explicit in the
ledger: `requirements_source: "declared"` (flags given) vs `"none-declared"` (no flags).
`"none-declared"` is not "no requirements"; it is *unknown requirements*, and §3.3 says what
happens then.

| Flag | Repeatable | Values | Default |
|---|---|---|---|
| `--task-kind` | no | `design｜implementation｜test｜build｜research｜logging｜diagnosis｜other` | from `--role` via the profile's `role_kind` map |
| `--require` | **yes** | capability token (§4.2) — **hard** | none |
| `--prefer-tool` | **yes** | capability token — **soft**, ranks only | none |
| `--prohibit` | **yes** | label or cli kind — **hard, never overridable** | none |
| `--complexity` | no | `low｜medium｜high` | `medium` |
| `--prefer` | no | `capability｜cost｜latency` | derived from `--complexity` (§5.2) |
| `--ref-budget` | no | bytes, 1024–65536 | `16384` |
| `--ledger` | no | write path for the ledger JSON | stdout only |
| `--mode` | no | `legacy｜shadow｜production` | `$AIGENTRY_ROUTER_MODE`, else `legacy` |

**Why flags, not a JSON side file.** `--profile` and `--ref` already reach `fs` from argv
under a reviewed, accepted Snyk CWE-23 finding (`bin/model-router.mjs:25-29`). A third
argv→`fs` **read** path would widen exactly that accepted surface. `--ledger` is a new
argv→`fs` **write** and is called out for the Snyk review in §11.

The existing parser (`:8-12`) collapses repeated keys; it becomes a multimap — scalars
last-wins, `--require`/`--prohibit`/`--prefer-tool` accumulate. Unknown flags are a hard
**request** error, so a typo'd `--requre worktree` can never read as "no requirement".

**Router exit codes must distinguish "refused" from "unavailable".** Today
`bin/model-router.mjs` always exits 0, and `resolveRoute` treats any non-zero as
`"router unavailable"` (`cli.ts:436`) — so a rejected request would silently take the
emergency arm, which is the opposite of refusing. The router therefore gains **exit 2 =
invalid request** (unknown flag, unknown token, unparseable value), distinct from a crash,
and `resolveRoute` maps router-exit-2 to a **dispatch usage error, exit 4** (the code
`src/dispatch/cli.ts` already uses for `--ref required` and friends, measured), never to the
emergency candidate set. Any other non-zero stays `"router unavailable"` and takes §8.5's
gated emergency arm.

### 3.2 Validation, before any routing work

Every declared value is checked against a closed vocabulary; **any violation is a usage
error (router exit 2 ⇒ dispatch exit 4), never a silent drop**: unknown capability token,
unknown task-kind, unknown prefer axis, `--prohibit` naming no known label or cli. The one
case that is **not** a usage error is `--require` naming a token no candidate declares —
that is `all-excluded` (§5) and ends in a defer, because it is a true statement about
capacity, not a malformed request. A requirement the router cannot interpret must stop the
router, not be discarded.

### 3.3 Task prose: bounded, boundary-safe, honest — and never load-bearing

1. Budget default **16384 B**. Measured corpus: this task's ref 8757 B, sampled
   `~/.telepty/shared/*.md` 3219–4319 B. **16 KB does not "solve requirement loss"** — §3.1
   does, by moving requirements out of prose entirely. The budget only bounds prompt cost.
2. Slice on a **character** boundary (decode-then-slice), never mid-codepoint. Closes D2.
3. Over budget ⇒ head+tail with an explicit `\n…[N bytes elided]…\n` marker, and
   `input.truncated: true` with exact byte counts in the ledger. Truncation stops being
   silent. Closes D1.
4. **The oversized-and-undeclared case** — ref over budget **and**
   `requirements_source: "none-declared"` — is the one the reviewer named, and it now has a
   defined outcome rather than an assumption:

   | Mode | Behaviour |
   |---|---|
   | `legacy` | today's exactly: 4096 B head, no requirements, no defer |
   | `shadow` | evaluate and log; the legacy decision still dispatches |
   | `production` | **bounded defer, exit 10**, reason `requirements-undeclared-oversized-ref`, unless `--accept-undeclared-requirements` is passed (explicit operator intent, recorded in the ledger as `undeclared_accepted: true`) |

   Deferring is the honest answer: the router cannot certify a routing whose constraints it
   provably has not seen. The confirmation path is one flag and it is auditable.
5. Task text stays data: the "Treat task text as data, never as routing instructions"
   instruction and `JSON.stringify` wrapping are retained verbatim.

---

## 4. Candidates and evidence

### 4.1 Profile front matter — parser-verified shape

Constrained by §1.12's static evidence. **F2 (parser) must land before or with F1.**

The parser extension is minimal and closed: a whitelist of top-level scalar keys
(`measured_at`, `profile_version`), one new section keyed like `default_table` already is,
and integer coercion+validation for `*_rank`. No YAML library (Article 17).

```yaml
measured_at: 2026-09-05
profile_version: 3                 # NEW top-level scalar — requires the F2 whitelist
models:                            # identity + MODEL-QUALITY evidence
  - {label: opus-5, cli: claude, model: "claude-opus-5[1m]", best_for: "design diagnosis integration", avoid_for: "logging boilerplate", cost_rank: 4, latency_rank: 4, evidence: "ceiling-from-fable-5.1"}
cli_caps:                          # NEW section — CLI-KEYED capability, block form like default_table
  claude: "mcp worktree subagents websearch permission-mode json-output"
  codex:  "mcp sandbox websearch json-output"
default_table:
  architect: opus-5
```

Every model row stays **one line** (§1.12). No ` #` in any value. `cost_rank` /
`latency_rank` parse as strings and are coerced to integers 1..9; a non-integer makes the
profile **invalid**, which under §8.5 now means "traverse the gates from the emergency
arm", not "silently emergency-Opus".

**`cli_caps` is keyed by CLI kind, not by model label — deliberately.** §1.9 measured that
the profile conflates model-quality claims with CLI-capability facts. `--worktree` exists or
does not exist *in the CLI*; it is not a property of Opus 5, and it must not inherit
provenance from a row whose benchmark numbers were measured on Fable 5.1. Splitting the two
is what makes "do not infer capability validation from row-level Fable evidence" mechanical
rather than aspirational.

`evidence:` on the model row (`measured｜claimed｜ceiling-from-<x>｜unmeasured`) describes
**model quality only** and feeds §5's T5. It never feeds a capability gate.

### 4.2 Capability tokens

Closed vocabulary: `websearch`, `worktree`, `subagents`, `mcp`, `sandbox`,
`permission-mode`, `json-output`, `long-context`. A token enters `cli_caps` only when the
profile body records a `measured:` observation of that **CLI surface**. Model prestige,
leaderboard scores and vendor claims are **not** capability evidence.

**Token count is never a capability judgement.** v1's `--prefer capability` ranked by
"number of matched required caps", which is constant across survivors of a hard filter and
therefore ranked nothing. §5.2 replaces it with soft `--prefer-tool` matches.

### 4.3 Eligibility gates

| # | Gate | Evidence | `unknown` policy |
|---|---|---|---|
| G1 | **prohibited** | `--prohibit`, profile `prohibit:` | total; **never overridable by `--cli`** (§8.5) |
| G2 | **installed** | `accessSync(dir/bin, X_OK)` over `PATH`; `gemini` via `geminiBinary()` | total |
| G3 | **capability** | hard `--require` ⊆ `cli_caps[cli]` | **BLOCKS.** A required token the profile does not declare is `unknown`, and unknown is not pass. |
| G4 | **auth** | §4.4 | `known_failed` **BLOCKS**; `unknown` **degrades** (§4.4) |
| G5 | **capacity** | §8 | occupancy unknown ⇒ **bounded defer in production** (§8.4), fail-open only in legacy |

Every verdict carries `evidence_kind` and `evidence_at` (ISO seconds). G1–G4 run inside the
router; G5 runs dispatch-side where the live list and the capacity lock are (§8.1).

### 4.4 Auth: presence is not authentication

**Presence of a config file proves a file exists. It does not prove authenticated, unexpired,
or usable-for-this-model.** The evidence model is four-valued and keyed to a context:

| Kind | Source | Effect |
|---|---|---|
| `verified` | an operator-run `--preflight-auth` recorded `{cli, model, at, verdict}` within `AIGENTRY_ROUTER_AUTH_TTL_S` (default 86400) | ranks first at T5 |
| `known_failed` | a **fresh** recorded auth failure for that `(cli, model)` within `AIGENTRY_ROUTER_AUTH_NEGATIVE_TTL_S` (default **1800**) | **EXCLUDES** |
| `artifact_present` | config artefact exists and is non-empty — existence and mtime only | weak positive; ranks above `unknown` at T5, **never** treated as authenticated |
| `unknown` | no artefact, no key name, no record | **degrades** (ranks last at T5); blocks only when `AIGENTRY_ROUTER_REQUIRE_AUTH_EVIDENCE=1` |

**Where `known_failed` comes from — evidence the system already produces.** Auth failures
here are *observable*, not hypothetical: `boot-prepare.mjs:7-10` records claude's measured
"Not logged in · Please run /login"; the profile records `gemini -p` blocking on an
interactive OAuth prompt (killed at 90 s). A dispatch that dies at readiness with one of
these recognised signatures appends `{cli, model, at, signature_id}` to a fixed-literal
`auth-negative.json` under `DISPATCH_STATE_DIR`. Signature ids, never captured screen text.

**Alternative auth paths, keyed to context.** Provider API-key **names** (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`) count as an alternative
`artifact_present` path — the **name only**, never the value, never a hash. Recorded with the
measured caveat that an API key does **not** imply the interactive CLI path works
(`boot-prepare.mjs:7-10`: claude's `--bare` is auth-incompatible with OAuth env).

**No paid or active auth calls by default.** No auth probe runs in the dispatch path, ever.
Measured cost if one did: claude 9 s, codex 8 s, grok 13 s, agy 6 s ⇒ up to ~36 s per
dispatch, each consuming the very session quota the caps protect; `gemini -p` blocks on an
interactive prompt. `--preflight-auth` is **operator-initiated, out of band**, uses each
CLI's cheapest local auth-status command where one exists, and records `unknown` — never a
paid call — where none exists.

**Credential rule:** contents are never read, hashed, logged or passed to the classifier.
Only `present｜absent`, an mtime, a key *name*, and a signature id reach the ledger.

---

## 5. Deterministic decision order

```
 1. validate declared request (§3.2) ── invalid ──> router exit 2 => dispatch exit 4
 2. parse profile ── invalid ──> EMERGENCY CANDIDATE SET (§8.5), which then
                                  traverses G1..G5 exactly like any other set
 3. build candidates from profile `models`
 4. G1 prohibited / G2 installed / G3 capability / G4 auth
       each candidate gets {verdict, evidence_kind, evidence_at}; a `fail` excludes,
       with the gate named
 5. eligible = no `fail`;  empty ⇒ DEFER (§8.6), never a constant
 6. ORDER eligible by T1..T4  ──>  tie_set = candidates equal through T4
 7. |tie_set| >= 2 AND tie-break enabled ?  ──> bounded LLM over tie_set only (§6)
 8. LLM absent/disabled/rejected ⇒ resolve tie_set by T5, then T6
 9. emit decision + ordered fallbacks + ledger
       ↓ dispatch-side
10. G5: walk the order; the first candidate that WINS THE CAPACITY TRANSACTION (§8.3) is
    dispatched
11. none wins, or occupancy cannot be established ⇒ DEFER (§8.4/§8.6). NEVER a constant.
```

### 5.1 The comparator, and why the tie-break is reachable

v1 made T6 = profile declaration order a **total** tier, so "tied at every tier" was
impossible and the LLM branch was dead code. Fixed by splitting the tiers:

**Substantive tiers (define the tie set):**

| Tier | Criterion |
|---|---|
| **T1** | hard `--require` satisfaction: all `pass` > any `unknown` (unknown already blocked at G3; T1 covers soft-mode variants) |
| **T2** | fitness class on `task_kind`, one ordered enum — `best_for ∧ ¬avoid_for` **>** `¬best_for ∧ ¬avoid_for` **>** `best_for ∧ avoid_for` **>** `¬best_for ∧ avoid_for` |
| **T3** | `--complexity` floor: at `high`, `evidence: unmeasured` rows rank below all others |
| **T4** | the `--prefer` axis (§5.2) |

**Resolution tiers (applied only when the LLM does not decide):**

| Tier | Criterion |
|---|---|
| **T5** | auth evidence `verified` > `artifact_present` > `unknown`; then model evidence `measured` > `claimed` > `ceiling-from-*` > `unmeasured` |
| **T6** | profile declaration order — **total**, so a decision is always reached |

**T2 is one enum, not two tiers.** v1 ranked `best_for` before `avoid_for`, which let a
candidate the profile explicitly warns against outrank a neutral one. An explicit
"avoid" is a stronger authored signal than an explicit "best"; the enum encodes exactly
that and is total on the dimension.

**Reachability:** the LLM is invoked iff two or more candidates are equal on T1–T4 — e.g.
two CLIs both listing `implementation` in `best_for`, neither in `avoid_for`, equal on the
preference axis. This is common with a 4-model profile; it is **not** the normal path.
Expected frequency is **unmeasured** and is one of the things shadow mode counts (§10.4).

### 5.2 Making `--complexity` and `--prefer` operative

v1 exposed `complexity` and never used it — a reviewer-flagged dead input. Both are now
load-bearing, or they would be removed:

* **`--complexity`** does two things: it supplies the **default** for `--prefer`
  (`low`→`cost`, `medium`→`capability`, `high`→`capability`), and it sets **T3**'s evidence
  floor (`high` demotes `unmeasured` rows). An explicit `--prefer` overrides the first; T3
  is unconditional.
* **`--prefer`**: `cost` → `cost_rank` ascending; `latency` → `latency_rank` ascending;
  `capability` → count of **soft `--prefer-tool` tokens** present in `cli_caps[cli]`,
  descending. Soft tokens exist precisely so `capability` has a non-degenerate metric; with
  no `--prefer-tool` given, T4 is a no-op and the tie set grows — which is correct, and is
  what makes the tie-break reachable.

No floats, no weights. The ledger records the tier at which each loser lost.

---

## 6. Bounded LLM tie-break

* **Invoked only** when `|tie_set| ≥ 2` (§5.1) **and** `--llm-tiebreak` /
  `AIGENTRY_ROUTER_LLM_TIEBREAK=1`. Off in `legacy` (which keeps today's behaviour verbatim)
  and default-off in `shadow` (§10.2).
* **Allowlist = the tie set only** (typically 2–3), never all four. An out-of-set answer is
  rejected as today (`:84`).
* Call unchanged: Haiku, `--max-turns 1`, JSON-only system prompt, no tools, no MCP,
  `MAX_THINKING_TOKENS=0`, `CLAUDE_EFFORT` deleted, 15 s timeout, SIGKILL, 1 MB buffer,
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
* **Confidence floor** (closes D3): `AIGENTRY_ROUTER_MIN_CONFIDENCE`, default **0.6**.
  Below floor ⇒ answer discarded, T5/T6 resolve the tie,
  `llm: {invoked:true, accepted:false, rejection:"below_floor", confidence:c}`.
  **0.6 is an uncalibrated policy starting value. It is not evidence of reliability and no
  claim of reliability is made for it.** Its only justification is direction: rejecting
  demotes to the deterministic order, which is the safe side. Calibration requires the
  confidence distribution that §10.4 collects; until then the number is a placeholder.
* Every failure mode — non-zero exit, timeout, unparsable, out-of-set, missing or
  non-finite confidence — falls to T5/T6. Never to a constant.
* Prompt carries the **tie set's own rows** plus their `best_for`/`avoid_for`, the structured
  request, and the bounded advisory prose — not the 8309 B profile body.
* The user has approved deterministic-first with an optional LLM; this section specifies it
  and does not re-ask.

---

## 7. Decision object and selection ledger

### 7.1 stdout (unchanged envelope, additive fields)

```jsonc
{"cli":"codex","model":"gpt-6-astra","label":"gpt-6-astra",
 "decided_by":"rules",                 // legacy: "llm" | "table"
 "reason":"T2 best_for:implementation",
 "confidence":1,
 "candidates":[ … suitability order … ],
 "ledger_ref":"<sha256-12 of the ledger record>"}
```

### 7.2 The ledger record

```jsonc
{
  "schema": 1,
  "decided_at": "2026-09-08T13:15:57Z",
  "profile": {"version": 3, "measured_at": "2026-09-05", "sha256_12": "a937791c86e5"},
  "request": {"role":"coder","task_kind":"implementation",
              "requires":["worktree"],"prefer_tools":["mcp"],"prohibits":[],
              "complexity":"medium","prefer":"capability",
              "requirements_source":"declared",
              "ref_bytes_total":8757,"ref_bytes_sent":8757,"truncated":false},
  "candidates": [
    {"label":"gpt-6-astra","cli":"codex","verdict":"eligible",
     "gates":{"prohibited":"pass","installed":"pass","capability":"pass",
              "auth":"artifact_present","capacity":"at_cap"},
     "evidence_at":"2026-09-08T13:15:57Z","lost_at_tier":null},
    {"label":"gemini","cli":"gemini","verdict":"excluded","excluded_by":"capability",
     "detail":"required token 'worktree' not in cli_caps[gemini]","evidence_at":"…"}
  ],
  "chosen": {"label":"opus-5","cli":"claude","model":"claude-opus-5[1m]","tier":"T4"},
  "tie_set": ["opus-5","grok-4.6"],
  "fallbacks": ["grok-4.6"],
  "llm": {"invoked":true,"accepted":false,"rejection":"below_floor","confidence":0.41,"latency_ms":7100},
  "capacity": {"codex":{"live_total":1,"live_workers":0,"reserved":0,"cap":2,"counting":"total"},
               "claude":{"live_total":2,"live_workers":2,"reserved":1,"cap":4,"counting":"total"}},
  "mode": "production",
  "shadow": null
}
```

Closes D9. **Bounds and privacy, enforced in code:**

* ≤ **4096 B** serialized; over budget ⇒ drop `detail` strings, then collapse excluded
  candidates to `{label, excluded_by}`, then set `ledger_truncated: true`.
* `candidates` length ≤ profile model count.
* **Never present:** ref contents, absolute ref path (only `path.basename`), env values,
  credential contents or values, API-key values, captured screen text, worktree paths,
  raw classifier stdout. `llm.reason` is task-derived text: **local telemetry only**, capped
  at 500 chars as today, never in the queue note.
* Transport is the existing `bin/emit-telemetry.mjs --helper dispatch`, whose failures are
  already swallowed (`:13-15`) — the ledger must never fail a dispatch.
* Queue-note stamp stays one line: `cli=codex/gpt-6-astra by=rules tier=T2`, or
  `by=rules-capped capped_cli=codex`, or `deferred=<reason>`.

**Transport schema is NOT frozen by this revision.** §16 lists what must be settled first;
the freeze is a gate at the start of implementation wave W3, not a property of this document.

---

## 8. Capacity: a serialized count-and-claim transaction

### 8.1 Where G5 runs

Dispatch-side, in `applyCliCap`, walking the router's ordered candidates — the *same*
suitability order (§5), not the role-table order. `EMERGENCY_ROUTE` is **removed from the
fallback path entirely**; §8.5 replaces it.

### 8.2 Worker-vs-orchestrator accounting — REVERSED from revision 1

**Decision: today's counting — orchestrator row included — is PRESERVED as the default.**

Revision 1 recommended excluding the orchestrator to recover a slot. That was wrong on the
evidence: `AIGENTRY_CLI_CAP_CODEX=2` is a **quota decision the user made** (`~/.env:36`),
and nothing in the repo establishes it was meant as a worker-only budget. Changing the
denominator to gain a slot silently re-interprets the user's limit. Revision 2 does not.

What changes is **visibility, not policy**: every ledger and every cap message reports
`live_total`, `live_workers` and `counting: "total"｜"workers"`. The distinction is already
computable — a worker row is one whose `command` is a guard-launcher path, i.e. `cliKindOf`
had to read an `exec -a` line (`cli.ts:461-465`) — and is currently discarded.

`AIGENTRY_CLI_CAP_COUNT=total｜workers` exists, defaults to `total`, and **is never changed
automatically**. Switching it is a user capacity decision, listed in §15 Q2 with the
evidence needed to make it. Closes D8 as an observability defect; leaves the policy open.

### 8.3 The capacity transaction (replaces v1's per-sid `O_EXCL` design)

**v1's design was wrong and is withdrawn.** Per-sid `O_EXCL` files give mutual exclusion on
a *filename*, not on the *count*: N distinct sids create N distinct files and every one
succeeds, so simultaneous starts all pass. It also violated a documented invariant —
`state_dir()`'s accepted Snyk exception (`bin/dispatch-registry.py:77-100`) rests explicitly
on "every filename under this directory is a FIXED LITERAL … no sid … is ever interpolated
into a path". A per-sid filename would have broken the rationale that exception was granted on.

**Replacement: one fixed-literal slot file, mutated under the repository's existing
exclusive lock.**

* **Files** (both fixed literals under `DISPATCH_STATE_DIR`): `cli-capacity.json` and its
  stable sibling `cli-capacity.json.lock`.
* **Primitive** — the `_Lock` class (`bin/dispatch-registry.py:163-194`): `flock(LOCK_EX)`
  on a stable sibling inode (never the data inode, which `rename` replaces), 0.05 s poll,
  `LOCK_TIMEOUT_S = 10.0` deadline. Commit uses the same
  temp→fsync→rename→dir-fsync as `commit()` (`:255-292`).
* **Operations**, new subcommands on `bin/dispatch-registry.py` (a **different file**, so
  `SCHEMA_VERSION` and `validate()` are untouched):
  * `reserve-cli --cli K --sid S --live-sids-json '[…]' --cap N --ttl T`
  * `release-cli --cli K --sid S`
  * `sweep-cli-reservations`
* **Count and claim are one critical section.** Inside the lock: load, reap expired, compute
  `occupancy(K) = | live_sids(K) ∪ reserved_sids(K) |`, and grant iff `occupancy < cap`,
  writing the reservation in the same committed generation. There is no window between
  counting and claiming.
* **Double counting is structurally impossible**: occupancy is the **union of sids**, so a
  session that is both live and reserved counts once. This is why reservations are keyed by
  sid, and why the live *sid list* — not a live *count* — is what the caller passes in.
* **Staleness, bounded and named.** The live sid list is a snapshot taken immediately before
  the call. A session that appeared after the snapshot is still counted if it holds a
  reservation, and every dispatch-spawned session does. The only escapees are sessions
  started **outside dispatch** (orchestrator boot, an operator's manual `telepty`) during the
  window; over-admission is bounded by that count, and it is exactly the population no
  reservation protocol can see. Stated, not hidden.
* **TTL sized from the measured startup budget** (§1.7). A reservation must survive
  claim→registration, ≤ 180 s. Default `AIGENTRY_ROUTER_RESERVATION_TTL_S = 600` (3.3×
  headroom); it is a **crash backstop, not the release mechanism**. Reaping a live
  reservation emits telemetry `reservation_reaped` with the sid — a reap is a defect signal,
  never routine.
* **Release paths, all three:**
  1. **Normal** — after `beginDelivery` returns `proceed`; the session is a registered
     telepty row by then and counts itself.
  2. **Failure** — every `die()`/`process.exit()` path after a claim, via one `try/finally`
     around the post-claim region plus a `process.on("exit")` handler. A release is
     idempotent.
  3. **Crash** — TTL reap, plus `sweep-cli-reservations` at the start of every
     **production-mode** dispatch (§10.3 — never in legacy or shadow).
* **Expiry during startup** is therefore a *reported* condition, not a silent one: if a
  reservation is reaped while its sid has not yet registered, telemetry records it and the
  slot returns to the pool. That is the correct trade (a stuck spawn must not hold a slot
  forever) and it is observable.

### 8.4 Occupancy or storage unavailable ⇒ bounded defer, not fail-open

Revision 1 kept §9's "a counter must never block dispatch" fail-open. **A hard cap that
fails open is not a hard cap.** Revision 2 makes the behaviour mode-dependent and explicit:

| Condition | `legacy` | `shadow` | `production` |
|---|---|---|---|
| `telepty list` unreadable (occupancy unknown) | fail-open (today's behaviour, unchanged) | log only | **defer, exit 10**, reason `occupancy-unknown` |
| capacity file unreadable / lock timeout (`LOCK_TIMEOUT_S = 10`) / write failure | fail-open | log only | **defer, exit 10**, reason `capacity-storage-unavailable` |

The defer is **bounded and observable**: it is a single dispatch attempt that ends in a named
exit code, a telemetry event and a queue-note stamp. It never blocks, sleeps or retries
internally. §9's principle is preserved where it belongs — in `legacy`, which is what ships
on merge — and is deliberately not carried into a mode that advertises hard caps.

`AIGENTRY_ROUTER_CAPACITY_FAIL_OPEN=1` restores fail-open inside production for an operator
who accepts it; it is recorded in the ledger as `capacity_fail_open: true` on every affected
decision.

### 8.5 Explicit `--cli`, prohibitions, and the profile/router-failure arm

Three v1 gaps, all closed:

* **`--cli` selects a model; it is not authorization to exceed a limit.**
  * A **prohibition** (`--prohibit`, profile `prohibit:`) is **never** overridable. `--cli`
    naming a prohibited target is a dispatch usage error, **exit 4**, in every mode
    including `legacy` — a prohibition is the one contract that has no legacy exemption,
    because there is no prior behaviour to preserve (no prohibition mechanism exists today).
  * A **hard cap**: `legacy` keeps today's behaviour verbatim (one WARNING, then spawn) —
    that is what "preserve legacy behavior only in legacy mode" means. In `production`,
    `--cli` at cap **defers** unless `--override-cap` is passed. `--override-cap` requires
    an accompanying `--override-reason <text>`, is recorded in the ledger as
    `cap_override: {by:"operator", reason}`, stamped into the queue note, and emitted as its
    own telemetry subtype. A deliberate override is documented as an override, not disguised
    as a routing decision.
* **Profile or router failure traverses the same gates.** The emergency arm no longer
  short-circuits to a constant. On profile-invalid or router-unavailable, dispatch builds an
  **emergency candidate set** — the compiled-in `EMERGENCY_ROUTE` plus any candidates it can
  still name — and runs it through **G1, G2, G4 and G5 exactly like any other set**
  (G3 is skipped: with no profile there are no `cli_caps` to check, and that fact is
  recorded as `capability: "unknown-no-profile"`). If nothing survives, it defers. Closes
  D5a **and** D5b: there is no path left that spawns over a cap.

### 8.6 All-ineligible / all-capped ⇒ durable defer

* Exit **10**, `DISPATCH_CAPACITY_DEFERRED`. 2,3,4,5,6,7,8,9 are taken (measured in
  `src/dispatch/cli.ts`).
* Evaluated **before any spawn-side side effect** — same position as the Rule 34 task gate.
* **What a defer does and does not write** (v1 contradicted itself here; §16-8):
  * **Does not write:** workspace, git guard, worker launcher, boot-prepare shadow home,
    registry row, inject, reservation.
  * **Does write, because durability is the point:** one telemetry event
    (`dispatch_deferred`, carrying the ledger) and one queue-note stamp via the existing
    `taskLedgerUpdate` writer (same temp+rename+indent-2 shape as #1110):
    `| deferred 2026-09-08T13:15:57Z reason=all-candidates-capped codex=1/2 claude=4/4`.
* **Task `status` is deliberately unchanged.** The Rule 34 gate accepts
  `pending|queued|in_progress|delegated|blocked-by-observation` (`cli.ts:655-660`) and
  refuses `blocked`; setting `blocked` would wedge the retry the defer exists to invite.
* **Retry trigger:** the orchestrator re-dispatches when occupancy drops. No new mechanism.
* **Out of scope:** any `--wait-for-capacity` blocking mode — a sleeping dispatch holds an
  orchestrator turn hostage.

---

## 9. State transitions

```
                    ┌───────────────┐
      dispatch ───► │ ROUTE_PENDING │
                    └───────┬───────┘
  request invalid (router exit 2) ┴──> DISPATCH USAGE ERROR (exit 4), nothing written
                            │
              profile bad / router down
                            ├──────────────> EMERGENCY CANDIDATE SET ──┐
                            ▼                                          │
                    ┌───────────────┐                                  │
                    │ RULES_ORDERED │                                  │
                    └───────┬───────┘                                  │
          |tie_set| >= 2 ───┤                                          │
                            ▼                                          │
                    ┌───────────────┐                                  │
                    │ LLM_TIEBREAK  │── reject ──> T5/T6 resolve       │
                    └───────┬───────┘                                  │
                            ▼                                          ▼
                 ┌──────────────────────────────────────────────────────┐
                 │ CANDIDATES_ORDERED  (ledger emitted)                 │
                 └───────────────┬──────────────────────────────────────┘
                                 ▼  walk order; per candidate, ONE locked
                                    count+claim transaction (§8.3)
        ┌────────────────────┐                   ┌────────────────────────────┐
        │ RESERVED(cli, sid) │                   │ DEFERRED (exit 10)         │
        └─────────┬──────────┘                   │ telemetry + queue note only│
                  ▼                              └────────────────────────────┘
     spawn → register → ready → beginDelivery → RELEASE
                  │
                  ├── failure after claim ──> RELEASE (finally/exit handler) → exit code
                  └── crash ────────────────> TTL reap + telemetry(reservation_reaped)
```

**Invariants.** (i) Occupancy is counted and claimed inside one lock, never across it.
(ii) Occupancy counts a sid once, whether live, reserved, or both.
(iii) Every claim ends in release or a *reported* reap. (iv) `DEFERRED` performs no
spawn-side write; its two records are telemetry and the queue note, and that is the
durability it exists to provide. (v) No path reaches spawn without a won transaction, an
operator `--override-cap`, or an explicitly recorded `capacity_fail_open`.

---

## 10. Migration, shadow, rollout, rollback

### 10.1 `AIGENTRY_ROUTER_MODE`

| Mode | Decision used | New code runs | Writes anything new? | Default |
|---|---|---|---|---|
| `legacy` | today's | no | no | **yes, on merge** |
| `shadow` | today's | yes, **read-only** | one append-only log line | no |
| `production` | new | yes | reservations, defers, ledger | no |

**No automatic activation.** Merging changes nothing observable (A1 asserts byte-identical
legacy stdout). The user flips the variable.

### 10.2 Shadow is read-only — enumerated

v1 claimed "no side effects" while also describing reservations and sweeps. The contract is
now explicit about every write:

* **Does not:** claim or release a reservation, sweep or reap reservations, write a defer,
  write a queue note, change the dispatched CLI, or call the LLM (unless
  `AIGENTRY_ROUTER_SHADOW_LLM=1`, off by default — an LLM call costs money and quota).
* **Reads only:** profile, `PATH`, auth artefact existence, `telepty list`, and a
  **read-only view** of `cli-capacity.json` (no lock taken, no write). G5 is evaluated
  **hypothetically**: "would this candidate have won a slot", recorded as
  `capacity_hypothetical`, never claimed.
* **Writes exactly one thing:** one line appended to `state/router-shadow.jsonl`.
  * Concurrency-safe by construction: opened `O_APPEND|O_CREAT`, one `writeSync` of a
    single line capped at **4096 B**. `O_APPEND` makes the offset update atomic; a single
    small write is not interleaved in practice on darwin/linux. **Ceiling stated:** this is
    not a guarantee for arbitrarily large writes, which is why the line is capped, and a
    malformed line is a logging defect, never a dispatch failure.
  * Log write failures are swallowed. Shadow must never affect a dispatch.

### 10.3 Sweeping happens only in production

v1 said reservations are "swept by the next dispatch in any mode", contradicting §10.2.
Corrected: `sweep-cli-reservations` runs **only** at the start of a `production`-mode
dispatch, and from the operator's explicit `bin/dispatch-registry.py sweep-cli-reservations`.
`legacy` and `shadow` never write to capacity state.

### 10.4 What shadow measures — and what it cannot

One line per decision: `{at, sid, role, task_kind, requirements_source, legacy:{label,decided_by},
new:{label,decided_by,tier,tie_set_size}, agree, llm_would_fire, confidence,
capacity_hypothetical, added_latency_ms, new_path_error}`.

Measures: **agreement rate**; **availability** (`new_path_error` must be 0); **added
latency** (the new path is local-only in shadow, budget ≤ 200 ms p95); **tie-break
frequency** — i.e. how often §5.1's tie set actually has ≥ 2 members, which is currently
unmeasured; and the **confidence distribution** needed to calibrate §6's placeholder floor.

**Cannot measure:** whether the chosen worker did the job better. Shadow compares
*classifications*, not outcomes. `outcome.state` is pinned to `"unknown"` with no writer
(`bin/dispatch-registry.py:228-231`), so no outcome-linked comparison — and therefore no
learning, tuning or weight fitting — is possible or permitted. **Classification agreement is
not evidence of suitability**, and a high agreement rate means only that the new path
reproduces the old one, which is a regression check, not a quality claim.

### 10.5 Gate to production — and what "100 decisions" may not be

1. ≥ **100 decisions from live dispatches**, not fixture runs. Fixture decisions validate
   correctness (that is §12's job); they are **not** representative evidence of routing
   behaviour, because the fixture profile, roles and refs are chosen by the test author.
   A shadow report must state its live/fixture split, and a fixture-only sample fails this gate.
2. Zero `new_path_error`.
3. p95 `added_latency_ms` ≤ 200.
4. Every disagreement class named and explained in writing.
5. Explicit user approval of the §15 open decisions that are still open.

### 10.6 Rollback, including with reservations in flight

Unset the variable. Because `legacy` and `shadow` never read or write capacity state, a
rollback from production leaves reservations that are simply **ignored**; they expire by TTL
(≤ 600 s) and are removed by the next production dispatch or by the operator's explicit
sweep. No revert, no migration, no wedged state. The only visible residue is a
`cli-capacity.json` whose reservations are stale, which the sweep subcommand prints and clears.

### 10.7 Retention

`router-shadow.jsonl` capped at 10 MB / 30 days, oldest-first truncation on write.
`cli-capacity.json` holds only unexpired reservations, bounded by candidate count ×
concurrent dispatches. `auth-negative.json` entries expire at
`AUTH_NEGATIVE_TTL_S` (1800 s) and are pruned on write. Telemetry retention is whatever
`dist/src/telemetry/logger-emit.js` already does — no new retention system (Article 1).
Whether `bin/dispatch-cleanup-scheduler.sh` should own these sweeps instead is
**unmeasured** (§14).

---

## 11. Security review notes for the implementer

* **No new argv→`fs` read path**, so the accepted CWE-23 finding at
  `bin/model-router.mjs:25-29` is not widened. `--ledger` is a new argv→`fs` **write** and
  must be named explicitly in the Snyk review.
* **All capacity/auth state filenames are FIXED LITERALS** (`cli-capacity.json`,
  `cli-capacity.json.lock`, `auth-negative.json`), preserving the exact rationale on which
  `state_dir()`'s accepted Snyk exception was granted (`dispatch-registry.py:77-100`). No
  sid, label, cli kind or ref value is ever interpolated into a path.
* Classifier seam stays env-only (`AIGENTRY_ROUTER_CLASSIFIER`), preserving the CWE-78
  posture of `:69`. No new `spawnSync` argv from user data.
* Credentials: existence, mtime, and key *names* only. Never contents, never values, never
  hashes. No auth probe in the dispatch path; `--preflight-auth` is operator-initiated and
  makes no paid call by default.
* Task text remains data; the tie-break's narrowed allowlist reduces what a prompt-injected
  ref could reach.
* `bin/snyk-scan.sh` (or `snyk_code_scan`) before DONE on every code unit; fix → rescan →
  repeat until zero **new** findings. Pre-existing accepted findings are not silenced.

---

## 12. Acceptance criteria

All new guards are `.test.ts` under `tests/dispatch/` (auto-collected by
`scripts/run-tests.mjs`, hence in `npm test` and CI). **Test ids are provisional**: the
measured maximum today is T150, and §13 requires re-checking at branch time.

**Ordering rule (reviewer issue 9): every R-guard is written first and demonstrated RED
against unmodified `main`.** A guard that has only ever been seen green after a fix is not
evidence the defect existed.

| ID | Acceptance criterion | Closes | Guard |
|---|---|---|---|
| A1 | `--mode legacy`, no new flags ⇒ **byte-identical** stdout to `bf127a5` for all 8 roles × {ref, no-ref} | regression | T151 |
| A2 | Missing/malformed profile ⇒ emergency **candidate set** that traverses G1/G2/G4/G5; with claude at cap it **defers**, not spawns | D5b | T151 |
| A3 | 9 KB ref sent whole; 20 KB ref sends head+tail with the marker; ledger reports `truncated:true` and exact byte counts | D1 | T151 |
| A3b | **Middle-only mandatory tool**: a `--require` token present only in ref prose is NOT inferred; with `requirements_source:"none-declared"` and an oversized ref, production **defers** with `requirements-undeclared-oversized-ref` | §3.3 | T151 |
| A3c | **Late prohibition**: a prohibition in the last 500 B of an oversized ref is not honoured from prose; declared `--prohibit` is honoured absolutely and `--cli` cannot override it (**exit 4**, in every mode) | §3.3, §8.5 | T151 |
| A4 | Budget boundary splitting a multi-byte character ⇒ **no U+FFFD** | D2 | T151 |
| A5 | `confidence:0.3` with floor 0.6 ⇒ deterministic resolution, `llm.accepted:false`, `rejection:"below_floor"`; confidence present in telemetry | D3 | T152 |
| A6 | Tie-break fires **iff** `|tie_set| ≥ 2` on T1–T4; allowlist = tie set only; a T5/T6-separable pair does **not** invoke it | §5.1 | T152 |
| A7 | `--require worktree` excludes a candidate whose `cli_caps` omits it, `capability:"unknown"`, `excluded_by:"capability"` — unknown is not pass | D6 | T152 |
| A7b | `--complexity high` demotes an `evidence:"unmeasured"` row at T3; `--prefer cost` reorders by `cost_rank`; `--prefer-tool` changes T4 order — **each input demonstrably changes an outcome** | §5.2 | T152 |
| A8 | Uninstalled CLI excluded at G2 before any spawn; ledger names the gate | D6 | T152 |
| A8b | A **fresh** `known_failed` auth record (< 1800 s) excludes that `(cli, model)`; an expired one does not; `artifact_present` alone never counts as authenticated; an API-key **name** is recorded without its value | §4.4 | T152 |
| A9 | Capped head falls to the **next candidate in suitability order**; `legacy` explicit `--cli` at cap warns once and spawns; `production` explicit `--cli` at cap **defers** unless `--override-cap --override-reason` | D4, §8.5 | T153 |
| A10 | **All** candidates capped ⇒ exit 10; no workspace, no registry row, no inject, no reservation; queue note stamped; telemetry `dispatch_deferred` | D5a | T153 |
| A11 | Router unavailable **and** claude at cap ⇒ exit 10, not an over-cap spawn | D5b | T153 |
| A12 | **Simultaneous** start: N=8 dispatch processes released from a common barrier against 1 free slot ⇒ **exactly one** wins the transaction, 7 defer; repeated 20× with zero over-admission. Sequential-only testing does not satisfy this criterion. | D7 | T154 |
| A12b | Union counting: a sid that is both live and reserved is counted **once**; release makes the slot immediately reusable; a TTL-expired reservation is reaped **and** emits `reservation_reaped` | §8.3 | T154 |
| A12c | Release on failure: a dispatch that dies after a claim (spawn failure, readiness timeout, `die()` at any post-claim site) releases its reservation; a killed process's reservation is reaped by TTL | §8.3 | T154 |
| A13 | `counting:"total"` is the default and includes the orchestrator row; `AIGENTRY_CLI_CAP_COUNT=workers` excludes it; **both** counts appear in every ledger and cap message regardless | D8 | T153 |
| A14 | Occupancy/storage unavailable ⇒ `legacy` fails open, `production` defers with the named reason; `AIGENTRY_ROUTER_CAPACITY_FAIL_OPEN=1` restores fail-open and records it | §8.4 | T154 |
| A15 | Ledger ≤ 4096 B; contains no ref text, no absolute ref path, no env value, no credential content, no API-key value, no screen text | D9 | T155 |
| A16 | Shadow is **read-only**: no reservation created/released/swept, no defer, no queue write, dispatched CLI unchanged, exactly one jsonl line appended; p95 added latency ≤ 200 ms over 100 fixture decisions **labelled as fixture, not live** | §10.2 | T155 |
| A17 | **The real profile, through the real parser**: the shipped `docs/model-profiles/…` file, loaded by `bin/model-router.mjs` itself (not a re-implementation), parses with no stderr for all roles; every model row has `best_for`, `cost_rank`, `latency_rank`, `evidence`; `cli_caps` covers every referenced cli; `profile_version` is an integer; `*_rank` values are integers 1..9 | D10, D11 | T156 |
| A18 | Parser negative cases, executed through the real parser: a **multi-line** model row, a value containing ` #`, an unknown top-level key, and a non-integer `cost_rank` each fail **loudly** (named error) rather than degrading every dispatch to emergency Opus | D11 | T156 |
| A19 | Router **exit 2** (invalid request: unknown flag, unknown token) maps to dispatch **exit 4**, not to the emergency candidate set; any other non-zero router exit still takes the gated emergency arm | §3.2 | T156 |

Hermeticity is inherited from `model-router-fixtures.ts` (#1109 ambient scrub). The fixture
gains `DISPATCH_STATE_DIR`-scoped capacity/auth/shadow paths, a mode knob, and a
**barrier-based multi-process launcher** for A12. The suite tripwire
(`run-all.sh:118-147`) and the fixture-sid convention still apply: **no guard may address
the real `orchestrator` sid**.

**Test scale is set by risk, not by symmetry:** concurrency (A12/A12b/A12c) and auth
(A8b) get the most cases because they are the two areas where a wrong answer is silent and
expensive; requirement completeness (A3b/A3c) gets explicit middle-and-tail cases because
that is where v1's design failed.

---

## 13. Implementation split — file ownership and edges

Ownership is **per file**. v1 bundled units that are not one task; corrected here.

| ID | File(s) | Change | Owner | Depends on |
|---|---|---|---|---|
| **F2** | `bin/model-router.mjs` | parser whitelist + `cli_caps` section + `*_rank` coercion/validation; multimap argv; §3 input; §4 gates; §5 comparator; §6 tie-break; §7 ledger; `--mode` | coder-A | — |
| **F1** | `docs/model-profiles/model-routing-profile.md` | §4.1 front matter. **Must land in the same branch/commit as F2** (§1.12: landing alone routes every dispatch to emergency Opus) | coder-A | **F2 (edge REVERSED from v1)** |
| **F5a** | `tests/dispatch/fixtures/model-routing-profile.md` | fixture profile gains the §4.1 shape | coder-A | F2 |
| **F5b** | `tests/dispatch/model-router-fixtures.ts` | capacity/auth/shadow paths, mode knob, barrier launcher | tester | F2 contract |
| **F3a** | `bin/dispatch-registry.py` | **NEW**: `reserve-cli` / `release-cli` / `sweep-cli-reservations` on `cli-capacity.json` using the existing `_Lock` + commit discipline. **`SCHEMA_VERSION`, `validate()` and `active.json` are NOT touched** | coder-B | — |
| **F3b** | `src/dispatch/cli.ts` | ordered fallback; remove `EMERGENCY_ROUTE` from the cap path; §8.2 dual counts; §8.3 claim/release; §8.4 defer; §8.5 override; §8.6 exit 10; ledger→telemetry | coder-B | F3a, §5/§7 contract |
| **F6** | `tests/dispatch/T151…T156-*.test.ts` | R1–R11 **red first**, then A1–A19 | tester | F5b; R-phase precedes F1/F2/F3 |
| **F7a** | `AGENTS.md:147` | rewrite the routing/cap paragraph; **remove the "→ Opus 5" tail** documenting deleted behaviour | coder-B | F3b |
| **F7b** | `src/dispatch/usage.ts` | exit 10, new flags, `--override-cap` | coder-B | F3b |
| **F8** | this spec | post-implementation "measured" appendix | architect | all |

**Edges:** `F2 → {F1, F5a}` (reversed from v1 — see §1.12); `F3a → F3b`;
`F5b → F6`; `F3b → {F7a, F7b}`. F2 and F3a/F3b are parallel-safe against each other:
disjoint files, communicating only through the §5/§7 contract — **which §16 says is not
frozen until the open items close.**

**Cross-task coordination (not a zero-shared-file promise).** #1136 may need
`src/dispatch/cli.ts` for a shared task-ledger transaction and owner registration. That file
is therefore **serially owned**: F3b and #1136's change must not be in flight simultaneously.
The order is a scheduling decision for the orchestrator; this spec asserts only that they are
**not parallel-safe** and that whichever lands second rebases onto the first. `F3a`
(`dispatch-registry.py`) is likewise a shared file if #1136 touches the ledger transaction —
same rule.

**Builder step (required).** F3b is TypeScript; production runs `dist/src/dispatch/cli.js`
and `npm test` refuses a stale `dist/` (`scripts/run-tests.mjs:37-47`). `tsc -p .` must run
after F3b and before any guard executes, and again before merge. F1/F2/F5a are `.mjs`/`.md`
and need no build. F3a is Python — no build, but it is invoked by the TypeScript, so its
guards need the built tree.

**Wave order (red-first):**

1. **W1 — reproduction.** tester writes R1–R11 against unmodified `main` and demonstrates
   them **RED**. Nothing else changes. This is the evidence the defects exist.
2. **W2 — router.** F2 + F1 + F5a in one branch (never split). coder-A.
3. **W3 — capacity.** F3a then F3b. coder-B, serialized against #1136 on
   `src/dispatch/cli.ts`. builder runs `tsc -p .`.
4. **W4 — acceptance.** F5b + F6 (A1–A19) green; `npm test` + `bash tests/dispatch/run-all.sh`
   on a built tree.
5. **W5 — docs + scan.** F7a, F7b, Snyk on F2/F3a/F3b. Merge, landing in `legacy` mode.
6. **W6 — evidence.** operator flips `shadow`, collects ≥ 100 **live** decisions,
   §10.5 review, then `production`.

---

## 14. Measured vs unmeasured

**Measured for this revision** (all read-only; nothing executed that changes state):
current `main` `bf127a5` and its ancestry from `f268d34`; blob SHAs of all four measured
sources identical at both; source of `bin/model-router.mjs`, `src/dispatch/cli.ts`, the real
and fixture profiles, `bin/dispatch-registry.py` (incl. `_Lock`, `commit`, `validate`,
`state_dir`), `bin/emit-telemetry.mjs`, `scripts/run-tests.mjs`, `tests/dispatch/run-all.sh`,
`.github/workflows/ci.yml`, T138/T139/T140 + fixtures; `dist/src/dispatch/cli.js` agreement
with source; live `telepty list` at **13:15:57Z** (and the 12:35Z sample, labelled
historical); `AIGENTRY_CLI_CAP_CODEX=2` from `~/.env:36`; installed binaries for all five CLI
names; this task's original ref byte counts and cut position; exit codes in use; startup
budget constants (180 000 / 30 000 / 90 000 ms); `LOCK_TIMEOUT_S = 10.0`; highest existing
test id **T150**; and §1.12's parser behaviour, obtained by extracting the parser's regexes
verbatim and exercising them in isolation.

**NOT measured — this spec does not claim otherwise:**

1. **The parser evidence in §1.12 is static.** The regexes were exercised standalone; the
   router itself was **not** invoked (architect boundary). A17/A18 exist precisely to
   execute the real config through the real parser, and are the gate on §4.1's shape.
2. **Live classifier latency/quality.** No classifier run. The 6–9 s figure is carried from
   the profile's 2026-09-05 measurement.
3. **Tie-break frequency.** How often the T1–T4 tie set has ≥ 2 members with the real
   profile is unknown; §10.4 counts it. §6's floor of 0.6 is therefore an **uncalibrated
   placeholder**, and no reliability is claimed for it.
4. **Reservation-race frequency in the wild.** Never instrumented. §8.3 makes the claim
   atomic; it does not tell us how often the race fires today.
5. **Over-admission by sessions started outside dispatch.** Bounded and named in §8.3,
   never counted.
6. **Opus 5's own capability.** The profile's opus-5 numbers are Fable 5.1 ceilings by the
   profile's own admission. §4.1 makes that machine-readable; it does not fix it.
7. **grok's auth artefact path.** Inferred from convention, not verified on this host. F2
   must verify before relying on an `artifact_present` verdict for grok.
8. **Whether `bin/dispatch-cleanup-scheduler.sh` can own the new sweeps.** Not read.
9. **`--target` / `--retry-unknown` under the new code.** By inspection they never reach
   `resolveRoute`'s auto arm (`cli.ts:418-422`, `:1074`); untested.
10. **Adjacent, out of scope, mentioned not fixed (Rule 29):** `bin/session-probe.py` has
    `BANNERS`/`PROMPTS` entries for claude, codex and gemini but **none for grok**
    (`:17-30`), though `cli_kind()` recognises grok (`:162`). A router that routes more work
    to grok increases exposure to that asymmetry. Separate task; no edit made here.

---

## 15. Open policy decisions

**Q1 is closed.** The user approved deterministic-first with an optional LLM; §5 and §6
specify it and it is not re-asked.

* **Q2 — cap counting (§8.2).** Default is **unchanged**: the orchestrator row counts, as it
  does today. The question is whether the user's `AIGENTRY_CLI_CAP_CODEX=2` was a
  *provider-quota* decision (in which case counting the orchestrator is correct — it consumes
  the same quota) or a *worker-budget* decision (in which case `workers` is correct).
  **Nothing in the repo answers this; only the user can.** Evidence to decide with is now
  exposed in every ledger (`live_total`, `live_workers`). No automatic change either way.
* **Q3 — confidence floor.** Ship 0.6 as a placeholder and calibrate from §10.4's
  distribution, or ship the floor disabled until data exists? *Recommendation: ship 0.6* —
  rejection only ever demotes to the deterministic order, and the value is one env var.
  Either way it is **not** evidence of reliability.
* **Q4 — ref budget.** 16 KB covers the measured corpus with ~2× headroom. Note this is a
  **cost** knob only; §3.1 is what prevents requirement loss.
* **Q5 (new) — production fail-open (§8.4).** Should `production` ever fail open on unknown
  occupancy? Default is **no** (defer), with `AIGENTRY_ROUTER_CAPACITY_FAIL_OPEN=1` as the
  operator's opt-in. Confirm the default, since it changes §9's long-standing
  "a counter must never block dispatch" inside production mode only.
* **Q6 (new) — `--override-cap` (§8.5).** Confirm that an explicit operator override of a
  hard cap should exist at all, given that a prohibition is never overridable. Default as
  specified: it exists, requires a reason, and is recorded everywhere.

---

## 16. Reviewer issue matrix

| # | Issue | Resolution | Where |
|---|---|---|---|
| 1 | O_EXCL per-sid does not atomically claim a slot; A12 sequential vs R7 concurrent; double counting, expiry-during-startup, crash/release; no LOC arguments | v1 design **withdrawn**. Serialized count+claim in one `flock` critical section reusing `dispatch-registry.py`'s `_Lock` + commit discipline on a separate fixed-literal file. Union-of-sids counting removes double counting. TTL sized from the measured 180 s registration budget, as a crash backstop with a telemetry-emitting reap. Three release paths enumerated. A12 is **N=8 barrier-released processes × 20 repeats**. No line-count claim anywhere. | §0, §8.3, A12/A12b/A12c |
| 2 | Fail-open contradicts hard caps; `--cli` is not authorization; legacy only in legacy; profile/router failure must traverse the gates | Mode-dependent: fail-open stays in `legacy`, `production` **defers** with named reasons. Prohibitions never overridable. `--cli` at cap defers in production unless `--override-cap --override-reason`, recorded everywhere. Emergency arm now traverses G1/G2/G4/G5. | §8.4, §8.5, Q5, Q6 |
| 3 | Head+tail still loses the middle; requirements must be complete/validated first; absent extraction ≠ `require=[]`; oversized/ambiguous legacy input needs a bounded path; don't claim 16 KB solves it | Requirements moved to an **authoritative declared channel**; prose is advisory and never load-bearing. `requirements_source` distinguishes `declared` from `none-declared`. Oversized + undeclared ⇒ **defer in production**, or explicit `--accept-undeclared-requirements`. 16 KB is explicitly a cost knob only. Middle-only-tool and late-prohibition tests pinned. | §3.1, §3.3, A3b, A3c |
| 4 | Presence ≠ authenticated; need fresh known-failed exclusion, unknown policy, API-key/external alternatives, evidence keyed to CLI/model/tool; no Fable row-level inference; no secrets/paid calls | Four-valued evidence with `known_failed` (fresh, 1800 s) **excluding**, sourced from measured failure signatures. API-key **names** as an alternative path, with the measured `--bare` caveat. Capability moved to a **CLI-keyed `cli_caps`** section, structurally separate from model-quality rows. No probe in the dispatch path; `--preflight-auth` makes no paid call by default. | §4.1, §4.4, A8b |
| 5 | Preserve orchestrator-included counting by default; quota ≠ worker budget; expose both counts; don't auto-change | v1's recommendation **reversed**. Default `counting: total` — unchanged from today. Both counts exposed in every ledger and message. Switching is a user decision with the evidence now visible. | §8.2, Q2 |
| 6 | Make every input operative or remove it; matched-cap count is constant after filtering; final label tiebreak kills the tie; explain reachability and `avoid_for` vs `best_for`; 0.6 is uncalibrated | `complexity` now sets the `prefer` default **and** T3's evidence floor. `--prefer capability` ranks **soft `--prefer-tool`** matches, not the constant hard-filter count. Tiers split into substantive (T1–T4, define the tie set) and resolution (T5–T6), making the tie-break reachable. T2 is one ordered enum putting `avoid_for` above `best_for`. 0.6 declared an uncalibrated placeholder. | §5.1, §5.2, §6, A6, A7b |
| 7 | Shadow cannot claim no side effects while reserving/deferring/sweeping; need read-only evaluation, concurrency-safe logging, safe rollback with in-flight reservations; fixture ≠ live | Shadow's writes enumerated: **exactly one** `O_APPEND` line ≤ 4096 B, with the atomicity ceiling stated. G5 evaluated hypothetically, no lock, no write. Sweeping is production-only. Rollback safe because legacy/shadow never read capacity state. Gate requires ≥ 100 **live** decisions; fixture runs explicitly excluded. Agreement ≠ suitability, stated. | §10.2, §10.3, §10.5, §10.6, A16 |
| 8 | Reconcile "no I/O" vs ledger writes and "mode-off" vs any-mode sweep; verify the parser accepts the proposed front matter; freeze schema only after resolution | Defer's writes enumerated exactly (spawn-side: none; telemetry + queue note: yes, by design). Sweep is production-only. **Parser verified statically and the v1 shape FAILS** — multi-line rows and any new top-level key throw, degrading every dispatch to emergency Opus; §4.1 rewritten to a parser-verified single-line shape plus a minimal whitelist, and A17/A18 execute the real config through the real parser. Schema freeze declared a W3 gate, not a property of this document. | §1.12, §4.1, §7.2, §8.6, §10.3, A17, A18 |
| 9 | Per-file ownership; independently assigned test ids after checking the repo; scale tests to real risk; reproductions must be red before fixes | Ownership split to F1/F2/F3a/F3b/F5a/F5b/F6/F7a/F7b with corrected edges (**F2 → F1**, reversed). Highest existing id measured (**T150**); ids provisional, re-checked at branch time. Test weight concentrated on concurrency, auth and requirement completeness. **W1 is a reproduction-only wave**: R1–R11 demonstrated RED against unmodified `main` before any fix. #1136 named as a serial co-owner of `src/dispatch/cli.ts`; no zero-shared-file promise. | §1.8, §12, §13 |

---

## 17. Bottom line

Eleven measured defects, each with a reproduction that must be demonstrated red before its
fix lands. The capacity protocol is now a real serialized transaction built on the
repository's own lock rather than a filename trick; hard caps no longer fail open in the mode
that advertises them; requirements no longer travel through clippable prose; capability
evidence is separated from model-quality claims; the tie-break is reachable and every exposed
input changes an outcome; shadow is genuinely read-only; and the profile shape is now one the
existing parser can actually accept — a fact revision 1 got wrong in a way that would have
routed every dispatch to emergency Opus.

Still requires a new service, framework, dependency or schema migration: **nothing**.
Still requires user decisions before implementation: **Q2, Q3, Q4, Q5, Q6** (§15).
This document does not approve implementation.
