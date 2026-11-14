# Infernix: Ornith 122B at 262K on RTX 5090

Status: **active production backend since 2026-11-14**. PolyStrata remains installed
and disabled as the measured fallback.

## Why evaluate it

Infernix is a C++/CUDA single-GPU engine for Qwen-model artifacts. The
`wallawalla47/Ornith-1.5-122B-NVFP4-Infernix` artifact contains Ornith's routed
experts (60.75 GiB) in NVFP4, MTP and DFlash2 drafters, vision and the model's
sampling metadata. The official guide recommends 262144 context, INT8 KV, MTP
with two confidence-gated drafts and `--host-context-mib 4096`.

This VM has a 32 GB RTX 5090 and **176 GiB RAM** (not 300+ GiB): 68 GiB pinned
for the model plus 4 GiB prefix host cache fit. The Linux `LimitMEMLOCK` must be
infinite; the login shell's default limit here is only about 21 GiB, so Infernix
must run under its systemd unit.

## Pinned inputs

- Source: `https://github.com/Wallawalla47/Infernix`
- Commit: `8200dfa2fe51811570b97820e73095fa2c7df98c` (2026-11-14)
- Build: CUDA 13.4.92, GCC 13.3, CMake release preset, `sm_120a`
- Artifact: `wallawalla47/Ornith-1.5-122B-NVFP4-Infernix`, 75,331,296,516 bytes
- Artifact SHA-256: `artifacts.sha256`
- Model license: MIT; DFlash2 component and engine: Apache-2.0

The engine README carries the author's explicit AI/hobby disclaimer. Treat it
as third-party software: loopback-only listener, no credentials in arguments,
pinned source/artifact, SHA verification, and rollback to PolyStrata.

## Build

```bash
sudo apt-get install -y cuda-toolkit-13-4 build-essential cmake ninja-build \
  pkg-config libavformat-dev libavcodec-dev libavutil-dev libswscale-dev \
  libjpeg-turbo8-dev libcurl4-openssl-dev
git clone https://github.com/Wallawalla47/Infernix.git
cd Infernix
git checkout 8200dfa2fe51811570b97820e73095fa2c7df98c
export PATH=/usr/local/cuda-13.4/bin:$PATH
export CUDACXX=/usr/local/cuda-13.4/bin/nvcc
cmake --preset release
cmake --build build -j 16
```

## Artifact

Keep all three `.infernix` parts in one directory and pass part 1. Verify with:

```bash
cd /srv/models/ornith-infernix
sha256sum -c /path/to/Enki/services/infernix/artifacts.sha256
```

## Runtime

`ornith-infernix.service` runs:

```text
infernix-serve part-00001.infernix
  --host 127.0.0.1 --port 1922 --model-id ornith15-122b
  --max-context 262144 --max-concurrency 2 --kv-dtype int8
  --spec mtp --draft-tokens auto
  --host-context-mib 4096 --expert-ram-layout full
  --prefix-cache-file /var/lib/ornith-infernix/prefix-cache.bin
  --expert-state /var/lib/ornith-infernix/expert-state.bin
```

`ornith-gateway` connects to port 1922 with `ORNITH_SERVICE=ornith-infernix`
and `ORNITH_EXCLUSIVE_RAM=0`. Keeping Qwen's unloaded API and its arena alive
still leaves enough RAM for Infernix (68 GiB pinned + 63 GiB shared); this keeps
the return to Qwen warm. Measured switching: Qwen→Infernix 60–95 s (Infernix
must reload 68 GiB), Infernix→Qwen 62 s. PolyStrata at the same 262K switches in
28–32 s.

## Measured on this VM

The official artifact SHA-256 and a 262,144-token plan pass. The 250K test sent
220,044 prompt tokens and recovered the exact marker. Tool JSON is valid.

| Check | Infernix NVFP4 | PolyStrata Q4_K_XL |
| --- | ---: | ---: |
| Context | 262,144 | 262,144 |
| 65K prefill | **3,928 tok/s** | 2,130 tok/s |
| 220K prompt total | **68.3 s** | 129.2 s |
| 220K prefill | **3,445 tok/s** | 1,727 tok/s |
| Decode after 220K | 28.3 tok/s | **34.7 tok/s** |
| Short/medium decode | 28–34 tok/s | **47–50 tok/s** |
| Qwen→Ornith switch | 60–95 s | **28–32 s** |
| Ornith→Qwen switch | 62 s | **28–32 s** |

Infernix wins long-prompt TTFT and end-to-end time by about 1.9×; PolyStrata
wins ordinary short decode and switching. On the 32 GB / PCIe 3 / DDR4 E5 VM,
Infernix does not reproduce the author's 77–103 tok/s (their i9/DDR5/PCIe 5).
The active choice is Infernix because the assignment prioritizes maximum speed
at 260K. For mostly short prompts, PolyStrata is the better daily backend.

## Acceptance gates

1. Three artifact SHA-256 checks pass.
2. `infernix-serve --plan` succeeds at 262144 context.
3. `/health`, `/v1/models`, reasoning and a valid tool call work through the
   existing gateway and model alias `ornith15-122b`.
4. A 65K needle and a long code turn pass; measure TTFT and decode against
   PolyStrata on this VM, not the author's published numbers.
5. Qwen → Infernix → Qwen completes and releases pinned RAM/VRAM correctly.
6. An Enki session succeeds end-to-end before enabling the unit at boot.

## Rollback

Keep `ornith-poly.service` installed and disabled at boot. Rollback is:
`systemctl disable --now ornith-infernix`, set gateway
`ORNITH_SERVICE=ornith-poly`, `ORNITH_BASE=http://127.0.0.1:1923` and
`ORNITH_EXCLUSIVE_RAM=0`, then start `ornith-poly` and restart the gateway.
No Qwen data or model artifact is removed. PolyStrata's 262K config and the
75 GB Q4 artifact remain ready.
