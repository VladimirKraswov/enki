/** One owner for scroll position: follow the tail OR preserve the reader's anchor. */
export interface ReadingPosition { following: boolean; top: number; anchor?: { id: string; offset: number } }
export class ChatScrollController {
  private following = true;
  private top = 0;
  private anchor?: ReadingPosition['anchor'];
  private written: number | null = null;
  private direction: 'up' | 'down' | null = null;
  private frame = 0;
  private dead = false;
  constructor(private el: HTMLElement, private changed: (following: boolean, away: boolean) => void,
    initial?: ReadingPosition) {
    this.following = initial?.following ?? true;
    this.top = initial?.top ?? 0;
    this.anchor = initial?.anchor;
    this.layout();
  }
  private bottom() { return Math.max(0, this.el.scrollHeight - this.el.clientHeight); }
  private publish() { this.changed(this.following, this.bottom() - this.el.scrollTop > 2 || (!this.following && this.bottom() > 2)); }
  private write(top: number) {
    const value = Math.max(0, Math.min(top, this.bottom()));
    if (Math.abs(this.el.scrollTop - value) > .5) {
      this.el.scrollTop = value;
      this.written = this.el.scrollTop;
    }
    this.top = this.el.scrollTop;
  }
  private capture() {
    const viewport = this.el.getBoundingClientRect();
    const nodes = this.el.querySelectorAll<HTMLElement>('[data-scroll-anchor]');
    let candidate: HTMLElement | undefined;
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      if (box.bottom > box.top && box.bottom > viewport.top + 1 && box.top < viewport.bottom) {
        if (!candidate || candidate.contains(node)) candidate = node;
        else break;
      }
    }
    this.anchor = candidate ? { id: candidate.dataset.scrollAnchor!, offset: candidate.getBoundingClientRect().top - viewport.top } : undefined;
  }
  /** Called before the browser processes a wheel/touch/key gesture. Even 1px up detaches. */
  intent(direction: 'up' | 'down') {
    this.direction = direction;
    if (direction === 'up') this.pause();
  }
  pause() {
    this.following = false;
    this.written = null;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.top = this.el.scrollTop;
    this.capture(); this.publish();
  }
  onScroll() {
    const now = Math.max(0, this.el.scrollTop);
    if (this.written !== null && Math.abs(now - this.written) < 1) {
      this.written = null; this.top = now; this.publish(); return;
    }
    this.written = null;
    const movement = now - this.top;
    // Only an explicit gesture may detach (see intent()/pause()). Raw upward
    // movement is NOT evidence of intent: when streamed blocks above collapse,
    // the browser itself clamps or anchor-shifts scrollTop and fires a scroll
    // event that once silenced following without any user touch.
    if (!this.following && this.direction !== 'up' && movement > .5 && this.bottom() - now <= 2)
      this.following = true;
    this.top = now;
    if (!this.following) this.capture();
    this.publish();
  }
  schedule() {
    if (this.frame || this.dead) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.layout(); });
  }
  /** Resize, token growth, history prepends and panel changes use the same policy. */
  layout() {
    if (this.dead) return;
    if (!this.following && this.anchor && !this.el.querySelector('[data-scroll-anchor]')) {
      this.changed(false, true); return; // History may still be loading after navigation.
    }
    if (this.following) this.write(this.bottom());
    else {
      const node = this.anchor && Array.from(this.el.querySelectorAll<HTMLElement>('[data-scroll-anchor]'))
        .find(x => {
          const box = x.getBoundingClientRect();
          return x.dataset.scrollAnchor === this.anchor!.id && box.bottom > box.top;
        });
      if (node) this.write(this.el.scrollTop + node.getBoundingClientRect().top - this.el.getBoundingClientRect().top - this.anchor!.offset);
      else this.write(this.top);
      this.capture();
    }
    this.publish();
  }
  latest() {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.following = true; this.direction = null; this.anchor = undefined;
    this.write(this.bottom()); this.publish();
  }
  snapshot(): ReadingPosition { return { following: this.following, top: this.top, anchor: this.anchor }; }
  dispose() { this.dead = true; cancelAnimationFrame(this.frame); }
}
