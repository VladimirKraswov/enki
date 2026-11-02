# TASK checkpoint (2026-11-03, Codex)

## Текущая задача — обмен устройств / диагностика, кандидат 2.0.32
Владелец поручил изучить/собрать/установить Enki на Mac; затем до установки
добавил ревью Windows timeout, общий обмен исходниками и критическими логами,
сообщения между агентами Windows/Mac через Hub. Работать самому, без делегации.
Независимые CLI/сервисы/истории и защищённую Мастерскую не менять.

## Проверенные исходные факты
HEAD c73637a, исходная 2.0.31 уже опубликована: canonical receipt и served Hub
совпадают. e556b92 в этом Git отсутствует. На Hub Windows workshop есть только
метаданные/ошибки инструментов, без текстов/команд; preview и каталог патча
не содержат. Его ревью по байтам не выполнено. На этом Mac /Applications/Enki.app
и активного Enki не было; прежние установочные записи не доказывают текущее состояние.
Hub подключён с существующим ключом Mac, отдельно от ключа Windows. Секреты
только в ignored .local/приватных файлах и OS vault, в checkpoint не копировать.

## Реализация 2.0.32
- Hub workshop.py: immutable source changes с base/claimed commit/digest,
  адресный inbox/ACK, observed presence, критические логи по session/operation;
  без исполнения кода/автозапуска заданий, с idempotency, квотами и retention.
- npm run workshop: committed Git bytes/deletions, private durable request для
  потерянной квитанции; скачивание JSON для ревью без checkout/apply.
- hub_exchange во всех SDK-сессиях, через pinned native broker и обычный gate;
  отправитель привязан к реальной сессии, ключи не уходят в Runtime/модель.
- Ошибки tools синхронизируются до завершения ответа. Категории SSE через
  существующий native outbox, без сырых ошибок/URL/текста, scope по Hub-профилю.
- Host Bash/PowerShell fallback: default1800s, explicit timeout сохраняется;
  SDK loop, plugin overrides и исполнение/отмена SDK сохранены. Это собственная
  реализация по проверенному SDK, не cherry-pick недоступного e556b92.
- Полная инструкция: docs/WORKSHOP-EXCHANGE.md. Версии манифестов 2.0.32.

## Выполненные проверки / сервер
UI205 files/1260tests; build/bundle, docs67/208, architecture221 без циклов;
release tests30passed. Финальный runtime437passed + node171passed/1skip,
artifact100passed/4skip; Rust293passed/7ignored, Clippy/fmt прошли. После
ограничения размера tool output: typecheck и exchange runtime5passed.
Source CLI3passed; Hub119tests/2skip. Docs/architecture/diff review прошли.
Hub сервер развёрнут с парной копией кода/SQLite, integrity ok; сохранены
200sessions/44574records/11devices/741issues. Проверены idle reservations и
прежний hash сервера до замены. Итоговые server.py/workshop.py доставлены
и их хеши совпадают с исходниками; квитанции в .local/hub-investigation.
Mac32 app собран, codesign и29402 runtimefiles проверены. Изолированный
профиль/Keychain/GUI Runtime ready и native CLI exchange→Hub проверены;
проверочное приложение штатно закрыто. После последнего SDK output bound
пересобрать итоговый app и повторить manifest check перед установкой.
Dev:setup установил Node24.22.1/GH2.103.3 в .local/tools по SHA256.
Dev:run изолирует npm/Cargo/GH caches, не меняя глобальные CLI/модели.
Системные Rust/Cargo1.99.1 и macOS SDK пригодны; UI build через wrapper прошёл.

## Следующее действие / ограничения
Review/prechecks завершены; локальный commit только своего scope, release:local
stable через собственный paired-device config. Сверить canonical receipt/head/
оба подписанных пакета с commit, push этого HEAD/main и release:packages до
новых tracked-коммитов. Не считать старую квитанцию доставкой32. GitHub dispatch
требует отдельного входа владельца; gh device login подготовлен, вход не подтверждён. Сборка/установка Mac — после проверки, штатный lifecycle;
desktop_updates если доступен. Windows установленная приёмка остаётся отдельной.
Безопасное завершение Windows/MSYS descendants и причина реальных SSE-обрывов
ещё не доказаны; эвристический sweep не применять и исправленными не объявлять.
Pinned Node24.22.1 доступен в src-tauri/target/enki-agent/current/node/bin;
NODE_OPTIONS=--max-old-space-size=768, CARGO_BUILD_JOBS<=2. Никакой GPU inference
для тестов не запускать. Проверочный профиль только изолированный.

После этого checkpoint исходники/документы не менять до release:packages на
том же HEAD. Сначала проверять actual .local/releases/2.0.32-stable.json и
операционные записи: отсутствие tracked DONE не означает отсутствия квитанции.
