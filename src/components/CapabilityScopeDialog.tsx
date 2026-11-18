import { useEffect } from "react";
import { CapabilitiesSettings } from "./CapabilitiesSettings";
import { Icon } from "./Icon";

/** Project/session-scoped capability editor. The full registry editor is reused
 * so there is one validation/CAS path; this wrapper only narrows its scope. */
export function CapabilityScopeDialog({
  title,
  scope,
  directory,
  session,
  onClose,
}: {
  title: string;
  scope: "project" | "session";
  directory: string;
  session?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal capability-scope-modal" role="dialog" aria-modal="true" aria-label={title}>
      <header className="settings-page-header capability-scope-head">
        <div><h2>{title}</h2><p>Наследование: общий уровень → проект → эта сессия. Отключённые здесь MCP и навыки не попадут в контекст.</p></div>
        <button className="icon-btn" aria-label="Закрыть настройки инструментов" onClick={onClose}><Icon name="close" size={16}/></button>
      </header>
      <CapabilitiesSettings initialScope={scope} directoryOverride={directory} sessionOverride={session ?? null}/>
    </div>
  </div>;
}
