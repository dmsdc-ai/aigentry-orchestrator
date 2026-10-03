// #1162 G2b pane binder. The sealed launcher runs this in the pane BEFORE the OS
// sandbox (same host process chain as worker-sandbox-runner), never inside the
// worker. It records which terminal surface/lifecycle hosts this sealed attempt,
// in the sealed root that the worker cannot write (root ∉ allowWrite).
//
// Exit: 0 bound, 10 attempt is no longer current, 20 terminal ids or sealed
// record absent (unsupported), 30 invalid input/record or write failure. It prints
// nothing; the launcher logs the rc. No manifest env, auth or path is printed.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentBindingError, BINDING_FILE, isUuid, readSandboxCurrent, readSealedManifest, writePrivate,
  type TerminalBinding,
} from "./worker-sandbox.js";

// Protected pane env written by the terminal host; a spawn env cannot override it.
const PANE_KEYS = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TERMINAL_LIFECYCLE_ID"] as const;

function bind(manifestFile: string | undefined, hash: string | undefined): number {
  if (!manifestFile || !hash) return 30;
  const { m, root, stage } = readSealedManifest(manifestFile, hash);
  const current = readSandboxCurrent(stage);
  if (current.manifest !== manifestFile || current.hash !== hash) return 10;
  const [workspace, surface, lifecycle] = PANE_KEYS.map(k => process.env[k]);
  if (!workspace || !surface || !lifecycle) return 20;
  if (!isUuid(workspace) || !isUuid(surface) || !isUuid(lifecycle)) return 30;
  const binding: TerminalBinding = { v: 1, sid: m.sid, task: m.task, attempt: m.attempt, manifest_hash: hash,
    workspace_id: workspace, surface_id: surface, terminal_lifecycle_id: lifecycle };
  // Private exclusive tmp, then rename: a planted symlink at the target is
  // replaced, never followed.
  const tmp = path.join(root, `.${BINDING_FILE}.${randomUUID()}`);
  writePrivate(tmp, JSON.stringify(binding) + "\n");
  try {
    fs.renameSync(tmp, path.join(root, BINDING_FILE));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return 0;
}

try {
  process.exitCode = bind(process.argv[2], process.argv[3]);
} catch (e) {
  process.exitCode = e instanceof AgentBindingError && e.code === "missing" ? 20 : 30;
}
