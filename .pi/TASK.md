# Enki 2.0.16 — восстановление MCP после временного отказа

W `.local/pi-sdk-migration-20261024/review`, R `/Volumes/Extend/work/Enki`.
H39 `../stabilize-v39`; H38 завершена: native/UI2.0.15, 263 записи, original
session/model восстановлены, Hub/main c32cc50, CI40474811011 все4jobs success.
Old14 bundle и H38 Cargo target удалены; H38/ACCEPTANCE-CHECKPOINT.json complete.
R/untracked opencode.json сохранить, независимые CLI/истории не трогать.

## Текущий дефект

Screenshot12:22: image MCP startup failure. Installed15 native CLI initialize+
listTools теперь healthy:8tools,6416ms, H39/IMAGE215-MCP.json. Генерация не шла.
SQLite latest mcp.status: два прежних чата all6connected, текущий busy чат
images=error/tools0, остальные5connected. Причина именно исходного handshake
не восстановима из общего сообщения; не утверждать доказанный timeout.
При startup error worker не повторял discovery после восстановления сервиса.

## Изменения UI16

McpRecoveryNotice + одноразовый бюджет на episode/host/session; ждёт idle,
готового SDK UI и synced draft. Store.recoverMcpConnection только existing
refreshCapabilities(directory) + same-session UI.open; guards после await,
не отправляет commands/prompts, registry не меняет, action не повторяет.
Учитывает startup notice после reload без mcp.status snapshot. Штатные
startup warnings заменены одной карточкой, остальные ошибки tools сохранены.
Focused14pass до последних readiness guards; tsc прошёл, затем повтор/полные
checks. UI-only: проверить nativeFingerprint совпадает с15 cfb456dba14c0e2174e42248b22e09b98c8479e9626c5618bfce14d81a8d4226.

## Далее

Diff review + focused tests + commit16. Полный release:local stable (без skips),
fresh оба подписанных пакета Hub и main; packages CI dispatch. Применить hot16
через штатный updater без остановки агентов. Actual current worker images8
connected после завершения текущего ответа; не прерывать/не возобновлять чужую
работу/не посылать prompts, не запускать генерацию или GPU. Проверить263history.
Owner AX только emit:false/whitelist, старые titles/commands содержат секреты.
SecurityAgent/Terminal UI не автоматизировать. Истории/ключи/backup сохранять.
