# Enki 2.0 — итоговый остаточный обзор UI (exact Claude Opus 5.5)

Автор: Claude Opus 5.5 (`claude-opus-5-5`), по поручению пользователя.
Режим: ТОЛЬКО правка исходников на Igor. Никакие команды, тесты, typecheck, сборки,
установки, git, приложения, браузеры, хуки и подпроцессы не запускались.

**ВСЕ ПРОВЕРКИ: NOT RUN.** Ни один новый или изменённый тест не выполнялся; ничего не
компилировалось. Утверждений о GREEN, готовности или выпуске нет; версия не менялась.

Пофайловый реестр: [`REMAINDER-UI-FILE-LEDGER.json`](REMAINDER-UI-FILE-LEDGER.json)
(414 строк инвентаря UI + новые файлы; путь, SHA-256 из инвентаря — для изменённых
файлов это SHA ДО правки, глубина чтения, находка/исправление/причина без изменений, тесты).

Исключительный домен правок: `src/**`, `test/**`, `index.html`, `vite.config.ts`,
`vitest.config.ts`, корневые `tsconfig*.json`. Чужие домены только читались.

## 1. Прочитанные входные данные

`REMAINDER-FINAL-REVIEW-COMMON.md`, `REMAINDER-DOMAIN-CHECKLIST.md`, `REMAINDER-REFERENCE-INDEX.md`,
`REMAINDER-CURRENT-FILE-INVENTORY.json` (строки scope `ui`), `FINAL-OPUS-REVIEW-RESULT.md`,
`FINAL-UI-REVIEW-RESULT.md` (§6 — список НЕ проверенного прошлым проходом, им и задан объём),
`TODO-FOR-OPUS-remainder-test-retirement-matrix.md`, `FINAL-INTEGRATION-DELETE-PATHS.json`
(только чтение). Вызывающие стороны в runtime (`src-tauri/resources/agent/src/**`) и native
читались выборочно для сверки портов.

## 2. Исправления и рефакторинг (по областям, с причинами)

### 2.1 Окно, разметка, состояние окна
- `src/App.tsx` + новый `src/util/resize.ts`: перетаскивание разделителей вешало
  `pointermove/pointerup` на `window` и снимало их только по `pointerup`. При
  `pointercancel`, потере фокуса окна (`blur`) или размонтировании слушатели оставались
  навсегда и продолжали менять разметку. Вынесено в `startResize(...)`: зажим min/max,
  ось x/y, завершение по `pointerup`/`pointercancel`/`blur`, возвращает функцию завершения.
  Нижний разделитель переведён на тот же порт (`axis:"y"`, `direction:-1`, 90–600 px).
- `src/components/ChatView.tsx`: при оборванном потоке событий (`reconnecting/error/closed`)
  или ошибке проверки статуса показывались одновременно спиннер «Агент работает…» и
  предупреждение «Выполнение не подтверждено». Теперь при неподтверждённом состоянии
  спиннер busy/retry скрыт, остаётся только предупреждение (архив без live-статуса не затронут).

### 2.2 Чат, рендер, store/reducer
- `src/components/render.tsx`: карточки разрешения и вопроса, строка статуса сессии,
  «Размышления», сжатие контекста, повтор, aria спиннера — переведены на русский
  (англоязычный текст был видим пользователю). Предикат «подключено» для подтверждения
  исполнения хода теперь `phase==="connected" && streamState==="open" && !statusError`;
  мёртвая ветка `isPiSession` (всегда true в одном runtime) удалена.
- `src/components/MessageEdit.tsx`: кнопка правки скрывалась по константе `isPiSession`
  — то есть никогда не показывалась. Теперь скрыта только для архивного чата
  (`isLegacySession`); подписка — узкий селектор `{running, attachments}` вместо всего AppState.
- `src/state/chatReducer.ts`: счётчик `patchRevision` (изменение/удаление patch-частей,
  удаление сообщений, сверка истории; сохраняется через `applyHistory`).
  `src/components/RightPanel.tsx` больше не сканирует все части сессии на каждой дельте
  стрима (O(parts) на токен), а сравнивает ревизию; селекторы вместо полной подписки;
  английский текст панели переведён.
- `src/state/store.ts`:
  - ограничены «только-стримовые» слоты фоновых чатов (`RETAINED_STREAM_SLOTS=12`):
    раньше каждый фоновый чат, приславший событие, навсегда оставался в памяти. Не
    вытесняются: активный, busy/retry/waiting, с ожидающим разрешением/вопросом,
    с `lastError`, `pendingTiming` или неуспешным исходом. Вызов — после `loadHistory`
    и при переходе неактивного чата в idle;
  - при смене рабочего пространства в `doConnect` очищаются `historyLoaded` и
    `mcpStatuses` (иначе после переподключения к другому компьютеру считалось, что
    история уже загружена, и показывался только стримовый хвост);
  - восстановление чата проекта в `setDirectory` читает авторитетную страницу истории,
    если слот есть, но история не загружена (раньше — только хвост из стрима);
  - `accessChangeAllowed()`: смена режима доступа разрешена в idle, а также когда ход
    стоит на ожидающем разрешении (busy/retry/waiting + pending permission, не архив).
    Ранее при «остановке на разрешении» переключить на полный доступ было нельзя, хотя
    именно это и нужно; вопрос (question) доступ не разблокирует. `Composer` использует порт;
  - русские тексты уведомлений вместо английских (проекты, создание/переименование/
    архивирование/восстановление/удаление чата, отклонение вопроса).
- `src/state/context.ts`: поиск последнего измеренного ответа без аллокаций (обратный цикл).
- `src/api/types.ts`: заголовок без названия → «Без названия».

### 2.3 Сайдбар, индикаторы, иконки
- `src/state/sidebar.ts`: `liveStatusConfirmed(connection, directory, currentDirectory)` —
  единое правило «живой статус подтверждён» (connected; для текущего каталога нет
  `statusError`; глобальный поток, а при его отсутствии поток каталога, открыт).
  `src/components/Sidebar.tsx`: метки активности чатов и проектов используют его;
  удалён мёртвый гейт `!store.isPiSession(id)`, из-за которого индикатор «?» никогда не
  показывался. Заголовки/обрезка и анимация (`SessionSpinner`: общий rAF-такт, reduced-motion,
  visibility) проверены без изменений. Все имена иконок, используемые в `src/components`,
  присутствуют в карте `Icon.tsx` (fallback `code` нигде не срабатывает).

### 2.4 Изображения, PBR, ZIP, вложения, PDF
- `src/images/results.ts`: `turnImageResults` на каждой дельте стрима делал `JSON.parse`
  вывода КАЖДОГО инструмента хода. Теперь быстрый отказ, если в выводе нет `"enkiImages"`,
  и `WeakMap` по объекту `state` части (reducer заменяет объект при изменении — кэш точен).
  Связь изображений/PBR-карт/ZIP с ходом и порядок карточек не менялись.
- `src/components/PdfPreview.tsx`: при смене файла показывались страница/документ/ошибка
  предыдущего PDF до окончания загрузки нового; теперь эффект загрузки сбрасывает
  `pdf/page/error` и выставляет `busy`.
- `GeneratedImages`, `AttachmentViewer`, `attachments/*`: проверены без изменений
  (см. реестр). Порт открытия/сохранения `images.zip` отсутствует в native — §5.

### 2.5 Плагины UI, диалоги
- `src/components/PluginUiPanel.tsx`: подписка на весь AppState (перерисовка терминальной
  поверхности на каждом токене любого чата) заменена селектором `{connected, theme}`;
  ключи уведомлений `${at}:${index}` (совпадающие `at` давали дубли ключей React).
- `src/components/PiDialog.tsx`: селектор `{dialog}` вместо полной подписки.
- Типизированные порты `pluginUi/*` (CAS-черновик, VT-кадры, attach/release/resync)
  проверены без изменений; разрывы портов — §5.

### 2.6 Hub, модели
- `src/models/hub.ts` `check()`: проверка готовности только читает (`inspect`), никогда не
  вызывает prepare/select. Если Hub сообщил `error` или `phase:"failed"`, `check()` раньше
  сообщал «модель не готова» как обычное ожидание. Теперь — правдивая ошибка
  «Hub сообщил об ошибке загрузки модели: …» (≤300 символов); состояние `failed` сохраняется
  и не перезаписывается, повторных запросов нет.
- `src/hub/collection.ts` + `src/diagnostics/tasks.ts` + `src/hub/incremental.ts`: сбор
  записей для Hub вызывал `taskDiagnostics` на каждое пользовательское сообщение с
  повторным поиском позиции (O(n²)) и пересчитывал хеши неизменённых ответов. Теперь
  `taskPositions(chat)` за один проход, записи ассистента переиспользуются по идентичности
  частей/метаданных (`stable:true`), хеш переиспользуется только для `stable`.
  Кэш по идентичности самой записи сознательно НЕ введён: `hub-incremental` мутирует записи.
- `src/components/ModelCatalogSettings.tsx`: шаблон «Добавить модель» содержал только
  провайдера `opencode`; добавлен вход `pi` (baseUrl, `openai-completions`) — именно его
  читает единственный runtime.
- `src/components/SkillQualitySettings.tsx`: применение/откат навыка вызывали только
  `invalidateCapabilities()`; открытые чаты runtime не получали новый навык. Теперь
  `store.capabilitiesCommitted(directory)` (порт runtime `/capabilities/refresh`) и правдивое
  уведомление «свободные — сразу, занятые (N) — после завершения работы».

### 2.7 Комментарии/тексты без изменения поведения
`src/attachments/prepare.ts`, `src/control/managedRuns.ts`, `src/control/bridge.ts`
(текст ошибки «Enki runtime не принял …» вместо устаревшего OpenCode-контекста).

## 3. Тесты (написаны/изменены, ВСЕ NOT RUN)

Новые:
- `test/resize.test.ts` — зажим, освобождение по `pointerup`, завершение по `pointercancel`/`blur`: после завершения движения указателя размер не меняют.
- `test/runtime-stream-framing.test.ts` — перенос независимого утверждения старого
  `events.test.ts` case0 на `runRuntimeStream`/`SseDecoder` runtime: LF-кадр; CRLF,
  разрезанный между чанками (`id: 6\r` | `\ndata…\r` | `\n\r` | `\n`); многострочный `data`;
  CR-only; UTF-8 «ёлка», разрезанная посреди байта; кадр, буферизованный после abort, не
  доставляется. Проверки: seq `[6,7,8,9]`, свойства, без reset, один fetch, `cancel()` тела,
  состояния `connecting → open → closed`.
- `test/model-hub-inspect.test.ts` — failed loader: только `catalog`+`inspect`, тело
  `{providerID, modelID, agent}`, статус `failed` сохраняется, 120 с фейковых таймеров — ни
  одного запроса; ready/loading/другой активный — только `inspect`; нечитаемый каталог
  (schema 2) — fail-closed без inspect/route/cache; каталог 503 — не более 3 попыток
  («после 3 попыток»); кэш аренд до 2.0 игнорируется; `ensure/ensureLocal` для Hub-модели
  ничего не трогают.
- `test/image-results-cache.test.ts` — `JSON.parse` вызывается 1 раз, затем 2 после замены части.
- `test/live-status.test.ts` — `liveStatusConfirmed` и согласование с `executionEvidence`.
- `test/hub-collection-scale.test.ts` — равенство позиций, граница чтений Proxy < 20×n
  (2000 сообщений), переиспользование записей/число перехеширований.
- `test/image-context-opencode-policy.test.ts` — дословно вынесенный мёртвый case
  access-policy (удерживается до удаления `access-policy.mjs`).

Изменённые (ни одно исходное утверждение не ослаблено и не удалено, если не указано):
- `test/chat-window.test.ts` — фикстура исправлена (действие автора 1); новый кейс
  «неподтверждённый live-чат показывает предупреждение вместо спиннера».
- `test/evaluations.test.ts` — устаревшее ожидание `OPENCODE_TEST_HOME` заменено (действие 2).
- `test/image-context.test.ts` — из файла вынесен ровно один мёртвый case access-policy
  (действие 3/разделение); файл не удалён и не пропущен, три живых кейса сохранены.
- `test/pi-shared-tools.test.ts` — +3: каждый image-инструмент (`image_inputs`,
  `edit_image`, `get_images`) получает идентичность сессии SDK поверх подделанной,
  аргументы целы; `__enkiImageContext` от модели не доходит до не-image сервера;
  недопустимые id сессии (`../escape`, пустой, 201 символ) — отказ «Общий MCP недоступен», вызова нет.
- `test/history-slot.test.ts` — +2: ограничение стримовых фоновых слотов; восстановление
  чата проекта читает авторитетную страницу.
- `test/queue-access.test.ts` — +1: ход стоит на разрешении → PATCH полных правил, без
  `POST /permissions/:id/reply`; ответ политики убирает карточку; вопрос не разблокирует.
- `test/chatReducer.test.ts` — +1 `patchRevision`.
- `test/turn-render.test.ts` — мок store `isLegacySession`; +1 кейс правки сообщения
  (live — кнопка «Редактировать сообщение», на время хода disabled; архив — нет).
- `test/skill-quality-ui.test.ts` — мок `capabilitiesCommitted`; +1 кейс promote.
- `test/pi-workspace.test.ts` — мок `useAppSelector` (RightPanel перешёл на селекторы).

## 4. Действия автора и особые пункты

1. **Фикстуры chat-window** (дефект фикстуры, не продукта): слот строился без `parts`/
   `partsByMessage`; ChatView читает `slot.partsByMessage[...]` для сравнения раскладки.
   Теперь используется реальный `emptySessionChat()`, у каждого сообщения текстовая часть
   записана как в reducer. Все утверждения (60/120 строк, reveal, навигация) сохранены.
2. **`OPENCODE_TEST_HOME`** (устаревший контракт): тест теперь проверяет изолированные
   `HOME/USERPROFILE`, `PI_CODING_AGENT_DIR=join(home,"pi")`, `XDG_{CONFIG,DATA,CACHE,STATE}_HOME`,
   отсутствие любых ключей `OPENCODE_*`, отсутствие секрета (`DEEPSEEK_API_KEY`) и пути
   владельца; окружение восстанавливается.
3. **Image lock** — qualified PASS, не менялся.
4. **SSE LF + split-CRLF + чистая отмена** перенесены на runtime-парсер (`test/runtime-stream-framing.test.ts`).
   OpenCode global-envelope case остаётся retired-premise.
5. **Проверка модели только через inspect**: `check()` не вызывает prepare/select;
   доказано `test/model-hub-inspect.test.ts` (окно). Runtime-часть (failed-loader терминален,
   SDK/select не диспетчеризуется, поздний ready не перезаписывает) — вне домена, §5.
6. **Статус неуспешного загрузчика принадлежит runtime/Hub**: UI только отображает
   `failed`/`error`, не делает повторов и не выводит готовность.
7. **Полный доступ**: UI не запрашивает разрешения приложения повторно — при полном
   доступе правила отправляются PATCH-ем, карточки снимает ответ политики runtime;
   разрешения ОС не обходятся. Стабильность разрешений ОС — идентичность
   `dev.local.opencodedesktop` (native, не менялась).
8. **Диктовка**: `voice/*` (SegmentedCapture, VoiceTiming, TranscriptionQueue, журнал
   IndexedDB) и `VoiceInput/VoiceWaveform` прочитаны полностью: сегменты ограничены,
   восстановление чанков после перезапуска идёт из журнала, повторы ASR ограничены;
   изменений не потребовалось.
9. **Очередь и коррекция во время хода**: `PromptQueue`, `promptQueue`, `queue`
   (DnD, правка, steer) — без изменений, см. реестр.
10. **Ограниченное хранение**: транскрипты (LRU 12 + новые стримовые слоты 12), позиции
    прокрутки (80), кэш изображений (WeakMap), хеши Hub (WeakMap) ограничены.

## 5. Межоменные порты и разрывы (точный файл/порт, минимальное изменение)

1. **Native — ZIP изображений.** В `src-tauri/src/images.rs` есть только `image_asset`,
   `image_settings`, `image_probe`; команды открыть/сохранить `images.zip` нет. Минимально:
   команда `image_archive_save(sessionId, path)` с проверкой, что путь архива принадлежит
   каталогу изображений сессии, + регистрация в `generate_handler!`. UI-карточка ZIP
   подключается к ней одной строкой.
2. **Runtime — неуспешный загрузчик Hub (матрица, разрыв 2).** Нужен тест runtime: статус
   `failed/error` терминален, SDK/select не диспетчеризуется, поздний `ready` не перезаписывает.
   Отдельно — гейтированный тест аренды на весь ход (разрыв 1: удерживать инструмент/
   стрим во время `renew()` и доказать отсутствие release до `agent_settled`).
3. **Runtime — `extension.notify`.** Уведомление может попадать и в тост store, и в
   уведомления панели плагина. Минимально: runtime помечает событие поверхностью
   (`surface: "toast" | "panel"`), либо UI-ветка выбирается по наличию активной панели — нужен контракт runtime.
4. **Runtime — черновик плагина.** `uiDraft` принимает необязательный `selection`, но
   композер его не передаёт; `themeName` поверхности не применяется. Нужна фиксация
   контракта (обязательно/необязательно) в `plugin-ui/protocol.ts`; UI готов передать.
5. **Native — разрешения ОС** — стабильная идентичность приложения; UI не меняет.
6. **Не исправлено в UI сознательно (низкий риск, описано):** удаление префиксов кэша
   usage O(S×F) — только по действию пользователя; `brokerRelays` очищается при >200;
   `mcpStatuses` не ограничен по сессиям (очищается при подключении); опрос
   переключения локальной службы модели продолжается после отмены отправки (общий
   полёт, ограничен 31 мин).

## 6. Сохранённые инварианты

Только-чтение старых историй и явное продолжение; очередь и коррекция во время хода;
таймеры и владение; source-first уменьшение модели и авторитетная готовность Hub (без
обхода Hub и без «тихого» прямого fallback); политика полного доступа; инструменты/MCP/
плагины и UI плагинов; изоляция браузера/компьютера; неограниченная восстанавливаемая
диктовка; изображения/правка/последнее/PBR/карточки/ZIP; саморабота мастерской и
обновления; удалённые устройства. Нет blanket-cast, silent catch-and-success,
бесконечных повторов, удаления данных пользователя, пропущенных тестов или ослабленных
утверждений.

## 7. Предложение удаления в собственном домене (deleteNow: false)

Ничего не удалено. `FINAL-INTEGRATION-DELETE-PATHS.json` не менялся. Новые предложения:

| Путь | Причина | Покрытие инварианта |
|---|---|---|
| `src/state/configEditor.ts` + `test/configEditor.test.ts` | нет импортёров в `src` | case1 (JSONC-комментарии) и case2 (отказ на повреждённом) — `test/model-catalog.test.ts` («refuses to touch a malformed provider block», «keeps comments inside the provider block…»); case3: MCP URL без учётных данных — `test/capabilities-registry.test.ts:30`; имена npm-плагинов OpenCode — retired premise |
| `src/state/contextTransfer.ts` + `test/context-transfer.test.ts` | уже в MIGRATION_DELETE_PATHS; нет импортёров | source-first/сводка принадлежат SDK/runtime: в матрице есть PASS переходов source-first/failed-summary, но timer-кейс RED — до его квалификации удалять нельзя |
| `src/state/handoffTranscript.ts` | в `src` нет вызывающих; `buildHandoffTranscript` используют только 5 кейсов `test/engines.test.ts` (строки 84–154) | эти 5 кейсов вынести/удалить вместе с модулем: передача расшифровки между движками — retired premise (один runtime; ветвление — `forkSession` runtime). Видимая провенанс-плашка старых передач (`prefs` origin → `ChatView`) остаётся и не зависит от модуля; первые 4 кейса `engines.test.ts` сохраняются |
| `src/App.css`, `src/assets/react.svg` | шаблон Vite, нигде не импортируется | нет поведения |
| `test/image-context-opencode-policy.test.ts` | проверяет мёртвый `access-policy.mjs` | удалить вместе с ним; доверенный контекст — `pi-shared-tools` (+3 кейса) |
| `src/api/events.ts` + `test/events.test.ts` case0 | OpenCode SSE | `test/runtime-stream-framing.test.ts`; case1 — retired premise |
| `test/model-hub.test.ts` case4 (оконная часть) | | `test/model-hub-inspect.test.ts`; runtime-часть открыта (§5.2) |

Ранее предложенные `agent/promptPolicy.ts`, `agent/toolWorkflow.ts`, `workshop/policy.ts`
остаются в прежнем предложении без изменений.

## 8. Оставшиеся пробелы и ограничения (честно)

- Ничего не компилировалось и не запускалось; новые тесты могут потребовать правки фикстур на Mac.
- `src/state/store.ts` прочитан ≈85 % (участки 100–1830, 1830–2700, 2780–3260, 3380–конец);
  остаток (≈2700–2780, 3260–3380) — только через поиск вызывающих.
- `src/styles.css` — целевое чтение (индикаторы сайдбара, обрезка заголовков), не полностью.
- Большинство `test/**` не перечитывались построчно: проверялся дрейф только у тестов,
  импортирующих изменённые модули (поиск импортёров); они помечены в реестре.
- Бинарные фикстуры/иконки (`*.png`, `source-archive.zip`) исключены как бинарные.
- Матрица: runtime-разрывы 1, 2, 3, 5 вне домена UI и остаются открытыми.
