// Shared fixture plumbing for tests/context-handoff/*.test.ts (task 1201). Not a test itself.
//
// HERMETIC BY CONSTRUCTION. Every transcript store lives under a temporary HOME, and the CLI
// is spawned with an environment built from nothing: no CLAUDE_CONFIG_DIR, CODEX_HOME,
// GEMINI_CLI_HOME, CLAUDE_CODE_SESSION_ID or AIGENTRY_* is inherited, so a developer's real
// ~/.claude, ~/.codex, ~/.gemini or ~/.grok can never be scanned by a test. In-process callers
// use `withHermeticEnv`, which points HOME at the fixture for the duration of the call.
//
// THE ENGINE IS REACHED ONLY THROUGH ITS FROZEN SURFACES (SPEC §8, §10, §3.2): the
// `bin/context-handoff.mjs` script (flags and exit codes), `resolveHandoff` (signature frozen;
// its module is discovered, not assumed) and `ADAPTERS` in adapters/index. Everything is
// imported dynamically so this suite compiles whatever the engine's internal names are, and an
// absent export is a test failure that names it rather than a build break.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** dist/tests/context-handoff/harness.js → the repo root. */
export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = path.join(REPO, "tests", "fixtures", "context-handoff");
export const BIN = path.join(REPO, "bin", "context-handoff.mjs");
export const ENGINE_DIST = path.join(REPO, "dist", "src", "context-handoff");

export type Cli = "claude" | "codex" | "gemini" | "grok";
export const CLIS: readonly Cli[] = ["claude", "codex", "gemini", "grok"];

/** SPEC §4.1 / §6.2 bounds. */
export const MAX_BYTES = 9216;
export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 300;
export const MAX_FIRST_TURN_BYTES = 400;

export interface Box {
  readonly base: string;
  readonly home: string;
  /** realpath of the fixture control workspace. */
  readonly ws: string;
}

/** A private temp tree: `<base>/home` (the fixture HOME) and `<base>/ws` (with `state/`). */
export function makeBox(opts: { state?: boolean } = {}): Box {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ch1201-"));
  const home = path.join(base, "home");
  const ws = path.join(base, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  if (opts.state !== false) fs.mkdirSync(path.join(ws, "state"));
  return { base, home, ws: fs.realpathSync(ws) };
}

export function dropBox(b: Box): void {
  fs.rmSync(b.base, { recursive: true, force: true });
}

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g;

/** Shift every ISO timestamp in `text` so the newest one becomes `last`, keeping their order. */
export function shiftTimestamps(text: string, last: Date): string {
  let max = -Infinity;
  for (const m of text.matchAll(ISO_RE)) max = Math.max(max, Date.parse(m[0]));
  if (max === -Infinity) return text;
  const delta = last.getTime() - max;
  return text.replace(ISO_RE, (s) => new Date(Date.parse(s) + delta).toISOString());
}

function fill(template: string, v: { ws: string; session: string; project?: string }): string {
  return template
    .split("__WORKSPACE__").join(JSON.stringify(v.ws).slice(1, -1))
    .split("__SESSION__").join(v.session)
    .split("__PROJECT__").join(v.project ?? "");
}

function writeAt(file: string, data: string | Buffer, mtime: Date): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

/** A filesystem-safe slug. The adapter must not trust it (SPEC §2.1): tests also plant lying ones. */
export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const stamp = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");

export interface PlantOpts {
  /** Last activity the planted transcript must report. */
  readonly last: Date;
  readonly session?: string;
  /** The cwd recorded INSIDE the transcript (default: the box workspace). */
  readonly cwd?: string;
  /** Fixture file name under tests/fixtures/context-handoff/<cli>/ (claude only). */
  readonly template?: string;
  /** Raw JSONL text to plant instead of a fixture template (placeholders still filled). */
  readonly text?: string;
  /** claude only: the project directory name, to plant a misleading slug. */
  readonly slug?: string;
  /** gemini only: the project name under ~/.gemini/tmp. */
  readonly project?: string;
}

export interface Planted {
  readonly cli: Cli;
  readonly session: string;
  /** The transcript file whose path the handoff's `source:` line should name. */
  readonly file: string;
}

function template(cli: string, name: string): string {
  return fs.readFileSync(path.join(FIXTURES, cli, name), "utf8");
}

export function plantClaude(b: Box, o: PlantOpts): Planted {
  const session = o.session ?? randomUUID();
  const cwd = o.cwd ?? b.ws;
  const text = shiftTimestamps(fill(o.text ?? template("claude", o.template ?? "session.jsonl"), { ws: cwd, session }), o.last);
  const file = path.join(b.home, ".claude", "projects", o.slug ?? claudeSlug(cwd), `${session}.jsonl`);
  return { cli: "claude", session, file: writeAt(file, text, o.last) };
}

/** `<slug>/<session>/subagents/agent-*.jsonl` — must never be a candidate (SPEC §3.2). */
export function plantClaudeSubagent(b: Box, parent: Planted, last: Date): string {
  const text = shiftTimestamps(fill(template("claude", "subagent.jsonl"), { ws: b.ws, session: parent.session }), last);
  const file = path.join(path.dirname(parent.file), parent.session, "subagents", "agent-a1b2c3.jsonl");
  return writeAt(file, text, last);
}

export function plantCodex(b: Box, o: PlantOpts): Planted {
  const session = o.session ?? randomUUID();
  const text = shiftTimestamps(fill(o.text ?? template("codex", "rollout.jsonl"), { ws: o.cwd ?? b.ws, session }), o.last);
  const d = o.last.toISOString();
  const file = path.join(b.home, ".codex", "sessions", d.slice(0, 4), d.slice(5, 7), d.slice(8, 10),
    `rollout-${stamp(o.last)}-${session}.jsonl`);
  return { cli: "codex", session, file: writeAt(file, text, o.last) };
}

export function plantGemini(b: Box, o: PlantOpts): Planted {
  const session = o.session ?? randomUUID();
  const cwd = o.cwd ?? b.ws;
  const project = o.project ?? `proj-${claudeSlug(path.basename(cwd))}-${session.slice(0, 4)}`;
  const registry = path.join(b.home, ".gemini", "projects.json");
  let doc: { projects: Record<string, string> } = { projects: {} };
  try {
    doc = JSON.parse(fs.readFileSync(registry, "utf8")) as { projects: Record<string, string> };
  } catch {
    // first plant
  }
  const entry = JSON.parse(fill(template("gemini", "projects.json"), { ws: cwd, session, project })) as {
    projects: Record<string, string>;
  };
  doc.projects = { ...doc.projects, ...entry.projects };
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, `${JSON.stringify(doc, null, 2)}\n`);
  const text = shiftTimestamps(fill(o.text ?? template("gemini", "session.jsonl"), { ws: cwd, session, project }), o.last);
  const file = path.join(b.home, ".gemini", "tmp", project, "chats", `session-${stamp(o.last).slice(0, 16)}-${session.slice(0, 8)}.jsonl`);
  return { cli: "gemini", session, file: writeAt(file, text, o.last) };
}

export function plantGrok(b: Box, o: PlantOpts): Planted {
  const session = o.session ?? randomUUID();
  const cwd = o.cwd ?? b.ws;
  const dir = path.join(b.home, ".grok", "sessions", encodeURIComponent(cwd), session);
  // One shift for the whole session directory, computed over the file that carries timestamps.
  const prompts = fill(template("grok", "prompt_history.jsonl"), { ws: cwd, session });
  const shifted = shiftTimestamps(prompts, o.last);
  writeAt(path.join(dir, "prompt_history.jsonl"), shifted, o.last);
  for (const name of ["prompt_context.json", "system_prompt.txt"]) {
    writeAt(path.join(dir, name), fill(template("grok", name), { ws: cwd, session }), o.last);
  }
  const chat = writeAt(path.join(dir, "chat_history.jsonl"), fill(o.text ?? template("grok", "chat_history.jsonl"), { ws: cwd, session }), o.last);
  return { cli: "grok", session, file: chat };
}

/** agy's protobuf store: detect-only (newest mtime), never parsed (PHASE0 P0-3). */
export function plantAgy(b: Box, mtime: Date): string {
  const file = path.join(b.home, ".gemini", "antigravity", "conversations", `${randomUUID()}.pb`);
  return writeAt(file, fs.readFileSync(path.join(FIXTURES, "agy", "conversation.pb")), mtime);
}

export function plant(cli: Cli, b: Box, o: PlantOpts): Planted {
  switch (cli) {
    case "claude":
      return plantClaude(b, o);
    case "codex":
      return plantCodex(b, o);
    case "gemini":
      return plantGemini(b, o);
    case "grok":
      return plantGrok(b, o);
  }
}

/** The four transcript-store env roots are deliberately absent; HOME is the fixture. */
export function hermeticEnv(b: Box, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: b.home, USERPROFILE: b.home, TMPDIR: b.base, TEMP: b.base, TMP: b.base };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  // Windows needs these for node itself to start (crypto, child processes).
  for (const k of ["SystemRoot", "windir", "ComSpec", "PATHEXT"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** `node bin/context-handoff.mjs --workspace <ws> …args` with a hermetic environment. */
export function runCli(b: Box, args: readonly string[] = [], extra: Record<string, string> = {}): CliRun {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, "--workspace", b.ws, ...args], {
    cwd: b.ws,
    env: hermeticEnv(b, extra),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms };
}

/** Raw argv, without the default `--workspace`, for the invocation-error rows. */
export function runCliRaw(b: Box, args: readonly string[]): CliRun {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: b.ws, env: hermeticEnv(b), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// ── the composed markdown (SPEC §4.2) ───────────────────────────────────────

export type SectionKey = "requests" | "status" | "tools" | "decisions" | "byproduct" | "where";
export const SECTION_ORDER: readonly SectionKey[] = ["requests", "status", "tools", "decisions", "byproduct", "where"];
const HEADINGS: Record<SectionKey, RegExp> = {
  requests: /^## Last user requests\b/,
  status: /^## Assistant.s last stated status\b/,
  tools: /^## Open tool activity\b/,
  decisions: /^## Explicit decisions\b/,
  byproduct: /^## Byproduct context\b/,
  where: /^## Where to look\b/,
};

export interface Parsed {
  readonly lines: readonly string[];
  /** Everything before the first `## ` heading. */
  readonly header: readonly string[];
  /** Section keys in the order they appear. */
  readonly order: readonly SectionKey[];
  readonly body: Partial<Record<SectionKey, readonly string[]>>;
  readonly unknownHeadings: readonly string[];
}

export function parseHandoff(md: string): Parsed {
  const lines = md.replace(/\n$/, "").split("\n");
  const header: string[] = [];
  const order: SectionKey[] = [];
  const body: Partial<Record<SectionKey, string[]>> = {};
  const unknownHeadings: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const key = SECTION_ORDER.find((k) => HEADINGS[k].test(line));
      if (key === undefined) {
        unknownHeadings.push(line);
        cur = [];
        continue;
      }
      order.push(key);
      cur = [];
      body[key] = cur;
      continue;
    }
    (cur ?? header).push(line);
  }
  return { lines, header, order, body, unknownHeadings };
}

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const chars = (s: string): number => [...s].length;
/** Body bytes of a section: its lines joined by "\n", trailing blank lines ignored. */
export function sectionBytes(p: Parsed, k: SectionKey): number {
  const b = [...(p.body[k] ?? [])];
  while (b.length > 0 && b[b.length - 1].trim() === "") b.pop();
  return bytes(b.join("\n"));
}
export function items(p: Parsed, k: SectionKey): readonly string[] {
  return (p.body[k] ?? []).filter((l) => l.startsWith("- "));
}

/** SPEC §4.1 on the composed markdown. Returns the violations, empty when it conforms. */
export function boundViolations(md: string): string[] {
  const out: string[] = [];
  if (bytes(md) > MAX_BYTES) out.push(`${bytes(md)} bytes > ${MAX_BYTES}`);
  const lines = md.replace(/\n$/, "").split("\n");
  if (lines.length > MAX_LINES) out.push(`${lines.length} lines > ${MAX_LINES}`);
  lines.forEach((l, i) => {
    if (chars(l) > MAX_LINE_CHARS) out.push(`line ${i + 1} has ${chars(l)} chars > ${MAX_LINE_CHARS}`);
  });
  return out;
}

/** True when `s` holds a C0/DEL control character other than "\n". */
export function hasControlOtherThanNewline(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f) return true;
  }
  return false;
}

// ── the frozen in-process surfaces ──────────────────────────────────────────

/** SPEC §10, verbatim apart from naming the record loosely (its keys are asserted). */
export interface TranscriptRefShape {
  readonly cli: string;
  readonly sessionId: string;
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly lastActivity: string;
}
export interface ResolveHandoffResult {
  readonly ref: { readonly file: string; readonly line: string; readonly source: TranscriptRefShape } | null;
  readonly record: Record<string, unknown>;
  readonly stderrLine: string;
  readonly markdown: string | null;
}
export type ResolveHandoff = (o: {
  workspace: string;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  bootId: string;
  write: boolean;
  deadlineMs: number;
}) => ResolveHandoffResult;

/**
 * SPEC §10 freezes `resolveHandoff` but not the module that exports it. Look in the compiled
 * engine, `cli.js` first (the §3.1 script entry), then every other top-level module.
 */
export async function findResolveHandoff(): Promise<{ fn: ResolveHandoff; module: string }> {
  const files = fs.existsSync(ENGINE_DIST)
    ? fs.readdirSync(ENGINE_DIST).filter((f) => f.endsWith(".js")).sort((a, b) => (a === "cli.js" ? -1 : b === "cli.js" ? 1 : a.localeCompare(b)))
    : [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(ENGINE_DIST, f)).href)) as Record<string, unknown>;
    if (typeof mod.resolveHandoff === "function") return { fn: mod.resolveHandoff as ResolveHandoff, module: f };
  }
  throw new Error(`no module under ${ENGINE_DIST} exports resolveHandoff (SPEC §10); looked at: ${files.join(", ") || "nothing — is the engine compiled?"}`);
}

/** SPEC §3.2. */
export interface AdapterShape {
  readonly cli: string;
  readonly status: string;
  roots(env: Readonly<Record<string, string | undefined>>): readonly string[];
  list: (...a: never[]) => unknown;
  extract: (...a: never[]) => unknown;
}
export async function loadAdapters(): Promise<readonly AdapterShape[]> {
  const file = path.join(ENGINE_DIST, "adapters", "index.js");
  const mod = (await import(pathToFileURL(file).href)) as { ADAPTERS?: unknown };
  if (!Array.isArray(mod.ADAPTERS)) throw new Error(`${file} does not export an ADAPTERS array (SPEC §3.1)`);
  return mod.ADAPTERS as readonly AdapterShape[];
}

const STORE_ENV = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "AIGENTRY_TASK_QUEUE", "AIGENTRY_HANDOFF"];

/**
 * Run `fn` with process.env pointing every store root at the fixture HOME. The engine may read
 * `os.homedir()` rather than the `env` it is handed; this makes both answers the fixture.
 */
export function withHermeticEnv<T>(b: Box, fn: () => T): T {
  const saved = new Map<string, string | undefined>(STORE_ENV.map((k) => [k, process.env[k]]));
  for (const k of STORE_ENV) delete process.env[k];
  process.env.HOME = b.home;
  process.env.USERPROFILE = b.home;
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 9, 2, 0, 0) + minutes * 60_000);
