// Hub-side remote channel as seen from the app UI. Devices and their sessions
// come from the Hub snapshot the Runtime already uploads; commands use the same
// validated endpoint the Runtime executes (`prompt`, `session.create`). Nothing
// here is a second agent loop: the Hub stores and routes, the receiving Runtime
// runs the request with its own dispatcher and queue.
import { request } from "./client";

export interface RemoteModelRef { providerID: string; modelID: string; variant?: string | null }
export interface RemoteSession {
  id: string;
  title?: string;
  directory?: string;
  model?: { id?: string; providerID?: string; variant?: string | null };
  time?: { created?: number; updated?: number; archived?: number };
}
export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  appVersion?: string | null;
  seen?: number;
  online?: boolean;
  updated?: number;
  overview?: {
    sessions?: RemoteSession[];
    projects?: string[];
    settings?: { model?: RemoteModelRef };
    host?: string;
    platform?: string;
  };
}
export interface RemoteOverview { devices: RemoteDevice[]; serverTime?: number }
export interface RemoteCommandCard {
  id: string; device: string; session: string | null; kind: string;
  state: "queued" | "running" | "done" | "error" | string;
  result?: Record<string, unknown> | null;
}

export async function remoteOverview(): Promise<RemoteOverview> {
  return request<RemoteOverview>("remote/overview");
}

export async function remoteCommand(id: string): Promise<RemoteCommandCard> {
  const value = await request<{ command?: RemoteCommandCard } | RemoteCommandCard>(`remote/command?id=${encodeURIComponent(id)}`);
  return (value as { command?: RemoteCommandCard }).command ?? (value as RemoteCommandCard);
}

/** Model the receiving Runtime needs: `prompt` refuses to run without one. */
export function modelRef(session: RemoteSession | undefined): RemoteModelRef | undefined {
  const id = session?.model?.id, providerID = session?.model?.providerID;
  if (!id || !providerID) return undefined;
  return { providerID, modelID: id, variant: session?.model?.variant ?? null };
}

export function newestSession(device: RemoteDevice | undefined): RemoteSession | undefined {
  const sessions = device?.overview?.sessions ?? [];
  return [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
}

/** Send a request into an existing remote session. */
export async function sendToSession(device: string, session: RemoteSession, text: string, id?: string) {
  const model = modelRef(session);
  if (!model) throw new Error("У сессии получателя не записана модель — выберите другую сессию или создайте новую.");
  const command = id ?? crypto.randomUUID();
  const card = await request<RemoteCommandCard>("remote/command", {
    id: command, device, session: session.id, kind: "prompt", payload: { text, model },
  });
  return { id: command, card };
}

/** Create a session on the receiving device and start it with the request. */
export async function createRemoteSession(device: string, directory: string, text: string, model?: RemoteModelRef, id?: string) {
  if (!directory.trim()) throw new Error("Выберите папку проекта на устройстве получателя.");
  const command = id ?? crypto.randomUUID();
  const card = await request<RemoteCommandCard>("remote/command", {
    id: command, device, session: null, kind: "session.create",
    payload: { directory, prompt: text, ...(model ? { model } : {}) },
  });
  return { id: command, card };
}

/** Stage text in a remote chat without starting its agent. */
export async function pasteToSession(device: string, session: RemoteSession, text: string, id?: string) {
  const command = id ?? crypto.randomUUID();
  const card = await request<RemoteCommandCard>("remote/command", {
    id: command, device, session: session.id, kind: "paste", payload: { text },
  });
  return { id: command, card };
}

/** Deliveries staged for one chat: the receiving Runtime acknowledged them and
 * the Hub still holds the result, so the shell can append them to the draft. */
export async function stagedPastes(device: string, session: string): Promise<{ id: string; text: string }[]> {
  const value = await request<{ commands?: { id: string; kind: string; state: string; result?: { text?: string } | null }[] }>(
    `remote/session?device=${encodeURIComponent(device)}&session=${encodeURIComponent(session)}`);
  return (value.commands ?? [])
    .filter(c => c.kind === "paste" && c.state === "done" && typeof c.result?.text === "string" && c.result.text.trim())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(c => ({ id: c.id, text: String(c.result!.text) }));
}
