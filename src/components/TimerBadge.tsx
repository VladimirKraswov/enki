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
    .map(task => {
      const cadence = task.mode === "repeat" ? `каждые ${task.minutes} мин` : "один раз";
      const next = new Date(task.nextAt).toLocaleString("ru");
      return `${task.title}: ${cadence}; следующий запуск ${next}`;
    })
    .join("\n");
  return <span className={className} role="status" aria-label={label} title={title}><Icon name="clock" size={size}/></span>;
}

/** A paused timer is a clock with attention, not a generic session error. */
export function TimerAlertBadge({ tasks }: { tasks: readonly ScheduledTask[] }) {
  if (!tasks.length) return null;
  const title = tasks.map(task => `${task.title}: ${task.detail ?? "таймер приостановлен"}`).join("\n");
  return <span className="session-timer timer-error" role="status" aria-label="Таймер приостановлен" title={title}>
    <Icon name="clock" size={14}/><span aria-hidden="true">!</span>
  </span>;
}
