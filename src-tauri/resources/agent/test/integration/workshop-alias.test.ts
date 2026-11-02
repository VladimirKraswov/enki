import { expect, it } from "vitest";
import path from "node:path";
import { verifiedLegacyWorkshopAlias } from "../../src/sessions/rehome.ts";

it("accepts only the app-owned workshop after both roots and the target are verified", () => {
  const base = path.resolve("test-owned-parent"), root = path.join(base, "enki");
  const old = path.join(base, "opencode-desktop"), data = path.join(root, "runtime");
  const physical = path.join(base, "physical", "enki"), target = path.join(physical, "workshop");
  const resolve = (p: string) => p === root || p === old ? physical : p === path.join(root, "workshop") ? target : null;
  const alias = path.join(old, "workshop");
  expect(verifiedLegacyWorkshopAlias(alias, data, "win32", resolve)).toBe(target);
  expect(verifiedLegacyWorkshopAlias(path.join(old, "other"), data, "win32", resolve)).toBeNull();
  expect(verifiedLegacyWorkshopAlias(alias, data, "linux", resolve)).toBeNull();
  expect(verifiedLegacyWorkshopAlias(alias, data, "win32", p => p === old ? path.join(base, "other") : resolve(p))).toBeNull();
  expect(verifiedLegacyWorkshopAlias(alias, data, "win32", p => p === path.join(root, "workshop") ? null : resolve(p))).toBeNull();
  expect(verifiedLegacyWorkshopAlias(alias, data, "win32", p => p === path.join(root, "workshop") ? path.join(base, "outside", "workshop") : resolve(p))).toBeNull();
});
