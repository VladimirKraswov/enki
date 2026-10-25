/**
 * An ABSOLUTE http(s) link from Markdown that may be opened in the external
 * browser. Relative links (e.g. a project path such as `src/a.ts`) are not web
 * addresses: resolving them against a placeholder base used to open
 * `http://invalid.local/...` in the browser. They render as plain text.
 */
export function safeExternalUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname) return u.toString();
    return null;
  } catch {
    return null;
  }
}
