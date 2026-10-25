import { maintenance } from './maintenance';
import { invoke } from '@tauri-apps/api/core';
import { isNative } from '../native/platform';
import { attachmentDrafts } from '../attachments/drafts';
import { ApiError } from '../api/http';

export class NotDispatched extends Error {}
export type DeliveryState = 'prepared' | 'dispatching' | 'accepted' | 'uncertain' | 'refused' | 'cancelled';
export interface Operation {
  id: string; workspace: string; engine: string; sessionId: string; directory: string;
  source: 'manual' | 'queue' | 'schedule'; sourceId: string | null; text: string;
  attachments: { scope: string; files: { id: string; name: string; mime: string; size: number }[] } | null;
  model: string; state: DeliveryState; updatedAt: number;
  /**
   * Exact ledger that received this send: `runtime:<hostId>` for 2.0 runtime
   * commands. Absent on records written by an older Enki (OpenCode / Pi CLI
   * engines): only the authority that received a request can prove it was
   * not delivered, so a 2.0 ledger 404 is "unknown" for those, never "unsent".
   */
  authority?: string;
}

/** The runtime ledger identity a record was sent to, or null for pre-2.0/unknown origins. */
export function ledgerAuthority(record: Pick<Operation, "authority">): string | null {
  return typeof record.authority === "string" && /^runtime:[a-f0-9-]{36}$/.test(record.authority) ? record.authority : null;
}
export type OperationInput = Omit<Operation, 'state' | 'updatedAt'>;
export interface JournalStorage {
  list(workspace: string): Promise<Operation[]>;
  write(record: Operation, expected: DeliveryState | null): Promise<void>;
}
const key = 'arvela.operations.v1';
// Browser-only development uses the same durable/CAS contract, never a memory fallback.
const browserStorage: JournalStorage = {
  async list(workspace) { return read().filter(r => r.workspace === workspace); },
  async write(record, expected) {
    const records = read(), old = records.find(r => r.id === record.id);
    if ((old?.state ?? null) !== expected) throw Error('Журнал изменился. Повторная отправка запрещена.');
    if (!old && record.source === 'queue' && records.some(r => r.workspace === record.workspace && r.source === 'queue' && r.sourceId === record.sourceId && ['dispatching', 'uncertain', 'accepted'].includes(r.state)))
      throw Error('Запрос уже отправлялся. Проверьте доставку в журнале.');
    localStorage.setItem(key, JSON.stringify([...records.filter(r => r.id !== record.id), record]));
  },
};
function read(): Operation[] {
  const text = localStorage.getItem(key); const records = text ? JSON.parse(text) : [];
  if (!Array.isArray(records) || records.some(r => !r || typeof r.id !== 'string' || typeof r.workspace !== 'string' || typeof r.state !== 'string'))
    throw Error('Журнал повреждён. Отправка приостановлена.');
  return records;
}
const nativeStorage: JournalStorage = {
  list: workspace => invoke('operation_journal', { workspace, record: null, expected: null }),
  async write(record, expected) { await invoke('operation_journal', { workspace: record.workspace, record, expected }); },
};
export class OperationJournal {
  private flights = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  constructor(private storage: () => JournalStorage = () => isNative() ? nativeStorage : browserStorage) {}
  list(workspace: string) { return this.storage().list(workspace); }
  private async write(record: Operation, state: DeliveryState, expected: DeliveryState | null) {
    const next = { ...record, state, updatedAt: Date.now() };
    await this.storage().write(next, expected);
    for (const notify of this.listeners) notify();
    return next;
  }
  dispatch(input: OperationInput, current: () => boolean, send: () => Promise<unknown>): Promise<void> {
    const flight=this.deliver(input,current,send);this.flights.add(flight);
    void flight.then(()=>this.flights.delete(flight),()=>this.flights.delete(flight));
    return flight;
  }
  async drain(): Promise<void> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { await Promise.race([Promise.allSettled([...this.flights]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Дождитесь подтверждения отправляемого сообщения.')),15000);})]); }
    finally { clearTimeout(timer); }
  }
  private async deliver(input: OperationInput, current: () => boolean, send: () => Promise<unknown>): Promise<void> {
    if(maintenance.active())throw new NotDispatched('Приложение обновляется; запрос сохранён в черновике.');
    const allowed=current;current=()=>!maintenance.active()&&allowed();
    // Keep private recovery copies. Composer/queue cleanup must not remove the
    // only attachment copy after a POST whose acknowledgement was lost.
    if (input.attachments?.files.length) {
      const scope = `${input.attachments.scope}:operation:${input.id}`;
      const files = await attachmentDrafts.copy(input.attachments.scope, scope, input.attachments.files.map(f => f.id));
      input = {...input, attachments: {scope, files: files.map(({id,name,mime,size}) => ({id,name,mime,size}))}};
    }
    const prepared = await this.write({ ...input, state: 'prepared', updatedAt: Date.now() }, 'prepared', null);
    if (!current()) { await this.write(prepared, 'cancelled', 'prepared'); throw Error('Отправка отменена. Черновик сохранён.'); }
    const sending = await this.write(prepared, 'dispatching', 'prepared');
    // Disk writes can yield: Stop/navigation must still win before the POST.
    if (!current()) { await this.write(sending, 'cancelled', 'dispatching'); throw Error('Отправка отменена. Черновик сохранён.'); }
    try { await send(); }
    catch (error) {
      const refused = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      await this.write(sending, error instanceof NotDispatched ? 'cancelled' : refused ? 'refused' : 'uncertain', 'dispatching').catch(() => {});
      throw error;
    }
    // A failed acknowledgement write must not misrepresent the POST as unsent.
    // The durable dispatching record remains recoverable and blocks blind replay.
    const accepted=await this.write(sending, 'accepted', 'dispatching').catch(() => null);
    if(accepted?.attachments)await attachmentDrafts.remove(accepted.attachments.scope,accepted.attachments.files.map(f=>f.id)).catch(()=>{});
  }
  async cancelPrepared(record: Operation) {
    if (record.state !== 'prepared') throw Error('Доставка могла состояться. Сначала проверьте историю.');
    await this.write(record, 'cancelled', 'prepared');
  }
  /** The runtime's durable ledger says the command was refused or never recorded. */
  async settle(record: Operation, state: 'refused' | 'cancelled') {
    if (!['dispatching', 'uncertain'].includes(record.state)) return false;
    await this.write(record, state, record.state);
    return true;
  }
  async confirm(record: Operation, foundExactUserMessage: boolean) {
    if (!foundExactUserMessage || !['dispatching', 'uncertain'].includes(record.state)) return false;
    await this.write(record, 'accepted', record.state);
    if(record.attachments)await attachmentDrafts.remove(record.attachments.scope,record.attachments.files.map(f=>f.id)).catch(()=>{});
    return true;
  }
}
export const operationJournal = new OperationJournal();
