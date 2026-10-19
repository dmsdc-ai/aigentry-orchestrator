import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(packageRoot, "bin/init/cli.mjs");
const limit = 64 * 1024;
// Discovery only: neither program is an installed dependency or may be executed.
const tripwireSource = '#!/bin/sh\nprintf "%s\\n" "$0" >> "$AIGENTRY_PREWRITE_TRIPWIRE_LOG"\nexit 97\n';
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function privateParent(parent) {
  assert.ok(typeof parent === "string" && path.isAbsolute(parent), "explicit fixture root required");
  assert.equal(path.normalize(parent), parent, "fixture root must be canonical");
  assert.ok(!/[\x00-\x1f\x7f]/.test(parent), "fixture root contains control characters");
  let current = path.parse(parent).root;
  for (const part of ["", ...parent.slice(current.length).split(path.sep)]) {
    current = path.join(current, part);
    const s = stat(current);
    assert.ok(s?.isDirectory() && !s.isSymbolicLink(), `unsafe ancestor: ${current}`);
    assert.ok(s.uid === 0n || s.uid === BigInt(process.getuid()), `foreign ancestor: ${current}`);
    assert.equal(Number(s.mode) & 0o022, 0, `writable ancestor: ${current}`);
    assert.equal(stat(path.join(current, ".git")), null, `Git ancestry: ${current}`);
  }
  assert.equal(fs.realpathSync.native(parent), parent);
  const s = stat(parent);
  assert.equal(s.uid, BigInt(process.getuid()));
  assert.equal(Number(s.mode) & 0o777, 0o700, "fixture parent must already be private");
  return parent;
}

function inventory(roots) {
  const result = {};
  function visit(file, key) {
    const s = stat(file);
    if (!s) { result[key] = null; return; }
    const entry = {};
    for (const field of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
      entry[field] = String(s[field]);
    entry.kind = s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other";
    result[key] = entry;
    if (s.isSymbolicLink()) entry.link = fs.readlinkSync(file);
    else if (s.isFile()) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        assert.equal(opened.dev, s.dev);
        assert.equal(opened.ino, s.ino);
        const bytes = fs.readFileSync(fd);
        entry.sha256 = hash(bytes);
        entry.base64 = bytes.toString("base64");
      } finally { fs.closeSync(fd); }
    } else if (s.isDirectory()) {
      entry.children = fs.readdirSync(file).sort();
      for (const name of entry.children) visit(path.join(file, name), `${key}/${name}`);
    }
  }
  for (const [name, root] of Object.entries(roots)) visit(root, name);
  return result;
}

function runtimeInventory() {
  const files = [process.execPath, "/bin/sh", fileURLToPath(import.meta.url),
    ...["package.json", "bin/init/cli.mjs", "bin/init/manifest.mjs", "bin/init/native-capture.mjs",
      "bin/init/preservation.mjs", "dist/src/session/model-decision.js",
      ...["bootstrap", "awareness", "resolve", "contract", "descriptors", "executable-version",
        "storage", "native-boot", "invocation"].map(name => `dist/src/environment/${name}.js`)]
      .map(name => path.join(packageRoot, name))];
  return Object.fromEntries(files.map(file => {
    const s = stat(file);
    if (!s) return [file, null];
    const entry = {};
    for (const field of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
      entry[field] = String(s[field]);
    if (s.isSymbolicLink()) entry.link = fs.readlinkSync(file);
    else if (s.isFile()) entry.sha256 = hash(fs.readFileSync(file));
    return [file, entry];
  }));
}

// Close/EOF evidence concerns the direct child, not exhaustive descendant supervision.
function invoke(args, env, cwd, evidence, signal) {
  return new Promise(resolve => {
    const result = { status: null, signal: null, close: false, stdoutEOF: false, stderrEOF: false,
      timeout: false, overflow: [], errors: [], bytes: { stdout: 0, stderr: 0 } };
    const chunks = { stdout: [], stderr: [] };
    let child;
    let timer;
    let settled = false;
    const stop = () => { if (child) child.kill("SIGKILL"); };
    const abort = () => { result.errors.push("test aborted"); stop(); finish(); };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const stdout = Buffer.concat(chunks.stdout), stderr = Buffer.concat(chunks.stderr);
      fs.writeFileSync(path.join(evidence, "stdout.bin"), stdout);
      fs.writeFileSync(path.join(evidence, "stderr.bin"), stderr);
      fs.writeFileSync(path.join(evidence, "status.json"), json(result));
      resolve({ ...result, stdout, stderr });
    };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { result.timeout = true; stop(); finish(); }, 20_000);
    try {
      child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      for (const name of ["stdout", "stderr"]) {
        child[name].on("data", chunk => {
          if (settled) return;
          const remaining = limit - result.bytes[name];
          result.bytes[name] += chunk.length;
          if (remaining > 0) chunks[name].push(chunk.subarray(0, remaining));
          if (result.bytes[name] > limit) { result.overflow.push(name); stop(); finish(); }
        });
        child[name].once("end", () => { result[`${name}EOF`] = true; });
        child[name].once("error", error => { result.errors.push(`${name}: ${error.message}`); stop(); finish(); });
      }
      child.once("error", error => { result.errors.push(error.message); stop(); finish(); });
      child.once("close", (code, signal) => {
        result.status = code;
        result.signal = signal;
        result.close = true;
        finish();
      });
    } catch (error) { result.errors.push(error.message); stop(); finish(); }
  });
}

test("ordinary first-parent obstruction leaves no pending operation", { timeout: 60_000 }, async t => {
  assert.ok(["linux", "darwin"].includes(process.platform), "this regression requires Linux or macOS");
  const parent = privateParent(process.env.AIGENTRY_PREWRITE_FIXTURE_ROOT);
  // Read the actual literal list without evaluating, slicing or replacing product code.
  const manifest = fs.readFileSync(path.join(packageRoot, "bin/init/manifest.mjs"), "utf8");
  const first = manifest.match(/const MANIFEST = \[\s*(?:\/\/[^\n]*\n\s*)*"([^"]+)"/);
  assert.equal(first?.[1], "bin/ask.sh", "first manifest destination changed; reassess this fixture");
  const caseRoot = fs.mkdtempSync(path.join(parent, "legacy-prewrite-"));
  assert.equal(Number(stat(caseRoot).mode) & 0o777, 0o700);
  const make = name => {
    const dir = path.join(caseRoot, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    return dir;
  };
  const evidence = make("evidence"), workspace = make("workspace"), home = make("home");
  const aigentry = make("aigentry"), tools = make("tools");
  const config = make("config"), cache = make("cache"), data = make("data"), tmp = make("tmp");
  const tripwireLog = path.join(evidence, "tripwire-invocations.log");
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data, TMPDIR: tmp, AIGENTRY_HOME: aigentry, PATH: tools, LANG: "C", LC_ALL: "C",
    AIGENTRY_PREWRITE_TRIPWIRE_LOG: tripwireLog };
  const emissions = [];
  for (const name of ["jq", "python3"]) {
    const file = path.join(tools, name);
    fs.writeFileSync(file, tripwireSource, { flag: "wx", mode: 0o700 });
    emissions.push({ file, source: tripwireSource, sha256: hash(tripwireSource), purpose: "discovery-only tripwire" });
  }
  fs.writeFileSync(path.join(evidence, "emissions.json"), json(emissions));
  // Synthetic upgrade routing data; this does not establish an installed baseline.
  fs.writeFileSync(path.join(workspace, ".aigentry-init.json"), "{}\n", { flag: "wx", mode: 0o600 });
  const nonce = randomUUID();
  fs.writeFileSync(path.join(workspace, "bin"), `${nonce}\n`, { flag: "wx", mode: 0o600 });
  const args = [cli, "init", "--yes", "--upgrade", "--workspace", workspace];
  fs.writeFileSync(path.join(evidence, "invocation.json"), json({ executable: process.execPath, args, env,
    cwd: workspace, nonce, platform: process.platform, node: process.version }));
  const roots = { workspace, home, aigentry, config, cache, data, tmp, tools };
  const before = inventory(roots);
  fs.writeFileSync(path.join(evidence, "before.json"), json(before));
  const runtimeBefore = runtimeInventory();
  fs.writeFileSync(path.join(evidence, "runtime-before.json"), json(runtimeBefore));
  const result = await invoke(args, env, workspace, evidence, t.signal);
  const after = inventory(roots);
  fs.writeFileSync(path.join(evidence, "after.json"), json(after));
  const runtimeAfter = runtimeInventory();
  fs.writeFileSync(path.join(evidence, "runtime-after.json"), json(runtimeAfter));
  const lockKey = "workspace/.aigentry-native-capture.lock";
  const ownerImage = after[`${lockKey}/owner.json`];
  let owner = null;
  if (ownerImage?.kind === "file") {
    try { owner = JSON.parse(Buffer.from(ownerImage.base64, "base64").toString("utf8")); }
    catch { owner = { invalid: true }; }
  }
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const receipt = { evidence, status: result.status, signal: result.signal, close: result.close,
    stdoutEOF: result.stdoutEOF, stderrEOF: result.stderrEOF, timeout: result.timeout,
    overflow: result.overflow, errors: result.errors, bytes: result.bytes, owner,
    changed, tripwireInvoked: stat(tripwireLog) !== null };
  fs.writeFileSync(path.join(evidence, "receipt.json"), json(receipt));
  // Keep raw bounded streams and every failed fixture/lock; never clean up to pass.
  console.log(JSON.stringify(receipt).slice(0, 8192));
  console.log(`CLI stdout tail: ${JSON.stringify(result.stdout.subarray(-4096).toString("utf8"))}`);
  console.log(`CLI stderr tail: ${JSON.stringify(result.stderr.subarray(-4096).toString("utf8"))}`);
  assert.equal(result.timeout, false, "CLI timed out; not the expected regression");
  assert.deepEqual(result.overflow, [], "CLI output overflow; not the expected regression");
  assert.deepEqual(result.errors, [], "CLI spawn/stream/abort failure");
  assert.equal(result.close, true, "CLI close not observed");
  assert.equal(result.stdoutEOF && result.stderrEOF, true, "CLI EOF not observed");
  assert.equal(receipt.tripwireInvoked, false, "discovery tripwire was executed");
  assert.equal(result.signal, null);
  assert.equal(result.status, 5, "must reach copy refusal, not loader/dependency/unsafe-root failure");
  assert.ok(result.stderr.toString("utf8").includes(`could not write ${path.join(workspace, "bin/ask.sh")}:`),
    "must diagnose the exact obstructed destination");
  assert.deepEqual(runtimeAfter, runtimeBefore, "runtime/package identities changed");
  if (after[lockKey]) {
    assert.equal(owner?.kind, "legacy-init", "unexpected pending owner");
    assert.match(owner?.operationId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
  const pending = [lockKey, "workspace/.aigentry-preservation.lock", "aigentry/.aigentry-preservation.lock"]
    .filter(key => after[key]);
  assert.deepEqual({ pending, changed }, { pending: [], changed: [] },
    `ordinary refusal must leave no pending operation and identical inventories; evidence: ${evidence}`);
});
