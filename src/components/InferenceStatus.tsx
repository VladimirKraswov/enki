import { useEffect, useRef, useState } from 'react';
import type { InferenceProgress } from '../../src-tauri/resources/agent/src/inference-progress';

export function InferenceStatus({ progress }: { progress: InferenceProgress }) {
  const [now, setNow] = useState(performance.now());
  const received = useRef({ request: progress.requestID, elapsed: progress.elapsedMs, at: performance.now() });
  if (received.current.request !== progress.requestID || received.current.elapsed !== progress.elapsedMs)
    received.current = { request: progress.requestID, elapsed: progress.elapsedMs, at: performance.now() };
  useEffect(() => { const timer = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(timer); }, [progress.requestID]);
  // A remote runtime can have a different wall clock. Count locally from its
  // reported elapsed time instead of subtracting a server timestamp.
  const seconds = Math.max(0, Math.floor((progress.elapsedMs + Math.max(0, now - received.current.at)) / 1000));
  const elapsed = seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
  const n = (value: number) => value.toLocaleString('ru-RU');
  const measured = progress.total !== undefined && progress.processed !== undefined;
  const phaseLabel = progress.phase === 'waiting' ? 'Ожидаю ответ сервера модели'
    : progress.phase === 'prefill' ? 'Обрабатываю контекст'
    : progress.phase === 'reasoning' ? 'Модель обдумывает ответ' : 'Модель формирует ответ';
  const label = progress.task === 'compaction' ? `Сжимаю историю · ${phaseLabel.toLocaleLowerCase('ru-RU')}` : phaseLabel;
  return <div className="inference-status" role="status" aria-label={label}>
    <div className="status-line"><span className="tool-spinner" aria-hidden />{label}<span className="inference-elapsed">{elapsed}</span></div>
    {progress.phase === 'prefill' && measured && <>
      <progress aria-label="Обработано токенов контекста" max={Math.max(1, progress.total!)} value={progress.processed!} />
      <div className="inference-detail">{n(progress.processed!)} / {n(progress.total!)} токенов
        {progress.cached! > 0 ? ` · из кэша ${n(progress.cached!)}` : ' · без готового кэша'}</div>
    </>}
    {progress.phase === 'waiting' && seconds >= 15 && <div className="inference-detail">Сервер ещё не передал прогресс. Запрос передаётся или обрабатывается; повторять его не нужно.</div>}
    {progress.phase === 'prefill' && progress.cache === 'prefix_changed' && <div className="inference-detail">Инструкции или инструменты изменились — контекст пересчитывается.</div>}
  </div>;
}
