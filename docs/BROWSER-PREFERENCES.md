# Browser profile customization

Packaged, published through Hub and installed on macOS in 0.2.57.
See [release acceptance](RELEASE-0.2.57.md).
Settings → Browser → Profile and privacy applies to every Enki chat (in 0.2.x it was shared by OpenCode and Pi). The existing
fast / human interaction selector remains independent of the environment profile.

Three editable presets are available: standard (the existing embedded Chromium),
compatibility (installed Chrome, ordinary window, reduced automation markers and
150 ms additional action pacing), and private (fresh temporary profile, DNT,
restricted direct WebRTC UDP, blocked Service Workers). Selecting/resetting a
preset edits the form; Save applies it. Browser choice does not touch a personal
Chrome profile. Persistent data remains separated by chat and browser engine.

Options include language, timezone, site theme/reduced motion, persistent or
temporary storage, optional automation-marker reduction, Service Workers, DNT and
WebRTC UDP policy. Pacing is a bounded additional pause before agent actions;
observations and manual input do not wait. Stale-frame/mode/permission checks stay
in place after the pause. Emulation still restricts agents to mouse/keyboard tools.

Native Desktop accepts only a bounded settings envelope from its main window.
The daemon validates keys, enums, types, language/timezone and the 0–1000 ms delay.
No arbitrary launch arguments, executable paths, credentials or scripts are
accepted. Valid configuration is atomically replaced with mode 0600. Startup
injects the saved app preferences before attaching shared tools. New contexts
capture a settings snapshot; saving leaves all open contexts and queues intact.
The UI reports how many open browsers still use older settings. To change those,
restart browser management when their work can be interrupted. Hiding a panel or
closing one tab does not close its browser context.

Temporary profiles are removed and cleanup is awaited during normal service
shutdown. Forced OS termination can leave temporary files; this is not secure
erasure. Temporary storage does not delete agent chat history or change Hub
history collection. Persistent profiles are preserved when returning from a
temporary profile. Browser sandboxing, HTTPS validation, workspace permissions,
session isolation and the private authenticated loopback transport remain enabled.
Camera, microphone, location and notification permissions are not auto-granted.

Automation-marker reduction presents the managed browser as an ordinary Chrome
profile for a normal user. It hides the `navigator.webdriver` automation feature
and banner; replaces the service `HeadlessChrome` token with the version actually
read from the launched executable in both `User-Agent` and the Sec-CH-UA client
hints (brand list, platform, full version); enables real Metal GPU rendering and
native display scaling on macOS; and, before any site script runs, adds the
ordinary `window.chrome` object, standard PDF plugins/MimeTypes and plausible
screen/outer-window metrics to the hidden embedded surface. The replacement UA
version is only taken from `--version` of the executable that will really run
(cached per runtime); an unparseable result keeps the stock identity. Client
hints are re-asserted per page over one attached CDP session because Chromium
reverts emulation when the client detaches. This reduction does not fake IP or
geolocation, does not modify the OS itself and is not a guarantee: advanced bot
detectors can still observe the CDP Runtime/Console activity the agent needs to
drive the page, and the first request of a site-opened popup can race the hint
re-application. Chromium's native implementation is visible in
[Navigator source](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/frame/navigator.cc).
Installed Chrome and ordinary windows are supported launch options; compatibility
with a particular Chrome version/site still depends on that browser and site.
See the [Playwright launch/context API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).
No CAPTCHA solving, login workaround or access restriction bypass is added.
DNT requests cooperation from a site; it is not a tracker blocker. WebRTC policy
may affect calls, and blocking Service Workers may affect offline applications.

## Acceptance

- Frontend: 839 tests passed, 6 existing skips; production TypeScript/Vite build,
  architecture dependency checks and bundle budgets passed.
- Native: 123 tests passed, 3 existing opt-in skips; strict all-target Clippy passed.
- Isolated real Chromium and installed Chrome (headless): retained open context,
  rejected arbitrary settings without changing the saved configuration, actual
  language/timezone/media/DNT, native webdriver marker reduction, blocked worker
  registration with an allowed-worker control, paced real keyboard input,
  temporary-profile cleanup/non-reuse, persistent-profile recovery and preference
  reload across daemon restart passed. No owner profiles or model calls used.
- Actual Chromium rendering: presets, save, invalid locale, reset and no horizontal
  overflow at 390 and 1100 px passed; fixture IPC never reaches owner services.
- Live headed/native-window acceptance, site-specific login/WAF behavior,
  end-to-end WebRTC ICE leak testing and Windows/Linux OS runs are not claimed.

## Automation-signal upgrade (0.2.65, repackaged in 0.2.66)

0.2.65 shipped the new `stealth.mjs` module without adding it to the embedded
Desktop script list that materializes the packaged browser runtime, so the
released daemon could not start its stealth import. 0.2.66 embeds the module and
adds a Rust regression that every relative import of the embedded daemon is
present in the shipped script list.

With the reduction enabled the hidden surface launches the full Chromium
binary in its new headless mode (the "chromium" channel) instead of the
stripped headless-shell build, so feature-presence probes see the same engine
an ordinary window uses; installed Chrome keeps its own channel.
Reduction now also normalizes the visible headless identity. The user-agent
carries only the reduced `Chrome/<major>.0.0.0` build token that desktop Chrome
itself sends since UA-Reduction; the full observed build version appears only
in Sec-CH-UA client hints (`fullVersionList`/`uaFullVersion`), and installed
Google Chrome adds its own brand. `navigator.userAgentData` is defined before
any site script runs (init script), so the brand list is correct from the
first synchronous read and does not wait for the CDP override that keeps the
request headers matching. The observed version is cached keyed by the exact
executable path plus its size and mtime, so a Chromium upgrade forces a fresh
read instead of an eternally stale UA. Real-runtime smoke showed
`navigator.webdriver=false`, the reduced ordinary User-Agent in both JS and
request headers, a matching Sec-CH-UA brand list (no `HeadlessChrome` brand),
full `uaFullVersion`, `macOS` platform hint, Metal WebGL renderer, 5 PDF
plugins with `PluginArray` presentation, `window.chrome`, screen 1512x982 with
a smaller available area, outer window larger than the viewport and 2x device
scaling; cache invalidation was verified by touching the executable. The head
`denied/denied` notification pair (a headless tell) now reports the ordinary
`default`/`prompt` desktop state.

The CDP surface itself was measured, not assumed: through the real daemon and
connected Playwright MCP client (navigate + snapshot + evaluate load), the
console Error-stack serialization traps that `Runtime.enable` would fire stay
false at first load and after the CDP machinery is exercised, no automation
globals (`__playwright__binding__`, cdc_*, driver, selenium) appear on the
page, and sixty consecutive driver evaluations produce no main-thread rAF
gaps. A guard test keeps the stealth and daemon sources free of
`Runtime/Console/Log/Page.enable`, console/pageerror subscriptions, route
interception and `exposeBinding`, which are exactly what turns those leaks on.
Detectors that profile the raw timing of heavy per-action evaluation can still
statistically notice a driver; Windows/Linux runs remain unclaimed.

Reproduce the opt-in daemon check using read-only dependencies/browser binaries
from an installed runtime; the runner creates and removes its own temporary root:

```sh
node src-tauri/resources/browser/test/preferences.mjs /absolute/runtime/current /absolute/browser-cache --chrome
```

Omit `--chrome` if Google Chrome is not installed. Rendering fixture:
`/test/fixtures/browser-settings.html` on a disposable Vite server. Neither test
requires inference or navigates to an external website.
