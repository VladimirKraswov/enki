# Infernix: Ornith 122B at 262K on RTX 5090

Status: **active production backend since 2026-11-14**. After acceptance the
PolyStrata sources/service and Q4 GGUF were removed; Qwen on Strata is the other
backend on this VM.

## Why evaluate it

Infernix is a C++/CUDA single-GPU engine for Qwen-model artifacts. The
`wallawalla47/Ornith-1.5-122B-NVFP4-Infernix` artifact contains Ornith's routed
experts (60.75 GiB) in NVFP4, MTP and DFlash2 drafters, vision and the model's
sampling metadata. The official guide recommends 262144 context, INT8 KV, MTP
with two confidence-gated drafts and `--host-context-mib 4096`.

This VM has a 32 GB RTX 5090 and is pinned to host **NUMA node 0**: 236 GiB
allocated (231 GiB visible), all 40 hardware threads. Node 1 and its RAM belong
to the host and other services; V100 is stopped and reserves nothing. Infernix
uses 24 CPU expert workers, leaving 16 threads for its engine/CUDA/runtime. Qwen
and Ornith never run simultaneously; when active, each service has the whole
node-0 CPU mask 0–39. The Linux `LimitMEMLOCK` must be infinite; the login
shell's default limit here is only about 21 GiB, so Infernix must run under its
systemd unit.

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
  --max-context 262144 --max-concurrency 1 --kv-dtype int8
  --spec mtp --draft-tokens 3
  --host-context-mib 4096 --expert-ram-layout full
  --prefix-cache-file /var/lib/ornith-infernix/prefix-cache.bin
  --expert-state /var/lib/ornith-infernix/expert-state.bin
```

`ornith-gateway` connects to port 1922 with `ORNITH_SERVICE=ornith-infernix`
and `ORNITH_EXCLUSIVE_RAM=0`. Qwen's unloaded API and its arena remain on the
same node 0; this keeps the return to Qwen warm. Measured warm cycle on the
dedicated node: **Infernix→Qwen 50 s, Qwen→Infernix 58 s**. The first Qwen start
after a VM reboot is cold (about 140 s); later cycles use the retained arena and
page cache.

## Measured on this VM

The official artifact SHA-256 and a 262,144-token plan pass. The 250K test sent
220,044 prompt tokens and recovered the exact marker. Tool JSON is valid.

| Check | Infernix NVFP4 | PolyStrata Q4_K_XL |
| --- | ---: | ---: |
| Context | 262,144 | 262,144 |
| 65K prefill | **3,942 tok/s** | 2,130 tok/s |
| 220K prompt total | **67.4 s** | 129.2 s |
| 220K prefill | **3,447 tok/s** | 1,727 tok/s |
| Decode after 220K | **39.1 tok/s** | 34.7 tok/s |
| Short/medium decode | **47.5 tok/s median** | 47–50 tok/s |
| Qwen→Ornith warm cycle | **58 s** | historical: 28–32 s (removed backend) |
| Ornith→Qwen warm cycle | **50 s** | historical: 28–32 s (removed backend) |

Infernix wins long-prompt TTFT and end-to-end time by about 1.9×; after tuning
it also leads 65K/220K decode and reaches parity with PolyStrata on short text.
On the 32 GB / PCIe 3 / DDR4 E5 VM, the author's 77–103 tok/s (i9/DDR5/PCIe 5)
was not reproduced by the default configuration.

### Maximum measured decode (thinking off)

| Model | Short median | Short max | ~52K context decode |
| --- | ---: | ---: | ---: |
| Qwen3.8-Flash-Next | 101.1 | **110.6** | **115.3 tok/s** |
| Ornith Infernix | 54.9 | **63.6** | 52.1 tok/s |

Ornith used 24 CPU workers over 512-token generations; its third short run
reached 63.6 tok/s as the expert cache warmed. Qwen's pool used 32 of 40 threads.
Full method and actual token counts:
[SPEED-2026-11-14](../model-eval/SPEED-2026-11-14.md).

## Tuning on this VM

The first active configuration used the engine's default six CPU workers and
MTP auto. The VM's CPU team measured 4,417 experts/s against the author's
~10,650, and the PCIe 3.0 link is slower than the author's Gen5×8. The default
auto link split (43/256) was therefore already sensible; forcing 0.125/0.25/0.5
did not improve it.

Increasing the physical CPU expert team did help. The tuning harness runs the
same three coding/3D/ESP32 prompts, temperature 0, and records both throughput
and output hashes:

| Placement / drafting | Median decode |
| --- | ---: |
| Default 6 workers, MTP auto (2) | 30.9 tok/s |
| Physical 12, MTP auto | 44.1 |
| Physical 16, MTP auto | 44.8 |
| Physical 20, MTP auto | 45.6 |
| Physical 24, MTP auto | 44.5 |
| **Physical 20, MTP 3** | **47.5 tok/s** |
| Physical 20, DFlash2 | 46.6 |
| Physical 20, DFlash2 tree 4 / 2 paths | 46.9 |

The active unit is **physical,24 + MTP 3** on the 40-thread node. On this node,
20 workers measured 45.2 tok/s, 24 measured **47.4**, and 28 measured 47.4; 24
gives the same throughput with 16 threads left for the engine. Qwen's Strata
pool independently picks 32 workers out of 40 when Qwen is the active service. `--a8-activations` and `--expert-tail-skip` were
not used because they change the quality contract.

Tuned acceptance: 65K decode 45.5 tok/s (was 33.8), 220K decode 39.1 (was
28.3), prefill unchanged at 3,942/3,447 tok/s. Both needles and the tool JSON
pass. `services/infernix/tune.py` is the repeatable harness.

## Acceptance gates

1. Three artifact SHA-256 checks pass.
2. `infernix-serve --plan` succeeds at 262144 context.
3. `/health`, `/v1/models`, reasoning and a valid tool call work through the
   existing gateway and model alias `ornith15-122b`.
4. A 65K needle and a long code turn pass; measure TTFT and decode against
   PolyStrata on this VM, not the author's published numbers.
5. Qwen → Infernix → Qwen completes and releases pinned RAM/VRAM correctly.
6. An Enki session succeeds end-to-end before enabling the unit at boot.

## After acceptance

PolyStrata, llama.cpp, the Q4 artifact and old Strata backups were deleted by the
owner's cleanup assignment. Only Qwen/Strata and Ornith/Infernix remain. Qwen is
available through the same gateway when Ornith is stopped or fails; do not assume
an uninstalled PolyStrata rollback exists. The measured PolyStrata figures above
are retained only as historical comparison data.
