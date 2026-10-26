import { useEffect, useState, type ReactNode } from "react";

/** Keep the live chat mounted while the context rail enters and leaves. */
export function ChatWorkspace({ open, panel, children }: { open: boolean; panel: ReactNode; children: ReactNode }) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) { setRetained(true); return; }
    const timer = setTimeout(() => setRetained(false), 240);
    return () => clearTimeout(timer);
  }, [open]);
  return <div className={`chat-workspace${open ? " context-open" : ""}`}>
    <div className="chat-col">{children}</div>
    <div className="chat-context-slot" inert={!open} aria-hidden={!open || undefined}>
      {(open || retained) && panel}
    </div>
  </div>;
}
