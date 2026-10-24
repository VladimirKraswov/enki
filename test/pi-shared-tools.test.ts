import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { attachShared } from "../src-tauri/resources/shared/pi-extension";
import { needsApproval } from "../src-tauri/resources/pi/tool-gate";
let root: string;
const server = {
  id: "demo",
  name: "Demo",
  enabled: true,
  kind: "stdio",
  command: "/usr/bin/node",
  args: [],
  url: "",
  envKeys: [],
  bearer: false,
};
async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), "pi-shared-"));
  await writeFile(
    path.join(root, "global.json"),
    JSON.stringify({ version: 1, sources: [], servers: [server] }),
  );
  vi.stubEnv("MESH_CAPABILITIES_ROOT", root);
  vi.stubEnv("MESH_CAPABILITIES_KEY", "global");
  vi.stubEnv("MESH_CAPABILITIES_COMMAND", "/tmp/desktop");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const events: any = {},
    tools = new Map<string, any>(),
    pi = {
      on: (n: string, h: any) => {
        events[n] = h;
      },
      registerTool: (t: any) => tools.set(t.name, t),
    },
    ctx = { cwd: root, ui: { notify: vi.fn() } };
  const connection = {
    connect: vi.fn(async () => {}),
    list: vi.fn(async () => ({
      tools: [
        {
          name: "read_project",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    })),
    call: vi.fn(async () => ({ content: [{ type: "text", text: "OK" }] })),
    close: vi.fn(async () => {}),
  };
  const load = vi.fn(async () => connection);
  attachShared(pi as any, load as any);
  return { events, tools, ctx, connection, load };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true });
});
it("metadata-only extension loading starts no process; real startup registers common names with approval", async () => {
  const f = await fixture();
  expect(f.load).not.toHaveBeenCalled();
  await f.events.session_start({}, f.ctx);
  const tool = f.tools.get("mesh_demo_read_project");
  expect(tool).toBeTruthy();
  expect(needsApproval(tool.name)).toBe(true);
  expect(
    await tool.execute("test", {}, new AbortController().signal),
  ).toMatchObject({ content: [{ type: "text", text: "OK" }] });
  await f.events.session_shutdown();
  expect(f.connection.close).toHaveBeenCalled();
});
it("disabled/reconfigured services fail closed for already registered Pi tools", async () => {
  const f = await fixture();
  await f.events.session_start({}, f.ctx);
  await writeFile(
    path.join(root, "global.json"),
    JSON.stringify({
      version: 1,
      sources: [],
      servers: [{ ...server, enabled: false }],
    }),
  );
  await expect(
    f.tools
      .get("mesh_demo_read_project")
      .execute("test", {}, new AbortController().signal),
  ).rejects.toThrow(/Переоткройте/);
  expect(f.connection.call).not.toHaveBeenCalled();
  await f.events.session_shutdown();
});
it("connection failure does not advertise tools or expose upstream error text", async () => {
  const f = await fixture();
  f.connection.connect.mockRejectedValue(Error("private-secret"));
  await f.events.session_start({}, f.ctx);
  expect(f.tools.size).toBe(0);
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain(
    "private-secret",
  );
  expect(f.connection.close).toHaveBeenCalled();
  await f.events.session_shutdown();
});
it("shutdown during discovery does not register late tools", async () => {
  const f = await fixture();
  let release!: () => void;
  f.connection.connect.mockImplementation(
    () => new Promise<void>((r) => (release = r)),
  );
  const pending = f.events.session_start({}, f.ctx);
  await vi.waitFor(() => expect(f.connection.connect).toHaveBeenCalled());
  await f.events.session_shutdown();
  release();
  await pending;
  expect(f.tools.size).toBe(0);
});
it('binds image calls to Pi SessionManager and replaces forged model context', async () => {
  const f = await fixture();
  await writeFile(path.join(root,'global.json'),JSON.stringify({version:1,sources:[],servers:[{...server,id:'enki-images'}]}));
  const ctx={...f.ctx,sessionManager:{getSessionId:()=> 'pi_background'}};
  await f.events.session_start({},ctx);
  const tool=f.tools.get('mesh_enki_images_read_project');
  await tool.execute('test',{__enkiImageContext:{engine:'opencode',sessionID:'forged'},prompt:'keep'},new AbortController().signal,undefined,{...ctx,sessionManager:{getSessionId:()=> 'pi_actual'}});
  expect(f.connection.call).toHaveBeenCalledWith('read_project',{prompt:'keep',__enkiImageContext:{engine:'pi',sessionID:'pi_actual'}},expect.any(AbortSignal));
  await f.events.session_shutdown();
});
