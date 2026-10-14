// Native Windows controls shared by the report suites. No successful anchored read is simulated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const loadReport = (name) => import(pathToFileURL(path.join(REPO, "dist", "src", "report", `${name}.js`)).href);
export const loadSandbox = () => import(pathToFileURL(path.join(REPO, "dist", "src", "session", "worker-sandbox.js")).href);

export function policyFixture(req, items = {}) {
  const row = { dispatch_id: "a".repeat(32), sid: "w1170-native", attempt: randomUUID(), manifest_sha256: "b".repeat(64),
    from_sid: "orchestrator", lifecycle: "dispatched", gate: null, transport: null, expected_report_by: null,
    dispatched_at: null, superseded_by: null,
    report: { v: 1, request_id: req.request_id, challenge_sha256: req.challenge_sha256, resolution: "open",
      current_final: null, items, failures: [], history: [], history_dropped: 0 } };
  const scan = { items: [], invalid: [], receipt: "unknown", pidsAlive: null, presence: "unknown",
    destination: { ok: true, dest: "orchestrator" }, observed: {}, hookDegraded: [], liveClaimOwners: [] };
  return { row, scan };
}

export function turnItem(seq, newFormal = []) {
  return { key: `TURN-${seq}`, kind: "TURN", seq, sha256: String(seq).repeat(64), bytes: 1,
    raw: Buffer.from("x"), turn: { end: "stop", assoc: "exact", error: null, newFormal } };
}

export async function sandboxRefusal(root, sid, argv, read = [], write = []) {
  const ws = await loadSandbox();
  const stage = path.join(root, sid);
  fs.mkdirSync(stage, { recursive: true });
  const scope = { version: 1, task: "1170", sid, read, write, domains: [] };
  assert.throws(() => ws.prepareWorkerSandbox(scope, "claude", root, argv, stage), /SANDBOX_PLATFORM_UNSUPPORTED/);
  assert.deepEqual(fs.readdirSync(stage), [], "platform refusal precedes staging writes");
}

export function registryFixture(root, req) {
  const state = path.join(root, "registry-state");
  fs.mkdirSync(state, { recursive: true });
  const script = path.join(REPO, "bin", "dispatch-registry.py");
  const python = process.env.AIGENTRY_REPORT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DISPATCH_STATE_DIR: state };
  const reg = (args) => spawnSync(python, [script, ...args], { cwd: REPO, env, encoding: "utf8", timeout: 30000 });
  const call = (args, expected = 0) => {
    const r = reg(args);
    assert.ifError(r.error);
    assert.equal(r.status, expected, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const sid = `w1170-${randomUUID().slice(0, 8)}`;
  const attempt = randomUUID();
  const ref = path.join(root, "ref.md");
  fs.writeFileSync(ref, "native fixture\n");
  const hash = createHash("sha256").update(fs.readFileSync(ref)).digest("hex");
  const now = "2026-10-09T12:00:00Z";
  const begun = call(["begin-delivery", "--sid", sid, "--ref-hash", hash, "--ref-path", ref,
    "--cwd", root, "--from", "orchestrator", "--track", "t1170", "--role", "tester", "--now", now,
    "--attempt", attempt, "--manifest-sha256", "b".repeat(64), "--report-request-id", req.request_id,
    "--report-challenge-sha256", req.challenge_sha256]);
  const did = begun.dispatch_id;
  const event = (kind, item, sha, fields = [], expected = 0) => call(["report-event", "--dispatch-id", did,
    "--kind", kind, "--item", item, ...(sha ? ["--sha256", sha] : []),
    ...fields.flatMap((field) => ["--field", field]), "--now", now], expected);
  const row = () => {
    const r = reg(["report-list", "--sid", sid]);
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim());
  };
  return { did, event, row };
}
