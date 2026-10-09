// Task 1201 — the owner's acceptance tests (SPEC §9.1), as far as they run without a live CLI.
//
//   AT-1 no save step      (a) a HOME holding ONLY native transcripts yields a [would-handoff]
//                              block naming the newest one; (b) static: no exit/signal handler,
//                              no shell trap, no hook, no reconciler reference; (c) static: the
//                              compiled adapters open transcripts read-only and reach no write API.
//   AT-2 no instruction    NOTRUN here: live, owner machine, opt-in AIGENTRY_LIVE_HANDOFF=1 —
//        after restart     it needs the four real CLIs and a pty read of the first model reply.
//                          Procedure: docs/setup/orchestrator-boot.md §7.
//   AT-3 newest across     the 4×4 matrix (each CLI newest once × each CLI booted) through
//        any CLI           `bin/orchestrator-boot.sh --dry-run`, plus a fifth newer transcript in
//                          another cwd and the agy staleness warning.
//
// THE BOOT IS DRIVEN HERMETICALLY, exactly as tests/packaging/orchestrator-boot-wizard.test.mjs
// does it: a closed PATH (bash, sh, dirname, node and recorders), a temporary HOME, a fixture
// sid, and a recorder on every seam. `--dry-run` acts on nothing, and the exec/kill/curl
// recorders must stay empty.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CLIS,
  type Box,
  type Cli,
  ENGINE_DIST,
  REPO,
  at,
  dropBox,
  engineWs,
  makeBox,
  parseHandoff,
  plant,
  plantAgy,
} from "./harness.js";

const POSIX_ONLY = process.platform === "win32" && "NOTRUN on win32: bin/orchestrator-boot.sh is a POSIX shim; a native Windows boot is out of this release (SPEC §13)";
const SHIM = path.join(REPO, "bin", "orchestrator-boot.sh");
const SID = "fixture-1201";
const PERMISSION: Record<Cli, string> = {
  claude: "approval=manual",
  codex: "approval=on-request;sandbox=read-only",
  gemini: "approval=default;sandbox=on",
  grok: "approval=default;sandbox=strict",
};
// The argv tail each restrictive plan produces today (tests/dispatch/T134 block H).
const TAIL: Record<Cli, readonly string[]> = {
  claude: ["claude", "--permission-mode", "manual"],
  codex: ["codex", "--ask-for-approval", "on-request", "--sandbox", "read-only"],
  gemini: ["gemini", "--approval-mode", "default", "--sandbox"],
  grok: ["grok", "--permission-mode", "default", "--sandbox", "strict"],
};

interface Boot {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The `[would-handoff] ` lines, prefix removed: the composed handoff. */
  readonly handoff: string;
  readonly argv: readonly string[];
  readonly recorded: (kind: string) => string[];
}

function recorderBin(b: Box): { bin: string; logs: string } {
  const bin = path.join(b.base, "path");
  const logs = path.join(b.base, "logs");
  if (fs.existsSync(bin)) return { bin, logs };
  fs.mkdirSync(bin);
  fs.mkdirSync(logs);
  for (const real of ["/bin/bash", "/bin/sh", "/usr/bin/dirname"]) fs.symlinkSync(real, path.join(bin, path.basename(real)));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const rec = (name: string, kind: string, emit = ""): void => {
    fs.writeFileSync(path.join(bin, name),
      `#!${process.execPath}\nconst fs=require('node:fs');\n` +
      `fs.appendFileSync(${JSON.stringify(path.join(logs, `${kind}.log`))},JSON.stringify(process.argv.slice(2))+'\\n');\n${emit}`,
      { mode: 0o700 });
  };
  rec("ps-recorder", "ps");
  rec("telepty-list-recorder", "list", "process.stdout.write('[]');\n");
  rec("kill-recorder", "kill");
  rec("curl-recorder", "curl", "process.stdout.write('200');\n");
  rec("telepty", "exec");
  for (const p of CLIS) rec(p, p);
  return { bin, logs };
}

function dryRun(b: Box, cli: Cli, extra: Record<string, string> = {}): Boot {
  const { bin, logs } = recorderBin(b);
  for (const f of fs.readdirSync(logs)) fs.rmSync(path.join(logs, f));
  const r = spawnSync("/bin/bash", [SHIM, "--dry-run"], {
    cwd: b.ws,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: {
      PATH: bin, HOME: b.home, TMPDIR: b.base, AIGENTRY_HOME: path.join(b.base, "aigentry-home"),
      SINGLETON_PS_CMD: path.join(bin, "ps-recorder"), KILL_CMD: path.join(bin, "kill-recorder"),
      TELEPTY: path.join(bin, "telepty-list-recorder"), CURL: path.join(bin, "curl-recorder"),
      SINGLETON_SELF_PID: "9999", TELEPTY_PORT: "3848",
      AIGENTRY_BOOT_PLAN: "1", ORCHESTRATOR_CLI: cli, ORCHESTRATOR_SID: SID,
      AIGENTRY_BOOT_PERMISSION: PERMISSION[cli], AIGENTRY_BOOT_HISTORY: "new",
      ...extra,
    },
  });
  const stdout = r.stdout ?? "";
  const handoff = stdout.split("\n").flatMap((l) => {
    const m = /\[would-handoff\] ?(.*)$/.exec(l);
    return m === null ? [] : [m[1]];
  }).join("\n");
  const argv = stdout.split("\n").filter((l) => l.startsWith("[would-exec] ")).map((l) => l.slice("[would-exec] ".length));
  const recorded = (kind: string): string[] => {
    const f = path.join(logs, `${kind}.log`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  };
  return { status: r.status, stdout, stderr: r.stderr ?? "", handoff, argv, recorded };
}

function assertInert(boot: Boot, label: string): void {
  for (const k of ["exec", "kill", "curl", ...CLIS]) assert.deepEqual(boot.recorded(k), [], `${label}: the ${k} recorder fired`);
}

/** The delivery a booted CLI gets in this release (SPEC §6.2: only claude's content channel is measured). */
function assertDelivery(boot: Boot, booted: Cli, ws: string, label: string): void {
  const head = ["telepty", "allow", "--id", SID, "--auto-restart", ...TAIL[booted]];
  if (booted === "claude") {
    assert.deepEqual(boot.argv, [...head, "--append-system-prompt-file", path.join(engineWs(ws), "state", "handoff", "latest.md")], `${label}: claude's measured delivery tokens`);
  } else {
    assert.deepEqual(boot.argv, head, `${label}: an owed delivery contributes no tokens`);
    assert.ok(`${boot.stdout}\n${boot.stderr}`.includes(`handoff: ${booted} delivery unmeasured — backstop only (AGENTS.md)`), `${label}: the backstop line`);
  }
}

function sourceLine(boot: Boot): string {
  return parseHandoff(boot.handoff).header.find((l) => l.startsWith("source: ")) ?? "";
}

test("AT-1(a): a HOME with ONLY native transcripts → [would-handoff] names the newest; nothing is written", { skip: POSIX_ONLY }, (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("claude", b, { last: at(10) });
  const newest = plant("codex", b, { last: at(20) });
  const boot = dryRun(b, "claude");
  assert.equal(boot.status, 0, boot.stderr);
  assert.ok(sourceLine(boot).startsWith(`source: codex session ${newest.session}`), `source line: ${sourceLine(boot)}\n${boot.stdout}`);
  assert.match(boot.stdout, /\[dry-run\] handoff source: .*codex/);
  assert.deepEqual(fs.readdirSync(path.join(b.ws, "state")), [], "a dry run writes nothing (SPEC §6.3)");
  assertInert(boot, "AT-1(a)");
});

test("AT-3: 4×4 — the newest source is named whichever CLI boots; a newer other-cwd transcript is ignored", { skip: POSIX_ONLY }, (t) => {
  for (const [i, newest] of CLIS.entries()) {
    const b = makeBox();
    t.after(() => dropBox(b));
    const planted = CLIS.map((cli, j) => plant(cli, b, { last: at(newest === cli ? 40 : 10 + j) }));
    plant(CLIS[(i + 2) % 4], b, { last: at(90), cwd: path.join(b.base, "another-workspace") });
    for (const booted of CLIS) {
      const label = `newest=${newest} booted=${booted}`;
      const boot = dryRun(b, booted);
      assert.equal(boot.status, 0, `${label}: ${boot.stderr}`);
      assert.ok(sourceLine(boot).startsWith(`source: ${newest} session ${planted[i].session}`), `${label}: ${sourceLine(boot)}`);
      assertDelivery(boot, booted, b.ws, label);
      assertInert(boot, label);
    }
  }
});

test("AT-3: newer activity in the detect-only agy store puts the staleness warning in the handoff", { skip: POSIX_ONLY }, (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("gemini", b, { last: at(20) });
  plantAgy(b, at(30));
  const boot = dryRun(b, "gemini");
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.handoff, /newer activity in unmeasured .+ store — handoff may not be the latest/);
});

// ── AT-1(b), AT-1(c): static ────────────────────────────────────────────────

function walk(dir: string, keep: (f: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
  });
}

test("AT-1(b): no exit/signal handler, no trap, no hook, no reconciler reference (static half; the git-diff half is the controller's)", () => {
  const feature = [
    ...walk(path.join(REPO, "src", "context-handoff"), (f) => f.endsWith(".ts")),
    path.join(REPO, "bin", "context-handoff.mjs"),
    path.join(REPO, "bin", "context-handoff.sh"),
  ];
  for (const f of feature) assert.ok(fs.existsSync(f), `feature file missing: ${path.relative(REPO, f)}`);
  assert.ok(feature.length > 2, "src/context-handoff/** has no .ts file");
  const handler = /process\s*\.\s*(on|once|addListener|prependListener|prependOnceListener)\s*\(\s*["'`](exit|beforeExit|SIGTERM|SIGINT|SIGHUP)["'`]/;
  for (const f of [...feature, ...walk(path.join(REPO, "src", "orchestrator-boot"), (x) => x.endsWith(".ts"))]) {
    const text = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(text, handler, `${path.relative(REPO, f)} registers a shutdown/signal handler — a save step at exit`);
    if (f.endsWith(".sh")) assert.doesNotMatch(text, /^\s*trap\s/m, `${path.relative(REPO, f)} sets a shell trap`);
  }
  for (const f of [...walk(path.join(REPO, ".claude", "hooks"), () => true), path.join(REPO, ".claude", "settings.json")]) {
    if (fs.existsSync(f)) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /context-handoff|state\/handoff/, `${path.relative(REPO, f)} wires the handoff into a hook`);
  }
  for (const f of walk(path.join(REPO, "src", "reconciler"), (x) => x.endsWith(".ts"))) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /context-handoff/, `${path.relative(REPO, f)} references the handoff engine`);
  }
});

/** Relative-import closure of a compiled module, inside the engine's dist tree. */
function closure(start: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const dep = path.resolve(path.dirname(f), m[1]);
      if (dep.startsWith(ENGINE_DIST) && fs.existsSync(dep)) queue.push(dep);
    }
  }
  return [...seen];
}

/** The argument text of every `name(` call, balanced on parentheses. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const startArgs = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(startArgs, i - 1));
  }
  return out;
}

/** Split an argument list at top-level commas. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Replace identifiers that name a closure constant by its definition, a few levels deep. */
function expandConstants(expr: string, defs: ReadonlyMap<string, string>): string {
  let out = expr;
  for (let i = 0; i < 3; i++) out = out.replace(/(?<![\w$.])[A-Za-z_$][\w$]*/g, (id) => (defs.has(id) ? `(${defs.get(id)})` : id));
  return out;
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("AT-1(c): compiled adapters open transcripts read-only and reach no write API", () => {
  const adapters = walk(path.join(ENGINE_DIST, "adapters"), (f) => f.endsWith(".js"));
  assert.ok(adapters.length >= 5, `compiled adapters missing under ${path.join(ENGINE_DIST, "adapters")} (want claude, codex, gemini, grok, index)`);
  const reach = closure(adapters);
  assert.ok(!reach.some((f) => path.basename(f) === "write.js"), `an adapter reaches write.js: ${reach.map((f) => path.relative(ENGINE_DIST, f)).join(", ")}`);
  // `const|let|var NAME = …;` across the closure, so a flags constant defined in another module resolves.
  const defs = new Map<string, string>();
  for (const f of reach) {
    for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(/(?:^|[\s;])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);/g)) defs.set(m[1], m[2]);
  }
  const WRITE_API = /\b(writeFileSync|writeFile|appendFileSync|appendFile|writeSync|writev|writevSync|createWriteStream|mkdirSync|mkdtempSync|renameSync|unlinkSync|rmSync|rmdirSync|copyFileSync|cpSync|symlinkSync|linkSync|chmodSync|fchmodSync|chownSync|truncateSync|ftruncateSync|utimesSync|futimesSync)\s*\(/;
  for (const f of reach) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    const rel = path.relative(REPO, f);
    assert.doesNotMatch(src, WRITE_API, `${rel} calls a write API`);
    for (const a of callArgs(src, "openSync")) {
      // The flags argument, with named constants resolved to their definitions in the closure
      // (e.g. `READ_FLAGS = fs.constants.O_RDONLY | …`). No flags argument means node's "r".
      const flags = expandConstants(topLevelArgs(a)[1] ?? `"r"`, defs);
      assert.match(flags, /O_RDONLY|["']r["']/, `${rel}: openSync(${a}) is not read-only (flags: ${flags})`);
      assert.doesNotMatch(flags, /O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC|["'](r\+|w\+?|a\+?|wx|ax)["']/, `${rel}: openSync(${a}) can write (flags: ${flags})`);
    }
    for (const a of callArgs(src, "readFileSync")) {
      assert.doesNotMatch(a, /flag\s*:\s*["'](r\+|w|a)/, `${rel}: readFileSync(${a}) with a write flag`);
    }
  }
});
