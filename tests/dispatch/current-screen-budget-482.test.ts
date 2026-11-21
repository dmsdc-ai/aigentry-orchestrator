// #482 — regression coverage for the BOUNDED current-screen read and the readiness
// probe budget the dispatch caller supplies.
//
// Two independent halves, both driving real product code:
//
//  (a) bin/current_screen.py through its own functions, in ONE bounded interpreter
//      subprocess: a slow-but-successful query must NOT be reported unavailable, a hung
//      query must stay bounded and unavailable, and the failure/oversize/encoding and
//      current-target identity guards must all keep refusing. The fixture sleeps and
//      sizes are derived FROM the module's own COMMAND_TIMEOUT_SECONDS /
//      MAX_RESPONSE_BYTES, so this file cannot drift away from the limits it measures.
//
//  (b) `dist/src/dispatch/cli.js __probe is-ready <sid> <cli> <budget-ms>` against a
//      fixture probe whose reply is deliberately scheduled far beyond the budget. The
//      caller must give up within its supplied budget and stay NOT-ready; a reply that
//      arrives after the deadline must never be promoted to ready. The public caller
//      clamps the remaining deadline at src/dispatch/cli.ts (waitForReady →
//      isReady(…, Math.max(1, Math.min(READINESS_CAPTURE_MAX_MS, deadline - now)))).
//
// Cross-platform contract (the runner collects this compiled file on every OS,
// win32 included, and the win32 lane allows zero skips):
//   * The interpreter is resolved like the rest of this directory — `python3`, then
//     `python` on win32 — and a missing interpreter is a FAILURE, never a skip.
//   * The fixture probe is a PLATFORM-SPECIFIC launcher, never a shebang-only file: a
//     `.cmd` the Windows command processor runs, an absolute-interpreter shebang the
//     POSIX kernel runs. Both delegate to one shared body, so both platforms measure the
//     same fixture behaviour. A `fast` control proves the launcher itself works on the
//     platform before the slow case is read as evidence of a bounded wait.
//   * Nothing asserts an exact duration. The deadlines are generous, the late reply is
//     scheduled far outside any plausible runner stall, and the assertions are on
//     ORDERING and LIMITS: the fixture started, the caller returned not-ready, the late
//     reply never landed, and the caller did not wait for it.
//
// Offline: no terminal, telepty/cmux, provider or network is touched. Every frame and
// every identity field below is a synthetic fixture value.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { REPO } from "./model-router-fixtures.js";

// The runner also runs compiled tests on win32 (scripts/run-tests.mjs only skips the
// POSIX control harness there), where the launcher is usually `python`. A missing
// interpreter is a FAILURE, never a skip — see runPython().
const PYTHON = process.platform === "win32" ? ["python3", "python"] : ["python3"];
const SCREEN_PY = join(REPO, "bin", "current_screen.py");
const DISPATCH_JS = join(REPO, "dist", "src", "dispatch", "cli.js");

// ── (a) the shipped reader, driven through its own functions ────────────────────────
// `sys.argv[1]` is the absolute module path, so the subprocess never depends on its cwd.
const DRIVER = String.raw`
import importlib.util, pathlib, sys, time, unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("screen_budget", pathlib.Path(sys.argv[1]))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

LIMIT = screen.COMMAND_TIMEOUT_SECONDS
# Comfortably inside the product's own limit (a quarter of it, at least one second), so a
# loaded runner cannot turn this success case into a timeout.
SLOW = max(1.0, LIMIT / 4)
# Comfortably OUTSIDE it: the child would answer a minute after the product gave up, so no
# stall can make the hung case finish in time. The product still returns after LIMIT.
HUNG = LIMIT + 60


class BudgetTests(unittest.TestCase):
    def test_slow_successful_query_is_not_unavailable(self):
        result = screen.capture_object([sys.executable, "-c",
            "import json,sys,time;time.sleep(float(sys.argv[1]));"
            "print(json.dumps({'id':'fixture','healthStatus':'CONNECTED'}))", str(SLOW)])
        self.assertEqual(result, {"id": "fixture", "healthStatus": "CONNECTED"})

    def test_hung_query_remains_bounded_and_unavailable(self):
        started = time.monotonic()
        with self.assertRaisesRegex(screen.ScreenUnavailable, "command timed out"):
            screen.capture([sys.executable, "-c",
                "import sys,time;time.sleep(float(sys.argv[1]))", str(HUNG)])
        # A LIMIT, not a measurement: the read must have been cut short rather than
        # having waited for the child's own reply. Deliberately slack.
        self.assertLess(time.monotonic() - started, HUNG)

    def test_failed_command_remains_unavailable(self):
        with self.assertRaisesRegex(screen.ScreenUnavailable, "command failed"):
            screen.capture([sys.executable, "-c", "raise SystemExit(7)"])

    def test_bad_json_remains_unavailable(self):
        with self.assertRaisesRegex(screen.ScreenUnavailable, "not JSON"):
            screen.capture_object([sys.executable, "-c", "print('not-json')"])

    def test_oversized_output_remains_unavailable(self):
        # Exact bytes, written to the raw buffer: no newline translation on any platform.
        with self.assertRaisesRegex(screen.ScreenUnavailable, "too large"):
            screen.capture([sys.executable, "-c",
                "import sys;sys.stdout.buffer.write(b'x' * (int(sys.argv[1]) + 1))",
                str(screen.MAX_RESPONSE_BYTES)])

    def test_output_at_the_limit_is_still_accepted(self):
        # The boundary itself is NOT over the limit — a sensitivity control for the case
        # above, so an always-refusing reader cannot pass it.
        text = screen.capture([sys.executable, "-c",
            "import sys;sys.stdout.buffer.write(b'x' * int(sys.argv[1]))",
            str(screen.MAX_RESPONSE_BYTES)])
        self.assertEqual(len(text), screen.MAX_RESPONSE_BYTES)

    def test_invalid_utf8_remains_unavailable(self):
        with self.assertRaisesRegex(screen.ScreenUnavailable, "not UTF-8"):
            screen.capture([sys.executable, "-c",
                "import sys;sys.stdout.buffer.write(bytes([255]))"])

    def info(self):
        return {"id": "fixture", "host": "127.0.0.1", "backend": "fixture",
            "ownerPid": 41, "ptyPid": 42, "healthStatus": "CONNECTED", "ready": True,
            "createdAt": "2026-01-01T00:00:00Z", "lastConnectedAt": "2026-01-01T00:00:00Z",
            "transport": {"health_status": "CONNECTED", "ready": True, "bootstrap": {"ready": True}}}

    def test_current_identity_is_rechecked_after_capture(self):
        info = self.info()
        with patch.dict(screen.ADAPTERS, {"fixture": lambda _: "fixture prompt"}):
            self.assertEqual(screen.read_current_screen("fixture", info, lambda: info),
                ("fixture prompt", "fixture:current-viewport"))
            with self.assertRaisesRegex(screen.ScreenUnavailable, "session changed"):
                screen.read_current_screen("fixture", info, lambda: dict(info, ownerPid=43))

    def test_invalid_target_or_bootstrap_is_never_ready(self):
        # 127.0.0.1 is the only host the reader admits; 192.0.2.1 is RFC 5737 TEST-NET-1,
        # used here purely as a "not loopback" identity control. Neither is dialled.
        mutations = [{"id": "another"}, {"host": "192.0.2.1"}, {"ready": False},
            {"ownerPid": 0}, {"healthStatus": "DISCONNECTED"},
            {"transport": {"health_status": "CONNECTED", "ready": True, "bootstrap": {"ready": False}}}]
        with patch.dict(screen.ADAPTERS, {"fixture": lambda _: "fixture prompt"}):
            for mutation in mutations:
                with self.subTest(fields=list(mutation)), self.assertRaises(screen.ScreenUnavailable):
                    info = dict(self.info(), **mutation)
                    screen.read_current_screen("fixture", info, lambda: info)

unittest.main(argv=["screen-budget-tests"], verbosity=2)
`;

/** One bounded interpreter run. An unusable module or interpreter FAILS this file. */
function runPython(): void {
  if (!existsSync(SCREEN_PY)) throw new Error(`current_screen.py not found at ${SCREEN_PY}`);
  const attempts: string[] = [];
  for (const exe of PYTHON) {
    const r = spawnSync(exe, ["-c", DRIVER, SCREEN_PY], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") { attempts.push(`${exe}: ENOENT`); continue; }
    if (r.error) throw new Error(`${exe} failed to run the #482 reader driver: ${r.error.message}`);
    if (r.status !== 0 || r.signal) {
      throw new Error(`${exe} exited status=${r.status} signal=${r.signal}\n${r.stderr || r.stdout}`);
    }
    return;
  }
  throw new Error(`no usable Python interpreter (${attempts.join(", ")}) — #482 coverage FAILS rather than skips`);
}

test("482: bounded reads and current-target guards hold in the shipped reader", { timeout: 300_000 }, () => {
  runPython();
});

// ── (b) the caller's readiness budget ───────────────────────────────────────────────
/** Far outside any plausible runner stall: a reply this late must never become ready. */
const LATE_REPLY_MS = 120_000;
/** Generous enough that the fixture certainly starts, small enough to keep CI short. */
const BUDGET_MS = 10_000;

interface Fixture { probe: string; marker: string }

/**
 * A fixture probe plus a launcher the platform can execute on its own.
 *
 * `delayMs === 0` replies at once (the control); otherwise the reply is scheduled at
 * `delayMs` and the marker records whether it ever landed. The body is shared, so both
 * platforms measure the same behaviour; only the launcher differs. Deliberately NOT a
 * shebang-only file: win32 has no shebang support of its own.
 */
function probeFixture(scratch: string, name: string, delayMs: number): Fixture {
  const marker = join(scratch, `${name}-marker.txt`);
  const body = join(scratch, `${name}-body.cjs`);
  const reply = `fs.appendFileSync(${JSON.stringify(marker)}, "end"); process.stdout.write('{"ready":true}\\n');`;
  writeFileSync(body,
    `const fs = require("node:fs");\n` +
    `fs.writeFileSync(${JSON.stringify(marker)}, "start");\n` +
    (delayMs === 0 ? `${reply}\n` : `setTimeout(() => { ${reply} }, ${delayMs});\n`));
  let probe: string;
  if (process.platform === "win32") {
    probe = join(scratch, `${name}.cmd`);
    // The production caller spawns this seam through cross-spawn on win32, which runs a
    // `.cmd` through the command processor. `%*` forwards `--sid … --cli …` unchanged.
    writeFileSync(probe, `@echo off\r\n"${process.execPath}" "${body}" %*\r\n`);
  } else {
    probe = join(scratch, `${name}.cjs`);
    // Absolute interpreter: the kernel needs no PATH lookup to run it.
    writeFileSync(probe, `#!${process.execPath}\nrequire(${JSON.stringify(body)});\n`, { mode: 0o755 });
  }
  return { probe, marker };
}

function isReady(probe: string, budgetMs: number): number | null {
  const r = spawnSync(process.execPath, [DISPATCH_JS, "__probe", "is-ready", "fixture-sid", "claude", String(budgetMs)], {
    cwd: REPO, encoding: "utf8", timeout: 240_000, killSignal: "SIGKILL",
    env: {
      ...process.env, SESSION_PROBE_PY: probe,
      // The POSIX launcher pins its own interpreter; this keeps `node` resolvable for the
      // win32 `.cmd` even when the runner's PATH does not carry it.
      PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ""),
    },
  });
  if (r.error) throw new Error(`__probe is-ready failed to run: ${r.error.message}`);
  if (r.signal) throw new Error(`__probe is-ready was killed by ${r.signal} — it did not bound its own wait`);
  return r.status;
}

test("482: the caller stops a slow probe within its supplied readiness budget", { timeout: 300_000 }, () => {
  assert.ok(existsSync(DISPATCH_JS), `${DISPATCH_JS} must be built — \`npm test\` runs tsc first`);
  const scratch = mkdtempSync(join(tmpdir(), "dispatch-budget-482-"));
  try {
    // Control FIRST: the same launcher mechanism, answering at once, must read as ready.
    // Without this a "not ready" below could be a broken fixture rather than a bounded wait.
    const fast = probeFixture(scratch, "fast-probe", 0);
    assert.equal(isReady(fast.probe, BUDGET_MS), 0, "the fixture launcher must work on this platform");
    assert.equal(readFileSync(fast.marker, "utf8"), "startend", "the control must have replied");

    const slow = probeFixture(scratch, "slow-probe", LATE_REPLY_MS);
    const started = Date.now();
    const status = isReady(slow.probe, BUDGET_MS);
    const elapsed = Date.now() - started;

    assert.ok(existsSync(slow.marker), "the fixture must actually have started");
    assert.ok(readFileSync(slow.marker, "utf8").startsWith("start"), "the fixture must actually have started");
    assert.equal(status, 1, "an over-budget probe must remain not-ready, not become ready later");
    assert.equal(readFileSync(slow.marker, "utf8"), "start",
      "the timed-out observation must not have been allowed to finish its delayed reply");
    // A LIMIT, not a measurement: the caller must have returned instead of waiting for a
    // reply scheduled two minutes out. Deliberately slack for a loaded runner.
    assert.ok(elapsed < LATE_REPLY_MS / 2,
      `the caller waited ${elapsed}ms for a probe whose reply was ${LATE_REPLY_MS}ms away`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
