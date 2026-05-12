// ADR-MF #4 + OQ4 — project_id derivation (ADR §4.4.1).
// Internal to the resolver per orchestrator decision: tamper-resistant (no
// caller-supplied project_id input drift).
//
// Walk cwd ancestry until first ancestor containing a marker:
//   .aigentry/project.json  (authoritative — JSON's project_id field wins)
//   AGENTS.md | CLAUDE.md | .git    (fallback — basename of ancestor)
// No marker found anywhere → "none".
import * as path from "node:path";
import type { VirtualFS } from "./virtual-fs.js";

const MARKERS = [
  ".aigentry/project.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".git",
] as const;

export type ProjectIdSource = "project_json" | "basename" | "none";

export interface DerivedProjectId {
  project_id: string;
  marker_dir: string;
  source: ProjectIdSource;
}

async function readProjectJson(
  fs: VirtualFS,
  dir: string,
): Promise<string | null> {
  const p = path.join(dir, ".aigentry/project.json");
  if (!(await fs.exists(p))) return null;
  try {
    const bytes = await fs.readFile(p);
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pid = (parsed as Record<string, unknown>)["project_id"];
      if (typeof pid === "string" && pid.length > 0) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

export async function deriveProjectId(
  cwd: string,
  fs: VirtualFS,
): Promise<DerivedProjectId> {
  let dir = path.resolve(cwd);
  let prev = "";
  while (dir !== prev) {
    for (const m of MARKERS) {
      if (await fs.exists(path.join(dir, m))) {
        const fromJson = await readProjectJson(fs, dir);
        if (fromJson !== null) {
          return { project_id: fromJson, marker_dir: dir, source: "project_json" };
        }
        return {
          project_id: path.basename(dir),
          marker_dir: dir,
          source: "basename",
        };
      }
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return { project_id: "none", marker_dir: "", source: "none" };
}
