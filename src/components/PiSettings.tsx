import { SettingHelp } from "./SettingHelp";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { store, useAppState, errText } from "../state/store";
import { RUNTIME_CAPABILITIES } from "../agent/runtime/backend";
import type { ConfigStatusDTO, PackageStatusDTO, ResourcePathStatusDTO, ResourceStatusDTO, RuntimeSettingsDTO } from "../agent/runtime/client";
import type { CapabilitiesDTO, ModelRef } from "../../src-tauri/resources/agent/src/protocol";
import { isAbsoluteLocalPath } from "../util/paths";

/** Sanitized import state (no paths/values) in owner language. */
export function configSummary(status: ConfigStatusDTO | null, defaults: { model: ModelRef | null; code: string | null } | null): string {
  if (!status) return "Состояние неизвестно";
  if (status.pendingRestart) return "Перенесено · применится после перезапуска Enki";
  const state = status.state === "ready" ? "Перенесено и действует" : status.state === "shadowed" ? "Перенесено, но перекрыто собственными настройками Enki"
    : status.state === "blocked" ? `Перенос заблокирован${status.code ? ` (${status.code})` : ""}` : "Не переносились";
  const model = defaults?.model ? ` · модель по умолчанию: ${defaults.model.providerID}/${defaults.model.modelID}`
    : defaults?.code ? " · модель по умолчанию недоступна в каталоге" : "";
  return state + model;
}
export function configImportError(error: unknown): string {
  const text = errText(error);
  if (/CONFIG_SOURCE_UNCONFIGURED/.test(text)) return "Для этого профиля Enki не задан каталог прежних настроек Pi; ничего не прочитано.";
  if (/CONFIG_NATIVE_UNAVAILABLE/.test(text)) return "Перенос доступен только для Enki на этом компьютере с хранилищем ключей; файл auth.json не используется.";
  return text;
}
const DEFERRED: Record<string, string> = { extensions: "расширения", skills: "навыки", prompts: "шаблоны", themes: "темы", packages: "пакеты" };
/** `/settings/skills` → owner-language name of the not-activated imported key. */
export function deferredLabel(pointer: string): string {
  const key = pointer.split("/").filter(Boolean).pop() ?? pointer;
  return DEFERRED[key] ?? key;
}
function missing(status: ResourcePathStatusDTO[] | undefined, path: string): ReactNode {
  return status?.some((item) => item.path === path && !item.present) ? <b> · не найден, не загружается</b> : null;
}
/** What the runtime actually loads from one local package, and why not the rest. */
export function packageSummary(status: PackageStatusDTO | undefined): string {
  if (!status) return "состояние неизвестно";
  if (!status.present) return "не найден, не загружается";
  const parts = [["расширений", status.extensions], ["навыков", status.skills], ["шаблонов", status.prompts], ["тем", status.themes]] as const;
  const loaded = parts.filter(([, count]) => count > 0).map(([label, count]) => `${label}: ${count}`);
  return loaded.length ? loaded.join(", ") : "ресурсов не загружено";
}
function PackageDetails({ status }: { status?: PackageStatusDTO }) {
  return <>
    <small> · {packageSummary(status)}</small>
    {!!status?.diagnostics.length && <ul className="handoff-note" aria-label="Диагностика пакета">
      {status.diagnostics.map((line) => <li key={line}>{line}</li>)}</ul>}
  </>;
}
function ExplicitPaths({ title, description, placeholder, paths, status, disabled, onChange, detail }: {
  title: string; description: string; placeholder: string; paths: string[]; status?: ResourcePathStatusDTO[]; disabled: boolean; onChange(paths: string[]): void;
  /** Extra per-path status (local packages); default: only "missing". */
  detail?(path: string): ReactNode;
}) {
  const [value, setValue] = useState("");
  const path = value.trim();
  return <>
    <Row title={title} description={description}>
      <input aria-label={title} spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn" disabled={disabled || !isAbsoluteLocalPath(path) || paths.includes(path) || paths.length >= 64}
        onClick={() => { onChange([...paths, path]); setValue(""); }}>Добавить</button>
    </Row>
    {paths.map(item => <div className="kv" key={item}><span>{item}{detail ? detail(item) : missing(status, item)}</span>
      <button className="btn" disabled={disabled} onClick={() => onChange(paths.filter(x => x !== item))}>Убрать</button></div>)}
  </>;
}
function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <div className="setting-field-heading"><span>{title}</span><SettingHelp topic={`pi:${title}`} title={title} description={description}/></div>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
function Group({ title, children, hidden }: { title: string; children: ReactNode; hidden?: boolean }) {
  return (
    <section className="setting-group" aria-label={title} hidden={hidden}>
      <h2>{title}</h2>
      <div className="setting-card">{children}</div>
    </section>
  );
}

/**
 * Settings of the single executing agent: the bundled Enki Runtime (Pi SDK) of
 * this computer or of the selected SSH host. Nothing here starts a process; the
 * former Pi CLI / Node program paths no longer exist.
 */
export function PiSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const s = useAppState();
  const [tab, setTab] = useState("runtime");
  const prefs = s.prefs.pi ?? {};
  const connected = s.connection.phase === "connected";
  const backendForRender = store.maybeBackend();
  const workspace = s.prefs.workspaceKey ?? s.prefs.endpoint;
  const runtimeScope = useRef({ backend: backendForRender, workspace, connected });
  if (runtimeScope.current.backend !== backendForRender || runtimeScope.current.workspace !== workspace || runtimeScope.current.connected !== connected)
    runtimeScope.current = { backend: backendForRender, workspace, connected };
  const captureRuntime = () => {
    const scope = runtimeScope.current;
    return { backend: scope.backend, current: () => runtimeScope.current === scope && scope.backend === store.maybeBackend() };
  };
  const [runtime, setRuntime] = useState<RuntimeSettingsDTO | null>(null);
  const [caps, setCaps] = useState<CapabilitiesDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lsp, setLsp] = useState<{ servers: string[]; missing: string[] } | null>(null);
  const [access, setAccess] = useState<{ ok: boolean; detail: string } | null>(null);
  const [checkingModel, setCheckingModel] = useState("");
  const [custom, setCustom] = useState(prefs.customModel ?? "");
  const [extension, setExtension] = useState("");
  const [serverPath, setServerPath] = useState("");
  const [gitProgram, setGitProgram] = useState("");
  const dirty = custom !== (prefs.customModel ?? "") || !!extension || !!serverPath || (runtime !== null && gitProgram !== (runtime.gitProgram ?? ""));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const [resources, setResources] = useState<ResourceStatusDTO | null>(null);
  const [config, setConfig] = useState<{ status: ConfigStatusDTO | null; defaults: { model: ModelRef | null; code: string | null } | null }>({ status: null, defaults: null });
  const load = async () => {
    const { backend, current } = captureRuntime();
    if (!current()) return;
    if (!backend || !connected) { setRuntime(null); setCaps(null); setResources(null); setBusy(false); setConfig({ status: null, defaults: null }); return; }
    setBusy(true); setError("");
    try {
      const [settings, capabilities] = await Promise.all([backend.client.settings(), backend.client.capabilities()]);
      // Optional on older runtimes: absence is shown as "unknown", never as "none".
      const [status, defaults, paths] = await Promise.all([
        Promise.resolve().then(() => backend.client.configStatus()).catch(() => null),
        Promise.resolve().then(() => backend.client.configDefaults()).catch(() => null),
        Promise.resolve().then(() => backend.client.resourceStatus()).catch(() => null),
      ]);
      if (!current()) return;
      setRuntime(settings); setCaps(capabilities); setGitProgram(settings.gitProgram ?? ""); setConfig({ status, defaults }); setResources(paths);
    } catch (e) { if (current()) setError(errText(e)); }
    finally { if (current()) setBusy(false); }
  };
  /** Explicit owner action; the runtime refuses (501) when this profile has no Pi source. */
  const importConfig = async () => {
    const { backend, current } = captureRuntime();
    if (!backend || !current() || store.currentHost()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await backend.client.importPiAgent();
      if (!current()) return;
      const status = await backend.client.configStatus().catch(() => null);
      if (!current()) return;
      setConfig(current => ({ ...current, status }));
      setNotice(status?.pendingRestart ? "Настройки Pi перенесены в хранилище Enki. Они применятся после перезапуска Enki." : "Настройки Pi перенесены.");
    } catch (e) { if (current()) setError(configImportError(e)); }
    finally { if (current()) setBusy(false); }
  };
  useEffect(() => { void load(); }, [connected, workspace, backendForRender]);
  // `runtime.settings` from the connected runtime (any window or client) replaces the shown values.
  useEffect(() => store.onRuntimeSettings(settings => setRuntime(current => current ? settings : current)), []);

  /** Runtime-owned settings: the runtime validates, persists and announces them. */
  const save = async (patch: Partial<RuntimeSettingsDTO>, done = "Сохранено. Новые сессии агента получат изменения.") => {
    const { backend, current } = captureRuntime();
    if (!backend || !current()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const settings = await backend.client.saveSettings(patch);
      if (!current()) return;
      setRuntime(settings); setNotice(done);
      // Path lists changed: show which of them actually exist on the runtime host.
      if (patch.extensionPaths || patch.skillPaths || patch.promptPaths || patch.packagePaths) {
        const paths = await Promise.resolve().then(() => backend.client.resourceStatus()).catch(() => null);
        if (current()) setResources(paths);
      }
    }
    catch (e) { if (current()) setError(errText(e)); }
    finally { if (current()) setBusy(false); }
  };
  const checkModel = async (id: string) => {
    setBusy(true); setCheckingModel(id); setAccess(null);
    try { setAccess(await store.checkPiModelAccess(id)); }
    finally { setCheckingModel(""); setBusy(false); }
  };
  const options = store.piModelOptions();
  const extensions = runtime?.extensionPaths ?? [];
  const lspInstalled = (prefs.extensions ?? []).some(path => path.endsWith("lsp-extension.ts")) || prefs.lspEnabled === true;
  // An older runtime without the field followed only its config file (= on).
  const lspOn = runtime ? runtime.lspEnabled !== false : prefs.lspEnabled !== false;

  return (
    <section className="pi-settings" aria-label="Агент Enki">
      <nav className="settings-agent-tabs" aria-label="Настройки агента">{[
        ["runtime", "Среда выполнения"], ["models", "Модели"], ["extensions", "Расширения и LSP"], ["capabilities", "Возможности"],
      ].map(([id, title]) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{title}</button>)}</nav>

      <Group title="Среда выполнения" hidden={tab !== "runtime"}>
        <Row title="Состояние" description="Встроенная среда выполнения запускается вместе с Enki; для SSH-хоста — установленная там среда. Отдельный агент не устанавливается.">
          <span>{connected ? `Подключена · ${s.connection.version ?? ""} · ${store.hostLabel()}` : "Не подключена"}</span>
        </Row>
        <Row title="Доступ к инструментам по умолчанию" description="Для чатов без своих правил. «Спрашивать» — безопасное значение: без ответа действие отклоняется. Явные запреты чата действуют всегда.">
          <select aria-label="Доступ к инструментам по умолчанию" disabled={!runtime || busy} value={runtime?.defaultPolicy ?? "ask"}
            onChange={(e) => { const value = e.target.value; void save({ defaultPolicy: value === "full" ? "full" : value === "read" ? "read" : "ask" }); }}>
            <option value="ask">Спрашивать подтверждение</option>
            <option value="read">Только чтение</option>
            <option value="full">Полный доступ без запроса</option>
          </select>
        </Row>
        <Row title="Сжатие контекста" description="Агент сжимает старую часть истории, когда контекст модели заполняется.">
          <label className="switch-label">
            <input type="checkbox" disabled={!runtime || busy} checked={runtime?.compaction.enabled ?? true}
              onChange={(e) => runtime && void save({ compaction: { ...runtime.compaction, enabled: e.target.checked } })} />
            <span>{runtime?.compaction.enabled === false ? "Выключено" : "Включено"}</span>
          </label>
        </Row>
        <Row title="Путь к Git" description="Абсолютный путь на компьютере среды выполнения. Пусто — искать автоматически.">
          <input aria-label="Путь к Git" spellCheck={false} disabled={!runtime} placeholder="/usr/bin/git" value={gitProgram} onChange={(e) => setGitProgram(e.target.value)} />
        </Row>
        <div className="btn-row">
          <button className="btn" disabled={!runtime || busy || gitProgram === (runtime?.gitProgram ?? "") || (!!gitProgram.trim() && !isAbsoluteLocalPath(gitProgram.trim()))}
            onClick={() => void save({ gitProgram: gitProgram.trim() || null })}>Сохранить путь</button>
          <button className="btn" disabled={busy || !connected} onClick={() => void load()}>Обновить</button>
        </div>
      </Group>

      <Group title="Модели" hidden={tab !== "models"}>
        <Row title="Выбранная модель" description="Настроенная модель — ещё не доступ. Проверка отправляет один минимальный запрос через среду выполнения.">
          <span>{access ? `${access.ok ? "Подтверждён" : "Не подтверждён"} · ${access.detail}` : prefs.verifiedModel ? `Подтверждён ранее: ${prefs.verifiedModel}` : "Не проверялся"}</span>
          <button className="btn" disabled={busy || !connected || !store.getModelChoice()} onClick={() => { const choice = store.getModelChoice(); if (choice) void checkModel(`${choice.providerID}/${choice.modelID}`); }}>Проверить</button>
        </Row>
        <Row title="Настройки прежнего Pi" description="Однократный явный перенос models.json и ключей из каталога прежнего Pi в хранилище Enki. Исходные файлы не изменяются; применяется после перезапуска Enki.">
          <span>{configSummary(config.status, config.defaults)}</span>
          <button className="btn" disabled={busy || !connected || !!store.currentHost() || !!config.status?.pendingRestart} onClick={() => void importConfig()}>Перенести</button>
        </Row>
        <Row title="Свой идентификатор модели" description="provider/model — для моделей вне встроенного каталога.">
          <input aria-label="Свой идентификатор модели" spellCheck={false} placeholder="deepseek/deepseek-flash" value={custom}
            onChange={(e) => setCustom(e.target.value)} onBlur={() => store.setPiCustomModel(custom)} />
          {custom.trim() && <button className="btn" disabled={busy || !connected || !/^[^/]+\/.+/.test(custom.trim())}
            onClick={() => { store.setPiCustomModel(custom); void checkModel(custom.trim()); }}>{checkingModel === custom.trim() ? "Проверка…" : "Проверить"}</button>}
        </Row>
        {options.length ? <div className="pi-model-list">{options.map(m => {
          const id = `${m.providerID}/${m.modelID}`;
          return <div className="kv" key={id}><span>{m.label}<small>{m.providerID}</small></span>
            <button className="btn" disabled={busy || !connected} onClick={() => void checkModel(id)}>
              {checkingModel === id ? "Проверка…" : m.verified ? "Проверена · повторить" : "Проверить"}</button></div>;
        })}</div> : <p className="handoff-note">{connected ? "Среда выполнения не сообщила моделей. Добавьте провайдера в разделе «Модели (Hub)» или ключ API." : "Нет подключения к среде выполнения."}</p>}
      </Group>

      <Group title="Расширения и LSP" hidden={tab !== "extensions"}>
        <Row title="Расширения агента" description="Абсолютные пути к расширениям Pi на компьютере среды выполнения. Их интерфейсы (виджеты, диалоги, собственные экраны и редактор) показываются над полем ввода чата.">
          <span>{extensions.length ? `${extensions.length} шт.` : "Нет"}</span>
        </Row>
        <Row title="Добавить расширение" description="Абсолютный путь к .ts/.js файлу расширения.">
          <input aria-label="Путь к расширению" spellCheck={false} placeholder="/home/user/.pi/agent/extensions/my.ts" value={extension} onChange={(e) => setExtension(e.target.value)} />
          <button className="btn" disabled={!runtime || busy || !isAbsoluteLocalPath(extension.trim())} onClick={() => {
            const path = extension.trim();
            if (!extensions.includes(path)) void save({ extensionPaths: [...extensions, path] });
            setExtension("");
          }}>Добавить</button>
        </Row>
        {extensions.map(path => <div className="kv" key={path}><span>{path}{missing(resources?.extensions, path)}</span>
          <button className="btn" disabled={busy} onClick={() => void save({ extensionPaths: extensions.filter(x => x !== path) })}>Убрать</button></div>)}
        <ExplicitPaths title="Навыки" description="Абсолютные пути к файлам или каталогам навыков Pi на компьютере среды выполнения. Загружаются только указанные здесь и включённые в общем каталоге; ничего не ищется автоматически."
          placeholder="/home/user/.pi/agent/skills/my-skill" paths={runtime?.skillPaths ?? []} status={resources?.skills} disabled={!runtime || busy || runtime.skillPaths === undefined}
          onChange={(skillPaths) => void save({ skillPaths })} />
        <ExplicitPaths title="Шаблоны запросов" description="Абсолютные пути к файлам или каталогам шаблонов Pi (prompt templates) на компьютере среды выполнения."
          placeholder="/home/user/.pi/agent/prompts" paths={runtime?.promptPaths ?? []} status={resources?.prompts} disabled={!runtime || busy || runtime.promptPaths === undefined}
          onChange={(promptPaths) => void save({ promptPaths })} />
        <ExplicitPaths title="Пакеты Pi" description="Абсолютный путь к локальной папке пакета Pi на компьютере среды выполнения (package.json с полем pi или папки extensions/skills/prompts/themes). Пакеты подключаются только из выбранной локальной папки; npm/git-пакеты не скачиваются и не устанавливаются. Расширения пакета — доверенный код: он выполняется с правами агента, поэтому добавляйте только пакеты, которым доверяете. Ссылки за пределы папки пакета, шаблоны путей и файлы .gitignore не поддерживаются — такие записи не загружаются и показываются ниже. При совпадении имён ресурс пакета важнее навыка или шаблона, указанного выше отдельно (как в Pi)."
          placeholder="/home/user/pi-packages/my-package" paths={runtime?.packagePaths ?? []} disabled={!runtime || busy || runtime.packagePaths === undefined}
          onChange={(packagePaths) => void save({ packagePaths })}
          detail={(path) => <PackageDetails status={resources?.packages?.find((item) => item.path === path)} />} />
        {!!resources?.deferred.length && <p className="handoff-note">
          Из настроек прежнего Pi не включены автоматически: {resources.deferred.map(deferredLabel).join(", ")}. Добавьте нужные расширения, навыки и шаблоны явно выше.
          Пакеты Pi (npm/git) Enki не скачивает и не устанавливает: укажите локальную папку уже установленного пакета в разделе «Пакеты Pi».</p>}
        <Row title="Языковые серверы (LSP)" description="Собственное расширение Enki без фоновых демонов; находит установленные серверы на этом компьютере.">
          <label className="switch-label">
            {/* Runtime-owned switch of the connected host; the legacy UI pref is only a one-time migration input. */}
            <input type="checkbox" aria-label="Языковые серверы (LSP)" disabled={!lspInstalled || !runtime || busy || !!store.currentHost()} checked={lspInstalled && lspOn}
              onChange={(e) => void save({ lspEnabled: e.target.checked }, e.target.checked ? "Языковые серверы включены для новых чатов." : "Языковые серверы выключены для новых чатов.")} />
            <span>{!lspInstalled ? "Не настроено" : store.currentHost() ? "Только на этом компьютере" : lspOn ? "Включено" : "Выключено"}</span>
          </label>
          <button className="btn" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try { setLsp(await store.setupPiLsp()); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
            // Setup also enables the runtime switch; show the runtime's own value.
            void load();
          }}>Настроить LSP</button>
        </Row>
        {lsp && <>
          {lsp.servers.map(line => <div className="kv" key={line}><span>{line}</span><b>готов</b></div>)}
          {lsp.missing.length > 0 && <p className="handoff-note">Не найдены серверы: {lsp.missing.join(", ")}. Установите их сами и повторите.</p>}
        </>}
        <Row title="Путь к языковому серверу" description="Абсолютный путь, пробуется раньше встроенных (приложение из Finder не наследует PATH).">
          <input aria-label="Путь к языковому серверу" spellCheck={false} placeholder="/opt/homebrew/bin/rust-analyzer" value={serverPath} onChange={(e) => setServerPath(e.target.value)} />
          <button className="btn" disabled={!isAbsoluteLocalPath(serverPath.trim())} onClick={() => {
            const path = serverPath.trim(), current = prefs.lspServerPaths ?? [];
            if (!current.includes(path)) store.setPiSettings({ lspServerPaths: [...current, path] });
            setServerPath("");
          }}>Добавить путь</button>
        </Row>
        {(prefs.lspServerPaths ?? []).map(path => <div className="kv" key={path}><span>{path}</span>
          <button className="btn" onClick={() => store.setPiSettings({ lspServerPaths: (prefs.lspServerPaths ?? []).filter(x => x !== path) })}>Убрать</button></div>)}
      </Group>

      <Group title="Возможности" hidden={tab !== "capabilities"}>
        <div className="kv"><span>Вложения</span><b>{RUNTIME_CAPABILITIES.attachments ? "Изображения и подготовленные файлы" : "Нет"}</b></div>
        <div className="kv"><span>Сжатие контекста</span><b>{RUNTIME_CAPABILITIES.compaction ? "Есть" : "Нет"}</b></div>
        <div className="kv"><span>Вопросы агента</span><b>{caps ? caps.questions ? "Есть" : "Нет в этой версии среды" : "—"}</b></div>
        <div className="kv"><span>Интерфейсы расширений</span><b>{caps ? caps.extensionUi.tui ? "Экраны, редактор, виджеты и диалоги" : "Только диалоги и уведомления" : "—"}</b></div>
        <div className="kv"><span>Терминал</span><b>{caps ? caps.pty ? "Есть" : "Недоступен в этой сборке" : "—"}</b></div>
      </Group>

      {busy && <p role="status">Обращаюсь к среде выполнения…</p>}
      {notice && <p role="status" className="settings-notice">{notice}</p>}
      {error && <p className="composer-error" role="alert">{error}</p>}
    </section>
  );
}
