// Shared fixtures for boot-adapter tests.
import { Role, type SessionContext } from "../../../src/session/types.js";
import type { ResolvedInstructions } from "../../../src/session/resolve-instructions.js";
import {
  canonicalBytes,
  sha256Hex,
} from "../../../src/session/persistence/canonical-bytes.js";
import type { MockScript } from "../../../src/session/boot-adapter/spawner.js";

export const EFFECTIVE_PROMPT = "COMMON\n\n---\n\nCODER ROLE\n\n---\n\nTASK BODY\n";
export const EXPECTED_DIGEST = sha256Hex(canonicalBytes(EFFECTIVE_PROMPT));

export function makeCtx(over: Partial<SessionContext> = {}): SessionContext {
  return {
    session_id: "S-1",
    role: Role.coder,
    cwd: "/work/myproj",
    task_id: "T-1",
    effective_prompt_digest: EXPECTED_DIGEST,
    effective_prompt_path: "/snap/effective_prompt.md",
    layers: [],
    spawn_chain: [],
    depth: 0,
    created_at: "2026-05-12T00:00:00+00:00",
    ...over,
  };
}

export function makeResolved(): ResolvedInstructions {
  return Object.freeze({
    effective_prompt: EFFECTIVE_PROMPT,
    effective_prompt_digest: EXPECTED_DIGEST,
    layers: Object.freeze([]),
    project_id: "myproj",
  });
}

export function readyScript(version = "1.0.0"): MockScript {
  return {
    version,
    features: ["--cd", "--workspace-root", "--bare"],
    on_run: (cmd) => ({
      stdout: `READY ${cmd.expected_digest}\n`,
      stderr: "",
      exit_code: 0,
      duration_ms: 3,
    }),
  };
}
