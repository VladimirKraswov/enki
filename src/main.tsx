import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BrowserMonitor } from "./components/BrowserMonitor";
import { store, applyTheme } from "./state/store";
import { startAgentControl } from "./control/bridge";
import { installStartupGuard } from "./startup/guard";
import "./styles.css";

const observingBrowser = new URLSearchParams(window.location.search).get("view") === "browser-monitor";

// A blank window is unreportable: an uncaught startup error, or a window that
// never painted, becomes a visible panel instead of white.
installStartupGuard(document, window);

// Debug handle for development only (not included in production bundles).
if (import.meta.env.DEV && !observingBrowser) {
  (window as unknown as Record<string, unknown>).__ocStore = store;
}

// Native agents use the private control plane, never simulated pointer input.
if (!observingBrowser) void startAgentControl();
else { document.documentElement.classList.add("browser-monitor-document"); applyTheme(store.state.prefs.theme); }

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {observingBrowser ? <BrowserMonitor /> : <App />}
  </React.StrictMode>,
);
