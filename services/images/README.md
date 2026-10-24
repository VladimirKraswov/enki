# CPU image generation for Enki

Resident **OpenVINO GenAI + SDXL quality profiles** on CPU. `enki-image-auto` selects visually qualified SDXL Lightning for general art, explicitly requested anime and materials; `lcm-dreamshaper-v7` remains an explicit low-quality draft option, never an automatic fallback. No CUDA, GPU offload or second language-agent loop. One worker keeps exactly one pipeline loaded, unloading it before profile/periodic-mode switches; an authenticated API exposes readiness, bounded durable jobs, progress, cancellation and immutable job identifiers. ASR remains a separate higher-priority service.

## Proven deployment

CT201 `cpu-inference`, `192.168.31.59`, Xeon E5-2698 v4 (AVX2). Existing nginx exposes `/api/images/` on its existing ports8080/8443; Python listens only127.0.0.1:18084. Update the existing nginx image-location include from this repository: its12MiB body limit accommodates an8MiB base64 input; the app independently streams/bounds/decodes the payload. Reload nginx after nginx -t; do not restart ASR. `enki-images.service` uses a dedicated system user,12 inference threads, CPU affinity20–31,1200% CPU quota, Nice10, CPUWeight20 and32GiB cap. No ASR/GPU/Hub model lifecycle changes.

Pinned quality exports (model data only; no repository Python is executed):

- `sdxl-lightning`: [SDXL Lightning INT8](https://huggingface.co/rupeshs/SDXL-Lightning-2steps-openvino-int8), revision `347b21e571d7b8a716af83f64d68c5c028c51c56`, exact2 denoising steps/guidance0;
- optional draft: [Intel LCM Dreamshaper INT8](https://huggingface.co/OpenVINO/LCM_Dreamshaper_v7-int8-ov), revision `340a03e5488f36f7f222e6efa29819850ad7e4be`, guidance8/2–8 steps. Its former4-step/~12s result was rejected for drawing quality; successful tool execution is not visual acceptance.

[ByteDance's Lightning contract](https://huggingface.co/ByteDance/SDXL-Lightning) requires matching the distilled step count and trailing Euler timesteps. SDXL renders at approximately1MP even for a smaller requested output, then downsamples with periodic neighbors for tiles. Increasing arbitrary step counts, painting blur/sharpening over a bad face, or silently falling back to LCM is not the quality strategy. Measured on this Xeon with12 threads: general illustrated portrait58.72s including load; periodic stone85.86s including preparation/load; benchmark peak16.1GiB, no swap. The three live Enki artwork jobs took56.72s,47.69s and48.4s at native1024 before requested downsampling. Exact eye/clothing color binding failed in the Enki three-variant trial despite sharp facial detail and Vision review; do not advertise perfect prompt adherence. First compilation and model switches are slower than warm generation; compare real images and measured timings on the target CPU, not unrelated vendor hardware.

The candidate `HelloSun/animagine-xl-4.0-Lightning-OpenVINO-INT4` revision`eeeada61b8138d91e905a7461a8cb49a3d80f4ce` was visually rejected: the explicit anime prompt produced a realistic woman. It is not registered as a production profile or selected by auto routing. The general SDXL export produced clear illustrated facial features on the same CPU.

The pinned Intel SDXL tokenizer IR is reused only after both CLIP vocabularies/merges match byte-for-byte (`d54e5b43fcb6b4b358f3a134269115d3fcb3eb25`). `compat.py` explicitly aligns each CLIP input with its actual tokenizer ID dtype using an internal conversion, preserving model math. Generated compatibility/periodic IR is local data with immutable pinned source metadata.

## Install / upgrade

Use a dedicated venv; install `requirements.txt`. Run `HF_HUB_DISABLE_XET=1 IMAGE_MODEL_DIR=/opt/enki-images/model-int8 python prepare_model.py`. Downloads happen directly in CPU Inference. The HF HTTP transport was used because Xet stalled on this network. Do not convert/serialize IR over mmap-backed input files.

Install `server.py`, `runtime.py`, `materials.py`, `periodic.py`, `procedural.py` and `compat.py` under `/opt/enki-images`; create a system user`enki-images`, writable `/var/lib/enki-images/{jobs,cache}`, and a random >=32-character API token in `/etc/enki-images/token` (root:enki-images0640, parent0750). Model/code/venv are read-only to the service. Install the supplied systemd unit and include `nginx-location.conf` **inside** the existing nginx server; `nginx -t` before reload. Back up the existing nginx file. Never restart ASR to deploy images. Check authoritative image jobs are idle before restarting this service.

Tests from the repository root: `PYTHONPATH=services/images venv/bin/python -m unittest discover -s services/images/tests` (or deploy the tests under `/opt/enki-images/tests`, keeping that service directory on `PYTHONPATH`). They cover idempotency, queue bound, cancellation/partial outputs, restart without replay, authorization/validation, actual reference pixels/privacy and edit boundaries, normal conventions/unit vectors/flat surfaces and circular convolutions, wrapped resampling/derivatives, unchanged albedo, profile routing and matched tokenizer/CLIP integer input compatibility. Run real PNG/ZIP/MCP acceptance separately; mocks do not prove image quality.

## HTTP contract

All routes require `Authorization: Bearer …`; no keys in URLs. Never disable TLS validation. HTTP is permitted only on the user's private LAN; external endpoints require HTTPS.

- `GET /health`: loading/ready/error, model and queue length, explicit `editing`, supported edit models/strength/source limits. It does not generate.
- `POST /jobs` + stable `Idempotency-Key`: `{prompt, model:"enki-image-auto", width:1024, height:1024, steps:4, seed:42, items:[]}`. Returns202 with a durable id. Same key and body returns the same job; changed body409. Queued jobs max8, images per pack max8, dimensions256–1536 in multiples of8, area<=1048576px. XL profile steps are fixed by the checkpoint; LCM draft alone accepts2–8 steps and area<=640000px. English visual prompts should be short (CLIP text encoder context).
- Optional `material` object selects the material workflow below; it cannot be combined with icon `items`.
- Optional `source_image:{data_base64:"…",mime_type:"image/png"}` selects **actual image-to-image editing**, with `edit_strength:0.7` by default. JPEG and WebP are also supported; omit `mime_type` to detect it, never pass a URL or `data:` prefix. Input is authenticated, limited to8MiB,4096px per side/16MP; the complete streamed request is limited to12MiB before JSON parsing. Animation, mismatched MIME, malformed/oversized images are rejected before accepting work. EXIF orientation is applied, metadata discarded and transparent pixels composited on white for the RGB model. The whole source is fitted into the requested canvas without cropping or stretching; another aspect ratio may add white margins. `source_image` cannot be combined with `material` or icon `items`.
- `GET /jobs/{id}`: state, loading/generating phase, actual selected model/inference resolution/steps, completed images and result files. `DELETE /jobs/{id}` cancels; it does not erase completed results.
- `GET /jobs/by-key?request_key=…`: authenticated read-only lookup of an accepted job by its exact, URL-encoded idempotency key (1–160 characters). Use it to recover a lost POST acknowledgement without replaying generation; unknown keys return404. Keys identify a job and must not contain credentials.
- `GET /jobs/{id}/files/{name}`: PNG / images.zip / manifest.json. Preview route`/jobs/{id}/preview/{name}` returns <=256px PNGs.
- `POST /v1/images/generations`: compatibility path, `n=1`, `response_format=b64_json`, `size:"512x512"`; accepts Idempotency-Key. Enki uses asynchronous jobs so a long HTTP call does not hide progress. A lost acknowledgement never triggers an automatic POST replay.

SQLite commits state/progress; results retained7days, pruned at new submissions; at most200 retained job records. On service restart unfinished jobs become`interrupted`, and are **not** silently repeated. Ready files remain retrievable. A full queue returns429; startup returns503. Job computation has a20min deadline checked between denoising steps. This is a trusted private-service token, not per-tenant isolation.

### Reference edits

Editing currently uses the qualified SDXL Lightning profile (`enki-image-auto` or `sdxl-lightning`), never the blurry draft fallback. Its checkpoint keeps the exact two-step schedule: strengths0.5–0.95 leave one effective image-to-image denoising step; a lower strength would perform no denoising and is rejected, rather than falsely reporting an edit. Higher strength redraws more and preserves less of the reference. Localized masking, exact identity retention and arbitrary low-strength edits are not claimed by this image-to-image model.

The accepted job and manifest report `mode:"image-to-image"`, actual inference/schedule steps, edit strength and the original/normalized SHA256 hashes, dimensions and detected MIME of the source. A sanitized immutable `source.png` is saved privately beside the job at0600; it is deliberately absent from downloadable files/ZIP. SQLite, API errors and manifests never contain the base64 upload. Cancellation/restart preserves that source and any completed output without silently re-running inference. Reusing a stable key with another reference or strength returns409. A follow-up edit must explicitly upload the selected last output as the next source; a service never guesses a global “last image” shared across sessions.

## Material / normal mapping

`material:{surface:"auto",strength:4,blur:1,roughness:0.7,metallic:0,convention:"opengl",tileable:false,invert_height:false}` produces:

- `image-01.png`: basecolor, sRGB;
- `height.png`:16-bit grayscale, authored relief for procedural recipes or **approximate height from that same image's luminance** for neural images; neither is measured scan geometry;
- `normal.png`: normalized tangent-space normals from the height gradient;
- `roughness.png`, `metallic.png`: uniform **explicitly chosen** scalar maps, not invented estimates from albedo;
- `relight.png`, `relight-right.png`: opposite side-light previews using the actual normals;
- optional`tile-preview.png`:2×2 repetition; ZIP and manifest include all outputs and import/color-space instructions.

Normal/height/roughness/metallic are **linear/non-color data**, never sRGB. OpenGL and DirectX differ by green-channel sign; the chosen convention is recorded. Strength controls the baked gradient; blur suppresses grain; invert_height swaps bumps/depressions. Relight handles the selected convention correctly. `tileable` replaces zero padding with circular spatial padding in BOTH the denoising UNet and the VAE decoder, then uses periodic resampling/height derivatives. It does not paint crossfade bands/squares into the final albedo or force adjacent border pixels to be identical. Repeated features, perspective and painted illumination still require visual inspection. Do not generate independent unrelated images for normal and albedo maps.

Describe a surface swatch, not a whole scene. Diffusion can still introduce perspective, objects or painted lighting; Vision should inspect basecolor, side-light and tile previews. At most two generation attempts total are allowed per human request; follow-up human instructions start another bounded edit. Without Vision report that semantic review was not performed. For measured/production materials a real authored height/scan or a specialist material workflow is still preferable.

### Regular surface recipes

`surface:auto` recognizes an unambiguous brick/granite material request; `brick`/`granite` select the recipe explicitly and `image` forces periodic neural generation. This only runs inside an explicitly selected material tool, never intercepts arbitrary chats/image prompts. Brick/granite are deterministic procedural PBR assets with aligned authored height, uniform requested roughness/metallic and periodic noise. They are reported as `procedural-brick-v1` / `procedural-granite-v1`,0 diffusion steps; the manifest identifies the authored method. Do not call this neural art or a measured scan. Runtime does not load/change a neural model for these recipes.

Regular neural brick geometry failed the live Vision check even after correction. Recipes fix this particular structural problem (regular staggered rows, mortar depth, exact periodic coordinates) rather than claiming that a more expensive seed makes arbitrary diffusion geometry exact. CPU proof at512: brick0.886s, granite0.834s including map/preview exports under a2-core cap. PBR color/scale is deliberately controllable via recipe code and normal strength; these are game material building blocks, not photogrammetry.

The added optional `surface:auto` field is excluded from legacy request fingerprints so existing accepted idempotency keys survive the upgrade. A cache regression test also verifies that tokenizer/encoder binding changes invalidate periodic copies, not only UNet/VAE changes.
