# Независимые synthetic migration fixtures

Подготовлены 2026-10-25 для проверки будущего importer. Это данные и ожидаемые свойства, **не исполняемый тестовый runner**. SQL/SDK/тесты не выполнялись; синтаксис и round-trip пока не подтверждены запуском. Ни одного байта пользовательской истории здесь нет.

## Происхождение схем

OpenCode tag 1.18.18 разрешён официальным GitHub API в commit `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`. Формы таблиц/индексов и payload прочитаны из этого commit:

- [Session/Message/Part/V2 SQL](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts)
- [Project SQL](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/project/sql.ts)
- [Timestamps](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/schema.sql.ts), [path encoding](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/path.ts)
- [V1 payload types](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/v1/session.ts)
- [V2 message types](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/session-message.ts), [prompt](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/prompt.ts), [delivery](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/session-delivery.ts)
- [V2 context snapshot](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/system-context/index.ts)

DDL — ручное физическое представление **выбранного подмножества** этих таблиц на SQLite, с соответствующими колонками, NOT NULL/default/FK/index. Это не дамп всей БД, не точная копия engine migration ledger и не доказательство версии конкретной owner DB. Нет account/auth/event/sync/share секретов или полного schema fingerprint. Если importer требует полную БД/ledger, harness должен независимо дополнить test-owned schema из того же upstream commit, а не ослаблять importer или выдавать fixture за настоящую installation DB.

Pi: установленный SDK `@earendil-works/pi-coding-agent` **0.85.1**, только чтение `dist/core/session-manager.{js,d.ts}`, `messages.d.ts` и `pi-ai/dist/types.d.ts`. `oldPi.jsonl` — version 2 с id/parentId tree и `hookMessage`; v2→v3 migration в SDK меняет роль на `custom`. Форма header/entries соответствует loader compatibility source, а не произвольному старому формату. `corruptPi.jsonl` намеренно содержит незаконченную JSON-строку 3.

## Что проверяет каждый файл

- `v1.sql`: IDs вне JSON, Unicode, равные timestamps, completed/error/pending tool states, вложенный tool attachment, summary/compaction/tail/revert, parent session/архивная ветка, foreign Windows cwd/file URI, ignored+synthetic text, todo/project command, которые запрещено исполнять при импорте.
- `v2.sql`: IDs/type вне JSON, seq в порядке, обратном лексикографическим ID, отдельные V1 shadow records, compaction/recent, записанный shell result, один уже promoted input и один pending input, context epoch. Ни shell, ни pending input не должны исполняться.
- `oldPi.jsonl`: source version2 не должна меняться, tool-call/result pair, model change, custom hook, compaction на неактивной ветке, выбранная альтернативная ветка/label/title. В source session ID есть точка; короткие entry IDs нельзя считать msg_-IDs или хронологией.
- `corruptPi.jsonl`: валидные записи до/после повреждения нельзя превратить в ложный «полный успешный импорт», молча пропустив строку. Raw archive сохраняется.
- `expected.json`: source counts/IDs/связи/markers и ограничения. Target IDs специально не предписаны: проверяется полный стабильный mapping, сохранение смыслов и отсутствие повторов/утечек.

## Как использовать после получения и проверки полного архива кода

1. Сначала статически просмотреть полный возвращённый diff/runtime contract. Не запускать неизвестный remote code автоматически по факту появления файлов.
2. Координатор создаёт отдельный test-owned temp root с собственным HOME/XDG/profile и snapshot/target dirs. Никогда не materialize SQL в существующий `opencode.db`, не указывать настоящие пользовательские roots и не запускать CLI/SDK на оригинальных историях.
3. В harness только fixture SQL материализуется в **новые** V1/V2 test DB. Для WAL-теста отдельно включить WAL и оставить committed fixture row в WAL; сравнить правильную snapshot с main-db-only ошибочным подходом. Этот набор сам не доказывает live-WAL корректность.
4. Pi JSONL копируется в source-fixture dir как data. Снять hashes/bytes/mtime и при необходимости readonly permissions. До и после importer сравнить original bytes/sidecars; `SessionManager.open/loadEntriesFromFile/forkFrom` запрещены на source.
5. Импортировать через реальный boundary будущего Enki importer в отдельный app-owned target. Использовать fake provider/tool executor, который падает при любой попытке модели, инструмента, project command, shell или network attachment fetch. История — данные, не задания.
6. Проверить `expected.json`: полную source-provenance, wire↔SDK mapping, counts по типам, точный текст/вложения/ошибки, ветки/summary и отдельно выбранный active context. `17 part rows` не включают один nested attachment как отдельную SQL строку. Архивная сессия не исчезает; V1 shadow не примешивается к V2.
7. SDK допускается открыть **только target copy**; сравнить полный tree и active context отдельно. На active ветке oldPi нет tool result из другой ветки. Добавить одну synthetic target реплику, restart/reimport: не перезаписывать новое и не дублировать старое.
8. Fault matrix отдельно: crash/ENOSPC/EACCES/частичный commit/повтор same hash/изменённый source hash/другая origin с тем же ID. Права/source archive/receipt/manifest CAS проверяются независимо от «история выглядит нормально».
9. Negative mutations делаются только в временной копии: future Pi version, duplicate ID/cycle/missing parent, truncated tail без newline, неизвестная SQL schema. Оригинальные fixture files остаются неизменными. Для oldPi tail-варианта убрать только финальный LF в test-owned copy и проверить, что importer его не ремонтирует на source.
10. Отчёт координатора отделяет offline pass от реального native/Windows/Hub acceptance. Пока этот набор не запускался, ни одной такой проверки не считать пройденной.

Подробная матрица потерь, ограничения SDK и существующие regression suites: `../parity-review.md`. Fixtures специально написаны независимо от будущего importer и не зависят от его внутренних имен функций/формата target ID.
