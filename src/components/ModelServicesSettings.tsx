import { SettingHelp } from "./SettingHelp";
import { useState, useSyncExternalStore } from "react";
import { store, useAppState } from "../state/store";
import { modelServices, type ModelService } from "../models/services";

export function ModelServicesSettings() {
  const { prefs } = useAppState();
  const snapshot = useSyncExternalStore(
    modelServices.subscribe,
    modelServices.snapshot,
  );
  const [name, setName] = useState(""),
    [provider, setProvider] = useState(""),
    [endpoint, setEndpoint] = useState("http://127.0.0.1:18008");
  const [mapping, setMapping] = useState(""),
    [error, setError] = useState(""),
    [keys, setKeys] = useState<Record<string, string>>({});
  const services = prefs.modelServices ?? [];
  const add = () => {
    try {
      const bindings: Record<string, string> = {};
      for (const line of mapping.split("\n").filter((line) => line.trim())) {
        const pair = line.split("=").map((s) => s.trim());
        if (pair.length !== 2 || !pair[0] || !pair[1] || bindings[pair[0]])
          throw new Error(
            "Каждая строка: модель в агенте = модель в сервисе. Без повторов.",
          );
        bindings[pair[0]] = pair[1];
      }
      const service: ModelService = {
        id: name.trim(),
        providerID: provider.trim(),
        endpoint: endpoint.trim().replace(/\/$/, ""),
        bindings,
      };
      store.setModelServices([...services, service]);
      setName("");
      setMapping("");
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <section className="setting-group" aria-label="Координатор моделей Hub">
        <h2 className="setting-field-heading">Координатор моделей Hub <SettingHelp topic="Координатор моделей Hub" description="Общий сервис согласует загрузку моделей между устройствами. Модель резервируется на время задания, включая выполнение инструментов. Если другая модель на той же видеокарте занята, запрос ждёт. Разные видеокарты работают независимо. После потери связи резерв освобождается через 10 минут. Старые клиенты без координатора нужно обновить."/></h2>
        <div className="setting-card">
          <div className="setting-row"><div className="setting-label"><span>Общие модели</span>
            <small>Переключение и очередь между устройствами</small></div>
            <button className="btn" onClick={() => void modelServices.refreshHub().catch(e => setError(String(e)))}>Обновить</button></div>
          {modelServices.hubRoutes().map(route => <div className="setting-row" key={`${route.agent}/${route.providerID}/${route.modelID}`}>
            <div className="setting-label"><span>{route.label} · {route.agent === "pi" ? "Enki" : "Внешний клиент"}</span>
              <small>{route.providerID} / {route.modelID}</small></div>
          </div>)}
          {!modelServices.hubRoutes().length && <div className="setting-row">Нет привязок в каталоге Hub</div>}
        </div>
      </section>

      {services.map((service) => (
        <section
          key={service.id}
          className="setting-group"
          aria-label={service.id}
        >
          <h2>{service.id}</h2>
          <div className="setting-card">
            <div className="setting-row">
              <div className="setting-label">
                <span>{service.providerID}</span>
                <small>{service.endpoint}</small>
              </div>
              <div className="setting-control">
                <button
                  className="btn"
                  onClick={() =>
                    store.setModelServices(
                      services.filter((s) => s.id !== service.id),
                    )
                  }
                >
                  Удалить подключение
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label"><div className="setting-field-heading"><label htmlFor={`service-key-${service.id}`}>Ключ управления</label><SettingHelp topic="Ключ управления"/></div></div>
              <div className="setting-control">
                <input
                  id={`service-key-${service.id}`}
                  type="password"
                  autoComplete="off"
                  value={keys[service.id] ?? ""}
                  onChange={(e) =>
                    setKeys({ ...keys, [service.id]: e.target.value })
                  }
                />
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      if (keys[service.id]?.trim()) await modelServices.saveKey(service.id, keys[service.id]);
                      await modelServices.refresh(service.id);
                      setKeys({ ...keys, [service.id]: "" });
                      setError("");
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  }}
                >
                  Подключить и проверить
                </button>
                <button className="btn" onClick={async () => {
                  try { await modelServices.forgetKey(service.id); setError(""); }
                  catch (error) { setError(error instanceof Error ? error.message : String(error)); }
                }}>Забыть ключ</button>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <span>Привязки</span>
                {Object.entries(service.bindings).map(([local, remote]) => (
                  <small key={local}>
                    {local} → {remote}
                  </small>
                ))}
              </div>
              <div className="setting-control">
                <span>
                  {snapshot.errors[service.id] ??
                    snapshot.states[service.id]?.phase ??
                    (modelServices.catalogFor(service.id)
                      ? `Каталог получен · моделей: ${modelServices.catalogFor(service.id)!.length}`
                      : "Ожидает проверки")}
                </span>
              </div>
            </div>
          </div>
        </section>
      ))}
      <section className="setting-group">
        <h2>Добавить сервис</h2>
        <div className="setting-card">
          {(
            [
              ["Имя сервиса", name, setName],
              ["ID провайдера", provider, setProvider],
              ["Локальный адрес API", endpoint, setEndpoint],
            ] as const
          ).map(([label, value, update]) => (
            <div className="setting-row" key={label}>
              <div className="setting-label"><div className="setting-field-heading"><label htmlFor={label}>{label}</label><SettingHelp topic={label} title={label}/></div></div>
              <div className="setting-control">
                <input
                  id={label}
                  value={value}
                  onChange={(e) => update(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          ))}
          <div className="setting-row">
            <div className="setting-label"><div className="setting-field-heading"><label htmlFor="model-bindings">Соответствие моделей</label><SettingHelp topic="Соответствие моделей"/></div></div>
            <div className="setting-control">
              <textarea
                id="model-bindings"
                placeholder="ID в агенте = ID в сервисе"
                rows={3}
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="setting-row">
            <button className="btn primary" onClick={add}>
              Добавить
            </button>
          </div>
        </div>
      </section>
      {error && (
        <p role="alert" className="composer-error">
          {error}
        </p>
      )}
    </>
  );
}
