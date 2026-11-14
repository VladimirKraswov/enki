# SearXNG in the Enki Hub CT

The private search instance runs in CT206 as a separate systemd service; it does
not replace the Hub listener or its 512 MiB memory limit.

- Endpoint: `http://192.168.31.223:8888/search?q=QUERY&format=json&language=all`
- Bind: `192.168.31.223:8888` only (Hub LAN), no WAN forwarding.
- Service: `searxng.service`, user `searxng`, `MemoryMax=300M`, enabled at boot.
- Install: `/opt/searxng`, config `/etc/searxng/settings.yml` (mode600), writable
  cache/log/data paths only.
- Version: `2026.11.14+a7128d5d` (tarball from SearXNG commit
  `a7128d5d1d5af2837a68fbeaaee9c3e8391aa9cf`); `version_frozen.py` avoids a git
  dependency.
- JSON is enabled; `contact_url` is set; the limiter is disabled for the trusted
  LAN instance.
- `web-search-plus` calls SearXNG first, then Brave (if a key exists), then
  Bing RSS/GitHub. The MCP bridge's checked `web-search-core.mjs` is **not**
  modified; the companion uses `web-search-plus-core.mjs`.
- Health: `GET /healthz` returns 200. Search quality depends on the upstream
  engines; DuckDuckGo currently returns CAPTCHA and is cooled down by SearXNG.
