import { afterEach, expect, test, vi } from "vitest";
import type { Broker, BrokerMethod } from "../src/control/broker.ts";
import { VaultCredentialStore } from "../src/models/credentials.ts";

afterEach(() => vi.useRealTimers());

function native(capacity = 2) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  let active = 0, maximum = 0;
  const broker: Broker = {
    kind: "supervisor", available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      expect(method).toBe("vault.credentialRead");
      const id = String(params.providerId);
      seen.push(id);
      active++; maximum = Math.max(maximum, active);
      try {
        if (active > capacity) throw Error("native broker capacity exceeded");
        await Promise.resolve(); // an IPC reply cannot arrive in the dispatching stack
        if (id === "held") await held;
        if (id === "failure") throw Error("vault unavailable");
        return { value: id === "missing" ? null : JSON.stringify({ type: "api_key", key: `fixture-${id}` }), revision: 1 } as T;
      } finally { active--; }
    },
  };
  return { broker, seen, release: () => release(), maximum: () => maximum };
}

test("a provider auth burst across stores fits a bounded native broker and retains every credential", async () => {
  const f = native(), a = new VaultCredentialStore(f.broker), b = new VaultCredentialStore(f.broker);
  const ids = ["held", ...Array.from({ length: 100 }, (_, i) => `provider-${i}`)];
  const result = Promise.all(ids.map((id, i) => (i % 2 ? a : b).read(id)));
  await Promise.resolve();
  f.release();
  expect((await result).map(c => c?.type === "api_key" ? c.key : undefined)).toEqual(ids.map(id => `fixture-${id}`));
  expect(f.maximum()).toBeLessThanOrEqual(2);
  expect(f.seen).toEqual(ids);
});

test("cancelling a queued read prevents its dispatch without releasing the active native call", async () => {
  const f = native(), store = new VaultCredentialStore(f.broker), abort = new AbortController();
  const first = store.read("held");
  const cancelled = store.read("cancelled", { signal: abort.signal });
  const rejected = expect(cancelled).rejects.toThrow(/отменено/);
  const last = store.read("last");
  abort.abort(); await rejected;
  expect(f.seen).not.toContain("cancelled");
  f.release(); await first; await last;
  expect(f.seen).toEqual(["held", "last"]);
});

test("a failed vault read stays an error and does not poison later reads", async () => {
  const f = native(), store = new VaultCredentialStore(f.broker);
  await expect(store.read("failure")).rejects.toThrow("vault unavailable");
  expect(await store.read("missing")).toBeUndefined();
  expect(await store.read("next")).toEqual({ type: "api_key", key: "fixture-next" });
});

test("a waiting read has a deadline and is not dispatched after it expires", async () => {
  vi.useFakeTimers();
  const f = native(), store = new VaultCredentialStore(f.broker);
  const first = store.read("held");
  const queued = expect(store.read("expired")).rejects.toThrow(/Истекло время/);
  await vi.advanceTimersByTimeAsync(20_001); await queued;
  f.release(); await first; await Promise.resolve();
  expect(f.seen).toEqual(["held"]);
});

test("the client backlog is bounded and rejected callers never reach the native bridge", async () => {
  const f = native(), store = new VaultCredentialStore(f.broker);
  const requests = [store.read("held"), ...Array.from({ length: 1000 }, (_, i) => store.read(`flood-${i}`))];
  const all = Promise.allSettled(requests);
  f.release(); const result = await all;
  expect(result.some(r => r.status === "rejected" && /Очередь/.test(String(r.reason)))).toBe(true);
  expect(f.seen.length).toBeLessThan(requests.length);
  expect(f.seen.length).toBe(result.filter(r => r.status === "fulfilled").length);
  expect(f.maximum()).toBeLessThanOrEqual(2);
});

test("an independent broker is not held behind another client's vault", async () => {
  const a = native(), b = native();
  const held = new VaultCredentialStore(a.broker).read("held");
  expect(await new VaultCredentialStore(b.broker).read("other")).toEqual({ type: "api_key", key: "fixture-other" });
  a.release(); await held;
});
