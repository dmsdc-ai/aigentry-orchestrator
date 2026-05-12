// ADR-MF #4 — deterministic layered instruction resolver (ADR §4.4 + §4.4.1).
// Pure async function producing effective_prompt + sha256 digest from four layers:
// common → project → role → task. Reuses canonicalBytes/sha256Hex from ADR §6 #14.
//
// OQ4 (orchestrator 2026-05-12): project_id is re-derived internally from cwd to
// prevent caller input drift / tampering.
// OQ1: missing layer = graceful skip (digest still deterministic); required-layer
// enforcement is the spawn gate's job (ADR §6 #15), not this module's.
import * as os from "node:os";
import * as path from "node:path";
import type { LayerKind, LayerMeta, Role } from "./types.js";
import {
  canonicalBytes,
  sha256Hex,
} from "./persistence/canonical-bytes.js";
import { deriveProjectId } from "./project-id.js";
import type { VirtualFS } from "./virtual-fs.js";

const LAYER_ORDER: readonly LayerKind[] = [
  "common",
  "project",
  "role",
  "task",
] as const;

// ADR §4.4 parser-visible separator: two newlines + thematic break + two newlines.
const DELIMITER = "\n\n---\n\n";

export interface ResolveContext {
  role: Role;
  cwd: string;
  task_prompt: string;
  task_source_path: string;
  // Per OQ3: $AIGENTRY_HOME overrides default ~/.aigentry. Caller may also pass
  // an explicit instructions_root (takes highest precedence — useful in tests).
  instructions_root?: string;
}

export interface ResolvedInstructions {
  effective_prompt: string;
  effective_prompt_digest: string;
  layers: readonly LayerMeta[];
  // Exposed so the spawn pipeline can persist project_id into SessionContext
  // without re-walking the filesystem.
  project_id: string;
}

function defaultRoot(): string {
  const envHome = process.env["AIGENTRY_HOME"];
  if (envHome && envHome.length > 0) {
    return path.join(envHome, "instructions");
  }
  return path.join(os.homedir(), ".aigentry", "instructions");
}

interface Normalized {
  text: string;
  bytes: Uint8Array;
}

function normalizeLayer(raw: string): Normalized {
  // Stage 1: BOM strip + CRLF→LF + NFC, via shared canonical-bytes from #14.
  const decoded = new TextDecoder("utf-8").decode(canonicalBytes(raw));
  // Stage 2: per-line trailing-whitespace trim + strip trailing blank lines +
  // ensure exactly one trailing LF (ADR §4.4 normalization clause).
  const lines = decoded.split("\n").map((l) => l.replace(/[\t ]+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const text = lines.join("\n") + "\n";
  return { text, bytes: canonicalBytes(text) };
}

interface LayerSource {
  kind: LayerKind;
  source_path: string;
  raw: string;
}

async function readIfExists(
  fs: VirtualFS,
  p: string,
): Promise<string | null> {
  if (!(await fs.exists(p))) return null;
  const bytes = await fs.readFile(p);
  return new TextDecoder("utf-8").decode(bytes);
}

async function collectSources(
  ctx: ResolveContext,
  fs: VirtualFS,
  root: string,
  projectId: string,
): Promise<LayerSource[]> {
  const out: LayerSource[] = [];

  const commonPath = path.join(root, "common.md");
  const commonRaw = await readIfExists(fs, commonPath);
  if (commonRaw !== null) {
    out.push({ kind: "common", source_path: commonPath, raw: commonRaw });
  }

  if (projectId !== "none") {
    const projPath = path.join(root, "projects", `${projectId}.md`);
    const projRaw = await readIfExists(fs, projPath);
    if (projRaw !== null) {
      out.push({ kind: "project", source_path: projPath, raw: projRaw });
    }
  }

  const rolePath = path.join(root, "roles", `${ctx.role}.md`);
  const roleRaw = await readIfExists(fs, rolePath);
  if (roleRaw !== null) {
    out.push({ kind: "role", source_path: rolePath, raw: roleRaw });
  }

  // task layer is always emitted from caller-supplied bytes (task_prompt is
  // never read from instructions_root — caller already has it).
  out.push({
    kind: "task",
    source_path: ctx.task_source_path,
    raw: ctx.task_prompt,
  });

  // Enforce deterministic order regardless of collection order (defensive
  // against future refactors — SPEC test #12).
  const order = new Map(LAYER_ORDER.map((k, i) => [k, i] as const));
  out.sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0));
  return out;
}

export async function resolveInstructions(
  ctx: ResolveContext,
  fs: VirtualFS,
): Promise<ResolvedInstructions> {
  const root = ctx.instructions_root ?? defaultRoot();
  const { project_id } = await deriveProjectId(ctx.cwd, fs);
  const sources = await collectSources(ctx, fs, root, project_id);

  const readAt = new Date().toISOString();
  const layers: LayerMeta[] = [];
  const pieces: string[] = [];

  for (const s of sources) {
    const { text, bytes } = normalizeLayer(s.raw);
    layers.push({
      layer: s.kind,
      source_path: s.source_path,
      content_sha256: sha256Hex(bytes),
      read_at: readAt,
    });
    // Each normalizeLayer text ends in exactly one LF; strip it so the
    // ADR §4.4 "\n\n---\n\n" delimiter is not doubled.
    pieces.push(text.replace(/\n$/, ""));
  }

  const effective_prompt = pieces.join(DELIMITER) + "\n";
  const effective_prompt_digest = sha256Hex(canonicalBytes(effective_prompt));

  return Object.freeze({
    effective_prompt,
    effective_prompt_digest,
    layers: Object.freeze(layers) as readonly LayerMeta[],
    project_id,
  });
}
