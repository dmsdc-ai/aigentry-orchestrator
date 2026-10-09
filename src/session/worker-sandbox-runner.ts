import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { assertExecutableIdentity, preflightConnectProbe, preflightControlPort, preflightDenyProbe, quote, readSealedManifest, withSeccompHelperRead, type WorkerManifest } from "./worker-sandbox.js";
import { CLAUDE_OAUTH_CHILD, CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_FILE, readClaudeOAuthHandoff } from "./claude-worker-oauth.js";

async function run(m: WorkerManifest, command: string[], capture = false,
  secretEnv: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command.map(quote).join(" "), "/bin/bash",
    undefined, undefined, m.cwd, { commandId: `${m.attempt}:${capture ? "preflight" : "worker"}` });
  const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd: m.cwd, env: { ...m.env, ...wrapped.env, ...secretEnv }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!capture) {
    fs.writeFileSync(m.receipt, JSON.stringify({ state: "running", hash: process.argv[3],
      attempt: m.attempt, supervisorPid: process.pid, childPid: child.pid, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  let output = "";
  if (capture) {
    child.stdout?.on("data", d => { if (output.length < 8192) output += String(d); });
    child.stderr?.on("data", d => { if (output.length < 8192) output += String(d); });
  }
  const forward = (): void => { child.kill("SIGTERM"); };
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  const timer = capture ? setTimeout(() => child.kill("SIGKILL"), 15000) : undefined;
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", c => resolve(c ?? 1));
    });
    return { code, output };
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGTERM", forward);
    process.removeListener("SIGINT", forward);
  }
}

// #652 positive control for the preflight's network leg: a host loopback listener on an ephemeral port that this
// runner alone owns, proven live by one self-connection before the sandbox is asked not to reach it. Every
// further connection it accepts is a leak; each accepted socket is destroyed at once. Bind and self-connect are
// bounded; the caller closes it on every path.
async function openControl(reserved: readonly (number | undefined)[]):
  Promise<{ port: number; leaks: () => number; failure: () => string | undefined; close: () => Promise<void> }> {
  const server = net.createServer();
  const peers: (number | undefined)[] = [];
  let failure: string | undefined, client: net.Socket | undefined, timer: NodeJS.Timeout | undefined;
  server.on("connection", s => { peers.push(s.remotePort); s.on("error", () => {}); s.destroy(); });
  server.on("error", e => { failure ??= (e as NodeJS.ErrnoException).code ?? "error"; });
  const close = (): Promise<void> => {
    client?.destroy();
    return new Promise(resolve => server.close(() => resolve()));
  };
  let port = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("SANDBOX_PREFLIGHT_FAILED: listener timeout")), 5000);
      const fail = (e: NodeJS.ErrnoException): void => reject(new Error(`SANDBOX_PREFLIGHT_FAILED: listener ${e.code ?? "error"}`));
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        if (!server.listening) return;
        try {
          port = preflightControlPort(server.address(), reserved);
        } catch (e) {
          return reject(e);
        }
        const self = (): void => {
          if (client?.localPort !== undefined && client.remoteAddress && peers.includes(client.localPort)) resolve();
        };
        server.on("connection", self);
        client = net.connect({ host: "127.0.0.1", port });
        client.on("error", fail);
        client.once("connect", self);
      });
    });
  } catch (e) {
    await close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  client?.destroy();
  return { port, leaks: () => peers.length - 1, failure: () => failure, close };
}

async function main(): Promise<void> {
  const file = process.argv[2], expected = process.argv[3];
  if (!file || !expected) throw new Error("SANDBOX_MANIFEST_REQUIRED");
  // The binder's sealed read (O_NOFOLLOW, owner-only, 1 MiB cap, sealed path and receipt);
  // its failures map onto this runner's fixed codes.
  let m: WorkerManifest;
  try {
    m = readSealedManifest(file, expected).m;
  } catch (e) {
    throw new Error(e instanceof Error && e.message === "SANDBOX_MANIFEST_CHANGED" ? "SANDBOX_MANIFEST_CHANGED" : "SANDBOX_MANIFEST_INVALID");
  }
  if (m.version !== 1 || !m.command.length || !m.task || !m.attempt) throw new Error("SANDBOX_MANIFEST_INVALID");
  // #652: the sealed marker must name exactly this attempt's handoff; checked
  // before any sandbox work, read only for the actual worker below.
  const handoff = path.join(path.dirname(path.resolve(file)), CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_FILE);
  if (m.claudeOAuthHandoff !== undefined && (m.cli !== "claude" || m.claudeOAuthHandoff !== handoff)) {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  }
  // #1148 U4: a sealed executable identity is re-checked on every start (auto-restart
  // replays this same manifest) and again right before exec; a replaced file refuses.
  if (m.executable) assertExecutableIdentity(m.executable, m.command[0]!);
  if (!SandboxManager.isSupportedPlatform()) throw new Error("SANDBOX_PLATFORM_UNSUPPORTED");
  // A legacy or unusable canary cannot attest the metadata boundary. The probed files must exist
  // on the host: on Linux the deny probe reads ENOENT inside the sandbox as the denial.
  try {
    if (!m.probeDirectory || !path.isAbsolute(m.probeDirectory) ||
      !fs.lstatSync(m.probeDirectory).isDirectory()) throw new Error("invalid canary");
    if (!fs.lstatSync(m.probeFile).isFile() ||
      !fs.lstatSync(path.join(m.probeDirectory, "synthetic.txt")).isFile()) throw new Error("invalid canary");
  } catch {
    throw new Error("SANDBOX_METADATA_CANARY_REQUIRED");
  }
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length) throw new Error(`SANDBOX_DEPENDENCIES: ${deps.errors.join("; ")}`);
  // SRT's temporary paths must belong to this worker, never to shared host /tmp.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, m.env);
  // #652: the sealed config plus, on Linux only, the runtime's own seccomp helper directory.
  const runtimeDir = path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"));
  await SandboxManager.initialize(withSeccompHelperRead(m.config, process.platform, runtimeDir), undefined, false);
  try {
    // The directory canary attests the metadata boundary through what macOS sandbox-exec
    // enforces: listing the directory and stat/lstat of a file inside it are denied. stat of
    // the directory entry itself is allowed by sandbox-exec on macOS 26 (measured 2026-10-08:
    // every directory under a denied path answers stat, none answers readdir), so it is not a
    // boundary this preflight can require without refusing every spawn on that platform.
    const sentinel = path.join(m.env.TMPDIR!, "preflight.txt");
    const script = `const fs=require('fs'),net=require('net');
      ${preflightDenyProbe(process.platform)}
      ${preflightConnectProbe(process.platform)}
      deny('readFile',()=>fs.readFileSync(process.argv[1],'utf8'),process.argv[4]);
      deny('writeFile',()=>fs.writeFileSync(process.argv[1],'changed'));
      deny('readdir',()=>fs.readdirSync(process.argv[3]),'synthetic.txt');
      deny('stat',()=>fs.statSync(process.argv[3]+'/synthetic.txt'));
      deny('lstat',()=>fs.lstatSync(process.argv[3]+'/synthetic.txt'));
      fs.writeFileSync(process.argv[2],'ok'); fs.unlinkSync(process.argv[2]);
      connect(process.argv[5]);`;
    // The host's canary text: on Linux a read inside the sandbox is readable only if it returns exactly this.
    const canary = fs.readFileSync(m.probeFile, "utf8");
    const control = await openControl([SandboxManager.getProxyPort?.(), SandboxManager.getSocksProxyPort?.()]);
    let check: { code: number; output: string };
    try {
      check = await run(m, [process.execPath, "-e", script, m.probeFile, sentinel, m.probeDirectory, canary,
        String(control.port)], true);
      // Accepts that became ready with the child's exit are counted before the listener closes.
      await new Promise(r => setImmediate(r));
      // Any connection that reached the host listener refuses, whatever the child reported.
      if (control.leaks() > 0) throw new Error("SANDBOX_PREFLIGHT_FAILED: connect:leaked");
      const failure = control.failure();
      if (failure) throw new Error(`SANDBOX_PREFLIGHT_FAILED: listener ${failure}`);
    } finally {
      await control.close();
    }
    if (check.code !== 0) throw new Error(`SANDBOX_PREFLIGHT_FAILED: ${check.code} ${check.output}`);
    // A Linux write the probe accepted (into bwrap's tmpfs) must not have reached the host canary.
    if (fs.readFileSync(m.probeFile, "utf8") !== canary) throw new Error("SANDBOX_PREFLIGHT_FAILED: writeFile:leaked");
    process.stderr.write(`[sandbox] ${m.sid} task=${m.task} attempt=${m.attempt} OS confinement preflight passed\n`);
    if (process.argv[4] === "--preflight-only") return;
    // Token goes to the worker child env only: not process.env, not m.env, not preflight.
    const secretEnv: Record<string, string> = m.claudeOAuthHandoff === undefined ? {} :
      { [CLAUDE_OAUTH_CHILD]: readClaudeOAuthHandoff(m.claudeOAuthHandoff, handoff) };
    if (m.executable) assertExecutableIdentity(m.executable, m.command[0]!);
    const result = await run(m, m.command, false, secretEnv);
    fs.writeFileSync(m.receipt, JSON.stringify({ state: "exited", attempt: m.attempt, code: result.code }), { mode: 0o600 });
    process.exitCode = result.code;
  } finally {
    await SandboxManager.reset();
  }
}

main().catch(e => { process.stderr.write(`[sandbox] REFUSED: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 78; });
