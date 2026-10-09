// #1201 — byproduct readers (SPEC §4.3). Every one is optional and read-only: a missing,
// unreadable or malformed source is `null` and simply drops its line. None is a prerequisite.
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { listCaptureInventory } from "../request-capture/inventory.js";
import { redact } from "./redact.js";
import { isObject, lstatOrNull, readBounded, regularFile, str, type Env } from "./types.js";

const QUEUE_MAX = 32 * 1024 * 1024;
const REGISTRY_MAX = 16 * 1024 * 1024;
const HOOKS_MAX = 64 * 1024;
const OPEN_STATUS: Readonly<Record<string, number>> = { in_progress: 0, blocked: 1, pending: 2 };
// bin/dispatch-registry.py RETIRED_LIFECYCLES and TRANSITION_ARTIFACTS (F11).
const RETIRED = new Set(["cleaned", "cutover_retired", "delivery_failed", "not_delivered", "superseded"]);
const TRANSITION_ARTIFACTS = ["active.db", "active.db-journal", "active.db-wal", "active.db-shm",
  "active.json.source", "active.json.pre-sqlite.bak", "active.json.barrier.tmp"];

export interface OpenTask {
  readonly id: string;
  readonly status: string;
  readonly priority: string;
  readonly desc: string;
  readonly noteDate: string | null;
  readonly note: string | null;
}

export interface Enrichment {
  readonly tasks: readonly OpenTask[] | null;
  readonly dispatches: readonly { readonly sid: string; readonly lifecycle: string }[] | null;
  readonly capture: { readonly count: number; readonly truncated: boolean; readonly newest: string | null } | null;
  readonly snapshotMtime: string | null;
  readonly git: { readonly branch: string; readonly changed: number } | null;
}

function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, "utf8") > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function readJson(file: string, max: number): unknown {
  const r = readBounded(file, max, true);
  if (r === null || r.size > max) return undefined;
  try {
    return JSON.parse(r.text);
  } catch {
    return undefined;
  }
}

/** Open tasks: `status ∈ {in_progress, blocked, pending}`, ≤ 10; only the LAST ` || ` note segment, ≤ 200 B. */
export function readTasks(workspace: string, env: Env): OpenTask[] | null {
  const file = env.AIGENTRY_TASK_QUEUE || path.join(workspace, "state", "task-queue.json");
  const doc = readJson(file, QUEUE_MAX);
  if (!isObject(doc) || !Array.isArray(doc.tasks)) return null;
  const open: OpenTask[] = [];
  for (const t of doc.tasks) {
    if (!isObject(t) || typeof t.status !== "string" || !(t.status in OPEN_STATUS)) continue;
    const note = str(t.note);
    const segment = note === null ? null : (note.split(" || ").pop() ?? "").trim();
    open.push({
      id: oneLine(String(t.id ?? "?")).slice(0, 40),
      status: t.status,
      priority: oneLine(String(t.priority ?? "-")).slice(0, 20),
      desc: cutBytes(oneLine(redact(String(t.desc ?? ""))), 120),
      noteDate: segment === null ? null : /\d{4}-\d{2}-\d{2}/.exec(segment)?.[0] ?? null,
      note: segment === null || segment === "" ? null : cutBytes(oneLine(redact(segment)), 200),
    });
  }
  open.sort((a, b) => (OPEN_STATUS[a.status] ?? 9) - (OPEN_STATUS[b.status] ?? 9)
    || (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0)
    || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  return open.slice(0, 10);
}

/** Live dispatches from the JSON registry; skipped when a SQLite transition artifact exists. */
export function readDispatches(workspace: string): { sid: string; lifecycle: string }[] | null {
  const dir = path.join(workspace, "state", "dispatch");
  if (TRANSITION_ARTIFACTS.some((n) => lstatOrNull(path.join(dir, n)) !== null)) return null;
  const doc = readJson(path.join(dir, "active.json"), REGISTRY_MAX);
  if (!isObject(doc) || !Array.isArray(doc.dispatches)) return null;
  const out: { sid: string; lifecycle: string }[] = [];
  for (const d of doc.dispatches) {
    if (!isObject(d) || !isObject(d.assigned) || !isObject(d.lifecycle)) continue;
    const sid = str(d.assigned.sid);
    const state = str(d.lifecycle.state);
    const gated = isObject(d.gate) && d.gate.state !== null && d.gate.state !== undefined;
    if (sid === null || state === null || RETIRED.has(state) || gated) continue;
    out.push({ sid: oneLine(sid).slice(0, 80), lifecycle: oneLine(state).slice(0, 40) });
    if (out.length >= 10) break;
  }
  return out;
}

/** `.context-snapshot.md`: stat only. Its content is never copied (it would make a save step). */
export function readSnapshotMtime(workspace: string): string | null {
  const st = regularFile(path.join(workspace, ".context-snapshot.md"));
  return st === null ? null : new Date(st.mtimeMs).toISOString();
}

/** Branch and changed-path count; 1 s timeout each; null when git is absent or slow. */
export function readGit(workspace: string, env: Env): { branch: string; changed: number } | null {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["--no-optional-locks", "-C", workspace, ...args], {
        encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        env: { ...env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true,
      });
    } catch {
      return null;
    }
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return null;
  const status = run(["status", "--porcelain"]);
  if (status === null) return null;
  return { branch: oneLine(branch).slice(0, 80), changed: status.split("\n").filter((l) => l !== "").length };
}

/**
 * The capture root named by the workspace's native-capture hook, if any. The command is built by
 * bin/init/native-capture.mjs `definition()`: `--root` unquoted, the root single-quoted with
 * `'` written as `'"'"'`.
 */
function captureRoot(workspace: string): string | null {
  const doc = readJson(path.join(workspace, ".codex", "hooks.json"), HOOKS_MAX);
  const groups = isObject(doc) && isObject(doc.hooks) && Array.isArray(doc.hooks.UserPromptSubmit) ? doc.hooks.UserPromptSubmit : [];
  for (const g of groups) {
    const hooks = isObject(g) && Array.isArray(g.hooks) ? g.hooks : [];
    for (const h of hooks) {
      const command = isObject(h) ? str(h.command) : null;
      const m = command === null ? null : / --root '((?:[^']|'"'"')*)'/.exec(command);
      if (m?.[1] === undefined) continue;
      const root = m[1].replaceAll(`'"'"'`, "'");
      if (path.isAbsolute(root)) return root;
    }
  }
  return null;
}

/**
 * Request-capture inventory (`limit:100`): count and newest `received_at` only; no content (F12).
 * The inventory keeps the OLDEST `limit` items, so past the limit the newest is not observed.
 * Async: only the script entry can await it (resolveHandoff is synchronous, SPEC §10).
 */
export async function readCapture(workspace: string): Promise<{ count: number; truncated: boolean; newest: string | null } | null> {
  const root = captureRoot(workspace);
  if (root === null) return null;
  try {
    const inv = await listCaptureInventory(root, { limit: 100 });
    if (inv.items.length === 0 && !inv.complete) return null;
    const truncated = inv.anomalies.some((a) => a.code === "scan_limit");
    return { count: inv.items.length, truncated, newest: truncated ? null : inv.items[inv.items.length - 1]?.received_at ?? null };
  } catch {
    return null;
  }
}
