#!/usr/bin/env python3
"""Stable short/medium generation benchmark for Infernix tuning."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import time
import urllib.request

BASE = "http://192.168.31.71:1921/v1/chat/completions"
PROMPTS = [
    "Напиши Python-функцию для поиска LCP двух строк и объясни сложность.",
    "Объясни перспективную проекцию 3D-куба и painter's algorithm.",
    "Опиши неблокирующий ESP32 loop для LED 500 мс и DS18B20 каждые 2 секунды.",
]


def call(prompt):
    body = {"model": "ornith15-122b", "messages": [{"role": "user", "content": prompt}], "max_tokens": 256, "temperature": 0}
    request = urllib.request.Request(BASE, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=600) as response:
        value = json.load(response)
    message = value["choices"][0]["message"]
    text = (message.get("reasoning_content") or "") + "\n" + (message.get("content") or "")
    timings = value.get("timings") or {}
    return {
        "seconds": round(time.perf_counter() - started, 3),
        "hash": hashlib.sha256(text.encode()).hexdigest(),
        "usage": value.get("usage"),
        "decodeTokS": timings.get("predicted_per_second"),
        "prefillTokS": timings.get("prompt_per_second"),
        "accepted": [timings.get("draft_n_accepted"), timings.get("draft_n")],
        "expertHit": [timings.get("expert_hit_n"), timings.get("expert_routed_n")],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("label")
    p.add_argument("--out", default="/Volumes/Extend/work/Enki/.local/infernix-tuning")
    args = p.parse_args()
    rows = [call(prompt) for prompt in PROMPTS]
    decode = [r["decodeTokS"] for r in rows if r.get("decodeTokS")]
    result = {"label": args.label, "rows": rows, "medianDecodeTokS": statistics.median(decode) if decode else None,
              "hashes": [r["hash"] for r in rows]}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{args.label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"label": args.label, "medianDecodeTokS": result["medianDecodeTokS"],
                      "hashes": result["hashes"], "decode": [r["decodeTokS"] for r in rows]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
