#!/usr/bin/env node
// tq-note.mjs — the operator command for every task-queue mutation (#1172 U3).
//
// Rule 40 says a context delta is appended to the task that owns it before the turn
// moves on. Doing that with `node -e` or `jq` meant a model re-authored the whole
// document for a one-line change, and two writers disagreeing about the committed
// shape cost a 26k-line diff per commit (#1110). This command is the bounded
// alternative: one mutation, one atomic commit, in the shape the file is already in.
//
// It holds no authority. It does not dispatch, spawn, inject, approve, publish or read
// state/dispatch/active.json, and it caches no task/sid/attempt ownership. A queue
// write is a PLANNING-RECORD edit: never product completion, never a semantic ACK,
// never admission. Transport receipt, session liveness and product completion stay
// separate states that no queue write may imply.
//
//   tq-note.mjs append     --task <id> --segment-file <path> [--allow-duplicate-content]
//   tq-note.mjs register   --task-file <path>
//   tq-note.mjs set-status --task <id> --status <s> [--expect-status <s0>]
//   tq-note.mjs set-focus  --track <t> [--expect-focus <t0|null>]
//
// Every subcommand also takes [--queue <path>] [--expect-sha256 <H>] [--json]
// [--correlation-id <id>] [--timeout <sec>].
//
// Node built-ins only; no npm runtime dependency and no `jq` (Article 17). The OS
// advisory lock lives in bin/lib/task-queue-lock.py because Node has neither `fcntl`
// nor `msvcrt` — see that file. If the lock capability is unavailable this command
// refuses by name; it never writes the queue unlocked.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(SELF);
const PKG_ROOT = path.dirname(BIN_DIR);
const BROKER = path.join(BIN_DIR, "lib", "task-queue-lock.py");

/** Identical table in bin/lib/task-queue-lock.py and bin/lib/task-queue-write.mjs. */
const EXIT = { ok: 0, state: 3, usage: 4, capability: 6, corrupt: 9 };

const USAGE = `tq-note.mjs — atomic, locked task-queue mutation (#1172 U3)

  tq-note.mjs append     --task <id> --segment-file <path> [--allow-duplicate-content]
  tq-note.mjs register   --task-file <path>
  tq-note.mjs set-status --task <id> --status <status> [--expect-status <status>]
  tq-note.mjs set-focus  --track <track> [--expect-focus <track|null>]

Common options
  --queue <path>          default: $AIGENTRY_TASK_QUEUE, else <pkg>/state/task-queue.json
  --expect-sha256 <hex>   refuse unless the document still hashes to this (CAS)
  --correlation-id <id>   echoed in --json output; never persisted, never consulted
  --timeout <sec>         transform deadline (default 30); the lock deadline is 10
  --json                  print the response document instead of a sentence

Exit codes
  0  applied, or an observed no-op (already_applied)
  3  state refusal (stale_document, concurrent_write_detected, queue_unavailable,
     ambiguous_task_id, unknown_task_id, duplicate_task_id, unknown_track,
     status_regression, duplicate_segment_content, empty_segment, …)
  4  usage
  6  the OS advisory lock capability is unavailable (no fallback is attempted)
  9  the queue is missing, unreadable, non-regular, over the 32 MiB cap, or corrupt

A segment comes from a FILE, not argv: Rule 40 ¶4 wants spaced, complete sentences,
and shell quoting is how multi-sentence notes get mangled.`;

const die = (code, msg) => {
  process.stderr.write(`tq-note.mjs: ${msg}\n`);
  process.exit(code);
};

/** The canonical queue path. The broker realpaths the directory on top of this, which
 *  is what pins every writer to one `<queue>.lock` inode. */
function resolveQueue(explicit) {
  const raw = explicit || process.env.AIGENTRY_TASK_QUEUE
    || path.join(PKG_ROOT, "state", "task-queue.json");
  return path.resolve(raw);
}

function parseArgs(argv) {
  const op = argv.shift();
  if (op === undefined || op === "--help" || op === "-h" || op === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT.ok);
  }
  const o = { op, json: false, allowDuplicate: false };
  const want = (flag) => {
    const v = argv.shift();
    if (v === undefined || v.startsWith("--")) die(EXIT.usage, `${flag} requires a value`);
    return v;
  };
  while (argv.length) {
    const a = argv.shift();
    switch (a) {
      case "--task": o.task = want(a); break;
      case "--status": o.status = want(a); break;
      case "--track": o.track = want(a); break;
      case "--segment-file": o.segmentFile = want(a); break;
      case "--task-file": o.taskFile = want(a); break;
      case "--queue": o.queue = want(a); break;
      case "--expect-sha256": o.expectSha256 = want(a); break;
      case "--expect-status": o.expectStatus = want(a); break;
      case "--expect-focus": o.expectFocus = want(a); break;
      case "--correlation-id": o.correlationId = want(a); break;
      case "--timeout": o.timeout = want(a); break;
      case "--allow-duplicate-content": o.allowDuplicate = true; break;
      case "--json": o.json = true; break;
      case "--help": case "-h": process.stdout.write(`${USAGE}\n`); process.exit(EXIT.ok); break;
      default: die(EXIT.usage, `unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return o;
}

function readTextFile(file, flag) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) die(EXIT.usage, `${flag} must name a regular file: ${file}`);
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") die(EXIT.usage, `${flag} not found: ${file}`);
    throw e;
  }
}

function buildRequest(o) {
  const params = {};
  switch (o.op) {
    case "append":
      if (!o.task) die(EXIT.usage, "append requires --task");
      if (!o.segmentFile) die(EXIT.usage, "append requires --segment-file");
      params.task = o.task;
      params.segment = readTextFile(o.segmentFile, "--segment-file");
      params.allow_duplicate_content = o.allowDuplicate;
      break;
    case "set-status":
      if (!o.task) die(EXIT.usage, "set-status requires --task");
      if (!o.status) die(EXIT.usage, "set-status requires --status");
      params.task = o.task;
      params.status = o.status;
      if (o.expectStatus !== undefined) params.expect_status = o.expectStatus;
      break;
    case "register": {
      if (!o.taskFile) die(EXIT.usage, "register requires --task-file");
      const text = readTextFile(o.taskFile, "--task-file");
      try {
        params.task_record = JSON.parse(text);
      } catch (e) {
        die(EXIT.usage, `--task-file is not valid JSON: ${e.message}`);
      }
      break;
    }
    case "set-focus":
      if (!o.track) die(EXIT.usage, "set-focus requires --track");
      params.track = o.track;
      if (o.expectFocus !== undefined) params.expect_focus = o.expectFocus;
      break;
    default:
      die(EXIT.usage, `unknown subcommand: ${o.op}\n\n${USAGE}`);
  }
  const request = { v: 1, op: o.op, queue: resolveQueue(o.queue), params };
  if (o.expectSha256 !== undefined) request.expect_sha256 = o.expectSha256;
  // Echoed for log stitching only. It is never persisted and never consulted as an
  // idempotency key — the committed document is the only decision input.
  if (o.correlationId !== undefined) request.correlation_id = o.correlationId;
  return request;
}

/** Run the broker. Windows has no shebang, so Python is named explicitly there — the
 *  same split bin/dispatch-registry.py callers already use (src/dispatch/registry-command.ts). */
export function callBroker(request, { timeout, queue } = {}) {
  if (!fs.existsSync(BROKER)) {
    return {
      status: EXIT.capability,
      body: {
        v: 1, applied: false, reason: "lock_capability_unavailable",
        detail: `the packaged lock broker is absent at ${BROKER}; this install is incomplete `
          + "and the queue was not written",
      },
      stderr: "",
    };
  }
  const args = ["--queue", queue ?? request.queue, "--node", process.execPath];
  if (timeout !== undefined) args.push("--timeout", String(timeout));
  const invocation = process.platform === "win32"
    ? { cmd: "python", args: [BROKER, ...args] }
    : { cmd: BROKER, args };
  const r = spawnSync(invocation.cmd, invocation.args, {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (r.error) {
    return {
      status: EXIT.capability,
      body: {
        v: 1, applied: false, reason: "lock_capability_unavailable",
        detail: `could not run ${BROKER}: ${r.error.message}. Python 3 is a declared `
          + "dependency of this package; the queue was not written and no unlocked "
          + "fallback was attempted",
      },
      stderr: r.stderr || "",
    };
  }
  let body = null;
  const line = String(r.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (line) { try { body = JSON.parse(line); } catch { body = null; } }
  if (body === null) {
    body = {
      v: 1, applied: false, reason: "malformed_response",
      detail: `the broker produced no response document (exit ${r.status}, signal ${r.signal})`,
    };
  }
  return { status: r.status === null ? EXIT.state : r.status, body, stderr: r.stderr || "", signal: r.signal };
}

function sentence(b) {
  if (b.applied) {
    const where = b.op === "set-focus" ? `active_focus=${b.track ?? ""}` : `task ${b.task}`;
    return `${b.op}: applied to ${where} (${b.bytes_before} -> ${b.bytes_after} bytes, `
      + `${b.doc_sha256_after?.slice(0, 12)})`;
  }
  if (b.reason === "already_applied") return `${b.op}: already applied — nothing written`;
  if (b.reason === "exists") return `${b.op}: the queue already exists — preserved`;
  return `${b.reason}: ${b.detail ?? ""}`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const request = buildRequest(o);
  const timeoutArg = o.timeout === undefined ? undefined : Number(o.timeout);
  if (timeoutArg !== undefined && !(Number.isFinite(timeoutArg) && timeoutArg > 0)) {
    die(EXIT.usage, "--timeout must be a positive number of seconds");
  }
  const { status, body, stderr } = callBroker(request, { timeout: timeoutArg });
  if (o.json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stdout.write(`${sentence(body)}\n`);
  // The sentence already carries the reason and detail, so the helper's own stderr is
  // forwarded only in --json mode, where stdout must stay machine-readable.
  if (o.json && status !== EXIT.ok && stderr) process.stderr.write(stderr);
  process.exit(status);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SELF)) main();
