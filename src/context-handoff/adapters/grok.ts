// #1201 — Grok CLI transcript adapter (MEASURED: PHASE0 P0-4).
// Store: `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/`. The directory name IS the cwd record.
// `prompt_history.jsonl` `{timestamp, session_id, prompt, is_bash}` carries the only timestamps,
// so last activity is the newest prompt (the reply after it is not timestamped).
// `chat_history.jsonl` `{type, content: string | [{type:'text', text}], …}` gives the last
// assistant prose. Never read: reasoning, tool_result, system, summary, encrypted_content,
// synthetic records, bash prompts, prompt_context.json, system_prompt.txt.
import * as path from "node:path";
import {
  homeOf, isObject, isoOf, jsonlRecords, listDir, maxIso, minIso, newestByMtime, sameDir, str,
  type Env, type Extract, type Limits, type TranscriptAdapter, type TranscriptRef,
} from "../types.js";

const CHAT = "chat_history.jsonl";
const PROMPTS = "prompt_history.jsonl";

function decoded(name: string): string | null {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

function list(root: string, workspace: string, limits: Limits): TranscriptRef[] {
  const sessions: string[] = [];
  for (const enc of listDir(root)) {
    const cwd = decoded(enc);
    if (cwd === null || !sameDir(cwd, workspace)) continue;
    for (const id of listDir(path.join(root, enc))) sessions.push(path.join(root, enc, id, CHAT));
  }
  const out: TranscriptRef[] = [];
  for (const { path: f, st } of newestByMtime(sessions, limits.k)) {
    if (Date.now() > limits.deadlineAt) break;
    const id = path.basename(path.dirname(f));
    let first: string | null = null;
    let last: string | null = null;
    for (const r of jsonlRecords(path.join(path.dirname(f), PROMPTS), limits.probeBytes)) {
      if (typeof r.session_id === "string" && r.session_id !== id) continue;
      const t = isoOf(r.timestamp);
      last = maxIso(last, t);
      first = minIso(first, t);
    }
    if (last === null) continue;
    out.push({ cli: "grok", sessionId: id, path: f, bytes: st.size, mtimeMs: st.mtimeMs, lastActivity: last, firstActivity: first });
  }
  return out;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const joined = content.filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string").map((c) => (c as { text: string }).text).join("\n").trim();
  return joined === "" ? null : joined;
}

function extract(ref: TranscriptRef, limits: Limits): Extract {
  const requests: { at: string; text: string }[] = [];
  for (const r of jsonlRecords(path.join(path.dirname(ref.path), PROMPTS), limits.tailBytes)) {
    if (typeof r.session_id === "string" && r.session_id !== ref.sessionId) continue;
    if (r.is_bash === true) continue;
    const text = str(r.prompt);
    const at = isoOf(r.timestamp);
    if (text !== null && text.trim() !== "" && at !== null) requests.push({ at, text });
  }
  requests.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let status: { at: string; text: string } | null = null;
  for (const r of jsonlRecords(ref.path, limits.tailBytes)) {
    if (r.type !== "assistant" || r.synthetic_reason) continue;
    const t = textOf(r.content);
    if (t !== null) status = { at: ref.lastActivity, text: t };
  }
  return { userRequests: requests, assistantStatus: status, openTools: [], title: null };
}

export const grokAdapter: TranscriptAdapter = {
  cli: "grok",
  status: "measured",
  roots(env: Env): readonly string[] {
    const home = homeOf(env);
    return home === null ? [] : [path.join(home, ".grok", "sessions")];
  },
  list,
  extract,
};
