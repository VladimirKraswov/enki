# Платформы и сборки Enki

Текущий номер берётся из `package.json`; `bundle-config.test.ts` проверяет его
совпадение с Cargo/Tauri. Стабильные идентификатор `dev.local.opencodedesktop`,
исполняемый файл `opencode-desktop` и прежние пути данных сохранены для обновлений.

## Общий код и реальные границы

По переданному отчёту Windows-агента от 2026-10-09: 0.2.35 с минимальным
исправлением Git-карты проекта собрана на Windows; 654 frontend, 78 Rust (включая дерево Job Object), 37 Hub и
реальные изолированные browser/shared-MCP/Pi-loader проверки пройдены.
0.2.35 установлена: обычный путь Windows, версия в Settings, список чатов и
Qwen Medium; установленный MCP (36 инструментов), ввод/клик в панели и DOM
проверены. Это не полная platform acceptance и не новый запуск задачи моделью.
[Отчёт и ограничения 0.2.35](WINDOWS-RESULT-0.2.35-20261009.md).

| | macOS | Windows | Linux |
|---|---|---|---|
| CI runner | macos-14, ARM64 | windows-2022, x64 | ubuntu-24.04, x64 |
| Пакет | `.app` + `.dmg` | NSIS `.exe`, текущий пользователь | `.deb` |
| Команда | `npm run build:macos` | `npm.cmd run build:windows` | `npm run build:linux` |
| Оверлей | `tauri.macos.conf.json` | `tauri.windows.conf.json` | `tauri.linux.conf.json` |
| Встроенное Enki Runtime (Pi SDK) / общий MCP | реализованы | реализованы | реализованы |
| Удалённый хост ядра | — | — | только Linux x64 ([процедура](REMOTE-RUNTIME.md)) |
| Agent Control / Factory | Unix socket | недоступны, UI сообщает | Unix socket |
| Cua Driver | отдельная интеграция | недоступна | недоступна |
| Нативный звук | afplay | нет системного проигрывателя | первый доступный canberra/paplay/pw-play |
| Хранилище ключей | Keychain | Windows Credentials | Secret Service |

### Windows: доверенный нативный раннер сборки (bootstrap из исходников)

`runtime:prepare` на Windows запускает каждый процесс (tar, npm, node-gyp, esbuild)
только через `enki-build-runner --enki-build-job`: процесс создаётся
приостановленным, назначается в kill-on-close Job Object и лишь затем
возобновляется; таймаут, ограничение вывода или гибель раннера закрывают Job и
завершают всё дерево. После выхода основного процесса Job тоже завершается, и
`reaped:true` сообщается только когда Job подтверждённо пуст. Вывод потоковых
задач идёт через ограниченную очередь: непрочитанный stderr никогда не
блокирует дедлайн. Каталоги при продвижении артефакта сбрасываются на диск тем
же портом (`FlushFileBuffers` по дескриптору каталога с правом записи, только
точные пути без ссылок). Запасного «обычного» запуска нет.

Раннер **не** берётся из установленного Enki и не задаётся переменной окружения.
Перед подготовкой `scripts/runtime/build-runner.mjs` компилирует маленький
крейт `src-tauri/build-runner` (только serde/serde_json/libc, тот же проверенный
`process.rs`/`build_job.rs`, без Tauri, ассетов и agent runtime) из тех же
аутентифицированных исходников в новый приватный каталог
`src-tauri/target/enki-build-runner/enki-build-runner-*`: настоящий `cargo` из
sysroot `rustc` (не прокси rustup; на Windows cargo сам держит свой kill-on-close
Job), `--locked`, явное окружение без `RUSTFLAGS`/обёрток. Квитанция фиксирует
SHA256 исходников и бинарника; перед каждой задачей бинарник сверяется с ней.
Нет Rust — типизированный отказ «Rust toolchain missing», без запасного пути.
Поэтому первое обновление старым установленным Enki 0.2.x (у которого нет
`--enki-build-job`) работает так же, как ручная сборка:

```powershell
npm.cmd run build:windows   # раннер собирается автоматически из этого дерева
node scripts/runtime/build-runner.mjs --out "$env:TEMP\enki-build-runner"  # отдельно (CI)
```

Unix: подготовка использует собственную группу процессов Node; CLI-раннер на
Unix завершает всю группу, пока незахороненный основной процесс удерживает её
идентификатор (Linux дополнительно подбирает «сбежавших» потомков как
subreaper; macOS сообщает охват `group`).

Статус: исходный код, живая проверка Windows ещё не выполнена (см. NATIVE-FOLLOWUP-RESULT.md).

Ожидание bootstrap ограничено: после выхода основного `cargo` вывод дочитывается
не дольше `drainMs` (10 с). Если потомок продолжает держать stdout/stderr, а также
при дедлайне/отмене после выхода основного процесса, результат —
`ENKI_BUILD_CLEANUP_UNKNOWN`. Сохранённый PGID уже не сигналится: процесс мог
быть захоронен, а PID переиспользован. Квитанция не выпускается, а приватный каталог
не удаляется как «завершённый», путь сообщается в ошибке. Параллельность
bootstrap — `--jobs` и `CARGO_BUILD_JOBS` = min(`CARGO_BUILD_JOBS` вызывающего, 2),
по умолчанию 2. Неверное значение — явный отказ.

### Первое обновление 0.2 → 2.0: исходниковая точка входа `npm run tauri`

Старый установленный сборщик 0.2 выполняет только `npm ci` и
`npm run tauri -- build --bundles <app|nsis|appimage|deb|rpm> [Mac signing --config] --ci -- --locked`.
Поэтому `package.json` `tauri` = `node scripts/runtime/tauri-entry.mjs`. Для
`build`/`bundle` вход сначала проверяет версию хостового Node (≥22.13, проверено на
24.22.1) — ещё до загрузки помощников с `node:sqlite`. Затем он готовит runtime
этого исходника через `prepare()` либо переиспользует уже подготовленный, но только
при квитанции `preparation-receipt.json`, привязанной к SHA256 манифеста и хешам
входов, и при полной проверке артефакта. Затем проверка повторяется, и запускается
установленный bin `@tauri-apps/cli` (`<node> tauri.js`, `shell:false`, сверка с
`package-lock.json`, без PATH). Исходные аргументы сохраняются побайтно, а
`--config src-tauri/tauri.runtime.conf.json` вставляется перед первым `--` Cargo.
Сбой, отказ, дедлайн или отмена подготовки означают, что компиляции нет.
`--help`/`--version`/`dev`/`info` и прочие команды проходят без подготовки.
Удобные `build:<platform>` остаются как есть. Прямые `cargo check/test` и
`npm run build` не затронуты. CI Windows собирает пакет именно старой командой.

«Реализовано» не означает «проверено в packaged UI на этой ОС». Свежая живая
проверка ведётся в [VERIFICATION.md](VERIFICATION.md). Для M42 все три нативных
CI-пакета 0.2.33 собраны и проверены; macOS 0.2.33 установлен и проверен по
версии, агентам, восстановлению состояния и Hub. Windows/Linux текущие
live-сценарии не запускались. Прежние
[Windows 0.2.21](WINDOWS-RESULT-0.2.21-20261007.md) и Linux 0.2.10 — отдельные
исторические результаты, не доказательство работоспособности нового релиза.

## CI

[Desktop platform builds](../.github/workflows/desktop.yml) запускается на main,
рабочих `codex/**` ветках, pull request и вручную. Три независимых задания:
`npm ci`, frontend-тесты, offline eval-contracts, Hub Python-тесты, Rust fmt/check/
test и настоящий Tauri пакет. Fail-fast выключен: сбой Windows не скрывает
результат других ОС. Повторный push отменяет только устаревший запуск этой ветки.
Cargo кэш разделён по ОС/архитектуре/lockfile; Node 24 и Rust stable указываются
в артефактном receipt. Actions закреплены по commit SHA.

Проверки пакета: Mac signature/microphone + DMG CRC, Windows непустой PE/NSIS,
Linux версия/payload/no macOS files. Артефакты и `.local/ci-artifacts.json` с
version, commit, SHA256 и toolchains доступны 14 дней. Runner не устанавливает
приложение, не открывает GUI, не запускает модели и не требует приватных ключей.
CI не публикует релизы автоматически. [Чеклист живой проверки](PLATFORM-ACCEPTANCE.md)
ведётся отдельно; receipt всегда пишет `liveAcceptance: not-run`.

## Локальная сборка

Нужны Node 24 (закреплённый 24.22.1; подготовка ядра отказывает ниже 22.13 до
любых действий), Rust stable; `npm ci` и Cargo `--locked` используют lockfiles,
`CARGO_BUILD_JOBS=2`. Сборки `build:*` сначала подготавливают встроенное ядро
(`npm run runtime:prepare`), полный список шлюзов — [VERIFICATION.md](VERIFICATION.md).
Tauri автоматически объединяет базовый конфиг с оверлеем ОС. Объекты сливаются,
массивы заменяются целиком; тест проверяет полный Mac-объект окна, CSP,
entitlements и отдельные bundle targets.

```sh
npm ci
npm test -- --maxWorkers=2
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

macOS: Xcode Command Line Tools, `npm run build:macos`, затем
`python3 scripts/verify-macos.py src-tauri/target/release/bundle/macos/Enki.app`.
Локальный DMG подписан ad-hoc; notarization/сертификат издателя не настроены.

Windows: Visual Studio C++ Build Tools, Rust stable-msvc, WebView2, Node 24.
Используйте `npm.cmd`, затем `scripts/verify-windows.ps1 -ArtifactOnly`. Режим
без `-ArtifactOnly` — историческая проверка 0.2.x с внешним OpenCode; для 2.0 он
не является шлюзом и не заменяет GUI.
Установщик без подписи издателя. Деревья дочерних процессов используют Job Object;
создание консольных процессов скрыто. Полный live tree-cleanup проверяется отдельно.

Ubuntu 24.04: build-essential, pkg-config, libgtk-3-dev, libwebkit2gtk-4.1-dev,
libsoup-3.0-dev, librsvg2-dev, libssl-dev. `npm run check:linux-prereqs` только
сообщает зависимости; `npm run build:linux` создаёт пакет. `dpkg-deb -I/-c` проверяет
его без установки. Xvfb — только smoke рендеринга, не проверка реального рабочего стола.
Зависимости сверены с [официальными требованиями Tauri](https://v2.tauri.app/start/prerequisites/).

## Пути и владение

Данные Enki: каталог `enki` (прежний `opencode-desktop` переносится при запуске
с сохранением совместимой ссылки) в macOS `$HOME/.local/share`, Linux абсолютном
`$XDG_DATA_HOME` или `$HOME/.local/share`, Windows `%LOCALAPPDATA%`. Данные ядра —
подкаталог `runtime`. Точные пути разрешает `src-tauri/src/paths.rs`. Прежняя
история OpenCode (`opencode.db` в `.local/share/opencode` / XDG) открывается только
для чтения при импорте. `ENKI_PROFILE_DIR` (только для разработки/приёмки)
переносит данные, WebKit и пространства имён системного хранилища ключей в
отдельный профиль без доступа к профилю владельца.

Enki управляет только собственными процессами: ядро, browser/MCP, PTY, SSH. Внешние
OpenCode/Pi и их серверы не запускаются и не останавливаются. Все консольные
процессы Windows проходят общий helper `process.rs` (Job Object); на macOS
потомки, покинувшие группу процессов PTY, публичным API не отслеживаются и
отображаются как «очистка не подтверждена». Недоступность Cua Driver или Agent
Control не выключает ядро/браузер/обычные инструменты.
