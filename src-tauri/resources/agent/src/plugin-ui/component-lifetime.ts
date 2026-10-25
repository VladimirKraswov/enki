import { isFocusable, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { asError, type UiFault } from "./host-ports.ts";

export type DisposableComponent = Component & { dispose?(): void };
export function requireComponent(value: unknown): asserts value is DisposableComponent {
  if (!value || typeof value !== "object" || !("render" in value) || typeof value.render !== "function"
    || !("invalidate" in value) || typeof value.invalidate !== "function"
    || "dispose" in value && value.dispose !== undefined && typeof value.dispose !== "function") {
    throw new TypeError("Фабрика расширения не вернула настоящий Component.");
  }
}

/** Shared returned objects are disposed only after the last mounted ownership ends. */
export class ComponentLifetimes {
  private readonly references = new WeakMap<DisposableComponent, number>();
  private readonly disposed = new WeakSet<DisposableComponent>();
  constructor(private readonly fault: (fault: UiFault) => void) {}
  held(component: Component): boolean { return (this.references.get(component) ?? 0) > 0; }
  hold(component: DisposableComponent, operation: string): () => void {
    requireComponent(component);
    if (this.disposed.has(component)) throw new Error("Расширение повторно вернуло уже уничтоженный компонент.");
    this.references.set(component, (this.references.get(component) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.references.get(component) ?? 1) - 1;
      if (remaining > 0) { this.references.set(component, remaining); return; }
      this.references.delete(component);
      this.disposed.add(component);
      try { component.dispose?.(); }
      catch (error) { this.fault({ operation: `${operation}:dispose`, error: asError(error) }); }
    };
  }
}

/** Actual component calls stay local; failures are visible and scoped, never silent empty renders. */
export class GuardedComponent implements Component {
  readonly children: Component[];
  private localFocus = false;
  private failed = false;
  constructor(readonly component: DisposableComponent, private readonly fail: (error: Error) => void) {
    this.children = [component];
  }
  get focused(): boolean { return isFocusable(this.component) ? this.component.focused : this.localFocus; }
  set focused(value: boolean) {
    this.localFocus = value;
    if (isFocusable(this.component)) this.component.focused = value;
  }
  get wantsKeyRelease(): boolean | undefined { return this.component.wantsKeyRelease; }
  render(width: number): string[] {
    if (this.failed) return ["[Компонент расширения завершился с ошибкой.]"];
    try { return this.component.render(width); }
    catch (error) { this.failure(error); return ["[Не удалось отобразить компонент расширения.]"]; }
  }
  handleInput(data: string): void {
    if (!this.failed) try { this.component.handleInput?.(data); } catch (error) { this.failure(error); }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.failed) try { return this.component.handleMouse?.(event); } catch (error) { this.failure(error); }
    return undefined;
  }
  invalidate(): void {
    if (!this.failed) try { this.component.invalidate(); } catch (error) { this.failure(error); }
  }
  private failure(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.fail(asError(error));
  }
}
