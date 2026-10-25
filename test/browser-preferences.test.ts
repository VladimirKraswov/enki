import { expect, it } from "vitest";
import { browserEnabled, browserNodeProgram } from "../src/browser/preferences";

// The former Pi CLI bridge's Node.js setting launches nothing any more; when
// the browser has no own path, native discovery chooses (it prefers the Node.js
// bundled with the Enki Runtime).
it("uses one Node.js rule everywhere: the browser's own path, else native discovery", () => {
  const legacy = (value: object) => value as Parameters<typeof browserNodeProgram>[0];
  expect(browserNodeProgram({})).toBeNull();
  expect(browserNodeProgram(legacy({ pi: { nodeProgram: "/opt/homebrew/bin/node" } }))).toBeNull();
  expect(browserNodeProgram(legacy({ browser: { nodeProgram: " /Users/example/Node Runtime/node " }, pi: { nodeProgram: "/opt/homebrew/bin/node" } })))
    .toBe("/Users/example/Node Runtime/node");
  // A blank value is "not set", never an empty program path.
  expect(browserNodeProgram({ browser: { nodeProgram: "   " } })).toBeNull();
  expect(browserNodeProgram({ browser: { nodeProgram: "" } })).toBeNull();
});

it("treats an absent preference as enabled and only an explicit false as disabled", () => {
  expect(browserEnabled({})).toBe(true);
  expect(browserEnabled({ browser: {} })).toBe(true);
  expect(browserEnabled({ browser: { enabled: true } })).toBe(true);
  expect(browserEnabled({ browser: { enabled: false } })).toBe(false);
});
