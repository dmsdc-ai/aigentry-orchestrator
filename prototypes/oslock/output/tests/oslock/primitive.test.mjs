// #1166 independent runtime tests for the oslock primitive prototype (tester-owned).
// Run: node --expose-gc tests/oslock/primitive.test.mjs   (cwd ROOT/output)
//   OSLOCK_SUITE=focused|stress|all (default focused). P1/P2 repetitions are fixed (20).
// Executes the staged addon only on fake private roots under ROOT/output and only in this
// process, its owned children/grandchild and its own worker_threads. Product files are
// read-only inputs; nothing under ROOT/input is modified.
// Portable: darwin/linux/win32. Integrity comes from ROOT/manifest.json (local seal or the
// CI build manifest): entries are path-checked and remeasured, the four product sources are
// pinned here, and the binary sha256 is taken only from the verified manifest entry.
// Fixtures that cannot be created unprivileged are reported as skipped "NOTMEASURED: ...".
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const INPUT = join(ROOT, "input");
const ADDON = join(INPUT, "build/oslock.node");
const LOADER = join(INPUT, "proto/oslock-loader.mjs");
const HARNESS = join(INPUT, "proto/with-os-lock.mjs");
const CHILD = join(HERE, "fixtures/child.mjs");
const WORKER = join(HERE, "fixtures/worker.mjs");
const FAKE_BASE = join(HERE, ".fake");
const LOG_DIR = join(ROOT, "output/logs");
const SUITE = process.env.OSLOCK_SUITE ?? "focused";
const WIN = process.platform === "win32";
// Pinned product sources (code 58af35ff, binding 98f5cbf3, loader 1b8cc43e, poller dd72566e).
const PINNED_SOURCES = {
  "input/native/oslock/binding.gyp": "98f5cbf34c9f4bbb8f831eaab4765393558b9b86e600cc820577b65bca1f75d8",
  "input/native/oslock/oslock.c": "58af35ff2d3d02be41580ffa999d1d23e4ccbc0bc316466113b9bbf409b2f6cd",
  "input/proto/oslock-loader.mjs": "1b8cc43eafd5efa27212ef8cbd18bc042c24d5c6ff40e55fa907c92573cacd44",
  "input/proto/with-os-lock.mjs": "dd72566e45691122951a8a3b8005fa191f71dcae344ac96836eff6ce7080b010",
};
const BINARY_ENTRY = "input/build/oslock.node";
// Historical documents appear only in the original local seal; pinned if present.
const HISTORICAL = {
  "input/CODER-REPORT.md": "4abfad556801409f2f6f8faf5c780d63ab96ee2c14663f3a619dc2b23a335597",
  "input/CONTROLLER-CORRECTIONS.md": "3d2ee22dbf3ea4b48ea75835acd559cf18e6d6393968208b4aff0162f3458b89",
  "input/SPEC.md": "7ad1abfa9c07e3dc719f88b9c6bd4adb8b23e9a7bd0a6d82265c68828090ee04",
};
// Compile-time path bound used by oslock.c: PATH_MAX (darwin 1024, linux/glibc 4096) or
// 32767 UTF-16 units on Windows. No portable constant; an unknown platform fails.
const PATH_LIMITS = { darwin: 1024, linux: 4096, win32: 32767 };
// Windows OS errors are reported by the module as WIN32_<GetLastError>.
const WIN_ACCESS_DENIED = "WIN32_5";
const WIN_LONG_PATH_CODES = ["WIN32_3", "WIN32_123", "WIN32_206"]; // path not found / invalid name / filename exceeds range
const WIN_SHARE_DENIAL = ["EPERM", "EBUSY", "EACCES"]; // libuv mapping of access/sharing violations

function sha256Bytes(b) {
  return createHash("sha256").update(b).digest("hex");
}

// Validates ROOT/manifest.json (or given raw bytes) and remeasures every entry.
// Returns the verified binary sha.
function verifyManifest(raw = readFileSync(join(ROOT, "manifest.json"))) {
  const m = JSON.parse(raw.toString("utf8"));
  assert.ok(m && typeof m === "object" && Array.isArray(m.files), "manifest: files[] required");
  const allowed = new Set([...Object.keys(PINNED_SOURCES), BINARY_ENTRY, ...Object.keys(HISTORICAL)]);
  const seen = new Map();
  for (const e of m.files) {
    assert.ok(e && typeof e === "object", "manifest: entry must be an object");
    assert.deepEqual(Object.keys(e).sort(), ["bytes", "path", "sha256"], "manifest: entry keys");
    const p = e.path;
    assert.equal(typeof p, "string", "manifest: path string");
    assert.ok(!p.includes("\\") && !p.includes("\0") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p), `manifest: path form ${JSON.stringify(p)}`);
    assert.ok(p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), `manifest: traversal ${JSON.stringify(p)}`);
    assert.equal(posix.normalize(p), p, `manifest: normalized ${JSON.stringify(p)}`);
    assert.ok(allowed.has(p), `manifest: unexpected entry ${JSON.stringify(p)}`);
    assert.ok(!seen.has(p), `manifest: duplicate ${p}`);
    assert.ok(Number.isSafeInteger(e.bytes) && e.bytes >= 0, `manifest: bytes ${p}`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, `manifest: sha256 ${p}`);
    const abs = resolve(ROOT, ...p.split("/"));
    assert.ok(abs.startsWith(ROOT + sep), `manifest: escapes root ${p}`);
    const st = lstatSync(abs);
    assert.ok(st.isFile(), `manifest: not a regular file ${p}`);
    const bytes = readFileSync(abs);
    assert.equal(bytes.length, e.bytes, `manifest: remeasured bytes ${p}`);
    assert.equal(sha256Bytes(bytes), e.sha256, `manifest: remeasured sha256 ${p}`);
    if (PINNED_SOURCES[p]) assert.equal(e.sha256, PINNED_SOURCES[p], `pinned source ${p}`);
    if (HISTORICAL[p]) assert.equal(e.sha256, HISTORICAL[p], `pinned historical ${p}`);
    seen.set(p, { sha256: e.sha256, bytes: e.bytes, mode: st.mode & 0o777 });
  }
  for (const p of [...Object.keys(PINNED_SOURCES), BINARY_ENTRY]) assert.ok(seen.has(p), `manifest: missing ${p}`);
  // The original local seal staged inputs read-only; CI checkouts are not expected to.
  const localSeal = Object.keys(HISTORICAL).every((p) => seen.has(p));
  if (localSeal && !WIN) {
    for (const [p, v] of seen) assert.equal(v.mode, 0o444, `input mode ${p}`);
  }
  return {
    manifestSha256: sha256Bytes(raw),
    entries: seen.size,
    localSeal,
    binarySha: seen.get(BINARY_ENTRY).sha256,
    modes: Object.fromEntries([...seen].map(([p, v]) => [p, v.mode.toString(8)])),
  };
}

let integrity;
try {
  integrity = { ok: true, ...verifyManifest() };
} catch (err) {
  integrity = { ok: false, error: err };
}
const ADDON_SHA = integrity.ok ? integrity.binarySha : undefined;

process.env.OSLOCK_NODE = ADDON;
if (ADDON_SHA) process.env.OSLOCK_SHA256 = ADDON_SHA;
process.env.OSLOCK_LOADER = LOADER;
process.env.OSLOCK_HARNESS = HARNESS;

// Product modules are imported only after their pinned hashes were verified.
const { loadOsLock } = integrity.ok ? await import(pathToFileURL(LOADER).href) : {};
const { withOsLock } = integrity.ok ? await import(pathToFileURL(HARNESS).href) : {};

// Measurements reported verbatim in REPORT.md (written to logs/ at the end).
const results = {
  suite: SUITE, node: process.version, platform: `${process.platform}-${process.arch}`,
  integrity: integrity.ok ? { ...integrity } : { ok: false, error: String(integrity.error?.message) },
  cases: {},
};
function record(name, data) {
  results.cases[name] = { ...(results.cases[name] ?? {}), ...data };
}

let addon;

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function fakeRoot() {
  mkdirSync(FAKE_BASE, { recursive: true, mode: 0o700 });
  const r = mkdtempSync(join(FAKE_BASE, "r-"));
  chmodSync(r, 0o700);
  return r;
}

// Own-process descriptor count through the standard /dev/fd listing (POSIX only).
// Windows has no unprivileged own-handle listing here: the metric is NOTMEASURED there and
// the safety cases use the share-mode probe below instead.
function fdCount() {
  return WIN ? null : readdirSync("/dev/fd").length;
}

// Windows: carriers are opened without FILE_SHARE_DELETE, so renaming one away succeeds only
// when no oslock handle is open on it. Returns "ok" or the denial code.
function renameProbe(c) {
  const t = `${c}.probe`;
  try {
    renameSync(c, t);
  } catch (err) {
    return err.code;
  }
  renameSync(t, c);
  return "ok";
}

// Descriptors/handles released: POSIX by own fd count, Windows by the share-mode probe.
function assertReleased(c, fd0, what) {
  if (WIN) {
    assert.equal(renameProbe(c), "ok", `${what}: no open handle on carrier`);
    record("fd-metric", { win32: "NOTMEASURED (no unprivileged own-handle count); share-mode probe used" });
  } else {
    assert.equal(fdCount(), fd0, `${what}: descriptor count`);
  }
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw");
}

// True when another open file description currently holds the lock.
function isLocked(carrier) {
  const p = addon.open(carrier);
  try {
    const got = addon.tryLock(p);
    return !got;
  } finally {
    addon.close(p);
  }
}

// Busy-poll a fresh handle until it locks; returns ms waited (or null past boundMs).
function acquireDelay(carrier, boundMs) {
  const p = addon.open(carrier);
  const t0 = performance.now();
  try {
    for (;;) {
      if (addon.tryLock(p)) return performance.now() - t0;
      if (performance.now() - t0 > boundMs) return null;
    }
  } finally {
    addon.close(p);
  }
}

// ---- owned child processes: tracked, watchdogged, always reaped ----
const ownedChildren = new Set();
const ownedGrandchildren = []; // { pid, nonce, channel, done, cleanup }

function spawnChild(role, args, { limitMs = 20_000, env } = {}) {
  const child = spawn(process.execPath, [CHILD, role, JSON.stringify({ ...args, selfLimitMs: limitMs })], {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? process.env,
  });
  ownedChildren.add(child);
  const lines = [];
  const waiters = [];
  let buf = "";
  let stderr = "";
  let closedInfo = null;
  const deliver = (m) => {
    lines.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  };
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        m = { type: "raw", line };
      }
      deliver(m);
    }
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const rejectAll = (why) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(`${role}: ${why} before expected message; stderr=${stderr.slice(0, 2000)}`));
    }
  };
  const watchdog = setTimeout(() => child.kill("SIGKILL"), limitMs + 3000);
  watchdog.unref();
  const exited = new Promise((res) => {
    child.once("exit", (code, signal) => {
      clearTimeout(watchdog);
      ownedChildren.delete(child);
      res({ code, signal, t: performance.now() });
    });
  });
  child.once("error", (err) => rejectAll(`spawn error ${err.code}`));
  // stdio close (not exit) so lines still in the pipe are delivered first.
  child.once("close", (code, signal) => {
    closedInfo = { code, signal };
    rejectAll(`exited (${code}, ${signal})`);
  });
  function waitFor(pred, ms = 10_000) {
    const found = lines.find(pred);
    if (found) return Promise.resolve(found);
    if (closedInfo) {
      return Promise.reject(new Error(`${role}: already exited (${closedInfo.code}, ${closedInfo.signal}); stderr=${stderr.slice(0, 2000)}`));
    }
    return new Promise((resolve2, reject) => {
      const w = { pred, resolve: resolve2, reject };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`${role}: no expected message within ${ms}ms; stderr=${stderr.slice(0, 2000)}`));
      }, ms);
      waiters.push(w);
    });
  }
  return { child, lines, waitFor, exited, stderr: () => stderr };
}

async function reapAllChildren() {
  const pending = [];
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      pending.push(new Promise((r) => child.once("exit", r)));
      child.kill("SIGKILL");
    }
  }
  await Promise.all(pending);
}

// ---- owned P6 grandchildren: nonce-bound channel file, no stdio pipes involved ----
// Only complete lines carrying our nonce and the spawned pid count as evidence.
function channelLines(g) {
  let text;
  try {
    text = readFileSync(g.channel, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const m = JSON.parse(line);
      if (m.nonce === g.nonce && m.pid === g.pid) out.push(m);
    } catch {
      /* not ours */
    }
  }
  return out;
}

function maxBeat(g) {
  return channelLines(g).reduce((s, m) => (m.type === "beat" && m.seq > s ? m.seq : s), 0);
}

async function waitChannel(g, pred, ms, what) {
  const until = performance.now() + ms;
  for (;;) {
    const m = channelLines(g).find(pred);
    if (m) return m;
    if (performance.now() > until) throw new Error(`grandchild ${g.pid}: no ${what} within ${ms}ms`);
    await sleep(20);
  }
}

// A beat newer than every beat seen at call time: the grandchild was alive after the call.
function beatAfter(g, ms = 2000) {
  const s = maxBeat(g);
  return waitChannel(g, (m) => m.type === "beat" && m.seq > s, ms, `beat after seq ${s}`);
}

// Bounded cooperative cleanup, never throws, never signals a pid: stop file holding the nonce,
// then its "exit" line (the normal stop contract). Only if that is missing, a separate teardown
// request, answered by "teardown-exit" (recorded apart, never counted as a normal stop). Past
// that, the fixture 15s self-limit is the bound and the outcome stays unconfirmed.
// Gone = the pid no longer exists: an observation only, never used to act on a pid.
async function stopGrandchild(g) {
  if (g.cleanup) return g.cleanup;
  const out = { exitLine: false, teardownExit: false, gone: false };
  g.cleanup = out;
  try {
    writeFileSync(`${g.channel}.stop`, g.nonce);
    out.exitLine = await waitChannel(g, (m) => m.type === "exit", 5000, "exit").then(() => true, () => false);
    if (!out.exitLine) {
      writeFileSync(`${g.channel}.teardown`, g.nonce);
      out.teardownExit = await waitChannel(g, (m) => m.type === "teardown-exit", 5000, "teardown-exit").then(() => true, () => false);
    }
    const until = performance.now() + 3000;
    while (!out.gone && !out.probeError && performance.now() < until) {
      try {
        process.kill(g.pid, 0);
        await sleep(20);
      } catch (err) {
        if (err.code === "ESRCH") out.gone = true;
        else out.probeError = err.code;
      }
    }
  } catch (err) {
    out.error = String(err?.message ?? err);
  }
  g.done = out.gone && (out.exitLine || out.teardownExit);
  return out;
}

// P6 parent: locks the carrier, spawns the grandchild (with args.control, if any), exits.
async function spawnHoldSpawn(c, closeFirst, control) {
  const nonce = randomUUID();
  const channel = join(dirname(c), `g-${nonce}.jsonl`);
  const a = spawnChild("hold-spawn", { carrier: c, nonce, channel, closeFirst, control, grandLimitMs: 15_000 }, { limitMs: 10_000 });
  const spawned = await a.waitFor((m) => m.type === "spawned" && m.nonce === nonce);
  const g = { pid: spawned.gpid, nonce, channel, done: false };
  ownedGrandchildren.push(g);
  return { a, g };
}

// ---- owned workers ----
const ownedWorkers = new Set();

function startWorker(workerData, limitMs = 20_000) {
  const w = new Worker(WORKER, { workerData });
  ownedWorkers.add(w);
  const msgs = [];
  const waiters = [];
  let exitInfo = null;
  const watchdog = setTimeout(() => w.terminate(), limitMs);
  watchdog.unref();
  w.on("message", (m) => {
    msgs.push(m);
    for (const x of [...waiters]) {
      if (x.pred(m)) {
        waiters.splice(waiters.indexOf(x), 1);
        clearTimeout(x.timer);
        x.resolve(m);
      }
    }
  });
  const fail = (why) => {
    for (const x of waiters.splice(0)) {
      clearTimeout(x.timer);
      x.reject(new Error(`worker ${workerData.role}: ${why}`));
    }
  };
  w.on("error", (err) => fail(`error ${err?.message}`));
  const exited = new Promise((res) => {
    w.once("exit", (code) => {
      clearTimeout(watchdog);
      ownedWorkers.delete(w);
      exitInfo = { code, t: performance.now() };
      fail(`exited (${code}) before expected message`);
      res(exitInfo);
    });
  });
  function waitFor(pred, ms = 10_000) {
    const found = msgs.find(pred);
    if (found) return Promise.resolve(found);
    if (exitInfo) return Promise.reject(new Error(`worker ${workerData.role}: already exited (${exitInfo.code})`));
    return new Promise((resolve2, reject) => {
      const x = { pred, resolve: resolve2, reject };
      x.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(x), 1);
        reject(new Error(`worker ${workerData.role}: no expected message within ${ms}ms`));
      }, ms);
      waiters.push(x);
    });
  }
  return { w, msgs, waitFor, exited };
}

// ---- harness seam: explicit wrapped addon that counts calls and injects faults ----
function wrapAddon(base, hooks = {}) {
  const stats = { calls: 0, open: 0, close: 0, tryLock: 0, identity: 0, live: new Set(), lastLocked: null };
  const w = {
    abi: base.abi,
    open(p) {
      stats.calls++;
      const h = base.open(p);
      stats.open++;
      stats.live.add(h);
      return h;
    },
    tryLock(h) {
      stats.calls++;
      stats.tryLock++;
      const got = base.tryLock(h);
      if (got) {
        stats.lastLocked = h;
        hooks.afterLock?.(h);
      }
      return got;
    },
    unlock(h) {
      stats.calls++;
      return base.unlock(h);
    },
    close(h) {
      stats.calls++;
      stats.live.delete(h);
      base.close(h);
      stats.close++;
      hooks.afterClose?.(h);
    },
    identity(h) {
      stats.calls++;
      stats.identity++;
      return base.identity(h);
    },
  };
  return { w, stats };
}

function sameInode(h, carrier) {
  const st = lstatSync(carrier, { bigint: true });
  const id = addon.identity(h);
  // Windows identity is {vol, idx}: volume serial and 64-bit file index, which libuv
  // reports as st.dev / st.ino.
  if (WIN) return String(st.dev) === id.vol && String(st.ino) === id.idx;
  return String(st.dev) === id.dev && String(st.ino) === id.ino;
}

before(() => {
  if (!integrity.ok) return; // reported by the integrity test; nothing is loaded
  assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
  assert.ok(PATH_LIMITS[process.platform], `no oslock path bound known for ${process.platform}`);
  addon = loadOsLock({ path: ADDON, sha256: ADDON_SHA });
});

after(async () => {
  for (const w of ownedWorkers) await w.terminate();
  await reapAllChildren();
  for (const g of ownedGrandchildren) {
    await stopGrandchild(g);
    if (!g.done) record("cleanup", { grandchildUnconfirmed: g });
  }
  rmSync(FAKE_BASE, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(LOG_DIR, `results-${SUITE}-${Date.now()}.json`), `${JSON.stringify(results, null, 2)}\n`);
});

assert.ok(["focused", "stress", "all"].includes(SUITE), `OSLOCK_SUITE must be focused|stress|all, got ${SUITE}`);
const FOCUSED = integrity.ok && (SUITE === "focused" || SUITE === "all");
const STRESS = integrity.ok && (SUITE === "stress" || SUITE === "all");

test("C0 manifest integrity: path rules, remeasured bytes/sha256, pinned sources, binary sha from manifest", () => {
  if (!integrity.ok) throw integrity.error;
  assert.equal(sha256File(ADDON), ADDON_SHA);
  record("C0", { manifestSha256: integrity.manifestSha256, entries: integrity.entries, localSeal: integrity.localSeal, binarySha: ADDON_SHA });
});

test("C0b manifest validator rejects traversal, foreign forms, unexpected/duplicate/missing entries, bad bytes/sha", () => {
  if (!integrity.ok) throw integrity.error;
  const base = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const src = base.files.find((e) => e.path === "input/proto/with-os-lock.mjs");
  const variants = {
    dotdot: (f) => f.concat({ ...src, path: "../input/proto/with-os-lock.mjs" }),
    innerDotdot: (f) => f.concat({ ...src, path: "input/../input/proto/with-os-lock.mjs" }),
    dotSegment: (f) => f.concat({ ...src, path: "input/./proto/with-os-lock.mjs" }),
    absolute: (f) => f.concat({ ...src, path: "/input/proto/with-os-lock.mjs" }),
    drive: (f) => f.concat({ ...src, path: "C:/input/proto/with-os-lock.mjs" }),
    backslash: (f) => f.concat({ ...src, path: "input\\proto\\with-os-lock.mjs" }),
    unexpected: (f) => f.concat({ ...src, path: "input/proto/extra.mjs" }),
    duplicate: (f) => f.concat({ ...src }),
    extraKey: (f) => f.map((e) => (e === src ? { ...e, mode: 420 } : e)),
    wrongBytes: (f) => f.map((e) => (e === src ? { ...e, bytes: e.bytes + 1 } : e)),
    wrongSha: (f) => f.map((e) => (e === src ? { ...e, sha256: "0".repeat(64) } : e)),
    missingBinary: (f) => f.filter((e) => e.path !== BINARY_ENTRY),
    missingSource: (f) => f.filter((e) => e !== src),
  };
  const out = {};
  for (const [name, mutate] of Object.entries(variants)) {
    const raw = Buffer.from(JSON.stringify({ ...base, files: mutate(base.files) }));
    const err = codeOf(() => verifyManifest(raw));
    assert.ok(err instanceof assert.AssertionError, `${name}: ${err?.message}`);
    out[name] = String(err.message).split("\n")[0];
  }
  assert.doesNotThrow(() => verifyManifest(Buffer.from(JSON.stringify(base))), "unmodified manifest accepted");
  record("C0b", out);
});

if (FOCUSED) {
  describe("controls", () => {
    test("C1 abi and exact frozen export set", () => {
      assert.equal(addon.abi(), "oslock/1");
      assert.deepEqual(Object.keys(addon).sort(), ["abi", "close", "identity", "open", "tryLock", "unlock"]);
      assert.ok(Object.isFrozen(addon));
    });

    test("C2 basic lifecycle, identity matches lstat, carrier 0600 and never unlinked", () => {
      const r = fakeRoot();
      const c = join(r, "carrier");
      const fd0 = fdCount();
      const h = addon.open(c);
      if (WIN) {
        assert.ok(WIN_SHARE_DENIAL.includes(renameProbe(c)), "open handle denies rename (no FILE_SHARE_DELETE)");
        record("C2", { win32Mode: "N/A (POSIX 0600 only)" });
      } else {
        assert.equal(fdCount(), fd0 + 1);
        assert.equal(statSync(c).mode & 0o777, 0o600);
      }
      assert.ok(sameInode(h, c));
      assert.equal(addon.tryLock(h), true);
      assert.equal(isLocked(c), true);
      assert.equal(addon.unlock(h), undefined);
      assert.equal(isLocked(c), false);
      assert.equal(addon.tryLock(h), true);
      assert.equal(addon.close(h), undefined); // close while LOCKED releases
      assert.equal(isLocked(c), false);
      assertReleased(c, fd0, "C2");
      assert.ok(lstatSync(c).isFile());
    });

    test("P3 same-thread second handle self-conflicts; after unlock it locks", () => {
      const c = join(fakeRoot(), "carrier");
      const h1 = addon.open(c);
      const h2 = addon.open(c);
      assert.equal(addon.tryLock(h1), true);
      assert.equal(addon.tryLock(h2), false);
      assert.equal(addon.tryLock(h2), false);
      addon.unlock(h1);
      assert.equal(addon.tryLock(h2), true);
      assert.equal(addon.tryLock(h1), false);
      addon.close(h2);
      addon.close(h1);
    });

    test("P7 misuse: non-handles, clones, proxies, closed/double close/unlock, tryLock while LOCKED", () => {
      const c = join(fakeRoot(), "carrier");
      const h = addon.open(c);
      assert.equal(addon.tryLock(h), true);
      const bogus = {
        plain: {}, nul: null, undef: undefined, num: 42, str: "x", arr: [], fn() {},
        protoChild: Object.create(h), proxy: new Proxy(h, {}), clone: structuredClone(h),
      };
      const seen = {};
      for (const op of ["tryLock", "unlock", "identity", "close"]) {
        for (const [k, v] of Object.entries(bogus)) {
          const err = codeOf(() => addon[op](v));
          assert.equal(err.code, "EOSLOCK_HANDLE", `${op}(${k})`);
          assert.ok(err instanceof TypeError, `${op}(${k}) TypeError`);
          seen[`${op}:${k}`] = err.code;
        }
        const noArg = codeOf(() => addon[op]());
        assert.equal(noArg.code, "EOSLOCK_HANDLE", `${op}()`);
      }
      assert.equal(codeOf(() => addon.open(h)).code, "EOSLOCK_PATH");
      assert.equal(isLocked(c), true, "no lock change after misuse");
      const st = codeOf(() => addon.tryLock(h));
      assert.equal(st.code, "EOSLOCK_STATE");
      assert.equal(isLocked(c), true, "tryLock while LOCKED keeps the lock");
      addon.unlock(h);
      assert.equal(codeOf(() => addon.unlock(h)).code, "EOSLOCK_STATE", "double unlock");
      assert.equal(isLocked(c), false);
      addon.close(h);
      for (const op of ["tryLock", "unlock", "identity", "close"]) {
        const err = codeOf(() => addon[op](h));
        assert.equal(err.code, "EOSLOCK_CLOSED", `${op}(closed)`);
      }
      record("P7", { misuseMatrix: Object.keys(seen).length + 4, cloneKeys: Object.keys(bogus.clone) });
    });

    test("P7 handle posted to a worker arrives as a non-handle; original unaffected", { timeout: 20_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const h = addon.open(c);
      assert.equal(addon.tryLock(h), true);
      const wk = startWorker({ role: "probe-clone" });
      await wk.waitFor((m) => m.type === "ready");
      let postError = null;
      try {
        wk.w.postMessage({ h });
      } catch (err) {
        postError = { name: err.name, message: err.message };
      }
      let probe = null;
      if (postError) {
        await wk.w.terminate();
      } else {
        probe = await wk.waitFor((m) => m.type === "probe");
        for (const v of Object.values(probe.results)) assert.equal(v, "EOSLOCK_HANDLE");
      }
      await wk.exited;
      assert.equal(isLocked(c), true);
      assert.ok(sameInode(h, c));
      addon.close(h);
      record("P7-worker", { postError, probe });
    });

    test("paths: wrong type, empty, NUL, unpaired surrogates, lengths; no stray files; no path in messages", () => {
      const r = fakeRoot();
      const out = {};
      const expectCode = (name, v, code, typeErr) => {
        const err = codeOf(() => addon.open(v));
        assert.equal(err.code, code, name);
        if (typeErr !== undefined) assert.equal(err instanceof TypeError, typeErr, `${name} TypeError`);
        assert.ok(!String(err.message).includes(r), `${name} message has no path`);
        out[name] = err.code;
      };
      expectCode("number", 123, "EOSLOCK_PATH", true);
      expectCode("undefined", undefined, "EOSLOCK_PATH", true);
      expectCode("object", {}, "EOSLOCK_PATH", true);
      expectCode("null", null, "EOSLOCK_PATH", true);
      expectCode("empty", "", "EOSLOCK_PATH", true);
      expectCode("embeddedNUL", join(r, "a\0b"), "EOSLOCK_PATH", true);
      expectCode("loneHigh", join(r, "x\uD800y"), "EOSLOCK_PATH", true);
      expectCode("loneHighEnd", join(r, "x\uD800"), "EOSLOCK_PATH", true);
      expectCode("loneLow", join(r, "x\uDC00"), "EOSLOCK_PATH", true);
      expectCode("reversedPair", join(r, "x\uDC00\uD800"), "EOSLOCK_PATH", true);
      // Module bound (code without .syscall) vs OS rejection (.syscall set): platform limit.
      const LIMIT = PATH_LIMITS[process.platform];
      const pad = (n) => {
        const base = join(r, "a");
        return base + "a".repeat(n - base.length);
      };
      const moduleBound = (name, p) => {
        const err = codeOf(() => addon.open(p));
        assert.equal(err.code, "ENAMETOOLONG", name);
        assert.equal(err.syscall, undefined, `${name}: module bound, not OS`);
        out[name] = err.code;
      };
      const osReject = (name, p) => {
        const err = codeOf(() => addon.open(p));
        if (WIN) {
          assert.equal(err.syscall, "CreateFileW", name);
          assert.ok(WIN_LONG_PATH_CODES.includes(err.code), `${name}: got ${err.code}`);
        } else {
          assert.equal(err.code, "ENAMETOOLONG", name);
          assert.equal(err.syscall, "open", `${name}: OS rejection`);
        }
        out[name] = `${err.code}/${err.syscall}`;
      };
      moduleBound("utf16AtLimit", pad(LIMIT));
      moduleBound("utf16TooLong", pad(LIMIT + 76));
      osReject("belowLimitReachesOs", pad(LIMIT - 1));
      if (WIN) {
        out.utf8TooLong = "N/A (win32 converts paths as UTF-16 only)";
      } else {
        const comps = Math.ceil(LIMIT / 240) + 1;
        const multi = join(r, ...Array.from({ length: comps }, () => "한".repeat(80)));
        assert.ok(multi.length < LIMIT && Buffer.byteLength(multi) >= LIMIT);
        moduleBound("utf8TooLong", multi);
      }
      osReject("componentTooLong", join(r, "b".repeat(300)));
      assert.deepEqual(readdirSync(r), [], "no files created by rejected paths");
      const emoji = join(r, "\u{1F600}.lock");
      const h = addon.open(emoji);
      assert.ok(sameInode(h, emoji));
      addon.close(h);
      assert.deepEqual(readdirSync(r), ["\u{1F600}.lock"]);
      record("paths", out);
    });

    // P9 rejection: expected code, descriptor/handle released after the throw.
    const p9Reject = (name, p, codes, syscall) => {
      const fd0 = fdCount();
      const err = codeOf(() => addon.open(p));
      assert.ok(codes.includes(err.code), `${name}: got ${err.code}`);
      if (syscall !== undefined) assert.equal(err.syscall, syscall, `${name}: syscall`);
      assertReleased(p, fd0, name);
      record("P9", { [name]: { code: err.code, syscall: err.syscall, cleanupUncertain: err.cleanupUncertain ?? false } });
    };

    test("P9 directory rejected; descriptor/handle released", () => {
      const r = fakeRoot();
      mkdirSync(join(r, "dir"), { mode: 0o700 });
      // Windows: CreateFileW on a directory without FILE_FLAG_BACKUP_SEMANTICS is denied.
      if (WIN) p9Reject("directory", join(r, "dir"), [WIN_ACCESS_DENIED], "CreateFileW");
      else p9Reject("directory", join(r, "dir"), ["EISDIR", "EOSLOCK_TYPE"]);
      assert.deepEqual(readdirSync(join(r, "dir")), []);
    });

    test("P9 hardlink (both names) rejected EOSLOCK_LINKS; descriptor/handle released", () => {
      const r = fakeRoot();
      writeFileSync(join(r, "hl-a"), "", { mode: 0o600 });
      linkSync(join(r, "hl-a"), join(r, "hl-b"));
      p9Reject("hardlinkA", join(r, "hl-a"), ["EOSLOCK_LINKS"]);
      p9Reject("hardlinkB", join(r, "hl-b"), ["EOSLOCK_LINKS"]);
    });

    test("P9 symlink and dangling symlink not followed; target neither locked nor created", (t) => {
      const r = fakeRoot();
      const target = join(r, "target");
      writeFileSync(target, "", { mode: 0o600 });
      try {
        symlinkSync(target, join(r, "sym"), "file");
        symlinkSync(join(r, "absent"), join(r, "dangling"), "file");
      } catch (err) {
        if (WIN && (err.code === "EPERM" || err.code === "EACCES")) {
          record("P9", { symlink: `NOTMEASURED (symlink creation needs privilege on win32: ${err.code})` });
          t.skip(`NOTMEASURED: win32 symlink creation unprivileged failed (${err.code})`);
          return;
        }
        throw err;
      }
      // POSIX: O_NOFOLLOW -> ELOOP. Windows: FILE_FLAG_OPEN_REPARSE_POINT opens the link itself,
      // which is then rejected as a reparse point.
      const codes = WIN ? ["EOSLOCK_TYPE"] : ["ELOOP"];
      p9Reject("symlink", join(r, "sym"), codes);
      p9Reject("dangling", join(r, "dangling"), codes);
      assert.equal(lstatSync(join(r, "absent"), { throwIfNoEntry: false }), undefined, "dangling target not created");
      assert.equal(isLocked(target), false, "symlink target not locked");
    });

    if (WIN) {
      test("P9 win32 junction (unprivileged directory reparse point) as final component rejected", () => {
        const r = fakeRoot();
        mkdirSync(join(r, "jt"));
        symlinkSync(join(r, "jt"), join(r, "junction"), "junction");
        p9Reject("junction", join(r, "junction"), [WIN_ACCESS_DENIED, "EOSLOCK_TYPE"], undefined);
        assert.deepEqual(readdirSync(join(r, "jt")), []);
        record("P9", { junctionNote: "rejected; does not discriminate follow vs no-follow (target is a directory either way)" });
      });
    }

    test("P9 other-owner carrier", (t) => {
      record("P9", { otherOwner: "NOTMEASURED (needs another uid/owner; no privilege obtained)" });
      t.skip("NOTMEASURED: other-owner fixture needs privilege");
    });

    test("P9 FIFO carrier rejected without hanging (owned child, bounded)", { timeout: 20_000 }, async (t) => {
      const mkfifo = WIN ? undefined : ["/usr/bin/mkfifo", "/bin/mkfifo"].find((p) => existsSync(p));
      if (!mkfifo) {
        const why = WIN ? "no unprivileged FIFO inside the fake root on win32" : "mkfifo tool not found";
        record("P9-fifo", { result: `NOTMEASURED (${why})` });
        t.skip(`NOTMEASURED: ${why}`);
        return;
      }
      const r = fakeRoot();
      const fifo = join(r, "fifo");
      execFileSync(mkfifo, ["-m", "600", fifo]);
      const ch = spawnChild("fifo", { path: fifo }, { limitMs: 8000 });
      const m = await ch.waitFor((x) => x.type === "rejected" || x.type === "opened-unexpectedly" || x.type === "error");
      const ex = await ch.exited;
      assert.equal(m.type, "rejected", JSON.stringify(m));
      assert.equal(m.code, "EOSLOCK_TYPE");
      assert.ok(m.ms < 1000, `fifo open took ${m.ms}ms`);
      assert.equal(ex.code, 0);
      record("P9-fifo", { code: m.code, ms: m.ms });
    });

    // P10 POSIX: identity is checked after the lock (rename/unlink are possible while held).
    // Windows has its own block below (share mode pins the carrier while the handle is open).
    if (!WIN) {
    test("P10 carrier renamed-over once after lock: stale inode dropped, fn runs on the new inode", async () => {
      const r = fakeRoot();
      const c = join(r, "carrier");
      let n = 0;
      const { w, stats } = wrapAddon(addon, {
        afterLock() {
          if (n++ === 0) {
            writeFileSync(join(r, "repl"), "", { mode: 0o600 });
            renameSync(join(r, "repl"), c);
          }
        },
      });
      let ranOnFresh = null;
      const v = await withOsLock(c, () => {
        ranOnFresh = sameInode(stats.lastLocked, c);
        assert.equal(stats.live.size, 1);
        return "ok";
      }, { addon: w, timeoutMs: 2000 });
      assert.equal(v, "ok");
      assert.equal(ranOnFresh, true);
      assert.equal(stats.open, 2);
      assert.equal(stats.close, 2);
      assert.equal(stats.live.size, 0);
      assert.equal(isLocked(c), false);
      record("P10-once", { opens: stats.open, closes: stats.close });
    });

    test("P10 vanished carrier once after lock: recreated, fn runs on the live inode", async () => {
      const r = fakeRoot();
      const c = join(r, "carrier");
      let n = 0;
      const { w, stats } = wrapAddon(addon, {
        afterLock() {
          if (n++ === 0) unlinkSync(c);
        },
      });
      let fresh = null;
      await withOsLock(c, () => {
        fresh = sameInode(stats.lastLocked, c);
      }, { addon: w, timeoutMs: 2000 });
      assert.equal(fresh, true);
      assert.equal(stats.live.size, 0);
      assert.equal(stats.open, stats.close);
    });

    for (const mode of ["rename", "unlink"]) {
      test(`P10 repeated ${mode} on every lock: one absolute deadline, fn never runs, all handles closed`, async () => {
        const r = fakeRoot();
        const c = join(r, "carrier");
        let k = 0;
        const { w, stats } = wrapAddon(addon, {
          afterLock() {
            if (mode === "rename") {
              const t = join(r, `repl-${k++}`);
              writeFileSync(t, "", { mode: 0o600 });
              renameSync(t, c);
            } else {
              unlinkSync(c);
            }
          },
        });
        let ran = false;
        const t0 = performance.now();
        const err = await withOsLock(c, () => {
          ran = true;
        }, { addon: w, timeoutMs: 100 }).then(() => null, (e) => e);
        const ms = performance.now() - t0;
        assert.equal(err?.code, "EOSLOCK_TIMEOUT");
        assert.equal(ran, false);
        assert.ok(ms < 1100, `took ${ms}`);
        assert.equal(stats.live.size, 0);
        assert.equal(stats.open, stats.close);
        const calls = stats.calls;
        await sleep(200);
        assert.equal(stats.calls, calls, "no calls after reject");
        record(`P10-repeated-${mode}`, { ms: Math.round(ms), replacements: stats.tryLock, opens: stats.open });
      });
    }

    test("P10 carrier replaced by a symlink after lock: fails closed (no follow), fn never runs", async () => {
      const r = fakeRoot();
      const c = join(r, "carrier");
      writeFileSync(join(r, "elsewhere"), "", { mode: 0o600 });
      let n = 0;
      const { w, stats } = wrapAddon(addon, {
        afterLock() {
          if (n++ === 0) {
            symlinkSync(join(r, "elsewhere"), join(r, "sl"));
            renameSync(join(r, "sl"), c);
          }
        },
      });
      let ran = false;
      const err = await withOsLock(c, () => {
        ran = true;
      }, { addon: w, timeoutMs: 1000 }).then(() => null, (e) => e);
      assert.equal(err?.code, "ELOOP");
      assert.equal(ran, false);
      assert.equal(stats.live.size, 0);
      assert.equal(isLocked(join(r, "elsewhere")), false);
      record("P10-symlink", { code: err.code });
    });
    }

    if (WIN) {
      // Rename-over, unlink and rename-away attempted on EVERY successful lock.
      test("P10 win32 held carrier: rename-over/unlink/rename-away denied by share mode; fn on same file; allowed after close", async () => {
        const r = fakeRoot();
        const c = join(r, "carrier");
        const attempts = [];
        const { w, stats } = wrapAddon(addon, {
          afterLock() {
            const res = {};
            const t = join(r, `repl-${attempts.length}`);
            writeFileSync(t, "");
            for (const [op, fn] of [
              ["renameOver", () => renameSync(t, c)],
              ["unlink", () => unlinkSync(c)],
              ["renameAway", () => renameSync(c, join(r, "away"))],
            ]) {
              try {
                fn();
                res[op] = "ALLOWED";
              } catch (err) {
                res[op] = err.code;
              }
            }
            attempts.push(res);
          },
        });
        let same = null;
        const t0 = performance.now();
        const v = await withOsLock(c, () => {
          same = sameInode(stats.lastLocked, c);
          return "ok";
        }, { addon: w, timeoutMs: 2000 });
        const ms = performance.now() - t0;
        assert.equal(v, "ok");
        assert.equal(same, true, "fn ran on the locked file");
        assert.equal(stats.tryLock, 1, "no replacement loop on win32");
        for (const res of attempts) {
          for (const [op, code] of Object.entries(res)) assert.ok(WIN_SHARE_DENIAL.includes(code), `${op}: ${code}`);
        }
        assert.equal(stats.live.size, 0);
        assert.equal(stats.open, stats.close);
        // After close the same operations succeed.
        renameSync(join(r, "repl-0"), c);
        unlinkSync(c);
        assert.equal(lstatSync(c, { throwIfNoEntry: false }), undefined);
        record("P10-win32", { attempts, ms: Math.round(ms) });
      });

      test("P10 win32 symlink renamed over held carrier", async (t) => {
        const r = fakeRoot();
        const c = join(r, "carrier");
        writeFileSync(join(r, "elsewhere"), "");
        try {
          symlinkSync(join(r, "elsewhere"), join(r, "sl"), "file");
        } catch (err) {
          if (err.code === "EPERM" || err.code === "EACCES") {
            record("P10-symlink", { result: `NOTMEASURED (win32 symlink creation needs privilege: ${err.code})` });
            t.skip(`NOTMEASURED: win32 symlink creation unprivileged failed (${err.code})`);
            return;
          }
          throw err;
        }
        let denied = null;
        const { w, stats } = wrapAddon(addon, {
          afterLock() {
            try {
              renameSync(join(r, "sl"), c);
              denied = "ALLOWED";
            } catch (err) {
              denied = err.code;
            }
          },
        });
        let same = null;
        await withOsLock(c, () => {
          same = sameInode(stats.lastLocked, c);
        }, { addon: w, timeoutMs: 1000 });
        assert.ok(WIN_SHARE_DENIAL.includes(denied), `rename symlink over held carrier: ${denied}`);
        assert.equal(same, true);
        assert.equal(isLocked(join(r, "elsewhere")), false);
        record("P10-symlink", { win32Denied: denied });
      });
    }

    test("P5 live holder in another process, timeoutMs=100: bounded reject, no calls after", { timeout: 60_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const holder = spawnChild("hold", { carrier: c }, { limitMs: 40_000 });
      await holder.waitFor((m) => m.type === "locked");
      const runs = [];
      for (let i = 0; i < 10; i++) {
        const { w, stats } = wrapAddon(addon);
        let ran = false;
        const t0 = performance.now();
        const err = await withOsLock(c, () => {
          ran = true;
        }, { addon: w, timeoutMs: 100 }).then(() => null, (e) => e);
        const ms = performance.now() - t0;
        assert.equal(err?.code, "EOSLOCK_TIMEOUT");
        assert.equal(ran, false);
        assert.ok(ms >= 99 && ms < 1100, `elapsed ${ms}`);
        assert.equal(stats.live.size, 0);
        const calls = stats.calls;
        await sleep(150);
        assert.equal(stats.calls, calls, "no calls after reject");
        runs.push({ ms: Math.round(ms * 10) / 10, tryLocks: stats.tryLock });
      }
      holder.child.stdin.end();
      await holder.waitFor((m) => m.type === "released");
      assert.equal((await holder.exited).code, 0);
      record("P5", { runs, maxMs: Math.max(...runs.map((x) => x.ms)) });
    });

    test("timeoutMs=0 still attempts once; free carrier succeeds, held carrier rejects", async () => {
      const c = join(fakeRoot(), "carrier");
      assert.equal(await withOsLock(c, () => 7, { timeoutMs: 0 }), 7);
      const h = addon.open(c);
      addon.tryLock(h);
      const { w, stats } = wrapAddon(addon);
      const err = await withOsLock(c, () => 1, { addon: w, timeoutMs: 0 }).then(() => null, (e) => e);
      assert.equal(err?.code, "EOSLOCK_TIMEOUT");
      assert.equal(stats.tryLock, 1);
      addon.close(h);
    });

    test("harness argument validation happens before any lock or callback", async () => {
      const { w, stats } = wrapAddon(addon);
      const c = join(fakeRoot(), "carrier");
      let ran = 0;
      const cb = () => {
        ran++;
      };
      const cases = [
        ["relative", "rel/carrier", cb, {}, TypeError],
        ["nonString", 5, cb, {}, TypeError],
        ["noFn", c, null, {}, TypeError],
        ["negative", c, cb, { timeoutMs: -1 }, RangeError],
        ["nan", c, cb, { timeoutMs: NaN }, RangeError],
        ["infinity", c, cb, { timeoutMs: Infinity }, RangeError],
        ["string", c, cb, { timeoutMs: "100" }, RangeError],
      ];
      for (const [name, carrier, fn, opts, Type] of cases) {
        await assert.rejects(withOsLock(carrier, fn, { ...opts, addon: w }), Type, name);
      }
      assert.equal(ran, 0);
      assert.equal(stats.calls, 0);
      assert.equal(lstatSync(c, { throwIfNoEntry: false }), undefined);
    });

    describe("P12 callback versus cleanup error priority (harness seam)", () => {
      const injected = () => Object.assign(new Error("injected close failure"), { code: "EINJECT_CLOSE" });
      const setup = (inject) => {
        const c = join(fakeRoot(), "carrier");
        const { w, stats } = wrapAddon(addon, inject ? {
          afterClose() {
            throw injected();
          },
        } : {});
        return { c, w, stats };
      };
      const released = (c, stats) => {
        assert.equal(stats.live.size, 0);
        assert.equal(isLocked(c), false);
      };

      test("fn throws + close throws: fn error wins, close error attached, descriptor closed", async () => {
        const { c, w, stats } = setup(true);
        const fd0 = fdCount();
        const e1 = new Error("callback failure");
        const err = await withOsLock(c, () => {
          throw e1;
        }, { addon: w }).then(() => null, (e) => e);
        assert.equal(err, e1);
        assert.equal(err.oslockCleanupError?.code, "EINJECT_CLOSE");
        assert.equal(Object.keys(err).includes("oslockCleanupError"), false, "non-enumerable");
        released(c, stats);
        assertReleased(c, fd0, "P12");
      });

      test("fn succeeds + close throws: close error surfaces (no fake success)", async () => {
        const { c, w, stats } = setup(true);
        const err = await withOsLock(c, () => "value", { addon: w }).then(() => null, (e) => e);
        assert.equal(err?.code, "EINJECT_CLOSE");
        released(c, stats);
      });

      for (const [kind, thrown] of [["primitive", "boom"], ["frozen", Object.freeze(new Error("frozen"))]]) {
        test(`fn throws ${kind} + close throws: fn value wins, cleanup kept as EOSLOCK_CLEANUP warning`, async () => {
          const { c, w, stats } = setup(true);
          const warnings = [];
          const onWarn = (wn) => warnings.push(wn);
          process.on("warning", onWarn);
          try {
            const err = await withOsLock(c, () => {
              throw thrown;
            }, { addon: w }).then(() => null, (e) => e);
            assert.equal(err, thrown);
            await tick();
            await sleep(10);
            assert.ok(warnings.some((x) => x.code === "EOSLOCK_CLEANUP"), "cleanup warning emitted");
          } finally {
            process.off("warning", onWarn);
          }
          released(c, stats);
        });
      }

      test("fn throws, close fine: fn error, lock released; fn returns: value, released", async () => {
        const { c, w, stats } = setup(false);
        const e1 = new Error("cb");
        assert.equal(await withOsLock(c, () => {
          throw e1;
        }, { addon: w }).then(() => null, (e) => e), e1);
        assert.equal(e1.oslockCleanupError, undefined);
        released(c, stats);
        assert.equal(await withOsLock(c, async () => 42, { addon: w }), 42);
        released(c, stats);
      });

      test("acquire-phase error after lock + close throws: acquire error wins, handle closed, fn never runs", async () => {
        const c = join(fakeRoot(), "carrier");
        const e3 = Object.assign(new Error("post-lock failure"), { code: "EINJECT_LOCK" });
        const { w, stats } = wrapAddon(addon, {
          afterLock() {
            throw e3;
          },
          afterClose() {
            throw injected();
          },
        });
        let ran = false;
        const err = await withOsLock(c, () => {
          ran = true;
        }, { addon: w }).then(() => null, (e) => e);
        assert.equal(err, e3);
        assert.equal(err.oslockCleanupError?.code, "EINJECT_CLOSE");
        assert.equal(ran, false);
        released(c, stats);
      });
    });

    // POSIX: SIGKILL, signal asserted, release ≤100 ms after reap. Windows: child.kill() is
    // TerminateProcess; no POSIX signal reporting asserted; OS unlock delay is unspecified, so
    // it is measured (bounded at 5000 ms) and reported, never hidden.
    test("P4 holder SIGKILL mid-hold: next acquirer succeeds; release delay after reap measured", { timeout: 240_000 }, async () => {
      const reps = 20;
      const delays = [];
      const bound = WIN ? 5000 : 2000;
      for (let i = 0; i < reps; i++) {
        const c = join(fakeRoot(), "carrier");
        const holder = spawnChild("hold", { carrier: c }, { limitMs: 20_000 });
        await holder.waitFor((m) => m.type === "locked");
        assert.equal(isLocked(c), true);
        const tKill = performance.now();
        holder.child.kill("SIGKILL");
        const ex = await holder.exited;
        if (!WIN) assert.equal(ex.signal, "SIGKILL");
        assert.equal(holder.lines.some((m) => m.type === "released"), false, "holder did not release by itself");
        const afterReap = acquireDelay(c, bound);
        assert.notEqual(afterReap, null, `acquired within ${bound}ms of reap`);
        delays.push({ afterReapMs: Math.round(afterReap * 1000) / 1000, killToReapMs: Math.round(ex.t - tKill), code: ex.code, signal: ex.signal });
      }
      const max = Math.max(...delays.map((d) => d.afterReapMs));
      record("P4", { reps, maxAfterReapMs: max, boundMs: bound, delays });
      if (!WIN) assert.ok(max <= 100, `max release delay after reap ${max}ms`);
    });

    test("env termination: child exits while LOCKED without close; lock released", { timeout: 20_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const ch = spawnChild("exit-locked", { carrier: c }, { limitMs: 10_000 });
      await ch.waitFor((m) => m.type === "locked");
      const ex = await ch.exited;
      assert.equal(ex.code, 0);
      const d = acquireDelay(c, 2000);
      assert.notEqual(d, null);
      record("exit-locked", { afterExitMs: d });
    });

    for (const closeFirst of [true, false]) {
      test(`P6 no inheritance: grandchild spawned during hold, parent ${closeFirst ? "closes and" : "exits without close and"} exits`, { timeout: 30_000 }, async () => {
        const c = join(fakeRoot(), "carrier");
        const { a, g } = await spawnHoldSpawn(c, closeFirst);
        let acquiredMs;
        let renameWhileAlive;
        let exitBeforeChecks;
        try {
          await waitChannel(g, (m) => m.type === "ready", 10_000, "ready");
          const ex = await a.exited;
          assert.equal(ex.code, 0);
          // The exact nonce-bound grandchild is alive after the parent was reaped...
          await beatAfter(g);
          acquiredMs = acquireDelay(c, 1000);
          // Windows: an inherited handle (no FILE_SHARE_DELETE) would deny this rename while the
          // grandchild runs, so this is the discriminating check there. POSIX: always "ok".
          renameWhileAlive = renameProbe(c);
          // ...and still alive after both checks.
          await beatAfter(g);
          exitBeforeChecks = channelLines(g).some((m) => m.type === "exit");
        } finally {
          // Cleanup first (also on failure), then assert.
          await stopGrandchild(g);
          record(`P6-${closeFirst ? "close" : "noclose"}`, { acquiredMs, renameWhileAlive, grandchildPid: g.pid, cleanup: g.cleanup });
        }
        assert.equal(exitBeforeChecks, false, "grandchild still running");
        assert.notEqual(acquiredMs, null, "another process acquired while the grandchild still ran");
        assert.equal(renameWhileAlive, "ok", "no handle inherited by the grandchild");
        assert.equal(g.cleanup.exitLine, true, "grandchild exited on stop");
        assert.equal(g.cleanup.gone, true, "grandchild pid gone after stop");
      });
    }

    test("P6 negative controls: missing readiness, ignored stop and a grandchild-held lock are each detected", { timeout: 60_000 }, async () => {
      const out = {};
      {
        // Alive but never ready: the readiness wait must fail, not a dead fixture.
        const { a, g } = await spawnHoldSpawn(join(fakeRoot(), "carrier"), true, "no-ready");
        let readyErr;
        try {
          readyErr = await waitChannel(g, (m) => m.type === "ready", 1000, "ready").then(() => null, (e) => e);
          await a.exited;
          await beatAfter(g, 5000);
        } finally {
          await stopGrandchild(g);
        }
        assert.match(String(readyErr?.message), /no ready within 1000ms/, "missing readiness detected");
        assert.equal(g.cleanup.exitLine, true);
        assert.equal(g.cleanup.gone, true);
        out.noReady = { readyErr: readyErr.message, cleanup: g.cleanup };
      }
      {
        // Stop ignored: no exit line is detected; cleanup only via the separate teardown request.
        const { a, g } = await spawnHoldSpawn(join(fakeRoot(), "carrier"), true, "ignore-stop");
        try {
          await waitChannel(g, (m) => m.type === "ready", 10_000, "ready");
          await a.exited;
        } finally {
          await stopGrandchild(g);
        }
        assert.equal(g.cleanup.exitLine, false, "ignored stop detected");
        assert.equal(g.cleanup.teardownExit, true, "cooperative teardown (cleanup only) confirmed");
        assert.equal(g.cleanup.gone, true);
        assert.equal(g.done, true);
        out.ignoreStop = { cleanup: g.cleanup };
      }
      {
        // Grandchild holds its own lock on the carrier: both post-exit checks must see it.
        const c = join(fakeRoot(), "carrier");
        const { a, g } = await spawnHoldSpawn(c, true, "lock");
        let acquiredMs;
        let renameWhileAlive;
        try {
          await waitChannel(g, (m) => m.type === "ready", 10_000, "ready");
          await a.exited;
          await beatAfter(g);
          acquiredMs = acquireDelay(c, 1000);
          renameWhileAlive = renameProbe(c);
          await beatAfter(g);
        } finally {
          await stopGrandchild(g);
        }
        assert.equal(acquiredMs, null, "grandchild-held lock detected");
        if (WIN) assert.ok(WIN_SHARE_DENIAL.includes(renameWhileAlive), `grandchild-held handle denies rename: ${renameWhileAlive}`);
        else assert.equal(renameWhileAlive, "ok"); // POSIX rename is not a handle detector
        assert.equal(g.cleanup.exitLine, true);
        assert.equal(g.cleanup.gone, true);
        assert.equal(acquireDelay(c, 1000) !== null, true, "released after the grandchild closed");
        out.lock = { acquiredMs, renameWhileAlive, cleanup: g.cleanup };
      }
      record("P6-controls", out);
    });

    test("P8 handle dropped while LOCKED + global.gc: lock released by finalizer", { timeout: 20_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      (() => {
        const h = addon.open(c);
        assert.equal(addon.tryLock(h), true);
      })();
      const probe = addon.open(c);
      let rounds = 0;
      while (!addon.tryLock(probe)) {
        assert.ok(rounds++ < 50, "lock not released after 50 gc rounds");
        globalThis.gc();
        await tick();
        await sleep(1);
      }
      addon.close(probe);
      record("P8-gc", { gcRounds: rounds });
    });

    test("P8 GC: 500 dropped OPEN handles return descriptors; 2000 closed handles finalize without crash", { timeout: 60_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const fd0 = fdCount();
      (() => {
        for (let i = 0; i < 500; i++) addon.open(c);
      })();
      // Windows: handles open -> rename denied; all finalized -> rename allowed.
      const released0 = () => (WIN ? renameProbe(c) === "ok" : fdCount() === fd0);
      const mid = WIN ? renameProbe(c) : fdCount();
      if (WIN) assert.ok(WIN_SHARE_DENIAL.includes(mid), `open handles deny rename: ${mid}`);
      else assert.equal(mid, fd0 + 500);
      let rounds = 0;
      while (!released0()) {
        assert.ok(rounds++ < 50, `descriptors/handles not returned after 50 gc rounds (fd ${fdCount()} vs ${fd0})`);
        globalThis.gc();
        await tick();
        await sleep(1);
      }
      for (let i = 0; i < 2000; i++) addon.close(addon.open(c));
      for (let i = 0; i < 5; i++) {
        globalThis.gc();
        await tick();
      }
      assertReleased(c, fd0, "P8-gc-bulk");
      record("P8-gc-bulk", { mid, fd0, gcRounds: rounds });
    });

    test("P8 worker.terminate() while LOCKED (plus extra open handles): lock and descriptors released", { timeout: 20_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const fd0 = fdCount();
      const wk = startWorker({ role: "hold", carrier: c, extraOpen: 3 });
      await wk.waitFor((m) => m.type === "locked");
      assert.equal(isLocked(c), true);
      await wk.w.terminate();
      const d = acquireDelay(c, 1000);
      assert.notEqual(d, null, "released after terminate");
      assertReleased(c, fd0, "worker handles closed by env cleanup");
      record("P8-terminate", { afterTerminateMs: d });
    });

    test("env teardown: worker exits naturally while LOCKED (handle reachable); explicit close in worker", { timeout: 20_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      const a = startWorker({ role: "hold-exit", carrier: c });
      await a.waitFor((m) => m.type === "locked");
      assert.equal((await a.exited).code, 0);
      assert.notEqual(acquireDelay(c, 1000), null);
      const b = startWorker({ role: "hold", carrier: c });
      await b.waitFor((m) => m.type === "locked");
      b.w.postMessage("close");
      await b.waitFor((m) => m.type === "released");
      assert.equal(isLocked(c), false);
      await b.w.terminate();
    });

    test("registry lifetime: 100 worker lock/terminate cycles + gc, no crash or descriptor leak", { timeout: 120_000 }, async () => {
      const c = join(fakeRoot(), "carrier");
      globalThis.gc();
      const fd0 = fdCount();
      const rss0 = process.memoryUsage().rss;
      const cycles = 100;
      for (let i = 0; i < cycles; i++) {
        const wk = startWorker({ role: "hold", carrier: c, extraOpen: 2 });
        await wk.waitFor((m) => m.type === "locked");
        if (i % 2 === 0) await wk.w.terminate();
        else {
          wk.w.postMessage("close");
          await wk.waitFor((m) => m.type === "released");
          await wk.exited;
        }
        assert.equal(isLocked(c), false, `cycle ${i}`);
      }
      for (let i = 0; i < 5; i++) {
        globalThis.gc();
        await tick();
      }
      assertReleased(c, fd0, "registry-cycles");
      record("registry-cycles", { cycles, rssDeltaMiB: Math.round((process.memoryUsage().rss - rss0) / 1048576) });
    });
  });

  describe("P11 fail-closed loader", () => {
    const reason = (opts) => {
      const err = codeOf(() => loadOsLock(opts));
      assert.equal(err.code, "EOSLOCK_UNAVAILABLE");
      assert.match(err.message, /^oslock: native unavailable \(/);
      return err.reason;
    };

    test("missing / relative / malformed hash / tampered copy / symlink / directory / non-binary", () => {
      const r = fakeRoot();
      const out = {};
      out.missing = reason({ path: join(r, "nope.node"), sha256: ADDON_SHA });
      assert.equal(out.missing, "missing file");
      out.relative = reason({ path: "build/oslock.node", sha256: ADDON_SHA });
      assert.equal(out.relative, "addon path must be absolute");
      out.badSha = reason({ path: ADDON, sha256: "xyz" });
      assert.equal(out.badSha, "expected sha256 missing or malformed");
      const tampered = join(r, "tampered.node");
      copyFileSync(ADDON, tampered);
      chmodSync(tampered, 0o600); // private copy keeps the product 0444 mode otherwise
      const bytes = readFileSync(tampered);
      bytes[bytes.length >> 1] ^= 0x01;
      writeFileSync(tampered, bytes);
      out.tampered = reason({ path: tampered, sha256: ADDON_SHA });
      assert.equal(out.tampered, "hash mismatch");
      try {
        symlinkSync(ADDON, join(r, "link.node"), "file");
        out.symlink = reason({ path: join(r, "link.node"), sha256: ADDON_SHA });
        assert.equal(out.symlink, "not a regular file");
      } catch (err) {
        if (!(WIN && (err.code === "EPERM" || err.code === "EACCES"))) throw err;
        out.symlink = `NOTMEASURED (win32 symlink creation needs privilege: ${err.code})`;
      }
      mkdirSync(join(r, "dir.node"));
      out.directory = reason({ path: join(r, "dir.node"), sha256: ADDON_SHA });
      assert.equal(out.directory, "not a regular file");
      const text = join(r, "text.node");
      writeFileSync(text, "not a mach-o image\n");
      out.nonBinaryMatchingHash = reason({ path: text, sha256: sha256File(text) });
      assert.equal(out.nonBinaryMatchingHash, "dlopen failed");
      assert.equal(sha256File(ADDON), ADDON_SHA, "product binary untouched");
      record("P11", {
        ...out,
        wrongPlatformBinary: "NOTMEASURED (no foreign-platform binary supplied)",
        abiMismatchStub: "NOTMEASURED (no stub binary supplied; no compiler grant)",
      });
    });

    test("harness fails closed before the callback when env load fails (owned children)", { timeout: 30_000 }, async () => {
      const r = fakeRoot();
      const tampered = join(r, "tampered.node");
      copyFileSync(ADDON, tampered);
      chmodSync(tampered, 0o600);
      const bytes = readFileSync(tampered);
      bytes[100] ^= 0xff;
      writeFileSync(tampered, bytes);
      const out = {};
      for (const [name, envPatch] of [
        ["missingEnv", { OSLOCK_NODE: undefined }],
        ["missingFile", { OSLOCK_NODE: join(r, "nope.node") }],
        ["badSha", { OSLOCK_SHA256: "0".repeat(64) }],
        ["tampered", { OSLOCK_NODE: tampered }],
      ]) {
        const env = { ...process.env, ...envPatch };
        for (const [k, v] of Object.entries(envPatch)) if (v === undefined) delete env[k];
        const ch = spawnChild("harness-load", { carrier: join(r, `carrier-${name}`) }, { limitMs: 10_000, env });
        const m = await ch.waitFor((x) => x.type === "harness-load" || x.type === "error");
        assert.equal((await ch.exited).code, 0);
        assert.equal(m.ok, false, name);
        assert.equal(m.ran, false, name);
        assert.equal(m.code, "EOSLOCK_UNAVAILABLE", name);
        assert.equal(lstatSync(join(r, `carrier-${name}`), { throwIfNoEntry: false }), undefined);
        out[name] = m.reason;
      }
      record("P11-harness", out);
    });

    test("double load (same path and pristine copy) fails explicitly or reuses safely; foreign-env handles rejected", { timeout: 30_000 }, async () => {
      const r = fakeRoot();
      const copy = join(r, "copy.node");
      copyFileSync(ADDON, copy);
      assert.equal(sha256File(copy), ADDON_SHA);
      const out = {};
      for (const [name, pathB] of [["samePath", ADDON], ["copyPath", copy]]) {
        const ch = spawnChild("doubleload", { pathA: ADDON, pathB, sha256: ADDON_SHA, carrier: join(r, `c-${name}`) }, { limitMs: 10_000 });
        const m = await ch.waitFor((x) => x.type === "doubleload" || x.type === "error");
        const ex = await ch.exited;
        assert.equal(ex.code, 0, `${name}: exit ${ex.code}/${ex.signal} stderr=${ch.stderr()}`);
        assert.equal(m.type, "doubleload", JSON.stringify(m));
        if (m.second.ok) {
          for (const v of Object.values(m.cross)) assert.equal(v, "EOSLOCK_HANDLE", `${name} cross-env`);
          assert.equal(m.aLocks, true);
          assert.equal(m.bConflicts, true);
          assert.equal(m.bAfter, true);
        } else {
          assert.equal(m.second.code, "EOSLOCK_UNAVAILABLE");
        }
        out[name] = m;
      }
      record("doubleload", out);
    });
  });
}

async function stressRound(kind, count, n, r, extra = {}) {
  const carrier = join(r, "carrier");
  const counter = join(r, "counter");
  const marker = join(r, "inside");
  writeFileSync(counter, "0");
  const args = { carrier, counter, marker, n, timeoutMs: 120_000, ...extra };
  const t0 = performance.now();
  let done;
  if (kind === "process") {
    const kids = Array.from({ length: count }, () => spawnChild("increment", args, { limitMs: 300_000 }));
    done = await Promise.all(kids.map(async (k) => {
      const m = await k.waitFor((x) => x.type === "done" || x.type === "error", 300_000);
      const ex = await k.exited;
      assert.equal(m.type, "done", JSON.stringify(m));
      assert.equal(ex.code, 0);
      return m;
    }));
  } else {
    const ws = Array.from({ length: count }, () => startWorker({ role: "increment", ...args }, 300_000));
    done = await Promise.all(ws.map(async (k) => {
      const m = await k.waitFor((x) => x.type === "done" || x.type === "error", 300_000);
      assert.equal(m.type, "done", JSON.stringify(m));
      assert.equal((await k.exited).code, 0);
      return m;
    }));
  }
  const ms = performance.now() - t0;
  const final = Number(readFileSync(counter, "utf8"));
  const violations = done.reduce((s, m) => s + m.violations, 0);
  const ioConflicts = done.reduce((s, m) => s + (m.ioConflicts ?? 0), 0);
  return { final, violations, ioConflicts, ms: Math.round(ms), markerLeft: lstatSync(marker, { throwIfNoEntry: false }) !== undefined };
}

if (STRESS) {
  describe("stress", () => {
    // Fixed SPEC targets; not configurable so they cannot be reduced or disabled.
    const p1Reps = 20;
    const p2Reps = 20;
    test("negative control: same 8x200 workload without the lock is detected (lost updates, overlaps or IO conflicts)", { timeout: 600_000 }, async () => {
      const res = await stressRound("process", 8, 200, fakeRoot(), { noLock: true });
      record("P1-negative-control", res);
      assert.ok(res.final !== 1600 || res.violations > 0 || res.ioConflicts > 0, `detector did not fire: ${JSON.stringify(res)}`);
    });
    test(`P1 8 processes x 200 increments x ${p1Reps}`, { timeout: 3_600_000 }, async () => {
      const rounds = [];
      try {
        for (let i = 0; i < p1Reps; i++) {
          const res = await stressRound("process", 8, 200, fakeRoot());
          rounds.push(res);
          assert.equal(res.final, 1600, `rep ${i}`);
          assert.equal(res.violations, 0, `rep ${i}`);
          assert.equal(res.markerLeft, false, `rep ${i}`);
        }
      } finally {
        record("P1", { repsRequested: p1Reps, repsCompleted: rounds.length, rounds });
      }
    });
    test(`P2 4 worker_threads x 200 increments x ${p2Reps}`, { timeout: 3_600_000 }, async () => {
      const rounds = [];
      try {
        for (let i = 0; i < p2Reps; i++) {
          const res = await stressRound("worker", 4, 200, fakeRoot());
          rounds.push(res);
          assert.equal(res.final, 800, `rep ${i}`);
          assert.equal(res.violations, 0, `rep ${i}`);
          assert.equal(res.markerLeft, false, `rep ${i}`);
        }
      } finally {
        record("P2", { repsRequested: p2Reps, repsCompleted: rounds.length, rounds });
      }
    });
  });
}
