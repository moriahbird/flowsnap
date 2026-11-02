import type { Screen } from '@/utils/db';
import type { Gap, ViewInfo } from '@/utils/messages';

/**
 * Tall screens: as the user scrolls a page, each new part they scroll to is added to the screen's
 * image (at the bottom going down, at the top going up from where it started), so the whole page
 * they looked at becomes one tall screen.
 *
 * Sticky headers appear once, at the top: each new part starts below the header. A fixed footer
 * is left off until the bottom of the page is reached, so it doesn't repeat down the image. On a
 * page that scrolls an inner panel beside a sidebar that stays put (like Gemini), new parts take
 * just the panel, and beside them is the sidebar's background, so the sidebar shows once.
 */

/**
 * A tall screen stops growing at this many window-heights, to keep the image a size that saves
 * (browsers can't make an image much taller than 32,000 pixels: 14 windows of a 1,100-pixel tall
 * window on a 2× screen is about 31,000).
 */
export const MAX_SCREENS_TALL = 14;

/** Browsers can't make an image taller than about this many pixels. */
const MAX_IMAGE_PIXELS = 32_000;

/** How tall a tall screen can grow, in CSS pixels: 14 windows, or less if that's too many pixels. */
export function tallLimit(viewportHeight: number, ratio: number) {
  return Math.min(MAX_SCREENS_TALL * viewportHeight, MAX_IMAGE_PIXELS / ratio);
}

/**
 * Add a new screenshot to a screen's image.
 *
 * 'extend' adds whatever's new below what the screen already shows (the user scrolled down).
 * 'extend-up' adds whatever's new above it (the screen was first captured partway down the page and
 * the user scrolled up).
 * 'refresh' redraws the part of the screen that's showing (the page finished loading after the
 * user scrolled), keeping the rest of a tall screen.
 *
 * `base` is the screen's image if it's already open, which saves decoding it again. Returns the new
 * image, not yet saved as a file, or null if the screenshot adds nothing.
 */
export async function addToScreen(
  screen: Screen,
  shot: ImageBitmap,
  view: ViewInfo,
  ratio: number,
  mode: 'extend' | 'extend-up' | 'refresh',
  base?: OffscreenCanvas,
) {
  if (!base && !screen.image) return null;
  const top = screen.scrollTop ?? view.scrollY;
  const bottom = top + screen.height / ratio;
  const oldFooter = screen.footer ?? 0;
  const viewBottom = view.scrollY + view.viewportHeight;
  const limit = top + tallLimit(view.viewportHeight, ratio);

  if (mode === 'extend-up') {
    // From the top of this screenshot (its sticky header included, as the page's new top), down
    // over the old image's top edge, where the old image had the sticky header over the page.
    const newTop = Math.max(view.scrollY, bottom - tallLimit(view.viewportHeight, ratio));
    if (newTop >= top - 1) return null;
    // Down to the old top (and over its sticky header), but never past what this screenshot shows:
    // scrolled up too far at once leaves a white gap, filled in later by scrolling back over it.
    const end = Math.min(Math.max(top, top + view.header), view.scrollY + view.viewportHeight - view.footer);
    const width = screen.width;
    const height = Math.round((bottom - newTop) * ratio);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    const shift = Math.round((top - newTop) * ratio);
    if (base) {
      ctx.drawImage(base, 0, shift);
    } else {
      const old = await createImageBitmap(screen.image!);
      ctx.drawImage(old, 0, shift);
      old.close();
    }
    const fitWidth = width / shot.width;
    const col = scrollingColumn(shot, view, ratio);
    fillBeside(ctx, shot, col, fitWidth, 0, shift);
    const sourceY = (newTop - view.scrollY) * ratio;
    const sourceH = (end - newTop) * ratio;
    drawColumn(ctx, shot, col, fitWidth, sourceY, sourceH, 0);
    return { canvas, height, footer: oldFooter, bottom, top: newTop };
  }

  let start: number;
  let end: number;
  let footer: number;
  if (mode === 'extend') {
    // From where the old image's content ends (over its fixed footer), or below this screenshot's
    // sticky header if the user scrolled past what was captured.
    start = Math.max(bottom - oldFooter, view.scrollY + view.header);
    // Leave the fixed footer off until the end of the page.
    end = Math.min(viewBottom - (view.atBottom ? 0 : view.footer), limit);
    if (end <= bottom - oldFooter + 1) return null;
    footer = view.atBottom && end === viewBottom ? view.footer : 0;
  } else {
    // The visible part, without the sticky header unless it's the top of the screen, and without
    // the fixed footer unless it's the bottom.
    start = Math.max(top, view.scrollY + (view.scrollY > top + 1 ? view.header : 0));
    const atScreenBottom = viewBottom >= bottom - 1;
    end = Math.min(viewBottom - (atScreenBottom ? 0 : view.footer), limit);
    footer = atScreenBottom ? view.footer : oldFooter;
    if (end <= start) return null;
  }

  const newBottom = mode === 'extend' ? end : Math.max(bottom, end);
  const width = screen.width;
  const height = Math.round((newBottom - top) * ratio);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  // White under any gap left by scrolling past part of the page too quickly.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  if (base) {
    ctx.drawImage(base, 0, 0);
  } else {
    const old = await createImageBitmap(screen.image!);
    ctx.drawImage(old, 0, 0);
    old.close();
  }

  // The new part, from the screenshot to its place on the page. The window may have been
  // resized since, so it's fitted to the screen's width.
  const fitWidth = width / shot.width;
  const col = scrollingColumn(shot, view, ratio);
  // Beside the new rows (including any skipped by scrolling too fast), the sidebar's background.
  const oldHeight = Math.round((bottom - top) * ratio);
  if (height > oldHeight) fillBeside(ctx, shot, col, fitWidth, oldHeight, height - oldHeight);
  const sourceY = (start - view.scrollY) * ratio;
  const sourceH = (end - start) * ratio;
  drawColumn(ctx, shot, col, fitWidth, sourceY, sourceH, (start - top) * ratio);

  return { canvas, height, footer, bottom: newBottom, top };
}

/**
 * Draw whatever this screenshot shows of the parts skipped earlier (scrolled past too fast), leaving
 * its sticky header and fixed footer out. Returns the new image and the parts still missing, or
 * null if it shows none of them.
 */
export async function fillGaps(
  screen: Screen,
  shot: ImageBitmap,
  view: ViewInfo,
  ratio: number,
  gaps: Gap[],
  base?: OffscreenCanvas,
) {
  if (!base && !screen.image) return null;
  const top = screen.scrollTop ?? view.scrollY;
  const shown = { from: view.scrollY + view.header, to: view.scrollY + view.viewportHeight - view.footer };
  const remaining: Gap[] = [];
  const draws: Gap[] = [];
  for (const g of gaps) {
    const from = Math.max(g.from, shown.from);
    const to = Math.min(g.to, shown.to);
    if (to - from < 1) {
      remaining.push(g);
      continue;
    }
    draws.push({ from, to });
    if (from > g.from + 1) remaining.push({ from: g.from, to: from });
    if (to < g.to - 1) remaining.push({ from: to, to: g.to });
  }
  if (!draws.length) return null;

  const width = screen.width;
  const canvas = new OffscreenCanvas(width, screen.height);
  const ctx = canvas.getContext('2d')!;
  if (base) {
    ctx.drawImage(base, 0, 0);
  } else {
    const old = await createImageBitmap(screen.image!);
    ctx.drawImage(old, 0, 0);
    old.close();
  }
  const fitWidth = width / shot.width;
  const col = scrollingColumn(shot, view, ratio);
  for (const d of draws) {
    const sourceH = (d.to - d.from) * ratio;
    drawColumn(ctx, shot, col, fitWidth, (d.from - view.scrollY) * ratio, sourceH, (d.from - top) * ratio);
  }
  return { canvas, gaps: remaining };
}

/** Across a screenshot, the part that scrolls, in its pixels: from `x`, `width` wide. */
interface Column {
  x: number;
  width: number;
}

/**
 * The part of a screenshot that scrolls: all of it, or on a page that scrolls an inner panel
 * beside a sidebar, just that panel.
 */
function scrollingColumn(shot: ImageBitmap, view: ViewInfo, ratio: number): Column {
  const left = Math.round((view.left ?? 0) * ratio);
  const right = Math.round((view.right ?? 0) * ratio);
  const width = shot.width - left - right;
  // Not a narrow sliver of the window: that's not a page's main panel.
  return width >= shot.width * 0.3 ? { x: left, width } : { x: 0, width: shot.width };
}

/** Draw a band of the screenshot's scrolling part onto the screen, fitted to the screen's width. */
function drawColumn(
  ctx: OffscreenCanvasRenderingContext2D,
  shot: ImageBitmap,
  col: Column,
  fitWidth: number,
  sourceY: number,
  sourceH: number,
  destY: number,
) {
  ctx.drawImage(shot, col.x, sourceY, col.width, sourceH, col.x * fitWidth, destY, col.width * fitWidth, sourceH * fitWidth);
}

/**
 * Paint the sidebars' background beside rows of the screen (the most common colour in each, so a
 * sidebar's own background rather than its text and icons). Nothing to do on a page without them.
 */
function fillBeside(
  ctx: OffscreenCanvasRenderingContext2D,
  shot: ImageBitmap,
  col: Column,
  fitWidth: number,
  destY: number,
  destH: number,
) {
  if (destH <= 0) return;
  const sides = [
    { x: 0, width: col.x },
    { x: col.x + col.width, width: shot.width - col.x - col.width },
  ];
  for (const side of sides) {
    if (side.width < 1) continue;
    ctx.fillStyle = commonColor(shot, side);
    ctx.fillRect(side.x * fitWidth, destY, side.width * fitWidth, destH);
  }
}

/** The colour that covers most of a strip of the screenshot, sampled on a coarse grid. */
function commonColor(shot: ImageBitmap, strip: Column) {
  const cols = 12;
  const rows = 48;
  const grid = new OffscreenCanvas(cols, rows);
  const g = grid.getContext('2d')!;
  // Nearest pixel, not blended: each sample is a real colour from the screenshot.
  g.imageSmoothingEnabled = false;
  g.drawImage(shot, strip.x, 0, strip.width, shot.height, 0, 0, cols, rows);
  const data = g.getImageData(0, 0, cols, rows).data;
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const rgb = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    const n = (counts.get(rgb) ?? 0) + 1;
    counts.set(rgb, n);
    if (n > bestCount) {
      best = rgb;
      bestCount = n;
    }
  }
  return `#${best.toString(16).padStart(6, '0')}`;
}
