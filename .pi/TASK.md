# Текущая задача — Enki 2.0.10

W: `.local/pi-sdk-migration-20261024/question-input`; доказательстваstabilize-v33.
Не запускать старые задачи, офисных агентов и GPU benchmarks.

Установленаnative2.0.8 (строгая сверка31610файлов/codesign, executableSHA
72690963b1806a4c51689fa9b2dfea967379d5e5b707dab2bc716d544fea9539).
Все261 каталога/архив255/47239/211229 сохранены, один прежний tombstone.
2.0.9/c8c7324 опубликована после оригинальных canonicalgates (686.87s),
Hub/source/hot byte-exact verified; UI209 применён штатно без сменыruntime
19583850cfe05f94/endpoint65396. Native209 CI40369429009: Mac/Linux прошли,
Windows REFUSED: exact runtime equality gate found stale removed packages
in cached target/release/agent-runtime after Tauri copied over it.209native НЕ
опубликован. Исправить210 и заменить им native209; не менять immutable209source,
не ослаблять проверки. Новаяbuild.rs sync: source/current +stage проверены
существующим artifact verifier, атомарная замена выходногоagent-runtime,
неизвестные старые файлы сохраняютсявнепакета, валидныйпрежнийbuild disposable.
Watch target/enki-agent/current/runtime-manifest.json; source/node не меняются.
FocusedRust3tests PASSED, реальная Cargo сборка также синхронизировала
подготовленный210runtime. Перваяошибкаbuild-dependencylibc исправлена.
Новыйhelper добавил serde/unicode/libc только build-deps ужеlocked crates.

209упаковка удаляет чужие esbuild и только доказуемые дубли, runtime
668255585→368984894B в отдельнойкопии;25foreign+52duplicates. СистемныйNode/
bootstrap НЕ внедрён, автономный закреплённыйNode оставлен явно. См.docs/RUNTIME.

210: QuestionCard использует общийVoiceInput с отдельным durable draftTarget,
общийAttachmentChip, выбор/clipboard/native drag-drop, отдельный scopedIDB.
Текст/выбор переживают навигацию. Новые черновики не подменяют основной prompt.
Ответ с готовыми частями идётв /questions/:id/reply; runtime проверяет только
подготовленные text/images безHTTPfetch, файлы SHA256persist доACK, SSE metadata
безblob; тот же ожидающийquestionTool возвращаетimage/text в SDK. Есть capability
questionAttachments, старое ядро явно отказывает без потери черновика.
На Mac исходники картинок также попадают в обычный imageContext для правки;
nonVision получает явные reference captions. Длинный голосовойответ уходит
полным текстовым файлом. Двойнойклик fencedref, Ctrl/⌘Enter, ошибки сохраняютввод.
Вопрос не закрывается при сохранённомнераспознанномзвуке: recovery/discard
снимают sendfence. PiDialog input/editor тоже диктовка с отдельнымdraft и сохранениемprefill;
строковый APIплагина не получает бинарныевложения.

Focused:37UI +11store,28runtime incl.realSDKimage/toolResult и однаuserentry,
SDKcontract/types/architecture/docs прошли дофинальногоревью. BrowserQA actual
components в private fixture, обе темы/узкаякомпоновка/realPNG draft +send прошли;
скриншоты stabilize-v33. Никакой model/GPU inference не запускался.

Далее finaldiffreview, cleancommit210, ORIGINAL npm run release:local -- stable
на pinnedNode и тёплом stabilize-v30/cargo-target/jobs2. VerifyHub/main/3packages.
Установитьштатно только authoritative idle, сохранитьпоследнеевладельческое
задание копированияSD. Не прерывать rawdd/не отвечать за владельца на вопрос.
Текущийownerчат c7433ceb-3f9b-48a1-9a92-9bbb317221da. Не повторять прежнее
backup-only уточнение: владелец позднее изменилзадачу на копиюSD.

Послеустановки проверитьruntimeверсию, questionAttachmentscap, истории/одинGUI,
UIвсамойEnki, подписи и updater readiness. Убрать только свои старыеартефакты.
Не управлятьSecurityAgent/Terminal. AXполныеsidebarсодержатсекреты; emit:false
+строгие anchoredфильтры, не broad progress(совпадает сbashкомандами).
Сохранить независимыеCLI/rootuntrackedopencode.json.
