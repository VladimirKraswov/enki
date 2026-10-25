// Native shared-capability registry (skills, MCP servers) access for the UI.
// The Enki Runtime reads the same registry for every session through its
// native broker (`capabilities.prepare`); the UI never configures an agent
// directly, so there is no per-engine synchronization step here.
import {decodeHubError} from '../hub/errors';
import { isNative } from "../native/platform";
export async function capabilityNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isNative())
    throw new Error("Каталог доступен в установленном приложении.");
  try { return await (await import("@tauri-apps/api/core")).invoke<T>(command, args); }
  catch (error) { throw command.startsWith("hub_") ? decodeHubError(error) : error; }
}
const listeners = new Set<() => void>();
/** Registry changed: the runtime re-reads it for sessions opened from now on. */
export function invalidateCapabilities() {
  for (const listener of listeners) listener();
}
export function onCapabilitiesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
