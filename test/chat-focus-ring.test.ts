// A full-height focus ring around the transcript looked like a permanent yellow
// highlight. The keyboard cue must stay, but not as a box around the whole chat.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const rule = css.match(/\.chat-scroll:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";

it("does not draw an outline around the whole transcript", () => {
  expect(rule).toMatch(/outline:\s*none/);
  expect(rule).not.toMatch(/outline:\s*\d/);
});

it("still gives a visible keyboard cue", () => {
  expect(rule).toMatch(/box-shadow/);
  expect(rule).toMatch(/inset/);
});
