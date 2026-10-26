import { Fragment, useEffect, useRef, useState } from "react";
import { FloatingPopover } from "./FloatingPopover";
import { Icon } from "./Icon";
export function SelectMenu({
  label,
  className,
  icon,
  value,
  options,
  onChange,
  disabled = false,
  onRefresh,
  refreshing = false,
  refreshError,
  fallbackLabel,
}: {
  label: string;
  fallbackLabel?: string;
  className?: string;
  icon?: string;
  value: string;
  options: {
    value: string;
    label: string;
    detail?: string;
    section?: string;
    /** Shown but not selectable; `detail` explains why. */
    disabled?: boolean;
    /** DeepSeek peak-hours hint: tints the row and shows the countdown. */
    peak?: { note: string };
  }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<"first" | "last" | null>(null);
  useEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const rows = popup?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)");
    const target = initialFocus.current
      ? rows?.[initialFocus.current === "last" ? rows.length - 1 : 0]
      : popup?.querySelector<HTMLElement>('input, [role=option][aria-selected=true]:not(:disabled)') ?? rows?.[0];
    (target ?? popup?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    initialFocus.current = null;
  }, [open]);
  const selected = options.find((o) => o.value === value);
  const filtered = options.filter((o) =>
    (o.label + " " + (o.detail ?? "") + " " + (o.section ?? ""))
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const sections = [...new Set(filtered.map(o => o.section))];
  return (
    <div
      className={`select-menu ${className ?? ""}`}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          e.stopPropagation();
          ref.current?.querySelector("button")?.focus();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [
            ...(popupRef.current?.querySelectorAll<HTMLButtonElement>(
              "[role=option]:not(:disabled)",
            ) ?? []),
          ];
          const i = rows.indexOf(document.activeElement as HTMLButtonElement);
          if (!open) { initialFocus.current = e.key === "ArrowDown" ? "first" : "last"; setQuery(""); setOpen(true); return; }
          rows[i < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) :
            (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="select-trigger"
        aria-label={label}
        aria-haspopup={onRefresh ? "dialog" : "listbox"}
        aria-expanded={open}
        title={selected ? [selected.label, selected.detail].filter(Boolean).join(" · ") : fallbackLabel || value || label}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setQuery("");
        }}
      >
        {icon && <Icon name={icon} size={16}/>}
        <span>
          {selected?.label ?? fallbackLabel ?? (value || label)}
        </span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <FloatingPopover anchor={buttonRef.current} contentRef={popupRef}
          className="select-popover" role={onRefresh ? "dialog" : "listbox"} label={label}
          width={options.some((o) => o.detail) ? 360 : 240}
          onClose={() => setOpen(false)}>
          {options.length > 8 && (
            <input
              autoFocus
              placeholder="Поиск…"
              aria-label={`Поиск: ${label}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="select-options" role={onRefresh ? "listbox" : undefined} aria-label={onRefresh ? label : undefined}>
            {sections.map(section => {
              const rows = filtered.filter(o => o.section === section).map((o) => (
              <button
                role="option"
                className={o.peak ? "select-option-peak" : undefined}
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                disabled={o.disabled}
                key={o.value}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  setOpen(false);
                  ref.current?.querySelector("button")?.focus();
                }}
              >
                <span>
                  {o.label}
                  {o.detail && <small>{o.detail}</small>}
                  {o.peak && <small className="select-option-peak-note">дорого · {o.peak.note}</small>}
                </span>
                {o.value === value && <Icon name="check" size={15} />}
              </button>
              ));
              return section ? <div key={section} role="group" aria-label={section} className="select-section">
                <div className="select-section-title" aria-hidden="true">{section}</div>{rows}
              </div> : <Fragment key="ungrouped">{rows}</Fragment>;
            })}
          </div>
          {!filtered.length && <div className="select-empty" role={refreshError ? undefined : "status"}>
            <span>{query.trim() ? "Ничего не найдено. Измените запрос." : refreshing ? "Загружаем доступные модели…" : onRefresh ? "Доступных моделей пока нет. Обновите список или проверьте подключения в настройках." : "Нет доступных вариантов."}</span>
            {query.trim() && <button type="button" className="btn small ghost" onClick={() => { setQuery(""); popupRef.current?.querySelector("input")?.focus(); }}>Сбросить поиск</button>}
          </div>}
          {onRefresh && <div className="select-refresh">
            <button type="button" disabled={refreshing} onClick={onRefresh}>
              <Icon name="refresh" size={14}/>{refreshing ? "Обновление…" : "Обновить список"}
            </button>
            {refreshError && <small role="status">{refreshError}</small>}
          </div>}
        </FloatingPopover>
      )}
    </div>
  );
}
