import type { ScheduledTask } from "../schedules/tasks";
import { Icon } from "./Icon";

/** Clock badge for a chat or project that still has an enabled wake-up. */
export function TimerBadge({ tasks, label, size = 14, className = "session-timer" }: {
  tasks: readonly ScheduledTask[];
  label: string;
  size?: number;
  className?: string;
}) {
  if (!tasks.length) return null;
  const title = tasks
    .map(task => `${task.title}: ${new Date(task.nextAt).toLocaleString("ru")}`)
    .join("\n");
  return <span className={className} role="status" aria-label={label} title={title}><Icon name="clock" size={size}/></span>;
}
