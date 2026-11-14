#!/usr/bin/env python3
"""Small acceptance benchmark for the running Ornith gateway, no model tokens in output."""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:1921"


def chat(messages, max_tokens=64, tools=None):
    body = {"model": "ornith15-122b", "messages": messages, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
    started = time.perf_counter()
    request = urllib.request.Request(BASE + "/v1/chat/completions", data=json.dumps(body).encode(),
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


def main():
    result = {}
    result["short"] = chat([
        {"role": "system", "content": "Отвечай по-русски, коротко и точно."},
        {"role": "user", "content": "Назови модель и скажи, готова ли ты к тесту."},
    ], 96)
    tools = [{"type": "function", "function": {"name": "get_weather", "description": "Текущая погода в городе",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
    result["tool"] = chat([{"role": "user", "content": "Вызови get_weather для Moscow."}], 64, tools)
    marker = "ORNITH-NEEDLE-73921"
    paragraph = "Это обычный технический абзац о локальном запуске больших моделей и разделении весов между GPU и RAM. "
    repeated = paragraph * 2600
    prompt = f"Запомни маркер {marker} в начале документа. {repeated}\nКакой маркер был в начале документа? Ответь только маркером."
    result["long"] = chat([{"role": "user", "content": prompt}], 96)
    result["long"]["approxChars"] = len(prompt)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
