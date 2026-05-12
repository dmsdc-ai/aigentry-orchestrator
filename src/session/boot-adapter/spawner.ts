// ADR-MF #13 — Spawner abstraction. stdlib only.
import { spawn } from "node:child_process";
import type { BootCommand } from "./types.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export interface Spawner {
  run(cmd: BootCommand, stdin?: string, timeout_ms?: number): Promise<RunResult>;
  probeVersion(executable: string): Promise<string>;
  probeFeature(executable: string, flag: string): Promise<boolean>;
}

function collect(exe: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, [...args], { shell: false });
    let out = "";
    c.stdout?.on("data", (d) => (out += d.toString()));
    c.stderr?.on("data", (d) => (out += d.toString()));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("nonzero"))));
  });
}

export function nodeSpawner(): Spawner {
  return {
    async run(cmd, stdin, timeout_ms = 5_000) {
      const start = Date.now();
      const [exe, ...args] = cmd.argv;
      if (!exe) throw new Error("nodeSpawner: empty argv");
      return await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(exe, args, {
          cwd: cmd.cwd,
          env: { ...process.env, ...cmd.env },
          shell: false,
        });
        let out = "", err = "";
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Object.assign(new Error("BOOT_TIMEOUT"), { code: "ETIMEDOUT" }));
        }, timeout_ms);
        child.stdout?.on("data", (d) => (out += d.toString()));
        child.stderr?.on("data", (d) => (err += d.toString()));
        child.on("error", (e) => {
          clearTimeout(t);
          reject(Object.assign(e, { code: "ENOENT" }));
        });
        child.on("close", (code) => {
          clearTimeout(t);
          resolve({ stdout: out, stderr: err, exit_code: code ?? -1, duration_ms: Date.now() - start });
        });
        if (stdin !== undefined) { child.stdin?.write(stdin); child.stdin?.end(); }
      });
    },
    async probeVersion(exe) {
      try {
        const out = await collect(exe, ["--version"]);
        const m = out.match(/(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?/);
        return m ? m[0] : out.trim();
      } catch { throw new Error("CLI_NOT_FOUND"); }
    },
    async probeFeature(exe, flag) {
      try { return (await collect(exe, ["--help"])).includes(flag); }
      catch { return false; }
    },
  };
}

export interface MockScript {
  version?: string;
  features?: readonly string[];
  on_run?: (cmd: BootCommand, stdin?: string) => RunResult | Error;
}

export function mockSpawner(
  scripts: Record<string, MockScript>,
): Spawner & { calls: ReadonlyArray<{ cmd: BootCommand; stdin?: string }> } {
  const calls: Array<{ cmd: BootCommand; stdin?: string }> = [];
  return {
    calls,
    async run(cmd, stdin) {
      const entry: { cmd: BootCommand; stdin?: string } =
        stdin === undefined ? { cmd } : { cmd, stdin };
      calls.push(entry);
      const s = scripts[cmd.argv[0] ?? ""];
      if (!s?.on_run) return { stdout: "", stderr: "", exit_code: 0, duration_ms: 1 };
      const r = s.on_run(cmd, stdin);
      if (r instanceof Error) throw r;
      return r;
    },
    async probeVersion(exe) {
      const v = scripts[exe]?.version;
      if (!v) throw new Error("CLI_NOT_FOUND");
      return v;
    },
    async probeFeature(exe, flag) { return !!scripts[exe]?.features?.includes(flag); },
  };
}
