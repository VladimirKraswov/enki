# Проверки и доказательства выпуска

Канонический порядок задан в [scripts/releases/operator.mjs](../scripts/releases/operator.mjs).
`npm run release:local -- stable` выполняет проверки до обращения к ключам и
публикации. Обычные тесты и сборки ничего не выпускают. Для Cargo используйте
`CARGO_BUILD_JOBS=2` или меньше.

| Область | Проверки |
|---|---|
| Исходники | Чистый проверенный Git commit; согласованные версии манифестов |
| Документация | `npm run check:docs` — переносимые пути и ссылки на существующие разделы |
| Интерфейс | `npm test`, `npm run build`, `npm run check:architecture`, `npm run check:bundle` |
| Выпуск | `npm run test:releases` — порядок проверок, подписи, публикация и потерянное подтверждение |
| SDK | `npm run sdk:check` — согласованность версий SDK/Node/схемы |
| Runtime | Установка по lockfile без произвольных scripts, сборка node-pty, runtime typecheck, `npm run test:runtime` |
| Упаковка | `npm run test:runtime-artifact` — manifest, подготовка, удалённая установка и парный откат |
| Сервисы | `python3 -m unittest discover -s services/hub/tests` и `services/asr/tests` |
| Rust | `cargo fmt --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` для приложения и build-runner |

CI дополнительно проверяет offline evaluations, fault-сценарии, службы Strata/V100,
нативный протокол build runner и настоящие платформенные пакеты. Точный перечень —
[desktop.yml](../.github/workflows/desktop.yml). Прогон должен относиться к тому
же commit, что пакет. Проверка другой ветки или старые числа тестов его не заменяют.

## Публикация и установка — разные результаты

1. Проверить diff и выполнить канонический выпуск.
2. Получить `.local/releases/<version>-<channel>.json` от штатного publisher.
3. Независимо прочитать served head и оба подписанных пакета; сверить версию,
   commit, native fingerprint, подпись и фактические изменённые файлы.
4. Проверить нативный пакет: версию, полный runtime manifest, подпись и SHA256.
5. Установить штатным механизмом с блокировкой обслуживания, простоем и парной
   копией данных; отдельно выполнить [живую приёмку](PLATFORM-ACCEPTANCE.md).

Фраза «выпущено» требует квитанции и проверки доступности. Фраза «установлено»
требует проверки приложения после замены. Зелёные unit-тесты не доказывают работу
GPU, реальный UI, системные разрешения или сохранность конкретной истории.

На macOS готовый GitHub-пакет можно проверить тем же нативным путём без установки:
сохраните проверенные ответы Hub как JSON с `version`, `nativeFingerprint`,
`native` (ответ `/api/updates/native/stable` с envelope), затем запустите:

```sh
ENKI_NATIVE_ACCEPTANCE=/absolute/private/receipt.json cargo test --manifest-path src-tauri/Cargo.toml --locked actual_signed_package_downloads_and_unpacks_without_installation -- --ignored --nocapture
```

Проверка использует закреплённый ключ, HTTPS, размер/hash, распаковку DMG,
идентичность/версию и codesign. Она не создаёт план установки, не запускает новое
приложение и удаляет свой временный каталог после успеха. Обычный CI её не вызывает.

## Проверочный профиль

`ENKI_PROFILE_DIR` должен быть новым абсолютным каталогом. Перед первым запросом
проверьте, что и runtime, и WebView, и системные ключи относятся к нему. Нативный
`webview_profile.rs` применяет отдельное хранилище непосредственно к основному
и вынесенному окну; неподдерживаемая версия macOS отказывает без fallback на
профиль владельца. Не проверяйте миграцию удалением пользовательского чата.

## Хранение результатов

Текущие незавершённые проверки — в [ROADMAP](../ROADMAP.md) и `.pi/TASK.md`.
Приватные логи, квитанции, снимки и данные приёмки хранятся вне публикуемого дерева.
Отчёты завершённых работ доступны в Git. Фикстуры в `test/fixtures/` — тестовые
данные, не инструкции и не подтверждение качества текущей версии модели.
