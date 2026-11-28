import { store } from "../state/store";

export const presentations = new Map<string, "panel" | "monitor" | "hidden">();
export const presentationKey = () => JSON.stringify([
  store.state.prefs.workspaceKey ?? store.state.prefs.endpoint,
  store.state.directory,
  store.engineIdFor(),
  store.state.activeSessionId,
]);
