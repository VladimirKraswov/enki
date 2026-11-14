# RTX 5090: Qwen on Strata and Ornith on Infernix

The VM 5200 (`192.168.31.71`) runs exactly two model backends:

| Model | Engine / artifact | Public model ID |
| --- | --- | --- |
| Qwen3.8-Flash-Next | Strata Control 0.1.59.1 / engine 0.1.59, current NVFP4 pack | `qwen38-flash-next` |
| Ornith-1.5-122B | Infernix `8200dfa`, NVFP4 artifact, 262,144 context | `ornith15-122b` |

`ornith-gateway.service` exposes the existing authenticated model-control and
OpenAI proxy on port 1921. Strata's Qwen control API is on loopback 1920 and
legacy inference gateway on 1919; Infernix listens only on loopback 1922.
Hub coordinates whole-turn reservations and the shared physical GPU. There is
no second agent loop.

## Active settings

- Qwen: native 262,144 context, INT8 KV, GPU Vision, existing NVFP4 pack,
  separate MTP, calibrated `pcie-frac 0.16`, `spec 6`, expert profile and
  `conversation-cache-park-gain 1024`.
- Ornith: 262,144 context, INT8 KV, one request, full expert RAM layout,
  `INFERNIX_TMP_CPU_PLACEMENT=physical,20`, MTP with three drafts,
  4 GiB host prefix cache and persistent expert/prefix state.
- Qwen remains loaded in the API but unloaded at the engine when Ornith runs;
  its arena and Infernix's pinned experts fit together in 176 GiB VM RAM.
- Qwen and Infernix use separate systemd units. Only Infernix starts at boot;
  Qwen starts on explicit selection. The old fixed-only watchdog is removed:
  it treated a deliberate Qwen unload as a failure and interfered with switches.

## Measured after final cleanup

- Qwen → Ornith: 107.5 s; Ornith → Qwen: 72.1 s. The Infernix side must reload
  68 GiB of weights and save/restore prefix/expert state; this is slower than
  the removed PolyStrata backend's switch, but the cycle is reliable.
- Qwen tool call: valid `{"city":"Moscow"}`, 67.1 tok/s.
- Ornith tool call: valid JSON; short output varies with reasoning/drafts.
- No failed systemd units. 700 GB free on the guest disk. The host thinpool
  fell from 100% to 89.6% after the cleanup.

## Removed after acceptance

PolyStrata, llama.cpp, Ornith's UD-Q4_K_XL GGUF, old Strata 0.1.56 app/bin,
pre-0.1.56 backups, the staging service and old watchdog files were removed.
The only remaining Ornith model artifact is the Infernix NVFP4 set.

## Source and tests

- [Infernix deployment and measured tuning](../infernix/README.md)
- [Strata deployment and Qwen profile](../strata/README.md)
- `gateway.py` and `ornith-gateway.service`: model lifecycle and proxy.
- `tests/test_gateway.py`: control/auth/recovery/nonblocking service-start tests.
- `benchmark.py`: small gateway acceptance benchmark.

Do not run two GPU engines simultaneously. Do not restore deleted artifacts or
services from old instructions without a new assignment and a memory/disk plan.
