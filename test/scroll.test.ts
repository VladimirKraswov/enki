// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ChatScrollController} from '../src/chat/scroll';
let el: HTMLElement, height: number, anchorTop: number, controller: ChatScrollController;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  el=document.createElement('div'); document.body.append(el); height=1000; anchorTop=600;
  Object.defineProperties(el,{scrollHeight:{get:()=>height},clientHeight:{get:()=>200}});
  el.getBoundingClientRect=()=>({top:0,bottom:200} as DOMRect);
  const row=document.createElement('div');row.dataset.scrollAnchor='message';el.append(row);
  row.getBoundingClientRect=()=>({top:anchorTop-el.scrollTop,bottom:anchorTop+500-el.scrollTop} as DOMRect);
  controller=new ChatScrollController(el,vi.fn());
});
afterEach(()=>{controller.dispose();el.remove();vi.unstubAllGlobals();});
it('follows streaming and late layout growth only while watching the tail',()=>{
 expect(el.scrollTop).toBe(800);height=1300;controller.layout();expect(el.scrollTop).toBe(1100);
});
it('a one-pixel upward gesture stops follow before the next token, even inside the old 80px zone',()=>{
 controller.intent('up'); el.scrollTop=799;controller.onScroll();height=1300;controller.layout();
 expect(el.scrollTop).toBe(799);expect(controller.snapshot().following).toBe(false);
});
it('a queued resize cannot override manual upward intent',async()=>{
 height=1200;controller.schedule();controller.intent('up');el.scrollTop=790;controller.onScroll();
 await new Promise(r=>setTimeout(r,10));expect(el.scrollTop).toBe(790);
});
it('preserves a visible anchor when history or a resized block is inserted above it',()=>{
 controller.intent('up');el.scrollTop=650;controller.onScroll();anchorTop+=700;height+=700;controller.layout();
 expect(el.scrollTop).toBe(1350);expect(anchorTop-el.scrollTop).toBe(-50);
});
it('does not resume due to resize clamping or a programmatic scroll event',()=>{
 controller.intent('up');el.scrollTop=700;controller.onScroll();height=800;controller.layout();controller.onScroll();
 height=1200;controller.layout();expect(controller.snapshot().following).toBe(false);
});
it('keeps following through browser clamp, anchor nudge and stale scroll events without a gesture', () => {
  height = 700; el.scrollTop = 500; controller.onScroll(); // blocks above collapsed: the browser clamped us
  expect(controller.snapshot().following).toBe(true);
  height = 1300; controller.layout(); expect(el.scrollTop).toBe(1100);
  el.scrollTop = 1050; controller.onScroll(); // a stale or anchor-adjusted event arrives late
  height = 1600; controller.layout();
  expect(controller.snapshot().following).toBe(true); expect(el.scrollTop).toBe(1400);
});
it('resumes when the reader scrolls down to the actual bottom, or presses latest',()=>{
 controller.intent('up');el.scrollTop=500;controller.onScroll();controller.intent('down');el.scrollTop=800;controller.onScroll();
 height=1200;controller.layout();expect(el.scrollTop).toBe(1000);
 controller.pause();el.scrollTop=500;controller.onScroll();controller.latest();expect(el.scrollTop).toBe(1000);
});
it('restores a paused position without jumping into new content',()=>{
 controller.intent('up');el.scrollTop=650;controller.onScroll();const saved=controller.snapshot();controller.dispose();
 height=1600;el.scrollTop=0;controller=new ChatScrollController(el,vi.fn(),saved);expect(el.scrollTop).toBe(650);
});

it('retains a paused anchor while history is temporarily empty during restoration',()=>{
 controller.intent('up');el.scrollTop=650;controller.onScroll();const saved=controller.snapshot();controller.dispose();
 const row=el.firstElementChild!;row.remove();height=200;el.scrollTop=0;
 controller=new ChatScrollController(el,vi.fn(),saved);expect(controller.snapshot().anchor).toEqual(saved.anchor);
 el.append(row);height=1400;controller.layout();expect(el.scrollTop).toBe(650);
});
it('anchors to the visible part inside a long answer when preceding parts resize',()=>{
 const parent=el.firstElementChild!;const part=document.createElement('div');part.dataset.scrollAnchor='visible-part';parent.append(part);
 let partTop=850;part.getBoundingClientRect=()=>({top:partTop-el.scrollTop,bottom:partTop+100-el.scrollTop} as DOMRect);
 controller.pause();expect(controller.snapshot().anchor?.id).toBe('visible-part');
 partTop+=200;height+=200;controller.layout();expect(el.scrollTop).toBe(1000);
});
it('ignores zero-size anchors in folded progress even when the viewport extends above the window',()=>{
 el.getBoundingClientRect=()=>({top:-52,bottom:148} as DOMRect);
 const folded=document.createElement('div');folded.dataset.scrollAnchor='hidden-step';el.prepend(folded);
 folded.getBoundingClientRect=()=>({top:0,bottom:0} as DOMRect);
 controller.pause();expect(controller.snapshot().anchor?.id).toBe('message');
});
