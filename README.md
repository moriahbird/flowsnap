# FlowSnap

A Chrome extension for product designers that records a user flow as you click through a website and lays it out as an editable flow diagram: screenshots connected by arrows from exactly where you clicked, ready to annotate and paste into Figma.

## Try it

1. Download **FlowSnap.zip** from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

Then pin FlowSnap to the toolbar, open any website, and click the FlowSnap icon to start recording. Click through the site as usual and press **Finish** in the small panel when you're done. The flow opens on a canvas.

The first recording asks for access to websites. FlowSnap needs that to capture pages, and asks for it only when you first record, not at install.

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
