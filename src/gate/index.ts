// ADR-MF #15 — Gate integration barrel.
export type {
  Dispatcher,
  GateError,
  GateInvocation,
  GateOptions,
  GateOutcome,
  SpawnEventEmitter,
} from "./common.js";
export {
  gatedTeleptyInject,
  type GatedTeleptyOptions,
  type TeleptyDispatchArg,
} from "./class-a/telepty.js";
export {
  gatedCmuxSpawn,
  type GatedCmuxOptions,
  type CmuxDispatchArg,
  type CmuxSpawnKind,
} from "./class-a/cmux.js";
export {
  gatedCliDirectSpawn,
  type GatedCliDirectOptions,
  type CliDirectArg,
} from "./class-a/cli_direct.js";
export {
  validateAgentPrompt,
  persistAgentRecord,
  type AgentToolRequest,
  type AgentValidationResult,
} from "./class-b/agent-tool-validator.js";
export {
  gateMcpToolCall,
  MCP_GATED_TOOLS,
  type McpGateErrorCode,
  type McpGateOptions,
  type McpGateResult,
  type McpSessionContext,
  type McpToolCall,
} from "./class-c/mcp-deliberation-adapter.js";
