import { expect, it } from "vitest";
import { hubPlatform } from "../src/remote/hub.ts";

it("uses the Hub device platform names shared with native clients", () => {
  expect(hubPlatform("darwin")).toBe("macos");
  expect(hubPlatform("win32")).toBe("windows");
  expect(hubPlatform("linux")).toBe("linux");
});
