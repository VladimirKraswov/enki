/** Host work admission, shared by HTTP, scheduling, SDK UI and native calls.
 * Reservations cover preparation as well as execution, including an accepted
 * HTTP request whose complete body has not yet arrived. No agent loop lives here.
 */
export class AdmissionClosed extends Error {
  constructor() { super("Enki Runtime готовится к обновлению. Действие не принято; повторите после обновления."); this.name = "AdmissionClosed"; }
}
export class Admission {
  private stopped = false;
  private maintenance = false;
  private readonly operations = new Map<symbol, string>();
  open(): boolean { return !this.stopped && !this.maintenance; }
  reserve(kind: string): () => void {
    if (!this.open()) throw new AdmissionClosed();
    const id = Symbol(kind); this.operations.set(id, kind);
    return () => { this.operations.delete(id); };
  }
  setMaintenance(value: boolean): void {
    if (value && this.stopped) throw new AdmissionClosed();
    this.maintenance = value;
  }
  stop(): void { this.stopped = true; }
  active(): number { return this.operations.size; }
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const kind of this.operations.values()) counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }
}
