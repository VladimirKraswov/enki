/** Pointer-drag splitter: size follows movementX (or movementY), clamped. The
 * drag ends on release AND on cancel/blur, so no listener outlives the gesture. */
export function startResize(opts: {
  initial: number;
  min: number;
  max: number;
  direction?: number;
  axis?: "x" | "y";
  apply: (px: number) => void;
}, target: Window = window): () => void {
  let current = opts.initial;
  const move = (e: PointerEvent) => {
    const delta = opts.axis === "y" ? e.movementY : e.movementX;
    current = Math.min(opts.max, Math.max(opts.min, current + delta * (opts.direction ?? 1)));
    opts.apply(current);
  };
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    target.removeEventListener("blur", end);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  target.addEventListener("blur", end);
  return end;
}
