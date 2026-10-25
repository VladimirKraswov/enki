import { SettingField } from "./SettingHelp";
import { useEffect, useRef, useState } from "react";
import { store, useAppState } from "../state/store";
import { isLocalComputer } from "../state/computer";
import { isNative } from "../native/platform";
import {
  capabilityNative,
  invalidateCapabilities,
} from "../capabilities/integration";
import {
  runtimeServerState,
  serverName,
  validateServer,
  type Catalog,
  type Registry,
  type Scope,
  type SharedServer,
  type Skill,
} from "../capabilities/registry";
import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
const blankServer = (): SharedServer => ({
  id: "",
  name: "",
  enabled: true,
  kind: "stdio",
  command: "",
  args: [],
  url: "",
  envKeys: [],
  bearer: false,
});
/**
 * What the runtime does with a catalog skill. Workers load only the explicit
 * `skillPaths` of enabled registry sources (no ambient SDK discovery) and do
 * not report which skills they loaded, so nothing here claims "found by agent".
 */
export function skillAgentState(skill: Pick<Skill, "managed" | "enabled" | "engines">): string {
  if (!skill.engines.includes(RUNTIME_AGENT_ID)) return "Другой агент";
  if (!skill.managed) return "Не загружается: каталог не подключён как источник";
  if (!skill.enabled) return "Выключен источник; проверьте сессию";
  return "Не проверено";
}
/** What actually happened to open chats after a confirmed registry commit. */
export function registryNotice(refreshed: { reopened: number; pending: number } | null): string {
  if (!refreshed)
    return "Сохранено в реестре. Новые чаты этого компьютера получат изменения; уже открытые сохраняют прежний набор до переоткрытия.";
  const parts = ["Сохранено в реестре. Новые чаты получат изменения сразу."];
  if (refreshed.reopened) parts.push(`Открытых чатов обновлено: ${refreshed.reopened}.`);
  if (refreshed.pending) parts.push(`Обновятся после завершения текущей работы: ${refreshed.pending}.`);
  return parts.join(" ");
}
export function CapabilitiesSettings({
  onDirtyChange,
  onNavigate,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onNavigate?: (section: "browser" | "pi") => void;
}) {
  const app = useAppState(),
    [scope, setScope] = useState<Scope>("global"),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [sourceId, setSourceId] = useState(""),
    [sourcePath, setSourcePath] = useState(""),
    [server, setServer] = useState(blankServer),
    [args, setArgs] = useState("[]"),
    [env, setEnv] = useState(""),
    [token, setToken] = useState("");
  // MCP status comes from the worker's reports; skills see skillAgentState.
  const [piRunning, setPiRunning] = useState(false),
    [probes, setProbes] = useState<Record<string, string[]>>({});
  const generation = useRef(0),
    local = isLocalComputer(app.prefs.endpoint, !!store.currentHost()),
    directory = scope === "project" ? app.directory : null;
  const running =
    Object.values({ ...app.statuses, ...app.activityStatuses }).some(
      (s) => s.type === "busy" || s.type === "retry",
    ) || app.ui.sending;
  const dirty = !!sourceId || !!sourcePath || !!server.id || !!token;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const refresh = async () => {
    const serial = ++generation.current;
    setError("");
    setBusy(true);
    setCatalog(null);
    setPiRunning(false);
    try {
      const value = await capabilityNative<Catalog>("shared_catalog", {
        scope,
        directory,
      });
      if (serial !== generation.current) return;
      setCatalog(value);
      const backend = store.maybeBackend(), sessionId = app.activeSessionId;
      if (backend && app.directory && sessionId) {
        // Live workers of this folder; the MCP state itself arrives as worker reports.
        const report = await backend.client.extensions(app.directory).catch(() => null);
        if (serial !== generation.current) return;
        setPiRunning(!!report?.sessions.some((entry) => entry.sessionID === sessionId));
      }
    } catch {
      if (serial === generation.current)
        setError(
          "Каталог не прочитан. Проверьте локальный проект и состояние приложения.",
        );
    } finally {
      if (serial === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSourceId("");
    setSourcePath("");
    setServer(blankServer());
    setArgs("[]");
    setEnv("");
    setToken("");
    setNotice("");
    setProbes({});
    if (local && isNative() && (scope === "global" || directory))
      void refresh();
    else {
      generation.current++;
      setCatalog(null);
    }
    return () => {
      generation.current++;
    };
  }, [
    scope,
    directory,
    app.directory,
    app.activeSessionId,
    app.prefs.endpoint,
    local,
  ]);
  const save = async (registry: Registry) => {
    if (!catalog || running || busy) return;
    const serial = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await capabilityNative<Catalog>("shared_save", {
        scope,
        directory,
        expected: catalog.content,
        registry,
      });
      if (serial !== generation.current) return;
      setCatalog(saved);
      invalidateCapabilities();
      // The commit is confirmed: ask THIS computer's runtime to refresh (idle
      // chats reopen, busy ones after their current work; nothing is replayed).
      const refreshed = app.connection.phase === "connected"
        ? await store.capabilitiesCommitted(scope === "global" ? null : directory ?? null).catch(() => null)
        : null;
      if (serial !== generation.current) return;
      setNotice(registryNotice(refreshed));
      setSourceId("");
      setSourcePath("");
      setServer(blankServer());
      setToken("");
      setArgs("[]");
      setEnv("");
      setProbes({});
    } catch (e) {
      if (serial === generation.current)
        setError(
          `Настройка не завершена: ${e instanceof Error ? e.message : String(e)}. Сохранённый реестр можно перечитать и повторно подключить.`,
        );
    } finally {
      if (serial === generation.current) setBusy(false);
    }
  };
  const servers = catalog
    ? [
        ...catalog.inherited.servers.map((s) => ({ ...s, inherited: true })),
        ...catalog.registry.servers.map((s) => ({ ...s, inherited: false })),
      ]
    : [];
  const sources = catalog
    ? [
        ...catalog.inherited.sources.map((s) => ({ ...s, inherited: true })),
        ...catalog.registry.sources.map((s) => ({ ...s, inherited: false })),
      ]
    : [];
  const skills = catalog?.skills ?? [];
  const sourceFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        directory: true,
        multiple: false,
        title: "Каталог общих навыков",
      });
      if (typeof path === "string") setSourcePath(path);
    } catch {
      setError("Не удалось выбрать каталог. Можно указать абсолютный путь.");
    }
  };
  const act = async (fn: () => Promise<void>) => {
    const serial = generation.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (serial === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (serial === generation.current) setBusy(false);
    }
  };
  const editable = !!catalog && !busy && !running;
  return (
    <div className="capabilities-settings">

      {!local && (
        <p role="status">
          Общий каталог настраивается на этом компьютере. Среда выполнения на
          SSH-хосте не получает навыки и MCP этого компьютера.
        </p>
      )}
      {!isNative() && (
        <p>Управление доступно в установленном Enki.</p>
      )}
      <div className="settings-actions">
        <SettingField label="Область">{" "}<select
            aria-label="Область общего каталога"
            disabled={busy || dirty || !local}
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="global">Весь компьютер</option>
            <option value="project" disabled={!app.directory}>
              Этот проект
            </option>
          </select></SettingField>
        <button
          className="btn"
          disabled={busy || !local || !isNative() || dirty}
          onClick={() => void refresh()}
        >
          Обновить статус
        </button>
      </div>
      {running && (
        <p className="settings-muted">
          Сохранение подключений доступно после завершения работающих агентов.
        </p>
      )}
      {catalog && (
        <>
          <section className="setting-group">
            <h2>Общий инструментарий</h2>
            <div className="setting-card">
              <div className="setting-row">
                <div className="setting-label">
                  <span>MCP SDK</span>

                </div>
                <div className="setting-control">
                  <span>
                    {catalog.runtimeReady ? "Установлен" : "Не установлен"}
                  </span>
                  <button
                    className="btn"
                    disabled={!editable}
                    onClick={() =>
                      void act(async () => {
                        await capabilityNative("shared_install", {
                          nodeProgram:
                            app.prefs.pi?.nodeProgram ??
                            app.prefs.browser?.nodeProgram ??
                            null,
                        });
                        await refresh();
                      })
                    }
                  >
                    {catalog.runtimeReady
                      ? "Проверить мост"
                      : "Установить мост"}
                  </button>
                </div>
              </div>
            </div>
          </section>
          <section className="setting-group">
            <h2>Источники навыков</h2>
            <div className="setting-card">

              {sources.map((s) => (
                <div className="capability-item" key={`${s.inherited}:${s.id}`}>
                  <div>
                    <b>{s.id}</b>
                    <code>{s.path}</code>
                    <small>
                      {s.inherited
                        ? "Из общей области"
                        : "Источник этой области"}{" "}
                      ·{" "}
                      {catalog.sourceHealth?.[s.id] === false
                        ? "Каталог недоступен"
                        : "Каталог на диске"}
                    </small>
                  </div>
                  <SettingField label="Включён"><input
                      type="checkbox"
                      aria-label={`Источник ${s.id}`}
                      checked={s.enabled}
                      disabled={!editable || s.inherited}
                      onChange={(e) =>
                        void save({
                          ...catalog.registry,
                          sources: catalog.registry.sources.map((v) =>
                            v.id === s.id
                              ? { ...v, enabled: e.target.checked }
                              : v,
                          ),
                        })
                      }
                    /></SettingField>
                </div>
              ))}
              <div className="capability-form">
                <SettingField label="Идентификатор источника"><input
                    aria-label="Идентификатор источника"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    placeholder="my-skills"
                  /></SettingField>
                <SettingField label="Каталог навыков"><input
                    aria-label="Каталог навыков"
                    value={sourcePath}
                    onChange={(e) => setSourcePath(e.target.value)}
                    placeholder="Абсолютный путь"
                  /></SettingField>
                <div className="settings-actions">
                  <button
                    className="btn"
                    disabled={!editable}
                    onClick={() => void sourceFolder()}
                  >
                    Выбрать папку
                  </button>
                  <button
                    className="btn"
                    disabled={!editable || !sourceId || !sourcePath}
                    onClick={() => {
                      if (
                        !/^[a-z][a-z0-9-]{0,31}$/.test(sourceId) ||
                        sources.some((s) => s.id === sourceId)
                      ) {
                        setError(
                          "Нужен уникальный идентификатор: строчные латинские буквы, цифры и дефис.",
                        );
                        return;
                      }
                      void save({
                        ...catalog.registry,
                        sources: [
                          ...catalog.registry.sources,
                          { id: sourceId, path: sourcePath, enabled: true },
                        ],
                      });
                    }}
                  >
                    Подключить источник
                  </button>
                </div>
              </div>
            </div>
          </section>
          <section className="setting-group">
            <h2>Навыки</h2>
            <div className="setting-card">
              {catalog.scanLimited && (
                <p role="status" className="handoff-note">
                  Просмотр ограничен 3000 записями. Подключите более точные
                  каталоги навыков.
                </p>
              )}

              {!skills.length && (
                <p className="handoff-note">
                  Навыки в проверенных каталогах не найдены.
                </p>
              )}
              {skills.map((s, i) => (
                <article className="capability-skill" key={`${s.path}:${i}`}>
                  <b>{s.name}</b>
                  <p>{s.description}</p>
                  <code>{s.path}</code>
                  {s.error ? (
                    <p role="alert">{s.error}</p>
                  ) : (
                    <div className="capability-statuses">
                      <span>
                        Агент: {skillAgentState(s)}
                      </span>
                    </div>
                  )}
                  <small>
                    {s.managed
                      ? `Источник: ${s.source}`
                      : "Обнаружен на диске автоматически"}
                  </small>
                </article>
              ))}
            </div>
          </section>
          <section className="setting-group">
            <h2>Общие MCP-инструменты</h2>
            <div className="setting-card">

              {!servers.length && <p className="handoff-note">MCP не подключены.</p>}
              {servers.map((s) => (
                <article
                  className="capability-skill"
                  key={`${s.inherited}:${s.id}`}
                >
                  <div className="capability-item">
                    <b>{s.name}</b>
                    <SettingField label="Включён"><input
                        aria-label={`MCP ${s.id}`}
                        type="checkbox"
                        checked={s.enabled}
                        disabled={!editable || s.inherited}
                        onChange={(e) =>
                          void save({
                            ...catalog.registry,
                            servers: catalog.registry.servers.map((v) =>
                              v.id === s.id
                                ? { ...v, enabled: e.target.checked }
                                : v,
                            ),
                          })
                        }
                      /></SettingField>
                  </div>
                  <code>{s.kind === "http" ? s.url : s.command}</code>
                  <div className="capability-statuses">
                    <span>Агент: {runtimeServerState(s, store.mcpServerStatuses(app.activeSessionId), piRunning)}</span>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="btn"
                      disabled={
                        !editable || !s.enabled || !catalog.runtimeReady
                      }
                      onClick={() =>
                        void act(async () => {
                          const result = await capabilityNative<{
                            tools: { name: string }[];
                          }>("shared_probe", {
                            scope,
                            directory: app.directory,
                            id: s.id,
                            nodeProgram: app.prefs.pi?.nodeProgram ?? null,
                          });
                          setProbes((p) => ({
                            ...p,
                            [s.id]: result.tools.map((t) => t.name),
                          }));
                        })
                      }
                    >
                      Проверить MCP
                    </button>
                    <button
                      className="btn"
                      disabled={!editable || s.inherited}
                      onClick={() => {
                        setServer(s);
                        setArgs(JSON.stringify(s.args));
                        setEnv(s.envKeys.join(", "));
                        setToken("");
                      }}
                    >
                      Изменить
                    </button>
                  </div>
                  {probes[s.id] && (
                    <details>
                      <summary>
                        Сервис ответил · {probes[s.id].length} инструментов
                      </summary>
                      <ul>
                        {probes[s.id].map((t) => (
                          <li key={t}>
                            <code>{`${serverName(s.id)}_${t.replace(/-/g, "_")}`}</code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              ))}
              <div className="capability-form">
                <h3>
                  {catalog.registry.servers.some((s) => s.id === server.id)
                    ? "Изменение MCP"
                    : "Новое подключение"}
                </h3>
                <SettingField label="Идентификатор MCP"><input
                    aria-label="Идентификатор общего MCP"
                    value={server.id}
                    onChange={(e) =>
                      setServer({ ...server, id: e.target.value })
                    }
                    placeholder="project-search"
                  /></SettingField>
                <SettingField label="Название"><input
                    aria-label="Название общего MCP"
                    value={server.name}
                    onChange={(e) =>
                      setServer({ ...server, name: e.target.value })
                    }
                  /></SettingField>
                <SettingField label="Транспорт"><select
                    aria-label="Транспорт общего MCP"
                    value={server.kind}
                    onChange={(e) =>
                      setServer({
                        ...server,
                        kind: e.target.value as SharedServer["kind"],
                        bearer: false,
                      })
                    }
                  >
                    <option value="stdio">Локальная программа · stdio</option>
                    <option value="http">Streamable HTTP</option>
                  </select></SettingField>
                {server.kind === "stdio" ? (
                  <>
                    <SettingField label="Программа"><input
                        aria-label="Программа общего MCP"
                        value={server.command}
                        onChange={(e) =>
                          setServer({ ...server, command: e.target.value })
                        }
                        placeholder="Абсолютный путь к node / python / программе"
                      /></SettingField>
                    <SettingField label="Аргументы · JSON"><input
                        aria-label="Аргументы общего MCP"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        placeholder='["/path/server.mjs"]'
                      /></SettingField>
                    <SettingField label="Имена переменных окружения"><input
                        aria-label="Переменные общего MCP"
                        value={env}
                        onChange={(e) => setEnv(e.target.value)}
                        placeholder="API_KEY, CONFIG_PATH"
                      /><small>
                        Значения берутся из окружения запущенного Desktop; в
                        реестр не сохраняются.
                      </small></SettingField>
                  </>
                ) : (
                  <>
                    <SettingField label="URL"><input
                        aria-label="URL общего MCP"
                        value={server.url}
                        onChange={(e) =>
                          setServer({ ...server, url: e.target.value })
                        }
                        placeholder="https://service.example/mcp"
                      /></SettingField>
                    <SettingField label="Bearer-токен"><input
                        aria-label="Токен общего MCP"
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder={
                          server.bearer
                            ? "Сохранён в связке ключей; пусто — оставить"
                            : "Необязательно"
                        }
                      /><small>
                        Сохраняется в системной связке ключей; не передаётся в
                        URL или аргументах процесса.
                      </small></SettingField>
                    {server.bearer && (
                      <button
                        className="btn"
                        disabled={!editable}
                        onClick={() => {
                          setServer({ ...server, bearer: false });
                          setToken("");
                        }}
                      >
                        Убрать авторизацию при сохранении
                      </button>
                    )}
                  </>
                )}
                <div className="settings-actions">
                  <button
                    className="btn primary"
                    disabled={!editable || !server.id || !server.name}
                    onClick={() =>
                      void (async () => {
                        let parsed;
                        try {
                          parsed = JSON.parse(args);
                          if (
                            !Array.isArray(parsed) ||
                            parsed.some((v) => typeof v !== "string")
                          )
                            throw Error();
                        } catch {
                          setError(
                            "Аргументы должны быть JSON-массивом строк.",
                          );
                          return;
                        }
                        const spec = {
                          ...server,
                          authRevision: token
                            ? crypto.randomUUID()
                            : server.authRevision,
                          args: parsed,
                          envKeys: env
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean),
                          bearer:
                            server.kind === "http" &&
                            (server.bearer || !!token),
                        };
                        const problem = validateServer(spec);
                        if (problem) {
                          setError(problem);
                          return;
                        }
                        if (
                          catalog.inherited.servers.some(
                            (s) => s.id === spec.id,
                          )
                        ) {
                          setError("Этот идентификатор задан в общей области.");
                          return;
                        }
                        if (spec.kind === "http" && !spec.bearer) {
                          try {
                            await capabilityNative("shared_mcp_key", {
                              key: catalog.key,
                              id: spec.id,
                              value: null,
                            });
                          } catch {
                            setError(
                              "Не удалось удалить токен из связки ключей.",
                            );
                            return;
                          }
                        }
                        if (token) {
                          try {
                            await capabilityNative("shared_mcp_key", {
                              key: catalog.key,
                              id: spec.id,
                              value: token,
                            });
                            setToken("");
                            setServer(spec);
                          } catch {
                            setError(
                              "Не удалось сохранить токен в системной связке ключей.",
                            );
                            return;
                          }
                        }
                        void save({
                          ...catalog.registry,
                          servers: [
                            ...catalog.registry.servers.filter(
                              (s) => s.id !== spec.id,
                            ),
                            spec,
                          ],
                        });
                      })()
                    }
                  >
                    Сохранить и подключить
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setServer(blankServer());
                      setSourceId("");
                      setSourcePath("");
                      setToken("");
                      setArgs("[]");
                      setEnv("");
                    }}
                  >
                    Очистить форму
                  </button>
                </div>
              </div>
            </div>
          </section>
          <section className="setting-group">
            <h2>Возможности агентов</h2>
            <div className="setting-card">
              <article className="capability-skill">
                <b>Встроенный браузер · общий</b>

                <button className="btn" onClick={() => onNavigate?.("browser")}>
                  Настроить браузер
                </button>
              </article>
              <article className="capability-skill">
                <b>Инструменты агента</b>

                <button className="btn" onClick={() => onNavigate?.("pi")}>
                  Настроить агента
                </button>
              </article>
            </div>
          </section>
          <div className="settings-actions">
            <button
              className="btn"
              disabled={!editable}
              onClick={() =>
                void act(async () => {
                  // A check only re-reads state; it is not a commit, so no worker refresh.
                  invalidateCapabilities();
                  if (app.directory) await store.configureSharedTools();
                  await refresh();
                })
              }
            >
              Проверить подключения
            </button>
          </div>
        </>
      )}
      {busy && <p role="status">Проверяю каталог и подключения…</p>}
      {error && (
        <p role="alert" className="settings-inline-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
