# TASK — 2026-11-12: honest stale state + immediate history / 2.0.74

Владелец: Remote «ужасно синхронизируется»: Mac offline хотя открыт, Мастерская
грузится долго, stale queue показывает вчерашнее. Live: установлен72, 73 waiting;
Runtime не heartbeat с14:42, Hub detail 15ч. В 72 optional updates.control awaited
до core sync (исправлено73 background+watchdog, ещё не применено).
74: Hub session старше30с возвращает stale=true; messages остаются last snapshot,
queue/questions/permissions очищаются, status unknown. UI «нет связи» вместо
«офлайн», banner, не рисует stale queue и убирает непонятную фразу.
Browser selection сначала detail, затем overview long-poll: загрузка fixture 27мс
(было >20с); offline banner, old queue absent, JS errors0. History cache by
record.updated (тест поймал ошибочное time.updated) — нет повторного чтения100
сообщений в idle. Snapshot4, transport2, integration2, Hub stale test PASS.
Hub CT206 обновлён, live stale queue sanitized. Нужен source release74+apply для
восстановления heartbeat и свежего detail.
# TASK — 2026-11-12: model identity + Remote liveness / 2.0.73

Владелец: «Kimi K3.1 Pro работает, но доступ не подтверждён», после refresh
модель исчезла. Причина UI: selection identity использовалась как entitlement
наблюдение; unknown/неconnected скрывались, fallback звучал как отказ. Добавлен
withCurrentSelection: выбранная модель всегда остаётся строкой «Текущая модель»
с честной пометкой, без подмены; fallback только имя. Другие unconfirmed скрыты.
Picker 4 PASS, build PASS.
Live 2.0.72 обнаружил Remote dead с14:42 (Hub revision62/detail0). Причина:
optional updates.control awaited before core sync; native updater после auto
restart может зависнуть и блокировать весь LAN relay. Статус обновлений теперь
fire-and-forget, не гейтит sync. Sync watchdog 30с generation-fence перезапускает
зависший bridge tick; backoff сохранён. transport2+detail3+integration2 PASS,
typecheck PASS. Нужен release/apply и live проверка свежего detail.
# TASK — 2026-11-12: versioned Remote sync architecture / 2.0.72

После 2.0.71 live Workshop detail всё ещё стар (40кс), overview свежий. Раздельные
requests позволяли такому противоречию. Runtime разделён: remote/snapshot.ts
(read-only live envelope+history bound), remote/sync.ts (single atomic request,
watch, commands, 1s/backoff/reconnect), remote.ts command adapter. Больше нет
второго optional detail request. Hub additive migrations revision/detailRevision;
overview+detail одной SQLite transaction; unchanged heartbeat freshness без
revision increment. Browser remote-sync.js sole scheduler, AbortController при
selection, visibility, non-overlap; overview long-poll since revision до20с,
detailRevision skip unchanged. WebSocket не добавлен: pinned HTTPS/LAN сохранены,
long-poll даёт push и простое восстановление без нового порта/executor.
Tests: agent typecheck PASS, remote detail3+integration2 PASS; Hub revision
atomic/longpoll wakeup, полный suite перед release. Browser mobile fixture live
queue add/remove без refresh, JS errors0; steady revision change 54ms.
Hub CT206 backup integrity ok, migrated/deployed, live revisions visible. Runtime
72 нужен для атомарного watched detail и устранения stale Workshop queue.
# TASK — 2026-11-12: Remote stale queue / 2.0.71

Владелец прислал phone screenshot: Workshop idle, но старое «В очереди: Это
приложение нельзя установить». Live Hub remote_detail updated=1794433819826
(часы назад), queue sending; локальная SQLite queue уже пуста. Commands по item:
несколько rejected Hub HTTP502 и final cancelled. Значит UI показывал stale cache,
не живую задачу. Overview продолжал обновляться, detail watched Workshop — нет.
RemoteControl.detail теперь формирует live envelope независимо от history;
fitRemoteDetail <=3.5MiB: text/reasoning/tool bounds, recent messages, явный
historyError, ошибка historyPage не блокирует queue/status/questions. Полная
локальная история не меняется. Browser маркирует snapshot queue >20s как stale.
Новые remote-detail 3 PASS (1000 large messages; pathological parts; small);
existing remote integration 2 PASS; Hub135 PASS. Static stale UI установлен на
CT206; требуется новый Runtime для обновления живого detail.
# TASK — 2026-11-12: Remote PWA trust + session sync / 2.0.70

Владелец: «приложение нельзя установить», смена сессии оставляет Мастерскую.
Live Chromium CDP: manifest errors=[], icons/start_url валидны, но installability
not-from-secure-origin; SW register: SSL certificate error fetching script.
Причина — self-signed Hub TLS, bypass browser warning не даёт доверенного HTTPS.
Добавлены install sheet с точной диагностикой, platform steps, public cert
`/remote-certificate.crt`, SHA256 и повторная проверка; native prompt errors
не остаются молчаливыми. Нельзя обойти secure-context требование.
Sync: selection token+device/session guards, старая история сразу скрыта,
loading; последовательный scheduler без overlap, visibility pause/resume,
manual ↻, online/команда refresh. Независимые message/question/queue signatures
сохраняют ввод ответа; session list перерисовывается только по изменениям;
scroll и draft исходной сессии сохраняются. Fixture две сессии: переключение
обе стороны + задержанный old detail 1.5s, final title/messages первой верны.
Mobile 390×844 main/install screenshots проверены. Hub 135 PASS. Live CT206
assets установлены, certificate mode 0644 после выявленного EACCES и bytes OK.
# TASK — 2026-11-12: Remote PWA / 2.0.69

`/remote` превращена в PWA: manifest standalone, иконки PNG 192/512 и Apple 180,
service worker `/remote-sw.js`, install action (native beforeinstallprompt;
iOS инструкция Поделиться→На экран Домой), safe mobile UI сохранён.
SW кэширует только shell, network-first; API/downloads/чаты/команды/ASR не
кэшируются. Офлайн открывается shell и честный статус, не снимок истории.
Hub server отдаёт manifest/icons/worker с корректными MIME, shell no-cache;
LAN/no-auth контракт не менялся. Hub 135 PASS. Browser: SW activated scope=/,
offline reload title Enki/Нет связи, cachedApi=false. Live CT206: все PWA routes
HTTP200. Документация REMOTE-CONTROL обновлена. Релиз канонической доставки.
# TASK — 2026-11-12: mobile-first Remote UI / 2.0.68

По отзыву владельца заменена трёхпанельная страница `/remote` на мобильный
single-column UI: компьютер в topbar, текущая сессия, чат и закреплённый composer.
Выбор сессии — bottom sheet с поиском по названию/проекту, фильтрами Все/
Работают/Ждут ответа/Мастерская, статусами и датами. Touch targets ≥44px,
safe-area, 16px controls против iOS zoom, растущий textarea, backdrop close.
Модели: доступные только при настроенном провайдере и access.state=available;
unknown/unavailable/unconfigured полностью скрыты и в настройках тоже.
Живая проверка fixture в браузере: основной экран, sheet, поиск без совпадений,
prompt; отдельный isolated mobile viewport 390×844 (main+sessions screenshots
в .local); после добавления unavailable/unknown/off моделей selector содержит
только доступную Qwen. Hub 134 PASS; обновлённые статические файлы установлены
на CT206. Runtime/протокол не менялись. Релиз для канонической доставки исходников.
# TASK — 2026-11-12: LAN Remote Control + remote updates / 2.0.67

Страница Hub `/remote`: все активные сессии всех устройств, включая Мастерскую
(badge); live история/инструменты, промпт/диктовка GigaAM, stop, вопросы и
разрешения, новая сессия+первый промпт, модели/настройки. Обновления на устройстве:
check, prepare (source→build, hot→download), apply (source→install, hot→activate).
Apply планируется после ответа broker (750мс), поэтому собственный permit не
блокирует idle; далее штатные maintenance/idle/backup/signature/installer.
Никаких аккаунтов/регистрации/токенов Hub по прямому поручению; LAN subnet gate,
HTTPS certificate и подписи пакетов остаются. Hub только relay, не agent loop.
2.0.66 был опубликован до уточнения, но не применялся; 2.0.67 его заменяет.
Проверки предыдущего среза: agent492/UI1300/Hub134/runtime106/releases30 PASS,
build/arch/docs/bundle PASS. Новые update transport интеграционно PASS; Rust
remote operation mapping PASS; clippy/fmt PASS. Живой Hub и ASR HTTP200;
браузерный fixture + стабильные клики + prompt queue PASS. После релиза —
реальный Mac/Мастерская и применение; телефонный микрофон отдельно владельцем.

# TASK — 2026-11-12: LAN Remote Control / 2.0.66

По поручению владельца реализована страница Hub `/remote` без входа,
регистрации и токенов; Server.verify_request по-прежнему ограничивает доступ
loopback/192.168.31.0/24, WAN не добавляется. Hub — только relay снимков и
команд; единственный исполнитель — существующий Runtime на каждом устройстве.
Runtime remote.ts каждые 2с синхронизирует устройства/проекты/сессии/статусы/
модели/настройки и наблюдаемую сессию; команды идемпотентны, повтор delivered
после потери ACK возвращает сохранённый результат. Поддержаны новый чат+первый
промпт, prompt/queue, stop, model.set, compact, вопросы/разрешения, settings,
queue pause/resume, refresh providers. Отдельная консоль Hub также без входа.
Диктовка: MediaRecorder → Hub multipart ≤25MiB → существующий GigaAM CT201 →
текст в черновик без автоотправки; аудио не хранится Hub.
Токены Hub удалены из нативного request/release/catalog/setup пути; HTTPS origin,
сертификат и подписи пакетов сохранены. Старые поля ключей wire-совместимы.
Тесты: agent 492 PASS, UI 1300 PASS, Hub 134 PASS, Rust 297 PASS,
runtime-artifact 106 PASS, releases 30 PASS; build/arch/docs/bundle/clippy/fmt
PASS. Живой Hub CT206 обновлён с SQLite backup и active; `/remote`, overview,
no-auth API и ASR через Hub проверены HTTP200. Страница проверена в браузере с
fixture: устройство/сессия/ответ/tool, стабильные клики и prompt→queued.
После применения нужен живой прогон реального Mac Runtime и микрофона телефона.

# TASK — 2026-11-12: Windows long-path build failure / 2.0.65

Отчёт владельца: кнопка «Собрать на этом компьютере» на Windows падала с
LNK1104 — ссылщик не открывает build_script_build .exe под глубоким путём
update-runtime\build-<sha>\attempt-<id>\... (262+ символов > MAX_PATH).
Изменено (по доказанному владельцем рецепту + сверх него):
1) scripts/runtime/prepare.mjs: на Windows bootstrap доверенного runner
   компилируется в %TEMP%\enki-build-runner, рабочее дерево runtime — в
   %TEMP%\enki-runtime-build\work-*; Unix без изменений.
2) stageForPromotion(): внешний артефакт переносится (rename того же тома)
   или копируется и ПОВТОРНО проверяется verifyArtifact в приватный staged-
   каталог внутриowned-корня, затем штатный журналированный promote();
   отказ не трогает current/previous. promote() по-прежнему принимает только
   потомка artifact root.
3) build.rs: CARGO_TARGET_DIR основного компилята на Windows — короткий
   %TEMP%\enki-native-target-<digest> (шарится между попытками одного digest
   для кэша зависимостей), artifact() ищет пакет там же; Build::clear()
   чистит эти папки. Офф-Windows поведение не изменилось.
4) failure_detail: в сообщение об ошибке попадают до 3 последних решающих
   строк (runtime:prepare:, npm error, error:, fatal error LNK) вместо одной
   — LNK1104 с путём виден в UI, не только Some(1); полный журнал — build.log.
Тесты: runtime-artifact 106 PASS (новые: выбор коротких roots по платформам,
внешний staged promote, copy-on-cross-volume + отказ при изменённых байтах),
Rust 296 PASS, clippy -D warnings и fmt чистые, UI 1300 PASS (ci-artifacts
падает только без ~/.cargo/bin в PATH — окружение, не продукт).
Не покрыто живым Windows-прогоном из этой среды: фактическая сборка кнопкой в
стандартном профиле Windows подтверждается только на машине владельца.

# TASK — 2026-11-12: compaction when the model is out of quota / 2.0.64

Сценарий владельца: платная модель 1M исчерпала лимит (429), переключение в
локальную 262K требовало сжатия ИСХОДЯЩЕЙ моделью → тупик и россыпи 429
(SDK сам ретраит 429 трижды — это и были повторы на скриншоте).
Реализовано в worker.fitTarget: мини-пробирование доступности исходной модели
(крохотный запрос, только известные API; unknown не блокирует попытку) и
классификация ошибки компакта. При quota/auth/unreachable — вопрос через штатный
broker: сжать историю ближайшей моделью ДРУГОГО настроенного провайдера,
вмещающей весь контекст (для Kimi → deepseek-flash 1M). Приняли — lease+select
альтернативы, компакт, проверка fit, переход; отказ/Stop — штатный отказ,
исходная модель и история целы; резидентность возвращается исходной модели.
Диалог «Подготовка модели» показывает текст ожидающего вопроса и кнопку
«Перейти к вопросу» (закрытие не отменяет операцию в Runtime).
RuntimeSettings.retry — явный переопределяемый retry (по умолчанию как был).
Тесты: agent 490 PASS (availability.test.ts + интеграция
transition-quota-fallback: принятие и отказ на настоящем SDK-цикле), UI 1299 PASS
(падение только известное окруженческое ci-artifacts), build/arch/docs/bundle PASS.
Не покрыто этой нарезкой: предложение для обычной реплики (не сжатия), для
кнопки «Сжать сейчас»; handoff_required пока не предлагает альтернативу.
Далее: релиз 2.0.64 и применение штатным desktop_updates (постоянное поручение).

# TASK — 2026-11-11: auto-apply prepare re-check / 2.0.63

При применении 2.0.62 через штатный desktop_updates (MCP --agent-mcp, клиент
.local/updates-mcp.mjs) prepare не делал повторный check после прежнего
«Установлена актуальная версия»: релиз обнаруживался только плановой проверкой
watchUpdateChecks (5 мин). Исправлено: prepare проверяет Hub всегда, когда
release?.available !== true. Тест agent-control-updates: повторный prepare
после available:false делает новый check и видит 2.0.99.
UI 1298 PASS, ci-artifacts 1 fail (среда), build/arch/docs PASS.
Далее: release 2.0.63, status до available 2.0.63, prepare до stage=ready,
apply последним действием (прямое поручение владельца обновить приложение).

# TASK — 2026-11-11: режим небольших локальных моделей / 2.0.62

Поручение владельца: выполнить P0–P5 самостоятельно, проверить, выпустить и
обновить приложение.
P0: compactionBudget.triggerRatio; для провайдеров local-* по умолчанию 0.68
(LOCAL_COMPACTION_TRIGGER_RATIO), явная настройка compaction.triggerRatio важнее.
P1+P3: policy/compact.ts — короткие блоки workflow/quality/wait/schedules,
обязательный план 2–4 пункта и проверка перед «готово»; язык и workshop полные.
Выбор по ctx.model.provider в before_agent_start (ctx опционален для тестов).
P2: policy/tool-output.ts + расширение enki-local-tool-output: bash/powershell
head 4000 + tail 6000, границы строк, ссылка на fullOutputPath SDK.
P4: уроки/навыки уже в 2.0.56–58, тесты проходят.
P5: стенд scripts/evaluations существует; eval:check PASS. Задокументирован
протокол до/после; стенд меряет ядро SDK без слоёв Enki — прирост качества на
живых задачах НЕ измерен.
Проверки: agent 483 PASS (включая integration/local-model-harness на реальном
SDK: компактный промпт и head+tail у local-scripted, полный промпт у cloud),
UI 1297 PASS, ci-artifacts 1 fail (среда rustc PATH), build/arch/docs/bundle PASS.
Следующее: release:local stable 2.0.62, затем применение обновления по прямому
поручению владельца (штатный desktop_updates в этой сессии недоступен).

# TASK — 2026-11-10: скрытый содержательный ответ / 2.0.61

Дефект (скриншот владельца): развёрнутый разбор написан до последнего bash,
на экране осталась только финальная фраза — шаг с текстом был свёрнут в «Ход работы».
Факт: AssistantTurnView показывал без раскрытия только последний шаг/ошибки.
Сделано: wroteAnswer (!summary && answerText(parts)) — шаг, где ассистент написал
текст, всегда виден; tool-only шаги по-прежнему свёрнуты и монтируются лениво;
внутренние сводки сжатия остаются скрытыми.
Тесты: новый кейс «substantive answer visible when the model calls a tool
afterwards», turn-render обновлён под контракт без ослабления (ленивый монтаж
проверяется на tool-only шаге). UI 1297 PASS, ci-artifacts 1 fail (среда).
Следующее: release:local stable 2.0.61. Автоприменение не выполняю.

# TASK — 2026-11-10: «статус не подтверждён» у инструментов / 2.0.60

Поручение: подобные ошибки не должны возникать — исправить системно.
Факт: render.tsx считал connected как streamState === "open", поэтому ЛЮБОЕ
переподключение (даже 1 с) помечало каждый незавершённый вызов
«статус не подтверждён: нет связи», хотя агент работал.
Сделано: единый grace-период (streamStalled, 5с) применён к свидетельствам
инструментов через useConnectionStalled (селектор соединения, не store.state —
тесты не ломаются). Тест execution-evidence (3) + turn-render обновлён под
новый контракт: свежий разрыв → «выполняется», затяжной → «нет связи»,
завершённый инструмент без статуса.
UI 1296 PASS, ci-artifacts 1 fail (среда), build/architecture PASS.
Следующее: commit → release:local stable 2.0.60. Автоприменение не выполняю.

# TASK — 2026-11-09: конфликт каталога данных Kimi / 2.0.52

Причина воспроизведена на этом Mac: `~/.local/share/enki` содержит полные данные
Enki (6.8 GiB), а `opencode-desktop` содержал только 948-byte `helper-tunnel.sh`.
`migration::resolve_named` считал оба каталога базами данных и блокировал config/vault.
Установщик сам создавал этот ложный конфликт, записывая tunnel helper в старый каталог.

Исправлено: установщик кладёт скрипт в `~/.local/share/enki`; миграция игнорирует
старую папку только если там ровно один regular file, имя `helper-tunnel.sh`, bytes
в точности совпадают с bundled `services/helper/tunnel.sh`. Иначе прежний fail-closed
конфликт. Это сохраняет данные и не обходит настоящую защиту миграции.
Тесты `cargo test migration::tests::helper_tunnel` 2 PASS; `cargo fmt --check`,
`git diff --check`, `sh -n` PASS.
На Mac создан backup в `~/.local/share/enki/recovery/legacy-tunnel-migration-20261109/`;
LaunchAgent перенесён на enki path, старый каталог удалён, config/runtime/sessions intact.
Изменения диктовки присутствовали до задачи; не тронуты.
Следующее: полные release gates в изолированном worktree, Hub publish/receipt, штатная
установка и проверка чтения конфигурации. SSH helper tunnel всё ещё не коннектится:
`ssh pve` → unknown host; это отдельный endpoint, не причина двух-каталоговой ошибки.
# TASK — 2026-11-10: зависший индикатор «работает» / 2.0.59

Поручение: у сессии Mash крутится лоадер, Stop «нажимается, но ничего».
Факты: рантайм idle с 17:35:33 (session.outcome completed + session.idle),
очередь armed:false без причин, команд running нет — работа не идёт, завис UI.
Причина: сверка статусов при переподключении учитывала только busy/retry, а
статус waiting (он тоже рисует спиннер) не перепроверялся и сверка шла только
при открытии стрима.
Сделано: state/sidebar activeStatusIds (busy/retry/waiting в каталоге),
reconcileBackgroundActivity использует её, плюс периодическая сверка каждые
20с, пока есть статусы, обещающие работу. Тест active-status 1 PASS.
UI 1295 PASS, ci-artifacts 1 fail (среда), build/architecture PASS.
Следующее: commit → release:local stable 2.0.59. Автоприменение не выполняю.

# TASK — 2026-11-09: агент создаёт навыки сам / 2.0.58

Поручение: система должна создавать себе скиллы; сильная модель оставляет
метод, слабая потом выполняет то же легко.
Сделано: skills/learned.ts saveLearnedSkill (slug, frontmatter, ≤8000, нет
секретов), инструмент create_skill в enki.ts, рантайм пишет в
data/skills/learned/<name>/SKILL.md и включает этот путь в skillPaths — навык
виден следующим ходам автоматически. Это текст, не исполняемый код.
Тесты: learned-skills 3 PASS (валидная запись, отказ traversal/длины, обновление
того же навыка); агент 470 PASS, UI 1294 PASS, ci-artifacts 1 fail (среда).
Документация CAPABILITIES.md «Навыки, созданные агентом».
Следующее: commit → release:local stable 2.0.58. Автоприменение не выполняю.

# TASK — 2026-11-09: автоматический урок при падении хода / 2.0.57

Поручение: продолжать самоулучшение до готовности системы. Срез: урок пишется
даже без вызова remember_lesson моделью. Сделано: lessonFromOutcome (только
failed + known reason: no_answer/length/terminated/error; никаких сырых
ошибок провайдера), LessonStore.addIfNew (дедуп по тексту), Runtime.onSettled
при failed добавляет урок в каталог сессии. Тесты: lessons 4 PASS (маппинг,
не-failed не учится, дедуп). Агент 467 PASS.
Следующее: commit → release:local stable 2.0.57. Автоприменение не выполняю.

# TASK — 2026-11-09: самоулучшение агента (уроки) / 2.0.56

Поручение: агент должен учиться на ошибках и не повторять их, в духе Harness²,
но нативно в Enki. Сделано: store/lessons.ts (SQLite, trim 500, 50 на каталог,
5 в промпт), инструмент remember_lesson (после исправленной ошибки/поправки),
внедрение enki-lessons-v1 в системный промпт как советы, не новые инструкции.
Зависимость опциональна, тестовые сессии не затронуты. Документация
PROJECT-MEMORY.md «Самоулучшение агента».
Тесты: lessons 2 PASS (границы/порядок/пустой), turn-policy/project-tools PASS
после опциональности, агент 465 PASS, UI 1294 PASS, ci-artifacts 1 fail (среда).
Следующее: commit → release:local stable 2.0.56. Автоприменение не выполняю.

# TASK — 2026-11-09: PDF не превращается в «файл не прикреплён» / 2.0.55

Поручение: PDF разваливался на картинки, модель отвечала «файл не прикреплён».
Сделано: attachments/prepare.ts — validateConverted (пустая конвертация → отказ;
скан без текстового слоя + модель без изображений → понятный отказ до отправки)
и conversionSummary: модель всегда получает имя файла, тип, есть ли текстовый
слой и список страниц. Прямое прикрепление PDF при input.pdf сохранено.
Тесты: attachment-conversion 3 PASS; npm test 1294 PASS, ci-artifacts 1 fail
(среда). Следующее: commit → release:local stable 2.0.55. Автоприменение нет.

# TASK — 2026-11-09: очередь вечно «ждёт следующего шага» / 2.0.54

Поручение: уточнение висит «ждёт следующего шага», агент ничего не делает.
Диагноз: runtime-коррекции пусты (queue.updated: items:[], corrections:[]),
значит, ядро уже отработало, а UI держит старое состояние. Причина: после
завершения хода никто не публиковал queue.updated — клиент не узнавал, что
коррекции сняты. Сделано: PromptQueue.notify(sessionID, directory) (публичная
публикация текущего вида, включая пустое), Runtime.onSettled вызывает её после
queue.onSettled. Тест queue-unit: notify публикует пустое состояние (снятие
старого уточнения), null-каталог ничего не публикует. 13 PASS.
Агент 463 PASS, UI 1291 PASS, ci-artifacts 1 fail (среда).
Следующее: commit → release:local stable 2.0.54. Автоприменение не выполняю.

# TASK — 2026-11-09: циклические обрывы стрима + ложный «unconfirmed» / 2.0.53

Поручение: баннер «связь прервалась» появляется/исчезает снова и снова; при
выборе другой сессии лоадер меняется на перечёркнутый значок.
Причина 1 (server/http.ts): при backpressure первый write ставил blocked, а
следующий write закрывал стрим (`if (blocked) close()`), вместо ожидания drain —
отсюда обрыв/реконнект/реплей по кругу. Сделано: очередь pending + flush на
drain, закрытие только при переполнении бюджета или долгом stall (30с);
keepalive больше не пропадает при blocked (ставится в очередь).
Причина 2: liveStatusConfirmed требовал открытый стрим именно текущей папки или
global — при переключении чата значок падал. Сделано: sessionStatusConfirmed
= connected && !stalled && нет statusError для текущей папки; выбор вкладки
не влияет.
Тесты: event-stream-backpressure 2 PASS (очередь+drain, закрытие по бюджету),
sidebar-status 3 PASS; агент 462 PASS, UI 1291 PASS, ci-artifacts 1 fail (среда).
Следующее: commit → release:local stable 2.0.53. Автоприменение не выполняю.

# TASK — 2026-11-09: PDF без помощника + откат сломавшей ASR предпроверки / 2.0.52

Поручение: «не работает» — PDF «Load failed» и ASR «фрагмент повреждён».
Что было: моя decodeAudioData-предпроверка ломала запись (WebKit) — отменена;
вместо неё: пре-ролл не создаёт сегмент, если в нём только заголовок
(bytes<=2048) — именно такие фрагменты давали ASR 400 (EBML header).
PDF: помощник 127.0.0.1:18107 недоступен (curl refused), LaunchAgent туннеля
не был установлен; установлен services/helper/install-tunnel.sh, но SSH-алиас
pve отсутствует в ~/.ssh/config — поэтому сделан ЛОКАЛЬНЫЙ путь:
attachments/pdfLocal.ts (pdf.js legacy, текст + JPEG страниц, ≤30 страниц,
doc.cleanup), prepare.ts при ошибке помощника для pdf конвертирует локально.
Тесты: pdf-local (настоящий test/fixtures/hello-enki.pdf) PASS; asr/voice 18 PASS;
npm test 1289 PASS, ci-artifacts 1 fail (среда). Версии уже 2.0.52.
Следующее: commit → release:local stable 2.0.52. Автоприменение не выполняю.
Ограничение: живой UI не наблюдал; SSH-алиас pve на Mac отсутствует —
помощник по-прежнему недоступен, но PDF работает локально.

# TASK — 2026-11-09: ошибка помощника PDF вместо «Load failed» / 2.0.51

Поручение: вложение Lenovo RD450X.pdf с ошибкой «Load failed».
Диагноз: это сырой WebKit-отказ fetch до помощника (127.0.0.1:18107) —
service/SSH-туннель недоступен (curl: connection refused). UI показывал его
как есть. Сделано: attachments/helper.ts helperTransportError — сетевая ошибка
становится «Сервис подготовки файлов недоступен (endpoint). Проверьте его
запуск и SSH-туннель; исходный файл сохранён», HTTP-ошибка помощника сохраняется.
Тест: helper-error 2 PASS. Полный npm test 1289 PASS, ci-artifacts 1 fail (среда).
Замечание по прошлому релизу: 2.0.50 ушла с commit ce0f28a, а HEAD отошёл;
этот релиз — один коммит, 2.0.51. Автоприменение не выполняю.

# TASK — 2026-11-09: ASR 400 от битого аудиофрагмента / 2.0.50

Поручение: частые обрывы, на скрине «ASR HTTP 400. Сервис отклонил
аудиофрагмент».
Диагноз с фактами: реальный сервис 192.168.31.59:8080 принимает валидные
wav/webm (включая 0.2с), а 400 — при непарсящемся контейнере (EBML header
parsing failed). Значит, такие фрагменты нельзя отправлять вообще.
Сделано: в voice/asr.ts перед загрузкой fragmentDecodes(blob) через
AudioContext.decodeAudioData: пустой/недекодируемый контейнер → запрос НЕ
отправляется, честное сообщение «Аудиофрагмент повреждён… звук оставлен для
восстановления», вместо 400 от сервера.
Тесты: asr-fragment (jsdom) 3 PASS (нет fetch при битом контейнере; валидный
фрагмент отправляется; NotSupportedError в Safari/WebKit НЕ блокирует запись —
иначе вся диктовка сломалась бы), asr 5 PASS, voice-input 13 PASS.
npm test 1286 PASS, ci-artifacts 1 fail (rustc PATH — среда).
Следующее: commit → release:local stable 2.0.50. Автоприменение не выполняю.

# TASK — 2026-11-09: пре-ролл диктовки — первые слова не теряются / 2.0.49

Поручение: при старте диктовки первые слова терялись — говорил во время
«подготовки записи», а они не попадали в запись.
Причина: getUserMedia (разрешение + открытие устройства, до нескольких секунд на
macOS) вызывался ПОСЛЕ подготовки журнала, а захват стартовал ещё позже; всё
сказанное до recorder.start() физически не записывалось.
Сделано: порядок — проверка сохранённой диктовки (микрофон не трогаем), затем
сразу getUserMedia и пре-ролл MediaRecorder (250 мс слайсы, буфер в памяти);
после готовности журнала пре-ролл передаётся как первый ЗАВЕРШЁННЫЙ сегмент
(SegmentedCapture.start(preroll)), а захват продолжается вторым фрагментом.
Handover ограничен 600 мс и не блокирует запись; ошибка микрофона теперь
отдельно от ошибки журнала (правильная подсказка про Конфиденциальность).
Тесты: voice-preroll (2: пре-ролл = complete-сегмент, пустой пре-ролл), voice-input
13 PASS — обновлены под новый контракт: два старта записи и две транскрипции
(пре-ролл + основная запись), проверка «не трогать микрофон до восстановления»
сохранена. Полный npm test 1284 PASS, ci-artifacts 1 fail (rustc PATH — среда).
Следующее: commit → release:local stable 2.0.49. Автоприменение не выполняю.

# TASK — 2026-11-09: обрывы «модель не дала ответа» / 2.0.48

Поручение: исключить обрывы хода, когда после инструмента и «Размышлений»
модель молчит (DeepSeek V4.1 Flash).
Причина: runOutcome помечал пустой/только-reasoning финал как no_answer без
повтора (так было задумано раньше — тесты фиксировали «никакого повтора»).
Сделано: needsContinuation (только stop без текста/инструмента; не при стопе
пользователя, ошибке провайдера или лимите длины) + одна автоматическая
продолжающая реплика внутри ТОГО ЖЕ хода (worker, без нового ledger-команды),
статус «Модель ответила без текста — прошу продолжить»; текст результата —
«даже после автоматического продолжения».
Тесты: no-answer-continuation (2) PASS; integration/turn-outcome обновлён:
пустой стоп → ровно 2 вызова и failed; reasoning-only → продолжение доводит
до ответа, инструмент и запрос пользователя не повторяются (9 PASS).
Агент 460 PASS, typecheck PASS; npm test 1282 PASS, ci-artifacts 1 fail (rustc
PATH — среда).
Следующее: commit → release:local stable 2.0.48. Автоприменение не выполняю.

# TASK — 2026-11-09: реальная квота Kimi в Enki / 2.0.47

Поручение: брать лимиты и сбросы с https://www.kimi.ai/settings/subscription.
Находка: бандл сайта пуст для API, но публичный официальный CLI Kimi раскрывает
контракт: GET <api base>/v1/usages → usages.limit5h/limit7d/monthCode/monthTotal
({usedRatio, resetAt}) + extraUsage. Реализовано: agent models/usage.ts (строгий
парсер: clamp 0..1, только известные поля, null если данных нет),
models/probe-usage.ts (creds из стора рантайма → свежий OAuth, не старый
auth.json), GET /providers/usage; клиент providerUsage; ContextMeter: блок
«Квота подписки» — 5ч/неделя/месяц·Код/месяц·всего с процентами и временем сброса,
плюс доп. квота; локальный счётчик остаётся как fallback.
Тесты: provider-usage 3 PASS (документированная форма, clamp/мусор, null);
context-meter 3 PASS (реальная квота рисуется, отсутствующее окно не выдумывается);
npm test 1282 PASS, ci-artifacts 1 fail (rustc PATH — среда).
Не проверено вживую: refresh-токен в auth.json истёк (400), а запущено 2.0.42 без
маршрута; проверка — после установки, попавер контекста на модели Kimi.
Следующее: commit → release:local stable 2.0.47. Автоприменение не выполняю.

# TASK — 2026-11-09: мимолётные обрывы стрима больше не пугают / 2.0.46

Поручение: часто висят «Нет свежих событий / Выполнение не подтверждено» и
баннер «Связь с чатом временно прервалась».
Диагноз: сервер отправляет keepalive раз в 15с и не рвёт поток при малейшей
задержке; клиент тоже считает keepalive живостью (idle 45с). Проблема — UI без
паузы показывал тревогу на ЛЮБОЕ кратковременное переподключение
(навигация/рестарт/короткий разрыв), хотя журнал догоняет пропуск сам.
Сделано: state/streamHealth.ts (streamStalled, grace 5с) + поле
connection.streamDownSince (ставится при уходе из open, сбрасывается в open);
useStreamStalled с секундным таймером; ChatView unconfirmed и баннер Composer
показывают тревогу только после grace. statusError остаётся мгновенным.
Тесты: stream-health (свежий vs затяжной простой, открытый/первичный поток,
без отметки) PASS; chat-window обновён под новый контракт — свежий разрыв
молчит и показывает спиннер, затяжной — предупреждение (не ослаблено).
Прогон: npm test 1281 PASS, ci-artifacts 1 fail — rustc PATH (среда, как на HEAD).
Следующее: commit → release:local stable 2.0.46. Автоприменение не выполняю.

# TASK — 2026-11-09: drag-and-drop сессий между проектами / 2.0.45

Поручение владельца: починить DnD сессий (macOS, 2.0.42), не автоматически
применять обновление. Найдено: источник — src/components/Sidebar.tsx, drop-зоны
там же, композитор src/components/Composer.tsx (фильтр Files есть).
Причина: HTML5 DnD ненадёжен в webview (types без .includes → drop не
разрешался; drag из кнопки не стартовал). Сделано: pointer-перетаскивание в
src/chat/sessionDrag.ts (порог 8px, hover/drop, cancel, без dataTransfer — 
композитор не реагирует), data-session-drop на проекте и «Недавние», подсветка
[data-session-drop-active], подавление клика после жеста; меню сессии
«Перенести в проект…» остаётся вторым путём.
Дополнительно: ложные значки «нет свежего статуса» — в журнале висели busy с 8.11;
рантайм при старте сбрасывает такие статусы в idle (sessions/status-reset.ts).
Тесты: session-drag 5 PASS (порог/клик, проект, «Недавние», пустая зона, cancel),
status-reset 2 PASS; ui-copy PASS (без ОС в комментариях); агент 455 PASS; полный
npm test 1280 PASS, ci-artifacts 1 fail — rustc PATH (среда).
Живая проверка: Cua/enki-control в сессии нет; osascript Accessibility
отклонён (-1728/-25211), запущено 2.0.42 без правки, обновление не применял —
реальную двустороннюю проверку в окне не выполнял, нужна после установки.
Следующее: commit → release:local stable 2.0.45 (только публикация, без apply).

# TASK — 2026-11-09: нормальный перенос сессии в проект / 2.0.44

Поручение: перетаскивание не сработало — нужен рабочий перенос. Сделано: пункт
меню сессии «Перенести в проект…» открывает модалку со списком всех проектов
и «Без проекта»; выбор вызывает store.moveSessionToProject (runtime
/sessions/:id/move + транскрипт). Это основной путь вместо DnD.
В релиз входит и отменённый ранее 2.0.43 (консоль Hub) — версия поднята до
2.0.44, чтобы не смешивать недопубликованное.
Проверки: tsc/build/architecture PASS; runtime move покрыт sessions-move (3).
Ограничение: модалку вживую не наблюдал; DnD оставлен, но меню — основное.
Следующее: commit → release:local stable 2.0.44 → receipt/served/подписи.

# TASK — 2026-11-08: веб-консоль Hub / 2.0.43

Поручение: сделать Hub центром с фронтендом и страницей настройки.
Сделано: services/hub/console.html/.js/.css (тёмная страница, вход ключом через
существующий /api/login + cookie, без инлайн-скриптов — CSP); Handler раздаёт
/, /console, /console.js, /console.css; Hub.console_overview + GET
/api/console/overview: каналы stable/preview, устройства (имя/платформа/версия/
admin/revoked/seen), модельные сервисы, каталог моделей, провайдеры с кредами
(ids, без секретов). Документация HUB.md «Веб-консоль».
Тесты: Python test_console (обзор с provisioned-устройством, отсутствие токена
в ответе, целостность статики) 2 PASS.
Ограничение: страница появится после обновления Hub этим кодом; из сессии
развёртывание Hub не выполнялось. Редактирования конфига в UI пока нет —
следующий срез (каталог/сервисы с admin-ключом).
Следующее: commit → release:local stable 2.0.43 → receipt/served/подписи.

# TASK — 2026-11-08: единая точка истины моделей на Hub / 2.0.42

Поручение: все модели и их настройки/креды — на Hub, доступны на любом
устройстве владельца. Важно: публичный каталог Hub намеренно не хранит секреты,
поэтому сделан отдельный приватный канал, а не ключи в каталоге.
Сделано: model-services.json поддерживает credentials (api_key/oauth,
валидация, только приватный 0600 файл); POST /api/model-services/credentials
отдаёт один кред аутентифицированному устройству (404 если нет). Enki:
HubLeases.credential(), adoptProviderCredentials (только если в vault пусто,
imported только при реальной записи), adoptHubCredentials при старте
vault-хоста + refreshCredentialSnapshot без перезапуска.
Тесты: Hub Python 2 PASS (отдача, 404, отсутствие ключа в каталоге, 503 на
битом креде), import-credentials 5 PASS (включая «vault важнее»), typecheck PASS.
Следующее: commit → release:local stable 2.0.42 → receipt/served/подписи.
Ограничение: сам Hub нужно обновить этим кодом и прописать credentials в
его model-services.json — операторский шаг, из этой сессии не выполнен.

# TASK — 2026-11-08: создание проектов, перенос сессий, контекст проекта / 2.0.41

Поручение: создавать проекты без готовой папки (сам создаёт), единый корень,
перетягивать сессии в/из проекта, общий контекст проекта без раздувания.
Сделано: POST /projects/create (папка ~/enki-projects/<имя>, EEXIST=409);
POST /sessions/:id/move — registry.moveToDirectory: отказ при busy/retained,
recycle воркера, moveSessionTranscript в шард целевой папки (без перезаписи,
только собственный шард), catalog.rehome; вне проекта — собственная папка
prepareChatWorkspace(UUID). UI: «Создать проект» в сайдбаре (форма имени),
DnD сессии на проект или в «Недавние», ошибка переноса показана в сайдбаре.
Контекст: enki-project-v1 блок в системном промпте (папка + названия до 8
соседних чатов), projectless не получает блок. docs/WORKSPACES.md обновлён.
Тесты: sessions-move (3) PASS; агент 452 PASS + typecheck; UI tsc/build PASS;
npm test 1275 PASS, ci-artifacts 1 fail — rustc PATH (среда, как на HEAD).
Ограничение: живой DnD не наблюдал в окне; проверка по коду и unit-тестам.
Следующее: commit → release:local stable 2.0.41 → receipt/served/подписи.

# TASK — 2026-11-08: сборка обновления не падает от временной 504 / 2.0.40

Поручение: «Собрать на этом компьютере» падает, при возврате из чата снова
кнопка сборки. Диагноз по скриншоту и логу: runtime:prepare не смог скачать
ripgrep-15.2.0-aarch64-apple-darwin.tar.gz с github.com — HTTP 504. Состояние
контроллера не теряется (native status + singleton), останавливается именно
сборка: download() давал лишь 3 попытки за ~1.5с на временные ошибки.
Сделано: ограниченный экспоненциальный бэкофф в scripts/runtime/prepare.mjs
download(): maxAttempts=7, задержка 500мс*2^attempt (cap 20с, суммарно ~31с),
не-transient ошибки по-прежнему фатальны сразу, abort сохраняет поведение.
Тесты: контрактный тест обновлён (7 попыток при вечном TypeError), добавлен
тест «короткий GitHub-outage больше не роняет сборку» (5×504, успех на 6-й).
node --test scripts/runtime/prepare.test.mjs: 23 PASS / 1 skip (Windows-only).
Следующее: commit → release:local stable 2.0.40 → receipt/served/подписи.
Ограничение: при длительном (>~30с) отказе сети ошибка остаётся честной;
автоповтора сборки не добавлял.

# TASK — 2026-11-08: контекст вопросов агента / 2.0.39

Поручение: вопросы не должны приходить «из ниоткуда» — пользователь, не следивший
за работой, должен понимать, что сделано и о чём спрашивают.
Сделано: в инструменте question появилось поле context (2–4 предложения: что уже
сделано и зачем нужен выбор; лимит 2000), options.description — последствия и
плюсы/минусы, рекомендуемый вариант; DTO протокола и UI QuestionInfo дополнены;
questionProblem валидирует контекст; askQuestion больше не выбрасывает его из DTO
(найдено ревью); QuestionCard показывает контекст над вопросом и объективную
строку «Перед вопросом агент выполнил N действий, последнее — X» из текущего хода.
Тесты: questionProblem (контекст), askQuestion сохраняет context в question.asked,
currentTurnActivity (только текущий ход, последний инструмент, пусто без действий).
Агент: 449 vitest PASS, typecheck PASS. UI: turns 6 PASS, tsc PASS, build PASS.
Полный npm test 1275 PASS; ci-artifacts 1 fail — rustc PATH (среда, как на HEAD).
Следующее: commit → release:local stable 2.0.39 → receipt/served/подписи.
Ограничение: живой вопрос в UI не наблюдал; эффект для слабых моделей зависит от
их следования инструкции — автоматическая строка действий не зависит.

# TASK — 2026-11-08: месячный расход/лимит рядом с контекстом / 2.0.38

Поручение: показать месячный лимит рядом с контекстом, чтобы было понятно,
сколько ещё можно тратить. Важное: провайдер Kimi квоты не публикует (404 на
всех эндпоинтах, нет rate-limit-заголовков, SDK квот не знает), поэтому
проценты только от введённого владельцем лимита — никаких выдуманных цифр.
Сделано: usage/windows.ts (месячный расход по провайдеру из фактов Enki,
resetAt=1-е число, limitPercent только при положительном лимите), accounting
loadUsageCache без цен, prefs.monthlyLimits + store.setMonthlyLimit,
ContextMeter: блок «Месячный расход · провайдер» (токены с 1-го, сброс,
остаток+прогресс при лимите), ввод лимита, чип «Месяц NN%» рядом с контекстом
только при заданном лимите. Сброс устаревших данных при смене модели.
Тесты: usage-windows (3) и context-meter (2, включая новый сценарий) PASS;
полный npm test 1274 PASS, ci-artifacts 1 fail — rustc PATH (среда, на чистом
HEAD то же). build/architecture/bundle/typecheck PASS.
Следующее: commit → release:local stable 2.0.38 → receipt/served/подписи.
Живой UI не наблюдал (нет доступа к окну); проверка компонентная.

# TASK — 2026-11-08: подписка Kimi становится выбираемой в Enki / 2.0.37

Поручение: сделать выбор моделей Kimi доступным в Enki (подписка оформлена в CLI).
Диагностика: models.json/agentDir в порядке и SDK резолвит kimi-coding (6 моделей,
OAuth). Причина в другом: Enki передаёт свой стор кредов (vault), а SDK при этом
НЕ читает agentDir/auth.json (`options.credentials ?? DefaultAuthStorage`) — токен
подписки, записанный CLI, приложению невидим, провайдер без кредов скрыт.
Сделано: adoptAgentDirCredentials — при старте vault-хоста недостающие креды из
своего auth.json усыновляются в хранилище ОС только для известных Enki
провайдеров; vault всегда важнее, файл не меняется, битый/отсутствующий файл
не блокирует старт; после импорта провайдеры пересобираются без перезапуска.
Рефактор: transferSecrets общий для импорта легаси-каталога и усыновления.
Проверки: агент typecheck PASS, vitest 447 PASS (+2 новых теста усыновления),
офлайн-проба: креды в vault → kimi-coding, 6 моделей, isUsingSubscription=true.
Ограничение: живьём в UI после релиза не проверял — нужен старт рантайма.
Следующее: commit → release:local stable 2.0.37 → receipt/served/подписи.

# TASK — 2026-11-05: очередь одно-слотовой модели видна в чате / Enki 2.0.36

Поручение: показать в чате, почему параллельный запрос к Qwen Flash Next молчит.
Причина: strata-api обслуживает один запрос+ФИФО; Hub делит резидентность
одной модели, поэтому второй чат ждёт внутри движка без статуса.
Сделано: ModelSlotQueue (FIFO-свидетель на устройство) в рантайме, флаг
queued в InferenceProgress только для prompt-progress-v1 маршрутовHub,
освобождение слота на flush/abort/settled, в UI «Модель отвечает другому
чату» с объяснением вместо тихого ожидания; снимается при первом кадре
prefill или освобождении (опрос 500мс). Честное ограничение: трафик других
устройств локально невидим — остаётся общий текст про сервер.
Проверки: агент vitest 445 PASS, node-набор 171 PASS/1skip, inference-status
UI/parse 4 PASS, build/check:architecture/check:bundle/typecheck PASS.
ci-artifacts 1 fail — нет rustc в PATH дочерних процессов, повторено на чистом
HEAD (не моя правка). Живой UI с реальной очередью Strata не наблюдался
(нужны два параллельных хода); проверка компонентная.
Следующее: commit → release:local stable 2.0.36 → receipt+served+подписи →
desktop_updates status/prepare/apply. Операционные итоги — в .local.
Дополнение (то же задание): автопрокрутка замирала из-за detach по любому
восходящему scroll-событию — браузер сам жал scrollTop при схлопывании
блоков выше или отдавал устаревшее событие после двух быстрых записей.
Отцепление теперь только по явному намерению (wheel/клавиши/тач/скроллбар),
возврат прежнему. Регресс-тест падает на старом коде, 11/11 PASS.
Первый прогон release:local упал на гейте npm ci: getaddrinfo
registry.npmjs.org (сеть), публикаций не было; повторить с того же HEAD.

# TASK — 2026-11-05: качество длинных задач Qwen / Enki 2.0.35

Поручение: проверить ухудшение модели по чату гонок и улучшить работу агента.
Аудит: Strata engine0.1.56, NVFP4/FP8 PLE/kvint8, MTP6, tail_skip0,
pcie0.16, park-gain1024, 262144контекста; sampling1/.95/20, Medium,
max_tokens16384. Shared overrides отсутствуют. Новых ухудшающих профиль
флагов не нашли; эквивалентность качества старому движку НЕ доказана.
Чат гонок: 210K входного контекста в конце; неверные API/итерации, дефекты
на просмотренных кадрах при отчёте «roadmap выполнен». Два последовательных
синтетических запроса по3случаям: baseline и candidate отвергают ложнуюготовность;
это НЕ доказательство улучшения долгого агента. История не отправлялась как тест.
Добавлены общие требования приёмки сценария/визуального результата/API/совместимости.
Целевой turn-policy4PASS; npm run build PASS. Канонические gates/publish предстоят.
2.0.34 уже установлен: native/UI34, runtime ready, исходный чат idle сохранён.
Strata reasoning_close_retry включён после освобождения leases; при атомарной
замене потеряна группа файла, восстановлена root:strata0640. Ready/accept PASS,
watchdog active, профиль сохранён; JSON/logic черезHub2PASS.
Типы/SDK/docs PASS; синтетические ответы и аудит хранятся приватно.
Операционные данные .local/quality-audit/, .local/turn-recovery/; не публиковатьистории.
Следующее: готовность Strata/watchdog, контрольчерезHub, commit → release:local stable,
receipt+файлы+подписи → desktop_updates status/prepare/poll/apply.
GitHub packages отложены владельцем. Гонку/другие проекты не менять.

# TASK — 2026-11-05: Enki 2.0.34 / Strata reasoning-only stop

Поручение: исправить остановку и потерю UI-связи на подходящей стороне Enki/Strata.
Диагностика: 04.11 23:48:10 MSK последний SDK assistant reasoning-only/stop;
ранние tools дали facts.produced=true, ошибочный session.outcome answered.
После пользовательского хода23:54 агент снова выполнял команды; текущий ход
не останавливать/не переотправлять. Сессия b83e2411-9514-4942-94a3-47dd4a234e72.

Реализовано: last stop без текста/tool не success даже после предыдущих tools;
403 черновика → offline, один reconnect SSE, повтор того же CAS только послеhello;
повторный403 → видимая ошибка/manual retry. Поздняя ошибка offline не оживляетretry.
Целевые frontend9PASS, runtime9PASS, build/typecheck/sdk PASS на рабочем дереве.
Штатные Strata ReasoningCloseRetry4PASS в bundledPython без GPU. Включение
reasoning_close_retry разрешено владельцем, ждём освобождения Hublease (агентработает).
Полный canonical gate/publish ещё предстоит; версия34 зарезервирована вmanifest.
После коммита: dev-tools run npm run release:local -- stable, квитанция/подписи/
фактические файлы, затем desktop_updates status→prepare→poll→apply последнимдействием.
GitHub packages отложены владельцем; новых разрешений не спрашивать.
Логи .local/turn-recovery/. Ключи/владельческие истории не публиковать.

## Предыдущая работа и сохранённые ограничения
## Результат
VM5200 RTX5090/160GiB/NUMA0 проверена. Релиз v0.2.10, Control/engine0.1.56
скачаны из upstream release, проверены SHA256. Старый0.1.45.3 сохранён.
Новый Control использует собственный Python через systemd dropin.
MTP, tail_skip0, PCIe0.16,262144контекста,500W, веса и квантование сохранены.
DFlash2 для NVFP4 upstream не поддерживает; не включали. PCIe0.25 проверен,
на длинном вводе хуже; возвращён0.16. Watchdog/API/gateway active+enabled.
4контрольных сценария PASS: JSON, логика, tool-call, Vision. Это ограниченная
приёмка, не доказательство повышения/полной эквивалентности качества.
Медианы ток/с: short99.84→109.85; long52541tokens82.26→122.01;768output,
по3повтора, одинаковые prompts/settings. Warm TTFT long0.15→1.14s хуже,
полное время9.48→7.38s лучше. Результаты/ограничения services/strata/README.md.
Операционные квитанции .local/strata-upgrade/results.json, final-service.txt.
Backup/старые каталоги и инструкции отката указаны в README; ключи не печатать.

## Сохранённый контекст Enki (отдельная незавершённая работа)
Enki2.0.33/12ac06f опубликована Hub, подписи+41изменённый файл проверены,
main pushed. Mac установлен штатно через desktop_updates, после ручного
Keychain разрешения Qwen Medium ответила «Обновление работает», idle подтверждён.
Квитанции .local/releases/2.0.33-stable.json и
.local/hub-investigation/review-delivery33.json. Не перепубликовывать33.
Владелец явно отложил GitHub packages; это не блокирует Hub/local delivery.
Windows2.0.31 видит33, локальная сборка упала LNK1104/путь304символа.
Удалённого доступа Windows нет. Пользователю передано задание местной
Мастерской проверить те же исходники в C:\EnkiBuild\2.0.33; результата нет.
Штатный длинный путь сборки ещё НЕ исправлен. Windows/MSYS cleanup и
исходная причина SSE не решены. Защищённую Мастерскую/истории сохранять.

Проверки документации67файлов/208ссылок PASS; services/strata unittest7PASS,
3nginx-теста SKIP (nginx отсутствует на Mac); живой gateway VM проверен отдельно.
Обновлялся только внешний Strata: новый выпуск Enki для этого не требуется.
