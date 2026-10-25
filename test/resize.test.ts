import { expect, it, vi } from 'vitest';
import { startResize } from '../src/util/resize';

const pointer = (type: string, movement: { movementX?: number; movementY?: number } = {}) =>
  Object.assign(new Event(type), { movementX: 0, movementY: 0, ...movement });

it('a splitter drag follows the pointer, clamps, and ends on release', () => {
  const target = new EventTarget() as unknown as Window, apply = vi.fn();
  startResize({ initial: 300, min: 180, max: 420, apply }, target);
  target.dispatchEvent(pointer('pointermove', { movementX: 50 }));
  target.dispatchEvent(pointer('pointermove', { movementX: 500 }));
  expect(apply.mock.calls.map(([px]) => px)).toEqual([350, 420]);
  target.dispatchEvent(pointer('pointerup'));
  target.dispatchEvent(pointer('pointermove', { movementX: -50 }));
  expect(apply).toHaveBeenCalledTimes(2);
});

it.each(['pointercancel', 'blur'])('a %s ends the drag: later pointer moves never resize the panel', (type) => {
  const target = new EventTarget() as unknown as Window, apply = vi.fn();
  startResize({ initial: 200, min: 90, max: 600, direction: -1, axis: 'y', apply }, target);
  target.dispatchEvent(pointer('pointermove', { movementY: -10, movementX: 99 }));
  expect(apply).toHaveBeenLastCalledWith(210);
  target.dispatchEvent(pointer(type));
  target.dispatchEvent(pointer('pointermove', { movementY: -10 }));
  target.dispatchEvent(pointer('pointerup'));
  expect(apply).toHaveBeenCalledTimes(1);
});
