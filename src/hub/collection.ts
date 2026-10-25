import type { AppState } from '../state/types';
import type { Outcome } from '../outcomes/store';
import type { Message, MessagePart, Session } from '../api/types';
import { engineForSession } from '../state/engines';
import { attachAssessment } from '../outcomes/sharing';
import { taskDiagnostics, taskPositions } from '../diagnostics/tasks';
import { record, type HubRecord } from './records';

/** A record the collector will never mutate: its digest may be reused by identity. */
export interface CollectedRecord { message: Message; record: HubRecord; stable?: boolean }

// An assistant record depends only on these inputs. The reducer replaces changed
// message/part objects, so identical inputs reproduce an identical record: reuse
// it instead of re-redacting/serializing an unchanged transcript every tick.
interface AssistantInputs { parts: readonly MessagePart[]; session: string; title: string; directory: string; engine: string; shareText: boolean; record: HubRecord | null }
const assistantRecords = new WeakMap<Message, AssistantInputs>();
const sameParts = (a: readonly MessagePart[], b: readonly MessagePart[]) => a.length === b.length && a.every((part, i) => part === b[i]);

/** Read one consistent snapshot; never guess a background chat's directory. */
export function* iterateHubRecords(state: AppState, assessments: Map<string, Outcome>, shareText: boolean): Generator<CollectedRecord> {
  const sessions = new Map<string, Pick<Session, 'id' | 'title' | 'directory'>>();
  for (const session of [
    ...(state.prefs.projectlessSessions ?? []), ...state.recentSessionList.sessions,
    ...Object.values(state.projectSessionLists).flatMap(list => list.sessions),
    ...state.archivedSessions, ...state.sessions,
  ]) if (session.directory) sessions.set(session.id, session);
  for (const meta of Object.values(state.prefs.piSessions ?? {})) sessions.set(meta.id, meta);
  const server = state.prefs.workspaceKey ?? state.prefs.endpoint;
  for (const [sessionID, chat] of Object.entries(state.chat.sessions)) {
    const session = sessions.get(sessionID);
    if (!session) continue; // Metadata will be collected once it is known.
    const engine = engineForSession(state.prefs, sessionID, session.directory) === 'pi' ? 'pi' : 'opencode';
    const order = [...chat.messageOrder];
    let positions: ReturnType<typeof taskPositions> | undefined;
    for (const messageID of order) {
      const message = chat.messages[messageID];
      if (!message) continue;
      const parts = (chat.partsByMessage[messageID] ?? []).map(id => chat.parts[id]).filter(Boolean);
      if (message.role === 'assistant') {
        const cached = assistantRecords.get(message);
        const reuse = !!cached && cached.session === session.id && cached.title === session.title && cached.directory === (session.directory ?? '')
          && cached.engine === engine && cached.shareText === shareText && sameParts(cached.parts, parts);
        const item = reuse ? cached!.record : record(engine, session, message, parts, shareText);
        if (!reuse) assistantRecords.set(message, { parts, session: session.id, title: session.title, directory: session.directory ?? '', engine, shareText, record: item });
        if (item) yield { message, record: item, stable: true };
        continue;
      }
      const item = attachAssessment(record(engine, session, message, parts, shareText), assessments, server, session.directory ?? '', shareText);
      if (!item) continue;
      if (message.role === 'user') {
        positions ??= taskPositions(chat);
        const diagnostics = taskDiagnostics(chat, messageID, positions.get(messageID));
        if (diagnostics) item.diagnostics = diagnostics;
      }
      yield { message, record: item };
    }
  }
}
export function collectHubRecords(state: AppState, assessments: Map<string, Outcome>, shareText: boolean): HubRecord[] {
  return [...iterateHubRecords(state, assessments, shareText)].map(item => item.record);
}
