import type { BrowserPreferences } from "./integration";

/**
 * The one rule for the managed browser's interpreter, shared by background
 * setup, settings and the toolbar: the browser's own Node.js path, else null
 * so native discovery chooses (it prefers the Node.js bundled with the Enki
 * Runtime). Blank values never hide the fallback.
 */
export function browserNodeProgram(prefs: {
  browser?: Pick<BrowserPreferences, "nodeProgram">;
}): string | null {
  return prefs.browser?.nodeProgram?.trim() || null;
}

/** Absent means enabled: the browser is opt-out, as before. */
export function browserEnabled(prefs: { browser?: Pick<BrowserPreferences, "enabled"> }): boolean {
  return prefs.browser?.enabled !== false;
}
