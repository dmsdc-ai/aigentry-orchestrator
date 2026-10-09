// #1201 — Codex CLI transcript adapter (MEASURED: PHASE0 P0-2).
// Store: `$CODEX_HOME/sessions` else `~/.codex/sessions`, `YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`.
// Record `{timestamp, ordinal?, type, payload}`. cwd: `session_meta.payload.cwd` (first record,
// read from a bounded HEAD window) and `turn_context.payload.cwd` (per turn, in the tail).
// A live rollout is hundreds of MB and still growing: only bounded head/tail windows are read.
// Never read: reasoning, function/custom tool outputs, developer messages, base_instructions,
// compacted, world_state, token usage.
import * as path from "node:path";
import {
  homeOf, isObject, isoOf, jsonlRecords, listDir, maxIso, newestByMtime, sameDir, str, toolHint,
  type Env, type Extract, type Limits, type TranscriptAdapter, type TranscriptRef,
} from "../types.js";

const MAX_STATS = 20_000;
const ROLLOUT = /^rollout-.*\.jsonl$/;
const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Every rollout under YYYY/MM/DD, newest day directories first, capped. */
function rollouts(root: string): string[] {
  const out: string[] = [];
  const desc = (names: string[]): string[] => names.filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const y of desc(listDir(root))) {
    for (const m of desc(listDir(path.join(root, y)))) {
      for (const d of desc(listDir(path.join(root, y, m)))) {
        const dir = path.join(root, y, m, d);
        for (const name of listDir(dir)) {
          if (ROLLOUT.test(name)) out.push(path.join(dir, name));
          if (out.length >= MAX_STATS) return out;
        }
      }
    }
  }
  return out;
}

function payloadOf(r: Record<string, unknown>): Record<string, unknown> | null {
  return isObject(r.payload) ? r.payload : null;
}

function list(root: string, workspace: string, limits: Limits): TranscriptRef[] {
  const out: TranscriptRef[] = [];
  for (const { path: f, st } of newestByMtime(rollouts(root), limits.k)) {
    if (Date.now() > limits.deadlineAt) break;
    let cwdOk = false;
    let id: string | null = null;
    let first: string | null = null;
    for (const r of jsonlRecords(f, limits.probeBytes, true).slice(0, 4)) {
      const p = payloadOf(r);
      if (r.type !== "session_meta" || p === null) continue;
      id = str(p.id);
      first = isoOf(p.timestamp) ?? isoOf(r.timestamp);
      if (typeof p.cwd === "string" && sameDir(p.cwd, workspace)) cwdOk = true;
      break;
    }
    let last: string | null = null;
    for (const r of jsonlRecords(f, limits.probeBytes)) {
      last = maxIso(last, isoOf(r.timestamp));
      const p = payloadOf(r);
      if (!cwdOk && p !== null && (r.type === "turn_context" || r.type === "session_meta")
        && typeof p.cwd === "string" && sameDir(p.cwd, workspace)) {
        cwdOk = true;
      }
    }
    if (!cwdOk || last === null) continue;
    out.push({
      cli: "codex",
      sessionId: id ?? UUID_TAIL.exec(f)?.[1] ?? path.basename(f, ".jsonl"),
      path: f,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      lastActivity: last,
      firstActivity: first,
    });
  }
  return out;
}

function texts(content: unknown, kind: "input_text" | "output_text"): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => isObject(c) && c.type === kind && typeof c.text === "string").map((c) => (c as { text: string }).text);
  const joined = parts.join("\n").trim();
  return joined === "" ? null : joined;
}

function extract(ref: TranscriptRef, limits: Limits): Extract {
  const typed: { at: string; text: string }[] = [];
  const echoed: { at: string; text: string }[] = [];
  let status: { at: string; text: string } | null = null;
  const tools = new Map<string, { name: string; hint: string }>();
  for (const r of jsonlRecords(ref.path, limits.tailBytes)) {
    const p = payloadOf(r);
    if (p === null) continue;
    const at = isoOf(r.timestamp) ?? ref.lastActivity;
    if (r.type === "event_msg") {
      // The user's typed words, without the harness's environment/instruction wrappers.
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim() !== "") typed.push({ at, text: p.message });
      continue;
    }
    if (r.type !== "response_item") continue;
    switch (p.type) {
      case "message": {
        if (p.role === "user") {
          const t = texts(p.content, "input_text");
          if (t !== null && !t.startsWith("<")) echoed.push({ at, text: t });
        } else if (p.role === "assistant") {
          const t = texts(p.content, "output_text");
          if (t !== null) status = { at, text: t };
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        if (typeof p.call_id !== "string" || typeof p.name !== "string") break;
        let input: unknown = p.input;
        if (typeof p.arguments === "string") {
          try {
            input = JSON.parse(p.arguments);
          } catch {
            input = undefined;
          }
        }
        tools.set(p.call_id, { name: p.name, hint: toolHint(input) });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        // Only the id: an output closes its call. The output itself is never read.
        if (typeof p.call_id === "string") tools.delete(p.call_id);
        break;
      default:
        break;
    }
  }
  // event_msg user_message is the clean channel; the response_item echo is the fallback.
  return { userRequests: typed.length > 0 ? typed : echoed, assistantStatus: status, openTools: [...tools.values()], title: null };
}

export const codexAdapter: TranscriptAdapter = {
  cli: "codex",
  status: "measured",
  roots(env: Env): readonly string[] {
    if (env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME)) return [path.join(env.CODEX_HOME, "sessions")];
    const home = homeOf(env);
    return home === null ? [] : [path.join(home, ".codex", "sessions")];
  },
  list,
  extract,
};
