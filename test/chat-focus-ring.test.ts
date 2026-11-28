// A full-height focus ring around the transcript looked like a permanent yellow
// highlight. The keyboard cue must stay, but not as a box around the whole chat.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const rule = css.match(/\.chat-scroll:focus-visible[^{]*\{([^}]*)\}/)?.[1] ?? "";

it("does not draw an outline around the whole transcript", () => {
  expect(rule).toMatch(/outline:\s*none/);
  expect(rule).not.toMatch(/outline:\s*\d/);
});

it("paints nothing at all around the transcript", () => {
  // The owner explicitly asked for no frame: no ring, no edge accent.
  expect(css).not.toMatch(/\.chat-scroll:focus-visible[^{]*\{[^}]*box-shadow:\s*inset/);
  expect(rule).toMatch(/box-shadow:\s*none/);
});
