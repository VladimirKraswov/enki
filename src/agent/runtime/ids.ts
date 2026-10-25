// Identity tags of the single agent runtime.
//
// `RUNTIME_AGENT_ID` is the value persisted in app-owned scopes that predate the
// migration (browser task profiles, original-image contexts, delivery journal,
// Hub records, model-service routing). The runtime executes the Pi SDK, so the
// historical "pi" tag stays valid and those records keep resolving unchanged.
export const RUNTIME_AGENT_ID = "pi";

/** Workspace key of the runtime on this computer (remote hosts use `ssh:` keys). */
export const LOCAL_WORKSPACE = "enki-runtime:local";
