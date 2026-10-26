import { SettingHelp } from "./SettingHelp";
import { BrowserEnvironmentSettings } from "./BrowserEnvironmentSettings";
import { BrowserPerformance } from "./BrowserPerformance";
import { useEffect, useState } from "react";
import { browserNative, openSessionBrowser, browserSetupSnapshot, useBrowserSetup, type BrowserSetup, type BrowserStatus } from "../browser/integration";
import { browserEnabled, browserNodeProgram } from "../browser/preferences";
import { isLocalComputer } from "../state/computer";
import { Icon } from "./Icon";
import { isNative } from "../native/platform";
import { store, useAppState } from "../state/store";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const IN_PROGRESS: BrowserSetup["phase"][] = ["checking", "installing", "configuring"];

function setupSummary(setup: BrowserSetup, enabled: boolean): string {
  switch (setup.phase) {
    case "checking": return "Проверка инструментария браузера…";
    case "installing": return "Установка Playwright и Chromium выполняется в фоне…";
    case "configuring": return "Подключение инструментов к среде выполнения…";
    case "ready": return "Инструменты готовы";
    case "error": return "Настройка не завершена";
    case "disabled": return "Управление браузером выключено";
    default: return enabled ? "Настройка при запуске приложения" : "Управление браузером выключено";
  }
}

export function BrowserSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const app = useAppState(), setup = useBrowserSetup();
  const [status, setStatus] = useState<BrowserStatus | undefined>(setup.status);
  const [node, setNode] = useState(app.prefs.browser?.nodeProgram ?? "");
  const [url, setUrl] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [environmentDirty, setEnvironmentDirty] = useState(false);
  const dirty = environmentDirty || node !== (app.prefs.browser?.nodeProgram ?? "");
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const enabled = browserEnabled(app.prefs);
  const nodeProgram = browserNodeProgram(app.prefs);
  const native = isNative(), local = isLocalComputer(app.prefs.endpoint, !!store.currentHost());
  const configuring = IN_PROGRESS.includes(setup.phase);
  async function refresh() {
    if (!native) return;
    setStatus(await browserNative<BrowserStatus>("browser_status", { nodeProgram }));
    setError("");
  }
  useEffect(() => { setStatus(setup.status); }, [setup.status]);
  useEffect(() => { void refresh().catch(error => setError(message(error))); }, []);
  const action = async (command: "browser_open" | "browser_stop") => {
    setBusy(true); setError("");
    const current = () => store.state.activeSessionId === app.activeSessionId && store.state.directory === app.directory && store.state.prefs.endpoint === app.prefs.endpoint;
    try {
      // Disable first, so a setup job cancelled by this stop is already
      // superseded and cannot report the cancellation as a setup error.
      if (command === "browser_stop") store.setBrowserSettings({ enabled: false });
      const value = command === "browser_open" ? await openSessionBrowser({directory:app.directory, engine:store.engineIdFor(), sessionId:app.activeSessionId},current,url.trim() || null,nodeProgram)
        : await browserNative<BrowserStatus>(command);
      if (!current()) return;
      setStatus(value);
      if (command === "browser_open") store.setUi({ browserOpen: true, settingsOpen: false });
    } catch (error) { if (current()) setError(message(error)); }
    finally { setBusy(false); }
  };
  return <>

    {!native && <p role="status">Откройте установленное приложение, чтобы настроить браузер.</p>}
    {!local && <p role="status">Управляемый браузер работает только со средой выполнения на этом компьютере. Для настройки выберите «Этот компьютер».</p>}
    <section className="setting-group" aria-label="Настройка браузера"><h2>Подключение</h2><div className="setting-card">
      <div className="setting-row"><div className="setting-label"><span>Браузер агента</span><SettingHelp topic="browser.enabled" title="Браузер агента"/></div><div className="setting-control"><label className="switch-label"><input type="checkbox" aria-label="Браузер агента" checked={enabled} disabled={!native || !local || busy} onChange={event => store.setBrowserSettings({ enabled: event.target.checked })}/><span>{enabled ? "Включён" : "Выключен"}</span></label></div></div>
      <div className="setting-row"><div className="setting-label"><label htmlFor="browser-mode">Режим работы</label><SettingHelp topic="browser.mode" title="Режим работы"/></div><div className="setting-control"><select id="browser-mode" value={app.prefs.browser?.mode ?? "fast"} disabled={!native || !local || !enabled || busy || configuring} onChange={event => {
        const mode = event.target.value as "fast" | "human";
        setBusy(true); setError("");
        void browserNative("browser_input", { action: "mode", args: { mode } }).then(() => store.setBrowserSettings({ mode })).catch(e => setError(message(e))).finally(() => setBusy(false));
      }}><option value="fast">Быстрый</option><option value="human">Полная эмуляция</option></select></div></div>
      <div className="setting-row"><div className="setting-label"><span>Инструментарий</span></div><div className="setting-control"><span>{setup.phase === "installing" ? "Установка Playwright и Chromium…" : status?.installed ? `Playwright MCP ${status.version ?? ""}` : "Ещё не установлен"}</span></div></div>
      <div className="setting-row"><div className="setting-label"><span>Агент</span></div><div className="setting-control"><span>{setup.agent}</span></div></div>
      <div className="setting-row"><div className="setting-label"><span>Разрешения на действия</span><SettingHelp topic="browser.permissions" title="Разрешения на действия"/></div><div className="setting-control"><span>Доступ чата в Enki</span></div></div>
      <div className="settings-actions"><span className="settings-muted" role="status">{setupSummary(setup, enabled)}</span><button className="btn" disabled={!native || !local || busy || configuring} onClick={() => { setError(""); void store.configureBrowser(true); }}>Настроить и проверить</button></div>
    </div></section>
    <BrowserEnvironmentSettings disabled={!native || !local || busy || configuring} running={!!status?.running} onDirtyChange={setEnvironmentDirty}/>
    <section className="setting-group" aria-label="Панель браузера"><h2>Панель браузера</h2><div className="setting-card">
      <div className="setting-row engine-field-row"><div className="setting-label"><label htmlFor="browser-address">Адрес страницы</label><SettingHelp topic="browser.address" title="Адрес страницы"/></div><div className="setting-control"><input id="browser-address" type="url" value={url} placeholder="https://example.com" onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && native && local && enabled && status?.installed && !busy && !configuring) void action("browser_open"); }}/></div></div>
      <div className="setting-row"><div className="setting-label"><span>Состояние</span></div><div className="setting-control"><span>{status?.browserOpen ? "Браузер открыт в Enki" : status?.running ? "Сервис готов; страница откроется по запросу" : "Остановлен"}</span></div></div>
      <div className="setting-row"><div className="setting-label"><span>Отдельный профиль</span><SettingHelp topic="browser.profile" title="Отдельный профиль"/></div><div className="setting-control"><span className="settings-path">{status?.profilePath ?? "—"}</span></div></div>
      <div className="settings-actions"><button className="btn primary" disabled={!native || !local || !enabled || !status?.installed || busy || configuring} onClick={() => void action("browser_open")}>Открыть браузер</button><button className="btn" disabled={!native || busy || (!status?.running && !configuring)} title={configuring ? "Останавливает и отменяет текущую установку или запуск" : undefined} onClick={() => void action("browser_stop")}>Остановить управление</button><button className="btn" disabled={!native || busy} onClick={() => void refresh().catch(error => setError(message(error)))}>Обновить состояние</button></div>
    </div></section>
    <section className="setting-group" aria-label="Среда браузера"><h2>Среда</h2><div className="setting-card">
      <div className="setting-row engine-field-row"><div className="setting-label"><label htmlFor="browser-node">Путь к Node.js</label><SettingHelp topic="browser.node" title="Путь к Node.js"/></div><div className="setting-control"><input id="browser-node" value={node} placeholder={status?.nodeProgram ?? "Автоматически"} spellCheck={false} onChange={event => setNode(event.target.value)}/></div></div>
      <div className="settings-actions"><button className="btn" disabled={!native || !local || configuring} onClick={() => store.setBrowserSettings({ nodeProgram: node.trim() || undefined })}>Сохранить и проверить путь</button><button className="btn" onClick={() => void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl("https://nodejs.org/en/download"))}>Установить Node.js…</button></div>
    </div></section>
    <BrowserPerformance />
    {(error || setup.error || status?.error) && <p className="settings-inline-error" role="alert">{error || setup.error || status?.error}</p>}
  </>;
}

function browserButtonTitle(local: boolean, native: boolean, enabled: boolean, phase: BrowserSetup["phase"]): string {
  if (!native) return "Браузер агента доступен в установленном приложении";
  if (!local) return "Браузер агента работает только на этом компьютере";
  if (!enabled) return "Браузер агента выключен в настройках";
  if (IN_PROGRESS.includes(phase)) return "Настройка браузера выполняется; окно откроется после её завершения";
  return "Открыть встроенную панель браузера агента";
}

export function BrowserButton({ compact = false }: { compact?: boolean } = {}) {
  const app = useAppState(), setup = useBrowserSetup();
  const [busy, setBusy] = useState(false);
  const native = isNative(), local = isLocalComputer(app.prefs.endpoint, !!store.currentHost());
  const enabled = browserEnabled(app.prefs);
  return <button className="icon-btn browser-button" aria-label="Открыть браузер агента" title={browserButtonTitle(local, native, enabled, setup.phase)} disabled={busy || !local || !native || !enabled} onClick={() => {
    setBusy(true);
    let sessionId = app.activeSessionId;
    let directory = app.directory;
    const engine = store.engineIdFor();
    const current = () => store.state.activeSessionId === sessionId && store.state.directory === directory
      && store.state.prefs.endpoint === app.prefs.endpoint && store.engineIdFor() === engine
      && store.state.prefs.workspaceKey === app.prefs.workspaceKey;
    // A failed setup is retried from scratch: clicking again after fixing
    // Node.js or the network must not replay the cached failure.
    void (async () => {
      // The toolbar is available before the first model turn. Browser sessions
      // are scoped to a real agent session, so materialize an empty one instead
      // of making the user send a prompt just to reveal Chromium.
      if (!sessionId) {
        if (!directory) {
          if (!await store.ensureChatWorkspace()) throw new Error("Не удалось подготовить чат для браузера.");
          directory = store.state.directory;
        }
        if (!directory) throw new Error("Не выбрана рабочая папка для браузера.");
        const created = await store.createSessionNow("Браузер");
        if (!created) throw new Error("Не удалось создать чат для браузера.");
        sessionId = created.id;
        directory = created.directory;
        if (!current()) throw new Error("Выбран другой чат; браузер не открыт.");
      }
      // Reveal the side panel as soon as this browser has a real session scope.
      // Runtime setup may still be downloading/attaching tools; that must not
      // make the toolbar appear to do nothing while the user waits.
      store.setUi({ browserOpen: true });
      await store.configureBrowser(browserSetupSnapshot().phase === "error");
      const setup = browserSetupSnapshot();
      if (setup.phase === "error") throw new Error(setup.error || "Инструменты браузера не подключены.");
      await openSessionBrowser({directory, engine, sessionId},current,null,browserNodeProgram(app.prefs));
      if (current()) store.setUi({ browserOpen: true });
    })().catch(error => { if (current()) store.setUi({ toast: `Браузер: ${message(error)}` }); }).finally(() => setBusy(false));
  }}><Icon name="browser" size={17}/>{!compact && <span>{busy ? "Открываю…" : "Браузер"}</span>}</button>;
}
