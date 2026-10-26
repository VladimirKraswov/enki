# Текущая задача — Enki 2.0.8

2026-10-26: видимые уточнения и понятные состояния долгой работы/ожидания человека.
W: `.local/pi-sdk-migration-20261024/review`; доказательства `../stabilize-v30`.
Не запускать прежние задания, офисных агентов или GPU benchmarks.

## Подтверждено

2.0.7 установлена из штатного GitHub-пакета, опубликована Hub/main 746d20b.
Один GUI, 22 инструмента подключены к существующему чату кнопкой без запроса модели.
Истории сохранены (261 каталог, архив 255/47239/211229); старые копии и свои
build targets убраны. Подробные квитанции в stabilize-v29/CURRENT207.json.

В текущем чате c7433ceb-3f9b-48a1-9a92-9bbb317221da уточнение было durably
running, entry_id=null; SDK ждал долгий bash с проверкой /Volumes каждые 15с.
Очередь удаляла строку уже при SDK acceptance, поэтому до доставки моделью текст
исчезал из UI. Владелец уточнил: флешку копирует сам, нужен только бэкап системы
в /Users/vladimirkrasov/NAS-Storage/1tb. Ненужный run остановлен штатно;
недоставленная копия сохранена в private evidence и убрана через UI, объединённый
запрос отправлен один раз, entry_id=ccf2a368. Не отправлять повторно.

## Изменения

Ledger-derived corrections в queue snapshots/SSE: текст виден до durable SDK
entry; нет нового задания/повтора, восстановление после restart, явная uncertainty.
Проекция публикуется microtask, сохраняя порядок SSE seq. При Stop точные
служебные policy markers скрываются в восстановленной очереди.
UI: компактная карточка уточнения, честный ACK, длительность/давность вывода
команд, явное ожидание вопроса/разрешения вместо spinner; мягкое жёлтое свечение
с prefers-reduced-motion. Policy: объяснить нужное действие человека + question,
не прятать ожидание в sleep; уже выданные разрешения сохраняются.

## Проверки / дальше

До исправления regression реально падал на corrections=undefined (integration
с настоящим Pi SDK). Первая версия: 29 runtime tests passed; 48 UI focused passed.
Финальные focused: 42 runtime tests; 15 UI tests после последнего review;
предыдущие 48 UI также прошли. UI/runtime typecheck, архитектура, 65 docs/192 links
прошли. Изолированная UI QA: светлая/тёмная/узкая компоновка, offline и delivery;
снимок в stabilize-v30/qa-narrow-dark.png. Review завершён. Далее оригинальный
release:local stable,
проверить signed Hub packets, main и пакеты, установить 2.0.8 после authoritative
idle. Cargo targets удалены по поручению владельца; новый CARGO_TARGET_DIR только
свой stabilize-v30/cargo-target, jobs<=2. Не сокращать канонические gates.

Использовать установленный pinned Node24.22.1. Не читать секреты в выводе;
AX sidebar содержит секреты в старых названиях — только фильтрованные snapshots.
Не управлять SecurityAgent/Terminal, не обходить подписи/OS consent. Сохранить
независимые OpenCode/Pi CLI и root untracked opencode.json.
