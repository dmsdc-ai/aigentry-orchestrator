# ADR Metadata-first — gemini review r1 (researcher perspective)

## Verdict
ACCEPT_WITH_MINOR_FIXES

## Top 3 industry-comparison findings
1. **Convergence with OCI/Capability Security**: The `child.permissions ⊆ parent.permissions` constraint (G5) perfectly aligns with WASI and seL4 capability-based security models. This is highly robust for recursive agent spawning.
2. **Divergence from Conversational Handoffs**: While frameworks like OpenAI Swarm and AutoGen rely on message history and conversational state for context sharing, aigentry's metadata-first approach (three-axis separation) is closer to Kubernetes Pod specs or Temporal event sourcing. This is a unique and superior approach for deterministic hierarchy.
3. **Missing Supervision/Pruning Limits**: Deferring depth/fan-out limits (Q-OPEN-3) is risky. In actor models (Erlang/Akka) and HTN planners, unbounded children typically require strict supervision trees and garbage collection. Pruning (Q-OPEN-5) should be elevated from deferred to a fast-follow priority.

## Section-by-section research findings

### §1-3 Context / problem / forces
The problem of "spooky action at a distance" (cwd-driven role inference) is a known pitfall in early agent frameworks where ambient context pollutes instructions. Aigentry correctly identifies this.

### §4 Decision — compare to LangGraph / CrewAI / AutoGen / Swarm / Anthropic
Aigentry's Spawn API gate diverges from Swarm's function-based handoffs and CrewAI's implicit manager delegation. By explicitly separating cwd, role, and task, aigentry introduces a K8s-like declarative orchestration that is more deterministic than standard conversational frameworks. The immutable SessionContext snapshot is conceptually identical to LangGraph's state checkpoints but enforces a stricter append-only schema (like Temporal's event sourcing).

### §5 Layer-aware — multi-agent frameworks comparison
L1 tree recursion acting as the sole infinite-depth path is sound. It mirrors the Erlang/Akka actor model where actors spawn child actors out-of-process.

### §6 Migration — established staged-rollout patterns
The warn-mode validation behind a flag is a standard industry practice (e.g., Kubernetes admission controller dry-runs).

### §7 Consequences — alternatives correctness
Rejecting isolated cwd per session is correct; it mirrors Docker's container decoupling where the filesystem mount (cwd) is orthogonal to the entrypoint/user (role).

### §8 Open questions — industry-known answers?
Q-OPEN-5 (Snapshot pruning/GC) is critical. In Temporal and event-sourcing systems, history truncation or snapshots are mandatory to prevent disk exhaustion.

## Convergence / divergence with industry
- **aigentry uniquely contributes:** The K8s-like deterministic layered resolver for assembling prompts from purely decoupled metadata axes (cwd/role/task).
- **aigentry standard practice:** Capability subsetting (WASI/seL4) and immutable checkpoints (LangGraph/Temporal).
- **aigentry potentially missing:** Strict supervision bounds and automated GC for the append-only lineages.

## Anthropic Claude Code Agent View comparison (2026-05-11)
- **Integration vs separation recommendation:** Anthropic's Agent View provides a dashboard for parallel sessions. Aigentry's `lineage.json` and `state/sessions/index.json` are perfectly structured to act as a backend for such a dashboard. Aigentry should integrate by exposing a command that formats its metadata for ingestion by the Agent View UI, rather than building a separate visualization layer.

## Citations
- [1] WASI (WebAssembly System Interface) Capability-based Security Model
- [2] Temporal Durable Execution & Event Sourcing
- [3] OpenAI Swarm Handoff Pattern Documentation
- [4] Kubernetes Pod Specification vs Namespace decoupling
- [5] Erlang/OTP Actor Model & Supervision Trees

## Recommendation for next rev
Elevate Q-OPEN-3 (Limits) and Q-OPEN-5 (GC) to higher priorities, as infinite-depth recursion without bounds or garbage collection inevitably leads to resource exhaustion in production actor models.
