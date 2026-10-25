// The approval gate for every tool in an SDK-hosted Pi session.
//
// Enki Runtime installs this gate into every real session, so its default
// behaviour is a security property, not a preference. The policy now comes from
// the session's access mode (no process environment), so two sessions in one
// runtime can have different policies.

import { expect, it, vi } from "vitest";
import { createToolGate, describe, isMutating, needsApproval, policyVerdict, type Policy, type ToolGateOptions } from "../src-tauri/resources/pi/tool-gate";

type Handler = (
  event: { toolName: string; toolCallId: string; input?: unknown },
  ctx: { cwd: string; signal?: AbortSignal },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

function install(policy: () => Policy, approve: ToolGateOptions["approve"]): { call: Handler } {
  let handler: Handler | undefined;
  createToolGate({ decide: (tool, input, _cwd, temporary) => policyVerdict(policy(), tool, input, temporary), approve })({
    on: (event: string, fn: Handler) => { if (event === "tool_call") handler = fn; },
  } as never);
  if (!handler) throw new Error("gate did not subscribe to tool_call");
  return { call: handler };
}
const ctx = { cwd: "/project" };

it("asks before anything that is not a known read-only tool", () => {
  for (const tool of ["write", "edit", "bash", "apply_patch", "fetch"]) expect(needsApproval(tool)).toBe(true);
  expect(needsApproval("some_future_tool")).toBe(true);
  for (const tool of ["read", "glob", "grep", "find", "ls", "lsp_diagnostics"]) expect(needsApproval(tool)).toBe(false);
  expect(isMutating("bash")).toBe(true);
  expect(isMutating("some_future_tool")).toBe(false);
});

it("blocks a mutating tool the user declines and passes an approved one untouched", async () => {
  const declined = install(() => "ask", vi.fn().mockResolvedValue(false));
  const result = await declined.call({ toolName: "write", toolCallId: "c1", input: { path: "src/main.rs" } }, ctx);
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("не разрешил");
  const approved = install(() => "ask", vi.fn().mockResolvedValue(true));
  expect(await approved.call({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, ctx)).toBeUndefined();
});

it("never asks about read-only tools", async () => {
  const approve = vi.fn();
  const { call } = install(() => "ask", approve);
  expect(await call({ toolName: "read", toolCallId: "c", input: { path: "a.ts" } }, ctx)).toBeUndefined();
  expect(approve).not.toHaveBeenCalled();
});

it("denies when the approval path fails or answers anything but true", async () => {
  expect((await install(() => "ask", vi.fn().mockRejectedValue(new Error("no client"))).call({ toolName: "edit", toolCallId: "c", input: { path: "x" } }, ctx))?.block).toBe(true);
  expect((await install(() => "ask", vi.fn().mockResolvedValue(undefined as unknown as boolean)).call({ toolName: "edit", toolCallId: "c", input: { path: "x" } }, ctx))?.block).toBe(true);
});

it("a decision failure is a denial, not a pass-through", async () => {
  let handler: Handler | undefined;
  createToolGate({ decide: () => { throw new Error("corrupt rules"); }, approve: vi.fn() })({ on: (_e: string, fn: Handler) => { handler = fn; } } as never);
  expect((await handler!({ toolName: "write", toolCallId: "c", input: {} }, ctx))?.block).toBe(true);
});

it("full allows every tool; read blocks mutations without approval dialogs", async () => {
  let policy: Policy = "full";
  const approve = vi.fn().mockResolvedValue(true);
  const { call } = install(() => policy, approve);
  for (const toolName of ["bash", "edit", "mesh_custom_tool", "desktop_browser_browser_file_upload"])
    expect(await call({ toolName, toolCallId: "c", input: {} }, ctx)).toBeUndefined();
  policy = "read";
  expect((await call({ toolName: "bash", toolCallId: "c", input: {} }, ctx))?.block).toBe(true);
  expect(await call({ toolName: "read", toolCallId: "c", input: {} }, ctx)).toBeUndefined();
  expect(approve).not.toHaveBeenCalled();
});

it("shows the user what is actually about to happen and forwards the tool signal", async () => {
  const approve = vi.fn().mockResolvedValue(false);
  const { call } = install(() => "ask", approve);
  const signal = new AbortController().signal;
  await call({ toolName: "bash", toolCallId: "call-7", input: { command: "rm -rf build" } }, { cwd: "/p", signal });
  const [request] = approve.mock.calls[0];
  expect(request.title).toContain("изменить файлы или выполнить команду");
  expect(request.summary).toContain("rm -rf build");
  expect(request.toolCallId).toBe("call-7");
  expect(request.signal).toBe(signal);
  expect(describe("write", { path: "x".repeat(500) })).toContain("…");
});
