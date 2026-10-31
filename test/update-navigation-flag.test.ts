// @vitest-environment jsdom
// Mechanism guard: the navigation intent is render-safe (peek never consumes;
// only an explicit consume clears it). Against the pre-fix code the same shape
// failed: the discarded first attempt consumed the flag inside the useState
// initializer, the retry saw false, and settings opened on «Общее».
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Suspense, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { consumeUpdateSettings, peekUpdateSettings, requestUpdateSettings } from "../src/updates/controller";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); consumeUpdateSettings(); });
afterEach(() => { root?.unsafe; act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("peek is repeatable and only consume clears the intent", () => {
  expect(peekUpdateSettings()).toBe(false);
  requestUpdateSettings();
  expect(peekUpdateSettings()).toBe(true);
  expect(peekUpdateSettings()).toBe(true); // render attempts may re-read freely
  expect(consumeUpdateSettings()).toBe(true);
  expect(peekUpdateSettings()).toBe(false);
});

it("a discarded mount attempt does not consume the navigation intent", async () => {
  let started = false;
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  function Gate() { if (!started) { started = true; throw promise; } return null; }
  let probe = () => "unset";
  function Probe() {
    const [section] = useState<"updates" | "general">(() => (peekUpdateSettings() ? "updates" : "general"));
    probe = () => section;
    return createElement("p", { id: "section" }, section);
  }
  requestUpdateSettings();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Suspense, { fallback: null },
    createElement("div", null, createElement(Probe), createElement(Gate)))));
  // With a null fallback React 19 keeps the suspended attempt detached; the
  // important property is that the attempt never reaches a committed effect,
  // so peek-based initializers are recomputed with the intent still intact.
  expect(started).toBe(true); // Gate did suspend the first attempt
  await act(async () => { resolve(); await new Promise(r => setTimeout(r, 0)); });
  expect(probe()).toBe("updates");
  expect(document.getElementById("section")!.textContent).toBe("updates");
  // Consumption belongs to the real screen's committed effect (not present in
  // this probe); the retry did not clear the intent either.
  expect(peekUpdateSettings()).toBe(true);
  consumeUpdateSettings();
});
