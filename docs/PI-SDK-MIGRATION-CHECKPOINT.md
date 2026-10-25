# Pi SDK migration — checkpoint (SOURCE ONLY, NOT VERIFIED)

Base: Enki 0.2.115 main snapshot. Nothing in this work was executed: no install,
build, type check, test, lint or app run happened on the authoring machine.

## Committed design (do not re-litigate)

- Enki Runtime = Node ≥22.19 sidecar in `src-tauri/resources/agent/`, pinned
  `@earendil-works/pi-coding-agent@0.85.1`. Only `src/sdk/adapter.ts` imports SDK
  values; everything else uses adapter types.
- Rust `src-tauri/src/runtime.rs` supervises the local runtime (stdio JSONL control:
  token configure/rotate, shutdown/drain, broker for vault/Hub). WebView gets
  endpoint + bearer through a Tauri command, never a URL token.
- Remote hosts: `enki-runtime ensure` over strict-key SSH + `-L` tunnel; broker
  relayed by an attached desktop client; never falls back to local.
- Runtime owns sessions (AgentSession per session worker), command ledger
  (idempotent ids), event journal (durable seq cursor), queue, scheduler, tool
  execution journal, permissions/questions/extension UI, Hub run leases,
  files/git/PTY, legacy import.
- UI: `src/agent/runtime/*` client implementing `AgentBackend` (+ platform/queue/
  schedule APIs). OpenCode HTTP client, Pi CLI bridge, engine selection removed.
- Legacy OpenCode: read-only SQLite backup snapshot → immutable archive + manifest;
  served read-only; explicit continuation creates Pi session with mapped entries.

## Status

See bottom of file for live progress; updated at milestones.

### Progress log
- [x] Read instructions, store, queue, scheduler, journal, Pi bridge, SDK 0.85.1 API.
- [x] Runtime package `src-tauri/resources/agent/` (protocol, adapter, store, ledger,
      journal, workers, dispatcher, queue, scheduler, Hub leases, vault credentials,
      MCP pool, extension UI bridge, legacy import/continuation, files/git/PTY,
      HTTP API, supervisor channel, main) + runtime tests under `test/`.
      Extension sources in resources/{pi,shared,browser} adapted to per-session
      options (no env/stdout). Policy text moved to `resources/agent/src/policy/`.
- [x] Native supervisor: `runtime.rs` (+ `capabilities::runtime_scope`, `lsp.rs`),
      `lifecycle.rs` (drain on Quit, quit report from `drained`), `updates::idle`
      and Hub install via supervisor, `hosts::connect_remote_runtime`,
      `control.rs` schedules → runtime API, `lib.rs` wiring. `pi.rs`,
      `local_server.rs`, `agent_plugins.rs` unreferenced → delete list.
      Device build adds `runtime:prepare` stage + `tauri.runtime.conf.json`.
- [ ] Frontend migration
  - [x] Store/registry/engines glue (SOURCE ONLY): `agent/registry.ts` (single
        `RuntimeBackend`, strict local/SSH targets), `state/engines.ts` (single engine),
        new `state/runtimeSync.ts`, `state/store.ts` connected to runtime (connection,
        metadata, queue host without local dispatch, schedules removed, dialogs, broker
        relay, cursor/position history, ledger reconcile, legacy continuation),
        `test/runtime-store-sync.test.ts`. Details: `STORE-RESULT.md`.
  - [ ] Callers: components using `store.client` as OpenCode client, PiDialog/agentDialog,
        EngineSwitchDialog/TopBar, Settings/Dialogs/Composer/PiSettings, schedules/Runtime.tsx,
        PromptQueue acknowledge; old two-engine tests; delete list (see STORE-RESULT.md).
- [x] Packaging/CI/fingerprint: `scripts/runtime/{artifact,prepare,native-port,install-remote}.mjs`
      (the unauthenticated `install-remote.sh` is obsolete; removal listed in
      `MIGRATION_DELETE_PATHS_NATIVE.json`), `artifact.test.mjs`, `tauri.runtime.conf.json`,
      `runtime-node.entitlements`, package.json scripts, desktop.yml steps,
      verify-macos.py / verify-windows.ps1 nested runtime checks. Outputs only
      under `src-tauri/target/enki-agent/` (fingerprint rules unchanged in all
      three implementations).
  - [ ] UI pass (Opus 5.5, SOURCE ONLY, NOT RUN) — in progress:
    - [x] runtime: PtyService activity port/fence/unconfirmed exits; Runtime.activity counts
          PTY + questions (idle), quit drain excludes shells; HTTP drain route removed.
    - [x] runtime: InteractionBroker questions (start() transaction helper), `question`
          tool (Typebox), gate never asks permission to ask; /questions + snapshot.
    - [x] runtime: `server/ui-routes.ts` (/sessions/:id/ui, /ui/open, /ui/events, control,
          release, input, resize, resync, draft, retry-draft, resolve-draft, retry-submission).
    - [x] runtime tests: pty-activity, integration/questions, integration/plugin-ui-routes.
    - [x] frontend: RuntimeClient X-Enki-Client (per window) + questions + ui*; backend
          questions; pluginUi/{types,frameConsumer,surfaceController,session,draftSync,
          active}.ts; xtermHost, PluginTerminalSurface, PluginUiPanel; App/Composer wired.
    - [x] CSS; TerminalPanel (runtime PTY SSE), RightPanel, ContextPanel, CapabilitiesSettings
          (worker MCP reports), ComputerSettings (shared registry `--computer-mcp`),
          InformationDialog, SettingsScreen (OpenCode sections removed), App, Composer.
    - [x] Dialogs, TopBar (archive continuation), PiSettings (runtime settings), HostDialogs,
          HandoffDialog, AgentControlSettings/ComputerSettings (reserved registry),
          usage/sources, PiDialog (agentDialog), updates/runtime (runtime idle blocker),
          schedules/Runtime (binder only), PromptQueue (uncertain drop/requeue), Sidebar.
    - [x] ScheduleSection, ModelCatalogSettings; control/bridge + HubSettings need no change;
          fullAccessLoop → delete list. Frontend tests written; MIGRATION_DELETE_PATHS.json;
          UI-RESULT.md (remaining items listed there). ALL CHECKS NOT RUN.
  - [ ] Next bounded pass: legacy Pi callers in routes.ts (TODO), Windows native build
        runner, OpenCodeClient-mocking store tests rewiring, maxEventStreams review.
- [ ] Tests (written, not run)
- [ ] Docs + REMOTE-RESULT + delete list
