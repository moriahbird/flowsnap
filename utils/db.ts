import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type FlowStatus = 'recording' | 'complete' | 'incomplete';

export interface Flow {
  id: string;
  name: string;
  createdAt: number;
  status: FlowStatus;
  /** What the first recorded website calls itself (its og:site_name tag), for the default name. */
  siteName?: string;
  /** The user named the flow, so FlowSnap never replaces the name with a default one. */
  renamed?: boolean;
  /** The tab it was last recorded in, so Continue capture can go back to it. */
  lastTabId?: number;
}

export interface Screen {
  id: string;
  flowId: string;
  /**
   * 'screenshot' is a captured screen. 'new-tab' is a placeholder for a page that opened in
   * another tab, which FlowSnap doesn't record: it has no image, only the page's address and title.
   * 'text' is a page the user added on the canvas between two screens, to describe in words a step
   * that wasn't captured (checking an email, typing a code sent by text, or a page that didn't record).
   */
  kind: 'screenshot' | 'new-tab' | 'text';
  /** For a 'text' page: its headline, what the user wrote under it, and its quick icon. */
  heading?: string;
  text?: string;
  icon?: 'newTab' | 'email' | 'message' | 'call' | 'app';
  /** Position in click order, starting at 0. */
  index: number;
  /**
   * Identifies what was on screen when it was captured, so clicks can be matched to it.
   * A new key is made on each page load and each in-page screen change.
   */
  screenKey: string;
  /**
   * Keys of later captures that looked the same as this screen and were skipped. Clicks made
   * on them belong to this screen.
   */
  extraKeys?: string[];
  image?: Blob;
  /** Image size in real pixels (CSS pixels × device pixel ratio). 0 for a new-tab placeholder. */
  width: number;
  height: number;
  /**
   * Image pixels per CSS pixel: 2 on a Retina screen. Saved into exported PNGs so they show at
   * full sharpness. Missing for screens captured before it was recorded.
   */
  pixelRatio?: number;
  /**
   * How far down the page the image starts, in CSS pixels. A screen grows into a tall one as the
   * user scrolls down. Missing for screens captured before tall screens.
   */
  scrollTop?: number;
  /** Height of a fixed footer included at the bottom of the image, in CSS pixels. */
  footer?: number;
  url: string;
  /** The page's own title when it was captured. */
  title: string;
  /** A name the user gave the screen on the canvas. Shown and exported instead of the title. */
  name?: string;
  capturedAt: number;
  /** Which tab it came from: 1 is the tab the recording started in, 2 and up are added tabs. */
  tab?: number;
  /** The first screen of a tab added without a recorded click leading to it. */
  unlinked?: boolean;
  /** For a new-tab placeholder: the screen it was opened from, and where on it the user clicked. */
  openedFrom?: string;
  openedBy?: { x: number; y: number; pageY?: number };
  /**
   * Where the arrow to the next screen starts, as a fraction of this screen's size, if the user
   * moved its dot on the canvas. Otherwise it starts where they clicked.
   */
  arrowStart?: { x: number; y: number };
  /** Sticky notes the user added to the screen on the canvas. */
  notes?: Note[];
  /** Parts of the screen blurred to hide sensitive information. Exports bake them into the image. */
  blurs?: Mark[];
  /** Hand-drawn circles pointing things out. */
  circles?: Mark[];
}

/** A blur or circle on a screen: a box, as fractions of the screen's size. */
export interface Mark {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A sticky note on a screen. */
export interface Note {
  id: string;
  /** Its top-left corner, as a fraction of the screen's size. */
  x: number;
  y: number;
  text: string;
  /**
   * Yellow for a plain note, green for something good, pink for something the user doesn't like.
   * Missing means yellow.
   */
  color?: NoteColor;
}

export type NoteColor = 'yellow' | 'green' | 'pink';

/** The last click made on a screen, which is the one that led to the next screen. */
export interface Click {
  screenKey: string;
  flowId: string;
  /** Position as a fraction of the viewport (0–1), so it maps onto the screenshot at any pixel density. */
  x: number;
  y: number;
  /** Distance from the top of the whole page, in CSS pixels, for placing it on a tall screen. */
  pageY?: number;
  at: number;
}

interface FlowSnapDB extends DBSchema {
  flows: { key: string; value: Flow };
  screens: { key: string; value: Screen; indexes: { byFlow: string } };
  clicks: { key: string; value: Click; indexes: { byFlow: string } };
}

let dbPromise: Promise<IDBPDatabase<FlowSnapDB>> | undefined;

export function db() {
  dbPromise ??= openDB<FlowSnapDB>('flowsnap', 2, {
    upgrade(d) {
      // Version 1 was chunk 1 test data with a different click key. Start fresh.
      for (const name of [...d.objectStoreNames]) d.deleteObjectStore(name);
      d.createObjectStore('flows', { keyPath: 'id' });
      d.createObjectStore('screens', { keyPath: 'id' }).createIndex('byFlow', 'flowId');
      d.createObjectStore('clicks', { keyPath: 'screenKey' }).createIndex('byFlow', 'flowId');
    },
  });
  return dbPromise;
}

export async function getScreens(flowId: string) {
  const screens = await (await db()).getAllFromIndex('screens', 'byFlow', flowId);
  return screens.sort((a, b) => a.index - b.index);
}

export async function getClicks(flowId: string) {
  const clicks = await (await db()).getAllFromIndex('clicks', 'byFlow', flowId);
  return new Map(clicks.map((c) => [c.screenKey, c]));
}

/** What a screen is called on the canvas and in exports: the user's name for it, or a default. */
export function screenLabel(screen: Screen) {
  if (screen.name) return screen.name;
  if (screen.kind === 'new-tab') return 'Opened in a new tab';
  if (screen.kind === 'text') return 'Added step';
  return screen.title || screen.url || 'Untitled';
}

/** Every key a screen's clicks may be saved under: its own and those of skipped duplicates. */
export function screenKeys(screen: Screen) {
  return [screen.screenKey, ...(screen.extraKeys ?? [])];
}

export async function getLatestFlow() {
  const flows = await (await db()).getAll('flows');
  return flows.sort((a, b) => b.createdAt - a.createdAt)[0];
}
