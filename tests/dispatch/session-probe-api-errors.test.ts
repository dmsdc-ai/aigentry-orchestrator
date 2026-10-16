import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Compiled location: <repo>/dist/tests/dispatch/*.test.js (Node 20+).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.env.PYTHON || "python3";
type Case = { name: string; screen: string; surface: string; action: string; tracker: string };
const cases: Case[] = [];
const working = "Working (3s • esc to interrupt)";
function add(name: string, screen: string, surface: string, action = "NOOP", tracker = "NOOP") {
  cases.push({ name, screen, surface, action, tracker });
}
const quoted = {
  "quoted-rate": '  const response = { code: "rate_limited" };',
  "hash-529": "  SHA256: a7f1529b44d883c021d87ba2133ee8401738103b7f01d0948bd3d301ba21cde02",
  "quoted-timeout": '  tool_fixture = {"failure": "ETIMEDOUT"}',
  "json-api": '  {"sample": "API Error: example message"}',
  "code-api": '  const label = "API Error";',
};
for (const [name, body] of Object.entries(quoted)) {
  for (const active of [true, false]) {
    for (const layout of ["multiline", "compact", "ansi"]) {
      let screen = `Quoted source excerpt:\n\`\`\`text\n${body}\n\`\`\`\n${active ? working : "›"}\n`;
      if (layout === "compact") screen = screen.replaceAll("\n", " ");
      if (layout === "ansi") screen = `\x1b[36m${screen}\x1b[0m`;
      add(`${name}-${active ? "active" : "idle"}-${layout}`, screen, active ? "working" : "idle");
    }
  }
}
const controls: [string, string, string, string, string][] = [
  ["provider-api", "API Error: 503 service unavailable", "error", "AWAIT_USER", "ESCALATE"],
  ["provider-rate", "API Error: rate_limited", "error", "AWAIT_USER", "ESCALATE"],
  ["transport", "Connection failed: ECONNREFUSED", "error", "AWAIT_USER", "NOOP"],
  ["transport-timeout", "Connection failed: ETIMEDOUT", "error", "AWAIT_USER", "NOOP"],
  ["sleep-cut", "API Error: Your computer went to sleep mid-response. The response above may be incomplete.", "sleep_cut", "RESUME", "ESCALATE"],
  ["sandbox", "Would you like to run the following command?\n1. Yes\n2. No", "sandbox_prompt", "SEND_KEY", "NOOP"],
  ["unknown-error", "Unexpected failure: ZXQ", "unknown", "ESCALATE", "ESCALATE"],
];
for (const [name, body, surface, action, tracker] of controls) {
  for (const active of [false, true]) {
    if (active && name === "unknown-error") continue;
    add(`${name}-${active ? "active" : "static"}`, body + (active ? `\n${working}` : ""), surface, action, tracker);
  }
}
add("clean-active", working, "working");
add("clean-idle", "›", "idle");
// Synthetic recognizable shapes, not authenticated provider captures.
for (const [name, body] of [
  ["csi", "\x1b[31mAPI Error:\x1b[0m 503 unavailable"],
  ["osc-bel", "\x1b]8;;https://example.invalid\x07API Error: 503\x1b]8;;\x07"],
  ["osc-st", "\x1b]0;title\x1b\\API Error: 503"],
  ["three-spaces", "   API Error: 503"],
  ...["✖", "✘", "×", "⚠️", "!"].map(glyph => [`glyph-${glyph}`, `${glyph} API Error: 503`]),
  ["connection-token-punctuation", "Connection failed: ETIMEDOUT (retry)"],
]) add(name!, `${body}\n${working}`, "error", "AWAIT_USER", body!.includes("API Error:") ? "ESCALATE" : "NOOP");
for (const [name, body] of [
  ["fence-before-tail20", "```text\n" + "context\n".repeat(25) + "API Error: 503\n```"],
  ["tilde-fence", "~~~text\nAPI Error: 503\n~~~"],
  ["short-backtick-closer", "````\n```\nAPI Error: 503"],
  ["short-tilde-closer", "~~~~\n~~~\nAPI Error: 503"],
  ["wrong-fence-closer", "```\n~~~\nAPI Error: 503"],
  ["closer-with-text", "```\n``` not a close\nAPI Error: 503"],
  ["four-spaces", "    API Error: 503"],
  ["tab", "\tAPI Error: 503"],
  ["mixed-indent", " \tAPI Error: 503"],
  ["quoted-prefix", "> API Error: 503"],
  ["tool-prefix", "tool: API Error: 503"],
  ["string-prefix", '"API Error: 503"'],
  ["empty-banner", "API Error:"],
  ["blank-diagnostic", "API Error:   "],
  ["missing-colon", "API Error 503"],
  ["unknown-transport", "Connection failed: EPIPE"],
  ["transport-token-suffix", "Connection failed: ETIMEDOUT_OTHER"],
  ["transport-empty", "Connection failed:"],
  ["unknown-provider", "Provider unavailable: 503"],
  ["bare-number", "529"],
  ["stale-outside-tail20", "API Error: 503\n" + "context\n".repeat(20)],
]) add(name!, `${body}\n›`, "idle");
for (const [name, body] of [
  ["longer-backtick-closer", "```\nexample\n````\nAPI Error: 503"],
  ["longer-tilde-closer", "~~~\nexample\n~~~~\nAPI Error: 503"],
  ["tail20-included", "API Error: 503\n" + "context\n".repeat(18)],
  // Missing opening context and stale-but-in-tail banners cannot be authenticated.
  ["truncated-opening-fence", "API Error: 503\n```"],
  ["stale-within-tail20", "API Error: 503\nPrevious response ended."],
]) add(name!, `${body}\n›`, "error", "AWAIT_USER", "ESCALATE");
add("blank-screen", "", "unknown", "ESCALATE", "ESCALATE");
add("unknown-banner-alone", "Provider unavailable: 503", "unknown", "ESCALATE", "ESCALATE");
add("genuine-tracker-command-error", "command not found: missing-command\n›", "idle", "NOOP", "ESCALATE");
add("genuine-tracker-panic", "panic: unrecoverable runtime failure", "crash", "REDISPATCH", "ESCALATE");

for (const row of cases) {
  for (const status of ["in_flight", "tracker_check"]) {
    test(`${row.name} / ${status}`, () => {
      const root = mkdtempSync(join(tmpdir(), "session-probe-api-"));
      try {
        const screen = join(root, "screen.txt"), info = join(root, "info.json");
        writeFileSync(screen, row.screen);
        writeFileSync(info, JSON.stringify({ command: "codex", healthStatus: "CONNECTED", ready: true,
          transport: { ready: true, bootstrap: { ready: true } } }));
        const run = (args: string[], input?: string) => {
          const result = spawnSync(python, args, { encoding: "utf8", timeout: 10000,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TELEPTY: "offline-session-api-forbidden" },
            ...(input === undefined ? {} : { input }) });
          if (process.env.API_ERROR_COMMAND_LOG) appendFileSync(process.env.API_ERROR_COMMAND_LOG,
            JSON.stringify({ argv: [python, ...args], cwd: process.cwd(), input, exit: result.status,
              stdout: result.stdout, stderr: result.stderr, error: result.error?.message }) + "\n");
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0, result.stderr);
          return JSON.parse(result.stdout);
        };
        const state = run([join(repo, "bin/session-probe.py"), "--sid", "api-error-fixture", "--screen-file", screen, "--info-file", info]);
        const action = run([join(repo, "bin/policy.py"), "--status", status, "--state", "-"], JSON.stringify(state));
        if (process.env.API_ERROR_OBSERVATIONS) appendFileSync(process.env.API_ERROR_OBSERVATIONS,
          JSON.stringify({ name: row.name, status, state, action, expected: row }) + "\n");
        assert.equal(state.surface, row.surface);
        assert.equal(action.action, status === "in_flight" ? row.action : row.tracker);
        if (status === "tracker_check" && row.tracker === "ESCALATE" && row.surface !== "unknown") {
          assert.equal(state.detail.tracker_class, "error");
          assert.equal(action.status, "stuck_error");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
