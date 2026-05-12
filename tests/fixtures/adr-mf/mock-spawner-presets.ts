// ADR-MF #10 fixture — preset MockScripts for boot-adapter conformance tests.
// Each preset reuses mockSpawner() from src/session/boot-adapter/spawner.ts; this
// file only adds the four scripted-response shapes the conformance suite exercises.
import type { MockScript } from "../../../src/session/boot-adapter/spawner.js";

// Features set covers every codeCwdFlag/bare-flag we probe across the three adapters.
const ALL_FEATURES = ["--cd", "--workspace-root", "--bare"] as const;

export function readyForDigest(version = "1.0.0"): MockScript {
  return {
    version,
    features: [...ALL_FEATURES],
    on_run: (cmd) => ({
      stdout: `READY ${cmd.expected_digest}\n`,
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }),
  };
}

export function leakingSpawner(marker: string, version = "1.0.0"): MockScript {
  return {
    version,
    features: [...ALL_FEATURES],
    on_run: (cmd) => ({
      stdout: `READY ${cmd.expected_digest}\n${marker}\n`,
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }),
  };
}

export function digestMismatchSpawner(
  badDigest: string,
  version = "1.0.0",
): MockScript {
  return {
    version,
    features: [...ALL_FEATURES],
    on_run: () => ({
      stdout: `READY ${badDigest}\n`,
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }),
  };
}

export function unsupportedFeatureSpawner(version = "1.0.0"): MockScript {
  return {
    version,
    features: [],
    on_run: () => ({ stdout: "", stderr: "", exit_code: 0, duration_ms: 1 }),
  };
}
