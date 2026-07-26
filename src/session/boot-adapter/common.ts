// ADR-MF #13 — shared adapter factory (Article 1 trim).
// Each per-CLI file declares an AdapterConfig and delegates here.
import * as path from "node:path";
import type { ResolvedInstructions } from "../resolve-instructions.js";
import type { SessionContext } from "../types.js";
import { canonicalBytes } from "../persistence/canonical-bytes.js";
import type { Spawner } from "./spawner.js";
import {
  BootAdapterError,
  type BootAdapter,
  type BootCommand,
  type BuildOptions,
  type CliKind,
} from "./types.js";

// SemVer 2 §11 minimal compare: major.minor.patch numeric; any prerelease < release.
export function semverGte(installed: string, minimum: string): boolean {
  const parse = (s: string): [number, number, number, boolean] => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(-[A-Za-z0-9.-]+)?/);
    return m
      ? [Number(m[1]), Number(m[2]), Number(m[3]), Boolean(m[4])]
      : [0, 0, 0, false];
  };
  const [aM, an, ap, apre] = parse(installed);
  const [bM, bn, bp, bpre] = parse(minimum);
  if (aM !== bM) return aM > bM;
  if (an !== bn) return an > bn;
  if (ap !== bp) return ap > bp;
  // equal core: release ≥ prerelease; prerelease < release; same-flag treat equal.
  if (apre === bpre) return true;
  return !apre;
}

export interface AdapterConfig {
  name: CliKind;
  min_version: string;
  // #532 additive role-injection descriptor (see BootAdapter in types.ts).
  // Defaulted for claude (flag-based), set for codex/gemini.
  contextFile?: string | null;
  homeEnv?: string | null;
  homeExclude?: readonly string[];
  // #569: config subdir under homeEnv (gemini ".gemini"; null = homeEnv is the
  // config dir directly, e.g. codex). See BootAdapter.homeConfigSubdir.
  homeConfigSubdir?: string | null;
  buildArgvEnv(args: {
    ctx: SessionContext;
    prompt_file: string;
  }): { argv: readonly string[]; env: Readonly<Record<string, string>> };
}

export function makeAdapter(cfg: AdapterConfig): BootAdapter {
  let cachedVersion: Promise<string> | null = null;
  const versionGate = (spawner: Spawner): Promise<string> => {
    if (cachedVersion) return cachedVersion;
    cachedVersion = (async () => {
      let v: string;
      try {
        v = await spawner.probeVersion(cfg.name);
      } catch {
        cachedVersion = null;
        throw new BootAdapterError("CLI_NOT_FOUND", cfg.name);
      }
      if (!semverGte(v, cfg.min_version)) {
        cachedVersion = null;
        throw new BootAdapterError(
          "CLI_VERSION_DRIFT",
          `${cfg.name} installed=${v} min=${cfg.min_version}`,
        );
      }
      return v;
    })();
    return cachedVersion;
  };
  const adapter: BootAdapter = {
    name: cfg.name,
    min_version: cfg.min_version,
    contextFile: cfg.contextFile ?? null,
    homeEnv: cfg.homeEnv ?? null,
    homeExclude: Object.freeze([...(cfg.homeExclude ?? [])]),
    homeConfigSubdir: cfg.homeConfigSubdir ?? null,
    async buildBootCommand(
      ctx: SessionContext,
      resolved: ResolvedInstructions,
      opts: BuildOptions,
    ): Promise<BootCommand> {
      await versionGate(opts.spawner);
      await opts.fs.mkdirP(opts.staging_dir);
      const prompt_file = path.join(opts.staging_dir, "effective_prompt.md");
      await opts.fs.writeFile(prompt_file, canonicalBytes(resolved.effective_prompt));
      const { argv, env } = cfg.buildArgvEnv({ ctx, prompt_file });
      return Object.freeze({
        argv: Object.freeze([...argv]),
        env: Object.freeze({ ...env }),
        cwd: ctx.cwd,
        prompt_file,
        expected_digest: resolved.effective_prompt_digest,
      });
    },
  };
  return adapter;
}
