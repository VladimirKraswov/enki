# RTX 5090 model coding evaluation

Bounded synthetic comparison of `qwen38-flash-next` and `ornith15-122b` through
the existing VM gateway. It does not create Enki sessions, use owner history,
switch models, or change inference configuration.

Tasks:

- Python backend token bucket: argument/state/refill/negative-time checks.
- JS telemetry boundary: validation, non-finite values and CSV escaping.
- JS 3D core: cuboid geometry, perspective camera, zoom and painter-sorted faces.
- Arduino ESP32 controller: C++17 compile against test-owned Arduino/OneWire/
  DallasTemperature stubs, then simulated LED/sensor/nonblocking behaviour.

Run one model while it is active on the gateway, then the other. No concurrent
inference is used. Generated code is untrusted and is compiled/run only in its
isolated task directory with timeouts.

```bash
python3 services/model-eval/run.py ornith15-122b
python3 services/model-eval/run.py qwen38-flash-next
# Repeat offline verification without model tokens:
python3 services/model-eval/run.py qwen38-flash-next --verify-only
```

Results and generated source: `.local/model-eval/<model>/report.json`.
Automated pass/fail is a narrow engineering signal, not a general intelligence
score or proof that one model is better for every task. Timing fields come from
the engine responses; they are recorded per generation and not averaged into a
misleading universal tokens/s claim.
