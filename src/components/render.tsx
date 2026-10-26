import {turnImageResults} from "../images/results";
import { partsPresentation } from '../chat/presentation';
import { executionEvidence, executionLabel, type ExecutionEvidence } from '../chat/execution';
import { lazy, Suspense, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { attachmentParts } from '../attachments/archive';
import type {
  AssistantMessage,
  MessagePart,
  PermissionRequest,
  QuestionRequest,
  Session,
  UserMessage,
} from "../api/types";
import { store, useAppState, useAppSelector } from "../state/store";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { sessionSources } from "../state/taskContext";
import { AttachmentThumbnail, AttachmentViewer } from "./AttachmentViewer";
import { MessageEdit } from "./MessageEdit";
import { actionCountLabel, answerText, finalAnswer, stepCountLabel, turnMetrics, visibleParts } from "../chat/turns";
import { exactTime, messageTime } from "../chat/time";
import { describeMessageError, isModelConnectionError } from "../chat/errors";
import { ModelConnectionCheck } from "./ModelConnectionCheck";
import { ToolActivity } from "./ToolActivity";
export { Markdown } from "./Markdown";
const GeneratedImages = lazy(() => import("./GeneratedImages"));
const OutputLimitNotice = lazy(() => import("./OutputLimitNotice"));

function MessageTimestamp({value}:{value:number}) {
 return value>0?<time dateTime={new Date(value).toISOString()} title={exactTime(value)}>{messageTime(value)}</time>:null;
}

export function Fold({
  label,
  children,
  tone,
  right,
  defaultOpen = false,
  spinner,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  tone?: "reasoning" | "tool";
  right?: React.ReactNode;
  defaultOpen?: boolean;
  spinner?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`fold${open ? " open" : ""}${tone ? ` ${tone}` : ""}`}>
      <button
        className="fold-head"
        aria-expanded={open}
        onClick={e => {
          e.currentTarget.dispatchEvent(new Event('conversation-disclosure', {bubbles:true}));
          setOpen(v => !v);
        }}
      >
        <span className="tw">▶</span>
        <span
          style={{
            flex: "0 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {spinner && <span className="tool-spinner" aria-label="Выполняется" />}
        {right}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

function truncate(s: string, n = 6000): string {
  return s.length > n ? `${s.slice(0, n)}\n… truncated (${s.length} chars)` : s;
}

export const ToolPartView = memo(function ToolPartView({
  part, evidence = "active",
}: {
  part: MessagePart; evidence?: ExecutionEvidence;
}) {
  const st = part.state ?? { status: "pending" as const };
  const running = st.status === "running" || st.status === "pending";
  const elapsed = st.time?.end && st.time?.start ? Math.max(0, st.time.end - st.time.start) : null;
  const dur = elapsed === null ? null : elapsed < 100 ? '<0,1 с' : `${(elapsed / 1000).toFixed(1)} с`;
  const fields = st.input && typeof st.input === 'object' ? st.input as Record<string, unknown> : {};
  const description = typeof fields.description === 'string' && fields.description.trim() ? fields.description : st.title;
  const label = (
    <>
      <span className="tool-name">{part.tool ?? "tool"}</span>
      {description ? <span> {description}</span> : null}
      {st.status === "error" && <span className="tool-state-error"> — ошибка</span>}
      {running && <span className="tool-state-run"> — {executionLabel(evidence)}</span>}
    </>
  );
  return (
    <Fold
      label={label}
      tone="tool"
      spinner={running && evidence === "active"}
      right={running && evidence === "active" && st.time?.start
        ? <span className="tool-duration"><ToolActivity state={st} tool={part.tool}/></span>
        : dur ? <span className="tool-duration">{dur}</span> : undefined}
      defaultOpen={st.status === "error"}
    >
      <ToolDetails state={st} />
    </Fold>

  );
});

// Fold does not mount its children while closed: avoid serializing large tool inputs on navigation.
function ToolDetails({state: st}: {state: NonNullable<MessagePart['state']>}) {
  const input =
    st.input === undefined
      ? ""
      : typeof st.input === "string"
        ? st.input
        : JSON.stringify(st.input, null, 2);
  return <>
      {input && (
        <>
          <div style={{ color: "var(--text-faint)", marginBottom: 3 }}>
            input
          </div>
          <pre>{truncate(input)}</pre>
        </>
      )}
      {st.output ? (
        <>
          <div style={{ color: "var(--text-faint)", margin: "6px 0 3px" }}>
            result
          </div>
          <pre>{truncate(st.output)}</pre>
        </>
      ) : null}
      {st.error ? (
        <>
          <div style={{ color: "var(--err)", margin: "6px 0 3px" }}>error</div>
          <pre style={{ color: "var(--err)" }}>
            {truncate(String(st.error))}
          </pre>
        </>
      ) : null}
  </>;
}

export function PartView({ part, evidence }: { part: MessagePart; evidence?: ExecutionEvidence }) {
  switch (part.type) {
    case "text":
      if (part.ignored || part.synthetic) return null;
      return part.text ? <Markdown source={part.text} /> : null;
    case "reasoning":
      return part.text ? (
        <Fold label="Размышления" tone="reasoning">
          <div style={{ whiteSpace: "pre-wrap", color: "var(--text-dim)" }}>
            {part.text}
          </div>
        </Fold>
      ) : null;
    case "tool":
      return <ToolPartView part={part} evidence={evidence} />;
    case "step-finish":
      return null;
    case "patch":
      return (
        <Fold label={<span>изменения применены</span>}>
          Изменения файлов записаны в сводку изменений сессии.
        </Fold>
      );
    case "retry":
      return (
        <div className="msg-meta finish-note">
          Повтор…{" "}
          {String((part.metadata as { message?: string })?.message ?? "")}
        </div>
      );
    case "compaction":
      return <div className="msg-meta">Контекст сжат</div>;
    default:
      return null;
  }
}

function usePartsPresentation(sessionId: string, messageIds: readonly string[]) {
  const select = useMemo(() => partsPresentation(sessionId, messageIds,
    () => store.activityStatus(sessionId)?.type,
    // The runtime event stream is the only live evidence that a tool still runs.
    s => s.connection.phase === "connected" && s.connection.streamState === "open" && !s.connection.statusError,
  ), [sessionId, messageIds]);
  return useAppSelector(select);
}

export const AssistantMessageView = memo(function AssistantMessageView({
  sessionId,
  message,
}: {
  sessionId: string;
  message: AssistantMessage;
}) {
  const ids = useMemo(() => [message.id], [message.id]);
  const snapshot = usePartsPresentation(sessionId, ids);
  const parts = visibleParts(snapshot.parts);
  const { status, connected } = snapshot;
  const terminal = !!message.time.completed && !["tool-calls", "tool_calls"].includes(message.finish ?? "");
  const evidence = executionEvidence(terminal, status === "busy" || status === "retry", connected, snapshot.waitingForUser);
  const running = !message.time.completed && evidence === "active";
  const errText = message.error ? describeMessageError(message.error) : null;
  const finishBad =
    message.finish &&
    !["stop", "end_turn", "stop_sequence", "tool-calls", "tool_calls"].includes(
      message.finish,
    );
  return (
    <div className="msg-assistant" data-scroll-anchor={`message:${message.id}`}>
      {parts.map((p) => (
        <div key={p.id} data-scroll-anchor={`part:${p.id}`}><PartView part={p} evidence={evidence} /></div>
      ))}
      {running && parts.length === 0 && (
        <div className="status-line">
          <span className="tool-spinner" /> Работаю…
        </div>
      )}
      {errText && (
        <div className="msg-error" role="alert">
          {errText}
          {isModelConnectionError(message.error) && message.providerID && message.modelID &&
            <ModelConnectionCheck providerID={message.providerID} modelID={message.modelID} agent={store.isPiSession(sessionId) ? "pi" : "opencode"} />}
        </div>
      )}
      {(message.finish === "length" || (message.error as {name?:string} | undefined)?.name === "MessageOutputLengthError")
        ? <Suspense fallback={<div className="msg-meta finish-note" role="status">Достигнут лимит ответа модели.</div>}>
          <OutputLimitNotice sessionId={sessionId} message={message} parts={parts}/>
        </Suspense>
        : finishBad && <div className="msg-meta finish-note" role="status">Завершено со статусом: {message.finish}</div>}


    </div>
  );
});

/** A turn owns one footer. Mount folded history on demand; preserve visited step state. */
export const AssistantTurnView = memo(function AssistantTurnView({sessionId, messages, active = false, partial = false, progressState, progressKey}: {
  sessionId: string; messages: AssistantMessage[]; active?: boolean; partial?: boolean;
  progressState?: Record<string, boolean>; progressKey?: string;
}) {
  const regionId = useId();
  const ids = useMemo(() => messages.map(m => m.id), [messages]);
  const snapshot = usePartsPresentation(sessionId, ids);
  const visited = useRef(new Set<string>());
  const last = messages[messages.length - 1];
  const parts = snapshot.parts.filter(p => p.messageID === last.id);
  const hasFinal = finalAnswer(last, parts);
  // Only history opened after completion starts folded. Never collapse a reader's live progress.
  const [expanded, setExpanded] = useState(() => (progressKey ? progressState?.[progressKey] : undefined) ?? (!last.summary && (active || !hasFinal)));
  useEffect(() => { if (progressState && progressKey) progressState[progressKey] = expanded; }, [progressState, progressKey, expanded]);
  const progress = hasFinal ? messages.slice(0, -1) : messages;
  const allParts = snapshot.parts;
  const generated = turnImageResults(allParts);
  const actions = allParts.filter(p => p.type === 'tool').length;
  const errors = allParts.filter(p => p.type === 'tool' && p.state?.status === 'error').length;
  const metrics = turnMetrics(messages);
  const terminal = !!last.time.completed && last.finish !== 'tool-calls' && last.finish !== 'tool_calls';
  const connected = snapshot.connected;
  const confirmedActive = active && connected && !snapshot.waitingForUser;
  const label = last.summary ? 'Сжатие контекста' : active && connected && snapshot.waitingForUser ? 'Ожидает вашего ответа'
    : confirmedActive ? 'Работаю' : active ? 'Ожидаю подтверждения состояния' : 'Ход работы';
  const toggle = () => {
    // Explicit disclosure is reader navigation, not new streaming content to follow to the tail.
    document.getElementById(regionId)?.dispatchEvent(new Event('conversation-disclosure', {bubbles:true}));
    setExpanded(v => !v);
  };
  return <section className="assistant-turn" aria-label="Ответ ассистента">
    {progress.length > 0 && <button className="turn-progress-toggle" data-scroll-anchor={`disclosure:${progressKey ?? messages[0].id}`} aria-expanded={expanded} aria-controls={progress.map(m => `${regionId}-${m.id}`).join(' ')} onClick={toggle}>
      <span className={`turn-chevron${expanded ? ' expanded' : ''}`} aria-hidden>›</span>
      {confirmedActive && <span className="tool-spinner" aria-hidden />}
      <span>{label}</span>{actions > 0 && <span className="turn-count">{actionCountLabel(actions)}</span>}
      {partial && <span className="turn-count">продолжение</span>}
      {errors > 0 && <span className="turn-tool-errors">Ошибок инструментов: {errors}</span>}
    </button>}
    <div id={regionId} className="turn-content">
      {messages.map(m => {
        const isFinal = hasFinal && m.id === last.id;
        // Message failures and output limits must remain visible even if the user folded progress.
        const problem = !!m.error || (!!m.finish && !['stop','end_turn','stop_sequence','tool-calls','tool_calls'].includes(m.finish));
        const visible = isFinal || expanded || problem;
        if (visible) visited.current.add(m.id);
        return <div key={m.id} id={`${regionId}-${m.id}`} data-message-id={m.id} className={isFinal ? `turn-answer${progress.length ? ' after-progress' : ''}` : 'turn-step'}
          hidden={!isFinal && !expanded && !problem}>
          {(visible || visited.current.has(m.id)) && <AssistantMessageView sessionId={sessionId} message={m} />}
        </div>;
      })}
    </div>
    {generated.length>0 && <div className="turn-generated-results"><Suspense fallback={<p>Изображения готовы…</p>}>{generated.map((result,i)=><GeneratedImages key={result.images[0]?.url??i} result={result}/>)}</Suspense></div>}
    {terminal && <div className="message-footer turn-footer">
      {!!answerText(parts).trim() && <CopyButton text={answerText(parts)} label={last.summary ? "Копировать сводку" : hasFinal ? "Копировать весь ответ" : "Копировать незавершённый ответ"} compact />}
      <MessageTimestamp value={last.time.completed!} />
      <details className="turn-details"><summary>Сведения</summary><div>
        {metrics.profiles.length > 0 && <span>{metrics.profiles.join(' → ')}</span>}
        <span>{stepCountLabel(messages.length)}{partial ? ' в загруженной истории' : ''}</span>
        {metrics.output > 0 && <span>{metrics.output.toLocaleString('ru-RU')} выходных токенов{metrics.partial ? ' (данные неполные)' : ''}</span>}
      </div></details>
    </div>}
  </section>;
}, (a, b) => a.sessionId === b.sessionId && a.active === b.active && a.partial === b.partial
  && a.progressState === b.progressState && a.progressKey === b.progressKey
  && a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]));

function MessageAttachmentViewer({sessionId, initialKey, onClose}: {sessionId:string; initialKey:string; onClose:()=>void}) {
  const s = useAppState();
  // Only user attachments; the same list object while nothing it shows changed.
  const next = sessionSources(s.chat.sessions[sessionId]), stable = useRef(next);
  const same = stable.current.length === next.length && next.every((f, i) => { const o = stable.current[i]; return o.key === f.key && o.url === f.url && o.name === f.name && o.mime === f.mime; });
  if (!same) stable.current = next;
  return <AttachmentViewer files={stable.current} initialKey={initialKey} onClose={onClose}/>;
}

export function UserMessageView({ message }: { message: UserMessage }) {
  const [viewedFile,setViewedFile] = useState<string|null>(null);
  const ids = useMemo(() => [message.id], [message.id]);
  const allParts = usePartsPresentation(message.sessionID, ids).parts;
  const parts = allParts.filter(
    (p) => p.type === "text" && !p.synthetic && !p.ignored,
  );
  const files = attachmentParts(allParts);
  const text = parts
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
  if (!text && !files.length) return null;
  const steering = parts.some(p => p.metadata?.arvelaSteering === 1);
  return <div className={`user-message ${steering ? "user-message-steering" : ""}`} data-scroll-anchor={`message:${message.id}`}>
    {steering && <span className="steering-label">↳ Уточнение</span>}
    {text && <div className="msg-user">{text}</div>}
    {files.length > 0 && <div className="message-file-list">{files.map(file => <button className="message-file" key={file.id} onClick={()=>setViewedFile(file.id)}><AttachmentThumbnail file={{key:file.id,name:file.filename||"Вложение",mime:file.mime,url:file.url}}/>{file.filename || "Вложение"}</button>)}</div>}
    {viewedFile && <MessageAttachmentViewer sessionId={message.sessionID} initialKey={viewedFile} onClose={()=>setViewedFile(null)}/>}
    <div className="message-footer"><MessageTimestamp value={message.time.created}/><CopyButton text={text} label="Копировать сообщение" compact/><MessageEdit message={message} text={text}/></div>
  </div>;
}

export function PermissionCard({
  req,
  onReply,
}: {
  req: PermissionRequest;
  onReply: (r: "once" | "always" | "reject") => void;
}) {
  return (
    <div
      className="action-card"
      role="alertdialog"
      aria-label="Запрос разрешения"
    >
      <div className="caption">Нужно разрешение</div>
      <div className="body">
        Агент просит разрешение <b>{req.permission}</b>
        {req.tool?.callID ? " для вызова инструмента" : ""}.
      </div>
      {req.patterns && req.patterns.length > 0 && (
        <div className="patterns">{req.patterns.join("\n")}</div>
      )}
      {req.metadata && Object.keys(req.metadata).length > 0 && (
        <div className="patterns">
          {truncate(JSON.stringify(req.metadata, null, 2), 1500)}
        </div>
      )}
      <div className="btn-row">
        <button className="btn small danger" onClick={() => onReply("reject")}>
          Отклонить
        </button>
        <button
          className="btn small"
          onClick={() => onReply("always")}
          title="Разрешать это действие до конца сессии"
        >
          Разрешать всегда
        </button>
        <button className="btn small primary" onClick={() => onReply("once")}>
          Разрешить один раз
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({
  req,
  onReply,
  onReject,
}: {
  req: QuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const allAnswered = req.questions.every(
    (_, i) => (picks[i]?.length ?? 0) > 0 || custom[i]?.trim(),
  );
  const submit = () => {
    const answers = req.questions.map((_, i) => {
      const chosen = picks[i] ?? [];
      const c = custom[i]?.trim();
      return c ? [...chosen, c] : chosen;
    });
    onReply(answers);
  };
  return (
    <div
      className="action-card"
      role="group"
      aria-label="Вопрос агента"
    >
      <div className="caption">Агент спрашивает</div>
      {req.questions.map((q, qi) => (
        <div
          key={qi}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div className="question-text">{q.question}</div>
          {(q.options ?? []).map((opt) => (
            <label className="opt-row" key={opt.label}>
              <input
                type={q.multiple ? "checkbox" : "radio"}
                name={`${req.id}-${qi}`}
                checked={(picks[qi] ?? []).includes(opt.label)}
                onChange={() =>
                  setPicks((prev) => {
                    const cur = prev[qi] ?? [];
                    if (!q.multiple) setCustom((old) => ({ ...old, [qi]: "" }));
                    const next = q.multiple
                      ? cur.includes(opt.label)
                        ? cur.filter((x) => x !== opt.label)
                        : [...cur, opt.label]
                      : [opt.label];
                    return { ...prev, [qi]: next };
                  })
                }
              />
              <span>
                <span className="opt-label">{opt.label}</span>
                {opt.description && (
                  <span className="opt-desc"> — {opt.description}</span>
                )}
              </span>
            </label>
          ))}
          {(q.custom ?? true) && (
            <input
              className="search-box"
              placeholder="Свой ответ…"
              aria-label="Свой ответ"
              value={custom[qi] ?? ""}
              onChange={(e) => {
                setCustom((prev) => ({ ...prev, [qi]: e.target.value }));
                if (!q.multiple) setPicks((prev) => ({ ...prev, [qi]: [] }));
              }}
            />
          )}
        </div>
      ))}
      <div className="btn-row">
        <button className="btn small danger" onClick={onReject}>
          Отклонить вопрос
        </button>
        <button
          className="btn small primary"
          disabled={!allAnswered}
          onClick={submit}
        >
          Отправить ответ
        </button>
      </div>
    </div>
  );
}

export function sessionStatusLine(
  s: ReturnType<typeof useAppState>,
  session: Session | null,
): string | null {
  if (!session) return null;
  const st = s.chat.sessions[session.id]?.status ?? s.statuses[session.id];
  if (!st) return null;
  switch (st.type) {
    case "busy":
      return "Выполняется…";
    case "retry":
      return `Повтор (попытка ${st.attempt ?? 1})${st.message ? `: ${st.message}` : ""}`;
    case "waiting":
      return "Ожидает ответа";
    default:
      return null;
  }
}
