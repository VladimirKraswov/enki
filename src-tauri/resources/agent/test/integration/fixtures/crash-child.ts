// Crash fixture child for crash-recovery.test.ts ONLY. A real Runtime (real
// SDK, SQLite, writer lease, loopback HTTP) runs in this process until the test
// SIGKILLs it, so the writer lease is released by genuine process death, never
// by closing a handle or unlinking a lock. Started with the network guard
// preloaded; works only inside an owned temporary data directory; no owner data.
// Bounded: exits on its own deadline or as soon as the parent's stdin pipe closes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSdkEnvironment } from "../../../src/platform/environment.ts";

const PREFIX = "ENKI_CRASH_FIXTURE ";
const scenario = process.env.ENKI_CRASH_FIXTURE_SCENARIO;
const data = process.env.ENKI_CRASH_FIXTURE_DATA;
const profile = process.env.ENKI_CRASH_FIXTURE_PROFILE;
const refuse = (why: string): never => {
  process.stderr.write(`crash-child: refused (${why}); this fixture runs only under crash-recovery.test.ts\n`);
  process.exit(2);
};
if (scenario !== "tool" && scenario !== "accepted") refuse("unknown scenario");
if (!data || !path.isAbsolute(data) || !profile || !path.isAbsolute(profile)) refuse("missing fixture paths");
const tmp = fs.realpathSync(os.tmpdir());
if (!fs.realpathSync(data!).startsWith(tmp + path.sep)) refuse("data directory is not an owned temporary directory");

const deadline = setTimeout(() => { process.stderr.write("crash-child: fixture deadline exceeded\n"); process.exit(70); }, 60_000);
process.stdin.on("close", () => { clearTimeout(deadline); process.exit(71); });
process.stdin.resume();

// Same call main.ts makes, before any SDK value module is imported.
installSdkEnvironment(profile!);
const { Type } = await import("typebox");
const { fauxAssistantMessage, fauxToolCall } = await import("../../../src/sdk/testing.ts");
const { extension, harness, newSession, promptCommand } = await import("../../helpers.ts");
const report = (value: Record<string, unknown>) => process.stdout.write(PREFIX + JSON.stringify(value) + "\n");

if (scenario === "tool") {
  let executions = 0;
  const blocking = extension("blocking", (pi) => pi.registerTool({
    name: "deploy", label: "Deploy", description: "External side effect", parameters: Type.Object({}),
    execute: () => { executions++; return new Promise<never>(() => { /* the process dies before this settles */ }); },
  }));
  const h = await harness({ data: data!, extraExtensions: () => [blocking] });
  const dir = h.project("crash");
  const sid = await newSession(h, dir, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("deploy", {}, { id: "call_deploy" })], { stopReason: "toolUse" })]);
  const accepted = await h.command(promptCommand(h, "cmd-crash", sid, dir, "deploy now"));
  for (let i = 0; i < 400 && h.runtime.tools.interrupted(sid).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  report({ type: "ready", pid: process.pid, sid, dir, status: accepted.status, executions,
    interrupted: h.runtime.tools.interrupted(sid), receipt: h.runtime.ledger.get("cmd-crash")?.state ?? null, calls: h.scripted.calls() });
} else {
  const h = await harness({ data: data! });
  const dir = h.project("accepted");
  const sid = await newSession(h, dir);
  h.runtime.ledger.begin(promptCommand(h, "cmd-never", sid, dir, "never ran"));
  report({ type: "ready", pid: process.pid, sid, dir, receipt: h.runtime.ledger.get("cmd-never")?.state ?? null, calls: h.scripted.calls() });
}
// Stay alive, holding the writer lease and the in-flight work, until killed.
