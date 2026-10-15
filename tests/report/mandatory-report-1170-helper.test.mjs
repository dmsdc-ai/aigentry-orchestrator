// Focused contract checks for the package-shipped fd-anchored helper.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outbox = await import(pathToFileURL(path.join(candidate, "dist/src/report/outbox.js")).href);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("anchored helper distinguishes missing request, bad manifest, bad root and bound/unbound bytes", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "report-helper-"));
  const sid = "mr1170-helper", attempt = randomUUID(), request = randomUUID();
  const out = path.join(root, "home", "report-outbox");
  const dir = path.join(out, request);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = Buffer.from(JSON.stringify({ sid, attempt }));
  fs.writeFileSync(path.join(root, "manifest.json"), manifest, { mode: 0o600 });
  const digest = sha(manifest);
  const read = (req = request, hash = digest, at = root) => outbox.scanAnchoredOutbox(at, hash, sid, attempt, req);
  try {
    assert.deepEqual(read(randomUUID()), { status: "missing_request", entries: [], markers: [], ignored: 0 });
    assert.equal(read(request, "a".repeat(64)).error, "helper_manifest_mismatch");
    assert.equal(read(request, digest, path.join(root, "absent")).error, "chain_root_invalid");
    fs.writeFileSync(path.join(out, ".hook-degraded-race"), "");
    const bytes = Buffer.from("bound-worker-bytes");
    fs.writeFileSync(path.join(dir, "REPORT-1.md"), bytes, { mode: 0o600 });
    const good = read();
    assert.equal(good.status, "ok");
    assert.deepEqual(good.markers, ["race"]);
    assert.ok(good.entries[0].bytes.equals(bytes));
    const unbound = path.join(out, "_unbound");
    fs.mkdirSync(unbound, { mode: 0o700 });
    fs.writeFileSync(path.join(unbound, "TURN-1.md"), "turn", { mode: 0o600 });
    const turn = read("_unbound");
    assert.equal(turn.status, "ok");
    assert.equal(turn.entries[0].kind, "TURN");
    assert.equal(turn.entries[0].bytes.toString(), "turn");
    fs.renameSync(out, path.join(root, "moved-outbox"));
    assert.equal(read().error, "outbox_root_invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("root fd is closed once on validation mismatch and spawn failure, preserving the first refusal", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "report-close-"));
  const sid = "mr1170-close", attempt = randomUUID(), request = randomUUID();
  const digest = "a".repeat(64);
  const original = { openSync: fsMutable.openSync, fstatSync: fsMutable.fstatSync,
    closeSync: fsMutable.closeSync, spawnSync: childProcess.spawnSync };
  let fd, closes = 0;
  try {
    fsMutable.openSync = (...args) => {
      const opened = original.openSync(...args);
      if (args[0] === root) fd = opened;
      return opened;
    };
    fsMutable.fstatSync = (...args) => {
      const st = original.fstatSync(...args);
      if (args[0] === fd) st.ino += 1n;
      return st;
    };
    fsMutable.closeSync = (opened) => {
      if (opened === fd) {
        closes++;
        if (closes === 1) throw new Error("synthetic close failure");
      }
      return original.closeSync(opened);
    };
    syncBuiltinESMExports();
    assert.equal(outbox.scanAnchoredOutbox(root, digest, sid, attempt, request).error, "chain_root_race");
    assert.equal(closes, 1, "the acquired fd must never be retried after a close error");
    // The injected failure kept this fixture fd open; close it outside the instrumented path.
    original.closeSync(fd);
    fd = undefined;

    fsMutable.fstatSync = original.fstatSync;
    fsMutable.closeSync = (opened) => {
      if (opened === fd) closes++;
      return original.closeSync(opened);
    };
    childProcess.spawnSync = () => ({ error: new Error("synthetic spawn failure"), status: null, signal: null });
    closes = 0;
    syncBuiltinESMExports();
    assert.equal(outbox.scanAnchoredOutbox(root, digest, sid, attempt, request).error, "helper_process_failed");
    assert.equal(closes, 1, "spawn failure must close its root fd exactly once");

    childProcess.spawnSync = () => ({ status: 0, signal: null,
      stdout: JSON.stringify({ v: 1, status: "ok", entries: [], markers: [], ignored: 0 }) });
    fsMutable.closeSync = (opened) => {
      if (opened === fd) {
        closes++;
        original.closeSync(opened);
        throw new Error("synthetic close failure after a successful helper");
      }
      return original.closeSync(opened);
    };
    closes = 0;
    syncBuiltinESMExports();
    assert.equal(outbox.scanAnchoredOutbox(root, digest, sid, attempt, request).error, "helper_close_failed");
    assert.equal(closes, 1, "successful helper close failure is reported after exactly one attempt");
    fd = undefined;
  } finally {
    fsMutable.openSync = original.openSync;
    fsMutable.fstatSync = original.fstatSync;
    fsMutable.closeSync = original.closeSync;
    childProcess.spawnSync = original.spawnSync;
    syncBuiltinESMExports();
    if (fd !== undefined) try { original.closeSync(fd); } catch { /* closed on spawn failure */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
