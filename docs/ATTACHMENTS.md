# Вложения и CPU-помощник

## Использование

В поле сообщения можно перетащить файлы из Finder, нажать кнопку «Приложить файлы» или вставить файл/изображение из буфера. Нативное приложение принимает системное событие перетаскивания Tauri: обычный HTML `drop` на macOS может не получить файл из Finder. Разрешение на чтение выдаётся только перетащенным файлам, без общего доступа к Рабочему столу. Вставленный текст от 8000 символов становится отдельным `.txt`-вложением; короткий текст остаётся в поле. Картинки показываются миниатюрами, остальные файлы — именем и размером. Черновики вложений хранятся в IndexedDB этого приложения отдельно по серверу, каталогу и сессии; после перезапуска они восстанавливаются. Снять вложение можно до отправки. Кнопка + раздела «Источники» в панели контекста открывает тот же picker композера через типизированный мост и только для того же чата; выбранные файлы попадают в черновик чата, для которого picker был открыт. До подтверждения средой выполнения Enki вложения не удаляются. При неопределённом результате запроса приложение не повторяет отправку автоматически.

Не более 12 файлов, 50 МиБ на файл и на все вложения одного запроса. Этот предел выбран для надёжности клиента и локального сервиса; **он не является заявлением о точном лимите Codex Desktop**. Текстовые файлы допускают до 750 000 символов на файл. Больший текст отклоняется явно, без незаметной обрезки. Во время работы агента запросы с вложениями можно добавлять в очередь или передавать как уточнение.

Проверяются реальные возможности ввода выбранной модели из каталога моделей среды выполнения Enki. Изображения PNG/JPEG/GIF/WebP передаются напрямую только моделям с `image`; прочие форматы изображений преобразуются в PNG средствами WebView, если декодер их понимает. Ядро (Pi SDK) принимает только текст и изображения, поэтому PDF, аудио и видео всегда сначала преобразуются. У текущих `qwen38-flash-next` и `qwen-v100` подтверждены `text` и `image`. Поэтому PDF превращается в текст и до 12 страниц JPEG, аудио — в текст через GigaAM, видео — в до 12 кадров JPEG и расшифровку звуковой дорожки. Приложение объясняет ошибку, если модель не принимает необходимые изображения или преобразование не удалось. Для PDF длиннее 12 страниц кадры выбираются из разных частей документа, извлекается текст всего PDF до указанного предела, а ограничение указывается в содержимом отправляемого файла.

Исторические сообщения показывают имена вложений, но не открывают потенциально опасные `file:` или `data:` ссылки из истории. При редактировании сообщения с вложениями создайте новое уточнение.

## Развёртывание

CPU-сервис работает в отдельном непривилегированном Proxmox CT **205 `oc-helper`**, Debian 12, 4 vCPU/4 ГБ, `ubuntu-2tb` 20 ГБ, системный `oc-helper.service`. Конвертация использует `ffmpeg`, `poppler-utils`, `tesseract-ocr` с русским/английским языками. Одновременно выполняются не более двух преобразований, отдельный процесс ограничен памятью 3 ГБ; файлы существуют лишь во временном каталоге на время запроса и удаляются после него. Пользовательская модель/GPU и среда выполнения Enki не перезапускаются и не делят с ним процесс.

Сервис принимает только запросы от Proxmox-хоста `192.168.31.2`. С Mac прямое обращение к адресу CT возвращает HTTP 403. Пользовательский LaunchAgent `dev.vladimir.oc-helper-tunnel` поднимает SSH-туннель `127.0.0.1:18107 → pve → CT205:8080`. Скрипт `services/helper/tunnel.sh` заново узнаёт DHCP-адрес CT и переподключает туннель, когда адрес меняется. Установка туннеля: `sh services/helper/install-tunnel.sh`. Настройки Desktop → «Сервисы помощника» содержат локальный адрес, проверку соединения и фактически объявленные сервисы. Настройки → «Диктовка» отдельно управляют действующим **GigaAM ASR на CT201**, `192.168.31.59`, моделью `gigaam-v3-e2e-rnnt`. CT205 готовит аудио и отправляет его на GigaAM через приложение, поэтому ключ и настройки ASR не хранятся в CT205.

`GET /health` отдаёт версию, список сервисов и лимит. `POST /v1/convert` с `X-Kind: pdf|audio|video` и бинарным телом возвращает извлечённый текст, JPEG и аудиофрагменты в base64. Источник сервиса — `services/helper/server.py`, unit — `services/helper/oc-helper.service`. Новые CPU-инструменты можно разместить в этом контейнере отдельными ограниченными unit. MCP-серверы подключаются в общем каталоге «Навыки и инструменты» после их отдельного развёртывания ([возможности](CAPABILITIES.md)); **CT205 пока не предоставляет собственного MCP endpoint**. Это выделенная площадка для таких сервисов, а не скрыто добавленный агенту набор MCP-инструментов.

Проверка без вызова модели: `curl http://127.0.0.1:18107/health`. Тестовый PDF можно передать через `/v1/convert` с `X-Kind: pdf`. Не отправляйте конфиденциальные файлы в сторонний endpoint: поле настроек допускает только loopback HTTP.

## ZIP attachments and queued corrections

ZIP files retain their original bytes. Enki saves a private, independent copy under its attachment directory, then gives the agent a small file reference (path, filename, byte count and SHA-256). Archives are not sent as unsupported model binary parts or unpacked automatically. The agent inspects them through its file/archive tools, subject to the chat's access policy.

Local staging checks the runtime's reported home against the current computer. SSH staging uses the already connected host and its exact tunnel endpoint, strict host keys, stdin streaming and a 60-second deadline. A failed remote transfer never falls back to a local path. Archives belong to the recorded history and survive draft/queue cleanup.

The runtime preserves the reference in the prompt and its JSONL transcript and reconstructs source metadata on live echo and reload; the source gallery projects it as the original ZIP. References do not inline the archive's contents in the model context or telemetry. ZIP format detection checks the container signature; the agent's archive tools still validate and inspect its entries. (A generated **images.zip** is a different file: it is saved through the result card, see [images](IMAGE-GENERATION.md).)

Queued prompts are stored by the runtime with their own copies of the prepared attachments. The file-count button opens a removable file list. Removing a queued file is an edit of that runtime item; failure keeps the original item. Composer removal updates the visible draft immediately, and sends wait for pending storage changes before selecting current attachment IDs. A removed file from an older render is excluded.

**Now** applies an entry's active edit first, including removed attachments, then sends exactly one correction as an SDK steering message, delivered at the next model/tool boundary. Stop during preparation prevents a late correction from restarting the agent. Preparation failures retain editable files; ambiguous outcomes are never retried automatically. Blocked operations explain the reason and retain the queued request.

Validation covers queued removal/edit/Now in the actual Composer and isolated Chromium, ZIP byte preservation and bounded stdin transfer, and live/durable references in the runtime transcript. Native Windows/Linux and live SSH qualification are separate from the Mac checks.

Local archive previews re-authorize only the exact recorded app-owned file on each click, including after restart; unrelated paths and symlinks are rejected.
