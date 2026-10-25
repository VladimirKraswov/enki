// Pure endpoint/error contracts of src/api/http.ts, ported from the retired
// OpenCodeClient suite (test/client.test.ts). isAllowedBaseUrl is the only gate
// between a stored/forwarded endpoint and the WebView's fetch: it must accept
// exactly plain-HTTP loopback origins and nothing that could smuggle a host,
// credential, path or scheme.
import { describe, expect, it } from "vitest";
import { ApiError, ConnectionError, isAllowedBaseUrl } from "../src/api/http";

describe("isAllowedBaseUrl", () => {
  it("accepts plain-HTTP IPv4, IPv6 and localhost loopback origins", () => {
    for (const url of [
      "http://127.0.0.1:4096",
      "http://127.0.0.1:4096/",
      "http://127.0.0.1",
      "http://localhost:3000",
      "http://LOCALHOST:3000",
      "http://[::1]:4096",
      "http://[0:0:0:0:0:0:0:1]:4096", // canonicalised by URL to [::1]
      "http://127.0.0.1:65535",
    ])
      expect(isAllowedBaseUrl(url), url).toBe(true);
  });

  it("rejects port 0, out-of-range and non-numeric ports", () => {
    for (const url of ["http://127.0.0.1:0", "http://[::1]:0", "http://127.0.0.1:65536", "http://127.0.0.1:99999", "http://127.0.0.1:12ab"])
      expect(isAllowedBaseUrl(url), url).toBe(false);
  });

  it("rejects non-loopback IPv4/IPv6 hosts and look-alike names", () => {
    for (const url of [
      "http://example.com",
      "http://10.0.0.5:4096",
      "http://0.0.0.0:4096",
      "http://127.0.0.2:4096",
      "http://192.168.1.10:4096",
      "http://[::]:4096",
      "http://[::2]:4096",
      "http://[fe80::1]:4096",
      "http://[::ffff:127.0.0.1]:4096",
      "http://localhost.:4096",
      "http://localhost.example.com:4096",
      "http://127.0.0.1.nip.io:4096",
    ])
      expect(isAllowedBaseUrl(url), url).toBe(false);
  });

  it("rejects HTTPS, file, WebSocket, data and javascript schemes even on loopback", () => {
    for (const url of [
      "https://127.0.0.1:4096",
      "https://localhost:4096",
      "file:///etc/passwd",
      "file://localhost/etc/passwd",
      "ws://127.0.0.1:4096",
      "data:text/plain,hi",
      "javascript:alert(1)",
    ])
      expect(isAllowedBaseUrl(url), url).toBe(false);
  });

  it("rejects userinfo in either direction, so no credential or host can be smuggled", () => {
    for (const url of [
      "http://user:secret@localhost:4096",
      "http://user@127.0.0.1:4096",
      "http://:secret@[::1]:4096",
      "http://127.0.0.1@evil.example:4096",
      "http://evil.example@127.0.0.1:4096",
    ])
      expect(isAllowedBaseUrl(url), url).toBe(false);
  });

  it("rejects paths, queries and fragments: an endpoint is an origin only", () => {
    for (const url of [
      "http://localhost:4096/other",
      "http://localhost:4096//",
      "http://localhost:4096/v1",
      "http://localhost:4096?x=1",
      "http://localhost:4096/?token=abc",
      "http://localhost:4096#frag",
      "http://localhost:4096/#frag",
    ])
      expect(isAllowedBaseUrl(url), url).toBe(false);
  });

  it("rejects malformed or empty input instead of throwing", () => {
    for (const url of ["", " ", "not a url", "127.0.0.1:4096", "//127.0.0.1:4096", "http://", "http://[::1:4096", "http://127.0.0.1:4096\u0000"])
      expect(() => isAllowedBaseUrl(url), JSON.stringify(url)).not.toThrow();
    for (const url of ["", " ", "not a url", "//127.0.0.1:4096", "http://", "http://[::1:4096"])
      expect(isAllowedBaseUrl(url), JSON.stringify(url)).toBe(false);
  });
});

describe("transport error classes", () => {
  it("ApiError keeps status/detail and flags only real filesystem denials", () => {
    const denied = new ApiError(403, "EACCES: permission denied, open '/x'");
    expect(denied).toBeInstanceOf(Error);
    expect(denied).not.toBeInstanceOf(ConnectionError);
    expect(denied).toMatchObject({ name: "ApiError", status: 403, filesystemDenied: true, message: "EACCES: permission denied, open '/x'" });
    expect(new ApiError(500, "operation not permitted (EPERM)").filesystemDenied).toBe(true);
    // Words that merely contain the code are not a denial.
    expect(new ApiError(500, "EPERMANENT failure").filesystemDenied).toBe(false);
    expect(new ApiError(400, "model not found").filesystemDenied).toBe(false);
  });

  it("an empty ApiError detail still yields a status message; ConnectionError is distinct", () => {
    expect(new ApiError(502, "").message).toBe("HTTP 502");
    const offline = new ConnectionError();
    expect(offline.name).toBe("ConnectionError");
    expect(offline).not.toBeInstanceOf(ApiError);
    expect(offline.message.length).toBeGreaterThan(0);
  });
});
