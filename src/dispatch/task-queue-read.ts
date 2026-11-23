import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR =
  process.env.DISPATCH_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");

export const TASK_QUEUE = process.env.AIGENTRY_TASK_QUEUE || path.join(SCRIPT_DIR, "..", "state", "task-queue.json");

export const ALLOWED_STATUS = new Set(["pending", "in_progress", "delegated", "queued", "blocked-by-observation"]);
export const TERMINAL_STATUS = new Set(["done", "completed", "superseded", "cancelled", "closed"]);

export type TaskQueueResult =
  | { kind: "unreadable" }
  | { kind: "not-found" }
  | { kind: "archived"; status: "completed" }
  | { kind: "unique"; status: string; dispatchable: boolean; terminal: boolean }
  | { kind: "duplicate"; rows: unknown[]; hits: number[] };

/** Every row whose id matches. The COUNT is the point: two rows is an id nobody can resolve. */
export function findTaskRows(rows: unknown[], taskId: string): number[] {
  const hits: number[] = [];
  rows.forEach((t, i) => {
    if (t && String((t as { id?: unknown }).id) === taskId) hits.push(i);
  });
  return hits;
}

/** Read the local queue with active rows taking precedence over the archive. */
export function taskQueueStatus(taskId: string): TaskQueueResult {
  let data: { tasks?: unknown[]; completed?: unknown[] };
  try {
    data = JSON.parse(fs.readFileSync(TASK_QUEUE, "utf8"));
  } catch {
    return { kind: "unreadable" };
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const hits = findTaskRows(tasks, taskId);
  if (hits.length > 1) return { kind: "duplicate", rows: tasks, hits };
  const task = (hits.length === 1 ? tasks[hits[0]!] : undefined) as { status?: unknown } | undefined;
  if (task === undefined) {
    // completed[] is the archive tail — a hit there is a stale id, not an unknown one.
    const completed = Array.isArray(data.completed) ? data.completed : [];
    if (completed.some((t) => t && String((t as { id?: unknown }).id) === taskId)) {
      return { kind: "archived", status: "completed" };
    }
    return { kind: "not-found" };
  }
  const status = String(task.status || "");
  if (ALLOWED_STATUS.has(status)) return { kind: "unique", status, dispatchable: true, terminal: false };
  const terminal = TERMINAL_STATUS.has(status) || status.startsWith("done") || status.startsWith("completed");
  return { kind: "unique", status, dispatchable: false, terminal };
}
