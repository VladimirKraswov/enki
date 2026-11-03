# TASK checkpoint — 2026-11-03, рабочее ревью Enki

## Цель и приоритет
Владелец потребовал качественное ревью/рефакторинг и рабочую установленную Enki.
Сначала рабочий чат Mac, затем доставка Windows и быстрый безопасный запуск.
Работа без делегации. Сохранять Мастерскую/историю/чужие CLI/модели/инференс.

## Уже установленное / опубликованное (не повторять выпуск)
HEAD main 32200e2, Enki 2.0.32 опубликована в Hub; оба подписанных пакета и39
изменённых файлов проверены. canonical receipt .local/releases/2.0.32-stable.json.
main pushed. /Applications/Enki.app 2.0.32 установлена и работает.
GitHub CLI установлен локально, но НЕ авторизован; native package dispatch32
не выполнен. Не перепубликовывать immutable32. Пароли/ключи не печатать.
Подробности .local/hub-investigation/FINAL-STATE.json (состояние прошлого выпуска).

## Диагностика и реальная работа Mac
- Каталог Hub был выключен на новом Mac. Включён и применён штатно.
- Все5моделей были в меню; AX macOS ошибочно показывает только выделенную строку,
  screenshot подтвердил полный список. Не делать выводы только по AX.
- Qwen Flash Next, Medium: Hub inspect ready, authenticated models endpoint200
  с exact id; реальный ответ в установленном приложении «Соединение работает».
- Первый проверочный ввод через CUA typeText потерял кириллицу (ошибка способа
  ввода, НЕ Enki). Собственный запрос остановлен; bash-разрешения НЕ выдавались.
  Использовать CUA paste для кириллицы. Последующий точный запрос успешно завершён.
- Artemis/Gemma Pi-каталог указывал на отсутствующий loopback18008. Через уже
  зарегистрированный V100 gateway оба authenticated GET /models200 с exact ids.
  Hub catalog CAS3→4: только Pi baseUrl этих2провайдеров изменён на существующий
  endpoint того же сервиса; параметры моделей, OpenCode, веса/сервисы не менялись.
  backup/receipt .local/hub-investigation/model-catalog-{before-portable,portable-receipt}.json.
  Каталог4 применён штатно на Mac после перезапуска ТОЛЬКО интерфейса. Qwen выбран.

## Незакоммиченные исправления текущего ревью (все наши)
- UI active относится к конкретному ходу: старые pending tools не оживают на новом.
- SDK ProviderError Connection error распознаётся; одинаковые пустые retries
  показаны одной ошибкой с реальным count, история не переписана/не удалена.
- receipt.entryId доказывает доставку и не даёт маркировать отменённый выполненный
  запрос как «не отправлен». Старые ошибочные notices фильтруются по receipt.
- state/activity.ts: единая семантика свежий activityStatuses > старый statuses;
  устранены ложные busy-блокировки4настроек, updates использует тот же helper.
- PUT /config/models: авторитетная runtime idle-проверка перед синхронной CAS
  записью; исключается только собственный HTTP admission, другая работа блокирует.
- image-reference-v1: служебное описание отдельно от видимого текста, имена и
  доступность картинки восстанавливаются из SDK JSONL; маркер НЕ даёт файловый доступ.
- Исходный выпуск виден в badge без native-пакета; локальная сборка раскрыта
  при отсутствии установщика. Auth GitHub не нужен, registry downloads нужны.
- Dependency declarations/maps упакованы побайтно в development-metadata.json.gz,
  JS/TS/нативные файлы/package metadata/licenses остаются. Полная проверка каждого
  поставленного файла/архива сохранена, persistent trust cache НЕ добавлен.
  Node maps Enki остались, dependency maps извлекаются отдельно для диагностики.
  runtime identity учитывает packaging format. 29402→14520 files; native probe на
  этом Mac ~19.29s→14.35s (warm current verifier, НЕ Windows measurement).
- README/ROADMAP/HUB-UPDATES/RUNTIME/PLATFORMS обновлены; версии пока остаются32,
  НОВОГО РЕЛИЗА ЭТИХ ИСПРАВЛЕНИЙ ПОКА НЕТ.

## Проверки и доставка 2.0.33
UI206files/1266passed + latest render18passed; runtime75files/440passed,
SDK node171passed/1skip; artifact102passed/4skips. SDK pins/typecheck/build/docs/
architecture/bundle/diff passed. Native candidate build/codesign passed.
Isolated profile .local/review-profile: signed runtime14520files checked,
phase ready2455ms (warm launch, not a cross-platform performance claim).
GUI acceptance candidate pending: Mac locked; never bypass OS lock.

Владелец 03.11.2026 явно разрешил отложить GitHub packages32 и новые GitHub-пакеты,
выпустить следующую версию через Hub/local build. Это исключение из порядка
AGENTS, не отмена проверок подписей, idle и сохранности данных.
Версии синхронизированы2.0.33; served stable перед выпуском2.0.32/32200e2.
Следующее: commit reviewed scope; canonical release:local stable; проверить
receipt/head/обе подписи/actual changed files, push exact HEAD main. Затем
сборка33 и штатное применение через desktop_updates при доступности инструмента.
Текущий установленный Mac32 работает с Qwen; новый код ещё НЕ опубликован.
Операционные итоги после commit только .local, не менять publication HEAD.
Windows/Linux live acceptance НЕ выполнена; Windows/MSYS cleanup и исходная
причина SSE остаются открытыми. Не заявлять весь проект полностью исправленным.
