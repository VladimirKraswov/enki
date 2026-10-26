import { useEffect, useRef, useState } from 'react';
import { isNative } from '../native/platform';
import { config, type HubConfig } from '../hub/client';
import { outcomes, subscribeOutcomes, type Outcome } from '../outcomes/store';
import { hubIdentity, memoryPage, memoryWrite, portableText, proposal, sourceOf, synchronizeMemorySources, type EntryInput, type MemoryEntry, type MemoryPage } from '../memory/client';
import { projects, projectKey, uuid, type Binding, type ProjectScope } from '../memory/projects';
import { connectRetrieval, readRetrieval, retrievalScope, isGranted, retrievalAvailable, type Connection } from '../memory/retrieval';
const states: Record<MemoryEntry['state'], string> = { candidate: 'Ждёт вашей проверки', approved: 'Одобрено вами', stale: 'Неактуально', expired: 'Срок истёк' };
type Draft = { id: string; sourceCard: string; sourceRevision: number; kind: 'fact' | 'runbook'; title: string; text: string; days: number };
// Only unsaved local forms, bounded and never transmitted on panel close.
const drafts = new Map<string, Draft>();

export function MemorySection({ server, directory, proposed }: { server: string; directory: string | null; proposed: Outcome | null }) {
  const [connection, setConnection] = useState<{ c: HubConfig; hub: string } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!isNative()) return;
    let live = true, serial = 0;
    const read = async () => { const n = ++serial; try { const c = await config(), hub = await hubIdentity(c); if (live && n === serial) { setConnection(previous => previous && JSON.stringify(previous.c) === JSON.stringify(c) ? previous : { c, hub }); setError(''); } } catch (e) { if (live && n === serial) { setConnection(null); setError(String(e)); } } };
    void read(); window.addEventListener('focus', read);
    return () => { live = false; serial++; window.removeEventListener('focus', read); };
  }, []);
  if (error) return <section className="outcome-section"><details><summary>Память проекта</summary><p role="alert" className="context-error">{error}</p><p className="context-note">Подключение настраивается в общей облачной библиотеке.</p></details></section>;
  if (!isNative() || !connection || !connection.c.enabled || !directory) return <section className="outcome-section"><details><summary>Память проекта</summary><p className="context-note">{!isNative() ? 'Память доступна в установленном Enki.' : !directory ? 'Откройте папку проекта, чтобы связать её с общей памятью.' : connection?.c.enabled === false ? 'Включите подключение к Hub в настройках облачной библиотеки.' : 'Проверка подключения…'}</p></details></section>;
  const scope = { hub: connection.hub, server, directory };
  return <ProjectMemory key={projectKey(scope)} scope={scope} shareText={connection.c.shareText} proposed={proposed} />;
}

export function ProjectMemory({ scope, shareText, proposed }: { scope: ProjectScope; shareText: boolean; proposed: Outcome | null }) {
  const key = projectKey(scope), [binding, setBinding] = useState<Binding | null>(null), [localBinding,setLocalBinding] = useState<Binding | null>(null), [page, setPage] = useState<MemoryPage>({ projects: [], entries: [] }), [cards, setCards] = useState<Outcome[]>([]);
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(key) ?? null), [title, setTitle] = useState(''), [code, setCode] = useState(''), [chosen, setChosen] = useState<{ id: string; title: string } | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [notice, setNotice] = useState('');
  const [retrieval, setRetrieval] = useState<Connection | null>(null), [retrievalError, setRetrievalError] = useState('');
  const newID = useRef(crypto.randomUUID());
  const live = useRef(true), serial = useRef(0), details = useRef<HTMLDetailsElement>(null);
  const refresh = async () => {
    const n = ++serial.current;
    try { const b = await projects.get(scope);
      if (!live.current || n !== serial.current) return;
      setLocalBinding(b);
      if (isNative() && retrievalAvailable(scope.server) && b) { try { const r = await readRetrieval(retrievalScope(scope,b)); if (live.current && n === serial.current) { setRetrieval(r); setRetrievalError(''); } } catch (e) { if (live.current && n === serial.current) { setRetrieval(null); setRetrievalError(String(e)); } } }
      await synchronizeMemorySources(); const p = await memoryPage(scope, b?.projectID), all = await outcomes.list();
      if (!live.current || n !== serial.current) return;
      setBinding(b); setPage(p);
      setCards(all.filter(x => x.scope.server === scope.server && x.scope.directory === scope.directory && x.verdict === 'accepted')); setReady(true); setLoadError('');
    } catch (e) { if (live.current && n === serial.current) { setReady(false); setPage({ projects: [], entries: [] }); setLoadError(String(e)); } }
  };
  useEffect(() => { live.current = true; void refresh(); const off = subscribeOutcomes(() => void refresh()); const tick = setInterval(() => void refresh(), 60000); return () => { live.current = false; serial.current++; off(); clearInterval(tick); }; }, [key]);
  const keep = (d: Draft | null) => { if (d) { if (!drafts.has(key) && drafts.size >= 100) throw Error('Сохраните другие черновики памяти (предел 100).'); drafts.set(key, d); } else drafts.delete(key); setDraft(d); };
  const begin = (card: Outcome) => { if (details.current) details.current.open = true; if (drafts.has(key)) { setError('Сначала сохраните или отмените черновик памяти.'); return; } try { keep({ ...proposal(card), id: crypto.randomUUID(), sourceCard: card.id, sourceRevision: card.revision, kind: 'fact', days: 30 }); if (details.current) details.current.open = true; setNotice('Проверьте текст: результат задачи ещё не является проверенным фактом.'); } catch (e) { setError(String(e)); } };
  const lastProposal = useRef<Outcome | null>(null);
  useEffect(() => { if (proposed && proposed !== lastProposal.current) { lastProposal.current = proposed; begin(proposed); } }, [proposed]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { if (live.current) setError(String(e)); } finally { if (live.current) setBusy(false); } };
  const create = () => void run(async () => { const id = newID.current; const p = await memoryWrite<{ id: string; title: string }>(scope, { action: 'project', id, title }); if (live.current) { setChosen(p); setNotice('Проект создан в Hub. Подтвердите привязку этой папки.'); } });
  const find = () => void run(async () => { if (!uuid(code)) throw Error('Вставьте полный UUID проекта с другого устройства.'); const p = await memoryPage(scope, code), found = p.projects.find(x => x.id === code); if (!found) throw Error('Проект не найден.'); if (live.current) setChosen(found); });
  const bind = () => void run(async () => { if (!chosen) return; await projects.bind(scope, chosen.id, chosen.title, binding?.revision ?? null); if (live.current) { setChosen(null); await refresh(); setNotice('Папка связана с общей памятью.'); } });
  const save = () => void run(async () => { if (!draft || !binding) return; const latest = (await outcomes.list()).find(x => x.id === draft.sourceCard); if (!latest) throw Error('Исходный результат не найден.'); proposal(latest); if (latest.revision !== draft.sourceRevision) throw Error('Результат изменён после создания черновика. Отмените его и выберите свежий источник.'); const source = await sourceOf(latest);
    const entry: EntryInput = { id: draft.id, project: binding.projectID, kind: draft.kind, title: portableText(draft.title, 120), text: portableText(draft.text, 4000), source, expiresAt: Date.now() + draft.days * 86400000 };
    await memoryWrite<MemoryEntry>(scope, { action: 'save', expected: null, entry }); if (live.current) { keep(null); await refresh(); setNotice('Кандидат сохранён. Отдельно проверьте и одобрите запись.'); }
  });
  const review = (e: MemoryEntry, action: 'approve' | 'invalidate') => void run(async () => { await synchronizeMemorySources(); await memoryWrite(scope, { action, id: e.id, expected: e.revision }); if (live.current) { await refresh(); setNotice(action === 'approve' ? 'Запись одобрена вами.' : 'Запись исключена из актуальной памяти.'); } });
  const edit = (patch: Partial<Draft>) => { if (draft) keep({ ...draft, ...patch }); };
  return <section className="outcome-section memory-section"><details ref={details}><summary>Память проекта{binding ? ` · ${binding.title}` : ''}</summary>

    {!shareText && <p className="context-note">Чтобы добавлять записи, включите передачу текстов в настройках библиотеки.</p>}
    <button className="btn small ghost" disabled={busy} onClick={() => void run(refresh)}>Обновить память</button>
    {localBinding && isNative() && retrievalAvailable(scope.server) && <div className="memory-card"><strong>Память для агента</strong><p className="context-note">Агент получит одобренные записи проекта. После подключения откройте чат заново, чтобы обновить доступные инструменты.</p><button className="btn small" disabled={busy || (!ready && !isGranted(retrieval,retrievalScope(scope,localBinding)))} onClick={() => void run(async () => { if (!isGranted(retrieval,retrievalScope(scope,localBinding))) await synchronizeMemorySources(); const r = await connectRetrieval(retrievalScope(scope,localBinding), !isGranted(retrieval,retrievalScope(scope,localBinding))); if (live.current) { setRetrieval(r); setRetrievalError(''); setNotice(r.grant?.enabled ? 'Память подключена для этой папки.' : 'Поиск отключён. Уже переданный контекст остаётся в истории чата.'); } })}>{isGranted(retrieval,retrievalScope(scope,localBinding)) ? 'Отключить память' : 'Подключить память'}</button>{retrievalError && <p role="alert" className="context-error">{retrievalError}</p>}</div>}
    {!binding && <><label>Название нового проекта<input aria-label="Название проекта памяти" maxLength={80} value={title} disabled={busy} onChange={e => { setTitle(e.target.value); newID.current = crypto.randomUUID(); setChosen(null); }} /></label>
      <button className="btn small" disabled={busy || !ready || !shareText || !title.trim()} onClick={create}>Создать проект памяти</button>
      <label>Код проекта с другого устройства<input aria-label="Код проекта памяти" value={code} maxLength={36} disabled={busy} onChange={e => { setCode(e.target.value); setChosen(null); }} /></label>
      <button className="btn small" disabled={busy || !ready || !uuid(code)} onClick={find}>Проверить код проекта</button></>}
    {chosen && <div className="memory-card"><strong>{chosen.title}</strong><p className="context-note">Связать текущую папку с этим проектом?</p><button className="btn small primary" disabled={busy} onClick={bind}>Подтвердить привязку папки</button></div>}
    {binding && <>{!retrievalAvailable(scope.server) && <p className="context-note">Поиск памяти доступен только локальным агентам.</p>}<label>Код для другого устройства<input aria-label="Переносимый код проекта" value={binding.projectID} readOnly onFocus={e => e.target.select()} /></label>
      <p className="context-note">Скопируйте код для привязки на другом устройстве.</p>
      {!draft && <><label>Принятый результат<select aria-label="Источник памяти" disabled={busy || !ready || !shareText} defaultValue="" onChange={e => { const c = cards.find(x => x.id === e.target.value); if (c) begin(c); e.target.value = ''; }}><option value="">Выберите результат…</option>{cards.map(c => <option key={c.id} value={c.id}>{c.scope.engine === 'pi' ? 'Enki' : 'Источник: OpenCode'} · {c.goal.slice(0,100)}</option>)}</select></label>{!cards.length && <p className="context-note">Сначала сохраните и примите результат задачи в этой папке.</p>}</>}
      {draft && <fieldset disabled={busy}><legend>Предложение в память</legend><label>Вид<select aria-label="Вид записи памяти" value={draft.kind} onChange={e => edit({ kind: e.target.value as Draft['kind'] })}><option value="fact">Факт</option><option value="runbook">Порядок действий</option></select></label>
        <label>Название<input aria-label="Название записи памяти" maxLength={120} value={draft.title} onChange={e => edit({ title: e.target.value })} /></label>
        <label>Проверенные сведения<textarea aria-label="Текст памяти" maxLength={4000} value={draft.text} onChange={e => edit({ text: e.target.value })} /></label>
        <label>Срок актуальности<select aria-label="Срок памяти" value={draft.days} onChange={e => edit({ days: Number(e.target.value) })}>{[7,30,90,180,365].map(d => <option key={d} value={d}>{d} дней</option>)}</select></label>
        <p className="context-note">Не вставляйте секреты. Запись отправится после сохранения и потребует одобрения.</p>
        <div className="outcome-actions"><button className="btn small primary" disabled={!ready || !shareText || !draft.title.trim() || !draft.text.trim()} onClick={save}>Сохранить кандидата</button><button className="btn small ghost" onClick={() => keep(null)}>Отменить черновик памяти</button></div>
      </fieldset>}

      {ready && !page.entries.length && <p className="context-note">Записей пока нет.</p>}
      {page.entries.map(e => <article className="memory-card" key={e.id}><strong>{e.title}</strong><small>{states[e.state]} · {e.kind === 'fact' ? 'факт' : 'порядок действий'} · версия {e.revision}</small><p className="memory-text">{e.text}</p><small>{e.source.engine === 'pi' ? 'Enki' : 'Источник: OpenCode'} · источник {e.source.anchor.slice(0,12)} / {e.source.revision} · до {new Date(e.expiresAt).toLocaleDateString('ru')}</small>
        <div className="outcome-actions">{e.state === 'candidate' && <button className="btn small primary" disabled={busy || !ready} onClick={() => review(e, 'approve')}>Одобрить запись</button>}{(e.state === 'candidate' || e.state === 'approved') && <button className="btn small ghost" disabled={busy || !ready} onClick={() => review(e, 'invalidate')}>Снять актуальность</button>}</div></article>)}
    </>}
    {busy && <p className="context-note" role="status">Сохранение / обновление…</p>}{notice && <p className="context-note" role="status">{notice}</p>}{(error || loadError) && <p className="context-error" role="alert">{error || loadError}</p>}
  </details></section>;
}
