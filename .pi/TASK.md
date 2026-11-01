# TASK checkpoint (2026-11-02, session 8a5e5bd7)

## Цель
2.0.29: перезапуск после source-обновления перестаёт выглядеть падением.
Квитанция `last-install.json` получает `ts`; первый запуск после свежей
подтверждённой установки показывает штатный toast (версия + «данные
сохранены»); `desktop_updates status` отдаёт `installedVersion`.

## Ограничения
TMPDIR ВНЕ репозитория: /Volumes/Extend/work/enki-release-tmp (0700, Extend;
внутри .local project-map падает — git-ignore-aware). NODE_OPTIONS≤1024
(768), cargo jobs ≤2. Не трогать d1e46f3/eecb774, opencode.json, Eridu.
Часы машины могли давать скачок (timed шагал −2ч36м за перезапуск 2.0.28):
notice молчит для будущих/устаревших/бессоюзных receipt — неannounce заново.

## Проверенные факты
- freshApplyNotice: mount-тест + таблица (свежий/устаревший/будущий/без ts/
  interrupted) — test/update-applied-notice.test.ts 4/4; прежний код: 3/4
  падали (proof .local/catalog-apply-audit/old-code-proof-2.0.29.log).
- bridge installedVersion — agent-control-updates 6/6.
- Rust receipt ts — hub_updates 26/26, lib 286/286, clippy -D warnings, fmt.
- UI vitest 201 файлов EXIT=0; runtime 416/416; sdk-compat fail 0; tsc/build;
  architecture 217; check:bundle OK.

## Следующий шаг
release:local stable 2.0.29 → квитанция/head/пакеты → push → авто-apply
(desktop_updates). Наблюдателю после apply: toast «Enki обновлён до 2.0.29…».
