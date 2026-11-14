# Ornith 1.5 122B on RTX 5090

## Decision

The current VM 5200 has a 32 GB RTX 5090, 32 vCPU and SSD. The 122B model does not fit VRAM: UD-Q4_K_XL is 79,713,771,665 bytes. Use llama.cpp b11757+ with routed experts in system RAM, not a claim of full-GPU inference.

Deployment sizing for this host: VM memory 176 GiB, root disk 1 TB. Larger allocations were rejected by the host's NUMA policy, so the working configuration is bounded by GPU and one active engine rather than by an inflated RAM reservation. Qwen remains resident while Ornith is downloaded and compiled; a brief restart is only needed to apply the memory size and switch the active engine.

- Model: `unsloth/Ornith-1.5-122B-GGUF`, `UD-Q4_K_XL`, three shards.
- Engine: llama.cpp, CUDA `sm_120`.
- `llama-server -ngl 99 --n-cpu-moe 36 -c 131072 -fa on -t 16 --load-mode none --parallel 1`.
- Sampling for coding: temperature 0.6, top_p 0.95, top_k 20, min_p 0.
- MTP disabled: published CPU-expert testing showed ~21% acceptance and no speed gain.
- DFlash2 is relevant to NVFP4 + vLLM/SGLang, not this GGUF llama.cpp path. It needs a different memory profile and the drafter must not be mistaken for a standalone model.
- Qwen and Ornith are selected one at a time. Model files stay on SSD/page cache for quick switching; one active GPU engine at a time.

## Sources checked

- Official model and serving requirements: <https://huggingface.co/ornith-ai/Ornith-1.5-122B>
- Dynamic GGUF files: <https://huggingface.co/unsloth/Ornith-1.5-122B-GGUF>
- DFlash2 draft (not standalone): <https://huggingface.co/incoai/Ornith-1.5-122B-DFlash2>
- NVFP4/DFlash2 vLLM compatibility and BF16 head: <https://huggingface.co/Sherlock-Comms/Ornith-1.5-122B-NVFP4-DFlash2-RTX-Spark>
- Published 3090/5090 offload recipe, `--n-cpu-moe`, thread sweep and 128K results: <https://www.reddit.com/r/LocalLLM/comments/1xbg2qk/recipe_ornith15122b_on_a_single_rtx_3090_155_toks/>
- PolyStrata scope: <https://github.com/simplexai-labs/PolyStrata> — its Ornith path is 35B-A3B, not this 122B deployment.

## Files

- `ornith.service`: llama.cpp on `127.0.0.1:1922`, alias `ornith15-122b`.
- `gateway.py` + `ornith-gateway.service`: bounded model-control/proxy on `1921`, no arbitrary commands and no second agent loop.
- `tests/test_gateway.py`: auth, catalog, status and no-op selection checks.

The gateway accepts only `/health`, `/v1/model-control/{catalog,status,select}` and OpenAI-compatible `/v1/*` proxy routes. Qwen is unloaded/loaded via the existing Strata API. Ornith is controlled only through `systemctl {start,stop} ornith`.

## Hub integration

Keep the existing `rtx5090` service but make it a switch service at `http://192.168.31.71:1921`. Its control catalog contains both `qwen38-flash-next` and `ornith15-122b`; both share the `rtx5090` resource. Add the public model `local-ornith` with providerID `local-ornith`, modelID `ornith15-122b`, and a control binding to that same service. Keep API keys only in the existing private Hub key file, never in the public catalog or this repository.
