// Transport errors and endpoint validation shared by every loopback client.

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly filesystemDenied: boolean;
  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.filesystemDenied = /\b(?:EPERM|EACCES)\b/i.test(detail);
  }
}

export class ConnectionError extends Error {
  constructor(message = "Среда выполнения Enki недоступна") {
    super(message);
    this.name = "ConnectionError";
  }
}

/** Only loopback endpoints: native SSH forwards remote runtimes without broadening WebView network access. */
export function isAllowedBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    return false;
  const host = url.hostname.toLowerCase();
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "[::1]" &&
    host !== "::1"
  )
    return false;
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) === 0)) return false;
  return true;
}
