import { describe, expect, it } from "vitest";
import { hubRemoteTool } from "../src-tauri/resources/agent/src/extensions/hub-remote";

function fakeBroker(overview: unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    broker: {
      kind: "supervisor" as const,
      available: () => true,
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "hub.identity") return { scope: "hub-scope" };
        if (params.path === "remote/overview") return overview;
        return { id: "cmd-1", state: "queued" };
      },
    },
  };
}

describe("Hub remote tool", () => {
  it("summarizes devices without leaking the provider catalog", async () => {
    const { broker, calls } = fakeBroker({ devices: [{
      id: "device-1", name: "Windows", platform: "other", appVersion: "2.0.85",
      online: true, seen: 1, revision: 2,
      overview: {
        host: "local", statuses: { s: { type: "idle" } }, activity: { idle: true },
        sessions: [{ id: "s", title: "work", directory: "C:\\work", time: { updated: 9 } }],
        providers: { all: [{ id: "secret-provider", auth: { configured: true } }] },
      },
    }] });
    const tool = hubRemoteTool(broker as never);
    const result = await tool.execute("call-1", { action: "status" } as never);
    const text = result.content[0].text;
    expect(text).toContain("device-1");
    expect(text).toContain("Windows");
    expect(text).toContain("work");
    expect(text).not.toContain("secret-provider");
    expect(calls.filter(c => c.params.path).map(c => c.params.path)).toEqual(["remote/overview"]);
  });

  it("allows only update/settings commands and sends the exact device/id", async () => {
    const { broker, calls } = fakeBroker({ devices: [] });
    const tool = hubRemoteTool(broker as never);
    await tool.execute("call-2", {
      action: "command", device: "device-1", kind: "update.check", id: "cmd-2",
    } as never);
    expect(calls.at(-1)?.params.body).toMatchObject({ device: "device-1", kind: "update.check", id: "cmd-2" });
    await expect(tool.execute("call-3", {
      action: "command", device: "device-1", kind: "prompt",
    } as never)).rejects.toThrow("не разрешена");
    await expect(tool.execute("call-4", {
      action: "command", kind: "update.check",
    } as never)).rejects.toThrow("ID устройства");
  });
});
