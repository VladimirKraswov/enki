// Host platform detection for the WebView shell.
//
// Used only for presentation decisions that genuinely differ per desktop: window
// chrome insets (macOS draws overlay traffic lights, GTK/Windows draw a real title
// bar), the modifier-key label, and OS-specific help text. Never use it to gate a
// backend feature — that is what `AgentBackend.capabilities` is for.

export type DesktopPlatform = "macos" | "windows" | "linux" | "other";

/** Derived from the user agent: WebKitGTK, WKWebView and WebView2 all report it. */
export function detectPlatform(userAgent: string): DesktopPlatform {
  const ua = userAgent.toLowerCase();
  // `macintel`/`darwin` only appear in the deprecated `navigator.platform`.
  if (/mac os x|macintosh|macintel|darwin|iphone|ipad/.test(ua)) return "macos";
  if (/windows|win64|win32/.test(ua)) return "windows";
  // Android also contains "linux"; check it first so it is not treated as desktop.
  if (/android/.test(ua)) return "other";
  if (/linux|x11|ubuntu|cros/.test(ua)) return "linux";
  return "other";
}

let cached: DesktopPlatform | null = null;

export function platform(): DesktopPlatform {
  if (cached) return cached;
  const nav: Partial<Navigator> | undefined =
    typeof navigator === "undefined" ? undefined : navigator;
  const ua = typeof nav?.userAgent === "string" ? nav.userAgent : "";
  // `navigator.platform` is deprecated but still reported by WKWebView,
  // WebKitGTK and WebView2. It is the fallback that keeps the macOS window
  // chrome correct even if a future WebView ships a stripped user agent —
  // losing macOS detection would leave a dead gap where the traffic lights are.
  const legacy = typeof nav?.platform === "string" ? nav.platform : "";
  if (!ua && !legacy) return "other"; // nothing to go on; do not cache a guess
  const detected = detectPlatform(ua);
  cached = detected === "other" && legacy ? detectPlatform(legacy) : detected;
  return cached;
}

/** Test seam; production code never calls this. */
export function resetPlatformCache(): void {
  cached = null;
}

export function isNative(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * macOS puts the window controls inside the content area, so the shell reserves
 * space for them. GTK and Windows draw their own title bar above the content.
 */
export function hasOverlayWindowControls(p: DesktopPlatform = platform()): boolean {
  return p === "macos";
}

export function modKeyLabel(p: DesktopPlatform = platform()): string {
  return p === "macos" ? "⌘" : "Ctrl";
}
