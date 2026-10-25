import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, SessionDiffFile } from "../api/types";
import { store, useAppSelector, errText } from "../state/store";
import type { AppState } from "../state/types";
import type { RuntimeClient } from "../agent/runtime/client";
import { sessionPatchFiles } from "../state/chatReducer";
import { looksBinary, unifiedDiffLines } from "../util/diff";
import { isAbsoluteLocalPath, normalizeLocalPath, pathDirname, pathIsWithin } from "../util/paths";

/** Diff rebuilt from before/after content when the server gives no patch text (R8). */
function GeneratedDiff({ before, after }: { before?: string; after?: string }) {
  const lines = useMemo(() => unifiedDiffLines(before, after), [before, after]);
  if (lines.length === 0)
    return <div className="panel-note">Текстовых изменений нет.</div>;
  return <DiffView patch={lines.join("\n")} />;
}

function diffBadge(f: SessionDiffFile): { label: string; cls: string } {
  const st = (f.status ?? "").toLowerCase();
  if (st === "touched") return { label: "·", cls: "" };
  if (st === "modified") return { label: "M", cls: "" };
  if (st.includes("add") || (!f.before && f.after))
    return { label: "A", cls: "diff-add" };
  if (st.includes("del") || (f.before && !f.after))
    return { label: "D", cls: "diff-del" };
  if (st.includes("ren")) return { label: "R", cls: "" };
  return { label: "M", cls: "" };
}

function DiffView({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split("\n").slice(0, 4000), [patch]);
  return (
    <div className="diff-body">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`diff-line${l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : l.startsWith("@@") ? " hunk" : ""}`}
        >
          {l || " "}
        </div>
      ))}
      {patch.split("\n").length > 4000 && (
        <div className="diff-line">… изменения показаны не полностью …</div>
      )}
    </div>
  );
}

// Narrow subscriptions: streamed deltas of the chat must not re-render or rescan the panel.
const changesSnapshot = (s: AppState) => {
  const id = s.activeSessionId;
  return { directory: s.directory, activeSessionId: id,
    bump: id ? (s.chat.sessionPatched[id] ?? 0) : 0, patches: id ? (s.chat.sessions[id]?.patchRevision ?? 0) : 0 };
};
const filesSnapshot = (s: AppState) => ({ directory: s.directory });
const panelSnapshot = (s: AppState) => ({ layout: s.prefs.layout, directory: s.directory, activeSessionId: s.activeSessionId, endpoint: s.connection.endpoint });

function ChangesTab() {
  const s = useAppSelector(changesSnapshot);
  const [files, setFiles] = useState<SessionDiffFile[] | null>(null);
  const [source, setSource] = useState<"session" | "worktree">("session");
  // The runtime serves both: per-session edits (/sessions/:id/diff) and Git worktree diff.
  const effectiveSource = s.activeSessionId ? source : "worktree";
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const client: RuntimeClient = store.client;
  const requestGen = useRef(0);
  const openGen = useRef(0);
  const bump = s.bump;
  // After a reload the history (patch parts) can arrive after the first diff fetch; reload once they show up.
  const patchCount = s.patches;

  /** Expanding a patch-part-only file: content is not in the stream, so fetch it on demand. */
  const toggle = async (f: SessionDiffFile) => {
    const gen = ++openGen.current;
    const dir = s.directory;
    setOpenError(null);
    if (open === f.file) return setOpen(null);
    setOpen(f.file);
    if (f.status === "touched" && f.after === undefined && !f.patch) {
      try {
        const c = await client.fileContent(dir ?? "", f.file);
        if (
          gen !== openGen.current ||
          dir !== store.state.directory ||
          client !== store.client
        )
          return;
        const content = typeof c.content === "string" ? c.content : "";
        setFiles(
          (prev) =>
            prev?.map((x) =>
              x.file === f.file ? { ...x, after: content } : x,
            ) ?? prev,
        );
      } catch (e) {
        if (gen === openGen.current) setOpenError(errText(e));
      }
    }
  };

  const load = useCallback(async () => {
    const gen = ++requestGen.current;
    setFiles(null);
    setOpen(null);
    ++openGen.current;
    const dir = s.directory;
    const sessionId = effectiveSource === "session" ? s.activeSessionId : null;
    if (!dir) return;
    setLoading(true);
    setError(null);
    const stillCurrent = () =>
      gen === requestGen.current &&
      client === store.client &&
      store.state.directory === dir &&
      store.state.activeSessionId === s.activeSessionId;
    try {
      let result = sessionId
        ? await client.sessionDiff(sessionId, dir)
        : await client.vcsDiff(dir);
      if (sessionId) {
        // 1.18.18 may return no server diff after writes; patch parts are the truthful list.
        const toRel = (abs: string) => {
          const clean = normalizeLocalPath(abs).replace(/^\/private(?=\/)/, "");
          const root = normalizeLocalPath(dir).replace(/^\/private(?=\/)/, "");
          return pathIsWithin(clean, root) && clean !== root
            ? clean.slice(root.length + (root.endsWith("/") ? 0 : 1))
            : clean.replace(/^\/+/, "");
        };
        const known = new Set(
          result.map((r) => toRel(isAbsoluteLocalPath(r.file) ? r.file : `${dir}/${r.file}`)),
        );
        const generated: SessionDiffFile[] = [];
        for (const abs of sessionPatchFiles(
          store.state.chat.sessions[sessionId],
        )) {
          const rel = toRel(abs);
          if (!known.has(rel) && !result.some((r) => r.file === rel))
            generated.push({ file: rel, status: "touched" });
        }
        result = [...result, ...generated];
      }
      if (!stillCurrent()) return; // user switched project/session while the request was in flight
      setFiles(result);
    } catch (e) {
      if (!stillCurrent()) return;
      setError(errText(e));
      setFiles(null);
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  }, [s.directory, s.activeSessionId, effectiveSource, client]);

  useEffect(() => {
    void load();
    return () => {
      ++requestGen.current;
      ++openGen.current;
    };
  }, [load, bump, patchCount]);

  return (
    <>
      <div className="panel-toolbar">
        <button
          className={`panel-tab${effectiveSource === "session" ? " on" : ""}`}
          disabled={!s.activeSessionId}
          onClick={() => setSource("session")}
        >
          Эта задача
        </button>
        <button
          className={`panel-tab${effectiveSource === "worktree" ? " on" : ""}`}
          onClick={() => setSource("worktree")}
        >
          Рабочая копия
        </button>
        <button
          className="btn small ghost"
          onClick={() => void load()}
          aria-label="Обновить изменения"
        >
          ↻
        </button>
      </div>
      {loading && !files && <div className="panel-note">Загрузка изменений…</div>}
      {error && (
        <div className="panel-note" role="alert">
          {error}
        </div>
      )}
      {files && files.length === 0 && (
        <div className="panel-note">
          {effectiveSource === "session"
            ? "В этой задаче пока нет изменений файлов."
            : "В рабочей копии нет изменений относительно HEAD."}
        </div>
      )}
      {files?.map((f) => {
        const badge = diffBadge(f);
        return (
          <div className="diff-file" key={f.file}>
            <button
              className="diff-head"
              onClick={() => void toggle(f)}
              aria-expanded={open === f.file}
            >
              <span className={badge.cls}>{badge.label}</span>
              <span className="path" title={f.file}>
                {f.file}
              </span>
              {typeof f.additions === "number" && (
                <span className="diff-add">+{f.additions}</span>
              )}
              {typeof f.deletions === "number" && (
                <span className="diff-del">−{f.deletions}</span>
              )}
            </button>
            {open === f.file &&
              (f.status === "touched" ? (
                <div className="panel-note">
                  <p>
                    Файл затронут задачей. Сервер не сохранил исходную версию —
                    точный diff этой задачи недоступен. Текущий Git diff есть на
                    вкладке «Рабочая копия».
                  </p>
                  {f.after !== undefined ? (
                    <pre className="content-preview">
                      {f.after.slice(0, 100000)}
                    </pre>
                  ) : (
                    <p>{openError ?? "Загрузка текущего содержимого…"}</p>
                  )}
                </div>
              ) : f.patch ? (
                <DiffView patch={f.patch} />
              ) : looksBinary(f.before, f.after) ? (
                <div className="panel-note">Двоичный файл — текстового просмотра нет.</div>
              ) : f.before !== undefined || f.after !== undefined ? (
                <GeneratedDiff before={f.before} after={f.after} />
              ) : openError ? (
                <div className="panel-note" role="alert">
                  {openError}
                </div>
              ) : (
                <div className="panel-note">
                  Текст изменений недоступен.
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}

function FilesTab() {
  const s = useAppSelector(filesSnapshot);
  const client: RuntimeClient = store.client;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [file, setFile] = useState<{
    path: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqGen = useRef(0);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!s.directory) return;
      const gen = ++reqGen.current;
      setLoading(true);
      setError(null);
      setFile(null);
      try {
        const list = await client.fileList(s.directory, dir);
        if (gen !== reqGen.current) return;
        const sorted = [...list].sort((a, b) =>
          a.type === b.type
            ? a.name.localeCompare(b.name)
            : a.type === "directory"
              ? -1
              : 1,
        );
        setEntries(sorted);
        setPath(dir);
      } catch (e) {
        if (gen === reqGen.current) setError(errText(e));
      } finally {
        if (gen === reqGen.current) setLoading(false);
      }
    },
    [s.directory, client],
  );

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const openFile = async (entry: FileEntry) => {
    if (!s.directory) return;
    const gen = ++reqGen.current;
    setLoading(true);
    setError(null);
    try {
      const res = await client.fileContent(s.directory, entry.path);
      if (gen !== reqGen.current) return;
      if (res.type === "text" && typeof res.content === "string") {
        const MAX = 400_000;
        setFile({
          path: entry.path,
          content: res.content.slice(0, MAX),
          truncated: res.content.length > MAX,
        });
      } else {
        setFile({
          path: entry.path,
          content: "(двоичный файл или изображение — не показывается)",
          truncated: false,
        });
      }
    } catch (e) {
      if (gen === reqGen.current) setError(errText(e));
    } finally {
      if (gen === reqGen.current) setLoading(false);
    }
  };

  const parent = pathDirname(path);

  return (
    <>
      <div className="panel-toolbar">
        {file ? (
          <>
            <button
              className="btn small ghost"
              onClick={() => {
                setFile(null);
                void loadDir(path);
              }}
            >
              ← Назад
            </button>
            <span className="crumbs" title={file.path}>
              {file.path}
            </span>
          </>
        ) : (
          <>
            {path && (
              <button
                className="btn small ghost"
                onClick={() => void loadDir(parent)}
                aria-label="Родительская папка"
              >
                ↑
              </button>
            )}
            <span className="crumbs" title={s.directory ?? ""}>
              {path || (s.directory ?? "")}
            </span>
            <button
              className="btn small ghost"
              onClick={() => void loadDir(path)}
              aria-label="Обновить список файлов"
            >
              ↻
            </button>
          </>
        )}
      </div>
      {loading && <div className="panel-note">Загрузка…</div>}
      {error && (
        <div className="panel-note" role="alert">
          {error}{" "}
          <button
            className="btn small ghost"
            onClick={() => void loadDir(path)}
          >
            Повторить
          </button>
        </div>
      )}
      {file ? (
        <div className="code-view">
          {file.content
            .split("\n")
            .slice(0, 5000)
            .map((line, i) => (
              <div className="code-line" key={i}>
                <span className="ln">{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
          {file.truncated && (
            <div className="panel-note">Показано начало файла.</div>
          )}
        </div>
      ) : (
        <div className="file-tree">
          {entries?.map((e) => (
            <div
              key={e.path}
              className="file-row"
              role="button"
              tabIndex={0}
              onKeyDown={(ev) =>
                ev.key === "Enter" &&
                (e.type === "directory"
                  ? void loadDir(e.path)
                  : void openFile(e))
              }
              onClick={() =>
                e.type === "directory" ? void loadDir(e.path) : void openFile(e)
              }
            >
              <span className="ficon">
                {e.type === "directory" ? "▸" : "·"}
              </span>
              <span style={{ opacity: e.ignored ? 0.55 : 1 }}>{e.name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function RightPanel() {
  const s = useAppSelector(panelSnapshot);
  const layout = s.layout;
  return (
    <aside
      className="right-panel"
      style={{ width: layout.rightWidth }}
      aria-label="Изменения и файлы"
    >
      <div className="panel-tabs">
        <button
          className={`panel-tab${layout.rightTab === "changes" ? " on" : ""}`}
          onClick={() => store.setLayout({ rightTab: "changes" })}
        >
          Изменения
        </button>
        <button
          className={`panel-tab${layout.rightTab === "files" ? " on" : ""}`}
          onClick={() => store.setLayout({ rightTab: "files" })}
        >
          Файлы
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn small ghost"
          onClick={() => store.setLayout({ rightOpen: false })}
          aria-label="Закрыть панель"
        >
          ✕
        </button>
      </div>
      <div className="panel-body">
        {!s.directory ? (
          <div className="panel-note">
            Файлы появятся после начала чата. Можно работать без проекта или выбрать папку.
          </div>
        ) : layout.rightTab === "changes" ? (
          <ChangesTab
            key={`${s.endpoint}:${s.directory}:${s.activeSessionId}`}
          />
        ) : (
          <FilesTab key={`${s.endpoint}:${s.directory}`} />
        )}
      </div>
    </aside>
  );
}
