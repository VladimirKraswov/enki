// A runtime dies while a tool with side effects is executing. The next runtime
// must show the outcome as uncertain, keep every tool call paired with an
// explicit "unknown result", and never execute the tool or the turn again.
//
// The first runtime is a REAL process (fixtures/crash-child.ts) that is
// SIGKILLed: its SQLite writer lease is released only by genuine process death.
// While it lives, a second writer is refused. Lifetime is bounded and every
// child is killed and joined in teardown, even after a failed assertion.
import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { fauxAssistantMessage, scriptedRuntime } from "../../src/sdk/testing.ts";
import { INTERRUPTED_TOOL_TEXT } from "../../src/execution/tools.ts";
import { projectToolEnvironment, sdkProfileDirectory } from "../../src/platform/environment.ts";
import { extension, harness, promptCommand, tempDir, type Harness } from "../helpers.ts";

const CHILD = fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url));
const GUARD = pathToFileURL(fileURLToPath(new URL("../node-guard.mjs", import.meta.url))).href;
const PREFIX = "ENKI_CRASH_FIXTURE ";
const READY_MS = 20_000, EXIT_MS = 10_000;

let h: Harness | undefined;
const children = new Set<ChildProcess>();
afterEach(async () => {
  const current = h; h = undefined;
  try {
    for (const child of [...children]) await crash(child);
  } finally {
    await current?.stop();
  }
});

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** SIGKILL (no graceful settle, receipt update or shutdown) and join, bounded. */
async function crash(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGKILL");
    return await bounded(exited, EXIT_MS, `crash fixture ${child.pid} did not exit after SIGKILL`);
  } finally {
    children.delete(child);
  }
}

/** Starts the owned fixture child and resolves with its ready report. */
async function crashChild(scenario: "tool" | "accepted", data: string): Promise<{ child: ChildProcess; ready: Record<string, unknown> }> {
  const profile = sdkProfileDirectory();
  if (!profile) throw new Error("SDK environment is not installed in this worker");
  // Host values for PI_*/ADC are restored; the child installs the same profile itself.
  const env = { ...projectToolEnvironment(process.env), ENKI_CRASH_FIXTURE_SCENARIO: scenario, ENKI_CRASH_FIXTURE_DATA: data, ENKI_CRASH_FIXTURE_PROFILE: profile };
  const child = spawn(process.execPath, ["--experimental-transform-types", "--import", GUARD, CHILD], {
    cwd: path.resolve(path.dirname(CHILD), "../../.."), env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  children.add(child);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let index: number; (index = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          const message = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
          if (message.type === "ready") resolve(message);
        } catch (error) { reject(error); }
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`crash fixture exited before ready (${code ?? signal}): ${stderr}`)));
  });
  try {
    return { child, ready: await bounded(ready, READY_MS, "crash fixture did not become ready") };
  } catch (error) {
    await crash(child);
    throw new Error(`${(error as Error).message}\n${stderr}`, { cause: error });
  }
}

it("crash during a tool side effect is reconciled as uncertain and never replayed", async () => {
  const data = tempDir("crash");
  const { child, ready } = await crashChild("tool", data);
  const sid = String(ready.sid), dir = String(ready.dir);
  expect(ready.pid).toBe(child.pid);
  expect(ready.status).toBe(202);
  expect(ready.interrupted).toEqual([expect.objectContaining({ toolCallId: "call_deploy", tool: "deploy", commandId: "cmd-crash" })]);
  expect(ready.executions).toBe(1);

  // A recovering runtime registers the same tool, so a replay WOULD be counted here.
  let executions = 0;
  const deploy = extension("blocking", (pi) => pi.registerTool({
    name: "deploy", label: "Deploy", description: "External side effect", parameters: Type.Object({}),
    execute: async () => { executions++; return { content: [{ type: "text", text: "deployed again" }], details: {} }; },
  }));
  const scripted = await scriptedRuntime(path.join(data, "scripted-recovery"));
  // The first runtime is alive: its writer lease refuses a second writer.
  await expect(harness({ data, scripted, extraExtensions: () => [deploy] })).rejects.toThrow(/already owns/);

  const death = await crash(child);
  expect(death.signal).toBe("SIGKILL");

  h = await harness({ data, scripted, extraExtensions: () => [deploy] });
  const receipt = h.runtime.ledger.get("cmd-crash");
  expect(receipt?.state).toBe("uncertain");
  expect(receipt?.error).toMatch(/не подтверждён|повторной отправки не было/);
  const history = await h.request<{ messages: Array<{ info: { role: string }; parts: Array<{ type: string; callID?: string; state?: { status: string; output?: string } }> }> }>("GET", `/sessions/${sid}/messages`);
  const tools = history.body.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.callID === "call_deploy");
  expect(tools).toHaveLength(1);
  expect(tools[0].state?.status).toBe("error");
  expect(tools[0].state?.output).toBe(INTERRUPTED_TOOL_TEXT);
  expect(h.runtime.tools.interrupted(sid)).toEqual([]);
  expect(executions).toBe(0);
  expect(scripted.calls()).toBe(0);

  // The next turn sees the call paired with its explicit unknown result.
  let paired = false;
  scripted.setResponses([async (context) => {
    const messages = context.messages as Array<{ role: string; toolCallId?: string; isError?: boolean }>;
    paired = messages.filter((m) => m.role === "toolResult" && m.toolCallId === "call_deploy").length === 1
      && messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_deploy" && m.isError === true);
    return fauxAssistantMessage("I will verify the deployment state first.");
  }]);
  await h.command(promptCommand(h, "cmd-after", sid, dir, "what happened?"));
  await h.waitReceipt("cmd-after", ["completed"]);
  expect(paired).toBe(true);
  expect(executions).toBe(0);
  const turnCalls = scripted.calls();
  // Restarting again is idempotent: no duplicate recovery results, no replay.
  await h.stop();
  h = await harness({ data, scripted, extraExtensions: () => [deploy] });
  expect(h.runtime.ledger.get("cmd-crash")?.state).toBe("uncertain");
  const again = await h.request<{ messages: Array<{ parts: Array<{ type: string; callID?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  expect(again.body.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.callID === "call_deploy")).toHaveLength(1);
  expect(executions).toBe(0);
  expect(scripted.calls()).toBe(turnCalls);
});

it("a command accepted but not yet dispatched before a crash is cancelled, not replayed", async () => {
  const data = tempDir("crash-accepted");
  const { child, ready } = await crashChild("accepted", data);
  expect(ready.receipt).toBe("accepted");
  expect(ready.calls).toBe(0);
  const scripted = await scriptedRuntime(path.join(data, "scripted-recovery"));
  await expect(harness({ data, scripted })).rejects.toThrow(/already owns/);
  expect((await crash(child)).signal).toBe("SIGKILL");
  h = await harness({ data, scripted });
  expect(h.runtime.ledger.get("cmd-never")?.state).toBe("cancelled");
  expect(scripted.calls()).toBe(0);
});
