# Текущая задача — Enki 2.0.14

W `.local/pi-sdk-migration-20261024/review`, R `/Volumes/Extend/work/Enki`.
Evidence H37 `../stabilize-v37`; предыдущие H30–H36 сохранять.
Установлены native2.0.10 / hot UI2.0.11; exe SHA256
338f09d142e8851774d22219252b1538e15203284eab7de0b91a4faa3d72201d.
Полная установленная приёмка210 вH33, горячая211 вH34. Не getApp во время замены.

## Выполнено

2.0.13 / d1d06b181b4aac1f1e17f307be1dc37700001f79 опубликована Hub/main;
1172 UI /408runtime /276Rust; CI40401499982 три ОС+publisher success.
Включает микрофон/файлы в вопросах, MCP bounded startup recovery, Bash always
для разных команд в одном чате с сохранением deny/read-only/других scopes,
новые явные подписи кнопок, журнал ACK/snapshot для карточек и статусов связи.
Подробности и доказательства H33–H36. 263 записи каталогов, 255/47239/211229
архивных sessions/messages/parts, один старый tombstone; все живые JSONL вEnki.

## Подтверждённые блокеры установки13

Штатное скачивание GitHub оборвалось по15мин:55787520 из113857995байт,
контрольный curl range~107КБ/с. Затем штатная source build13 прошла runtime
(0.85.1-4f8fff9b40b64051) и frontend, но холодная Rust compilation оборвалась
точно по40мин без ошибок компиляции, total57:38. CacheHub hits0/writes403.
Реальный лог сохранён H37/source213-timeout.log. Артефакт НЕ готов/НЕ установлен.
Не выдавать подготовку за готовую, не внедрять ready state/фальшивые receipts.
Его рабочая папка:
~/.local/share/enki/update-runtime/build-14c939fc7711a2f82d8e8086b3c17345cbb4d6246b55f34d9d2732d44d9b56c4/attempt-5df4bf87243d9c7262d21b1ea974d1e2

## Исправления14 в работе

Nativedownload finite size-aware budget15..60min at32KiB/s +2min; индивидуальные
connect/read deadlines, cancel, exactsize/hash/signature неизменны. Source runtime
40min / coldcompile90min, прежние2jobs и bounded owned-tree termination.
Ошибки отмены/времени/8MBлога отдельные; реальные короткие subprocess tests.
Focused Rust tests:26passed/2ignored (hub_updates), logH37/focused-native.log. Затем diff review,
commit14, исходный npm run release:local -- stable без пропусков, H30/cargo-target/jobs2.
Fresh Hub/main+оба подписанных пакета, CI native14. Можно после Hub14 сразу
начать штатную sourcebuild14 через старый host10: кэш403 предыдущих компиляций
уже наHub, ожидаются совпадения (проверить, не утверждать заранее). Не делать
лишний перезапуск13. Финал — native/UI14, настоящий installplan/hash/codesign,
MCP/runtime/history audit263+, одинGUI, cleanup proven own outputs.

## Безопасность и текущие работы владельца

Не запускать офис/Igor/старые задачи/GPU inference/benchmarks. Source config
R/untracked opencode.json сохранить; независимые CLI/истории не трогать.
Owner AX только emit:false+строгий whitelist/booleans: старые titles содержат
секреты. SecurityAgent/Terminal не автоматизировать. CUA rewriteDocumentation
после compaction. App handle enkiUpdateApp, текущий безопасный экран Updates.
NativeMCP210 helper H33 сохраняет весь stdout private. tools desktop_sessions/
conversation/select могут менять UI directory и добавлять projectless папки как
проекты; не использовать для массового read-only обхода.

VM10c15e8e-ee2b-4e5b-aeaf-035f3b342e15, Медикf76c7e35-a25c-4f4b-b372-a2e588f5845c,
TrimUIc7433ceb-3f9b-48a1-9a92-9bbb317221da. Сейчас никаких сессий нами НЕ остановлено;
последний SQLite snapshot: open executions0, commands completed45/cancelled8/
rejected7, pending running0. Не возобновлять завершённую работу. Перед install
снова проверить, ждать authoritative idle; если реально останавливать по уже
данному разрешению, возобновить только их и ровноодинраз без старого backup prompt.

Сохранить тёплый H30/cargo-target до приёмки, затем удалить только собственные
build outputs и проверенные previous app2.0.8/2.0.10; сохранять receipts/history/
исходные архивы. Известные предыдущие cleanup вH32/H34.
