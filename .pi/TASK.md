# Enki 2.0.17 — связь, фоновое чтение и стабильная панель

W `.local/pi-sdk-migration-20261024/review`, R `/Volumes/Extend/work/Enki`.
H40 `../stabilize-v40`. H39 complete: installed native/UI2.0.16, 263IDs,
Hub/main4a3a52b, CI40488983247 все4success; собственные target/old15 удалены.
Native fingerprint16 82a3a88216c41574197292367ae9938b3960dabf0aedf6749aa463b1e44b57b8.
Не трогать R/untracked opencode.json, истории, ключи, независимые CLI.
Owner AX только emit:false + whitelist: истории содержат секреты.
Не автоматизировать Terminal/SecurityAgent, не запускать GPU/генерацию/старые задачи.

## Дефекты

Screenshot23:21 recovering SSE. Сейчас native216 status оба stream open,
busy, безerror. Исходную причину именно того разрыва не доказали.
В events.ts отсутствовали deadlines header/hello/read; новая попытка не
обновляла endpoint после сетевого отказа. Добавлены20s handshake/45s idle,
сервер15skeepalive сохраняетживость, bounded refresh, seq replay безповторакоманд.
User Medic->DreamUI сам: control bridge sessions/conversation и managed wait
вызывали selectDirectory/selectSession. Это подтверждённый focus-stealing путь.
Read-only проекция через existing scopedAPI; managed continuation исходному
session/model через existing durable backend.prompt, не visiblecomposer.
Browser_presence nativefallback running:false трактовался какclosed ->hide/reveal.
Теперь unknownpresence не меняетпанель; callbackmonitor fenced поhost/dir/chat.

## Проверки/далее

Focused65pass (6files): streams, background focus, busy polling, late read, browser.
Typecheck pass. Native fingerprint совпадает с16.
Focusfixture сначала использовалтотжеmessageID дляновоготурна ->correcttimeout,
исправленнаa2. Busy-poll bounded1s и late read guards проверены; diff review выполнен.
Full release:local stable no skips, Hubобапакетаexact+signatureverify, mainpush.
Если nativefingerprintтотже16, активироватьштатныйhotUI безостановкиownerjobs;
не утверждать native17 безпереустановки. Сохранятьlatestвыбор и263истории.
