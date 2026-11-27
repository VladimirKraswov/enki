# Images in Enki

Settings → **Генерация изображений**: enabled switch, base service URL, OS-vault API key and a read-only connection check (`GET /health`). There is one model and one workflow — nothing to select. Source defaults contain only the LAN endpoint, no secret. Local operator provisioning can place a private 0600 `image-api.bootstrap` beside `image-generation.json`; installed Enki imports it into its own OS vault on first use and removes the temporary file. Existing keys are preserved. This is not a release credential and must never enter Git/Hub packets.

## The service

`<endpoint>` is the Hub's image route, normally `http://192.168.31.59:8080/api/images`. The Hub is the single gateway: callers talk to the Hub, the Hub talks to ComfyUI running **Qwen-Image-Edit 2511** (GGUF Q6_K, Lightning 4 steps) on a Tesla V100. Text-to-image and image editing are the same model. All routes need `Authorization: Bearer <token>`:

- `GET /health` → `{status: ready|degraded, model:{id,title,steps,multiple,max_side,max_pixels,max_items,modes}, engine:{name,device,vram_total_mib,vram_free_mib}, queue:{pending,running}}`;
- `POST /jobs` → **201** job. Body: `prompt`, `width`, `height`, `seed`, `items[]` (≤8), `source_image.data_base64`, `strength` 0…1. Unknown fields are ignored;
- `GET /jobs/{id}` → job with `state`, `progress:{phase,step,steps,percent}`, `images[]` and `error` when failed;
- `GET /jobs?state=&limit=` — recent jobs;
- `DELETE /jobs/{id}` — cancel a queued or running job (the Hub interrupts ComfyUI);
- `GET /jobs/{id}/images/{name}` — PNG;
- `GET /jobs/{id}/metadata` — request and inference parameters.

States: `queued → running → completed | failed | cancelled`. Progress is real: step counters arrive from ComfyUI over its WebSocket, so `sampling 1/4 … 4/4` and percent are actual sampling, not a timer. Limits: sides 256–1536, multiples of 16, `width×height ≤ 1048576`, prompt ≤ 2000 characters, source ≤ 8 MiB.

## Shared MCP `enki-images / «Генерация изображений»`

- `image_inputs`: list this session’s attached originals and the last generated result, plus Vision capability and remaining attempts;
- `generate_image`: start drawing (`prompt`, optional size/seed);
- `generate_icon_pack`: 1–8 subjects in one job with a shared style, palette and background;
- `edit_image`: real image-to-image from `attachment:N` or `latest`; `strength` 0…1 is an optional edit-intensity control, omitted for normal instruction edits;
- `image_status`: readiness or job progress, bounded 20 s wait, stops on a terminal state;
- `get_images`: retrieve finished PNGs, save them in `.enki/generated-images/<job>/`, show cards, and report the job’s inference metadata;
- `cancel_image`: cancel without deleting already finished files.

The model should call these tools for raster-generation requests, retrieve and show the actual output, and visually inspect it when capable. A returned text description is not an image. Non-Vision models get file references without image-input blocks; Vision gets actual PNG blocks when requested. Never claim visual review without seeing those pixels.

## What the chat shows

While a job runs, the turn shows one **progress card per job** — phase from the engine
(`В очереди → Готовлю задание → Загружаю исходник → Рисую 2 из 4`), an accessible percent
bar and **Отменить**. The card is driven by a native proxy (`image_job`,
`image_job_cancel`, `image_job_result`): the WebView never receives the service key, and
polling stops as soon as the job reaches a terminal state. Errors show the service’s own
message, never a fake success.

If a turn ends before the agent retrieved the pictures (Stop, a long edit, a closed
window), the card saves the finished PNGs into `<chat>/.enki/generated-images/<job>/`
itself and shows them, so work already paid for on the GPU is not lost. Once the turn’s
own result cards contain the same job, the progress card disappears instead of repeating
the image. Cancelled and failed jobs keep a one-line honest note.

## Editing and budget

Attach a PNG/JPEG/WebP and ask «Перерисуй это в стиле аниме». Enki privately stages the original bytes for the actual session/message; the agent calls `image_inputs` → `edit_image(source=attachment:1)` → `image_status` → `get_images`. A follow-up «Поменяй волосы на синие» uses `source=latest`, the last completed primary image of this session. A new attached original replaces the retained one; edits keep the source aspect unless a size is given and send the actual pixels, never a path.

**At most two total generation jobs per human request** — initial plus one correction, across generate/pack/edit. This is enforced by a durable per-session journal under a native OS file lock, survives restarts and concurrent calls, and does not refill on timer wakes. A lost acknowledgement is recovered by matching the newest live job’s metadata, never by a replayed POST. A new human message grants a new two-attempt budget.

Results are saved without overwriting files in the agent workspace `.enki/generated-images/<job>/image-NN.png`; generated cards stay visible when «Ход работы» is folded and duplicate retrievals do not duplicate cards. PNG dimensions/bytes and generated-file paths are bounded. When an agent’s file is on another device, Enki fetches only the exact job image from its configured authenticated service (`/jobs/{id}/images/{name}`), never a tool-supplied URL.

No previews, ZIP bundles or material maps exist any more: the Hub returns one PNG per generated item and optional edit metadata. Whole-frame editing is what the model does; exact pixel preservation, masks and transparency are not promised.

## Shared runtime self-repair

Shared tools (images, web search, project map, schedules) are part of the product, not a
manual setup step. Every session start calls a bounded repair: the runtime directory gets
the files this build embeds, `node.json` is restored when a profile lost it, and the pinned
MCP SDK is installed once per app run only when it is actually missing (offline file
refresh never runs npm). A successful repair makes the tools appear in every chat,
including projectless ones; a failed one is reported as `mcpUnavailable` with the reason
instead of failing the session. This is why an app update cannot leave the tools
half-installed: the next session start reconciles the files with the new build.

Native update required for settings commands and shared runtime. A UI-only activation cannot install the native reader, OS vault integration or shared tool files. Publication does not interrupt active agents; install through the normal idle native-update flow.

Upgrade to this schema is one-time: `image-generation.json` keeps `enabled`/`endpoint`, the retired `provider`/`model` fields are dropped, the previous file is saved as `image-generation.before-hub-v1.json` and a `image-hub-v1.json` marker is written.
