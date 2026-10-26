// Per-turn policy of the runtime (extensions/enki.ts "enki-turn-policy"). The
// window no longer has to attach language/tool/timer/workshop reminders to
// queued or steered items: every turn of a session gets them in its system
// prompt here. Carries "workshop queued corrections retain release
// authorization when steering now" (retired store-regressions case) and the
// browser scope rule. Written, NOT RUN.
import { describe, expect, it } from "vitest";
import { browserAccess, enkiExtensions, type ExtensionDeps } from "../src/extensions/enki.ts";
import type { SdkExtension } from "../src/sdk/adapter.ts";
import { languageReminder, scheduleReminder, sessionPolicyBlocks, userWaitReminder } from "../src/policy/prompt.ts";
import { toolWorkflowReminder } from "../src/policy/toolWorkflow.ts";
import { workshopReminder } from "../src/policy/workshop.ts";

type Handler = (event: { systemPrompt: string }) => { systemPrompt: string };
type NamedExtension = Extract<SdkExtension, { factory: unknown }>;
function turnPolicy(workshop: () => boolean): Handler {
  const deps = { broker: {}, journal: {}, pool: {}, defaultPolicy: () => "ask", capabilities: null } as unknown as ExtensionDeps;
  const extensions = enkiExtensions({ sessionID: "ses/1", directory: "/work", rules: () => [], workshop }, deps);
  // InlineExtension is `ExtensionFactory | { name; factory }`: narrow to the named form.
  const policy = extensions.find((e): e is NamedExtension => typeof e !== "function" && e.name === "enki-turn-policy")!;
  let handler: Handler | undefined;
  policy.factory({ on: (name: string, h: Handler) => { if (name === "before_agent_start") handler = h; } } as never);
  return handler!;
}

describe("turn policy", () => {
  it("appends the session's language, tool workflow and timer blocks to every turn without touching the base prompt", () => {
    const out = turnPolicy(() => false)({ systemPrompt: "BASE" }).systemPrompt;
    expect(out.startsWith("BASE\n\n")).toBe(true);
    for (const block of [languageReminder("ses/1"), toolWorkflowReminder("ses/1"), userWaitReminder("ses/1"), scheduleReminder("ses/1", "/work")]) expect(out).toContain(block);
    expect(out).toContain("инструмент question");
    expect(out).toContain("согласованные действия не требуют нового вопроса");
    expect(out).not.toContain(workshopReminder("ses/1"));
  });

  it("re-reads the workshop flag per turn, so a queued or steered correction keeps the release authorization", () => {
    let workshop = true;
    const handler = turnPolicy(() => workshop);
    expect(handler({ systemPrompt: "BASE" }).systemPrompt).toContain(workshopReminder("ses/1"));
    workshop = false;
    expect(handler({ systemPrompt: "BASE" }).systemPrompt).not.toContain("arvela-workshop-release-v1");
  });

  it("blocks are scoped to their own session id and directory", () => {
    const blocks = sessionPolicyBlocks("a", "/one", true);
    expect(blocks).toEqual([languageReminder("a"), toolWorkflowReminder("a"), userWaitReminder("a"), scheduleReminder("a", "/one"), workshopReminder("a")]);
    for (const block of blocks) expect(block).toContain('session="a"');
    expect(blocks.join("")).not.toContain('session="b"');
    expect(scheduleReminder("a", '/a"b')).toContain(JSON.stringify('/a"b'));
  });
});

describe("browser scope", () => {
  it("leaves the project only with full rules or a full default policy", () => {
    expect(browserAccess([], "full")).toBe("full");
    expect(browserAccess([], "ask")).toBe("project");
    expect(browserAccess([{ permission: "*", pattern: "*", action: "allow" }], "read")).toBe("full");
    expect(browserAccess([{ permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "ask" }], "full")).toBe("project");
    expect(browserAccess([{ permission: "*", pattern: "*", action: "ask" }, { permission: "read", pattern: "*", action: "allow" }], "full")).toBe("project");
  });
});
