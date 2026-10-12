/**
 * Decides when a page has changed screens without loading a new page: a single-page app
 * moving to a new view, a modal or dropdown opening, search suggestions appearing, or a
 * tooltip showing on hover.
 *
 * Only changes the user causes count. It watches after a click, Enter, a URL change, or
 * the pointer resting on something. Things that change on their own, like carousels, ads,
 * tickers and spinners, are learned and ignored.
 */

/** Wait this long with no changes before judging what happened. */
const QUIET_MS = 300;
/**
 * Keep watching this long after the user acts, for things that appear late (a confirmation
 * banner after a save) or keep changing. A change found earlier is captured straight away.
 */
const MAX_WAIT_MS = 3000;
/**
 * After a change is captured, the page may keep changing: a reply streaming in, or content
 * filling in after a loading skeleton. Once it's been still this long, the final state replaces
 * that capture, since it's the same screen, finished.
 */
const FOLLOW_UP_QUIET_MS = 1500;
/**
 * Stop waiting for the page to settle after this long. A page that never settles is changing on
 * its own (a live widget, an ad rotating), so nothing is captured then.
 */
const FOLLOW_UP_MAX_MS = 60_000;
/**
 * Changes this soon after a scroll come from the scroll: content loading as it comes into view,
 * or the page sliding under a still pointer. They're not something the user opened.
 */
const SCROLL_SETTLE_MS = 600;
/** Before judging, let things that are fading or sliding in finish, up to this long. */
const ANIMATION_WAIT_MS = 800;
/** Share of the visible page that must change after a click or Enter. Small enough for a dropdown. */
const MIN_COVERAGE_ACTION = 0.012;
/** Share that must change after the pointer rests on something. Small enough for a tooltip. */
const MIN_COVERAGE_HOVER = 0.002;
/**
 * After a hover, only changes within this distance of the pointer count. Tooltips and hover menus
 * open right next to what's pointed at. Animations elsewhere on the page (decorations playing as
 * they scroll into view) aren't something the user opened.
 */
const HOVER_REACH_PX = 120;
/**
 * Something the pointer is over growing by this much counts as a hover change, like a side nav
 * widening to show its labels. A button swelling slightly on hover doesn't.
 */
const HOVER_GROW_PX = 80;
/** How many levels up from what's pointed at are checked for growing. */
const HOVER_GROW_DEPTH = 12;
/** How long the pointer must rest before a hover change is judged. */
const HOVER_DWELL_MS = 300;
/** A click or Enter is what the user is doing for this long, for `userIsIn`. */
const RECENT_ACTION_MS = 5000;
/** Changes with no user action this recently are treated as happening on their own. */
const AUTONOMOUS_AFTER_MS = 1000;
/**
 * Something must change on its own this many times before it's ignored. Carousels, tickers
 * and blinking cursors repeat. A one-off like a "Saving…" banner doesn't, so the same spot
 * still counts when the user's action causes a banner there.
 */
const AUTONOMOUS_REPEATS = 3;
/** The visible page is divided into this grid to measure how much of it changed. */
const GRID_COLS = 64;
const GRID_ROWS = 40;
/** Limits how much work one judgement does on very large changes. */
const MAX_ELEMENTS_PER_CHANGE = 300;
const MAX_ELEMENTS_TOTAL = 4000;
const URL_POLL_MS = 500;

const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const MEDIA_TAGS = new Set([
  'IMG',
  'SVG',
  'VIDEO',
  'CANVAS',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'IFRAME',
]);
/**
 * Carousels are ignored, since many rotate on their own. One the user is clicking through (its
 * arrows, or anything in the same dialog) counts. See `userIsIn`.
 */
const CAROUSEL_SELECTOR =
  '[aria-roledescription="carousel"], [class*="carousel" i], [class*="swiper" i], [class*="slick" i], [class*="slider" i], [class*="marquee" i], [class*="ticker" i]';

type Mode = 'action' | 'hover';

/**
 * How something changed. 'appeared' is new content: added to the page, or unhidden.
 * 'restyled' is an existing element changing its classes or styles, which might reveal
 * something (a menu shown by a class) or might just change a color.
 */
type ChangeKind = 'appeared' | 'restyled';

/** Attribute changes that show or hide an element outright. */
const VISIBILITY_ATTRIBUTES = new Set(['hidden', 'open', 'aria-hidden']);
const HIDDEN_STYLE = /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/;

export interface ChangeDetector {
  /** Call when the user clicks or presses Enter. */
  interaction(): void;
  /**
   * Call after a screen is captured for a reason other than a detected change, like a page
   * load. If the page keeps changing, its final state is captured once it settles.
   */
  followUp(): void;
  /** Forget any change being watched, for example after a manual capture. */
  reset(): void;
  stop(): void;
}

export function createChangeDetector(options: {
  /** FlowSnap's own UI, whose changes are ignored. */
  ignore: Element;
  /**
   * Called with a short, readable reason, for checking why a screen was captured. `settled` means
   * the screen just captured finished filling in, so its capture should be replaced, not added to.
   */
  onMeaningfulChange: (reason: string, settled: boolean) => void;
}): ChangeDetector {
  const { ignore, onMeaningfulChange } = options;

  let mode: Mode | null = null;
  let changed = new Map<Element, ChangeKind>();
  let hovered: Element | null = null;
  /**
   * What the pointer is over and everything around it, with each one's size from when the pointer
   * first went over it. Moving around inside something keeps its first size, so a panel that opens
   * as the pointer enters it, and is then explored, still counts as having grown.
   */
  let hoverSizes = new Map<Element, { width: number; height: number }>();
  let startHref = location.href;
  let lastHref = location.href;
  let lastActionAt = 0;
  let lastMoveAt = 0;
  let lastScrollAt = 0;
  /** Where the pointer last moved to, to tell real movement from the page moving under it. */
  let pointerX: number | null = null;
  let pointerY: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  /** Increases on every new watch, so a judgement that was waiting can tell it's out of date. */
  let watchId = 0;
  /** Changes since the last capture, while waiting for the page to settle. See FOLLOW_UP_QUIET_MS. */
  let following: {
    changed: Map<Element, ChangeKind>;
    quietTimer: ReturnType<typeof setTimeout>;
    maxTimer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** How many times each container has changed on its own. Repeat offenders are ignored. */
  const unpromptedCounts = new WeakMap<Element, number>();
  /** What the user last clicked or pressed Enter on, and when. */
  let actedOn: { el: Element; at: number } | null = null;

  /**
   * Whether a change at `el` is in what the user just clicked: the same dialog, or the carousel
   * whose arrows (often just outside it) they clicked. Changes there are theirs even if the area
   * would otherwise be ignored, like a carousel or something next to a video.
   */
  const userIsIn = (el: Element) => {
    if (!actedOn || Date.now() - actedOn.at > RECENT_ACTION_MS) return false;
    const target = actedOn.el;
    const dialog = el.closest(DIALOG_SELECTOR);
    if (dialog?.contains(target)) return true;
    const carousel = el.closest(CAROUSEL_SELECTOR);
    if (!carousel) return false;
    // Its arrows are often just outside it, up to two levels. Never the whole page, though.
    let around: Element = carousel;
    for (let i = 0; i < 2; i++) {
      const parent: Element | null = around.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      around = parent;
    }
    return around.contains(target);
  };

  const isAutonomous = (el: Element) => {
    if (userIsIn(el)) return false;
    if (el.closest(CAROUSEL_SELECTOR)) return true;
    for (let a: Element | null = el, i = 0; a && i < 5; a = a.parentElement, i++) {
      if ((unpromptedCounts.get(a) ?? 0) >= AUTONOMOUS_REPEATS) return true;
    }
    return false;
  };

  const learnAutonomous = (els: Set<Element>) => {
    for (const el of els) {
      // Never write off the whole page.
      if (el === document.documentElement || el === document.body) continue;
      unpromptedCounts.set(el, (unpromptedCounts.get(el) ?? 0) + 1);
    }
  };

  /** Record one change into `into` (the current watch's changes, or the follow-up's). */
  const collect = (r: MutationRecord, target: Element, into: Map<Element, ChangeKind>) => {
    if (isAutonomous(target) || (nearVideo(target) && !userIsIn(target))) return;
    const note = (el: Element, kind: ChangeKind) => {
      if (into.get(el) !== 'appeared') into.set(el, kind);
    };
    if (r.type === 'childList') {
      for (const node of r.addedNodes) {
        const el = node instanceof Element ? node : node.parentElement;
        if (el && !ignore.contains(el)) note(el, 'appeared');
      }
    } else if (target === document.documentElement || target === document.body) {
      // Sites toggle classes on <html> and <body> for all sorts of small things.
    } else if (r.type === 'characterData') {
      note(target, 'restyled');
    } else if (VISIBILITY_ATTRIBUTES.has(r.attributeName!)) {
      note(target, 'appeared');
    } else if (r.attributeName === 'style' && HIDDEN_STYLE.test(r.oldValue ?? '')) {
      // It was hidden by its inline style before this change.
      note(target, 'appeared');
    } else {
      note(target, 'restyled');
    }
  };

  // Always on: between user actions it learns what changes on its own; during a watch it
  // collects what changed.
  const observer = new MutationObserver((records) => {
    const now = Date.now();
    const scrolling = now - lastScrollAt < SCROLL_SETTLE_MS;
    const unprompted =
      !mode && !following && now - lastActionAt > AUTONOMOUS_AFTER_MS && now - lastMoveAt > HOVER_DWELL_MS;
    // Count each container once per batch, so one burst of changes counts as one occurrence.
    const changedOnTheirOwn = new Set<Element>();
    // Whether new content arrived (text or elements), as opposed to restyling like a blinking cursor.
    let contentArrived = false;
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!target || ignore.contains(target)) continue;
      if (unprompted) {
        changedOnTheirOwn.add(target);
        if (target.parentElement) changedOnTheirOwn.add(target.parentElement);
      } else {
        // A hover is cancelled by scrolling, and content loading as the page scrolls isn't the page
        // still settling after the last capture.
        if (mode && !(mode === 'hover' && scrolling)) collect(r, target, changed);
        if (following && !scrolling) {
          collect(r, target, following.changed);
          if (r.type !== 'attributes' && !isAutonomous(target)) contentArrived = true;
        }
      }
    }
    learnAutonomous(changedOnTheirOwn);
    if (mode) {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => void judge(false), QUIET_MS);
    }
    if (following && contentArrived) {
      clearTimeout(following.quietTimer);
      following.quietTimer = setTimeout(finishFollowUp, FOLLOW_UP_QUIET_MS);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
  });

  function watch(m: Mode) {
    mode = m;
    watchId++;
    lastActionAt = Date.now();
    changed = new Map();
    startHref = location.href;
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    quietTimer = setTimeout(() => void judge(false), QUIET_MS);
    maxTimer = setTimeout(() => void judge(true), MAX_WAIT_MS);
  }

  function endWatch() {
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    mode = null;
  }

  /**
   * Decide whether what changed counts as a new screen. A `final` judgement ends the watch
   * either way. Otherwise, if nothing counts yet, it keeps watching for late changes.
   */
  async function judge(final: boolean) {
    if (!mode) return;
    if (mode === 'hover' && !final && Date.now() - lastMoveAt < HOVER_DWELL_MS) {
      // Still moving. Judge once the pointer rests.
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => void judge(false), HOVER_DWELL_MS);
      return;
    }

    // Let anything fading or sliding in finish first: mid-animation it can look invisible.
    // Skipped when the user has already acted again, so their next action isn't held up.
    if (!final) {
      const id = watchId;
      await animationsSettled();
      if (id !== watchId || !mode) return; // A newer watch took over while waiting.
    }

    // Handle changes the observer hasn't reported yet.
    for (const r of observer.takeRecords()) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (target && !ignore.contains(target)) collect(r, target, changed);
    }
    const urlChanged = location.href !== startHref;
    const grew = mode === 'hover' ? grownUnderPointer() : null;

    // A hover only counts if something new appears, like a tooltip or menu. The hovered
    // element (and what contains it) restyling itself, or anything just changing color, is
    // a hover effect, not a new screen.
    const hover = mode === 'hover';
    const skip = hover && hovered ? hovered : null;
    const min = hover ? MIN_COVERAGE_HOVER : MIN_COVERAGE_ACTION;
    const dialog = !urlChanged && hasVisibleDialog(changed.keys());
    const near = hover && pointerX != null && pointerY != null ? { x: pointerX, y: pointerY } : null;
    const share = urlChanged || dialog ? 0 : coverage(changed, min, skip, hover, near);
    const meaningful = urlChanged || dialog || !!grew || share >= min;
    if (!meaningful && !final) return; // Keep watching for something that appears late.

    endWatch();
    lastActionAt = Date.now();
    lastHref = location.href;
    if (meaningful) {
      const after = hover ? 'pointer rested on something' : 'click or Enter';
      onMeaningfulChange(
        urlChanged
          ? `URL changed (${after})`
          : dialog
            ? `dialog opened (${after})`
            : grew
              ? `something under the pointer grew, like a panel opening (${after})`
              : `${percent(share)} of the page changed (${after})`,
        false,
      );
      // After a click, the page may keep going (a reply streaming in). Capture where it ends up.
      if (!hover) startFollowUp();
    }
  }

  /** Note the size of what the pointer is now over, and what's around it, keeping sizes already noted. */
  function noteHoverSizes(target: Element) {
    const next = new Map<Element, { width: number; height: number }>();
    for (let el: Element | null = target, i = 0; el && i < HOVER_GROW_DEPTH; el = el.parentElement, i++) {
      if (el === document.body || el === document.documentElement) break;
      const r = el.getBoundingClientRect();
      next.set(el, hoverSizes.get(el) ?? { width: r.width, height: r.height });
    }
    hoverSizes = next;
  }

  /**
   * Something under the pointer that has grown by HOVER_GROW_PX since the pointer went over it, or
   * null. Once found, sizes start over from now, so the same panel isn't counted again.
   */
  function grownUnderPointer() {
    let grown: Element | null = null;
    for (const [el, before] of hoverSizes) {
      if (!el.isConnected || nearVideo(el) || !isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width - before.width >= HOVER_GROW_PX || r.height - before.height >= HOVER_GROW_PX) {
        grown = el;
        break;
      }
    }
    if (grown) for (const el of hoverSizes.keys()) {
      const r = el.getBoundingClientRect();
      hoverSizes.set(el, { width: r.width, height: r.height });
    }
    return grown;
  }

  function startFollowUp() {
    cancelFollowUp();
    following = {
      changed: new Map(),
      quietTimer: setTimeout(finishFollowUp, FOLLOW_UP_QUIET_MS),
      maxTimer: setTimeout(cancelFollowUp, FOLLOW_UP_MAX_MS),
    };
  }

  function cancelFollowUp() {
    if (!following) return;
    clearTimeout(following.quietTimer);
    clearTimeout(following.maxTimer);
    following = null;
  }

  /** The page has settled (or the user acted again). Capture it if it changed enough since the last capture. */
  function finishFollowUp() {
    if (!following) return;
    const { changed: since } = following;
    cancelFollowUp();
    lastActionAt = Date.now();
    if (hasVisibleDialog(since.keys())) {
      // A dialog appearing late is a new screen of its own.
      onMeaningfulChange('dialog opened while the page settled after the last capture', false);
      return;
    }
    const share = coverage(since, MIN_COVERAGE_ACTION, null, false);
    if (share >= MIN_COVERAGE_ACTION) {
      onMeaningfulChange(`${percent(share)} of the page changed while it settled after the last capture`, true);
    }
  }

  /** Resolves when finite animations on the page have finished, or after ANIMATION_WAIT_MS. */
  function animationsSettled() {
    const running = document.getAnimations().filter((a) => {
      if (a.playState !== 'running') return false;
      if (a.effect?.getComputedTiming().endTime === Infinity) return false; // Spinners, pulses.
      const target = (a.effect as KeyframeEffect | null)?.target;
      return !!target && !ignore.contains(target) && !isAutonomous(target);
    });
    if (!running.length) return Promise.resolve();
    return Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, ANIMATION_WAIT_MS)),
    ]);
  }

  // Hover: when the pointer moves onto something new, watch for what appears (tooltips,
  // hover menus). It's judged once the pointer rests, so passing over things doesn't count.
  const onPointerMove = (e: PointerEvent) => {
    lastMoveAt = Date.now();
    pointerX = e.clientX;
    pointerY = e.clientY;
  };
  // pointerover fires before the site's own mouseenter handlers, so a tooltip that appears
  // instantly is still seen as caused by the user.
  const onPointerOver = (e: PointerEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target === hovered || ignore.contains(target)) return;
    hovered = target;
    noteHoverSizes(target);
    // Scrolling slides the page under a still pointer, which reports it as moving onto new
    // things, sometimes well after the scroll. That isn't the user pointing at anything. A
    // real move comes before its own pointermove, so it's at a new position. In a frame embedded in
    // the page, the pointer may not have moved inside it at all: the page scrolled the frame under it.
    const pointerStill = pointerX === null || (e.clientX === pointerX && e.clientY === pointerY);
    if (pointerStill || Date.now() - lastScrollAt < SCROLL_SETTLE_MS) return;
    lastMoveAt = Date.now();
    if (mode !== 'action') watch('hover');
  };
  // Scrolling (the page or anything in it) cancels a hover being watched: whatever appears
  // next came into view, rather than being opened.
  const onScroll = () => {
    lastScrollAt = Date.now();
    if (mode === 'hover') endWatch();
  };
  // Remember what the user acts on, for `userIsIn`.
  const onPointerDown = (e: PointerEvent) => {
    if (e.isPrimary && e.button === 0 && e.target instanceof Element) actedOn = { el: e.target, at: Date.now() };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && document.activeElement) actedOn = { el: document.activeElement, at: Date.now() };
  };
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('keydown', onKeyDown, { capture: true, passive: true });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  // Catch URL changes that don't come from a click, like redirects or the Back button.
  const poll = setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    // Some sites update the URL as you scroll through sections. That's not a new screen.
    const now = Date.now();
    if (now - lastScrollAt < SCROLL_SETTLE_MS * 2 && now - lastActionAt > AUTONOMOUS_AFTER_MS) return;
    if (!mode) {
      watch('action');
      startHref = ''; // The URL already changed, so this always counts.
    }
  }, URL_POLL_MS);

  return {
    interaction() {
      // A new action while still watching: judge the previous one first, so each change is
      // captured before the next action alters the page again.
      finishFollowUp();
      if (mode === 'action') void judge(true);
      watch('action');
    },
    followUp() {
      startFollowUp();
    },
    reset() {
      endWatch();
      cancelFollowUp();
      lastHref = location.href;
    },
    stop() {
      endWatch();
      cancelFollowUp();
      observer.disconnect();
      clearInterval(poll);
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerover', onPointerOver, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('scroll', onScroll, { capture: true });
    },
  };
}

/**
 * Whether an element is part of, or right around, a video. Captions, player controls and the
 * overlays on a hover preview (like YouTube's) change because the video is playing, not because
 * the user opened something.
 */
function nearVideo(el: Element) {
  for (let a: Element | null = el, i = 0; a && i < 4; a = a.parentElement, i++) {
    if (a.tagName === 'VIDEO' || a.getElementsByTagName('video').length) return true;
  }
  return false;
}

function percent(share: number) {
  return `${Math.round(share * 1000) / 10}%`;
}

function hasVisibleDialog(changed: Iterable<Element>) {
  for (const el of changed) {
    if (!el.isConnected) continue;
    const dialogs = el.matches(DIALOG_SELECTOR) ? [el] : [...el.querySelectorAll(DIALOG_SELECTOR)];
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && isShown(d)) return true;
    }
  }
  return false;
}

/**
 * The share of the visible page (0–1) covered by things that changed and can be seen.
 * Stops counting once it reaches `enough`. Elements that contain `skip` (or are it) are
 * left out, though their other contents still count.
 *
 * With `newContentOnly`, only things floating above the page count (tooltips, menus, popovers).
 * A restyled element counts only for what it reveals floating, not for its own or its contents'
 * new colors. New content in the page's normal layout doesn't count either: on a hover, that's
 * a card fading in as it scrolls into view, not something the pointer opened.
 *
 * With `near`, only elements within HOVER_REACH_PX of that point count.
 */
function coverage(
  changed: Map<Element, ChangeKind>,
  enough: number,
  skip: Element | null,
  newContentOnly: boolean,
  near: { x: number; y: number } | null = null,
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cells = new Uint8Array(GRID_COLS * GRID_ROWS);
  const needed = Math.ceil(cells.length * enough);
  let marked = 0;
  let checked = 0;

  const mark = (el: Element) => {
    if (skip && el.contains(skip)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return;
    if (near && distance(r, near) > HOVER_REACH_PX) return;
    if (!isPainted(el)) return;
    // Mark each grid cell the element overlaps.
    const c0 = Math.max(0, Math.floor((r.left / vw) * GRID_COLS));
    const c1 = Math.min(GRID_COLS - 1, Math.ceil((r.right / vw) * GRID_COLS) - 1);
    const r0 = Math.max(0, Math.floor((r.top / vh) * GRID_ROWS));
    const r1 = Math.min(GRID_ROWS - 1, Math.ceil((r.bottom / vh) * GRID_ROWS) - 1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * GRID_COLS + col;
        if (!cells[i]) {
          cells[i] = 1;
          marked++;
        }
      }
    }
  };

  const floatingOnPage = new Map<Element, boolean>();
  for (const [root, kind] of changed) {
    if (!root.isConnected) continue;
    const floatingOnly = newContentOnly && kind === 'restyled';
    const floating = new Map<Element, boolean>();
    // Look inside each change too: a modal or menu is often added as an empty wrapper
    // whose visible content sits in its children.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el: Node | null = root;
    for (let n = 0; el && n < MAX_ELEMENTS_PER_CHANGE; n++, el = walker.nextNode()) {
      const counts = floatingOnly
        ? isFloating(el as Element, root, floating)
        : !newContentOnly || isFloating(el as Element, document.documentElement, floatingOnPage);
      if (counts) mark(el as Element);
      if (marked >= needed || ++checked >= MAX_ELEMENTS_TOTAL) return marked / cells.length;
    }
  }
  return marked / cells.length;
}

/** How far a point is from a rectangle, in pixels. Zero if it's inside. */
function distance(r: DOMRect, p: { x: number; y: number }) {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Whether an element is, or sits inside, something positioned above the page (a menu or
 * popover), between it and `root`. `cache` avoids rechecking shared ancestors.
 */
function isFloating(el: Element, root: Element, cache: Map<Element, boolean>): boolean {
  const known = cache.get(el);
  if (known !== undefined) return known;
  const position = getComputedStyle(el).position;
  const result =
    position === 'absolute' ||
    position === 'fixed' ||
    (el !== root && !!el.parentElement && isFloating(el.parentElement, root, cache));
  cache.set(el, result);
  return result;
}

/**
 * Whether an element itself draws something: text, an image or form control, or a background.
 * This skips invisible full-screen layers that sites add to close dropdowns on outside clicks.
 */
function isPainted(el: Element) {
  if (!isShown(el)) return false;
  if (MEDIA_TAGS.has(el.tagName.toUpperCase())) return true;
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) return true;
  }
  const style = getComputedStyle(el);
  if (style.backgroundImage !== 'none') return true;
  return alpha(style.backgroundColor) > 0.05;
}

function isShown(el: Element) {
  return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

/** Alpha of a computed CSS colour such as "rgba(0, 0, 0, 0.5)" or "rgb(0 0 0 / 50%)". */
function alpha(color: string) {
  if (color === 'transparent') return 0;
  const m = color.match(/[\d.]+%?/g);
  if (!m || m.length < 4) return 1;
  const a = m[3]!;
  return a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
}
