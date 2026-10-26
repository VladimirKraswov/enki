# Документация Enki

Здесь находятся действующие инструкции. Версии и API определяет текущий код,
а статус выпуска — квитанция и проверка установленного приложения. Завершённые
задания и разовые отчёты доступны в Git, не смешиваются с руководствами.

## Работа в приложении

- [Замысел и поведение](PRODUCT.md), [настройки](SETTINGS.md), [чаты и компьютеры](WORKSPACES.md).
- [Контекст задачи](CHAT-CONTEXT.md), [контекст, очередь и диктовка](CONTEXT-QUEUE-VOICE.md), [таймеры](SCHEDULES.md).
- [Вложения](ATTACHMENTS.md), [изображения и материалы](IMAGE-GENERATION.md).
- [Браузер](BROWSER.md), [профиль браузера](BROWSER-PREFERENCES.md), [управление компьютером](COMPUTER-USE.md).
- [Модели](LOCAL-MODELS.md), [навыки и MCP](CAPABILITIES.md), [создание навыка](SHARED-SKILL-AUTHORING.md).
- [Библиотека Hub](HUB.md), [память проекта](PROJECT-MEMORY.md), [карта проекта](PROJECT-NAVIGATION.md).
- [Результаты задач](TASK-RESULTS.md), [диагностика времени](TASK-DIAGNOSTICS.md).
- [Обновления](HUB-UPDATES.md), [данные и восстановление](DATA-RECOVERY.md), [системный доступ](ACCESS.md).

## Разработка и сопровождение

- [Разработка](DEVELOPMENT.md), [платформы](PLATFORMS.md), [проверки](VERIFICATION.md), [живая приёмка](PLATFORM-ACCEPTANCE.md).
- [Архитектура](ARCHITECTURE.md), [runtime](RUNTIME.md), [слой клиента](AGENT-BACKENDS.md), [API](API.md).
- [Обновление SDK](SDK-UPGRADE.md), [удалённый runtime](REMOTE-RUNTIME.md).
- [Мастерская и выпуск](SELF-DEVELOPMENT.md), [Windows bootstrap](WINDOWS-BOOTSTRAP.md), [задание Windows-агенту](WINDOWS-AGENT-PROMPT.md).
- [Внешнее управление приложением](AGENT-CONTROL.md), [длительные задачи](AGENT-FACTORY.md).
- [Инструменты проекта](PROJECT-TOOLS.md), [надёжность инструментов](TOOL-RELIABILITY.md), [оценки задач](EVALUATIONS.md).
- [Карта инфраструктуры](AI-ENVIRONMENT.md), [управление моделями](MODEL-SERVICES.md).
- [Имя и идентичность](BRANDING.md), [иконка](ENKI-ICON.md), [текущий план](../ROADMAP.md).

## Сервисы и встроенные ресурсы

Операторские инструкции: [Hub](../services/hub/README.md),
[ASR](../services/asr/README.md), [изображения](../services/images/README.md),
[Strata](../services/strata/README.md), [V100](../services/v100/README.md).
Публикация клиента сама по себе не развёртывает серверные службы.

Встроенные `SKILL.md`, prompt мастерской и описания fixture рядом с исходниками
имеют отдельное назначение. Тестовые снимки в `test/fixtures/` сохраняют байты и
происхождение; они не являются инструкциями для выполнения.

## Поддержание документации

После изменения поведения обновляйте его руководство и связанные ссылки.
Не добавляйте в общие документы логи каждого запуска, абсолютные пути к временным
сборкам, секреты, незакрытые старые поручения или неподтверждённое «проверено».
В `.pi/TASK.md` оставляйте краткий текущий checkpoint. Незавершённые функции
отмечайте в roadmap; описывайте как доступные только реализованные возможности.

Перед коммитом выполните `npm run check:docs`: ссылки проверяются также в CI
и до публикации. Неизменяемые fixture-документы не считаются руководствами.
