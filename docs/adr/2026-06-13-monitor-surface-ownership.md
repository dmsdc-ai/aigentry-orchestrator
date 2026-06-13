---
type: adr
status: PROPOSED
date: 2026-06-13
topic: deliberation monitor (전광판) surface ownership — cross-component boundary
task: tq#611
role: architect (design only — implementation is a separate coder task after approval)
worktree: /private/tmp/wt-611 (repo aigentry-orchestrator, branch wt/611-monitor-design, base 0b3db63)
relates_to:
  - docs/adr/2026-05-30-surface-ownership-boundary-verdict.md  # surface-DRIVING = orchestrator (SESSION surfaces)
  - docs/adr/2026-06-13-terminal-adaptor-contract.md            # #608 9-verb wh_open contract; verified split (conf 0.93)
  - docs/adr/2026-05-05-telepty-devkit-boundary.md              # cross-repo runtime-dependency reversal rejected
---

# ADR 2026-06-13 — Deliberation Monitor: Surface Ownership Across the deliberation↔orchestrator Boundary

- **Status**: PROPOSED (SPEC FIRST — Rule 24). **No code shipped in this ADR.** Implementation (if any) is a separate coder task after user/orchestrator approval.
- **Role**: architect (design/ADR only — does not modify production code; ⚠ no cmux build/restart performed, read-only analysis).
- **Question (cross-component, currently undecided)**: the deliberation 토론 monitor (전광판) is spawned by the **deliberation MCP itself** (osascript/tmux), bypassing the orchestrator's terminal adapter (`workspace-host.sh wh_open`). Does the verified "surface-DRIVING = orchestrator" boundary (ADR 2026-05-30 / #608) extend to the monitor, requiring deliberation to route through the orchestrator adapter — or is the monitor a different class of surface to which that rule does not apply?

---

## 0. TL;DR — Recommendation up front (§13)

**RECOMMEND Option C (status quo + #610).** Keep the deliberation monitor self-spawned by the deliberation component. The integration proposed by #611 is a **consistency nicety, not a requirement**, and the two integration options that would satisfy the "everything in cmux" aesthetic — (A) deliberation calls orchestrator's `workspace-host.sh`, (B) orchestrator owns the monitor surface — **both violate §9 (독립)** and add cross-repo coupling that the existing precedent (`2026-05-05-telepty-devkit-boundary.md`) already rejected.

The premise that the monitor is "a session surface that escaped the orchestrator adapter" is a **category error**: the #608/2026-05-30 ownership rule is scoped to **orchestrator-managed telepty _session_ surfaces** (a dispatched worker running `telepty allow --id`). The deliberation monitor is a **read-only viewport of deliberation's own internal state** — no telepty session, no stdin agent, no lifecycle the orchestrator reconciles. By the same verdict's own **creator=destroyer** principle, the component that *creates and owns the state* (deliberation) owns its read-only projection of it.

**If — and only if — the user specifically wants the monitor in the cmux foreground** (a cosmetic placement preference, not a functional gap), the single constitutional way to deliver that is **Option C+**: deliberation self-spawns into cmux by calling the **`cmux` CLI directly** (a terminal tool, not the orchestrator) when cmux is detected, with its current tmux/osascript path as the §17 fallback. C+ keeps deliberation owning its own viewport (§9 intact) and adds **no** runtime dependency on the orchestrator. This stakeholder-preference fork (C vs C+) is surfaced in the REPORT for sign-off.

---

## 1. Context — verified mechanism (file:line, not speculation)

### 1.1 How the monitor is spawned today (deliberation-internal)

On `deliberation_start`, deliberation spawns its own monitor:

```
index.js:1098-1101
  const tmuxOpened = spawnMonitorTerminal(sessionId);
  const terminalOpenResult = tmuxOpened ? openPhysicalTerminal(sessionId) : {opened:false, windowIds:[]};
```

- `spawnMonitorTerminal()` (`lib/transport.js:341-401`) creates a **tmux** window in the dedicated `deliberation` tmux session running `session-monitor.sh` (`buildMonitorCommand`, `lib/transport.js:111-119`).
- `openPhysicalTerminal()` (`lib/transport.js:232-339`) brings it to the front via **`osascript` → Terminal.app** (macOS) or gnome-terminal/konsole/etc. (Linux). It is idempotent (already-viewed → just `activate`, `:239-247`).
- `session-monitor.sh` renders a **read-only dashboard**: header box (session/project/status/round/next-speaker/progress bar, `:179-187`), synthesis excerpt (`:196-203`), color-coded debate log (`:210-232`), waiting/completion footer (`:234-239`). It re-reads the state JSON each refresh. It is **"사각형과 텍스트"** — exactly the terminal-UI §1.5 sanctions.

### 1.2 #610 (window-index fix) — already landed; the monitor WORKS

The 전광판 itself is functional after #610 (한글 토픽 인코딩 fix): `tmuxWindowName()` (`lib/transport.js:88-90`) permits Hangul (`[^a-zA-Z0-9가-힣-]`), and `session-monitor.sh` does East-Asian-width-aware box fitting (`:35-53`). **The monitor displays correctly today.** #611 is therefore an *additional consistency* question — "should the monitor live in cmux like managed sessions" — not a fix for a broken feature.

### 1.3 deliberation is a separately-published, orchestrator-independent component

- `package.json`: name `@dmsdc-ai/aigentry-deliberation`, version `0.0.45`, repo `git+https://github.com/dmsdc-ai/aigentry-deliberation.git`, deps = `@modelcontextprotocol/sdk` + `ws` only.
- Installed at `~/.local/lib/mcp-deliberation/`, **not** a submodule of aigentry-orchestrator.
- `grep` of the entire package for `workspace-host` / `open-session` / `wh_open` / orchestrator bin artifacts → **∅**. The only orchestrator touchpoint is the *semantic* field `orchestrator_session_id` in state JSON (used to route status back via `telepty inject` — a CLI, not a code dependency).

**This fact is decisive for §9 below:** a public user can `npm i @dmsdc-ai/aigentry-deliberation`, run it with no orchestrator present, and the monitor must still open.

### 1.4 The user principle that motivates #611

> "세션은 오케스트레이터가 쓰는 터미널(=cmux)에 포그라운드로." — the monitor pops in a *separate Terminal.app window*, not in cmux.

**Architect note (§13, stated early because it reframes the whole question):** that principle is about **dispatched agent _sessions_** — the orchestrator's delegated workers, which are telepty sessions the orchestrator spawns, drives, reconciles, and closes. The deliberation monitor is **not a session in that sense**. Treating the apparent "어긋남" as a boundary violation conflates two different surface classes (see §3).

---

## 2. The verified precedent this question must be measured against

ADR `2026-05-30-surface-ownership-boundary-verdict.md` + ADR `2026-06-13-terminal-adaptor-contract.md` (§11, independently re-verified by 6-lens + 3-refute, **confidence 0.93**) established the canonical split:

> **surface-DRIVING (spawn / close / focus) = orchestrator** (`workspace-host.sh` 9-verb seam); **session-existence / PTY / transport + read-only liveness probe + `surface_orphaned` signal = telepty.**

Two load-bearing details of that verdict matter here:

1. **Scope.** Every surface in that verdict is an **orchestrator-managed _session_ surface** — a visible container the orchestrator *spawns to host* a `telepty allow --id <sid>` worker it dispatched (`2026-05-30 §8` SPAWN diagram: "orchestrator open-session.sh → cmux new-workspace → `telepty allow` runs INSIDE"). The ownership rule exists *because the orchestrator is the creator* of those surfaces and coordinates the sessions inside them.
2. **Principle = creator=destroyer.** "the orchestrator (creator) owns surface destruction" (`2026-05-30 §2`, "creator=destroyer symmetry"). Ownership follows creation, not surface-type.

**The monitor satisfies neither premise:** the orchestrator does not create it, no telepty session runs inside it, and the orchestrator does not (and need not) reconcile or close it. So the verdict does not *automatically* extend to the monitor — extending it is the very thing this ADR must decide, not assume.

---

## 3. Design Question 1 — Who should own the monitor surface?

**The monitor is a read-only viewport, not a managed session surface.** Concretely it differs from a #608 session surface on every axis the verdict cares about:

| Axis | #608 managed session surface | deliberation monitor |
|------|------------------------------|----------------------|
| Creator | orchestrator (`open-session.sh`) | **deliberation** (`spawnMonitorTerminal`) |
| Hosts a telepty session? | yes (`telepty allow --id`) | **no** (a `tail`-like dashboard on state JSON) |
| stdin / agent inside? | yes — driven via `telepty inject` | **no** — read-only render loop |
| Orchestrator reconciles/closes it? | yes (`session-reconciler.sh`, `wh_close`) | **no** — deliberation owns its `deliberation` tmux session |
| Lifecycle coupling | orchestrator dispatch ⇒ surface | deliberation_start ⇒ its own monitor |
| Constitutional home | §3 orchestrator (지휘/세션 조율) | §3 deliberation (its own 두뇌 state) |

By **creator=destroyer** (the verdict's own principle), the monitor belongs to **deliberation** — it created the state and the view. Forcing the orchestrator to own a surface it has no semantic stake in would *invert* creator=destroyer, not honor it. The monitor is to deliberation what a component's own `--verbose`/log pane is to that component: an observability projection owned by the data owner.

**Closest existing analogy — the kitty-label carve-out (BC5, `2026-06-13-terminal-adaptor-contract.md:260`).** That ADR ruled telepty's own terminal-title write is **permanently allowed** because its *origin* is telepty-internal (labelling its own surface), not orchestrator-intent. Same discriminator here: the monitor's origin is **deliberation-internal** (rendering its own debate), so it stays with deliberation. Only an *orchestrator-originated* surface intent must route through the orchestrator adapter — and the monitor is not that.

**Conclusion (Q1):** monitor surface ownership = **deliberation**. The #608 "surface-driving = orchestrator" rule is scoped to managed session surfaces and does **not** bind a component's own read-only viewport.

---

## 4. Design Question 2 — Three options, trade-offs

### Option A — deliberation sources/calls orchestrator's `workspace-host.sh` (`wh_open`)

deliberation drops its osascript/tmux spawn and instead `source`s (or shells out to) the orchestrator's `bin/lib/workspace-host.sh` and calls `wh_open <sid> <cwd> <cmd>` for the monitor pane.

| | |
|---|---|
| **Pro** | Single terminal seam — monitor spawns through the same adapter as managed sessions; lands in cmux; matches the "everything in cmux" aesthetic; reuses the #608 ready-gate. |
| **Con — §9 KILLER** | deliberation (a standalone npm package, §1.3) would now **require orchestrator's `workspace-host.sh` to exist on disk** at a path it does not own. A public user who installs *only* `@dmsdc-ai/aigentry-deliberation` has no orchestrator → monitor cannot open → **core feature lost standalone.** Direct §9.3/§9.4 violation. |
| **Con — cross-repo reversal** | deliberation→orchestrator **runtime** dependency. This is precisely the reversal `2026-05-05-telepty-devkit-boundary.md:223,226` rejected: *"a library creates a runtime dependency path"*; the sanctioned cross-component coupling surface is **CLI only**. orchestrator is the **지휘자** that calls *into* leaf components — a leaf component (deliberation) `source`-ing the conductor's private bash lib inverts the dependency arrow. |
| **Con — §17** | introduces a cross-repo runtime coupling beyond CLI; no fallback if the lib is absent (unless re-built — which is just Option C with extra steps). |
| **Verdict** | **REJECT.** Worst option constitutionally — breaks §9, reverses dependency direction, breaches §17. |

### Option B — orchestrator owns the monitor as a cmux sidebar workspace (orchestrator detects `deliberation_start` → `wh_open` monitor pane; deliberation only signals)

| | |
|---|---|
| **Pro** | Monitor lives in cmux; orchestrator owns *all* surfaces uniformly; deliberation emits only a signal (mirrors the `surface_orphaned` event pattern). |
| **Con — §9 KILLER** | Standalone deliberation (no orchestrator) gets **no monitor at all** — the feature becomes orchestrator-only. Same §9.3/§9.4 violation as A, from the other side. |
| **Con — §3 role stretch** | The orchestrator coordinates **sessions**; the monitor is not a session. Making the orchestrator spawn-and-own a surface whose *only content* is deliberation's internal `session-monitor.sh` forces a **new orchestrator→deliberation coupling** (orchestrator must know deliberation's monitor script path + invocation) — a reversal in the opposite direction, and a §3 intrusion (orchestrator absorbing a non-session display). |
| **Con — §1 machinery** | Requires a *new observation contract*: orchestrator must detect `deliberation_start` (poll state? subscribe to a bus?) and a teardown path to close the monitor when the debate ends. Net new machinery for a **cosmetic** gain over a feature that already works (#610). |
| **Con — not even a clean #608 fit** | #608 orchestrator-owned surfaces *host a dispatched telepty session*. A monitor hosts none, so B doesn't reuse the #608 model cleanly — it bolts a new "orchestrator spawns a foreign component's dashboard" pattern onto the adapter. |
| **Verdict** | **REJECT.** Breaks §9, stretches §3, adds machinery, and isn't a true #608 reuse. |

### Option C — status quo (deliberation self-spawns) + #610 fix is sufficient ✅ RECOMMENDED

| | |
|---|---|
| **Pro — §9** | deliberation works fully standalone, monitor included; zero orchestrator dependency (§1.3). §9.3/§9.4 satisfied. |
| **Pro — §3** | The data owner owns its read-only view (§3). Monitor is "사각형과 텍스트" (§1.5). Not a managed session surface, so #608 does not bind it (§3 analysis). |
| **Pro — §1 (decisive)** | #610 already made the monitor work. Building A or B is the **§1.6 over-engineering anti-pattern** verbatim: *"기존 메커니즘이 이미 달성하는가? → Yes → nothing-to-build."* §1.6 was itself born from a 4-iteration "이미 작동하잖아" loop — this is exactly that shape. |
| **Con (real, but cosmetic)** | On macOS the monitor opens in a **separate Terminal.app window**, not a cmux pane — mild inconsistency with the "everything in cmux" aesthetic. But: the monitor is read-only, hosts no session, and is not reconciled by the orchestrator. A non-cmux monitor window is the same *cosmetic* class of trade-off ADR `2026-05-30 §10` accepted for ghost tabs ("a stray empty tab is cosmetic; the real harm was a leaked session"). No functional/lifecycle capability is lost. |
| **Verdict** | **ACCEPT.** Constitutionally cleanest; the #611 integration is unnecessary. |

### Option C+ — refinement, ONLY if the user wants cmux-foreground placement

If the cosmetic placement genuinely matters to the user, the constitutional way to get it **without** A's or B's §9 break:

- deliberation keeps owning its own monitor spawn (in `lib/transport.js`), but adds a branch that, **when cmux is detected** (e.g. `command -v cmux` / cmux env), spawns the monitor by calling the **`cmux` CLI directly** (`cmux new-workspace …`), with its **current tmux/osascript path as the fallback** when cmux is absent.
- This is the **§17 pattern** verbatim: *"외부 의존이 불가피하면 fallback path를 동반한다."*
- **Critically NOT Option A:** `cmux` is an independent **terminal tool**, not the orchestrator. deliberation already shells out to `tmux`/`osascript` CLIs; adding a `cmux` CLI branch is the same class of self-owned spawn — it adds **no dependency on `workspace-host.sh` or any orchestrator code**, so §9 standalone is preserved (cmux-absent → tmux/osascript, exactly as today).
- **Cost:** a small, bounded addition to deliberation's own spawn logic; no orchestrator change; no cross-repo coupling.

C+ is offered because it is the *only* way to honor the user's placement preference while staying constitutional. The C-vs-C+ choice is a **stakeholder cosmetic preference**, surfaced in the REPORT.

---

## 5. Design Question 3 — 위헌 심사 (constitutional review)

| Article | Question | A | B | C / C+ |
|---------|----------|---|---|--------|
| **§3 역할** (두뇌 vs 지휘자 vs surface) | Does the owner match the role boundary? | ✗ deliberation reaches into orchestrator's surface seam | ✗ orchestrator absorbs deliberation's own dashboard (role stretch) | **✓ data owner (deliberation, 두뇌) owns its read-only view; monitor = 사각형+텍스트; #608 scope = session surfaces, not this** |
| **§1 경량** (over-engineering; #610 already works) | Is the integration justified machinery? | ✗ cross-repo coupling for cosmetic gain | ✗ new observation+teardown contract for cosmetic gain | **✓ C = nothing-to-build (§1.6); C+ = one bounded CLI branch w/ fallback, only if placement wanted** |
| **§9 독립** (deliberation must run standalone) | Does the monitor still open with no orchestrator? | ✗ **needs orchestrator's bash lib — feature lost standalone** | ✗ **monitor becomes orchestrator-only — lost standalone** | **✓ fully standalone; C+ cmux-absent → tmux/osascript fallback** |
| **§17 무의존** | New cross-repo runtime dep beyond CLI? | ✗ source-level dep on `workspace-host.sh` | ✗ orchestrator→deliberation script coupling | **✓ none (C); C+ uses cmux CLI only, with fallback** |

**§9 is the decisive article** — it independently eliminates **both** A and B, because the deliberation package ships and runs without the orchestrator (§1.3, verified). **§1.6** then confirms C over any integration: the feature already works.

**Constitutional conflict found:** Options A and B each violate §9 (and A additionally §17). Option C (and C+) violate none. No orchestrator waiver is needed for C/C+; A/B would require waiving §9, which the architect does **not** recommend.

---

## 6. Cross-repo reversal verdict (#608/#613 comparison — required by dispatch)

**Is routing the monitor through the orchestrator a dependency reversal like the one #613/devkit-boundary rejected?**

- **Yes for Option A.** deliberation→orchestrator runtime coupling is the same shape `2026-05-05-telepty-devkit-boundary.md:223,226` rejected (*"a library creates a runtime dependency path"; CLI is the only sanctioned coupling surface; Article 9 + 17*). A leaf component (deliberation, 두뇌) `source`-ing the conductor's (orchestrator, 지휘자) private bash lib inverts the natural arrow (conductor calls *into* leaves, not the reverse).
- **Softer reversal for Option B.** orchestrator→deliberation (the orchestrator must observe `deliberation_start` and invoke deliberation's monitor script). Less of a classic library-dependency reversal, but it forces the orchestrator to know a foreign component's internals and breaks §9 standalone.
- **The #608 verdict does NOT mandate either.** Its scope is **orchestrator-created telepty session surfaces**; its principle is **creator=destroyer**. The monitor is created by deliberation and hosts no session, so creator=destroyer assigns it to **deliberation**. Extending "surface-driving = orchestrator" to a component's own read-only dashboard is a **category error**, not a faithful application of #608.

**Verdict:** the apparent "monitor escaped the orchestrator adapter" framing misclassifies the monitor as a managed session surface. Correctly classified (read-only viewport, deliberation-owned), there is **no boundary violation to fix** — the monitor is already where creator=destroyer + §3 + §9 put it.

---

## 7. Recommendation

1. **Adopt Option C (status quo + #610).** Document the monitor as a **deliberation-owned read-only viewport**, explicitly *outside* the #608 "surface-driving = orchestrator" scope (which governs orchestrator-managed telepty *session* surfaces). No code change. This is the honest §1 conclusion: the integration is unnecessary because the feature already works.
2. **Add a one-line boundary note** to the relevant doc (e.g. deliberation BOUNDARY/CONTEXT or the #608 ADR's scope section) recording: *"deliberation monitor (전광판) = component-internal read-only viewport, owned by deliberation (creator=destroyer); not an orchestrator-managed session surface; #608 wh_open ownership does not apply."* — closes the gray zone so this question is not re-litigated. (This is a docs edit for the eventual coder/orchestrator, not part of this ADR.)
3. **Reject A and B** on §9 (both) + §17/dependency-reversal (A) + §3 role-stretch/machinery (B).
4. **Offer C+ only if the user confirms the cmux-foreground placement is wanted.** C+ = deliberation self-spawns via the `cmux` CLI when present, tmux/osascript fallback otherwise (§17 pattern). It is the sole constitutional path to that placement and adds no orchestrator dependency. **This is a stakeholder cosmetic preference and is surfaced for sign-off — not decided unilaterally.**

---

## 8. Consequences

- **Positive (C):** §9 standalone preserved; zero new cross-repo coupling; no machinery; the gray zone ("is the monitor a session surface?") is closed by an explicit boundary note; honors §1.6 (nothing-to-build).
- **Negative (C):** the macOS monitor remains a separate Terminal.app window — a cosmetic deviation from the cmux-foreground aesthetic. Bounded, read-only, non-lifecycle; mitigable by C+ if the user cares.
- **Cost of C+ (if chosen):** a small, fallback-guarded `cmux`-CLI branch in deliberation's own spawn path; no orchestrator change.
- **Risk if A/B were adopted instead:** deliberation loses its monitor when run standalone (§9 regression) and acquires a cross-repo runtime dependency the codebase has so far deliberately avoided (§1.3 verified ∅).

---

## 9. Implementation note

**This ADR ships zero implementation.** Option C requires no code. Option C+ (if approved) and the boundary-note docs edit are separate coder tasks, gated on user/orchestrator approval and on the C-vs-C+ stakeholder decision. ⚠ No cmux build/restart was performed for this analysis (read-only). Snyk scan applies only to any coder-generated code, not to this design doc.
