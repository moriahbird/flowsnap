/**
 * Written pages: pages the user adds between two screens to describe a step that isn't captured,
 * whether it happens elsewhere (checking an email, typing a code sent by text) or on the page and
 * simply wasn't recorded. Shared by the canvas and the exports.
 */

/** The quick icons a written page can show, drawn as outline paths on a 24 × 24 grid. */
export const TEXT_PAGE_ICONS = {
  newTab: {
    label: 'New tab',
    d: 'M7 17 17 7M8 7h9v9',
  },
  email: {
    label: 'Email',
    d: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 7.5 12 13l8.5-5.5',
  },
  message: {
    label: 'Text message',
    d: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 10.5h.01M12 10.5h.01M16 10.5h.01',
  },
  call: {
    label: 'Phone call',
    d: 'M5 4h3.5l2 5-2.5 1.6a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z',
  },
  app: {
    label: 'Another app',
    d: 'M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2zM11 18h2',
  },
} as const;

export type TextPageIcon = keyof typeof TEXT_PAGE_ICONS;

/** A written page's icon path: the one picked, or three dots (also for an icon no longer offered). */
export function textPageIconPath(icon: string | undefined) {
  return icon && icon in TEXT_PAGE_ICONS ? TEXT_PAGE_ICONS[icon as TextPageIcon].d : TEXT_PAGE_DEFAULT_ICON;
}

/** Shown when no quick icon is picked: three dots, for "something happens here". */
export const TEXT_PAGE_DEFAULT_ICON = 'M6 12h.01M12 12h.01M18 12h.01';

/** A written page's name until it has a headline. */
export const TEXT_PAGE_NAME = 'Added step';

/** A written page's tint: a very pale plum, so it reads as a note between screens, not a screenshot. */
export const TEXT_PAGE_TINT = '#FAF5F8';

export const TEXT_PAGE_HEADING_PLACEHOLDER = 'What happens here…';
export const TEXT_PAGE_BODY_PLACEHOLDER = 'e.g. They check their email and tap the link.';
