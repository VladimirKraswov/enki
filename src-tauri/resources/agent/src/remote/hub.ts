// Direct, pinned LAN transport for the Remote relay. It reads only the public
// Hub connection descriptor (endpoint, public certificate, label); credentials
// are not used by this no-auth LAN endpoint. No native bridge is involved, so a
// stalled updater or desktop command cannot stop session synchronization.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import type { Runtime } from "../core/runtime.ts";

type HubConfig = { enabled: boolean; endpoint: string; certificate: string; label: string };
export type HubRequest = (route: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
const HUB_PLATFORM: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };
export function hubPlatform(value: string = process.platform): string { return HUB_PLATFORM[value] ?? value; }
let cachedNativeVersion: string | null = null;
function nativeVersion(fallback: string): string {
  if (cachedNativeVersion) return cachedNativeVersion;
  try {
    const plist = path.resolve(path.dirname(process.execPath), "../../../..", "Info.plist");
    const stat = fs.lstatSync(plist);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024) {
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(plist, "utf8"));
      if (match?.[1] && /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/.test(match[1])) cachedNativeVersion = match[1];
    }
  } catch { /* non-bundle runtime */ }
  return cachedNativeVersion ?? fallback;
}

function descriptor(runtime: Runtime): HubConfig | null {
  const candidates = [
    path.join(path.dirname(runtime.config.dataDir), "capabilities", "hub", "connection.json"),
    path.join(runtime.config.dataDir, "capabilities", "hub", "connection.json"),
  ];
  for (const file of candidates) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HubConfig>;
      if (value.enabled !== true || typeof value.endpoint !== "string" || typeof value.certificate !== "string"
        || typeof value.label !== "string") continue;
      const url = new URL(value.endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) continue;
      return { enabled: true, endpoint: value.endpoint.replace(/\/+$/, ""), certificate: value.certificate,
        label: value.label.slice(0, 80) };
    } catch { /* next candidate */ }
  }
  return null;
}

function direct(config: HubConfig): HubRequest {
  const url = new URL(config.endpoint);
  return (route, body, signal) => new Promise((resolve, reject) => {
    if (route === "remote/sync" && body && typeof body === "object" && "overview" in body
      && body.overview && typeof body.overview === "object") {
      const overview = body.overview as Record<string, unknown>;
      body = { ...body, overview: { ...overview, version: nativeVersion(String(overview.version ?? "")) } };
    }
    const raw = JSON.stringify(body);
    const request = https.request({
      hostname: url.hostname, port: url.port || 443, path: "/api/" + route, method: "POST",
      ca: config.certificate, rejectUnauthorized: true, timeout: 15_000,
      headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw),
        "X-Enki-Device-Name": config.label, "X-Enki-Platform": hubPlatform(),
      },
    }, response => {
      const parts: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { request.destroy(new Error("Hub response too large")); return; }
        parts.push(chunk);
      });
      response.on("end", () => {
        if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
        let value: unknown = {};
        try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return reject(new Error("Hub returned invalid JSON")); }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          const error = value && typeof value === "object" && "error" in value ? String(value.error) : `HTTP ${response.statusCode}`;
          return reject(new Error(error));
        }
        resolve(value);
      });
    });
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    request.on("timeout", () => request.destroy(new Error("Hub request timeout")));
    request.on("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.end(raw);
  });
}

/** Direct transport when a valid public descriptor exists; otherwise the
 * existing native broker contract (used by injected test runtimes). */
export function hubRequest(runtime: Runtime): HubRequest {
  const config = descriptor(runtime);
  if (config) return direct(config);
  let pendingScope: Promise<string | null> | null = null;
  const identity = () => pendingScope ??= runtime.config.broker.call<{ scope: string | null }>("hub.identity", {}, AbortSignal.timeout(5_000), 5_000)
    .then(value => { if (!value.scope) pendingScope = null; return value.scope; }, error => { pendingScope = null; throw error; });
  return async (route, body, signal) => {
    const found = await identity();
    if (!found) throw new Error("Hub is not connected");
    return runtime.config.broker.call("hub.request", { path: route, scope: found, body }, signal, 15_000);
  };
}
