import { InformationDialog } from "./InformationDialog";
import { useState } from "react";
import { store, useAppState } from "../state/store";
import { FloatingPopover } from "./FloatingPopover";
import { Icon } from "./Icon";
import { pathBasename } from "../util/paths";

export function ProjectActions({ directory }: { directory: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [information, setInformation] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const name = pathBasename(directory);
  return <>
    <button className="project-menu icon-btn" aria-label={`Действия проекта ${name}`} title="Действия проекта" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><Icon name="dots" size={16} /></button>
    {anchor && <FloatingPopover anchor={anchor} className="task-popover" role="menu" label="Действия проекта" width={235} placement="bottom" align="end" onClose={() => setAnchor(null)}>
      <button onClick={() => { setAnchor(null); void store.setDirectory(directory); }}>Новый чат</button>
      <button onClick={() => { setAnchor(null); setInformation(true); }}>Сведения</button>
      <button onClick={() => { setAnchor(null); setConfirm(true); }}>Убрать проект из списка…</button>
    </FloatingPopover>}
    {information && <InformationDialog directory={directory} onClose={() => setInformation(false)} />}
    {confirm && <div className="modal-overlay" onKeyDown={(e) => { if (e.key === "Escape") setConfirm(false); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Убрать проект из списка">
        <h3>Убрать «{name}» из списка?</h3>
        <p>Папка и история сессий сохранятся. Выполняющиеся задачи продолжат работу. Вернуть проект можно через «Убранные проекты».</p>
        <p className="project-path">{directory}</p>
        <div className="btn-row"><button className="btn" autoFocus onClick={() => setConfirm(false)}>Отмена</button><button className="btn primary" onClick={() => { store.removeProject(directory); setConfirm(false); }}>Убрать проект</button></div>
      </div>
    </div>}
  </>;
}

export function RemovedProjects() {
  const s = useAppState();
  const [open, setOpen] = useState(false);
  const dirs = s.prefs.hiddenProjects ?? [];
  if (!dirs.length) return null;
  return <>
    <button className="show-more" onClick={() => setOpen(true)}>Убранные проекты ({dirs.length})</button>
    {open && <div className="modal-overlay" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <div className="modal removed-projects" role="dialog" aria-modal="true" aria-label="Убранные проекты">
        <h3>Убранные проекты</h3>
        <p>Папки и чаты не удаляются и остаются в среде выполнения Enki. Восстановление возвращает их в боковую панель.</p>
        <div className="removed-list">{dirs.map((dir) => <div className="removed-row" key={dir}>
          <span><b>{pathBasename(dir)}</b><small className="project-path">{dir}</small></span>
          <button className="btn small" onClick={() => { if (dirs.length === 1) setOpen(false); store.restoreProject(dir); }}>Вернуть</button>
        </div>)}</div>
        <div className="btn-row"><button className="btn" autoFocus onClick={() => setOpen(false)}>Закрыть</button></div>
      </div>
    </div>}
  </>;
}
