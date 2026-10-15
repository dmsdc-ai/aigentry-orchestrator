// #1201 — private write of `<ws>/state/handoff/latest.{md,json}` (SPEC §6.4), copying the
// boot-record discipline (src/orchestrator-boot/boot-record.ts writeControllerBootRecord):
// - `<ws>/state` must already be a real directory (not a symlink; POSIX: ours, not group/other-
//   writable). `state/handoff` is made by ONE non-recursive mkdir 0700, then lstat'ed the same way.
// - each file: a unique `wx` 0600 O_NOFOLLOW temp → write → fsync → close → rename over the
//   target (a planted link AT the target is replaced, not followed) → lstat dev/ino compare.
//   On error only OUR temp is unlinked.
// - win32: the same sequence; a directory this call created is Set private through the P2
//   primitive (src/session/private-storage.js), a pre-existing one must verify private.
// SAME-USER RACE LIMIT as boot-record.ts: check-then-use; drift is reported, never prevented.
// No chmod/chown: nothing pre-existing is repaired or widened. Never throws.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { WinPrivateStorage } from "../session/private-storage.js";
import type { HandoffOutcome } from "./types.js";

const POSIX = process.platform !== "win32";
const WIN_STORAGE: WinPrivateStorage | null = POSIX
  ? null
  : await import("../session/private-storage.js").then((m) => m.winPrivateStorage, () => null);

export function handoffDir(workspace: string): string {
  return path.join(workspace, "state", "handoff");
}

function safeDir(p: string): "ok" | "missing" | "unsafe" {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return "unsafe";
  if (!POSIX) return "ok";
  const uid = process.getuid?.();
  return (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0 ? "ok" : "unsafe";
}

/** `<ws>/state` precondition (SPEC §6.1): null when it is a safe real directory. */
export function checkStateDir(workspace: string): HandoffOutcome | null {
  const state = safeDir(path.join(workspace, "state"));
  if (state === "missing") return "skipped:no-state-dir";
  if (state !== "ok") return "skipped:unsafe-path";
  if (!POSIX && WIN_STORAGE === null) return "skipped:platform";
  return null;
}

/** `state/handoff`, created if absent; null outcome when it is safe to write into. */
function prepareDir(workspace: string): HandoffOutcome | null {
  const state = checkStateDir(workspace);
  if (state !== null) return state;
  const dir = handoffDir(workspace);
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return "skipped:unsafe-path";
  }
  if (safeDir(dir) !== "ok") return "skipped:unsafe-path";
  if (WIN_STORAGE !== null) {
    if (created) {
      if (WIN_STORAGE.setPrivate(dir, "directory").status !== "ok") {
        try {
          fs.rmdirSync(dir);
        } catch {
          // Best effort, and only ever the empty directory this call just made.
        }
        return "skipped:platform";
      }
    }
    const [v] = WIN_STORAGE.verify([{ path: dir, kind: "directory", want: "private" }]);
    if (v === undefined || !v.ok) return "skipped:unsafe-path";
  }
  return null;
}

function writeOne(dir: string, name: string, data: Buffer): boolean {
  const target = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.${randomUUID()}`);
  let tmp: string | null = null;
  try {
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (POSIX ? fs.constants.O_NOFOLLOW : 0),
      0o600,
    );
    tmp = tmpPath;
    let written: fs.Stats;
    try {
      let off = 0;
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
      written = fs.fstatSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, target);
    tmp = null;
    const after = fs.lstatSync(target);
    return after.isFile() && after.dev === written.dev && after.ino === written.ino;
  } catch {
    if (tmp !== null) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best effort, and only ever our own temp path.
      }
    }
    return false;
  }
}

/** Writes latest.md, then latest.json (which names latest.md's sha256). */
export function writeHandoff(workspace: string, markdown: Buffer, record: Buffer): HandoffOutcome {
  try {
    const refused = prepareDir(workspace);
    if (refused !== null) return refused;
    const dir = handoffDir(workspace);
    if (!writeOne(dir, "latest.md", markdown)) return "skipped:write-error";
    if (!writeOne(dir, "latest.json", record)) return "skipped:write-error";
    return safeDir(dir) === "ok" ? "written" : "skipped:write-error";
  } catch {
    return "skipped:write-error";
  }
}
