# Задание Windows-агенту: сборка и проверка Enki 2.0

Работай с точным свежим исходником Enki из
`https://github.com/VladimirKraswov/enki` или проверенного подписанного пакета
Hub. Собери Windows x64 NSIS, установи обновление и проверь реальное приложение.
Подтверждённые исправления отправь отдельной веткой/PR в `main`; не делай merge,
force-push или самостоятельный release. Этот документ задаёт процедуру,
**не утверждает, что Windows 2.0 уже прошёл её**.

## Исходник и границы работы

Проверь существующую копию, Git status/remotes и незакоммиченные изменения.
При чистой подходящей копии используй fetch и fast-forward свежего `main`;
при расхождении создай отдельную копию/worktree, не затирай чужую работу.
Предпочтительный новый каталог — `C:\Dev\Enki`. Зафиксируй source SHA,
фактические версии из `package.json`, lockfiles, Cargo/Tauri, ОС и архитектуру.
Не подставляй старый 0.2.x tag/минимальный commit вместо согласованного кандидата.

Прочитай `AGENTS.md`, актуальный `.pi/TASK.md`, релевантный roadmap,
[архитектуру](ARCHITECTURE.md), [платформы](PLATFORMS.md),
[обновление SDK](SDK-UPGRADE.md), [миграцию](ENKI-MIGRATION.md) и
[платформенную приёмку](PLATFORM-ACCEPTANCE.md). Старые задачи из checkpoint
автоматически не запускай.

Единственный исполняющий агент — встроенный Enki Runtime с закреплённым Pi SDK
и Node. Глобальные OpenCode/Pi CLI не устанавливай, не запускай и не обновляй;
их службы, конфигурацию и историю не трогай. Модели/Hub/ASR настраиваются через
Enki. Не меняй GPU/Proxmox, provider/model/effort или ключи ради проверки UI.

Название продукта — Enki, основной binary — `enki.exe`. Идентификатор
`dev.local.opencodedesktop`, совместимый CLI `opencode-desktop` и существующие
пространства хранилищ сохраняются для обновления. Это совместимость данных,
а не второй движок. Не создавай новый пустой профиль заменой идентификаторов.

## Toolchain и содержательные гейты

Используй точный Node из `scripts/runtime/sdk-contract.mjs` (сейчас 24.22.1),
соответствующий npm, Rust stable MSVC x64 с rustfmt/Clippy, Visual Studio C++
Build Tools/Windows SDK, WebView2 Evergreen и Git. `npm.cmd` избегает запуска
`npm.ps1` через execution policy. `scripts/check-windows-prereqs.ps1` проверяет
предпосылки; SDK-пин дополнительно проверяется `npm.cmd run sdk:check`.
Не ослабляй политики ОС/TLS и не обновляй зависимости/lockfiles без причины.

Команды ниже — текущие исходные entry points, не уже выполненный отчёт.
Выполняй последовательно, проверяй `$LASTEXITCODE` после каждой native-команды;
`$ErrorActionPreference='Stop'` не заменяет эту проверку. Остановись и сохрани
исходный вывод при сбое. Работай в собственных временных папках/фикстурах.

```powershell
npm.cmd ci
npm.cmd run sdk:check
npm.cmd ci --prefix src-tauri/resources/agent --ignore-scripts
npm.cmd rebuild --prefix src-tauri/resources/agent node-pty
npm.cmd --prefix src-tauri/resources/agent run typecheck
npm.cmd run test:runtime
npm.cmd test -- --maxWorkers=2
npm.cmd run build
npm.cmd run check:architecture
npm.cmd run test:releases
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Проверь также standalone `src-tauri/build-runner/Cargo.toml` (fmt, Clippy,
locked tests), Windows Job Object/процессы, script/Hub/ASR фикстуры и остальные
обязательные проверки из `.github/workflows/desktop.yml`. Для публичных
`test:runtime-artifact`/`native-port` подготовь раннер **из этого же дерева**
`node scripts/runtime/build-runner.mjs --out <новый абсолютный каталог>`.
Сохрани его JSON-квитанцию; выставь `ENKI_TEST_NATIVE_RUNNER` и
`ENKI_TEST_NATIVE_RUNNER_SHA256` ровно из её `path`/`sha256`, затем запусти
`npm.cmd run test:runtime-artifact`. Не подставляй установленный Enki, PATH-раннер
или произвольный бинарник. Без такого прогона Windows-only skip не является PASS.
Текущий полный CI — источник точных команд и условий, счётчики старых релизов
не эталон для подгонки. Реальные модели и пользовательские профили не нужны для
этих тестов; live сценарии ниже отмечаются отдельно.

## Первый переход 0.2 → 2.0: проверяй именно старую точку сборки

Старый установленный Enki знает `npm ci` и команду ниже, но ещё не знает
`runtime:prepare` и конфигурацию нового ресурса:

```powershell
npm.cmd run tauri -- build --bundles nsis --ci -- --locked
```

`package.json` направляет её в исходниковый `scripts/runtime/tauri-entry.mjs`.
Для build/bundle он проверяет host Node, готовит и проверяет runtime этого
исходника, затем добавляет `src-tauri/tauri.runtime.conf.json` перед Cargo `--`
и запускает закреплённый локальный Tauri CLI. Windows bootstrap сам собирает
доверенный native runner; установленный Enki с новым CLI для этого не нужен.
Сбой/отмена подготовки запрещают компиляцию, а непроверенный кэш не используется.

Удобный `npm.cmd run build:windows` также остаётся поддержанным, но не заменяет
проверку первой команды при миграции старого сборщика. Не передавай macOS signing
config и не повышай версию просто ради сборки той же базы. Сопоставь
`src-tauri/target/enki-agent/current` и bundled `agent-runtime` с одним
`runtime-manifest.json` по публичному `verifyArtifact`, как в Windows CI.
Присутствие папки само по себе не доказывает корректный ресурс/подпись Node.

Результат — `src-tauri\target\release\bundle\nsis\Enki_<version>_x64-setup.exe`.
Сохрани размер и SHA256, запусти `scripts/verify-windows.ps1 -InstallerPath
'<точный путь>' -ArtifactOnly` и `scripts/test-windows-install-selection.ps1`
(собственные фикстуры, без записи в реестр). Успех ArtifactOnly не доказывает
установку или исправность UI/runtime.

## Установка и миграция данных

Сначала сохрани приватную резервную копию необходимых app/profile данных и
старого установщика вне Git. Не запускай две версии Enki одновременно.
Установка ждёт простоя собственных агентов/диалогов; закрытие окна может лишь
скрывать приложение в трей, поэтому отличай его от штатного полного выхода.
Не останавливай внешние процессы по имени и не прерывай чужие службы.

Установи точный NSIS для текущего пользователя. Проверь реальный путь/binary,
версию в настройках, uninstall/shortcuts и отсутствие дубликата; не выводи
успешную установку из одного наличия установщика. Системные блокировки требуют
обычного разрешения пользователя, а не отключения защиты.

Собственные данные `%LOCALAPPDATA%\opencode-desktop` мигрируют в `enki` штатным
журналируемым механизмом; профиль браузера под `%USERPROFILE%` сохраняет свою
миграцию и совместимые пути. Не удаляй вручную старые каталоги/junction и не
создавай конкурирующий профиль. При конфликте разных данных миграция должна
отказаться без перезаписи. Перезапуск во время восстановления не должен терять
исходные данные или повторно отправлять задания.

Истории OpenCode/Pi CLI импортируются в архив только для чтения. Продолжение —
явный новый Enki-чат с происхождением. Прежние очереди/таймеры переносятся с
журналом и остаются на паузе; неизвестная доставка не становится «не отправлено».
Ключи и настройки импортируются только явно; не копируй секреты в репозиторий,
логи или промпты. Внешние `~/.pi`/OpenCode установки не меняются.

## Живая Windows-приёмка и передача результата

В собственном тестовом профиле/чате проверь установленный bundled runtime,
историю после restart, настройки/ключи без раскрытия значений, обычный промпт,
stream/tools/Stop, full/read/ask и запомненные разрешения, очередь/уточнение и
таймеры, переключение модели с Hub readiness, вложения/диктовку, терминал/diff,
браузер/MCP и закрытие/трей. Проверяй затронутые Windows paths, отмену сборки,
истинное завершение собственного дерева и восстановление после сбоя. Список и
разделение CI/live доказательств — [PLATFORM-ACCEPTANCE.md](PLATFORM-ACCEPTANCE.md).
Неподдержанную или недоступную возможность помечай с причиной; Mac PASS и
исторический 0.2.x Windows PASS не доказывают Windows 2.0.

SDK обновляй только отдельным reviewed шагом по [SDK-UPGRADE.md](SDK-UPGRADE.md):
точная цель, синхронные пины/lockfiles, обзор API, совместимость расширений и
парный откат БД/JSONL. Никаких глобальных `npm update`, Pi CLI или `latest`.

В отчёте дай source SHA/branch, версии/OS/toolchain, точные команды и коды,
PASS/FAIL/SKIP/NOT RUN по гейтам и живым сценариям, installer path/size/SHA256,
installed path/version, найденные дефекты и ограничения. Коммить только код и
обезличенные доказательства, не installer/target/node_modules/истории/ключи.
Согласованные исправления отправь своей веткой/PR, прикрепи PR к чату, если
инструмент доступен. Публикация в Hub/релиз и merge принадлежат канонической
процедуре «Мастерской» после принятия и проверки, не обходному Windows upload.
