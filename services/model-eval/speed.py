#!/usr/bin/env python3
"""Reproducible decode/prefill speed measurement through the Enki gateway."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import time
import urllib.request

BASE = "http://192.168.31.71:1921/v1/chat/completions"
PARAGRAPH = "Технический абзац о локальном inference, экспертах, памяти и длинном контексте. "
SHORT_PROMPTS = [
    "Напиши на Python потокобезопасный LRU-кэш с TTL. Покажи полный код и кратко объясни инварианты.",
    "Объясни перспективную проекцию, near/far clipping и painter's algorithm для Canvas 3D.",
    "Напиши неблокирующий ESP32 loop: LED 500 мс, кнопка с debounce 50 мс, DS18B20 каждые 2 секунды.",
]


def call(model: str, prompt: str, max_tokens: int):
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "enable_thinking": False,
    }
    request = urllib.request.Request(BASE, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=1800) as response:
        value = json.load(response)
    message = value.get("choices", [{}])[0].get("message", {})
    text = (message.get("reasoning_content") or "") + "\n" + (message.get("content") or "")
    timings = value.get("timings") or {}
    usage = value.get("usage") or {}
    return {
        "seconds": round(time.perf_counter() - started, 3),
        "promptTokens": usage.get("prompt_tokens"),
        "completionTokens": usage.get("completion_tokens"),
        "reasoningTokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        "prefillTokS": timings.get("prompt_per_second"),
        "decodeTokS": timings.get("predicted_per_second"),
        "draftAccepted": [timings.get("draft_n_accepted"), timings.get("draft_n")],
        "expertHit": [timings.get("expert_hit_n"), timings.get("expert_routed_n")],
        "hash": hashlib.sha256(text.encode()).hexdigest(),
    }


def long_prompt(approx_tokens: int) -> str:
    copies = max(1, round(approx_tokens / 25))
    return f"Ниже длинный технический документ. {PARAGRAPH * copies}\nКратко ответь: что это за документ?"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=["qwen38-flash-next", "ornith15-122b"])
    parser.add_argument("--out", default="/Volumes/Extend/work/Enki/.local/speed")
    args = parser.parse_args()
    result = {"model": args.model, "short": [], "medium": None, "long": None}
    for prompt in SHORT_PROMPTS:
        row = call(args.model, prompt, 512)
        result["short"].append(row)
        print(args.model, "short", row["decodeTokS"], row["completionTokens"], flush=True)
    result["medium"] = call(args.model, long_prompt(8_000), 256)
    print(args.model, "8k", result["medium"]["prefillTokS"], result["medium"]["decodeTokS"], flush=True)
    result["long"] = call(args.model, long_prompt(65_000), 128)
    print(args.model, "65k", result["long"]["prefillTokS"], result["long"]["decodeTokS"], flush=True)
    short_decode = [r["decodeTokS"] for r in result["short"] if r["decodeTokS"]]
    result["summary"] = {
        "shortDecodeMedian": statistics.median(short_decode) if short_decode else None,
        "shortDecodeMax": max(short_decode) if short_decode else None,
        "shortDecodeMin": min(short_decode) if short_decode else None,
        "shortPrefillMedian": statistics.median([r["prefillTokS"] for r in result["short"] if r["prefillTokS"]]),
    }
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    (out / f"{args.model}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
