// ADR-MF #13 — shared adapter factory (Article 1 trim).
// Each per-CLI file declares an AdapterConfig and delegates here.
import * as path from "node:path";
import type { ResolvedInstructions } from "../resolve-instructions.js";
import type { SessionContext } from "../types.js";
import { canonicalBytes } from "../persistence/canonical-bytes.js";
import type { Spawner } from "./spawner.js";
import { semverGte, runSelfTest } from "./self-test.js";
import {
  BootAdapterError,
  type BootAdapter,
  type BootCommand,
  type BuildOptions,
  type CliKind,
  type SelfTestInput,
} from "./types.js";

export interface AdapterConfig {
  name: CliKind;
  min_version: string;
  needScratchCwd: boolean;
  codeCwdFlag: string | null;  // null = no separate flag (claude --bare case)
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
    async buildBootCommand(
      ctx: SessionContext,
      resolved: ResolvedInstructions,
      opts: BuildOptions,
    ): Promise<BootCommand> {
      await versionGate(opts.spawner);
      if (cfg.codeCwdFlag) {
        const ok = await opts.spawner.probeFeature(cfg.name, cfg.codeCwdFlag);
        if (!ok) {
          throw new BootAdapterError(
            "ERR_BOOT_ADAPTER_UNSUPPORTED",
            `${cfg.name} lacks ${cfg.codeCwdFlag} (ADR §4.5.1.1 two-axis separation)`,
          );
        }
      }
      await opts.fs.mkdirP(opts.staging_dir);
      let processCwd = ctx.cwd;
      if (cfg.needScratchCwd) {
        processCwd = path.join(opts.staging_dir, "control");
        await opts.fs.mkdirP(processCwd);
      }
      const prompt_file = path.join(opts.staging_dir, "effective_prompt.md");
      await opts.fs.writeFile(prompt_file, canonicalBytes(resolved.effective_prompt));
      const { argv, env } = cfg.buildArgvEnv({ ctx, prompt_file });
      return Object.freeze({
        argv: Object.freeze([...argv]),
        env: Object.freeze({ ...env }),
        cwd: processCwd,
        code_scope_cwd: ctx.cwd,
        prompt_file,
        expected_digest: resolved.effective_prompt_digest,
      });
    },
    async verifyBootSelfTest(input: SelfTestInput) {
      return await runSelfTest(adapter, input);
    },
  };
  return adapter;
}
