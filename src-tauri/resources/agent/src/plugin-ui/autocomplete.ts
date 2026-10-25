import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

function requireProvider(value: AutocompleteProvider): void {
  if (!value || typeof value.getSuggestions !== "function" || typeof value.applyCompletion !== "function") {
    throw new TypeError("Фабрика autocomplete не вернула настоящий provider.");
  }
}

/** Real ordered wrapper pipeline; cancellation fences late promises after swap/reload. */
export class AutocompletePipeline implements AutocompleteProvider {
  private wrappers: AutocompleteProviderFactory[] = [];
  private current: AutocompleteProvider;
  private request: AbortController | null = null;
  private stopped = false;
  private generation = 0;
  constructor(private base: AutocompleteProvider) { requireProvider(base); this.current = base; }
  get triggerCharacters(): string[] | undefined { return this.current.triggerCharacters; }
  add(factory: AutocompleteProviderFactory): void {
    const wrappers = [...this.wrappers, factory];
    const next = this.build(this.base, wrappers);
    this.cancel(); this.wrappers = wrappers; this.current = next;
  }
  setBase(base: AutocompleteProvider): void {
    const next = this.build(base, this.wrappers);
    this.cancel(); this.base = base; this.current = next;
  }
  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
    this.ensureAlive(); this.cancel();
    const [lines, line, col, options] = args;
    const request = new AbortController(), generation = this.generation;
    this.request = request;
    const abort = () => request.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    try {
      const result = await this.current.getSuggestions(lines, line, col, { ...options, signal: request.signal });
      if (request.signal.aborted || this.stopped || generation !== this.generation) {
        throw new DOMException("Autocomplete request was cancelled", "AbortError");
      }
      return result;
    } finally {
      options.signal.removeEventListener("abort", abort);
      if (this.request === request) this.request = null;
    }
  }
  applyCompletion(...args: Parameters<AutocompleteProvider["applyCompletion"]>) {
    this.ensureAlive(); return this.current.applyCompletion(...args);
  }
  shouldTriggerFileCompletion(...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>) {
    this.ensureAlive(); return this.current.shouldTriggerFileCompletion?.(...args) ?? false;
  }
  cancel(): void { this.generation += 1; this.request?.abort(); this.request = null; }
  dispose(): void { this.cancel(); this.stopped = true; }
  private build(base: AutocompleteProvider, wrappers: AutocompleteProviderFactory[]): AutocompleteProvider {
    requireProvider(base);
    let current = base;
    for (const factory of wrappers) { current = factory(current); requireProvider(current); }
    return current;
  }
  private ensureAlive(): void { if (this.stopped) throw new Error("Autocomplete session is disposed"); }
}
