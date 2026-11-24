// Delivered text ("просто переслать") must appear in the receiving chat's input
// field without starting the agent. The receiving Runtime acknowledged the staged
// paste and the Hub keeps it, so the shell drains it here: append once, remember
// the command id, never send it.
import { useEffect, useRef } from "react";
import { store, useAppState } from "../state/store";
import { request } from "../hub/client";
import { stagedPastes } from "../hub/remote";
import { draftKey } from "../state/prefs";

const ownDevice = async (): Promise<string | null> => {
  try {
    const status = await request<{ device?: string }>("workshop/status");
    return status.device ?? null;
  } catch { return null; }
};

export function RemotePasteInbox() {
  const s = useAppState();
  const session = s.activeSessionId;
  const directory = s.directory;
  const busy = useRef(false);

  useEffect(() => {
    if (!session || !directory) return;
    let cancelled = false;
    const drain = async () => {
      if (busy.current || cancelled) return;
      busy.current = true;
      try {
        const device = await ownDevice();
        if (!device || cancelled) return;
        const pending = (await stagedPastes(device, session))
          .filter(item => !store.state.prefs.pastesSeen.includes(item.id));
        if (!pending.length || cancelled) return;
        const key = draftKey(session, directory);
        const current = store.state.prefs.drafts[key] ?? "";
        // The person may have typed meanwhile: never overwrite, only append.
        const merged = pending.map(item => item.text.trim()).reduce((text, next) => text ? `${text}\n\n${next}` : next, current);
        store.setDraftFor(session, directory, merged);
        store.markRemotePastes(pending.map(item => item.id));
      } catch { /* An unavailable Hub must not disturb the open chat. */ }
      finally { busy.current = false; }
    };
    void drain();
    const timer = setInterval(() => { if (!document.hidden) void drain(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session, directory]);

  return null;
}
