// Trusted pixel projection of the real browser. Remote HTML never enters the
// privileged Desktop WebView. No extra listener, exposed CDP or injected script.
export function createView(getContext) {
  let active;
  let cursor;
  let busy = false;
  let attached;
  let revision = 0;
  let observationEpoch = 0;
  let interruptionEpoch = 0;
  let navigationEpoch = 0;
  const screenshotStarts = new WeakMap();
// Page titles are re-read for every tab on every frame, but a title only
// changes on navigation or a same-document title update. Caching removes N CDP
// round trips per frame and, with a deadline, stops one unresponsive renderer
// from stalling the whole projection.
const titles = new WeakMap();
// A page that awaits a native dialog or whose renderer crashed cannot paint or
// answer. Report that state instead of leaving the panel silently frozen.
const blocked = new WeakMap();
const TITLE_TTL_MS = 1500;
const TITLE_TIMEOUT_MS = 400;
const FRAME_BUDGET_MS = 1600;
// Chromium pushes pixels only when the page actually paints. A screencast is
// therefore cheaper and fresher than screenshot polling: no CDP screenshot per
// poll, no cost at all while the page is static, and frames appear as soon as
// something changes. A screenshot stays as the fallback path.
const CAST_IDLE_MS = 6000;
// Pages with a live screencast. A Set (not a WeakMap) because idle shutdown
// must be able to iterate them; entries are removed on close, resize and stop.
const casts = new WeakMap();
const castPages = new Set();
  const watched = new WeakSet();
  let mode = 'fast';
  let size = { width: 1280, height: 800 };
  const observed = new WeakMap();
  const geometry = value => JSON.stringify([pageId(value), value.url(), value.viewportSize(), revision, observationEpoch]);
  const reads = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests']);
  const pointer = name => /^browser_mouse_.*_xy$/.test(name) || ['browser_mouse_down', 'browser_mouse_up'].includes(name);
  const humanTools = new Set([...reads, 'browser_close', 'browser_navigate', 'browser_navigate_back', 'browser_tabs',
    'browser_press_key', 'browser_keyboard_type', 'browser_mouse_down', 'browser_mouse_up', 'browser_mouse_wheel', 'browser_file_upload', 'browser_handle_dialog', 'browser_wait_for', 'browser_resize',
    'browser_mouse_click_xy', 'browser_mouse_move_xy', 'browser_mouse_drag_xy']);
  function policy(params, owner = 'agent') {
    if (owner !== 'agent' || mode !== 'human') return;
    if (!humanTools.has(params.name))
      throw Object.assign(new Error('Human mode: use a fresh screenshot, mouse coordinates and keyboard typing. DOM actions and code execution are disabled.'), { recovery: 'mode' });
  }
  function guard(client, params, owner = 'agent') {
    policy(params, owner);
    const args = params.arguments || {}, viewport = active.viewportSize() || size;
    const points = params.name === 'browser_mouse_drag_xy' ? [[args.startX, args.startY], [args.endX, args.endY]] : ('x' in args || 'y' in args) ? [[args.x, args.y]] : [];
    const outside = points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height);
    if (pointer(params.name) && (outside || (owner === 'agent' && observed.get(client) !== geometry(active))))
      throw Object.assign(new Error('Viewport or page changed. No input was sent. Use the fresh screenshot and its CSS pixel coordinates.'), { recovery: 'geometry' });
  }
  async function resize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1920 || height < 240 || height > 1200)
      throw new Error('Invalid viewport');
    if (width === size.width && height === size.height) return;
    size = { width, height }; revision++; cursor = undefined;
    if (active && !active.isClosed()) {
      // The screencast encodes at the old size: restart it after the reflow.
      await stopCast(active);
      await active.setViewportSize(size);
    }
  }
  function setMode(value) {    if (!['fast', 'human'].includes(value)) throw new Error('Invalid browser mode');
    if (mode !== value) { mode = value; revision++; cursor = undefined; }
  }
  const state = () => ({ mode, viewport: { ...size }, revision, blocked: blockState(active) });
  let nextPageId = 0;
  const pageIds = new WeakMap();
  const pageId = value => {
    if (!pageIds.has(value)) pageIds.set(value, String(++nextPageId));
    return pageIds.get(value);
  };
  const selected = new WeakMap();
  async function bounded(work, ms) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Frame deadline exceeded'), { deadline: true })), ms);
      timer.unref?.();
    });
    const running = Promise.resolve(work);
    // The loser of the race must never surface as an unhandled rejection:
    // the daemon treats those as a fatal runtime failure.
    running.catch(() => {});
    try { return await Promise.race([running, deadline]); }
    finally { clearTimeout(timer); }
  }
  function watchPage(value) {
    if (watched.has(value)) return;
    watched.add(value);
    pageId(value);
    value.on('framenavigated', frame => {
      if (frame === value.mainFrame()) { titles.delete(value); blocked.delete(value); revision++; navigationEpoch++; }
    });
    value.on('crash', () => { blocked.set(value, { kind: 'crash' }); revision++; });
    // Page-level transport errors are reported, never fatal.
    value.on('error', () => {});
    value.on('close', () => { titles.delete(value); blocked.delete(value); void stopCast(value); });
    value.on('dialog', dialog => {
      // The official backend owns dialog handling. Never dismiss here: keep the
      // handle for an explicit decision and report only the safe state.
      blocked.set(value, { kind: 'dialog', type: dialog.type(), dialog });
      revision++;
    });
  }
  // Only plain data may reach the frame payload: a dialog handle is native.
  const blockState = value => {
    const state = value && !value.isClosed() ? blocked.get(value) : null;
    return state ? { kind: state.kind, ...(state.type ? { type: state.type } : {}) } : null;
  };
  let castIdle;
  async function stopCast(value) {
    const cast = value && casts.get(value);
    if (!cast) return;
    casts.delete(value);
    castPages.delete(value);
    await cast.session.send('Page.stopScreencast').catch(() => {});
    await cast.session.detach().catch(() => {});
  }
  function idle() {
    clearTimeout(castIdle);
    castIdle = setTimeout(() => {
      // Nobody is looking at the panel: stop encoding instead of burning CPU.
      for (const value of [...castPages]) void stopCast(value).catch(() => {});
    }, CAST_IDLE_MS);
    castIdle.unref?.();
  }
  /** Start (or reuse) the screencast of one page at the current size. Failure
   * is not fatal: frame() falls back to a screenshot. */
  async function cast(value, size) {
    const existing = casts.get(value);
    if (existing && existing.width === size.width && existing.height === size.height) return existing;
    if (existing) await stopCast(value);
    try {
      const session = await value.context().newCDPSession(value);
      // A CDP session emits 'error' when the browser dies; an EventEmitter
      // 'error' without a listener is fatal for the whole daemon.
      session.on('error', () => {});
      const record = { session, width: size.width, height: size.height, image: '', at: 0 };
      session.on('Page.screencastFrame', event => {
        if (!event || typeof event.data !== 'string') return;
        record.image = event.data;
        record.at = Date.now();
        void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      });
      await session.send('Page.startScreencast', { format: 'jpeg', quality: 65,
        maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
      casts.set(value, record);
      castPages.add(value);
      return record;
    } catch { return undefined; }
  }
  /** Title of one page, cached and bounded: an unresponsive renderer never
   * blocks the frame for longer than TITLE_TIMEOUT_MS. */
  async function titleOf(value) {
    const cached = titles.get(value);
    const now = Date.now();
    if (cached && now - cached.at < TITLE_TTL_MS) return cached.title;
    const title = await bounded(value.title(), TITLE_TIMEOUT_MS)
      .then(text => (typeof text === 'string' ? text : ''))
      .catch(() => cached?.title ?? '');
    titles.set(value, { title, at: Date.now() });
    return title;
  }
  async function page() {
    const context = await getContext();
    if (attached !== context) {
      attached = context;
      context.on('page', value => { active = value; watchPage(value); revision++; });
    }
    if (!active || active.isClosed()) active = context.pages().at(-1) || await context.newPage();
    watchPage(active);
    if (JSON.stringify(active.viewportSize()) !== JSON.stringify(size)) { revision++; cursor = undefined; await active.setViewportSize(size); }
    return active;
  }
  async function before(client, params, owner = 'agent', signal) {
    signal?.throwIfAborted();
    const current = await page();
    signal?.throwIfAborted();
    guard(client, params, owner);
    if (!reads.has(params.name) && !['browser_mouse_move_xy', 'browser_mouse_down', 'browser_wait_for'].includes(params.name) && !(params.name === 'browser_tabs' && params.arguments?.action === 'list')) {
      if (owner === 'agent') revision++;
      else {
        observationEpoch++;
        // A manual wheel changes every screen coordinate. Invalidate old
        // panel frames as well as agent observations, without invalidating
        // each character of an otherwise continuous manual typing burst.
        if (params.name === 'browser_mouse_wheel') { revision++; cursor = undefined; }
      }
    }
    if (selected.get(client) !== current) {
      // The official backend's tab list is initially empty until its first
      // context-using call. A read-only snapshot attaches it to our context.
      if (!selected.has(client)) {
        const initialized = await client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { signal, timeout: 10000 });
        if (initialized.isError) throw new Error('Could not attach browser context');
      }
      signal?.throwIfAborted();
      const index = current.context().pages().indexOf(current);
      const result = await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index } }, undefined, { signal, timeout: 10000 });
      if (result.isError) throw new Error('Could not synchronize browser tab');
      signal?.throwIfAborted();
      selected.set(client, current);
    }
    if (params.name === 'browser_take_screenshot') screenshotStarts.set(client, geometry(current));
    busy = true;
    const args = params.arguments || {};
    let point;
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) point = { x: args.x, y: args.y };
    else if (typeof args.target === 'string' && /^[a-zA-Z0-9]+$/.test(args.target)) {
      const box = await current.locator(`aria-ref=${args.target}`).boundingBox({ timeout: 500 }).catch(() => null);
      if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (point) cursor = { ...point, owner, action: params.name, at: Date.now() };
  }
  async function after(client, params, result) {
    busy = false;
    // The owner (or the agent through the official tool) dismissed a dialog:
    // the page is answerable again, so the projection may stop reporting it.
    if (params.name === 'browser_handle_dialog' && active && !active.isClosed() && !result?.isError)
      blocked.delete(active);
    const context = await getContext();
    const pages = context.pages();
    const text = result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
    const url = text.match(/^- Page URL: (.+)$/m)?.[1];
    if (params.name === 'browser_tabs' && params.arguments?.action === 'select') active = pages[params.arguments.index];
    else if (url) active = pages.find(value => value.url() === url) || active;
    if (active && !active.isClosed()) {
      selected.set(client, active);
      // Coordinates are meaningful only after observing the current viewport.
      if (params.name === 'browser_take_screenshot' && !result?.isError && !params.arguments?.fullPage && !params.arguments?.target && params.arguments?.scale === 'css' && screenshotStarts.get(client) === geometry(active)) observed.set(client, geometry(active));
      if (params.name === 'browser_resize') { size = active.viewportSize() || size; cursor = undefined; }
    }
  }
  let lastFrame;
  async function frame(context, observedPageId) {
    if (!context) return { browserOpen: false, tabs: [], busy: false, mode, blocked: null };
    const pages = context.pages();
    if (!active || active.isClosed()) active = pages.at(-1);
    if (!active) return { browserOpen: true, tabs: [], busy, mode, blocked: null };
    const agentPage = active;
    const current = (observedPageId && pages.find(value => pageId(value) === observedPageId)) || active;
    watchPage(current);
    const viewport = current.viewportSize() || { width: 1280, height: 800 };
    const size = { width: Math.min(viewport.width, 1920), height: Math.min(viewport.height, 1200) };
    const capturedRevision = revision, capturedUrl = current.url();
    idle();
    // A warm screencast answers synchronously; a cold one is started in the
    // background so this frame is never delayed by stream setup.
    const warm = casts.get(current);
    const streaming = warm && warm.image && warm.width === size.width && warm.height === size.height ? warm : undefined;
    if (!streaming) void bounded(cast(current, size), 600).catch(() => undefined);
    const capture = (async () => {
      // A cached screencast frame from a browser that has died would look fresh
      // forever. A lost connection is a failed capture, so the panel shows the
      // honest "last frame" state instead of a frozen picture.
      let lost = false;
      try { const handle = context.browser?.(); if (handle) lost = handle.isConnected?.() === false; } catch { lost = true; }
      if (lost) throw new Error('Browser connection lost');
      // A screencast frame is the page's own pixels; only ask for a screenshot
      // when the stream has not delivered anything yet.
      const image = streaming?.image
        || (await current.screenshot({ type: 'jpeg', quality: 65, timeout: 1000, scale: 'css', clip: { x: 0, y: 0, ...size } })).toString('base64');
      const tabs = await Promise.all(pages.map(async (value, index) => ({ index, id: pageId(value), url: value.url(), title: await titleOf(value), active: value === agentPage })));
      const id = pageId(current);
      // The projected title belongs to the observed page, not only to the agent page.
      const title = tabs.find(value => value.id === id)?.title ?? await titleOf(current);
      if (capturedRevision !== revision || capturedUrl !== current.url() || active !== agentPage || current.isClosed()) throw Object.assign(new Error('Frame changed during capture'), { frameChanged: true });
      return { browserOpen: true, mode, tabs, url: capturedUrl, title,
        pageId: pageId(current), revision: capturedRevision,
        width: size.width, height: size.height, image, busy,
        blocked: blockState(current),
        cursor: current === agentPage && cursor && Date.now() - cursor.at < 8000 ? cursor : null };
    })();
    try {
      const fresh = await bounded(capture, FRAME_BUDGET_MS);
      lastFrame = fresh;
      return fresh;
    } catch (error) {
      if (error.frameChanged && !error.deadline) throw error;
      // A slow or wedged renderer must not blank the projection: keep the last
      // painted frame, mark it stale and let the daemon retry on its own cadence.
      if (!lastFrame) throw error;
      return { ...lastFrame, stale: true, staleReason: error.deadline ? 'deadline' : 'capture',
        busy, mode, blocked: blockState(current),
        cursor: lastFrame.cursor && Date.now() - lastFrame.cursor.at < 8000 ? lastFrame.cursor : null };
    }
  }
  function assertCurrent(expected) {
    if (busy || !active || active.isClosed() || !expected || expected.pageId !== pageId(active)
        || expected.url !== active.url() || expected.revision !== revision
        || (expected.width !== undefined && (expected.width !== active.viewportSize()?.width || expected.height !== active.viewportSize()?.height)))
      throw new Error('Page changed; inspect a fresh frame before manual input');
  }
  // Trusted desktop input does not need the agent's accessibility snapshot.
  // The daemon still validates chat/frame and serializes this with agent actions.
  async function manual(method, args) {
    const current = await page();
    const point = (x, y) => {
      const size = current.viewportSize();
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height) throw new Error('Invalid pointer coordinates');
    };
    if (method === 'desktop/click' || method === 'desktop/drag') {
      point(args.x, args.y);
      if (method === 'desktop/drag') point(args.endX, args.endY);
      observationEpoch++;
      cursor = { x: args.x, y: args.y, owner: 'user', action: method, at: Date.now() };
      if (method === 'desktop/click') await current.mouse.click(args.x, args.y);
      else {
        await current.mouse.move(args.x, args.y);
        await current.mouse.down();
        try { await current.mouse.move(args.endX, args.endY, { steps: 12 }); }
        finally { await current.mouse.up(); }
        cursor = { ...cursor, x: args.endX, y: args.endY };
      }
    } else if (method === 'desktop/wheel') {
      if (!Number.isFinite(args.dy) || Math.abs(args.dy) > 2000) throw new Error('Invalid wheel');
      observationEpoch++; revision++; cursor = undefined;
      await current.mouse.wheel(0, args.dy);
    } else if (method === 'desktop/key') {
      if (!['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','ControlOrMeta+a'].includes(args.key)) throw new Error('Invalid key');
      observationEpoch++;
      await current.keyboard.press(args.key);
    } else if (method === 'desktop/dialog') {
      const pending = blocked.get(current);
      if (!pending?.dialog) throw new Error('No blocking dialog');
      if (typeof args.accept !== 'boolean') throw new Error('Invalid dialog decision');
      const text = typeof args.promptText === 'string' ? args.promptText.slice(0, 1024) : undefined;
      observationEpoch++; revision++;
      blocked.delete(current);
      if (args.accept) await pending.dialog.accept(text);
      else await pending.dialog.dismiss();
      return { applied: true };
    } else if (method === 'desktop/copy') {
      const text = await current.evaluate(() => {
        const element = document.activeElement;
        if (element instanceof HTMLInputElement && element.type === 'password') return '';
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          return element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0).slice(0, 1048576);
        }
        return (window.getSelection()?.toString() || '').slice(0, 1048576);
      });
      return { text };
    } else throw new Error('Invalid desktop input');
    return { applied: true };
  }
  async function identity() { const current = await page(); return JSON.stringify([pageId(current), current.url(), current.viewportSize(), mode, interruptionEpoch, observationEpoch, navigationEpoch]); }
  return { manual, identity, interrupt: (invalidate = true) => { interruptionEpoch++; if (invalidate) observationEpoch++; }, page, before, after, frame, assertCurrent, resize, setMode, state, policy, changed: () => { observationEpoch++; }, failed: () => { busy = false; } };
}
