// #1170 controller-owned anchored reader and controller inbox persistence.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HEX64_RE, ITEM_KEY_RE, REQUEST_ID_RE, type ItemKind } from "./envelope.js";

export const DISPATCH_ID_RE = /^[0-9a-f]{32}$/;
export const UNBOUND_DIR = "_unbound";
const ITEM_FILE_RE = /^(?:(REPORT|HOLD)-([1-9]|[12][0-9]|3[0-2])|(TURN)-([1-9]|[1-5][0-9]|6[0-4]))\.md$/;
const MARKER_RE = /^[a-z_]{1,32}$/;
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CODES = new Set(["anchored_read_unsupported", "helper_bad_args", "helper_root_invalid", "helper_manifest_invalid",
  "helper_manifest_mismatch", "outbox_root_invalid", "request_invalid", "outbox_entry_limit", "symlink",
  "not_regular", "hardlink", "too_large", "race", "io_error"]);
const HELPER = fileURLToPath(new URL("../../../bin/report-outbox-read.py", import.meta.url));

export interface AnchoredEntry { name: string; kind: ItemKind; seq: number; bytes?: Buffer; refusalCode?: string }
export type AnchoredScan = { status: "ok" | "missing_request"; entries: AnchoredEntry[]; markers: string[]; ignored: number } |
  { status: "refused"; error: string; entries: []; markers: []; ignored: 0 };

const refused = (error: string): AnchoredScan => ({ status: "refused", error, entries: [], markers: [], ignored: 0 });
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(x).sort().join("\0") === keys.sort().join("\0");

/** Controller configuration only. The worker manifest's PATH is never used. */
function controllerPython(): string | null {
  const configured = process.env.AIGENTRY_REPORT_PYTHON;
  const candidates = configured ? [configured] : (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)
    .filter((p) => path.isAbsolute(p)).map((p) => path.join(p, "python3"));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const real = fs.realpathSync(candidate);
      const st = fs.statSync(real);
      if (st.isFile() && (st.mode & 0o111) !== 0) return real;
    } catch { /* next fixed controller candidate */ }
  }
  return null;
}

function decode(stdout: string): AnchoredScan {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return refused("helper_protocol_invalid"); }
  if (!isRecord(value) || value.v !== 1 || !["ok", "missing_request", "refused"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.ignored) || (value.ignored as number) < 0 || (value.ignored as number) > 512 ||
      !Array.isArray(value.markers) || value.markers.length > 16 ||
      !value.markers.every((m) => typeof m === "string" && MARKER_RE.test(m)) ||
      new Set(value.markers).size !== value.markers.length || !Array.isArray(value.entries) || value.entries.length > 128) {
    return refused("helper_protocol_invalid");
  }
  if (value.status === "refused") {
    return exactKeys(value, ["v", "status", "error", "ignored", "markers", "entries"]) &&
      typeof value.error === "string" && CODES.has(value.error) && value.ignored === 0 &&
      value.markers.length === 0 && value.entries.length === 0 ? refused(value.error) : refused("helper_protocol_invalid");
  }
  if (!exactKeys(value, ["v", "status", "ignored", "markers", "entries"]) ||
      (value.status === "missing_request" && (value.entries.length !== 0 || value.ignored !== 0))) return refused("helper_protocol_invalid");
  const entries: AnchoredEntry[] = [];
  const names = new Set<string>();
  for (const raw of value.entries) {
    if (!isRecord(raw) || typeof raw.name !== "string" || names.has(raw.name)) return refused("helper_protocol_invalid");
    names.add(raw.name);
    const match = ITEM_FILE_RE.exec(raw.name);
    if (!match) return refused("helper_protocol_invalid");
    const kind = (match[1] ?? match[3]) as ItemKind;
    const seq = Number(match[2] ?? match[4]);
    if (exactKeys(raw, ["name", "refusal_code"]) && typeof raw.refusal_code === "string" && CODES.has(raw.refusal_code)) {
      entries.push({ name: raw.name, kind, seq, refusalCode: raw.refusal_code });
      continue;
    }
    if (!exactKeys(raw, ["name", "bytes_b64"]) || typeof raw.bytes_b64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.bytes_b64)) {
      return refused("helper_protocol_invalid");
    }
    const bytes = Buffer.from(raw.bytes_b64, "base64");
    if (bytes.toString("base64") !== raw.bytes_b64 || bytes.length > (kind === "TURN" ? 8192 : 65536)) {
      return refused("helper_protocol_invalid");
    }
    entries.push({ name: raw.name, kind, seq, bytes });
  }
  return { status: value.status as "ok" | "missing_request", entries, markers: value.markers as string[], ignored: value.ignored as number };
}

/** Open the sealed attempt root once, then let the fixed helper scan through fd 3. */
export function scanAnchoredOutbox(root: string, manifestSha: string, sid: string, attempt: string, request: string): AnchoredScan {
  if ((!REQUEST_ID_RE.test(request) && request !== UNBOUND_DIR) || !SID_RE.test(sid) ||
      !REQUEST_ID_RE.test(attempt) || !HEX64_RE.test(manifestSha)) return refused("helper_bad_args");
  if (fs.constants.O_NOFOLLOW === undefined || fs.constants.O_DIRECTORY === undefined) return refused("anchored_read_unsupported");
  let fd: number | undefined;
  let phase: "root" | "helper" = "root";
  let result: AnchoredScan = refused("chain_root_invalid");
  try {
    const pre = fs.lstatSync(root, { bigint: true });
    if (pre.isDirectory() && (pre.mode & 0o077n) === 0n) {
      fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const post = fs.fstatSync(fd, { bigint: true });
      if (!post.isDirectory() || pre.dev !== post.dev || pre.ino !== post.ino || pre.uid !== post.uid ||
          (post.mode & 0o077n) !== 0n) {
        result = refused("chain_root_race");
      } else {
        phase = "helper";
        const python = controllerPython();
        if (!python) result = refused("helper_python_unavailable");
        else if (!fs.lstatSync(HELPER).isFile()) result = refused("helper_missing");
        else {
          const child = spawnSync(python, ["-I", "-S", HELPER, request, sid, attempt, manifestSha], {
            shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", fd],
          });
          result = child.error || child.signal || child.status !== 0 ? refused("helper_process_failed") : decode(child.stdout);
        }
      }
    }
  } catch {
    result = refused(phase === "root" ? "chain_root_invalid" : "helper_process_failed");
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { if (result.status !== "refused") result = refused("helper_close_failed"); }
    }
  }
  return result;
}

/** Controller-owned, atomic inbox copy. */
export function writeInboxCopy(stateDir: string, dispatchId: string, key: string, sha256: string, bytes: Uint8Array): string {
  if (!DISPATCH_ID_RE.test(dispatchId) || !ITEM_KEY_RE.test(key) || !HEX64_RE.test(sha256)) throw new Error("REPORT_INBOX_NAME");
  const dir = path.join(stateDir, "inbox", "reports", dispatchId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${key}-${sha256}.md`);
  const tmp = `${target}.tmp.report-pump.${process.pid}`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      for (let off = 0; off < bytes.length;) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  if (process.platform !== "win32") {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  return target;
}
