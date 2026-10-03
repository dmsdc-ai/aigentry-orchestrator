// #1162 G2b: read-only CLI over readSealedAgentBinding for the terminal adapter.
//   node dist/src/session/agent-binding.js --stage ROOT --sid SID [--task TASK]
//     [--expect-attempt UUID --expect-hash HEX64 --expect-surface UUID --expect-lifecycle UUID]
//     [--with-owner]
// stdout {"binding":…,"launch":…} and exit 0; exit 20 = no sealed record or
// binding (unsupported); exit 30 = invalid arguments or a record that fails any
// check. `--task` is an optional explicit expectation; without it the task is
// the sealed manifest's own. Errors are fixed codes: no env, auth or key dump.
// The four --expect-* flags are all-or-none: a valid chain that no longer matches
// them exits 10 (drift). --with-owner (valueless) adds "owner":{supervisor_pid,
// child_pid} from the running receipt; without it the output shape is unchanged.
import { AgentBindingError, readSealedAgentBinding } from "./worker-sandbox.js";

const VALUED = ["--stage", "--sid", "--task", "--expect-attempt", "--expect-hash", "--expect-surface", "--expect-lifecycle"];
const EXPECT = ["--expect-attempt", "--expect-hash", "--expect-surface", "--expect-lifecycle"];

function main(argv: string[]): number {
  const opts: Record<string, string> = {};
  let withOwner = false;
  for (let i = 0; i < argv.length;) {
    const key = argv[i]!, value = argv[i + 1];
    if (key === "--with-owner" && !withOwner) {
      withOwner = true;
      i += 1;
      continue;
    }
    if (!VALUED.includes(key) || value === undefined || key in opts) {
      process.stderr.write("agent-binding: AGENT_BINDING_ARGS\n");
      return 30;
    }
    opts[key] = value;
    i += 2;
  }
  const stage = opts["--stage"], sid = opts["--sid"], task = opts["--task"];
  const pinned = EXPECT.filter(k => k in opts).length;
  if (!stage || !sid || (pinned !== 0 && pinned !== EXPECT.length)) {
    process.stderr.write("agent-binding: AGENT_BINDING_ARGS\n");
    return 30;
  }
  const expect = pinned ? { attempt: opts["--expect-attempt"]!, manifest_hash: opts["--expect-hash"]!,
    surface_id: opts["--expect-surface"]!, terminal_lifecycle_id: opts["--expect-lifecycle"]! } : undefined;
  try {
    process.stdout.write(JSON.stringify(readSealedAgentBinding(stage, sid, task,
      { ...(expect ? { expect } : {}), withOwner })) + "\n");
    return 0;
  } catch (e) {
    const known = e instanceof AgentBindingError;
    process.stderr.write(`agent-binding: ${known ? e.message : "AGENT_BINDING_READ"}\n`);
    return known && e.code === "missing" ? 20 : known && e.code === "drift" ? 10 : 30;
  }
}

process.exitCode = main(process.argv.slice(2));
