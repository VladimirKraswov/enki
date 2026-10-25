// Schedules live in the runtime, so denied browser storage can no longer
// disable them. It must still neither crash the mirror nor invent a timer.
import { expect, it, vi } from "vitest";
it("keeps the mirror usable when access to localStorage itself is denied, and invents nothing while disconnected", async () => {
  vi.resetModules();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage denied"); } });
  try {
    const { taskScheduler, STORAGE_FAILED } = await import("../src/schedules/tasks");
    const scheduler = taskScheduler();
    scheduler.attach(null, "local");
    expect(scheduler.status().storage).toBe("unavailable");
    expect(scheduler.snapshot()).toEqual([]);
    await expect(scheduler.add({ server: "local", directory: "/p", sessionID: "s", engine: "pi", title: "CI", prompt: "check", minutes: 15, model: { providerID: "p", modelID: "m" } }))
      .rejects.toThrow(STORAGE_FAILED);
    // Old timers that cannot even be read are left alone: nothing is sent to the runtime, nothing invented.
    const denied = { getItem: () => { throw new Error("storage denied"); }, setItem: () => { throw new Error("storage denied"); } };
    const cutover = vi.fn();
    await expect(scheduler.migrateLegacy(denied, { client: { cutover } } as never, { installation: "inst-0001", workspace: "enki-runtime:local", servers: ["local"] }))
      .resolves.toEqual({ accepted: 0, quarantined: [], pending: 0, invalid: 0 });
    expect(cutover).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toEqual([]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
