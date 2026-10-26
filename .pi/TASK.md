# Текущая задача — Enki 2.0.7

В работе, 2026-10-26. Кэш сборки на Hub, устранение дублей приложения,
завершение установки/проверки/очистки. Не запускать офисных агентов и старые задачи.
W `.local/pi-sdk-migration-20261024/review`; приватные доказательства рядом в
`stabilize-v29`. Они не входят в релиз.

## Подтверждено

- 2.0.6 опубликована на Hub, main 621f115, квитанция и все файлы проверены.
  CI 40309281268 три ОС прошли; draft GitHub выявил ошибку tag lookup. После
  проверки всех digest/commit/run draft опубликован, failed job повторён успешно.
  Новый код исправляет поиск draft и имеет регрессионный тест.
- Нативная 2.0.6 установлена через реальный UI: сборка Rust 33m44s, 31610 файлов
  совпали с планом, codesign strict прошёл; H29/NATIVE-206-VERIFIED.json.
- Все 259 чатов, 47239 сообщений и 211229 частей архива сохранены. Четыре
  изменяемые истории в Enki, старых directory refs в каталоге нет.
- После установки возник дубль: 58739 старый и 59689 новый. Старый подтверждённый
  процесс завершён; остался 59689, runtime connected. Каталог моделей после refresh
  загрузился (Qwen Flash Next и DeepSeek). Два Arvela.app symlink удалены.
- Новый source 2.0.7: sccache 0.19 pinned SHA 6 платформ, scoped Hub cache leases,
  8GiB global/3GiB device/64MiB object, TTL/LRU, HTTPS+hash proxy, fallback;
  реальные Cargo/Rust/sccache/одноразовый HTTPS Hub: после удаления первого target
  и перехода в новую папку зависимость взята с Hub (1 hit, собственный crate — miss).
  H29/cache-live-clean-rebuild-6.log. Проба учитывает symlink /var на macOS.
- 108 Hub tests (1 skipped), 29 cache/publisher/entry Node tests, 1115 UI tests,
  273 Rust tests (7 ignored), UI build и 65 docs/192 links прошли.
- Hub cache развёрнут с backup кода/SQLite в CT206; реальный HTTPS smoke подтвердил
  lease/PUT/GET/hash/scoping/revoke. Bundled Node из Codex shell получает EHOSTUNREACH
  к LAN, native Hub работает; операторская проверка через Homebrew Node успешна.
  Проверить именно дочерний Node установленного приложения, не менять OS consent.
- Single-instance plugin pinned2.4.2 (совместим с Tauri2.11), не обновлять весь
  framework; Cargo.lock добавляет только plugin и tempfile dev-dependency.
  Профиль/установка fenced OS file locks, reopen Mac больше не использует -n.

## Осталось

Проверить текущие изменения целиком, тесты HTTP кэша/квот/отзыва, тест single
instance и реальный запуск дважды. Развернуть cache server с backup + smoke,
провести свежую каноническую публикацию 2.0.7 (2.0.6 не изменять), push main,
GitHub packages, установить одну актуальную Enki. Один bounded Qwen Medium
health prompt; фактическая загрузка DMG: H29/NATIVE-ACTUAL-ACCEPTANCE.private.json
для2.0.6 уже готов, opt-in Rust test. Обновить private drivers (они привязаны к206
и старому205 executable), не запускать без адаптации. Hub signer/ключи неизменны.

Два helper plist и app-owned config paths уже переведены на enki на диске, но
launchd ещё держит старые argv. Перезагрузить только их в простое, сверить health.
Удалять старые data/source aliases только после проверки prefs/tool refs; одна
native-gallery UI ссылка ещё показывалась старой. Независимые CLI, root opencode.json,
истории/recovery не трогать. Кэши Cargo пока сохранять до завершения новой схемы.
Старая .Enki-previous-58420.app — rollback205, убрать после финальной приёмки.

Все сообщения по-русски. Не управлять SecurityAgent/Terminal через CUA, не обходить
OS consent. Не читать секреты в вывод. Нет GPU benchmark/model switch/concurrent
inference. Не выдавать CI за установку Windows/Linux на устройствах владельца.
