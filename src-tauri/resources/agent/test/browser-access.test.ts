// The managed browser leaves project scope ONLY under the session's actual full
// access (bash + external_directory allowed); defaults follow the runtime
// policy; nothing comes from model arguments (browser/pi-extension.ts strips
// reserved __arvelaAccess/__arvelaSession and uses this value).
import { expect, it } from "vitest";
import { browserAccess } from "../src/extensions/enki.ts";

it("derives browser scope from the session rules and the default policy only", () => {
  expect(browserAccess([], "full")).toBe("full");
  expect(browserAccess([], "ask")).toBe("project");
  expect(browserAccess([], "read")).toBe("project");
  expect(browserAccess([{ permission: "*", pattern: "*", action: "allow" }], "read")).toBe("full");
  expect(browserAccess([{ permission: "*", pattern: "*", action: "ask" }], "full")).toBe("project");
  expect(browserAccess([{ permission: "bash", pattern: "*", action: "allow" }], "full")).toBe("project");
  expect(browserAccess([{ permission: "bash", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "allow" }], "ask")).toBe("full");
  expect(browserAccess([{ permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "deny" }], "full")).toBe("project");
});
