import type { Screen } from '@/utils/db';
import { CARD_WIDTH } from './notes';

/**
 * Screens are shown at one shared scale, not one shared width: the widest window in the flow is
 * CARD_WIDTH on the canvas, and every other screenshot keeps its true size relative to it. So a
 * nav bar the same size on the website looks the same size on every card, even if the window was
 * resized between screenshots. Shared by the canvas and the exports, so they always match.
 */

/** A screenshot from a very narrow window (a phone-sized one) is still never narrower than this. */
export const MIN_CARD_WIDTH = 240;

/**
 * How wide the window was when a screenshot was taken, in CSS pixels: its image width over its
 * pixel ratio (so a Retina screenshot and a standard one of the same window match). 0 for a page
 * with no screenshot.
 */
function windowWidth(screen: Screen) {
  if (screen.kind !== 'screenshot' || !screen.width) return 0;
  // Screenshots taken before their pixel ratio was saved were most likely taken on this screen.
  return screen.width / (screen.pixelRatio ?? devicePixelRatio ?? 1);
}

/**
 * Each screenshot's width on the canvas, by screen id. Pages without a screenshot (written steps,
 * pages in tabs that weren't recorded) aren't included: they have their own widths.
 */
export function cardWidths(screens: Screen[]) {
  const widest = Math.max(0, ...screens.map(windowWidth));
  const widths = new Map<string, number>();
  for (const screen of screens) {
    const own = windowWidth(screen);
    if (!own) continue;
    const width = widest ? Math.round((CARD_WIDTH * own) / widest) : CARD_WIDTH;
    widths.set(screen.id, Math.min(CARD_WIDTH, Math.max(MIN_CARD_WIDTH, width)));
  }
  return widths;
}
