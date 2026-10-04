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
}

// #1167: a probe must never hang or buffer unboundedly. Hard deadline and a
// combined stdout+stderr byte ceiling; on either, SIGKILL the direct child and
// reject without carrying any captured output.
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 1_048_576;

function collect(exe: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, [...args], { shell: false });
    let out: string[] = [];
    let bytes = 0;
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      out = [];
      c.kill("SIGKILL");
      reject(e);
    };
    const t = setTimeout(() => fail(new Error("PROBE_TIMEOUT")), PROBE_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      if (done) return;
      bytes += d.length;
      if (bytes > PROBE_MAX_BYTES) return fail(new Error("PROBE_OUTPUT_LIMIT"));
      out.push(d.toString());
    };
    c.stdout?.on("data", onData);
    c.stderr?.on("data", onData);
    c.stdout?.on("error", fail);
    c.stderr?.on("error", fail);
    c.on("error", fail);
    c.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (code === 0) resolve(out.join(""));
      else reject(new Error("nonzero"));
    });
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
          // #1167: propagate the real OS error (EACCES stays EACCES; missing exe is already ENOENT).
          reject(e);
        });
        // #1162: stdin pipe errors (EPIPE when the child closed its read end) must
        // never crash the parent. A non-empty payload counts as delivered only once
        // its write callback succeeds; a failed delivery rejects with the real error.
        let stdinErr: Error | undefined;
        let stdinPending = false;
        let closed: { code: number | null } | undefined;
        const finish = (code: number | null) => {
          clearTimeout(t);
          if (stdinErr) reject(stdinErr);
          else resolve({ stdout: out, stderr: err, exit_code: code ?? -1, duration_ms: Date.now() - start });
        };
        child.on("close", (code) => {
          if (stdinPending) { closed = { code }; return; }
          finish(code);
        });
        if (stdin !== undefined && child.stdin) {
          const peerClosed = (e: NodeJS.ErrnoException) => e.code === "EPIPE" || e.code === "ECONNRESET";
          child.stdin.on("error", (e: NodeJS.ErrnoException) => {
            // Nothing left undelivered (empty payload / already flushed): EOF to a gone reader is moot.
            if (!stdinPending && peerClosed(e)) return;
            stdinErr ??= e;
          });
          if (stdin.length > 0) {
            stdinPending = true;
            child.stdin.write(stdin, (e) => {
              stdinPending = false;
              if (e) stdinErr ??= e;
              if (closed) finish(closed.code);
            });
          }
          child.stdin.end();
        }
      });
    },
    async probeVersion(exe) {
      try {
        const out = await collect(exe, ["--version"]);
        const m = out.match(/(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?/);
        return m ? m[0] : out.trim();
      } catch { throw new Error("CLI_NOT_FOUND"); }
    },
  };
}

export interface MockScript {
  version?: string;
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
  };
}
