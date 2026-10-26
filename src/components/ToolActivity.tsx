import { useEffect, useState } from "react";
import type { ToolState } from "../api/types";

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} с` : seconds < 3600 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
    : `${Math.floor(seconds / 3600)} ч ${Math.floor(seconds / 60) % 60} мин`;
}

/** A clock is not progress evidence. Silence is measured only from real output. */
export function ToolActivity({ state, tool }: { state: ToolState; tool?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = state.time?.start;
  if (!start || !Number.isFinite(start)) return null;
  const elapsed = Math.max(0, now - start);
  const outputAt = state.time?.output;
  const silence = outputAt ? Math.max(0, now - outputAt) : elapsed;
  const fields = state.input && typeof state.input === "object" ? state.input as Record<string, unknown> : {};
  const timeout = tool === "bash" && typeof fields.timeout === "number" && Number.isFinite(fields.timeout) && fields.timeout > 0 ? fields.timeout * 1000 : null;
  return <span className="tool-activity" title={`Команда ещё не завершилась. Агент ждёт результат инструмента.${outputAt ? ` Без нового вывода: ${duration(silence)}.` : ""}${timeout ? ` Лимит команды: ${duration(timeout)}.` : ""}`}>
    <span>{duration(elapsed)}</span>
    {silence >= 30_000 && (outputAt || !state.output) && <span className="tool-silence">{outputAt ? "без вывода" : "нет вывода"} {duration(silence)}</span>}
  </span>;
}
