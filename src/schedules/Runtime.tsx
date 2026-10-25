import { useEffect } from "react";
import { store } from "../state/store";
import { taskScheduler } from "./tasks";

/**
 * Binds the timer list to the connected runtime. The runtime's own scheduler
 * executes timers (also while the window is closed to the tray); this window
 * never dispatches a task, so a missed interval can never be replayed here.
 * Updates arrive as `schedule.updated/removed` events; a periodic re-read only
 * repairs the list after a stream gap.
 */
export function ScheduleRuntime() {
  useEffect(() => {
    const scheduler = taskScheduler();
    const workspace = () => store.state.prefs.workspaceKey ?? store.state.prefs.endpoint;
    let bound: unknown = undefined, boundWorkspace = "";
    const bind = () => {
      const backend = store.state.connection.phase === "connected" ? store.maybeBackend() : null;
      if (backend === bound && workspace() === boundWorkspace) return;
      bound = backend; boundWorkspace = workspace();
      scheduler.attach(backend, boundWorkspace);
    };
    bind();
    const unsubscribe = store.subscribe(bind);
    const refresh = () => void scheduler.refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  return null;
}
