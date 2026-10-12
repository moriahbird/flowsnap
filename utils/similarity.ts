/**
 * Spotting near-duplicate screenshots: two captures that look the same apart from tiny
 * details like a blinking cursor. Screenshots are shrunk to a small greyscale thumbnail
 * and compared pixel by pixel.
 */

const WIDTH = 160;
const HEIGHT = 100;
/** How different two thumbnail pixels must be (0–255) to count as changed. */
const PIXEL_THRESHOLD = 24;
/**
 * Fewer changed pixels than this share means "the same screen". Small enough that a short
 * tooltip or a dropdown still makes a screen count as different.
 */
const MAX_CHANGED_SHARE = 0.0006;

export type Fingerprint = Uint8Array;

export async function fingerprint(image: Blob | ImageBitmap): Promise<Fingerprint> {
  const bitmap = image instanceof Blob ? await createImageBitmap(image) : image;
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
  if (image instanceof Blob) bitmap.close();
  const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const grey = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000;
  }
  return grey;
}

export function nearlyIdentical(a: Fingerprint, b: Fingerprint) {
  const limit = a.length * MAX_CHANGED_SHARE;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > PIXEL_THRESHOLD && ++changed > limit) return false;
  }
  return true;
}
