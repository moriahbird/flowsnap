import type { Mark, Screen } from '@/utils/db';
import { CARD_WIDTH, NOTE_SIZE } from './notes';

/**
 * Marks drawn on screens from the bottom toolbar: blurs, which hide sensitive information, and
 * hand-drawn circles, which point things out. Both are boxes measured as fractions of the screen,
 * so they stay in place at any zoom and in every export.
 */

export type MarkKind = 'blurs' | 'circles';

/** Circles are drawn in black marker, this thick on a screen 640 wide (as on the canvas). */
export const CIRCLE_COLOR = '#1C1C1E';
export const CIRCLE_STROKE = 3;
/**
 * Smallest a mark can be resized to, in canvas pixels each way (on a screen 640 wide). A fixed size,
 * not a share of the screen, so a mark on a tall screen can still be made short.
 */
export const MIN_MARK_PX = 12;

/**
 * The size a mark gets when it's placed with a click or dropped from the toolbar, in canvas pixels
 * (on a screen 640 wide): a blur is as wide as a sticky note and half as tall, ready to stretch
 * over what it should hide.
 */
export function defaultMarkSize(kind: MarkKind) {
  return kind === 'blurs' ? { w: NOTE_SIZE, h: NOTE_SIZE / 2 } : { w: 120, h: 80 };
}

/**
 * A mark of the default size centred on `at` (a fraction of the screen), kept on the screen.
 * `height` and `width` are the screen's size on the canvas.
 */
export function placedMark(kind: MarkKind, at: { x: number; y: number }, height: number, width = CARD_WIDTH): Mark {
  const size = defaultMarkSize(kind);
  const w = Math.min(1, size.w / width);
  const h = Math.min(1, size.h / height);
  const clamp = (n: number, max: number) => Math.min(Math.max(0, n), max);
  return { id: crypto.randomUUID(), x: clamp(at.x - w / 2, 1 - w), y: clamp(at.y - h / 2, 1 - h), w, h };
}

/**
 * The screenshot with its blurs baked into the pixels, for exports. The hidden parts are pixelated
 * and then blurred, so nothing under them can be read or recovered from the file. Returns the
 * original image if the screen has no blurs.
 */
export async function blurredImage(screen: Screen): Promise<Blob> {
  const blurs = screen.blurs ?? [];
  if (!blurs.length || !screen.image) return screen.image!;
  const cached = bakedCache.get(screen);
  if (cached) return cached;

  const bitmap = await createImageBitmap(screen.image);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  for (const b of blurs) {
    const x = Math.round(b.x * width);
    const y = Math.round(b.y * height);
    const w = Math.max(1, Math.round(b.w * width));
    const h = Math.max(1, Math.round(b.h * height));
    // Coarse enough that text becomes blocks of colour, then softened so it reads as a blur. Sized
    // to the box, so large text in it is as unreadable as small: a line of text the height of the
    // box is only two or three blocks tall.
    const block = Math.max(Math.round(width / 80), Math.round(Math.min(w, h) / 2.5));
    const small = new OffscreenCanvas(Math.max(1, Math.ceil(w / block)), Math.max(1, Math.ceil(h / block)));
    const sctx = small.getContext('2d')!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(bitmap, x, y, w, h, 0, 0, small.width, small.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${block * 0.6}px)`;
    ctx.imageSmoothingEnabled = true;
    // A little past the edges, so the blur doesn't fade into the page around it.
    ctx.drawImage(small, x - block, y - block, w + block * 2, h + block * 2);
    ctx.restore();
  }
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  bakedCache.set(screen, blob);
  return blob;
}

/** Each screen's baked image, until the screen changes (a changed screen is a new object). */
const bakedCache = new WeakMap<Screen, Blob>();

/**
 * Points around a hand-drawn circle filling a `w` × `h` box: slightly wobbly, a little tilted, and
 * running past its start, like a circle drawn with a marker. The same mark always gets the same
 * wobble.
 */
export function circlePoints(mark: Mark, w: number, h: number) {
  let seed = 0;
  for (const c of mark.id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const start = -Math.PI * (0.55 + random() * 0.2);
  const turn = Math.PI * 2 + 0.45;
  const wobble = [random(), random(), random()].map((r) => r * Math.PI * 2);
  const steps = 48;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = start + t * turn;
    // A gentle uneven radius, and the end overshooting a little outside the start.
    const r = 1 + 0.035 * Math.sin(a * 2 + wobble[0]!) + 0.02 * Math.sin(a * 3 + wobble[1]!) + 0.05 * t * t;
    points.push({ x: w / 2 + (w / 2) * 0.94 * r * Math.cos(a), y: h / 2 + (h / 2) * 0.92 * r * Math.sin(a) });
  }
  return points;
}

/** A smooth SVG path through points. */
export function smoothPath(points: { x: number; y: number }[]) {
  const r = (n: number) => Math.round(n * 100) / 100;
  let d = `M${r(points[0]!.x)} ${r(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 2] ?? points[i - 1]!;
    const p1 = points[i - 1]!;
    const p2 = points[i]!;
    const p3 = points[i + 1] ?? p2;
    d += ` C${r(p1.x + (p2.x - p0.x) / 6)} ${r(p1.y + (p2.y - p0.y) / 6)} ${r(p2.x - (p3.x - p1.x) / 6)} ${r(p2.y - (p3.y - p1.y) / 6)} ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}
