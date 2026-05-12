// ADR-MF #13 — fail-closed self-test (SPEC §5).
// OQ2: real CLIs lack #READY? ack today; this file's parsing + leak logic is
// mock-only validated until upstream cooperation lands.
import type {
  BootAdapter,
  BootError,
  SelfTestInput,
  SelfTestResult,
} from "./types.js";
import { READY_PREFIX, READY_PROMPT } from "./types.js";

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

export async function runSelfTest(
  adapter: BootAdapter,
  input: SelfTestInput,
): Promise<SelfTestResult> {
  const errors: BootError[] = [];
  const start = Date.now();
  let version = "unknown";
  try {
    version = await input.spawner.probeVersion(adapter.name);
  } catch {
    errors.push({ code: "CLI_NOT_FOUND", detail: adapter.name });
    return finalize(adapter.name, version, errors, start);
  }
  if (!semverGte(version, adapter.min_version)) {
    errors.push({
      code: "CLI_VERSION_DRIFT",
      detail: `installed=${version} min=${adapter.min_version}`,
    });
    return finalize(adapter.name, version, errors, start);
  }
  let result;
  try {
    result = await input.spawner.run(
      input.cmd,
      READY_PROMPT,
      input.timeout_ms ?? 5_000,
    );
  } catch (e) {
    const code =
      (e as { code?: string }).code === "ENOENT" ? "CLI_NOT_FOUND" : "BOOT_TIMEOUT";
    errors.push({ code, detail: (e as Error).message });
    return finalize(adapter.name, version, errors, start);
  }
  if (!result.stdout.includes(READY_PREFIX + input.cmd.expected_digest)) {
    errors.push({
      code: "BOOT_DIGEST_MISMATCH",
      detail: `missing READY ${input.cmd.expected_digest}`,
    });
  }
  for (const marker of input.leak_markers ?? []) {
    if (result.stdout.includes(marker) || result.stderr.includes(marker)) {
      errors.push({ code: "BOOT_LEAK_DETECTED", detail: marker });
    }
  }
  return finalize(adapter.name, version, errors, start);
}

function finalize(
  adapter: SelfTestResult["adapter"],
  version: string,
  errors: BootError[],
  start: number,
): SelfTestResult {
  return Object.freeze({
    adapter,
    version,
    suppression_verified: errors.length === 0,
    latency_ms: Math.max(0, Date.now() - start),
    errors: Object.freeze(errors) as readonly BootError[],
  });
}
