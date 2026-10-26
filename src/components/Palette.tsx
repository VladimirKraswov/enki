import { useEffect, useRef, useState } from "react";
import { store, useAppState } from "../state/store";
import { Icon } from "./Icon";
import { pickFolder } from "./Sidebar";
import { pathBasename } from "../util/paths";
export function Palette() {
  const s = useAppState(),
    [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const prior = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    const active = document.activeElement;
    if ((!active || active === document.body || panel.current?.contains(active)) && prior.current?.isConnected) prior.current.focus({ preventScroll: true });
  }, []);
  if (!s.ui.paletteOpen) return null;
  const close = () => store.setUi({ paletteOpen: false });
  const q = query.trim().toLowerCase();
  const actions = [
    { name: "Новый чат", icon: "new", run: () => store.newSession() },
    { name: "Открыть папку", icon: "folder", run: () => pickFolder() },
    {
      name: "Терминал",
      icon: "terminal",
      run: () => store.toggleTerminal(),
    },
    {
      name: "Изменения и файлы",
      icon: "panel",
      run: () => store.setLayout({ rightOpen: !s.prefs.layout.rightOpen }),
    },
    {
      name: "Настройки",
      icon: "settings",
      run: () => store.setUi({ settingsOpen: true }),
    },
    ...(s.activeSessionId
      ? [
          {
            name: "Сжать контекст задачи",
            icon: "archive",
            run: () => store.compactSession(s.activeSessionId!),
          },
        ]
      : []),
  ];
  const dirs = store.projectDirectories();
  const rows = [
    ...actions.map((a) => ({ ...a, detail: "Действие" })),
    ...dirs.map((dir) => ({
      name: pathBasename(dir),
      detail: dir,
      icon: "folder",
      run: () => store.setDirectory(dir, { restoreSession: true }),
    })),
    ...s.sessions.map((x) => ({
      name: x.title,
      detail: "Задача",
      icon: "chat",
      run: () => store.selectSession(x.id),
    })),
  ]
    .filter((x) => (x.name + " " + x.detail).toLowerCase().includes(q))
    .slice(0, 40);
  return (
    <div
      className="modal-overlay palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
        if (e.key === "Tab") {
          const items = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
          if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items[items.length - 1]?.focus(); }
          else if (!e.shiftKey && document.activeElement === items[items.length - 1]) { e.preventDefault(); items[0]?.focus(); }
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const el = e.currentTarget;
          const items = [
            ...el.querySelectorAll<HTMLButtonElement>(".palette-row"),
          ];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          items[
            i < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
          ]?.focus();
        }
      }}
    >
      <div
        className="palette"
        ref={panel}
        role="dialog"
        aria-label="Поиск и команды"
        aria-modal="true"
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="Поиск задач, проектов и команд"
            placeholder="Поиск задач, проектов и команд…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rows[0]) {
                close();
                void rows[0].run();
              }
            }}
          />
          <button aria-label="Закрыть поиск" onClick={close}>
            <kbd>esc</kbd>
          </button>
        </div>
        <div className="palette-results">
          {rows.map((a, i) => (
            <button
              className="palette-row"
              key={i}
              onClick={() => {
                close();
                void a.run();
              }}
            >
              <Icon name={a.icon} />
              <span>
                {a.name}
                <small>{a.detail}</small>
              </span>
              <span className="spacer" />
              <span className="faint">↵</span>
            </button>
          ))}
          {rows.length === 0 && <p className="empty-hint">Ничего не найдено</p>}
        </div>
        <div className="palette-footer">
          ↑ ↓ Выбрать <span>↵ Открыть</span>
        </div>
      </div>
    </div>
  );
}
