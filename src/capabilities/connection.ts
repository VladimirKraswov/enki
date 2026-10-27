import type { RuntimeServerStatus } from "./registry";

/** Wait for the selected worker's tool registration, never a registry-write ACK. */
export function waitForMcpServer(options: {
  id: string;
  current(): boolean;
  report(): { servers: RuntimeServerStatus[]; error: string | null };
  subscribe(check: () => void): () => void;
  open(): void;
  timeoutMs?: number;
  label?: string;
  all?: boolean;
}): Promise<RuntimeServerStatus> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (error?: Error, server?: RuntimeServerStatus) => {
      if (done) return;
      done = true; clearTimeout(timer); unsubscribe();
      if (error) reject(error); else resolve(server!);
    };
    const check = () => {
      if (!options.current()) return finish(new Error("Чат или подключение изменились. Проверьте управление в выбранном чате."));
      const report = options.report();
      if (report.error) return finish(new Error(report.error));
      const server = options.all
        ? report.servers.find(item => item.state === "error") ?? report.servers[0]
        : report.servers.find(item => item.id === options.id);
      if (server?.state === "error") return finish(new Error(options.label
        ? "Подключение инструментов не восстановлено. Проверьте сервис в настройках."
        : "Чат не смог загрузить инструменты управления. Повторите подключение; если ошибка сохранится, проверьте драйвер и мост MCP."));
      if (server?.state === "connected") {
        if (options.all && !report.servers.every(item => item.state === "connected")) return;
        if (!server.tools.length) return finish(new Error("Подключение ответило, но не предоставило инструментов управления."));
        finish(undefined, server);
      }
    };
    const timer = setTimeout(() => finish(new Error("Чат не подтвердил подключение инструментов за отведённое время. Повторите подключение; создавать новый чат не нужно.")), options.timeoutMs ?? 65_000);
    unsubscribe = options.subscribe(check);
    try { options.open(); check(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
