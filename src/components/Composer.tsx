import {AttachmentChip} from "./AttachmentChip";
import { modelServices, isSwitching } from "../models/services";
import { compactModelName } from "../models/display";
import { availablePickerModels } from "../models/picker";
import { ModelSwitchStatus } from "./ModelSwitchStatus";
import { ModelSelectionDialog } from "./ModelSelectionDialog";
import { HostPicker } from "./WorkspacePicker";
import { ContextMeter } from "./ContextMeter";
import { PendingCorrections } from "./PendingCorrections";
import { VoiceInput } from "./VoiceInput";
import { accessOptions, type AccessMode } from "../state/access";
import { Icon } from "./Icon";
import { activePluginUi } from "../agent/runtime/pluginUi/active";
import { SelectMenu } from "./SelectMenu";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { store, useAppState } from "../state/store";
import { attachmentDrafts, attachmentScope } from "../attachments/drafts";
import { LARGE_PASTE_THRESHOLD, pastedTextFile } from "../attachments/prepare";
import { filesFromNativeDrop, nativeDropTargetsQuestion } from "../attachments/native-drop";
import { pathBasename } from "../util/paths";
import { openFileInput, registerComposer } from "../attachments/composerBridge";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { deepseekPeakStatus, formatUntilCheap } from "../usage/peak";

const PromptQueue = lazy(() => import("./PromptQueue").then(m => ({default: m.PromptQueue})));

/** A file the runtime already stores for the edited queue item: metadata only, never fetched. */
function KeptAttachmentChip({ file, onRemove, disabled }: { file: { name: string; size: number }; onRemove: () => void; disabled: boolean }) {
  return <div className="attachment-chip attachment-chip-kept" title="Уже сохранён в очереди">
    <Icon name="file" size={18}/>
    <span title={file.name}>{file.name}</span><small>{file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} КБ` : `${(file.size / 1024 / 1024).toFixed(1)} МБ`}</small>
    <button type="button" disabled={disabled} aria-label={`Убрать ${file.name}`} onClick={onRemove}><Icon name="close" size={14}/></button>
  </div>;
}

export function Composer() {
  const s = useAppState();
  const activeQueue = s.activeSessionId ? s.queues[s.activeSessionId] : undefined;
  const pendingCorrections = useMemo(() => (activeQueue?.corrections ?? [])
    .filter(item => !activeQueue?.items.some(queued => queued.commandId === item.id)), [activeQueue]);
  const switches = useSyncExternalStore(modelServices.subscribe, modelServices.snapshot);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentProgress, setAttachmentProgress] = useState("");
  const [dragging, setDragging] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  // Peak-hours hint refreshes once a minute so the "cheaper in …" countdown stays honest.
  const [priceNow, setPriceNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setPriceNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const scope = attachmentScope(s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, s.activeSessionId);
  const attachments = useSyncExternalStore(attachmentDrafts.subscribe, () => attachmentDrafts.snapshot(scope));
  const draft = store.getDraft();
  const queueEdit = store.getQueueEdit();
  // Original files of the edited queue item that are still kept (removal is applied atomically).
  const kept = queueEdit ? store.editKeptFiles() : [];
  const choice = store.getModelChoice();
  const switchContext = s.activeSessionId ?? `@draft:${s.directory}`;
  const switchState = choice ? modelServices.statusFor(choice.providerID, choice.modelID, switchContext, store.engineIdFor()) : undefined;
  const switchError = choice ? modelServices.errorFor(choice.providerID, choice.modelID, switchContext, store.engineIdFor()) : undefined;
  const switching = isSwitching(switchState);
  const providers = store.configuredProvidersWithModels();
  const session = store.activeSession() ?? null;
  const status = session
    ? store.activityStatus(session.id)
    : s.ui.sending
      ? { type: "busy" as const }
      : { type: "idle" as const };
  const running = status?.type === "busy" || status?.type === "retry" || status?.type === "waiting";
  // The engine that will run the prompt decides readiness, not OpenCode alone.
  const connected = store.engineReady();

  useEffect(() => {
    let cancelled = false;
    setAttachmentError(""); setAttachmentProgress("");
    void attachmentDrafts.ensure(scope).catch(error => { if (!cancelled) setAttachmentError(String(error)); });
    return () => { cancelled = true; };
  }, [scope]);
  // Files from a chooser belong to the chat it was opened for, even if the user
  // switched chats while the native dialog was open.
  const chooserScope = useRef<string | null>(null);
  const addFiles = (files: File[], target = scope) => {
    if (!files.length) return;
    if (s.ui.sending) { if (scopeRef.current === target) setAttachmentError("Дождитесь подтверждения текущего запроса, затем добавьте файлы."); return; }
    if (scopeRef.current === target) setAttachmentError("");
    void attachmentDrafts.add(target, files).catch(error => { if (scopeRef.current === target) setAttachmentError(error instanceof Error ? error.message : String(error)); });
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const removeFile = (id: string) => {
    const target = scope;
    setAttachmentError('');
    void store.removeDraftAttachment(id).catch(error => {
      if (scopeRef.current === target) setAttachmentError(error instanceof Error ? error.message : String(error));
    });
  };
  const openChooser = () => {
    if (store.state.ui.sending) return false;
    chooserScope.current = scopeRef.current;
    return openFileInput(fileInputRef.current);
  };
  useEffect(() => registerComposer({
    scope: () => scopeRef.current,
    openFiles: openChooser,
    focus: () => textareaRef.current?.focus(),
  }), []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "enter" || event.payload.type === "over") { setDragging(true); return; }
      setDragging(false);
      if (event.payload.type !== "drop") return;
      if (nativeDropTargetsQuestion(event.payload.position)) return;
      const target = scopeRef.current;
      void filesFromNativeDrop(event.payload.paths, stat, readFile)
        .then(files => { if (!disposed) addFilesRef.current(files, target); })
        .catch(error => { if (!disposed && scopeRef.current === target) setAttachmentError(error instanceof Error ? error.message : String(error)); });
    }).then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(error => { if (!disposed) setAttachmentError(`Не удалось включить перетаскивание файлов: ${String(error)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault(); setDragging(true);
    };
    const drop = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      if (event.defaultPrevented) return;
      event.preventDefault(); setDragging(false); addFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
    };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setDragging(false); };
    window.addEventListener("dragover", over); window.addEventListener("drop", drop); window.addEventListener("dragleave", leave);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); window.removeEventListener("dragleave", leave); };
  }, []);

  // One executing agent (bundled runtime); the id only scopes model-service state.
  const engineId = store.engineIdFor();
  const selectionScope = `${scope}/${engineId}`;
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  const selectionTicket = useRef(0), refreshTicket = useRef(0);
  const selectionAbort = useRef<AbortController | null>(null);
  const [selection, setSelection] = useState<{ providerID: string; modelID: string; label: string; pending: boolean; error: string; progress?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  useEffect(() => { selectionAbort.current?.abort(); selectionTicket.current++; refreshTicket.current++; setSelection(null); setRefreshError(""); setRefreshing(false); }, [selectionScope]);
  useEffect(() => () => { selectionAbort.current?.abort(); selectionScopeRef.current = ""; selectionTicket.current++; refreshTicket.current++; }, []);

  const modelList = useMemo(() => availablePickerModels(providers, s.connectedProviderIds,
    (provider, model) => modelServices.manages(provider, model) && modelServices.visible(provider, model, engineId))
    .filter(m => modelServices.visible(m.providerID, m.modelID, engineId))
    .map(m => ({ ...m, label: compactModelName(m.label) })),
  [providers, s.connectedProviderIds, switches.revision, engineId]);

  const refreshModels = async () => {
    if (refreshing) return;
    const expected = selectionScope;
    const ticket = ++refreshTicket.current;
    setRefreshing(true); setRefreshError("");
    try { await store.refreshModelCatalog(); }
    catch (error) { if (selectionScopeRef.current === expected && ticket === refreshTicket.current) setRefreshError(error instanceof Error ? error.message : String(error)); }
    finally { if (selectionScopeRef.current === expected && ticket === refreshTicket.current) setRefreshing(false); }
  };
  const selectModel = async (providerID: string, modelID: string) => {
    selectionAbort.current?.abort();
    const abort = new AbortController(); selectionAbort.current = abort;
    const expected = selectionScope;
    const ticket = ++selectionTicket.current;
    const label = modelList.find(m => m.providerID === providerID && m.modelID === modelID)?.label ?? modelID;
    setSelection({ providerID, modelID, label, pending: true, error: "" });
    try {
      const variants = store.modelInfo(providerID, modelID)?.variants;
      await store.selectModel(providerID, modelID, variants?.medium ? "medium" : null, abort.signal, progress => {
        if (selectionScopeRef.current === expected && ticket === selectionTicket.current) setSelection(value => value ? {...value, progress} : value);
      });
      if (selectionScopeRef.current === expected && ticket === selectionTicket.current) setSelection(null);
    } catch (error) {
      if (selectionScopeRef.current === expected && ticket === selectionTicket.current) setSelection({ providerID, modelID, label, pending: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const variantOptions = store.effortOptions();

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight + 8, 240)}px`;
  }, [draft]);

  const send = () => {
    const text = store.getDraft();
    // s.ui.sending also blocks a second Enter while the first request awaits acknowledgement.
    if (queueEdit) {
      if ((!text.trim() && !attachments.length && !kept.length) || s.ui.sending) return;
      void store.applyQueueEdit(text, attachments);
      return;
    }
    if ((!text.trim() && !attachments.length) || s.ui.sending || !connected) return;
    if (running) {
      const target = scope;
      setAttachmentError("");
      void store.enqueueWithAttachments(text, attachments).then(accepted => {
        if (!accepted && scopeRef.current === target && !store.state.ui.sendError)
          setAttachmentError("Не удалось добавить запрос в очередь. Проверьте модель и лимит в 20 сообщений.");
      }).catch(error => { if (scopeRef.current === target) setAttachmentError(String(error)); });
      return;
    }
    // The store owns the draft lifecycle: on accept it removes exactly the submitted
    // revision; on failure the draft was never touched — nothing to lose or silently resend.
    setAttachmentError("");
    void store.sendPrompt(text, attachments, label => { if (scopeRef.current === scope) setAttachmentProgress(label); });
  };

  return (
    <div className="composer-wrap">
      {selection && <ModelSelectionDialog {...selection}
        status={modelServices.statusFor(selection.providerID, selection.modelID, undefined, engineId)}
        onClose={() => { selectionAbort.current?.abort(); selectionTicket.current++; setSelection(null); }} onRetry={() => void selectModel(selection.providerID, selection.modelID)}/>}
      {!connected && (
        <div className="offline-banner" role="alert">
          <span>Нет связи со средой выполнения Enki. Черновики и история сохранены.</span>
          <button onClick={() => void store.retryConnection()}>
            Проверить снова
          </button>
        </div>
      )}
      {connected && ["reconnecting", "error"].includes(s.connection.streamState) && (
        <div
          className="offline-banner"
          style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
          role="status"
        >
          Связь с чатом временно прервалась. Восстанавливаем автоматически — повторять запрос не нужно.
        </div>
      )}
      {s.ui.sendError && (
        <div className="composer-error" role="alert">
          {s.ui.sendError}
        </div>
      )}
      {attachmentError && <div className="composer-error" role="alert">{attachmentError}</div>}
      {switchState && (switching || switchState.error) && <ModelSwitchStatus state={switchState}
        modelName={modelList.find(m => m.modelID === (switchState.target_model ?? switchState.active_model))?.label
          ?? compactModelName(switchState.target_model ?? switchState.active_model ?? "Модель")}/>}
      {switchError && !switchState?.error && <div className="composer-error" role="alert">{switchError}</div>}
      {attachmentProgress && <div className="workspace-progress" role="status">{attachmentProgress}</div>}
      <PendingCorrections items={pendingCorrections}
        connected={connected && s.connection.streamState === "open"}/>
      {store.getQueue().length > 0 && (
        <Suspense fallback={null}><PromptQueue attachments={attachments} removeFile={removeFile} focusEditor={() => textareaRef.current?.focus()} switching={switching}/></Suspense>
      )}
      {s.ui.workspacePreparing && (
        <div className="workspace-progress" role="status">
          Подготовка рабочего места чата…
        </div>
      )}
      {queueEdit && <div className="queue-edit-heading" role="status">
        <span>Редактирование запроса в очереди</span>
        <button type="button" disabled={s.ui.sending} onClick={() => void store.cancelQueueEdit()}>Отмена</button>
      </div>}
      <div className={`composer ${dragging ? "composer-drop-target" : ""} ${voiceActive ? "composer-voice-active" : ""}`}>
        {dragging && <div className="composer-drop-label">Перетащите файлы сюда</div>}
        {(attachments.length > 0 || kept.length > 0) && <div className="attachment-list" aria-label="Вложения">
          {queueEdit && kept.map(file => <KeptAttachmentChip key={`kept:${file.id}`} file={file} disabled={s.ui.sending} onRemove={() => void store.removeQueuedAttachment(queueEdit.id, file.id)}/>)}
          {attachments.map(file => <AttachmentChip key={file.id} file={file} disabled={s.ui.sending} onRemove={() => removeFile(file.id)}/>)}</div>}
        <textarea
          ref={textareaRef}
          aria-label="Сообщение"
          placeholder="Работайте с Enki"
          value={draft}
          disabled={s.ui.workspacePreparing}
          onChange={(e) => store.setDraft(e.target.value)}
          // An IME composition is never sent to (or overwritten by) the shared plugin draft.
          onCompositionStart={() => activePluginUi.setComposing(true)}
          onCompositionEnd={() => activePluginUi.setComposing(false)}
          onBlur={() => activePluginUi.setComposing(false)}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) files.push(...Array.from(event.clipboardData.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => !!file));
            if (files.length) { event.preventDefault(); addFiles(files); return; }
            const value = event.clipboardData.getData("text/plain");
            if (value.length >= LARGE_PASTE_THRESHOLD) { event.preventDefault(); addFiles([pastedTextFile(value)]); }
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-controls-left">
            <button className="composer-plus" aria-label="Открыть команды" title="Команды и действия" onClick={() => store.setUi({paletteOpen: true})}>
              <Icon name="command" size={19} />
            </button>
            <input ref={fileInputRef} type="file" multiple hidden disabled={s.ui.sending} aria-label="Выбрать файлы" onChange={event => {
              addFiles(Array.from(event.currentTarget.files ?? []), chooserScope.current ?? scope);
              chooserScope.current = null; event.currentTarget.value = "";
            }}/>
            <button className="composer-plus" type="button" disabled={s.ui.sending} aria-label="Приложить файлы" title="Приложить файлы" onClick={openChooser}><Icon name="file" size={18}/></button>
            <SelectMenu
              label="Режим доступа"
              className={store.getAccessMode() === "full" ? "composer-access-full" : "composer-access"}
              icon={store.getAccessMode() === "full" ? "shield" : undefined}
              // Also while a tool waits for permission: the runtime re-decides that call by the new mode.
              disabled={!store.accessChangeAllowed() || !connected}
              value={store.getAccessMode()}
              options={[
                ...accessOptions,
                ...(store.getAccessMode() === "custom" ? [{value: "custom", label: "Свои разрешения", detail: "Правила этой сессии"}] : []),
              ]}
              onChange={(mode) => mode !== "custom" && void store.setAccessMode(mode as AccessMode)}
            />
          </div>
          <div className="composer-controls-right">
          <SelectMenu
            label="Модель"
            className="composer-model-picker"
            disabled={running || s.ui.sending || switching || !!selection?.pending}
            value={choice ? `${choice.providerID}/${choice.modelID}` : ""}
            fallbackLabel={s.modelCatalogChecking ? "Проверка доступных моделей…" : choice
              ? `${compactModelName(store.modelInfo(choice.providerID, choice.modelID)?.name ?? choice.modelID)} · доступ не подтверждён`
              : "Выберите доступную модель"}
            options={modelList.map((m) => {
              const peak = m.providerID === "deepseek" ? deepseekPeakStatus(priceNow) : null;
              return {
                value: `${m.providerID}/${m.modelID}`,
                label: m.label,
                detail: m.detail,
                section: m.section,
                peak: peak?.peak && peak.untilMs != null ? { note: `дешевле через ${formatUntilCheap(peak.untilMs)}` } : undefined,
              };
            })}
            onRefresh={() => void refreshModels()}
            refreshing={refreshing || s.modelCatalogChecking === true}
            refreshError={refreshError}
            onChange={(value) => {
              const [providerID, ...rest] = value.split("/");
              const modelID = rest.join("/");
              void selectModel(providerID, modelID);
            }}
          />
          {variantOptions.length > 0 && (
            <SelectMenu
              label="Усилие рассуждения"
              className="composer-effort-picker"
              value={choice?.variant ?? ""}
              options={[
                { value: "", label: "По умолчанию" },
                ...variantOptions.map((v) => ({
                  value: v,
                  label: v.charAt(0).toUpperCase() + v.slice(1),
                })),
              ]}
              onChange={(v) =>
                choice &&
                store.setModelChoice(
                  choice.providerID,
                  choice.modelID,
                  v || null,
                )
              }
            />
          )}
          </div>
          <div className="composer-actions">
          <VoiceInput disabled={!connected || s.ui.workspacePreparing} onActiveChange={setVoiceActive} />
          {((running && session) || s.ui.sending) && (
            <button
              className="stop-btn"
              onClick={() => running && session ? void store.stopSession(session.id) : store.cancelPreparation()}
              aria-label="Остановить ответ"
              title={running ? "Остановить ответ" : "Отменить подготовку"}
            >
              <Icon name="stop" size={14} />
            </button>
          )}
          {(!!queueEdit || !running || !!draft.trim() || attachments.length > 0) && <button
            className="send-btn"
            aria-label={queueEdit ? "Применить изменения" : running ? "Добавить в очередь" : "Send prompt"}
            title={queueEdit ? "Применить изменения к запросу в очереди" : undefined}
            disabled={
              (!queueEdit && !connected) ||
              (!draft.trim() && !attachments.length && !kept.length) ||
              s.ui.sending ||
              s.ui.workspacePreparing ||
              s.ui.runtimeLoading
            }
            onClick={send}
          >
            <Icon name={queueEdit ? "check" : running ? "plus" : "arrow"} size={19} />
          </button>}
          </div>
        </div>
      </div>
      <div className="composer-footer">
        {!s.activeSessionId ? (
          <HostPicker />
        ) : (
          <span
            title={`Инструменты выполняются: ${store.hostLabel()} · ${s.directory}`}
          >
            <Icon name={store.currentHost() ? "server" : "monitor"} size={13} />
            {store.hostLabel()}
          </span>
        )}
        <span
          className="workspace-caption"
          title={
            s.directory ??
            "Для нового чата будет создана отдельная рабочая папка"
          }
        >
          <Icon name={store.isProjectless() ? "chat" : "folder"} size={13} />
          {store.isProjectless()
            ? "Без проекта"
            : s.directory ? pathBasename(s.directory) : undefined}
        </span>
        <ContextMeter />
        {s.activeSessionId && <button className="browser-task-toggle" aria-label="Браузерная задача" aria-pressed={store.browserTaskActive()} disabled={running || s.ui.sending}
          title="Отдельный профиль: меньше рассуждений для обычных действий; усилие можно изменить вручную. Разрешения агента сохраняются."
          onClick={() => store.setBrowserTask(!store.browserTaskActive())}><Icon name="browser" size={13}/>{store.browserTaskActive() ? "Браузер · профиль" : "Браузерная задача"}</button>}

        <span className="spacer" />
        <span className="composer-keyboard-hint">
          Enter ↵{" "}
          <span className="optional-hint">· Shift+Enter новая строка</span>
        </span>
      </div>
    </div>
  );
}
