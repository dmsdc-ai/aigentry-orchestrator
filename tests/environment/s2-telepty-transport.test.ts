import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { requestTelepty, validatedTeleptyPort } from "../../src/telepty/http.js";

test("typed loopback request preserves 403 and excludes absent credentials", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-telepty-")));
  const seen: Array<{ url: string | undefined; method: string | undefined; token: unknown }> = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, token: request.headers["x-telepty-token"] });
    response.writeHead(403); response.end("forbidden");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    const result = await requestTelepty({ trustedHome: home }, { operation: "delete-session", id: "fixture-sid", port: address.port });
    assert.equal(result.transportCode, "ok");
    assert.equal(result.httpStatus, 403);
    assert.deepEqual(seen, [{ url: "/api/sessions/fixture-sid", method: "DELETE", token: undefined }]);
    assert.throws(() => validatedTeleptyPort("65536"), /TELEPTY_PORT_INVALID/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("typed transport keeps 404 absence separate from server failure", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-telepty-status-")));
  let status = 404;
  const server = http.createServer((_request, response) => { response.writeHead(status); response.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  try {
    const ask = () => requestTelepty({ trustedHome: home }, { operation: "delete-session", id: "fixture-sid", port: address.port });
    assert.equal((await ask()).httpStatus, 404);
    status = 500;
    const failed = await ask();
    assert.equal(failed.transportCode, "ok");
    assert.equal(failed.httpStatus, 500);
    status = 401;
    assert.equal((await ask()).httpStatus, 401);
    status = 200;
    assert.equal((await ask()).httpStatus, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sole bounded reader supplies a private token and rejects duplicate config", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-telepty-auth-")));
  const config = path.join(home, ".telepty", "config.json");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ authToken: "fixture-secret" }), { mode: 0o600 });
  const seen: unknown[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers["x-telepty-token"]); response.writeHead(200); response.end("ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    const ask = () => requestTelepty({ trustedHome: home }, { operation: "delete-session", id: "fixture-sid", port: address.port });
    assert.equal((await ask()).httpStatus, 200);
    assert.deepEqual(seen, ["fixture-secret"]);
    fs.writeFileSync(config, '{"authToken":"first","authToken":"second"}', { mode: 0o600 });
    assert.equal((await ask()).httpStatus, 200);
    assert.deepEqual(seen, ["fixture-secret", undefined]);
    fs.writeFileSync(config, "x".repeat(131073), { mode: 0o600 });
    assert.equal((await ask()).httpStatus, 200);
    assert.deepEqual(seen, ["fixture-secret", undefined, undefined]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("response body ceiling reports transport unknown instead of accepting partial JSON", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-telepty-body-")));
  const server = http.createServer((_request, response) => {
    response.writeHead(200); response.end("x".repeat(1024 * 1024 + 1));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    const result = await requestTelepty({ trustedHome: home }, { operation: "observe-inject", id: "fixture-sid", port: address.port });
    assert.equal(result.transportCode, "000");
    assert.equal(result.httpStatus, 0);
    assert.equal(result.body, "");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loopback transport bounds a hung response and preserves connection failure as 000", { timeout: 12_000 }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-telepty-timeout-")));
  const server = http.createServer((_request, _response) => { /* intentionally never answer */ });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  try {
    const started = Date.now();
    const hung = await requestTelepty({ trustedHome: home }, {
      operation: "observe-inject", id: "fixture-sid", port: address.port,
    });
    assert.deepEqual(hung, { transportCode: "000", httpStatus: 0, body: "" });
    assert.ok(Date.now() - started < 8_000, "HTTP timeout must bound a hung daemon response");
    assert.rejects(requestTelepty({ trustedHome: home }, {
      operation: "delete-session", id: "../escape", port: address.port,
    }), /TELEPTY_REQUEST_INVALID/);
    assert.rejects(requestTelepty({ trustedHome: home }, {
      operation: "delete-session", id: "fixture-sid", port: 65536,
    }), /TELEPTY_REQUEST_INVALID/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
  const unavailable = await requestTelepty({ trustedHome: home }, {
    operation: "delete-session", id: "fixture-sid", port: address.port,
  });
  assert.deepEqual(unavailable, { transportCode: "000", httpStatus: 0, body: "" });
});
