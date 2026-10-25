// The frontend invoke payloads and the Rust command signatures must stay in sync:
// Tauri v2 resolves command arguments by camelCase names, so `admin_key` in the
// webview silently becomes None and publishing with an admin key stops working.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const client = readFileSync(fileURLToPath(new URL("../src/hub/modelCatalog.ts", import.meta.url)), "utf8");
const rust = readFileSync(fileURLToPath(new URL("../src-tauri/src/hub.rs", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("../src-tauri/src/lib.rs", import.meta.url)), "utf8");
const settings = readFileSync(fileURLToPath(new URL("../src/components/ModelCatalogSettings.tsx", import.meta.url)), "utf8");

it("sends the admin key under the camelCase name the Rust command expects", () => {
  expect(rust).toMatch(/pub async fn hub_model_catalog[\s\S]{0,400}admin_key: Option<String>/);
  expect(client).toContain("adminKey:");
  expect(client).not.toContain("admin_key:");
});

it("registers the catalog command and refreshes the runtime instead of restarting an external engine", () => {
  expect(server).toContain("hub::hub_model_catalog");
  // No external OpenCode process is restarted from the UI any more.
  expect(settings).not.toContain("restart_local_opencode");
  expect(settings).not.toContain("restartLocalServerIfNative");
  expect(settings).toContain("store.refreshModelCatalog()");
});

it("gates catalog application behind the device preference", () => {
  expect(client).toMatch(/if \(!prefs\.enabled\) throw new Error/);
});
