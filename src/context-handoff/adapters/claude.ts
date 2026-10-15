// #1201 — Claude Code transcript adapter (MEASURED: SPEC §2.1, PHASE0 P0-1).
// Store: `$CLAUDE_CONFIG_DIR/projects` else `~/.claude/projects`, `<slug>/<sessionId>.jsonl`.
// The slug only FINDS candidates; a candidate counts only if a record's `cwd` is the workspace.
// Never read: isSidechain records, `subagents/` (depth-2 listing never reaches it), thinking,
// tool_result content, toolUseResult, attachments other than queued_command.prompt, snapshots.
import * as path from "node:path";
import {
  homeOf, isObject, isoOf, jsonlRecords, listDir, maxIso, minIso, newestByMtime, sameDir, str, toolHint,
  type Env, type Extract, type Limits, type TranscriptAdapter, type TranscriptRef,
} from "../types.js";

/** Claude's project slug: every non-alphanumeric character becomes `-` (measured for `/` and `.`). */
function slugOf(workspace: string): string {
  return workspace.replace(/[^A-Za-z0-9]/g, "-");
}

function candidates(root: string, workspace: string, k: number): string[] {
  const slugs = listDir(root);
  const all: string[] = [];
  const own: string[] = [];
  const mine = slugOf(workspace);
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const f = path.join(dir, name);
      all.push(f);
      if (slug === mine) own.push(f);
    }
  }
  // Newest K over the whole root, plus the newest K under the workspace's own slug: a busy
  // machine must not push the orchestrator's transcript out of the window.
  const pick = new Set([...newestByMtime(all, k), ...newestByMtime(own, k)].map((c) => c.path));
  return [...pick];
}

function list(root: string, workspace: string, limits: Limits): TranscriptRef[] {
  const out: TranscriptRef[] = [];
  for (const f of candidates(root, workspace, limits.k)) {
    if (Date.now() > limits.deadlineAt) break;
    const st = newestByMtime([f], 1)[0];
    if (st === undefined) continue;
    const tail = jsonlRecords(f, limits.probeBytes);
    let cwdOk = false;
    let last: string | null = null;
    for (const r of tail) {
      if (r.isSidechain === true) continue;
      if (!cwdOk && typeof r.cwd === "string" && sameDir(r.cwd, workspace)) cwdOk = true;
      last = maxIso(last, isoOf(r.timestamp));
    }
    let first: string | null = null;
    const head = st.st.size > limits.probeBytes ? jsonlRecords(f, limits.probeBytes, true) : tail;
    for (const r of head) {
      if (!cwdOk && r.isSidechain !== true && typeof r.cwd === "string" && sameDir(r.cwd, workspace)) cwdOk = true;
      first = minIso(first, isoOf(r.timestamp));
    }
    if (!cwdOk || last === null) continue;
    out.push({
      cli: "claude",
      sessionId: path.basename(f, ".jsonl"),
      path: f,
      bytes: st.st.size,
      mtimeMs: st.st.mtimeMs,
      lastActivity: last,
      firstActivity: first,
    });
  }
  return out;
}

/** A human-typed prompt: string content with origin.kind "human" (or a pre-origin typed prompt). */
function humanText(r: Record<string, unknown>): string | null {
  const msg = r.message;
  if (!isObject(msg) || typeof msg.content !== "string") return null;
  const origin = r.origin;
  if (isObject(origin)) return origin.kind === "human" ? msg.content : null;
  if (origin !== undefined || r.isMeta === true || r.toolUseResult !== undefined) return null;
  return msg.content.startsWith("<") ? null : msg.content;
}

function extract(ref: TranscriptRef, limits: Limits): Extract {
  const requests: { at: string; text: string }[] = [];
  let status: { at: string; text: string } | null = null;
  const tools = new Map<string, { name: string; hint: string }>();
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  for (const r of jsonlRecords(ref.path, limits.tailBytes)) {
    if (r.isSidechain === true) continue;
    const at = isoOf(r.timestamp) ?? ref.lastActivity;
    switch (r.type) {
      case "user": {
        const text = humanText(r);
        if (text !== null) {
          requests.push({ at, text });
          break;
        }
        const msg = r.message;
        if (isObject(msg) && Array.isArray(msg.content)) {
          for (const b of msg.content) {
            // Only the id: a result closes its tool_use. The result content is never read.
            if (isObject(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") tools.delete(b.tool_use_id);
          }
        }
        break;
      }
      case "queue-operation":
        if (r.operation === "enqueue" && typeof r.content === "string") requests.push({ at, text: r.content });
        break;
      case "attachment": {
        const a = r.attachment;
        if (isObject(a) && a.type === "queued_command" && typeof a.prompt === "string") {
          requests.push({ at, text: a.prompt });
        }
        break;
      }
      case "assistant": {
        const msg = r.message;
        if (!isObject(msg) || !Array.isArray(msg.content)) break;
        for (const b of msg.content) {
          if (!isObject(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") status = { at, text: b.text };
          else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            tools.set(b.id, { name: b.name, hint: toolHint(b.input) });
          }
        }
        break;
      }
      case "ai-title":
        aiTitle = str(r.aiTitle) ?? aiTitle;
        break;
      case "last-prompt":
        lastPrompt = str(r.lastPrompt) ?? lastPrompt;
        break;
      default:
        break;
    }
  }
  return { userRequests: dedupe(requests), assistantStatus: status, openTools: [...tools.values()], title: aiTitle ?? lastPrompt };
}

/** A queued message appears both as `queue-operation` and as `queued_command`: same text, ≤ 60 s apart. */
function dedupe(items: { at: string; text: string }[]): { at: string; text: string }[] {
  const sorted = [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: { at: string; text: string }[] = [];
  const seen = new Map<string, number[]>();
  for (const it of sorted) {
    const key = it.text.trim();
    const t = Date.parse(it.at);
    const times = seen.get(key) ?? [];
    if (times.some((s) => Math.abs(s - t) <= 60_000)) continue;
    times.push(t);
    seen.set(key, times);
    out.push(it);
  }
  return out;
}

export const claudeAdapter: TranscriptAdapter = {
  cli: "claude",
  status: "measured",
  roots(env: Env): readonly string[] {
    if (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)) return [path.join(env.CLAUDE_CONFIG_DIR, "projects")];
    const home = homeOf(env);
    return home === null ? [] : [path.join(home, ".claude", "projects")];
  },
  list,
  extract,
};
