// Task 1202: native Windows evidence for the resolve.test.ts ACL fixture prerequisite.
// Diagnostic only. All ACL writes stay on files created under one disposable test box.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { winPrivateStorage } from "../../dist/src/session/private-storage.js";
import { dropBox, makeBox, plantClaude } from "../../dist/tests/context-handoff/harness.js";

const report = { schema: 1, diagnostic: "1202-windows-acl", platform: process.platform, cases: [], cleanup: [] };
const output = process.argv[2];
if (!output || process.platform !== "win32") throw new Error("usage: node windows-acl-1202.mjs <report.json> on Windows");

const b = makeBox();
const tool = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const owned = new Map();
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rel = (file) => path.relative(b.base, file).replaceAll("\\", "/");
const clean = (value) => String(value ?? "").replaceAll(b.base, "<owned-root>").replaceAll(b.base.toLowerCase(), "<owned-root>");
const bridgeUrl = new URL("../../dist/src/session/private-storage.js", import.meta.url).href;
const ordinaryReadScript = String.raw`
$lines = [Console]::In.ReadToEnd().Split([char]10)
for ($i = 0; $i -lt 2; $i++) {
  $stream = $null
  try {
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($lines[$i].Trim()))
    $stream = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $n = $stream.ReadByte()
    $count = [int]($n -ne -1)
    [Console]::Out.WriteLine($i.ToString() + ' ok ' + $count.ToString())
  } catch {
    $x = $_.Exception
    while ($null -ne $x.InnerException) { $x = $x.InnerException }
    $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x.Message))
    [Console]::Out.WriteLine($i.ToString() + ' err ' + $x.GetType().FullName + ' ' + $x.HResult + ' ' + $message)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}
`;

// A fresh Node child starts with built-ins only. The product mode observes the same file
// before and after the source's read-only currentPrincipal/readSecurity operations.
const childSource = String.raw`
import fs from "node:fs";
const [mode, denied, positive, bridge] = process.argv.slice(1);
if (!["builtins", "product"].includes(mode)) throw new Error("invalid fixed diagnostic mode");
function observe(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
    return { outcome: "ok", bytes: fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) };
  } catch (e) {
    return { outcome: "error", code: e.code ?? null, errno: e.errno ?? null, syscall: e.syscall ?? null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const result = { mode, before: { denied: observe(denied), positive: observe(positive) } };
if (mode === "product") {
  try {
    const { winPrivateStorage } = await import(bridge);
    result.operation = {
      principal: winPrivateStorage.currentPrincipal(),
      security: winPrivateStorage.readSecurity([{ path: denied, kind: "file" }])[0],
    };
  } catch (e) {
    result.operation = { error: { name: e.name ?? "Error", message: String(e.message ?? "") } };
  }
  result.after = { denied: observe(denied), positive: observe(positive) };
}
process.stdout.write(JSON.stringify(result));
`;

function freshChild(mode, denied, positive) {
  const argv = ["--input-type=module", "-e", childSource, mode, denied, positive, bridgeUrl];
  const r = spawnSync(process.execPath, argv, {
    encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
  });
  const result = {
    executable: process.execPath, argv, status: r.status, signal: r.signal,
    error: r.error?.code ?? null, stderr: r.stderr ?? "",
  };
  try { result.observation = JSON.parse(r.stdout ?? ""); }
  catch { result.stdout = r.stdout ?? ""; process.exitCode = 1; }
  if (r.status !== 0 || result.observation?.mode !== mode ||
      result.observation?.before?.positive?.outcome !== "ok" ||
      (mode === "product" && (result.observation?.operation?.error || result.observation?.after?.positive?.outcome !== "ok"))) {
    process.exitCode = 1;
  }
  return result;
}

function invoke(label, args) {
  const r = spawnSync(tool, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const result = {
    label, executable: tool, argv: args,
    status: r.status, signal: r.signal, error: r.error?.code ?? null,
    stdout: r.stdout ?? "", stderr: r.stderr ?? "",
  };
  return result;
}

function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  return { relativePath: rel(file), dev: String(s.dev), ino: String(s.ino), size: String(s.size) };
}

function acl(file) {
  // This is the same Windows primitive exposed to the test through private-storage.ts.
  return winPrivateStorage.readSecurity([{ path: file, kind: "file" }])[0];
}

function read(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
    const bytes = fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return { outcome: "ok", bytes };
  } catch (e) {
    return { outcome: "error", code: e.code ?? null, errno: e.errno ?? null, syscall: e.syscall ?? null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ownedFile(file) {
  const relative = path.win32.relative(b.base, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error("ordinary read target escapes the owned fixture box");
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ordinary read target is not an owned regular file");
  return file;
}

function ordinaryPowerShellRead(denied, positive) {
  const sr = process.env.SystemRoot;
  // readSecurity() above already validated SystemRoot and this fixed tool path.
  const executable = path.win32.join(sr, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("source-resolved PowerShell path is not a regular file");
  }
  const targets = [ownedFile(denied), ownedFile(positive)];
  const input = targets.map((file) => Buffer.from(file, "utf8").toString("base64")).join("\n") + "\n";
  const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ordinaryReadScript];
  const env = {
    SystemRoot: sr, WINDIR: sr,
    PSModulePath: path.win32.join(sr, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  };
  for (const key of ["TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  const r = spawnSync(executable, argv, {
    input, env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
  });
  const result = {
    executable, argv, targets: targets.map(rel), status: r.status, signal: r.signal,
    error: r.error?.code ?? null, stderr: r.stderr ?? "", stdout: r.stdout ?? "",
  };
  const lines = (r.stdout ?? "").trim().split(/\r?\n/);
  result.observations = lines.map((line) => {
    const ok = /^([01]) ok ([01])$/.exec(line);
    if (ok) return { index: Number(ok[1]), outcome: "ok", bytes: Number(ok[2]) };
    const error = /^([01]) err ([A-Za-z0-9_.]+) (-?\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
    if (error) return {
      index: Number(error[1]), outcome: "error", type: error[2], hresult: Number(error[3]),
      message: Buffer.from(error[4], "base64").toString("utf8"),
    };
    return { outcome: "invalid", line };
  });
  if (r.status !== 0 || result.observations.length !== 2 || result.observations[0].index !== 0 ||
      result.observations[1].index !== 1 || result.observations[1].outcome !== "ok" ||
      result.observations[1].bytes !== 1) process.exitCode = 1;
  return result;
}

function caseFile(label, file, denyArgs, sid) {
  const item = { label, before: { identity: identity(file), acl: acl(file), read: read(file) } };
  report.cases.push(item);
  item.icaclsBefore = invoke(`${label}: inspect before`, [file]);
  const priorDeny = item.before.acl.status === "ok" && item.before.acl.dacl?.some((ace) => ace.type === 1 && ace.sid === sid);
  if (priorDeny || item.before.acl.status !== "ok") throw new Error(`${label}: cannot establish an initially deny-free owned file`);
  owned.set(file, sid); // A nonzero icacls status can still leave a partial ACL write.
  item.deny = invoke(`${label}: deny`, [file, ...denyArgs]);
  item.after = { identity: identity(file), acl: acl(file), read: read(file) };
  item.icaclsAfter = invoke(`${label}: inspect after`, [file]);
}

function runCase(label, file, denyArgs, sid) {
  try { caseFile(label, file, denyArgs, sid); }
  catch (e) {
    const item = report.cases.find((entry) => entry.label === label) ?? { label };
    if (!report.cases.includes(item)) report.cases.push(item);
    item.error = { name: e.name ?? "Error", message: clean(e.message) };
    process.exitCode = 1;
  }
}

try {
  const p = plantClaude(b, { last: new Date() });
  const canonical = path.join(path.dirname(p.file), "canonical-control.jsonl");
  const readData = path.join(path.dirname(p.file), "read-data-variant.jsonl");
  const childFile = path.join(path.dirname(p.file), "fresh-child-comparison.jsonl");
  const positive = path.join(path.dirname(p.file), "readable-control.jsonl");
  fs.copyFileSync(p.file, canonical);
  fs.copyFileSync(p.file, readData);
  fs.copyFileSync(p.file, childFile);
  fs.copyFileSync(p.file, positive);
  report.fixture = {
    root: "private test box", baseline: rel(p.file), canonical: rel(canonical), readDataVariant: rel(readData),
    childComparison: rel(childFile), positive: rel(positive),
    sha256: sha256(p.file), sameBytes: [canonical, readData, childFile, positive].every((file) => sha256(p.file) === sha256(file)),
  };
  if (!report.fixture.sameBytes) throw new Error("control files differ from baseline transcript");
  report.fixture.acl = {
    root: winPrivateStorage.readSecurity([{ path: b.base, kind: "directory" }])[0],
    home: winPrivateStorage.readSecurity([{ path: b.home, kind: "directory" }])[0],
  };
  report.positive = { identity: identity(positive), acl: acl(positive), read: read(positive) };
  report.positive.icacls = invoke("readable control: inspect", [positive]);

  const principal = winPrivateStorage.currentPrincipal();
  report.principal = principal; // Actual source path; no account name or token dump.
  if (principal.status !== "ok") throw new Error(`currentPrincipal: ${principal.code}`);
  const sid = `*${principal.userSid}`;

  // Exact resolve.test.ts helper argv, including /q, on the planted transcript.
  runCase("original helper and caller", p.file, ["/deny", `${sid}:(R)`, "/q"], principal.userSid);
  // Direct canonical icacls call on a separate same-byte synthetic file, without /q.
  runCase("direct canonical control", canonical, ["/deny", `${sid}:(R)`], principal.userSid);
  // Proposed narrower right, diagnostic variant only; no production test change.
  runCase("read-data diagnostic variant", readData, ["/deny", `${sid}:(RD)`], principal.userSid);
  // One additional same-byte file, exact original deny, two fresh Node processes.
  runCase("fresh child comparison", childFile, ["/deny", `${sid}:(R)`, "/q"], principal.userSid);
  const comparison = report.cases.find((item) => item.label === "fresh child comparison");
  const exactDeny = comparison?.after?.acl.status === "ok" &&
    comparison.after.acl.dacl?.some((ace) => ace.type === 1 && ace.sid === principal.userSid && (ace.mask & 1) === 1);
  if (exactDeny) {
    comparison.children = {
      builtinsOnly: freshChild("builtins", childFile, positive),
      productBridge: freshChild("product", childFile, positive),
    };
    comparison.afterChildren = { identity: identity(childFile), acl: acl(childFile), read: read(childFile) };
    comparison.ordinaryRead = {
      before: {
        denied: { identity: identity(childFile), acl: acl(childFile), read: read(childFile) },
        positive: { identity: identity(positive), acl: acl(positive), read: read(positive) },
      },
      powershell: ordinaryPowerShellRead(childFile, positive),
      after: {
        denied: { identity: identity(childFile), acl: acl(childFile), read: read(childFile) },
        positive: { identity: identity(positive), acl: acl(positive), read: read(positive) },
      },
    };
  } else if (comparison) {
    comparison.childrenSkipped = "exact user read-data deny ACE was not observed";
    process.exitCode = 1;
  }
} catch (e) {
  report.error = { name: e.name ?? "Error", message: clean(e.message) };
  process.exitCode = 1;
} finally {
  for (const [file, sid] of owned) {
    const item = { path: rel(file), command: invoke("cleanup: remove exact deny ACE", [file, "/remove:d", `*${sid}`, "/q"]) };
    try { item.aclAfter = acl(file); } catch (e) { item.error = clean(e.message); }
    report.cleanup.push(item);
    if (item.command.status !== 0) process.exitCode = 1;
  }
  try { dropBox(b); report.cleanup.push({ ownedBoxRemoved: true }); }
  catch (e) { report.cleanup.push({ ownedBoxRemoved: false, error: clean(e.message) }); process.exitCode = 1; }
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (report.positive?.read.outcome !== "ok") process.exitCode = 1;
}
