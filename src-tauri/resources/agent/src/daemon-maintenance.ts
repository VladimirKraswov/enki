// Authenticated daemon maintenance is a held lease, never an "idle" boolean.
import { randomBytes, randomUUID } from "node:crypto";
import { assertStartOwner, writePrivate, type Identity, type HeldMaintenanceReceipt, type MaintenanceReceipt } from "./daemon-control.ts";
import type { UpdateBackup } from "./core/runtime.ts";
import { HttpError, type Router } from "./server/http.ts";
import { CONTROL } from "./daemon-control.ts";
interface MaintenanceRuntime {
  beginMaintenance(): Promise<void>;
  endMaintenance(): void;
  backupForUpdate(id: string): Promise<UpdateBackup>;
}
interface Command { requestId: string; instance: string; dataHash: string; startOwner: string; mode: "begin" | "end"; lease?: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nonce = /^[A-Za-z0-9_-]{43}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class DaemonMaintenance {
  private held: { lease: string; requestId: string; ready: boolean; receipt?: HeldMaintenanceReceipt } | null = null;
  private readonly receipts = new Map<string, { body: string; result: Promise<unknown>; value?: unknown }>();
  constructor(private readonly data: string, private readonly identity: Identity, private readonly runtime: MaintenanceRuntime, initialOwner?: string) {
    if (initialOwner) {
      assertStartOwner(data, initialOwner);
      const receipt: HeldMaintenanceReceipt = { ok: true, op: "maintenance", id: randomUUID(), identity, lease: randomBytes(32).toString("base64url"), initial: true };
      this.held = { lease: receipt.lease, requestId: receipt.id, ready: true, receipt };
      writePrivate(data, "daemon-maintenance.json", JSON.stringify(receipt));
    }
  }
  snapshot(): HeldMaintenanceReceipt | undefined { return this.held?.ready ? this.held.receipt : undefined; }
  private command(input: unknown): Command {
    if (!record(input) || input.instance !== this.identity.instance || input.dataHash !== this.identity.dataHash
      || typeof input.requestId !== "string" || !uuid.test(input.requestId) || !["begin", "end"].includes(String(input.mode))
      || typeof input.startOwner !== "string" || !nonce.test(input.startOwner)
      || (input.lease !== undefined && (typeof input.lease !== "string" || !nonce.test(input.lease)))) throw new HttpError(409, "Поколение или заявка обслуживания не совпадает.");
    assertStartOwner(this.data, input.startOwner);
    return { requestId: input.requestId, instance: input.instance, dataHash: input.dataHash,
      startOwner: input.startOwner, mode: input.mode as "begin" | "end", ...(typeof input.lease === "string" ? { lease: input.lease } : {}) };
  }
  execute(input: unknown): Promise<unknown> {
    const command = this.command(input), body = JSON.stringify(command), prior = this.receipts.get(command.requestId);
    if (prior) {
      if (prior.body !== body) throw new HttpError(409, "ID обслуживания использован с другим содержимым.");
      return prior.result;
    }
    if (this.receipts.size >= 1024) throw new HttpError(409, "Лимит квитанций обслуживания исчерпан. Требуется новое поколение runtime.");
    const result = this.apply(command);
    const entry: { body: string; result: Promise<unknown>; value?: unknown } = { body, result };
    this.receipts.set(command.requestId, entry);
    void result.then(value => { entry.value = value; }, error => { entry.value = { state: "failed", id: command.requestId, message: error instanceof Error ? error.message.slice(0, 500) : "Обслуживание не подтверждено." }; });
    return result;
  }
  private async apply(command: Command): Promise<unknown> {
    if (command.mode === "end") {
      if (!this.held?.ready || command.lease !== this.held.lease) throw new HttpError(409, "Требуется совпадающая удержанная квитанция обслуживания.");
      this.runtime.endMaintenance(); this.held = null;
      const receipt = { ok: true, op: "maintenance", id: command.requestId, identity: this.identity };
      writePrivate(this.data, "daemon-maintenance.json", JSON.stringify(receipt));
      return receipt;
    }
    if (this.held) throw new HttpError(409, "Обслуживание уже удерживается другой заявкой.");
    const held: NonNullable<DaemonMaintenance["held"]> = { lease: randomBytes(32).toString("base64url"), requestId: command.requestId, ready: false };
    this.held = held;
    let fenced = false;
    try {
      await this.runtime.beginMaintenance(); fenced = true;
      const backup = await this.runtime.backupForUpdate(command.requestId);
      assertStartOwner(this.data, command.startOwner);
      const receipt: MaintenanceReceipt = { ok: true, op: "maintenance", id: command.requestId, identity: this.identity, lease: held.lease, backup };
      // Backup is complete and private before success is externally observable.
      writePrivate(this.data, "daemon-maintenance.json", JSON.stringify(receipt));
      held.receipt = receipt; held.ready = true; return receipt;
    } catch (error) {
      if (fenced) this.runtime.endMaintenance();
      this.held = null; throw error;
    }
  }
  lookup(id: string): unknown {
    const entry = this.receipts.get(id);
    if (!uuid.test(id) || !entry) throw new HttpError(404, "Квитанция обслуживания не найдена в этом поколении.");
    return entry.value ?? { state: "pending", id, identity: this.identity };
  }
  assertShutdown(body: unknown): void {
    if (!this.held) return;
    if (!record(body) || !this.held.ready || body.lease !== this.held.lease) throw new HttpError(409, "Остановка требует удержанную квитанцию обслуживания.");
    assertStartOwner(this.data, body.startOwner);
  }
  routes(router: Router): void {
    router.add("POST", `${CONTROL}/maintenance`, request => this.execute(request.body));
    router.add("GET", `${CONTROL}/maintenance/:id`, request => this.lookup(request.params.id));
  }
}
