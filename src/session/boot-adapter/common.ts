// ADR-MF #13 — shared adapter factory (Article 1 trim).
// Each per-CLI file declares an AdapterConfig and delegates here.
import * as path from "node:path";
import type { ResolvedInstructions } from "../resolve-instructions.js";
import type { SessionContext } from "../types.js";
import type { SpawnDecision } from "../model-decision.js";
import { canonicalBytes } from "../persistence/canonical-bytes.js";
import type { Spawner } from "./spawner.js";
import { CLI_DEFAULT, launchConfig, normalizeLaunch, type LaunchSetting } from "./launch-config.js";
import {
  BootAdapterError,
  type BootAdapter,
  type BootCommand,
  type BuildOptions,
  type CliKind,
  type LaunchConfig,
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

// #1148: the LaunchConfig v2 a spawn decision implies. An adapter applying a decision
// builds `launch` from this, so argv and metadata still share one resolution; null
// model/effort = no flag (cli-default). An env-sourced explicit request keeps its env name.
export function decisionLaunch(d: SpawnDecision): LaunchConfig {
  const up = d.cli.toUpperCase();
  const model: LaunchSetting = d.model === null ? CLI_DEFAULT : { arg: d.model,
    source: d.decided_by === "explicit" && d.requested.model === d.model ? `env:AIGENTRY_${up}_MODEL` : "default" };
  const effort: LaunchSetting = d.effort.token === null ? CLI_DEFAULT : { arg: d.effort.token,
    source: d.effort.state === "explicit" || d.effort.state === "explicit-unverified" ? `env:AIGENTRY_${up}_EFFORT` : "default" };
  return launchConfig(d.cli, model, effort);
}

export interface AdapterConfig {
  name: CliKind;
  min_version: string;
  // agy has no --version; verify its required flags through --help instead.
  capabilityProbe?: { executable: string; flags: readonly string[] };
  // #532 additive role-injection descriptor (see BootAdapter in types.ts).
  // Defaulted for claude (flag-based), set for codex/gemini.
  contextFile?: string | null;
  homeEnv?: string | null;
  homeExclude?: readonly string[];
  // #569: config subdir under homeEnv (gemini ".gemini"; null = homeEnv is the
  // config dir directly, e.g. codex). See BootAdapter.homeConfigSubdir.
  homeConfigSubdir?: string | null;
  // #1162: `launch` is built from the same resolved settings as `argv`
  // (launch-config.ts). Absent ⇒ BootCommand.launch is explicit unknown.
  buildArgvEnv(args: {
    ctx: SessionContext;
    prompt_file: string;
    // #1148: present only on a resolver-managed spawn; the adapter then reads no env default.
    decision?: SpawnDecision | undefined;
  }): { argv: readonly string[]; env: Readonly<Record<string, string>>; launch?: LaunchConfig };
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
      if (opts.executable || opts.decision) {
        // #1148: no probe. A known version below the adapter floor is drift; unknown proceeds
        // (the decision already labels it). The decision must bind the same file.
        if (!opts.executable || opts.executable.cli !== cfg.name || (opts.decision &&
          (opts.decision.executable.realpath !== opts.executable.realpath || opts.decision.executable.path !== opts.executable.path))) {
          throw new BootAdapterError("UNSUPPORTED_CLI", `${cfg.name}: executable binding mismatch`);
        }
        if (opts.executable.version !== null && !semverGte(opts.executable.version, cfg.min_version)) {
          throw new BootAdapterError("CLI_VERSION_DRIFT",
            `${cfg.name} installed=${opts.executable.version} min=${cfg.min_version}`);
        }
      } else if (cfg.capabilityProbe) {
        const { executable, flags } = cfg.capabilityProbe;
        // #1167: a missing CLI is CLI_NOT_FOUND here too, never a raw `spawn <cli> ENOENT`.
        const help = await opts.spawner.run({ argv: [executable, "--help"], env: {},
          cwd: ctx.cwd, prompt_file: "", expected_digest: "" }, "", 5000).catch((e: unknown) => {
          throw (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? new BootAdapterError("CLI_NOT_FOUND", executable) : e;
        });
        if (help.exit_code !== 0 || flags.some((f) => !(help.stdout + help.stderr).includes(f))) {
          throw new BootAdapterError("CLI_VERSION_DRIFT", `${executable}: required flags missing`);
        }
      } else {
        await versionGate(opts.spawner);
      }
      await opts.fs.mkdirP(opts.staging_dir);
      const prompt_file = path.join(opts.staging_dir, "effective_prompt.md");
      await opts.fs.writeFile(prompt_file, canonicalBytes(resolved.effective_prompt));
      const { argv, env, launch } = cfg.buildArgvEnv({ ctx, prompt_file, decision: opts.decision });
      const normalized = normalizeLaunch(cfg.name, launch);
      // #1148: an adapter that did not apply the decision (its metadata differs) never launches.
      if (opts.decision && JSON.stringify(normalized) !== JSON.stringify(decisionLaunch(opts.decision))) {
        throw new BootAdapterError("UNSUPPORTED_CLI", `${cfg.name}: adapter did not apply the spawn decision`);
      }
      return Object.freeze({
        argv: Object.freeze(opts.executable ? [opts.executable.path, ...argv.slice(1)] : [...argv]),
        env: Object.freeze({ ...env }),
        cwd: ctx.cwd,
        prompt_file,
        expected_digest: resolved.effective_prompt_digest,
        launch: normalized,
      });
    },
  };
  return adapter;
}
