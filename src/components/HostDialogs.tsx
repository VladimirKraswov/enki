import { useEffect, useRef, useState } from "react";
import { store, useAppState, errText } from "../state/store";
import {
  DEFAULT_REMOTE_IDENTITY_PORT,
  sshAliases,
  validRemote,
} from "../native/hosts";
import { Icon } from "./Icon";

function useDialogFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, [open]);
  return {
    ref,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const elements = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ];
      if (e.shiftKey && document.activeElement === elements[0]) {
        e.preventDefault();
        elements[elements.length - 1]?.focus();
      } else if (
        !e.shiftKey &&
        document.activeElement === elements[elements.length - 1]
      ) {
        e.preventDefault();
        elements[0]?.focus();
      }
    },
  };
}
export function HostDialogs() {
  const s = useAppState(),
    open = s.ui.hostDialogOpen;
  const [name, setName] = useState(""),
    [target, setTarget] = useState(""),
    // Identity of a saved host (its workspace key), not a dialled port.
    [port, setPort] = useState(DEFAULT_REMOTE_IDENTITY_PORT);
  const [aliases, setAliases] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [path, setPath] = useState(""),
    [pathError, setPathError] = useState("");
  const focus = useDialogFocus(open || s.ui.remoteFolderOpen);
  useEffect(() => {
    if (open) {
      setError("");
      const current = store.currentHost();
      if (current) {
        setTarget(current.target);
        setName(current.name);
        setPort(current.port);
      }
      void sshAliases()
        .then(setAliases)
        .catch(() => setAliases([]));
    }
  }, [open]);
  useEffect(() => {
    if (s.ui.remoteFolderOpen) {
      setPath("");
      setPathError("");
    }
  }, [s.ui.remoteFolderOpen]);
  const close = () => {
    store.setUi({ hostDialogOpen: false, remoteFolderOpen: false });
  };
  if (!open && !s.ui.remoteFolderOpen) return null;
  const connect = async () => {
    const trimmed = target.trim();
    // Re-adding a saved target keeps its saved identity (and so its chats/queues).
    const saved = s.prefs.remoteHosts?.filter((h) => h.target === trimmed) ?? [];
    const identity = saved.some((h) => h.port === port) ? port : saved[0]?.port ?? DEFAULT_REMOTE_IDENTITY_PORT;
    const host = {
      id: `ssh:${trimmed}:${identity}`,
      name: name.trim() || trimmed,
      target: trimmed,
      port: identity,
    };
    if (!validRemote(host)) {
      setError("Введите SSH-алиас или user@host.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      store.saveRemoteHost(host);
      if (await store.connectHost(host.id)) close();
      else setError(store.state.connection.error ?? "Не удалось подключиться.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const addRemote = async () => {
    if (!path.startsWith("/") || /[\r\n\0]/.test(path)) {
      setPathError(
        "Укажите абсолютный путь на удалённой машине, например /home/user/work/app.",
      );
      return;
    }
    setBusy(true);
    setPathError("");
    const client = store.client;
    try {
      const resolved = await client.paths(path);
      await client.fileList(resolved.directory, "");
      if (client !== store.client)
        throw new Error("Компьютер изменился. Повторите выбор папки.");
      await store.addProjectDirectory(resolved.directory);
      close();
    } catch (e) {
      setPathError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) close();
      }}
    >
      <div
        {...focus}
        className="modal host-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={open ? "Удалённые компьютеры" : "Папка на сервере"}
      >
        <div className="dialog-heading">
          <Icon name="server" size={22} />
          <h3>{open ? "Работать удалённо" : "Открыть папку на сервере"}</h3>
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={close}
            disabled={busy}
            aria-label="Закрыть"
          >
            <Icon name="close" />
          </button>
        </div>
        {open ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <p className="dialog-description">
              Агент, терминал и файлы будут работать на выбранной машине.
              Подключение использует ваши SSH-ключи и настройки из
              ~/.ssh/config.
            </p>
            <label>
              SSH-алиас или user@host
              <input
                list="ssh-aliases"
                autoComplete="off"
                placeholder="vm-v100 или user@server"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={busy}
              />
            </label>
            <datalist id="ssh-aliases">
              {aliases.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
            <label>
              Название
              <input
                placeholder="Например, домашний сервер"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </label>
            <details className="connection-help">
              <summary>Подготовка сервера</summary>
              <p>
                На сервере (Linux x64) должна быть установлена среда выполнения
                Enki: <code>~/.local/share/enki/runtime-dist/current</code>.
                Её ставит и обновляет доверенный установщик из исходников Enki
                по аутентифицированному манифесту: запускайте
                <code>node scripts/runtime/install-remote-entry.mjs</code> — он
                сначала проверяет Node.js сервера (нужен 22.13+) и ничего не
                меняет на неподходящем (см. docs/REMOTE-RUNTIME.md).
              </p>
              <p>
                Enki сам запускает её по SSH и подключается через туннель к
                локальному порту сервера; отдельный пароль или открытый порт
                не нужны. Ключ сервера должен быть уже подтверждён в
                ~/.ssh/known_hosts — один раз войдите через ssh в терминале.
                Если среда на сервере недоступна, Enki сообщит об ошибке и не
                переключится на этот компьютер.
              </p>
            </details>
            {error && (
              <p className="composer-error" role="alert">
                {error}
              </p>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={close}
              >
                Отмена
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? "Подключение…" : "Подключиться"}
              </button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addRemote();
            }}
          >
            <p className="dialog-description">
              Папка на {store.hostLabel()}. Папки этого компьютера здесь не
              используются.
            </p>
            <label>
              Абсолютный путь
              <input
                placeholder="/home/user/work/project"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={busy}
              />
            </label>
            {pathError && (
              <p className="composer-error" role="alert">
                {pathError}
              </p>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={close}
                disabled={busy}
              >
                Отмена
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? "Проверка…" : "Открыть проект"}
              </button>
            </div>
          </form>
        )}
        {open && !!s.prefs.remoteHosts?.length && (
          <div className="saved-hosts">
            <div className="picker-section">Сохранённые подключения</div>
            {s.prefs.remoteHosts.map((h) => (
              <div key={h.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setTarget(h.target);
                    setName(h.name);
                    setPort(h.port);
                  }}
                >
                  {h.name}
                  <small>{h.target}</small>
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Удалить подключение ${h.name}`}
                  disabled={busy || h.id === s.prefs.activeHost}
                  onClick={() => store.removeRemoteHost(h.id)}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
