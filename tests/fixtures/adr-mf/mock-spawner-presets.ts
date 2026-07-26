// ADR-MF #10 fixture — preset MockScripts for boot-adapter conformance tests.
// Each preset reuses mockSpawner() from src/session/boot-adapter/spawner.ts; this
// file only adds the scripted-response shapes the conformance suite exercises.
import type { MockScript } from "../../../src/session/boot-adapter/spawner.js";

export function readyForDigest(version = "1.0.0"): MockScript {
  return {
    version,
    on_run: (cmd) => ({
      stdout: `READY ${cmd.expected_digest}\n`,
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }),
  };
}
