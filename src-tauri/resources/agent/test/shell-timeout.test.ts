import { describe, expect, it } from "vitest";
import { withShellTimeout } from "../src/sdk/shell-timeout.ts";

describe("host shell timeout policy", () => {
  it("defaults a missing timeout without mutating the command or caller", () => {
    const input = Object.freeze({ command: "curl --max-time 30 example.invalid | grep pattern" });
    expect(withShellTimeout(input)).toEqual({ ...input, timeout: 1800 });
    expect(input).not.toHaveProperty("timeout");
  });
  it.each([0.05, 60, 7200])("preserves an explicit %s-second limit", timeout => {
    expect(withShellTimeout({ command: "build", timeout }).timeout).toBe(timeout);
  });
  it.each([0, -1, NaN, Infinity])("leaves invalid %s to SDK validation", timeout => {
    expect(withShellTimeout({ command: "build", timeout }).timeout).toBe(timeout);
  });
});
