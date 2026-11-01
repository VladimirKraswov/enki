// @vitest-environment jsdom
// A source update restarts the app to load the new bundle. That restart is the
// delivery step itself, yet to whoever watches a chat it is indistinguishable
// from a crash. The committed install receipt (with its fresh `ts`) must make
// the next start explain the restart exactly once; stale, future (clock-jumped)
// or pre-`ts` receipts must stay silent — an old update is never re-announced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { freshApplyNotice } from "../src/updates/controller";

const h = vi.hoisted(() => ({
  toasts: [] as Array<string | null>,
  installation: null as null | { version: string; installed: boolean; error: string | null; phase: string; ts?: number },
}));

vi.mock("../src/native/platform", () => ({
  isNative: () => true, platform: () => "macos", hasOverlayWindowControls: () => false,
}));
vi.mock("../src/state/store", () => ({
  store: {
    setUi: (patch: { toast?: string | null }) => { if (patch.toast !== undefined) { h.toasts.push(patch.toast); } },
    getSnapshot: () => ({
      prefs: {}, directory: "", activeSessionId: null, statuses: {}, activityStatuses: {},
      chat: { permissions: {}, questions: {} },
      ui: { sending: false, workspacePreparing: false, agentDialog: null, settingsOpen: false },
    }),
    maybeBackend: () => null,
  },
}));
vi.mock("../src/state/prefs", () => ({ savePrefs: () => {}, flushPrefs: () => true }));
vi.mock("../src/voice/capture", () => ({ flushDictationCapture: async () => {} }));
vi.mock("../src/operations/journal", () => ({ operationJournal: { drain: async () => {} } }));
vi.mock("../src/operations/backups", () => ({ makeBackup: async () => ({}) }));
vi.mock("../src/operations/maintenance", () => ({ maintenance: { run: async (fn: () => unknown) => fn(), handoff: () => {} } }));
vi.mock("../src/attachments/drafts", () => ({ attachmentDrafts: { flush: async () => {} } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_cmd: string, args: { action?: string }) => {
    if (args?.action === "status") return {
      nativeVersion: "2.0.29", nativeFingerprint: "f",
      hot: { uiVersion: "2.0.29", activeDigest: null, pending: false, lastError: null },
      build: {}, installation: h.installation, release: { available: false },
    };
    return { available: false };
  },
}));

describe("freshApplyNotice", () => {
  const now = 1_700_000_000_000;
  const committed = (over = {}) => ({ version: "2.0.29", installed: true, error: null, phase: "committed" as const, ...over });
  it("names the restart only for a receipt committed moments ago", () => {
    expect(freshApplyNotice(committed({ ts: now - 8000 }), now)).toMatch(/2\.0\.29.*перезапущен/);
  });
  it("stays silent for stale, future, missing-ts or uncommitted receipts", () => {
    expect(freshApplyNotice(committed({ ts: now - 5 * 60_000 }), now)).toBeNull();     // checked later: not this restart
    expect(freshApplyNotice(committed({ ts: now + 5 * 60_000 }), now)).toBeNull();     // clock jumped backwards
    expect(freshApplyNotice(committed(), now)).toBeNull();                             // pre-ts receipt
    expect(freshApplyNotice(committed({ ts: now, phase: "interrupted" }), now)).toBeNull();
    expect(freshApplyNotice(committed({ ts: now, installed: false }), now)).toBeNull();
    expect(freshApplyNotice(undefined, now)).toBeNull();
  });
});

describe("UpdateRuntime start notice", () => {
  let root: Root | undefined;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(() => { if (root) act(() => root.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

  async function boot(installation: typeof h.installation) {
    h.toasts.length = 0; h.installation = installation;
    vi.resetModules();
    const { UpdateRuntime } = await import("../src/updates/runtime");
    const div = document.createElement("div"); document.body.append(div);
    root = createRoot(div);
    await act(async () => { root!.render(createElement(UpdateRuntime)); await new Promise(r => setTimeout(r, 25)); });
    return h.toasts.filter(Boolean);
  }

  it("announces the applied update once at the first status after restart", async () => {
    const toasts = await boot({ version: "2.0.29", installed: true, error: null, phase: "committed", ts: Date.now() - 8000 });
    expect(toasts).toEqual(["Enki обновлён до версии 2.0.29 и перезапущен для применения. Чаты и данные сохранены."]);
  });
  it("does not speak for a receipt that is not this restart", async () => {
    expect(await boot({ version: "2.0.28", installed: true, error: null, phase: "committed", ts: Date.now() - 3_600_000 })).toEqual([]);
    expect(await boot({ version: "2.0.28", installed: true, error: null, phase: "committed" })).toEqual([]);
    expect(await boot({ version: "2.0.28", installed: true, error: null, phase: "interrupted", ts: Date.now() })).toEqual([]);
  });
});
