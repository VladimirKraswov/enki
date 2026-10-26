import { ConnectionError } from "../../api/http";
import type { MigrationsDTO } from "./client";

/** A lost HTTP answer is not a failed import. Follow the SAME durable job;
 * never resend its POST and never mistake an older archive for completion. */
export async function reconcileOpenCodeImport(error: unknown, source: string, previous: MigrationsDTO,
  port: { read(): Promise<MigrationsDTO>; current(): boolean; notify(phase: string): void; pause?(): Promise<void> }): Promise<void> {
  if (!(error instanceof ConnectionError)) throw error;
  const known = new Set(previous.journal.map(job => job.id));
  const pause = () => port.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 2000));
  const deadline = Date.now() + 20 * 60_000;
  let jobId: string | undefined, lastPhase: string | undefined;
  let readFailures = 0;
  for (let attempt = 0; attempt < 600 && Date.now() < deadline; attempt++) {
    if (!port.current()) throw new Error("Перенос истории продолжится в своей среде выполнения. Подключение изменилось.");
    let info: MigrationsDTO;
    try { info = await port.read(); readFailures = 0; }
    catch (readError) {
      if (!(readError instanceof ConnectionError) || ++readFailures >= 3) throw readError;
      await pause(); continue;
    }
    if (!port.current() || info.sources.opencode !== source) throw new Error("Источник истории изменился; исходные данные сохранены.");
    const jobs = info.journal.filter(job => job.kind === "opencode" && !known.has(job.id));
    if (!jobId) {
      if (jobs.length !== 1) throw error;
      jobId = jobs[0].id;
    }
    const job = jobs.find(item => item.id === jobId);
    if (!job) throw error;
    let archive: unknown;
    try { archive = JSON.parse(job.detail ?? "{}").archive; } catch { throw error; }
    if (job.state === "committed") {
      if (typeof archive !== "string" || !info.archives.some(item => item.id === archive && item.kind === "opencode" && item.source === source)) throw error;
      return;
    }
    if (!["staging", "snapshotted", "verified", "publishing"].includes(job.state))
      throw new Error("Подготовка истории остановлена. Исходная база сохранена; подробности доступны в журнале импорта.");
    if (lastPhase !== job.state) { port.notify(job.state); lastPhase = job.state; }
    await pause();
  }
  throw new Error("Подготовка истории ещё не подтверждена. Исходная база сохранена; проверьте журнал импорта перед повтором.");
}
