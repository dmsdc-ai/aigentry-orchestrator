// #1148 — regression suite for "no implicit worker count cap".
//
// Acceptance is the AUDITED ROUTE DECISION the product itself emitted: the
// dispatch_start telemetry payload (cli / route.label / route.decided_by /
// route.capped_cli) and the task-queue note the run wrote. The cap decision is
// made entirely by the compiled CLI under test; nothing here re-implements or
// stubs cliCap/applyCliCap. stderr is recorded as corroboration, never as the
// sole acceptance signal.
//
// Every group runs by default on every supported host — there is no opt-in arm
// and nothing is skipped on any OS. win32 runs the same groups through another
// fixture and reads the decision from the platform refusal: see WIN32.
//
// GROUPS: [target] existing-target semantics · [652] absolute staged ref ·
// [spawn] the fresh-spawn cap matrix.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fixture as capFixture, audit, liveRows, type CapFixture, type DispatchStartPayload, type RoutePayload } from "./cli-cap-fixtures.js";
import { fixture as routerFixture, type Decided } from "./model-router-fixtures.js";

// #1167 P6/P7: win32 runs every group, not a skip. cli-cap-fixtures is POSIX-shaped (":" PATH, a shebang
// registry stub), so win32 drives the same product CLI through the win32-ready model-router fixture (.cmd
// shims, real registry, fake cmux) with a recording telepty. The cap decision is made exactly as on POSIX;
// a fresh confined spawn then refuses (SANDBOX_PLATFORM_UNSUPPORTED, exit 78) before any effect, and emits
// no dispatch_start, so its audited decision is read from that refusal. --target runs to delivery unchanged.
const WIN32 = process.platform === "win32";
const SPAWN_EXIT = WIN32 ? 78 : 0;
type Win32CapFixture = CapFixture & { refused: (r: SpawnSyncReturns<string>) => Decided };

function win32Fixture(): Win32CapFixture {
  const f = routerFixture();
  const injectArgs = join(f.root, "inject-args.json");
  const telepty = f.script("telepty-inject-args", `
if (process.argv[2] === 'list') console.log(process.env.LIVE_SESSIONS || JSON.stringify([{id: 'router-fixture', command: process.env.OBSERVED_CLI || 'codex'}]));
else if (process.argv[2] === 'inject') {
  require('node:fs').writeFileSync(process.env.INJECT_ARGS, JSON.stringify(process.argv.slice(2)));
  console.log('stub inject OK');
}
else process.exit(99);
`);
  return {
    root: f.root, bin: f.bin, aig: f.aig, ref: f.ref, queue: f.queue, env: { ...f.env, TELEPTY: telepty, INJECT_ARGS: injectArgs },
    script: f.script, liveLauncher: f.liveLauncher, spawnArgs: f.spawnArgs, calls: f.calls, refused: f.refused,
    dispatch: (args = [], overrides = {}) => f.dispatch(args, { TELEPTY: telepty, INJECT_ARGS: injectArgs, ...overrides }),
    makeExistingTarget: () => {
      f.prepareTarget();
      const stagingRoot = join(f.aig, "sessions", "router-fixture");
      return { sid: "router-fixture", sealedHome: join(stagingRoot, "fixture-home"), stagingRoot };
    },
    cleanup: async () => f.cleanup(),
  };
}
const fixture: () => CapFixture = WIN32 ? win32Fixture : capFixture;

/** win32: the decision the refusal names, in the shape POSIX reads from dispatch_start and the ledger note. */
function refusedAudit(f: CapFixture, r: SpawnSyncReturns<string>): { payload: DispatchStartPayload; note: string } {
  const d = (f as Win32CapFixture).refused(r);
  const route: RoutePayload = { decided_by: d.decided_by ?? "", ...(d.model === null ? {} : { model: d.model }),
    ...(d.capped_cli === undefined ? {} : { capped_cli: d.capped_cli }) };
  return { payload: { cli: d.cli, route },
    note: `cli=${d.cli}/${d.model ?? "unknown"} by=${d.decided_by}${d.capped_cli ? ` capped_cli=${d.capped_cli}` : ""}` };
}

// #1206 D7: dispatch never sends the ref to the classifier, so the route is the profile's role row:
// architect -> opus-5 (claude), coder -> gpt-6-astra (codex).
const ROLE: Record<string, string> = { claude: "architect", codex: "coder" };

interface SpawnRunResult {
  r: SpawnSyncReturns<string>;
  payload: DispatchStartPayload;
  note: string;
}

/** Run one fresh-spawn dispatch and return the product's own audited decision. */
async function spawnRun(
  overrides: (f: CapFixture) => NodeJS.ProcessEnv,
  args: string[] = ["--role", "coder"],
): Promise<SpawnRunResult> {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, ...args], overrides(f));
    return { r, ...(WIN32 ? refusedAudit(f, r) : audit(f)) };
  } finally { await f.cleanup(); }
}

// ── [target] existing-target semantics ──────────────────────────────────────

describe("[target] existing-target semantics are cap-exempt", () => {
  for (const live of [4, 8, 16]) {
    test(`--target with ${live} live claude sessions never applies a cap`, async () => {
      const f = fixture();
      try {
        const t = f.makeExistingTarget("claude");
        const r = f.dispatch(["--target", t.sid], { LIVE_SESSIONS: liveRows(f, "claude", live) });
        assert.equal(r.status, 0, r.stderr);
        const { payload, note } = audit(f);
        // The decision object the product emitted: existing, uncapped, unrewritten.
        assert.equal(payload.mode, "target");
        assert.equal(payload.cli, "claude");
        assert.equal(payload.route.decided_by, "existing");
        assert.equal(payload.route.capped_cli, undefined);
        assert.match(note, /cli=claude\/unknown by=existing/);
        assert.doesNotMatch(r.stderr, /at cap/);
      } finally { await f.cleanup(); }
    });
  }

  test("--target on a codex worker is likewise uncapped and reports the observed CLI", async () => {
    const f = fixture();
    try {
      const t = f.makeExistingTarget("codex");
      const r = f.dispatch(["--target", t.sid], { LIVE_SESSIONS: liveRows(f, "codex", 8) });
      assert.equal(r.status, 0, r.stderr);
      const { payload } = audit(f);
      assert.equal(payload.cli, "codex");
      assert.equal(payload.route.decided_by, "existing");
      assert.equal(payload.route.capped_cli, undefined);
    } finally { await f.cleanup(); }
  });
});

// ── [652] absolute staged-ref locator must be preserved ─────────────────────

describe("[652] staged ref is delivered as an absolute path inside the sealed HOME", () => {
  test("inject argv carries an absolute [context-ref], not a tilde or relative path", async () => {
    const f = fixture();
    try {
      const t = f.makeExistingTarget("claude");
      const r = f.dispatch(["--target", t.sid], { LIVE_SESSIONS: liveRows(f, "claude", 2) });
      assert.equal(r.status, 0, r.stderr);
      const argv = JSON.parse(readFileSync(f.env.INJECT_ARGS!, "utf8")) as string[];
      const prompt = argv[argv.length - 1]!;
      const m = /^\[context-ref\] Read (\S+) and use it as the source of truth/.exec(prompt);
      assert.ok(m, `no context-ref prompt in inject argv: ${JSON.stringify(argv)}`);
      const staged = m[1]!;
      // The #652 fix: an absolute path, not "~/..." and not repo-relative.
      assert.ok(isAbsolute(staged), `staged ref is not absolute: ${staged}`);
      assert.ok(!staged.startsWith("~"), `staged ref is tilde-rooted: ${staged}`);
      assert.ok(staged.startsWith(t.sealedHome), `staged ref escapes the sealed HOME: ${staged}`);
      // And the bytes at that path really are the ref (locator resolves, not just looks right).
      assert.equal(readFileSync(staged, "utf8"), readFileSync(f.ref, "utf8"));
    } finally { await f.cleanup(); }
  });
});

// ── [spawn] the fresh-spawn cap matrix ──────────────────────────────────────

describe("[spawn] no implicit count ceiling for missing / empty / unlimited config", () => {
  // CONTRACT: absent or empty AIGENTRY_CLI_CAP_<CLI> means NO implicit ceiling,
  // for EVERY CLI. The pre-#1148 behaviour violated this (codex 2 / claude 4).
  const knobs: [string, string | undefined][] = [["missing", undefined], ["empty", ""], ["unlimited", "unlimited"]];
  const clis: [string, number][] = [["claude", 8], ["codex", 8]];

  for (const [knobDesc, knob] of knobs) {
    for (const [cli, n] of clis) {
      test(`${cli}: ${knobDesc} config + ${n} live -> routes ${cli}, no cap`, async () => {
        const knobVar = `AIGENTRY_CLI_CAP_${cli.toUpperCase()}`;
        const { r, payload, note } = await spawnRun((f) => ({
          LIVE_SESSIONS: liveRows(f, cli, n),
          ...(knob === undefined ? {} : { [knobVar]: knob }),
        }), ["--role", ROLE[cli]!]);
        assert.equal(r.status, SPAWN_EXIT, r.stderr);
        assert.equal(payload.cli, cli, `expected no cap, got route ${JSON.stringify(payload.route)}`);
        assert.equal(payload.route.capped_cli, undefined);
        assert.doesNotMatch(payload.route.decided_by, /-capped$/);
        assert.match(note, new RegExp(`cli=${cli}/`));
      });
    }
  }

  // CLI counts above the old hardcoded ceilings must not trigger a ceiling.
  for (const n of [3, 5, 9]) {
    test(`claude: ${n} live with no config exceeds old default 4 without capping`, async () => {
      const { r, payload } = await spawnRun((f) => ({ LIVE_SESSIONS: liveRows(f, "claude", n) }), ["--role", ROLE.claude!]);
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      assert.equal(payload.cli, "claude");
      assert.equal(payload.route.capped_cli, undefined);
    });
    test(`codex: ${n} live with no config exceeds old default 2 without capping`, async () => {
      const { r, payload } = await spawnRun((f) => ({ LIVE_SESSIONS: liveRows(f, "codex", n) }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      assert.equal(payload.cli, "codex");
      assert.equal(payload.route.capped_cli, undefined);
    });
  }
});

describe("[spawn] finite numeric opt-in quotas keep working unchanged", () => {
  // A numeric knob is an explicit opt-in and MUST still cap, including 0.
  const quotas: [string, number, boolean][] = [
    ["0", 0, true], ["1", 1, true], ["2", 2, true], ["3", 2, false], ["8", 3, false], ["8", 8, true],
  ];

  for (const [quota, live, capped] of quotas) {
    test(`AIGENTRY_CLI_CAP_CODEX=${quota} with ${live} live -> ${capped ? "capped" : "routes codex"}`, async () => {
      const { r, payload, note } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: quota, LIVE_SESSIONS: liveRows(f, "codex", live),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      if (capped) {
        assert.equal(payload.route.capped_cli, "codex");
        assert.match(payload.route.decided_by, /-capped$/);
        assert.notEqual(payload.cli, "codex");
        assert.match(note, /capped_cli=codex/);
      } else {
        assert.equal(payload.cli, "codex");
        assert.equal(payload.route.capped_cli, undefined);
      }
    });
  }

  test("quota 0 means never auto-route there even with zero live sessions", async () => {
    const { r, payload } = await spawnRun((f) => ({
      AIGENTRY_CLI_CAP_CODEX: "0", LIVE_SESSIONS: liveRows(f, "codex", 0),
    }));
    assert.equal(r.status, SPAWN_EXIT, r.stderr);
    assert.equal(payload.route.capped_cli, "codex");
    assert.notEqual(payload.cli, "codex");
  });
});

describe("[spawn] explicit --cli stays compatible: warn and proceed", () => {
  const explicit: [string, string, number][] = [["codex", "1", 2], ["claude", "2", 4], ["codex", "0", 0]];

  for (const [cli, quota, live] of explicit) {
    test(`--cli ${cli} at an explicit quota (${quota}, ${live} live) still spawns ${cli}`, async () => {
      const { r, payload, note } = await spawnRun((f) => ({
        [`AIGENTRY_CLI_CAP_${cli.toUpperCase()}`]: quota, LIVE_SESSIONS: liveRows(f, cli, live),
      }), ["--cli", cli, "--role", "coder"]);
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      // Explicit choice is honoured: the CLI is NOT rewritten and NOT marked capped.
      assert.equal(payload.cli, cli);
      assert.equal(payload.route.decided_by, "explicit");
      assert.equal(payload.route.capped_cli, undefined);
      assert.match(note, new RegExp(`cli=${cli}/.* by=explicit`));
      // The warning is corroboration, and must appear exactly once.
      assert.equal((r.stderr.match(/WARNING .* at cap/g) || []).length, 1);
    });
  }

  test("--cli with no configured quota warns not at all", async () => {
    const { r, payload } = await spawnRun((f) => ({
      LIVE_SESSIONS: liveRows(f, "claude", 9),
    }), ["--cli", "claude", "--role", "coder"]);
    assert.equal(r.status, SPAWN_EXIT, r.stderr);
    assert.equal(payload.cli, "claude");
    assert.doesNotMatch(r.stderr, /at cap/);
  });
});

// Malformed / unknown values: NOT asserted to a guessed outcome. The contract
// requires these be reported explicitly rather than guessed, so this records the
// observed decision for the contract owner instead of encoding a guess. The
// asserted malformed contract lives in the two groups below.
describe("[spawn] malformed knob behaviour is recorded, not guessed", () => {
  for (const bad of ["abc", " ", "-1", "2.5", "1e1", "Infinity", "null"]) {
    test(`AIGENTRY_CLI_CAP_CODEX=${JSON.stringify(bad)} -> observed decision is recorded`, async () => {
      const { r, payload } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: bad, LIVE_SESSIONS: liveRows(f, "codex", 3),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      console.log(`  OBSERVED knob=${JSON.stringify(bad)} live=3 -> cli=${payload.cli} decided_by=${payload.route.decided_by} capped_cli=${payload.route.capped_cli ?? "none"}`);
      // The one thing the contract forbids outright — silently manufacturing a
      // count cap out of a malformed value — is asserted in the group below.
      // Here, assert only that the run did not crash or half-apply.
      assert.ok(payload.route.decided_by);
    });
  }
});

describe("[spawn] 'unlimited' is case-insensitive and whitespace-tolerant", () => {
  for (const literal of ["unlimited", "UNLIMITED", "Unlimited", "uNlImItEd", "  unlimited  "]) {
    test(`AIGENTRY_CLI_CAP_CODEX=${JSON.stringify(literal)} with 9 live -> no ceiling`, async () => {
      const { r, payload } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: literal, LIVE_SESSIONS: liveRows(f, "codex", 9),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      assert.equal(payload.cli, "codex", `expected no ceiling, got route ${JSON.stringify(payload.route)}`);
      assert.equal(payload.route.capped_cli, undefined);
      assert.doesNotMatch(payload.route.decided_by, /-capped$/);
    });
  }

  // Whitespace-only belongs with missing/empty. The sharp pre-#1148 cliff was
  // Number(" ") === 0, which silently meant "never auto-route here".
  for (const ws of [" ", "   ", "\t"]) {
    test(`whitespace-only knob ${JSON.stringify(ws)} means no ceiling, not quota 0`, async () => {
      const { r, payload } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: ws, LIVE_SESSIONS: liveRows(f, "codex", 3),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      assert.equal(payload.cli, "codex", `whitespace knob manufactured a cap: ${JSON.stringify(payload.route)}`);
      assert.equal(payload.route.capped_cli, undefined);
    });
  }
});

describe("[spawn] malformed knob: no ceiling + one STATIC warning per knob", () => {
  const WARN = /dispatch\.sh: WARNING AIGENTRY_CLI_CAP_CODEX is set to an invalid value[^\n]*\n/g;

  for (const bad of ["abc", "null", "2.5.1", "one", "12abc"]) {
    test(`AIGENTRY_CLI_CAP_CODEX=${JSON.stringify(bad)} -> no ceiling, warned exactly once`, async () => {
      const { r, payload } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: bad, LIVE_SESSIONS: liveRows(f, "codex", 9),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      // No manufactured ceiling: the audited decision still routes codex.
      assert.equal(payload.cli, "codex", `malformed value manufactured a cap: ${JSON.stringify(payload.route)}`);
      assert.equal(payload.route.capped_cli, undefined);
      // cliCap() is consulted several times per run (once per route candidate,
      // twice more when building the status line), so "once" is a real dedup.
      assert.equal((r.stderr.match(WARN) || []).length, 1, `warning not emitted exactly once:\n${r.stderr}`);
    });
  }

  test("the warning is STATIC: it names the knob and never echoes its value", async () => {
    const marker = "AIGENTRY-SYNTHETIC-SECRET-MARKER-c3f09b";
    const { r } = await spawnRun((f) => ({
      AIGENTRY_CLI_CAP_CODEX: `abc ${marker}`, LIVE_SESSIONS: liveRows(f, "codex", 3),
    }));
    assert.equal(r.status, SPAWN_EXIT, r.stderr);
    const warnings = r.stderr.match(WARN) || [];
    assert.equal(warnings.length, 1, `warning not emitted exactly once:\n${r.stderr}`);
    // Static: byte-identical to the same warning produced by a different value.
    const { r: r2 } = await spawnRun((f) => ({
      AIGENTRY_CLI_CAP_CODEX: "zzz", LIVE_SESSIONS: liveRows(f, "codex", 3),
    }));
    assert.deepEqual(warnings, r2.stderr.match(WARN) || []);
  });
});

describe("[spawn] untrusted knob bytes never reach the operator stream", () => {
  // The knob is untrusted input and stderr is an operator terminal and a log.
  // A newline could forge a second log line, an ANSI escape could rewrite the
  // terminal, and a mis-set secret must not be replayed. None may appear.
  const marker = "AIGENTRY-SYNTHETIC-SECRET-MARKER-c3f09b";
  const payloads: [string, string][] = [
    ["newline", "abc\ndispatch.sh: FORGED LINE claiming success"],
    ["ANSI", "abc\u001b[31mRED\u001b[0m\u001b]0;title\u0007"],
    ["synthetic secret", `abc ${marker}`],
    ["combined", `abc\u001b[2J\n${marker}\n`],
  ];

  for (const [what, value] of payloads) {
    test(`${what} in AIGENTRY_CLI_CAP_CODEX never appears in stderr`, async () => {
      const { r, payload } = await spawnRun((f) => ({
        AIGENTRY_CLI_CAP_CODEX: value, LIVE_SESSIONS: liveRows(f, "codex", 3),
      }));
      assert.equal(r.status, SPAWN_EXIT, r.stderr);
      assert.ok(!r.stderr.includes(marker), `synthetic secret marker replayed to stderr:\n${r.stderr}`);
      assert.ok(!/\u001b/.test(r.stderr), `ANSI escape byte reached stderr:\n${JSON.stringify(r.stderr)}`);
      assert.ok(!r.stderr.includes("FORGED LINE"), `newline forged a log line:\n${r.stderr}`);
      // And the malformed value still yields no ceiling.
      assert.equal(payload.route.capped_cli, undefined);
    });
  }
});
