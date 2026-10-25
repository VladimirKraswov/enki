import { describe, expect, it, vi } from "vitest";
import { store } from "../src/state/store";
import { agentControlForTest } from "../src/control/bridge";
import type { ManagedRun } from "../src/control/managedRuns";

describe("agent control MCP", () => {
  const managed = (overrides: Partial<ManagedRun> = {}): ManagedRun => ({
    version: 1,
    serverKey: "local",
    sessionId: "ses_long",
    directory: "/tmp/project",
    boundaryMessageId: null,
    turnBoundaryMessageId: null,
    recoveredMessageIds: [],
    malformedAttempts: 0,
    continuationAttempts: 0,
    maxContinuations: 2,
    completionMarker: "DONE",
    checkpointPath: ".pi/TASK.md",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  // Registration of the control MCP moved from the OpenCode JSONC writer to the
  // shared registry: test/reserved-servers.test.ts ("enki-control: adds its
  // entry…", "…an unrelated entry using the reserved id is kept and refused").

  it("exposes a bounded status snapshot without transport details", async () => {
    const result = (await agentControlForTest.execute("status", {})) as Record<
      string,
      unknown
    >;
    expect(result).toHaveProperty("connection");
    expect(result).toHaveProperty("directory");
    expect(result).toHaveProperty("pending");
    expect(result).not.toHaveProperty("prefs");
  });

  it("refuses the retired OpenCode engine before selecting a project or sending anything", async () => {
    const select = vi.spyOn(store, "setDirectory"), add = vi.spyOn(store, "addProjectDirectory"), send = vi.spyOn(store, "sendPrompt");
    try {
      for (const engine of ["opencode", "codex"])
        await expect(agentControlForTest.execute("send", { directory: "/tmp/project", text: "build it", engine })).rejects.toThrow(/engine/);
      expect(select).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    } finally { select.mockRestore(); add.mockRestore(); send.mockRestore(); }
  });

  it("rejects malformed model selection before mutating the chat", async () => {
    await expect(
      agentControlForTest.execute("configure", { provider_id: "local-only" }),
    ).rejects.toThrow(/supplied together/);
  });

  it("rejects an explicit model that resolves to another model instead of allowing a send", async () => {
    const choose = vi.spyOn(store, "setModelChoice").mockImplementation(() => {});
    const current = vi.spyOn(store, "getModelChoice").mockReturnValue({ providerID: "local", modelID: "other", variant: null });
    try {
      await expect(agentControlForTest.execute("configure", { provider_id: "local", model_id: "unverified" }))
        .rejects.toThrow("No prompt was sent");
    } finally { choose.mockRestore(); current.mockRestore(); }
  });

  it("reports an already idle session immediately instead of timing out", async () => {
    const result = (await agentControlForTest.execute("wait", {
      session_id: "ses_already_idle",
      timeout_seconds: 1,
    })) as { outcome: string };
    expect(result.outcome).toBe("idle");
  });

  it("recognizes a completed textual tool call that OpenCode cannot execute", () => {
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_bad", role: "assistant", finish: "stop" },
        [
          {
            type: "text",
            text: "<tool_call>\n<function=bash>\ndate\n</parameter>\n</function>\n</tool_call>",
          },
        ],
      ),
    ).toBe(true);
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_truncated", role: "assistant", finish: "stop" },
        [
          {
            type: "text",
            text: "<tool_call>\n<function=bash>\n<parameter=command>date",
          },
        ],
      ),
    ).toBe(true);
  });

  it("does not retry normal text, user text, unfinished turns or real tool calls", () => {
    const marker =
      "<tool_call>\n<function=bash>\ndate\n</parameter>\n</function>\n</tool_call>";
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_ok", role: "assistant", finish: "stop" },
        [{ type: "text", text: "Работа закончена." }],
      ),
    ).toBe(false);
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_user", role: "user", finish: "stop" },
        [{ type: "text", text: marker }],
      ),
    ).toBe(false);
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_busy", role: "assistant", finish: null },
        [{ type: "text", text: marker }],
      ),
    ).toBe(false);
    expect(
      agentControlForTest.malformedToolCallMessage(
        { id: "msg_tool", role: "assistant", finish: "stop" },
        [
          { type: "text", text: marker },
          { type: "tool", text: "" },
        ],
      ),
    ).toBe(false);
  });

  it("uses independent bounded budgets for malformed calls and incomplete work", () => {
    expect(agentControlForTest.decideManagedIdle(managed(), "msg_bad", false)).toEqual({
      kind: "retry_malformed",
      messageId: "msg_bad",
    });
    expect(
      agentControlForTest.decideManagedIdle(
        managed({ malformedAttempts: 2 }),
        "msg_bad",
        false,
      ),
    ).toEqual({ kind: "recovery_exhausted", messageId: "msg_bad" });
    expect(agentControlForTest.decideManagedIdle(managed(), null, true)).toEqual({
      kind: "completed",
    });
    expect(agentControlForTest.decideManagedIdle(managed(), null, false)).toEqual({
      kind: "continue",
    });
    expect(
      agentControlForTest.decideManagedIdle(
        managed({ continuationAttempts: 2 }),
        null,
        false,
      ),
    ).toEqual({ kind: "incomplete" });
  });

  it("accepts a completion marker only as its own exact line", () => {
    expect(agentControlForTest.containsCompletionMarker("done\nACCEPTANCE_DONE\n", "ACCEPTANCE_DONE")).toBe(true);
    expect(agentControlForTest.containsCompletionMarker("will later print ACCEPTANCE_DONE", "ACCEPTANCE_DONE")).toBe(false);
    expect(agentControlForTest.containsCompletionMarker("ACCEPTANCE_DONE_SUFFIX", "ACCEPTANCE_DONE")).toBe(false);
  });

  it("does not cross a tool-call boundary before the final assistant answer", () => {
    expect(agentControlForTest.isFinalAssistant({ role: "assistant", finish: "tool-calls" })).toBe(false);
    expect(agentControlForTest.isFinalAssistant({ role: "assistant", finish: null })).toBe(false);
    expect(agentControlForTest.isFinalAssistant({ role: "assistant", finish: "stop" })).toBe(true);
  });
});
