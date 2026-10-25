// Durable tool execution journal.
//
// A row is written when a tool starts and completed when it ends. After a
// crash, rows still "started" mark side effects whose outcome is unknown. The
// session then receives an explicit error tool result for each such call — the
// transcript keeps every tool call paired with a result, the model is told the
// outcome is unknown, and nothing is replayed.

import { integer, optionalText, text, type Database } from "../store/db.ts";

export interface InterruptedTool { sessionID: string; toolCallId: string; tool: string; commandId: string | null; started: number }

export const INTERRUPTED_TOOL_TEXT = "Enki Runtime остановилась во время выполнения этого инструмента. Результат НЕИЗВЕСТЕН: действие могло частично выполниться. Не считай его успешным и не повторяй вслепую — сначала проверь фактическое состояние (файлы, процессы, внешние системы).";

export class ToolJournal {
  constructor(private readonly db: Database) {}

  started(sessionID: string, toolCallId: string, tool: string, commandId: string | null): void {
    this.db.run("INSERT INTO executions(session_id,tool_call_id,tool,command_id,state,started) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,tool_call_id) DO UPDATE SET state='started', started=excluded.started",
      sessionID, toolCallId, tool, commandId, "started", Date.now());
  }

  ended(sessionID: string, toolCallId: string, isError: boolean): void {
    this.db.run("UPDATE executions SET state=?, ended=? WHERE session_id=? AND tool_call_id=?", isError ? "error" : "completed", Date.now(), sessionID, toolCallId);
  }

  interrupted(sessionID?: string): InterruptedTool[] {
    const rows = sessionID
      ? this.db.all("SELECT * FROM executions WHERE state='started' AND session_id=?", sessionID)
      : this.db.all("SELECT * FROM executions WHERE state='started'");
    return rows.map((row) => ({
      sessionID: text(row, "session_id"), toolCallId: text(row, "tool_call_id"), tool: text(row, "tool"),
      commandId: optionalText(row, "command_id"), started: integer(row, "started"),
    }));
  }

  reconciled(sessionID: string, toolCallId: string): void {
    this.db.run("UPDATE executions SET state='uncertain', ended=? WHERE session_id=? AND tool_call_id=?", Date.now(), sessionID, toolCallId);
  }

  prune(olderThan: number): void {
    this.db.run("DELETE FROM executions WHERE state<>'started' AND started < ?", olderThan);
  }
}
