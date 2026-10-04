// #1167 — native boot-shim discriminator, R1 DELTA. DIAGNOSTIC, test-only; not a regression gate.
//
// Complements tests/dispatch/windows-boot-spawn-probe.mjs, which already measures (win32 only,
// node v20.20.2) the R2 install shape with real npm-generated .cmd shims and the R3 cross-spawn
// comparison. This file measures only what that probe does not, and does not repeat it:
//   R1  the ORIGINAL fixture shape: extensionless Node-shebang fake CLI looked up by BARE name on
//       PATH, with model-router-fixtures.ts's leading-";" PATHEXT (the existing probe execs that
//       file by absolute path only). Product probeVersion and run, unchanged and uninstrumented.
//   R3  cross-spawn on that same bare R1 name: an ISOLATED comparison, not a product fix.
//   POSIX baseline: the same cases on linux/darwin (the existing probe refuses to run there).
// Controls: process.execPath must work (positive); an impossible path must fail (negative).
//
// Every product call runs in an owned isolated Node child with an in-child op watchdog AND a
// parent watchdog, because probeVersion has no timeout of its own. The product .run timeout
// kills its direct child only; this probe creates no grandchild trees on purpose and claims
// no Job Object / tree-kill coverage. The fake CLIs answer once and exit, with no background work.
//
// Exit 0 means the HARNESS kept control: controls behaved, every observation was well formed
// and settled, and no unexpected artifact appeared. Observed product failures do NOT fail the
// harness; they are recorded in results.json and summary.md. A green run is not a claim that
// Windows works. Exit 1 is a harness integrity failure, exit 2 a precondition/usage error.
//
// Usage: node tests/dispatch/boot-shim-probe.mjs --out <dir> [--repo <dir>] [--spawner <file>]
//        node tests/dispatch/boot-shim-probe.mjs --self-test --out <dir>   (harness meta-checks)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SCHEMA = "boot-shim-probe/v1";
const OBS_TAG = "BOOT_SHIM_OBSERVATION ";
const ARGV_TAG = "FAKECLI_ARGV ";
const FAKE = "bsp-fakecli";
const SENTINEL = "SENTINEL-EXPANDED";
const OUTPUT_LIMIT = 4096, CHILD_STDOUT_LIMIT = 1024 * 1024, KILL_GRACE_MS = 5000;
const isWin = process.platform === "win32";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);
const clip = (s) => (typeof s === "string" && s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + "…[clipped]" : s);
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

function errInfo(e) {
  if (!(e instanceof Error)) return { name: typeof e, message: clip(String(e)) };
  const o = { name: e.name, message: clip(e.message) };
  for (const k of ["code", "errno", "syscall", "path"]) if (e[k] !== undefined) o[k] = e[k];
  if (Array.isArray(e.spawnargs)) o.spawnargs = e.spawnargs.map(String);
  return o;
}

/** The fake CLI's argv report, parsed from its stdout; null when absent or unparseable. */
function parseArgv(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).find((l) => l.startsWith(ARGV_TAG));
  if (!line) return null;
  try { const a = JSON.parse(line.slice(ARGV_TAG.length)); return Array.isArray(a) ? a : null; } catch { return null; }
}

function argvCompare(sent, got) {
  if (!got) return { argvEqual: false, received: null };
  const diffs = [];
  for (let i = 0; i < Math.max(sent.length, got.length); i++)
    if (sent[i] !== got[i]) diffs.push({ i, sent: sent[i] ?? null, got: got[i] ?? null });
  return { argvEqual: diffs.length === 0, received: got, diffs, sentinelExpanded: got.some((a) => String(a).includes(SENTINEL)) };
}

/** spawn-shaped call with a bounded wait; records the real error instead of normalizing it. */
function rawSpawn(spawnFn, exe, args, options, timeoutMs) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "", err = "", settled = false, child, timer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ...r, stdout: clip(out), stderr: clip(err), elapsedMs: Date.now() - t0, spawnargs: child?.spawnargs?.map(String) ?? null });
    };
    try { child = spawnFn(exe, args, options); } catch (e) { finish({ state: "sync-throw", error: errInfo(e) }); return; }
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* recorded as timeout below */ } finish({ state: "timeout" }); }, timeoutMs);
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => finish({ state: "error", error: errInfo(e) }));
    child.on("close", (code, signal) => finish({ state: "exited", exitCode: code, signal }));
  });
}

// ---------------------------------------------------------------- isolated child ----------
async function childMain() {
  const spec = JSON.parse(Buffer.from(process.env.BOOT_SHIM_PROBE_CASE ?? "", "base64").toString("utf8"));
  const obs = { schema: SCHEMA, id: spec.id, op: spec.op };
  let emitted = false;
  const emit = (code) => {
    if (emitted) return;
    emitted = true;
    process.stdout.write(OBS_TAG + b64(obs) + "\n", () => process.exit(code));
  };
  setTimeout(() => { obs.unsettled = "op-watchdog"; emit(3); }, spec.opTimeoutMs);
  try {
    if (spec.op === "cross-spawn") {
      const crossSpawn = createRequire(SELF)(spec.crossSpawn);
      try {
        const p = crossSpawn._parse(spec.exe, spec.args, {});
        obs.crossSpawnParsed = { command: p.command, args: p.args, file: p.file ?? null, shell: Boolean(p.options?.shell) };
      } catch (e) { obs.crossSpawnParsed = { error: errInfo(e) }; }
      obs.crossSpawn = await rawSpawn(crossSpawn, spec.exe, spec.args, { cwd: spec.cwd, env: process.env }, spec.runTimeoutMs);
      obs.crossSpawn.argv = argvCompare(spec.expectArgv, parseArgv(obs.crossSpawn.stdout));
    } else {
      const args = spec.op === "product-probe" ? ["--version"] : spec.args;
      const opts = spec.op === "product-probe" ? { shell: false } : { cwd: spec.cwd, env: { ...process.env }, shell: false };
      // Mirror: the same spawn options the product uses, so the real error code survives
      // (probeVersion maps every failure to CLI_NOT_FOUND; .run stamps code ENOENT).
      obs.mirror = await rawSpawn(spawn, spec.exe, args, opts, spec.runTimeoutMs);
      const { nodeSpawner } = await import(pathToFileURL(spec.spawner).href);
      const sp = nodeSpawner();
      try {
        if (spec.op === "product-probe") {
          obs.product = { state: "resolved", value: clip(String(await sp.probeVersion(spec.exe))) };
        } else {
          const cmd = { argv: [spec.exe, ...spec.args], env: {}, cwd: spec.cwd, prompt_file: "", expected_digest: "" };
          const r = await sp.run(cmd, undefined, spec.runTimeoutMs);
          obs.product = { state: "resolved", exitCode: r.exit_code, stdout: clip(r.stdout), stderr: clip(r.stderr),
            durationMs: r.duration_ms, argv: argvCompare(spec.expectArgv, parseArgv(r.stdout)) };
        }
      } catch (e) { obs.product = { state: "rejected", error: errInfo(e) }; }
    }
  } catch (e) { obs.fatal = errInfo(e); }
  emit(0);
}

// ---------------------------------------------------------------- parent ----------------
function parseFlags(argv) {
  const f = { opTimeoutMs: 10_000, childWatchdogMs: 30_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`missing value for ${k}`); return argv[++i]; };
    if (k === "--out") f.out = resolve(v());
    else if (k === "--repo") f.repo = resolve(v());
    else if (k === "--spawner") f.spawner = resolve(v());
    else if (k === "--op-timeout-ms") f.opTimeoutMs = Number(v());
    else if (k === "--child-watchdog-ms") f.childWatchdogMs = Number(v());
    else if (k === "--allow-missing-cross-spawn") f.allowMissingCrossSpawn = true;
    else if (k === "--self-test") f.selfTest = true;
    else throw new Error(`unknown flag ${k}`);
  }
  if (!f.out) throw new Error("--out <dir> is required");
  for (const [k, lo, hi] of [["opTimeoutMs", 1000, 60_000], ["childWatchdogMs", 2000, 120_000]])
    if (!Number.isInteger(f[k]) || f[k] < lo || f[k] > hi) throw new Error(`${k} must be an integer in [${lo}, ${hi}]`);
  if (f.childWatchdogMs <= f.opTimeoutMs) throw new Error("child watchdog must exceed the op timeout");
  return f;
}

function envValue(name) {
  const hit = Object.entries(process.env).find(([k]) => k.toUpperCase() === name);
  return hit?.[1];
}

/** Hermetic child env: only what the probe needs. No credentials, tokens or ambient AIGENTRY_*. */
function childEnv(root, bin) {
  const env = { TMP: join(root, "tmp"), TEMP: join(root, "tmp"), TMPDIR: join(root, "tmp"), BSP_SENTINEL: SENTINEL };
  if (isWin) {
    for (const k of ["SYSTEMROOT", "WINDIR", "COMSPEC"]) { const v = envValue(k); if (v) env[k] = v; }
    const sys = env.SYSTEMROOT ? join(env.SYSTEMROOT, "System32") : "";
    env.PATH = [bin, dirname(process.execPath), sys].filter(Boolean).join(delimiter);
    // Same shape as model-router-fixtures.ts: a leading empty extension, then the inherited list.
    env.PATHEXT = `;${envValue("PATHEXT") || ".COM;.EXE;.BAT;.CMD"}`;
  } else {
    env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  }
  return env;
}

function inertArgs(marker) {
  return ["plain", "with space", "unicode-\u00fc-\u2713-\ud55c\uae00", 'dq"inner', "sq'inner", "", "trailing-backslash\\",
    "a&b|c<d>e^f(g)", "%BSP_SENTINEL%", "!BSP_SENTINEL!", "$BSP_SENTINEL", "*?",
    `& type nul > "${marker}"`, `" & type nul > "${marker}" & "`, `; : > '${marker}'`, `$(: > '${marker}')`, `\`: > '${marker}'\``];
}

/** Fake CLI body: valid as CJS and ESM, prints one line, ends naturally (no handles, no files). */
const FAKE_BODY = [
  "const a = process.argv.slice(2);",
  "if (a.length === 1 && a[0] === '--version') process.stdout.write('bsp-fakecli 9.9.9\\n');",
  "else process.stdout.write('" + ARGV_TAG + "' + JSON.stringify(a).replace(/[\\u007f-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\\n');",
  "process.exitCode = 0;",
].join("\n") + "\n";

function writeFixtures(root) {
  const bin = join(root, "bin"), work = join(root, "work");
  for (const d of [bin, work, join(root, "tmp")]) mkdirSync(d, { recursive: true });
  const files = {};
  const put = (name, text, mode) => { const p = join(bin, name); writeFileSync(p, text, { mode }); files[name] = { sha256: sha256(text), bytes: Buffer.byteLength(text) }; };
  // R1: exactly the fixture's shebang choice (model-router-fixtures.ts script()).
  put(FAKE, (isWin ? "#!/usr/bin/env node\n" : "#!" + process.execPath + "\n") + FAKE_BODY, 0o755);
  put(FAKE + ".js", FAKE_BODY, 0o644);
  return { bin, work, files };
}

function listTree(root) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out.push(relative(root, p).split("\\").join("/") + (e.isDirectory() ? "/" : "")); if (e.isDirectory()) walk(p); } };
  walk(root);
  return out.sort();
}

function runChild(spec, env, cwd, watchdogMs) {
  return new Promise((done) => {
    let out = "", err = "", settled = false, killed = false, overflow = false, grace;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(wd); clearTimeout(grace); done({ ...r, killed, overflow, stdout: out, stderr: clip(err) }); };
    let child;
    try {
      child = spawn(process.execPath, [SELF, "--child"], { cwd, env: { ...env, BOOT_SHIM_PROBE_CASE: b64(spec) }, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (e) { done({ spawnError: errInfo(e), killed: false, overflow: false, stdout: "", stderr: "" }); return; }
    const wd = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* lost control is decided by the grace timer */ }
      grace = setTimeout(() => finish({ lostControl: true }), KILL_GRACE_MS);
    }, watchdogMs);
    child.stdout.on("data", (d) => { if (out.length < CHILD_STDOUT_LIMIT) out += d.toString(); else overflow = true; });
    child.stderr.on("data", (d) => { err += d.toString(); if (err.length > CHILD_STDOUT_LIMIT) err = err.slice(0, CHILD_STDOUT_LIMIT); });
    child.on("error", (e) => finish({ spawnError: errInfo(e) }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

function decodeObservation(spec, r) {
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith(OBS_TAG));
  if (lines.length !== 1) return { error: `expected exactly 1 observation line, got ${lines.length}` };
  try {
    const o = JSON.parse(Buffer.from(lines[0].slice(OBS_TAG.length), "base64").toString("utf8"));
    if (o?.schema !== SCHEMA || o.id !== spec.id || o.op !== spec.op) return { error: "observation schema/id/op mismatch" };
    return { obs: o };
  } catch (e) { return { error: `observation not decodable: ${e.message}` }; }
}

function outcomeText(c) {
  if (c.state === "unmeasured") return `UNMEASURED (${c.reason})`;
  const o = c.observation;
  if (!o) return `NO OBSERVATION (${c.harnessIssues.join(", ")})`;
  if (o.unsettled) return `UNSETTLED (${o.unsettled})`;
  if (o.fatal) return `FATAL ${o.fatal.message}`;
  const argvTxt = (a) => (a ? (a.argvEqual ? "argv=equal" : a.received ? `argv=differs(${a.diffs.length})` : "argv=absent") + (a?.sentinelExpanded ? " sentinel-expanded" : "") : "");
  const errTxt = (e) => `${e.message}${e.code ? ` code=${e.code}` : ""}${e.errno !== undefined ? ` errno=${e.errno}` : ""}`;
  const raw = o.mirror ?? o.crossSpawn;
  const rawTxt = raw ? (raw.state === "exited" ? `exit=${raw.exitCode}` : raw.state === "timeout" ? "timeout" : `${raw.state} ${errTxt(raw.error)}`) : "";
  if (o.op === "cross-spawn") return `cross-spawn ${rawTxt} ${argvTxt(raw.argv)}`.trim();
  const p = o.product;
  const prodTxt = p.state === "rejected" ? `REJECTED ${errTxt(p.error)}` : o.op === "product-probe" ? `resolved ${p.value}` : `exit=${p.exitCode} ${argvTxt(p.argv)}`;
  return `${prodTxt} | mirror ${rawTxt}`;
}

function derive(cases) {
  const st = (id) => cases.find((c) => c.id === id);
  const ok = (id) => st(id)?.observation?.product?.state === "resolved" && (st(id).op !== "product-run" || st(id).observation.product.exitCode === 0);
  const r1 = ok("R1-probe") && ok("R1-run");
  const label = !isWin ? `posix-baseline: R1 bare extensionless ${r1 ? "resolved" : "FAILED"} (POSIX shebang path, not Windows)`
    : r1 ? "R1-resolved: original extensionless fixture shape NOT reproduced as failing (H1 not reproduced)"
      : "R1-failed: unchanged product cannot launch the original extensionless fixture shape (H1 reproduced)";
  return { label, note: "R1 only. The R2 half of the discriminator (bare npm .cmd shim through the unchanged product) comes from the windows-boot-spawn-probe receipt (current/*/local-bare|prefix-bare/*), read together with this one. Not a product fix, not proof that Windows works." };
}

async function probeMain(f) {
  const repo = f.repo ?? resolve(dirname(SELF), "../..");
  const spawner = f.spawner ?? join(repo, "dist/src/session/boot-adapter/spawner.js");
  if (!existsSync(spawner)) { console.error(`precondition: compiled spawner not found at ${spawner} (run npm run build first)`); return 2; }
  let crossSpawn = null, crossSpawnMeta = { state: "unresolved" };
  try {
    crossSpawn = createRequire(join(repo, "package.json")).resolve("cross-spawn");
    const pkg = join(dirname(crossSpawn), "package.json");
    crossSpawnMeta = { state: "resolved", path: crossSpawn, version: JSON.parse(readFileSync(pkg, "utf8")).version, indexSha256: fileSha(crossSpawn),
      parseSha256: fileSha(join(dirname(crossSpawn), "lib/parse.js")), escapeSha256: fileSha(join(dirname(crossSpawn), "lib/util/escape.js")) };
  } catch (e) {
    crossSpawnMeta = { state: "unresolved", error: errInfo(e) };
    if (!f.allowMissingCrossSpawn) { console.error("precondition: cross-spawn not resolvable from the repo (npm ci first)"); return 2; }
  }
  const spawnerShaBefore = fileSha(spawner);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "boot-shim-probe-")));
  const harnessIssues = [];
  const cases = [];
  let meta;
  try {
    const { bin, work, files } = writeFixtures(root);
    const marker = join(root, "marker-should-not-exist");
    const env = childEnv(root, bin);
    const args = inertArgs(marker);
    const impossible = join(root, "no-such-dir", "no-such-cli");
    const runTimeoutMs = Math.max(500, Math.min(8000, f.opTimeoutMs - 1000));
    meta = {
      schema: SCHEMA, generatedAt: new Date().toISOString(),
      runtime: { node: process.version, uv: process.versions.uv, v8: process.versions.v8, execPath: process.execPath, platform: process.platform, arch: process.arch, osRelease: release() },
      ci: { githubActions: process.env.GITHUB_ACTIONS === "true", sha: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, runnerOs: process.env.RUNNER_OS ?? null, imageVersion: process.env.ImageVersion ?? null },
      source: { spawnerTs: { path: join(repo, "src/session/boot-adapter/spawner.ts"), sha256: fileSha(join(repo, "src/session/boot-adapter/spawner.ts")) },
        spawnerJs: { path: spawner, sha256: spawnerShaBefore }, probeSha256: fileSha(SELF), crossSpawn: crossSpawnMeta },
      fixtures: { root, files, childPath: env.PATH.split(delimiter), childPathExt: env.PATHEXT ?? null, cwd: work },
      limits: { opTimeoutMs: f.opTimeoutMs, childWatchdogMs: f.childWatchdogMs, productRunTimeoutMs: runTimeoutMs,
        note: "product .run timeout kills its direct child only; no grandchild-tree or Job Object coverage is claimed" },
      sentArgv: args,
    };
    const plan = [
      { id: "C-pos-probe", rung: "control+", op: "product-probe", exe: process.execPath },
      // The script path is node's own argument, so the fake reports only the inert args.
      { id: "C-pos-run", rung: "control+", op: "product-run", exe: process.execPath, args: [join(bin, FAKE + ".js"), ...args], expectArgv: args },
      { id: "C-neg-probe", rung: "control-", op: "product-probe", exe: impossible },
      { id: "C-neg-run", rung: "control-", op: "product-run", exe: impossible, args: [] },
      { id: "R1-probe", rung: "R1", op: "product-probe", exe: FAKE },
      { id: "R1-run", rung: "R1", op: "product-run", exe: FAKE, args },
      { id: "R3-cs-R1-version", rung: "R3", op: "cross-spawn", exe: FAKE, args: ["--version"] },
      { id: "R3-cs-R1-args", rung: "R3", op: "cross-spawn", exe: FAKE, args },
    ];
    for (const p of plan) {
      const c = { id: p.id, rung: p.rung, op: p.op, exe: p.exe, harnessIssues: [] };
      cases.push(c);
      if (p.op === "cross-spawn" && !crossSpawn) { Object.assign(c, { state: "unmeasured", reason: "cross-spawn unresolved (allowed by flag)" }); continue; }
      const spec = { id: p.id, op: p.op, exe: p.exe, args: p.args ?? [], expectArgv: p.expectArgv ?? p.args ?? [], cwd: work, spawner, crossSpawn, opTimeoutMs: f.opTimeoutMs, runTimeoutMs };
      const r = await runChild(spec, env, work, f.childWatchdogMs);
      c.child = { exitCode: r.exitCode ?? null, signal: r.signal ?? null, killedByWatchdog: r.killed, stderr: r.stderr || undefined };
      if (r.spawnError) c.harnessIssues.push(`lost-control: probe child spawn failed (${r.spawnError.message})`);
      if (r.lostControl) c.harnessIssues.push("lost-control: probe child did not close after SIGKILL");
      if (r.killed) c.harnessIssues.push("timeout-unsettled: parent watchdog killed the probe child");
      if (r.overflow) c.harnessIssues.push("malformed-observation: probe child stdout overflow");
      if (!r.spawnError && !r.lostControl && !r.killed) {
        const d = decodeObservation(spec, r);
        if (d.error) c.harnessIssues.push(`malformed-observation: ${d.error}`);
        else {
          c.observation = d.obs;
          if (d.obs.unsettled) c.harnessIssues.push(`timeout-unsettled: ${d.obs.unsettled}`);
          if (d.obs.fatal) c.harnessIssues.push(`malformed-observation: child fatal ${d.obs.fatal.message}`);
          if (!d.obs.unsettled && !d.obs.fatal && p.op !== "cross-spawn" && !d.obs.product) c.harnessIssues.push("malformed-observation: no product result");
        }
      }
      if (existsSync(marker)) { c.harnessIssues.push("unexpected-artifact: shell side-effect marker created"); rmSync(marker, { force: true }); }
      const stray = readdirSync(work);
      if (stray.length) { c.harnessIssues.push(`unexpected-artifact: files in cwd ${JSON.stringify(stray)}`); for (const s of stray) rmSync(join(work, s), { recursive: true, force: true }); }
      // Controls decide whether this run measured anything at all.
      const o = c.observation, pr = o?.product;
      if (c.observation && !o.unsettled && !o.fatal && pr) {
        if (p.id === "C-pos-probe" && !(pr.state === "resolved" && pr.value === process.versions.node)) c.harnessIssues.push("control-failed: probeVersion(process.execPath) did not return this node version");
        if (p.id === "C-pos-run" && !(pr.state === "resolved" && pr.exitCode === 0 && pr.argv?.argvEqual)) c.harnessIssues.push("control-failed: run(process.execPath fake.js ...) did not round-trip argv with exit 0");
        if (p.id === "C-neg-probe" && !(pr.state === "rejected" && /CLI_NOT_FOUND/.test(pr.error.message))) c.harnessIssues.push("control-failed: impossible path was not CLI_NOT_FOUND");
        if (p.id === "C-neg-run" && pr.state !== "rejected") c.harnessIssues.push("control-failed: impossible path run did not reject");
      }
      c.state = c.harnessIssues.length ? "harness-issue" : p.rung.startsWith("control") ? "control-ok"
        : (pr?.state === "rejected" || (pr?.state === "resolved" && p.op === "product-run" && pr.exitCode !== 0)) ? "observed-product-failure"
          : p.op === "cross-spawn" ? "observed-comparison" : "observed-product-success";
      c.outcome = outcomeText(c);
      harnessIssues.push(...c.harnessIssues.map((i) => `${c.id}: ${i}`));
    }
    const expected = ["bin/", "tmp/", "work/", ...Object.keys(files).map((n) => "bin/" + n)].sort();
    const tree = listTree(root);
    const unexpected = tree.filter((t) => !expected.includes(t) && !t.startsWith("tmp/"));
    const missing = expected.filter((t) => !tree.includes(t));
    if (unexpected.length) harnessIssues.push(`unexpected-artifact: ${JSON.stringify(unexpected)}`);
    if (missing.length) harnessIssues.push(`lost-control: fixture files vanished ${JSON.stringify(missing)}`);
    meta.fixtures.tmpLeftovers = tree.filter((t) => t.startsWith("tmp/"));
    if (fileSha(spawner) !== spawnerShaBefore) harnessIssues.push("unexpected-artifact: compiled spawner changed during the probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const verdict = harnessIssues.length ? "HARNESS-FAILED" : "HARNESS-OK (observations recorded; not a product pass)";
  const results = { ...meta, cases, harness: { verdict, issues: harnessIssues }, discriminator: derive(cases) };
  mkdirSync(f.out, { recursive: true });
  writeFileSync(join(f.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  const md = [`# boot-shim-probe ${process.platform}/${process.arch} node ${process.version}`, "",
    `- spawner.ts sha256 \`${meta.source.spawnerTs.sha256}\``, `- spawner.js sha256 \`${meta.source.spawnerJs.sha256}\``,
    `- cross-spawn ${crossSpawnMeta.version ?? "unresolved"} | commit ${meta.ci.sha ?? "local"}`, `- harness: **${verdict}**`,
    `- discriminator: ${results.discriminator.label}`, `  - ${results.discriminator.note}`, "",
    "| case | rung | state | outcome |", "|---|---|---|---|",
    ...cases.map((c) => `| ${c.id} | ${c.rung} | ${c.state} | ${String(c.outcome ?? c.reason ?? "").replace(/\|/g, "\\|")} |`), "",
    ...(harnessIssues.length ? ["## Harness issues", ...harnessIssues.map((i) => `- ${i}`)] : [])].join("\n") + "\n";
  writeFileSync(join(f.out, "summary.md"), md);
  process.stdout.write(md);
  if (process.env.GITHUB_ACTIONS === "true")
    for (const c of cases.filter((x) => x.state === "observed-product-failure"))
      process.stdout.write(`::warning title=observed product failure ${c.id}::${String(c.outcome).replace(/[\r\n%]/g, " ")}\n`);
  return harnessIssues.length ? 1 : 0;
}

// ---------------------------------------------------------------- self-test -------------
// Meta-checks that the harness fails on its own loss of control. Uses only owned fake
// spawner modules (never the product) and process.execPath; every run is bounded.
const GOOD_SPAWNER = `import { spawn } from "node:child_process";
export function nodeSpawner() { return {
  probeVersion(exe) { /*PROBE*/ return new Promise((res, rej) => { const c = spawn(exe, ["--version"], { shell: false }); let o = "";
    c.stdout.on("data", (d) => { o += d; }); c.on("error", () => rej(new Error("CLI_NOT_FOUND")));
    c.on("close", (code) => (code === 0 ? res((o.match(/\\d+\\.\\d+\\.\\d+/) || [o.trim()])[0]) : rej(new Error("CLI_NOT_FOUND")))); }); },
  run(cmd, stdin, timeout_ms = 5000) { /*RUN*/ return new Promise((res, rej) => { const t0 = Date.now(); const [exe, ...args] = cmd.argv;
    const c = spawn(exe, args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, shell: false }); let o = "", e = "";
    const t = setTimeout(() => { c.kill("SIGKILL"); rej(new Error("BOOT_TIMEOUT")); }, timeout_ms);
    c.stdout.on("data", (d) => { o += d; }); c.stderr.on("data", (d) => { e += d; });
    c.on("error", (err) => { clearTimeout(t); rej(err); });
    c.on("close", (code) => { clearTimeout(t); res({ stdout: o, stderr: e, exit_code: code ?? -1, duration_ms: Date.now() - t0 }); }); }); },
}; }
`;
const META_CASES = [
  { name: "good", src: GOOD_SPAWNER, exit: 0, issue: null },
  { name: "hang", src: GOOD_SPAWNER.replace("/*PROBE*/", "return new Promise(() => {});"), exit: 1, issue: "timeout-unsettled" },
  { name: "busy", src: GOOD_SPAWNER.replace("/*PROBE*/", "for (;;) {}"), exit: 1, issue: "timeout-unsettled", watchdog: 4000 },
  { name: "garbage", src: `process.stdout.write("${OBS_TAG}%%%\\n");\n` + GOOD_SPAWNER, exit: 1, issue: "malformed-observation" },
  { name: "liar", src: GOOD_SPAWNER.replace("/*PROBE*/", "return Promise.reject(new Error(\"CLI_NOT_FOUND\"));"), exit: 1, issue: "control-failed" },
  { name: "stray", src: GOOD_SPAWNER.replace("/*RUN*/", "(await import(\"node:fs\")).writeFileSync(cmd.cwd + \"/stray\", \"x\");").replace("run(cmd,", "async run(cmd,"), exit: 1, issue: "unexpected-artifact" },
];

async function selfTestMain(f) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "boot-shim-selftest-")));
  const report = [];
  try {
    for (const m of META_CASES) {
      const fake = join(root, `${m.name}-spawner.mjs`);
      writeFileSync(fake, m.src);
      const out = join(f.out, m.name);
      const argv = [SELF, "--out", out, "--spawner", fake, "--repo", root, "--allow-missing-cross-spawn", "--op-timeout-ms", "3000", "--child-watchdog-ms", String(m.watchdog ?? 15_000)];
      const r = await new Promise((done) => {
        const c = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
        let err = "";
        c.stdout.resume();
        c.stderr.on("data", (d) => { err += d; });
        const t = setTimeout(() => { c.kill("SIGKILL"); done({ exit: "outer-timeout", err }); }, 180_000);
        c.on("close", (code) => { clearTimeout(t); done({ exit: code, err }); });
      });
      let issues = null;
      try { issues = JSON.parse(readFileSync(join(out, "results.json"), "utf8")).harness.issues; } catch { /* checked below */ }
      const pass = r.exit === m.exit && Array.isArray(issues) && (m.issue === null ? issues.length === 0 : issues.some((i) => i.includes(m.issue)));
      report.push({ meta: m.name, expectExit: m.exit, gotExit: r.exit, expectIssue: m.issue, issues, pass, stderr: clip(r.err) || undefined });
      process.stdout.write(`self-test ${m.name}: ${pass ? "PASS" : "FAIL"} (exit ${r.exit}, expected ${m.exit}${m.issue ? `, issue ${m.issue}` : ""})\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(f.out, { recursive: true });
  writeFileSync(join(f.out, "self-test.json"), JSON.stringify({ schema: SCHEMA, node: process.version, platform: process.platform, probeSha256: fileSha(SELF), report }, null, 2) + "\n");
  return report.every((x) => x.pass) ? 0 : 1;
}

if (process.argv[2] === "--child") {
  await childMain();
} else {
  let flags;
  try { flags = parseFlags(process.argv.slice(2)); } catch (e) { console.error(`usage: ${e.message}`); process.exit(2); }
  process.exitCode = flags.selfTest ? await selfTestMain(flags) : await probeMain(flags);
}
