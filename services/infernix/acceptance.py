#!/usr/bin/env python3
"""Acceptance checks for the Ornith Infernix backend through the Hub gateway."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
import urllib.request

BASE = os.environ.get("INFERNIX_ACCEPT_BASE", "http://192.168.31.71:1921/v1/chat/completions")
OUT = Path(os.environ.get("INFERNIX_ACCEPT_OUT", "/Volumes/Extend/work/Enki/.local/infernix-acceptance.json"))
PARAGRAPH = "Технический абзац о локальном inference, экспертах, памяти и проверке длинного контекста. "


def chat(messages, max_tokens=96, tools=None):
    body = {"model": "ornith15-122b", "messages": messages, "max_tokens": max_tokens, "temperature": 0}
    if tools:
        body["tools"] = tools
    started = time.perf_counter()
    request = urllib.request.Request(BASE, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    with urllib.request.urlopen(request, timeout=1800) as response:
        value = json.load(response)
    message = value.get("choices", [{}])[0].get("message", {})
    return {
        "seconds": round(time.perf_counter() - started, 3),
        "content": message.get("content"),
        "hasReasoning": bool(message.get("reasoning_content")),
        "toolCalls": message.get("tool_calls"),
        "usage": value.get("usage"),
        "timings": value.get("timings"),
    }


def needle(tokens: int, marker: str):
    copies = max(1, round(tokens / 25))
    prompt = f"Маркер: {marker}. {PARAGRAPH * copies}\nКакой маркер был в начале? Ответь только маркером."
    result = chat([{"role": "user", "content": prompt}], 128)
    result["requestedApproxTokens"] = tokens
    result["exact"] = (result.get("content") or "").strip() == marker
    return result


def main():
    out = {}
    out["health"] = json.load(urllib.request.urlopen(BASE.replace("/v1/chat/completions", "/health"), timeout=30))
    models = json.load(urllib.request.urlopen(BASE.replace("/v1/chat/completions", "/v1/models"),
        timeout=30))
    out["models"] = models
    out["short"] = chat([{"role": "user", "content": "Ответь одним предложением: Infernix готов."}], 48)
    tools = [{"type": "function", "function": {"name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
    out["tool"] = chat([{"role": "user", "content": "Вызови get_weather для Moscow."}], 96, tools)
    out["needle65k"] = needle(65_000, "INFERNIX-65K-73921")
    out["needle250k"] = needle(250_000, "INFERNIX-250K-48157")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
