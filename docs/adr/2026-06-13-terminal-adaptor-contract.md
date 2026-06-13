# ADR 2026-06-13 — Terminal Adaptor Contract: complete unification (cmux ↔ warp seamless parity)

- **Status**: PROPOSED (SPEC FIRST — Rule 24). Awaiting user/orchestrator approval. **No code shipped in this ADR.** Premise independently verified — see §11 (workflow 6-lens + 3-refute, confidence 0.93). Adversarially reviewed by 3-LLM deliberation (claude/codex/gemini, unanimous) — **§12 binds 6 Blocking Migration Criteria as approval conditions.**
- **Role**: architect (design only — implementation is a separate coder task after approval).
- **Task**: tq#608 — 터미널 어댑터 계약 완전 통일.
- **Worktree**: `/private/tmp/wt-arch-608` (repo `aigentry-orchestrator`, branch `wt/arch-608`, base `277ff97`).
- **Supersedes/extends**: [ADR 2026-05-20 session-lifecycle-3-layer](./2026-05-20-session-lifecycle-3-layer.md) (Workspace Host adapter seam), [verdict 2026-05-30 surface-ownership-boundary](./2026-05-30-surface-ownership-boundary-verdict.md) (focus off telepty; adapter owns control).

---

## 1. Context — the user requirement (verbatim)

> "터미널 추상화 완벽하게 되어야 돼. cmux에서 warp로 터미널 바뀌면 **warp adaptor로 모든 기능 문제없이 심리스하게** 동작해야 돼."

Constitution §2 (크로스): *every* lifecycle verb must keep working when the adapter is swapped (cmux → warp → headless), with **zero feature loss**. Today that is not true: a cmux→warp swap can `close`/`focus`/`alive` an *already-spawned* surface but **cannot spawn one at all**, and even the verbs that "work" rely on state nothing produces.

---

## 2. Confirmed gap inventory (2026-06-13, re-verified — file:line, not speculation)

Three layers each know a **different terminal vocabulary**, and **spawn lives in a different abstraction layer than lifecycle**:

| # | Finding | Evidence |
|---|---------|----------|
| G1 | **spawn is inline, not an adapter.** `open-session.sh:open_in_terminal()` is a hand-written `case "$term"` over `{cmux, aterm, tmux, wezterm, iterm, ghostty/generic}`. No `warp`, no `headless`. | `bin/open-session.sh:216–272` |
| G2 | **spawn layer never sees the adapter seam.** `open-session.sh` sources only `platform.sh`; it never sources `workspace-host.sh`. | `bin/open-session.sh:51`; `grep workspace-host bin/open-session.sh` → ∅ |
| G3 | **lifecycle has no `open` verb.** `workspace-host.sh` defines `wh_lookup/close/alive/list_ids/focus/prune_orphans/set_status/clear_status` (+ composite `wh_close_for_sid`). There is **no `wh_open`/`wh_spawn` anywhere in the repo.** | `bin/lib/workspace-host.sh:429–480`; `grep -rn 'wh_open' bin/` → ∅ |
| G4 | **two disjoint terminal vocabularies.** `detect_terminal()` = `{cmux,aterm,tmux,wezterm,iterm,ghostty,generic}`; `_wh_adapter()` = `{cmux,warp,headless}`. Only `cmux` overlaps. There is no single registry. | `bin/open-session.sh:137–147` vs `bin/lib/workspace-host.sh:414–427` |
| G5 | **warp spawn is a comment, not code.** The warp adapter header says spawn happens "at the dispatch layer via a `warp://tab_config/` deeplink". **No `warp://` call site exists** — only the comment. → cmux→warp swap = *cannot spawn*. | `bin/lib/workspace-host.sh:237` (comment); `grep -rn 'warp://' bin/` → only that comment |
| G6 | **NEW — warp lifecycle reads state nothing writes.** `_wh_warp_alive` / `_wh_warp_list_ids` depend on the sentinel `~/.aigentry/warp-surfaces/<sid>.live`. `_wh_warp_close` *removes* it (`bin/lib/workspace-host.sh:339`), but **no code ever creates it** (`grep -rn warp-surfaces bin/` → only the dir-var + comments). Consequence: under a running Warp, every warp surface fails the alive probe (`workspace-host.sh:365` returns 1 "gone") — i.e. **warp surfaces are born orphaned.** The "implemented" warp lifecycle is non-functional without the missing spawn-side writer. | `bin/lib/workspace-host.sh:248,339,365,372` |
| G7 | **dead code.** `bin/cmux-inject.sh` has no production caller (only self-refs + one audit-doc mention). | `grep -rln cmux-inject` → `bin/cmux-inject.sh`, `docs/reports/2026-06-10-structure-audit.md` |

**Root cause (one sentence):** spawn and lifecycle were built in two different eras against two different abstractions; the warp adapter was authored for the lifecycle seam on the *assumption* of a spawn-layer deeplink + sentinel writer that was never built.

---

## 3. Decision

### D1 — One adapter, all verbs. `open` (spawn) is promoted into the Workspace Host contract.

The Workspace Host contract becomes the **single** owner of every terminal lifecycle verb, spawn included. `open-session.sh`'s inline `case` is replaced (post-approval) by a call into `wh_open`. The contract is the **9-verb interface** below. Each verb is dispatched by `_wh_adapter` to exactly one adapter; **one terminal ⇒ one adapter responsible for all 9 verbs.**

#### The contract (9 verbs + 1 composite)

| Verb | Signature (sketch — not code) | Meaning | Idempotency / exit contract |
|------|------|---------|------|
| `wh_open` | `wh_open <sid> <cwd> <cli_cmd>` → prints `host_id` (ref/marker) on stdout | Spawn a visible surface wrapping `telepty allow --id <sid>`, **block until ready-gate passes**, then emit the stable handle. | `0` only when the surface can accept input; non-zero ⇒ no handle emitted, no half-spawned surface left (see D3 ready-gate). |
| `wh_lookup` | `wh_lookup <sid> [<json>]` → `host_id` | Resolve sid → host handle (empty = no mapping). | `0` always; empty stdout = "no mapping". |
| `wh_close` | `wh_close <host_id>` | Release the surface. | `0` released-or-gone; `1` real failure (still alive). |
| `wh_close_for_sid` | `wh_close_for_sid <sid> [<json>]` | Composite: lookup+close. | `0` always (no mapping ⇒ no-op). |
| `wh_alive` | `wh_alive <host_id>` | Probe liveness. | `0` alive, `1` gone. INV-17: indeterminate ⇒ alive. |
| `wh_focus` | `wh_focus <host_id>` | Raise/foreground (policy actuation, owned by orchestrator — verdict 2026-05-30). | `0` (focused or gracefully degraded). |
| `wh_list_ids` | `wh_list_ids` → host_ids, one per line | Enumerate handles the adapter knows (orphan detection). | `0`. |
| `wh_prune_orphans` | `wh_prune_orphans <live_csv> <protected_csv>` → count | Close vanished-session surfaces (ownership + debounce gated). | `0` (best-effort, never blocks sweep). |
| `wh_set_status` | `wh_set_status <host_id> <state>` | Push `{working,idle,disconnected}` to sidebar pill. | `0` always. |
| `wh_clear_status` | `wh_clear_status <host_id>` | Remove the aigentry pill. | `0` always. |

**§1 (경량) justification — every verb is already consumed, none is speculative:**

- `wh_open` ← will replace `open-session.sh:216` (the only spawn path).
- `wh_lookup/close/close_for_sid` ← `session-cleanup.sh:125,130,235`.
- `wh_alive/focus/lookup/prune_orphans/set_status` ← `session-reconciler.sh:509,552,677,731,741`.
- `wh_list_ids` ← orphan sweep in `session-reconciler.sh` (host-side orphan = in list, not in telepty).
- `wh_clear_status` ← teardown dual of `set_status` (`session-cleanup.sh`).

No 10th verb is added. The `ready-gate` is **not** a separate public verb — it is an *internal obligation of `wh_open`* (D3), so the surface area stays at 9. This is the YAGNI floor: every verb maps to a live call site.

### D2 — One terminal registry. detect / spawn / lifecycle share it.

Today `detect_terminal()` and `_wh_adapter()` are two hard-coded lists (G4). Decision: **collapse both into the adapter registry** keyed by adapter name. Each registered adapter declares:

```
adapter <name>:
  detect:        <predicate>     # how detect_terminal recognizes it (env var / TERM_PROGRAM / CLI-on-PATH)
  auto_detectable: <bool>        # warp = false (no CLI → env-force only), cmux = true
  capabilities:  { verb → impl-kind }   # see D4
```

`detect_terminal()` becomes "first adapter whose `detect` predicate matches" and `_wh_adapter()` becomes "env-forced name, else first `auto_detectable` adapter whose `detect` matches, else `headless`". **One list, one vocabulary.** The legacy terminals `{aterm,tmux,wezterm,iterm,ghostty}` are folded in as adapters during migration (Phase 3) so detect and lifecycle can never again disagree.

> §1 note: the registry is a **data table**, not a framework. No plugin loader, no DI container (§17 무의존 — aigentry ships these adapters in-tree; no external registration). It is the minimum structure that makes G4 unrepresentable.

### D3 — `wh_open` ready-gate is part of the contract (not best-effort).

`wh_open` MUST NOT return a handle until the surface can accept `send-key`; otherwise the daemon-submit race (`open-session.sh:164–207`, BUG-A) re-appears for every adapter. The ready-gate is **per-adapter** but its *contract* is uniform: **"handle emitted ⇒ pane ready."**

| Adapter | ready-gate mechanism | Strength |
|---------|---------------------|----------|
| cmux | existing 3-part proof: `list-workspaces` ∋ ref → `surface-health type=terminal` → `read-screen` non-empty (`open-session.sh:183–207`). | **strong** (surface-attested via CLI). |
| warp | sentinel `~/.aigentry/warp-surfaces/<sid>.live` appears, gated by `Warp-app-alive`. **Sentinel is written by the in-surface wrapper, not the spawner** — see D4-warp. | **weaker** (process-attested, not surface-attested — Warp has no CLI to inspect the PTY). Residual race documented in §6. |
| headless | n/a — `telepty spawn` daemon PTY; ready when `telepty list` shows the id. | medium. |

This both fixes G6 (now there IS a sentinel writer) **and** unifies the ready semantics.

### D4 — Capability declaration + explicit-error policy (§2 seamless core).

The dispatcher (`wh_<verb>`) consults each adapter's declared capability for the verb and routes to one of **three** outcomes — never a silent failure:

| impl-kind | meaning | runtime behavior |
|-----------|---------|------------------|
| `native` | adapter fully implements the verb | run it. |
| `degraded-noop` (§17) | verb is *semantically satisfiable as "nothing to do"* on this host (e.g. warp has no sidebar → `set_status` is a true no-op; the user loses no capability, only a cosmetic pill) | run the no-op, **log at debug**, return success. **Allowed** because the verb's contract (`return 0 always`) is honored and no user-visible function is lost. |
| `unsupported` | verb **cannot** be honored and silently pretending would lose function the user expects (e.g. an adapter that genuinely cannot spawn) | **surface an explicit error** to the caller (non-zero + a `[workspace-host] <adapter> <verb>: UNSUPPORTED — <reason>` line). Never a silent `return 0`. |

**The §17-no-op vs §2-unsupported distinction (the heart of the user requirement):**

- §17 `degraded-noop` = "the host has no such surface affordance, but nothing the user asked for is lost." Example: warp `set_status`/`prune_orphans` (no sidebar / no listing CLI) — `workspace-host.sh:395–397`. The session still works; only a pill is absent.
- `unsupported` = "the user pressed a button that did nothing and got no signal." **This is the failure mode the user is complaining about** ("되는 줄 알았는데 조용히 안 됨"). The policy makes it *impossible*: any verb that cannot be honored must throw a labelled error.

**Mandatory rule:** a verb declared `degraded-noop` MUST be one where degradation costs the user *zero* lifecycle capability (only cosmetics). If degradation would cost real function, it MUST be `unsupported` (explicit error), not `degraded-noop`. The matrix in §4 assigns every cell to exactly one impl-kind and justifies each `degraded-noop`.

### D5 — warp spawn fully specified (closes G5 + G6).

The warp `wh_open` (today: absent) is specified as:

1. **Write a tab_config TOML** `~/.warp/tab_configs/telepty-<sid>.toml` (macOS) / `$XDG_DATA_HOME/warp-terminal/tab_configs/` (Linux) describing a single tab whose command is the **wrapper** below and whose window title is the marker `telepty::<sid>` (the only find-handle; `workspace-host.sh:250–251,330`). *(`_wh_warp_rm_tab_config`, `workspace-host.sh:311–319`, already GCs exactly this path — the writer is its missing dual.)*
2. **Wrapper command** (this is what makes G6's sentinel exist and doubles as the ready-gate):
   ```
   bash -c 'cd <cwd> \
            && telepty allow --id <sid> --auto-restart <cli_cmd> \
                 --on-ready "touch ~/.aigentry/warp-surfaces/<sid>.live"'
   ```
   The sentinel is written **by the in-surface process once telepty registration is up**, not by the spawner — so its presence attests "the PTY is live and registered", which is exactly what `wh_alive` already assumes (`workspace-host.sh:365`). *(If `telepty allow` has no `--on-ready` hook, the fallback wrapper is `... && touch <sentinel> & exec telepty allow ...` with the residual race noted in §6; the strict variant requires the hook — flagged as an implementation decision for the coder.)*
3. **Open the surface** via the deeplink `open "warp://tab_config/telepty-<sid>"` (macOS `open(1)`; Linux `xdg-open`). This is the `warp://` call that G5 says is missing.
4. **Ready-gate** (D3): poll for `~/.aigentry/warp-surfaces/<sid>.live` **AND** `Warp-app-alive` (reuse `_wh_warp_app_running`, `workspace-host.sh:262–266`) up to `WARP_READY_TIMEOUT_MS`. On timeout: GC the TOML + sentinel and return non-zero (no half-spawned handle).
5. **Emit** the marker `telepty::<sid>` as the host_id — already the handle every other warp verb consumes (`wh_lookup/close/alive/list_ids`).

This makes warp satisfy the **same 9-verb contract** as cmux end-to-end. Result: a cmux→warp swap now spawns, and the previously-dead alive/list_ids verbs become functional because the sentinel finally has a writer.

---

## 4. Verb × Adapter matrix (warp parity — every cell assigned)

`native` = full impl · `degraded-noop` = §17 cosmetic-only no-op (returns success, logs) · `unsupported` = explicit labelled error (never silent).

| Verb | cmux | warp | headless |
|------|------|------|----------|
| `wh_open` | **native** — `new-workspace` + rename + 3-part ready-gate (`open-session.sh:217–236`) | **native (D5)** — tab_config TOML + `warp://` deeplink + sentinel ready-gate. ⚠ weaker gate (§6) | **native** — `telepty spawn` daemon PTY (no visible UI; attach instructions). |
| `wh_lookup` | **native** — `cmuxWorkspaceId`, title fallback (`:72–84`) | **native** — marker `telepty::<sid>` (`:321–332`) | **native (empty)** — headless keeps no map; returns "" = no mapping. |
| `wh_close` | **native** — `close-workspace` + alive re-probe (`:86–100`) | **native** — raise-then-Cmd+W, no blind close; removes sentinel+TOML (`:334–355`) | **native** — `return 0` (daemon PTY already torn by telepty). |
| `wh_close_for_sid` | **native** (composite) | **native** (composite) | **native** (composite). |
| `wh_alive` | **native** — `sidebar-state` content probe (`:102–116`) | **native** — sentinel + Warp-alive, INV-17 indeterminate→alive (`:357–367`) — *now has a writer (D5)* | **native** — `return 1` (no surface to be alive). |
| `wh_focus` | **native** — `select-workspace` (`:225–230`) | **native** — AXRaise by marker; **degraded-noop** when no osascript/AX (§17, `:379–392`) | **degraded-noop** — no UI to raise (`:406`). Costs no lifecycle function (headless has no surface). |
| `wh_list_ids` | **native** — workspace refs (`:118–126`) | **native** — sentinel-dir glob (`:369–377`) — *now populated (D5)* | **degraded-noop (empty)** — headless tracks nothing. |
| `wh_prune_orphans` | **native** — ownership+debounce ledger (`:175–223`) | **degraded-noop** — Warp has no listing CLI → cannot enumerate to prune (`:395`). §17: cosmetic (orphan tab), not lost function. | **degraded-noop** — nothing to prune (`:407`). |
| `wh_set_status` | **native** — sidebar pill under `aigentry` key (`:140–153`) | **degraded-noop** — Warp has no sidebar pill API (`:396`). Cosmetic only. | **degraded-noop** (`:408`). |
| `wh_clear_status` | **native** — `clear-status` (`:156–162`) | **degraded-noop** (`:397`) | **degraded-noop** (`:409`). |

**Parity verdict:** cmux = 10/10 native. warp = 6 native + 4 degraded-noop, **0 unsupported, 0 silent** — every degraded cell is cosmetic-only (status pills, orphan-pruning, focus-when-AX-denied), so **no lifecycle function is lost on a cmux→warp swap.** headless = spawn/lookup/close/alive native + cosmetics no-op. The §2 requirement ("모든 기능 문제없이 심리스") is **met for all real lifecycle verbs**; the only warp deltas are sidebar cosmetics that have no functional meaning on Warp.

**Honesty note (§13):** warp `wh_focus` degrades to no-op when macOS AX permission is denied, and warp `wh_open`'s ready-gate is process-attested not surface-attested (§6). These are declared, not hidden.

---

## 5. Conformance test suite design (proves seamless on swap)

**Principle:** one **contract test per verb**, parameterized over `{cmux, warp, headless}`, each run against a **mock surface** (stub `cmux`/`osascript`/`pgrep`/`telepty` on a curated `PATH`). An adapter is "conformant" iff it passes every applicable verb test with the declared impl-kind. Template already exists: `tests/dispatch/T25_warp_adapter_degrade.sh` (sources the lib, stubs binaries, asserts behavior + asserts *absence* of destructive ops). The suite generalizes that pattern.

**Test contract per verb (what the coder implements):**

| Verb | Contract assertions (per adapter) | Mock |
|------|-----------------------------------|------|
| `wh_open` | (a) `native`: returns handle **only after** ready-gate passes; (b) on gate timeout returns non-zero **and** leaves no surface/sentinel/TOML; (c) handle round-trips: `wh_lookup`(sid) == emitted handle; (d) idempotent re-open of same sid does not double-spawn. | stub spawn CLI + controllable ready signal (cmux read-screen / warp sentinel touch / telepty list). |
| `wh_lookup` | empty stdout ⇔ no mapping; non-empty ⇔ a handle `wh_alive` accepts. | stub list/json. |
| `wh_close` | `0` when gone-or-released; `1` only when still alive; **never** a blind destructive op (warp: assert no Cmd+W keycode 13 when window unconfirmable — T25 §3). | stub close + alive. |
| `wh_alive` | `0`/`1` per surface state; **INV-17**: indeterminate (probe absent / app down) ⇒ `0` never `1` (T25 §2 a–d). | stub pgrep + sentinel. |
| `wh_focus` | `0` focused-or-degraded; `degraded-noop` adapters log + `0`, never throw (T25 §1,§5). | stub osascript/cmux. |
| `wh_list_ids` | enumerates exactly the live handles; empty for headless. | stub list / sentinel dir. |
| `wh_prune_orphans` | closes only ownership-gated, debounced, non-protected, non-live candidates; honors `DRY_RUN`; `degraded-noop` adapters print `0`. | stub list-titles + ledger tmp. |
| `wh_set_status`/`wh_clear_status` | `native`: correct CLI args, distinct `aigentry` key (never clobber `claude_code` — T25-style); `degraded-noop`: `0`, no call. | stub set/clear. |
| **capability policy** | for every (adapter,verb): declared `unsupported` ⇒ non-zero **and** a labelled `UNSUPPORTED` stderr line; declared `degraded-noop` ⇒ `0` **and** no user-visible side effect; **no cell is silent-fail.** | matrix-driven assertion. |

**Cross-adapter seamlessness test (the §2 proof):** a single scenario script runs the *same* lifecycle sequence — `open → lookup → set_status → focus → alive → close → alive` — under `AIGENTRY_WORKSPACE_HOST=cmux`, then `=warp`, then `=headless`, and asserts the **observable lifecycle outcome is identical** (surface created → discoverable → torn down → reported gone), tolerating only the declared cosmetic deltas. This is the literal encoding of "cmux↔warp 심리스 패리티".

> All tests are **mock-surface** (no live cmux daemon 3848, no real Warp). They run in CI/headless. Implementation is the coder's; this ADR fixes the *contract* each must satisfy.

---

## 6. Open trade-off (surfaced, not hidden — §13)

**warp ready-gate is process-attested, not surface-attested.** cmux proves readiness by *reading the pane* (`read-screen`). Warp has no CLI, so the strongest honest signal is "the in-surface wrapper reached the post-`telepty-allow` point and touched the sentinel" + "Warp is alive". Residual race: if `telepty allow` registers but the PTY is momentarily not yet accepting keys when the sentinel lands, a daemon submit could still race. Two variants:

- **V1 (recommended): sentinel via `telepty allow --on-ready` hook** — sentinel lands only after telepty confirms the foreground proc is up. Closes most of the race; requires telepty to expose `--on-ready` (verify before implementation).
- **V2 (strict parity): sentinel + a UI-script `read-screen`** — after the sentinel, an `osascript` reads the Warp window's last line and waits for a known prompt token. Surface-attested like cmux, but slower and AX-permission-dependent.

**Recommendation:** ship **V1**; offer **V2** behind `WARP_STRICT_READY=1` for users who need cmux-identical guarantees. This is the one cell where warp cannot be *bit-identical* to cmux; it is declared, bounded, and has a mitigation — not a silent gap. **Flagged in the REPORT for sign-off at the implementation-approval gate** (since `--on-ready` availability gates V1).

---

## 7. Migration plan (backward-compatible — current cmux operation must not break)

| Phase | Step | Back-compat guard |
|-------|------|-------------------|
| **0** | Land this ADR; user approves spec. **No code.** | — |
| **1** | Add `wh_open` to `workspace-host.sh` for **cmux** by *moving* the existing `open-session.sh:217–236` cmux logic (incl. `_cmux_wait_ready`) verbatim into `_wh_cmux_open`. `open-session.sh` sources the lib (closes G2) and the cmux branch calls `wh_open`. | Byte-for-byte behavior parity for cmux (the live path); covered by existing cmux spawn tests + new `wh_open` contract test. |
| **2** | Add `_wh_warp_open` (D5) + the sentinel writer (closes G5+G6). Warp now spawns. | warp is env-force-only (never auto-selected, `workspace-host.sh:419–421`) → cannot affect any current user who hasn't opted in. |
| **3** | Fold `{aterm,tmux,wezterm,iterm,ghostty,generic/headless}` spawn branches into adapters; unify `detect_terminal()` + `_wh_adapter()` onto the **single registry** (D2). `open-session.sh:open_in_terminal` becomes a thin `wh_open "$(detect_terminal)" …` dispatch. | each branch moved 1:1 first, then de-duplicated; per-adapter spawn contract test gates each move. Fallback chain (`fallback_spawn`, `:152–162`) preserved as the `generic→headless` adapter. |
| **4** | Wire the capability-policy dispatcher (D4): every `wh_<verb>` consults the declared impl-kind; `unsupported` cells emit labelled errors. | additive — `native`/`degraded-noop` cells unchanged; only previously-silent failures gain an error surface. |
| **5** | Land the full conformance suite (§5) incl. the cross-adapter seamlessness scenario. | CI gate. |
| **6** | **Remove dead `bin/cmux-inject.sh`** (G7, no caller). *Recommended, separate cleanup task per Rule 29 — mentioned here, not bundled into the contract change.* | independent; revert-safe. |

**Invariant across all phases:** the live cmux path (daemon 3848) is never touched until its `wh_open` is proven byte-equivalent (Phase 1 test gate). No phase removes a working path before its replacement passes the contract test.

---

## 8. 위헌 심사 (constitutional review)

| Article | Question | Verdict |
|---------|----------|---------|
| **§1 경량** | Is a 9-verb contract over-engineering? Is any verb YAGNI? | **PASS.** Every verb maps to an existing live call site (§3 D1 justification); zero speculative verbs. `wh_open` *removes* an abstraction (inline `case` → one seam) rather than adding one. The registry (D2) is a data table, not a framework — no plugin loader, no DI. Net: fewer abstraction layers than today (spawn+lifecycle were two; now one). |
| **§2 크로스** | Does adapter-swap preserve all function? | **PASS (with one declared caveat).** Matrix §4: 0 unsupported, 0 silent; all warp deltas are cosmetic (status pills / focus-when-AX-denied / orphan-prune). The only non-cosmetic delta is warp's weaker ready-gate (§6), declared with a V2 strict-parity mitigation. This ADR is the direct instrument of §2. |
| **§3 역할** | Does this abstraction match the `terminal-adaptor = orchestrator`-owned boundary? | **PASS.** Verdict 2026-05-30 already moved control (focus/close) onto the adapter, owned by the orchestrator. Promoting `wh_open` into the same seam *completes* that boundary instead of splitting spawn off into `open-session.sh`. Consistent with the principles "terminal-adaptor owns control" and "surface close via adaptor only" — spawn was the one control verb living outside the adaptor; D1 fixes that. |
| **§17 무의존** | Does it add an external dependency? | **PASS.** All adapters ship in-tree; the registry is internal. Each adapter degrades gracefully when its tool is absent (cmux-not-installed → headless; warp-no-osascript → no-op). No plugin/library introduced. |

**Constitutional conflict:** none found. The design *increases* §1/§2/§3 compliance versus the status quo. No orchestrator waiver required.

---

## 9. Consequences

- **Positive:** cmux→warp swap finally spawns; warp alive/list_ids become functional (G6 fixed); detect/spawn/lifecycle can never again disagree (single registry); every "button that does nothing" now either works or errors loudly (§2); dead code flagged.
- **Negative / cost:** ~6-phase migration; warp ready-gate is one notch weaker than cmux (§6, mitigated); folding 5 legacy terminals into adapters is mechanical but non-trivial.
- **Risk if not done:** the user's exact complaint persists — warp looks supported (lifecycle verbs exist) but cannot spawn and self-reports its surfaces as orphans.

---

## 10. Implementation note

**This ADR ships zero implementation.** Function signatures above are sketches for the contract, not code. Implementation (Phases 1–6) is a separate coder task, gated on (a) user approval of this spec and (b) sign-off on the §6 ready-gate variant. Snyk scan applies to the coder's generated `.sh`, not to this design doc.

---

## 11. Premise verification + corrections (orchestrator workflow, 2026-06-13)

The premise of this ADR — *terminal surface adaptors belong in the orchestrator* — was independently verified by a 6-lens analysis + 3-way adversarial refutation (full report: `docs/reports/2026-06-13-terminal-adaptor-ownership-analysis.md`). **Verdict: confirmed, confidence 0.93** — 6/6 lenses agreed and all three refutations left the consensus standing. The verified canonical split: **surface-DRIVING (spawn/close/focus) = orchestrator (`workspace-host.sh` seam); session-existence/transport + read-only liveness probe + `surface_orphaned` signal + zombie-session GC = telepty.** §3 D1 (promote `wh_open` into the seam) and the §4 capability policy are consistent with this. The verification surfaced three corrections to fold in:

### 11.1 telepty residual surface-write — explicit carve-out (was unstated)
The managed path has **no leak** (`closeSurface` is a `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE!=='1'`-gated no-op; `focusSurface` is removed — asserted `typeof===undefined` in `test/lifecycle-surface-acceptance.test.js:290-292`). But **one live surface-write remains in telepty**: `src/transport/websocket.js:88` writes the kitty tab **label** on reconnect (`set-tab-title … '⚡ telepty :: <sid>'`). This is *labelling, not lifecycle* (no open/close/focus), so it is **not** an ownership violation. **Decision (orchestrator, §1 경량):** carve it out as permitted — "labelling ≠ surface lifecycle" — rather than add a 10th `wh_label` verb for a single reconnect call site (that would breach the YAGNI floor §3 D1 just established). The contract's boundary note must state this carve-out explicitly so the gray zone is closed. Implementation may revisit if a second label call site appears. (`tui.js` kitty send-text is byte-driving = telepty's legitimate role, unaffected.)

### 11.2 §7 migration premise — telepty rework is already LANDED (fact-correction)
Any reading that the telepty `closeSurface`/`focusSurface` rework is an *uncommitted working-tree diff to stage before landing* is **outdated**. telepty HEAD `f4641b7` is working-tree clean and the rework is **already committed** (`closeSurface` = gated no-op committed; `focusSurface` removed). Re-frame #608 accordingly: it is **"add a unified spawn contract on top of an already-landed split,"** not "stage a pending diff." §7 Phase 1 (move cmux spawn into `_wh_cmux_open`) stands unchanged; only the framing is corrected.

### 11.3 conformance must gate INV-17 non-regression (add to §5)
The §5 conformance suite must include **#486 INV-17 non-regression**: on host app-quit, both cmux and warp must resolve `INDETERMINATE → alive` (never mass-kill sessions) — `_wh_warp_alive:360-363` + `isSurfaceAlive` `'unknown'→skip`. A unified `wh_open`/registry change must not regress this app-quit safety.

> §11 is orchestrator-authored (ADR finalization is an orchestrator role per the role table); §1–§10 are the architect's design, unchanged except the §1.0 status line. Implementation remains gated on user approval.

---

## 12. Blocking Migration Criteria (3-LLM deliberation, 2026-06-13 — unanimous)

Adversarial review by claude (critic) / codex (implementer) / gemini (researcher), 3 rounds, unanimous. Full synthesis: `docs/reports/2026-06-13-608-adr-deliberation-synthesis.md`. Verdict: **no structural defect** (9-verb not over-engineered, ownership split sound, §1/§2/§3/§17 hold). Approval is **conditional** on these 6 criteria being satisfied as the migration proceeds — each is a BLOCKING gate, not advisory.

| # | Criterion | Gate |
|---|-----------|------|
| **BC1** | **warp ready-gate = V2** (bounded `osascript`+AX read-screen) + degraded fallback. **V1 (`telepty --on-ready`) is REJECTED** — gemini established that Warp's `warp://` is an async launchd handoff with **no IPC/socket callback for surface-ready**, so a transport/process hook can never attest *surface* readiness. In degraded warp (AX unavailable), `wh_open` MUST NOT route work that requires a guaranteed-visible foreground surface. | Phase 2 gate: warp `wh_open` returns a handle only after V2 attestation OR declares `degraded`; no V1 code path ships. |
| **BC2** | **9-verb boundary is invariant.** No 10th verb (`wh_probe_ready` rejected). Ready is a `wh_open` internal obligation (D3). Add capability field **`ready_attestation: surface \| process \| none`** per adapter. | Contract test asserts exactly 9 public verbs; `ready_attestation` declared for every adapter. |
| **BC3** | **Phase 3 = Tiered conformance gate.** **Tier 1** (full lifecycle IPC: cmux, tmux, wezterm, iterm) / **Tier 2** (fire-and-forget spawn: warp, ghostty, generic). Each adapter must pass **its tier's** contract test **before** it is folded in (closes the mid-migration verification gap). Add the Tier classification table to §4/§5. | Phase 3 entry: per-adapter tier test green; no adapter folded without its tier test existing first. |
| **BC4** | **Rollback / observability (per phase).** ADR §7 had only forward gates — no reverse path. Add: (a) **per-phase** old-path fallback flag (individual env, not one global — preserves phase isolation), (b) adapter-selection logging, (c) one-command rollback. Protects the live cmux daemon (3848). | Each phase ships with its fallback flag + rollback command + selection log, verified before the phase is declared done. |
| **BC5** | **kitty-label boundary.** telepty-internal terminal-title escape (`websocket.js:88`, reconnect label) stays in the transport layer — **permanently allowed** (not a temporary waiver). BUT any **orchestrator-originated** workspace/session logical-label intent MUST go through a route the adapter owns (`wh_label` if/when a second call site appears). Discriminator: *origin* = telepty-internal (allowed) vs orchestrator-intent (adapter route). Supersedes §11.1's "carve-out, revisit later" with this explicit boundary. | Boundary documented; no orchestrator-intent label write bypasses the adapter. |
| **BC6** | **§2 honest re-definition.** "Seamless parity" = **functional parity achieved** (spawn/close/focus/alive/list/prune/status/inject all work on cmux AND warp) **+ bounded ready-attestation asymmetry** (cmux=surface-attested, warp=process-or-AX-attested). The asymmetry is the honest declaration of a platform limit (Warp has no CLI), **not a design defect**. Update §6/§8 wording from "one caveat" to this framing. | §6/§8 reworded; matrix labels warp ready-gate as `bounded`, not `unsupported` or silent. |

**Separated scope (NOT part of #608):** standalone telepty ghost-tab accumulation — `closeSurface` is a gated no-op already landed (`AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE` default OFF), so a standalone telepty (no orchestrator) currently ships leaking ghost tabs. This is a **distinct active P1** (telepty surface-GC / default policy), tracked separately (tq#609) and noted in §9 Consequences. Folding it into #608 would be scope creep.

**Approval path:** these 6 criteria are now part of the spec. User approval of this ADR (with §12) → coder Phase 1 (cmux `wh_open` move, byte-equivalent gate). No implementation before approval.
