# Текущая задача — Enki 2.0.15: восстановление локальной авторизации

W `.local/pi-sdk-migration-20261024/review`, R `/Volumes/Extend/work/Enki`.
Evidence H38 `../stabilize-v38`; предыдущие H30–H37 сохранять.
Установленная 2.0.14 проверена: H37/ACCEPTANCE-CHECKPOINT.json complete,
263 записи сохранены, модели/оба потока доступны, один GUI; старые own builds
и backup bundles удалены. R/untracked opencode.json — данные владельца, не трогать.

## Дефект и изменения

Скриншоты Unauthorized сделаны до восстановления14. Свежий native desktop_status
подтвердил connected/model selected/open streams/no errors. Не объявлять повтор
сбоя на текущем соединении. Найден воспроизводимый дефект протокола: runtime
устанавливает replacement token, два ACK теряются; supervisor забывает exact
id/token и до следующего6h rotate возвращает истёкший token. Причина именно
исторического инцидента не доказана; этот failure mode подтверждён тестами.
15 сохраняет pending rotation в памяти, replays SAME id/token до ACK,
ensure/reconnect сначала settle; фон3 попытки по15sec. Без restart/новых prompt.
401 после ограниченного recovery — русское объяснение с сохранением работы.
Focused: frontend25pass, HTTP6pass, standalone Rust pending authority2pass.
Последний runtime HTTP suite запускался из agent cwd (первый вызов из root
не нашёл тестов; не выдавать его за успешный). Cargo fmt/diff check прошли.

## Далее

Проверить diff, commit15, штатный npm run release:local -- stable (все gates),
Hub/main+оба signed packets, CI native15; затем штатная установка на authoritative
idle и live acceptance/263 history audit. Не запускать офис/Igor/старые задачи/
GPU inference/benchmarks. Не возобновлять чужую работу: нами ничего не paused.
Owner AX только emit:false+whitelist, секреты в старых titles/командах;
SecurityAgent/Terminal GUI не автоматизировать. OS identity сохранять.
