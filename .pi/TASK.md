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
