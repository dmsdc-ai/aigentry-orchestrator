import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { digest, quote, type WorkerManifest } from "./worker-sandbox.js";

async function run(m: WorkerManifest, command: string[], capture = false): Promise<{ code: number; output: string }> {
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command.map(quote).join(" "), "/bin/bash",
    undefined, undefined, m.cwd, { commandId: `${m.attempt}:${capture ? "preflight" : "worker"}` });
  const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd: m.cwd, env: { ...m.env, ...wrapped.env }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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

async function main(): Promise<void> {
  const file = process.argv[2], expected = process.argv[3];
  if (!file || !expected) throw new Error("SANDBOX_MANIFEST_REQUIRED");
  const raw = fs.readFileSync(file, "utf8");
  if (digest(raw) !== expected) throw new Error("SANDBOX_MANIFEST_CHANGED");
  const m = JSON.parse(raw) as WorkerManifest;
  if (m.version !== 1 || !m.command.length || !m.task || !m.attempt) throw new Error("SANDBOX_MANIFEST_INVALID");
  if (!SandboxManager.isSupportedPlatform()) throw new Error("SANDBOX_PLATFORM_UNSUPPORTED");
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length) throw new Error(`SANDBOX_DEPENDENCIES: ${deps.errors.join("; ")}`);
  // SRT's temporary paths must belong to this worker, never to shared host /tmp.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, m.env);
  await SandboxManager.initialize(m.config, undefined, false);
  try {
    const sentinel = path.join(m.env.TMPDIR!, "preflight.txt");
    const script = `const fs=require('fs'),net=require('net');
      const deny=f=>{try{f();process.exit(71)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}};
      deny(()=>fs.readFileSync(process.argv[1]));
      deny(()=>fs.writeFileSync(process.argv[1],'changed'));
      fs.writeFileSync(process.argv[2],'ok'); fs.unlinkSync(process.argv[2]);
      const s=net.connect({host:'127.0.0.1',port:3848});
      s.on('connect',()=>process.exit(72)); s.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:73));
      setTimeout(()=>process.exit(74),3000);`;
    const check = await run(m, [process.execPath, "-e", script, m.probeFile, sentinel], true);
    if (check.code !== 0) throw new Error(`SANDBOX_PREFLIGHT_FAILED: ${check.code} ${check.output}`);
    process.stderr.write(`[sandbox] ${m.sid} task=${m.task} attempt=${m.attempt} OS confinement preflight passed\n`);
    if (process.argv[4] === "--preflight-only") return;
    const result = await run(m, m.command);
    fs.writeFileSync(m.receipt, JSON.stringify({ state: "exited", attempt: m.attempt, code: result.code }), { mode: 0o600 });
    process.exitCode = result.code;
  } finally {
    await SandboxManager.reset();
  }
}

main().catch(e => { process.stderr.write(`[sandbox] REFUSED: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 78; });
