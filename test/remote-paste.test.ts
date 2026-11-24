// Receiving side: staged pastes must be filtered strictly and in order, because
// the shell appends exactly these texts to the composer draft.
import { expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ paths: [] as string[], reply: {} as any }));
vi.mock("../src/hub/client", () => ({
  request: async (path: string) => { sent.paths.push(path); return sent.reply; },
}));
import { stagedPastes } from "../src/hub/remote";

it("returns only acknowledged pastes with real text, in command order", async () => {
  sent.paths.length = 0;
  sent.reply = { commands: [
    { id: "b", kind: "paste", state: "done", result: { text: "второй" } },
    { id: "a", kind: "paste", state: "done", result: { text: "первый" } },
    { id: "c", kind: "paste", state: "queued", result: null },
    { id: "d", kind: "prompt", state: "done", result: { text: "не пересылка" } },
    { id: "e", kind: "paste", state: "done", result: { text: "   " } },
    { id: "f", kind: "paste", state: "done", result: {} },
  ] };
  await expect(stagedPastes("dev-1", "ses-1")).resolves.toEqual([
    { id: "a", text: "первый" }, { id: "b", text: "второй" },
  ]);
  expect(sent.paths[0]).toBe("remote/session?device=dev-1&session=ses-1");
});

it("survives an empty or malformed command list", async () => {
  sent.reply = {};
  await expect(stagedPastes("d", "s")).resolves.toEqual([]);
  sent.reply = { commands: [{ id: "x", kind: "paste", state: "done", result: null }] };
  await expect(stagedPastes("d", "s")).resolves.toEqual([]);
});
