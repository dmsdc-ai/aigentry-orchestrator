// #1201 — Gemini CLI transcript adapter (MEASURED: PHASE0 P0-3) and the agy detect-only probe.
// Store: `$GEMINI_CLI_HOME/.gemini` else `~/.gemini`; `projects.json` maps cwd → project name;
// chats are `tmp/<project-name>/chats/session-<ISO>-<id>.jsonl`: a header record
// `{sessionId, projectHash, startTime, lastUpdated, kind}` then `{"$set": {messages[], lastUpdated}}`
// update records. The project mapping IS the cwd record. Messages are merged by id, later wins,
// so both full-snapshot and incremental `$set` records give the same result.
// agy (`antigravity/conversations/<uuid>.pb`) is protobuf: newest file mtime and size only.
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  homeOf, isObject, isoOf, jsonlRecords, listDir, maxIso, minIso, newestByMtime, readBounded, sameDir, str, toolHint,
  type DetectOnlyStore, type Detection, type Env, type Extract, type Limits, type TranscriptAdapter, type TranscriptRef,
} from "../types.js";

const PROJECTS_MAX = 4 * 1024 * 1024;
const CHAT = /^session-.*\.jsonl$/;
const DONE = new Set(["success", "error", "cancelled", "canceled"]);

function geminiHome(env: Env): string | null {
  if (env.GEMINI_CLI_HOME && path.isAbsolute(env.GEMINI_CLI_HOME)) return path.join(env.GEMINI_CLI_HOME, ".gemini");
  const home = homeOf(env);
  return home === null ? null : path.join(home, ".gemini");
}

/** Project directory names mapped to the workspace, plus the older sha256(cwd) directory. */
function projectDirs(root: string, workspace: string): string[] {
  const names = new Set<string>([createHash("sha256").update(workspace).digest("hex")]);
  const read = readBounded(path.join(path.dirname(root), "projects.json"), PROJECTS_MAX, true);
  if (read !== null && read.size <= PROJECTS_MAX) {
    try {
      const doc: unknown = JSON.parse(read.text);
      const map = isObject(doc) && isObject(doc.projects) ? doc.projects : doc;
      if (isObject(map)) {
        for (const [cwd, name] of Object.entries(map)) {
          if (typeof name === "string" && name !== "" && !name.includes("/") && !name.includes("\\")
            && name !== "." && name !== ".." && sameDir(cwd, workspace)) {
            names.add(name);
          }
        }
      }
    } catch {
      // No mapping: only the hash directory is tried.
    }
  }
  return [...names].map((n) => path.join(root, n));
}

function list(root: string, workspace: string, limits: Limits): TranscriptRef[] {
  const files: string[] = [];
  for (const dir of projectDirs(root, workspace)) {
    const chats = path.join(dir, "chats");
    for (const name of listDir(chats)) if (CHAT.test(name)) files.push(path.join(chats, name));
  }
  const out: TranscriptRef[] = [];
  for (const { path: f, st } of newestByMtime(files, limits.k)) {
    if (Date.now() > limits.deadlineAt) break;
    let id: string | null = null;
    let first: string | null = null;
    let last: string | null = null;
    let main = true;
    const head = jsonlRecords(f, limits.probeBytes, true)[0];
    if (head !== undefined && !("$set" in head)) {
      id = str(head.sessionId);
      first = isoOf(head.startTime);
      last = isoOf(head.lastUpdated);
      if (typeof head.kind === "string" && head.kind !== "main") main = false;
    }
    if (!main) continue;
    for (const r of jsonlRecords(f, limits.probeBytes)) {
      const set = isObject(r.$set) ? r.$set : r;
      last = maxIso(last, isoOf(set.lastUpdated));
      if (Array.isArray(set.messages)) {
        for (const m of set.messages) {
          if (!isObject(m)) continue;
          const t = isoOf(m.timestamp);
          last = maxIso(last, t);
          first = minIso(first, t);
        }
      }
    }
    if (last === null) continue;
    out.push({
      cli: "gemini",
      sessionId: id ?? path.basename(f, ".jsonl"),
      path: f,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      lastActivity: last,
      firstActivity: first,
    });
  }
  return out;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const joined = content.filter((c) => isObject(c) && typeof c.text === "string").map((c) => (c as { text: string }).text).join("\n").trim();
  return joined === "" ? null : joined;
}

function extract(ref: TranscriptRef, limits: Limits): Extract {
  const messages = new Map<string, Record<string, unknown>>();
  let n = 0;
  for (const r of jsonlRecords(ref.path, limits.tailBytes)) {
    const set = isObject(r.$set) ? r.$set : null;
    if (set === null || !Array.isArray(set.messages)) continue;
    for (const m of set.messages) {
      if (!isObject(m)) continue;
      const key = typeof m.id === "string" ? m.id : `#${n++}`;
      messages.delete(key);
      messages.set(key, m);
    }
  }
  const requests: { at: string; text: string }[] = [];
  let status: { at: string; text: string } | null = null;
  const tools: { name: string; hint: string }[] = [];
  const ordered = [...messages.values()].sort((a, b) => (Date.parse(String(a.timestamp)) || 0) - (Date.parse(String(b.timestamp)) || 0));
  for (const m of ordered) {
    const at = isoOf(m.timestamp) ?? ref.lastActivity;
    // `thoughts`, tool results and info/error/warning messages are never read.
    if (m.type === "user") {
      const t = textOf(m.content);
      if (t !== null) requests.push({ at, text: t });
    } else if (m.type === "gemini" || m.type === "model" || m.type === "assistant") {
      const t = textOf(m.content);
      if (t !== null) status = { at, text: t };
      if (Array.isArray(m.toolCalls)) {
        for (const c of m.toolCalls) {
          if (isObject(c) && typeof c.name === "string" && typeof c.status === "string" && !DONE.has(c.status)) {
            tools.push({ name: c.name, hint: toolHint(c.args) });
          }
        }
      }
    }
  }
  return { userRequests: requests, assistantStatus: status, openTools: tools, title: null };
}

export const geminiAdapter: TranscriptAdapter = {
  cli: "gemini",
  status: "measured",
  roots(env: Env): readonly string[] {
    const g = geminiHome(env);
    return g === null ? [] : [path.join(g, "tmp")];
  },
  list,
  extract,
};

/** agy: protobuf conversations, not parseable without the schema. Stat only, no content. */
export const agyDetector: DetectOnlyStore = {
  store: "agy",
  status: "owed",
  detect(env: Env, _limits: Limits): Detection | null {
    const g = geminiHome(env);
    if (g === null) return null;
    const dir = path.join(g, "antigravity", "conversations");
    const files = listDir(dir).filter((n) => n.endsWith(".pb")).map((n) => path.join(dir, n));
    const newest = newestByMtime(files, 1)[0];
    return newest === undefined ? null : { store: "agy", path: newest.path, bytes: newest.st.size, mtimeMs: newest.st.mtimeMs };
  },
};
