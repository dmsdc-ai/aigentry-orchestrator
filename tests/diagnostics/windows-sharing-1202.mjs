// Task 1202 diagnostic only. The release resolver test and production code are not imported.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_HOLDER = [
  "$ErrorActionPreference = 'Stop'",
  "$encoded = [Console]::In.ReadLine()",
  "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
  "$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)",
  "try {",
  "  [Console]::Out.WriteLine('READY')",
  "  [Console]::Out.Flush()",
  "  [void][Console]::In.ReadLine()",
  "} finally { $stream.Dispose() }",
].join("\n");

const ACK_HOLDER = [
  "$ErrorActionPreference = 'Stop'",
  "$encoded = [Console]::In.ReadLine()",
  "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
  "$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)",
  "try {",
  "  [Console]::Out.WriteLine('READY')",
  "  [Console]::Out.Flush()",
  "  while ($true) {",
  "    $command = [Console]::In.ReadLine()",
  "    if ($command -eq 'RELEASE') { [Console]::Out.WriteLine('RELEASE_ACK'); break }",
  "    if ($null -eq $command) { [Console]::Out.WriteLine('UNEXPECTED_EOF'); break }",
  "  }",
  "} finally { $stream.Dispose(); [Console]::Out.WriteLine('DISPOSED') }",
].join("\n");

const READER = [
  "$ErrorActionPreference = 'Stop'",
  "$encoded = [Console]::In.ReadLine()",
  "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
  "try {",
  "  $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)",
  "  try { $value = $stream.ReadByte(); $result = @{ status = 'ok'; bytesRead = [int]($value -ge 0) } }",
  "  finally { $stream.Dispose() }",
  "} catch {",
  "  $exception = $_.Exception",
  "  $inner = $exception.InnerException",
  "  $result = @{ status = 'error'; type = $exception.GetType().FullName; hresult = $exception.HResult; innerType = $(if ($inner) { $inner.GetType().FullName } else { $null }); innerHresult = $(if ($inner) { $inner.HResult } else { $null }) }",
  "}",
  "[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))",
].join("\n");

const scripts = { originalHolder: ORIGINAL_HOLDER, acknowledgementHolder: ACK_HOLDER, dotnetReader: READER };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const reportPath = process.argv[2];
const report = {
  task: 1202,
  kind: "diagnostic-only",
  platform: process.platform,
  node: process.version,
  powershell,
  scriptsSha256: Object.fromEntries(Object.entries(scripts).map(([name, source]) => [name, sha256(source)])),
  fixture: null,
  variants: {},
  primaryError: null,
  cleanupErrors: [],
  children: [],
};
const handles = [];
let fixture;

function fileIdentity(file) {
  const stat = fs.lstatSync(file);
  return { regular: stat.isFile(), dev: stat.dev, ino: stat.ino, size: stat.size };
}

function assertOwned(file, root) {
  const real = fs.realpathSync(file);
  const relative = path.relative(root, real);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.lstatSync(real).isFile()) {
    throw new Error("diagnostic path is not an owned regular file");
  }
  return real;
}

function startChild(label, script) {
  const argv = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const record = { label, argv, pid: child.pid ?? null, events: [], stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signalCode: null };
  const started = Date.now();
  const event = (name, detail = null) => {
    if (record.events.length < 40) record.events.push({ name, ms: Date.now() - started, detail, exitCode: child.exitCode, signalCode: child.signalCode });
  };
  const listeners = new Set();
  let pending = "";
  const append = (key, chunk) => {
    const text = chunk.toString("utf8");
    const room = Math.max(0, 4096 - record[key].length);
    record[key] += text.slice(0, room);
    if (text.length > room) record[`${key}Truncated`] = true;
    return text;
  };
  child.stdout.on("data", (chunk) => {
    pending += append("stdout", chunk);
    if (pending.length > 4096) pending = pending.slice(-4096);
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      event("stdout-line", line.slice(0, 120));
      for (const listener of listeners) listener(line);
    }
  });
  child.stderr.on("data", (chunk) => { append("stderr", chunk); event("stderr-data", chunk.length); });
  child.stdin.on("error", (error) => event("stdin-error", { code: error.code ?? null, message: error.message.slice(0, 120) }));
  child.on("spawn", () => event("spawn"));
  child.on("error", (error) => event("error", { code: error.code ?? null, message: error.message.slice(0, 120) }));
  child.on("exit", (code, signal) => { record.exitCode = code; record.signalCode = signal; event("exit"); });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    record.exitCode = code;
    record.signalCode = signal;
    event("close");
    resolve();
  }));
  const handle = { child, record, closed, listeners, event, released: false, get closeObserved() { return record.events.some((entry) => entry.name === "close"); } };
  handles.push(handle);
  return handle;
}

async function boundedClosed(handle, ms) {
  let timer;
  try {
    return await Promise.race([handle.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reap(handle, releaseLine = null) {
  if (handle.released) return;
  handle.released = true;
  if (!handle.closeObserved) {
    handle.event("parent-release", releaseLine ?? "EOF");
    if (releaseLine) handle.child.stdin.write(`${releaseLine}\n`);
    handle.child.stdin.end();
  }
  if (await boundedClosed(handle, 5000)) return;
  handle.event("forced-owned-cleanup");
  handle.child.kill();
  if (!(await boundedClosed(handle, 5000))) throw new Error(`${handle.record.label}: own child did not close after forced cleanup`);
  throw new Error(`${handle.record.label}: forced owned cleanup was required`);
}

function liveSnapshot(handle) {
  return { pid: handle.child.pid ?? null, exitCode: handle.child.exitCode, signalCode: handle.child.signalCode, closeObserved: handle.closeObserved,
    live: handle.child.pid !== undefined && handle.child.exitCode === null && handle.child.signalCode === null && !handle.closeObserved };
}

async function launchHolder(label, script, file) {
  const handle = startChild(label, script);
  const ready = new Promise((resolve, reject) => {
    let timer;
    const onLine = (line) => {
      if (line === "READY") { clearTimeout(timer); handle.listeners.delete(onLine); resolve(true); }
      else { clearTimeout(timer); handle.listeners.delete(onLine); reject(new Error(`${label}: unexpected pre-ready marker ${line.slice(0, 80)}`)); }
    };
    handle.listeners.add(onLine);
    handle.closed.then(() => { clearTimeout(timer); handle.listeners.delete(onLine); reject(new Error(`${label}: closed before READY`)); });
    timer = setTimeout(() => { handle.listeners.delete(onLine); reject(new Error(`${label}: READY timeout`)); }, 15000);
  });
  handle.child.stdin.write(Buffer.from(file, "utf8").toString("base64") + "\n");
  await ready;
  return handle;
}

function nodeRead(file) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try { return { status: "ok", bytesRead: fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) }; }
    finally { fs.closeSync(fd); }
  } catch (error) {
    return { status: "error", code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null };
  }
}

async function dotnetRead(label, file) {
  const handle = startChild(label, READER);
  handle.child.stdin.end(Buffer.from(file, "utf8").toString("base64") + "\n");
  if (!(await boundedClosed(handle, 15000))) {
    await reap(handle);
    return { status: "timeout", child: handle.record };
  }
  handle.released = true;
  let result;
  try { result = JSON.parse(handle.record.stdout.trim()); }
  catch { result = { status: "invalid-json" }; }
  return { result, child: handle.record };
}

async function compareWhileHeld(holder, denied, readable) {
  const observations = [];
  for (const [engine, label, file] of [
    ["node", "denied", denied], ["node", "positive", readable],
    ["dotnet", "denied", denied], ["dotnet", "positive", readable],
  ]) {
    const before = liveSnapshot(holder);
    const observation = { engine, label, holderBefore: before };
    if (before.live) observation.read = engine === "node" ? nodeRead(file) : await dotnetRead(`reader-${label}`, file);
    else observation.read = { status: "skipped-holder-not-live" };
    observation.holderAfter = liveSnapshot(holder);
    observations.push(observation);
  }
  return observations;
}

async function run() {
  if (process.platform !== "win32") throw new Error("Windows diagnostic only");
  if (!reportPath || !path.isAbsolute(reportPath) || path.basename(reportPath) !== "windows-sharing-1202.json") throw new Error("expected absolute diagnostic report path");
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sharing-1202-"));
  const denied = path.join(fixture, "synthetic-transcript.jsonl");
  const readable = path.join(fixture, "readable-control.jsonl");
  fs.writeFileSync(denied, Buffer.from('{"synthetic":true}\n', "utf8"));
  fs.copyFileSync(denied, readable);
  const deniedPath = assertOwned(denied, fixture);
  const readablePath = assertOwned(readable, fixture);
  if (!fs.readFileSync(deniedPath).equals(fs.readFileSync(readablePath))) throw new Error("control bytes differ");
  report.fixture = { root: fixture, denied: deniedPath, positive: readablePath, bytesSha256: sha256(fs.readFileSync(deniedPath)),
    before: { denied: fileIdentity(deniedPath), positive: fileIdentity(readablePath) } };

  const original = await launchHolder("original-exact", ORIGINAL_HOLDER, deniedPath);
  report.variants.original = { holder: original.record, readySnapshot: liveSnapshot(original), mechanism: "exact release-test script; no script-level disposal marker" };
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  report.variants.original.afterEventLoop = liveSnapshot(original);
  if (report.variants.original.afterEventLoop.live) report.variants.original.reads = await compareWhileHeld(original, deniedPath, readablePath);
  else report.variants.original.reads = "skipped: holder exited before comparisons";
  await reap(original);
  report.variants.original.afterRelease = liveSnapshot(original);

  if (!report.variants.original.afterEventLoop.live) {
    const acknowledgement = await launchHolder("acknowledgement-variant", ACK_HOLDER, deniedPath);
    report.variants.acknowledgement = { holder: acknowledgement.record, readySnapshot: liveSnapshot(acknowledgement), mechanism: "separate explicit RELEASE acknowledgement and DISPOSED markers" };
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    report.variants.acknowledgement.afterEventLoop = liveSnapshot(acknowledgement);
    report.variants.acknowledgement.reads = await compareWhileHeld(acknowledgement, deniedPath, readablePath);
    await reap(acknowledgement, "RELEASE");
    report.variants.acknowledgement.afterRelease = liveSnapshot(acknowledgement);
  }
  report.fixture.after = { denied: fileIdentity(deniedPath), positive: fileIdentity(readablePath), deniedNodeRead: nodeRead(deniedPath) };
  for (const key of ["denied", "positive"]) {
    const before = report.fixture.before[key];
    const after = report.fixture.after[key];
    if (!after.regular || before.dev !== after.dev || before.ino !== after.ino) throw new Error(`${key}: regular-file identity changed`);
  }
}

try {
  await run();
} catch (error) {
  report.primaryError = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const handle of handles.slice().reverse()) {
    if (!handle.closeObserved) {
      try { await reap(handle, handle.record.label === "acknowledgement-variant" ? "RELEASE" : null); }
      catch (error) { report.cleanupErrors.push(String(error)); process.exitCode = 1; }
    }
  }
  if (fixture) {
    if (handles.every((handle) => handle.closeObserved)) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(`fixture cleanup: ${String(error)}`); process.exitCode = 1; }
    } else {
      report.cleanupErrors.push("fixture retained because an owned holder was not reaped");
      process.exitCode = 1;
    }
  }
  report.children = handles.map((handle) => handle.record);
  if (reportPath && path.isAbsolute(reportPath)) {
    try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); }
    catch (error) { process.stderr.write(`diagnostic report write failed: ${String(error)}\n`); process.exitCode = 1; }
  }
}
