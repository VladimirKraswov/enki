#!/usr/bin/env python3
"""Reproducible, bounded code-generation comparison for the two RTX 5090 models.

Synthetic prompts only. Generated code is saved and checked in isolated task
folders by verify.py; the harness never changes Enki sessions or model services.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
import urllib.request

from verify import verify_task

BASE = os.environ.get("MODEL_EVAL_BASE", "http://192.168.31.71:1921/v1/chat/completions")
ROOT = Path(os.environ.get("MODEL_EVAL_ROOT", "/Volumes/Extend/work/Enki/.local/model-eval"))
SYSTEM = (
    "Ты выполняешь инженерный тест. Отвечай только кодом в одном fenced block, "
    "без пояснений. Точно сохраняй требуемые имена файлов и интерфейсы. "
    "Не используй внешние сетевые ресурсы или недокументированные зависимости."
)
TASKS = {
    "backend": {
        "file": "backend_limiter.py",
        "prompt": """Создай backend_limiter.py для Python 3.11+.

Реализуй потокобезопасный TokenBucket с injectable monotonic clock:
class TokenBucket:
    def __init__(self, capacity: float, refill_per_second: float, clock=None): ...
    def try_acquire(self, tokens: float = 1.0) -> bool: ...
    @property
    def available(self) -> float: ...

Требования: capacity и refill_per_second > 0; tokens > 0 и конечное число;
начальное число токенов = capacity; refill не превышает capacity; отрицательное
время не уменьшает доступные токены. Если часы ушли назад, не сдвигай сохранённую
точку отсчёта назад: после возврата refill считается от последнего максимального
наблюдённого времени. При нехватке состояние не расходуется; sleep и глобальное
состояние запрещены; блокировка должна защищать состояние.
Только стандартная библиотека. Ответь кодом целиком.""",
    },
    "telemetry": {
        "file": "telemetry.mjs",
        "prompt": """Создай ES module telemetry.mjs для frontend/backend границы.

export function validateTelemetry(value) — возвращает {ok, errors}, где errors —
массив строк по-русски. Принимает только plain object с обязательными:
sequence (целое >= 0), timestamp (конечное число >= 0), temperatureC (конечное
число от -40 до 125 включительно), deviceId (непустая строка длиной <= 64).
Лишние поля разрешены. null, массивы, NaN и Infinity отклоняются без throw.

export function telemetryCsvRow(value) — после успешной validateTelemetry
возвращает CSV строку "deviceId,sequence,timestamp,temperatureC" с корректным
CSV escaping deviceId; для невалидного значения возвращает пустую строку.
Без зависимостей. Ответь кодом целиком.""",
    },
    "scene3d": {
        "file": "scene3d.mjs",
        "max_tokens": 8000,
        "prompt": """Создай компактный ES module scene3d.mjs для frontend 3D-сцены.

API обязательно и без изменения имён:
export function cuboidVertices(cx, cy, cz, width, height, depth)
  → массив из 8 вершин [x,y,z]; размеры — полные width/height/depth.

export function projectPoint(x, y, z, camera = {})
  → {x, y, depth}; camera поддерживает yaw, pitch, zoom, width=800,
  height=600, near=1. Это перспективная проекция с центром canvas
  в (width/2,height/2); положительный depth — перед камерой, БОЛЬШЕ depth
  означает ДАЛЬШЕ от камеры.

export function projectCuboid(cx, cy, cz, width, height, depth, camera = {})
  → {vertices, faces}; vertices — 8 объектов {x,y,z,screenX,screenY,depth},
  faces — ровно 6 массивов по 4 индекса вершин, отсортированных от дальних
  к ближним по среднему depth (painter's algorithm); faces[0] — самая дальняя.

Требования: вращение yaw вокруг Y и pitch вокруг X, zoom масштабирует
проекцию, нулевые/отрицательные width и height в camera заменяются на 1 без
NaN; функции не зависят от DOM и не используют библиотеки. Только чистый JS.
Ответь одним fenced-блоком с кодом.""",
    },
    "esp32": {
        "file": "esp32_controller.ino",
        "prompt": """Создай esp32_controller.ino для Arduino ESP32 с неблокирующей логикой.

GPIO2: LED с периодом изменения состояния 500 мс.
GPIO0: кнопка INPUT_PULLUP, переключает работу LED с debounce 50 мс.
GPIO4: OneWire + DallasTemperature, requestTemperatures и getTempCByIndex(0)
не чаще одного раза в 2000 мс; значение выводить в Serial с двумя знаками.
В setup настроить пины, Serial.begin(115200), sensors.begin().
В loop нельзя использовать delay(), delayMicroseconds(), sleep или busy-wait.
Используй только Arduino.h, OneWire.h, DallasTemperature.h и millis().
Код должен компилироваться как C++17. Ответь полным INO.""",
    },
}


def extract_code(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first, _, rest = text.partition("\n")
        if first[3:].strip().lower() in {"", "python", "py", "javascript", "js", "mjs", "html", "cpp", "c++", "ino", "arduino"}:
            text = rest
        stripped = text.rstrip()
        if stripped.endswith("```"):
            text = stripped[:-3]
        return text.strip() + "\n"
    if "```" not in text:
        return text + "\n"
    blocks = text.split("```")
    for i in range(len(blocks) - 2, 0, -2):
        block = blocks[i].strip()
        if not block:
            continue
        first, _, rest = block.partition("\n")
        if first.lower() in {"python", "py", "javascript", "js", "mjs", "html", "cpp", "c++", "ino", "arduino"}:
            return rest.strip() + "\n"
        return block + "\n"
    return text + "\n"


def chat(model: str, prompt: str, max_tokens: int) -> tuple[str, dict]:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    started = time.perf_counter()
    request = urllib.request.Request(BASE, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    with urllib.request.urlopen(request, timeout=900) as response:
        value = json.load(response)
    message = value.get("choices", [{}])[0].get("message", {})
    content = message.get("content") or ""
    metadata = {
        "seconds": round(time.perf_counter() - started, 3),
        "finish": value.get("choices", [{}])[0].get("finish_reason"),
        "usage": value.get("usage"),
        "timings": value.get("timings"),
        "reasoningPresent": bool(message.get("reasoning_content")),
        "contentPresent": bool(content.strip()),
    }
    return content, metadata


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=["qwen38-flash-next", "ornith15-122b"])
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--tasks", nargs="*", choices=list(TASKS), default=list(TASKS))
    args = parser.parse_args()
    root = ROOT / args.model
    root.mkdir(parents=True, exist_ok=True)
    report = {"model": args.model, "base": BASE, "tasks": {}}
    existing = root / "report.json"
    if existing.exists():
        try:
            report = json.loads(existing.read_text())
            report.setdefault("tasks", {})
        except (OSError, ValueError):
            pass
    for name in args.tasks:
        task = TASKS[name]
        directory = root / name
        directory.mkdir(exist_ok=True)
        source = directory / task["file"]
        metadata = report.get("tasks", {}).get(name, {}).get("generation", {})
        if not args.verify_only:
            try:
                content, metadata = chat(args.model, task["prompt"], task.get("max_tokens", 4000))
                (directory / "raw.txt").write_text(content)
                source.write_text(extract_code(content))
            except Exception as exc:
                metadata = {"transportError": str(exc)[:500]}
        verification = verify_task(name, directory)
        report["tasks"][name] = {"generation": metadata, "verification": verification}
        print(f"{args.model} {name}: {'PASS' if verification['pass'] else 'FAIL'} — {verification['summary']}", flush=True)
        (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    passed = sum(1 for t in report["tasks"].values() if t["verification"]["pass"])
    print(f"RESULT {args.model}: {passed}/{len(report['tasks'])} automated checks passed")
    return 0 if passed == len(report["tasks"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
