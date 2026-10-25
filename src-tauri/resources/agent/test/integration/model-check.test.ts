// POST /models/check: the explicit access probe runs one real (scripted)
// request in an ephemeral, tool-less SDK session. Carries the invariants of
// the retired Pi CLI probe suites (test/pi-probe-id.test.ts, pi-backend
// "loads a capability probe without a session so it leaves no chat behind"):
// no persistent session, no transcript, no event in another chat, no identity
// collision between concurrent probes. Written, NOT RUN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage, scriptedRuntime } from "../../src/sdk/testing.ts";
import { harness, newSession, tempDir, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });
const sessionFiles = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(entry.parentPath, entry.name));

it("a successful probe answers once and leaves no chat, session file or transcript behind", async () => {
  const data = tempDir("model-check");
  const scripted = await scriptedRuntime(path.join(data, "scripted-agent"));
  h = await harness({ data, scripted });
  const dir = h.project("probe");
  const sid = await newSession(h, dir);
  const before = sessionFiles(data);
  h.scripted.setResponses([fauxAssistantMessage("OK")]);
  const model = h.model();
  const checked = await h.request<{ ok: boolean; detail: string }>("POST", "/models/check", model);
  expect(checked.status).toBe(200);
  expect(checked.body).toEqual({ ok: true, detail: "Модель ответила на тестовый запрос." });
  expect(h.scripted.calls()).toBe(1);
  expect(sessionFiles(data)).toEqual(before);
  const recent = await h.request<{ sessions: Array<{ id: string }> }>("GET", "/sessions/recent");
  expect(recent.body.sessions.map((s) => s.id)).toEqual([sid]);
  const history = await h.request<{ messages: unknown[] }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages).toEqual([]);
});

it("a failed or unknown model is reported as not confirmed, never as success, and leaves nothing behind", async () => {
  h = await harness();
  h.scripted.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
  const failed = await h.request<{ ok: boolean; detail: string }>("POST", "/models/check", h.model());
  expect(failed.body.ok).toBe(false);
  expect(failed.body.detail).toContain("401 invalid api key");
  const unknown = await h.request<{ ok: boolean; detail: string }>("POST", "/models/check", { providerID: "enki-scripted", modelID: "missing" });
  expect(unknown.body).toMatchObject({ ok: false, detail: expect.stringContaining("не найдена") });
  expect((await h.request<{ sessions: unknown[] }>("GET", "/sessions/recent")).body.sessions).toEqual([]);
});

it("concurrent probes never share a session identity or a transcript", async () => {
  h = await harness();
  h.scripted.setResponses([fauxAssistantMessage("OK"), fauxAssistantMessage("OK")]);
  const [a, b] = await Promise.all([h.request<{ ok: boolean }>("POST", "/models/check", h.model()), h.request<{ ok: boolean }>("POST", "/models/check", h.model("small"))]);
  expect([a.body.ok, b.body.ok]).toEqual([true, true]);
  expect(h.scripted.calls()).toBe(2);
  expect((await h.request<{ sessions: unknown[] }>("GET", "/sessions/recent")).body.sessions).toEqual([]);
});
