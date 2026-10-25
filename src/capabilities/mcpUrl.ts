/** Remote MCP URLs: HTTPS, or HTTP to loopback only; never credentials or fragments. */
export function remoteMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username && !url.password && !url.hash && (url.protocol === "https:" || (local && url.protocol === "http:"));
  } catch { return false; }
}
