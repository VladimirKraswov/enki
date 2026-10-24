import type { ScheduledTask } from "./tasks";

/**
 * Enabled wake-ups of one chat. The session id is the identity: the stored
 * `server`/`directory` can legitimately drift after a workspace migration, and
 * a timer that still fires must still be visible in the sidebar.
 */
export function activeTimers(tasks: readonly ScheduledTask[], sessionID: string): ScheduledTask[] {
  return tasks.filter(task => task.enabled && task.sessionID === sessionID);
}

/** Enabled wake-ups of a project, for the collapsed-project hint. */
export function directoryTimers(tasks: readonly ScheduledTask[], directory: string): ScheduledTask[] {
  return tasks.filter(task => task.enabled && task.directory === directory);
}
