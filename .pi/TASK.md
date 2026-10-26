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

## Дополнение: управление компьютером

В 2.0.6 текущий чат открылся с mcpUnavailable (мост не готов). Подключить
обновляло реестр/закрывало idle worker, но не открывало его заново; UI скрывал
ошибки и объявлял успех. В навыке остался неверный префикс cua_desktop_*.

Исправлено: shared_install перед подключением; явный existing SDK ui/open для
того же чата; ожидание mcp.status с реальными инструментами (65s, отмена при смене
чата/хоста); ошибка моста сохраняется в UI. Проверка моста инвалидирует ресурсы.
Навык использует реальные mesh_cua_desktop_* имена. 24 профильных теста прошли;
включая настоящий store + HTTP fixture, без команд модели.

Владелец уже разблокирован: один read-only Qwen Medium запрос в существующем
чате 43fb45ff-bdcd-4932-ba8a-9b40a9d92395 вызвал mesh_cua_desktop_check_permissions
успешно. AX настроек: Подключено · 22 инструментов; оба разрешения предоставлены.
Telegram и другие приложения не открывались. Приватные доказательства в H29.

## Осталось

Новый commit 2.0.7 включает исправление управления. Выполнить свежие канонические
проверки, CI, публикацию Hub/main, готовые пакеты и установить одну Enki.
Предыдущий 974ad1b прошёл все канонические тесты и три платформенных CI
40320782743, но publisher timeout ожидания CI — НЕ опубликован. Старые координаторы
и локальная полная сборка остановлены, не запускать привязанные к974 драйверы.

Фактическая загрузка/проверка настоящего DMG 2.0.6 прошла; локальный native build207
отменён в пользу готового CI пакета. Истории проверены, 19 старых0.2appbundles
удалены,3проверенных aliases retired,2helperlaunchdjobs перезапущены с canonical
argv и health200. Не повторять очистку. Независимые CLI, root opencode.json,
истории/recovery не трогать. Кэши Cargo пока сохранять до завершения новой схемы.
Старая .Enki-previous-58420.app — rollback205, убрать после финальной приёмки.

Все сообщения по-русски. Не управлять SecurityAgent/Terminal через CUA, не обходить
OS consent. Не читать секреты в вывод. Нет GPU benchmark/model switch/concurrent
inference. Один реальный health prompt уже сделан, не повторять без новой причины.
Не выдавать CI за установку Windows/Linux на устройствах владельца.
