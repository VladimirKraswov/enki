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
