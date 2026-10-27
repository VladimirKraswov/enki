// Loopback transport security: bearer required, constant-time compare with
// rotation grace, no tokens in URLs, DNS-rebinding Host guard, exact CORS
// allowlist without wildcard.
import { afterEach, expect, it } from "vitest";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ConfigurationGate } from "../src/lifecycle.ts";
import { harness, ORIGIN, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

function raw(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
    });
    request.on("error", reject);
    request.end();
  });
}

it("refuses unauthenticated, token-in-URL and rebinding requests", async () => {
  h = await harness();
  const port = Number(new URL(h.base).port);
  expect((await raw(port, "/v1/health", {})).status).toBe(401);
  expect((await raw(port, "/v1/health", { Authorization: "Bearer wrong-token-wrong-token-wrong-token-00" })).status).toBe(401);
  expect((await raw(port, `/v1/health?token=${h.token}`, { Authorization: `Bearer ${h.token}` })).status).toBe(400);
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${h.token}`, Host: "evil.example:80" })).status).toBe(421);
  const ok = await raw(port, "/v1/health", { Authorization: `Bearer ${h.token}` });
  expect(ok.status).toBe(200);
  expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
});

it("answers CORS only for the exact app origin", async () => {
  h = await harness();
  const port = Number(new URL(h.base).port);
  const allowed = await raw(port, "/v1/health", { Authorization: `Bearer ${h.token}`, Origin: ORIGIN });
  expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN);
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${h.token}`, Origin: "https://evil.example" })).status).toBe(403);
});

it("accepts the previous token only during the rotation grace period", async () => {
  h = await harness();
  const port = Number(new URL(h.base).port);
  const old = h.token;
  h.credentials.previous = { token: old, until: Date.now() + 60_000 };
  h.credentials.current = "n".repeat(43);
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${old}` })).status).toBe(200);
  h.credentials.previous = { token: old, until: Date.now() - 1 };
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${old}` })).status).toBe(401);
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${"n".repeat(43)}` })).status).toBe(200);
});

it("settles a lost rotation ACK after expiry without reinstalling or restarting the runtime", async () => {
  h = await harness();
  const port = Number(new URL(h.base).port), instance = h.runtime.instance;
  const gate = new ConfigurationGate();
  gate.configure({ token: h.token, origins: [ORIGIN], version: "test", generation: "g".repeat(43), requestId: randomUUID() });
  const request = { requestId: randomUUID(), token: "n".repeat(43), graceMs: 120000 };
  const install = () => {
    h.credentials.previous = { token: h.token, until: Date.now() - 1 };
    h.credentials.current = request.token;
  };
  gate.rotate(request, install); // runtime applied it; the supervisor loses this ACK
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${h.token}` })).status).toBe(401);
  expect(gate.rotate(request, () => { throw Error("must only return the stored receipt"); })).toMatchObject({ ok: true, id: request.requestId });
  expect((await raw(port, "/v1/health", { Authorization: `Bearer ${request.token}` })).status).toBe(200);
  expect(h.runtime.instance).toBe(instance);
  expect(() => gate.rotate({ ...request, token: "z".repeat(43) }, install)).toThrow("different authority");
});

it("a malformed escape in a path parameter is a 400, never an internal 500", async () => {
  h = await harness();
  const port = Number(new URL(h.base).port);
  expect((await raw(port, "/v1/sessions/%E0%A4", { Authorization: `Bearer ${h.token}` })).status).toBe(400);
  expect((await raw(port, "/v1/sessions/%ZZ", { Authorization: `Bearer ${h.token}` })).status).toBe(400);
});

it("health reports versions and the pinned SDK contract", async () => {
  h = await harness();
  const health = await h.request<{ contract: number; sdk: string; node: string; instance: string }>("GET", "/health");
  expect(health.body).toMatchObject({ contract: 1, sdk: "0.85.1", instance: h.runtime.instance });
});
