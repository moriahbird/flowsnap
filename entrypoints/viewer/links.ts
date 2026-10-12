import { screenKeys, type Click, type Screen } from '@/utils/db';

/**
 * An arrow in the flow: from where the user clicked on one screen to the next screen. Shared by
 * the canvas and the exported image, so they always draw the same arrows.
 */
export interface Link {
  /** Index of the screen the arrow starts on. */
  from: number;
  /** Index of the screen it leads to, always the next one. */
  to: number;
  /**
   * Where on `from` the arrow starts, as a fraction of its size: where the user moved its dot to,
   * or else where they clicked, or else near the right edge if no click was recorded.
   */
  point: { x: number; y: number };
  /** A screen in an added tab with no recorded click leading to it: "connection not recorded". */
  dashed: boolean;
}

/**
 * One arrow out of each screen, to the next screen, starting where the user clicked to get there.
 * If the next screen opened in a new tab, that's the click that opened it. Otherwise it's the last
 * click on the screen. The user can move where an arrow starts by dragging its dot or its line. When a screen in
 * between is deleted, its neighbours connect directly.
 */
export function flowLinks(screens: Screen[], clicks: Map<string, Click>): Link[] {
  const links: Link[] = [];
  for (let i = 1; i < screens.length; i++) {
    const from = screens[i - 1]!;
    const to = screens[i]!;
    const openedHere =
      to.kind === 'new-tab' && to.openedBy && to.openedFrom && screenKeys(from).includes(to.openedFrom);
    const click = latestClick(from, clicks);
    const clicked = openedHere ? to.openedBy : click;
    const point = from.arrowStart ?? (clicked && onScreen(from, clicked)) ?? DEFAULT_START;
    links.push({ from: i - 1, to: i, point, dashed: !!to.unlinked });
  }
  return links;
}

/**
 * Where an arrow starts on a screen with no usable recorded click: halfway down its right edge,
 * with the dot just overlapping the edge.
 */
const DEFAULT_START = { x: 0.995, y: 0.5 };

/**
 * Where a click lands on a screen, as a fraction of its size. Clicks are saved relative to the
 * window, so on a tall screen (one that grew as the user scrolled) they're placed by their
 * distance from the top of the page instead. A click that doesn't land on the screen (for example
 * on a part of the page that wasn't captured) gives nothing, so the arrow starts from the default
 * spot rather than being pinned to an edge.
 */
function onScreen(screen: Screen, click: { x: number; y: number; pageY?: number }) {
  let y = click.y;
  if (click.pageY !== undefined && screen.scrollTop !== undefined && screen.pixelRatio) {
    y = (click.pageY - screen.scrollTop) / (screen.height / screen.pixelRatio);
  }
  const inside = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  // Exactly the top-left corner means the position wasn't known (a click made from the keyboard).
  const unknown = click.x === 0 && y === 0;
  return inside(click.x) && inside(y) && !unknown ? { x: click.x, y } : undefined;
}

/** The last click on a screen, including on duplicates of it that were skipped. */
export function latestClick(screen: Screen, clicks: Map<string, Click>) {
  return screenKeys(screen)
    .map((k) => clicks.get(k))
    .filter((c): c is Click => !!c)
    .sort((a, b) => b.at - a.at)[0];
}
