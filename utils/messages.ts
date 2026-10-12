/** Messages from the page (content script) to the background. */
export type ToBackground =
  /** `pageY`: the click's distance from the top of the whole page, for placing it on a tall screen. */
  | { type: 'click'; screenKey: string; x: number; y: number; pageY: number }
  | { type: 'hello' }
  /** What the page's website calls itself, for naming the flow. Empty if it doesn't say. */
  | { type: 'page-info'; siteName: string }
  /** `replace`: the screen showing finished filling in. Update its capture instead of adding one. */
  | { type: 'capture-request'; replace?: boolean }
  /** The user scrolled further down the page. Capture what's showing and add it to the screen. */
  | { type: 'capture-slice' }
  | { type: 'finish' }
  /** From the canvas: go back to the flow's page and keep recording into it. */
  | { type: 'continue-flow'; flowId: string };

/** Reply to 'continue-flow': why it couldn't continue, if it couldn't. */
export interface ContinueReply {
  error?: string;
}

/** Messages from the background to the canvas. */
export type ToViewer =
  /** The flow was recorded into again. A canvas showing it reloads, comes to the front and replies true. */
  { type: 'show-flow'; flowId: string };

/** Messages from the background to the page. */
export type ToPage =
  /**
   * `slice`: the capture adds to a tall screen, so things pinned beside the content are hidden.
   * `refresh`: the capture redraws part of the screen showing, so they're hidden too if the page
   * is scrolled below where the screen starts.
   */
  | { type: 'prepare-capture'; slice?: boolean; refresh?: boolean }
  /**
   * `covered`: how far up and down the page the screen showing now reaches, so the page knows when
   * to add more.
   */
  | {
      type: 'capture-done';
      covered?: { screenKey: string; top?: number; bottom: number };
      /** A tall screen's part was thrown away: the page moved while it was being captured. */
      missed?: boolean;
    }
  | { type: 'current-screen' }
  /** `flash` confirms a screen was saved even though the count didn't change. */
  | { type: 'status'; screenCount: number; flash?: boolean }
  | { type: 'note'; text: string }
  /** Parts of a tall screen skipped by scrolling too fast, in page pixels, so scrolling back fills them in. */
  | { type: 'gaps'; screenKey: string; gaps: Gap[] }
  | { type: 'stop' };

/** A stretch of a tall screen that was scrolled past too fast to capture, in page CSS pixels. */
export interface Gap {
  from: number;
  to: number;
}

/** Reply to 'hello': whether this page's tab is being recorded. */
export interface HelloReply {
  recording: boolean;
  screenCount: number;
  /**
   * This tab's own screen isn't in screenCount yet: the page recording started on, or a tab
   * added by clicking FlowSnap in it. A tab opened from the flow already has a placeholder.
   */
  ownScreenPending: boolean;
}

/**
 * Reply to 'prepare-capture' (once FlowSnap's UI is hidden) and to 'current-screen':
 * which screen is showing.
 */
export interface PrepareReply {
  screenKey: string;
  /** Where the page is scrolled to right now, from 'current-screen'. */
  scrollY?: number;
  /** Where the page is scrolled to, from 'prepare-capture'. */
  view?: ViewInfo;
}

/** The visible part of the page when a screenshot is taken, in CSS pixels. */
export interface ViewInfo {
  scrollY: number;
  viewportHeight: number;
  /** Height of a header that stays fixed at the top as the page scrolls. 0 if none. */
  header: number;
  /** Height of a footer that stays fixed at the bottom. 0 if none. */
  footer: number;
  /** Scrolled all the way to the bottom of the page. */
  atBottom: boolean;
}

/**
 * Local storage key for where the panel was dragged to. It's kept between pages of a recording
 * and cleared when a new recording starts, so each one begins in the corner.
 */
export const PANEL_POSITION_KEY = 'panelPosition';
