import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface TeleptyContext { readonly trustedHome: string; readonly reader?: string }
export type Operation = "observe-inject" | "delete-session";
export interface TeleptyResult { readonly transportCode: "ok" | "000"; readonly httpStatus: number; readonly body: string }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function validatedTeleptyPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3848;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535) throw new Error("TELEPTY_PORT_INVALID");
  return Number(raw);
}
export async function requestTelepty(ctx: TeleptyContext, request: {
  readonly operation: Operation; readonly id: string; readonly port: number; readonly discardBody?: boolean;
}): Promise<TeleptyResult> {
  if (!ID.test(request.id) || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535 ||
      !["observe-inject", "delete-session"].includes(request.operation)) throw new Error("TELEPTY_REQUEST_INVALID");
  const failed: TeleptyResult = { transportCode: "000", httpStatus: 0, body: "" };
  const helper = fileURLToPath(new URL("../../../bin/lib/telepty-auth.sh", import.meta.url));
  if (!path.isAbsolute(ctx.trustedHome) || (ctx.reader && path.resolve(ctx.reader) !== helper)) return failed;
  const endpoint = request.operation === "observe-inject" ? "inject-observations" : "sessions";
  const method = request.operation === "observe-inject" ? "GET" : "DELETE";
  const env: NodeJS.ProcessEnv = { HOME: ctx.trustedHome, PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.CURL) env.CURL = process.env.CURL;
  const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
  const shellHelper = process.platform === "win32" ? helper.replace(/\\/g, "/") : helper;
  return new Promise<TeleptyResult>(resolve => {
    let length = 0, stderrLength = 0, invalid = false, settled = false;
    const parts: Buffer[] = [];
    const child = spawn(bash, ["--noprofile", "--norc", "-c", '. "$1"; shift; telepty_curl -s -w "\n%{http_code}" "$@"', "_", shellHelper,
      "-X", method, `http://127.0.0.1:${request.port}/api/${endpoint}/${request.id}`], {
      env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = (): void => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already closed */ } }
    };
    const done = (result: TeleptyResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => { invalid = true; kill(); done(failed); }, 7000);
    child.stdout.on("data", (part: Buffer) => {
      length += part.length;
      if (length > 1024 * 1024 + 4) { invalid = true; kill(); done(failed); return; }
      parts.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      stderrLength += part.length;
      if (stderrLength > 8192) { invalid = true; kill(); done(failed); }
    });
    child.once("error", () => done(failed));
    child.once("close", code => {
      if (invalid || code !== 0) { done(failed); return; }
      const raw = Buffer.concat(parts, length);
      if (raw.length < 4 || !/^\n[1-5][0-9]{2}$/.test(raw.subarray(-4).toString("latin1"))) { done(failed); return; }
      done({ transportCode: "ok", httpStatus: Number(raw.subarray(-3).toString("ascii")),
        body: request.discardBody ? "" : raw.subarray(0, -4).toString("utf8") });
    });
  });
}
