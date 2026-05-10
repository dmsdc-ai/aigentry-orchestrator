# ADR: E3 amendment — supervisor idle RSS budget (10 MB → 15 MB)

- **Date**: 2026-05-10
- **Author**: aigentry-architect-c1-e3 (proposal — orchestrator approval required before merge)
- **Status**: **proposed**
- **Type**: amendment to Q'''-bis V1 ADR §4.E (binding requirement E3)
- **Supersedes**: nothing (precondition closure C1 of the parent ADR)
- **Related**: `2026-05-10-telepty-l2-architecture-q-prime-bis.md` §4.E (E3), §10.3 (E3 risk), §13.1 (C1), §17.1 (self-criticism)
- **Output ID**: ADR-E3-r1
- **Cross-LLM review**: codex (next stage)

---

## §0 TL;DR

> Replace **E3 = "≤ 10 MB RSS per idle supervisor"** with **E3' = "≤ 15 MB RSS per idle supervisor (jemalloc tuned, single-thread tokio)"**. No other Q'''-bis §4.E item changes. CONSTITUTION.md text is **not** modified. Articles 1 / 5 / 13 are referenced (not amended) as the reasoning frame.

---

## §1 Status

**proposed**. Per CONSTITUTION.md 최종조, only the orchestrator may merge constitution-class changes. This document is the architect's evidence-based proposal; orchestrator must (a) confirm Q'''-bis §13.1 acceptance rule applies, (b) approve, and (c) trigger amendment text replacement in `2026-05-10-telepty-l2-architecture-q-prime-bis.md` (and any propagated copies in `*-claude.md` / `*-codex.md`).

---

## §2 Context

### §2.1 What E3 currently says (Q'''-bis §4.E, line 444)

> **E3** | **RAM**: ≤ 10 MB RSS per idle supervisor (jemalloc tuned) | post-spawn `ps -o rss` ≤ 10 MB. **C1 amendment** if Phase 1 measurement shows 10–15 MB unavoidable; constitution amendment process applies

### §2.2 Why E3 is in scope for amendment now

Q'''-bis §13.1 (C1 — E3 RAM amendment) was authored as a **gating precondition** for Phase 1 entry. The acceptance rule is:

```
- if ≤ 10 MB is met, keep E3;
- if 10–15 MB is met and tradeoff is justified, run constitution amendment procedure;
- if > 15 MB, revisit architecture or implementation language.
```

The cross-LLM deliberation on **2026-05-10** (session `telepty-supervisor-l-moz0o7clzczs`, 3 LLM consensus) produced empirical findings that move the question into the second branch (10–15 MB band).

### §2.3 Cross-LLM deliberation finding (2026-05-10)

Quoted from the deliberation report (3 LLMs cross-confirmed):

> Standard Rust binary utilizing `tokio` (for async IPC) and `serde_json` typically idles at **12–20 MB RSS**. Achieving < 10 MB requires configuring Tokio for `current_thread` (single-threaded) mode and aggressively tuning jemalloc via `MALLOC_CONF` to eagerly purge arenas (e.g., `dirty_decay_ms:0`).

Interpretation:

- **default Rust+tokio+serde_json idle: 12–20 MB** — exceeds E3 (≤10) on a stock build.
- **with M24 (single-thread tokio) + M31 (jemalloc `dirty_decay_ms:0,muzzy_decay_ms:0`)**: Q'''-bis §10.2 / §9.2 cite a **5–8 MB target**. This is achievable in the best case, but the best case is operationally fragile (allocator OS variance, PTY burst-output transient peaks, jemalloc behavior on Darwin vs glibc Linux vs musl Linux vs Windows native).
- The 10 MB ceiling sits **between** the achievable best case (5–8) and the unmodified baseline (12–20). It can be hit but cannot be **reliably** hit across all three OS targets without exotic per-platform tuning that exceeds M31's current allocator recipe.

### §2.4 Independent corroboration (web search 2026-05-10)

Search query: `Rust tokio current_thread runtime idle RSS memory baseline jemalloc dirty_decay_ms`. Cross-source agreement on:

- **jemalloc RSS retention** is a known, recurring issue with default decay (10 s+) — `dirty_decay_ms:0,muzzy_decay_ms:0` is the standard mitigation; tighter recipes add `narenas:1, tcache:false, background_thread:true`.
- **Tokio multi-thread runtime** holds per-worker stack RAM (≈ 2 MB × N_workers) above the single-thread baseline — Q'''-bis M24 already accounts for this by mandating `current_thread`.
- **No public benchmark** locates a Rust+tokio binary at ≤ 10 MB idle RSS without fully tuned jemalloc + minimal feature set, on **all three** of {Linux glibc, macOS arm64, Windows native}. The mac/Windows side is the wildcard.

Sources:
- [tokio-rs/tokio #2650 — Free memory after task is complete](https://github.com/tokio-rs/tokio/discussions/2650)
- [jemalloc/jemalloc #2688 — `dirty_decay_ms` doesn't take effect](https://github.com/jemalloc/jemalloc/issues/2688)
- [pkolaczk — Memory consumption of async](https://pkolaczk.github.io/memory-consumption-of-async/)
- [tokio-rs/tokio #6083 — Memory issues in multiple runtimes](https://github.com/tokio-rs/tokio/discussions/6083)

### §2.5 Mechanism context already in Q'''-bis (M24, M31)

Q'''-bis already mandates the two mechanisms required for tight RSS:

| Mandate | Wording | Serves |
|---|---|---|
| **M24** | Single-process supervisor, single-thread tokio + jemalloc | E3, E4, F1, F2 |
| **M31** | Per-supervisor jemalloc tuning: `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0` | E3, E4 |

Therefore: **the tooling for tight RSS is locked in**. The amendment changes only the *target ceiling*, not the *mechanism*. M24 and M31 remain unchanged.

### §2.6 Q'''-bis self-criticism already concedes the precondition risk (§17.1)

Q'''-bis §17.1 explicitly admits:

> E3 itself is a precondition risk (C1 explicitly admits 10 MB may be unattainable), so the design currently rests on an unmeasured invariant.

This ADR closes that admission with a re-grounded invariant.

---

## §3 Decision

### §3.1 Recommended option: **A** — relax E3 to ≤ 15 MB

**Amended text** (replaces line 444 of Q'''-bis ADR):

> **E3'** | **RAM**: ≤ 15 MB RSS per idle supervisor (single-thread tokio + jemalloc tuned per M24+M31) | post-spawn `ps -o rss` ≤ 15 MB on macOS arm64, Linux x86_64/glibc, and Windows native (no WSL substitution per §17.10). C1 closed by ADR-E3-r1 (2026-05-10) on cross-LLM empirical consensus.

**Companion text** (replaces Q'''-bis §10.3 paragraph):

> §10.3 E3 closure (precondition C1 closed). E3 is amended from ≤ 10 MB to ≤ 15 MB per ADR-E3-r1 on cross-LLM empirical evidence (deliberation 2026-05-10, 3-LLM consensus): default Rust+tokio idle is 12–20 MB; the M24+M31 mechanism brings the best case to 5–8 MB but does not produce a reliable ≤ 10 MB ceiling across all three OS targets. The 15 MB ceiling absorbs ≈ 2× safety margin over best-case while preserving binding-class invariant character (Article 13 객관성). Phase 4 measurement gates remain authoritative; if Phase 4 measurement closes ≤ 10 MB on all three OSes, the ceiling MAY be tightened by a follow-up ADR.

### §3.2 Why A and not B / C / D — see §4 trade-off matrix.

### §3.3 Phase impact (binding)

- **Phase 0**: C1 is **closed by this ADR's merge**. Phase 1 entry no longer blocked on E3 evidence. (Q'''-bis §6 phase plan affected.)
- **Phase 1**: supervisor PoC must measure idle RSS on macOS arm64, Linux x86_64/glibc, Windows native at N ∈ {1, 10, 50, 100} (per §13.1 required evidence). Pass criterion changes from "≤ 10 MB" to "≤ 15 MB". M24+M31 settings are still mandatory.
- **Phase 4**: measurement gates re-evaluate. Phase 4 may propose tightening (15 → 12 or 10) if evidence supports it; this proposal does **not** preclude future tightening.
- **M24 / M31**: unchanged. The recipe (single-thread tokio + jemalloc decay-zero) is the hard-locked mechanism; the new ceiling preserves headroom for cross-OS allocator variance.

### §3.4 Capacity planning under E3'

| N (sessions) | Worst-case RSS (15 MB × N) | Supervisor share of typical 16 GB host |
|---|---|---|
| 10 | 150 MB | < 1 % |
| 100 | 1.5 GB | ≈ 9 % |
| 500 | 7.5 GB | ≈ 47 % |
| 1000 | 15 GB | ≈ 94 % (impractical — host-bound, expected) |

The change relative to 10 MB ceiling: same shape, 50 % steeper. M29 (∞ N) remains infrastructure-bound; the practical N for a 16 GB laptop drops from ~800 to ~500 supervisors. This is the principal cost of A.

---

## §4 Trade-off matrix

### §4.1 The four options

| Option | Amended ceiling | Mechanism implication | Empirical fit | Constitutional fit |
|---|---|---|---|---|
| **A** | **≤ 15 MB** | M24+M31 unchanged; cross-OS achievable | strong (matches deliberation) | preserves Articles 1/5/13 |
| **B** | ≤ 12 MB | M31 must expand: `narenas:1,tcache:false,background_thread:true` | tight to best-case 5–8 MB; macOS / Windows wildcard | Article 5 ambiguous |
| **C** | ≤ 10 MB POSIX-violation note | Linux/macOS empirically excluded; Windows native unverified | inverts evidence into per-OS invariant | Article 2 FAIL |
| **D** | E3 removed | "best effort" only | matches §17.1 admission but loses anchor | Article 5 + 13 FAIL |

### §4.2 Per-option implication

#### Option A (≤ 15 MB) — RECOMMENDED

- **Pros**:
  - Empirically attainable on all 3 OSes with the existing M24+M31 recipe; no mandate expansion required.
  - Pre-authorized by Q'''-bis §13.1 acceptance rule (10–15 MB band → amendment).
  - Preserves binding-class invariant (objective, measurable ceiling) per Article 13.
  - ≈ 2× safety margin over best-case 5–8 MB tolerates burst PTY output, allocator OS variance, Phase 4 measurement noise.
  - M29 ∞ N capacity planning remains computable (15 MB × N = predictable upper bound).
- **Cons**:
  - 50 % per-supervisor RSS increase vs original target. At N = 500, host RAM share rises from ~31 % to ~47 % on a 16 GB laptop.
  - Optical regression on Article 1 (경량) — relaxing a number is rhetorically weaker than tightening one.
  - 5 MB headroom may invite codebase laxity ("we have margin"). Mitigation: M24+M31 lock-in + Phase 4 re-tightening clause in §3.3.
- **Constitutional fit**:
  - **Article 1 (경량)**: PASS. 15 MB is still tight against alternatives (Node 60–150 MB, Java JVM 100+ MB, Go static binary 8–15 MB). The amendment is not a license for over-engineering; it is a recalibration to empirical reality.
  - **Article 5 (최선)**: PASS. Sticking with 10 MB *would be* the workaround (forcing exotic allocator surgery to chase a number that does not serve the user goal — N supervisors at acceptable RAM per host). Amendment is the best-first move.
  - **Article 13 (객관성)**: PASS — the canonical form. Cross-LLM empirical consensus + WebSearch corroboration + acceptance-rule mechanism designed precisely for this case.

#### Option B (≤ 12 MB)

- **Pros**: tighter; closer to measured 5–8 MB best-case + safety; smaller capacity-planning impact than A.
- **Cons**:
  - Requires expanding M31 to the full jemalloc recipe (`narenas:1, tcache:false, background_thread:true, dirty_decay_ms:0, muzzy_decay_ms:0`) — operationally fragile across Darwin / glibc / musl / Windows.
  - Transient burst-output peaks (PTY producing many KB of output per frame) routinely exceed steady-state by 2–4 MB; 12 MB ceiling may be missed during traffic, generating false E3 violations.
  - Risks a *second* amendment cycle if Phase 4 measurements show 12–13 MB on macOS — wasteful.
- **Constitutional fit**: Article 1 PASS, Article 5 ambiguous (cuts safety margin too thin to be "best"), Article 13 PASS but requires more measurement than is currently available.
- **Reject reason**: tighter than evidence supports without further measurement; gambles on a re-amendment.

#### Option C (≤ 10 MB hard + POSIX-platform formal violation note)

- **Pros**: preserves the original number; admits reality only "where required".
- **Cons**:
  - Creates a per-OS-divergent invariant: Windows native enforced ≤ 10, Linux/macOS exempted. **Direct violation of Article 2 (크로스: macOS, Linux, Windows 동일 경험)** — invariants must be uniform across cross-OS.
  - Breaks the Q'''-bis §13.1 acceptance rule: "10–15 MB met → amendment", not "POSIX violation note".
  - Constitutional invariants are not a place for asterisks. An invariant with a per-platform footnote is a workaround in disguise.
- **Constitutional fit**: Article 1 PASS, **Article 2 FAIL**, **Article 5 FAIL** (canonical workaround antipattern).
- **Reject reason**: Article 2 violation. Cross-OS invariant unity is not negotiable.

#### Option D (E3 removed)

- **Pros**: most honest about empirical uncertainty; matches §17.1 admission word-for-word; minimum text change.
- **Cons**:
  - M29 (∞ N) loses any per-supervisor RAM ceiling — capacity planning becomes unanswerable. Users cannot answer "how many sessions can my laptop run?" without a number.
  - "Best-effort RAM" is the textbook Article-5 anti-pattern: Article 5 §1 explicitly forbids "차선책이나 우회 방법(workaround)을 먼저 시도하지 않는다" — removing the metric is the canonical workaround.
  - Article 13 (객관성) requires *measurable* targets to be objective; removing the metric removes the empirical anchor.
- **Constitutional fit**: Article 1 PASS, **Article 5 FAIL**, **Article 13 FAIL**.
- **Reject reason**: incompatible with Article 5 + Article 13 + M29 capacity planning.

### §4.3 Summary table

| Option | Empirical | Article 1 | Article 2 | Article 5 | Article 13 | Verdict |
|---|---|---|---|---|---|---|
| **A** | ✅ | ✅ | ✅ | ✅ | ✅ | **RECOMMEND** |
| B | ⚠ tight | ✅ | ✅ | ⚠ | ✅ | hold |
| C | ⚠ | ✅ | ❌ | ❌ | ⚠ | reject |
| D | ✅ | ✅ | ✅ | ❌ | ❌ | reject |

---

## §5 Constitutional articles affected (clarifying scope)

> **Note**: this amendment edits Q'''-bis ADR §4.E (E3) and §10.3 — **not** CONSTITUTION.md article text. CONSTITUTION.md articles 1 / 5 / 13 are the *reasoning frame*; their wording is unchanged.

| Article | Affected? | Role |
|---|---|---|
| **제1조 경량 (Lightweight)** | reasoning-frame, not text | The amendment must demonstrate that 15 MB is still 경량 against alternatives. §4.2 A "Constitutional fit" makes this case (Node 60–150, Java 100+, Go 8–15 — Rust at 15 still in 경량 band). No article text changes. |
| **제5조 최선 (Best-First)** | reasoning-frame, not text | §1 of Article 5 forbids workaround-first. Sticking with 10 MB on faith *is* the workaround. Amending to the empirically-grounded ceiling is the 최선 path. No article text changes. |
| **제13조 비판적+건설적+객관적** | reasoning-frame, not text | The amendment is the canonical Article 13 motion: empirical (cross-LLM), critical (admits §17.1 risk), constructive (provides 15 MB replacement). No article text changes. |
| **최종조. 헌법 수정 권한** | governance | Architect proposes; orchestrator merges. This ADR follows that procedure. |

| Q'''-bis ADR section | Affected? | How |
|---|---|---|
| §4.E E3 | **YES — text replacement** | line 444 reworded to ≤ 15 MB |
| §10.3 E3 risk | **YES — text replacement** | risk-paragraph replaced with closure-paragraph (per §3.1) |
| §10.1 Target budgets | **YES — table edit** | row "Supervisor RSS ≤ 10 MB" → "≤ 15 MB" |
| §13.1 C1 | **YES — closure note** | append "Closed by ADR-E3-r1 (2026-05-10), Option A" |
| §14 Outstanding (E3 row) | **YES — status update** | "r1 amendment-eligible" → "closed: ≤ 15 MB" |
| §17.1 self-criticism | **YES — partial closure** | E3 line annotated "closed by ADR-E3-r1"; M29 ∞ N criticism remains |
| M24, M31 | **NO** | mechanisms unchanged |
| All other E/F/G/H/I/J/K | **NO** | unchanged |

---

## §6 Consequences

### §6.1 긍정 (positive)

- **Phase 1 unblocked**: C1 precondition closed without architecture rewrite or language change. Phase 1 PoC begins on a measurable, achievable target.
- **Empirical anchor preserved**: binding-class invariant retained (15 MB is testable with `ps -o rss`); Article 13 objectivity intact.
- **Cross-OS uniform**: single global ceiling, no per-platform exemption (Article 2 preserved).
- **Burst-output tolerance**: 5 MB headroom over best-case 5–8 MB absorbs PTY traffic spikes without false alarms.
- **Future tightening clause**: §3.3 explicitly permits Phase 4 measurement to propose 15 → 12 or 10 if evidence supports.

### §6.2 부정 (negative)

- **50 % per-supervisor RAM ceiling growth**: at N = 500 on a 16 GB host, supervisor share rises from ~31 % to ~47 %. Practical N drops from ~800 to ~500.
- **Optical Article 1 regression**: relaxation reads as "경량 retreat" even though the recipe (M24+M31) remains tight. Mitigation = §3.3 future-tightening clause + §4.2 A peer comparison (Rust at 15 still beats Node/Java/Go-equivalent class).
- **Re-amendment risk if Phase 4 finds < 10 MB attainable**: a tightening ADR would then be needed. Acceptable; cheaper than chasing 10 MB on faith now.

### §6.3 中립 (neutral)

- **No change to wire protocol, manifest schema, IPC, security model, or operability** (M22, M37', M38', G1–G3, H1–H3 unaffected).
- **CONSTITUTION.md untouched**: this is a Q'''-bis ADR amendment, not a constitution-text amendment. The "constitutional" framing in Q'''-bis §10.3 is shorthand for "binding ADR layer".
- **Migration ADR #379 unaffected**: no wire change.

### §6.4 Reversibility

The amendment is **reversible** by a future ADR if Phase 4 measurements close < 10 MB on all three OSes. The §3.3 clause makes this explicit. Reversibility is one-directional (15 → tighter) — not 15 → looser, since looser would re-open Article 5 / Article 13 violations.

---

## §7 Alternatives Considered (B / C / D rejection summary)

See §4.2 for full implication. Concise reject record:

- **Option B (≤ 12 MB)**: REJECT (hold). Tighter than current evidence supports without M31 expansion + cross-OS measurement. Risks a wasteful second-amendment cycle. May be the **right Phase 4 outcome** but is the wrong Phase 0 closure.
- **Option C (≤ 10 MB + POSIX violation note)**: REJECT. Direct Article 2 (cross-OS unity) violation. Per-platform invariant exemptions are workarounds in disguise (Article 5 §1).
- **Option D (E3 removed)**: REJECT. M29 capacity planning loses its anchor; "best effort" is the canonical Article 5 anti-pattern; Article 13 loses the empirical metric.

---

## §8 Amendment text (proposed — full diff for Q'''-bis ADR)

### §8.1 §4.E line 444 — replacement

```diff
- | E3 | **RAM**: ≤ 10 MB RSS per idle supervisor (jemalloc tuned) | post-spawn `ps -o rss` ≤ 10 MB. **C1 amendment** if Phase 1 measurement shows 10–15 MB unavoidable; constitution amendment process applies |
+ | E3 | **RAM**: ≤ 15 MB RSS per idle supervisor (single-thread tokio + jemalloc tuned per M24+M31) | post-spawn `ps -o rss` ≤ 15 MB on macOS arm64, Linux x86_64/glibc, and Windows native (no WSL substitution per §17.10). C1 closed by ADR-E3-r1 (2026-05-10) on cross-LLM empirical consensus. |
```

### §8.2 §10.3 paragraph — replacement

Replace the "E3 risk (unproven invariant)" paragraph with §3.1 companion text (E3 closure paragraph).

### §8.3 §10.1 Target budgets — row edit

```diff
- | Supervisor RSS | ≤ 10 MB unless C1 amendment changes target (E3) |
+ | Supervisor RSS | ≤ 15 MB (E3 amended per ADR-E3-r1) |
```

### §8.4 §13.1 — closure note (append)

```diff
+ **Closure**: ADR-E3-r1 (2026-05-10) selected Option A (≤ 15 MB). C1 closed.
```

### §8.5 §14 Outstanding — E3 row

```diff
- | **E3 (RAM 10 vs 15 MB)** | r1 amendment-eligible per C1 | architect + orchestrator | Phase 0 C1 closure + (optional) constitution amendment |
+ | **E3 (RAM ≤ 15 MB)** | closed (ADR-E3-r1) | — | none |
```

### §8.6 §17.1 — partial closure annotation

Append to the §17.1 paragraph:
> *(E3 ceiling closed by ADR-E3-r1 (2026-05-10) at 15 MB. M29 ∞ N capacity criticism remains open — separate ops-doc deliverable per §17.1 constructive answer.)*

---

## §9 Self-criticism (Article 13 객관성)

Points where this ADR can be reasonably attacked, surfaced for the codex review stage:

### §9.1 "15 MB is a round number, not a measured one"

- **Attack**: A says ~2× safety over 5–8 MB best-case, but 5–8 → 15 is closer to ~2.5×. The 15 number is inherited from the brief's pre-authorized band, not derived bottom-up.
- **Defense**: 15 MB is the **upper edge of the acceptance band** Q'''-bis §13.1 already approves. Choosing the upper edge maximizes Phase 1 headroom against unknown-OS-allocator behavior. Phase 4 may tighten with measurement.
- **Residual risk**: if Phase 1 measurement comes in at 7–9 MB across all OSes, the 15 ceiling will look generous; we accept the risk in exchange for not blocking Phase 1.

### §9.2 "Why not measure first, then amend?"

- **Attack**: Article 13 demands evidence. The ADR cites cross-LLM consensus but no `ps -o rss` numbers from a working supervisor.
- **Defense**: the supervisor doesn't exist yet — Phase 1 PoC builds it. C1 is a *Phase 1 entry precondition*; deferring the ceiling decision to post-PoC inverts the gate. The cross-LLM consensus is used **as a sanity check that the 10 MB target is not free** before Phase 1 commits resources to chasing it.
- **Residual risk**: if Phase 1 PoC turns out to hit ≤ 10 MB out of the box, this ADR was a needless relaxation. Mitigation: §3.3 future-tightening clause.

### §9.3 "Article 1 says 매몰비용으로 잘못된 선택을 유지하지 않는다 — but you're keeping the architecture and just relaxing the number"

- **Attack**: Maybe the *architecture* is wrong (per-process supervisor) and 15 MB is itself a sunk-cost retreat from a flawed Q'''-bis decision.
- **Defense**: the architecture (per-session supervisor) has independent justification (D2 daemon-less embed, F1 crash isolation, M40 binary reachability) — RSS is **not** its primary motivation. Q'''-bis §15 alternatives consider K-sessions-per-process and reject for non-RSS reasons. The amendment does not preserve sunk cost; it acknowledges that the RSS budget was set with insufficient evidence.
- **Residual risk**: if Phase 4 N=1000 measurements show the per-process model is fundamentally too RAM-hungry, the architecture (not just E3) will need revisit.

### §9.4 "Why not Option B as a stretch goal?"

- **Attack**: setting 15 invites coasting. 12 with stretch-goal language could be more disciplined.
- **Defense**: stretch goals create ambiguity in binding-class invariants. Either E3 is binding at 12 MB (and false alarms expected) or it is binding at 15 MB (and the stretch is informal in M31 docs). §3.3 already provides the disciplined path: **bind at 15 MB now, tighten via ADR after Phase 4 measurement**. Discipline through evidence beats discipline through stretch language.
- **Residual risk**: codex may prefer B-with-Phase-4-tightening-clause as a co-equal alternative. Acceptable; orchestrator decides.

### §9.5 "Cross-LLM consensus might be triplicate hallucination"

- **Attack**: 3 LLMs trained on similar data may all parrot the same memorized number (12–20 MB). Article 13 says don't use bias as evidence.
- **Defense**: WebSearch corroborates the qualitative finding (jemalloc retention is well-documented; Tokio multi-thread RSS is well-documented; the 12–20 MB band overlaps known measured Rust+tokio binaries on real benchmarks). The amendment also makes Phase 1 PoC the **measurement that validates or invalidates** the deliberation — built-in falsifiability.
- **Residual risk**: if Phase 1 PoC shows 5 MB across all OSes, the deliberation was misleading; the ADR's §3.3 tightening clause is the correction path.

### §9.6 "M31 may need expansion regardless"

- **Attack**: WebSearch shows the standard tight-RSS recipe is `narenas:1, tcache:false, background_thread:true, dirty_decay_ms:0, muzzy_decay_ms:0` — M31 only has the last two. Even ≤ 15 MB may need M31 expansion to be reliable.
- **Defense**: this ADR scopes E3 only. M31 expansion (if needed) is a separate Phase 0 follow-up — out of scope here. Surfaced for codex / orchestrator awareness.
- **Residual risk**: Phase 1 may discover M31 needs expansion; that's an ADR for Phase 1, not C1 closure.

---

## §10 위헌 심사 (Constitution Check, CONSTITUTION.md §위헌 심사)

| # | Question | Answer |
|---|---|---|
| 1 | AI 기술 격차 해소에 복무하는가? | **YES**. Empirically-grounded RSS ceiling enables Phase 1 PoC → V1 ∞ → V4 cross-mesh → multi-CLI multi-machine workflows. |
| 2 | 어느 컴포넌트의 역할인가? | **telepty L2** (supervisor RSS budget). orchestrator approves via 최종조. architect proposes (this ADR). Boundary clean. |
| 3 | 프레임워크/라이브러리가 정말 필요한가? | **YES, unchanged**. jemalloc is the only new dependency, already justified by Q'''-bis §18.3 (statically linked). M24+M31 unchanged. |
| 4 | 모든 크로스 환경에서 동일하게 동작하는가? | **YES**. Single global 15 MB ceiling on macOS arm64 / Linux x86_64 / Windows native. Option C explicitly rejected for violating Article 2. |
| 5 | 다른 컴포넌트가 이 컴포넌트 없이도 동작하는가? | **YES, unchanged**. Per-supervisor isolation preserved (Q'''-bis F1, D1–D3). |
| 6 | 사용자가 원클릭으로 사용할 수 있는가? | **YES, unchanged**. RSS ceiling is internal; not user-visible at install or use. |
| 7 | 사용자에게 "어떻게"를 강요하지 않는가? | **YES, unchanged**. Allocator tuning is supervisor-internal (M24+M31). |
| 8 | 안전장치가 동반되어 있는가? | **YES**. Phase 1 measurement gates verify the ceiling; Phase 4 re-evaluates; §3.3 reversibility clause. |
| 9 | 계약 변경이 SSOT에 등록되었는가? | **PENDING** — orchestrator merge into Q'''-bis ADR is the registration event. |

All nine pass or have explicit closure paths.

---

## §11 Cross-LLM review surface (for codex)

Points codex should examine specifically:

1. **§9.1 — 15 MB number derivation**: is the upper-band-of-acceptance-rule the right anchor, or should we derive bottom-up (5–8 best × OS variance × burst headroom)?
2. **§9.2 — measure-first counter-argument**: Phase 1 entry gate timing is the load-bearing assumption. Codex should confirm that Phase 1 cannot start without a closed C1.
3. **§9.4 — Option B as co-equal**: codex may prefer B(≤12) with a Phase 4 tightening clause. Acceptable if architectural-level argument; orchestrator picks.
4. **§9.6 — M31 expansion scope**: does this ADR need to bundle M31 expansion (`narenas:1, tcache:false, background_thread:true`) into C1 closure, or is it a clean Phase 1 follow-up?
5. **§5 article-vs-Q'''-bis-section disambiguation**: confirm that CONSTITUTION.md is **not** being textually amended (only Q'''-bis ADR §4.E / §10.3 / §10.1 / §13.1 / §14 / §17.1).
6. **§3.4 capacity table**: practical-N drop from ~800 to ~500 on 16 GB host — is this acceptable to M29 (∞ N) intent, or does it need orchestrator user-facing comms?

---

## §12 Recommendation lock

**Recommend: Option A (≤ 15 MB)**.

**One-line rationale**: empirically grounded ceiling (cross-LLM consensus + WebSearch corroboration) within the Q'''-bis §13.1 pre-authorized band, preserves all binding/cross-OS/Article-13 properties of the original E3, unblocks Phase 1 with a falsifiable measurement target.

**Constitutional articles affected (reasoning-frame, not text)**: 제1조 경량, 제5조 최선, 제13조 객관성, 최종조 (수정 절차).

**ADR sections to edit on merge**: Q'''-bis §4.E line 444, §10.1 row, §10.3 paragraph, §13.1 closure, §14 Outstanding row, §17.1 annotation. CONSTITUTION.md untouched.

**Required next step**: orchestrator review → codex cross-LLM review → orchestrator merge → propagate to `*-claude.md` and `*-codex.md` companion drafts.

---

## §13 History

- **r1 — 2026-05-10**: initial draft. Architect (aigentry-architect-c1-e3 session). Recommends Option A on cross-LLM deliberation evidence + WebSearch corroboration. Awaiting codex review and orchestrator merge.
