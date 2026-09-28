// #1162 G2b: read-only CLI over readSealedAgentBinding for the terminal adapter.
//   node dist/src/session/agent-binding.js --stage ROOT --sid SID [--task TASK]
// stdout {"binding":…,"launch":…} and exit 0; exit 20 = no sealed record or
// binding (unsupported); exit 30 = invalid arguments or a record that fails any
// check. `--task` is an optional explicit expectation; without it the task is
// the sealed manifest's own. Errors are fixed codes: no env, auth or key dump.
import { AgentBindingError, readSealedAgentBinding } from "./worker-sandbox.js";

function main(argv: string[]): number {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--stage", "--sid", "--task"].includes(key) || value === undefined || key in opts) {
      process.stderr.write("agent-binding: AGENT_BINDING_ARGS\n");
      return 30;
    }
    opts[key] = value;
  }
  const stage = opts["--stage"], sid = opts["--sid"], task = opts["--task"];
  if (!stage || !sid) {
    process.stderr.write("agent-binding: AGENT_BINDING_ARGS\n");
    return 30;
  }
  try {
    process.stdout.write(JSON.stringify(readSealedAgentBinding(stage, sid, task)) + "\n");
    return 0;
  } catch (e) {
    const known = e instanceof AgentBindingError;
    process.stderr.write(`agent-binding: ${known ? e.message : "AGENT_BINDING_READ"}\n`);
    return known && e.code === "missing" ? 20 : 30;
  }
}

process.exitCode = main(process.argv.slice(2));
