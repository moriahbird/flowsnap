# FlowSnap

A Chrome extension for product designers that records a user flow as you click through a website and lays it out as an editable flow diagram: screenshots connected by arrows from exactly where you clicked, ready to annotate and paste into Figma.

## Install (about 2 minutes)

FlowSnap works in Chrome on a computer (and other Chrome-based browsers like Edge, Arc and Brave). It isn't on the Chrome Web Store, so it's installed from a download:

1. **Download** [FlowSnap.zip](https://github.com/moriahbird/flowsnap/releases/latest/download/FlowSnap.zip).
2. **Unzip it.** Double-click the downloaded file. You'll get a folder called **FlowSnap**.
3. **Open Chrome's extensions page.** Type `chrome://extensions` in the address bar and press Enter.
4. **Turn on Developer mode** with the switch in the top-right corner of that page.
5. **Click Load unpacked** (top left), then choose the **FlowSnap folder** from step 2 (the folder, not the .zip file) and click **Select**.
6. **Pin it.** Click the puzzle-piece icon to the right of the address bar, then the pin next to FlowSnap, so its icon stays in the toolbar.

If **Load unpacked** or **Developer mode** is missing or greyed out, your browser is managed by your organization and doesn't allow extensions from outside the Chrome Web Store. Try a personal computer or Chrome profile.

## Record your first flow

1. Open any website, like an online store.
2. Click the **FlowSnap icon** in the toolbar. The first time, Chrome asks to let FlowSnap read and change site data, which it needs to capture pages. Click **Allow**, and recording starts.
3. Click through the site as you normally would. A small panel in the corner counts the screens captured. It never appears in the screenshots.
4. Click **Stop Recording** in the panel. Your flow opens on a canvas: screens joined by arrows from where you clicked.
5. Drag notes, circles or blurs onto the screens, then use **Copy for Figma** or **Download** to export it.

Recordings are stored only in your browser. Nothing is uploaded.

## What it does

- **Captures the screens that matter.** A new screen is captured when a page loads, an app changes view without loading a page, a modal, dropdown or menu opens, or a hover reveals something new. Changes you didn't cause (carousels, ads, spinners) are learned and ignored.
- **Captures whole pages.** Scrolling a long page grows one tall screenshot instead of many partial ones, without repeating sticky headers or pinned elements.
- **Connects screens where you clicked.** Each arrow starts at the exact spot you clicked, even partway down a tall page. A link that opens a new tab shows up as a placeholder in the flow, and clicking the FlowSnap icon in that tab records it into the same flow.
- **Lets you annotate.** Drag on sticky notes, circles and blurs (for hiding sensitive information). Add written steps for things that happen off-screen, like checking an email.
- **Exports cleanly.** Copy for Figma pastes the flow as editable layers (named screen groups, vector arrows, text labels). Download as PNG or PDF, with or without the individual screenshots.
- **Keeps everything local.** Recordings are stored only in your browser. Nothing is uploaded.

## Build from source

Requires a recent version of Node.js.

```bash
npm install
npm run build
```

The extension is built to `extension/chrome-mv3`; load that folder with **Load unpacked** as above. `npm run dev` builds in watch mode and opens a Chrome window with the extension loaded.

## How it's built

- [WXT](https://wxt.dev), React and TypeScript, Manifest V3
- IndexedDB (via `idb`) for flows, screens and clicks
- `entrypoints/background.ts`: recording state, the capture queue and storage
- `entrypoints/content.ts` and `utils/changeDetector.ts`: watching the page for clicks and screen changes
- `entrypoints/viewer/`: the canvas and exports

The product spec, including the key design decisions behind it, is in [docs/PRD.md](docs/PRD.md).
