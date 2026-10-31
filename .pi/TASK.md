# TASK checkpoint (2026-11-01, session 8a5e5bd7)

## Цель
Один релиз 2.0.28 (>2.0.27): (A) catalog-apply UX (no-op при занятом агенте,
свежий guard, непостоянный blocker) + (B) отказ команды до dispatch не исчезает
(Eridu-случай): ledger-rejection после durable ACK → «Не отправлен» в исходном
чате с причиной, черновик/скрытие, desktop_wait/conversation видят отказ.

## Ограничения
TMPDIR ВНЕ репозитория: /Volumes/Extend/work/enki-release-tmp (0700, Extend;
внутри .local project-map падает — git-ignore-aware). NODE_OPTIONS≤1024
(768 использован), cargo jobs ≤2, без параллельных инференсов. Не трогать
d1e46f3/eecb774, opencode.json, Eridu-сессию/код/VM. Рекурсию mock
(getMockImplementation) в catalog-apply-ux не возвращать.

## Проверенные факты
- Catalog: 41/41 (catalog-apply, -ux 6, editor, review, model-catalog, bridge).
  Блокировка — неперсистентный status, автоочистка при idle; guard перед CAS;
  fresh store.state после preview; no-op пишет только appliedPi/appliedVersion.
  Прежний код: 4/6 падали (proof .local/catalog-apply-audit/old-code-proof.log).
- Отказ до dispatch: journal accepted→refused|cancelled (Rust whitelist+тест),
  runtimeSync.commandRefused, store.settlePreDispatchRefusal/notSent/
  refreshNotSent/dismiss/return, ChatView-карточка, RecoveryCenter метки,
  bridge conversation.notSent + wait outcome failed. test/command-refusal 6/6.
- Runtime: bounded retry discovery (resolve/resolveMissing ≤2, same command,
  scope-change НЕ ретраится, ensureRun без диспетчерских ретраев — свой
  same-requestKey цикл в hub.ts). hub-retry 3/3; hub-lease-authority+
  model-alias 41/41.
- UI vitest 1238 — кроме project-map, зелёный при TMPDIR вне репо (5/5).
- chat-window мок дополнен портом notSent (4/4).

## Изменённые файлы (кроме каталог-пакета)
src/operations/journal.ts, src/state/{runtimeSync,store,prefs}.ts,
src/components/{ChatView,RecoveryCenter}.tsx, src/control/bridge.ts,
src-tauri/src/journal.rs, resources/agent/src/execution/dispatcher.ts,
test/command-refusal.test.ts, resources/agent/test/hub-retry.test.ts,
test/chat-window.test.ts, test/catalog-*.

## Следующий шаг
1) Полный npm test + runtime suite + cargo (fmt/clippy/test) при верном TMPDIR.
2) tsc/build/architecture/bundle; docs (HUB-UPDATES про refuse-контракт?),
   version 2.0.28 во всех манифестах; review diff; commit.
3) release:local -- stable (TMPDIR=/Volumes/Extend/work/enki-release-tmp),
   receipt+served+2 пакета, push same HEAD, release:packages, desktop_updates
   apply последним (source-обновление: native fingerprint изменён journal.rs →
   жёлтый, idle gate). Наблюдатель проверит живые клики catalog + refuse.
4) Маркер ENKI_CATALOG_DELIVERY_VERIFIED только после применения и проверок.
