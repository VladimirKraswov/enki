/* The sole browser synchronization scheduler. Rendering and commands live in
 * remote.js; this module owns cancellation, visibility and non-overlap. */
export class RemoteSynchronizer {
  constructor(task, onState) {
    this.task = task; this.onState = onState;
    this.timer = null; this.running = false; this.pending = false;
    this.controller = null; this.started = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(this.timer); this.controller?.abort(); }
      else if (this.started) this.refresh();
    });
  }
  start() { if (!this.started) { this.started = true; this.refresh(); } }
  refresh() {
    if (!this.started) this.started = true;
    clearTimeout(this.timer);
    if (document.hidden) return;
    if (this.running) { this.pending = true; this.controller?.abort(); return; }
    void this.run();
  }
  async run() {
    this.running = true; this.pending = false;
    this.controller = new AbortController(); this.onState?.(true);
    let delay = 2500;
    try { if ((await this.task(this.controller.signal))?.immediate) delay = 0; }
    catch (error) { if (error?.name !== 'AbortError') throw error; }
    finally {
      this.running = false; this.controller = null; this.onState?.(false);
      if (this.pending && !document.hidden) void this.run();
      else if (this.started && !document.hidden) this.timer = setTimeout(() => this.refresh(), delay);
    }
  }
}
