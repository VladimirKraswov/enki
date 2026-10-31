import { useState } from 'react';
import { taskDiagnostics } from '../diagnostics/tasks';
import type { SessionChatState } from '../state/chatReducer';
import { secondsText } from '../util/duration';
const time = (ms: number | null) => ms == null ? 'Не измерено' : secondsText(ms);
const states = {running:'Выполняется',ended:'Агент завершил ответ',error:'Ошибка',aborted:'Остановлено',unknown:'Недостаточно данных'};
export function TaskDiagnostics({chat}:{chat?: SessionChatState}) {
  const [selected,setSelected] = useState('');
  const requests = (chat?.messageOrder ?? []).filter(id=>chat?.messages[id]?.role==='user');
  const id = requests.includes(selected) ? selected : requests[requests.length-1];
  const d = taskDiagnostics(chat,id);
  return <section className="task-diagnostics"><details><summary>Время и выполнение задачи</summary>

    {!d ? <p className="context-note">Появится после запроса в этом чате.</p> : <>
      <label>Запрос<select aria-label="Запрос для диагностики" value={id} onChange={e=>setSelected(e.target.value)}>{requests.map((id,i)=><option key={id} value={id}>Запрос {i+1}</option>)}</select></label>
      <p>{states[d.state]} · {d.source==='observed'?'есть живые наблюдения':'история агента'}</p>
      <dl className="task-timings">{[
        ['Полное время',time(d.wallMs)],['Очередь Desktop',time(d.queueMs)],['Подготовка в Desktop',time(d.preparationMs)],
        ['Первый ответ после отправки',time(d.firstResponseMs)],['Инструменты',time(d.toolMs)],['Рассуждения',time(d.reasoningMs)],
        ['Вне известных фаз',time(d.unattributedMs)],['Вызовы / ошибки',`${d.calls} / ${d.failed}`],
        ['Повторные вызовы инструмента',String(d.repeatedCalls)],['Повторы соединения',d.retries==null?'Не измерено':String(d.retries)],
        ['Вход / выход / рассуждения',`${d.input??'—'} / ${d.output??'—'} / ${d.reasoning??'—'}`],
      ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <button className="btn small" onClick={()=>{
        const url=URL.createObjectURL(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='enki-task-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }}>Экспортировать числовую сводку</button>
      {!d.usageComplete && <p className="context-note">Неполные данные о токенах.</p>}
    </>}
  </details></section>;
}
