import { browser, type Browser } from 'wxt/browser';
import { db, screenKeys, type Screen } from '@/utils/db';
import { fingerprint, nearlyIdentical, type Fingerprint } from '@/utils/similarity';
import { defaultFlowName, siteName } from '@/utils/flowName';
import { addToScreen, fillGaps, tallLimit } from '@/utils/tallScreen';
import { PANEL_POSITION_KEY, type ContinueReply, type Gap, type ToViewer, type HelloReply, type PrepareReply, type ToBackground, type ToPage } from '@/utils/messages';

/**
 * The current recording. Kept in session storage so it survives the service worker going idle.
 *
 * A recording starts in one tab and can include tabs the user adds by clicking the icon in
 * them. Only the tab in front is ever captured. Keys of the records below are tab ids.
 */
interface Recording {
  flowId: string;
  /** The tab the recording started in. */
  originalTabId: number;
  /** Tabs currently being recorded: the original plus added tabs not yet marked done. */
  tabIds: number[];
  /** Each tab's number within the flow (1 is the original), kept even after it's done. */
  tabNumbers: Record<string, number>;
  /** Tabs opened by a click in the flow, mapped to their placeholder screen's id. */
  placeholders: Record<string, string>;
  /** Added tabs with no placeholder whose next screen joins with a "connection not recorded" arrow. */
  unlinked: number[];
  screenCount: number;
}

const CONTENT_SCRIPT = 'content-scripts/content.js';
/** Id of the content script registered while recording, so it starts on each page as early as possible. */
const RECORDER_ID = 'flowsnap-recorder';
/** Chrome allows 2 captureVisibleTab calls per second. Stay just under it. */
const MIN_CAPTURE_GAP_MS = 510;
const DEFAULT_TITLE = 'FlowSnap: click to start recording';

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    // Ask for website access first, while Chrome still treats this as a user click.
    // If access was already granted, this resolves straight away with no prompt.
    const access = browser.permissions.request({ origins: ['<all_urls>'] }).catch((err) => {
      console.warn('FlowSnap: permission request failed', err);
      return false;
    });
    void onIconClick(tab, access);
  });

  browser.runtime.onMessage.addListener((msg: ToBackground, sender, sendResponse) => {
    if (msg.type === 'hello') {
      // A page asking whether to record. It runs in every tab while recording, so only
      // recorded tabs say yes.
      void getRecording().then((rec) => {
        const tabId = sender.tab?.id;
        const reply: HelloReply = {
          recording: !!rec && tabId != null && rec.tabIds.includes(tabId),
          screenCount: rec?.screenCount ?? 0,
          ownScreenPending: !!rec && (rec.screenCount === 0 || (tabId != null && rec.unlinked.includes(tabId))),
        };
        sendResponse(reply);
      });
      return true; // Reply asynchronously.
    }
    if (msg.type === 'continue-flow') {
      void continueFlow(msg.flowId).then(sendResponse);
      return true; // Reply asynchronously.
    }
    void onPageMessage(msg, sender.tab?.id);
    return false;
  });

  // Normally the registered script has already started on the new page and asked for its own
  // capture. This is a fallback for pages it missed. A page never runs it twice.
  browser.tabs.onUpdated.addListener(async (tabId, change) => {
    if (change.status !== 'complete') return;
    const rec = await getRecording();
    if (rec?.tabIds.includes(tabId)) await injectRecorder(tabId);
  });

  // Switching to a recorded tab: capture it if it changed while it was in the background.
  // If it didn't, this finds the screen already captured and does nothing.
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    const rec = await getRecording();
    if (rec?.tabIds.includes(tabId)) enqueueCapture(tabId);
  });

  // A click that opens a new tab: FlowSnap doesn't follow it, but leaves a placeholder in the flow.
  // A popup window (like "Sign in with Google") is followed, since it has no toolbar to click
  // FlowSnap in, and it's always part of the flow. Its first screen replaces the placeholder.
  browser.tabs.onCreated.addListener(async (tab) => {
    const rec = await getRecording();
    const opener = tab.openerTabId;
    if (!rec || opener == null || !rec.tabIds.includes(opener) || tab.id == null) return;
    const newTabId = tab.id;
    const popup = (await browser.windows.get(tab.windowId).catch(() => undefined))?.type === 'popup';
    enqueue(() =>
      addNewTabPlaceholder(newTabId, opener, tab.pendingUrl || tab.url || '', tab.title || '', popup),
    );
    if (popup) enqueue(() => addTab(newTabId));
  });

  // Fill in a placeholder's address and title as its tab loads.
  browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
    if (!change.url && !change.title) return;
    const rec = await getRecording();
    const screenId = rec?.placeholders[tabId];
    if (!screenId || !isRecordable(tab.url)) return;
    const d = await db();
    const screen = await d.get('screens', screenId);
    if (screen?.kind === 'new-tab') {
      await d.put('screens', { ...screen, url: tab.url ?? screen.url, title: tab.title || screen.title });
    }
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    const rec = await getRecording();
    if (!rec) return;
    // Closing the original tab ends the recording, keeping what was captured, marked Incomplete.
    // Closing an added tab just removes it.
    if (tabId === rec.originalTabId) await stopRecording(rec, 'incomplete');
    else if (rec.tabIds.includes(tabId)) enqueue(() => removeTab(tabId));
  });
});

async function onIconClick(tab: Browser.tabs.Tab, access: Promise<boolean>) {
  if (tab.id == null) return;
  const rec = await getRecording();

  if (!isRecordable(tab.url)) {
    await flashBadge(tab.id, '!', "FlowSnap can't record this page. Chrome blocks extensions here.");
    return;
  }

  if (!(await access)) {
    await flashBadge(tab.id, '!', 'FlowSnap needs website access to record. Click the icon to try again.');
    return;
  }

  const tabId = tab.id;
  // A tab the flow itself opened (a link opening in a new tab) joins the flow it came from.
  if (rec && rec.placeholders[tabId] && !rec.tabIds.includes(tabId)) {
    enqueue(() => addTab(tabId));
    return;
  }
  // Otherwise the icon always starts a new flow. A recording still going (even one picked back up
  // with Continue capture) is saved first: Continue capture is the only way to add to a flow.
  if (rec) await stopRecording(rec, 'complete');
  await startRecording(tab, tabId);
}

async function startRecording(tab: Browser.tabs.Tab, tabId: number) {
  const flowId = crypto.randomUUID();
  await (
    await db()
  ).put('flows', {
    id: flowId,
    name: tab.title || 'Untitled flow',
    createdAt: Date.now(),
    status: 'recording',
  });
  // Each recording starts with the panel back in its corner.
  await browser.storage.local.remove(PANEL_POSITION_KEY);
  await setRecording({
    flowId,
    originalTabId: tabId,
    tabIds: [tabId],
    tabNumbers: { [tabId]: 1 },
    placeholders: {},
    unlinked: [],
    screenCount: 0,
  });
  await showRecBadge(tabId);

  // Start on each new page as soon as its content is there, rather than waiting for the whole
  // page (ads, trackers and all) to finish loading. The current page gets it straight away.
  await registerRecorder();
  await injectRecorder(tabId);
}

/** Add a tab to the current recording. Its pages are recorded whenever it's in front. */
async function addTab(tabId: number) {
  const rec = await getRecording();
  if (!rec || rec.tabIds.includes(tabId)) return;
  const tabNumbers = { ...rec.tabNumbers };
  tabNumbers[tabId] ??= Math.max(...Object.values(tabNumbers)) + 1;
  // A tab opened from the flow replaces its placeholder. Any other tab joins unlinked.
  const unlinked = rec.placeholders[tabId] ? rec.unlinked : [...rec.unlinked, tabId];
  await setRecording({ ...rec, tabIds: [...rec.tabIds, tabId], tabNumbers, unlinked });
  await showRecBadge(tabId);
  await injectRecorder(tabId);
}

/** Stop recording an added tab that was closed. */
async function removeTab(tabId: number) {
  const rec = await getRecording();
  if (!rec || tabId === rec.originalTabId) return;
  const { [tabId]: _, ...placeholders } = rec.placeholders;
  await setRecording({
    ...rec,
    tabIds: rec.tabIds.filter((id) => id !== tabId),
    unlinked: rec.unlinked.filter((id) => id !== tabId),
    placeholders,
  });
  await stopTab(tabId);
}

async function onPageMessage(msg: ToBackground, tabId: number | undefined) {
  const rec = await getRecording();
  if (!rec || tabId == null || !rec.tabIds.includes(tabId)) return;

  if (msg.type === 'page-info') {
    // The flow is named after the first website recorded, so only the first page's name is kept.
    const d = await db();
    const flow = await d.get('flows', rec.flowId);
    if (flow && flow.siteName === undefined) await d.put('flows', { ...flow, siteName: msg.siteName });
  } else if (msg.type === 'click') {
    // Only the last click on a page is kept: it's the one that led to the next screen.
    await (
      await db()
    ).put('clicks', {
      screenKey: msg.screenKey,
      flowId: rec.flowId,
      x: msg.x,
      y: msg.y,
      pageY: msg.pageY,
      at: Date.now(),
    });
  } else if (msg.type === 'capture-slice') {
    enqueue(() => captureSlice(tabId));
  } else if (msg.type === 'capture-request') {
    // The page changed screens without loading a new page, the user asked for an extra screen, or
    // the screen showing finished filling in.
    enqueueCapture(tabId, msg.replace);
  } else if (msg.type === 'finish') {
    // Let any queued capture finish so no screen is lost.
    await captureQueue;
    await saveTall();
    await stopRecording(rec, 'complete');
    // A canvas already showing this flow (after Continue capture) refreshes and comes to the front.
    // Otherwise a new one opens next to this tab.
    const shown = await browser.runtime
      .sendMessage({ type: 'show-flow', flowId: rec.flowId } satisfies ToViewer)
      .catch(() => false);
    if (shown === true) return;
    await browser.tabs.create({
      url: browser.runtime.getURL(`/viewer.html?flow=${rec.flowId}`),
      index: (await browser.tabs.get(tabId)).index + 1,
    });
  }
}

/**
 * Continue capture, from the canvas: go back to the tab the flow was recorded in (or its last page
 * in a new tab, if that's closed) and record into the same flow. New screens are added after the
 * existing ones. If the page is the same as the last screen, the duplicate check skips it.
 */
/**
 * The tab the user was last recording in: the one the flow's latest screen was captured in, or the
 * tab the recording started in if that can't be told.
 */
function lastRecordedTab(rec: Recording, screens: Screen[]) {
  const number = latest(screens.filter((s) => s.kind === 'screenshot'))?.tab ?? 1;
  const found = Object.entries(rec.tabNumbers).find(([, n]) => n === number);
  return found ? Number(found[0]) : rec.originalTabId;
}

async function continueFlow(flowId: string): Promise<ContinueReply> {
  let rec = await getRecording();
  if (rec && rec.flowId !== flowId) {
    // Another flow is still recording, often in a tab the user has lost track of. Like the toolbar
    // icon, save it as it is and stop it (its screens are already kept), then carry on with this one.
    await captureQueue;
    await stopRecording(rec, 'complete');
    rec = null;
  }
  const d = await db();
  const flow = await d.get('flows', flowId);
  if (!flow) return { error: "This flow couldn't be found." };
  const screens = await d.getAllFromIndex('screens', 'byFlow', flowId);
  const last = latest(screens.filter((s) => s.kind === 'screenshot'));

  // The tab it was last recorded in (where its latest screen was captured), if it's still open on
  // a page FlowSnap can record.
  let tab = rec
    ? await browser.tabs.get(lastRecordedTab(rec, screens)).catch(() => undefined)
    : flow.lastTabId !== undefined
      ? await browser.tabs.get(flow.lastTabId).catch(() => undefined)
      : undefined;
  if (!tab || !isRecordable(tab.url)) {
    if (!last?.url || !isRecordable(last.url)) return { error: "There's no page to go back to." };
    tab = await browser.tabs.create({ url: last.url, active: true });
  }
  if (tab.id == null) return { error: "Couldn't open the page." };
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});

  const tabId = tab.id;
  if (rec) {
    // Already recording this flow, but its tab may have moved on to a page FlowSnap can't record
    // (like a Chrome settings page), so a new one was opened. Record there from now on.
    if (rec.originalTabId !== tabId) {
      await setRecording({
        ...rec,
        originalTabId: tabId,
        tabIds: rec.tabIds.includes(tabId) ? rec.tabIds : [...rec.tabIds, tabId],
        tabNumbers: { ...rec.tabNumbers, [tabId]: rec.tabNumbers[tabId] ?? last?.tab ?? 1 },
      });
    }
  } else {
    await d.put('flows', { ...flow, status: 'recording' });
    await setRecording({
      flowId,
      originalTabId: tabId,
      tabIds: [tabId],
      tabNumbers: { [tabId]: last?.tab ?? 1 },
      placeholders: {},
      unlinked: [],
      screenCount: screens.length,
    });
  }
  await showRecBadge(tabId);
  await registerRecorder();
  // Shows the panel. If it's already on the page, this does nothing; if the page is still loading,
  // it's added again once it has loaded.
  await injectRecorder(tabId);
  return {};
}

async function stopRecording(rec: Recording, status: 'complete' | 'incomplete') {
  await saveTall();
  await setRecording(null);
  await unregisterRecorder();
  const d = await db();
  const flow = await d.get('flows', rec.flowId);
  if (flow) {
    // Name it after the website and its number of screens, like "Airbnb Mapped User Journey (4 Steps)",
    // unless the user has named it.
    let name = flow.name;
    const screens = await d.getAllFromIndex('screens', 'byFlow', rec.flowId);
    if (!flow.renamed) {
      const shots = screens.filter((s) => s.kind === 'screenshot').sort((a, b) => a.index - b.index);
      name = defaultFlowName(siteName(flow.siteName, shots[0]?.url ?? ''), shots.length);
    }
    // Continue capture goes back to the tab the user was last recording in.
    await d.put('flows', { ...flow, name, status, lastTabId: lastRecordedTab(rec, screens) });
  }
  for (const tabId of rec.tabIds) await stopTab(tabId);
}

/** Remove FlowSnap's panel and listeners from a tab and clear its badge. */
async function stopTab(tabId: number) {
  // Every frame, not just the main page: frames inside the page are watching too.
  await browser.tabs.sendMessage(tabId, { type: 'stop' } satisfies ToPage).catch(() => {});
  await browser.action.setBadgeText({ text: '', tabId }).catch(() => {});
}

// --- Capturing ---

let captureQueue: Promise<void> = Promise.resolve();
let lastCaptureAt = 0;
/** The latest saved screenshot's fingerprint, so it isn't recomputed for every comparison. */
let lastFingerprint: { screenId: string; fp: Fingerprint } | undefined;

/**
 * Captures, placeholders and changes to the recording run one at a time, in order, so fast
 * clicking never drops a screen and screens keep the order they happened in.
 */
function enqueue(task: () => Promise<void>) {
  captureQueue = captureQueue.then(task).catch((err) => {
    console.warn('FlowSnap: capture failed', err);
  });
}

function enqueueCapture(tabId: number, replace = false) {
  enqueue(() => captureScreen(tabId, replace));
}

/** A click opened a new tab. Add a placeholder screen for it, linked to the click that opened it. */
async function addNewTabPlaceholder(
  newTabId: number,
  openerTabId: number,
  url: string,
  title: string,
  /** A popup window, which is recorded straight away, so there's nothing to tell the user. */
  popup = false,
) {
  const rec = await getRecording();
  if (!rec) return;
  const d = await db();

  // The click that opened the tab is the latest one on the opener's current screen. It belongs
  // to the placeholder now, not to whatever comes next in the opener.
  const current = await sendToPage<PrepareReply>(openerTabId, { type: 'current-screen' });
  const click = current ? await d.get('clicks', current.screenKey) : undefined;
  const recentClick = click && Date.now() - click.at < 5000 ? click : undefined;
  if (recentClick) await d.delete('clicks', recentClick.screenKey);

  const existing = await d.getAllFromIndex('screens', 'byFlow', rec.flowId);
  const id = crypto.randomUUID();
  await d.put('screens', {
    id,
    flowId: rec.flowId,
    kind: 'new-tab',
    index: existing.length,
    screenKey: crypto.randomUUID(),
    width: 0,
    height: 0,
    url: isRecordable(url) ? url : '',
    title,
    capturedAt: Date.now(),
    openedFrom: current?.screenKey,
    openedBy: recentClick ? { x: recentClick.x, y: recentClick.y, pageY: recentClick.pageY } : undefined,
  });

  const screenCount = existing.length + 1;
  await setRecording({ ...rec, screenCount, placeholders: { ...rec.placeholders, [newTabId]: id } });
  await sendStatus(rec.tabIds, screenCount);
  if (popup) return;
  await sendToPage(openerTabId, {
    type: 'note',
    text: "That opened a new tab, so it's marked in your flow. To record it too, click FlowSnap in that tab.",
  });
}

/**
 * Capture the tab's visible screen. With `replace`, the screen showing finished filling in, so its
 * existing capture is updated in place instead of adding another screen.
 */
async function captureScreen(tabId: number, replace = false) {
  // A tall screen still open from scrolling is saved first, so it's read as it now is.
  await saveTall();
  const rec = await getRecording();
  if (!rec?.tabIds.includes(tabId)) return;

  const tab = await browser.tabs.get(tabId);
  // captureVisibleTab shows whatever tab is in front, so only capture while this one is.
  if (!tab.active) return;

  const wait = lastCaptureAt + MIN_CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);

  const d = await db();
  const existing = await d.getAllFromIndex('screens', 'byFlow', rec.flowId);
  const capturedAs = (key: string) =>
    existing.find((s) => s.kind === 'screenshot' && screenKeys(s).includes(key));
  // When replacing, the screen must already have a capture to replace. Otherwise it's a new one.
  const skip = (key: string) => !replace && !!capturedAs(key);

  // Skip a screen that was already captured before hiding the panel, so it doesn't blink for nothing.
  const showing = await sendToPage<PrepareReply>(tabId, { type: 'current-screen' });
  if (!showing || skip(showing.screenKey)) return;

  // Hide FlowSnap's UI and find out which screen is showing now.
  const page = await sendToPage<PrepareReply>(tabId, { type: 'prepare-capture', refresh: replace });
  if (!page) return;
  if (skip(page.screenKey)) {
    await sendToPage(tabId, { type: 'capture-done' });
    return;
  }
  const updating = replace ? capturedAs(page.screenKey) : undefined;

  let dataUrl: string;
  try {
    dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    lastCaptureAt = Date.now();
    // Tell the page how far up and down this screen reaches, so scrolling past it adds more.
    const view = page.view;
    const bottom = view && Math.max(view.scrollY + view.viewportHeight, updating ? screenBottom(updating) : 0);
    const top = view && Math.min(view.scrollY, updating?.scrollTop ?? view.scrollY);
    await sendToPage(tabId, {
      type: 'capture-done',
      covered: bottom ? { screenKey: page.screenKey, top, bottom } : undefined,
    });
  }

  const image = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(image);
  const fp = await fingerprint(bitmap);
  const tabNumber = rec.tabNumbers[tabId] ?? 1;

  // A tall screen that finished loading: redraw just the part that's showing, keeping the rest.
  const ratio = updating?.pixelRatio ?? pixelRatio(bitmap.width, tab) ?? 1;
  if (updating && page.view && isTall(updating, ratio, page.view.viewportHeight)) {
    const added = await addToScreen(updating, bitmap, page.view, ratio, 'refresh');
    bitmap.close();
    if (added) {
      const image = await added.canvas.convertToBlob({ type: 'image/png' });
      await d.put('screens', { ...updating, image, height: added.height, footer: added.footer, capturedAt: Date.now() });
    }
    return;
  }

  if (updating) {
    // The same screen, now finished. Keep its place in the flow and its clicks.
    await d.put('screens', {
      ...updating,
      image,
      width: bitmap.width,
      height: bitmap.height,
      pixelRatio: pixelRatio(bitmap.width, tab),
      scrollTop: page.view?.scrollY,
      footer: page.view?.footer,
      url: tab.url ?? updating.url,
      title: tab.title ?? updating.title,
      capturedAt: Date.now(),
    });
    bitmap.close();
    lastFingerprint = { screenId: updating.id, fp };
    return;
  }

  // Skip it if it looks the same as this tab's previous screen. Clicks made on it go to that screen.
  const previous = latest(existing.filter((s) => (s.tab ?? 1) === tabNumber));
  if (previous?.kind === 'screenshot' && previous.image) {
    const previousFp =
      lastFingerprint?.screenId === previous.id ? lastFingerprint.fp : await fingerprint(previous.image);
    if (nearlyIdentical(fp, previousFp)) {
      bitmap.close();
      await d.put('screens', { ...previous, extraKeys: [...(previous.extraKeys ?? []), page.screenKey] });
      lastFingerprint = { screenId: previous.id, fp: previousFp };
      return;
    }
  }

  const shot = {
    kind: 'screenshot' as const,
    tab: tabNumber,
    screenKey: page.screenKey,
    image,
    width: bitmap.width,
    height: bitmap.height,
    pixelRatio: pixelRatio(bitmap.width, tab),
    scrollTop: page.view?.scrollY,
    footer: page.view?.footer,
    url: tab.url ?? '',
    title: tab.title ?? '',
    capturedAt: Date.now(),
  };
  bitmap.close();

  // Re-read in case the recording changed while capturing.
  const current = await getRecording();
  if (current?.flowId !== rec.flowId) return;

  // The first screen of a tab opened from the flow takes its placeholder's place.
  const placeholderId = current.placeholders[tabId];
  const placeholder = placeholderId ? await d.get('screens', placeholderId) : undefined;
  if (placeholder?.kind === 'new-tab' && current.tabIds.includes(tabId)) {
    await d.put('screens', { ...placeholder, ...shot });
    lastFingerprint = { screenId: placeholder.id, fp };
    const { [tabId]: _, ...placeholders } = current.placeholders;
    await setRecording({ ...current, placeholders });
    await sendStatus(current.tabIds, current.screenCount, tabId);
    return;
  }

  const id = crypto.randomUUID();
  lastFingerprint = { screenId: id, fp };
  const unlinked = current.unlinked.includes(tabId);
  await d.put('screens', { id, flowId: rec.flowId, index: existing.length, unlinked, ...shot });
  const screenCount = existing.length + 1;
  await setRecording({
    ...current,
    screenCount,
    unlinked: unlinked ? current.unlinked.filter((t) => t !== tabId) : current.unlinked,
  });
  await sendStatus(current.tabIds, screenCount);
}

/**
 * The user scrolled further down the page than the current screen reaches. Capture what's showing
 * and add the new part to the bottom of the screen, which grows into a tall screen.
 */
async function captureSlice(tabId: number) {
  const rec = await getRecording();
  if (!rec?.tabIds.includes(tabId)) return;
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) return;
  const wait = lastCaptureAt + MIN_CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);

  const d = await db();
  const find = async (key: string) =>
    (await d.getAllFromIndex('screens', 'byFlow', rec.flowId)).find(
      (s) => s.kind === 'screenshot' && screenKeys(s).includes(key),
    );
  // The screen must already be captured. If not, its own capture covers what's showing anyway.
  const showing = await sendToPage<PrepareReply>(tabId, { type: 'current-screen' });
  if (!showing || !(await find(showing.screenKey))) return;

  const page = await sendToPage<PrepareReply>(tabId, { type: 'prepare-capture', slice: true });
  const view = page?.view;
  if (!page || !view) return;
  let dataUrl: string;
  let moved = false;
  try {
    dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // Scrolling fast, the page can still be gliding: if it's no longer where it was measured, the
    // screenshot shows another part of it. Thrown away rather than pasted in the wrong place.
    const now = await sendToPage<PrepareReply>(tabId, { type: 'current-screen' });
    moved = now?.scrollY !== undefined && Math.abs(now.scrollY - view.scrollY) > 2;
  } finally {
    lastCaptureAt = Date.now();
    await sendToPage(tabId, {
      type: 'capture-done',
      covered: moved
        ? undefined
        : { screenKey: page.screenKey, top: view.scrollY, bottom: view.scrollY + view.viewportHeight },
      missed: moved || undefined,
    });
  }
  if (moved) return;

  // Read the screen again: a capture queued before this one may have changed it. If its image is
  // still open from the last part, carry on from that.
  const stored = await find(page.screenKey);
  if (!stored) return;
  const open = tall?.screenId === stored.id ? tall : undefined;
  const screen = open ? { ...stored, height: open.height, footer: open.footer, scrollTop: open.top } : stored;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const ratio = screen.pixelRatio ?? pixelRatio(bitmap.width, tab) ?? 1;

  // First fill in anything skipped earlier that's showing now (the user scrolled back over it).
  let holes = gaps.get(screen.id) ?? [];
  let base = open?.canvas;
  const filled = holes.length ? await fillGaps(screen, bitmap, view, ratio, holes, base) : null;
  if (filled) {
    base = filled.canvas;
    holes = filled.gaps;
  }

  // Scrolled up above where the screen starts: add to its top. Otherwise to its bottom.
  const top = screen.scrollTop ?? view.scrollY;
  const bottom = top + screen.height / ratio;
  const up = screen.scrollTop !== undefined && view.scrollY < screen.scrollTop - 1;
  const added = await addToScreen(screen, bitmap, view, ratio, up ? 'extend-up' : 'extend', base);
  bitmap.close();
  // Scrolled too fast for the parts in between: they're left white, and remembered to fill in.
  const skipped = !added
    ? undefined
    : up
      ? { from: view.scrollY + view.viewportHeight - view.footer, to: top }
      : { from: bottom - (screen.footer ?? 0), to: view.scrollY + view.header };
  if (skipped && skipped.to - skipped.from > 2) holes = [...holes, skipped];
  if (added || filled) {
    gaps.set(screen.id, holes);
    await sendToPage(tabId, { type: 'gaps', screenKey: page.screenKey, gaps: holes });
  }
  // Reached the most a tall screen can hold: said once, so it's no surprise the rest is missing.
  const full = !added && !up && view.scrollY + view.viewportHeight > top + tallLimit(view.viewportHeight, ratio);
  if (full && !tallNoted.has(screen.id)) {
    tallNoted.add(screen.id);
    await sendToPage(tabId, { type: 'note', text: TALL_NOTE });
  }
  if (!added && !filled) return;
  tall = added
    ? { screenId: screen.id, canvas: added.canvas, height: added.height, footer: added.footer, top: added.top }
    : { screenId: screen.id, canvas: base!, height: screen.height, footer: screen.footer ?? 0, top };
  // Saved once the user pauses, rather than after every part.
  clearTimeout(tallSaveTimer);
  tallSaveTimer = setTimeout(() => enqueue(saveTall), TALL_SAVE_AFTER_MS);
  // Confirm it in the panel, like a new screen, without changing the count.
  await sendToPage(tabId, { type: 'status', screenCount: rec.screenCount, flash: true });
}

/**
 * A tall screen's image while the user is scrolling, kept open so each new part is drawn straight
 * onto it. It's saved once they pause, and always before anything else reads the screen.
 */
let tall: { screenId: string; canvas: OffscreenCanvas; height: number; footer: number; top: number } | undefined;

/** Parts of tall screens skipped by scrolling too fast, by screen id, in page pixels. */
const gaps = new Map<string, Gap[]>();
/** Screens that reached the most a tall screen can hold, pointed out once each. */
const tallNoted = new Set<string>();
const TALL_NOTE = "This page is very long, so FlowSnap captured it only this far. Capture Extra Screen adds what's showing as its own screen.";
let tallSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Save a tall screen this long after its last new part. */
const TALL_SAVE_AFTER_MS = 800;

async function saveTall() {
  clearTimeout(tallSaveTimer);
  const pending = tall;
  if (!pending) return;
  tall = undefined;
  const d = await db();
  const screen = await d.get('screens', pending.screenId);
  if (!screen) return;
  const image = await pending.canvas.convertToBlob({ type: 'image/png' });
  await d.put('screens', { ...screen, image, height: pending.height, footer: pending.footer, scrollTop: pending.top });
}

/** How far down the page a screen's image reaches, in CSS pixels. */
function screenBottom(screen: Screen) {
  const ratio = screen.pixelRatio ?? 1;
  return (screen.scrollTop ?? 0) + screen.height / ratio;
}

/** Whether a screen has grown taller than one window as the user scrolled. */
function isTall(screen: Screen, ratio: number, viewportHeight: number) {
  return screen.height / ratio > viewportHeight + 2;
}

/** Screenshot pixels per CSS pixel, from the tab's width: 2 on a Retina screen. */
function pixelRatio(imageWidth: number, tab: Browser.tabs.Tab) {
  if (!tab.width) return undefined;
  return Math.round((imageWidth / tab.width) * 100) / 100;
}

/** The screen with the highest index. */
function latest(screens: Screen[]) {
  return screens.reduce<Screen | undefined>((a, s) => (!a || s.index > a.index ? s : a), undefined);
}

/**
 * Update the screen count in every recorded tab's panel. `confirmed` flashes that tab's panel
 * even though the count didn't change (a placeholder became a real screen).
 */
async function sendStatus(tabIds: number[], screenCount: number, confirmed?: number) {
  for (const tabId of tabIds) {
    await sendToPage(tabId, { type: 'status', screenCount, flash: tabId === confirmed });
  }
}

// --- Helpers ---

async function injectRecorder(tabId: number) {
  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`/${CONTENT_SCRIPT}`],
    });
  } catch (err) {
    console.warn('FlowSnap: could not start on this page', err);
  }
}

async function registerRecorder() {
  await unregisterRecorder();
  await browser.scripting.registerContentScripts([
    {
      id: RECORDER_ID,
      matches: ['<all_urls>'],
      js: [CONTENT_SCRIPT],
      runAt: 'document_end',
      // Some dialogs (like sharing in Google Docs) live in frames inside the page.
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    },
  ]);
}

async function unregisterRecorder() {
  await browser.scripting.unregisterContentScripts({ ids: [RECORDER_ID] }).catch(() => {});
}

async function sendToPage<T = unknown>(tabId: number, msg: ToPage): Promise<T | undefined> {
  try {
    return (await browser.tabs.sendMessage(tabId, msg, { frameId: 0 })) as T;
  } catch {
    // The page may be loading or blocked. The next page load re-adds the panel.
    return undefined;
  }
}

function isRecordable(url: string | undefined) {
  if (!url) return false;
  if (
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    return false;
  }
  return /^(https?|file):/.test(url);
}

async function showRecBadge(tabId: number) {
  await browser.action.setBadgeBackgroundColor({ color: '#E5484D', tabId });
  await browser.action.setBadgeText({ text: 'REC', tabId });
}

async function flashBadge(tabId: number, text: string, title: string) {
  await browser.action.setBadgeBackgroundColor({ color: '#6F6F6F', tabId });
  await browser.action.setBadgeText({ text, tabId });
  await browser.action.setTitle({ title, tabId });
  setTimeout(() => {
    void browser.action.setBadgeText({ text: '', tabId }).catch(() => {});
    void browser.action.setTitle({ title: DEFAULT_TITLE, tabId }).catch(() => {});
  }, 4000);
}

async function getRecording(): Promise<Recording | null> {
  const { recording } = await browser.storage.session.get('recording');
  return (recording as Recording | undefined) ?? null;
}

async function setRecording(rec: Recording | null) {
  await browser.storage.session.set({ recording: rec });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
