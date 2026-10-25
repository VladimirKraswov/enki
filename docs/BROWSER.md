## Chat access policy (0.2.49)

Desktop uses one per-chat selector for OpenCode and Pi. Full access allows agent
tools without approval, including file paths outside the project. OpenCode's
shared plugin propagates the actual root-chat policy to delegated sessions;
review roles and prompts remain intact. Pi persists the choice and starts its
own session process with the chosen policy; idle processes are replaced after a
change. Read-only and confirmation modes remain available.

Browser adapters derive file policy from the invoking session rather than model
arguments. Full and restricted official MCP connections are distinct; returning
to a restricted policy does not reuse a full-access connection. Session ownership,
viewport freshness and browser interaction mode guards remain in effect.
Filesystem access still depends on the operating-system account's permissions.
The shared plugin is registered independently of browser installation. An already
cached OpenCode project is refreshed only while its scoped sessions are idle;
other projects and the external engine process are not restarted.

# In-app browser in Enki 0.2.25

Desktop owns installation and browser lifecycle. The independently installed OpenCode owns inference, sessions, permissions and its agent loop. Pi 0.85.1 uses a thin extension that exposes the same 32 official MCP tools plus four bounded Desktop adapters (keyboard input, observe, action and sequence); there is no second agent loop or copied browser implementation.

## Passive observation window (0.2.25)

The panel header has **Вынести браузер в окно наблюдения**. It moves the projection into a separate fixed 420×308 native window, above other windows, with the real page, agent cursor and busy/stale status. Drag its header to move it. Its image accepts no clicks, scrolling, typing or pasted content; resizing/maximizing is disabled. This is a local JPEG viewer, never a second Chromium instance or privileged remote webview. Detaching leaves the actual page viewport and tabs unchanged, including while an agent is running. Pending panel input/resize is discarded before detachment.

**Вернуть браузер в приложение** hides the viewer and restores the interactive panel. The panel can then reflow Chromium to its current size; normal fresh-frame/coordinate guards still apply. Settings with unsaved edits are retained: returning the browser does not close settings, and a notice asks you to return to the application. **Скрыть окно наблюдения**, an OS window close, or closing the panel only hides the projection; agent work continues. The existing **Браузер** button restores the panel later. Only **Остановить управление** stops browser management.

The secondary window does not start agent/control/scheduler loops. It has only the window-drag core permission; native window labels restrict its browser IPC to frame reads and restore/hide. Hidden viewers capture no frames; visible polling is serial with error backoff, and unavailable frames are explicitly marked stale. Switching to a remote computer or disabling browser support hides the viewer. Closing the main application exits and cleans up its owned children even if the viewer was open. macOS live acceptance and Windows/Linux limitations are recorded in [VERIFICATION](VERIFICATION.md).

## Manual scrolling and recovery

Manual scrolling in the interactive panel immediately drops queued input and locks page input with **Обновляю после прокрутки…** until newer pixels are decoded. The daemon increments the panel frame revision for a manual wheel as well as invalidating each agent's observation. Old manual XY clicks are refused; the next stale agent XY action receives a fresh screenshot and no click is sent/replayed. A pending composed action/sequence is interrupted on receipt of manual input, before it can execute further steps. Already completed actions are reported honestly; an in-flight action may have started before interruption. Agents can observe the new page and continue, with no automatic scroll reversal or replay. Continuous manual typing retains its existing revision so characters in a typing burst are not lost to this wheel-specific guard. Passive preview pixels cannot scroll the page at all.

## Startup and configuration

On a local Desktop connection, a detached bootstrap detects the separately installed OpenCode and Pi. Missing engines are skipped; their existing installation offers remain available. Checking/installing an engine again triggers browser setup. Remote SSH workspaces never rewrite local browser configuration or attach local tools.

The runtime installs pinned `@playwright/mcp` 0.0.83, its lockfile dependencies and Chromium into app-owned data. `npm ci --ignore-scripts` verifies lockfile integrity, then the explicit Playwright installer downloads Chromium. Node.js 20+ and npm are required. Node can be discovered or selected by absolute path in Settings → Browser; engine paths remain separately configurable. One rule applies everywhere: the browser's Node.js path, else Pi's Node.js path, else discovery. Discovery checks only fixed absolute locations (user shims, Homebrew/system, then nvm/fnm/mise/asdf version directories, newest first; on Windows Program Files, `NVM_SYMLINK`, per-user and Scoop installs) and takes the first interpreter that actually reports version 20 or newer, so an old system Node no longer hides a newer one. PATH and the working directory never choose it. Linux needs the normal Chromium system libraries; setup does not invoke sudo or modify the host automatically.

Desktop-owned scripts (`daemon.mjs`, `proxy.mjs`, `setup.mjs`, the skill and the Pi extension) are validated separately from dependencies. When a newer Desktop only changes those scripts, they are replaced atomically in place under the lifecycle lock, without another `npm ci` or Chromium download. A changed `package.json`/`package-lock.json` still requires a full verified installation in a fresh staging directory. Staging directories left by an interrupted installation are removed by the next installation.

Only the reserved `mcp.desktop_browser` entry and the browser skill path are added to OpenCode's global JSONC configuration. Comments, providers, models, plugins, unrelated MCP servers, and permission rules are retained. Writes compare the previously read content and create a backup. A conflicting reserved name is refused. An entry that this app wrote from another install location (same executable name, the private `--browser-mcp` flag, an absolute path) is recognised as its own and updated to the current executable, so moving or reinstalling the app does not strand the integration; drive-letter paths compare the name without case. Disabling browser control stops the service first and then disables only this app's own entry; a foreign entry with the reserved name is left untouched. The running local server receives a directory-scoped `/mcp` attachment and must confirm actual connection. It is not killed or restarted. The skill is discovered when OpenCode reloads its configuration normally.

Pi receives `--extension` only for real, enabled Desktop sessions, and only after the runtime is installed. Metadata probes never start a browser proxy. Tool discovery runs in the background with bounded timeouts. Native sessions keep their existing approval gate; full access applies only if the owner selected it explicitly. Pi's existing model/credential settings are not rewritten. Reopen an already running Pi session to load newly installed tools.

## Panel and profile

The top bar's Browser button and Settings → Browser open a live Browser panel inside Desktop. Agent navigation also reveals it once; hiding the panel does not stop a task. Chromium runs headless in its own app-owned process: no external Chrome window or extension is opened. The panel projects actual JPEG viewport frames (up to 1920×1200, up to 4 frames/second), with tabs, address, back/forward/reload, clicking, plain text/paste, scrolling and basic navigation keys. This is a pixel projection, not a remote-HTML webview or video stream. In fast mode agent tools retain the actual DOM/accessibility tree, evaluation and screenshots through official Playwright MCP. Human mode enforces mouse and keyboard actions as described below. A cursor indicates the true element bounding-box center or supplied coordinates for pointer actions, not an invented animation for DOM-only operations. Dragging, native Chromium menus, clipboard copy from a page and full IME composition in the projection are not implemented. Use the corresponding agent tools for richer interaction in the selected mode.

Each engine/session/project identity owns a persistent browser profile. The selected chat controls only the projected page; background agents keep their own tabs. A chat without a browser shows no panel or observation window. Ordinary browsers are unaffected; logins in each profile survive restarts. The former shared profile is retained for legacy CLI clients and is never silently copied into new chats; sign in again in a new profile if needed. No special password-field restriction is imposed: official browser tools can fill fields under the agent's normal permissions and the user's task authorization. This is not an OS credential vault or a new password manager.

Remote HTML never enters the privileged Tauri WebView: it receives only pixels and plain-text metadata, not page scripts. Chromium's sandbox stays enabled. There is no publicly exposed CDP or LAN listener. A private authenticated loopback gateway and stdio MCP proxy connect engines to Microsoft's unmodified Playwright implementation. Native browser commands accept only Desktop's main window; panel input uses a bounded action allowlist, not arbitrary JavaScript. Frames use the same bearer/Host/Origin checks as tools. Gateway credentials are not put into URLs, React state or logs. Frame captures are coalesced and do not queue behind long agent actions. Hidden panels do not capture screenshots; an open panel also stops fetching frames while the Desktop window is hidden or a native file chooser is open, and backs off (up to 2 s) while the service fails. Lightweight presence polling does not spawn Node probes. Manual input runs strictly in order and is never replayed; typing or scrolling that has not started yet is merged into one action for the same page state, the waiting backlog is bounded, and text over the native 16 KB limit is refused with an explanation. Queued manual input with an old page identity/URL/agent revision is rejected, not replayed. The address field is not overwritten while the user edits it (Escape restores the real URL). Shift+Tab leaves the page projection so keyboard focus is never trapped; IME composition keys are not forwarded. The first native local prompt waits for directory-scoped MCP attachment; remote prompts never attach local tools.

Calls are serialized within each session. Independent session contexts have separate queues, so a long tool in one chat does not block another chat. Each session has its own context, and each project connection keeps its own official MCP file roots. Uploads outside that connection's project roots are rejected by Playwright MCP. Snapshots, clicks, forms, tabs, uploads, downloads, screenshots and PDF capabilities come from official tools. Default outputs go into a private per-session/project subdirectory of the managed browser workspace. Official MCP also permits that connection's own output directory for file operations. The bounded cache supports 32 session identities and 32 workspace connections per identity per service lifetime; restart the browser to release older connections. In 2.0 the browser extension loaded by the bundled Enki Runtime (`resources/browser/pi-extension.ts`, scope tag `pi`) passes the invoking session identity independently of the selected UI chat; the native selection still accepts the `opencode` tag only so existing 0.2.x scopes keep resolving. The 0.2.x OpenCode before-tool plugin is no longer loaded by Enki; no owner task is replayed. Unscoped legacy calls remain in the old profile and are not projected into a chat. Manual input includes the viewed session key and is refused if selection changed. Agents still reinspect after user input or interruption.

Stopping browser control disables automatic setup and stops the owned service; the checkbox can reenable it. Stop also cancels an installation or start that is queued or already running: native install/start no longer hold the owner lock while they wait, and they check a stop generation at every polling step and terminate only their own child tree. Exiting Desktop cancels them the same way, waits a bounded time for them to clean up, then closes its own browser tree; external OpenCode/Pi CLI processes are never touched. Unix uses owned process groups; Windows uses a kill-on-close Job Object for the daemon/browser and installer. The daemon additionally watches a private owner pipe (opt-in through `OCDESKTOP_BROWSER_OWNER_PIPE`, so manual smoke runs are unaffected): if Desktop crashes, the pipe closes and the daemon shuts the browser down instead of becoming an unowned orphan. A start counts as ready only when a daemon started after that point answers (a new instance identifier), never because an older readiness record is still present. Browser profiles and downloaded runtime survive shutdown. Disabling tools doesn't delete the profile.

## Paths and troubleshooting

macOS: `~/.local/share/enki/browser-runtime`.
Linux: existing app data directory or absolute `XDG_DATA_HOME/opencode-desktop`.
Windows: `%USERPROFILE%/.opencode-desktop/browser-runtime` (0.2.18).
This deliberately avoids per-process MSIX AppData redirection. Desktop and an
independently running engine use the same readiness record, runtime and profile.
The MCP executable is an exact, versioned copy of Desktop under
`browser-runtime/bridge/<version>/enki.exe`, also outside AppData,
so the engine cannot accidentally launch a shadowed older Desktop binary.
Normal Desktop installation imports its own legacy AppData browser profile,
packages and Chromium cache by copying, not moving/deleting them. Completed
shared profiles are never overwritten or merged with another legacy view.
Migration checks cancellation and publishes only after the copy completes;
an interruption during publication can leave a preserved profile and cause a
fresh package installation on retry. No existing chat directories are moved.

`current` holds pinned tooling, `skills/desktop-browser/SKILL.md`, and the Pi extension; `browsers` holds Chromium; `profile` holds browser state; `workspace` holds outputs. The ready record is private and short-lived. Do not copy live authentication records into reports or Git.

Settings shows the actual installation, service, OpenCode and Pi state. The proxy reads and verifies the private readiness record before each request, so an existing MCP connection can follow a browser-service restart. A request is retried once, after waiting up to five seconds for a fresh record, only when it provably never reached the daemon (connection refused, or 403 because the token had rotated); a sent tool call is never repeated. Timeouts and interrupted connections are reported as such and ask the agent to inspect the page before retrying. The `--browser-mcp` shim waits up to ten seconds for a daemon that is still starting. While Desktop/browser is stopped, calls fail closed. A background setup that is superseded without a successor (for example by switching to an SSH host) settles back to idle instead of showing a permanent "installing"; the toolbar button retries a failed setup from scratch and explains why it is disabled. Changing engine paths or rechecking Pi reruns setup without re-adding an already confirmed OpenCode MCP attachment, so another session's in-flight browser call is not interrupted; reconnecting and "Configure and check" still re-verify it. Use Configure and check after an engine-side MCP disconnection. A failed setup is not labelled ready. Browser startup/install are bounded and idempotent; closing Desktop cancels its active installer/startup and terminates only owned child processes; configuration changes don't silently enable global permissions. Windows 0.2.16 compiled unchanged and passed the real headed test-owned browser smoke and packaged settings checks according to the supplied report/logs. Packaged toolbar opening, stop/re-enable and Pi chat remain unverified there; Linux acceptance is pending. See `WINDOWS-RESULT-0.2.16-20261005.md`.

## Interaction modes and responsive coordinates

Select **Быстрый / Эмуляция** in the compact browser toolbar, or **Режим работы**
in Settings → Browser. OpenCode and Pi share the managed runtime and mode policy; each agent session has an independent browser context.
The mode is persisted and applied before startup tool attachment. A live mode
change is serialized with other actions and does not restart a healthy MCP.

- **Fast**: semantic snapshot references, direct navigation and form tools are
  preferred. Evaluation remains available under the agent's normal permissions.
- **Human**: page clicks and dragging use real Playwright mouse input in CSS
  viewport coordinates, scrolling uses the wheel, and typing uses the keyboard.
  DOM click/fill/select/hover/drag, target-based typing and evaluation/run-code
  tools are refused by a runtime allowlist, rather than merely discouraged in a
  prompt. Navigation/tab controls, observations, dialogs and authorized uploads
  remain available. `browser_keyboard_type` pastes up to 16 KiB into the field
  already focused by a mouse click; it never finds/focuses an element by selector.

Both modes retain existing agent approvals and file-root restrictions. Human
mode controls these browser tools, not unrelated terminal tools or the host OS.
Passwords can be entered within the user's task authorization in either mode;
there is no new credential vault or automatic grant of permissions.

The toolbar has compact scrollable tabs, navigation, a centered address field,
mode selection and expand/collapse. At narrow widths controls wrap without
hiding mode or navigation. The footer shows real operation status and viewport
size. Closing the panel preserves the browser/task.

`ResizeObserver` measures the available panel surface and debounces window,
panel and zoom changes for 200 ms. Chromium's **actual viewport** is reflowed,
with bounded dimensions (320..1920 × 240..1200). Waiting old panel input is
cleared and manual actions stay disabled until a frame matching the requested
size arrives. Pixel clicks use the dimensions/revision of the image that has
actually decoded, not a newer image still loading.

Before agent XY actions, take `browser_take_screenshot` with `scale="css"`,
`fullPage=false` and no element target. The bridge records that observation per
client and associates it with page identity, URL, viewport and action revision.
Resize, navigation, scroll, changed tab and shared manual input invalidate it.
Full-page/device-scale/element images cannot authorize viewport-coordinate
input. Points outside the current viewport are rejected as well.

A stale or disallowed action is refused **before mouse input**. Its MCP result
contains a fresh CSS screenshot, current dimensions/mode and an explicit
recovery reason. Pi preserves that recovery image/guidance in the tool result.
The agent can choose a new target immediately; the bridge never replays a click.
It cannot infer the user's intent or guarantee targets on a spontaneously
animating page: inspect/verify important results. Ordinary interrupted tools
may have partially executed and are never treated as safe to replay.

Frame captures raced by navigation/resize are discarded and refreshed once
(read-only). Frames never combine old pixels with a newer page revision. Tool
results contain only small mode/viewport metadata in addition to normal MCP
content; no secrets are added to runtime logs or React state.

## Reproducible smoke

After preparing a test-owned runtime, transport-only regressions can run with
`node src-tauri/resources/browser/test/proxy.mjs /absolute/test-runtime/current`.
They use a disposable HTTP gateway and the real MCP SDK/proxy, with no model
requests or user browser profile. The Chromium smoke additionally verifies the
daemon's owner-pipe shutdown and persistence after another restart.

Prepare a test-owned `/tmp/oc-browser-*` root with the installed runtime under `current` and Chromium under `browsers`, then run its fixture from the repository:

```
node src-tauri/resources/browser/test/smoke.mjs /tmp/oc-browser-test-runtime
```

Use the script's actual invocation/arguments documented in its header. It owns a temporary profile/fixture/children, never uses real credentials and never requests model inference. Acceptance checks cover auth/Origin rejection, lazy headless startup, navigation/snapshot, form/password filling, project file upload and rejection outside roots, screenshots, persisted browser state, live frames, DOM-derived cursor, panel text input, shared tabs and history.

Primary implementation: https://github.com/microsoft/playwright-mcp
OpenCode MCP configuration: https://opencode.ai/docs/mcp-servers/

## System performance profiles (0.2.22)

Settings → Browser → Speed and diagnostics creates a separate projectless
browser chat, with a new working directory and no imported transcript. Its initial
Low (or chosen Medium) effort is a real per-chat model variant, applied only when
advertised by OpenCode or supported by Pi. Existing coding chats, global provider
options, permissions, inference runtimes and skills are unchanged. The composer
can explicitly enable the profile on an idle chat. Manual effort selection wins;
no silent adaptive escalation or "hidden thinking" is used. Pi levels follow its
reasoning flag and explicit thinkingLevelMap for xhigh/max; native Pi confirms the
selected level before a prompt. For complex navigation or recovery select Medium.
Turning a profile off restores its former effort only if model and auto-applied
effort still match, preserving a later manual choice.

All 32 official tools remain available. Prefer `browser_observe` for a compact
6000-character snapshot; maxChars accepts integers 256–20000 and truncation is marked. CSS viewport screenshots remain required for coordinate input.
`browser_action` joins an approved action, optional text/textGone wait and a fresh
observation into one agent tool call. `browser_sequence` joins at most six known
steps. `step` and each `arguments` value must be objects; `steps` must be an
array, not a string containing code/JSON. Invalid compositions return a safe
`reason: arguments` result before any input, with a field and expected shape. Arguments for every step are validated against the official schemas before
the first input; schemas are not duplicated in the model's tool inventory. Allowed
steps are semantic click/type/fill/select in fast mode, or mouse/keyboard/wheel
input. Arbitrary code, navigation, uploads and dialog approval are excluded from
compositions and retain their ordinary tools and approvals. Human mode still
blocks semantic/code actions. Between XY clicks a fresh screenshot is necessary;
a sequence cannot grant itself permission to use stale coordinates.

A sequence stops before further input on tab/navigation (including same-URL
reload), viewport/mode change, another caller in the same session or manual intervention. Each session queue
serializes its own browser writes; a different chat cannot interrupt it. A 1–30 second deadline and caller abort
bound compositions; waits are cancelled on intervention. Partial results include
completed/total steps, stop reason and uncertainty for the last action. A failed
or cancelled mutation is never automatically replayed. Guard rejection returns a
fresh CSS screenshot; after a deadline/interruption explicitly observe again.
The whole gateway tool call, including queue/setup, has a 45-second deadline
so a controlled result can arrive before the engine's standard 60s MCP timeout.
Initial snapshot/tab synchronization receives cancellation and a 10-second SDK
limit. A queued cancelled request sends no input. When a backend mutation is
already delivered, cancellation cannot undo it: the gateway retains that
session's execution barrier until the call settles, reports uncertainty and
never replays it. Other sessions remain independent. Error results preserve a
bounded underlying tool diagnostic instead of only returning a new snapshot.
Numeric failure metrics retain outer timeout failures even if the backend later
finishes successfully.

Use current network request indexes after a context restart. Optional output
filenames stay within approved workspace/output roots; omit the filename to
return text. These restrictions are not broadened to work around errors.

`test/recovery.mjs` in the browser resources exercises real SDK + test-owned
Chromium contexts: small observations, value-free invalid-argument results,
independent queues, a 50-second backend call/45-second controlled deadline,
retained same-session barrier and no input replay. Run it with a prepared
temporary runtime and the read-only managed Chromium binary directory; never
against owner profiles. Mac was exercised; Windows/Linux acceptance is separate.

Action success alone is not proof that the user's full task succeeded.

Diagnostics show numeric queue/action+wait/observation totals for the current
shared-service lifetime, plus available timings/tokens from the already loaded
current chat turn. Tool/think intervals are unioned, not double counted. No session
history searches, URL/argument/password telemetry or persistent trace files.
Unknown/completing measurements display a dash. Model queue/prefill are not
separately measurable through the present engine API. Idle visible-panel captures
are limited to 2/s; active agent work remains 4/s and hidden panels stop captures.

These mechanisms reduce required model round trips; they do not establish an
end-to-end speedup or unchanged reasoning quality. Those need a later paired
user-task evaluation, which was deliberately not run against external sessions.
