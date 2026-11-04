import { afterEach, expect, it, vi } from "vitest";
import { PluginUiSession } from "../src/agent/runtime/pluginUi/session";
import type { RuntimeClient } from "../src/agent/runtime/client";

afterEach(() => vi.unstubAllGlobals());

it("a lost draft lease aborts a silent stream and watches the same scope; repeated rejection waits for the user", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = { uiStreamUrl: vi.fn((id, dir, mode) => `http://127.0.0.1:1/${id}/${mode}?directory=${dir}`), authorization: () => ({}) } as unknown as RuntimeClient;
  const session = new PluginUiSession(client, "chat-a", "/project-a");
  try {
    session.start();
    session.authorityLost(true);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(client.uiStreamUrl).toHaveBeenNthCalledWith(2, "chat-a", "/project-a", "events");
    session.authorityLost(false);
    await Promise.resolve();
    expect(signals[1].aborted).toBe(true);
    expect(session.getView()).toMatchObject({ phase: "error", detail: expect.stringContaining("Черновик сохранён") });
    expect(fetcher).toHaveBeenCalledTimes(2);
    session.retry();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { session.dispose(); }
});
