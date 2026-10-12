import type { Note, NoteColor, Screen } from '@/utils/db';

/**
 * Sticky notes on screens. Sizes are in canvas pixels on a screen 640 wide, which is how wide every
 * screen is on the canvas. Exports scale them with the screen, so a note covers the same part of it.
 */
export const CARD_WIDTH = 640;
/** Notes are square, like a paper sticky note. */
export const NOTE_SIZE = 76;
/** A note can be dragged off a screen's right and bottom edges, as long as it still overlaps it by this much. */
export const NOTE_OVERLAP = 16;
/** Space around the text, which is also where a note is dragged from. */
export const NOTE_PAD = 10;
export const NOTE_LINE = 1.3;
/** Text starts at the largest size and shrinks to fit, down to the smallest. */
export const NOTE_MAX_FONT = 13;
export const NOTE_MIN_FONT = 6.5;
export const NOTE_FONT_FAMILY = '"Manrope Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const NOTE_COLORS = { text: '#33002D' };

/** The colours a note can be, in the order the palette shows them. Yellow is the default. */
export const NOTE_PAPERS: { color: NoteColor; label: string; paper: string }[] = [
  { color: 'yellow', label: 'Yellow', paper: '#FFEC85' },
  { color: 'green', label: 'Green: something good', paper: '#C8F0C4' },
  { color: 'pink', label: 'Pink: something to fix', paper: '#FFC9CE' },
];

/** A note's paper colour. */
export function notePaper(note: Note) {
  return (NOTE_PAPERS.find((p) => p.color === note.color) ?? NOTE_PAPERS[0]!).paper;
}

interface Measurer {
  font: string;
  measureText: (text: string) => { width: number };
}

let shared: Measurer | undefined;

/**
 * The size a note's text is shown at, and its lines: the largest size, up to NOTE_MAX_FONT, at which
 * it fits in the note, in canvas pixels. Centred in the note, like a sticky note in Miro.
 */
export function fitNote(text: string, measure: Measurer = (shared ??= new OffscreenCanvas(1, 1).getContext('2d')!)) {
  const inner = NOTE_SIZE - 2 * NOTE_PAD;
  let font = NOTE_MAX_FONT;
  for (; ; font -= 0.5) {
    measure.font = `700 ${font}px ${NOTE_FONT_FAMILY}`;
    const width = (t: string) => measure.measureText(t).width;
    const lines = wrapLines(text, inner, width);
    // Small enough that it fits, and that no word has to be split across lines.
    const wordsFit = text.split(/\s+/).every((word) => width(word) <= inner);
    if ((wordsFit && lines.length * font * NOTE_LINE <= inner) || font <= NOTE_MIN_FONT) return { font, lines };
  }
}

/** A new note, with its top-left corner where the screen was clicked, kept on the screen. */
export function newNote(x: number, y: number): Note {
  return {
    id: crypto.randomUUID(),
    x: Math.min(Math.max(0, x), 1 - NOTE_SIZE / CARD_WIDTH),
    y: Math.min(Math.max(0, y), 0.98),
    text: '',
  };
}

/**
 * How far below the top of a screen its lowest note reaches, for a screen `w` wide and `h` tall in
 * any units. At least `h`, so it's how much room the screen and its notes need.
 */
export function notesBottom(screen: Screen, w: number, h: number, withText = false) {
  const k = w / CARD_WIDTH;
  return (screen.notes ?? [])
    .filter((n) => !withText || n.text.trim())
    .reduce((bottom, n) => Math.max(bottom, n.y * h + NOTE_SIZE * k), h);
}

/** Break a note's text into lines no wider than `width`, using `measure` for each line's width. */
export function wrapLines(text: string, width: number, measure: (line: string) => number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (!line || measure(next) <= width) {
        line = next;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
      // A word too long for a line on its own is broken wherever it runs out of room.
      while (measure(line) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
