import { useEffect, useState } from 'react';
import type { RuntimeStartup } from '../agent/runtime/startup';
import { CopyButton } from './CopyButton';

const names: Record<RuntimeStartup['phase'], string> = {
  preparing:'Подготавливаем среду Enki', manifest:'Проверяем манифест среды', inventory:'Проверяем состав файлов',
  hashing:'Проверяем целостность файлов', starting_node:'Запускаем Node.js', waiting_ready:'Ожидаем готовности среды',
  ready:'Подключаемся к среде Enki', failed:'Не удалось запустить среду Enki', cancelled:'Запуск среды отменён',
};
export function RuntimeStartupStatus({ progress, error, onRetry }: {
  progress?: RuntimeStartup; error?: string | null; onRetry(): void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(n=>n+1),1000); return () => clearInterval(timer); },[]);
  const active = progress && !['ready','failed','cancelled'].includes(progress.phase);
  error = error ?? (progress?.phase === 'failed' || progress?.phase === 'cancelled' ? progress.error : null);
  // Native elapsed is monotonic; it does not depend on the host wall clock.
  const seconds = progress ? Math.floor(progress.elapsedMs/1000) : tick;
  const label = error && progress?.phase !== 'failed' && progress?.phase !== 'cancelled'
    ? 'Не удалось подключиться к среде Enki'
    : progress ? names[progress.phase] : 'Подготавливаем среду Enki';
  const detail = progress?.phase === 'hashing' && progress.total !== null
    ? `${progress.completed.toLocaleString('ru-RU')} / ${progress.total.toLocaleString('ru-RU')} файлов`
    : progress?.phase === 'inventory' ? `Проверено записей: ${progress.completed.toLocaleString('ru-RU')}` : null;
  return <div className="runtime-startup" role={error ? 'alert' : 'group'} aria-label="Запуск среды Enki">
    <div className="status-line">{!error && <span className="tool-spinner" aria-hidden/>}<strong role={error ? undefined : 'status'}>{label}</strong><span className="inference-elapsed" aria-hidden>{seconds < 60 ? `${seconds} с` : `${Math.floor(seconds/60)} мин ${seconds%60} с`}</span></div>
    {progress?.phase === 'hashing' && progress.total !== null && <progress aria-label="Проверено файлов среды" max={Math.max(1,progress.total)} value={progress.completed}/>}
    {detail && <div className="inference-detail">{detail}</div>}
    <p className="inference-detail">{!error ? 'Дождитесь подготовки. Черновики и история сохранены; повторный запуск не нужен.' : error}</p>
    <div className="btn-row">
      {error && !active && <button className="btn small" onClick={onRetry}>Повторить подключение</button>}
    </div>
    {progress && <details className="inference-detail"><summary>Диагностика запуска</summary>
      <CopyButton label="Скопировать диагностику запуска" text={JSON.stringify({type:'enki-runtime-startup',...progress,error:progress.error ? 'start_failed' : null},null,2)}/>
      <pre className="terminal-output">{JSON.stringify({type:'enki-runtime-startup',...progress,error:progress.error ? 'start_failed' : null},null,2)}</pre>
    </details>}
  </div>;
}
