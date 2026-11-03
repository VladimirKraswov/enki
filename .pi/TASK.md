# TASK — 2026-11-03: Strata VM5200

## Текущее поручение
Владелец явно поручил обновить отдельный Strata на PVE192.168.31.2/VM5200
с замерами до/после. Это разрешает изменение именно этой inference-службы.
Затем уточнил: без снижения качества. Делегации не было.

Продолжение по TTFT завершено с ограничением: первое сохранение длинной
ветки всё ещё ~1с. Причина — park ~940мс/1.17ГБ; KV resize522–725мс.
Обычное продолжение не паркуется; исходный тест был перегенерацией.
Установлен штатный --conversation-cache-park-gain1024, остальные параметры
прежние. Следующий повтор short0.105с / long0.146с; после переключений long
0.421/0.145/0.144с, decode107.5/126.3/99.4ток/с (разброс, не гарантия равенства).
Между двумя чатами reuse52536/52541 сохранён. JSON/logic PASS.
POOL4 снят: длинный TTFT0.95–1.33с и decode хуже в этой серии; TRACE снят.
Watchdog исправлен и установлен: постоянный strata-vision несовместим с lazy
Vision0.1.56, приводил к ложному рестарту/start-limit-hit. API восстановлен,
watchdog включён; healthy проверяется в его штатном venv с psutil.
Резерв config VM upgrade-20261103/model-before-latency.json, watchdog-before-elastic.py.
Приёмка VM upgrade-20261103/latency-accepted.json; частные логи/скрипты
.local/strata-latency/, данные .local/strata-upgrade/latency-*.
Команды: python3 -m unittest discover -s services/strata -p 'test_*.py'
(8PASS/3SKIP без nginx); npm run check:docs (67/208PASS), git diff --check.
Изменена только VM-служба и её operator/watchdog файлы; Enki UI/runtime
не менялись, выпуск Enki не требуется. Подробные пределы замеров в README Strata.

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
