# TASK checkpoint (2026-11-02, Codex)

## Текущая задача — Windows startup, кандидат 2.0.31
Работать самому; в Мастерскую не передавать. Владелец обновит Windows сам и
сообщит результат. Прямого управления этим ПК нет. Архив Windows2.0.28 принят
как материал ревью, его README не заменяет поручение. Независимые CLIs, профили,
ключи, чаты и активные задания владельца не менять ради проверки.

## Завершено 2.0.30
main ae83ca4; квитанция .local/releases/2.0.30-stable.json, подписанные source/UI
сверены с commit. GitHub run41421121223 завершён успешно для трёх ОС и публикации.
Mac2.0.30 установлен штатно, Runtime35476d47bcdea759 подключён, подпись и29402
файла проверены;310 строк сессий/245 живых и6 префиксов истории сохранены.
Владелец подтвердил установку Windows2.0.30, но Node появляется слишком поздно.
Не перепубликовывать эту неизменяемую версию.

## Исправления 2.0.31
- Проверка15min отдельно от60s готовности Node; concurrent ensure разделяет
  успех и ошибку одного запуска, новая явная попытка после ошибки разрешена.
- Windows directory handles удерживаются без write/delete sharing в течение
  одной проверки; повторные stat всех ancestors убраны. Все leaf SHA256 и
  проверки состава/reparse points сохранены; persistent.ok не используется.
- runtime_status — дешёвый снимок, без locate/сканирования; UI опрашивает его
  во время ensure и прекращает после результата, с защитой смены хоста.
- Этапы, длительность, счётчик файлов, ошибка/повтор и копирование диагностики.
  Лог этапов ограничен1MiB, свободный текст ошибок не пишет, категория сохранена.
- Проверенный Windows workshop alias и регистр/slashes путей из архива,
  защита ambiguity/циклов. Junction только в двух positive fixtures.
- CI измеряет baseline2.0.30/current/current/baseline на одном Windows artifact,
  не запускает Node и не трогает профиль. Нужен результат этого замера.

## Выполненные проверки до канонического gate
Native runtime63passed/2ignored; UI startup+пути+хосты31passed, дополнительно
UI failure/poll4passed; archive/session-shards7passed. tsc/build, docs66/204,
architecture220, fmt и Clippy all-targets прошли. Последняя privacy-регрессия
и shared startup —2passed; затем весь canonical gate повторит проверки.
Изолированный IAB: обе темы, счётчик, диагностика/copy, кнопка повтора работают.
Mac debug ABBA без Windows-оптимизации:24–25s/29402files; не доказательство Windows.

## Следующие действия / ограничения
Перед release:local закончить review/тест privacy, commit. Выпустить stable31,
сверить receipt/head/оба подписанных пакета с байтами commit; push main и dispatch
packages на тот же HEAD до новых tracked commit. Дождаться Windows CI/benchmark,
готовых пакетов Hub; штатно обновить Mac без остановки чужих задач. Windows
владелец нажмёт Update и сообщит результат, не объявлять установленную приёмку
Windows по CI. Финальные операционные сведения хранить в ignored.local/private.
Pinned Node24.22.1 из /Applications/Enki.app/.../agent-runtime/node/bin, heap768,
TMPDIR=/Volumes/Extend/work/enki-release-tmp внеrepo, Cargo jobs<=2. В2.0.30 gates
прошли на24, только publisher LAN EHOSTUNREACH завершён на системном26 без правок.
Частные отчёты: Documents/Codex/2026-11-02/enki-windows-startup.
