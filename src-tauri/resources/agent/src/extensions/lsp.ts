/**
 * Enki — language-server tools for the SDK runtime.
 *
 * Lives INSIDE the agent package (moved from resources/pi/lsp-extension.ts):
 * it value-imports `typebox`, which is declared and locked only by this
 * package. A sibling directory has no package boundary, so native Node (crash
 * children, *.node.ts suites) could not resolve it; the bundle only worked
 * through build.mjs nodePaths.
 *
 * Why this exists instead of an off-the-shelf extension: the reviewed candidate
 * (`samfoy/pi-lsp-extension` @ f2433d1) is ~8.4k lines, pulls in web-tree-sitter
 * and jiti, carries organisation-specific "Brazil workspace" logic, and — most
 * importantly — spawns a **detached daemon** per workspace that outlives the Pi
 * session and talks over a Unix socket it manages itself. This app promises that
 * no agent child outlives the window that started it, so a daemon it does not
 * own is the wrong shape. See docs/RUNTIME.md for the full audit.
 *
 * This file is deliberately small and auditable:
 *   - Language servers run as **direct children of the Enki Runtime** over
 *     stdio and are stopped on the session's `session_shutdown`; there is no
 *     daemon, no socket, no PID file. The runtime's process tree is owned by
 *     the native supervisor, so nothing outlives an explicit exit.
 *   - Server programs come only from the app-written config file the runtime
 *     passes explicitly. Project files never choose what gets executed.
 *   - Every program path must be absolute and exist. `PATH` is not consulted.
 *   - All waits are bounded, and a server that fails to start is reported, not
 *     retried in a loop.
 *
 * Tools registered: `lsp_diagnostics`, `lsp_hover`, `lsp_definition`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectToolEnvironment } from "../platform/environment.ts";

interface ServerConfig {
  id: string;
  /** Absolute path to the language-server program. */
  command: string;
  args?: string[];
  /** File extensions this server handles, e.g. [".ts", ".tsx"]. */
  extensions: string[];
  /** LSP languageId reported for opened documents. */
  languageId: string;
}

export interface LspConfig {
  servers: ServerConfig[];
}

const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const DIAGNOSTICS_WAIT_MS = 8_000;
const MAX_SERVERS = 4;
/** Largest single JSON-RPC frame accepted from a server (and buffered bytes). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function loadLspConfig(path: string | undefined): LspConfig {
  if (!path || !isAbsolute(path) || !existsSync(path)) return { servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LspConfig;
    const servers = (parsed.servers ?? []).filter(
      (s) =>
        s &&
        typeof s.command === "string" &&
        isAbsolute(s.command) &&
        existsSync(s.command) &&
        Array.isArray(s.extensions) &&
        s.extensions.length > 0,
    );
    return { servers: servers.slice(0, MAX_SERVERS) };
  } catch {
    return { servers: [] };
  }
}

/** Minimal LSP client over stdio: Content-Length framing, JSON-RPC 2.0. */
class LanguageServer {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private diagnostics = new Map<string, unknown[]>();
  /** Diagnostics waiters; an error means the server ended (never "no issues"). */
  private waiters = new Map<string, ((error?: Error) => void)[]>();
  /** Last document version sent per URI (didOpen = 1, then didChange). */
  private versions = new Map<string, number>();
  private ready: Promise<void> | null = null;
  private generation = 0;
  private rejectStart: ((error: Error) => void) | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly root: string,
    private readonly spawnServer: typeof spawn,
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    let started!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      this.rejectStart = reject;
    });
    // Publish before spawning: a synchronous spawn failure must not leave a
    // rejected promise cached as the readiness of every subsequent attempt.
    this.ready = ready;
    let child: ChildProcess;
    try {
      child = this.spawnServer(this.config.command, this.config.args ?? [], {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        // Project tooling: the host's original Pi/ADC variables, not the
        // bundled SDK profile overrides (platform/environment.ts).
        env: projectToolEnvironment(process.env),
      });
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      return ready;
    }
    this.child = child;
    const current = () => this.generation === generation && this.child === child;
    this.startTimer = setTimeout(() => {
      if (current()) this.stop(new Error(`${this.config.id}: сервер не инициализировался за 30 с`));
    }, START_TIMEOUT_MS);
    child.on("error", (error) => {
      if (current()) this.stop(error);
    });
    // Writing to a server that already died raises EPIPE on its stdin; the
    // exit handler settles every request, so the stream error is not fatal.
    child.stdin?.on("error", () => {});
    child.on("exit", (code) => {
      // exit can precede pipe closure. A stopped predecessor may report it
      // after a successor already has pending requests: never touch those.
      if (current()) this.stop(new Error(`${this.config.id}: сервер завершился (код ${code})`));
    });
    child.stdout?.on("data", (chunk: Buffer) => { if (current()) this.onData(chunk); });
    // Language servers are chatty on stderr; it is not part of the protocol.
    child.stderr?.resume();

    this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [
        { uri: pathToFileURL(this.root).href, name: "workspace" },
      ],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: { linkSupport: false },
        },
        workspace: { workspaceFolders: true },
      },
    })
      .then(() => {
        if (!current()) return;
        this.notify("initialized", {});
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.rejectStart = null;
        started();
      })
      .catch((error) => {
        if (current()) this.stop(error instanceof Error ? error : new Error(String(error)));
      });
    return ready;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator === -1) {
        // A header never terminated within the frame bound: protocol garbage.
        if (this.buffer.length > MAX_FRAME_BYTES) this.oversized();
        return;
      }
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) { this.oversized(); return; }
      const start = separator + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        /* a malformed frame must not kill the session */
      }
    }
  }

  /** A frame beyond MAX_FRAME_BYTES: fail its requests and stop this server (bounded memory). */
  private oversized(): void {
    this.stop(new Error(`${this.config.id}: сервер прислал слишком большой ответ; сервер остановлен`));
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id as number | undefined;
    if (typeof id === "number" && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error).slice(0, 400)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri: string; diagnostics: unknown[]; version?: number };
      // A late publish for an older version must not answer the newer check.
      const sent = this.versions.get(params.uri);
      if (typeof params.version === "number" && sent !== undefined && params.version < sent) return;
      this.diagnostics.set(params.uri, params.diagnostics ?? []);
      for (const waiter of this.waiters.get(params.uri) ?? []) waiter();
      this.waiters.delete(params.uri);
      return;
    }
    // Server-initiated requests we do not implement must still be answered,
    // otherwise some servers stall waiting for a reply.
    if (typeof id === "number" && typeof message.method === "string") {
      this.send({ jsonrpc: "2.0", id, result: null });
    }
  }

  private send(payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.child?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child?.stdin?.write(body);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error(`${this.config.id}: сервер остановлен`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.id}: ${method} не ответил за 20 с`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Sends the CURRENT file text. The first call opens the document; later calls
   * (e.g. after an edit) send a full-text didChange with the next version and
   * drop the cached diagnostics, so a check never reports the pre-edit state.
   */
  async openFile(path: string): Promise<string> {
    const uri = pathToFileURL(path).href;
    const text = readFileSync(path, "utf8");
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.diagnostics.delete(uri);
    if (version === 1) {
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.config.languageId, version, text } });
    } else {
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  /** Diagnostics are pushed, so wait (bounded) for the publish after the last send. */
  waitForDiagnostics(uri: string): Promise<unknown[]> {
    if (!this.child) return Promise.reject(new Error(`${this.config.id}: сервер остановлен`));
    if (this.diagnostics.has(uri)) return Promise.resolve(this.diagnostics.get(uri)!);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (error?: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (error) reject(error);
        else resolve(this.diagnostics.get(uri) ?? []);
      };
      const list = this.waiters.get(uri) ?? [];
      list.push(done);
      this.waiters.set(uri, list);
      timer = setTimeout(() => {
        const remaining = (this.waiters.get(uri) ?? []).filter((waiter) => waiter !== done);
        if (remaining.length) this.waiters.set(uri, remaining);
        else this.waiters.delete(uri);
        done();
      }, DIAGNOSTICS_WAIT_MS);
    });
  }

  stop(reason = new Error(`${this.config.id}: сервер остановлен`)): void {
    // Fence callbacks before rejecting promises: their continuations must not
    // stop a successor that a caller starts after observing this rejection.
    this.generation++;
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const rejectStart = this.rejectStart;
    this.rejectStart = null;
    rejectStart?.(reason);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    for (const list of this.waiters.values()) for (const waiter of list) waiter(reason);
    this.waiters.clear();
    this.versions.clear();
    this.diagnostics.clear();
    this.buffer = Buffer.alloc(0);
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    // SIGTERM first so the server can shut down its own helpers; SIGKILL only
    // if it is still alive shortly after.
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const force = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2000);
    // Do not hold the process open just to fire the fallback.
    force.unref?.();
    child.once("exit", () => clearTimeout(force));
  }
}

const SEVERITY = ["", "ошибка", "предупреждение", "информация", "подсказка"];

export function formatDiagnostics(path: string, diagnostics: unknown[]): string {
  if (!diagnostics.length) return `${path}: замечаний нет.`;
  return diagnostics
    .slice(0, 100)
    .map((raw) => {
      const d = raw as {
        range?: { start?: { line?: number; character?: number } };
        severity?: number;
        message?: string;
        source?: string;
        code?: unknown;
      };
      const line = (d.range?.start?.line ?? 0) + 1;
      const column = (d.range?.start?.character ?? 0) + 1;
      const severity = SEVERITY[d.severity ?? 1] || "ошибка";
      const code = d.code === undefined ? "" : ` [${String(d.code)}]`;
      return `${path}:${line}:${column} ${severity}${code}: ${d.message ?? ""}`;
    })
    .join("\n");
}

/** Per-session language servers; the runtime emits session_shutdown on close. */
export function attachLsp(pi: ExtensionAPI, config: LspConfig, spawnServer: typeof spawn = spawn): void {
  const servers = new Map<string, LanguageServer>();

  const stopAll = () => {
    for (const server of servers.values()) server.stop();
    servers.clear();
  };
  pi.on("session_shutdown", async () => stopAll());

  const serverFor = async (absolutePath: string, root: string) => {
    const extension = extname(absolutePath);
    const found = config.servers.find((s) => s.extensions.includes(extension));
    if (!found)
      throw new Error(
        `Для «${extension}» не настроен языковой сервер. Проверьте «Настройки → Агент → LSP».`,
      );
    let server = servers.get(found.id);
    if (!server) {
      server = new LanguageServer(found, root, spawnServer);
      servers.set(found.id, server);
    }
    await server.start();
    return server;
  };

  const resolveTarget = (raw: string, cwd: string) => {
    const cleaned = raw.replace(/^@/, "");
    const absolute = resolvePath(cwd, cleaned);
    if (!existsSync(absolute)) throw new Error(`Файл не найден: ${cleaned}`);
    return absolute;
  };

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP: замечания",
    description:
      "Compiler/linter diagnostics for one file from its language server. Use lsp_diagnostics after editing a file to check it still type-checks.",
    promptSnippet: "Language-server diagnostics for a file",
    parameters: Type.Object({
      path: Type.String({ description: "File path, relative to the project root" }),
    }),
    async execute(_id: string, params: { path: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const absolute = resolveTarget(params.path, ctx.cwd);
      const server = await serverFor(absolute, ctx.cwd);
      const uri = await server.openFile(absolute);
      const diagnostics = await server.waitForDiagnostics(uri);
      return {
        content: [{ type: "text", text: formatDiagnostics(params.path, diagnostics) }],
        details: { count: diagnostics.length },
      };
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP: тип и документация",
    description:
      "Type and documentation at a position, from the language server. Use lsp_hover to check an inferred type instead of guessing.",
    promptSnippet: "Type/doc at a position",
    parameters: Type.Object({
      path: Type.String(),
      line: Type.Number({ description: "1-based line" }),
      character: Type.Number({ description: "1-based column" }),
    }),
    async execute(_id: string, params: { path: string; line: number; character: number }, _s: unknown, _u: unknown, ctx: { cwd: string }) {
      const absolute = resolveTarget(params.path, ctx.cwd);
      const server = await serverFor(absolute, ctx.cwd);
      const uri = await server.openFile(absolute);
      const result = (await server.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: Math.max(0, params.line - 1), character: Math.max(0, params.character - 1) },
      })) as { contents?: unknown } | null;
      const contents = result?.contents;
      const text =
        typeof contents === "string"
          ? contents
          : Array.isArray(contents)
            ? contents.map((c) => (typeof c === "string" ? c : String((c as { value?: string }).value ?? ""))).join("\n")
            : String((contents as { value?: string } | undefined)?.value ?? "");
      return {
        content: [{ type: "text", text: text.trim() || "Нет сведений в этой позиции." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP: определение",
    description:
      "Where a symbol is defined, from the language server. Use lsp_definition instead of guessing a file path from a name.",
    promptSnippet: "Definition location of a symbol",
    parameters: Type.Object({
      path: Type.String(),
      line: Type.Number({ description: "1-based line" }),
      character: Type.Number({ description: "1-based column" }),
    }),
    async execute(_id: string, params: { path: string; line: number; character: number }, _s: unknown, _u: unknown, ctx: { cwd: string }) {
      const absolute = resolveTarget(params.path, ctx.cwd);
      const server = await serverFor(absolute, ctx.cwd);
      const uri = await server.openFile(absolute);
      const result = await server.request("textDocument/definition", {
        textDocument: { uri },
        position: { line: Math.max(0, params.line - 1), character: Math.max(0, params.character - 1) },
      });
      const locations = (Array.isArray(result) ? result : result ? [result] : []) as {
        uri?: string;
        range?: { start?: { line?: number; character?: number } };
      }[];
      const text = locations.length
        ? locations
            .slice(0, 20)
            .map((l) => `${locationPath(l.uri ?? "")}:${(l.range?.start?.line ?? 0) + 1}:${(l.range?.start?.character ?? 0) + 1}`)
            .join("\n")
        : "Определение не найдено.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

/** file:// URI → native path (Windows drive letters included); others verbatim. */
export function locationPath(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try { return fileURLToPath(uri); } catch { return decodeURIComponent(uri.replace("file://", "")); }
}
