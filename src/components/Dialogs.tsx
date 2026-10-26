import { store, useAppState } from "../state/store";
import { useEffect, useRef } from "react";

export function DeleteConfirm() {
  const s = useAppState();
  const sess = s.ui.confirmDelete;
  if (!sess) return null;
  const archive = store.isLegacySession(sess.id);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) =>
        e.target === e.currentTarget && store.setUi({ confirmDelete: null })
      }
    >
      <div className="modal" role="alertdialog" aria-label="Удалить сессию">
        <h3>Удалить сессию безвозвратно?</h3>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: "var(--text-dim)",
            lineHeight: 1.6,
          }}
        >
          «{sess.title}» и вся её история будут удалены из {archive ? "локального архива Enki" : "Enki"}.
          {!archive && <> Вместе с чатом удаляются его запросы в очереди и запомненные ответы на разрешения; таймеры этого чата останутся в списке приостановленными. Работающий чат сначала остановите.</>}
          {" "}Отменить это нельзя. Чтобы только скрыть чат, используйте <b>Архив</b>.
        </p>
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button
            className="btn"
            onClick={() => store.setUi({ confirmDelete: null })}
          >
            Отмена
          </button>
          <button
            className="btn danger"
            onClick={() => void store.deleteSession(sess)}
          >
            Удалить безвозвратно
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const s = useAppState();
  const scope = JSON.stringify([s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, s.activeSessionId, !!s.ui.settingsOpen]);
  const previous = useRef({ scope, text: s.ui.toast });
  useEffect(() => {
    const old = previous.current; previous.current = { scope, text: s.ui.toast };
    // A chat's old receipt must not follow the user into settings/another chat.
    // A new message produced by that navigation is kept.
    if (old.scope !== scope && old.text === s.ui.toast && s.ui.toast) store.setUi({ toast: null });
  }, [scope, s.ui.toast]);
  if (!s.ui.toast) return null;
  return (
    <div
      className="toast"
      role="status"
    >
      <span>{s.ui.toast}</span>
      <button type="button" className="toast-close" aria-label="Закрыть уведомление" onClick={() => store.setUi({ toast: null })}>×</button>
    </div>
  );
}

/**
 * The bundled Enki Runtime of this computer, or the runtime of the selected SSH
 * host. There is no address to type and no external agent to install: a remote
 * failure is never replaced by local execution.
 */
export function ConnectionGate() {
  const s = useAppState();
  const remote = store.currentHost();
  if (s.connection.phase === "connected") return null;
  return (
    <div className="gate" role="alert" aria-live="polite">
      <h2>
        {s.connection.phase === "connecting"
          ? "Подключение к среде выполнения Enki…"
          : `Нет подключения · ${store.hostLabel()}`}
      </h2>
      <p>
        {remote ? (
          <>
            Проверьте SSH-доступ к {remote.target} и установленную там среду
            выполнения Enki. Задачи не будут запускаться на этом компьютере вместо
            удалённой машины.
          </>
        ) : (
          <>
            Встроенная среда выполнения запускается вместе с приложением. Если она
            не ответила, повторите подключение; черновики и история сохранены.
          </>
        )}
      </p>
      {s.connection.error && (
        <p className="composer-error">{s.connection.error}</p>
      )}
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        {remote && (
          <button className="btn" onClick={() => store.setUi({ hostDialogOpen: true })}>
            Настроить подключение / ввести пароль
          </button>
        )}
        <button
          className="btn"
          disabled={s.connection.phase === "connecting"}
          onClick={() => void store.retryConnection()}
        >
          Повторить подключение
        </button>
      </div>
    </div>
  );
}
