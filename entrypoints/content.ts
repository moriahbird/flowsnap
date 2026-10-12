import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createChangeDetector } from '@/utils/changeDetector';
import {
  PANEL_POSITION_KEY,
  type Gap,
  type HelloReply,
  type PrepareReply,
  type ToBackground,
  type ToPage,
  type ViewInfo,
} from '@/utils/messages';

declare global {
  interface Window {
    /** The copy of FlowSnap running on this page, if any. */
    __flowsnap?: RunningCopy;
  }
}

interface RunningCopy {
  /** Whether this copy can still reach the extension. False once FlowSnap is reloaded or removed. */
  alive(): boolean;
  /** Stop recording on this page and remove the panel. */
  end(): void;
}

/** How often a copy checks whether it has been replaced by a reloaded FlowSnap. */
const ALIVE_CHECK_MS = 1000;

/**
 * Keep the panel above everything on the page, including dialogs and popovers that sites open in
 * the browser's top layer, which would otherwise cover it whatever its z-index.
 *
 * The panel goes in the top layer too, as a popover, and is brought back to the front whenever the
 * site opens something there. While a site shows a modal dialog, the browser makes everything
 * outside it unclickable, so the panel moves inside the dialog until it closes. It stays where it
 * was on screen: things in the top layer are placed against the window, not their parent.
 *
 * Returns a function that stops.
 */
function keepOnTop(host: HTMLElement) {
  host.popover = 'manual';
  const raise = () => {
    // Inside the topmost modal dialog if there is one, so it stays clickable.
    const modals = document.querySelectorAll('dialog:modal');
    const parent = modals[modals.length - 1] ?? document.documentElement;
    if (host.parentElement !== parent || !host.isConnected) parent.append(host);
    // Showing it again puts it at the front of the top layer.
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  };
  raise();

  // Something opened or closed in the top layer, or the dialog holding the panel was removed.
  let queued = false;
  const check = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      raise();
    });
  };
  const onToggle = (e: Event) => {
    if (e.target !== host) check();
  };
  document.addEventListener('toggle', onToggle, true);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target !== host) return check();
      if (r.type === 'childList' && !host.isConnected) return check();
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  return () => {
    document.removeEventListener('toggle', onToggle, true);
    observer.disconnect();
    if (host.matches(':popover-open')) host.hidePopover();
  };
}

/** Capture the next part of a tall screen once the user has stopped scrolling for this long. */
const SLICE_SETTLE_MS = 250;
/**
 * A scroll this soon after the user's own scrolling input (the wheel or trackpad, touch, scrolling
 * keys, or dragging a scrollbar) is theirs. Any other scroll is the page moving itself, like a chat
 * scrolling down to its newest message, which doesn't grow the screen: it's a change on the page.
 */
const USER_SCROLL_MS = 1000;
/** Keys that scroll the page when they aren't typing into something. */
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);
/** Only capture a new part once at least this much (in CSS pixels) hasn't been captured yet. */
const SLICE_MIN_NEW = 40;
/**
 * While scrolling, capture without waiting for the user to stop once this share of a window of new
 * page is showing. Captures are limited to about two a second, so very fast scrolling can still
 * skip a part, which shows as a white gap.
 */
const SLICE_EARLY = 0.5;
/** After the user stops scrolling this long, skipped parts of the screen are filled in. */
const FILL_AFTER_MS = 700;
/** Filling in: at most this many parts at a time, waiting this long after each scroll for the page to settle. */
const FILL_MAX_PARTS = 12;
const FILL_SCROLL_SETTLE_MS = 120;
/** Filling in: how long to wait for each part to be captured, and for the screen's gaps to update after it. */
const FILL_PART_MAX_MS = 3000;
const FILL_GAPS_WAIT_MS = 1500;
const FILL_NOTE = 'Filling in parts of the page that were skipped…';
const FILL_LEFT_NOTE = 'Part of the page was skipped. Scroll back over it to fill it in.';

/** A part thrown away because the page moved is asked for again at most this many times in a row. */
const SLICE_RETRIES = 3;
/** Ask for a part again if no answer has come after this long. */
const SLICE_ANSWER_MS = 3000;

/**
 * A panel inside the page that scrolls on its own, like the options beside a product's picture,
 * counts once it's at least this share of the window's width and height. Smaller ones (menus,
 * lists) don't change what the screen looks like enough to matter.
 */
const INNER_SCROLLER_MIN_W = 0.25;
const INNER_SCROLLER_MIN_H = 0.5;
/** Re-capture the screen once such a panel has stopped for this long, having moved this far. */
const INNER_SCROLL_SETTLE_MS = 400;
const INNER_SCROLL_MIN = 40;

/** Before capturing a part of a tall screen, wait this long for it to paint, and no longer than the next for its images. */
const PART_PAINT_MS = 120;
const PART_READY_MAX_MS = 800;

/** Once the page looks ready, capture it. Never wait longer than this. */
const READY_MAX_MS = 1500;
/** The page looks ready once nothing has changed for this long. */
const READY_QUIET_MS = 250;

/** After the page scrolls, ignore changes reported by frames embedded in it for this long. */
const FRAME_SCROLL_IGNORE_MS = 1500;

/** After a screen change, ignore a frame reporting the same change for this long. */
const FRAME_CHANGE_DEDUPE_MS = 700;

/**
 * Sent from an embedded frame up to its parent: a click (position in the sender's viewport,
 * in CSS pixels), another action, or a screen change inside it. Parents add the frame's
 * offset and pass it up until it reaches the main page.
 */
type FrameReport =
  | { __flowsnap: 'click'; x: number; y: number; primary: boolean }
  | { __flowsnap: 'action' }
  | { __flowsnap: 'change'; settled: boolean };

/**
 * While recording, runs on every page and every frame inside it as soon as its content is
 * there. On the recorded tab's main page it captures the page once it looks ready, reports
 * clicks, spots in-page screen changes and shows the recording panel. In frames inside the page
 * (like some dialogs) it watches for clicks and changes and reports them to the main page. In other tabs it does nothing.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main(ctx) {
    // The background may also inject this on a page where it already started.
    const previous = window.__flowsnap;
    if (previous?.alive()) return;
    // A copy left over from before FlowSnap was reloaded. Remove it and take over.
    previous?.end();
    window.__flowsnap = { alive: isAlive, end: () => {} };
    void start(ctx);
  },
});

async function start(ctx: ContentScriptContext) {
  const hello = (await browser.runtime
    .sendMessage({ type: 'hello' } satisfies ToBackground)
    .catch(() => undefined)) as HelloReply | undefined;
  if (!hello?.recording) {
    window.__flowsnap = undefined;
    return;
  }
  if (window === window.top) record(ctx, hello.screenCount, hello.ownScreenPending);
  else recordFrame(ctx);
}

function isAlive() {
  try {
    return !!browser.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Run `teardown` when the recording stops, or when this copy of FlowSnap is replaced (the
 * extension was reloaded or updated while the page was open). Without the second, the old copy's
 * panel would stay on the page next to the new one's.
 */
function onEnd(ctx: ContentScriptContext, teardown: () => void) {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(aliveCheck);
    teardown();
    try {
      browser.runtime.onMessage.removeListener(onMessage);
    } catch {
      // This copy was replaced and can't reach the extension any more. Nothing to remove.
    }
    if (window.__flowsnap === self) window.__flowsnap = undefined;
  };
  const self: RunningCopy = { alive: isAlive, end };
  window.__flowsnap = self;
  const onMessage = (msg: ToPage) => {
    if (msg.type === 'stop') end();
    return false;
  };
  browser.runtime.onMessage.addListener(onMessage);
  // WXT tells this copy when a newer one starts. Chrome doesn't always pass that along between
  // copies, so also check for being cut off from the extension.
  ctx.onInvalidated(end);
  const aliveCheck = setInterval(() => {
    if (!isAlive()) end();
  }, ALIVE_CHECK_MS);
}

/** Inside an embedded frame: report clicks, Enter and screen changes to the parent. */
function recordFrame(ctx: ContentScriptContext) {
  const report = (r: FrameReport) => window.parent.postMessage(r, '*');
  // Nothing of FlowSnap's is shown in a frame, so there's nothing to ignore.
  const detector = createChangeDetector({
    ignore: document.createElement('span'),
    onMeaningfulChange: (_reason, settled) => report({ __flowsnap: 'change', settled }),
  });
  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || (e.button !== 0 && e.button !== 1)) return;
    if (e.button === 0) detector.interaction();
    report({ __flowsnap: 'click', x: e.clientX, y: e.clientY, primary: e.button === 0 });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    detector.interaction();
    report({ __flowsnap: 'action' });
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  // Frames inside this one report here. Pass them up.
  const stopRelay = listenToChildFrames(report);

  onEnd(ctx, () => {
    detector.stop();
    stopRelay();
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
  });
}

/**
 * Listen for reports from frames embedded in this page. Click positions are converted from
 * the frame's viewport to this page's viewport. Returns a function that stops listening.
 */
function listenToChildFrames(onReport: (r: FrameReport) => void) {
  const onMessage = (e: MessageEvent) => {
    const r = e.data as FrameReport | undefined;
    if (!r || typeof r !== 'object' || !('__flowsnap' in r)) return;
    // Only accept reports from frames actually embedded in this page.
    const frame = [...document.querySelectorAll('iframe, frame')].find(
      (f) => (f as HTMLIFrameElement).contentWindow === e.source,
    );
    if (!frame) return;
    if (r.__flowsnap === 'click') {
      const rect = frame.getBoundingClientRect();
      onReport({ ...r, x: r.x + rect.left + frame.clientLeft, y: r.y + rect.top + frame.clientTop });
    } else {
      onReport(r);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

function record(ctx: ContentScriptContext, screenCount: number, ownScreenPending: boolean) {
  // Clicks are saved against the screen that's showing. A new key means a new screen.
  let screenKey = crypto.randomUUID();
  let lastNewScreenAt = 0;
  /** When the page last scrolled, to ignore what embedded frames report while it does. */
  let lastPageScrollAt = 0;
  const newScreen = () => {
    screenKey = crypto.randomUUID();
    lastNewScreenAt = Date.now();
    send({ type: 'capture-request' });
  };
  // The screen showing finished filling in (a reply streamed in, a skeleton loaded). Same screen,
  // so its capture is replaced rather than added as another.
  const updateScreen = () => send({ type: 'capture-request', replace: true });

  const panel = createPanel({
    onFinish: () => send({ type: 'finish' }),
    onCaptureExtra: () => {
      detector.reset();
      newScreen();
    },
  });
  // On the page a tab starts recording on, take the screenshot first and only then show the
  // panel, so it opens with that screen already in it and doesn't blink for the capture.
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  /** Shows the page's pinned things again after a tall screen's part was captured. */
  let unpin: (() => void) | undefined;
  if (ownScreenPending) {
    panel.hide();
    // If the capture doesn't happen (say the tab isn't in front), show the panel anyway.
    revealTimer = setTimeout(() => panel.show(), 3000);
  }
  document.documentElement.append(panel.host);
  const stopKeepingOnTop = keepOnTop(panel.host);
  const opensWith = screenCount + (ownScreenPending ? 1 : 0);
  panel.setCount(opensWith);
  let shownCount = screenCount;

  const detector = createChangeDetector({
    ignore: panel.host,
    onMeaningfulChange: (reason, settled) => {
      // Shown in the page's console, to check why a screen was captured.
      console.info(`FlowSnap: ${settled ? 'updated screen' : 'new screen'}, ${reason}`);
      if (settled) updateScreen();
      else newScreen();
    },
  });

  const onClick = (x: number, y: number, primary: boolean) => {
    // This may finish judging the previous click first, starting a new screen,
    // so the click below is saved against the screen it was actually made on.
    if (primary) detector.interaction();
    send({ type: 'click', screenKey, x: x / window.innerWidth, y: y / window.innerHeight, pageY: y + scrollPosition() });
  };
  const onPointerDown = (e: PointerEvent) => {
    // Left click, or middle click (which opens links in a new tab).
    if (!e.isPrimary || (e.button !== 0 && e.button !== 1)) return;
    if (e.composedPath().includes(panel.host)) return;
    onClick(e.clientX, e.clientY, e.button === 0);
  };

  // Clicks and changes inside embedded frames, like some dialogs.
  const stopFrames = listenToChildFrames((r) => {
    if (r.__flowsnap === 'click') onClick(r.x, r.y, r.primary);
    else if (r.__flowsnap === 'action') detector.interaction();
    // Frames embedded in a page (ads, videos, social posts) change as the page scrolls past them, and
    // can't tell it's scrolling. That's the user reading on, not a new screen.
    else if (Date.now() - lastPageScrollAt < FRAME_SCROLL_IGNORE_MS) return;
    else if (r.settled) updateScreen();
    else if (Date.now() - lastNewScreenAt > FRAME_CHANGE_DEDUPE_MS) {
      // A change inside a frame. Skip it if this page just captured the same change.
      detector.reset();
      newScreen();
    }
  });
  const onKeyDown = (e: KeyboardEvent) => {
    // Enter submits forms and activates links. Ordinary typing is ignored.
    if (e.key === 'Enter' && !e.composedPath().includes(panel.host)) detector.interaction();
  };
  // Capture phase, so actions are seen even if the site stops them from spreading.
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);

  // Scrolling past what's been captured, down or up: once the user stops, capture what's showing
  // and add it to the screen, which grows into a tall one.
  // What's covered only grows once a part is actually added. One part is asked for at a time; a
  // part thrown away (the page moved while it was captured) is asked for again a few times at most.
  let covered: { screenKey: string; top?: number; bottom: number } | undefined;
  let sliceTimer: ReturnType<typeof setTimeout> | undefined;
  let sliceAsked: ReturnType<typeof setTimeout> | undefined;
  let missedInRow = 0;
  /** Parts of the current tall screen skipped by scrolling too fast, to fill in by scrolling back. */
  let gaps: { screenKey: string; list: Gap[] } | undefined;
  // `scrolled`: asked because the user scrolled, which is when scrolling back over a skipped part
  // fills it in. Asked after a capture, only new parts above or below count.
  const askForSlice = (scrolled = true) => {
    if (!covered || covered.screenKey !== screenKey || sliceAsked) return;
    const top = scrollPosition();
    const bottom = top + window.innerHeight;
    const down = bottom > covered.bottom + SLICE_MIN_NEW;
    const up = covered.top !== undefined && top < covered.top - SLICE_MIN_NEW;
    const gap =
      scrolled &&
      gaps?.screenKey === screenKey &&
      gaps.list.some((g) => Math.min(g.to, bottom) - Math.max(g.from, top) >= SLICE_MIN_NEW);
    if (!down && !up && !gap) return;
    // If no answer comes (the tab went to the background), ask again on the next scroll.
    sliceAsked = setTimeout(() => (sliceAsked = undefined), SLICE_ANSWER_MS);
    send({ type: 'capture-slice' });
  };
  // A panel scrolled on its own, not the whole page (like the options beside a product's picture):
  // once it stops, the screen is captured again as it now looks, so the clicks made on it land on
  // what was there. The page's own scrolling grows a tall screen instead (above).
  let innerAtCapture = new WeakMap<Element, number>();
  let innerTimer: ReturnType<typeof setTimeout> | undefined;
  const onInnerScroll = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < window.innerWidth * INNER_SCROLLER_MIN_W || r.height < window.innerHeight * INNER_SCROLLER_MIN_H) return;
    if (!innerAtCapture.has(el)) innerAtCapture.set(el, el.scrollTop);
    clearTimeout(innerTimer);
    innerTimer = setTimeout(() => {
      if (!el.isConnected || Math.abs(el.scrollTop - (innerAtCapture.get(el) ?? 0)) < INNER_SCROLL_MIN) return;
      innerAtCapture.set(el, el.scrollTop);
      updateScreen();
    }, INNER_SCROLL_SETTLE_MS);
  };
  /*
   * Parts skipped by scrolling too fast are filled in automatically: once the user stops, the page
   * is scrolled to each skipped part, it's captured, and the page goes back to where they were. A
   * scroll, click or key from the user stops it at once, leaving them where they are.
   */
  let filling = false;
  let fillTimer: ReturnType<typeof setTimeout> | undefined;
  let captureDone: (() => void) | undefined;
  let gapsArrived: (() => void) | undefined;
  const fillGapsNow = async () => {
    const key = screenKey;
    const missing = () => (gaps?.screenKey === key ? gaps.list : []);
    if (filling || sliceAsked || !missing().length) return;
    filling = true;
    const home = scrollPosition();
    let interrupted = false;
    const stop = () => (interrupted = true);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const type of events) window.addEventListener(type, stop, { capture: true, passive: true });
    panel.showNote(FILL_NOTE, true);
    for (let i = 0; i < FILL_MAX_PARTS && !interrupted && screenKey === key; i++) {
      const next = [...missing()].sort((a, b) => a.from - b.from)[0];
      if (!next) break;
      // Its top a little below the top of the window, clear of any header pinned there.
      scrollToPosition(Math.max(0, next.from - window.innerHeight * 0.25));
      await sleep(FILL_SCROLL_SETTLE_MS);
      if (interrupted) break;
      const done = new Promise<void>((resolve) => (captureDone = resolve));
      const updated = new Promise<void>((resolve) => (gapsArrived = resolve));
      send({ type: 'capture-slice' });
      await Promise.race([done, sleep(FILL_PART_MAX_MS)]);
      await Promise.race([updated, sleep(FILL_GAPS_WAIT_MS)]);
      // Nothing of it could be filled (it's under a pinned header, say): don't try it again.
      const still = missing().find((g) => g.from === next.from && g.to === next.to);
      if (still) break;
    }
    for (const type of events) window.removeEventListener(type, stop, { capture: true });
    if (!interrupted) scrollToPosition(home);
    // Let the scroll back settle before the page's own scroll handling resumes.
    await sleep(FILL_SCROLL_SETTLE_MS);
    filling = false;
    if (missing().length) panel.showNote(FILL_LEFT_NOTE);
    else panel.hideNote();
  };

  // When the user last scrolled, so the page scrolling itself can be told apart.
  let userScrollAt = 0;
  let draggingScrollbar = false;
  const onUserScroll = () => (userScrollAt = Date.now());
  const onScrollKey = (e: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(e.key)) return;
    const target = e.composedPath()[0];
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    onUserScroll();
  };
  // Pressing on a scrollbar: the press lands on what scrolls, beside its content.
  const onScrollbarDown = (e: PointerEvent) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const box = el === document.documentElement ? null : el.getBoundingClientRect();
    const right = box ? box.left + el.clientLeft + el.clientWidth : document.documentElement.clientWidth;
    const bottom = box ? box.top + el.clientTop + el.clientHeight : document.documentElement.clientHeight;
    if (e.clientX >= right || e.clientY >= bottom) draggingScrollbar = true;
  };
  const onScrollbarUp = () => {
    if (draggingScrollbar) onUserScroll();
    draggingScrollbar = false;
  };
  const userScrolling = () => draggingScrollbar || Date.now() - userScrollAt < USER_SCROLL_MS;
  for (const type of ['wheel', 'touchmove'] as const) window.addEventListener(type, onUserScroll, { capture: true, passive: true });
  window.addEventListener('keydown', onScrollKey, true);
  window.addEventListener('pointerdown', onScrollbarDown, true);
  window.addEventListener('pointerup', onScrollbarUp, true);

  const onScroll = (e: Event) => {
    // FlowSnap's own scrolling while it fills in skipped parts.
    if (filling) return;
    // The page scrolling itself (a chat moving to its newest message, a form jumping to an error):
    // not the user reading on, so it doesn't add to the screen. Whatever changed is a new screen.
    if (!userScrolling()) {
      lastPageScrollAt = Date.now();
      return;
    }
    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => void fillGapsNow(), FILL_AFTER_MS);
    const el = e.target;
    if (el instanceof Element && el !== document.scrollingElement && el !== pageScroller()) onInnerScroll(el);
    lastPageScrollAt = Date.now();
    clearTimeout(sliceTimer);
    // Scrolling fast: capture before a whole window of new page has gone by, so nothing is skipped.
    const position = scrollPosition();
    const ahead =
      covered && covered.screenKey === screenKey
        ? Math.max(position + window.innerHeight - covered.bottom, covered.top === undefined ? 0 : covered.top - position)
        : 0;
    if (ahead > window.innerHeight * SLICE_EARLY) askForSlice();
    else sliceTimer = setTimeout(askForSlice, SLICE_SETTLE_MS);
  };
  // Captured on the document, so scrolling inside an inner panel is seen too (scroll events
  // don't bubble).
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  const onMessage = (msg: ToPage, _sender: unknown, sendResponse: (reply?: PrepareReply) => void) => {
    switch (msg.type) {
      case 'prepare-capture':
        // Not shown again by the first capture's safety timer while this capture is being taken.
        clearTimeout(revealTimer);
        panel.hide();
        // Things pinned in place (a sticky order summary, a chat button) belong in a screen once, in
        // its first capture. Any later capture of the same screen taken scrolled away from where it
        // started (a part added to a tall screen, or a part redrawn after the page finished
        // loading) hides them, so they aren't repeated down the screen.
        {
          const position = scrollPosition();
          const sameScreen = covered?.screenKey === screenKey;
          const away = sameScreen && Math.abs(position - (covered!.top ?? 0)) > 1;
          const hide = !!msg.slice || away;
          console.info(
            `FlowSnap: preparing capture (${msg.slice ? 'added part' : msg.refresh ? 'redraw' : 'screen'}), scrolled to ${Math.round(position)}, screen starts at ${sameScreen ? Math.round(covered!.top ?? 0) : 'new'}, ${hide ? 'hiding' : 'keeping'} pinned elements`,
          );
          if (hide) unpin = hidePinned(panel.host);
        }
        // Measured once FlowSnap's panel is hidden, so it's never mistaken for a fixed footer. A
        // part added to a tall screen first waits (briefly) for what's now in view to be drawn:
        // scrolling fast, images still loading and parts the browser hasn't painted yet would
        // otherwise be captured blank.
        void (msg.slice ? waitForPartDrawn() : Promise.resolve())
          .then(waitForRepaint)
          .then(() => sendResponse({ screenKey, view: viewInfo(panel.host) }));
        return true; // Reply asynchronously.
      case 'current-screen':
        sendResponse({ screenKey, scrollY: scrollPosition() });
        break;
      case 'note':
        panel.showNote(msg.text);
        break;
      case 'capture-done':
        clearTimeout(revealTimer);
        unpin?.();
        unpin = undefined;
        panel.show();
        captureDone?.();
        captureDone = undefined;
        clearTimeout(sliceAsked);
        sliceAsked = undefined;
        // A part thrown away: try again once the page settles, but not forever.
        if (msg.missed) {
          missedInRow += 1;
          clearTimeout(sliceTimer);
          if (missedInRow <= SLICE_RETRIES) sliceTimer = setTimeout(askForSlice, SLICE_SETTLE_MS);
        } else if (msg.covered) missedInRow = 0;
        // Grows what's covered, for the same screen: a part captured further up or down adds to it.
        if (msg.covered) {
          const same = covered?.screenKey === msg.covered.screenKey ? covered : undefined;
          const tops = [same?.top, msg.covered.top].filter((t): t is number => t !== undefined);
          covered = {
            screenKey: msg.covered.screenKey,
            top: tops.length ? Math.min(...tops) : undefined,
            bottom: Math.max(same?.bottom ?? 0, msg.covered.bottom),
          };
        }
        // Inner panels are measured from where they are in this capture.
        innerAtCapture = new WeakMap();
        // Scrolled on past this part while it was captured: ask for the next once things settle.
        if (msg.covered && !msg.missed) {
          clearTimeout(sliceTimer);
          sliceTimer = setTimeout(() => askForSlice(false), SLICE_SETTLE_MS);
        }
        break;
      case 'gaps':
        gaps = { screenKey: msg.screenKey, list: msg.gaps };
        gapsArrived?.();
        gapsArrived = undefined;
        break;
      case 'status':
        shownCount = msg.screenCount;
        panel.setCount(Math.max(msg.screenCount, opensWith));
        break;
    }
    return false;
  };
  browser.runtime.onMessage.addListener(onMessage);
  onEnd(ctx, () => {
    detector.stop();
    stopFrames();
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onScroll, { capture: true });
    for (const type of ['wheel', 'touchmove'] as const) window.removeEventListener(type, onUserScroll, { capture: true });
    window.removeEventListener('keydown', onScrollKey, true);
    window.removeEventListener('pointerdown', onScrollbarDown, true);
    window.removeEventListener('pointerup', onScrollbarUp, true);
    clearTimeout(sliceTimer);
    try {
      browser.runtime.onMessage.removeListener(onMessage);
    } catch {
      // This copy was replaced and can't reach the extension any more. Nothing to remove.
    }
    stopKeepingOnTop();
    panel.host.remove();
  });

  // A page that was already open when recording started, or when its tab was added, is loaded,
  // so capture it straight away. A page that's still loading is captured once it looks ready.
  // If it keeps loading after that (a skeleton filling in), capture the loaded page too.
  const ready = document.readyState === 'complete' ? Promise.resolve() : waitUntilLooksReady();
  void ready.then(() => {
    send({ type: 'page-info', siteName: declaredSiteName() });
    send({ type: 'capture-request' });
    detector.followUp();
  });
}

/**
 * Where the page is scrolled to, and how tall any header or footer is that stays fixed at the top
 * or bottom of the window as it scrolls, so tall screens show them only once.
 */
/**
 * Hide everything pinned in place on the page (fixed, or sticky and stuck) other than bars across
 * the top or bottom, which tall screens already show once. Returns a function that shows them
 * again, which also runs by itself after a few seconds in case the capture never finishes.
 */
function hidePinned(ignore: Element) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Hidden with opacity, which nothing inside can override (a child can turn visibility back on),
  // with transitions off so it's gone at once rather than fading out during the capture.
  const props = ['opacity', 'visibility', 'transition'] as const;
  const values: Record<(typeof props)[number], string> = { opacity: '0', visibility: 'hidden', transition: 'none' };
  const hidden: { el: HTMLElement; before: [string, string][] }[] = [];
  // The page, and the self-contained parts some widgets build themselves in (open shadow roots).
  const roots: Node[] = [document.body];
  for (let i = 0; i < roots.length; i++) {
    const walker = document.createTreeWalker(roots[i]!, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node as HTMLElement;
      if (el.shadowRoot && !ignore.contains(el)) roots.push(el.shadowRoot);
      if (ignore.contains(el) || !(el instanceof HTMLElement)) continue;
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      // Not showing, or too small to matter.
      if (r.width < 40 || r.height < 40 || r.bottom <= 0 || r.top >= height || r.right <= 0 || r.left >= width) continue;
      // Sticky but not stuck to the top or bottom right now: part of the page, like a table's first
      // column that stays put when the table scrolls sideways.
      if (position === 'sticky' && !stuckVertically(el, r)) continue;
      // A bar across the top or bottom: kept, as tall screens already show it just once.
      if (r.width >= width * 0.5 && r.height <= height * 0.4 && (r.top <= 1 || r.bottom >= height - 1)) continue;
      // Covering most of the window: some sites hold their whole page in one. Never hidden.
      if (r.width >= width * 0.9 && r.height >= height * 0.9) continue;
      hidden.push({ el, before: props.map((p) => [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]) });
      for (const p of props) el.style.setProperty(p, values[p], 'important');
      // Everything inside it is hidden with it.
      walker.currentNode = lastDescendant(el);
    }
  }
  // Shown in the page's console, to check what was kept out of a tall screen's added part.
  console.info(
    `FlowSnap: hid ${hidden.length} pinned element(s) for this part`,
    hidden.map((h) => h.el),
  );
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    clearTimeout(safety);
    for (const h of hidden) props.forEach((p, i) => h.el.style.setProperty(p, h.before[i]![0], h.before[i]![1]));
  };
  const safety = setTimeout(show, 3000);
  return show;
}

/**
 * Whether a sticky element is stuck to the top or bottom of what it scrolls in, so it stays in view
 * as the page scrolls (rather than sitting where it would anyway, or sticking only sideways).
 */
function stuckVertically(el: HTMLElement, r: DOMRect) {
  const style = getComputedStyle(el);
  if (style.top === 'auto' && style.bottom === 'auto') return false;
  // What it sticks within: the nearest part of the page that scrolls up and down, or the window.
  let top = 0;
  let bottom = window.innerHeight;
  for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const overflow = getComputedStyle(a).overflowY;
    if (overflow === 'visible' || overflow === 'clip') continue;
    const box = a.getBoundingClientRect();
    top = box.top;
    bottom = box.bottom;
    break;
  }
  if (style.top !== 'auto' && Math.abs(r.top - (top + parseFloat(style.top))) <= 2) return true;
  if (style.bottom !== 'auto' && Math.abs(r.bottom - (bottom - parseFloat(style.bottom))) <= 2) return true;
  return false;
}

function lastDescendant(el: Element): Element {
  let last = el;
  while (last.lastElementChild) last = last.lastElementChild;
  return last;
}

function viewInfo(ignore: Element): ViewInfo {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scroller = pageScroller();
  let header = 0;
  let footer = 0;
  // An inner panel that scrolls: whatever's above or below it in the window stays put.
  if (scroller && scroller !== document.scrollingElement) {
    const r = scroller.getBoundingClientRect();
    header = Math.max(0, r.top);
    footer = Math.max(0, height - r.bottom);
  }
  const pinned = (x: number, y: number) => {
    const found = new Set<Element>();
    for (const el of document.elementsFromPoint(x, y)) {
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        if (found.has(a) || ignore.contains(a)) continue;
        found.add(a);
        const position = getComputedStyle(a).position;
        if (position !== 'fixed' && position !== 'sticky') continue;
        const r = a.getBoundingClientRect();
        // A bar across most of the window, against its top or bottom edge.
        if (r.width < width * 0.5 || r.height > height * 0.4) continue;
        if (r.top <= 1) header = Math.max(header, r.bottom);
        if (r.bottom >= height - 1) footer = Math.max(footer, height - r.top);
      }
    }
  };
  for (const x of [width * 0.25, width * 0.5, width * 0.75]) {
    pinned(x, 2);
    pinned(x, height - 2);
  }
  const position = scrollPosition();
  const atBottom = scroller ? position + scroller.clientHeight >= scroller.scrollHeight - 2 : true;
  return {
    scrollY: position,
    viewportHeight: height,
    header: Math.round(header),
    footer: Math.round(footer),
    atBottom,
  };
}

/**
 * What scrolls the page: the window, or on sites that scroll an inner panel instead (like Figma's),
 * that panel, if it fills most of the window. Null if the page doesn't scroll.
 */
function pageScroller(): Element | null {
  // Asked on every scroll event, so the answer is kept for a moment.
  if (scrollerCache && Date.now() - scrollerCache.at < SCROLLER_CACHE_MS && scrollerCache.el?.isConnected !== false) {
    return scrollerCache.el;
  }
  const el = findPageScroller();
  scrollerCache = { el, at: Date.now() };
  return el;
}

let scrollerCache: { el: Element | null; at: number } | undefined;
const SCROLLER_CACHE_MS = 1000;

function findPageScroller(): Element | null {
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollHeight > window.innerHeight + 1 && scrolls(document.body) && scrolls(root)) return root;
  for (const el of document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2)) {
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
      if (a.scrollHeight <= a.clientHeight + 1 || !scrolls(a, true)) continue;
      const r = a.getBoundingClientRect();
      if (r.height >= window.innerHeight * 0.7 && r.width >= window.innerWidth * 0.7) return a;
    }
  }
  return null;
}

/** Whether an element lets its content scroll vertically (`own`: it scrolls itself). */
function scrolls(el: Element, own = false) {
  const overflow = getComputedStyle(el).overflowY;
  return own ? overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay' : overflow !== 'hidden' && overflow !== 'clip';
}

/** Scroll the page (whatever scrolls it) to `top`, at once rather than smoothly. */
function scrollToPosition(top: number) {
  const scroller = pageScroller();
  if (!scroller || scroller === document.scrollingElement) window.scrollTo({ top, behavior: 'instant' });
  else scroller.scrollTo({ top, behavior: 'instant' });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** How far the page is scrolled down, whatever scrolls it. */
function scrollPosition() {
  const scroller = pageScroller();
  return !scroller || scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
}

/** What the website calls itself, if it says: its og:site_name or application-name tag. */
function declaredSiteName() {
  const tag = document.querySelector<HTMLMetaElement>(
    'meta[property="og:site_name"], meta[name="application-name"], meta[name="apple-mobile-web-app-title"]',
  );
  return tag?.content.trim() ?? '';
}

/**
 * Resolves once the page looks ready to capture: nothing has moved for a moment, and the images
 * and fonts in view have loaded. Ads and trackers further down don't hold it up.
 */
function waitUntilLooksReady() {
  const quiet = new Promise<void>((resolve) => {
    let timer = setTimeout(done, READY_QUIET_MS);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, READY_QUIET_MS);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const giveUp = setTimeout(done, READY_MAX_MS);
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(giveUp);
      resolve();
    }
  });
  const images = Promise.all(
    [...document.images]
      .filter((img) => !img.complete && isInView(img))
      .map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
      ),
  );
  const ready = Promise.all([quiet, images, document.fonts.ready]);
  const giveUp = new Promise((resolve) => setTimeout(resolve, READY_MAX_MS));
  return Promise.race([ready, giveUp]);
}

/**
 * After scrolling to a new part of a page: wait for the images now in view to load and the browser
 * to paint it, but never long, so capturing keeps up with someone scrolling.
 */
function waitForPartDrawn() {
  const images = Promise.all(
    [...document.images]
      .filter((img) => !img.complete && isInView(img))
      .map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
      ),
  );
  // A moment for the browser to finish painting what scrolled into view.
  const painted = new Promise((resolve) => setTimeout(resolve, PART_PAINT_MS));
  const giveUp = new Promise((resolve) => setTimeout(resolve, PART_READY_MAX_MS));
  return Promise.race([Promise.all([images, painted]), giveUp]);
}

function isInView(el: Element) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

function send(msg: ToBackground) {
  try {
    void browser.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // FlowSnap was reloaded or removed since this page started, so this copy can't reach it.
    // Chrome throws straight away rather than rejecting. Nothing to do: the new copy takes over.
  }
}

/** Wait until the page has painted without the panel, so it can't appear in the screenshot. */
function waitForRepaint() {
  const frames = new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))),
  );
  // Animation frames pause in background tabs. Don't wait forever.
  const fallback = new Promise<void>((resolve) => setTimeout(resolve, 200));
  return Promise.race([frames, fallback]);
}

/** Space kept between the panel and the window's edges, in CSS pixels. */
const PANEL_MARGIN = 16;
/** The panel never shrinks below this to fit a narrow window, so it stays readable. */
const MIN_PANEL_ZOOM = 0.6;

/**
 * Remove any FlowSnap panel on the page other than `keep`. When the extension is reloaded, the old
 * copy's panel doesn't always go away in time, and nothing would hide it for a screenshot.
 */
function removeOtherPanels(keep?: Element) {
  for (const el of document.querySelectorAll('flowsnap-panel')) if (el !== keep) el.remove();
}

/** The recording panel: status, screen count and buttons. Isolated from the site's styles. */
function createPanel(options: {
  onFinish: () => void;
  onCaptureExtra: () => void;
}) {
  removeOtherPanels();
  const host = document.createElement('flowsnap-panel');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { --ink: #33002D; --muted: #6E6E73; --line: #DAD5D8; --hover: #F7F5F6; --accent: #8A3B78; --accent-hover: #742F64; }
      .panel {
        position: relative; box-sizing: border-box; height: 56px;
        display: flex; align-items: center;
        padding: 0 10px 0 16px;
        /* The canvas's warm off-white, so the panel feels like part of FlowSnap. */
        background: #F4F3F1; color: var(--ink);
        font: 400 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        border: 1.5px solid var(--line); border-radius: 14px;
        box-shadow: 0 6px 18px rgb(0 0 0 / 0.12);
        user-select: none; white-space: nowrap;
      }
      .status { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 12.5px; margin-right: 14px; color: var(--accent); }
      .dot { position: relative; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
      .dot::after {
        content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--accent);
        animation: live 2s ease-out infinite;
      }
      @keyframes live { 0% { transform: scale(1); opacity: 0.45; } 70%, 100% { transform: scale(2.4); opacity: 0; } }
      svg { display: block; overflow: visible; }
      @media (prefers-reduced-motion: reduce) {
        .dot::after { animation: none !important; }
      }
      .count { flex: none; min-width: 52px; margin: 0 14px 0 0; color: var(--ink); font-size: 12px; font-variant-numeric: tabular-nums; }
      .count b { font-weight: 600; }
      button {
        all: unset; box-sizing: border-box; cursor: pointer; height: 34px;
        display: inline-flex; align-items: center; gap: 7px; padding: 0 12px;
        border-radius: 8px; font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button svg { width: 16px; height: 16px; flex: none; }
      .capture { color: var(--ink); background: transparent; border: 1.5px solid var(--line); margin-right: 8px; }
      .capture:hover { background: rgb(51 0 45 / 0.05); }
      .stop { color: #FFFFFF; background: var(--accent); }
      .stop:hover { background: var(--accent-hover); }
      .brand { display: flex; align-items: center; margin-left: 10px; padding: 12px 6px; cursor: grab; touch-action: none; }
      .dragging .brand { cursor: grabbing; }
      .grip { display: grid; grid-template-columns: repeat(2, 3px); gap: 3px; }
      .grip i { width: 3px; height: 3px; border-radius: 50%; background: #B5B5B5; transition: background 0.15s; }
      .brand:hover .grip i, .dragging .grip i { background: var(--muted); }
      .wrap { position: relative; }
      .note {
        position: absolute; right: 0; bottom: calc(100% + 8px); width: 280px;
        padding: 10px 12px; border-radius: 10px;
        background: #FFFFFF; color: var(--ink); border: 1.5px solid var(--line);
        box-shadow: 0 4px 16px rgb(0 0 0 / 0.08);
        font: 400 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        white-space: normal;
      }
      .below .note { bottom: auto; top: calc(100% + 8px); }
      .note[hidden] { display: none; }
    </style>
    <div class="wrap">
    <div class="note" hidden></div>
    <div class="panel">
      <span class="status"><span class="dot"></span>Rec</span>
      <span class="count"></span>
      <button type="button" class="capture">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 7h1a2 2 0 0 0 2-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
        Capture Extra Screen
      </button>
      <button type="button" class="stop">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8" />
          <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" />
        </svg>
        Stop Recording
      </button>
      <span class="brand" title="Drag to move">
        <span class="grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
      </span>
    </div>
    </div>
  `;
  const wrap = root.querySelector<HTMLElement>('.wrap')!;
  const box = root.querySelector<HTMLElement>('.panel')!;
  const count = root.querySelector<HTMLElement>('.count')!;
  const note = root.querySelector<HTMLElement>('.note')!;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  root.querySelector('.stop')!.addEventListener('click', options.onFinish);
  root.querySelector('.capture')!.addEventListener('click', options.onCaptureExtra);
  const place = placePanel(host, wrap, root.querySelector<HTMLElement>('.brand')!);

  // In a window narrower than the panel (like a sign-in popup), shrink it to fit.
  const fit = () => {
    if (!host.isConnected) return;
    host.style.zoom = '';
    const room = window.innerWidth - PANEL_MARGIN * 2;
    const width = box.offsetWidth;
    if (width > room) host.style.zoom = String(Math.max(MIN_PANEL_ZOOM, room / width));
    place();
  };
  // Once it's on the page. Not an animation frame: those don't run in a tab in the background.
  setTimeout(fit);
  window.addEventListener('resize', fit);

  return {
    host,
    setCount(n: number) {
      // Just the count: capturing happens on every click, so nothing moves in the panel.
      // The number a little bolder than the word after it.
      const number = document.createElement('b');
      number.textContent = String(n);
      count.replaceChildren(number, ` ${n === 1 ? 'screen' : 'screens'}`);
    },
    /**
     * Hide the panel for a screenshot. Instant, so it's gone for as short a time as possible.
     * A fade would make the blink longer.
     */
    hide() {
      host.style.visibility = 'hidden';
      // There's only ever one panel on a page. Any other is a leftover from before the extension
      // was reloaded, and must not end up in the screenshot.
      removeOtherPanels(host);
    },
    /** Bring the panel back at once: it happens on every capture, so no fade to watch. */
    show() {
      host.style.visibility = '';
    },
    /** Show a note above the panel, for six seconds or, with `stay`, until it's hidden. */
    showNote(text: string, stay = false) {
      note.textContent = text;
      note.hidden = false;
      clearTimeout(noteTimer);
      if (!stay) noteTimer = setTimeout(() => (note.hidden = true), 6000);
    },
    hideNote() {
      clearTimeout(noteTimer);
      note.hidden = true;
    },
  };
}

/**
 * Keep the panel in its corner of what the user can see, at its normal size, and let it be dragged
 * by its handle. It's held by its distance from the right and bottom edges, so it stays in its
 * corner when the window is resized or the page is zoomed with ⌘+. When the user pinches to zoom
 * in on the page, it follows the part of the page they're looking at and stays the same size,
 * rather than being zoomed with the page and left off screen.
 *
 * Moves back to where it was last dragged, so it doesn't jump back to the corner on every new
 * page. It stays invisible until then, so it never shows in the old spot first.
 *
 * Returns a function that places it again, for when its size changes.
 */
function placePanel(host: HTMLElement, box: HTMLElement, handle: HTMLElement) {
  /** Distance from the right and bottom edges of what's visible, in screen pixels. */
  let anchor = { right: PANEL_MARGIN, bottom: PANEL_MARGIN };

  /** What's visible of the page: its position and size in the page's pixels, and the pinch zoom. */
  const view = () => {
    const vv = window.visualViewport;
    return {
      x: vv?.offsetLeft ?? 0,
      y: vv?.offsetTop ?? 0,
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
      scale: vv?.scale ?? 1,
    };
  };

  const place = () => {
    if (!host.isConnected) return;
    const v = view();
    // Undo the pinch zoom, so the panel stays its normal size.
    host.style.transformOrigin = '0 0';
    host.style.transform = v.scale === 1 ? '' : `scale(${1 / v.scale})`;
    const rect = host.getBoundingClientRect();
    const width = rect.width * v.scale;
    const height = rect.height * v.scale;
    // Kept fully on screen.
    anchor = {
      right: Math.min(Math.max(0, anchor.right), v.width * v.scale - width),
      bottom: Math.min(Math.max(0, anchor.bottom), v.height * v.scale - height),
    };
    // `left` and `top` are scaled by the panel's own zoom (in a narrow window), so they're divided by it.
    const zoom = parseFloat(host.style.zoom) || 1;
    host.style.left = `${(v.x + v.width - (width + anchor.right) / v.scale) / zoom}px`;
    host.style.top = `${(v.y + v.height - (height + anchor.bottom) / v.scale) / zoom}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    // Near the top of the screen, notes open below the panel instead of above it.
    box.classList.toggle('below', v.height * v.scale - height - anchor.bottom < 120);
  };

  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...anchor };
    handle.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
    const onMove = (m: PointerEvent) => {
      // Pointer positions are in the page's pixels; the anchor is in screen pixels.
      const { scale } = view();
      anchor = {
        right: start.right - (m.clientX - start.x) * scale,
        bottom: start.bottom - (m.clientY - start.y) * scale,
      };
      place();
    };
    const onUp = () => {
      box.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      // If FlowSnap was reloaded since this page started, the position just isn't remembered.
      // Chrome throws straight away then, rather than rejecting.
      try {
        void browser.storage.local.set({ [PANEL_POSITION_KEY]: anchor }).catch(() => {});
      } catch {}
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });

  // Back to where it was last dragged.
  host.style.opacity = '0';
  void (async () => {
    try {
      const stored = await browser.storage.local.get(PANEL_POSITION_KEY);
      // Older positions were saved by the left and top.
      const saved = stored[PANEL_POSITION_KEY] as
        | { right: number; bottom: number }
        | { left: number; top: number }
        | undefined;
      if (saved && 'right' in saved) {
        anchor = saved;
      } else if (saved) {
        const { width, height } = host.getBoundingClientRect();
        anchor = { right: window.innerWidth - saved.left - width, bottom: window.innerHeight - saved.top - height };
      }
    } catch {
      // FlowSnap was reloaded since this page started. Leave the panel in the corner.
    } finally {
      place();
      host.style.opacity = '';
    }
  })();

  return place;
}
