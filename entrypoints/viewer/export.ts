import { zipSync } from 'fflate';
import { screenLabel, type Click, type Flow, type Screen } from '@/utils/db';
import { exportName } from '@/utils/flowName';
import { flowLinks } from './links';
import { cardWidths } from './scale';
import { TEXT_PAGE_ICONS, TEXT_PAGE_TINT, textPageIconPath } from './textPage';
import { blurredImage, CIRCLE_COLOR, CIRCLE_STROKE, circlePoints, smoothPath } from './marks';
import { CARD_WIDTH, fitNote, notePaper, notesBottom, NOTE_COLORS, NOTE_FONT_FAMILY, NOTE_LINE, NOTE_SIZE, wrapLines } from './notes';

/**
 * Downloading a flow: always one file, saved to Downloads.
 *
 *   [Flow name].png or .pdf      the whole flow
 *
 * or, with the screenshots included, one zip that opens as a folder:
 *
 *   [Flow name].zip
 *     [Flow name]/
 *       [Flow name].png or .pdf
 *       Screenshots/
 *         01 – Homepage.png      every screen, numbered in click order
 *
 * One file per click needs no extra permission, and Chrome never asks about multiple downloads.
 */

export type FlowFormat = 'png' | 'pdf';

/** The name a flow's downloads are given, without an extension. */
export function downloadName(flow: Flow, screens: Screen[]) {
  // Always ends in "Mapped User Journey (N Steps)", with the flow's current number of screens.
  const steps = screens.filter((s) => s.kind === 'screenshot').length;
  return safeName(exportName(flow.name, steps), 'Mapped User Journey');
}

/** Download the flow as a PNG or PDF, or with `withScreenshots`, a zip with every screenshot too. */
export async function exportFlow(
  flow: Flow,
  screens: Screen[],
  clicks: Map<string, Click>,
  format: FlowFormat,
  withScreenshots: boolean,
  /** How many rows to lay the screens out in, wrapping onto the next row with an arrow. */
  rows = 1,
) {
  const name = downloadName(flow, screens);
  const columns = Math.ceil(screens.length / Math.max(1, rows));
  const { canvas, scale } = await renderFlow(flow, screens, clicks, undefined, columns);
  const image =
    format === 'png'
      ? // Tagged as a whole 2× (or more) even when a very large flow had to be drawn a little below
        // it, so it shows pixel for pixel on a Retina screen rather than slightly enlarged.
        await withResolution(await canvas.convertToBlob({ type: 'image/png' }), Math.max(2, Math.round(scale)))
      : await flowPdf(canvas, scale, flow.name);

  if (!withScreenshots) {
    saveWithLink(image, `${name}.${format}`);
    return;
  }

  // Inside one folder with the zip's name, so the zip opens as just that folder. PNGs are already
  // compressed, so everything is stored as it is.
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {
    [`${name}/${name}.${format}`]: [new Uint8Array(await image.arrayBuffer()), { level: 0 }],
  };
  const shots = screens.filter((s) => s.kind === 'screenshot' && s.image);
  const digits = Math.max(2, String(screens.length).length);
  for (const s of shots) {
    // Its number in the flow, the same as in the flow image.
    const number = String(screens.indexOf(s) + 1).padStart(digits, '0');
    // Screens captured before their pixel ratio was saved were most likely taken on this screen.
    // With its blurs baked in, so what they hide isn't in the file.
    const png = await withResolution(await blurredImage(s), s.pixelRatio ?? devicePixelRatio);
    // Like "01 – Pick a listing.png".
    entries[`${name}/Screenshots/${number} – ${safeName(screenLabel(s), 'Screen')}.png`] = [
      new Uint8Array(await png.arrayBuffer()),
      { level: 0 },
    ];
  }
  // fflate always returns a plain ArrayBuffer-backed array, never a shared one.
  const zip = zipSync(entries) as Uint8Array<ArrayBuffer>;
  saveWithLink(new Blob([zip], { type: 'application/zip' }), `${name}.zip`);
}

/** Download one file without the downloads permission. */
function saveWithLink(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// --- Copy for Figma ---

/**
 * Past this many characters of screenshots, Figma gets slow to paste. Screenshots are copied as
 * PNGs if they fit, then as high-quality JPEGs (several times smaller, still crisp), and only at
 * standard resolution (half the width and height on a Retina screen) if even those don't fit.
 */
const MAX_FIGMA_IMAGE_CHARS = 24_000_000;
/** JPEG quality for screenshots copied to Figma: high enough that text stays sharp. */
const FIGMA_JPEG_QUALITY = 0.92;
/** Figma shrinks images taller or wider than this, so tall screens are copied in slices. */
const FIGMA_MAX_IMAGE_SIDE = 4096;

/**
 * The flow as SVG, which Figma turns into layers when it's pasted: each screen a group named after
 * it ("02 Pick a listing") holding its screenshot, the arrows and click dots as vectors, and the
 * numbers and names as text. Laid out exactly like the exported image, on a transparent
 * background so it sits on whatever it's pasted onto.
 */
export async function flowSvg(flow: Flow, screens: Screen[], clicks: Map<string, Click>) {
  const { placed, width, height, shots, arrows } = layoutFlow(screens, clicks);

  // Screenshots, packed into the SVG so they arrive in Figma as images. Each is one or more
  // slices, from top to bottom: `y` and `h` are in layout units, within the screen.
  type Slice = { y: number; h: number; url: string };
  const encode = async (quality: 'png' | 'jpeg' | 'standard') => {
    const images = new Map<Screen, Slice[]>();
    for (const p of placed) {
      if (p.screen.kind !== 'screenshot' || !p.screen.image) continue;
      const bitmap = await createImageBitmap(await blurredImage(p.screen));
      const scale = quality === 'standard' ? Math.min(1, p.w / bitmap.width) : 1;
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      const slices: Slice[] = [];
      for (let top = 0; top < height; top += FIGMA_MAX_IMAGE_SIDE) {
        const h = Math.min(FIGMA_MAX_IMAGE_SIDE, height - top);
        const canvas = new OffscreenCanvas(width, h);
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, top / scale, bitmap.width, h / scale, 0, 0, width, h);
        const blob = await canvas.convertToBlob(
          quality === 'jpeg' ? { type: 'image/jpeg', quality: FIGMA_JPEG_QUALITY } : { type: 'image/png' },
        );
        slices.push({ y: (top / height) * p.h, h: (h / height) * p.h, url: await dataUrl(blob) });
      }
      bitmap.close();
      images.set(p.screen, slices);
    }
    return images;
  };
  const chars = (images: Map<Screen, Slice[]>) =>
    [...images.values()].flat().reduce((total, slice) => total + slice.url.length, 0);
  let images = await encode('png');
  if (chars(images) > MAX_FIGMA_IMAGE_CHARS) images = await encode('jpeg');
  if (chars(images) > MAX_FIGMA_IMAGE_CHARS) images = await encode('standard');

  const text = (x: number, y: number, size: number, weight: number, fill: string, value: string, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-family="Manrope, -apple-system, Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xml(value)}</text>`;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<g id="Title">`,
    text(PAD, PAD + 52, 52, 700, COLORS.text, flow.name),
    text(PAD, PAD + 100, 28, 700, COLORS.muted, subtitle(flow, shots)),
    `</g>`,
  );

  for (const p of placed) {
    const label = screenLabel(p.screen);
    const number = p.number ? String(p.number).padStart(2, '0') : '';
    const captionY = p.y - CAPTION_H;
    out.push(`<g id="${xml(number ? `${number} ${label}` : label)}">`);
    if (number) out.push(text(p.x, captionY + 36, 30, 600, COLORS.accent, number).replace(/font-family="[^"]*"/, `font-family="JetBrains Mono, monospace"`));
    out.push(text(number ? p.x + 52 : p.x, captionY + 36, 30, 700, COLORS.text, truncate(label, (p.w - 52) / 17)));
    out.push(text(p.x, captionY + 70, 22, 700, COLORS.muted, truncate(shortUrl(p.screen.url), p.w / 12)));
    const slices = images.get(p.screen);
    if (slices) {
      const image = (slice: Slice, id: string) =>
        `<image id="${id}" x="${p.x}" y="${round2(p.y + slice.y)}" width="${p.w}" height="${round2(slice.h)}" preserveAspectRatio="none" href="${slice.url}" xlink:href="${slice.url}"/>`;
      if (slices.length === 1) out.push(image(slices[0]!, 'Screenshot'));
      else out.push(`<g id="Screenshot">`, ...slices.map((slice, i) => image(slice, `Part ${i + 1}`)), `</g>`);
      out.push(
        `<rect x="${p.x + 0.5}" y="${p.y + 0.5}" width="${p.w - 1}" height="${p.h - 1}" rx="${CORNER}" fill="none" stroke="${COLORS.border}"/>`,
        ...circleSvg(p),
        ...noteSvg(p),
      );
    } else if (p.screen.kind === 'text') {
      // A written page: a pale plum card with its icon, headline and text, the words as editable
      // text in Figma.
      const layout = textPageLayout(p);
      const font = 'Manrope, -apple-system, Segoe UI, sans-serif';
      const tspans = (lines: string[], top: number, size: number) =>
        lines.map((line, i) => `<tspan x="${p.x + TEXT_PAGE_PAD}" y="${round2(top + i * size * TEXT_PAGE_LINE)}">${xml(line)}</tspan>`).join('');
      out.push(
        `<rect x="${p.x + 1.5}" y="${p.y + 1.5}" width="${p.w - 3}" height="${p.h - 3}" fill="${TEXT_PAGE_TINT}" stroke="${COLORS.border}" stroke-width="3" stroke-dasharray="14 10"/>`,
        `<path d="${textPageIcon(p)}" transform="translate(${p.x + TEXT_PAGE_PAD} ${p.y + TEXT_PAGE_PAD}) scale(${ICON_SIZE / 24})" fill="none" stroke="${COLORS.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<text font-family="${font}" font-size="${HEADING_SIZE}" font-weight="700" fill="${COLORS.text}">${tspans(layout.heading, layout.headingTop, HEADING_SIZE)}</text>`,
        `<text font-family="${font}" font-size="${BODY_SIZE}" font-weight="500" fill="${COLORS.text}">${tspans(layout.body, layout.bodyTop, BODY_SIZE)}</text>`,
      );
    } else {
      // A page in a tab that wasn't recorded: laid out like a written page, on an empty card.
      const title = placeholderTitle(p);
      out.push(
        `<rect x="${p.x + 1.5}" y="${p.y + 1.5}" width="${p.w - 3}" height="${p.h - 3}" fill="none" stroke="${COLORS.border}" stroke-width="3" stroke-dasharray="14 10"/>`,
        `<path d="${TEXT_PAGE_ICONS.newTab.d}" transform="translate(${p.x + TEXT_PAGE_PAD} ${p.y + TEXT_PAGE_PAD}) scale(${ICON_SIZE / 24})" fill="none" stroke="${COLORS.muted}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
        text(p.x + TEXT_PAGE_PAD, p.y + TEXT_PAGE_PAD + ICON_SIZE + 44 + HEADING_SIZE, HEADING_SIZE, 700, COLORS.text, truncate(title, (p.w - TEXT_PAGE_PAD * 2) / (HEADING_SIZE * 0.55))),
        text(p.x + TEXT_PAGE_PAD, p.y + TEXT_PAGE_PAD + ICON_SIZE + 44 + HEADING_SIZE + BODY_SIZE * 1.8, BODY_SIZE, 500, COLORS.muted, 'Not recorded'),
        ...noteSvg(p),
      );
    }
    out.push(`</g>`);
  }

  out.push(`<g id="Arrows">`);
  arrows.forEach((a, i) => {
    const points = a.line.map((p) => `${round2(p.x)} ${round2(p.y)}`).join(' L');
    const head = a.head.map((p) => `${round2(p.x)} ${round2(p.y)}`).join(' L');
    out.push(
      `<g id="Arrow ${i + 1}">`,
      `<path d="M${points}" fill="none" stroke="${COLORS.accent}" stroke-width="${ARROW_WIDTH}" stroke-linecap="round" stroke-linejoin="round"${a.dashed ? ' stroke-dasharray="16 12"' : ''}/>`,
      `<path d="M${head}" fill="none" stroke="${COLORS.accent}" stroke-width="${ARROW_WIDTH}" stroke-linecap="round" stroke-linejoin="miter"/>`,
    );
    const { x, y } = a.start;
    out.push(
      `<circle id="Start" cx="${round2(x)}" cy="${round2(y)}" r="${DOT_RADIUS}" fill="${COLORS.accent}" stroke="${COLORS.accent}" stroke-width="${DOT_RING}"/>`,
    );
    out.push(`</g>`);
  });
  out.push(`</g>`, `</svg>`);
  return out.join('\n');
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function xml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Shorten text to roughly fit a number of characters. Figma can't measure it for us. */
function truncate(text: string, chars: number) {
  const max = Math.max(4, Math.floor(chars));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// --- Copy for Google Slides ---

/**
 * Google Slides and Docs turn down images over about 25 megapixels, which a flow drawn at Retina
 * resolution often is. The copied image is drawn smaller to stay under it.
 */
const MAX_SLIDES_PIXELS = 24_000_000;

/** The flow as a PNG small enough for Google Slides and Docs, for pasting as an image. */
export async function flowImageForSlides(flow: Flow, screens: Screen[], clicks: Map<string, Click>) {
  // In rows shaped like a slide, so each screen is large on the slide and the pixels go into them.
  const { canvas } = await renderFlow(flow, screens, clicks, MAX_SLIDES_PIXELS, slideColumns(screens));
  return canvas.convertToBlob({ type: 'image/png' });
}

// --- PNG resolution ---

/** PNG files measure resolution in pixels per metre. 72 dpi is one pixel per point. */
const PIXELS_PER_METRE_AT_1X = 72 / 0.0254;

/**
 * Tag a PNG with its resolution, as macOS does for its own screenshots: 144 dpi for a 2× image.
 * Without it, Preview and Quick Look show a 2× image at double size, which looks blurry.
 */
async function withResolution(png: Blob, ratio: number) {
  if (!(ratio > 1)) return png;
  const bytes = new Uint8Array(await png.arrayBuffer());
  const ppm = Math.round(PIXELS_PER_METRE_AT_1X * ratio);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm);
  view.setUint32(4, ppm);
  data[8] = 1; // The unit is the metre.
  const chunk = pngChunk('pHYs', data);

  // Replace an existing pHYs chunk, or add one straight after the header (IHDR), as PNG requires
  // it to come before the image data.
  const read = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = read.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'pHYs') {
      return new Blob([bytes.subarray(0, at), chunk, bytes.subarray(at + 12 + length)], { type: 'image/png' });
    }
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + length;
  }
  const afterHeader = 8 + 12 + read.getUint32(8);
  return new Blob([bytes.subarray(0, afterHeader), chunk, bytes.subarray(afterHeader)], { type: 'image/png' });
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- The PDF ---

/** JPEG quality for the image in the PDF. High enough that text in screenshots stays crisp. */
const PDF_JPEG_QUALITY = 0.92;
/** PDF viewers can't show a page larger than 200 inches (14,400 points) on a side. */
const MAX_PDF_PAGE = 14_400;
/** Points per CSS pixel: a 1440-pixel-wide screen is 15 inches wide, like on a 96 dpi display. */
const POINTS_PER_PX = 0.75;

/**
 * The flow image as a one-page PDF, sized to the flow. The image keeps its full resolution, so it
 * stays sharp when zoomed in. Written by hand: a PDF holding one JPEG is only a few objects.
 */
async function flowPdf(canvas: OffscreenCanvas, scale: number, title: string) {
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: PDF_JPEG_QUALITY })).arrayBuffer());
  const { width: w, height: h } = canvas;
  let pageW = (w / scale) * POINTS_PER_PX;
  let pageH = (h / scale) * POINTS_PER_PX;
  const shrink = Math.min(1, MAX_PDF_PAGE / pageW, MAX_PDF_PAGE / pageH);
  pageW = round(pageW * shrink);
  pageH = round(pageH * shrink);

  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Flow Do Q`;
  const objects: (string | [string, Uint8Array])[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Flow 4 0 R >> >> /Contents 5 0 R >>`,
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg],
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfText(title)} /Creator (FlowSnap) >>`,
  ];

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let length = 0;
  const add = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  // The binary comment tells tools the file holds binary data.
  add('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(length);
    if (typeof obj === 'string') {
      add(`${i + 1} 0 obj\n${obj}\nendobj\n`);
    } else {
      add(`${i + 1} 0 obj\n${obj[0]}\nstream\n`);
      add(obj[1]);
      add('\nendstream\nendobj\n');
    }
  });
  const xref = length;
  add(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) add(`${String(offset).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'application/pdf' });
}

/** Text for a PDF, as UTF-16 so any language shows correctly. */
function pdfText(text: string) {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex}>`;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * A name that's safe as a file or folder name on every system: no slashes or other reserved
 * characters, no leading or trailing dots or spaces, and not too long.
 */
function safeName(name: string, fallback: string) {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned || fallback;
  // Too long: shorten the start, keeping the "Mapped User Journey (N Steps)" ending whole.
  const ending = cleaned.match(/Mapped User (?:Flow|Journey) \(\d+ Steps?\)$/i)?.[0] ?? '';
  const start = cleaned.slice(0, MAX_NAME_LENGTH - ending.length - 2).trimEnd();
  return ending ? `${start}… ${ending}` : `${start}…`;
}

const MAX_NAME_LENGTH = 80;

// --- The flow image ---

/**
 * The layout is worked out in points: each screen is at most this wide, like a browser window.
 * The image is then drawn at a whole 2× or more (see exportScale), so the screens keep every pixel
 * and the text and arrows are just as sharp.
 */
const SCREEN_W = 1440;
/** Screens are never laid out narrower than this, even for small screenshots. */
const MIN_SCREEN_W = 1280;

/**
 * Image pixels per point: a whole number, at least 2. A whole 2× image shows pixel for pixel on a
 * Retina screen, where an in-between scale like 1.78× is shown slightly enlarged, which blurs it.
 * Rounded down, not up: 3× only for screenshots that really are 3×, since a bigger image than the
 * screenshots need only adds size, and a very large one has to be shrunk to be saved at all.
 */
function exportScale(screens: Screen[]) {
  const widest = Math.max(0, ...screens.map((s) => (s.kind === 'screenshot' && s.width) || 0));
  return Math.max(2, Math.floor(widest / SCREEN_W + 0.1));
}
/** In points. A long flow wider than this shrinks its screens rather than growing further. */
const MAX_IMAGE_W = 16_000;
/** In points, for very tall screens. */
const MAX_IMAGE_H = 12_000;
/**
 * Browsers can't make an image wider or taller than about 32,000 pixels, and a very large one
 * may fail to save. Above these, the image is drawn at a lower resolution instead.
 */
const MAX_PIXELS_SIDE = 32_000;
const MAX_PIXELS_AREA = 160_000_000;
const PAD = 120;
/** Space between screens: the canvas's 32px between 640px-wide screens, at this size. */
const GAP = 72;
/** Space between rows, when the flow is laid out in rows (for Slides), below each row's captions. */
const ROW_GAP = 120;

/**
 * Corner rounding of each screen in exports: none, so no part of a screenshot is cut off. The
 * canvas rounds its screens only for looks.
 */
const CORNER = 0;
const HEADER_H = 140;
const CAPTION_H = 96;

/** The space around and between things in the flow image. */
interface Spacing {
  pad: number;
  header: number;
  caption: number;
  gap: number;
  rowGap: number;
  /** Show each screen's web address under its name. */
  urls: boolean;
  /** Show "N screens · Recorded on 9 October 2026 with FlowSnap" under the title. */
  subtitle: boolean;
}

const ROOMY: Spacing = { pad: PAD, header: HEADER_H, caption: CAPTION_H, gap: GAP, rowGap: ROW_GAP, urls: true, subtitle: true };
/** The screens' numbers are set in a monospace face. */
const MONO = '"JetBrains Mono Variable", monospace';
const FONT = '"Manrope Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const COLORS = {
  background: '#F6F6F7',
  border: '#E1E1E3',
  text: '#33002D',
  muted: '#8A8A8A',
  accent: '#8A3B78',
};

interface Placed {
  screen: Screen;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Image points per canvas pixel: notes and circles are this much bigger than on the canvas, on every screen. */
  k: number;
  /** Which row it's in, when the flow is laid out in rows (for Slides). 0 otherwise. */
  row: number;
  /** Its number in the export: every card in order, as on the canvas. */
  number?: number;
}

/**
 * Draw the whole flow: screens in a row, top-aligned, with arrows from each click to the next
 * screen. `scale` is how many image pixels there are per point of layout.
 */
/**
 * Where everything in the flow image goes, in points: each screen, the arrows between them, and the
 * image's size. Shared by the image export and Copy for Figma, so they always match.
 */
export function layoutFlow(
  screens: Screen[],
  clicks: Map<string, Click>,
  columns = screens.length,
  sp: Spacing = ROOMY,
) {
  const n = Math.max(1, screens.length);
  const cols = Math.max(1, Math.min(columns, n));
  const fitW = (MAX_IMAGE_W - sp.pad * 2 - sp.gap * (cols - 1)) / cols;
  // As wide as the widest screenshot at the export's scale, so its pixels land one for one (a 2560
  // pixel Retina screenshot is 1280 points wide at 2×), within SCREEN_W and the image's width.
  const widest = Math.max(0, ...screens.map((s) => (s.kind === 'screenshot' && s.width) || 0));
  const natural = widest ? Math.max(MIN_SCREEN_W, widest / exportScale(screens)) : SCREEN_W;
  const w = Math.floor(Math.min(SCREEN_W, natural, fitW));
  // Screenshots at one shared scale, as on the canvas: one from a narrower window is narrower, so
  // the same things on the page are the same size in every screen. Other pages are full width.
  const cards = cardWidths(screens);
  const widthOf = (screen: Screen) => {
    const card = cards.get(screen.id);
    return card ? Math.round((w * card) / CARD_WIDTH) : w;
  };
  const heightOf = (screen: Screen) =>
    screen.kind === 'screenshot' && screen.width
      ? Math.round((widthOf(screen) * screen.height) / screen.width)
      : screen.kind === 'text'
        ? textPageHeight(screen, w)
        : Math.round(w * 0.6);

  // Rows of `cols` screens, each as tall as its tallest screen (and any notes hanging below it),
  // with room for captions between.
  const rowHeights: number[] = [];
  screens.forEach((screen, i) => {
    const row = Math.floor(i / cols);
    const reach = Math.ceil(notesBottom(screen, w, heightOf(screen), true));
    rowHeights[row] = Math.max(rowHeights[row] ?? Math.round(w * 0.6), reach);
  });
  const rowTops: number[] = [];
  let y = sp.pad + sp.header + sp.caption;
  for (const h of rowHeights) {
    rowTops.push(y);
    y += h + sp.rowGap + sp.caption;
  }

  let number = 0;
  // Each row packed left to right, every screen at its own width.
  const rowX: number[] = [];
  const placed: Placed[] = screens.map((screen, i) => {
    const row = Math.floor(i / cols);
    const x = rowX[row] ?? sp.pad;
    const pw = widthOf(screen);
    rowX[row] = x + pw + sp.gap;
    return {
      screen,
      x,
      y: rowTops[row]!,
      w: pw,
      h: heightOf(screen),
      k: w / CARD_WIDTH,
      row,
      // Every card is numbered in order, written steps and other-tab pages too, as on the canvas.
      number: ++number,
    };
  });

  const width = Math.max(...rowX.map((x) => x - sp.gap), sp.pad) + sp.pad;
  const lastRow = rowHeights.length - 1;
  const height = Math.min(
    MAX_IMAGE_H,
    (rowTops[lastRow] ?? sp.pad + sp.header + sp.caption) + (rowHeights[lastRow] ?? 0) + sp.pad,
  );

  // One arrow out of each screen, from its dot: the click that led to the next one, or where the
  // user moved it to.
  const arrows = flowLinks(screens, clicks).map((link) => {
    const source = placed[link.from]!;
    const start = { x: source.x + link.point.x * source.w, y: source.y + link.point.y * source.h };
    const below = (rowTops[source.row] ?? 0) + (rowHeights[source.row] ?? 0);
    return { ...arrowShape(start, source, placed[link.to]!, below, sp), start, dashed: link.dashed };
  });
  return { placed, width, height, shots: number, arrows, spacing: sp };
}

/**
 * How many screens per row make the flow's shape closest to a 16:9 slide, so it fills a slide
 * rather than being a thin strip across it.
 */
export function slideColumns(screens: Screen[], sp: Spacing = ROOMY) {
  let best = screens.length;
  let bestScore = Infinity;
  for (let cols = 1; cols <= screens.length; cols++) {
    const { width, height } = layoutFlow(screens, new Map(), cols, sp);
    const score = Math.abs(Math.log(width / height / (16 / 9)));
    if (score < bestScore) {
      best = cols;
      bestScore = score;
    }
  }
  return best;
}

/**
 * An arrow from a click to the left edge of the next screen: the line's corners, and the three
 * points of its chevron tip. When the next screen starts a new row, the arrow runs down past the end of this
 * row (`below` is the bottom of it) and back to the start of the next one.
 */
function arrowShape(from: { x: number; y: number }, source: Placed, to: Placed, below: number, sp: Spacing) {
  // The chevron's point, just touching the next screen once its round end is drawn.
  const endX = to.x - ARROW_WIDTH / 2;
  const endY = Math.min(Math.max(to.row === source.row ? from.y : to.y + to.h * 0.3, to.y + 60), to.y + to.h - 60);
  const turnX = to.x - sp.gap / 2;
  const line =
    to.row === source.row
      ? [from, { x: turnX, y: from.y }, { x: turnX, y: endY }, { x: endX, y: endY }]
      : [
          from,
          { x: source.x + source.w + sp.gap / 2, y: from.y },
          { x: source.x + source.w + sp.gap / 2, y: below + sp.rowGap / 2 },
          { x: turnX, y: below + sp.rowGap / 2 },
          { x: turnX, y: endY },
          { x: endX, y: endY },
        ];
  return {
    line,
    // An open chevron: from above, to the point, back to below.
    head: [{ x: endX - 17, y: endY - 10 }, { x: endX, y: endY }, { x: endX - 17, y: endY + 10 }],
  };
}

/**
 * Draw the whole flow: screens in a row, with arrows from each click to the next screen. It's drawn
 * at the screenshots' own resolution, unless that's more than `maxPixels`.
 */
async function renderFlow(
  flow: Flow,
  screens: Screen[],
  clicks: Map<string, Click>,
  maxPixels = MAX_PIXELS_AREA,
  columns = screens.length,
  sp: Spacing = ROOMY,
) {
  const { placed, width, height, shots: number, arrows } = layoutFlow(screens, clicks, columns, sp);
  // Draw at a whole 2× or more, so the screenshots keep every pixel and the text and arrows are
  // sharp, within what a browser can save.
  const scale = Math.min(
    exportScale(screens),
    MAX_PIXELS_SIDE / width,
    MAX_PIXELS_SIDE / height,
    Math.sqrt(maxPixels / (width * height)),
  );
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Header: the flow's name and a short summary.
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 52px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(flow.name, sp.pad, sp.pad + 52);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `700 28px ${FONT}`;
  if (sp.subtitle) ctx.fillText(subtitle(flow, number), sp.pad, sp.pad + 100);

  for (const p of placed) {
    drawCaption(ctx, p, sp);
    if (p.screen.kind === 'screenshot' && p.screen.image) await drawScreen(ctx, p);
    else if (p.screen.kind === 'text') drawTextPage(ctx, p);
    else drawPlaceholder(ctx, p);
  }

  // Circles and notes on the screens, then the arrows over everything, with a dot where each starts.
  for (const p of placed) drawCircles(ctx, p);
  for (const p of placed) for (const shape of noteShapes(p)) drawNote(ctx, shape);
  for (const arrow of arrows) drawArrow(ctx, arrow);
  for (const arrow of arrows) drawClickDot(ctx, arrow.start.x, arrow.start.y);

  return { canvas, scale };
}

/**
 * The line under the flow's name in exports: its number of screens and the day it was recorded,
 * like "5 screens · Recorded on 9 October 2026 with FlowSnap". The date is written the way the
 * user's computer writes dates.
 */
function subtitle(flow: Flow, screens: number) {
  const date = new Date(flow.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' });
  return `${screens} ${screens === 1 ? 'screen' : 'screens'} · Recorded on ${date} with FlowSnap`;
}

function drawCaption(ctx: OffscreenCanvasRenderingContext2D, p: Placed, sp: Spacing) {
  const y = p.y - sp.caption;
  ctx.textBaseline = 'alphabetic';
  let x = p.x;
  if (p.number) {
    ctx.fillStyle = COLORS.accent;
    ctx.font = `600 30px ${MONO}`;
    const label = String(p.number).padStart(2, '0');
    ctx.fillText(label, x, y + 36);
    x += ctx.measureText(label).width + 14;
  }
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 30px ${FONT}`;
  const title = screenLabel(p.screen);
  ctx.fillText(fit(ctx, title, p.x + p.w - x), x, y + 36);

  if (sp.urls) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(fit(ctx, shortUrl(p.screen.url), p.w), p.x, y + 70);
  }
}

async function drawScreen(ctx: OffscreenCanvasRenderingContext2D, p: Placed) {
  const bitmap = await createImageBitmap(await blurredImage(p.screen));
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.10)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  roundRect(ctx, p.x, p.y, p.w, p.h, CORNER);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, p.x, p.y, p.w, p.h, CORNER);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, p.x, p.y, p.w, p.h);
  ctx.restore();
  bitmap.close();

  roundRect(ctx, p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, CORNER);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** A written page's padding, icon size, text sizes and line height, in points. */
const TEXT_PAGE_PAD = 72;
const ICON_SIZE = 112;
const HEADING_SIZE = 56;
const BODY_SIZE = 40;
const TEXT_PAGE_LINE = 1.4;

/** A written page's icon: the one picked, or three dots. */
function textPageIcon(p: Placed) {
  return textPageIconPath(p.screen.icon);
}

/** Measures text for written pages, at the size and weight it's drawn. */
let measurer: OffscreenCanvasRenderingContext2D | undefined;
function measureText(line: string, size: number, weight: number) {
  measurer ??= new OffscreenCanvas(1, 1).getContext('2d')!;
  measurer.font = `${weight} ${size}px ${FONT}`;
  return measurer.measureText(line).width;
}

/**
 * Where a written page's headline and text go, `top` being the card's top, in lines that fit its
 * width. Nothing is cut off: the card is made as tall as its text needs.
 */
function textPageLines(screen: Screen, w: number, top: number) {
  const width = w - TEXT_PAGE_PAD * 2;
  const headingTop = top + TEXT_PAGE_PAD + ICON_SIZE + 44 + HEADING_SIZE;
  const headingText = screen.heading?.trim() ?? '';
  const heading = headingText ? wrapLines(headingText, width, (l) => measureText(l, HEADING_SIZE, 700)) : [];
  const bodyTop = headingTop + (heading.length ? (heading.length - 1) * HEADING_SIZE * TEXT_PAGE_LINE + BODY_SIZE * 1.6 : 0);
  const text = screen.text?.trim() ?? '';
  const body = text ? wrapLines(text, width, (l) => measureText(l, BODY_SIZE, 500)) : [];
  const bottom = (body.length ? bodyTop + (body.length - 1) * BODY_SIZE * TEXT_PAGE_LINE : headingTop) + TEXT_PAGE_PAD;
  return { heading, headingTop, body, bodyTop, bottom };
}

/** A written page is never taller than this share of its width, to stay in proportion with the screens. */
const TEXT_PAGE_MAX_RATIO = 0.95;

/** A written page's height: the usual card shape, or taller if its text needs it, up to a limit. */
function textPageHeight(screen: Screen, w: number) {
  return Math.min(Math.round(w * TEXT_PAGE_MAX_RATIO), Math.max(Math.round(w * 0.6), Math.ceil(textPageLines(screen, w, 0).bottom)));
}

/** A written page's lines in its card, the text ending in "…" if it runs past the card's height. */
function textPageLayout(p: Placed) {
  const layout = textPageLines(p.screen, p.w, p.y);
  const room = Math.floor((p.y + p.h - TEXT_PAGE_PAD - layout.bodyTop) / (BODY_SIZE * TEXT_PAGE_LINE)) + 1;
  if (layout.body.length > room) {
    layout.body = layout.body.slice(0, Math.max(0, room));
    if (room > 0) layout.body[room - 1] = `${layout.body[room - 1]!.replace(/\s*\S*$/, '')}…`;
  }
  return layout;
}

/** A page the user wrote between two screens: a pale plum card with its icon, headline and text. */
function drawTextPage(ctx: OffscreenCanvasRenderingContext2D, p: Placed) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.10)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = TEXT_PAGE_TINT;
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.restore();
  // A dashed outline, setting it apart from a captured screen.
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(p.x + 1.5, p.y + 1.5, p.w - 3, p.h - 3);
  ctx.setLineDash([]);

  // The icon, large, straight on the card.
  ctx.save();
  ctx.translate(p.x + TEXT_PAGE_PAD, p.y + TEXT_PAGE_PAD);
  ctx.scale(ICON_SIZE / 24, ICON_SIZE / 24);
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(textPageIcon(p)));
  ctx.restore();
  ctx.textBaseline = 'alphabetic';

  const layout = textPageLayout(p);
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 ${HEADING_SIZE}px ${FONT}`;
  layout.heading.forEach((line, i) => ctx.fillText(line, p.x + TEXT_PAGE_PAD, layout.headingTop + i * HEADING_SIZE * TEXT_PAGE_LINE));
  ctx.font = `500 ${BODY_SIZE}px ${FONT}`;
  layout.body.forEach((line, i) => ctx.fillText(line, p.x + TEXT_PAGE_PAD, layout.bodyTop + i * BODY_SIZE * TEXT_PAGE_LINE));
}

/** The headline on a page in a tab that wasn't recorded: its title, or where it was. */
function placeholderTitle(p: Placed) {
  let host = '';
  try {
    host = new URL(p.screen.url).host;
  } catch {
    // No address, or one that can't be read.
  }
  return p.screen.title || host || 'A page in another tab';
}

/**
 * A page that opened in a tab FlowSnap didn't record: laid out like a written page (a large icon,
 * a headline and "Not recorded", with a dashed outline), on an empty card.
 */
function drawPlaceholder(ctx: OffscreenCanvasRenderingContext2D, p: Placed) {
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(p.x + 1.5, p.y + 1.5, p.w - 3, p.h - 3);
  ctx.setLineDash([]);

  ctx.save();
  ctx.translate(p.x + TEXT_PAGE_PAD, p.y + TEXT_PAGE_PAD);
  ctx.scale(ICON_SIZE / 24, ICON_SIZE / 24);
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(TEXT_PAGE_ICONS.newTab.d));
  ctx.restore();

  const top = p.y + TEXT_PAGE_PAD + ICON_SIZE + 44 + HEADING_SIZE;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 ${HEADING_SIZE}px ${FONT}`;
  ctx.fillText(fit(ctx, placeholderTitle(p), p.w - TEXT_PAGE_PAD * 2), p.x + TEXT_PAGE_PAD, top);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 ${BODY_SIZE}px ${FONT}`;
  ctx.fillText('Not recorded', p.x + TEXT_PAGE_PAD, top + BODY_SIZE * 1.8);
}

/** An elbow arrow from a click to the left edge of the next screen. */
/** Line width of the arrows in exports, in layout units. */
const ARROW_WIDTH = 5.5;

function drawArrow(ctx: OffscreenCanvasRenderingContext2D, arrow: ReturnType<typeof arrowShape> & { dashed: boolean }) {
  const { line, head, dashed } = arrow;
  ctx.save();
  arrowShadow(ctx);
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = ARROW_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([16, 12]);
  ctx.beginPath();
  line.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  // The chevron, drawn with the same line, never dashed, with a sharp tip.
  ctx.lineJoin = 'miter';
  ctx.setLineDash([]);
  ctx.beginPath();
  head.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  ctx.restore();
}

/** A screen's circles, scaled with the screen from its size on the canvas. */
function circleShapes(p: Placed) {
  const k = p.k;
  return (p.screen.circles ?? []).map((c) => {
    const w = c.w * p.w;
    const h = c.h * p.h;
    const points = circlePoints(c, w, h).map((pt) => ({ x: p.x + c.x * p.w + pt.x, y: p.y + c.y * p.h + pt.y }));
    return { points, stroke: CIRCLE_STROKE * k };
  });
}

function drawCircles(ctx: OffscreenCanvasRenderingContext2D, p: Placed) {
  for (const c of circleShapes(p)) {
    ctx.save();
    ctx.strokeStyle = CIRCLE_COLOR;
    ctx.lineWidth = c.stroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(smoothPath(c.points)));
    ctx.restore();
  }
}

/** Circles as SVG paths, for Copy for Figma. */
function circleSvg(p: Placed) {
  return circleShapes(p).map(
    (c) =>
      `<path id="Circle" d="${smoothPath(c.points)}" fill="none" stroke="${CIRCLE_COLOR}" stroke-width="${round2(c.stroke)}" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
}

/** A note laid out on its screen in the export: its square, and its text broken into lines. */
interface NoteShape {
  x: number;
  y: number;
  size: number;
  /** How much larger than on the canvas. */
  k: number;
  font: number;
  lines: string[];
  paper: string;
}

/** Where each of a screen's notes goes, scaled with the screen from its size on the canvas. */
function noteShapes(p: Placed): NoteShape[] {
  const k = p.k;
  return (p.screen.notes ?? [])
    .filter((n) => n.text.trim())
    .map((n) => {
      // Fitted at canvas size, then scaled, so the lines break just as they do on the canvas.
      const { font, lines } = fitNote(n.text.trim());
      return { x: p.x + n.x * p.w, y: p.y + n.y * p.h, size: NOTE_SIZE * k, k, font: font * k, lines, paper: notePaper(n) };
    });
}

/** The top of each line of a note's text, centred in the note as a block. */
function noteLineTops(n: NoteShape) {
  const lineHeight = n.font * NOTE_LINE;
  const top = n.y + (n.size - n.lines.length * lineHeight) / 2;
  return n.lines.map((_, i) => top + i * lineHeight + (lineHeight - n.font) / 2);
}

function drawNote(ctx: OffscreenCanvasRenderingContext2D, n: NoteShape) {
  ctx.save();
  // A shadow under the bottom edge, as if the note's lifting off the screen a little.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = 5 * n.k;
  ctx.shadowOffsetY = 2.5 * n.k;
  ctx.fillStyle = n.paper;
  ctx.fillRect(n.x, n.y, n.size, n.size);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = NOTE_COLORS.text;
  ctx.font = `700 ${n.font}px ${NOTE_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const tops = noteLineTops(n);
  n.lines.forEach((line, i) => ctx.fillText(line, n.x + n.size / 2, tops[i]!));
  ctx.restore();
}

/** Notes as SVG, for Copy for Figma: a yellow square with the text as editable text. */
function noteSvg(p: Placed) {
  return noteShapes(p).map((n) => {
    const tops = noteLineTops(n);
    const lines = n.lines
      .map(
        (line, i) =>
          `<tspan x="${round2(n.x + n.size / 2)}" y="${round2(tops[i]! + n.font * 0.8)}">${xml(line) || ' '}</tspan>`,
      )
      .join('');
    return [
      `<g id="Note">`,
      `<rect x="${round2(n.x)}" y="${round2(n.y)}" width="${round2(n.size)}" height="${round2(n.size)}" fill="${n.paper}"/>`,
      `<text font-family="Manrope, -apple-system, Segoe UI, sans-serif" font-size="${round2(n.font)}" font-weight="700" fill="${NOTE_COLORS.text}" text-anchor="middle">${lines}</text>`,
      `</g>`,
    ].join('');
  });
}

/** Where an arrow starts: a solid dot in the arrow's colour, with its shadow. */
function drawClickDot(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  arrowShadow(ctx);
  ctx.fillStyle = COLORS.accent;
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = DOT_RING;
  ctx.beginPath();
  ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Where an arrow starts: a solid dot in the arrow's colour, as on the canvas, in layout
 * units (the canvas's 11px dot, scaled with the screens), its ring as thick as the arrow's line.
 */
const DOT_RADIUS = 9.6;
/** The same as the arrow's line width, as on the canvas. */
const DOT_RING = ARROW_WIDTH;

/** The soft shadow the arrows and their dots share, as on the canvas, scaled up the same way. */
function arrowShadow(ctx: OffscreenCanvasRenderingContext2D) {
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = 3.4;
  ctx.shadowOffsetY = 2.25;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Shorten text with an ellipsis to fit a width. */
function fit(ctx: OffscreenCanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return (u.host + (u.pathname === '/' ? '' : u.pathname)).replace(/^www\./, '');
  } catch {
    return url;
  }
}
