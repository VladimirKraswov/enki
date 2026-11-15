import { useCallback, useEffect, useRef, useState } from "react";
import { isNative, platform } from "../native/platform";
import { hasActiveSessions } from "../state/activity";
import { store } from "../state/store";
import {
  openPermissionSettings,
  permissionRows,
  probeMicrophone,
  requestSystemPermission,
  restartApp,
  shouldOpenPermissionCenter,
  systemPermissionStatus,
  type MicrophoneState,
  type PermissionRow,
  type SystemPermissionStatus,
} from "../permissions/status";

type Props = {
  mode: "startup" | "settings";
  onClose?: () => void;
  /** First launch after an update: ask for screen/accessibility once, visibly. */
  autoRequest?: boolean;
};

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(row: PermissionRow): string {
  switch (row.state) {
    case "granted":
      return "Разрешено";
    case "missing":
      return "Нужно разрешение";
    case "manual":
      return "Только вручную";
    default:
      return "Не проверено";
  }
}

/**
 * One place for every macOS permission Enki actually uses. It never claims a
 * grant: it shows the preflight result, asks only where an official API exists,
 * and sends the user to the exact Settings pane for the manual ones.
 */
export function PermissionCenter({ mode, onClose, autoRequest = false }: Props) {
  const [status, setStatus] = useState<SystemPermissionStatus | null>(null);
  const [microphone, setMicrophone] = useState<MicrophoneState>("unknown");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restartNeeded, setRestartNeeded] = useState(false);
  const autoDone = useRef(false);
  const native = isNative();
  const mac = platform() === "macos";
  const active = hasActiveSessions(store.getSnapshot()) || store.getSnapshot().ui.sending;

  const refresh = useCallback(async () => {
    try {
      setStatus(await systemPermissionStatus());
      setError("");
    } catch (problem) {
      setError(errText(problem));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const request = async (
    service: "screen" | "accessibility",
    rebind = false,
  ) => {
    setBusy(service);
    setError("");
    setNotice("");
    try {
      const result = await requestSystemPermission(service, rebind);
      if (result.granted) {
        setRestartNeeded(true);
        setNotice(
          service === "screen"
            ? "Доступ к записи экрана выдан. Для применения macOS может потребоваться перезапуск Enki."
            : "Доступ к универсальному доступу выдан.",
        );
      } else if (result.needs_settings) {
        await openPermissionSettings(service);
        setNotice(
          "Открыт нужный раздел настроек macOS. Включите Enki и вернитесь сюда.",
        );
      }
      await refresh();
    } catch (problem) {
      setError(errText(problem));
    } finally {
      setBusy(null);
    }
  };

  const requestAvailable = async (rebind = false) => {
    if (!status) return;
    setError("");
    setNotice("");
    setBusy("all");
    try {
      if (status.screen_recording === false) {
        const result = await requestSystemPermission("screen", rebind);
        if (!result.granted) {
          await openPermissionSettings("screen");
          setNotice("Открыт раздел «Запись экрана». Включите Enki и вернитесь сюда.");
        }
      }
      if (status.accessibility === false) {
        const result = await requestSystemPermission("accessibility", rebind);
        if (!result.granted) {
          await openPermissionSettings("accessibility");
          setNotice("Открыт раздел «Универсальный доступ». Включите Enki и вернитесь сюда.");
        }
      }
      setRestartNeeded(true);
      await refresh();
    } catch (problem) {
      setError(errText(problem));
    } finally {
      setBusy(null);
    }
  };

  // The update path is intentionally automatic once: the two permissions with
  // an official request API are asked for immediately, without the user having
  // to find this screen first. Full Disk Access and the microphone still need
  // an explicit action because they are more invasive.
  useEffect(() => {
    if (mode !== "startup" || !autoRequest || !status || autoDone.current) return;
    autoDone.current = true;
    // A version change almost always means the ad-hoc signature changed too.
    // Reset only Enki's stale TCC record and ask again, instead of trusting a
    // toggle that still points at the previous cdhash.
    void requestAvailable(true);
  }, [autoRequest, mode, status, requestAvailable]);

  const checkMicrophone = async () => {
    setBusy("microphone");
    setError("");
    setNotice("");
    try {
      const next = await probeMicrophone();
      setMicrophone(next);
      if (next === "denied") {
        await openPermissionSettings("microphone");
        setNotice("Открыт раздел «Микрофон». Включите Enki и повторите проверку.");
      } else if (next === "granted") {
        setNotice("Микрофон доступен.");
      } else {
        setNotice("Микрофон не удалось проверить: проверьте устройство ввода и настройки macOS.");
      }
    } catch (problem) {
      setError(errText(problem));
    } finally {
      setBusy(null);
    }
  };

  const rows = status ? permissionRows(status, microphone) : [];
  // The bulk button requests only the permissions with an official API. A
  // denied microphone is checked separately because opening it is a stronger
  // privacy action than asking for screen/accessibility.
  const missing = rows.some(
    (row) =>
      row.state === "missing" &&
      (row.key === "screen" || row.key === "accessibility"),
  );
  const title =
    mode === "startup"
      ? "Enki обновился — проверьте разрешения"
      : "Разрешения macOS";
  const intro =
    mode === "startup"
      ? "После обновления macOS могла отвязать старую подпись приложения. Это не значит, что переключатель в настройках выключен: Enki проверит фактический доступ."
      : "Здесь собраны только те доступы, которые Enki действительно использует. Выдача доступа всегда остаётся за вами.";

  const body = (
    <div className={`permission-center permission-center-${mode}`}>
      <header className="permission-center-head">
        <div>
          <h2>{title}</h2>
          <p>{intro}</p>
        </div>
        {mode === "startup" && onClose && (
          <button
            className="btn small"
            aria-label="Закрыть проверку разрешений"
            onClick={onClose}
          >
            Позже
          </button>
        )}
      </header>

      {!native || !mac ? (
        <p role="status" className="permission-empty">
          {!native
            ? "Это окно открыто не в приложении Enki."
            : "Системные разрешения macOS проверяются только в приложении Enki на Mac."}
        </p>
      ) : !status ? (
        <p role="status" className="permission-empty">
          Проверка разрешений…
        </p>
      ) : (
        <>
          <ul className="permission-list" aria-label="Разрешения Enki">
            {rows.map((row) => (
              <li key={row.key} className={`permission-row permission-${row.state}`}>
                <div className="permission-copy">
                  <div className="permission-title-line">
                    <b>{row.title}</b>
                    <span className={`permission-state permission-state-${row.state}`}>
                      {stateLabel(row)}
                    </span>
                  </div>
                  <small>{row.why}</small>
                  {row.key === "microphone" && (
                    <small>
                      Состояние проверяется только при нажатии кнопки: тихого
                      открытия микрофона нет.
                    </small>
                  )}
                </div>
                <div className="permission-actions">
                  {row.canRequest && (
                    <button
                      className="btn small"
                      disabled={busy !== null}
                      onClick={() =>
                        void request(
                          row.key === "screen" ? "screen" : "accessibility",
                        )
                      }
                    >
                      {busy === (row.key === "screen" ? "screen" : "accessibility")
                        ? "Запрос…"
                        : "Запросить"}
                    </button>
                  )}
                  {row.key === "microphone" && (
                    <button
                      className="btn small"
                      disabled={busy !== null}
                      onClick={() => void checkMicrophone()}
                    >
                      {busy === "microphone" ? "Проверка…" : "Проверить"}
                    </button>
                  )}
                  {(row.state === "missing" ||
                    row.state === "manual" ||
                    row.key === "microphone") && (
                    <button
                      className="btn small"
                      disabled={busy !== null}
                      onClick={() => void openPermissionSettings(row.key)}
                    >
                      Настройки
                    </button>
                  )}
                  {row.canRebind && (
                    <button
                      className="btn small permission-rebind"
                      disabled={busy !== null}
                      title="Удалить только старую запись Enki для этого разрешения и запросить её заново"
                      onClick={() =>
                        void request(
                          row.key === "screen" ? "screen" : "accessibility",
                          true,
                        )
                      }
                    >
                      Перепривязать
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="permission-note">
            «Перепривязать» удаляет только старую TCC-запись Enki для выбранного
            доступа и сразу запрашивает его заново. Это полезно после обновления
            с adhoc-подписью, когда переключатель уже включён, но фактически не
            действует.
          </p>
          {restartNeeded && (
            <div className="permission-restart" role="status">
              <span>
                Для записи экрана macOS может применить доступ только после
                полного перезапуска приложения
                {active ? ". Дождитесь завершения активных задач." : "."}
              </span>
              <button
                className="btn small"
                disabled={busy !== null || active}
                title={active ? "Не останавливайте Enki с активными задачами." : undefined}
                onClick={() => void restartApp().catch((problem) => setError(errText(problem)))}
              >
                Перезапустить Enki
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}

      <footer className="permission-footer">
        {mode === "startup" ? (
          <>
            <button
              className="btn primary"
              disabled={busy !== null || !status || !missing}
              onClick={() => void requestAvailable()}
            >
              {busy === "all" ? "Запрашиваю…" : "Запросить доступные разрешения"}
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => void refresh()}
            >
              Проверить снова
            </button>
            {onClose && (
              <button className="btn" onClick={onClose}>
                Продолжить без изменений
              </button>
            )}
          </>
        ) : (
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            Проверить снова
          </button>
        )}
      </footer>
    </div>
  );

  if (mode === "settings") return body;

  return (
    <div
      className="permission-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Проверка разрешений macOS"
    >
      {body}
    </div>
  );
}

/** Auto-open after an update or when a real screen/accessibility grant is absent. */
export function PermissionRuntime() {
  const [open, setOpen] = useState(false);
  const [autoRequested, setAutoRequested] = useState(false);
  useEffect(() => {
    if (!isNative() || platform() !== "macos") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void systemPermissionStatus()
        .then((status) => {
          if (cancelled) return;
          const versionKey = "enki.permissions.checked-version";
          const seen = localStorage.getItem(versionKey);
          localStorage.setItem(versionKey, status.version);
          if (shouldOpenPermissionCenter(status) || seen !== status.version) {
            setAutoRequested(seen !== status.version && shouldOpenPermissionCenter(status));
            setOpen(true);
          }
        })
        .catch(() => {});
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return open ? (
    <PermissionCenter
      mode="startup"
      autoRequest={autoRequested}
      onClose={() => setOpen(false)}
    />
  ) : null;
}
