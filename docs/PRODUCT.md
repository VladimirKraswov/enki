# Product brief

## User intent

The user wants **Enki**: a desktop coding workspace with the workflow and density
of the Codex desktop app, powered by their own models (local Qwen3.8 Flash Next and
other Hub-coordinated models). The project began as a shell over an installed
OpenCode (0.2.x) and gained an optional Pi CLI engine. Since **2.0** Enki runs every
chat in one bundled agent core — the **Enki Runtime** (pinned Pi SDK) — so no
external agent has to be installed, launched or kept compatible. Former OpenCode
and Pi CLI histories are imported read-only and can be explicitly continued in a
new Enki chat with visible provenance; their source files are never modified.

## Workspace layout

Use a restrained desktop design: thin native title area; roughly 240px left sidebar; readable center conversation; optional resizable right review/files panel and bottom terminal. Warm/neutral dark surfaces, subtle separators, compact readable typography, quiet status colors. Match the workflow and density of a serious coding tool, not a generic dashboard. Use original assets and the Enki identity.

The sidebar contains New conversation, project selector/add folder, search, grouped recent sessions, timers and settings/connection status. The center header shows session title, directory, branch/status and panel toggles. Message history has a comfortable reading width; tool and thinking entries collapse without hiding errors or requests needing action. Composer stays near the bottom and includes model, supported reasoning effort, access mode, attachments, dictation, send and stop.

Review/file/terminal panes should be usable alongside chat and maintain their dimensions. The app must work in an ordinary laptop window and on a large display. Keyboard navigation and focus restoration are first-class, including accessible names for icon controls.

## Primary flows

1. Launch → the bundled runtime starts (or the selected SSH host's runtime connects) → select project → resume/new conversation → choose model/Medium → send task.
2. Observe reasoning/tools → approve a concrete permission or answer a question → inspect changes → run tests in terminal → read the final result.
3. Switch projects while a task runs → maintain correct task state → return without losing drafts, history, queue, pending questions or changes.
4. Lose the runtime connection → keep draft/history → show disconnected/reconnecting state → resync when healthy, never silently resend a prompt.
5. Update Enki → the runtime is part of the signed update (its SDK pin changes only through the reviewed upgrade procedure, [SDK-UPGRADE](SDK-UPGRADE.md)); queued and timed work survives the restart without replay.

## Truthful status

Do not equate quiet output with a crash. Display session status, active tools, pending permission/questions, stream connectivity and last event time separately. Each run has a durable outcome: for `length`, explain output-budget exhaustion; a turn that ended on tool calls without an answer, a run with no answer, a provider `error`, an explicit Stop, an intentional close and a lost Hub reservation are all distinguished. Model/runtime safeguards stay in the runtime and the inference services; the app adds no uncontrolled automatic follow-up loop and never replays a turn.

## Ownership and settings

The **Enki Runtime** owns histories, execution, the durable command ledger, the prompt queue, timers, permissions, compaction, model transitions and Hub leases. The window owns theme, layout, selected directories, drafts and per-workspace preferences, and forwards explicit user intent. Native Enki owns credentials (OS vault), the capability registry, the browser/computer bridges and updates. Changing the UI must not silently reset sessions or rewrite agent behavior; old OpenCode/Pi configuration is never rewritten — importing Pi settings is an explicit, one-time action.

## Definition of useful

Real tool execution and real reviewable code changes, including errors and interruption, matter more than decorative feature count. A feature without a working API should be absent or visibly unavailable with an explanation.
