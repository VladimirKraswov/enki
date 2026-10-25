// @vitest-environment jsdom
// Final seam review (TODO-remainder-ui-review P2): the Changes panel subscribes
// to the O(1) patchRevision instead of rescanning parts per delta. An
// authoritative history replacement that REMOVES the last patch part must still
// invalidate it, so the panel re-reads the server diff and drops the stale
// patch-only fallback (and its expanded preview). Observed through the rendered
// panel over the real reducer state, not only the counter. Written, NOT RUN.
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyHistory, emptyChatRoot, reduceEvent, type ChatRootState } from "../src/state/chatReducer";

const fake = vi.hoisted(() => ({
  vcsDiff: vi.fn(async () => [] as unknown[]),
  sessionDiff: vi.fn(async () => [] as unknown[]),
  fileContent: vi.fn(async () => ({ content: "CURRENT FILE CONTENT" })),
  state: { connection: { phase: "connected", endpoint: "http://127.0.0.1:4096" }, directory: "/workspace", activeSessionId: "chat" as string | null,
    chat: { sessions: {}, sessionPatched: {} } as unknown, prefs: { layout: { rightTab: "changes", rightWidth: 400 } } },
}));
vi.mock("../src/state/store", () => ({
  useAppState: () => fake.state,
  useAppSelector: (select: (state: unknown) => unknown) => select(fake.state),
  errText: (e: unknown) => String(e),
  store: { get state() { return fake.state; }, engineIdFor: () => "pi",
    client: { vcsDiff: fake.vcsDiff, sessionDiff: fake.sessionDiff, fileContent: fake.fileContent }, setLayout: vi.fn(), setUi: vi.fn() },
}));
import { RightPanel } from "../src/components/RightPanel";

let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const SID = "chat", MID = "m1";
const message = { id: MID, sessionID: SID, role: "assistant", time: { created: 1 } };

it("an authoritative history without patches refreshes the visible diff and drops the stale fallback", async () => {
  const chat: ChatRootState = emptyChatRoot();
  fake.state.chat = chat;
  // A live edit: the server diff is empty, so the panel shows the patch-part fallback.
  reduceEvent(chat, { type: "message.updated", id: "u1", properties: { info: message } } as never);
  reduceEvent(chat, { type: "message.part.updated", id: "p1", properties: { part: { id: "patch-1", sessionID: SID, messageID: MID, type: "patch", files: ["/workspace/edited-by-tool.ts"] } } } as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(RightPanel)));
  expect(fake.sessionDiff).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("edited-by-tool.ts");
  // Expand it: the current content is fetched and shown.
  const head = [...document.querySelectorAll("button.diff-head")].find((b) => b.textContent?.includes("edited-by-tool.ts")) as HTMLButtonElement;
  await act(async () => head.click());
  expect(document.body.textContent).toContain("CURRENT FILE CONTENT");
  const before = chat.sessions[SID].patchRevision ?? 0;

  // Resync/compaction snapshot: the same message, but no patch parts anymore.
  applyHistory(chat, SID, [{ info: message as never, parts: [{ id: "t1", sessionID: SID, messageID: MID, type: "text", text: "summary" } as never] }]);
  expect(chat.sessions[SID].patchRevision ?? 0).toBeGreaterThan(before);
  await act(async () => root.render(createElement(RightPanel)));

  // The panel re-read the authoritative diff and shows its (empty) truth.
  expect(fake.sessionDiff).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain("edited-by-tool.ts");
  expect(document.body.textContent).not.toContain("CURRENT FILE CONTENT");
  expect(document.body.textContent).toContain("В этой задаче пока нет изменений файлов.");
});

it("a history reload that keeps the same patch-free state does not re-fetch (O(1) subscription stays quiet)", async () => {
  const chat: ChatRootState = emptyChatRoot();
  fake.state.chat = chat;
  applyHistory(chat, SID, [{ info: message as never, parts: [{ id: "t1", sessionID: SID, messageID: MID, type: "text", text: "a" } as never] }]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(RightPanel)));
  expect(fake.sessionDiff).toHaveBeenCalledTimes(1);
  // Streamed text deltas and a patch-free reload never touch the revision.
  reduceEvent(chat, { type: "message.part.delta", id: "d1", properties: { sessionID: SID, messageID: MID, partID: "t1", field: "text", delta: "b" } } as never);
  applyHistory(chat, SID, [{ info: message as never, parts: [{ id: "t1", sessionID: SID, messageID: MID, type: "text", text: "ab" } as never] }]);
  await act(async () => root.render(createElement(RightPanel)));
  expect(fake.sessionDiff).toHaveBeenCalledTimes(1);
});
