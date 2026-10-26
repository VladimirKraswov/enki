# Enki Hub

Private single-account LAN library and session observability. Python3 standard library + SQLite/WAL; no inference or agent loop. Uploaded files are **stored, never executed by the server**. Plain-text skills can include supporting scripts; existing agent tools and permissions remain responsible for execution on the device.

## Operator deployment

These are configured deployment coordinates, not a live availability check. Verify the current unit/environment before applying changes.

Proxmox `pve`, unprivileged Debian12 CT206 `enki-hub`: 1vCPU,1024MiB RAM,256MiB swap,16GiB rootfs on `nexus-lab` directory storage. Starts with host. HTTPS `https://192.168.31.223:8443`; DHCP MAC `BC:24:11:44:60:EE`: reserve its current IP in the router for stability. Certificate SAN covers hostname/current IP. Native client trusts the public certificate only for Hub; no disabled TLS checks, CORS bypass or system-wide trust change. Connections allowed only from loopback or192.168.31.0/24; no WAN forwarding added.

Code `/opt/enki-hub`; SQLite `/var/lib/enki-hub/hub.sqlite`; TLS `/etc/enki-hub/server.crt` and private `server.key`. systemd service runs as dedicated unprivileged user with filesystem restrictions,512MiB memory ceiling and16request workers. Unused Debian template logind/networkd units masked; headless CT uses ifupdown/DHCP and pct management. Nesting not enabled. Restart verified service/network/autostart.

## Source downloads for legacy clients

Unauthenticated LAN-only HTTPS `GET /downloads/latest/source.zip` downloads the
latest stable source as ZIP. `GET /downloads/latest` provides version, ZIP size,
SHA256 and immutable `/downloads/source/{source-payload-sha256}.zip` and `.json`
links. The latter is the original signed source envelope. These routes share the
existing two-download limit and do not expose private Hub APIs. Sources come
from the same canonical release; publishing stable updates the link automatically.
Use the verified local TLS certificate, then compare manifest ZIP SHA256/size.
See [Windows bootstrap](../../docs/WINDOWS-BOOTSTRAP.md).

## Another Mac / Windows / Linux

1. Install Enki. Settings → **Облачная библиотека**.
2. Enter HTTPS address and paste public `server.crt` PEM. Verify its fingerprint with administrator through trusted channel. Public certificate contains no credentials and can accompany instructions.
3. Administrator logs into Web UI using separate admin key, opens **Устройства → Создать ключ**. Every installation gets a distinct device key; never reuse the Mac key on Windows.
4. Paste device key into Enki, enable sync and optionally texts, save/check. Key stays in OS vault, never returned to WebView. Web UI uses30-minute HttpOnly/Secure/SameSite=Strict cookie and no localStorage credentials.
5. Load catalog, select packages. Skills enter the shared registry of the bundled Enki Runtime. A remote runtime requires installation on its own host; local paths are not injected remotely. MCP descriptors are imported **disabled**, without credentials. Configure/enable in common tool settings. Prompts append to drafts without sending; templates/runbooks are readable local files.

Selected skills/prompts/templates update every5minutes while agents are idle. New unselected packages are not installed automatically. MCP updates require deliberate review. Downloaded revisions have SHA256 checks and safe paths; local edits are preserved with an error. Old revisions remain in cache. Rollback: GET manifest `?revision=HASH`, publish its original files with current `expectedRevision`; devices pull this current version. Only packages are shared, not provider configuration or device secrets.

Private self-signed TLS produces browser warnings until owner explicitly trusts the certificate. Do not bypass errors with agent tools. After fingerprint verification, manually install public certificate in browser/OS trust UI for direct Web UI access. App's isolated trust already supports sync without this extra step.

## Recorded information

Optional user request/final visible text (max16000characters), actual provider/model/effort, agent, project **basename**, times, tokens, tool name/status/duration/redacted error. No hidden reasoning body, raw files/screenshots/audio/video, tool arguments or outputs/terminal dumps. Internal compaction summaries and intermediate tool-associated text excluded unless engine marks final stop. Message errors are collected; runtime failures without a message may not appear. Missing usage is unknown/zero, not estimated.

Known keys/password patterns, URL auth/query secrets, private keys and home usernames scrubbed before durable queue **and** on server. This heuristic cannot guarantee removal of arbitrary secrets/PII. Disable texts/transmission for sensitive tasks. Disabling texts clears queued records, not already uploaded history. Transmission defaults off on new devices; check current settings rather than assuming another device’s policy.

Private atomic outbox:1200records/12MiB,20records per upload,20s timeout, exponential retry up to60s. Oldest records dropped on overflow; count visible. Queue persists until upload/clear/policy reset, with no age expiry. Endpoint+certificate bind protects against replay to another Hub. Chat inference never replayed or blocked by Hub failure. Current/loaded messages captured; cancellable read-only30-day import limited to500sessions/20pages per session per agent, with failures/limits reported. Closed conversations missed before a final observed snapshot may need import: this is not guaranteed server-side event collection.

Deduplication engine+session+message; repeated viewing does not add tokens. Device attribution is **first reporter**, not guaranteed original operator. Total=max(reported total,sum of input/output/cache); reasoning is already included in output. Models split by provider/agent/effort. Cloud day graphs UTC. Durations are reported message/tool wall time; no invented TTFT or GPU tokens/s.

## Issues and later training

Errors form deduplicated **private issue candidates**, not proven defects. Expected negative checks can appear; review/ignore/confirm/resolve. No automatic GitHub posting or self-modifying agent. Approve/reject sessions and attach notes. Admin JSONL export contains approved sessions only, max500/6MiB, labeled reviewed-candidates. Source material requires further secret/PII review, labels, evaluations and train/test separation before LoRA/fine-tuning. Treat history as untrusted data, never system instructions.

Default retention: texts/errors/session notes180days, metadata730days, configurable in Web UI. Daily cleanup removes old tool error text/issue examples too. Catalog versions retained. Device keys can view the owner's common history: **single owner, not multi-tenant**. Revoke lost keys in Web UI. Admin bootstrap credentials in private `/etc/enki-hub` files; never put in Git.

## Backups / restore

Proxmox daily05:00UTC `enki-hub-backup.timer`: consistent SQLite backup API, integrity check, byte-verified NAS copy `/mnt/nas-storage/enki-hub/daily`, latest7copies only. Refuses below2GiB NAS free, never cleans unrelated files. NAS nearly full (~12GiB free); monitor capacity. Full CT backup stages under a local SSD directory with mode0711 (required for the mapped container UID), then copies a private byte/hash-verified archive to NAS; direct NFS staging cannot preserve ownership. Full CT archive under exclusive `enki-hub/ct` preserves service/model-free root and TLS/private keys; repeat manually after updates. Owner-readable only. Daily DB backups contain token hashes, not raw keys.

Full restore: `pct restore NEW_ID ARCHIVE --storage STORAGE`, check address/MAC/certificate/port scope, start. Never run clone with original MAC/IP simultaneously. DB-only restore: stop service, preserve DB/WAL/SHM, unpack private folder, verify SHA256SUMS and SQLite integrity, replace DB as service user, remove stale WAL/SHM **only after preserving them**, restart/check. Daily DB cannot replace TLS private key/app vault; retain full CT archive.

## API and maintenance

Public `GET /health` service/API version only. Bearer device key: `GET /api/me`, `/catalog`, `/catalog/ID?revision=HASH`, `/metrics?device=ID&days=30`, `/devices`, `/sessions`, `/sessions/ID`, `/issues`, `/settings`; `POST /api/ingest` max50records/2MiB. Device-readable `GET /api/model-catalog` returns the shared model catalog (version, per-engine provider definitions); admin `POST /api/model-catalog` publishes the whole catalog with server-side validation and atomic version increment. Devices merge it into local engine configuration and keep selections/exclusions on the device. Admin-only writes `/catalog` CAS `expectedRevision`, `/devices`, `/devices/revoke`, `/sessions/review`, `/issues/review`, `/settings`; admin `GET /api/export` JSONL wrapped in JSON.

`/sessions?limit=50&cursor=...` returns newest sessions with `nextCursor` (max100/page). `/sessions/ID?direction=older&limit=50&cursor=...` opens latest messages; `newer` walks from the beginning. Pages always return chronological records, `total`, and `nextCursor` (max200/page). Cursors are scoped to session/direction, with timestamp+ID tie-breaking. Web UI loads older pages without replacing review-note drafts; review still applies to the whole session. Closing/logout clears private detail and rejects late responses.

Read-only `/api/diagnostics?days=730&device=ID` groups reported errors into heuristic categories, with advice and related-session links. Scans latest25000records, reports coverage/truncation; refusal/cancellation are separate from technical candidates. Raw tool outputs are absent, so completed status does not prove exit0. Imported history lacking usage cannot establish model speed/quality. The **Разбор работы** tab never grants permissions, retries actions or changes issues automatically. Redaction on both client/server is stable across replay; old damaged placeholders cannot be reconstructed reliably.

Import reviewed bundle without SSH: `python3 services/hub/admin.py --endpoint URL --certificate PUBLIC_PEM --key-file PRIVATE_JSON --directory TEXT_BUNDLE --id ID --kind skill --title TITLE`. Server validates text/paths/secrets. Tool `tool.json`: kind:http, HTTPS URL, optional name/envKeys/bearer **without values or secrets**.

Dedicated new CT only: copy directory to `/opt/enki-hub`, `sh deploy/install.sh IP`; never install on Proxmox host/inference VM. Public cert expires after825days; rotation requires new public cert on clients. `python3 -m unittest discover -s services/hub/tests -v`. Installed Mac HTTPS catalog/history and shared skill installation exercised; Windows/Linux live acceptance remains separate.

Concepts follow [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) for opt-in content/reported counts. API is **not OTLP** and claims no full OTel compliance. CT management follows [Proxmox pct docs](https://github.com/proxmox/pve-docs/blob/master/pct.adoc).

Catalog deactivation disables its managed entry on idle sync. Updates preserve a locally disabled skill; re-enable deliberately in shared settings or apply manually. Shared registry and connection saves use compare-and-swap; stale upload/ack cannot target a changed Hub.

macOS local network access requires the normal owner permission; Info.plist contains NSLocalNetworkUsageDescription. Without it the OS may reject LAN connections. See [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy). No firewall/privacy bypass is installed.

## Curated project memory

Authenticated `/api/memory` shares explicit UUID projects, owner-approved fact/runbook candidates, opaque source/revision/digest metadata and expiry. Source changes invalidate after the originating device syncs; expiry is computed server-side. CAS protects edits/reviews; the version ledger records the reviewing device without transferring source ownership. No raw local identity paths/Git remotes, model calls, execution or prompt injection. Memory/versions persist independently of chat retention; expiry/invalidation do not delete content. Up to200projects/200entries per project. Copy **memory.py, releases.py and model_catalog.py together with server.py** during deployment/backup. Web «Память проектов» reads and reviews existing entries. See [workflow and limits](../../docs/PROJECT-MEMORY.md).

## Enki migration

The service and canonical code/data/TLS paths use `enki-hub`. Legacy path and unit aliases preserve existing clients, private gateway paths and backup jobs. The existing numerical service identity and legacy Unix account are retained on upgraded hosts; fresh installations create enki-hub. The previously pinned TLS certificate and IP endpoint are unchanged; its old DNS SAN `arvela-hub.local` remains a compatibility address until an explicit certificate rotation. Historical evaluation source snapshots remain immutable.

## Owner-device application publication

All enrolled non-revoked owner devices may POST /api/updates/device. Candidates
carry full source/UI snapshots and local-check attestations. Hub validates paths,
size, identity, six versions and native fingerprint; isolated release_signer.py
uses the existing pinned key through a Unix socket restricted to the Hub UID.
The HTTP user cannot read that key; uploaded code is never executed. Recheck
revocation/CAS before exposing head. Keys grant app release authority, not other
admin APIs. Signatures remain verified by clients; private key is now held by a
trusted online signer. Deploy device_updates.py/release_signer.py/native_updates.py with server.py
and releases.py, model_catalog.py and durable.py (crash-durable file publication
used by releases and the model catalog: POSIX directory fsync, Windows
MoveFileExW write-through), plus deploy/enki-release-signer.service/install-signer.sh.

## Готовые пакеты приложения

`GET /api/updates/native/stable` (или preview) требует ключ устройства. Ответ:
`pending`/`unavailable` с понятным сообщением или `ready` с подписанным envelope
и digest. Файлы загружаются клиентом с GitHub; Hub хранит только описание.
Проверка GitHub выполняется вне общей блокировки каталога, в один запрос за раз,
с кешем и ограниченным backoff. Нужен исходящий HTTPS к GitHub API и CDN.
Развёртывайте `native_updates.py` вместе с сервером и signer, затем перезапускайте
оба сервиса. Подпись, TLS и существующие ключи не заменяются.
[Полный порядок выпуска](../../docs/HUB-UPDATES.md).
