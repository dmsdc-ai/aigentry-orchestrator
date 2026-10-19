// Replaces only the SRT module import in an owned runner child. The real runner,
// manifest reader, grant claim, durable filesystem writes and unlink still run.
export function fixtureSrtWrapper(platform: NodeJS.Platform, env: NodeJS.ProcessEnv):
  { argv: string[]; env: NodeJS.ProcessEnv } {
  const proxy = "http://srt:00000000000000000000000000000000@localhost:3128";
  const noProxy = "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
  const assignments = ["SANDBOX_RUNTIME=1", `ALL_PROXY=${proxy}`, `all_proxy=${proxy}`,
    `GRPC_PROXY=${proxy}`, `grpc_proxy=${proxy}`, `NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`];
  let command: string;
  if (platform === "darwin") {
    command = `env ${assignments.join(" ")} /usr/bin/sandbox-exec -p fixture /bin/true`;
  } else if (platform === "linux") {
    command = `bwrap ${assignments.map(part => {
      const at = part.indexOf("=");
      return `--setenv ${part.slice(0, at)} ${part.slice(at + 1)}`;
    }).join(" ")} -- /bin/true`;
  } else {
    throw new Error("R2_FAKE_SRT_PLATFORM_UNSUPPORTED");
  }
  return { argv: ["/bin/bash", "-c", command], env: { ...env } };
}

export function assertFixtureSrtSpawn(command: string, args: readonly string[] | undefined,
  platform: NodeJS.Platform): void {
  const expected = fixtureSrtWrapper(platform, {}).argv;
  if (command !== expected[0] || args?.length !== 2 || args[0] !== expected[1] || args[1] !== expected[2]) {
    throw new Error("R2_FAKE_SRT_WRAPPER_REFUSED");
  }
}

// The loader child receives exactly the same wrapper implementation as the controls.
const fake = `const fixtureSrtWrapper = ${fixtureSrtWrapper.toString()};
export const SandboxManager = {
  isSupportedPlatform() { return process.platform === "darwin" || process.platform === "linux"; },
  async checkDependenciesAsync() { return { errors: [] }; },
  async initialize() {},
  async wrapWithSandboxArgv() { return fixtureSrtWrapper(process.platform, process.env); },
  async reset() {},
};`;

export async function resolve(specifier: string, context: unknown,
  nextResolve: (specifier: string, context: unknown) => Promise<unknown>): Promise<unknown> {
  if (specifier === "@anthropic-ai/sandbox-runtime") return { url: "r2-fixture:srt", shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url: string, context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<unknown>): Promise<unknown> {
  if (url === "r2-fixture:srt") return { format: "module", source: fake, shortCircuit: true };
  return nextLoad(url, context);
}
