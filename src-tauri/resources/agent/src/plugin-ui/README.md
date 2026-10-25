# Real SDK UI integration

This host executes real Pi 0.85.1 extension factories, `TuiAltScreen`, `Editor`,
widgets, overlays, header/footer replacements, theme/keybinding operations,
autocomplete, native-input listeners and command-context actions. The actual SDK
remains the only transcript writer. SQLite meta owns editor CAS, full submission
commands, stable submission IDs, pending projections and UI epochs.

Theme and keybindings are host-wide app preferences: the underlying SDK uses
process-global registries. They are not isolated per chat. Explicit resource
themes of other live sessions stay registered when a worker reloads or closes.

`WorkerUiPorts` requires the real Database, execution hostId, native clipboard /
paste / URL broker, authenticated `authorize`, and `submit` through the common
durable Dispatcher. Optional `admit` is a separate synchronous mutation fence;
read-only authenticated snapshots and attachments continue during maintenance.
Git branch comes from the execution host, never an unrelated attached desktop.
The runtime must await `shutdownPluginUi()` at process shutdown.

The transport API is available from `worker.ui()`:

- `attach(principal, {reset, frame, closed})` returns `{attachment, detach}`.
- `control(principal)`, `release(principal)`, `input(principal, command)`,
  `resize(principal, command)`, and `resync(principal)` use scoped controller
  leases, stream epochs, sequence numbers, and bounded VT queues.
- `snapshot(principal)` returns scope, canonical draft, surface state,
  attachment, pendingDraft, pendingSubmission and nativeScope. nativeScope is
  null for viewers; a current controller gets the exact authenticated principal,
  directory, host/session/epoch/surface scope for the native user-gesture broker.
- `replaceDraft`, `retrySubmission`, `retryDraft`, `resolveDraft` are explicit
  authenticated mutations. Lost admission ACK never invents a new command ID.

`SessionRegistry.setAdmission(false)` closes admission before the first await.
`activity()` returns opening/closing/busy/ui counts; `idle()` requires all zero.
Opening includes resources and staged session_start, busy includes prepare,
initialization, active SDK calls and UI command actions. UI includes active
custom factories, native RPCs and editor admission; a saved uncertain draft is
visible state rather than an indefinitely running operation. Pending permission
and question counts must additionally come from InteractionBroker.

Compatibility boundaries verify exact 0.85.1 package and source hashes before
using upstream non-root exports for explicit extension and Theme loading. They
do not patch/fork SDK sources. Inline Enki gate/policy initialization failure is
fatal; optional user-extension file errors remain diagnostics.

The private guarded qualification receipt is
`.local/pi-sdk-migration-20261024/plugin-ui-qualification-harness/evidence/review-integration-seven/`:
14 real SDK/SQLite/worker/UI tests passed, zero unexpected owner/network attempts,
Node 24.22.1, no SDK source modification. A separate frozen 43-test component
proof predates integration. Failed intermediate receipts remain preserved.

Limits: this receipt does not prove native macOS/Windows UI permissions, React /
xterm routes, real model/provider calls, remote authentication, full app release,
or production ADC/bootstrap environment isolation. Those require the real host
integration. Do not run SDK tests outside the pre-import isolation guard. Any
source change after the recorded SHA inventory needs fresh qualification.
