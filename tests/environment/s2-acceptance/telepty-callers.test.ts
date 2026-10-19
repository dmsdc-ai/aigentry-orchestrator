import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { requestTelepty } from "../../../src/telepty/http.js";
import { finish, fixture } from "./fixture.js";

test("owned loopback endpoint records truthful statuses, method, port, and private reader behavior", { skip: process.platform === "win32" }, async () => {
  const root = fixture();
  const config = path.join(root, ".telepty", "config.json");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ authToken: "fixture-token" }), { flag: "wx", mode: 0o600 });
  let status = 200;
  let port = 0;
  const received: Array<{ method: string | undefined; url: string | undefined; authenticated: boolean }> = [];
  const server = http.createServer((request, response) => {
    received.push({ method: request.method, url: request.url,
      authenticated: request.headers["x-telepty-token"] === "fixture-token" });
    response.writeHead(status); response.end(status === 200 ? "{\"ok\":true}" : "failure");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server address missing");
    port = address.port;
    for (status of [200, 401, 403, 404, 500]) {
      const response = await requestTelepty({ trustedHome: root },
        { operation: "delete-session", id: "fixture-sid", port: address.port, discardBody: true });
      assert.equal(response.transportCode, "ok");
      assert.equal(response.httpStatus, status);
      assert.equal(response.body, "");
    }
    assert.equal(received.length, 5);
    for (const r of received) {
      assert.deepEqual({ method: r.method, url: r.url, authenticated: r.authenticated },
        { method: "DELETE", url: "/api/sessions/fixture-sid", authenticated: true });
    }
    fs.writeFileSync(config, '{"authToken":"one","authToken":"two"}', { mode: 0o600 });
    const malformed = await requestTelepty({ trustedHome: root },
      { operation: "observe-inject", id: "fixture-sid", port: address.port });
    assert.equal(malformed.httpStatus, 500);
    assert.equal(received.at(-1)?.authenticated, false);
    assert.equal(received.at(-1)?.method, "GET");
    assert.equal(received.at(-1)?.url, "/api/inject-observations/fixture-sid");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const unavailable = await requestTelepty({ trustedHome: root },
    { operation: "delete-session", id: "fixture-sid", port });
  assert.deepEqual(unavailable, { transportCode: "000", httpStatus: 0, body: "" });
  finish(root, { statuses: [200, 401, 403, 404, 500, "000"], requests: received });
});
