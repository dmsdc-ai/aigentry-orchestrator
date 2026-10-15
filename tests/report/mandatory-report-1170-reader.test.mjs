// #1170 reader regressions at the real Node -> shipped Python helper fd seam.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outbox = await import(pathToFileURL(path.join(candidate, "dist/src/report/outbox.js")).href);
const POSIX_ONLY = process.platform === "win32" ? "fd-relative Python reader requires POSIX" : false;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function box() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "report-reader-"));
  fs.chmodSync(fixture, 0o700);
  const root = path.join(fixture, "attempt"), outside = path.join(fixture, "outside");
  const sid = "mr1170-reader", attempt = randomUUID(), request = randomUUID();
  const out = path.join(root, "home", "report-outbox");
  const dir = path.join(out, request);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  const manifest = Buffer.from(JSON.stringify({ sid, attempt }));
  fs.writeFileSync(path.join(root, "manifest.json"), manifest, { mode: 0o600 });
  const digest = sha(manifest);
  return {
    fixture, root, outside, out, dir, sid, attempt, request, digest,
    scan: (req = request) => outbox.scanAnchoredOutbox(root, digest, sid, attempt, req),
    put: (name, bytes) => fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 }),
    clean: () => fs.rmSync(fixture, { recursive: true, force: true }),
  };
}

// Run the actual package helper with a Python-only fault injector. The Node reader still
// supplies fd 3 and decodes the real helper's stdout; stderr is a test-owned trace.
const PROBE = `
import json, os, runpy, sys
helper, request, sid, attempt, digest, itemdir, outside, specraw = sys.argv[1:]
spec = json.loads(specraw)
item = spec.get("item", "REPORT-1.md")
itempath = os.path.join(itemdir, item)
outsidepath = os.path.join(outside, item)
backup = itemdir + ".saved"
original_stat, original_open, original_read, original_close = os.stat, os.open, os.read, os.close
original_inode = original_stat(itempath) if os.path.exists(itempath) else None
outside_inode = original_stat(outsidepath) if os.path.exists(outsidepath) else None
trace = {"fired": False, "item_open": False, "outside_open": False, "outside_read": False}
mode = spec["mode"]
if mode == "unsupported":
    os.supports_dir_fd.discard(original_open)
def stat_hook(name, *args, **kwargs):
    st = original_stat(name, *args, **kwargs)
    if mode in ("replace", "symlink", "vanish") and name == item and kwargs.get("dir_fd") is not None and not trace["fired"]:
        if mode == "replace":
            os.rename(outsidepath, itempath)
        else:
            os.unlink(itempath)
            if mode == "symlink":
                os.symlink(outsidepath, itempath)
        trace["fired"] = True
    return st
def open_hook(name, flags, *args, **kwargs):
    fd = original_open(name, flags, *args, **kwargs)
    if name == item and kwargs.get("dir_fd") is not None:
        trace["item_open"] = True
        st = os.fstat(fd)
        trace["outside_open"] = outside_inode is not None and (st.st_dev, st.st_ino) == (outside_inode.st_dev, outside_inode.st_ino)
        if mode == "postopen" and not trace["fired"]:
            os.rename(itemdir, backup)
            os.symlink(outside, itemdir)
            trace["fired"] = True
    return fd
def read_hook(fd, count):
    st = os.fstat(fd)
    if outside_inode is not None and (st.st_dev, st.st_ino) == (outside_inode.st_dev, outside_inode.st_ino):
        trace["outside_read"] = True
    if mode == "growth" and original_inode is not None and (st.st_dev, st.st_ino) == (original_inode.st_dev, original_inode.st_ino) and not trace["fired"]:
        extra = original_open(itempath, os.O_WRONLY | os.O_APPEND)
        try:
            os.write(extra, b"grown")
        finally:
            original_close(extra)
        trace["fired"] = True
    return original_read(fd, count)
def close_hook(fd):
    original_close(fd)
    if mode == "close" and fd == 3 and not trace["fired"]:
        trace["fired"] = True
        raise OSError("synthetic helper close failure")
os.stat, os.open, os.read, os.close = stat_hook, open_hook, read_hook, close_hook
os.supports_dir_fd.add(stat_hook)
if mode != "unsupported":
    os.supports_dir_fd.add(open_hook)
os.supports_follow_symlinks.add(stat_hook)
sys.argv = [helper, request, sid, attempt, digest]
try:
    runpy.run_path(helper, run_name="__main__")
finally:
    os.stat, os.open, os.read, os.close = original_stat, original_open, original_read, original_close
    if mode == "postopen" and trace["fired"]:
        os.unlink(itemdir)
        os.rename(backup, itemdir)
    print(json.dumps(trace), file=sys.stderr)
`;

function scanProbe(b, mode) {
  const original = childProcess.spawnSync;
  let child;
  childProcess.spawnSync = (python, args, opts) => {
    assert.equal(args[0], "-I");
    assert.equal(args[1], "-S");
    assert.equal(typeof opts.stdio[3], "number");
    child = original(python, ["-I", "-S", "-c", PROBE, args[2], ...args.slice(3),
      b.dir, b.outside, JSON.stringify({ mode })], opts);
    return child;
  };
  syncBuiltinESMExports();
  try {
    const result = b.scan();
    assert.equal(child?.status, 0, child?.stderr);
    const trace = JSON.parse(child.stderr.trim().split("\n").at(-1));
    return { result, trace, child };
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

test("reader accepts separate REPORT and HOLD bytes, bounded TURN and markers", { skip: POSIX_ONLY }, () => {
  const b = box();
  try {
    const report = Buffer.from("report positive"), hold = Buffer.from("hold positive");
    b.put("REPORT-1.md", report);
    b.put("HOLD-1.md", hold);
    for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(b.out, ".hook-degraded-" + String.fromCharCode(97 + i)), "");
    const r = b.scan();
    assert.equal(r.status, "ok");
    assert.deepEqual(r.entries.map(e => [e.name, e.bytes.toString()]),
      [["HOLD-1.md", hold.toString()], ["REPORT-1.md", report.toString()]]);
    assert.equal(r.markers.length, 16);
    const unbound = path.join(b.out, "_unbound");
    fs.mkdirSync(unbound, { mode: 0o700 });
    fs.writeFileSync(path.join(unbound, "TURN-1.md"), Buffer.alloc(8192, 65), { mode: 0o600 });
    assert.equal(b.scan("_unbound").entries[0].bytes.length, 8192);
    fs.writeFileSync(path.join(unbound, "TURN-2.md"), Buffer.alloc(8193, 65), { mode: 0o600 });
    assert.equal(b.scan("_unbound").entries.find(e => e.name === "TURN-2.md").refusalCode, "too_large");
  } finally { b.clean(); }
});

for (const [mode, code] of [["growth", "race"], ["replace", "race"],
  ["symlink", process.platform === "darwin" ? "race" : "symlink"], ["vanish", "race"]]) {
  test(`reader refuses ${mode} between stat/open/read at the Python fd seam`, { skip: POSIX_ONLY }, () => {
    const b = box();
    try {
      b.put("REPORT-1.md", "worker");
      fs.writeFileSync(path.join(b.outside, "REPORT-1.md"), "outside", { mode: 0o600 });
      const { result, trace } = scanProbe(b, mode);
      assert.equal(trace.fired, true, "fault hook reached");
      assert.equal(trace.outside_open, mode === "replace", "replacement inode can open but must fail before read");
      assert.equal(trace.outside_read, false);
      assert.equal(result.status, "ok");
      assert.equal(result.entries[0].refusalCode, code);
    } finally { b.clean(); }
  });
}

test("reader keeps opened request fd after parent swap and never reads outside inode", { skip: POSIX_ONLY }, () => {
  const b = box();
  try {
    b.put("REPORT-1.md", "worker");
    fs.writeFileSync(path.join(b.outside, "REPORT-1.md"), "outside", { mode: 0o600 });
    const { result, trace } = scanProbe(b, "postopen");
    assert.equal(trace.fired, true);
    assert.equal(trace.item_open, true);
    assert.equal(trace.outside_open, false);
    assert.equal(trace.outside_read, false);
    assert.equal(result.status, "ok");
    assert.equal(result.entries[0].bytes.toString(), "worker");
    assert.equal(fs.readFileSync(path.join(b.outside, "REPORT-1.md"), "utf8"), "outside");
  } finally { b.clean(); }
});

test("reader refuses unsupported fd capability before any item open or read", { skip: POSIX_ONLY }, () => {
  const b = box();
  try {
    b.put("REPORT-1.md", "worker");
    const { result, trace } = scanProbe(b, "unsupported");
    assert.equal(result.error, "anchored_read_unsupported");
    assert.equal(trace.item_open, false);
    assert.equal(trace.outside_read, false);
  } finally { b.clean(); }
});

test("helper close failure and malformed or truncated child stdout refuse at Node seam", { skip: POSIX_ONLY }, () => {
  const b = box();
  const original = childProcess.spawnSync;
  try {
    b.put("REPORT-1.md", "worker");
    const closed = scanProbe(b, "close");
    assert.equal(closed.trace.fired, true);
    assert.equal(closed.result.error, "io_error");
    for (const stdout of ['{"v":1,"status":"ok","entries":[]', '{"v":1,"status":"ok","entries":[],"markers":[],"ignored":0,"extra":1}']) {
      childProcess.spawnSync = () => ({ status: 0, signal: null, stdout, stderr: "" });
      syncBuiltinESMExports();
      assert.equal(b.scan().error, "helper_protocol_invalid");
    }
    assert.equal(fs.readFileSync(path.join(b.dir, "REPORT-1.md"), "utf8"), "worker");
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    b.clean();
  }
});
