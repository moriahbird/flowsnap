import { StrictMode, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  db,
  getClicks,
  getLatestFlow,
  getScreens,
  screenKeys,
  screenLabel,
  type Click,
  type Flow,
  type Mark,
  type Note,
  type Screen,
} from '@/utils/db';
import { browser } from 'wxt/browser';
import type { ContinueReply, ToBackground, ToViewer } from '@/utils/messages';
import { downloadName, exportFlow, flowImageForSlides, flowSvg, type FlowFormat } from './export';
import { flowLinks, type Link } from './links';
import {
  TEXT_PAGE_BODY_PLACEHOLDER,
  TEXT_PAGE_HEADING_PLACEHOLDER,
  TEXT_PAGE_ICONS,
  textPageIconPath,
  type TextPageIcon,
} from './textPage';
import { circlePoints, defaultMarkSize, MIN_MARK_PX, placedMark, smoothPath, type MarkKind } from './marks';
import { cardWidths } from './scale';
import { CARD_WIDTH, fitNote, newNote, NOTE_OVERLAP, NOTE_PAPERS, NOTE_SIZE, notePaper, notesBottom } from './notes';
import { defaultFlowName, shownName, siteName } from '@/utils/flowName';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/gaegu/latin-700.css';
import '@fontsource-variable/manrope/wght.css';
import logo from './logo.png';
import './style.css';

/**
 * Temporary viewer for chunk 1: lists the captured screens in order, each with a dot where
 * the user clicked. Chunk 4 replaces this with the canvas.
 */
function Viewer() {
  const [flow, setFlow] = useState<Flow | null | undefined>(undefined);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [clicks, setClicks] = useState<Map<string, Click>>(new Map());
  const list = useRef<HTMLOListElement>(null);
  /** Screens fading out after the user deleted them. They're removed once the animation ends. */
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  /** The last deletion, which the user can undo for a few seconds. */
  const [undo, setUndo] = useState<Deleted | null>(null);
  const main = useRef<HTMLElement>(null);
  /** The flow opens at 70%, so more of it fits on screen while the screens stay readable. */
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  /** A blur or circle just duplicated or pasted, which becomes the selected one. */
  const [focusMarkId, setFocusMarkId] = useState<string | null>(null);
  /** The latest `placeCopy`, for the paste shortcut, which is set up before it exists. */
  const placeCopyRef = useRef<(screenId: string, kind: MarkKind, mark: Mark, steps?: number, fromId?: string) => void>(undefined);
  /** Where each arrow runs down the gap after its screen, so the + there keeps clear of it. */
  const [gapArrows, setGapArrows] = useState<Record<string, { top: number; bottom: number }>>({});
  /** The screen whose following gap's + is hovered: the arrow across that gap fades. */
  const [insertHover, setInsertHover] = useState<string | null>(null);
  /** A written page just added, which opens ready to type in. */
  const [newTextPageId, setNewTextPageId] = useState<string | null>(null);
  /** A note just added, which opens ready to type in. */
  const [newNoteId, setNewNoteId] = useState<string | null>(null);
  /** The arrow the user clicked, by the id of the screen it starts on. Its dot is highlighted. */
  const [selected, setSelected] = useState<string | null>(null);
  const latestZoom = useRef(zoom);
  latestZoom.current = zoom;
  /**
   * The furthest out the flow can be zoomed: until the right edge of its last screen is
   * MAX_RIGHT_GAP from the right of the window, or until the whole flow fits top to bottom (for a
   * very tall screen), whichever is further out. A flow that already fits both ways at 100% can't be
   * zoomed out.
   */
  const zoomFloor = () => {
    const ol = list.current;
    const byWidth = fitWidth();
    if (!ol || !byWidth) return MIN_ZOOM;
    const area = main.current;
    // Also as far as it takes to see the whole flow top to bottom, for a flow with a very tall
    // screen (which already fits across the window).
    const flowHeight = contentSize(ol, true).height;
    const top = area ? area.getBoundingClientRect().top + parseFloat(getComputedStyle(area).paddingTop) : 0;
    const byHeight = flowHeight > 0 ? (innerHeight - top - FIT_MARGIN) / flowHeight : 1;
    return Math.min(1, Math.max(MIN_ZOOM, Math.min(byWidth, byHeight)));
  };
  /**
   * The zoom at which the whole flow fits across the window, ending MAX_RIGHT_GAP from its right
   * edge, or 0 before it's laid out.
   */
  const fitWidth = () => {
    const ol = list.current;
    if (!ol) return 0;
    const flowWidth = contentSize(ol, true).width - parseFloat(getComputedStyle(ol).paddingRight);
    if (flowWidth <= 0) return 0;
    // From where the flow starts when scrolled to the left: inside the canvas's padding.
    const area = main.current;
    const start = area ? area.getBoundingClientRect().left + parseFloat(getComputedStyle(area).paddingLeft) : 0;
    return (innerWidth - MAX_RIGHT_GAP - start) / flowWidth;
  };
  // A flow opens zoomed out to fit across the window, so more of it shows at first, but never
  // further than START_MIN_ZOOM (where screens get hard to read) or closer than DEFAULT_ZOOM.
  const startZoomed = useRef(false);
  useLayoutEffect(() => {
    if (startZoomed.current || !screens.length) return;
    const fit = fitWidth();
    if (!fit) return;
    startZoomed.current = true;
    setZoom(Math.min(DEFAULT_ZOOM, Math.max(START_MIN_ZOOM, fit)));
  }, [screens]);
  const [floor, setFloor] = useState(MIN_ZOOM);
  /**
   * The point zooming centres on, so it stays still on screen while the flow grows or shrinks
   * around it: where it is on screen, and where that is in the flow, in its own (unzoomed) units.
   */
  const anchor = useRef<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  /**
   * Zoom to `z`, keeping a point still: a selected note, or else `at` (the pointer, when pinching),
   * or else the middle of the canvas. `at: null` doesn't keep any point still.
   */
  const zoomTo = (z: number, at?: { x: number; y: number } | null) => {
    const ol = list.current;
    anchor.current = null;
    if (ol && main.current && at !== null) {
      const note = document.activeElement?.closest<HTMLElement>('.note');
      const view = ol.getBoundingClientRect();
      // The middle of the part of the flow that's visible, below the top bar, so zooming stays on
      // the screens rather than on empty canvas around them.
      const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      const flowTop = Math.max(top, view.top);
      const flowBottom = Math.min(innerHeight, view.bottom);
      let screen = at ?? {
        x: view.left + view.width / 2,
        y: flowBottom > flowTop ? (flowTop + flowBottom) / 2 : (top + innerHeight) / 2,
      };
      if (note) {
        const box = note.getBoundingClientRect();
        screen = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      const z0 = latestZoom.current;
      anchor.current = {
        screen,
        // The row of screens scrolls sideways in its own units; the page scrolls down.
        flow: { x: ol.scrollLeft + (screen.x - view.left) / z0, y: (screen.y - view.top) / z0 },
      };
    }
    setZoom(Math.max(zoomFloor(), clampZoom(z)));
  };
  // The limit changes with the window's width and the number of screens. Zoomed out past it, the
  // flow zooms back in to it.
  useLayoutEffect(() => {
    const update = () => {
      const f = zoomFloor();
      setFloor(f);
      if (latestZoom.current < f - 0.001) setZoom(f);
    };
    update();
    addEventListener('resize', update);
    return () => removeEventListener('resize', update);
  });
  // Zooming keeps its anchor point still on screen, so the flow grows or shrinks around it: a
  // selected note, the pointer when pinching, or the middle of the canvas. Near the end or bottom
  // of the flow there may not be enough to scroll, so room is added after it.
  useLayoutEffect(() => {
    const ol = list.current;
    const area = main.current;
    const a = anchor.current;
    anchor.current = null;
    if (!ol || !area) return;
    ol.style.paddingRight = '';
    area.style.paddingBottom = '';
    const room = {
      right: parseFloat(getComputedStyle(ol).paddingRight),
      bottom: parseFloat(getComputedStyle(area).paddingBottom),
      x: 0,
      y: 0,
    };
    zoomRoom.current = room;
    if (!a) return;
    // Where the anchor point is now, and how far that is from where it was.
    const view = ol.getBoundingClientRect();
    const dx = view.left + (a.flow.x - ol.scrollLeft) * zoom - a.screen.x;
    const dy = view.top + a.flow.y * zoom - a.screen.y;
    // Room to add: to the right inside the row, in its own units as its padding and scrolling are
    // zoomed along with it; and below the row, so its scrollbar stays just under the screens.
    // Checked again after adding, as some of it can go into empty space below the flow first.
    for (let i = 0; i < 3; i++) {
      const moreX = dx - (ol.scrollWidth - ol.clientWidth - ol.scrollLeft) * zoom;
      const moreY = dy - (document.documentElement.scrollHeight - innerHeight - scrollY);
      if (moreX <= 0.5 && moreY <= 0.5) break;
      if (moreX > 0.5) room.x += moreX / zoom;
      if (moreY > 0.5) room.y += moreY;
      ol.style.paddingRight = room.x ? `${room.right + room.x}px` : '';
      area.style.paddingBottom = room.y ? `${room.bottom + room.y}px` : '';
    }
    ol.scrollLeft += dx / zoom;
    scrollBy(0, dy);
  }, [zoom]);

  /**
   * Extra room added past the flow while zooming, so the zoom's anchor could stay still: to the
   * right inside the row (in its own units) and below it. It shrinks away as the user scrolls back,
   * so once the flow fits again there's nothing left to scroll and no scrollbar.
   */
  const zoomRoom = useRef<{ right: number; bottom: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const ol = list.current;
    const area = main.current;
    if (!ol || !area) return;
    const trim = () => {
      const room = zoomRoom.current;
      if (!room || (!room.x && !room.y)) return;
      // Only as much as is in view now, past where the flow itself ends.
      const needX = Math.max(0, ol.scrollLeft + ol.clientWidth - (ol.scrollWidth - room.x));
      const needY = Math.max(0, scrollY + innerHeight - (document.documentElement.scrollHeight - room.y));
      if (needX < room.x - 0.5) {
        room.x = needX;
        ol.style.paddingRight = room.x ? `${room.right + room.x}px` : '';
      }
      if (needY < room.y - 0.5) {
        room.y = needY;
        area.style.paddingBottom = room.y ? `${room.bottom + room.y}px` : '';
      }
    };
    ol.addEventListener('scroll', trim);
    addEventListener('scroll', trim);
    return () => {
      ol.removeEventListener('scroll', trim);
      removeEventListener('scroll', trim);
    };
  }, [flow === undefined || flow === null]);

  /** Zoom so the whole flow fits on screen, but never larger than 100%. */
  const fit = () => {
    const ol = list.current;
    const area = main.current;
    if (!ol || !area) return;
    const style = getComputedStyle(area);
    const width = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = innerHeight - area.getBoundingClientRect().top - parseFloat(style.paddingTop) - FIT_MARGIN;
    // The flow's size in its own units, so this works whatever the zoom is now. Screens on their
    // way out after being deleted don't count.
    const flowSize = contentSize(ol, true);
    zoomTo(Math.min(1, width / flowSize.width, height / flowSize.height), null);
  };

  // While the canvas scrolls, the gaps between screens don't offer to add a page: passing over them
  // shouldn't bring up the line and +. They respond again a moment after scrolling stops.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      const ol = list.current;
      if (!ol) return;
      ol.dataset.scrolling = '';
      clearTimeout(timer);
      timer = setTimeout(() => delete ol.dataset.scrolling, SCROLL_QUIET_MS);
    };
    addEventListener('scroll', onScroll, { capture: true, passive: true });
    addEventListener('wheel', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      removeEventListener('scroll', onScroll, { capture: true });
      removeEventListener('wheel', onScroll);
    };
  }, []);

  // Zoom shortcuts zoom the flow, not the whole page, so the top bar stays the same size.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘+ and ⌘− work while typing too, e.g. to zoom in on a note. ⇧1 types "!" there instead.
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'v' && !typing && copiedMark) {
          // Paste the copied blur or circle onto the screen the pointer is over, or else the one
          // last clicked, or the one of the blur or circle selected now, or else the screen it was
          // copied from. On another screen the first paste lands in the same place as the original;
          // each paste after it lands a step further along.
          const focused = document.activeElement?.closest<HTMLElement>('.screens > li[data-id]')?.dataset.id;
          const target = pasteTarget.hovered ?? pasteTarget.clicked ?? focused ?? copiedMark.screenId;
          if (target !== copiedMark.target) {
            copiedMark.target = target;
            copiedMark.pastes = target === copiedMark.screenId ? 1 : 0;
          } else copiedMark.pastes += 1;
          placeCopyRef.current?.(target, copiedMark.kind, copiedMark.mark, copiedMark.pastes, copiedMark.screenId);
          e.preventDefault();
          return;
        }
        if (e.key === '=' || e.key === '+') zoomTo(nextZoom(latestZoom.current, 1));
        else if (e.key === '-') zoomTo(nextZoom(latestZoom.current, -1));
        else if (e.key === '0') zoomTo(1);
        else return;
        e.preventDefault();
      } else if (!typing && e.shiftKey && (e.key === '!' || e.code === 'Digit1')) {
        e.preventDefault();
        fit();
      }
    };
    // Pinching on a trackpad (or Ctrl + scroll) zooms the flow too.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(latestZoom.current * Math.exp(-e.deltaY / 100), { x: e.clientX, y: e.clientY });
    };
    addEventListener('keydown', onKey);
    addEventListener('wheel', onWheel, { passive: false });
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('wheel', onWheel);
    };
  }, []);
  // Clicking anywhere but an arrow or its dot, or pressing Escape, unselects the arrow.
  useEffect(() => {
    if (!selected) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.arrow-hit, .arrow-start')) setSelected(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [selected]);

  // The latest state, for deletions that finish after an animation.
  const latest = useRef({ flow, screens, clicks });
  latest.current = { flow, screens, clicks };

  useEffect(() => {
    const load = async (id: string | null) => {
      const f = id ? await (await db()).get('flows', id) : await getLatestFlow();
      if (!f) {
        setFlow(null);
        return null;
      }
      setFlow(f);
      setScreens(await getScreens(f.id));
      setClicks(await getClicks(f.id));
      return f.id;
    };
    let shownId: string | null | undefined = new URLSearchParams(location.search).get('flow');
    void load(shownId).then((id) => (shownId = id));

    // After Continue capture, stopping the recording comes back here: reload the flow with its new
    // screens and bring this tab to the front, instead of opening another canvas.
    const onMessage = (msg: ToViewer, _sender: unknown, reply: (shown: boolean) => void) => {
      if (msg.type !== 'show-flow' || msg.flowId !== shownId) return false;
      void (async () => {
        await load(msg.flowId);
        const tab = await browser.tabs.getCurrent();
        if (tab?.id != null) {
          await browser.tabs.update(tab.id, { active: true });
          await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        reply(true);
      })();
      return true; // Reply asynchronously.
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  /**
   * Add a written page straight after a screen, to describe in words what happens between it and
   * the next (checking an email, typing a code sent by text). It opens ready to type in.
   */
  const insertTextPage = async (afterId: string) => {
    const { flow: f, screens: before } = latest.current;
    if (!f) return;
    const at = before.findIndex((s) => s.id === afterId) + 1;
    if (at <= 0) return;
    const page: Screen = {
      id: crypto.randomUUID(),
      flowId: f.id,
      kind: 'text',
      index: at,
      screenKey: crypto.randomUUID(),
      width: 0,
      height: 0,
      url: '',
      title: '',
      capturedAt: Date.now(),
      text: '',
      icon: 'newTab',
    };
    const after = [...before.slice(0, at), page, ...before.slice(at)].map((s, i) => (s.index === i ? s : { ...s, index: i }));
    setScreens(after);
    setNewTextPageId(page.id);
    const d = await db();
    for (const s of after) if (s === page || before.find((b) => b.id === s.id)?.index !== s.index) await d.put('screens', s);
  };

  /** Delete a screen: it fades out, the screens after it slide over, and the arrows reconnect. */
  const remove = (id: string) => {
    if (removing.has(id)) return;
    setRemoving((r) => new Set(r).add(id));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => void finishRemoving(id), reduced ? 0 : REMOVE_MS);
  };

  const finishRemoving = async (id: string) => {
    const { flow: f, screens: before, clicks: beforeClicks } = latest.current;
    const screen = before.find((s) => s.id === id);
    if (!f || !screen) return;
    const keys = screenKeys(screen);
    const removedClicks = keys.map((k) => beforeClicks.get(k)).filter((c): c is Click => !!c);
    // The rest keep their order, numbered from 0 again.
    const after = before.filter((s) => s.id !== id).map((s, i) => (s.index === i ? s : { ...s, index: i }));
    const clicksAfter = new Map(beforeClicks);
    for (const k of keys) clicksAfter.delete(k);
    const flowAfter = withDefaultName(f, after);

    setScreens(after);
    setClicks(clicksAfter);
    setFlow(flowAfter);
    setRemoving((r) => {
      const next = new Set(r);
      next.delete(id);
      return next;
    });
    setUndo({ screen, clicks: removedClicks, screensBefore: before, flowBefore: f });

    const d = await db();
    await d.delete('screens', id);
    for (const c of removedClicks) await d.delete('clicks', c.screenKey);
    for (const s of after) if (before.find((b) => b.id === s.id)?.index !== s.index) await d.put('screens', s);
    if (flowAfter !== f) await d.put('flows', flowAfter);
  };

  /** Put the last deleted screen back where it was. */
  const restore = async () => {
    if (!undo) return;
    const { screen, clicks: removedClicks, screensBefore, flowBefore } = undo;
    setUndo(null);
    const clicksAfter = new Map(latest.current.clicks);
    for (const c of removedClicks) clicksAfter.set(c.screenKey, c);
    // Keep any rename made since, but put a default name's step count back.
    const current = latest.current.flow ?? flowBefore;
    const flowAfter = current.renamed ? current : { ...current, name: flowBefore.name };
    // Screens renamed or with an arrow moved since keep those changes.
    const now = new Map(latest.current.screens.map((s) => [s.id, s]));
    const restored = screensBefore.map((s) => {
      const kept = now.get(s.id);
      return kept ? { ...kept, index: s.index } : s;
    });
    setScreens(restored);
    setClicks(clicksAfter);
    setFlow(flowAfter);

    const d = await db();
    for (const s of restored) await d.put('screens', s);
    for (const c of removedClicks) await d.put('clicks', c);
    await d.put('flows', flowAfter);
  };

  if (flow === undefined) return null;
  if (flow === null)
    return <p className="empty">No flow found. Click the FlowSnap icon on any page to record one.</p>;

  /** A screen was renamed on the canvas. It's saved by ScreenName; this updates what's shown. */
  const renameScreen = (renamed: Screen) =>
    setScreens((all) => all.map((s) => (s.id === renamed.id ? renamed : s)));

  // Numbers and arrows skip screens that are on their way out, so the arrows reconnect straight away.
  // A screen fading out keeps the number it had.
  const visible = screens.filter((s) => !removing.has(s.id));
  /** Each screenshot's width on the canvas: one shared scale, so the same things look the same size on every screen. */
  const widths = cardWidths(screens);
  const widthOf = (s: Screen) => widths.get(s.id) ?? CARD_WIDTH;
  const number = (s: Screen) => (removing.has(s.id) ? screens : visible).indexOf(s) + 1;
  const links = flowLinks(visible, clicks);
  // Each screen shows one dot: where its arrow to the next screen starts.
  const startOn = (s: Screen) => links.find((l) => visible[l.from] === s)?.point;

  /**
   * Change a screen from the canvas: where its arrow starts, or its notes. It's shown straight away
   * and saved once `save` is set, at the end of a drag or an edit.
   */
  const changeScreen = async (
    id: string,
    change: Pick<Partial<Screen>, 'arrowStart' | 'notes' | 'blurs' | 'circles' | 'text' | 'heading' | 'icon'>,
    save: boolean,
  ) => {
    setScreens((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));
    if (!save) return;
    // Read it fresh, so nothing else saved to the screen meanwhile is undone.
    const d = await db();
    const current = await d.get('screens', id);
    if (current) await d.put('screens', { ...current, ...change });
  };
  /** Move where a screen's arrow starts, or put it back on the recorded click with `undefined`. */
  const moveStart = (id: string, point: { x: number; y: number } | undefined, save: boolean) =>
    changeScreen(id, { arrowStart: point }, save);
  /** Add, move, resize or delete one of a screen's blurs or circles. `undefined` deletes it. */
  const changeMark = (screen: Screen, kind: MarkKind, id: string, mark: Mark | undefined, save: boolean) => {
    const others = (latest.current.screens.find((s) => s.id === screen.id)?.[kind] ?? []).filter((m) => m.id !== id);
    void changeScreen(screen.id, { [kind]: mark ? [...others, mark] : others }, save);
  };
  /**
   * Put a copy of a blur or circle on a screen, a little down and to the right of `mark` (or up
   * and to the left if it's against the edge), and select it.
   */
  const placeCopy = (screenId: string, kind: MarkKind, original: Mark, steps = 1, fromId?: string) => {
    const screen = latest.current.screens.find((s) => s.id === screenId);
    if (!screen || screen.kind !== 'screenshot' || !screen.width) return;
    const all = cardWidths(latest.current.screens);
    const width = all.get(screen.id) ?? CARD_WIDTH;
    const height = (width * screen.height) / screen.width;
    // From a screen of another size: the same size on the canvas, and kept on this screen.
    const from = fromId ? latest.current.screens.find((s) => s.id === fromId) : undefined;
    const fromWidth = from ? (all.get(from.id) ?? width) : width;
    const fromHeight = from?.kind === 'screenshot' && from.width ? (fromWidth * from.height) / from.width : height;
    const w = Math.min(1, (original.w * fromWidth) / width);
    const h = Math.min(1, (original.h * fromHeight) / height);
    const mark = {
      ...original,
      w,
      h,
      x: Math.min(Math.max(0, 1 - w), (original.x * fromWidth) / width),
      y: Math.min(Math.max(0, 1 - h), (original.y * fromHeight) / height),
    };
    const shift = (pos: number, size: number, step: number) => {
      const moved = pos + step * steps;
      return moved + size <= 1 ? moved : Math.max(0, pos - step * steps);
    };
    const copy = {
      ...mark,
      id: crypto.randomUUID(),
      x: shift(mark.x, mark.w, COPY_OFFSET / width),
      y: shift(mark.y, mark.h, COPY_OFFSET / height),
    };
    changeMark(screen, kind, copy.id, copy, true);
    setFocusMarkId(copy.id);
  };
  placeCopyRef.current = placeCopy;
  /** Add, edit, move or delete one of a screen's notes. `undefined` deletes it. */
  const changeNote = (screen: Screen, id: string, note: Note | undefined, save: boolean) => {
    const others = (latest.current.screens.find((s) => s.id === screen.id)?.notes ?? []).filter((n) => n.id !== id);
    void changeScreen(screen.id, { notes: note ? [...others, note] : others }, save);
  };
  const startDot = (s: Screen) => {
    const point = startOn(s);
    return (
      point && (
        <ArrowStart
          point={point}
          selected={selected === s.id}
          onSelect={() => setSelected(s.id)}
          onMove={(p, save) => void moveStart(s.id, p, save)}
        />
      )
    );
  };

  return (
    <>
      <TopBar
        flow={flow}
        screens={screens}
        clicks={clicks}
        onRename={setFlow}
      />
      <main ref={main}>
        <ol className="screens" ref={list} style={{ zoom, '--zoom': zoom } as CSSProperties}>
          <FlowArrows
            list={list}
            ids={visible.map((s) => s.id)}
            links={links}
            selected={selected}
            dimmed={insertHover}
            onGaps={setGapArrows}
            zoom={zoom}
            onSelect={setSelected}
            onMoveStart={(id, point, save) => void moveStart(id, point, save)}
          />
          {screens.map((s, i) =>
            s.kind === 'text' ? (
              <TextPageCard
                key={s.id}
                screen={s}
                number={number(s)}
                removing={removing.has(s.id)}
                onDelete={() => remove(s.id)}
                onRename={renameScreen}
                start={startDot(s)}
                autoFocus={s.id === newTextPageId}
                onChange={(change, save) => void changeScreen(s.id, change, save)}
                after={
                  i < screens.length - 1 && (
                    <InsertPage
                      onInsert={() => void insertTextPage(s.id)}
                      onHover={(on) => setInsertHover(on ? s.id : null)}
                      avoid={gapArrows[s.id]}
                      zoom={zoom}
                    />
                  )
                }
              />
            ) : s.kind === 'new-tab' ? (
              <NewTabCard
                key={s.id}
                screen={s}
                number={number(s)}
                removing={removing.has(s.id)}
                onDelete={() => remove(s.id)}
                onRename={renameScreen}
                start={startDot(s)}
                newNoteId={newNoteId}
                onChangeNote={(id, note, save) => changeNote(s, id, note, save)}
                after={
                  i < screens.length - 1 && (
                    <InsertPage
                      onInsert={() => void insertTextPage(s.id)}
                      onHover={(on) => setInsertHover(on ? s.id : null)}
                      avoid={gapArrows[s.id]}
                      zoom={zoom}
                    />
                  )
                }
              />
            ) : (
              <ScreenCard
                key={s.id}
                screen={s}
                cardWidth={widthOf(s)}
                number={number(s)}
                removing={removing.has(s.id)}
                onDelete={() => remove(s.id)}
                onRename={renameScreen}
                start={startDot(s)}
                newNoteId={newNoteId}
                onChangeNote={(id, note, save) => changeNote(s, id, note, save)}
                onChangeMark={(kind, id, mark, save) => changeMark(s, kind, id, mark, save)}
                focusMarkId={focusMarkId}
                zoom={zoom}
                onDuplicateMark={(kind, mark) => placeCopy(s.id, kind, mark)}
                after={
                  i < screens.length - 1 && (
                    <InsertPage
                      onInsert={() => void insertTextPage(s.id)}
                      onHover={(on) => setInsertHover(on ? s.id : null)}
                      avoid={gapArrows[s.id]}
                      zoom={zoom}
                    />
                  )
                }
              />
            ),
          )}
        </ol>
        {screens.length === 0 && (
          // Every screen deleted: say so, and how to carry on.
          <div className="flow-empty" role="status">
            <div className="flow-empty-card">
              {/* The recording panel's old mini flow: a captured screen, its click and an arrow to
                  the dashed spot where the next screen goes. */}
              <svg className="flow-empty-icon" viewBox="0 0 66 23" aria-hidden="true">
                <rect className="slot" x="36.5" y="0.5" width="29" height="22" rx="2" />
                <path className="plus" d="M51 9v5M48.5 11.5h5" />
                <rect className="body" x="0.5" y="0.5" width="29" height="22" rx="1.8" />
                <rect className="head" x="1" y="1" width="28" height="5" />
                <line className="rule" x1="0.5" x2="29.5" y1="6.5" y2="6.5" />
                <circle className="ink" cx="3.12" cy="3.5" r="1.04" />
                <circle className="ink" cx="6.58" cy="3.5" r="1.04" />
                <circle className="ink" cx="10.05" cy="3.5" r="1.04" />
                <path className="cross" d="M24.88 2.46 26.96 4.54M26.96 2.46 24.88 4.54" />
                <circle className="ink" cx="5.5" cy="10.5" r="1.7" />
                <path className="line" d="M5.5 10.5H15V16H35.6" />
                <path className="line" d="M32.4 12.8 35.6 16 32.4 19.2" />
              </svg>
              <h2>This flow is empty</h2>
              <p>
                You’ve deleted every screen. Continue capturing to add new ones to this flow, or start fresh by
                clicking the FlowSnap icon in any tab.
              </p>
              <ContinueButton flow={flow} />
            </div>
          </div>
        )}
      </main>
      <Sidebar
        disabled={screens.length === 0}
        zoom={zoom}
        minZoom={floor}
        onZoom={zoomTo}
        onFit={fit}
        onDrop={(kind, x, y) => {
          // Dropped from the sidebar: onto the screenshot it overlaps most, even if only partly
          // (it's then pulled onto the screen), or nowhere if it misses them all. A sticky note can
          // also go on a page that opened in a tab FlowSnap didn't record.
          const size = kind === 'notes' ? { w: NOTE_SIZE, h: NOTE_SIZE } : defaultMarkSize(kind);
          const dropW = size.w * zoom;
          const dropH = size.h * zoom;
          let best: { screen: Screen; box: DOMRect; overlap: number } | undefined;
          for (const li of list.current?.querySelectorAll<HTMLElement>(':scope > li[data-id]') ?? []) {
            const screen = latest.current.screens.find((s) => s.id === li.dataset.id);
            const onPlaceholder = kind === 'notes' && screen?.kind === 'new-tab';
            const shot = li.querySelector(onPlaceholder ? '.card' : '.shot');
            if (!screen || !shot || (!onPlaceholder && (screen.kind !== 'screenshot' || !screen.width))) continue;
            const box = shot.getBoundingClientRect();
            const overlapW = Math.min(x + dropW / 2, box.right) - Math.max(x - dropW / 2, box.left);
            const overlapH = Math.min(y + dropH / 2, box.bottom) - Math.max(y - dropH / 2, box.top);
            const overlap = Math.max(0, overlapW) * Math.max(0, overlapH);
            if (overlap > (best?.overlap ?? 0)) best = { screen, box, overlap };
          }
          if (!best) return;
          const { screen, box } = best;
          const at = { x: (x - box.left) / box.width, y: (y - box.top) / box.height };
          // The card's size in canvas pixels: a screenshot's from its image, a placeholder's as shown.
          const width = screen.kind === 'screenshot' ? widthOf(screen) : box.width / zoom;
          const height = screen.kind === 'screenshot' ? (width * screen.height) / screen.width : box.height / zoom;
          if (kind === 'notes') {
            // Centred where it was let go, ready to type in, and kept on the screen.
            const note = newNote(at.x - NOTE_SIZE / width / 2, at.y - NOTE_SIZE / height / 2);
            note.x = Math.min(note.x, Math.max(0, 1 - NOTE_SIZE / width));
            note.y = Math.min(note.y, Math.max(0, 1 - NOTE_SIZE / height));
            setNewNoteId(note.id);
            changeNote(screen, note.id, note, true);
          } else {
            const mark = placedMark(kind, at, height, width);
            changeMark(screen, kind, mark.id, mark, true);
          }
        }}
      />
      {undo && <UndoToast key={undo.screen.id} onUndo={() => void restore()} onDone={() => setUndo(null)} />}
    </>
  );
}

/** How long a deleted screen takes to fade out and close its gap. Matches .removing in style.css. */
const REMOVE_MS = 420;
/** How long Undo stays offered after deleting a screen. */
const UNDO_MS = 6000;

/** A deleted screen, kept for a few seconds so it can be put back. */
interface Deleted {
  screen: Screen;
  clicks: Click[];
  screensBefore: Screen[];
  flowBefore: Flow;
}

/**
 * A flow that still has its default name is renamed for its new number of screens, like
 * "(3 Steps)". A name the user chose stays as it is.
 */
function withDefaultName(flow: Flow, screens: Screen[]): Flow {
  if (flow.renamed) return flow;
  const shots = screens.filter((s) => s.kind === 'screenshot');
  const name = defaultFlowName(siteName(flow.siteName, shots[0]?.url ?? ''), shots.length);
  return name === flow.name ? flow : { ...flow, name };
}

/** "Screen deleted · Undo", for a few seconds after deleting. */
function UndoToast({ onUndo, onDone }: { onUndo: () => void; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, UNDO_MS);
    return () => clearTimeout(timer);
    // Runs once per deletion: the toast is remounted (by its key) for each one.
  }, []);
  return (
    <div className="undo-toast" role="status">
      Screen deleted
      <button type="button" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}

/** The trash button that deletes a screen, shown on hover over its top-right corner. */
function DeleteButton({ number, onDelete }: { number: number; onDelete: () => void }) {
  return (
    // At the end of the screen's title row, off the card, so nothing placed on the screen can
    // ever sit under it.
    <button type="button" className="delete" aria-label={`Delete screen ${number}`} title="Delete screen" onClick={onDelete}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
      </svg>
    </button>
  );
}

/**
 * The bar across the top of the canvas, holding everything you can do with the flow: its name on
 * the left, downloads on the right.
 */
function TopBar({
  flow,
  screens,
  clicks,
  onRename,
}: {
  flow: Flow;
  screens: Screen[];
  clicks: Map<string, Click>;
  onRename: (flow: Flow) => void;
}) {
  const shots = screens.filter((s) => s.kind === 'screenshot').length;
  // Continue capture shows just its arrow only when the bar is too narrow for everything at full
  // size: the logo, the whole flow name (up to its widest), the screen count and every button's name.
  const bar = useRef<HTMLElement>(null);
  const fullEnd = useRef(0);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const nav = bar.current;
    if (!nav) return;
    const update = () => {
      const start = nav.querySelector<HTMLElement>('.topbar-start');
      const end = nav.querySelector<HTMLElement>('.topbar-end');
      if (!start || !end) return;
      // The buttons' width with their names, measured whenever they're showing them.
      if (!nav.classList.contains('compact')) fullEnd.current = end.offsetWidth;
      // How much of the name is cut off now, up to the widest it's allowed (as in the stylesheet).
      const text = nav.querySelector<HTMLElement>('.flow-name-text');
      const name = text?.closest<HTMLElement>('.flow-name');
      const cut = text && name ? Math.min(text.scrollWidth - text.clientWidth, Math.min(440, innerWidth * 0.4) - name.offsetWidth) : 0;
      const style = getComputedStyle(nav);
      const room = nav.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.columnGap);
      setCompact(start.offsetWidth + Math.max(0, cut) + fullEnd.current > room);
    };
    update();
    // The window resizing, and anything else changing the bar's size (like the name's font loading).
    addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => {
      removeEventListener('resize', update);
      observer.disconnect();
    };
  }, [flow.name, shots]);
  return (
    <nav className={compact ? 'topbar compact' : 'topbar'} aria-label="Flow" ref={bar}>
      <div className="topbar-start">
        <span className="brand">
          {/* The clay flow: two screens and a new one, joined by arrows. */}
          <img className="brand-mark" src={logo} alt="" />
          <span className="brand-name">FlowSnap</span>
        </span>
        <FlowName flow={flow} onRename={onRename} />
        <span className="topbar-meta">
          {shots} {shots === 1 ? 'screen' : 'screens'}
        </span>
      </div>
      <div className="topbar-end">
        <ContinueButton flow={flow} />
        <Downloads flow={flow} screens={screens} clicks={clicks} />
        {/* The main action: most flows end up in Figma. */}
        <CopyButton
          flow={flow}
          screens={screens}
          clicks={clicks}
          label="Copy for Figma"
          icon="layers"
          title={`Copy the flow as layers, then paste into Figma (${MOD}C)`}
          shortcut
          item={(f, all, c) => ({ 'text/plain': flowSvg(f, all, c).then((t) => new Blob([t], { type: 'text/plain' })) })}
          copied="Copied. Paste into Figma with ⌘V"
          primary
        />
        {SLIDES_COPY && (
          <CopyButton
            flow={flow}
            screens={screens}
            clicks={clicks}
            label="Copy for Google Slides"
            icon="slides"
            title="Copy the flow as an image, then paste into Google Slides or Docs"
            item={(f, all, c) => ({ 'image/png': flowImageForSlides(f, all, c) })}
            copied="Copied. Paste into Google Slides or Docs with ⌘V"
          />
        )}
      </div>
    </nav>
  );
}

/**
 * Copy for Google Slides, switched off for now: the image Slides accepts from the clipboard is too
 * low resolution to read the screens. Turn it back on here once it's sharp enough.
 */
const SLIDES_COPY = false;

/** A written page's text is kept to this many characters, so its card stays in proportion. */
const TEXT_PAGE_BODY_MAX = 280;
/** How many characters are left shows once fewer than this remain. */
const TEXT_PAGE_COUNT_FROM = 40;

/** The + between screens never sits higher than this down the gap, near the top of the screens. */
const INSERT_MIN_Y = 70;

/** After the canvas stops scrolling, the gaps between screens respond to hovering again after this long. */
const SCROLL_QUIET_MS = 300;

/** Set once the flow name's one-time glow has been shown. */
const NAME_HINT_KEY = 'flowsnap.nameHintShown';

/** Longest flow name. It's also the exported files' name, so it's kept to a sensible length. */
const MAX_NAME_LENGTH = 120;

/**
 * The flow's name, shown as a field you can click to rename, like a file name in Figma. Press Enter
 * or click away to save, Escape to cancel. An empty name keeps the old one.
 */
function FlowName({ flow, onRename }: { flow: Flow; onRename: (flow: Flow) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // The very first time someone opens a flow, the name glows softly once, to say it can be renamed.
  const [hint] = useState(() => {
    try {
      if (localStorage.getItem(NAME_HINT_KEY)) return false;
      localStorage.setItem(NAME_HINT_KEY, '1');
      return true;
    } catch {
      return false;
    }
  });

  const save = async () => {
    if (draft === null) return;
    const name = draft.replace(/\s+/g, ' ').trim();
    setDraft(null);
    // Unchanged from what was shown (the name without its number of steps): keep the name as it is.
    if (!name || name === shownName(flow.name)) return;
    onRename({ ...flow, name, renamed: true });
    // Read it fresh, so nothing else saved to the flow meanwhile is undone.
    const d = await db();
    const current = await d.get('flows', flow.id);
    await d.put('flows', { ...(current ?? flow), name, renamed: true });
  };

  if (draft === null) {
    return (
      <button
        type="button"
        className={hint ? 'flow-name hint' : 'flow-name'}
        title="Rename flow"
        onClick={() => setDraft(shownName(flow.name))}
      >
        <span className="flow-name-text">{shownName(flow.name)}</span>
        <span className="sr-only">Rename flow</span>
      </button>
    );
  }
  return (
    <input
      className="flow-name flow-name-input"
      aria-label="Flow name"
      spellCheck
      value={draft}
      maxLength={MAX_NAME_LENGTH}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** How long a download's confirmation stays up. */
const MESSAGE_MS = 4000;

/**
 * The size of the screens in the list, in the list's own units (unaffected by zoom), including its
 * padding. With `skipRemoving`, screens fading out after being deleted are left out.
 */
function contentSize(ol: HTMLOListElement, skipRemoving: boolean) {
  const style = getComputedStyle(ol);
  let width = 0;
  let height = 0;
  for (const li of ol.querySelectorAll<HTMLElement>(':scope > li')) {
    if (skipRemoving && li.classList.contains('removing')) continue;
    width = Math.max(width, li.offsetLeft + li.offsetWidth);
    height = Math.max(height, li.offsetTop + li.offsetHeight);
  }
  return {
    width: width + parseFloat(style.paddingRight),
    height: height + parseFloat(style.paddingBottom),
  };
}

/**
 * A button that copies the flow to the clipboard, for pasting into another app:
 *
 * - Copy for Figma: SVG, which Figma turns into layers (each screen a named group with its
 *   screenshot, arrows as vectors, labels as text). ⌘C on the canvas does the same, unless text is
 *   selected or being typed (`shortcut`).
 * - Copy for Google Slides: an image, sized for Google Slides and Docs.
 */
/** Whether the filled Copy for Figma button shows its layers icon. Turn off to try it text only. */
const SHOW_PRIMARY_ICON = true;

function CopyButton({
  flow,
  screens,
  clicks,
  label,
  icon,
  title,
  item,
  copied,
  shortcut = false,
  primary = false,
}: {
  flow: Flow;
  screens: Screen[];
  clicks: Map<string, Click>;
  label: string;
  /** Layers for Figma, a presentation for Slides, so they're told apart when only icons show. */
  icon: 'layers' | 'slides';
  title: string;
  /** What goes on the clipboard, by type. Built after the click, so it's a promise. */
  item: (flow: Flow, screens: Screen[], clicks: Map<string, Click>) => Record<string, Promise<Blob>>;
  copied: string;
  shortcut?: boolean;
  /** Filled in plum, as the top bar's main action. */
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const latest = useRef({ flow, screens, clicks });
  latest.current = { flow, screens, clicks };
  const shots = screens.filter((s) => s.kind === 'screenshot').length;

  const copy = () => {
    const { flow: f, screens: all, clicks: c } = latest.current;
    if (!all.some((s) => s.kind === 'screenshot')) return;
    setBusy(true);
    setMessage('Copying…');
    // Written straight from the click, with the contents to follow, as browsers only allow
    // clipboard writes in response to the user, and building them takes a moment.
    navigator.clipboard
      .write([new ClipboardItem(item(f, all, c))])
      .then(() => setMessage(copied))
      .catch((err) => {
        console.error('FlowSnap: copy failed', err);
        setMessage("Couldn't copy. Try again.");
      })
      .finally(() => setBusy(false));
  };
  const latestCopy = useRef(copy);
  latestCopy.current = copy;

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c' || e.shiftKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (getSelection()?.toString()) return; // Copying selected text, as usual.
      e.preventDefault();
      latestCopy.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [shortcut]);

  useEffect(() => {
    if (!message || busy) return;
    const timer = setTimeout(() => setMessage(''), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message, busy]);

  return (
    <div className="continue">
      <button
        type="button"
        className={primary ? 'primary' : undefined}
        onClick={copy}
        disabled={busy || !shots}
        title={title}
        aria-label={label}
      >
        {/* SHOW_PRIMARY_ICON can make the main (filled) button text only. */}
        {(!primary || SHOW_PRIMARY_ICON) && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {icon === 'layers' ? (
              <path d="M12 4.5l9 5-9 5-9-5 9-5zM3 14.5l9 5 9-5" />
            ) : (
              <path d="M3 4h18M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4M12 16v4M8 20h8" />
            )}
          </svg>
        )}
        <span className="btn-label">{label}</span>
      </button>
      {message && (
        <p className="toast" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Continue capture: back to the flow's page to keep recording, adding new screens after these.
 * Stopping the recording brings you back to this canvas with them added.
 */
function ContinueButton({ flow }: { flow: Flow }) {
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const onClick = () => {
    // Website access is needed to record. It was given for the first recording, but ask again here,
    // straight from the click, in case it was turned off since.
    const access = browser.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    void (async () => {
      if (!(await access)) return setError('FlowSnap needs website access to capture.');
      const reply = (await browser.runtime
        .sendMessage({ type: 'continue-flow', flowId: flow.id } satisfies ToBackground)
        .catch(() => undefined)) as ContinueReply | undefined;
      if (!reply) setError("Couldn't continue. Try again.");
      else if (reply.error) setError(reply.error);
    })();
  };

  return (
    <div className="continue">
      <button
        type="button"
        className="continue-button"
        onClick={onClick}
        title="Go back to the page and keep capturing into this flow"
        aria-label="Continue Capture"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22.5 12H2.5M8 6.5 2.5 12 8 17.5" />
        </svg>
        <span className="btn-label">Continue Capture</span>
      </button>
      {error && (
        <p className="toast" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

/** Zoom levels the flow can be shown at. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const DEFAULT_ZOOM = 0.7;
/** A long flow opens zoomed out to fit across the window, but never further than this. */
const START_MIN_ZOOM = 0.4;
/** Zoomed out, the flow's last screen never ends further than this from the right of the window. */
const MAX_RIGHT_GAP = 200;
/** Zooming in or out steps through these. */
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Space kept below the flow when zooming to fit. */
const FIT_MARGIN = 24;

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The next zoom step in or out from `zoom`. */
function nextZoom(zoom: number, direction: 1 | -1) {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  return steps.find((z) => (direction > 0 ? z > zoom + 0.001 : z < zoom - 0.001)) ?? zoom;
}

const IS_MAC = navigator.platform.toLowerCase().includes('mac');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** Pressing a zoom button keeps a selected note selected, so zooming centres on it. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

/** Zoom levels offered as presets in the zoom menu. */
const ZOOM_PRESETS = [0.5, 1, 2];

/**
 * The zoom level at the foot of the sidebar, like Figma's: a small "70%" button that opens a menu
 * with a field to type a level, zoom in, out and to fit (with their shortcuts), and presets.
 */
function ZoomMenu({
  zoom,
  minZoom,
  onZoom,
  onFit,
}: {
  zoom: number;
  minZoom: number;
  onZoom: (z: number) => void;
  onFit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const percent = Math.round(zoom * 100);

  // Close on a click outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Apply the typed level, kept within the limits. Anything that isn't a number changes nothing. */
  const applyTyped = () => {
    const typed = parseFloat(draft.replace('%', ''));
    if (Number.isFinite(typed)) onZoom(Math.min(MAX_ZOOM, Math.max(minZoom, typed / 100)));
    setOpen(false);
  };
  const item = (label: string, shortcut: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={() => {
        run();
        setOpen(false);
      }}
    >
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  );

  return (
    <div className="zoom-menu" ref={root}>
      <button
        type="button"
        className="zoom-level"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Zoom ${percent}%`}
        title="Zoom"
        onMouseDown={keepFocus}
        onClick={() => {
          setDraft(String(percent));
          setOpen(!open);
        }}
      >
        {percent}%
      </button>
      {open && (
        <div className="zoom-popover" role="menu" aria-label="Zoom">
          <input
            className="zoom-field"
            aria-label="Zoom level, in percent"
            inputMode="numeric"
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyTyped();
            }}
          />
          <div className="zoom-rule" />
          {item('Zoom in', `${MOD}+`, () => onZoom(nextZoom(zoom, 1)), zoom >= MAX_ZOOM)}
          {item('Zoom out', `${MOD}−`, () => onZoom(nextZoom(zoom, -1)), zoom <= minZoom + 0.001)}
          {item('Zoom to fit', '⇧1', onFit)}
          <div className="zoom-rule" />
          {ZOOM_PRESETS.map((z) => (
            <span key={z}>{item(`Zoom to ${z * 100}%`, z === 1 ? `${MOD}0` : '', () => onZoom(z), z < minZoom - 0.001)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The numbers of rows a flow of `screens` can be laid out in: each a different number of screens
 * per row, down to 2.
 */
function layoutRowChoices(screens: number) {
  const choices = new Set<number>([1]);
  for (let perRow = screens; perRow >= 2; perRow--) choices.add(Math.ceil(screens / perRow));
  return [...choices].sort((a, b) => a - b);
}

/** The layout preview shows at most this many screens across and rows down, so they stay legible. */
const PREVIEW_MAX_COLS = 7;
const PREVIEW_MAX_ROWS = 4;

/**
 * A small picture of how the flow image will be laid out: plain screens joined by arrows, wrapping
 * from the end of each row to the start of the next, in a frame on the canvas. Every layout is
 * zoomed to fit the same space, so changing the number of rows never makes it jump around. A long
 * flow is shown in part, with "⋯" where rows carry on and where more rows follow.
 */
function LayoutPreview({ screens, rows }: { screens: number; rows: number }) {
  const VW = 298;
  const VH = 126;
  const MARGIN = 18;
  const PAD = 9;
  // Each screen in its own units; the whole layout is then scaled to fit.
  const UW = 30;
  const UH = 20;
  const GAP = 12;
  const ROW_GAP = 15;
  const MORE = 14;

  const perRow = Math.ceil(screens / rows);
  const actualRows = Math.ceil(screens / perRow);
  const cols = Math.min(perRow, PREVIEW_MAX_COLS);
  const shownRows = Math.min(actualRows, PREVIEW_MAX_ROWS);
  const moreAcross = perRow > cols;
  const moreDown = actualRows > shownRows;
  // Screens in each shown row: full rows, and the true length of the last one if it's shown.
  const inRow = (row: number) =>
    row === actualRows - 1 ? Math.min(cols, screens - perRow * row) : cols;
  // Room either side for the arrows that wrap between rows, and for the "⋯" marks.
  const wrap = shownRows > 1 ? GAP / 2 + 2 : 0;
  const naturalW = cols * UW + (cols - 1) * GAP + wrap * 2 + (moreAcross ? MORE : 0);
  const naturalH = shownRows * UH + (shownRows - 1) * ROW_GAP + (moreDown ? MORE : 0);
  const s = Math.min((VW - MARGIN * 2 - PAD * 2) / naturalW, (VH - MARGIN * 2 - PAD * 2) / naturalH);
  const frameW = naturalW * s + PAD * 2;
  const frameH = naturalH * s + PAD * 2;
  const frameX = (VW - frameW) / 2;
  const frameY = (VH - frameH) / 2 + 3;
  const w = UW * s;
  const h = UH * s;
  const gap = GAP * s;
  const rowGap = ROW_GAP * s;
  const wr = wrap * s;
  const left = frameX + PAD + wr;
  const top = frameY + PAD;
  const rightEdge = left + cols * w + (cols - 1) * gap;
  const r = (n: number) => Math.round(n * 10) / 10;
  // An open chevron, like the arrows on the canvas.
  const head = (x: number, y: number) => `M${r(x - 3)} ${r(y - 2.6)}L${r(x - 0.5)} ${r(y)}L${r(x - 3)} ${r(y + 2.6)}`;

  const lines: string[] = [];
  const heads: string[] = [];
  const boxes: { x: number; y: number }[] = [];
  const dots: { x: number; y: number }[] = [];
  for (let row = 0; row < shownRows; row++) {
    const count = inRow(row);
    const y = top + row * (h + rowGap);
    const mid = y + h / 2;
    for (let col = 0; col < count; col++) {
      const x = left + col * (w + gap);
      boxes.push({ x, y });
      if (col < count - 1) {
        lines.push(`M${r(x + w)} ${r(mid)}H${r(x + w + gap - 0.5)}`);
        heads.push(head(x + w + gap, mid));
      }
    }
    // The row carries on past what's shown.
    const actual = row === actualRows - 1 ? screens - perRow * row : perRow;
    if (actual > count) dots.push({ x: rightEdge + MORE * s * 0.55, y: mid });
    if (row < shownRows - 1) {
      // Wrap from the end of this row to the start of the next.
      const end = left + count * (w + gap) - gap;
      const between = y + h + rowGap / 2;
      const next = y + h + rowGap + h / 2;
      lines.push(`M${r(end)} ${r(mid)}H${r(end + wr)}V${r(between)}H${r(left - wr)}V${r(next)}H${r(left - 0.5)}`);
      heads.push(head(left, next));
    }
  }
  // More rows follow below.
  if (moreDown) dots.push({ x: left + (rightEdge - left) / 2, y: top + shownRows * (h + rowGap) - rowGap + MORE * s * 0.6 });

  return (
    <div className="layout-preview">
      <svg viewBox={`0 0 ${VW} ${VH}`} aria-hidden="true">
        <text x={r(frameX)} y={r(frameY - 5)}>
          Flow
        </text>
        <rect className="layout-frame" x={r(frameX)} y={r(frameY)} width={r(frameW)} height={r(frameH)} rx="3" />
        <path className="layout-arrow" d={lines.join('')} />
        <path className="layout-arrowhead" d={heads.join('')} />
        {boxes.map((b, i) => (
          <rect key={i} className="layout-screen" x={r(b.x)} y={r(b.y)} width={r(w)} height={r(h)} rx="2" />
        ))}
        {dots.map((d, i) => (
          <text key={i} className="layout-more" x={r(d.x)} y={r(d.y)}>
            ⋯
          </text>
        ))}
      </svg>
    </div>
  );
}

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

/**
 * The Download button and its menu: pick PNG or PDF for the flow, and optionally include every
 * screenshot, which downloads one zip with the flow and a folder of numbered screenshots.
 */
function Downloads({ flow, screens, clicks }: { flow: Flow; screens: Screen[]; clicks: Map<string, Click> }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<FlowFormat>('png');
  // By default, the screenshots come too, and the flow is one row. Both reset each time the menu
  // opens.
  const [withScreenshots, setWithScreenshots] = useState(false);
  const [rows, setRows] = useState(1);
  // Rows for the flow image: only the counts the screens actually divide into (9 screens can make 1,
  // 2, 3 or 5 rows, but not 4), with at least 2 screens in a full row. A flow too short to wrap has
  // no layout choice at all.
  const rowChoices = layoutRowChoices(screens.length);
  const step = (direction: 1 | -1) => rowChoices[rowChoices.indexOf(rows) + direction];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const shots = screens.filter((s) => s.kind === 'screenshot').length;
  const filename = `${downloadName(flow, screens)}.${withScreenshots ? 'zip' : format}`;

  // Close on a click outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A confirmation clears after a moment.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const download = () => {
    setBusy(true);
    void (async () => {
      try {
        await exportFlow(flow, screens, clicks, format, withScreenshots, rows);
        setOpen(false);
        setMessage(`Saved ${filename} to Downloads`);
      } catch (err) {
        console.error('FlowSnap: download failed', err);
        setMessage("Couldn't download. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="downloads" ref={root}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!shots}
        onClick={() => {
          if (!open) {
            setWithScreenshots(false);
            setRows(1);
          }
          setOpen(!open);
        }}
      >
        Download
        <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="download-menu" role="dialog" aria-label="Download flow">
          <label className="download-option">
            <input type="checkbox" checked={withScreenshots} onChange={(e) => setWithScreenshots(e.currentTarget.checked)} />
            <span>
              <span className="download-option-title">
                {shots === 1 ? 'Include the screenshot' : `Include all ${shots} screenshots`}
              </span>
              <span className="download-option-hint">Each screen exported as an individual PNG in a ZIP folder.</span>
            </span>
          </label>
          <p className="download-label" id="download-format">
            Save user journey as
          </p>
          <div className="segmented" role="radiogroup" aria-labelledby="download-format">
            {(['png', 'pdf'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                className={format === f ? 'selected' : undefined}
                onClick={() => setFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          {rowChoices.length > 1 && (
            <>
              <div className="download-rule" />
              <div className="layout-head">
                <p className="download-label" id="download-layout">
                  Number of rows
                </p>
                <div className="layout-step" role="group" aria-labelledby="download-layout">
                  <button type="button" aria-label="Fewer rows" disabled={step(-1) === undefined} onClick={() => setRows(step(-1)!)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 12h12" />
                    </svg>
                  </button>
                  <output aria-live="polite">{rows}</output>
                  <button type="button" aria-label="More rows" disabled={step(1) === undefined} onClick={() => setRows(step(1)!)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 12h12M12 6v12" />
                    </svg>
                  </button>
                </div>
              </div>
              <LayoutPreview screens={screens.length} rows={rows} />
              <p className="layout-caption">
                {rows === 1
                  ? `All ${screens.length} screens in one row`
                  : `${Math.ceil(screens.length / rows)} screens per row`}
              </p>
            </>
          )}
          <button type="button" className="primary download-go" disabled={busy} onClick={download}>
            {DOWNLOAD_ICON}
            {busy ? 'Preparing…' : 'Download Flow'}
          </button>
        </div>
      )}
      <p className="toast" role="status" hidden={!message}>
        {message}
      </p>
    </div>
  );
}

/** How far the pointer moves before pressing on an arrow becomes dragging it, in pixels. */
const DRAG_THRESHOLD = 3;

/** Length of an arrow's chevron tip. Small, to fit the narrow gap after the arrow's last bend. */
const ARROW_HEAD = 7;

interface Path {
  /** The id of the screen the arrow starts on. */
  from: string;
  /** Where on it the arrow starts, as a fraction of its size. */
  point: { x: number; y: number };
  d: string;
  head: string;
  dashed: boolean;
}

/**
 * Arrows from each click to the screen it led to, drawn over the cards. Clicking one selects it, so
 * its dot stands out to be dragged. Dragging its line moves its start, the same as dragging the
 * dot; double-clicking it puts the start back on the recorded click. They're measured from the
 * cards on the page, so they follow along as screenshots load and the layout changes.
 */
function FlowArrows({
  list,
  ids,
  links,
  selected,
  dimmed,
  onSelect,
  onMoveStart,
  onGaps,
  zoom,
}: {
  list: RefObject<HTMLOListElement | null>;
  /** The screens' ids, in the order `links` refers to them by. */
  ids: string[];
  links: Link[];
  /** The selected arrow, by the id of the screen it starts on. */
  selected: string | null;
  /** An arrow faded while a page is about to be added across it, by the id of the screen it starts on. */
  dimmed: string | null;
  /**
   * Where each arrow runs up or down the gap after its screen, from the top of that screen's list
   * item, in the list's units: the + for adding a page there keeps clear of it.
   */
  onGaps: (gaps: Record<string, { top: number; bottom: number }>) => void;
  /** The flow's zoom: zoomed far out, the gaps between screens widen, so the arrows are redrawn. */
  zoom: number;
  onSelect: (id: string) => void;
  /** Where an arrow starts, as a fraction of its screen, or `undefined` to reset it. */
  onMoveStart: (id: string, point: { x: number; y: number } | undefined, save: boolean) => void;
}) {
  const [paths, setPaths] = useState<Path[]>([]);
  /** The arrow under the pointer, by the id of the screen it starts on, shown thicker. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** The arrow being dragged, where the pointer pressed, and where its start moved to. */
  const drag = useRef<{ path: Path; x: number; y: number; moved: { x: number; y: number } | undefined } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const key = JSON.stringify([ids, links, zoom]);

  useLayoutEffect(() => {
    const ol = list.current;
    if (!ol) return;
    const measure = () => {
      // Positions within the list's content, in its own units: the arrows are drawn inside it, so
      // they scroll and zoom along with the screens.
      const box = (i: number) => {
        const el = ol.querySelector<HTMLElement>(`[data-id="${ids[i]}"] .frame`);
        if (!el) return null;
        let x = 0;
        let y = 0;
        for (let e: HTMLElement | null = el; e && e !== ol; e = e.offsetParent as HTMLElement | null) {
          x += e.offsetLeft;
          y += e.offsetTop;
          // Offsets are measured inside each parent's border, so its border width counts too (the
          // card's 1px border). Without it the arrows sit a pixel off the dots they start from.
          const parent = e.offsetParent as HTMLElement | null;
          if (parent && parent !== ol) {
            x += parent.clientLeft;
            y += parent.clientTop;
          }
        }
        return { x, y, w: el.offsetWidth, h: el.offsetHeight };
      };
      const next: Path[] = [];
      const gaps: Record<string, { top: number; bottom: number }> = {};
      for (const link of links) {
        const from = box(link.from);
        const to = box(link.to);
        if (!from || !to) continue;
        const start = { x: from.x + link.point.x * from.w, y: from.y + link.point.y * from.h };
        // The chevron's point, just touching the next screen once its round end is drawn.
        const endX = to.x - 1.5;
        const endY = Math.min(Math.max(start.y, to.y + 24), to.y + to.h - 24);
        // Down the middle of the gap between the two screens, however wide it is at this zoom.
        const turnX = (from.x + from.w + to.x) / 2;
        const d = `M${start.x} ${start.y} H${turnX} V${endY} H${endX}`;
        const head = `M${endX - ARROW_HEAD} ${endY - 4} L${endX} ${endY} L${endX - ARROW_HEAD} ${endY + 4}`;
        next.push({ from: ids[link.from]!, point: link.point, d, head, dashed: link.dashed });
        const li = ol.querySelector<HTMLElement>(`:scope > li[data-id="${ids[link.from]}"]`);
        if (li) gaps[ids[link.from]!] = { top: Math.min(start.y, endY) - li.offsetTop, bottom: Math.max(start.y, endY) - li.offsetTop };
      }
      setPaths(next);
      onGaps(gaps);
      // Sized to the screens, not the list's scroll size: that includes this layer itself, so it
      // would never shrink after a screen is deleted.
      setSize(contentSize(ol, false));
    };
    measure();
    // Screenshots load after the cards appear, and the window can be resized.
    const observer = new ResizeObserver(measure);
    observer.observe(ol);
    for (const li of ol.querySelectorAll('li')) observer.observe(li);
    return () => observer.disconnect();
    // `key` stands in for `ids` and `links`, which are new arrays on every render.
  }, [key]);

  return (
    <>
    {/* Two layers: the arrows you click, under notes, blurs and circles so those can still be
        grabbed near an arrow; and the arrows you see, over everything, so nothing ever hides them. */}
    <svg className="arrows arrows-hit" width={size.width} height={size.height} aria-hidden="true">
      {paths.map((p) => (
        <g key={p.from}>
          {/* A wide margin around the arrow, where clicking doesn't add a note to the screen. */}
          <path className="arrow-guard" d={p.d} />
          {/* A wider, invisible line over the arrow, so it's easy to click. */}
          <path
            className="arrow-hit"
            d={p.d}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              onSelect(p.from);
              drag.current = { path: p, x: e.clientX, y: e.clientY, moved: undefined };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const dx = d ? e.clientX - d.x : 0;
              const dy = d ? e.clientY - d.y : 0;
              if (!d || (d.moved === undefined && Math.hypot(dx, dy) < DRAG_THRESHOLD)) return;
              // The start moves as far as the pointer has, across the screen it's on.
              const frame = list.current?.querySelector(`[data-id="${d.path.from}"] .frame`);
              if (!frame) return;
              const box = frame.getBoundingClientRect();
              const clamp = (n: number) => Math.min(1, Math.max(0, n));
              d.moved = { x: clamp(d.path.point.x + dx / box.width), y: clamp(d.path.point.y + dy / box.height) };
              onMoveStart(d.path.from, d.moved, false);
            }}
            onPointerUp={() => {
              const d = drag.current;
              drag.current = null;
              if (d?.moved) onMoveStart(d.path.from, d.moved, true);
            }}
            onPointerCancel={() => (drag.current = null)}
            onDoubleClick={() => onMoveStart(p.from, undefined, true)}
            onPointerEnter={() => setHovered(p.from)}
            onPointerLeave={() => setHovered((h) => (h === p.from ? null : h))}
          />
        </g>
      ))}
    </svg>
    <svg className="arrows arrows-shown" width={size.width} height={size.height} aria-hidden="true">
      {paths.map((p) => (
        <g
          key={p.from}
          className={[p.from === selected || p.from === hovered ? 'selected' : '', p.from === dimmed ? 'dim' : ''].join(' ').trim() || undefined}
        >
          <path className={p.dashed ? 'arrow dashed' : 'arrow'} d={p.d} />
          <path className="arrow-head" d={p.head} />
        </g>
      ))}
    </svg>
    </>
  );
}

/** Longest name for a screen. It's also used for its file name in exports. */
const MAX_SCREEN_NAME_LENGTH = 100;

/**
 * A screen's name above its card, renamed in place: click it, type, then press Enter or click away
 * to save. Escape cancels. Clearing it goes back to the default (the page's title).
 */
function ScreenName({ screen, onRename }: { screen: Screen; onRename: (screen: Screen) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = screenLabel(screen);
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  // Focused without scrolling: the name is already on screen, and inside the zoomed flow the
  // browser's own scrolling into view jumps the canvas far off.
  useEffect(() => {
    if (!editing) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [editing]);

  const save = async () => {
    if (draft === null) return;
    const name = draft.replace(/\s+/g, ' ').trim();
    setDraft(null);
    // Empty, or the same as the default: no name of its own.
    const own = name && name !== screenLabel({ ...screen, name: undefined }) ? name : undefined;
    if (own === screen.name) return;
    onRename({ ...screen, name: own });
    // Read it fresh, so nothing else saved to the screen meanwhile is undone.
    const d = await db();
    const current = await d.get('screens', screen.id);
    if (current) await d.put('screens', { ...current, name: own });
  };

  // Wrapped in a margin where clicking does nothing, rather than adding a note to the screen below.
  if (draft === null) {
    return (
      <span className="name-zone">
        <button
          type="button"
          className="title screen-name"
          title={screen.url ? `Rename · ${screen.url}` : 'Rename'}
          onClick={() => setDraft(label)}
        >
          <span className="screen-name-text">{label}</span>
          <span className="sr-only">Rename screen</span>
        </button>
      </span>
    );
  }
  return (
    <span className="name-zone editing">
      <input
        ref={input}
        className="screen-name-input"
        aria-label="Screen name"
        spellCheck
        value={draft}
        maxLength={MAX_SCREEN_NAME_LENGTH}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    </span>
  );
}

/** How far the arrow keys move a selected dot, as a fraction of the screen. Shift moves it further. */
const NUDGE = 0.01;
const BIG_NUDGE = 0.05;

/**
 * The dot an arrow starts from. Drag it anywhere on its screen to move where the arrow starts; the
 * arrow still ends at the next screen. Double-click puts it back where the user clicked. With the
 * arrow selected, the arrow keys move it too.
 */
function ArrowStart({
  point,
  selected,
  onSelect,
  onMove,
}: {
  point: { x: number; y: number };
  selected: boolean;
  onSelect: () => void;
  /** Where it moved to, or `undefined` to reset it. `save` is set once it's let go. */
  onMove: (point: { x: number; y: number } | undefined, save: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  // Pointer to a fraction of the card, which is the same size as the screen inside it.
  const toPoint = (e: ReactPointerEvent<HTMLElement>) => {
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    return { x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height) };
  };
  const moved = useRef<{ x: number; y: number } | null>(null);

  return (
    <button
      type="button"
      className={['arrow-start', selected && 'selected', dragging && 'dragging'].filter(Boolean).join(' ')}
      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
      aria-label="Arrow start. Drag, or use the arrow keys, to move it."
      title="Drag to move where this arrow starts · Double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        onSelect();
        setDragging(true);
        moved.current = null;
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        moved.current = toPoint(e);
        onMove(moved.current, false);
      }}
      onPointerUp={() => {
        setDragging(false);
        if (moved.current) onMove(moved.current, true);
        moved.current = null;
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onMove(undefined, true)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? BIG_NUDGE : NUDGE;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        onSelect();
        onMove({ x: clamp(point.x + dx), y: clamp(point.y + dy) }, true);
      }}
    />
  );
}

/** Tallest tile, in image pixels. */
const DISPLAY_TILE = 4096;
/**
 * How much the canvas sharpens a screenshot after shrinking it. Shrunk text loses some of its edge
 * contrast and reads as soft; this brings it back to about that of text drawn at that size.
 */
const DISPLAY_SHARPEN = 0.3;
/** After zooming stops for this long, screenshots are redrawn at exactly the size they're shown. */
const DISPLAY_SETTLE_MS = 150;
/** Sizes kept ready per screenshot, so zooming back and forth doesn't redraw it every time. */
const DISPLAY_CACHE_SIZES = 4;

const displayCache = new WeakMap<Blob, Map<number, Promise<Blob[]>>>();

/**
 * The screenshot for the canvas at exactly `wanted` pixels wide (the size it's shown at on this
 * screen, at this zoom), shrunk with high-quality resampling and lightly sharpened, as tiles from
 * top to bottom. A screenshot no wider than that, and not too tall, comes back as it is.
 */
function displayImage(image: Blob, width: number, height: number, wanted: number): Promise<Blob[]> {
  const target = Math.min(width, wanted);
  const scaledHeight = width ? Math.round((height * target) / width) : 0;
  if (!width || !target || (width <= target && height <= DISPLAY_TILE)) return Promise.resolve([image]);
  let sizes = displayCache.get(image);
  if (!sizes) displayCache.set(image, (sizes = new Map()));
  let tiles = sizes.get(target);
  if (!tiles) {
    tiles = (async () => {
      const bitmap = await createImageBitmap(image);
      const scale = target / bitmap.width;
      const out: Blob[] = [];
      for (let top = 0; top < scaledHeight; top += DISPLAY_TILE) {
        const h = Math.min(DISPLAY_TILE, scaledHeight - top);
        // The matching band of the original, resized with high-quality resampling.
        const sy = Math.round(top / scale);
        const sh = Math.min(bitmap.height - sy, Math.round(h / scale));
        const tile = await createImageBitmap(bitmap, 0, sy, bitmap.width, sh, {
          resizeWidth: target,
          resizeHeight: h,
          resizeQuality: 'high',
        });
        const canvas = new OffscreenCanvas(tile.width, tile.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(tile, 0, 0);
        tile.close();
        sharpen(ctx, target, h);
        out.push(await canvas.convertToBlob({ type: 'image/png' }));
      }
      bitmap.close();
      return out;
    })().catch(() => [image]);
    sizes.set(target, tiles);
    // Only the most recent few sizes are kept.
    if (sizes.size > DISPLAY_CACHE_SIZES) sizes.delete(sizes.keys().next().value!);
  }
  return tiles;
}

/** Sharpen an image in place with a light unsharp mask (each pixel against its four neighbours). */
function sharpen(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  if (width < 3 || height < 3) return;
  const data = ctx.getImageData(0, 0, width, height);
  const out = data.data;
  const src = new Uint8ClampedArray(out);
  const row = width * 4;
  const amount = DISPLAY_SHARPEN / 4;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * row + x * 4;
      for (let c = i; c < i + 3; c++) {
        const v = src[c]!;
        out[c] = v + amount * (4 * v - src[c - 4]! - src[c + 4]! - src[c - row]! - src[c + row]!);
      }
    }
  }
  ctx.putImageData(data, 0, 0);
}

function ScreenCard({
  screen,
  cardWidth,
  number,
  removing,
  onDelete,
  onRename,
  start,
  newNoteId,
  onChangeNote,
  onChangeMark,
  focusMarkId,
  onDuplicateMark,
  zoom,
  after,
}: {
  screen: Screen;
  /** Its width on the canvas, in canvas pixels: the flow's shared scale (see scale.ts). */
  cardWidth: number;
  number: number;
  /** Deleted and fading out. */
  removing: boolean;
  onDelete: () => void;
  onRename: (screen: Screen) => void;
  /** The dot the arrow to the next screen starts from. */
  start?: ReactNode;
  newNoteId: string | null;
  onChangeNote: (id: string, note: Note | undefined, save: boolean) => void;
  onChangeMark: (kind: MarkKind, id: string, mark: Mark | undefined, save: boolean) => void;
  /** A blur or circle just duplicated or pasted, to select. */
  focusMarkId: string | null;
  /** The flow's zoom, so the screenshot is shown from an image of the right size. */
  zoom: number;
  onDuplicateMark: (kind: MarkKind, mark: Mark) => void;
  /** Shown after the screen, in the gap before the next one: adding a written page there. */
  after?: ReactNode;
}) {
  /** The screenshot's tiles, from top to bottom, at the size it's shown, so it stays sharp. */
  const [srcs, setSrcs] = useState<string[]>([]);
  // The width it's shown at, in this screen's pixels: redrawn to exactly that once zooming
  // settles, and kept showing the previous size meanwhile, so it never blanks.
  const wanted = Math.ceil(cardWidth * zoom * devicePixelRatio);
  const [target, setTarget] = useState(wanted);
  useEffect(() => {
    const timer = setTimeout(() => setTarget(wanted), DISPLAY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wanted]);
  const shown = useRef<string[]>([]);
  useEffect(() => {
    const image = screen.image;
    if (!image) return;
    let cancelled = false;
    void displayImage(image, screen.width, screen.height, target).then((blobs) => {
      if (cancelled) return;
      const urls = blobs.map((b) => URL.createObjectURL(b));
      const previous = shown.current;
      shown.current = urls;
      setSrcs(urls);
      // The old size, once the new one has had time to show.
      setTimeout(() => previous.forEach((url) => URL.revokeObjectURL(url)), 1000);
    });
    return () => {
      cancelled = true;
    };
  }, [screen.image, target]);
  useEffect(() => () => shown.current.forEach((url) => URL.revokeObjectURL(url)), []);

  // Room below the screen for notes hanging off its bottom edge, so they aren't cut off.
  const height = screen.width ? (cardWidth * screen.height) / screen.width : 0;
  const below = height ? notesBottom(screen, CARD_WIDTH, height) - height : 0;

  return (
    <li
      data-id={screen.id}
      className={removing ? 'removing' : undefined}
      aria-hidden={removing || undefined}
      style={{ '--card-w': `${cardWidth}px`, ...(below ? { paddingBottom: below } : {}) } as CSSProperties}
    >
      <div className="meta">
        <span className="num">{String(number).padStart(2, '0')}</span>
        <ScreenName screen={screen} onRename={onRename} />
        <DeleteButton number={number} onDelete={onDelete} />
      </div>
      {screen.unlinked && <p className="unlinked">Connection not recorded</p>}
      <div className="card">
        <div
          className="shot frame"
          // Not the browser's own drag of the screenshot as an image.
          onDragStart={(e) => e.preventDefault()}
        >
          {srcs.map((src, i) => (
            <img key={src} src={src} alt={i ? '' : `Screen ${number}: ${screen.title}`} draggable={false} />
          ))}
        </div>
        {start}
        {(['blurs', 'circles'] as const).map((kind) =>
          screen[kind]?.map((m) => (
            <MarkBox
              key={m.id}
              kind={kind}
              mark={m}
              cardWidth={cardWidth}
              cardHeight={height}
              onChange={(mark, save) => onChangeMark(kind, m.id, mark, save)}
              focus={m.id === focusMarkId}
              onDuplicate={() => onDuplicateMark(kind, m)}
              onCopy={() => (copiedMark = { screenId: screen.id, kind, mark: m, pastes: 0, target: screen.id })}
            />
          )),
        )}
        {screen.notes?.map((n) => (
          <StickyNote
            key={n.id}
            note={n}
            autoFocus={n.id === newNoteId}
            onChange={(note, save) => onChangeNote(n.id, note, save)}
          />
        ))}
      </div>
      {after}
    </li>
  );
}

/**
 * A blur this close to a screen's corner (in canvas pixels, the most its rounding reaches) gets
 * that corner rounded to match.
 */
const BLUR_CORNER_REACH = 14;

/** How far a duplicated or pasted blur or circle sits from the original, in canvas pixels. */
const COPY_OFFSET = 16;

/**
 * The blur or circle last copied with ⌘C, kept in the page rather than the system clipboard, and
 * how many times it's been pasted so each paste lands a step further along.
 */
let copiedMark: { screenId: string; kind: MarkKind; mark: Mark; pastes: number; target?: string } | null = null;

/** The screen the pointer is over, and the one last clicked, for pasting onto. */
const pasteTarget: { hovered?: string; clicked?: string } = {};
const screenUnder = (e: Event) =>
  e.target instanceof Element ? e.target.closest<HTMLElement>('.screens > li[data-id]')?.dataset.id : undefined;
addEventListener('pointerover', (e) => (pasteTarget.hovered = screenUnder(e)), true);
addEventListener('pointerdown', (e) => (pasteTarget.clicked = screenUnder(e) ?? pasteTarget.clicked), true);


/** What can be dragged from the sidebar onto a screen. */
type Dropped = 'notes' | MarkKind;

/**
 * The sidebar's items, top to bottom, each showing the thing itself (a sticky note, a blur, a
 * circle) to be dragged onto a screen. Blur and circle can also be clicked, to draw one at any
 * size; clicking again, or Escape, puts it down.
 */
const SIDEBAR: { item: Dropped; label: string; hint: string }[] = [
  { item: 'notes', label: 'Note', hint: 'Drag onto a screen to add a note' },
  { item: 'blurs', label: 'Blur', hint: 'Drag onto a screen to blur part of it' },
  { item: 'circles', label: 'Circle', hint: 'Drag onto a screen to circle something' },
];

/** A small picture of each item, drawn as the object itself so it reads as something to pick up. */
function SidebarArt({ item }: { item: Dropped }) {
  if (item === 'notes') {
    // A flat yellow square with two lines of writing and its bottom-right corner curled up.
    return (
      <span className="side-art side-note" aria-hidden="true">
        <i className="side-note-line" />
        <i className="side-note-line" />
        <i className="side-note-curl" />
      </span>
    );
  }
  if (item === 'blurs') {
    return (
      // A card with a dot and two short lines on the left, melting into pink and lilac haze on the
      // right, inside a bold, rounded dashed selection.
      <svg className="side-art side-blur" viewBox="0 0 38 28" aria-hidden="true">
        <defs>
          <filter id="side-blur-haze" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <clipPath id="side-blur-box">
            <rect x="2.5" y="2.5" width="33" height="23" rx="6" />
          </clipPath>
        </defs>
        <rect x="2.5" y="2.5" width="33" height="23" rx="6" fill="#fff" />
        <g clipPath="url(#side-blur-box)">
          <circle cx="9.5" cy="10" r="3.6" fill="#e7a6cf" />
          <rect x="15" y="8.5" width="8" height="3" rx="1.5" fill="#b98aaf" />
          <rect x="6" y="17" width="11" height="3" rx="1.5" fill="#c9a8c0" />
          <g filter="url(#side-blur-haze)">
            <circle cx="29" cy="9" r="6" fill="#f2b8d9" />
            <circle cx="25" cy="21" r="5.5" fill="#c7b6f2" />
          </g>
        </g>
        <rect className="side-blur-dashes" x="2.5" y="2.5" width="33" height="23" rx="6" />
      </svg>
    );
  }
  return (
    <svg className="side-art side-circle" viewBox="0 0 38 28" aria-hidden="true">
      {/* A hand-drawn marker loop: slightly tilted and uneven, heavier where the pen pressed and
          tapering at both ends, stopping just short of where it started. */}
      <path d="M11.8 6.5L12.6 6.2L13.4 6L14.3 5.9L15.1 5.7L16 5.6L16.8 5.5L17.7 5.5L18.6 5.5L19.5 5.6L20.4 5.8L21.2 5.9L22.1 6.1L23 6.2L23.9 6.3L24.7 6.5L25.5 6.7L26.4 6.9L27.2 7.2L27.9 7.6L28.6 7.9L29.3 8.3L30 8.7L30.5 9.2L31.1 9.7L31.6 10.2L32 10.7L32.4 11.2L32.7 11.7L32.9 12.2L33.2 12.8L33.3 13.3L33.4 13.9L33.5 14.4L33.5 15L33.5 15.6L33.4 16.1L33.3 16.7L33.1 17.2L32.9 17.7L32.6 18.3L32.3 18.8L31.9 19.3L31.4 19.8L31 20.3L30.4 20.8L29.8 21.2L29.2 21.6L28.5 22L27.8 22.3L27 22.6L26.2 22.9L25.4 23.2L24.5 23.3L23.6 23.5L22.7 23.6L21.8 23.7L20.9 23.7L20 23.7L19.1 23.7L18.2 23.6L17.3 23.5L16.4 23.4L15.5 23.2L14.6 23L13.8 22.8L13 22.5L12.1 22.3L11.3 22L10.5 21.7L9.7 21.3L9 21L8.2 20.6L7.5 20.1L6.8 19.7L6.2 19.2L5.6 18.8L5 18.3L4.4 17.8L3.9 17.2L3.5 16.7L3.2 16.1L2.9 15.5L2.6 14.9L2.5 14.2L2.5 13.6L2.5 13L2.7 12.3L2.9 11.7L3.2 11.1L3.5 10.5L4 9.9L4.5 9.3L5.1 8.8L5.7 8.3L6.4 7.8L7.1 7.4L6.4 6.2L5.6 6.7L4.9 7.2L4.2 7.8L3.5 8.4L3 9L2.4 9.7L2 10.4L1.6 11.2L1.4 12L1.2 12.8L1.1 13.6L1.1 14.4L1.2 15.2L1.4 16L1.6 16.8L2 17.6L2.4 18.3L2.9 19L3.5 19.7L4.1 20.4L4.8 21L5.5 21.6L6.3 22.1L7.1 22.6L7.9 23L8.8 23.4L9.6 23.8L10.5 24.1L11.4 24.4L12.3 24.7L13.2 25L14.1 25.2L15.1 25.4L16 25.6L17 25.8L17.9 25.9L18.9 26L19.9 26L20.9 26L21.9 26L22.9 25.9L23.9 25.8L24.9 25.6L25.9 25.4L26.9 25.2L27.8 24.8L28.7 24.5L29.6 24.1L30.4 23.6L31.2 23.2L31.9 22.6L32.6 22.1L33.2 21.5L33.8 20.8L34.3 20.2L34.7 19.5L35.1 18.8L35.4 18.1L35.7 17.3L35.8 16.6L36 15.8L36 15.1L36 14.3L35.9 13.5L35.8 12.7L35.6 12L35.3 11.2L35 10.5L34.5 9.8L34.1 9.1L33.5 8.4L32.9 7.8L32.2 7.2L31.5 6.6L30.7 6.1L29.9 5.6L29.1 5.1L28.2 4.7L27.2 4.4L26.3 4.1L25.3 3.8L24.4 3.6L23.4 3.4L22.4 3.3L21.4 3.3L20.4 3.4L19.5 3.5L18.5 3.6L17.6 3.8L16.7 3.9L15.8 4L14.9 4.2L14 4.3L13.1 4.5L12.2 4.7L11.4 4.9Z" />
    </svg>
  );
}

/**
 * The thin grey sidebar on the left of the canvas, holding things to drag onto screens: a sticky
 * note, a blur to hide sensitive information and a circle to point something out. They're only
 * dragged and dropped, never picked as a tool. The zoom controls sit at its foot.
 */
function Sidebar({
  disabled,
  zoom,
  minZoom,
  onZoom,
  onFit,
  onDrop,
}: {
  /** No screens to drop anything on: the tools are shown switched off. */
  disabled: boolean;
  zoom: number;
  minZoom: number;
  onZoom: (z: number) => void;
  onFit: () => void;
  /** Something was dragged off the sidebar and let go here, in window coordinates. */
  onDrop: (kind: Dropped, x: number, y: number) => void;
}) {
  /** An item being dragged onto a screen, and where the pointer is. */
  const [dragging, setDragging] = useState<{ kind: Dropped; x: number; y: number } | null>(null);
  /** Set once a press on an item has turned into a drag, so letting go drops it. */
  const dragged = useRef(false);

  const startDrag = (kind: Dropped) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    const onMove = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_THRESHOLD) return;
      dragged.current = true;
      setDragging({ kind, x: m.clientX, y: m.clientY });
    };
    const onUp = (u: PointerEvent) => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      setDragging(null);
      if (dragged.current) onDrop(kind, u.clientX, u.clientY);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  };
  const ghost = dragging && (dragging.kind === 'notes' ? { w: NOTE_SIZE, h: NOTE_SIZE } : defaultMarkSize(dragging.kind));

  return (
    <aside
      className={disabled ? 'sidebar disabled' : 'sidebar'}
      role="toolbar"
      aria-label="Canvas tools"
      aria-orientation="vertical"
    >
      {SIDEBAR.map((t) => (
        <button
          key={t.item}
          type="button"
          className="side-item draggable"
          disabled={disabled}
          aria-label={t.label}
          aria-description={t.hint}
          onMouseDown={keepFocus}
          onPointerDown={startDrag(t.item)}
        >
          <span className="side-tile">
            <SidebarArt item={t.item} />
          </span>
          <span className="side-name">{t.label}</span>
        </button>
      ))}
      {/* Under the tools, a handwritten note saying how they're used, with a little arrow above it
          curving off toward the canvas. */}
      <div className="side-hint">
        {/* Rising from the top right of the note in one round curve, off to the right. */}
        <svg className="side-hint-arrow" viewBox="0 0 28 24" aria-hidden="true">
          <path d="M4 22C4 11 10 5 24 5" />
          <path d="M19.8 1.2 24 5l-4.2 3.8" />
        </svg>
        <p className="side-caption">Drag these onto a screen!</p>
      </div>
      {/* Zoom, at the foot of the sidebar. */}
      <div className="side-zoom">
        <ZoomMenu zoom={zoom} minZoom={minZoom} onZoom={onZoom} onFit={onFit} />
      </div>
      {dragging &&
        ghost &&
        createPortal(
          <div
            className={`mark-ghost ${
              dragging.kind === 'blurs' ? 'mark-blur' : dragging.kind === 'notes' ? 'mark-ghost-note' : 'mark-ghost-circle'
            }`}
            style={{ left: dragging.x, top: dragging.y, width: ghost.w * zoom, height: ghost.h * zoom }}
            aria-hidden="true"
          />,
          document.body,
        )}
    </aside>
  );
}

/**
 * A blur or circle on a screen. Drag it to move it, drag its corner to resize it, and its × (or
 * Delete) removes it. On the canvas a blur is a frosted box; exports blur the image itself.
 */
function MarkBox({
  kind,
  mark,
  cardWidth,
  cardHeight,
  onChange,
  focus,
  onDuplicate,
  onCopy,
}: {
  kind: MarkKind;
  mark: Mark;
  /** The screen's height on the canvas, so a circle's wobble keeps its shape. */
  /** The screen's width on the canvas. */
  cardWidth: number;
  cardHeight: number;
  /** Moved or resized, or `undefined` when deleted. `save` is set once a drag ends. */
  onChange?: (mark: Mark | undefined, save: boolean) => void;
  /** Just duplicated or pasted: select it. */
  focus?: boolean;
  /** ⌘D (Ctrl+D): put a copy beside it. */
  onDuplicate?: () => void;
  /** ⌘C (Ctrl+C): copy it, to paste with ⌘V. */
  onCopy?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const drag = useRef<{ x: number; y: number; from: Mark; resize: boolean; moved?: Mark } | null>(null);
  const width = mark.w * cardWidth;
  const height = mark.h * cardHeight;

  const onPointerDown = (resize: boolean) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !onChange) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.closest<HTMLElement>('.mark')?.focus();
    drag.current = { x: e.clientX, y: e.clientY, from: mark, resize };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !onChange) return;
    const card = e.currentTarget.closest('.card')!.getBoundingClientRect();
    const dx = (e.clientX - d.x) / card.width;
    const dy = (e.clientY - d.y) / card.height;
    const f = d.from;
    const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
    d.moved = d.resize
      ? {
          ...f,
          w: clamp(f.w + dx, Math.min(f.w, MIN_MARK_PX / cardWidth), 1 - f.x),
          h: clamp(f.h + dy, Math.min(f.h, MIN_MARK_PX / (cardHeight || CARD_WIDTH)), 1 - f.y),
        }
      : { ...f, x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) };
    onChange(d.moved, false);
  };
  const onPointerUp = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (moved) onChange?.(moved, true);
  };

  // A blur reaching into one of the screen's rounded corners is rounded the same there, so it
  // never pokes out past the screenshot's curve.
  const nearX = BLUR_CORNER_REACH / cardWidth;
  const nearY = cardHeight ? BLUR_CORNER_REACH / cardHeight : 0;
  const atLeft = mark.x <= nearX;
  const atRight = 1 - mark.x - mark.w <= nearX;
  const atTop = mark.y <= nearY;
  const atBottom = 1 - mark.y - mark.h <= nearY;
  const corners =
    kind === 'blurs'
      ? [atTop && atLeft && 'at-tl', atTop && atRight && 'at-tr', atBottom && atLeft && 'at-bl', atBottom && atRight && 'at-br']
          .filter(Boolean)
          .join(' ')
      : '';
  return (
    <div
      ref={box}
      className={`mark ${kind === 'blurs' ? 'mark-blur' : 'mark-circle'} ${corners}`.trim()}
      style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, width: `${mark.w * 100}%`, height: `${mark.h * 100}%` }}
      tabIndex={0}
      aria-label={kind === 'blurs' ? 'Blur' : 'Circle'}
      onPointerDown={onPointerDown(false)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onChange?.(undefined, true);
        } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
          const key = e.key.toLowerCase();
          if (key !== 'd' && key !== 'c') return;
          // Not the browser's bookmark shortcut, or Copy for Figma's ⌘C on the canvas.
          e.preventDefault();
          e.stopPropagation();
          if (key === 'd') onDuplicate?.();
          else onCopy?.();
        }
      }}
    >
      {kind === 'circles' && width > 0 && height > 0 && (
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <path d={smoothPath(circlePoints(mark, width, height))} />
        </svg>
      )}
      <button
        type="button"
        className="mark-delete"
        aria-label={kind === 'blurs' ? 'Delete blur' : 'Delete circle'}
        title="Delete"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onChange?.(undefined, true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
      <span
        className="mark-resize"
        title="Drag to resize"
        // Its moves reach the box's own handlers, which do the resizing.
        onPointerDown={onPointerDown(true)}
      />
    </div>
  );
}

/**
 * A sticky note on a screen: a coloured square with its text centred, shrinking to fit as it grows,
 * like a sticky note in Miro. Drag it by the space around the text; the × deletes it. A note stays
 * when you click away, even before anything is written in it. While it's selected, a palette beside
 * it switches it between yellow, green (something good) and pink (something to fix).
 */
function StickyNote({
  note,
  autoFocus,
  onChange,
}: {
  note: Note;
  autoFocus: boolean;
  /** The note changed, or `undefined` when it's deleted. `save` is set once an edit or drag ends. */
  onChange: (note: Note | undefined, save: boolean) => void;
}) {
  /** Where the pointer pressed and where the note was then, and where it's moved to. */
  const drag = useRef<{ x: number; y: number; from: Note; moved?: Note } | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  // A new note is ready to type in. Focused without scrolling: it was just dropped where it's
  // seen, and inside the zoomed flow the browser's own scrolling into view jumps the canvas far off.
  useEffect(() => {
    if (autoFocus) text.current?.focus({ preventScroll: true });
  }, []);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const { font } = fitNote(note.text || 'Write a note…');

  return (
    <div
      className="note"
      style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%`, background: notePaper(note) }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('button, textarea')) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, from: note };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        // Moves as far as the pointer has, across the card it's on. It can hang off the right and
        // bottom edges, but always overlaps the screen a little.
        const el = e.currentTarget.closest<HTMLElement>('.card')!;
        const card = el.getBoundingClientRect();
        const maxX = 1 - NOTE_OVERLAP / el.offsetWidth;
        const maxY = 1 - NOTE_OVERLAP / el.offsetHeight;
        d.moved = {
          ...note,
          x: Math.min(maxX, clamp(d.from.x + dx / card.width)),
          y: Math.min(maxY, clamp(d.from.y + dy / card.height)),
        };
        onChange(d.moved, false);
      }}
      onPointerUp={() => {
        const moved = drag.current?.moved;
        const pressed = !!drag.current;
        drag.current = null;
        if (moved) onChange(moved, true);
        // A click on the note without dragging it starts typing at the end of its text.
        else if (pressed && text.current) {
          text.current.focus({ preventScroll: true });
          text.current.setSelectionRange(text.current.value.length, text.current.value.length);
        }
      }}
      onPointerCancel={() => (drag.current = null)}
    >
      <button type="button" className="note-delete" aria-label="Delete note" title="Delete note" onClick={() => onChange(undefined, true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
      {/* While the note is selected: its colour. Pressing a colour doesn't take the focus from the
          note, so it stays selected and you can keep typing. */}
      <div className="note-colors" role="radiogroup" aria-label="Note colour">
        {NOTE_PAPERS.map((p) => (
          <button
            key={p.color}
            type="button"
            role="radio"
            aria-checked={(note.color ?? 'yellow') === p.color}
            aria-label={p.label}
            title={p.label}
            style={{ background: p.paper }}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange({ ...note, color: p.color === 'yellow' ? undefined : p.color }, true)}
          />
        ))}
      </div>
      <textarea
        ref={text}
        className="note-text"
        aria-label="Note"
        placeholder="Write a note…"
        spellCheck
        style={{ fontSize: `${font}px` }}
        value={note.text}
        onChange={(e) => onChange({ ...note, text: e.currentTarget.value }, false)}
        onBlur={() => onChange(note, true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
    </div>
  );
}

/** A page that opened in another tab. FlowSnap didn't record it, so this marks its place. */
function NewTabCard({
  screen,
  number,
  removing,
  onDelete,
  onRename,
  start,
  newNoteId,
  onChangeNote,
  after,
}: {
  screen: Screen;
  number: number;
  removing: boolean;
  onDelete: () => void;
  onRename: (screen: Screen) => void;
  start?: ReactNode;
  newNoteId: string | null;
  onChangeNote: (id: string, note: Note | undefined, save: boolean) => void;
  after?: ReactNode;
}) {
  let host = '';
  try {
    host = new URL(screen.url).host;
  } catch {
    // No address yet, or one FlowSnap can't read.
  }
  return (
    <li
      className={removing ? 'placeholder removing' : 'placeholder'}
      data-id={screen.id}
      aria-hidden={removing || undefined}
    >
      <div className="meta">
        <span className="num">{String(number).padStart(2, '0')}</span>
        <ScreenName screen={screen} onRename={onRename} />
        <DeleteButton number={number} onDelete={onDelete} />
      </div>
      <div className="card">
        {/* Laid out like a written page: a large icon, a headline and text, on an empty card. */}
        <div className="placeholder-body frame">
          <span className="placeholder-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={TEXT_PAGE_ICONS.newTab.d} />
            </svg>
          </span>
          <p className="placeholder-title">{screen.title || host || 'A page in another tab'}</p>
          {screen.url && (
            <a href={screen.url} target="_blank" rel="noreferrer">
              {host}
            </a>
          )}
          <p className="placeholder-note">Not recorded. To include a tab like this, click FlowSnap in it while recording.</p>
        </div>
        {start}
        {screen.notes?.map((n) => (
          <StickyNote
            key={n.id}
            note={n}
            autoFocus={n.id === newNoteId}
            onChange={(note, save) => onChangeNote(n.id, note, save)}
          />
        ))}
      </div>
      {after}
    </li>
  );
}

/**
 * A page written by the user between two screens, describing a step that wasn't captured: a large
 * icon, a headline and a line or two under it, on a pale plum card.
 * Arrows run into and out of it like any screen.
 */
function TextPageCard({
  screen,
  number,
  removing,
  onDelete,
  onRename,
  start,
  autoFocus,
  onChange,
  after,
}: {
  screen: Screen;
  number: number;
  removing: boolean;
  onDelete: () => void;
  onRename: (screen: Screen) => void;
  start?: ReactNode;
  autoFocus: boolean;
  /** Its headline, text or icon changed. `save` is set once editing ends. */
  onChange: (change: Pick<Partial<Screen>, 'heading' | 'text' | 'icon'>, save: boolean) => void;
  after?: ReactNode;
}) {
  const heading = useRef<HTMLTextAreaElement>(null);
  /** Whether the icons to pick from were already showing when the icon was pressed. */
  const iconWasOpen = useRef(false);
  // Ready to type in when just added. Focused without scrolling: inside the zoomed flow the
  // browser's own scrolling into view jumps the canvas far off.
  useEffect(() => {
    if (autoFocus) heading.current?.focus({ preventScroll: true });
  }, []);
  const icon = textPageIconPath(screen.icon);
  const blurOnEscape = (e: { key: string; currentTarget: HTMLElement }) => {
    if (e.key === 'Escape') e.currentTarget.blur();
  };
  /**
   * Whether an edit would make a field run past its most lines (its max-height), counting both
   * wrapped lines and new ones. Such an edit isn't kept, so the card never grows too tall.
   */
  const tooLong = (el: HTMLTextAreaElement) => el.scrollHeight > el.clientHeight + 1;
  /** ⌘Return, Ctrl+Return or ⇧Return starts a new line (and can be undone like typing). */
  const newLine = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey || e.shiftKey)) return false;
    e.preventDefault();
    document.execCommand('insertText', false, '\n');
    return true;
  };
  return (
    <li
      className={['text-page', removing && 'removing', autoFocus && 'added'].filter(Boolean).join(' ')}
      data-id={screen.id}
      aria-hidden={removing || undefined}
    >
      <div className="meta">
        <span className="num">{String(number).padStart(2, '0')}</span>
        <ScreenName screen={screen} onRename={onRename} />
        <DeleteButton number={number} onDelete={onDelete} />
      </div>
      <div className="card">
        <div className="text-page-body frame">
          {/* Clicking the icon opens the icons to pick from (by selecting the page), and clicking it
              again closes them. */}
          <button
            type="button"
            className="text-page-icon"
            aria-label="Change icon"
            title="Change icon"
            onMouseDown={(e) => {
              iconWasOpen.current = !!e.currentTarget.closest('.text-page')?.contains(document.activeElement);
            }}
            onClick={(e) => {
              if (iconWasOpen.current) (document.activeElement as HTMLElement | null)?.blur();
              else e.currentTarget.focus({ preventScroll: true });
              iconWasOpen.current = false;
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={icon} />
            </svg>
          </button>
          {/* The headline wraps onto more lines as it grows, never cut off. */}
          <textarea
            ref={heading}
            className="text-page-heading"
            aria-label="Headline"
            placeholder={TEXT_PAGE_HEADING_PLACEHOLDER}
            spellCheck
            rows={1}
            maxLength={120}
            value={screen.heading ?? ''}
            onChange={(e) => {
              if (!tooLong(e.currentTarget)) onChange({ heading: e.currentTarget.value }, false);
            }}
            onBlur={(e) => onChange({ heading: e.currentTarget.value }, true)}
            // Return starts a new line, so a headline can run over two or more; Tab moves on to the
            // text under it.
            onKeyDown={(e) => {
              blurOnEscape(e);
              newLine(e);
            }}
          />
          {/* Kept to a short paragraph, so the card stays about a screenshot's height without
              scrolling. How much is left shows near the limit. */}
          <textarea
            className="text-page-text"
            aria-label="What happens"
            placeholder={TEXT_PAGE_BODY_PLACEHOLDER}
            spellCheck
            maxLength={TEXT_PAGE_BODY_MAX}
            value={screen.text ?? ''}
            onChange={(e) => {
              if (!tooLong(e.currentTarget)) onChange({ text: e.currentTarget.value }, false);
            }}
            onBlur={(e) => onChange({ text: e.currentTarget.value }, true)}
            onKeyDown={(e) => {
              blurOnEscape(e);
              newLine(e);
            }}
          />
          {(screen.text?.length ?? 0) > TEXT_PAGE_BODY_MAX - TEXT_PAGE_COUNT_FROM && (
            <span className="text-page-count" aria-live="polite">
              {TEXT_PAGE_BODY_MAX - (screen.text?.length ?? 0)}
            </span>
          )}
          {/* Quick icons in a white pill along the bottom, like a sticky note's colours, shown while
              it's selected. Pressing one doesn't take the focus from the text. */}
          <div className="text-page-icons" role="radiogroup" aria-label="Icon">
            {(Object.keys(TEXT_PAGE_ICONS) as TextPageIcon[]).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={screen.icon === key}
                aria-label={TEXT_PAGE_ICONS[key].label}
                title={TEXT_PAGE_ICONS[key].label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange({ icon: screen.icon === key ? undefined : key }, true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={TEXT_PAGE_ICONS[key].d} />
                </svg>
              </button>
            ))}
          </div>
        </div>
        {start}
      </div>
      {after}
    </li>
  );
}

/**
 * In the gap after a screen. Hovering the gap shows a thin line down it where a new page would go,
 * then a beat later a small round + on the line, partway down and clear of the screen's trash
 * button. Hovering the + fades the arrow across the gap; clicking adds a written page there.
 */
function InsertPage({
  onInsert,
  onHover,
  avoid,
  zoom,
}: {
  onInsert: () => void;
  onHover: (on: boolean) => void;
  /** Where the arrow runs up or down this gap, from the top of the screen's list item. */
  avoid?: { top: number; bottom: number };
  zoom: number;
}) {
  const zone = useRef<HTMLDivElement>(null);
  const [y, setY] = useState<number | undefined>(undefined);
  /** The line runs as far down as the shorter of the two cards it sits between. */
  const [line, setLine] = useState<{ top: number; height: number } | undefined>(undefined);
  const measureLine = () => {
    const li = zone.current?.closest('li');
    const left = li?.querySelector<HTMLElement>('.card');
    const right = li?.nextElementSibling?.querySelector<HTMLElement>('.card');
    if (!left || !right) return;
    const next = { top: left.offsetTop, height: Math.min(left.offsetHeight, right.offsetHeight) };
    setLine((was) => (was?.top === next.top && was.height === next.height ? was : next));
  };
  // Measured now, again as the cards change size (screenshots load in), and on hovering the gap.
  useLayoutEffect(() => {
    const li = zone.current?.closest('li');
    const left = li?.querySelector<HTMLElement>('.card');
    const right = li?.nextElementSibling?.querySelector<HTMLElement>('.card');
    if (!left || !right) return;
    const measure = measureLine;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(left);
    observer.observe(right);
    return () => observer.disconnect();
  }, []);
  // Halfway down the gap (but not far below the top); and if the arrow runs there, just above it,
  // or else just below it.
  useLayoutEffect(() => {
    // Within the line, which runs as far down as the shorter card.
    const height = line ? line.top + line.height : (zone.current?.offsetHeight ?? 0);
    const size = 22 / zoom;
    const clearance = 10 / zoom + size / 2;
    let at = Math.min(Math.max(150, height / 2), 300);
    if (avoid && at + clearance > avoid.top && at - clearance < avoid.bottom) {
      const above = avoid.top - clearance;
      const below = avoid.bottom + clearance;
      at = above >= INSERT_MIN_Y ? above : below <= height - size ? below : at;
    }
    setY(at);
  }, [avoid?.top, avoid?.bottom, zoom, line?.top, line?.height]);
  return (
    <div
      className="insert-page"
      ref={zone}
      style={
        {
          ...(y === undefined ? {} : { '--plus-y': `${y}px` }),
          ...(line === undefined ? {} : { '--line-top': `${line.top}px`, '--line-height': `${line.height}px` }),
        } as CSSProperties
      }
    >
      <span className="insert-hover" aria-hidden="true" onMouseEnter={measureLine} />
      <span className="insert-line" aria-hidden="true" />
      <button
        type="button"
        aria-label="Add a written page here"
        title="Add a page in between"
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        onClick={() => {
          onHover(false);
          onInsert();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 6v12M6 12h12" />
        </svg>
      </button>
    </div>
  );
}

// Notes measure their text to fit it, and exports draw it, so the fonts are loaded before anything is
// shown. A missing font only falls back to the system one.
Promise.all([document.fonts.load("700 13px 'Manrope Variable'"), document.fonts.load("600 13px 'JetBrains Mono Variable'", '0123456789')])
  .catch(() => {})
  .finally(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Viewer />
      </StrictMode>,
    ),
  );
