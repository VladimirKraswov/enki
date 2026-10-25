import { expect, it } from "vitest";
import {
  DEFAULT_ENGINE,
  engineForDirectory,
  engineForSession,
  engineOptions,
  legacyModelScope,
  modelScope,
  piAvailability,
} from "../src/state/engines";
import { RUNTIME_AGENT_ID } from "../src/agent/runtime/ids";

it("runs every folder and chat on the single bundled runtime agent", () => {
  expect(DEFAULT_ENGINE).toBe(RUNTIME_AGENT_ID);
  expect(engineForDirectory({}, "/legacy/project")).toBe(RUNTIME_AGENT_ID);
  expect(engineForDirectory({}, null)).toBe(RUNTIME_AGENT_ID);
  expect(engineForSession({}, "ses_old", "/legacy/project")).toBe(RUNTIME_AGENT_ID);
});

it("ignores former per-folder/per-chat engine preferences for execution", () => {
  // Old preferences may still name OpenCode or the Pi CLI; nothing is routed to
  // an external engine. OpenCode history continues only via explicit continuation.
  // A stored preference object from an older version (extra legacy fields are not part of Prefs).
  const prefs = { activeHost: "local", projectEngine: { "/work": "opencode" }, sessionEngine: { ses_a: "opencode" }, newChatEngine: "opencode" };
  expect(engineForDirectory(prefs, "/work")).toBe(RUNTIME_AGENT_ID);
  expect(engineForSession(prefs, "ses_a", "/work")).toBe(RUNTIME_AGENT_ID);
  expect(engineForSession(prefs, null, null)).toBe(RUNTIME_AGENT_ID);
});

it("keeps plain model keys and reads former Pi CLI choices only as a fallback", () => {
  expect(modelScope(RUNTIME_AGENT_ID, "session:x")).toBe("session:x");
  expect(legacyModelScope("session:x")).toBe(`${RUNTIME_AGENT_ID}::session:x`);
});

it("offers exactly one available agent, local or on an SSH host", () => {
  expect(piAvailability({ activeHost: "local" }).available).toBe(true);
  expect(piAvailability({ activeHost: "vm-1" }).available).toBe(true);
  expect(engineOptions({ activeHost: "local" }, false)).toEqual([{ id: RUNTIME_AGENT_ID, label: "Enki", available: true }]);
});
