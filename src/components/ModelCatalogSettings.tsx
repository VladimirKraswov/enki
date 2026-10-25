// Настройки «Модели (Hub)»: общий каталог моделей хранится на Hub (там же, где
// обновления), а это устройство решает, применять ли каталог, какие модели
// исключить и когда перечитать модели среды выполнения. Локальные провайдеры
// пользователя при объединении не меняются.

import { useEffect, useState } from "react";
import { SettingHelp } from "./SettingHelp";
import { store, useAppState } from "../state/store";
import {
  hubModelsState,
  type HubCatalog,
  type HubModel,
} from "../models/catalog";
import {
  applyCatalog,
  fetchCatalog,
  publishCatalog,
  type CatalogRefreshError,
} from "../hub/modelCatalog";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

/** The sole Enki 2.0 runtime applies only the Pi entry; OpenCode is optional 0.2.x compatibility. */
export const PI_REQUIRED = "Нужна запись Pi (providerId и provider): только её применяет среда выполнения Enki 2.0. Блок OpenCode необязателен и нужен лишь ещё не обновлённым клиентам Enki 0.2.x.";

/** A new catalog entry: Pi only (no OpenCode executable or provider is required). */
export function newCatalogModel(index: number): HubModel {
  return {
    id: `model-${index}`,
    label: "Новая модель",
    pi: {
      providerId: `local-model-${index}`,
      provider: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "local", models: [] },
    },
  };
}

const parseJson = (text: string, title: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${title}: JSON не разобран (${String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${title}: нужен объект`);
  return parsed as Record<string, unknown>;
};

function ModelDraft({
  model,
  index,
  onChange,
  onRemove,
}: {
  model: HubModel;
  index: number;
  onChange: (next: HubModel) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const ocText = model.opencode ? pretty(model.opencode.provider) : "";
  const piText = model.pi ? pretty(model.pi.provider) : "";
  const [draft, setDraft] = useState({
    id: model.id,
    label: model.label,
    note: model.note ?? "",
    opencodeId: model.opencode?.providerId ?? "",
    opencodeProvider: ocText,
    piId: model.pi?.providerId ?? "",
    piProvider: piText,
    controlService: model.control?.service ?? "",
    controlBindings: model.control ? pretty(model.control.bindings) : "",
  });
  const save = () => {
    try {
      if (!MODEL_ID.test(draft.id.trim()))
        throw new Error("id модели: строчные латинские буквы, цифры, ._- (с буквы/цифры)");
      if (!draft.label.trim()) throw new Error("Нужно название модели");
      const next: HubModel = {
        id: draft.id.trim(),
        label: draft.label.trim(),
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      };
      if (draft.opencodeId.trim() || draft.opencodeProvider.trim()) {
        if (!PROVIDER_ID.test(draft.opencodeId.trim()))
          throw new Error("providerId OpenCode (совместимость 0.2.x): без пробелов, до 64 символов");
        next.opencode = {
          providerId: draft.opencodeId.trim(),
          provider: parseJson(draft.opencodeProvider, "provider OpenCode"),
        };
      }
      if (draft.piId.trim() || draft.piProvider.trim()) {
        if (!PROVIDER_ID.test(draft.piId.trim()))
          throw new Error("providerId Pi: без пробелов, до 64 символов");
        next.pi = {
          providerId: draft.piId.trim(),
          provider: parseJson(draft.piProvider, "provider Pi"),
        };
      }
      if (!next.pi) throw new Error(PI_REQUIRED);
      if (draft.controlService.trim() || draft.controlBindings.trim()) {
        if (!MODEL_ID.test(draft.controlService.trim())) throw new Error("Некорректный id сервиса Hub");
        const bindings = parseJson(draft.controlBindings, "Привязки сервиса Hub");
        if (!Object.keys(bindings).length || Object.entries(bindings).some(([key, value]) =>
          !MODEL_ID.test(key) || typeof value !== "string" || !MODEL_ID.test(value))) throw new Error("Привязки: JSON-объект идентификаторов моделей");
        next.control = {service: draft.controlService.trim(), bindings: bindings as Record<string, string>};
      } else if (model.control) next.control = null;
      onChange(next);
      setError("");
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section className="setting-group" aria-label={model.id}>
      <h2>{model.label}</h2>
      <div className="setting-card">
        <div className="setting-row">
          <div className="setting-label">
            <span>{model.id}</span>
            <small>
              {model.pi
                ? [`Pi: ${model.pi.providerId}`, model.opencode ? `совместимость 0.2.x (OpenCode): ${model.opencode.providerId}` : null]
                  .filter(Boolean).join(" · ")
                : "Нет записи Pi — Enki 2.0 эту модель не применяет"}
            </small>
            {model.note ? <small>{model.note}</small> : null}
          </div>
          <div className="setting-control">
            <button className="btn" onClick={() => setOpen(!open)}>
              {open ? "Свернуть" : "Изменить"}
            </button>
            <button className="btn" onClick={onRemove}>
              Удалить
            </button>
          </div>
        </div>
        {open ? (
          <>
            {(
              [
                ["id модели", "id", "artemis31-v100"],
                ["Название", "label", "Artemis 31B v1.2 · Q4_0 MTP · 196k (V100)"],
                ["Заметка", "note", "Что важно владельцу каталога"],
                ["Сервис управления Hub", "controlService", "v100"],
              ] as const
            ).map(([title, key, placeholder]) => (
              <div className="setting-row" key={key}>
                <div className="setting-label">
                  <label htmlFor={`catalog-${index}-${key}`}>{title}</label>
                  {key === "controlService" && <SettingHelp topic={title} description="Идентификатор сервиса в конфигурации Hub, например v100. Hub знает адрес VM и ключ управления; клиенту они не нужны. Пустое поле оставляет модель без управления через Hub."/>}
                </div>
                <div className="setting-control">
                  <input
                    id={`catalog-${index}-${key}`}
                    value={draft[key]}
                    placeholder={placeholder}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  />
                </div>
              </div>
            ))}
            {(
              [
                ["providerId Pi", "piId", "local-artemis", "Обязательно: эту запись применяет среда выполнения Enki."],
                ["provider Pi (JSON)", "piProvider", pretty({ baseUrl: "http://127.0.0.1:18008/v1", api: "openai-completions", apiKey: "local", models: [] }), "Обязательно: адрес и модели для среды выполнения Enki."],
                ["Привязки сервиса Hub (JSON)", "controlBindings", pretty({"artemis31-v100": "artemis31-v100"}), "Пусто — модель без управления через Hub."],
                ["providerId OpenCode (совместимость 0.2.x)", "opencodeId", "local-artemis", "Необязательно: только для ещё не обновлённых клиентов Enki 0.2.x; Enki 2.0 не запускает OpenCode и эту запись не применяет."],
                ["provider OpenCode (JSON, совместимость 0.2.x)", "opencodeProvider", pretty({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:18021/v1", apiKey: "local" }, models: {} }), "Необязательно: пусто — клиенты 0.2.x эту модель не получат."],
              ] as const
            ).map(([title, key, placeholder, hint]) => (
              <div className="setting-row" key={key}>
                <div className="setting-label">
                  <label htmlFor={`catalog-${index}-${key}`}>{title}</label>
                  {key === "controlBindings" && <SettingHelp topic={title} description="JSON-объект: идентификатор модели в каталоге Pi → точный идентификатор в реестре сервиса. Каждая настроенная модель должна иметь привязку. Hub проверяет её перед загрузкой; названия моделей для маршрутизации не используются."/>}
                  <small>{hint}</small>
                </div>
                <div className="setting-control">
                  <textarea
                    id={`catalog-${index}-${key}`}
                    rows={key.includes("Provider") ? 8 : key === "controlBindings" ? 4 : 1}
                    className={key.includes("Provider") || key === "controlBindings" ? "catalog-json" : undefined}
                    value={draft[key]}
                    placeholder={placeholder}
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  />
                </div>
              </div>
            ))}
            {error ? <p role="alert" className="composer-error">{error}</p> : null}
            <div className="setting-row">
              <div className="setting-label" />
              <div className="setting-control">
                <button className="btn primary" onClick={save}>
                  Сохранить в черновике
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

export function ModelCatalogSettings() {
  const { prefs } = useAppState();
  const state = hubModelsState(prefs);
  const [catalog, setCatalog] = useState<HubCatalog | null>(null);
  const [models, setModels] = useState<HubModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchCatalog();
      setCatalog(result);
      setModels(structuredClone(result.models ?? []));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const busySession = [...Object.values(store.state.activityStatuses), ...Object.values(store.state.statuses)].some(
    (status) => status.type === "busy" || status.type === "retry",
  );
  const dirty =
    JSON.stringify(models) !== JSON.stringify(catalog?.models ?? []);
  const apply = async () => {
    if (!catalog) return;
    if (busySession) {
      setError("Дождитесь завершения работающего агента перед применением каталога.");
      return;
    }
    if (!state.enabled) {
      setError("Включите «Применять на этом устройстве», чтобы каталог писался в настройки моделей среды выполнения.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { report, appliedOpencode, appliedPi } = await applyCatalog(catalog, state, { client: store.client, remote: !!store.currentHost() });
      store.setHubModels({
        ...state,
        appliedVersion: catalog.version,
        appliedOpencode,
        appliedPi,
      });
      const parts: string[] = [];
      if (report.added.length) parts.push(`добавлены: ${report.added.join(", ")}`);
      if (report.replaced.length) parts.push(`обновлены: ${report.replaced.join(", ")}`);
      if (report.removed.length) parts.push(`удалены: ${report.removed.join(", ")}`);
      setNotice(
        parts.length
          ? `Каталог v${catalog.version} применён — ${parts.join("; ")}. Среда выполнения перечитала список моделей.`
          : `Каталог v${catalog.version} уже соответствует локальным настройкам.`,
      );
    } catch (failure) {
      // CatalogRefreshError: the file was committed. Record ownership (not the
      // version, so Apply stays offered) so a later removal can still remove them.
      const owned = (failure as Partial<CatalogRefreshError> | null)?.appliedPi;
      if (Array.isArray(owned)) store.setHubModels({ ...state, appliedOpencode: [], appliedPi: owned });
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await publishCatalog(models, adminKey, catalog?.version);
      setAdminKey("");
      // The acknowledged CAS response is this publication. A second GET could
      // lose the acknowledgement or replace this draft with another editor's.
      setCatalog(saved);
      setModels(structuredClone(saved.models));
      setNotice(`Каталог опубликован на Hub (версия ${saved.version}).`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  /** The runtime re-reads its model configuration; running turns are not interrupted. */
  const restart = async () => {
    setBusy(true);
    setError("");
    try {
      await store.refreshModelCatalog();
      setNotice("Каталог моделей среды выполнения обновлён. Новые запросы используют обновлённые модели.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const toggleExcluded = (id: string) =>
    store.setHubModels({
      ...state,
      excluded: state.excluded.includes(id)
        ? state.excluded.filter((item) => item !== id)
        : [...state.excluded, id],
    });
  return (
    <fieldset className="catalog-controls" disabled={busy || loading}>
      <section className="setting-group">
        <h2>Общий каталог моделей</h2>
        <div className="setting-card">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-field-heading">
                <label htmlFor="hub-catalog-apply">Применять на этом устройстве</label>
                <SettingHelp topic="Каталог моделей Hub" />
              </div>
              <small>
                {catalog
                  ? catalog.version
                    ? `Версия ${catalog.version}${catalog.updatedBy ? ` · ${catalog.updatedBy}` : ""}`
                    : "Каталог на Hub ещё не опубликован"
                  : loading
                    ? "Загрузка…"
                    : "Не загружен"}
              </small>
              <small>
                Локальные провайдеры и выбранные модели остаются на устройстве; каталог
                меняет только провайдеры, которые он публиковал раньше.
              </small>
            </div>
            <div className="setting-control">
              <input
                id="hub-catalog-apply"
                type="checkbox"
                checked={state.enabled}
                onChange={(e) => store.setHubModels({ ...state, enabled: e.target.checked })}
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <span>Состояние</span>
              <small>
                {state.appliedVersion
                  ? `Локально применена версия ${state.appliedVersion}`
                  : "Каталог ещё не применялся на этом устройстве"}
              </small>
            </div>
            <div className="setting-control">
              <button className="btn" disabled={loading || busy} onClick={() => void load()}>
                Обновить с Hub
              </button>
              <button
                className="btn primary"
                disabled={busy || loading || !catalog || catalog.version === 0}
                title={state.enabled ? undefined : "Сначала включите «Применять на этом устройстве»"}
                onClick={() => void apply()}
              >
                Применить на этом устройстве
              </button>
              <button className="btn" disabled={busy} onClick={() => void restart()}>
                Обновить модели
              </button>
            </div>
          </div>
          {error ? <p role="alert" className="composer-error">{error}</p> : null}
          {notice ? <p role="status" className="settings-notice">{notice}</p> : null}
        </div>
      </section>
      {models.map((model, index) => (
        <div key={`${catalog?.version ?? 0}:${model.id}-${index}`}>
          <ModelDraft
            model={model}
            index={index}
            onChange={(next) => setModels(models.map((m, i) => (i === index ? next : m)))}
            onRemove={() => setModels(models.filter((_, i) => i !== index))}
          />
          {state.excluded.includes(model.id) ? (
            <p role="status" className="settings-notice">Модель исключена на этом устройстве.</p>
          ) : null}
          <div className="setting-card">
            <div className="setting-row">
              <div className="setting-label">
                <label htmlFor={`catalog-exclude-${model.id}`}>Использовать на этом устройстве</label>
              </div>
              <div className="setting-control">
                <input
                  id={`catalog-exclude-${model.id}`}
                  type="checkbox"
                  checked={!state.excluded.includes(model.id)}
                  onChange={() => toggleExcluded(model.id)}
                />
              </div>
            </div>
          </div>
        </div>
      ))}
      <section className="setting-group">
        <h2>Публикация</h2>
        <div className="setting-card">
          <div className="setting-row">
            <div className="setting-label">
              <label htmlFor="hub-catalog-admin">Административный ключ Hub</label>
              <small>Нужен только для записи каталога; при доступном системном хранилище сохраняется в нём.</small>
            </div>
            <div className="setting-control">
              <input
                id="hub-catalog-admin"
                type="password"
                autoComplete="off"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <span>Черновик каталога</span>
              <small>
                {dirty
                  ? "Есть несохранённые на Hub правки"
                  : "Совпадает с опубликованной версией"}
              </small>
            </div>
            <div className="setting-control">
              <button
                className="btn"
                disabled={busy}
                // Pi only: an OpenCode block for 0.2.x clients may be added by hand.
                onClick={() => setModels([...models, newCatalogModel(models.length + 1)])}
              >
                Добавить модель
              </button>
              <button className="btn primary" disabled={busy || loading || !catalog || !dirty} onClick={() => void publish()}>
                Опубликовать на Hub
              </button>
            </div>
          </div>
        </div>
      </section>
    </fieldset>
  );
}
