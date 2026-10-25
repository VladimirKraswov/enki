// The SDK resolves provider auth concurrently. Keep that burst out of the
// bounded native broker without increasing its capacity or caching secrets.
import type { Broker } from "../control/broker.ts";

const WAIT_LIMIT = 256;
const TIMEOUT_MS = 20_000;

class ReadLane {
  private active = false;
  private waiting = new Set<() => void>();

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("Чтение ключа отменено."));
    if (this.waiting.size >= WAIT_LIMIT)
      return Promise.reject(new Error("Очередь чтения ключей заполнена. Повторите обновление моделей позже."));
    return new Promise<T>((resolve, reject) => {
      const detach = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const cancel = (message: string) => {
        if (!this.waiting.delete(start)) return; // dispatched: the broker owns cancellation
        detach();
        reject(new Error(message));
      };
      const abort = () => cancel("Чтение ключа отменено.");
      const timer = setTimeout(() => cancel("Истекло время ожидания чтения ключа. Проверьте доступ к системному хранилищу."), TIMEOUT_MS);
      const start = () => {
        this.waiting.delete(start);
        detach();
        this.active = true;
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw new Error("Чтение ключа отменено.");
          return work();
        }).then(resolve, reject).finally(() => {
          this.active = false;
          this.next();
        });
      };
      this.waiting.add(start);
      signal?.addEventListener("abort", abort, { once: true });
      if (!this.active) this.next();
    });
  }

  private next(): void { this.waiting.values().next().value?.(); }
}

// Shared by every CredentialStore on this broker, including model refreshes.
// Different native/remote broker generations do not block each other.
const lanes = new WeakMap<Broker, ReadLane>();

export function readCredential(broker: Broker, providerId: string, signal: AbortSignal | undefined, preflight: () => void): Promise<{ value: string | null; revision: number }> {
  let lane = lanes.get(broker);
  if (!lane) { lane = new ReadLane(); lanes.set(broker, lane); }
  return lane.run(() => {
    preflight();
    return broker.call<{ value: string | null; revision: number }>("vault.credentialRead", { providerId }, signal, TIMEOUT_MS);
  }, signal);
}
