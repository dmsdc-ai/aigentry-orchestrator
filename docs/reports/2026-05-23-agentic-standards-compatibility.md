# Agentic Standards Compatibility Matrix

**Date**: 2026-05-23
**Author**: aigentry-dustcraw-agentic-standards (dustcraw role)
**Purpose**: Map aigentry's Agentic 5-tier architecture against 8 emerging agentic standards/platforms on 5 structural dimensions. **Information + trade-off enumeration only — no analysis, judgment, or "X is better" recommendation. Architect/analyst sessions consume this.**

**Scope per orchestrator decisions (Phase 1 ACK)**:
- **OpenAI slot**: `openai-agents-python` (production successor) — Swarm relegated to historical 1-paragraph note (educational/superseded).
- **Microsoft slot**: Semantic Kernel ONLY. Microsoft Agent Framework (MAF) is a newer unified successor — out-of-scope; informational caveat at end of §4.
- **ADK sources**: Re-fetched from canonical `adk.dev` + `github.com/google/adk-python` after Phase 1 summarizer noise on URL listing (see §3 source note).
- **LangGraph sources**: Re-fetched from `docs.langchain.com/oss/python/langgraph` after migration from `langchain-ai.github.io/langgraph`.
- **A2A sources**: `docs/specification.md` is primary; README overview-only.

---

## Executive Summary (5 bullets)

1. **Communication transport**: aigentry's PTY-text + sentinel-string protocol (`telepty inject` + REPORT/CLEANUP_REQUEST) has no direct equivalent in any of the 8 standards — all 8 use either in-process function calls (Swarm/SDK/SK/AutoGen/LangGraph/ADK), JSON-RPC over stdio/HTTP (MCP, A2A), or graph-edge message passing. Deviation is structural, not stylistic.
2. **Agent identity / lifecycle**: A2A's `Agent Card` (JSON-RPC over HTTP, opaque agents) and aigentry's `SessionContext` (sid + cwd + capability subset) are the only two models that treat agents as **out-of-process, addressable, capability-declaring** entities. Other 6 frameworks treat agents as **in-process class instances** with method-level invocation. Aigentry ↔ A2A is the closest peer pair on agent identity.
3. **Tools/capability model**: aigentry's Permission Manager Capability enum (typed, role→capability subset, hard-fail enforced per ADR §6 #11) shares lineage with MCP's capability-negotiation handshake and Semantic Kernel's Plugin abstraction. Anthropic Skills + ADK use **filesystem-discovered**, schema-frontmatter models — orthogonal axis (discovery, not enforcement).
4. **Lifecycle / GC**: aigentry's 3-layer (A self-report + D timeout + Reconciler) per ADR 2026-05-20 is closest to MCP's 3-phase lifecycle (Initialize / Operation / Shutdown) and A2A's 8-state Task lifecycle (`SUBMITTED→WORKING→COMPLETED|...`). In-process frameworks (Swarm, AutoGen, LangGraph, ADK, SDK, SK) collapse this into object-lifetime (no explicit GC).
5. **Schema/contract authority**: A2A's `spec/a2a.proto` (single normative source, regenerated bindings) is the closest external precedent for aigentry's proposed typed Interface Authority over ssot. Other frameworks either auto-derive schemas from code (OpenAI SDK, Swarm, ADK function tools) or rely on framework class hierarchies (SK, LangGraph TypedDict).

---

## Per-standard sections (8 × 5 dimension matrix)

### 1. Anthropic (Skills + Subagents + Agent SDK)

| Dimension | aigentry 현/제안 | Anthropic standard | Align / Deviate | 호환 비용 (qualitative) |
|---|---|---|---|---|
| 1. Agent definition | role-based session (sid + cwd + capability) | **Subagent**: "specialized AI assistants that handle specific types of tasks ... Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions." [T1, code.claude.com/docs/en/sub-agents]. **Skill**: "modular capabilities that extend Claude's functionality. Each Skill packages instructions, metadata, and optional resources" [T1, platform.claude.com/docs/en/agents-and-tools/agent-skills/overview]. | **Partial align** — subagent ≈ aigentry's role-session (own context + tool subset + permissions). Skill is orthogonal axis (capability bundle, not agent identity). | If Anthropic-style subagents become standard: aigentry sid→subagent mapping ~direct; capability→tool-allowlist mapping straightforward. Skills are additive (filesystem mount). |
| 2. Inter-agent communication | telepty inject (PTY text) + REPORT/CLEANUP_REQUEST sentinels | "When Claude encounters a task that matches a subagent's description, it delegates to that subagent, which works independently and returns results." [T1, code.claude.com]. Parent ↔ subagent is **auto-delegation by description match**; return is summary text only. | **Deviate** — Anthropic = description-driven auto-delegation (LLM picks subagent); aigentry = orchestrator-explicit `telepty inject --ref` with verbatim spec. No cross-host transport in Anthropic model (single-session). | If becomes standard: aigentry's explicit-delegate model would need wrapper allowing LLM-side description matching. Cross-host (telepty's strength) not supported by Anthropic model. |
| 3. Tool/capability model | Permission Manager Capability enum + ssot contracts + role→capability subset (G1–G6 gates) | Skills use 3-level "progressive disclosure": Level 1 metadata (always loaded), Level 2 SKILL.md (triggered), Level 3 resources/code (as needed) [T1, agent-skills/overview]. Subagents: "Enforce constraints by limiting which tools a subagent can use" [T1, code.claude.com]. | **Partial align** on enforcement (subagent tool subset ≈ capability subset). **Deviate** on discovery (Skills = filesystem progressive disclosure vs aigentry's typed enum). | If Skills+subagent model dominant: aigentry capability enum maps cleanly to subagent allowed-tools; Skills require new "filesystem skill mount" surface in aigentry. |
| 4. Lifecycle / GC | 3-layer ADR 2026-05-20 (A self-report + D timeout + Reconciler) | Subagents are ephemeral per-task: "the subagent does that work in its own context and returns only the summary" [T1]. No persistent agent lifecycle — implicit lifetime = single delegation call. Skills are filesystem-static (no lifecycle). | **Deviate** — Anthropic = implicit per-call lifetime, no GC needed. aigentry = long-lived sessions requiring explicit reconciliation. | If subagent-style becomes standard: aigentry's reconciler becomes irrelevant for that surface; would coexist with telepty-managed long-lived sessions. |
| 5. Schema/contract authority | ssot (typed Interface Authority proposal) | Skill YAML frontmatter: `name` (max 64 chars, lowercase letters/numbers/hyphens) + `description` (max 1024 chars). Required by Skill API. [T1, agent-skills/overview]. | **Partial align** — both use declarative frontmatter/manifest. Anthropic schema is minimal (2 fields); aigentry ssot is richer (contracts, capability enum). | Low cost to extend ssot to emit Skill-compatible YAML for export; reverse import lossy (Anthropic carries less info). |

**T1 sources (§1)**:
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://platform.claude.com/docs/en/build-with-claude/skills-guide
- https://code.claude.com/docs/en/sub-agents
- https://github.com/anthropics/skills
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills (T1 engineering blog)

---

### 2. OpenAI Agents Python (production successor to Swarm)

| Dimension | aigentry 현/제안 | openai-agents-python | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | "Agents, which are LLMs equipped with instructions and tools." `Agent(name="Assistant", instructions="You are a helpful assistant")` [T1, openai.github.io/openai-agents-python]. | **Deviate** — SDK = in-process Python class; aigentry = OS-level session (sid + cwd). | If SDK style standard: each aigentry session would need to wrap one or more `Agent()` instances internally. SDK has no cross-host concept. |
| 2. Inter-agent communication | telepty inject + REPORT/CLEANUP_REQUEST | "Handoffs, which allow agents to delegate to other agents for specific tasks" / "Agents as tools / Handoffs" [T1, openai.github.io]. Handoff = function return value passing control to another `Agent` instance. | **Deviate** — SDK = synchronous in-process handoff; aigentry = async cross-process inject + sentinel report. | Wrapping cost: orchestrator-side adapter to translate handoff returns into telepty injects. Round-trip latency increases significantly. |
| 3. Tool/capability model | Permission Manager Capability enum + ssot | "Function tools: Turn any Python function into a tool with automatic schema generation and Pydantic-powered validation" [T1, openai.github.io]. | **Deviate on discovery** (auto-from-Python vs typed enum), **partial align on validation** (both use schema validation). | Low cost to expose aigentry capabilities as function tools; reverse (importing arbitrary function tools as capabilities) requires schema→enum projection. |
| 4. Lifecycle / GC | 3-layer (self-report + timeout + reconciler) | "Sessions: A persistent memory layer for maintaining working context within an agent loop" / `Runner.run_sync(agent, "...")` [T1]. Session lifetime = Runner loop scope. | **Deviate** — SDK Session = conversation context container; aigentry Session = OS process w/ capability set. Same word, different scope. | Naming-collision risk: aligning vocabularies requires explicit mapping doc. Functionally low-impact. |
| 5. Schema/contract authority | ssot typed Interface Authority | "Guardrails, which enable validation of agent inputs and outputs" + Pydantic for output_type validation [T1]. | **Partial align** — both have typed input/output validation; aigentry adds ecosystem-wide ssot authority that SDK lacks. | aigentry ssot can subsume SDK guardrails; SDK lacks cross-agent contract layer (each agent self-defines). |

**Swarm → openai-agents-python transition note**: Swarm (`github.com/openai/swarm`) is explicitly an "educational framework" — README states "Swarm is currently an experimental sample framework intended to explore ergonomic interfaces for multi-agent systems. It is not intended to be used in production, and therefore has no official support" [T1, github.com/openai/swarm]. The production successor is `openai-agents-python` (above), which carries forward Swarm's handoff model with stable APIs, Pydantic schemas, and explicit Runner-based execution.

**T1 sources (§2)**:
- https://github.com/openai/openai-agents-python
- https://openai.github.io/openai-agents-python/
- https://github.com/openai/swarm (historical / educational only)

---

### 3. Google ADK (Agent Development Kit) 2.0

**Source note**: Phase 1 WebFetch summarizer returned hallucinated `anthropic.com/adk/...` URLs (likely model confabulation on summary). Re-fetched from canonical `github.com/google/adk-python` README via `gh api` (T1) and `adk.dev` (T1, post-301 from `google.github.io/adk-docs/`). Adk.dev sub-pages listed below are URL-confirmed from `adk.dev/agents/` nav inspection; quote-level extraction from sub-pages partially blocked by content-summarizer terseness — concepts confirmed, verbatim per sub-page page-internal text not always recoverable.

| Dimension | aigentry 현/제안 | Google ADK 2.0 | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | "An open-source, code-first Python framework for building, evaluating, and deploying sophisticated AI agents" / `Agent(name="greeting_agent", model="gemini-2.5-flash", instruction="...")` [T1, github.com/google/adk-python README]. | **Deviate** — ADK Agent = Python class instance; aigentry session = OS process. | Same as OpenAI SDK case — wrapper needed for OS-level lifting. |
| 2. Inter-agent communication | telepty inject + REPORT | **Workflow Runtime**: "A graph-based execution engine for composing deterministic execution flows for agentic apps, with support for routing, fan-out/fan-in, loops, retry, state management, dynamic nodes, human-in-the-loop, and nested workflows." **Task API**: "Structured agent-to-agent delegation with multi-turn task mode, single-turn controlled output, mixed delegation patterns, human-in-the-loop, and task agents as workflow nodes." [T1, github.com/google/adk-python README "What's New in 2.0"]. ADK also integrates **A2A protocol** at `adk.dev/a2a/` for cross-framework agent communication. | **Partial align via A2A** — ADK's A2A integration matches aigentry's cross-process delegation goal. **Deviate on Workflow** — ADK Workflow = in-process DAG; aigentry = orchestrator + telepty inject. | If ADK + A2A becomes standard: aigentry's telepty inject layer could be wrapped as A2A transport (HTTP/JSON-RPC). Workflow Runtime conceptually maps to aigentry's wave-dispatch but with stricter DAG semantics. |
| 3. Tool/capability model | Permission Manager Capability enum + ssot | Tools surface at `adk.dev/tools-custom/` (Function tools, MCP tools, OpenAPI tools — concepts confirmed via adk.dev/agents/ nav and Phase 1 search-result excerpts). | **Deviate** — ADK = function-tool style; aigentry = typed capability. | Same wrapping cost as OpenAI SDK case. ADK's MCP tool integration is itself an interop bridge. |
| 4. Lifecycle / GC | 3-layer | Sessions/State/Memory sub-pages at `adk.dev/sessions/`. **ADK 2.0 breaking change**: "Sessions generated by ADK 2.0 are readable by ADK 1.28+ (extra fields will be ignored), but are incompatible with older 1.x versions." [T1, github.com/google/adk-python README]. | **Deviate** — ADK Session = conversation state container; aigentry Session = OS process. | Schema versioning model (ADK 2.0 forward-compat-only) is precedent for aigentry ssot evolution policy. |
| 5. Schema/contract authority | ssot typed Interface Authority | ADK input_schema/output_schema (Pydantic-based) per documented agent types; canonical sub-page at `adk.dev/agents/` references both. | **Partial align** — both use typed schemas; aigentry ssot is broader (ecosystem-wide). | Low cost. ADK schemas can be subsumed under ssot. |

**T1 sources (§3)**:
- https://github.com/google/adk-python (canonical README via `gh api`)
- https://adk.dev/ (post-301 redirect from google.github.io/adk-docs/)
- https://adk.dev/agents/ — agent overview hub
- https://adk.dev/tools-custom/ — tools
- https://adk.dev/sessions/ — session lifecycle
- https://adk.dev/a2a/ — A2A protocol integration
- https://adk.dev/workflows/ — Workflow Runtime
- https://adk.dev/runtime/ — runtime
- https://adk.dev/callbacks/ — callbacks/events
- https://adk.dev/skills/ — skills (Anthropic-Skills-style integration)
- https://google.github.io/adk-docs/a2a/intro/ (legacy URL, still resolves via 301)

---

### 4. Microsoft Semantic Kernel

| Dimension | aigentry 현/제안 | Semantic Kernel | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | "The abstract `Agent` class serves as the core abstraction for all types of agents, providing a foundational structure that can be extended to create more specialized agents." [T1, learn.microsoft.com/.../agent/agent-architecture]. Concrete types: `ChatCompletionAgent`, `OpenAIAssistantAgent`, `AzureAIAgent`, `OpenAIResponsesAgent`, `CopilotStudioAgent`. | **Deviate** — SK = class hierarchy; aigentry = session. | Same wrapping cost — SK Agents would be wrapped per session. |
| 2. Inter-agent communication | telepty inject + REPORT | Agent Orchestration "enables the coordination of multiple agents to solve complex tasks collaboratively" with patterns: "Concurrent, Sequential, Handoff, Group Chat, and Magentic" [T1, learn.microsoft.com/.../agent-architecture]. Note: `AgentGroupChat` is deprecated in favor of `GroupChatOrchestration`. | **Partial align** — SK orchestration patterns (Sequential, Handoff, Group Chat) map to aigentry's orchestrator + wave dispatch + deliberation routing. **Deviate on transport** — SK = in-process; aigentry = cross-process. | Pattern vocabulary (Sequential/Handoff/Concurrent/Group Chat) is the closest existing standard for aigentry's orchestration modes — adoption would clarify documentation. |
| 3. Tool/capability model | Permission Manager Capability enum + ssot | "Plugins are a fundamental aspect of the Semantic Kernel, enabling developers to integrate custom functionalities ... agent capabilities within the framework can be significantly enhanced by utilizing Plugins and leveraging Function Calling" [T1]. KernelFunction = unit of tool. SK uses **OpenAPI specifications** for plugin sharing. | **Partial align** — both have typed-capability abstraction. SK Plugin (OpenAPI-based) is the most-aligned tool model among the 8 standards. | Low cost. aigentry ssot capabilities can be exported as OpenAPI specs; KernelFunction signatures roughly map to capability declarations. |
| 4. Lifecycle / GC | 3-layer | "The abstract `AgentThread` class serves as the core abstraction for threads or conversation state. ... Stateful agent services often store conversation state in the service, and you can interact with it via an id. Other agents may require the entire chat history to be passed to the agent on each invocation" [T1]. | **Partial align** — `AgentThread` (stateful conversation, id-addressable) parallels aigentry's session-id model conceptually, though SK manages it via SDK calls rather than OS process boundaries. | Identifier mapping is straightforward (AgentThread.id ↔ telepty sid). |
| 5. Schema/contract authority | ssot typed Interface Authority | KernelContent/ChatMessageContent class hierarchy [T1]. Python: Declarative YAML spec via `@register_agent_type` decorator + `DeclarativeSpecMixin` (experimental). | **Partial align** — SK's declarative YAML spec is the closest existing precedent for aigentry's ssot typed-spec approach. **Deviate** — SK is class-attached; aigentry ssot is project-wide. | Low cost. SK declarative YAML format could be a template for aigentry ssot export. |

**MAF informational caveat (orchestrator-directed, out of matrix scope)**: Microsoft has a **newer unified successor** to Semantic Kernel called **Microsoft Agent Framework (MAF)**, intended to consolidate Semantic Kernel and AutoGen lineages. URL: https://learn.microsoft.com/en-us/agent-framework/ (T1). Per dispatch ref Rule 29 (surgical scope) and orchestrator Phase 1 decision, MAF is **not mapped** in this matrix but is relevant for future re-baselining if MAF supersedes Semantic Kernel for production usage.

**T1 sources (§4)**:
- https://learn.microsoft.com/en-us/semantic-kernel/overview/
- https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/
- https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-architecture
- https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/
- https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/
- https://learn.microsoft.com/en-us/agent-framework/ — **MAF informational caveat URL**

---

### 5. LangGraph

**Source note**: Documentation migrated from `langchain-ai.github.io/langgraph` to `docs.langchain.com/oss/python/langgraph` (Phase 1 redirect confirmed). Phase 2 fetches on sub-page URLs were partially terse — concepts confirmed via overview page; verbatim sub-page quotes limited.

| Dimension | aigentry 현/제안 | LangGraph | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | "LangGraph is a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents." [T1, docs.langchain.com/oss/python/langgraph/overview]. Agents are typically `StateGraph` instances composed of nodes. | **Deviate** — LangGraph = graph data structure; aigentry = OS session. | Wrapping: aigentry sessions could be nodes in a LangGraph StateGraph; reverse less natural. |
| 2. Inter-agent communication | telepty inject + REPORT | Edge-based message passing: `graph.add_edge(START, "mock_llm")` / `graph.add_edge("mock_llm", END)` [T1, overview example]. `Send` / `Command` primitives for dynamic routing per LangGraph reference (concept-confirmed; sub-page direct quote blocked by docs-migration). | **Deviate** — LangGraph = static DAG + dynamic Send/Command; aigentry = orchestrator-routed PTY inject. | Mapping: telepty inject ≈ Send to a node. Cross-host requires extra transport adapter. |
| 3. Tool/capability model | Permission Manager Capability enum | LangGraph references `ToolNode`/`bind_tools` patterns (concept-confirmed; sub-page direct quote blocked). LangChain Tools page at `docs.langchain.com/oss/python/langchain/tools` is referenced as the tool model authority. | **Deviate** — LangChain tools = decorator-based; aigentry = typed capability enum. | Standard wrapping cost. |
| 4. Lifecycle / GC | 3-layer | "Durable execution: Build agents that persist through failures and can run for extended periods, resuming from where they left off." [T1, overview]. Checkpointer (e.g., MemorySaver, SqliteSaver, PostgresSaver) + threads provide durable state. | **Partial align** — Durable execution + checkpointer is closest equivalent to aigentry's reconciler concept. Both prioritize crash-recovery and resumability. | Mapping: aigentry reconciler state could be persisted via LangGraph-style checkpointer abstraction. |
| 5. Schema/contract authority | ssot typed Interface Authority | State schema via `TypedDict` (e.g., `MessagesState`) or Pydantic BaseModel passed to `StateGraph(SchemaType)` [T1, overview example: `def mock_llm(state: MessagesState)`]. | **Partial align** — both use typed schemas; LangGraph state is per-graph, aigentry ssot is ecosystem-wide. | Low cost. |

**T1 sources (§5)**:
- https://docs.langchain.com/oss/python/langgraph/overview
- https://docs.langchain.com/langgraph (redirect target)
- https://docs.langchain.com/oss/python/langgraph/durable-execution
- https://docs.langchain.com/oss/python/langchain/tools
- https://github.com/langchain-ai/langgraph

---

### 6. AutoGen (Microsoft, v0.4+)

| Dimension | aigentry 현/제안 | AutoGen | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | "AssistantAgent is a built-in agent that uses a language model and has the ability to use tools." [T1, microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html]. | **Deviate** — class instance vs OS session. | Standard wrapping cost. |
| 2. Inter-agent communication | telepty inject + REPORT | "A team is a group of agents that work together to achieve a common goal." `RoundRobinGroupChat`: "a simple yet effective team configuration where all agents share the same context and take turns responding in a round-robin fashion." / "Each agent, during its turn, broadcasts its response to all other agents, ensuring that the entire team maintains a consistent context." [T1, .../tutorial/teams.html]. | **Partial align** on team/group abstraction (AutoGen team ≈ aigentry deliberation session). **Deviate** on transport (in-process broadcast vs cross-process inject) and on speaker selection model (round-robin vs orchestrator-driven). | Conceptual mapping is clean; transport adaptation needed. |
| 3. Tool/capability model | Permission Manager Capability enum | Tools passed as list parameter at agent construction: `tools=[web_search]` (functions decorated/passed at init) [T1, .../tutorial/agents.html]. | **Deviate** — function-list at init vs typed capability enum. | Standard wrapping cost. |
| 4. Lifecycle / GC | 3-layer | "Teams are stateful and maintains the conversation history and context after each run, unless you reset the team." Termination patterns: `TextMentionTermination` ("stops the team when a specific word is detected in the agent's response"), `ExternalTermination` (via `set()`), `TextMessageTermination` [T1, .../tutorial/teams.html]. `run_stream()` returns iterator + final `TaskResult`. | **Partial align** — AutoGen's termination conditions are explicit signals comparable to aigentry's REPORT/CLEANUP_REQUEST sentinels. | Sentinel-strings ↔ termination-condition mapping is a clean conceptual bridge. |
| 5. Schema/contract authority | ssot typed Interface Authority | `TaskResult` with `messages` attribute storing typed message objects (`AssistantMessage`, `UserMessage`, etc.) per `tutorial/messages.html`. | **Deviate** — AutoGen schemas are class-internal; aigentry ssot is project-wide. | Standard mapping cost. |

**T1 sources (§6)**:
- https://microsoft.github.io/autogen/stable/
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/messages.html
- https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.html

---

### 7. Model Context Protocol (MCP)

| Dimension | aigentry 현/제안 | MCP | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session | Three-party architecture: "MCP Host: The AI application that coordinates and manages one or multiple MCP clients" / "MCP Client: A component that maintains a connection to an MCP server and obtains context from an MCP server for the MCP host to use" / "MCP Server: A program that provides context to MCP clients" [T1, modelcontextprotocol.io/docs/learn/architecture]. | **Orthogonal** — MCP doesn't define "agents"; it defines context-providers (servers) for agent applications (hosts). Conceptually MCP server ≈ aigentry's capability provider, MCP host ≈ aigentry session. | Free win — aigentry already integrates MCP servers (see Class C MCP adapter, ADR-MF #15). |
| 2. Inter-agent communication | telepty inject + REPORT | "MCP uses JSON-RPC 2.0 as its underlying RPC protocol. Client and servers send requests to each other and respond accordingly. Notifications can be used when no response is required." [T1, .../architecture]. Transports: Stdio (local) and Streamable HTTP (remote) [T1]. | **Orthogonal** — MCP = host↔server, not agent↔agent. Different layer. | Direct: aigentry sessions communicate with each other via telepty; with MCP servers via JSON-RPC. Already coexisting. |
| 3. Tool/capability model | Permission Manager Capability enum | Three server primitives: "Tools: Executable functions that AI applications can invoke to perform actions" / "Resources: Data sources that provide contextual information" / "Prompts: Reusable templates" [T1, .../architecture]. Plus client primitives: Sampling, Elicitation, Logging. JSON Schema (`inputSchema`) declared per tool. | **Partial align** — both have typed-capability with JSON Schema. MCP's three-primitive model (Tools/Resources/Prompts) is more granular than aigentry capability enum. | aigentry capability enum could be expanded along MCP primitive axis. |
| 4. Lifecycle / GC | 3-layer (self-report + timeout + reconciler) | 3-phase lifecycle [T1, modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle]: **Initialize** (capability negotiation, version agreement, `initialize` request + `initialized` notification), **Operation** (negotiated capabilities only), **Shutdown** (transport-specific: stdio = stream close + SIGTERM + SIGKILL escalation; HTTP = connection close). Also: per-request timeouts with cancellation notifications. | **Strong align** — MCP's 3-phase lifecycle is the closest analog in the 8 standards to aigentry's 3-layer GC. Both have explicit capability handshake and explicit shutdown protocol. | Free win — aigentry's ADR 2026-05-20 3-layer model is structurally compatible. MCP-style `initialize`/`initialized` handshake could be adopted as aigentry session-startup convention. |
| 5. Schema/contract authority | ssot typed Interface Authority | Capability objects with sub-capabilities (`listChanged`, `subscribe`); each tool/resource declares JSON Schema via `inputSchema`. Spec at `modelcontextprotocol.io/specification/latest` is normative source. | **Partial align** — both treat schema as first-class authority. MCP spec is per-server (per-deployment); aigentry ssot is project-wide. | Low cost. aigentry ssot can emit MCP-compatible server manifests. |

**T1 sources (§7)**:
- https://modelcontextprotocol.io/
- https://modelcontextprotocol.io/docs/learn/architecture
- https://modelcontextprotocol.io/specification/latest
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://github.com/modelcontextprotocol/inspector
- https://github.com/modelcontextprotocol/servers

---

### 8. Agent-to-Agent Protocol (A2A)

**Source note**: Linux Foundation-hosted, originally contributed by Google. `docs/specification.md` is primary normative source per repo. README is overview-only.

| Dimension | aigentry 현/제안 | A2A | Align / Deviate | 호환 비용 |
|---|---|---|---|---|
| 1. Agent definition | role-based session (sid + cwd + capability) | **Agent Card**: "A JSON metadata document published by an A2A Server, describing its identity, capabilities, skills, service endpoint, and authentication requirements." [T1, github.com/a2aproject/A2A/blob/main/docs/specification.md]. Agents declare optional `AgentCapabilities` in their AgentCard. Agents preserve opacity (no exposure of internal state/tools). | **Strong align** — Agent Card (identity + capabilities + endpoint + auth) is the closest peer to aigentry's `SessionContext` (sid + cwd + permissions/capabilities). Both treat agents as **out-of-process, addressable, capability-declaring** entities. | Highest-affinity standard. aigentry SessionContext could emit Agent Card directly; reverse mapping covers most fields. |
| 2. Inter-agent communication | telepty inject (PTY text) + REPORT/CLEANUP_REQUEST | "Standardized Communication: JSON-RPC 2.0 over HTTP(S)" supporting "synchronous request/response, streaming (SSE), and asynchronous push notifications" [T1, github.com/a2aproject/A2A README]. Primary operation `message/send`: "The primary operation for initiating agent interactions. Clients send a message to an agent and receive either a task that tracks the processing or a direct response message." [T1, .../specification.md]. | **Deviate on transport** (JSON-RPC over HTTP vs PTY text), **align on semantics** (both: addressable agent, message dispatch, task tracking). | Wrapping: telepty inject could be exposed as A2A transport (HTTP server in front of telepty). REPORT semantic ≈ A2A task completion message. |
| 3. Tool/capability model | Permission Manager Capability enum | **AgentSkill**: "Skills represent discrete, named capabilities that an agent can perform. Each skill declares the types of inputs it accepts and outputs it produces." Agents MAY declare skills in Agent Card. [T1, .../specification.md]. | **Strong align** — AgentSkill (named, typed inputs/outputs, declared in Card) is the closest peer to aigentry capability enum. Both attach to agent identity. | Low cost. aigentry capabilities map 1:1 to AgentSkills in Agent Card export. |
| 4. Lifecycle / GC | 3-layer | **Task** = "The fundamental unit of work managed by A2A, identified by a unique ID. Tasks are stateful and progress through a defined lifecycle." 8 states: `TASK_STATE_SUBMITTED, TASK_STATE_WORKING, TASK_STATE_COMPLETED, TASK_STATE_FAILED, TASK_STATE_CANCELED, TASK_STATE_REJECTED, TASK_STATE_INPUT_REQUIRED, TASK_STATE_AUTH_REQUIRED` [T1, .../specification.md]. | **Strong align** — A2A's 8-state Task lifecycle is the most granular external precedent for aigentry's dispatch tracking states. aigentry's `state/dispatch/active.json` records (`in_flight`, `done`, `error`, classification history) align with the spirit of A2A Task states. | Low cost. aigentry dispatch tracker could emit A2A-compatible Task state transitions. |
| 5. Schema/contract authority | ssot typed Interface Authority | "The file `spec/a2a.proto` is the single authoritative normative definition of all protocol data objects and request/response messages." / "SDK language bindings, schemas, and any other derived forms MUST be regenerated from the proto (directly or via code generation) rather than edited manually." [T1, .../specification.md]. | **Strongest align** — A2A's "single proto = normative source, all bindings regenerated" is the closest external precedent for aigentry's proposed typed Interface Authority. | Very low cost. Adopting A2A's regeneration discipline for aigentry ssot would mirror an already-validated pattern. |

**T1 sources (§8)**:
- https://github.com/a2aproject/A2A
- https://github.com/a2aproject/A2A/blob/main/docs/specification.md (normative spec)
- https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md (raw)
- https://github.com/google-a2a/A2A/blob/main/docs/specification.md (legacy mirror)
- https://google.github.io/adk-docs/a2a/intro/ (ADK's A2A integration intro)

---

## Cross-cutting findings

### Common patterns across multiple standards

1. **Agent as in-process Python class with typed schema validation**: OpenAI SDK, Swarm, ADK, AutoGen, LangGraph, Semantic Kernel — six of eight frameworks treat agents as in-process class instances with Pydantic/TypedDict-based input/output validation. aigentry deviates by treating agents as OS sessions.
2. **Capability declaration via JSON Schema**: MCP (`inputSchema`), A2A (`AgentSkill.inputSchema`), OpenAI SDK (Pydantic→JSON Schema auto-generation), Swarm (function→JSON Schema), Semantic Kernel (OpenAPI), ADK (function tool schemas) all converge on JSON Schema as capability declaration medium.
3. **Multi-agent communication patterns**: Sequential, Concurrent, Handoff, Group Chat appear in some form in Semantic Kernel, AutoGen, OpenAI SDK, ADK Workflow, LangGraph — strong vocabulary convergence on these four patterns. aigentry's wave-dispatch + deliberation routing implements equivalents but with different naming.
4. **Durable/resumable execution**: ADK Workflow ("retry, state management"), LangGraph ("Durable execution ... resuming from where they left off"), AutoGen ("Teams are stateful"), A2A (`Task` state machine) all treat resumability as a first-class concern — matches aigentry's reconciler intent.

### Divergence points

1. **Transport**: PTY-text (aigentry) vs JSON-RPC (MCP, A2A) vs in-process function call (6 others) — three distinct transport families, no convergence.
2. **Agent addressability**: A2A + aigentry treat agents as externally addressable (Agent Card endpoint / telepty sid); 6 others have no out-of-process addressing.
3. **Schema authority scope**: A2A (proto-as-source-of-truth, regenerate all bindings) and aigentry proposed ssot (project-wide Interface Authority) are the only two with ecosystem-wide schema authority; others have framework-internal or per-deployment schemas.
4. **Lifecycle granularity**: MCP (3 phases), A2A (8 task states), aigentry (3-layer) have explicit lifecycle models. ADK, AutoGen, LangGraph have implicit lifecycle tied to object lifetime + checkpointer recovery. Anthropic Subagents have implicit per-call lifetime.

### aigentry's unique stance

- **OS-session = Agent**: No other standard treats agents as OS processes with cwd + permission set. Closest peer is A2A's Agent Card (external endpoint with declared capabilities), but A2A doesn't constrain the agent's runtime to OS-level isolation.
- **PTY text + sentinel-string communication**: Unique to aigentry. No precedent in the 8 standards. Reason (per ADR-MF history): cross-CLI interop without requiring each CLI vendor to implement JSON-RPC.
- **Orchestrator-driven explicit delegation**: aigentry orchestrator dispatches via `bin/dispatch.sh --ref` with self-contained spec. Anthropic Subagents use description-driven LLM auto-delegation; Semantic Kernel/AutoGen/ADK use orchestration patterns (round-robin, sequential) executed by framework. aigentry's model is most similar to A2A's `message/send` but with stricter spec discipline (verbatim refs, HOLD/REPORT envelope).

---

## Compatibility risk table

| Standard | aigentry alignment 정도 | If becomes dominant standard | Lock-in / migration cost estimate |
|---|---|---|---|
| Anthropic Skills + Subagents | Partial (subagent ≈ session; Skills orthogonal) | aigentry subagent surface needs description-driven auto-delegation wrapper; Skills become a filesystem mount feature | **Low-Medium** — additive feature work, no rewrites |
| OpenAI Agents Python (Swarm successor) | Low (in-process model) | Each aigentry session wraps SDK `Agent()` instances; handoff translation to telepty inject required | **Medium** — adapter layer between session-level and agent-level |
| Google ADK 2.0 (incl. A2A integration) | Partial via A2A (high), Low via ADK direct | A2A path: free win via shared protocol; ADK direct: full wrapping of Workflow Runtime + Task API needed | **Low (via A2A) — Medium (via ADK direct)** |
| Microsoft Semantic Kernel | Partial (orchestration patterns + AgentThread.id align) | Adopt SK orchestration vocabulary; map AgentThread.id ↔ telepty sid | **Low** — mostly documentation/vocabulary alignment. MAF supersession risk noted separately. |
| LangGraph | Partial (durable execution + state schema align) | aigentry reconciler could adopt LangGraph checkpointer pattern; cross-process transport remains custom | **Low-Medium** — checkpointer abstraction adoption |
| AutoGen v0.4+ | Partial (Teams + termination conditions) | Team abstraction wraps deliberation sessions; termination conditions ↔ REPORT/CLEANUP sentinels | **Low-Medium** |
| MCP | Orthogonal (different layer) + Strong align on lifecycle | Already integrated (Class C adapter, ADR-MF #15). Capability negotiation pattern could be adopted for telepty session startup | **Free win** — already coexisting |
| A2A | **Strong** on agent identity + skill model + task lifecycle + schema authority | Highest-affinity peer. aigentry SessionContext → Agent Card export and Task state mapping are direct | **Very Low** — protocol bridge is mostly serialization, not redesign |

**Top 3 free wins** (low cost, high upside if standard becomes dominant): MCP (already integrated), A2A (closest structural peer), Semantic Kernel orchestration patterns (vocabulary alignment).

**Top 3 lock-in risks** (medium cost if exclusive dominance): OpenAI SDK / ADK direct (in-process Python class agent model — aigentry's OS-session model would need wrapping); Anthropic auto-delegation by description (LLM-side speaker selection differs from orchestrator-explicit dispatch); AutoGen team-broadcast model (in-process broadcast vs cross-process inject).

---

## References (URL by group, T1/T2/T3 tier)

**Tier legend**: T1 = official docs / 1st-party blog / GitHub repo README; T2 = high-star OSS docs; T3 = well-known tech blog.

### §1 Anthropic
- [T1] https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- [T1] https://platform.claude.com/docs/en/build-with-claude/skills-guide
- [T1] https://code.claude.com/docs/en/sub-agents
- [T1] https://github.com/anthropics/skills
- [T1] https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

### §2 OpenAI Agents
- [T1] https://github.com/openai/openai-agents-python
- [T1] https://openai.github.io/openai-agents-python/
- [T1] https://github.com/openai/swarm (historical/educational only)

### §3 Google ADK 2.0
- [T1] https://github.com/google/adk-python
- [T1] https://adk.dev/
- [T1] https://adk.dev/agents/
- [T1] https://adk.dev/tools-custom/
- [T1] https://adk.dev/sessions/
- [T1] https://adk.dev/a2a/
- [T1] https://adk.dev/workflows/
- [T1] https://adk.dev/runtime/
- [T1] https://adk.dev/callbacks/
- [T1] https://adk.dev/skills/
- [T1] https://google.github.io/adk-docs/a2a/intro/ (legacy mirror, 301 redirect)

### §4 Microsoft Semantic Kernel
- [T1] https://learn.microsoft.com/en-us/semantic-kernel/overview/
- [T1] https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/
- [T1] https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-architecture
- [T1] https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/
- [T1] https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/
- [T1] https://learn.microsoft.com/en-us/agent-framework/ — **MAF caveat URL**

### §5 LangGraph
- [T1] https://docs.langchain.com/oss/python/langgraph/overview
- [T1] https://docs.langchain.com/langgraph
- [T1] https://docs.langchain.com/oss/python/langgraph/durable-execution
- [T1] https://docs.langchain.com/oss/python/langchain/tools
- [T1] https://github.com/langchain-ai/langgraph

### §6 AutoGen
- [T1] https://microsoft.github.io/autogen/stable/
- [T1] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html
- [T1] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
- [T1] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- [T1] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html
- [T1] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/messages.html
- [T1] https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.html

### §7 MCP
- [T1] https://modelcontextprotocol.io/
- [T1] https://modelcontextprotocol.io/docs/learn/architecture
- [T1] https://modelcontextprotocol.io/specification/latest
- [T1] https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- [T1] https://github.com/modelcontextprotocol/inspector
- [T1] https://github.com/modelcontextprotocol/servers

### §8 A2A
- [T1] https://github.com/a2aproject/A2A
- [T1] https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- [T1] https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md
- [T1] https://github.com/google-a2a/A2A/blob/main/docs/specification.md
- [T1] https://google.github.io/adk-docs/a2a/intro/

---

## Coverage caveats explicit

1. **Swarm**: Educational/non-production per repo README. Production successor `openai-agents-python` is mapped instead per orchestrator Phase 1 decision.
2. **Microsoft Agent Framework (MAF)**: Newer unified successor to Semantic Kernel + AutoGen. Out-of-scope per orchestrator Rule 29 (surgical 8-standard scope). URL noted for future tracking: https://learn.microsoft.com/en-us/agent-framework/
3. **ADK URL discovery**: Phase 1 WebFetch summarizer returned hallucinated `anthropic.com/adk/...` URLs (model confabulation on summarization). Phase 2 re-verified all ADK URLs against canonical `adk.dev` (post-301 from `google.github.io/adk-docs/`) and `github.com/google/adk-python` README via `gh api`. All URLs in §3 references are URL-confirmed.
4. **LangGraph docs migration**: `langchain-ai.github.io/langgraph` redirects to `docs.langchain.com/oss/python/langgraph`. Phase 2 sub-page fetches partially terse (overview-page content only) — concepts confirmed, verbatim sub-page quotes limited where documentation page rendering blocked detailed extraction.
5. **A2A README vs spec**: README overview-only; `docs/specification.md` is primary normative source for §8 quotes.
6. **Anthropic Agent SDK**: Mentioned in dispatch ref but distinct canonical URL not surfaced separately; Skills + Subagents docs cover the surface implicitly. If a dedicated "Agent SDK" page exists at platform.claude.com beyond the Skills/Subagents pages, it was not URL-discovered in Phase 1-2 fetches.
