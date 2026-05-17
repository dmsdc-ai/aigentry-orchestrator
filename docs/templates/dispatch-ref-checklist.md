# Dispatch Ref Pre-flight Checklist

Run this **before** sending any dispatch inject. Companion to `docs/templates/dispatch-ref-template.md`.
Hard-gate: if any unchecked item violates, fix before injecting.

---

## A. Front-matter & framing

- [ ] **dispatch_kind set**: explicitly `fresh-session` OR `re-dispatch` in front-matter (no implicit default)
- [ ] **Self-contained disclaimer present**: top-of-file callout stating "THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC" + path-disclaimer for `state/...` / `docs/...` / `bin/...`
- [ ] **Title format**: `# Dispatch — <session-name> — <one-line summary>`
- [ ] **All placeholders filled**: zero `<unsubstituted>` angle-brackets remain

## B. Self-containment (the #396 gate)

If `dispatch_kind: fresh-session`:

- [ ] **Every cited Rule N appears verbatim in §Inline excerpts** (not just name-only in §Constraints)
- [ ] **Every cited Constitution §N appears verbatim in §Inline excerpts**
- [ ] **Every cited ADR / spec is either inlined OR explicitly marked "context-only — receiver does not need to fetch"**
- [ ] **[SAWP] envelope is verbatim in §[SAWP] envelope** (NOT a name-only cite to `docs/sawp.md`)
- [ ] **No jargon-by-name without inline gloss** in §Background (e.g., "M1-M5" → "M1-M5 supervisor Phase 1 spike (spawn/observe, graceful kill, IPC wire, cross-OS, manual integration)")
- [ ] **Orchestrator-side paths flagged**: any `state/...` path explicitly marked as orchestrator metadata, not a file the receiver must fetch

If `dispatch_kind: re-dispatch`:

- [ ] **"Carry-over from <prior-dispatch>" note present** at top — proves receiver has prior context
- [ ] **Diff-only context**: §Background covers ONLY what changed since prior dispatch

## C. HOLD inject protocol (the #397 gate)

- [ ] **Dedicated `## HOLD inject protocol` section present** with exact format `HOLD: <tag> | phase: <N>/<total> awaiting | reason: ... | needs: ...`
- [ ] **HOLD is specified as a real `telepty inject` shell call** (NOT inline markdown in receiver's reply)
- [ ] **Every phase boundary in §Workflow ends with explicit "HOLD inject (format below)" instruction** (not just "Stop")
- [ ] **"Silent waiting = §13 violation" reminder present** in HOLD protocol section

## D. SAWP & rule compliance

- [ ] **Dedicated `## [SAWP] envelope` section present** with Rule 17 verbatim envelope (S/A/W/P expanded)
- [ ] **Snyk section present**: applicable (with phase + commands) OR explicit "N/A — <reason>" (per CLAUDE.md global rule)
- [ ] **Constitution §1 lightweight**: each section ≤30 lines; whole ref ≤350 lines
- [ ] **Rule 29 surgical**: §Goal scope is bounded; no drive-by refactor / reformat invitation in §Workflow

## E. REPORT format

- [ ] **Final REPORT inject template present** with `telepty inject --ref --submit --submit-retry 2 --from <sid> <orchestrator-sid> "REPORT: <tag>-DONE | ..."` shape
- [ ] **REPORT includes task #N reference** (links back to issue tracker / task queue)
- [ ] **REPORT includes verifiable evidence keys** (commit sha, file path, command exit-code)

## F. Boundary & full capability

- [ ] **§Boundary lists explicit do-nots** (no cross-repo, no extra session spawn, etc.)
- [ ] **§Boundary lists escalation triggers** (which conditions require HOLD before destructive action)
- [ ] **§Full capability lists allowed tools** (Read/Edit/Bash/etc.) — receiver knows what is authorized
- [ ] **§Full capability lists allowed skills + MCP servers** (or explicit "none")

## G. Orchestrator-side hygiene

- [ ] **Target session exists** (`telepty list | grep <session-id>`) OR explicit `--spawn-and-dispatch` plan
- [ ] **Dispatch uses `bin/dispatch.sh` helper** (Rule 32 HARD — wave + ref-payload dispatches MUST use helper)
- [ ] **Receiver cwd matches §Role scope** (e.g., builder session cwd = repo to release)
- [ ] **Self-test plan exists**: after Phase 3 land, will rewrite one existing dispatch ref to verify template fits (per task #396/#397 dispatch §Workflow Phase 3 step 4)

---

## Quick-check (TL;DR — 8 lines)

If you cannot answer YES to all 8 below, do NOT inject:

1. dispatch_kind front-matter set?
2. Self-contained disclaimer at top?
3. Every cited rule/§ verbatim in §Inline excerpts? (fresh-session only)
4. [SAWP] envelope verbatim in dedicated section?
5. HOLD inject = real `telepty inject` call (not markdown) + at every phase boundary?
6. Snyk section present (applicable phase OR N/A reason)?
7. REPORT inject template + task #N + verifiable evidence keys?
8. §Boundary + §Full capability complete?

---

## Failure mode catalog (when checklist fails)

| Missed item | Real-world failure | Task |
|---|---|---|
| B — name-only citation | Fresh `release-aigentry-telepty-builder` halted: "the source spec must be elsewhere" — 1 wasted round-trip | #396 |
| C — implicit Stop | Same builder reached Phase 3→4, self-corrected, held silently → orchestrator dead-reckoning until user surfaced "왜 그냥 대기?" | #397 |
| C — HOLD as markdown | Receiver prints `HOLD: ...` in reply, never calls `telepty inject` → orchestrator never notified → silent wait reproduced | #397 (meta) |
| A — unsubstituted placeholders | Receiver acts on `<session-name>` literal → undefined behavior | (preventive) |
| D — Snyk missing | First-party code committed without scan → CLAUDE.md global rule violation | (preventive) |
| G — wrong target sid | `telepty inject` exits 1 with "session not found" → dispatch fails silently | (preventive) |
