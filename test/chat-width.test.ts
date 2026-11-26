// A wide window must be used, and a wide table must stay readable instead of
// breaking every word into single letters inside a fixed narrow column.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const appearance = readFileSync(new URL("../src/state/appearance.ts", import.meta.url), "utf8");

it("message width presets scale with the window", () => {
  expect(appearance).toMatch(/--chat-width/);
  expect(appearance).toContain("58vw");
  expect(appearance).toContain("78vw");
  expect(appearance).not.toMatch(/"--chat-width", a\.chatWidth === "full" \? "100%" : a\.chatWidth === "wide" \? "1060px" : "830px"/);
});

it("tables keep natural width and scroll instead of squeezing", () => {
  expect(css).toMatch(/\.md \.md-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  expect(css).toMatch(/\.md table\s*\{[^}]*width:\s*max-content/);
  expect(css).toMatch(/\.md table\s*\{[^}]*min-width:\s*100%/);
});
