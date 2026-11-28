"""Enki Hub images service.

The Hub is the single gateway for image generation and editing: callers talk to
the Hub, the Hub talks to ComfyUI (Qwen-Image-Edit 2511 on a Tesla V100).

Design
  * one model, one workflow — no model/material selection, no compatibility shims;
  * jobs live in SQLite next to the Hub database, images on disk under the Hub data dir;
  * progress is real: step counters arrive over the ComfyUI WebSocket, not by polling;
  * states: queued -> running -> completed | failed | cancelled (cancel interrupts ComfyUI).

API (all under /api/images, Authorization: Bearer <token>)
  GET    /health                     service, model and queue status
  POST   /jobs                       create a job            -> 201 job
  GET    /jobs?state=&limit=         list recent jobs
  GET    /jobs/<id>                  one job with progress
  DELETE /jobs/<id>                  cancel a queued or running job
  GET    /jobs/<id>/images/<name>    PNG of a finished image
  GET    /jobs/<id>/metadata         request/inference metadata of a job
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import socket
import sqlite3
import struct
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

COMFY = os.environ.get("ENKI_HUB_IMAGES_COMFY", "http://192.168.31.96:8188")
UNET = os.environ.get("ENKI_HUB_IMAGES_UNET", "qwen-image-edit-2511-Q6_K.gguf")
CLIP = os.environ.get("ENKI_HUB_IMAGES_CLIP", "Qwen2.5-VL-7B-Instruct-bf16-q4_k.gguf")
VAE = os.environ.get("ENKI_HUB_IMAGES_VAE", "qwen_image_vae.safetensors")
LORA = os.environ.get("ENKI_HUB_IMAGES_LORA", "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors")

LORA_FAST = os.environ.get("ENKI_HUB_IMAGES_LORA", LORA)
LORA_SAFE = os.environ.get("ENKI_HUB_IMAGES_LORA_8STEP", "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors")
QUALITIES = {
    # 4-step Lightning: fastest, but distilled LoRA at CFG 1 follows a weak
    # instruction; stubborn edits (hair colour, small objects) need more.
    "fast": {"steps": 4, "cfg": 1.0, "lora": LORA_FAST, "shift": None},
    # 8-step Lightning: same CFG, twice the sampling, noticeably better adherence.
    "balanced": {"steps": 8, "cfg": 1.0, "lora": LORA_SAFE, "shift": None},
    # Base model, no distilled LoRA: 40 steps at CFG 4 with aura-flow shift 3.1
    # is the vendor workflow for edits that must actually change something.
    "best": {"steps": 40, "cfg": 4.0, "lora": None, "shift": 3.1},
}
DEFAULT_QUALITY = "fast"
MAX_VARIANTS = 4

MODEL_ID = "qwen-image-edit-2511"
MODEL_TITLE = "Qwen-Image-Edit 2511"
STEPS = 4  # progress default; the quality preset of each job decides the real count
MULTIPLE = 16
MAX_SIDE = 1536
MAX_PIXELS = 1048576
MAX_PROMPT = 2000
MAX_ITEMS = 8
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_BODY = 16 * 1024 * 1024
KEEP_JOBS = 200
STATES = ("queued", "running", "completed", "failed", "cancelled")


class ImagesError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _json_request(path: str, body: dict | None = None, timeout: float = 1800) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(COMFY + path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def _binary_request(path: str, timeout: float = 120) -> bytes:
    with urllib.request.urlopen(COMFY + path, timeout=timeout) as response:
        return response.read()


def _upload_png(filename: str, payload: bytes) -> str:
    boundary = "----hub" + uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
        f"Content-Type: image/png\r\n\r\n".encode(), payload,
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode(),
        f"--{boundary}--\r\n".encode(),
    ])
    request = urllib.request.Request(COMFY + "/upload/image", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read()).get("name", filename)


class ProgressSocket:
    """Minimal ComfyUI WebSocket reader: step counters for one prompt id."""

    def __init__(self, prompt_id: str, client_id: str, on_progress):
        self.prompt_id = prompt_id
        self.client_id = client_id
        self.on_progress = on_progress
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "ProgressSocket":
        self.thread.start()
        return self

    def _run(self):
        url = urllib.parse.urlsplit(COMFY)
        try:
            connection = socket.create_connection((url.hostname, url.port or 80), timeout=5)
        except OSError:
            return
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            connection.sendall((
                f"GET /ws?clientId={self.client_id} HTTP/1.1\r\n"
                f"Host: {url.hostname}:{url.port or 80}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode())
            buffer = b""
            while b"\r\n\r\n" not in buffer:
                chunk = connection.recv(4096)
                if not chunk:
                    return
                buffer += chunk
            if b" 101 " not in buffer.split(b"\r\n", 1)[0]:
                return
            connection.settimeout(1.0)
            payload = b""
            while not self.stop.is_set():
                header = self._read(connection, 2)
                if not header:
                    return
                opcode = header[0] & 0x0F
                length = header[1] & 0x7F
                if length == 126:
                    length = struct.unpack(">H", self._read(connection, 2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self._read(connection, 8))[0]
                data = self._read(connection, length) if length else b""
                if opcode == 0x8:
                    return
                if opcode not in (0x1, 0x0):
                    continue
                payload += data
                if header[0] & 0x80:
                    self._consume(payload)
                    payload = b""
        except OSError:
            return
        finally:
            self.stop.set()
            try:
                connection.close()
            except OSError:
                pass

    def _read(self, connection, length):
        data = b""
        while len(data) < length:
            if self.stop.is_set():
                return b""
            try:
                chunk = connection.recv(length - len(data))
            except socket.timeout:
                continue
            if not chunk:
                return b""
            data += chunk
        return data

    def _consume(self, payload: bytes):
        try:
            message = json.loads(payload)
        except ValueError:
            return
        if message.get("data", {}).get("prompt_id") not in (None, self.prompt_id):
            return
        kind = message.get("type")
        data = message.get("data") or {}
        if kind == "progress":
            try:
                self.on_progress(int(data.get("value") or 0), int(data.get("max") or STEPS))
            except Exception:  # noqa: BLE001 - прогресс не должен ломать чтение сокета
                pass


class Images:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.files = self.root / "images"
        self.files.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = self.root / "images.sqlite"
        self.token_file = Path(os.environ.get("ENKI_HUB_IMAGES_TOKEN_FILE", "/etc/enki-hub/images.token"))
        self.lock = threading.RLock()
        self.pending: "queue.Queue[str]" = queue.Queue()
        self.current: str | None = None
        self.current_prompt: str | None = None
        self._init_db()
        threading.Thread(target=self._worker, daemon=True).start()

    # ---------- storage ----------
    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self):
        with self._connect() as connection:
            connection.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY, state TEXT, created REAL, started REAL, finished REAL,
                mode TEXT, width INTEGER, height INTEGER, seed INTEGER,
                phase TEXT, step INTEGER, steps INTEGER, prompts TEXT, images TEXT,
                error_code TEXT, error_message TEXT, request TEXT);
            CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
            """)
            connection.execute("UPDATE jobs SET state='failed', error_code='interrupted', "
                               "error_message='Hub перезапущен во время генерации' "
                               "WHERE state IN ('queued','running')")
        os.chmod(self.db, 0o600)

    def _trim(self):
        with self._connect() as connection:
            stale = connection.execute(
                "SELECT id FROM jobs ORDER BY created DESC LIMIT -1 OFFSET ?", (KEEP_JOBS,)).fetchall()
            for row in stale:
                connection.execute("DELETE FROM jobs WHERE id=?", (row["id"],))
        for row in stale:
            folder = self.files / row["id"]
            if folder.is_dir():
                for child in folder.iterdir():
                    child.unlink(missing_ok=True)
                folder.rmdir()

    def _row(self, job_id: str) -> sqlite3.Row:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise ImagesError(404, "job_not_found", "Задача не найдена")
        return row

    @staticmethod
    def _view(row: sqlite3.Row) -> dict:
        prompts = json.loads(row["prompts"] or "[]")
        images = json.loads(row["images"] or "[]")
        steps = row["steps"] or STEPS
        step = min(row["step"] or 0, steps)
        percent = 100 if row["state"] == "completed" else round(100 * step / steps)
        view = {
            "id": row["id"],
            "state": row["state"],
            "mode": row["mode"],
            "created_at": row["created"],
            "started_at": row["started"],
            "finished_at": row["finished"],
            "progress": {"phase": row["phase"] or row["state"], "step": step, "steps": steps, "percent": percent},
            "width": row["width"], "height": row["height"], "seed": row["seed"],
            "images": [{**image, "url": f"/api/images/jobs/{row['id']}/images/{image['name']}"} for image in images],
        }
        if row["state"] == "failed":
            view["error"] = {"code": row["error_code"], "message": row["error_message"]}
        return view

    # ---------- auth ----------
    def _token(self) -> str:
        return self.token_file.read_text().strip()

    def authorize(self, headers) -> None:
        if not hmac.compare_digest(headers.get("Authorization", ""), "Bearer " + self._token()):
            raise ImagesError(401, "unauthorized", "Нужен API-ключ генератора")

    # ---------- public ----------
    def health(self) -> dict:
        engine, status = {}, "degraded"
        try:
            stats = _json_request("/system_stats", timeout=8)
            device = (stats.get("devices") or [{}])[0]
            engine = {"name": "ComfyUI", "device": device.get("name"),
                      "vram_total_mib": round((device.get("vram_total") or 0) / 2**20),
                      "vram_free_mib": round((device.get("vram_free") or 0) / 2**20)}
            status = "ready"
        except Exception:  # noqa: BLE001 - health must answer even when ComfyUI is down
            engine = {"name": "ComfyUI", "device": None, "error": "engine_unavailable"}
        with self.lock:
            running = 1 if self.current else 0
            pending = self.pending.qsize()
        return {
            "status": status,
            "model": {"id": MODEL_ID, "title": MODEL_TITLE, "steps": STEPS, "multiple": MULTIPLE,
                      "max_side": MAX_SIDE, "max_pixels": MAX_PIXELS, "max_items": MAX_ITEMS,
                      "max_variants": MAX_VARIANTS, "default_quality": DEFAULT_QUALITY,
                      "qualities": {name: {"steps": preset["steps"], "cfg": preset["cfg"],
                                          "lora": bool(preset["lora"]), "shift": preset["shift"]}
                                    for name, preset in QUALITIES.items()},
                      "modes": ["text-to-image", "image-edit"]},
            "engine": engine,
            "queue": {"pending": pending, "running": running},
        }

    def submit(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise ImagesError(400, "invalid_body", "Нужен JSON-объект")
        prompt = str(data.get("prompt") or "").strip()
        if not prompt or len(prompt) > MAX_PROMPT:
            raise ImagesError(422, "invalid_prompt", f"prompt: от 1 до {MAX_PROMPT} символов")
        items_raw = data.get("items") or []
        if not isinstance(items_raw, list) or len(items_raw) > MAX_ITEMS:
            raise ImagesError(422, "invalid_items", f"items: не больше {MAX_ITEMS} строк")
        items = [str(item).strip()[:160] for item in items_raw if str(item).strip()]
        quality = str(data.get("quality") or DEFAULT_QUALITY).strip().lower()
        if quality not in QUALITIES:
            raise ImagesError(422, "invalid_quality", "quality: " + ", ".join(QUALITIES))
        try:
            variants = int(data.get("variants") if data.get("variants") is not None else 1)
        except (TypeError, ValueError):
            raise ImagesError(422, "invalid_variants", "variants: целое число")
        if variants < 1 or variants > MAX_VARIANTS:
            raise ImagesError(422, "invalid_variants", f"variants: от 1 до {MAX_VARIANTS}")
        if variants > 1 and items:
            raise ImagesError(422, "invalid_variants", "variants и items вместе не поддерживаются")
        width = self._dimension(data.get("width"), 1024, "width")
        height = self._dimension(data.get("height"), 1024, "height")
        if width * height > MAX_PIXELS:
            raise ImagesError(422, "invalid_size", f"Не больше {MAX_PIXELS} пикселей")
        try:
            seed = int(data.get("seed") if data.get("seed") is not None else 42)
        except (TypeError, ValueError):
            raise ImagesError(422, "invalid_seed", "seed: целое число")
        source = None
        source_data = data.get("source_image")
        if source_data is not None:
            if not isinstance(source_data, dict) or not source_data.get("data_base64"):
                raise ImagesError(422, "invalid_source", "source_image: нужен data_base64")
            if items:
                raise ImagesError(422, "invalid_source", "Редактирование принимает один исходник и один prompt")
            try:
                source = base64.b64decode(source_data["data_base64"], validate=False)
            except Exception:  # noqa: BLE001
                raise ImagesError(422, "invalid_source", "source_image: некорректный base64")
            if len(source) > MAX_SOURCE_BYTES:
                raise ImagesError(413, "source_too_large", "Исходник до 8 МиБ")
        strength = data.get("strength")
        if strength is not None:
            try:
                strength = min(1.0, max(0.0, float(strength)))
            except (TypeError, ValueError):
                raise ImagesError(422, "invalid_strength", "strength: число от 0 до 1")
            if source is None:
                raise ImagesError(422, "invalid_strength", "strength применим только с source_image")
        job_id = str(uuid.uuid4())
        mode = "image-edit" if source else "text-to-image"
        prompts = items or [prompt] * variants
        steps = QUALITIES[quality]["steps"]
        request = {"prompt": prompt, "items": items, "width": width, "height": height,
                   "seed": seed, "strength": strength, "source": bool(source),
                   "quality": quality, "variants": variants}
        with self.lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO jobs(id,state,created,mode,width,height,seed,phase,step,steps,prompts,images,request) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "queued", time.time(), mode, width, height, seed, "queued", 0, steps,
                 json.dumps(prompts, ensure_ascii=False), "[]", json.dumps(request, ensure_ascii=False)))
        if source is not None:
            folder = self.files / job_id
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            (folder / "source.png").write_bytes(source)
        # Публикуем задачу только после коммита: воркер не должен увидеть несуществующую строку.
        self.pending.put(job_id)
        self._trim()
        return self._view(self._row(job_id))

    def job(self, job_id: str) -> dict:
        return self._view(self._row(job_id))

    def jobs(self, state: str | None = None, limit: int = 20) -> dict:
        limit = max(1, min(100, int(limit)))
        with self._connect() as connection:
            if state:
                if state not in STATES:
                    raise ImagesError(422, "invalid_state", "state: " + ", ".join(STATES))
                rows = connection.execute("SELECT * FROM jobs WHERE state=? ORDER BY created DESC LIMIT ?",
                                          (state, limit)).fetchall()
            else:
                rows = connection.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return {"items": [self._view(row) for row in rows]}

    def metadata(self, job_id: str) -> dict:
        row = self._row(job_id)
        return {"id": row["id"], "state": row["state"], "request": json.loads(row["request"] or "{}"),
                "inference": {"model": MODEL_ID, "quality": json.loads(row["request"] or "{}").get("quality", DEFAULT_QUALITY),
                              "steps": row["steps"] or STEPS,
                              "guidance": QUALITIES.get(json.loads(row["request"] or "{}").get("quality", DEFAULT_QUALITY), QUALITIES[DEFAULT_QUALITY])["cfg"],
                              "sampler": "euler/simple"},
                "images": json.loads(row["images"] or "[]")}

    def cancel(self, job_id: str) -> dict:
        with self.lock:
            row = self._row(job_id)
            if row["state"] == "running" and self.current == job_id and self.current_prompt:
                # Interrupt this prompt only; ComfyUI may also be serving other clients.
                try:
                    _json_request("/interrupt", {"prompt_id": self.current_prompt}, timeout=15)
                except Exception:  # noqa: BLE001 - ComfyUI may be idle already
                    pass
            if row["state"] in ("queued", "running"):
                self._update(job_id, state="cancelled", phase="cancelled", finished=time.time())
        return self.job(job_id)

    def image_path(self, job_id: str, name: str) -> Path:
        if "/" in name or "\\" in name or name.startswith("."):
            raise ImagesError(404, "image_not_found", "Изображение не найдено")
        row = self._row(job_id)
        if name not in [image["name"] for image in json.loads(row["images"] or "[]")]:
            raise ImagesError(404, "image_not_found", "Изображение не найдено")
        path = self.files / job_id / name
        if not path.is_file():
            raise ImagesError(404, "image_not_found", "Изображение не найдено")
        return path

    # ---------- validation helpers ----------
    @staticmethod
    def _dimension(value, default: int, name: str) -> int:
        try:
            number = int(value if value is not None else default)
        except (TypeError, ValueError):
            raise ImagesError(422, "invalid_size", f"{name}: целое число")
        if number < 256 or number > MAX_SIDE:
            raise ImagesError(422, "invalid_size", f"{name}: от 256 до {MAX_SIDE}")
        return number - (number % MULTIPLE)

    # ---------- worker ----------
    def _worker(self):
        while True:
            job_id = self.pending.get()
            try:
                self._run(job_id)
            except ImagesError as error:
                self._fail(job_id, error.code, error.message)
            except Exception as error:  # noqa: BLE001 - one bad job must not stop the worker
                self._fail(job_id, "generation_failed", str(error)[:400])
            finally:
                with self.lock:
                    self.current = None
                    self.current_prompt = None
                self.pending.task_done()

    def _update(self, job_id: str, **fields):
        if not fields:
            return
        assignments = ", ".join(f"{key}=?" for key in fields)
        with self._connect() as connection:
            connection.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*fields.values(), job_id))

    def _fail(self, job_id: str, code: str, message: str):
        # Отменённая задача остаётся отменённой: ошибка движка после interrupt её не переписывает.
        if self._row(job_id)["state"] == "cancelled":
            return
        self._update(job_id, state="failed", phase="failed", finished=time.time(),
                     error_code=code, error_message=message)

    def _run(self, job_id: str):
        with self.lock:
            row = self._row(job_id)
            if row["state"] == "cancelled":
                return
            self.current = job_id
            self.current_prompt = None
            self._update(job_id, state="running", started=time.time(), phase="prepare", step=0)
        prompts = json.loads(row["prompts"] or "[]")
        request = json.loads(row["request"] or "{}")
        (self.files / job_id).mkdir(parents=True, exist_ok=True, mode=0o700)
        image_name = None
        if request.get("source"):
            self._update(job_id, phase="upload")
            image_name = _upload_png(f"source-{job_id[:8]}.png", (self.files / job_id / "source.png").read_bytes())
        denoise = 1.0
        if image_name and request.get("strength") is not None:
            denoise = round(0.55 + 0.45 * float(request["strength"]), 3)
        produced = []
        for index, prompt in enumerate(prompts, start=1):
            png = self._generate(row, request, prompt, job_id, index, image_name, denoise)
            name = f"image-{index:02d}.png"
            (self.files / job_id / name).write_bytes(png)
            produced.append({"name": name, "prompt": prompt, "seed": row["seed"], "width": row["width"],
                             "height": row["height"], "bytes": len(png)})
            self._update(job_id, images=json.dumps(produced, ensure_ascii=False))
        if self._row(job_id)["state"] == "cancelled":
            return
        self._update(job_id, state="completed", phase="done", step=row["steps"] or STEPS, finished=time.time())

    def _generate(self, row, request, prompt, job_id, index, image_name, denoise) -> bytes:
        if self._row(job_id)["state"] == "cancelled":
            raise ImagesError(409, "cancelled", "Задача отменена")
        quality = QUALITIES.get(request.get("quality") or DEFAULT_QUALITY, QUALITIES[DEFAULT_QUALITY])
        graph = self._workflow(row["width"], row["height"], row["seed"] + index - 1, prompt, denoise, image_name, quality)
        client_id = f"hub-{job_id[:8]}"
        submitted = _json_request("/prompt", {"prompt": graph, "client_id": client_id})
        prompt_id = submitted.get("prompt_id")
        if not prompt_id:
            raise ImagesError(502, "engine_rejected", "ComfyUI не принял задачу")
        with self.lock:
            cancelled = self._row(job_id)["state"] == "cancelled"
            if not cancelled:
                self.current_prompt = prompt_id
        if cancelled:
            try:
                _json_request("/interrupt", {"prompt_id": prompt_id}, timeout=15)
            except Exception:  # noqa: BLE001 - cancellation remains authoritative
                pass
            raise ImagesError(409, "cancelled", "Задача отменена")

        def on_progress(step, steps):
            self._update(job_id, phase="sampling", step=step, steps=steps)

        reader = ProgressSocket(prompt_id, client_id, on_progress).start()
        deadline = time.time() + 1800
        entry = None
        while time.time() < deadline:
            history = _json_request(f"/history/{prompt_id}", timeout=30)
            if prompt_id in history:
                entry = history[prompt_id]
                break
            if self._row(job_id)["state"] == "cancelled":
                reader.stop.set()
                raise ImagesError(409, "cancelled", "Задача отменена")
            time.sleep(1)
        reader.stop.set()
        if entry is None:
            raise ImagesError(504, "engine_timeout", "ComfyUI не завершил задачу за 30 минут")
        if (entry.get("status") or {}).get("status_str") == "error":
            raise ImagesError(502, "engine_error", "ComfyUI вернул ошибку генерации")
        outputs = [image for output in (entry.get("outputs") or {}).values() for image in output.get("images", [])]
        if not outputs:
            raise ImagesError(502, "engine_empty", "ComfyUI не вернул изображение")
        image = outputs[0]
        query = urllib.parse.urlencode({"filename": image["filename"],
                                        "subfolder": image.get("subfolder", ""),
                                        "type": image.get("type", "output")})
        return _binary_request(f"/view?{query}")

    @staticmethod
    def _workflow(width, height, seed, prompt, denoise, image_name, quality=None) -> dict:
        """The vendor 2511 edit graph: TextEncodeQwenImageEditPlus keeps the
        reference image inside the text conditioning, the multi-reference
        method turns it into reference latents and aura-flow shift 3.1 matches
        the published workflow. The older TextEncodeQwenImageEdit path ignored
        the instruction on 2511 and only reproduced the source."""
        quality = quality or QUALITIES[DEFAULT_QUALITY]
        graph = {
            "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": UNET}},
            "clip": {"class_type": "CLIPLoaderGGUF", "inputs": {"clip_name": CLIP, "type": "qwen_image"}},
            "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        }
        model = ["unet", 0]
        if quality["lora"]:
            graph["lora"] = {"class_type": "LoraLoaderModelOnly",
                             "inputs": {"model": model, "lora_name": quality["lora"], "strength_model": 1.0}}
            model = ["lora", 0]
        graph["shift"] = {"class_type": "ModelSamplingAuraFlow",
                          "inputs": {"model": model, "shift": quality["shift"] or 3.1}}
        model = ["shift", 0]
        positive_inputs = {"clip": ["clip", 0], "prompt": prompt, "vae": ["vae", 0]}
        negative_inputs = {"clip": ["clip", 0], "prompt": "", "vae": ["vae", 0]}
        if image_name:
            graph["source"] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
            positive_inputs["image1"] = ["source", 0]
            negative_inputs["image1"] = ["source", 0]
            graph["latent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["source", 0], "vae": ["vae", 0]}}
        else:
            graph["latent"] = {"class_type": "EmptySD3LatentImage",
                               "inputs": {"width": width, "height": height, "batch_size": 1}}
        graph["positive"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": positive_inputs}
        graph["negative"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": negative_inputs}
        graph["ref-positive"] = {"class_type": "FluxKontextMultiReferenceLatentMethod",
                                 "inputs": {"conditioning": ["positive", 0],
                                            "reference_latents_method": "index_timestep_zero"}}
        graph["ref-negative"] = {"class_type": "FluxKontextMultiReferenceLatentMethod",
                                 "inputs": {"conditioning": ["negative", 0],
                                            "reference_latents_method": "index_timestep_zero"}}
        graph["sampler"] = {"class_type": "KSampler", "inputs": {
            "model": model, "seed": seed, "steps": quality["steps"], "cfg": quality["cfg"],
            "sampler_name": "euler", "scheduler": "simple", "denoise": denoise,
            "positive": ["ref-positive", 0], "negative": ["ref-negative", 0], "latent_image": ["latent", 0]}}
        graph["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sampler", 0], "vae": ["vae", 0]}}
        graph["save"] = {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": "hub"}}
        return graph

    # ---------- HTTP ----------
    def handle(self, handler, action: str):
        try:
            self.authorize(handler.headers)
            parts = [part for part in action.split("/") if part]
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
            body = self._body(handler)
            method = handler.command
            if parts in ([], ["health"]) and method == "GET":
                return handler.respond(200, self.health())
            if parts == ["jobs"] and method == "POST":
                return handler.respond(201, self.submit(body))
            if parts == ["jobs"] and method == "GET":
                return handler.respond(200, self.jobs((query.get("state") or [None])[0],
                                                      (query.get("limit") or [20])[0]))
            if len(parts) == 2 and parts[0] == "jobs":
                if method == "GET":
                    return handler.respond(200, self.job(parts[1]))
                if method == "DELETE":
                    return handler.respond(200, self.cancel(parts[1]))
            if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "images" and method == "GET":
                path = self.image_path(parts[1], urllib.parse.unquote(parts[3]))
                return handler.respond(200, path.read_bytes(), "image/png")
            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "metadata" and method == "GET":
                return handler.respond(200, self.metadata(parts[1]))
            raise ImagesError(404, "not_found", "Маршрут не найден")
        except ImagesError as error:
            handler.close_connection = True
            return handler.respond(error.status, {"error": {"code": error.code, "message": error.message}})
        except ValueError:
            return handler.respond(400, {"error": {"code": "invalid_json", "message": "Некорректный JSON"}})

    @staticmethod
    def _body(handler) -> dict:
        length = int(handler.headers.get("Content-Length", "0") or 0)
        if length > MAX_BODY:
            raise ImagesError(413, "body_too_large", "Тело запроса слишком велико")
        if not length:
            return {}
        return json.loads(handler.rfile.read(length) or b"{}")
