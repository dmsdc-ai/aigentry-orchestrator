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
  const positive = path.join(path.dirname(p.file), "readable-control.jsonl");
  fs.copyFileSync(p.file, canonical);
  fs.copyFileSync(p.file, readData);
  fs.copyFileSync(p.file, positive);
  report.fixture = {
    root: "private test box", baseline: rel(p.file), canonical: rel(canonical), readDataVariant: rel(readData), positive: rel(positive),
    sha256: sha256(p.file), sameBytes: [canonical, readData, positive].every((file) => sha256(p.file) === sha256(file)),
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
