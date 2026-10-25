// Interactive shells owned by the runtime, streamed over authenticated HTTP.
//
// Output is kept in a bounded ring with a byte cursor, so a client that
// reconnects (window reload, tab switch) resumes from where it stopped instead
// of losing output; shells keep running while no client is attached. Only
// shells created through this API exist here; nothing foreign is adopted.
// node-pty is a native module: if it cannot be loaded on this platform the
// capability is reported as unavailable rather than emulated.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectToolEnvironment } from "./environment.ts";

export interface NativePty {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtyModule { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): NativePty }

const RING = 1024 * 1024;

export interface PtyInfoDTO { id: string; title: string; cwd: string; status: "running" | "exited"; exitCode?: number; cursor: number }

interface Shell {
  info: PtyInfoDTO;
  pty: NativePty;
  buffer: string;
  start: number;
  listeners: Set<(chunk: { cursor: number; data: string }) => void>;
  exitListeners: Set<() => void>;
}

function shellProgram(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return { file: path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo"] };
  }
  const configured = process.env.SHELL;
  for (const candidate of [configured, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) return { file: candidate, args: ["-l"] };
  }
  return { file: "/bin/sh", args: [] };
}

/**
 * Synchronous maintenance view. Silence is not idleness: a running shell may be
 * executing a long command without output.
 *
 * Closing an owned shell is honest about what node-pty can prove: kill() is
 * sent once, and `onExit` proves only that the PRIMARY process ended. Shell
 * descendants that ignore SIGHUP (nohup, disowned jobs) may survive and there
 * is no owned process-tree backend yet, so a closed shell never becomes
 * "cleaned up" or idle by itself:
 *   closing          kill sent, bounded wait (CLOSE_DEADLINE) for the primary;
 *   cleanup-unknown  primary exit observed, or the deadline/kill failed —
 *                    descendants unverifiable.
 * Both stay owned activity (block automatic maintenance) until the user
 * explicitly detaches, which relinquishes ownership and proves nothing. No
 * stored PID/PGID is ever signalled again (it may be reaped and reused).
 */
export interface PtyActivity {
  /** Live shells that were not explicitly closed. */
  running: number;
  /** create() between admission and a spawned (or refused) process. */
  starting: number;
  /** Closed by Enki, cleanup not confirmed: closing + cleanupUnknown. */
  unconfirmed: number;
  closing: number;
  cleanupUnknown: number;
}
export type PtyCloseState = "closing" | "cleanup-unknown";
export interface PtyClosingDTO {
  id: string; title: string; cwd: string; state: PtyCloseState; since: number;
  /** The primary shell's exit was observed (descendants are still unverified). */
  primaryExited: boolean; exitCode?: number; detail: string;
}
interface Closing { shell: Shell; state: PtyCloseState; since: number; primaryExited: boolean; detail: string; timer?: ReturnType<typeof setTimeout> }

export const CLOSE_DEADLINE = 5_000;
const UNKNOWN_DETAIL = "Оболочка завершена, но фоновые процессы, запущенные в ней, могли остаться. Enki не может это проверить; закройте их сами при необходимости и нажмите «Отсоединить».";

export class PtyService {
  private module: PtyModule | null | undefined;
  private shells = new Map<string, Shell>();
  private readonly closing = new Map<string, Closing>();
  private starting = 0;
  private admitting = true;

  /** `loader` replaces the node-pty import (tests use an in-memory module). */
  constructor(private readonly loader?: () => Promise<PtyModule | null>, private readonly closeDeadline = CLOSE_DEADLINE) {}

  /** Same synchronous fence as the rest of the runtime: no new shell after it. */
  setAdmission(allowed: boolean): void { this.admitting = allowed; }

  activity(): PtyActivity {
    let running = 0, closing = 0, cleanupUnknown = 0;
    for (const shell of this.shells.values()) if (shell.info.status !== "exited") running++;
    for (const record of this.closing.values()) if (record.state === "closing") closing++; else cleanupUnknown++;
    return { running, starting: this.starting, unconfirmed: closing + cleanupUnknown, closing, cleanupUnknown };
  }

  /** Shells Enki closed whose cleanup is not confirmed: actionable status for the UI. */
  closingList(directory: string): PtyClosingDTO[] {
    return [...this.closing.entries()].filter(([, r]) => r.shell.info.cwd === directory).map(([id, r]) => ({
      id, title: r.shell.info.title, cwd: r.shell.info.cwd, state: r.state, since: r.since, primaryExited: r.primaryExited,
      ...(r.shell.info.exitCode !== undefined ? { exitCode: r.shell.info.exitCode } : {}), detail: r.detail,
    }));
  }

  /**
   * Explicit user decision: Enki stops tracking this closed shell. Nothing is
   * signalled (a stored PID may already be reaped and reused); the result says
   * that cleanup is unknown, never that it happened.
   */
  detach(id: string, directory: string): { id: string; detached: true; cleanup: "unknown"; primaryExited: boolean } {
    const record = this.closing.get(id);
    if (!record || record.shell.info.cwd !== directory) throw new Error("Закрываемый терминал не найден.");
    if (record.timer) clearTimeout(record.timer);
    this.closing.delete(id);
    return { id, detached: true, cleanup: "unknown", primaryExited: record.primaryExited };
  }

  private async load(): Promise<PtyModule | null> {
    if (this.module !== undefined) return this.module;
    if (this.loader) {
      try { this.module = await this.loader(); } catch { this.module = null; }
      return this.module;
    }
    try {
      const loaded: unknown = await import("node-pty");
      const candidate = (loaded as { spawn?: unknown; default?: { spawn?: unknown } });
      const spawn = typeof candidate.spawn === "function" ? candidate : candidate.default;
      this.module = spawn && typeof spawn.spawn === "function" ? (spawn as PtyModule) : null;
    } catch { this.module = null; }
    return this.module;
  }

  async available(): Promise<boolean> { return (await this.load()) !== null; }

  list(directory: string): PtyInfoDTO[] {
    return [...this.shells.values()].filter((s) => s.info.cwd === directory).map((s) => ({ ...s.info }));
  }

  get(id: string, directory: string): PtyInfoDTO {
    const shell = this.shells.get(id);
    if (!shell || shell.info.cwd !== directory) throw new Error("Терминал не найден.");
    return { ...shell.info };
  }

  async create(directory: string, title = "Enki", size = { cols: 100, rows: 30 }): Promise<PtyInfoDTO> {
    if (!this.admitting) throw new Error("Enki Runtime выполняет обслуживание; новый терминал не запущен.");
    this.starting++;
    try {
      const module = await this.load();
      if (!module) throw new Error("Терминал недоступен: модуль node-pty не загружен в этой сборке среды выполнения.");
      // The fence may have closed while the native module was loading.
      if (!this.admitting) throw new Error("Enki Runtime выполняет обслуживание; новый терминал не запущен.");
      if (this.shells.size + this.closing.size >= 16) throw new Error("Открыто слишком много терминалов.");
      return this.spawn(module, directory, title, size);
    } finally { this.starting--; }
  }

  private spawn(module: PtyModule, directory: string, title: string, size: { cols: number; rows: number }): PtyInfoDTO {
    const { file, args } = shellProgram();
    const env: Record<string, string> = {};
    // The user's shell gets the ORIGINAL host values of the SDK profile
    // overrides (PI_CODING_AGENT_DIR, PI_OFFLINE, GOOGLE_APPLICATION_CREDENTIALS),
    // exactly like the SDK's project tools: an owner `pi`/gcloud in this
    // terminal must not silently use Enki's bundled offline profile.
    for (const [key, value] of Object.entries(projectToolEnvironment(process.env))) if (typeof value === "string" && !/^ENKI_RUNTIME_/.test(key)) env[key] = value;
    env.TERM = "xterm-256color";
    const pty = module.spawn(file, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: directory, env });
    const id = `pty_${randomUUID()}`;
    const shell: Shell = { info: { id, title, cwd: directory, status: "running", cursor: 0 }, pty, buffer: "", start: 0, listeners: new Set(), exitListeners: new Set() };
    pty.onData((data) => {
      shell.buffer += data;
      if (shell.buffer.length > RING) {
        const drop = shell.buffer.length - RING;
        shell.buffer = shell.buffer.slice(drop);
        shell.start += drop;
      }
      shell.info.cursor = shell.start + shell.buffer.length;
      const chunk = { cursor: shell.info.cursor, data };
      for (const listener of shell.listeners) listener(chunk);
    });
    pty.onExit(({ exitCode }) => {
      shell.info.status = "exited";
      shell.info.exitCode = exitCode;
      const record = this.closing.get(id);
      if (record?.shell === shell) {
        // Proves the primary only; the record stays owned until detached.
        if (record.timer) clearTimeout(record.timer);
        record.timer = undefined;
        record.primaryExited = true;
        record.state = "cleanup-unknown";
        record.detail = UNKNOWN_DETAIL;
      }
      for (const listener of shell.exitListeners) listener();
    });
    this.shells.set(id, shell);
    return { ...shell.info };
  }

  /** Replay from `after` (character cursor), then follow live output. */
  attach(id: string, directory: string, after: number, onData: (chunk: { cursor: number; data: string; reset?: boolean }) => void, onExit: () => void): () => void {
    const shell = this.shells.get(id);
    if (!shell || shell.info.cwd !== directory) throw new Error("Терминал не найден.");
    if (after < shell.start) onData({ cursor: shell.info.cursor, data: shell.buffer, reset: true });
    else if (after < shell.info.cursor) onData({ cursor: shell.info.cursor, data: shell.buffer.slice(after - shell.start) });
    shell.listeners.add(onData);
    shell.exitListeners.add(onExit);
    if (shell.info.status === "exited") onExit();
    return () => { shell.listeners.delete(onData); shell.exitListeners.delete(onExit); };
  }

  input(id: string, directory: string, data: string): void {
    const shell = this.shells.get(id);
    if (!shell || shell.info.cwd !== directory || shell.info.status !== "running") throw new Error("Терминал не найден.");
    shell.pty.write(data.slice(0, 64 * 1024));
  }

  resize(id: string, directory: string, cols: number, rows: number): void {
    const shell = this.shells.get(id);
    if (!shell || shell.info.cwd !== directory || shell.info.status !== "running") return;
    shell.pty.resize(Math.max(2, Math.min(cols, 1000)), Math.max(2, Math.min(rows, 500)));
  }

  rename(id: string, directory: string, title: string): void {
    const shell = this.shells.get(id);
    if (shell && shell.info.cwd === directory) shell.info.title = title.slice(0, 120);
  }

  kill(id: string, directory: string): void {
    const shell = this.shells.get(id);
    if (!shell || shell.info.cwd !== directory) return;
    this.terminate(id, shell);
  }

  /** Hidden from listings at once; one kill, a bounded wait, never an unbounded UI wait. */
  private terminate(id: string, shell: Shell): void {
    this.shells.delete(id);
    if (shell.info.status === "exited") return; // ended by itself before any close
    const record: Closing = { shell, state: "closing", since: Date.now(), primaryExited: false,
      detail: "Терминал закрывается: ожидается завершение оболочки." };
    this.closing.set(id, record);
    try { shell.pty.kill(); }
    catch {
      record.state = "cleanup-unknown";
      record.detail = "Не удалось отправить сигнал завершения оболочке. Её состояние неизвестно; проверьте процессы и нажмите «Отсоединить».";
      return;
    }
    if (record.state !== "closing") return; // exit already observed synchronously
    record.timer = setTimeout(() => {
      if (this.closing.get(id) !== record || record.state !== "closing") return;
      record.timer = undefined;
      record.state = "cleanup-unknown";
      record.detail = "Оболочка не подтвердила завершение вовремя. Повторный сигнал не отправляется; проверьте процессы и нажмите «Отсоединить».";
    }, this.closeDeadline);
    record.timer.unref?.();
  }

  shutdown(): void {
    for (const [id, shell] of [...this.shells]) this.terminate(id, shell);
    for (const record of this.closing.values()) { if (record.timer) clearTimeout(record.timer); record.timer = undefined; }
  }
}
