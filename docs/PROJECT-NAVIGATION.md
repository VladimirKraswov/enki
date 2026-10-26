# Current project navigation

Open **Chat context → Карта проекта** to preview file paths, heuristic symbol names/line numbers, instruction-file pointers and package script names. Refresh explicitly after edits. The preview is local; it does not invoke a model or execute checks. It requires the existing shared MCP runtime.

**Подключить для агентов** enables the read-only `project_map` MCP tool for this local folder through the shared Enki runtime registry. It is off by default. The selected model receives metadata only when it calls the tool. Agent permissions still apply. No prompt injection, second agent loop, vector database, project instruction rewriting or skill generation is involved. Foreign/inherited registrations using the reserved name are preserved and reported; writes use the existing compare-and-swap registry operation. Disable/re-enable invalidates old connections.

Remote projects do not use the Mac filesystem map. Current support is explicitly local. Windows/Linux live acceptance is excluded at the owner's request; source portability and CI are separate from live acceptance.

## Evidence and boundaries

Each query rebuilds the map and reports observation time, a SHA256 revision of indexed metadata, coverage, partial/non-atomic flags and per-file sample SHA256/byte counts. This is not a full project revision or LSP index: line-oriented heuristics miss some symbols; a changed file may be observed at a different moment from another. Always read current files and applicable AGENTS/checkpoint instructions before editing. Instruction file contents and script bodies are never returned by the map.

Git inventory uses tracked/untracked nonignored files with fsmonitor disabled, no hooks, sanitized Git config environment and a three-second deadline. Nested roots respect ancestor-repository ignores. If Git inventory cannot be safely obtained, the query fails closed. Plain non-Git folders use a bounded walk and explicitly report that inventory; Gitignore semantics are not claimed there. Hidden/secret names, build/cache/vendor directories, symlink files/ancestors, parent paths and control characters are excluded. Files with arbitrary names can still contain sensitive symbol names: enable only for projects whose navigation metadata may be sent to your selected provider.

Limits: 2,000 walk nodes, 1,000 candidate paths, 2 MiB sampled per query, 64 KiB/file, 64 symbols/file, 30 check names, 1–40 output entries, 1–8 KiB whole UTF-8 JSON, 20 calls/64 KiB per connection. Native preview has a 15-second deadline. No file text, shell command bodies, remote URLs, environment, arbitrary roots or writes are supported. The backend validates folder/CWD and registry grant; SDK wrapper revalidates before and after each read and rejects changed registrations. Scripts use the existing verified Node runtime and pinned official MCP SDK.

## Evaluation

Synthetic suite 2.1.0 adds `--navigation off|tools|compare` to the existing bounded runner. Tools mode exposes the very same map core on the miniature project directory. It does not change held-out assertions or task prompts, inject prepared context or expose the oracle. Provider, bounds and scope remain identical between modes. This compares task outcomes/tokens/time, not native transport latency, large-project performance or local Qwen quality. A tool can be useful for navigation without reliably improving task success; no automatic promotion follows from a few successful runs.
