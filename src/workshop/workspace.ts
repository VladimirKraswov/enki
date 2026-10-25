import type { Session, PermissionRule } from "../api/types";
import type { AgentBackend, CreateSessionInput, SessionPatch } from "../agent/backend";
import { ApiError } from "../api/http";
export const WORKSHOP_TITLE = "Мастерская";
const legacyTitles = new Set(["Мастерская Arvela", "Мастерская Арвела"]);
export interface WorkshopWorkspace { directory: string; sourceDirectory: string | null; legacyDirectory?: string | null }
export interface WorkshopRecord extends WorkshopWorkspace { session: Session }
export async function prepareWorkshop(serverHome: string, sourceDirectory?: string): Promise<WorkshopWorkspace> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("workshop_prepare", { sourceDirectory: sourceDirectory ?? null, serverHome });
}
/** The runtime marks the workshop session; its release policy is injected into that session's system prompt. */
type WorkshopBackend = AgentBackend & {
  createSession(input: CreateSessionInput & { workshop?: boolean }): Promise<Session>;
  updateSession(sessionID: string, patch: SessionPatch & { workshop?: boolean }, directory: string | null): Promise<Session>;
  /** Verified archive → writable continuation; repeating it returns the same continuation. */
  continueLegacy(sessionID: string, directory: string): Promise<Session>;
};
const readOnly = (s: Session) => s.origin?.kind === "opencode";
/**
 * Reconcile ambiguous creates by directory/title before ever creating again.
 * A saved pointer that resolves to a read-only imported archive continues
 * through the runtime's verified (idempotent) continuation inside the trusted
 * workshop directory: its history is kept, nothing is replayed, and no empty
 * replacement is created. The caller replaces its saved pointer only with the
 * returned record, i.e. after the runtime acknowledged everything.
 */
export async function resolveWorkshop(
  backend: WorkshopBackend, workspace: WorkshopWorkspace, previous?: WorkshopRecord, permission?: PermissionRule[],
  onContinued?: (archive: Session, continuation: Session) => void,
): Promise<WorkshopRecord> {
  let session: Session | undefined, archive: Session | undefined;
  // The alias is supplied only after native canonical-path equality checks.
  const directories = [...new Set([workspace.directory, ...(workspace.legacyDirectory ? [workspace.legacyDirectory] : [])])];
  if (previous && directories.includes(previous.directory)) {
    try { session = await backend.getSession(previous.session.id, previous.directory); }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    if (session && readOnly(session)) { archive = session; session = undefined; }
  }
  if (!session && !archive) {
    // Without a saved pointer an imported archive is not proven to be this
    // user's workshop, so it is never adopted or continued from the list.
    const list = (await Promise.all(directories.map(directory => backend.listSessions(directory, {limit:100})))).flat();
    session = list.filter(s => directories.includes(s.directory) && (s.title === WORKSHOP_TITLE || legacyTitles.has(s.title)) && !s.parentID && !readOnly(s))
      .sort((a,b) => a.time.created - b.time.created || a.id.localeCompare(b.id))[0];
  }
  if (!session && archive) {
    if (!directories.includes(archive.directory)) throw new Error("Архив мастерской находится вне её каталога.");
    session = await backend.continueLegacy(archive.id, archive.directory);
    if (readOnly(session)) throw new Error("Среда выполнения не создала доступное для записи продолжение мастерской.");
    onContinued?.(archive, session);
  }
  session ??= await backend.createSession({directory:workspace.directory,title:WORKSHOP_TITLE,workshop:true,...(permission ? {permission} : {})});
  if (!directories.includes(session.directory)) throw new Error("Агент вернул другой каталог мастерской.");
  if (session.time.archived || legacyTitles.has(session.title ?? "") || !session.workshop) session = await backend.updateSession(session.id,{
    ...(session.time.archived ? {time:{archived:0}} : {}),
    ...(legacyTitles.has(session.title ?? "") ? {title:WORKSHOP_TITLE} : {}),
    ...(!session.workshop ? {workshop:true} : {}),
  },session.directory);
  return {...workspace,directory:session.directory,session};
}
export function isWorkshopSession(record: WorkshopRecord | undefined, session: Pick<Session,"id"|"directory">): boolean {
  return record?.session.id === session.id && record.directory === session.directory;
}
