// #1167 R4 follow-up — why does one Windows PowerShell read batch of bin/lib/win-private-storage.mjs
// take ~23 s on windows-latest (`[probe R4] p50=22878ms`) while whoami/icacls with the same spawn
// helper take 21-87 ms? A diagnostic CI probe: it never fails on timing, it asserts only that every
// measured variant produced correct output. Off win32 it registers one passing "win32 only" test.
//
// Output: one `# [ps-latency] <variant> p50=…ms min=…ms max=…ms n=…` line per variant, plus
// `# [ps-latency] info …` lines (inherited variable names, module-analysis cache state) and
// `# [ps-latency] alt …` lines for the two non-PowerShell readers (icacls /save, WSH + WMI).
// Variants change ONE thing against the module's own invocation (`constructed|script`): the
// environment (inherited, constructed + one variable, PSModulePath variants), the command
// (`-Command 1` versus the real SCRIPT, SCRIPT without the New-Object cmdlet), stdin, the execution
// policy, and the stages inside the script. `module …` rows call readSecurity() end to end: the
// module as built, and a temporary copy with the candidate constant PS_NO_CMDLET switched on.
// Samples are taken round-robin (every variant once, then again, up to 3) inside a 17-minute
// budget, because the lane job is capped at 25 minutes; an unmeasured variant prints NOT_MEASURED.
//
// Acceptance of the module candidate (PS_NO_CMDLET = true) from ONE windows-latest run:
//   1. `module readSecurity [candidate PS_NO_CMDLET]` p50 < 1500 ms with n = 3 and no failure, AND
//   2. `module readSecurity [as built]` still reproduces the defect in the same run (p50 > 10000 ms),
//      so the difference is attributable, AND
//   3. `stage[constructed]:2-first-New-Object` carries most of the as-built time (the cause is the
//      cmdlet autoload, not process start-up).
// Then flip PS_NO_CMDLET to true and run the lane with dist/tests/session/private-storage.test.js:
// 18/18 pass and `[probe R4]` p50 < 1500 ms. Other outcomes: a `constructed+<X>|script` row under
// 1500 ms while the candidate stays slow names the variable start-up needs (pass exactly that one);
// `inherited|trivial` over 1500 ms means PowerShell itself is slow on the runner (fallback reader).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE = fileURLToPath(new URL("../../bin/lib/win-private-storage.mjs", import.meta.url));

if (process.platform !== "win32") {
  test("win32 only: the PowerShell latency probe has nothing to measure on this platform", () => {
    assert.notEqual(process.platform, "win32");
  });
} else {
  const win = path.win32;
  const SR = process.env.SystemRoot ?? "";
  const PS = win.join(SR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ICACLS = win.join(SR, "System32", "icacls.exe");
  const CSCRIPT = win.join(SR, "System32", "cscript.exe");
  const PS_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
  const SAMPLES = 3;
  const BUDGET_MS = 17 * 60_000;
  const TIMEOUT = 60_000;
  const FULL = 2032127;
  const SOURCE = readFileSync(MODULE, "utf8");
  const mod = await import(pathToFileURL(MODULE).href);
  const base = realpathSync.native(mkdtempSync(win.join(tmpdir(), "ps-latency-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  // The module's SCRIPT literals and spawn shape, read from its source so the probe cannot drift.
  const literal = (name) => {
    const m = new RegExp(`^const ${name} = (".*");$`, "m").exec(SOURCE);
    assert.ok(m, `module constant ${name} not found`);
    return JSON.parse(m[1]);
  };
  for (const line of [
    'const env = { SystemRoot: tools.sr, WINDIR: tools.sr };',
    'env.PSModulePath = win.join(tools.sr, "System32", "WindowsPowerShell", "v1.0", "Modules");',
    'for (const key of ["TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"]) {',
    'shell: false, windowsHide: true, timeout, maxBuffer: MAX_BUFFER, encoding: "latin1",',
    '["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_NO_CMDLET ? SCRIPT_NO_CMDLET : SCRIPT]',
    "const PS_NO_CMDLET = false;",
  ]) assert.ok(SOURCE.includes(line), `the probe replicates the module invocation; the module changed: ${line}`);
  const SCRIPT = literal("SCRIPT");
  const SCRIPT_NO_CMDLET = literal("SCRIPT_NO_CMDLET");

  const getEnv = (key) => process.env[key]; // case-insensitive on win32
  const constructed = () => {
    const env = { SystemRoot: SR, WINDIR: SR, PSModulePath: win.join(SR, "System32", "WindowsPowerShell", "v1.0", "Modules") };
    for (const key of ["TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"]) if (typeof getEnv(key) === "string") env[key] = getEnv(key);
    return env;
  };
  const inherited = () => ({ ...process.env });
  const withoutKey = (env, key) => {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== key.toUpperCase()) out[k] = v;
    return out;
  };
  const CONSTRUCTED_PATH = [win.join(SR, "System32"), SR, win.join(SR, "System32", "Wbem"), win.join(SR, "System32", "WindowsPowerShell", "v1.0")].join(";");

  let who = null;
  let redact = (s) => s;
  const pct50 = (xs) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length / 2) - 1)];
  const row = (name, xs, extra = "") => (xs.length === 0
    ? `[ps-latency] ${name} NOT_MEASURED${extra}`
    : `[ps-latency] ${name} p50=${pct50(xs).toFixed(0)}ms min=${Math.min(...xs).toFixed(0)}ms max=${Math.max(...xs).toFixed(0)}ms n=${xs.length}${extra}`);
  const snippet = (r) => redact(`${r.stdout ?? ""}|${r.stderr ?? ""}`.replace(/\s+/g, " ").slice(0, 300));

  const privDir = (name) => {
    const dir = win.join(base, name);
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(mod.setPrivate(dir, "directory"), { status: "ok" }, `setPrivate(${name})`);
    const file = win.join(dir, "f.txt");
    writeFileSync(file, "x");
    return { dir, file, absent: win.join(base, `${name}-absent`) };
  };
  const toolPath = (p) => (p.length >= 248 ? path.toNamespacedPath(p) : p);
  const b64 = (p) => Buffer.from(toolPath(p), "utf8").toString("base64");
  const hex16 = (p) => Array.from({ length: p.length }, (_, i) => p.charCodeAt(i).toString(16).padStart(4, "0")).join("");

  // Correct read-back for [private dir, file inside it, absent path] in the module grammar. `absent`
  // is the accepted error-name pattern of line 2. Returns null when correct, else the reason.
  function checkRead(stdout, absent = /^(FileNotFoundException|DirectoryNotFoundException)$/) {
    if (!stdout.endsWith("\n")) return "output does not end in a newline";
    const lines = stdout.slice(0, -1).split("\n").map((l) => l.replace(/\r$/, ""));
    if (lines.length !== 3) return `expected 3 lines, got ${lines.length}`;
    const sid = who.userSid;
    const d = /^0 ok (S-1-[\d-]+) (\d+) (\S+)$/.exec(lines[0]);
    if (!d || d[1] !== sid || (Number(d[2]) & 0x1004) !== 0x1004 || d[3] !== `0:3:${FULL}:${sid}`) return `directory line: ${lines[0]}`;
    const f = /^1 ok (S-1-[\d-]+) (\d+)((?: \S+)+)$/.exec(lines[1]);
    if (!f || ![sid, "S-1-5-32-544"].includes(f[1]) || !f[3].slice(1).split(" ").every((a) => a === `0:16:${FULL}:${sid}`)) return `file line: ${lines[1]}`;
    const a = /^2 err (\S+) (-?\d+)$/.exec(lines[2]);
    if (!a || !absent.test(a[1])) return `absent line: ${lines[2]}`;
    return null;
  }

  test("win32: non-PowerShell readers — icacls /save and Windows Script Host + WMI (timing and returned data)", (t) => {
    who = mod.currentPrincipal();
    assert.equal(who.status, "ok", `currentPrincipal: ${JSON.stringify(who)}`);
    redact = (s) => s.split(who.userSid).join("<user>");
    const sets = { plain: privDir("alt"), unicode: privDir("alt-é世😀") };
    let long = win.join(base, "long-é世😀");
    for (let i = 0; long.length < 300; i++) long = win.join(long, `${String(i).padStart(2, "0")}-${"x".repeat(56)}`);
    sets[`long${long.length}`] = privDir(win.relative(base, long));
    const minimal = { SystemRoot: SR, WINDIR: SR };
    const opts = (env, input) => ({ shell: false, windowsHide: true, timeout: TIMEOUT, encoding: "latin1", env, ...(input === undefined ? {} : { input }) });

    // icacls /save: DACL only (SDDL `D:` text with protected/auto-inherited flags); no owner.
    const saveFile = win.join(base, "acl-save.txt");
    for (const [label, set] of Object.entries(sets)) {
      const xs = [];
      let shown = "";
      for (let i = 0; i < (label === "plain" ? SAMPLES : 1); i++) {
        rmSync(saveFile, { force: true });
        const t0 = performance.now();
        const r = spawnSync(ICACLS, [toolPath(set.dir), "/save", saveFile, "/q"], opts(minimal));
        xs.push(performance.now() - t0);
        if (r.error || r.status !== 0) { shown = `FAILED ${r.error?.code ?? `exit ${r.status}`} ${snippet(r)}`; continue; }
        let bytes = readFileSync(saveFile);
        if (bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.subarray(2);
        const lines = bytes.toString("utf16le").split(/\r?\n/).filter((l) => l !== "");
        shown = `lines=${lines.length} sddl=${redact(lines[1] ?? "")}`;
      }
      t.diagnostic(`${row(`alt icacls-save[${label}]`, xs)} returns: ${shown}`);
    }

    // Windows Script Host + WMI: owner SID, control flags, DACL ACEs with SID strings, in the module
    // grammar. Paths travel on stdin as hex UTF-16 code units (ASCII stdin, Unicode-safe).
    const js = win.join(base, "wmi-sd.js");
    writeFileSync(js, String.raw`var NL = String.fromCharCode(10);
var input = WScript.StdIn.AtEndOfStream ? "" : WScript.StdIn.ReadAll();
var lines = input.split(NL);
var svc = GetObject("winmgmts:{impersonationLevel=impersonate}!//./root/cimv2");
for (var n = 0; n < lines.length; n++) {
  var t = lines[n].replace(/\r$/, "").split(" ");
  if (t.length != 3) continue;
  var p = "";
  for (var k = 0; k + 4 <= t[2].length; k += 4) p += String.fromCharCode(parseInt(t[2].substr(k, 4), 16));
  var w;
  try {
    var o = svc.Get("Win32_LogicalFileSecuritySetting.Path='" + p.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'");
    var r = o.ExecMethod_("GetSecurityDescriptor");
    if (r.ReturnValue != 0) {
      w = t[0] + " err WmiReturnValue " + r.ReturnValue;
    } else {
      var d = r.Descriptor;
      w = t[0] + " ok " + d.Owner.SIDString + " " + d.ControlFlags;
      if (d.DACL == null) w += " null";
      else {
        var a = new VBArray(d.DACL).toArray();
        for (var i = 0; i < a.length; i++) w += " " + a[i].AceType + ":" + a[i].AceFlags + ":" + a[i].AccessMask + ":" + a[i].Trustee.SIDString;
      }
    }
  } catch (e) {
    w = t[0] + " err WmiError " + (e.number | 0);
  }
  WScript.StdOut.WriteLine(w);
}
`, "ascii");
    const wmiRuns = [["plain", "constructed", minimal, SAMPLES], ["plain", "inherited", inherited(), 1]];
    for (const label of Object.keys(sets)) if (label !== "plain") wmiRuns.push([label, "constructed", minimal, 1]);
    for (const [label, envName, env, n] of wmiRuns) {
      const set = sets[label];
      const input = `0 d ${hex16(set.dir)}\n1 f ${hex16(set.file)}\n2 d ${hex16(set.absent)}\n`;
      const xs = [];
      let shown = "";
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = spawnSync(CSCRIPT, ["//nologo", "//E:JScript", js], opts(env, input));
        xs.push(performance.now() - t0);
        if (r.error || r.status !== 0) { shown = `FAILED ${r.error?.code ?? `exit ${r.status}`} ${snippet(r)}`; continue; }
        const bad = checkRead(r.stdout, /^Wmi\w+$/);
        shown = `match=${bad === null ? "yes" : `no(${redact(bad)})`} lines=${redact(r.stdout.trim().split(/\r?\n/).join(" | "))}`;
      }
      t.diagnostic(`${row(`alt wsh-wmi[${label},${envName}]`, xs)} returns: ${shown}`);
    }
  });

  test("win32: PowerShell read-back latency matrix (diagnostic; asserts correct output only)", async (t) => {
    assert.ok(who && who.status === "ok", "the alternatives test resolves the principal first");
    const set = privDir("matrix");
    const input = `0 d ${b64(set.dir)}\n1 f ${b64(set.file)}\n2 d ${b64(set.absent)}\n`;
    const items = [{ path: set.dir, kind: "directory" }, { path: set.file, kind: "file" }, { path: set.absent, kind: "directory" }];

    // The candidate: a copy of the module with PS_NO_CMDLET switched on (the module imports only node: built-ins).
    assert.equal(SOURCE.split("const PS_NO_CMDLET = false;").length, 2);
    const candidatePath = win.join(base, "candidate-win-private-storage.mjs");
    writeFileSync(candidatePath, SOURCE.replace("const PS_NO_CMDLET = false;", "const PS_NO_CMDLET = true;"));
    const candidate = await import(pathToFileURL(candidatePath).href);

    const now = "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()";
    const STAGE = `[Console]::Out.WriteLine('M start '+${now});$null=New-Object System.Object;` +
      `[Console]::Out.WriteLine('M cmdlet '+${now});${SCRIPT};[Console]::Out.WriteLine('M end '+${now})`;

    // kind: script (SCRIPT-like output for the 3 items), trivial (`1`), empty (no stdin, no output), stage.
    function raw(env, command, kind, { stdin = kind !== "trivial", bypass = false } = {}) {
      const args = [...PS_ARGS.slice(0, 3), ...(bypass ? ["-ExecutionPolicy", "Bypass"] : []), PS_ARGS[3], command];
      const w0 = Date.now();
      const t0 = performance.now();
      const r = spawnSync(PS, args, {
        shell: false, windowsHide: true, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, encoding: "latin1", env,
        ...(stdin ? { input } : {}),
      });
      const ms = performance.now() - t0;
      const w1 = Date.now();
      if (r.error) return { ms, error: `${r.error.code ?? r.error.message} ${snippet(r)}` };
      if (r.status !== 0) return { ms, error: `exit ${r.status} ${snippet(r)}` };
      if (kind === "trivial") return { ms, error: r.stdout.trim() === "1" ? null : `stdout ${snippet(r)}` };
      if (kind === "empty") return { ms, error: r.stdout === "" ? null : `stdout ${snippet(r)}` };
      let out = r.stdout;
      let stages;
      if (kind === "stage") {
        const marks = {};
        out = out.split("\n").filter((l) => {
          const m = /^M (start|cmdlet|end) (\d+)\r?$/.exec(l);
          if (m) marks[m[1]] = Number(m[2]);
          return !m;
        }).join("\n");
        if (!(marks.start && marks.cmdlet && marks.end)) return { ms, error: `stage markers missing ${snippet(r)}` };
        stages = {
          "1-process-start-to-first-statement": marks.start - w0,
          "2-first-New-Object": marks.cmdlet - marks.start,
          "3-stdin-and-items": marks.end - marks.cmdlet,
          "4-last-statement-to-exit": w1 - marks.end,
        };
      }
      const bad = checkRead(out);
      return { ms, error: bad === null ? null : redact(bad), stages };
    }
    function e2e(module) {
      return () => {
        const t0 = performance.now();
        const r = module.readSecurity(items);
        const ms = performance.now() - t0;
        const [d, f, a] = r;
        const ok = d.status === "ok" && d.ownerSid === who.userSid && (d.control & 0x1004) === 0x1004 &&
          JSON.stringify(d.dacl) === JSON.stringify([{ type: 0, flags: 3, mask: FULL, sid: who.userSid }]) &&
          f.status === "ok" && f.dacl.length > 0 && f.dacl.every((x) => x.type === 0 && x.sid === who.userSid) &&
          a.status === "error" && a.code === "missing";
        return { ms, error: ok ? null : redact(JSON.stringify(r)) };
      };
    }

    const C = constructed;
    const plus = (extra) => () => ({ ...C(), ...extra });
    const pick = (...keys) => Object.fromEntries(keys.filter((k) => typeof getEnv(k) === "string").map((k) => [k, getEnv(k)]));
    const listed = ["APPDATA", "HOMEDRIVE", "HOMEPATH", "ProgramData", "ALLUSERSPROFILE", "SystemDrive", "PROCESSOR_ARCHITECTURE",
      "COMPUTERNAME", "USERNAME", "USERDOMAIN"];
    const variants = [
      ["inherited|trivial", inherited, "1", "trivial"],
      ["constructed|trivial", C, "1", "trivial"],
      ["inherited|script", inherited, SCRIPT, "script"],
      ["constructed|script", C, SCRIPT, "script"],
      ["constructed|script-no-cmdlet", C, SCRIPT_NO_CMDLET, "script"],
      ["module readSecurity [as built]", e2e(mod)],
      ["module readSecurity [candidate PS_NO_CMDLET]", e2e(candidate)],
      ["stage[constructed]", C, STAGE, "stage"],
      ["stage[inherited]", inherited, STAGE, "stage"],
      ["constructed+PSModuleAnalysisCachePath|script", plus(pick("PSModuleAnalysisCachePath")), SCRIPT, "script", ["PSModuleAnalysisCachePath"]],
      ["constructed PSModulePath=inherited|script", plus(pick("PSModulePath")), SCRIPT, "script", ["PSModulePath"]],
      ["constructed PSModulePath unset|script", () => withoutKey(C(), "PSModulePath"), SCRIPT, "script"],
      ["constructed PSModulePath=ProgramFiles+System32|script", plus({ PSModulePath: `${win.join(getEnv("ProgramFiles") ?? "", "WindowsPowerShell", "Modules")};${C().PSModulePath}` }), SCRIPT, "script", ["ProgramFiles"]],
      ["inherited PSModulePath=constructed|script", () => ({ ...withoutKey(inherited(), "PSModulePath"), PSModulePath: C().PSModulePath }), SCRIPT, "script"],
      ["constructed+Path(constructed)|script", plus({ Path: CONSTRUCTED_PATH }), SCRIPT, "script"],
      ["constructed+Path(inherited)|script", plus(pick("Path")), SCRIPT, "script", ["Path"]],
      ["constructed+HOMEDRIVE+HOMEPATH|script", plus(pick("HOMEDRIVE", "HOMEPATH")), SCRIPT, "script", ["HOMEDRIVE", "HOMEPATH"]],
      ...["APPDATA", "ProgramData", "ALLUSERSPROFILE", "SystemDrive", "PROCESSOR_ARCHITECTURE", "COMPUTERNAME", "USERNAME", "USERDOMAIN"]
        .map((k) => [`constructed+${k}|script`, plus(pick(k)), SCRIPT, "script", [k]]),
      ["constructed+all-listed+Path(inherited)|script", plus(pick(...listed, "Path")), SCRIPT, "script", listed],
      ["constructed|script-without-stdin", C, SCRIPT, "empty", undefined, { stdin: false }],
      ["constructed|trivial-with-stdin", C, "1", "trivial", undefined, { stdin: true }],
      ["constructed|script -ExecutionPolicy Bypass", C, SCRIPT, "script", undefined, { bypass: true }],
      ["constructed|trivial -ExecutionPolicy Bypass", C, "1", "trivial", undefined, { bypass: true }],
    ].map(([name, envOrRun, command, kind, needs, options]) => {
      const absent = (needs ?? []).filter((k) => typeof getEnv(k) !== "string");
      return {
        name, samples: [], errors: [], stages: {},
        skip: needs && absent.length === needs.length ? `NOT_APPLICABLE (absent in the parent environment: ${absent.join(",")})` : null,
        note: absent.length > 0 && absent.length < (needs ?? []).length ? ` (absent: ${absent.join(",")})` : "",
        run: command === undefined ? envOrRun : () => raw(envOrRun(), command, kind, options),
      };
    });

    const cacheFiles = [win.join(getEnv("LOCALAPPDATA") ?? "", "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache")];
    if (typeof getEnv("PSModuleAnalysisCachePath") === "string") cacheFiles.push(getEnv("PSModuleAnalysisCachePath"));
    const cacheState = () => cacheFiles.map((f) => {
      if (!existsSync(f)) return `${f}: absent`;
      const st = statSync(f);
      return `${f}: ${st.size} bytes mtime=${st.mtime.toISOString()}`;
    }).join("; ");
    const keys = Object.keys(process.env).sort((a, b) => a.localeCompare(b));
    const constructedKeys = new Set(Object.keys(C()).map((k) => k.toUpperCase()));
    t.diagnostic(`[ps-latency] info node=${process.version} powershell=${PS} inherited-names=${keys.join(",")}`);
    t.diagnostic(`[ps-latency] info inherited-not-constructed=${keys.filter((k) => !constructedKeys.has(k.toUpperCase())).join(",")}`);
    t.diagnostic(`[ps-latency] info PSModulePath(inherited)=${getEnv("PSModulePath") ?? "<unset>"} PSModuleAnalysisCachePath=${getEnv("PSModuleAnalysisCachePath") ?? "<unset>"}`);
    t.diagnostic(`[ps-latency] info analysis-cache before: ${cacheState()}`);

    const started = performance.now();
    let budgetHit = false;
    for (let round = 0; round < SAMPLES && !budgetHit; round++) {
      for (const v of variants) {
        if (v.skip) continue;
        if (performance.now() - started > BUDGET_MS) { budgetHit = true; break; }
        const s = v.run();
        v.samples.push(s.ms);
        if (s.error) v.errors.push(s.error);
        for (const [k, ms] of Object.entries(s.stages ?? {})) (v.stages[k] ??= []).push(ms);
      }
    }

    t.diagnostic(`[ps-latency] info analysis-cache after: ${cacheState()}`);
    t.diagnostic(`[ps-latency] info matrix wall=${((performance.now() - started) / 1000).toFixed(0)}s budget=${BUDGET_MS / 1000}s budget-hit=${budgetHit}`);
    const failures = [];
    for (const v of variants) {
      if (v.skip) { t.diagnostic(`[ps-latency] ${v.name} ${v.skip}`); continue; }
      const fail = v.errors.length > 0 ? ` FAIL(${v.errors.length}): ${v.errors[0]}` : "";
      t.diagnostic(row(v.name, v.samples, `${v.note}${v.samples.length === 0 ? " (budget)" : ""}${fail}`));
      for (const [k, xs] of Object.entries(v.stages)) t.diagnostic(row(`${v.name}:${k}`, xs));
      if (v.errors.length > 0) failures.push(`${v.name}: ${v.errors[0]}`);
    }
    assert.deepEqual(failures, [], "every measured variant must produce correct output");
  });
}
