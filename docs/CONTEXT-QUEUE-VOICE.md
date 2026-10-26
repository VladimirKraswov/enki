# Context, access, queue and dictation

Every chat runs in the single bundled **Enki Runtime** (pinned Pi SDK
0.85.1). Context, compaction, model transitions, the queue and timers are owned by
that runtime; the window only displays state and forwards explicit user intent.

## Ответы на вопросы агента

В свободном ответе доступны многострочный текст, тот же микрофон с восстановлением
диктовки, выбор файлов, перетаскивание и вставка скриншота. Большая текстовая
вставка и слишком длинный продиктованный ответ становятся текстовым вложением без
обрезки. Текст, выбранные варианты, файлы и запись привязаны
к конкретному вопросу и рабочему пространству; обычный черновик промпта сохраняется
отдельно. Ctrl/⌘+Enter отправляет ответ. Отправка блокируется на время записи и
подтверждения; повторный клик не создаёт второй запрос.

Файлы проходят обычную подготовку Enki: документы и аудио преобразуются для
модели, изображения передаются Vision-модели. На локальном компьютере оригиналы
поддерживаемых изображений также доступны инструментам редактирования; модель
без Vision получает явное объяснение, что она не видит пиксели. Ответ продолжает
ожидающий инструмент `question` в том же ходе работы, а не запускает новый промпт.
До подтверждения ядром сохраняются текст и файлы. Ошибка преобразования, связи
или устаревшее удалённое ядро оставляет их в черновике. В журнал событий попадают
метаданные файлов, исходные байты хранятся отдельно с проверкой SHA256. Текстовые
диалоги расширений также поддерживают диктовку; их строковый API не принимает
двоичные вложения.

## Context

The SDK owns automatic compaction, configured per runtime in
`Настройки → Агент Enki → Среда выполнения` (on/off; reserve and recent-tail
budgets). Enki never erases messages: a compaction or branch summary is shown as
a summary message while the summarised entries stay in the transcript. The
circular indicator shows the last reported model usage, the model's context
window and the remaining budget. It is not a sum of billing tokens and does not
pretend to know usage before the model reports it; a fresh chat shows "unknown"
until the first answer.

Model windows come from the runtime's model catalogue (the Pi entry of the Hub
catalogue, Enki's own `models.json`, or the SDK built-ins); see
[AI environment](AI-ENVIRONMENT.md). Changing an inference server's window does
not rewrite the catalogue automatically.

**Сжать сейчас** (when idle) submits one durable `compact` command. It always runs
on the chat's **current** model — a different model is refused with a pointer to
model transition. For a Hub-routed model the runtime first takes the Hub lease of
that exact model. Stop cancels it (`cancelled`, history unchanged); an explicitly
expired or replaced Hub lease cancels it the same way with that reason, so a paid
summary never continues without its reservation.

## Switching to a smaller model

Every path that changes the model — an ordinary prompt, a queued prompt, a timer
wake, an explicit model choice — passes the worker's **one** transition:

1. The next request is estimated from the SDK's real messages, system prompt and
   active tool schemas, taking `max(reported usage, estimate)`; unknown usage is
   never treated as "fits".
2. The target budget is its declared window minus its output reserve (declared
   `maxTokens`, at most half the window). A caller budget may only lower it.
3. If system + tools + the new prompt alone exceed the target, the request is
   refused before any inference (shorten the prompt or pick a larger model).
4. Otherwise, if the history does not fit, the **current (source) model**
   summarises it via SDK compaction — under its own Hub lease — and the bounded
   result is verified against the target. Only then is the target prepared (Hub
   lease of the exact target) and selected.

Each step is fenced by Stop/close: nothing reaches the target after a
cancellation or a lost source lease. A refusal keeps the previous model, the
draft and the queue, and explains the recovery (retry, larger model, or a new
chat with a bounded handoff). A source summary that was already persisted is
reported as such; it is never replayed. The original transcript is never
truncated or deleted. Progress phases (planning, summary model, summarising,
verifying, target model) are shown in the composer.

## Access

The composer selects **chat-scoped permission rules** evaluated by the runtime
(last match wins). It never automatically approves a pending permission request.

- **По умолчанию:** no chat rules; the runtime default from `Настройки → Агент Enki`
  applies («Спрашивать» is the safe default: an unanswered request is refused).
- **С подтверждением:** reading/search allowed, other tools ask.
- **Только чтение:** reading/search allowed, shell commands and editing denied.
- **Полный доступ:** tools allowed without asking, including outside the project.
- Existing nonstandard rules are displayed as **Свои разрешения** until explicitly changed.

Access may be changed while idle, and also while a turn is **parked on a tool
permission**: the runtime then re-decides that waiting call once by the new rules
(so switching to full access does not ask again). A turn that is streaming keeps
its access until it stops. These are tool permissions, **not an operating-system
sandbox**. A newly created chat uses the selected mode.

## Queue and correction

Enter during generation adds a prompt to the chat's **runtime-owned durable
queue** (maximum 20 items) with its model, variant, attachments, chat and
project. The runtime stores prepared parts and attachments itself; the window
only mirrors queue state. Normal completion dispatches the next item exactly
once, through the same gates and model transition as a manual prompt. Items can
be edited, reordered, removed or sent as a correction. Item operations are scoped
to their chat: an operation on an item that no longer belongs to the open chat
is refused (409) and the window re-reads that chat's queue. Deleting a chat also
removes its queued prompts and remembered permission answers; its timers stay
listed, paused with "chat deleted".

**Скорректировать сейчас** delivers that item as a steering message to the
running turn. The SDK shows it to the agent at the **next model/tool boundary**;
it cannot retroactively change generated tokens and does not kill an executing
command. If the turn ends before delivery, the item returns to the queue.

While delivery is pending, a compact **Уточнение** card keeps the original text
visible above the composer, with **Ждёт следующего шага агента**. The durable
command ledger is the authority: SDK acceptance alone does not mean the model
has seen the correction. Once the SDK user entry is saved, the card is replaced
by the labelled correction in chat history. Reopening the chat or reconnecting
reconstructs the card; uncertain delivery is explicitly marked and never replayed.
An unavailable status refresh after acceptance does not claim the send failed.

Long-running tools show elapsed time and, when measured from real output events,
time without new output. Repeated identical output does not reset that clock.
No output alone is not proof of a hung process. Disconnected or completed calls
do not animate a running clock. When a command is running, the footer explains
that the agent is waiting for its result.

If progress needs a human action, the agent must first explain what is needed
and ask through `question`, rather than poll devices in a long shell sleep.
Pending questions/permissions show **Ожидает вашего ответа/разрешения** instead
of working spinners. A soft yellow glow attracts attention; reduced-motion
settings retain a static highlight. This does not create additional approval
requirements for actions the owner has already authorized.

Queue guards:

- Durable command ids: a lost acknowledgement is retried under the same id and
  can never execute twice.
- Stop, a pausing error (balance, authentication, explicit Stop) or a pending
  interaction pauses the queue; resuming is an explicit action (optionally with
  the currently selected model).
- An item whose delivery is uncertain is shown as such and is **never replayed
  automatically**: check the history, then drop or requeue it.
- The queue survives window reloads, hidden windows and runtime restarts; it runs
  while the window is hidden or in the tray. A full quit stops dispatch; nothing
  is launched in a burst on the next start.

Timers ("wake-ups") are dispatched by the same runtime: a refused (provably
unsent) wake-up is re-attempted under a new id with back-off and pauses after 4
refusals; a cancelled one is consumed and the next occurs a full interval later;
an uncertain one pauses for the owner to check ([schedules](SCHEDULES.md)).

## Dictation

Settings accept a full transcription URL ending in `/audio/transcriptions`, model, optional language, and optional bearer API key. Compatible contract:

```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data
file=<audio>; model=<model>; language=ru; response_format=json

{"text":"Recognized text"}
```

The microphone starts only after a click and system permission. Recording has no total time limit; 30-second thinking pauses are allowed. With live Web Audio level detection it ends after 60 seconds of observed silence. If level detection cannot run, recording still works and the timer tooltip explains that stopping is manual. Sleep/background scheduling gaps do not count as observed silence.

Recognition runs while recording, serially on short independently decodable clips. Natural pauses (650ms, after at least 3 seconds) are preferred; continuous speech is cut into 15-second clips with a 700ms overlap and conservative multiword seam removal. MediaRecorder timeslice blobs are checkpoint parts of one container, not independent ASR inputs. Every clip is saved in the local IndexedDB journal before upload; pending audio and recognized-but-undelivered text stay there after errors. A recovery action resumes in order without re-transcribing text already recognized. Draft text and its receipt are persisted together before removing the corresponding audio. It never automatically sends a chat message.

The original workspace/draft owns audio and text. Navigation stops capture and preserves pending audio for explicit recovery in that draft. Cancellation before microphone permission sends nothing. Once recording has started, stopping retains recognized text and pending audio. Recovery can be retried or explicitly deleted; it is never automatically submitted on startup. Successful audio is removed. Raw audio is not uploaded to Hub or included in preferences. Microphone checkpoint delivery is browser scheduled, so a process/device crash can still lose the most recent unsaved tail; this is recovery protection, not a lossless hardware recorder.

Normal quit and update activation stop capture and await final audio persistence, without waiting for ASR or interrupting agents. Native ASR multipart requests keep the existing 25MiB per-request bound, private HTTP/HTTPS policy, redirect rejection and timeout; this is a per-clip transport limit, not a dictation duration limit. The ASR adapter accepts empty text for silence only when the progressive dictation caller permits it. Ordinary attachment transcription retains its missing-text error. Credentials remain memory-only and bound to the ASR endpoint; the journal contains only endpoint/model/language, never keys. A key may need to be entered again before recovery after restart. A native request already received by ASR cannot be recalled; disposed callers ignore late results and keep recoverable audio.

The packaged macOS app contains `NSMicrophoneUsageDescription` and the audio-input
entitlement required by its Hardened Runtime. On this installation the configured
ASR endpoint is GigaAM v3 in CT201 (`192.168.31.59`), and real M4A transcription
has been checked. Capture and cancellation in the installed app were also checked;
the ASR key, when required, remains memory-only. See [settings](SETTINGS.md) and
the [AI environment](AI-ENVIRONMENT.md).
