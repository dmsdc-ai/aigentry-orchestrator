// ADR-MF #10 fixture — layered VirtualFS builder for resolver tests.
// Wraps memoryFs() with the path convention from resolve-instructions.ts:collectSources
// (`<root>/common.md`, `<root>/projects/<id>.md`, `<root>/roles/<role>.md`) and
// the project_id marker convention from project-id.ts (`<cwd>/.aigentry/project.json`).
import * as path from "node:path";
import { memoryFs, type VirtualFS } from "../../../src/session/virtual-fs.js";
import type { Role } from "../../../src/session/types.js";

export interface InstructionLayers {
  common?: string;
  project?: { id: string; body: string };
  roles?: Partial<Record<Role, string>>;
}

export interface BuildOpts {
  root: string;
  // cwd where the project marker is planted (so deriveProjectId resolves to layers.project.id).
  // If omitted and layers.project is present, the marker is planted at "/work/<id>".
  cwd?: string;
  layers: InstructionLayers;
}

export function buildLayeredFs(opts: BuildOpts): VirtualFS {
  const entries: Array<[string, string]> = [];
  const { root, layers } = opts;

  if (layers.common !== undefined) {
    entries.push([path.join(root, "common.md"), layers.common]);
  }

  if (layers.project !== undefined) {
    const { id, body } = layers.project;
    entries.push([path.join(root, "projects", `${id}.md`), body]);
    const markerDir = opts.cwd ?? `/work/${id}`;
    entries.push([
      path.join(markerDir, ".aigentry/project.json"),
      JSON.stringify({ project_id: id }),
    ]);
  }

  if (layers.roles !== undefined) {
    for (const [role, body] of Object.entries(layers.roles)) {
      if (body !== undefined) {
        entries.push([path.join(root, "roles", `${role}.md`), body]);
      }
    }
  }

  return memoryFs(entries);
}
