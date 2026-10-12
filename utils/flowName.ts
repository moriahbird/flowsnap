/**
 * Flow names. A new flow is named after the website and its number of screens, like
 * "Airbnb Mapped User Journey (4 Steps)". Exported files always end the same way, whatever the
 * flow is called, so they're easy to recognise.
 */

/** A flow's default name is never longer than this. */
export const MAX_DEFAULT_NAME = 60;

/** The ending of every default name and every exported file's name. */
export function flowSuffix(steps: number) {
  return `Mapped User Journey (${steps} ${steps === 1 ? 'Step' : 'Steps'})`;
}

/**
 * Matches that ending on a name, whatever number of steps it had. Older flows end in "User Flow",
 * which is updated to "User Journey" too.
 */
const SUFFIX = /\s*Mapped User (?:Flow|Journey)(?: \(\d+ Steps?\))?$/i;

/** The number of steps at the end of a name, like " (4 Steps)". */
const STEPS = /\s*\(\d+ Steps?\)$/i;

/**
 * A flow's name as shown and edited in the canvas's top bar: without its number of steps, which
 * the bar shows on its own and exported files add back.
 */
export function shownName(name: string) {
  return name.replace(STEPS, '').trim() || name;
}

/** The name a new flow gets: the website's name, then the suffix, at most 60 characters. */
export function defaultFlowName(site: string, steps: number) {
  const suffix = flowSuffix(steps);
  const room = MAX_DEFAULT_NAME - suffix.length - 1;
  const name = site.length > room ? `${site.slice(0, room - 1).trimEnd()}…` : site;
  return name ? `${name} ${suffix}` : suffix;
}

/**
 * The name exported files are given: the flow's name, always ending in the suffix with the flow's
 * current number of steps. A name that already ends in a suffix (with or without its number of
 * steps) has it updated, not repeated.
 */
export function exportName(name: string, steps: number) {
  // A renamed flow may still end in an old "(3 Steps)" on its own; that's replaced too.
  const base = name.replace(SUFFIX, '').replace(STEPS, '').replace(SUFFIX, '').trim();
  if (!base) return flowSuffix(steps);
  // Already called a user journey or flow, like "Random User Journey": just add the steps.
  if (/\buser (?:journey|flow)$/i.test(base)) return `${base} (${steps} ${steps === 1 ? 'Step' : 'Steps'})`;
  return `${base} ${flowSuffix(steps)}`;
}

/**
 * A website's name, from what the site calls itself (its og:site_name or application-name tag)
 * if that's short and plain, otherwise from its address: "www.airbnb.co.uk" becomes "Airbnb".
 */
export function siteName(declared: string | undefined, url: string) {
  // Sites sometimes put a tagline in it, like "The Times | Breaking news". Keep the first part.
  const own = declared?.split(/\s+[|·–—-]\s+|:\s+/)[0]?.trim();
  if (own && own.length <= 32) return own;
  return siteFromUrl(url);
}

/** Second-level names used before a country's domain, like the "co" in "airbnb.co.uk". */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

function siteFromUrl(url: string) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  const parts = host.replace(/^www\d*\./, '').split('.');
  if (parts.length < 2) return capitalize(parts[0] ?? '');
  let i = parts.length - 2;
  if (i > 0 && parts[parts.length - 1]!.length === 2 && SECOND_LEVEL.has(parts[i]!)) i--;
  return capitalize(parts[i]!);
}

function capitalize(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
