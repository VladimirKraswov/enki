import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { harness, type Harness } from "./helpers.ts";
let h: Harness;
afterEach(async () => { await h?.stop(); });
it("a fresh UI reads MCP failure and idle recovery opens the same chat without actions", async () => {
  h = await harness();
  const directory = h.project("mcp-recovery"), root = path.join(h.data, "shared"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{
    id: "enki-images", name: "Image tools", enabled: true, kind: "stdio", command: "/not-run-in-test", args: [], url: "", envKeys: [], bearer: false,
  }] }));
  h.runtime.config.capabilities = async () => ({ root, key: "global", executable: "/not-run-in-test", mcp: true, browser: false, lspConfig: null, skillPaths: [] });
  const call = vi.fn(), release = vi.fn();
  vi.spyOn(h.runtime.pool, "acquire").mockRejectedValueOnce(Error("temporary failure")).mockRejectedValueOnce(Error("temporary failure"))
    .mockResolvedValue({ connection: { tools: async () => [{ name: "generate_image", inputSchema: { type: "object", properties: {} } }], call }, release });
  const session = (await h.request<{ id: string }>("POST", "/sessions", { directory, model: h.model() })).body;
  const worker = await h.runtime.registry.worker(session.id); expect(worker.idle()).toBe(true);
  const read = () => h.request<{ sessions: Array<{ sessionID: string; mcp: { servers: Array<{ state: string; tools: string[] }> } }> }>("GET", "/extensions?directory=" + encodeURIComponent(directory));
  const first = await read(); expect(first.body.sessions[0].mcp.servers[0]).toMatchObject({ state: "error", tools: [] });
  expect((await read()).body).toEqual(first.body);
  const refresh = await h.request<{ reopened: number }>("POST", "/capabilities/refresh", { directory }); expect(refresh.body.reopened).toBe(1);
  expect(h.runtime.mcpStatus(session.id)).toBeNull();
  const reopened = await h.runtime.registry.worker(session.id); expect(reopened).not.toBe(worker);
  const recovered = await read(); expect(recovered.body.sessions[0].sessionID).toBe(session.id);
  expect(recovered.body.sessions[0].mcp.servers[0]).toMatchObject({ state: "connected", tools: ["mesh_enki_images_generate_image"] });
  expect(call).not.toHaveBeenCalled(); expect(h.runtime.db.get("select count(*) n from commands")?.n).toBe(0);
  const other = h.project("other"); expect((await h.request<{ sessions: unknown[] }>("GET", "/extensions?directory=" + encodeURIComponent(other))).body.sessions).toEqual([]);
});
