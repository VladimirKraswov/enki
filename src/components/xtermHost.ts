// The single xterm host of the app: shell terminals (TerminalPanel) and the
// runtime plugin surface (PluginUiPanel) use the same renderer, font and theme.
// No clipboard/link/window-manipulation addons: native actions go through the
// gesture-scoped runtime broker only.
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Reads current theme colors so the terminal matches light/dark UI. */
export function terminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--panel").trim() || "#1e1e1e";
  const fg = cs.getPropertyValue("--text").trim() || "#d4d4d4";
  return { background: bg, foreground: fg, cursorCellBackground: fg };
}

export interface XtermHost { term: Terminal; fit: FitAddon; refit(): boolean; dispose(): void }

export function createXterm(container: HTMLElement, options: ITerminalOptions = {}): XtermHost {
  const term = new Terminal({
    convertEol: false,
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: 12.5,
    theme: terminalTheme(),
    scrollback: 5000,
    allowProposedApi: false,
    windowOptions: {},
    ...options,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  const refit = (): boolean => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return false;
    try { fit.fit(); return true; } catch { return false; } // hidden container
  };
  refit();
  let disposed = false;
  return { term, fit, refit, dispose: () => { if (!disposed) { disposed = true; term.dispose(); } } };
}
