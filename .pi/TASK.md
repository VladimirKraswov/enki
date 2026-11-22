# TASK — 2026-11-22: доступ к облачным моделям через Hub / 2.0.100

Владелец перенёс ключи внешних провайдеров на Hub (в приватном
`/etc/enki-hub/model-services.json` уже лежат `deepseek` api_key и `kimi-coding`
oauth), но в чатах DeepSeek перестал работать: устройство не получало ключ.

Причина найдена по контрасту контрактов: Hub отдаёт `POST
/api/model-services/credentials {providerID}` (проверено живым запросом — 200 и
ключ), а нативный broker пускал только `catalog/prepare/status/release/inspect`.
Запрос `model-services/credentials` падал на нативной стороне с «Недопустимый запрос
Hub», `HubModelCredentials.credential()` глотал ошибку и возвращал null, поэтому
`adoptHubCredentials()` ничего не импортировал в vault и модель оставалась без
ключа. Ключевые слова: allowlist путей в `hub.rs` (`model_control_path`,
`broker_request`).

Сделано: `model-services/credentials` разрешён для POST с телом ровно
`{providerID}` (символы как у остальных ID, без endpoint/произвольных полей) и
добавлен в список broker-путей; тесты на принято/отклонено (лишнее поле, пустое
тело, «;» в ID).

Проверки: `cargo fmt --check`, `cargo test` (301 PASS), `cargo clippy
--all-targets -D warnings`, `npm test` (1339 PASS), `npm run build`,
`check:architecture`, `check:bundle`, `check:docs`. Hub-код не менялся.

Непроверенным до живой поставки остаётся: после применения 2.0.100 ключ deepseek
появится в vault устройства и DeepSeek ответит в чате (проверяется в Мастерской
после обновления: «Обновить модели» или перезапуск).

Следующее: release:local stable (PATH += ~/.cargo/bin,
ENKI_NATIVE_EXECUTABLE=/Applications/Enki.app/Contents/MacOS/enki) → проверить
квитанцию и пакеты → штатно применить обновление → живая проверка DeepSeek.
