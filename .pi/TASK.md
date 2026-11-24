# TASK — 2026-11-24: панель настроек macOS не открывалась после обновления / 2.0.106

Задание владельца: после обновления 2.0.105 при запуске Enki показывал красные
строки разрешений, а «открыть системные настройки» ничего не открывал; спросил,
в чём проблема и можно ли это зафиксить и выпустить.

Причина (воспроизведена по коду 2.0.105): `openPermissionSettings` звала
`@tauri-apps/plugin-opener`, а capability `opener:default` разрешает только
http/https/mailto и отвергает `x-apple.systempreferences:` — фронт ловил
«Not allowed to open url» и показывал красную ошибку. Ручной `open` того же
URL в терминале открывал панель — владелец включил доступ, «сработало».

Сделано: реbase ранее не опубликованной правки «permissions: open macOS TCC
panes natively» (команда `system_permissions_open_settings` в
`src-tauri/src/system_permissions.rs`, белый список схемы, проверка main-окна)
на main 2.0.105 + фикс clippy в `runtime/config_fs.rs` + стресс-устойчивый
тест context-fit. Версии 2.0.106 во всех манифестах.

Проверки: `vitest test/permission-center.test.ts test/permission-card.test.ts`
(9 pass), `cargo test --lib system_permissions` (см. лог), `npm run build`,
`check:architecture`, `check:bundle`.

Осталось: следующий срез удалённой доставки — WebSocket-транспорт вместо
опроса `remote/sync` (контейнер Hub: Python без pip).
