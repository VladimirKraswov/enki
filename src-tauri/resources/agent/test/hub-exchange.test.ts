import { expect, it, vi } from "vitest";
import { hubExchangeTool, boundedHubToolResult } from "../src/extensions/hub-exchange.ts";
import type { Broker } from "../src/control/broker.ts";
import { decide } from "../src/interaction/access.ts";

function fixture() {
  const requests: Array<Record<string, unknown>> = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("cancelled");
    if (method === "hub.identity") return { scope: "pinned-profile" };
    requests.push(params);
    return params.path === "workshop/presence" ? { registered: true } : { accepted: true, items: [{ text: "Untrusted message" }] };
  });
  const broker = { kind: "supervisor", available: () => true, call } as unknown as Broker;
  return { tool: hubExchangeTool(broker, "actual-session"), call, requests };
}

it("source exchange does not inject a megabyte of base64 into the model context and oversized lists are marked truncated",()=>{
  const source=boundedHubToolResult("change",{id:"receipt",payload:{files:{"src/x.ts":"a".repeat(1_000_000)},commit:"commit"}});
  expect(source.text).toContain("src/x.ts");expect(source.text).not.toContain("a".repeat(100));
  expect(source.result).toMatchObject({payload:{files:["src/x.ts"],commit:"commit"}});
  const list=boundedHubToolResult("logs",{items:[{text:"z".repeat(40000)}]});
  expect(list.text.length).toBeLessThan(33000);expect(list.text).toContain("Result truncated");
});

it("discovers agents and reads only the actual session inbox without acknowledgement or task execution", async () => {
  const f = fixture();
  await f.tool.execute("read-1", { action: "inbox" });
  expect(f.requests[0]).toMatchObject({ path: "workshop/presence", body: { agent: "enki", session: "actual-session" }, scope: "pinned-profile" });
  expect(f.requests[1].path).toBe("workshop/inbox?limit=50&agent=enki&session=actual-session");
  expect(f.requests).toHaveLength(2);
});

it("binds the sender and preserves an explicit request ID for lost-ACK retries", async () => {
  const f = fixture();
  const input = { action: "send" as const, recipient: "windows-device", recipientSession: "win-session", text: "Review", requestId: "same-operation" };
  await f.tool.execute("call-1", input);
  await f.tool.execute("call-2", input);
  const sends = f.requests.filter(p => p.path === "workshop/messages");
  expect(sends[0]).toEqual(sends[1]);
  expect(sends[0].body).toMatchObject({ session: "actual-session", agent: "enki", requestId: "same-operation", recipientAgent: "enki" });
});

it("keeps status and delivery available when the optional presence heartbeat fails", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "hub.identity") return { scope: "pinned-profile" };
    if (params.path === "workshop/presence") throw new Error("Hub HTTP 400");
    requests.push(params);
    return { accepted: true, items: [] };
  });
  const tool = hubExchangeTool({ kind: "supervisor", available: () => true, call } as unknown as Broker, "actual-session");
  const result = await tool.execute("status-1", { action: "status" });
  expect(requests.map(p => p.path)).toEqual(["workshop/status"]);
  expect(result.content[0].text).toContain("Presence warning");
});

it("fails closed on disabled Hub and cancelled requests without a direct-network fallback", async () => {
  const f = fixture(); f.call.mockResolvedValueOnce({ scope: null } as never);
  await expect(f.tool.execute("s", { action: "status" })).rejects.toThrow("Hub не подключён");
  expect(f.requests).toHaveLength(0);
  await expect(f.tool.execute("s", { action: "status" }, AbortSignal.abort())).rejects.toThrow("cancelled");
  expect(f.requests).toHaveLength(0);
});

it("uses the ordinary runtime permission decision and cannot turn a read grant into a send grant", () => {
  const query = { rules: [], grants: [], fallback: "ask" as const, cwd: "/fixture", tool: "hub_exchange", input: { action: "status" } };
  expect(decide({ ...query, fallback: "read" }).decision).toBe("deny");
  const read = decide(query); expect(read.decision).toBe("ask");
  const send = decide({ ...query, input: { action: "send", text: "review" } as Record<string, unknown>,
    grants: [{ permission: read.permission, pattern: read.pattern, identity: read.identity }] });
  expect(send.decision).toBe("ask"); expect(send.identity).not.toBe(read.identity);
});

it("routes session.create and prompt through the receiving Runtime dispatcher, not the message queue", async () => {
  const f = fixture();
  await f.tool.execute("c1", { action: "create-session", recipient: "mac2", directory: "/proj", text: "Привет" });
  const create = f.requests.find(p => p.path === "remote/command");
  expect(create?.body).toMatchObject({ device: "mac2", session: null, kind: "session.create",
    payload: { directory: "/proj", prompt: "Привет" } });
  await f.tool.execute("c2", { action: "prompt", recipient: "mac2", recipientSession: "sess", text: "Продолжи",
    model: JSON.stringify({ providerID: "p", modelID: "m" }) });
  const prompt = f.requests.filter(p => p.path === "remote/command")[1];
  expect(prompt?.body).toMatchObject({ device: "mac2", session: "sess", kind: "prompt",
    payload: { text: "Продолжи", model: { providerID: "p", modelID: "m" } } });
});

it("keeps the model optional so an unpinned prompt still routes and the receiver picks the model", async () => {
  const f = fixture();
  await f.tool.execute("c", { action: "prompt", recipient: "mac2", recipientSession: "sess", text: "Без модели" });
  const prompt = f.requests.find(p => p.path === "remote/command");
  expect(prompt?.body).toMatchObject({ kind: "prompt", payload: { text: "Без модели" } });
  expect(JSON.stringify(prompt?.body)).not.toContain("model");
});

it("reads the device overview and a single command state for the receiver", async () => {
  const f = fixture();
  await f.tool.execute("o", { action: "overview" });
  expect(f.requests.find(p => p.path === "remote/overview")).toBeTruthy();
  await f.tool.execute("q", { action: "command", id: "call_00_abc" });
  expect(f.requests.find(p => p.path === "remote/command?id=call_00_abc")).toBeTruthy();
});

it("rejects remote commands without the required recipient fields", async () => {
  const f = fixture();
  await expect(f.tool.execute("c", { action: "create-session", recipient: "mac2", directory: "/proj", text: "" })).rejects.toThrow("Нужны устройство, папка и текст.");
  await expect(f.tool.execute("c", { action: "prompt", recipient: "mac2", recipientSession: "", text: "x" })).rejects.toThrow("Нужны устройство, сессия и текст.");
});
