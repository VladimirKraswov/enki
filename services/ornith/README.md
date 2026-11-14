# Ornith 1.5 122B on PolyStrata / RTX 5090

## Current deployment

**2026-11-14 update:** Qwen control/engine moved to Strata 0.1.59.1/0.1.59;
warm Qwen load fell from 36 to 30 s and Ornith→Qwen/Qwen→Ornith measured
28–32 s on PolyStrata. The legacy watchdog was disabled because it restarted the
deliberately unloaded Qwen during switches.

Ornith is now **active on Infernix NVFP4 at 262,144 context** with the same
public model ID; its measured 220K prompt time is 68 s against PolyStrata's
129 s, while PolyStrata is faster on short decode (47–50 against 28–34 tok/s)
and switching. `ornith-poly` (262K config) remains installed and disabled as
the fallback. See [services/infernix](../infernix/README.md).

VM 5200 has a 32 GB RTX 5090, 32 vCPU, 176 GiB RAM and a 1 TB root disk. The
122B model does not fit VRAM, so this is GPU + system-RAM expert offload, not a
claim of full-GPU inference.

- Engine: **PolyStrata `strata-poly`**, pinned source commit
  `67dde645dd94190733cca8ad78d2faa68b930e2a`, compiled locally for CUDA
  `sm_120` with CUDA 13.3.
- Model: the existing, already verified `unsloth/Ornith-1.5-122B-GGUF`
  **UD-Q4_K_XL**, three shards, 79,713,771,665 bytes. No quantization downgrade
  or model replacement was needed.
- Context: 131072 tokens; vision is off so its encoder does not consume VRAM.
- PolyStrata's own MTP/draft block in the GGUF is enabled (the default
  `--window 8`). There is no `--no-draft` and no external draft model.
- Default adaptive expert/profile cache, prompt batch 1024, 22 CPU expert
  threads and automatic conversation cache are retained.
- Qwen and Ornith share one GPU and are selected one at a time. Only
  `ornith-poly.service` starts at boot; Qwen starts on explicit selection.
  llama.cpp remains installed as a disabled fallback.

## Measured acceptance

All PolyStrata figures below are from this VM, not copied from another GPU.
The llama.cpp figures are the earlier deployment's measurements; short-prompt
runs are indicative rather than a controlled quality benchmark.

| Check | llama.cpp | PolyStrata |
| --- | ---: | ---: |
| 65,053-token cold prompt | about 207 tok/s | **2,199.6 tok/s** |
| Decode after the 65K prompt | about 18–21 tok/s | **34.3 tok/s** |
| Repeated 65K request | no equivalent measurement | 65,052 tokens reused; **52.1 tok/s** decode |
| Tool-call request | valid JSON, about 18–21 tok/s | valid JSON, **43.6 tok/s** |
| Enki turn, 13,592 input / 169 output tokens | not measured | 1,365.8 tok/s prefill, **39.2 tok/s** decode |
| Warm `/load` after Qwen unload | 36 s (0.1.56) | **30.2 s** (0.1.59.1) |
| Switch to Ornith | 42 s (0.1.56) | **28–32 s** (0.1.59.1) |

The 65K needle answer was exactly `ORNITH-NEEDLE-73921`. Tool arguments were
`{"city":"Moscow"}`. MTP acceptance was 21/29 in the tool test, 22/29 after the
long prompt and 60/98 in the Enki turn. A real Enki session completed normally
through the existing Hub reservation and gateway; no provider URL or model ID
changed.

`--prompt-batch 2048` was also tested: cold 65K prefill fell to 2,112.8 tok/s,
so it was reverted to the default 1024 rather than kept as an unverified
"optimization". MTP window 8 is already the engine default. No quality loss is
claimed proven by speed figures alone; the acceptance evidence is the identical
Q4 files, exact long-context answer, valid tool call and successful Enki turn.

The official Ornith Q5_K_M file and PolyStrata community Q5 results are a
possible later quality/speed experiment, but Q5 is **not installed or active**.
Changing engine and quantization simultaneously would make the A/B result less
clear.

## Install / reproduce

Build in a new source directory; do not overwrite the separate Qwen Strata
installation:

```bash
git clone https://github.com/simplexai-labs/PolyStrata.git \
  /home/vladimir/src/PolyStrata
cd /home/vladimir/src/PolyStrata
export PATH=/usr/local/cuda-13.3/bin:$PATH
./setup.sh --family ornith122 --model UD-Q4_K_XL \
  --context 131072 --vision no --port 1923 \
  --gguf-dir /srv/models/ornith-1.5-122b-ud-q4_k_xl \
  --yes --no-start --build
mkdir -p /home/vladimir/.config/strata /home/vladimir/.local/state/strata
```

The reviewed generated configuration is `polystrata-ornith122.json`. Its log is
outside the read-only source tree. `ornith-poly.service` runs the server on
`127.0.0.1:1923`; `ornith-gateway.service` proxies it through the existing
authenticated gateway on port 1921.

The gateway starts services with `systemctl start --no-block` and waits for the
exact health endpoint separately. This avoids starting a fallback while a slow
Qwen `ExecStartPost` readiness check is still running. An unreachable Qwen
health endpoint means "not ready", not an exception that skips service start.

## Files

- `polystrata-ornith122.json`: generated PolyStrata model configuration.
- `ornith-poly.service`: active PolyStrata inference unit.
- `ornith.service`: disabled llama.cpp fallback on `127.0.0.1:1922`.
- `gateway.py` + `ornith-gateway.service`: bounded model-control/proxy on 1921.
- `benchmark.py`: short/tool/65K acceptance benchmark; set
  `ORNITH_BENCH_BASE` to test port 1921 or 1923.
- `tests/test_gateway.py`: control contract, transport failure and non-blocking
  service-start regression tests.

## Sources checked

- Official model: <https://huggingface.co/ornith-ai/Ornith-1.5-122B>
- Current GGUF: <https://huggingface.co/unsloth/Ornith-1.5-122B-GGUF>
- PolyStrata Ornith-122B backend matrix and MTP/cache internals:
  <https://github.com/simplexai-labs/PolyStrata/blob/main/docs/BACKENDS.md>
- Community Ornith-122B Q5/MTP/128K and prompt-batch results:
  <https://github.com/simplexai-labs/PolyStrata/blob/main/docs/COMMUNITY_BENCHMARKS.md>
- llama.cpp offload recipe used for the earlier fallback:
  <https://www.reddit.com/r/LocalLLM/comments/1xbg2qk/recipe_ornith15122b_on_a_single_rtx_3090_155_toks/>
- DFlash2 is a different NVFP4/vLLM/SGLang path, not the active GGUF MTP block:
  <https://huggingface.co/incoai/Ornith-1.5-122B-DFlash2>

## Hub integration

The existing `rtx5090` switch service remains at
`http://192.168.31.71:1921`; its public model IDs and shared GPU resource are
unchanged. Hub coordinates whole-turn reservations. The gateway owns engine
lifecycle, and PolyStrata owns inference. No second agent loop was added.
