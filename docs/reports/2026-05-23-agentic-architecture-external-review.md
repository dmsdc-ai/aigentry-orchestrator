# Agentic 5-Tier Architecture — External Cross-Review

**Date**: 2026-05-23
**Reviewer**: `agentic-architect-agentic-review` (architect role, ADR critique scope)
**Subject**: Orchestrator's self-proposed 5-tier "Agentic" architecture (self-rated 82/120; 6.83/10 avg)
**Purpose**: Cross-check against external architectural frameworks; expose self-bias from the orchestrator scoring its own proposal.
**Scope**: Review only — no code edits, no tests, no builds (Constitution §3 architect role).

---

## 0. Self-bias caveat (read first)

This review session is itself an LLM (Claude-family, same as the proposer). Self-bias risks **in both directions**:

- **Confirmation bias**: Sibling-model alignment — I may reach the same conclusions because training corpus overlaps.
- **Anti-establishment bias**: Training corpus includes heavy "monolith bad / microservice criticism / DDD overhyped" material — could push toward systematic critique.
- **K8s-favoritism**: My pretraining over-indexes on Kubernetes patterns; a single-user local-first runtime does not need K8s-grade observability/lease semantics, but I may anchor scores there anyway.

Where these biases plausibly bent scores, the cell carries a `[bias-flag]` note. Net effect on Σ-delta is discussed in §5.5.

---

## 1. Standard frameworks cross-check (≥2 mandated; 5 evaluated)

### 1.1 Kubernetes controller pattern (level-triggered + owner-reference + finalizers)

**Verbatim (benchmark report §5.1, T2):**
> "Kubernetes controllers are level-driven. They don't care what happened — they care about the current state versus the desired state."
> "The workqueue doesn't hold events, it holds keys, which enables level-based reconciliation."
> "Reconcile functions should be idempotent—running them multiple times should produce the same result, which makes it robust against missed events and ensures eventual consistency."

**Alignments with Agentic:**
- ADR `2026-05-20-session-lifecycle-3-layer.md` Layer Reconciler **canonically** adopts the K8s pattern (level-triggered sweep, `state/dispatch/active.json` as GC root, exponential backoff, idempotent destructive ops, bounded reap delay ≤ `reconcile_interval × 2`). This is the strongest single alignment in the entire proposal.
- Tier 3 (Coordination + Lifecycle: orchestrator + devkit + hooks + sandbox) ≈ K8s control-plane.

**Deltas (deviations from K8s):**
- **K8s has ~3 layers (control-plane / data-plane / kubelet), not 5.** Agentic's 5-tier rubric is K8s-conceptually overcounted. K8s separates: etcd (state) ≠ apiserver (contract) ≠ kubelet (transport) ≠ scheduler (policy). Agentic Tier 2 lumps telepty (transport) + aterm (UI) + bridge + brain (memory) + deliberation (consensus) + context (state) into one tier — six heterogeneous concerns flattened. **Risk: "Core God-tier."**
- **K8s apiserver enforces contracts at admission time (OpenAPI schema validation, admission controllers).** Agentic ssot "Contract Authority" is, per current state, a documentation registry — no runtime admission. Promotion to "typed Interface Authority" matches the K8s pattern *in language* but lacks the enforcement seam. Big semantic gap.
- K8s has unified events stream + audit log via apiserver. Agentic has per-component NDJSON telemetry (e.g., `~/.aigentry/telemetry/spawn-events-YYYY-MM-DD.ndjson`) — no central event bus. Cross-tier debugging requires log-grep across 23 repos.

### 1.2 Hexagonal (Ports and Adapters) / Clean Architecture

**Reference (industry-standard):** Alistair Cockburn 2005; Robert C. Martin "Clean Architecture" 2017. Domain core has zero infrastructure dependency; ports define inbound/outbound boundaries; adapters implement ports for concrete tech (HTTP, DB, terminal, etc.).

**Alignments:**
- **Workspace Host adapter pattern** (cmux / zellij / headless / windows-terminal — introduced in the session-lifecycle ADR) is **canonical hexagonal**. Multiple adapters behind one port (`workspace_host.close(host_id)`); no-op semantics for headless. Textbook ports-and-adapters.
- Cross-AI CLI seam (claude / codex / gemini) fits "external systems behind adapters."
- Orchestrator-as-thin-director ≈ "use cases / application layer" being thin in Clean Architecture.

**Deltas:**
- **Hexagonal is NOT tiered — it is concentric** (domain center → application → ports → adapters). The Agentic "5-tier" naming connotes a stack/hierarchy that Hexagonal explicitly rejects. The two mental models are not the same shape.
- **Where is the domain core?** Hexagonal demands a domain core with zero infrastructure dependency. The proposal does not articulate one. Constitution is meta-policy, not a runtime domain model. *Candidate* domain core under Agentic: `Session + Dispatch + REPORT contract` (the lifecycle abstractions in CONTEXT.md ubiquitous language). But this is not stated. **Blind spot #7 — see §3.**

### 1.3 Domain-Driven Design (Bounded Contexts + Ubiquitous Language)

**Reference:** Evans 2003. Strategic patterns: Shared Kernel, Customer/Supplier, Conformist, Anti-Corruption Layer, Open Host Service, Published Language.

**Alignments:**
- 23 sibling repos as 23 Bounded Contexts — strategic-DDD-conformant.
- **CONTEXT.md per repo** captures ubiquitous language explicitly (`Session`, `Workspace Host`, `REPORT`, `CLEANUP_REQUEST`, `HOLD inject` in orchestrator/CONTEXT.md). Textbook DDD discipline; strongest single alignment after the Reconciler.
- Per-component CLAUDE.md/AGENTS.md replicates the per-BC documentation pattern.

**Deltas:**
- **23 BCs is at the upper end of practical DDD manageability.** Evans cautioned ~5–10 BCs per team. Single-user-with-LLM-sessions operates more like a single team; the cognitive surface is high. (D2 self-rated 4/10 — already acknowledged.)
- **Cross-BC strategic patterns are not enumerated.** Which BC pairs are Shared Kernel vs Open Host Service vs Anti-Corruption Layer? Without a Context Map, contract changes are case-by-case rather than pattern-driven. Constitution §15 (SSOT contract registration) is the procedural rule; the missing layer is the strategic-pattern map.

### 1.4 SOLID

| Principle | Agentic alignment | Note |
|---|---|---|
| **S**RP | **Strong** | Constitution §3 component table with explicit "절대 하지 않는 것" clauses per component is rigorous SRP. |
| **O**CP | **Mixed** | Workspace Host adapter = OCP-friendly. Cross-cutting changes (telemetry / lifecycle / new ADR-MF entries) require multi-repo edits because there is no extension-point registry beyond ssot text. |
| **L**SP | **N/A→Weak** | Workspace Host headless adapter is a no-op — downstream code expecting observable workspace effect is fine for cleanup (idempotent) but could violate LSP if any caller depends on side-effect verification. |
| **I**SP | **Strong** | Permission capabilities (`spawn_l1`, `spawn_l2`, role→capability subset per ADR §4.6.2) are granular and role-specific. Textbook ISP. |
| **D**IP | **Mixed** | Orchestrator depends on ssot (high→low ✓). Intra-Tier-2 coupling (telepty ↔ aterm ↔ brain) direction not analyzed in the proposal; bidirectional Tier-2 coupling would violate DIP. |

### 1.5 Microkernel / Plugin architecture (optional, evaluated)

**Alignments:**
- Constitution §17 (Zero External Dependency) + opt-in extension ethos matches microkernel philosophy.
- Tier 0 installer + Tier 4 Role Sessions ≈ kernel + plugins.

**Deltas:**
- **Microkernel demands a *narrow* core ABI.** Agentic Tier 2 "core runtime" has 6 components — that is not a microkernel; it is a mid-sized decomposed monolith. The proposal misuses the microkernel label if it is intended.

---

## 2. 12-Dimension Re-score (External lens)

| # | Dimension | Self | External | Δ | Framework reference for delta |
|---|---|---:|---:|---:|---|
| D1 | 헌법 정합 (§1/§2/§3/§9/§17) | 9 | 6 | **−3** | §1.2 framework-introduction question **never asked about the 5-tier rubric itself**. Meta-bias. |
| D2 | Onboarding / Cognitive load | 4 | 3 | −1 | DDD 23-BC upper bound + AGENTS.md ~23 hard rules + Rule 4-A 4-way + 18 Constitution articles. |
| D3 | AI-navigability | 8 | 8 | 0 | Per-repo CONTEXT.md ubiquitous-language is genuinely strong. No delta. |
| D4 | Maintainability | 7 | 6 | −1 | ssot Contract Authority benefit projected, not realized (K8s lens). |
| D5 | Testability | 8 | 7 | −1 | Per-repo testability strong; cross-repo integration test surface is N². |
| D6 | Performance / Latency | 6 | 6 | 0 | LLM latency dominates; inter-component latency is fine at this scale. `[bias-flag: external lens almost rated 7]` |
| D7 | Scalability (repo/role 추가) | 8 | 7 | −1 | Repo addition is cheap but cognitive load compounds (D2). |
| D8 | Failure mode handling | 7 | 6 | −1 | 3-layer cleanup ADR is K8s-grade strong; deduction is for cross-tier observability gap (no central audit log). `[bias-flag: K8s-favoritism — see §5.4]` |
| D9 | Tool / Infra overhead | 9 | 8 | −1 | ssot promotion to typed Interface Authority would introduce schema/codegen tooling — not free. |
| D10 | Economic / Cost efficiency | 7 | 7 | 0 | Per-architecture impact ≈ 0; LLM API cost dominates. |
| D11 | Standards / Industry maturity | 3 | 3 | 0 | Self-rating accurate; could argue 2/10 (multi-CLI agent orchestration as a category does not exist in standards bodies). |
| D12 | Multi-tenant evolvability | 6 | 4 | **−2** | No namespace primitive (K8s lens). Constitution §6 sovereignty single-user-baked. |
| **Σ** | | **82** | **71** | **−11** | |

### 2.1 Top-3 delta reasoning chains

**D1 (−3) — headline finding: meta-bias on the 5-tier rubric itself.**

Constitution §1.2: "프레임워크/라이브러리 도입 전 '이거 없이 직접 구현할 수 있는가?' 먼저 질문한다." The Agentic 5-tier rubric is itself a framework imposed on the ecosystem's mental model. The orchestrator applied §1.2 rigorously to *other* components (rejected GUI frameworks in terminals, rejected unnecessary abstraction layers) but **did not apply §1.2 to its own meta-rubric.** This is textbook proposer-bias: the proposer's own scaffolding is invisible to the proposer.

Mitigating note: if the 5 tiers are purely descriptive labels (not runtime layers), §1.3 ("불필요한 추상화 레이어를 추가하지 않는다") does not strictly apply — rubric-vs-runtime distinction. But Tier 1 ssot promotion from docs-registry to "typed Interface Authority" *is* a proposed runtime layer addition. So part of the proposal is rubric-only (cheap) and part is runtime (expensive). The mix was not separated in self-scoring.

**D12 (−2) — multi-tenant evolvability: no namespace primitive.**

K8s namespace is the canonical multi-tenant isolation primitive: one cluster, many tenants, declarative quotas per namespace, RBAC per namespace. Agentic has no namespace concept. Every user = full orchestrator + telepty + brain + 20 sibling repos on their own machine. This matches Constitution §6 (sovereignty, local-first) and is correct for the current single-user-developer target. But "evolvability" specifically asks: *can this architecture grow into multi-tenant?* The answer is "only by reworking §6." Self-score 6 implies optionality; external score 4 reflects that the rework cost is Constitutional, not infrastructural — i.e., the highest-cost kind of change. **Caveat:** if multi-tenant is explicitly out of scope (single-user-forever), self-score 6 is defensible and external 4 over-weights a non-goal.

**D8 (−1) — failure mode handling: cross-tier observability gap.**

The 3-layer session lifecycle (Layer A owner-declared + Layer D orchestrator timeout + Layer Reconciler level-triggered sweep) is genuinely production-grade and adopts the strongest patterns from the benchmark (lease-with-renewal + reconciler + bounded reap delay). External score 6 (vs self 7) deducts 1 point for the K8s-vs-Agentic delta: K8s aggregates events at apiserver; Agentic per-component NDJSON requires cross-repo grep for forensic investigation of cross-tier failures. `[bias-flag]` This delta may reflect my K8s-favoritism — single-user-LLM workflows rarely need a central audit bus. Self-score 7 may in fact be correct; external 6 may be over-corrected. Bias-adjusted estimate: 6.5–7.

---

## 3. Blind spot / hidden assumption inventory (8 enumerated)

1. **Single-user assumption is Constitutional, not just default.** §6 "데이터는 사용자의 머신에 저장한다" bakes single-user/local-first into the highest-priority document. Multi-user, team, or enterprise usage is not just unsupported — it requires Constitutional amendment.

2. **CLI vendor stability is uncontracted.** §2 Cross-AI promises CLI-neutrality, but there is no vendor SLA, no contractual versioning. If Anthropic, OpenAI, or Google change CLI output buffering, prompt-injection sanitization, or session protocols, telepty (Tier 2) breaks. The Cross-AI promise is aspirational, not contractual.

3. **Markdown-as-protocol is fragile.** HOLD / REPORT / CLEANUP_REQUEST / SAWP envelopes are unstructured markdown strings emitted by LLMs and regex-parsed by orchestrator. The benchmark report (§3) cites lease-with-renewal (etcd, Consul, DHCP) as the universal lifecycle primitive — those protocols are typed (gRPC/HTTP+JSON). Agentic implements lease semantics via *natural language*. False-positive risk (LLM prose containing "REPORT:" in unintended position) and parser-divergence risk are real.

4. **ssot is registry, not admission controller.** Constitution §15 mandates SSOT contract registration — but registration ≠ enforcement. K8s apiserver rejects malformed CRDs at write time; ssot has no equivalent gate. The architecture *talks like* it has a contract authority but currently only has a contract index.

5. **Cross-machine has no auth/capability model for inject.** Permission Manager (ADR-MF #8) gates `spawn` operations via `SessionContext.permissions`. There is no equivalent gate on `telepty inject`. In a single-machine single-user world this is fine; the moment Cross-Machine (§2.1) becomes real with multiple humans, any session can inject any session. Major security blind spot if scope expands.

6. **Constitution is enforced socially, not type-encoded.** Every session re-reads Constitution + checklist; compliance is per-LLM-session discipline. There is no runtime gate that rejects a proposal violating §3 component roles or §17 zero-dep. Drift across hundreds of sessions is statistically inevitable. Hexagonal lens: policy should be encoded as types/contracts; here it is encoded as docs.

7. **No expressed domain core.** Hexagonal demands a domain core with zero infrastructure dependency. "AI Development Runtime" as a marketing-tier description is not a runtime domain model. The closest candidate (Session + Dispatch + REPORT contract) is implicit in CONTEXT.md but not crystallized as the architectural center. Without an explicit core, "where does this concern belong?" answers default to "wherever the proposer is currently working" — exactly the bias this dispatch was designed to catch.

8. **LLM cost as architecture parameter is unmodeled.** 23 repos × per-repo context loading × per-session AGENTS.md re-read = compound token cost. D10 self-rates 7/10 acknowledging cost exists, but there is no architecture-level cost model (no per-namespace quota analog from K8s, no token budget profiling per tier). For an AI-native runtime where the dominant cost is AI inference itself, this is a curious omission.

### 3.1 Top-3 most architecturally consequential (per orchestrator request)

- **#6 social-only Constitution enforcement** — every other blind spot is downstream of this. Type-encoded constraints would catch #3, #4, #5, #7 at write time.
- **#4 ssot is registry-not-admission-controller** — promotion to "typed Interface Authority" remains aspirational without this; D4/D8 deltas hinge on it.
- **#3 markdown-as-protocol** — the lease pattern in the benchmark report requires typed contracts; Agentic's natural-language lease has unbounded false-positive surface.

### 3.2 Meta-bias finding (elevated from D1)

The orchestrator created the 5-tier rubric and the "Microservice/Agentic name choice" decision *while invoking* §1.2 framework-introduction-question on other architectural choices. The orchestrator's own meta-framework escaped its own §1.2 gate. This **is** the headline self-bias the dispatch was designed to surface; it is structural (proposer-bias) rather than carelessness.

---

## 4. Counterfactual paths — dimension-by-dimension

Each counterfactual scored against the **same 12 dimensions**, starting from external scores in §2 (71/120 baseline). Negative entries marked.

### 4.1 (a) Monorepo + workspace path

Single repo, workspace-tooling (npm workspaces / pnpm / cargo workspaces / Bazel) for per-package isolation.

| # | Dim | Agentic ext | Monorepo | Δ vs ext | Note |
|---|---|---:|---:|---:|---|
| D1 | Constitution | 6 | 7 | +1 | §1 lightweight wins (no tier-rubric); §9 independence weakened but workspace-extractable |
| D2 | Onboarding | 3 | 6 | +3 | One repo to clone; one CI |
| D3 | AI-nav | 8 | 8 | 0 | Single AGENTS.md surface; trade per-repo scoping for unified search |
| D4 | Maintainability | 6 | 8 | +2 | Atomic cross-cutting changes; no version skew |
| D5 | Testability | 7 | 7 | 0 | Similar |
| D6 | Perf/Latency | 6 | 6 | 0 | Similar |
| D7 | Scalability | 7 | 6 | −1 | New repo = new workspace member (slightly heavier than new sibling repo) |
| D8 | Failure mode | 6 | 8 | +2 | Atomic deploys, no inter-repo version skew, unified observability easier |
| D9 | Tool overhead | 8 | 8 | 0 | Similar (workspace tooling required) |
| D10 | Cost | 7 | 7 | 0 | Similar |
| D11 | Industry maturity | 3 | 5 | +2 | Google/Meta/Microsoft monorepo precedent |
| D12 | Multi-tenant | 4 | 4 | 0 | No improvement |
| **Σ** | | **71** | **80** | **+9** | |

**Lose**: §9 component-independent install (mitigatable with workspace extraction), per-repo git history granularity, per-component independent release cadence.
**Gain**: D2/D4/D8/D11. Substantial on cognitive load + maintainability + observability.
**Verdict**: Polyrepo bet pays off only if external contributors materialize (each repo independently maintainable). For current single-user-with-LLM-sessions reality, monorepo's D2/D4/D8 wins are load-bearing.

### 4.2 (b) All-service Microservice path

Every repo becomes long-running daemon with HTTP/gRPC API. Service mesh, discovery, mTLS.

| # | Dim | Agentic ext | Microservice | Δ vs ext | Note |
|---|---|---:|---:|---:|---|
| D1 | Constitution | 6 | 3 | −3 | §1 lightweight badly violated; §10 one-click violated |
| D2 | Onboarding | 3 | 2 | −1 | More infra concepts (mesh, discovery, TLS) |
| D3 | AI-nav | 8 | 6 | −2 | More moving parts to navigate |
| D4 | Maintainability | 6 | 6 | 0 | Service contracts stable but mesh ops add toil |
| D5 | Testability | 7 | 8 | +1 | Services testable via API |
| D6 | Perf/Latency | 6 | 4 | −2 | HTTP roundtrips dominate when LLM not in path |
| D7 | Scalability | 7 | 9 | +2 | Horizontal scale trivial |
| D8 | Failure mode | 6 | 9 | +3 | Real distributed tracing, real lease semantics |
| D9 | Tool overhead | 8 | 3 | −5 | Mesh + discovery + cert mgmt is heavy |
| D10 | Cost | 7 | 5 | −2 | Always-on services cost > on-demand LLM sessions |
| D11 | Industry maturity | 3 | 8 | +5 | Microservice is well-trodden |
| D12 | Multi-tenant | 4 | 9 | +5 | Trivial via namespace+RBAC |
| **Σ** | | **71** | **72** | **+1** | |

**Lose**: Constitution §1 and §10 take direct hits; D6/D9 large losses.
**Gain**: D7/D8/D11/D12 large wins.
**Verdict**: Roughly even Σ but **profile shifts radically** — right architecture for managed-service product, wrong architecture for local-first single-user runtime. Picking this path = pivot from product category, not just a refactor.

### 4.3 (c) Hexagonal-per-repo only (no tier rubric)

Drop 5-tier mental model. Each repo articulates its domain core + ports + adapters. ssot becomes the published-language documentation.

| # | Dim | Agentic ext | Hex-only | Δ vs ext | Note |
|---|---|---:|---:|---:|---|
| D1 | Constitution | 6 | 8 | +2 | §1 lightweight wins by removing tier-rubric layer; §3 separation preserved via ports |
| D2 | Onboarding | 3 | 4 | +1 | One pattern (Hexagonal) vs (tier × port × adapter) three axes |
| D3 | AI-nav | 8 | 7 | −1 | Less explicit tier-routing for LLM session selection |
| D4 | Maintainability | 6 | 7 | +1 | Cleaner DI direction |
| D5 | Testability | 7 | 8 | +1 | Ports = mock points are canonical |
| D6 | Perf/Latency | 6 | 6 | 0 | Similar |
| D7 | Scalability | 7 | 7 | 0 | Similar |
| D8 | Failure mode | 6 | 7 | +1 | Port contracts make failure modes explicit |
| D9 | Tool overhead | 8 | 8 | 0 | Similar |
| D10 | Cost | 7 | 7 | 0 | Similar |
| D11 | Industry maturity | 3 | 5 | +2 | Hexagonal is industry-recognized |
| D12 | Multi-tenant | 4 | 4 | 0 | No improvement |
| **Σ** | | **71** | **78** | **+7** | |

**Lose**: Tier-rubric as delegation-routing mental model that orchestrator finds useful. "Coordination + Lifecycle" Tier 3 grouping dissolves into flat adapters.
**Gain**: D1/D5/D11 substantial; D2/D4/D8 minor.
**Cost**: Must articulate a domain core (currently unarticulated — blind spot #7). Likely candidate: `Session + Dispatch + REPORT` contract.
**Verdict**: Best Σ-improvement counterfactual *if* domain core can be articulated. The cost is intellectual (forces "what IS the runtime domain?" question), not infrastructural.

### 4.4 Counterfactual summary

| Path | Σ | Δ vs Agentic | Verdict |
|---|---:|---:|---|
| Current Agentic (5-tier) | 71 | 0 | Baseline |
| (a) Monorepo + workspace | **80** | **+9** | Load-bearing on D2/D4/D8/D11; requires §9 reinterpretation |
| (b) Microservice | 72 | +1 | Product-category pivot; not a refactor |
| (c) Hexagonal-per-repo only | **78** | **+7** | Best architectural cleanup if domain core articulable |

**Two counterfactuals (a, c) beat the current proposal on unweighted-12-dim sum.** Not soft-pedaling. Weighting per scenario could change the picture (orchestrator's "가중 시나리오별 6.5~7.2" range suggests this), but the unweighted signal is too large to dismiss as noise.

---

## 5. Verdict + recommendation

### 5.1 Verdict: **accept-with-amendments**

The 5-tier Agentic proposal is **not wrong** but is **proposer-biased**. Its strongest pieces (Workspace Host adapter, 3-layer session lifecycle, per-repo ubiquitous language via CONTEXT.md, permission-capability ISP) are independent of the 5-tier rubric and stand on their own. The 5-tier rubric and the ssot "Interface Authority" promotion are the parts most exposed to the meta-bias of "proposer never asked §1.2 about own framework."

### 5.2 Required amendments

Each amendment cites the blind-spot (BS#) or counterfactual (CF-a/b/c) it addresses.

1. **Separate descriptive rubric from runtime layer.** State explicitly which parts of the 5-tier proposal are mental-model-only (cheap, OK) and which add runtime structure (expensive, must pass §1.2). Today the two are conflated; the conflation is what hides the meta-bias. *Addresses*: §3.2 meta-bias, D1 −3 delta.

2. **Articulate the domain core.** Hexagonal demands it; Agentic does not have it. Propose: `Session + Dispatch + REPORT/CLEANUP_REQUEST contract` as the runtime domain core. Everything else (telepty, cmux adapter, brain, deliberation) is an adapter around this core. This rewrites Tier 2 from "core God-tier" to "adapter cluster around an explicit domain center." *Addresses*: BS#7 (no expressed domain core), CF-c Hexagonal-only +7 path. *Captures*: most of CF-c gain without dropping the polyrepo bet.

3. **ssot promotion must include enforcement seam.** If ssot is to be "typed Interface Authority" (K8s apiserver analog), it must reject malformed contracts at write time, not at code-review time. A docs-only "Interface Authority" is rhetoric, not architecture. Concrete proposal: ssot publishes a JSON Schema / TypeScript types repo; CI gate in every consumer repo validates against the published types at PR time. (This is a small build-time tool, not a runtime daemon — preserves §1 lightweight.) *Addresses*: BS#4 (ssot registry-not-admission), §1.1 K8s apiserver delta, D4 −1 delta.

4. **Type-encode the lifecycle protocol.** HOLD/REPORT/CLEANUP_REQUEST/SAWP should be a parseable envelope (minimally: JSON-line emitted by session, fenced inside a markdown code block for human readability, schema-validated by orchestrator pre-dispatch-mutation). Free-form markdown header with regex parse is brittle. The benchmark's lease-with-renewal pattern (§3) requires typed contracts; Agentic's natural-language lease cannot claim that pattern without this. *Addresses*: BS#3 (markdown-as-protocol), §1.1 K8s typed-contract delta.

5. **Acknowledge single-user-Constitutional baking.** Constitution §6 + §2 Cross-Machine combination only works for single-user. State this explicitly. If multi-tenant evolvability matters (D12), open a Constitutional amendment thread; otherwise, lower D12 to "out-of-scope" and remove it from the scorecard rather than scoring it 6/10 on optionality. *Addresses*: BS#1 (single-user Constitutional baking), BS#5 (no inject auth), D12 −2 delta.

6. **Cross-tier observability proposal.** Per-component NDJSON is fine for per-component telemetry, but cross-tier debugging requires either (a) a tiny event aggregator (`bin/event-aggregate.sh` that tails all NDJSON files into a unified view) or (b) an explicit decision to accept "log-grep is the audit trail." Currently implicit — make it explicit. *Addresses*: §1.1 K8s audit-log delta, D8 −1 delta.

7. **Type-encode the top Constitution gates.** Social-only enforcement guarantees drift. At minimum, encode §3 component-role boundary checks (e.g., architect-role session may not write to non-`docs/` paths) as a pre-commit hook + dispatch-time validator. *Addresses*: BS#6 (social-only Constitution), upstream of BS#3/#4/#5/#7.

8. **Hybrid mono+poly migration for the most coupled cluster.** Capture most of CF-a +9 gain without §9 violation: workspace-extract `orchestrator + ssot + devkit + hooks` into a single workspace-tool monorepo; keep peripheral repos (analyst/architect/logger sessions; amplify/registry/forum) as siblings. *Addresses*: CF-a Monorepo +9 (D2 +3, D4 +2, D8 +2, D11 +2 captured), preserves §9 for the long tail.

### 5.2.1 Amendment ↔ finding cross-reference matrix

| # | Amendment | Blind spots addressed | Counterfactual captured | Δ-points reclaimed |
|---|---|---|---|---|
| 1 | Rubric/runtime split | meta-bias, D1 | — | ~+1 D1 |
| 2 | Domain core articulation | BS#7 | CF-c partial | ~+2 (D1, D4, D5) |
| 3 | ssot enforcement seam | BS#4 | — | ~+2 (D4, D8) |
| 4 | Type-encode lifecycle protocol | BS#3 | — | ~+1 (D8) |
| 5 | Single-user Constitutional baking explicit | BS#1, BS#5 | — | ~+1 (D12 — by scope-clarifying rather than mock-scoring) |
| 6 | Cross-tier observability decision | — | — | ~+1 (D8) |
| 7 | Type-encode Constitution gates | BS#6 (upstream of #3/#4/#5/#7) | — | ~+1 (D1) |
| 8 | Hybrid mono+poly cluster | — | CF-a partial | ~+4 (D2, D4, D8, D11) |
| **Σ** | | | | **~+13 (capped at +11 to land at ~84/120)** |

Amendments 1–8 together would recover the full Σ-delta and likely improve beyond self-score 82, *without* requiring full Hexagonal rewrite or full monorepo migration.

### 5.3 Counterfactual recommendation

The two best counterfactuals (monorepo +9, hexagonal-only +7) are not mutually exclusive with each other and *could* combine with amendments #1–#6. Concrete recommendation hierarchy:

- **Lowest-risk path**: Adopt amendments #1, #2, #3 above (rubric/runtime split + domain core articulation + ssot enforcement seam) inside the current polyrepo + 5-tier-as-rubric scheme. Δ ≈ +5 to +7 (most of the Hexagonal-only gain without architectural disruption).
- **Medium-risk path**: + adopt monorepo via workspace tooling for the most coupled sibling cluster (orchestrator + ssot + devkit + hooks). Keep peripheral repos (analyst/architect/logger sessions; amplify/registry/forum) as siblings. Hybrid mono+poly captures most of the +9 monorepo gain without §9 violation.
- **High-risk path**: Full Hexagonal rewrite + monorepo migration. Δ ≈ +12 but requires Constitutional review (§9 reinterpretation) and migration cost (orchestrator self-flagged risk #4 "migration cost 미정량").

### 5.4 Weighted-dimension sensitivity (does the counterfactual win survive weighting?)

Unweighted Σ favors CF-a (+9) and CF-c (+7) over current Agentic. The orchestrator's own scoring noted weighted scenarios produce 6.5–7.2 (vs unweighted 6.83) — weights matter. Three weighting scenarios:

**Scenario W1 — Constitution-mandated weights (D1, D9, D2 boosted ×3; D11, D12 deboosted ×0.5):**
Captures §1 lightweight + §10 one-click + §11 격차해소 priority. D11 and D12 are explicit non-goals for current single-user local-first product.

| Path | Σ (weighted) | Verdict |
|---|---:|---|
| Current Agentic | (6+3+8+6+7+6+7+6+8+7+3+4) → weighted: 9·3 + 3·3 + 8 + 6 + 7 + 6 + 7 + 6 + 8·3 + 7 + 3·0.5 + 4·0.5 = 27+9+8+6+7+6+7+6+24+7+1.5+2 = **110.5** | Baseline |
| CF-a Monorepo | weighted: 7·3 + 6·3 + 8 + 8 + 7 + 6 + 6 + 8 + 8·3 + 7 + 5·0.5 + 4·0.5 = 21+18+8+8+7+6+6+8+24+7+2.5+2 = **117.5** | +7 |
| CF-b Microservice | weighted: 3·3 + 2·3 + 6 + 6 + 8 + 4 + 9 + 9 + 3·3 + 5 + 8·0.5 + 9·0.5 = 9+6+6+6+8+4+9+9+9+5+4+4.5 = **79.5** | **−31 — disqualified** |
| CF-c Hex-only | weighted: 8·3 + 4·3 + 7 + 7 + 8 + 6 + 7 + 7 + 8·3 + 7 + 5·0.5 + 4·0.5 = 24+12+7+7+8+6+7+7+24+7+2.5+2 = **113.5** | +3 |

**W1 ranking: CF-a (117.5) > CF-c (113.5) > Agentic (110.5) >> CF-b (79.5).** Even under Constitution-favoring weights, both monorepo and hexagonal-only remain ahead. CF-b is correctly killed.

**Scenario W2 — Enterprise/Scaling weights (D7, D11, D12 boosted ×3; D9 deboosted ×0.5):**
Captures "what if multi-tenant matters" or "what if we want external adopters."

| Path | Σ (weighted) | Verdict |
|---|---:|---|
| Current Agentic | weighted: 6 + 3 + 8 + 6 + 7 + 6 + 7·3 + 6 + 8·0.5 + 7 + 3·3 + 4·3 = 6+3+8+6+7+6+21+6+4+7+9+12 = **95** | Baseline |
| CF-a Monorepo | weighted: 7 + 6 + 8 + 8 + 7 + 6 + 6·3 + 8 + 8·0.5 + 7 + 5·3 + 4·3 = 7+6+8+8+7+6+18+8+4+7+15+12 = **106** | +11 |
| CF-b Microservice | weighted: 3 + 2 + 6 + 6 + 8 + 4 + 9·3 + 9 + 3·0.5 + 5 + 8·3 + 9·3 = 3+2+6+6+8+4+27+9+1.5+5+24+27 = **122.5** | **+27.5 — clear winner** |
| CF-c Hex-only | weighted: 8 + 4 + 7 + 7 + 8 + 6 + 7·3 + 7 + 8·0.5 + 7 + 5·3 + 4·3 = 8+4+7+7+8+6+21+7+4+7+15+12 = **106** | +11 |

**W2 ranking: CF-b (122.5) >> CF-a = CF-c (106 tie) > Agentic (95).** Under enterprise weights, the verdict flips: microservice is correct. **This confirms that CF-b is not wrong — it's right *for a different product*.**

**Scenario W3 — AI-Dev-Runtime-realistic (the actual current state — D3 AI-nav and D2 onboarding boosted ×2; D11, D12 ×0.5):**

| Path | Σ (weighted) | Verdict |
|---|---:|---|
| Current Agentic | weighted: 6 + 3·2 + 8·2 + 6 + 7 + 6 + 7 + 6 + 8 + 7 + 3·0.5 + 4·0.5 = 6+6+16+6+7+6+7+6+8+7+1.5+2 = **78.5** | Baseline |
| CF-a Monorepo | weighted: 7 + 6·2 + 8·2 + 8 + 7 + 6 + 6 + 8 + 8 + 7 + 5·0.5 + 4·0.5 = 7+12+16+8+7+6+6+8+8+7+2.5+2 = **89.5** | +11 |
| CF-b Microservice | weighted: 3 + 2·2 + 6·2 + 6 + 8 + 4 + 9 + 9 + 3 + 5 + 8·0.5 + 9·0.5 = 3+4+12+6+8+4+9+9+3+5+4+4.5 = **71.5** | −7 |
| CF-c Hex-only | weighted: 8 + 4·2 + 7·2 + 7 + 8 + 6 + 7 + 7 + 8 + 7 + 5·0.5 + 4·0.5 = 8+8+14+7+8+6+7+7+8+7+2.5+2 = **84.5** | +6 |

**W3 ranking: CF-a (89.5) > CF-c (84.5) > Agentic (78.5) > CF-b (71.5).** The actual current-state weighting *does not flip* the verdict — counterfactual gains hold.

**Sensitivity conclusion**: Across three weighting scenarios (Constitution-mandated, Enterprise, AI-Dev-Runtime-realistic), CF-b is the right answer in W2 only (enterprise pivot); CF-a (Monorepo) and CF-c (Hexagonal) remain ahead of current Agentic in W1 and W3. **The unweighted counterfactual win is robust to weighting unless the product pivots to enterprise multi-tenant.** Amendment #8 (hybrid mono+poly) captures most CF-a gain across all three weighting scenarios.

### 5.5 Inverse self-bias check (per orchestrator request)

Where review-session bias plausibly bent scores:

- **D8 −1 (cross-tier observability)**: My K8s-favoritism. Single-user LLM workflows rarely need a central audit bus. Bias-adjusted: 6 → 7. Net Σ adjustment: +1.
- **D1 −3 (Constitution alignment)**: Rubric-vs-runtime distinction may have been conflated. If 5-tier is pure rubric (not runtime layer), §1.3 strictly doesn't apply. The ssot-promotion piece of the proposal *is* runtime layer; rest is rubric. Bias-adjusted: 6 → 7 (still −2, the meta-bias finding survives). Net Σ adjustment: +1.
- **D6, D11**: Self-scores already accurate or charitable. No bias adjustment.

**Bias-adjusted Σ: 71 + 2 = 73/120 (vs self 82, Δ = −9 instead of −11).** Verdict and amendments unchanged; the meta-bias finding (D1 and §1.2-never-asked-on-own-rubric) is robust to bias correction. Counterfactuals (a) and (c) still both beat bias-adjusted Σ.

### 5.6 What this dispatch confirmed

The orchestrator's own list of top-5 risks ("self-rated bias 자체" as risk #5) was *the* correct anticipation. The biggest single delta in this review is D1 = −3, driven by the meta-bias of applying §1.2 selectively. The dispatch design (commissioning external review specifically to break the self-bias cycle) succeeded in surfacing what self-review structurally cannot.

---

## 6. Constraints respected (audit trail)

- [x] No code edits / no tests / no builds (architect scope)
- [x] ≥2 external frameworks (5 evaluated: K8s, Hexagonal, DDD, SOLID, Microkernel)
- [x] Held at every phase boundary with real `telepty inject` HOLD (not markdown)
- [x] 12 dimensions only — no dimension added
- [x] Every score carries reasoning + framework reference
- [x] Self-bias caveat documented (§0 + §5.4)
- [x] 5+ blind spots (8 enumerated)
- [x] 3 counterfactuals × 12-dim each
- [x] Weighted-dimension sensitivity analysis (3 weighting scenarios)
- [x] Verdict explicit (accept-with-amendments) + 8 amendments enumerated + cross-reference matrix
- [x] Output = single markdown file (Rule 29 surgical)

---

*End of external review. Scope: architect role, ADR critique. Implementation decisions (ssot deepening, Session Lifecycle contract specifics) are out-of-scope and belong to subsequent architect / implementation sessions.*
