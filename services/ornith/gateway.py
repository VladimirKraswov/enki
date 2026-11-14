#!/usr/bin/env python3
"""Bounded RTX 5090 model-control and inference proxy.

Not an agent loop. Only qwen38-flash-next and ornith15-122b are selectable.
Qwen is controlled through the existing Strata API; Ornith is a systemd-owned
PolyStrata service (llama.cpp remains available as a disabled fallback).
Hub and Runtime remain the sources of sessions and work.
"""
from __future__ import annotations

import http.client
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

QWEN = "qwen38-flash-next"
ORNITH = "ornith15-122b"
MODELS = (QWEN, ORNITH)
AGENTS = ("pi", "opencode")
QWEN_API = os.environ.get("ORNITH_QWEN_BASE", "http://127.0.0.1:1919")
QWEN_CONTROL = os.environ.get("ORNITH_QWEN_CONTROL", "http://127.0.0.1:1920")
ORNITH_API = os.environ.get("ORNITH_BASE", "http://127.0.0.1:1922")
ORNITH_SERVICE = os.environ.get("ORNITH_SERVICE", "ornith")
CONTROL_KEY_FILE = Path(os.environ.get("ORNITH_CONTROL_KEY_FILE", "/etc/strata/ornith-gateway.key"))
STRATA_ENV = Path(os.environ.get("STRATA_API_ENV", "/etc/strata/api.env"))
STATE_FILE = Path(os.environ.get("ORNITH_ACTIVE_FILE", "/var/lib/ornith-gateway/active.json"))
MODEL_DIR = Path(os.environ.get("ORNITH_MODEL_DIR", "/srv/models/ornith-1.5-122b-ud-q4_k_xl"))
EXPECTED_BYTES = int(os.environ.get("ORNITH_MODEL_BYTES", "79713771665"))
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "host"}
JSON_CT = "application/json; charset=utf-8"


def read_key() -> str:
    key = CONTROL_KEY_FILE.read_text().strip()
    if not key or len(key) > 4096 or "\n" in key or "\r" in key:
        raise RuntimeError("invalid control key")
    return key


def strata_key() -> str:
    for line in STRATA_ENV.read_text().splitlines():
        if line.startswith("STRATA_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("STRATA_API_KEY is missing")


def request(base: str, path: str, body: dict | None = None, key: str | None = None,
            timeout: int = 20, stream: bool = False):
    url = urlsplit(base)
    conn = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.hostname, url.port, timeout=timeout)
    raw = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": JSON_CT}
    if key:
        headers["Authorization"] = "Bearer " + key
    try:
        conn.request("POST" if raw is not None else "GET", (url.path.rstrip("/") + path), raw, headers)
        response = conn.getresponse()
        if stream:
            return conn, response
        payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise RuntimeError("upstream response too large")
        try:
            value = json.loads(payload) if payload else {}
        except ValueError:
            value = {"status": response.status, "error": "invalid upstream JSON"}
        return response.status, value
    finally:
        if not stream:
            conn.close()


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.switch_lock = threading.Lock()
        self.active_requests = 0
        self.active = QWEN
        self.target = QWEN
        self.phase = "ready"
        self.error = None
        self.changed = time.monotonic()
        self.operation = 0
        if STATE_FILE.exists():
            try:
                saved = json.loads(STATE_FILE.read_text())
                if saved.get("active") in MODELS:
                    candidate = saved["active"]
                    if candidate == ORNITH:
                        import subprocess
                        running = subprocess.run(["systemctl", "is-active", "--quiet", ORNITH_SERVICE], capture_output=True, timeout=5)
                        if running.returncode == 0:
                            self.active = self.target = ORNITH
                    else:
                        self.active = self.target = candidate
            except (OSError, ValueError):
                pass

    def save(self):
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = STATE_FILE.with_suffix(".tmp")
        temp.write_text(json.dumps({"active": self.active}))
        os.replace(temp, STATE_FILE)

    def status(self):
        with self.lock:
            phase = self.phase
            ready = phase == "ready"
            loader = None
            if phase in ("unloading", "loading", "warming"):
                current = sum(f.stat().st_blocks * 512 for f in MODEL_DIR.glob("*.gguf"))
                loader = {"phase": "model files", "unit": "bytes", "current": current, "total": EXPECTED_BYTES}
            return {
                "schema": 1,
                "operation_id": f"rtx5090-switch-{self.operation}",
                "phase": phase,
                "ready": ready,
                "active_model": self.active if ready else None,
                "target_model": self.target,
                "elapsed_seconds": round(time.monotonic() - self.changed, 3),
                "active_requests": self.active_requests,
                "error": self.error,
                "loader": loader,
            }


STATE = State()


def wait_gpu_free(timeout: int = 180):
    import subprocess
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        try:
            used = int(result.stdout.strip().splitlines()[0])
        except (ValueError, IndexError):
            used = 0
        if result.returncode == 0 and used < 256:
            return
        time.sleep(2)
    raise RuntimeError("GPU memory is still held by the previous model")


def stop_ornith():
    import subprocess
    result = subprocess.run(["systemctl", "stop", ORNITH_SERVICE], capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f"systemctl stop {ORNITH_SERVICE} failed")
    wait_gpu_free()


def qwen_ready() -> bool:
    try:
        status, value = request(QWEN_CONTROL, "/v1/models", key=strata_key(), timeout=10)
    except (OSError, RuntimeError):
        return False
    if status != 200 or not isinstance(value, dict):
        return False
    for model in value.get("data", []):
        if model.get("id") == QWEN and model.get("status", {}).get("value") != "unloaded":
            return True
    return False


def ornith_ready() -> bool:
    status, value = request(ORNITH_API, "/health", timeout=10)
    return status == 200 and isinstance(value, dict) and value.get("status") in ("ok", "ready", True)


def qwen_action(action: str):
    status, value = request(QWEN_CONTROL, "/" + action, {}, key=strata_key(), timeout=120)
    if status != 200:
        raise RuntimeError(f"Qwen {action} failed: {status}")


def start_unit(unit: str):
    import subprocess
    result = subprocess.run(["systemctl", "start", "--no-block", unit], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"systemctl start {unit} failed")


def wait_for(model: str, timeout: int = 900):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if (qwen_ready() if model == QWEN else ornith_ready()):
                return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(f"{model} did not become ready")


def switch_to(target: str, operation: int):
    previous = STATE.active
    try:
        if previous == QWEN:
            qwen_action("unload")
            wait_gpu_free()
        else:
            stop_ornith()
        with STATE.lock:
            STATE.phase = "loading"
            STATE.changed = time.monotonic()
        if target == QWEN:
            if not qwen_ready():
                start_unit("strata-api")
            else:
                qwen_action("load")
        else:
            start_unit(ORNITH_SERVICE)
        with STATE.lock:
            STATE.phase = "warming"
            STATE.changed = time.monotonic()
        wait_for(target)
        with STATE.lock:
            STATE.active = target
            STATE.target = target
            STATE.phase = "ready"
            STATE.error = None
            STATE.changed = time.monotonic()
            STATE.operation = operation
            STATE.save()
    except Exception as exc:
        # Failed target start must not leave the previous working model offline.
        error = str(exc)[:1024]
        try:
            if previous == QWEN:
                qwen_action("load")
            else:
                start_unit(ORNITH_SERVICE)
            wait_for(previous, timeout=180)
            with STATE.lock:
                STATE.active = previous
                STATE.phase = "failed"
                STATE.error = error
                STATE.changed = time.monotonic()
                STATE.save()
        except Exception:
            with STATE.lock:
                STATE.active = previous
                STATE.phase = "failed"
                STATE.error = error
                STATE.changed = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(json.dumps({"remote": self.client_address[0], "message": fmt % args}), flush=True)

    def send_json(self, status: int, value):
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", JSON_CT)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self) -> bool:
        try:
            return self.headers.get("Authorization", "") == "Bearer " + read_key()
        except Exception:
            return False

    def control(self, action: str):
        if not self.authorized():
            return self.send_json(401, {"error": "control credential required"})
        if action == "status":
            return self.send_json(200, STATE.status())
        if action == "catalog":
            return self.send_json(200, {"schema": 1, "models": [{"id": model, "agents": list(AGENTS)} for model in MODELS]})
        if action != "select":
            return self.send_json(404, {"error": "unknown control action"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 4096:
            return self.send_json(400, {"error": "invalid selection"})
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json(400, {"error": "invalid JSON"})
        model, agent = data.get("model"), data.get("agent")
        if model not in MODELS or agent not in AGENTS:
            return self.send_json(403, {"error": "model is not available"})
        with STATE.switch_lock:
            if STATE.phase != "ready":
                return self.send_json(409, {"error": "another model switch is running"})
            if STATE.active_requests:
                return self.send_json(409, {"error": "inference is active"})
            if STATE.active == model:
                return self.send_json(200, STATE.status())
            STATE.operation += 1
            operation = STATE.operation
            STATE.target = model
            STATE.phase = "unloading"
            STATE.error = None
            STATE.changed = time.monotonic()
            threading.Thread(target=switch_to, args=(model, operation), daemon=True).start()
        return self.send_json(202, STATE.status())

    def proxy(self):
        base = QWEN_API if STATE.active == QWEN else ORNITH_API
        with STATE.lock:
            STATE.active_requests += 1
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 64 * 1024 * 1024:
                return self.send_json(413, {"error": "request too large"})
            body = self.rfile.read(length) if length else None
            path = self.path
            upstream_path = path
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "authorization"}
            headers["Authorization"] = "Bearer local"
            url = urlsplit(base)
            conn = http.client.HTTPConnection(url.hostname, url.port, timeout=1800)
            try:
                conn.request(self.command, url.path.rstrip("/") + upstream_path, body, headers)
                response = conn.getresponse()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in HOP:
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            finally:
                conn.close()
        except (OSError, http.client.HTTPException) as exc:
            if not self.wfile.closed:
                try:
                    self.send_json(503, {"error": {"type": "server_not_ready", "message": str(exc)[:300]}})
                except OSError:
                    pass
        finally:
            with STATE.lock:
                STATE.active_requests -= 1

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"status": "ok", "model": STATE.active})
        if self.path == "/v1/model-control/status":
            return self.control("status")
        if self.path == "/v1/model-control/catalog":
            return self.control("catalog")
        if self.path.startswith("/v1/"):
            return self.proxy()
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/v1/model-control/select":
            return self.control("select")
        if self.path.startswith("/v1/"):
            return self.proxy()
        self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("ORNITH_GATEWAY_PORT", "1921")),), Handler).serve_forever()
