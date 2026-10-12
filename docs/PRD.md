# FlowSnap: User Flow Capture for Chrome

## Problem

Benchmarking a competitor's user flow is tedious. Today it means clicking through the product, screenshotting every screen, renaming the files, dragging them into Figma, lining them up and drawing arrows between them. That time goes to busywork instead of analysis, and it's the part of research I dread most.

## Who it's for

Product designers, PMs and UX researchers doing competitive analysis or gathering inspiration.

## Solution

FlowSnap is a free Chrome extension that records a flow as soon as you click its icon. It captures each screen as you click through and remembers where you clicked. It then lays the flow out on a canvas, with an arrow from each click to the screen it led to. You can tidy it up and blur sensitive information, then download it as an image or PDF and a zipped folder of numbered screenshots.

## Goals

- Capture a full flow without taking a single manual screenshot.
- Start recording in one click.
- Show a flow diagram that's ready to use, in click order, with arrows starting at the exact spot clicked.
- Make cleanup fast: rename, reorder and delete screens.
- Let users blur sensitive information before sharing.
- Export what designers need: one image of the flow, plus the individual screens in order.
- Keep it free and private, with everything stored on the user's own computer.
- Publish it publicly on the Chrome Web Store.

## Core experience

1. **Start.** Click the FlowSnap icon in the toolbar. Recording starts immediately and the current page is captured as screen 1. FlowSnap asks for no website access at install. The first time you record, Chrome asks for website access, and FlowSnap explains in one line that nothing leaves your computer.
2. The recording panel appears on the page (see "Recording panel").
3. **Browse normally.** FlowSnap records only the tab you started in. It captures a new screen whenever you change what's on screen: a new page loading, an app moving to a new view without loading a page (as many modern sites do), a modal or dropdown opening, search suggestions appearing, or a tooltip or menu appearing when you hover. A hover only counts if something new appears, or something under the pointer grows by about 80px or more (like a side nav widening to show its labels); hover effects that just change colors or styling, or swell a button slightly, are ignored. It also ignores changes you didn't cause, like carousels, ads, tickers and loading spinners.
4. **Capture manually if needed.** If FlowSnap misses something, like a modal or a subtle change, press **Capture extra screen**.
5. **Add a tab when you need it.** If a click opens something in a new tab, like a presentation opened from Google Drive, click the FlowSnap icon in that tab to add it to the flow you're recording (see "Adding a tab"). You can then switch between the tabs freely; whichever one you're looking at is recorded, until you finish the flow or close the tab. FlowSnap never follows a new tab on its own.
6. **Scroll.** On a page longer than the window, the whole page is captured as one tall screen (see "Tall pages").
7. **Finish.** Press **Finish & view flow**. The canvas opens in a new tab with screens in one row, top-aligned and zoomed to fit, with arrows from each click point to the next screen.
8. **Refine.** Rename, reorder or delete screens, pan and zoom around the canvas, and blur sensitive information.
9. **Export.** From the canvas's **Download** menu, pick PNG or PDF for the flow, and optionally include every screenshot to get one zip with the flow and a folder of numbered screenshots. Blurs are applied to everything exported.
10. **Come back later.** Open "My flows" from the canvas header or by right-clicking the FlowSnap icon. From there, reopen, edit or continue past flows.

## Recording panel

A floating panel on the page while recording (see `designs/recording-panel.png`).

### Layout

- **Look:** matches the canvas: white with a 1.5px #DAD5D8 line and 14px corners, plum text, 8px-cornered buttons. The drag handle is at the end.
- **Status:** a red, gently pulsing dot with "Recording."
- **Count:** "4 screens captured."
- **No mini flow:** the panel used to show a growing chain of small screen icons. It was removed because something moving on every click was distracting on busy pages; the count going up is the confirmation. The old version is in commit 1c023ee.
- **Main button:** Finish & view flow.
- **Secondary button:** Capture extra screen.
- **Cancel / Discard:** for the first few seconds, Cancel undoes an accidental start. After that, a less prominent Discard asks for confirmation.

### Behavior

- **Draggable:** users can move it anywhere, and it remembers its position.
- **Stays put across pages:** the panel reappears on each new page in the recorded tab.
- Clicking the toolbar icon while recording never stops the recording.

## Adding a tab

For flows that briefly move into another tab, like opening a presentation from Google Drive, clicking through a few slides, then going back to Drive.

- **Only the tab you're looking at is recorded.** A recording can include the original tab plus tabs you've added, but only the one in front is captured. Nothing that happens in a tab while it's in the background is added.
- **Adding a tab:** while recording, click the FlowSnap icon in a tab the flow opened (a link that opened in a new tab). That tab is added to the current flow. In any other tab, the icon starts a new flow instead.
  - If the tab was opened by a click in the flow, its placeholder screen is replaced with a real screenshot, and the arrow comes from the click that opened it.
  - If it wasn't (for example, a tab you opened yourself), it's added at the end with a dashed "connection not recorded" arrow.
- **While in the added tab:** the panel appears there with the same screen count and the same "Rec" status as the original tab. Screens are captured exactly as in the original tab, in the order things happen.
- **Switching between tabs:** going back to the original tab doesn't end anything. Recording continues there, and the next arrow comes from your next click in that tab. Switch back to the added tab and recording picks up there again, with no need to click the icon a second time.
- **Leaving an added tab:** an added tab stays in the recording until you finish the flow. Closing it removes it from the recording. Closing the original tab ends the recording, saved as Incomplete.
- **Other tabs:** switching to any tab that hasn't been added captures nothing.
- **Finishing:** Finish & view flow is available in every recorded tab and ends the whole recording, including any added tabs.

## Clean captures

- FlowSnap's own UI (the recording panel and any capture animations) never appears in screenshots. Captures show only the website.
- The panel hides for a split second during each screenshot, so users see at most a tiny "blink" that confirms the capture.
- The capture highlight plays after the screenshot, never during it.
- The mouse cursor isn't included in screenshots. Click dots on the canvas mark where users clicked.
- **No near-duplicates:** a capture that looks the same as the screen before it, apart from tiny details like a blinking cursor, is skipped. Small but real changes, like a tooltip or dropdown, still count.
- **In-progress and final states:** when something keeps changing after you act, like an AI reply streaming in or a page filling in after a loading skeleton, FlowSnap captures the first state (for example, "thinking") and then the final state once it stops changing, skipping the in-between states.
- **Fast clicking:** clicking quickly never loses a screen. Captures wait in line, because Chrome allows only about two screenshots per second.

### Tall pages

- On a page longer than the window, the whole page is captured as one tall screen.
- Sticky headers and footers appear once, in their natural place, not repeated down the screenshot.
- Images and content that load as you scroll are captured loaded, not as blank boxes.
- Click dots land in the right place on tall screens, wherever the page was scrolled to when you clicked.
- FlowSnap's UI never appears in any slice of a tall screen.
- Very long pages are capped at a maximum height (to be decided, for example 10 screens' worth), with the cut marked.
- **Decided: captured as the user scrolls** (formerly Option B). FlowSnap never takes over the page. Each time the user stops scrolling below what's been captured, or has scrolled most of a window further while still scrolling, it captures the window and adds the new part to the bottom of the current screen. The screen stays one step in the flow and grows into a tall screen.
  - Only the user's own scrolling grows a screen (the wheel or trackpad, touch, scrolling keys, or dragging a scrollbar). A page scrolling itself, like a chat moving down to its newest message or a form jumping to an error, doesn't: what changed is captured as a new screen instead, so parts aren't stitched together from different moments.
  - Grows both ways: scrolling down adds to the bottom, and scrolling up above where the screen was first captured (a page that opened partway down, or after jumping to the bottom) adds to the top.
  - Anything else pinned in place (a sticky side column like Zenni's Order Summary, a chat button) is hidden while each added part is captured, so it appears once, where it was in the first capture, not repeated down the screen. Full-width headers and footers are handled as before, and anything covering most of the window is never hidden.
  - Each added part waits briefly (at most 0.8 seconds) for images in view to load and the page to paint, so fast scrolling doesn't capture blank areas.
  - A tall screen holds up to 14 window-heights; reaching that shows a one-time note ("This page is very long, so FlowSnap captured it only this far…").
  - Scrolling faster than FlowSnap can capture (about two parts a second) skips parts of the page. When the user stops scrolling, FlowSnap fills them in itself: it scrolls the page to each skipped part, captures it, and puts the page back where they were, with a note above the panel ("Filling in parts of the page that were skipped…") while it works. A scroll, click or key press stops it at once; anything still missing gets a note saying to scroll back over it, which also fills it in.
  - Works whether the window scrolls or a large inner panel does (as on some app-like sites).
  - A smaller panel that scrolls on its own, like the options beside a product's picture on Zenni's order page, doesn't grow a tall screen. Instead, once it stops scrolling, the screen is captured again as it now looks, so clicks made after scrolling land on what was there.
  - Fixed headers are kept only at the top, and fixed footers only at the bottom, once the bottom of the page is reached.
  - Only what the user scrolled through is captured. Scrolling very fast can skip a part, which shows as a white gap.
  - Tall screens are capped at 14 window-heights (and at what a browser can save, about 32,000 pixels).
  - While the user scrolls, the tall image stays open and each new part is drawn straight onto it. It's saved once they pause, so capturing keeps up with scrolling.
  - When a screen finishes loading after the user has scrolled, only the part showing is redrawn, so the rest of the tall screen is kept.

## Canvas

- **Layout:** screens in one row, top-aligned, in the order they happened, with arrows from each click point to the screen it led to. Tall screens hang down from the row.
- **Notes:** drag a sticky note from the sidebar onto a screenshot and type in it. Notes look like Miro's: a flat yellow square with centred text that shrinks to fit as you write more. While a note is selected, a white pill beside it offers three colours: yellow (the default), green for something good, and pink for something the user doesn't like. Drag a note by the space around its text to move it; its × deletes it. A note stays where it was dropped even if nothing has been written in it yet. Notes are saved with the flow and included in every export (in Figma as a box with editable text).
- **Arrows:** one arrow out of each screen, to the next screen, starting from where the user clicked to get there. If the next screen opened in a new tab, it starts from the click that opened it. Each screen shows only that one dot. Every arrow starts on its screen. Without a recorded click, or if the click isn't on the captured screen, the dot starts halfway down the screen's right edge, just overlapping it. Every arrow's starting dot can be moved: drag it anywhere on its screen (or click the arrow to select it and use the arrow keys), and the arrow redraws to still end at the next screen. Double-click a dot to put it back on the recorded click. Dragging an arrow's line moves its start the same way. Moved dots are saved and used in every export.
- **Added tabs:** screens from an added tab sit in the row where they happened, like any other screen. They aren't labelled with a tab number.
- **One scale for every screen:** screens are shown at one shared scale, not one shared width. The widest window in the flow is 640 px on the canvas, and every other screenshot keeps its true size relative to it (worked out from the window's width, so Retina and standard screens match), never narrower than 240 px. If the window was resized between screenshots, the same nav bar or button looks the same size on every card, and a narrower window shows as a narrower card. Notes, blurs and circles keep their size on every card. Exports use the same scale, each row packed left to right.
- **Opening view:** 70%, so more of the flow fits on screen while the screens stay readable (each 640 px wide at 100%). Scroll sideways along the flow, or zoom out to see all of it: zooming out goes as far as it takes for the flow to fit across the window, or to fit top to bottom when it has a very tall screen, whichever is further.
- **Pages in tabs that weren't recorded:** shown like a written page (a large grey new-tab arrow, the page's title as a headline, its address and "Not recorded…" under it, with a dashed outline), but on an empty, see-through card. Exports draw them the same way.
- **Deleting a screen:** a small trash button at the end of the screen's title row, shown while the screen is hovered (turning soft red on hover), with Undo afterwards. It's off the card, so nothing placed on a screen ever sits under it.
- **Written pages:** resting the pointer in the gap between two screens for a moment (about 0.15 seconds) shows a thin purple line down it where a page would go (as tall as the shorter of the two cards), with a small solid purple + on it, placed clear of the arrow running down that gap (just above it, or below if there's no room above) on the line, partway down (halfway, at most about 300px below the screens' tops). Hovering the + fades the arrow across the gap to 30%; arrows crossing the gap stay clickable and draggable. Passing over a gap does nothing, and while the canvas is scrolling the gaps don't respond at all (they do again 0.3 seconds after it stops). Clicking it opens a page there (it eases in, pushing the screens after it over) to describe a step that wasn't captured, whether it happens elsewhere (checking an email, a text message code) or on the page and simply didn't record. The page is a pale plum card with a dashed outline and a large purple icon (a new-tab arrow when it's added) straight on the card (no label or tile), a headline ("What happens here…") and a line or two under it ("e.g. They check their email and tap the link."). While it's selected, a white pill along its bottom, like a sticky note's colours, offers quick icons (new tab, email, text message, phone call, another app); the one picked replaces the default dots. Its name above the card is "Added step" (renamable), separate from the headline inside. The headline (up to 3 lines and 120 characters) and text (up to 7 lines and 280 characters, with a small count of what's left near the limit) wrap as they grow, and the card grows with them, never cropped or scrolling. Typing that would pass a limit, including extra Returns, isn't kept, so the card never gets taller than about a screenshot. In exports the card is at most about as tall as it is wide, and only text too long for that ends in "…". It's numbered and deletable like any screen, with arrows in and out. Exports draw the same card, the words as editable text in Figma; it isn't counted as a screen in the file name or the screenshots zip.
- **Empty flow:** if every screen is deleted, the canvas shows "This flow is empty" with a short explanation and a Continue Capture button, and the sidebar's tools are greyed out and can't be dragged until there's a screen again.
- **Sidebar:** a thin grey strip down the left of the canvas holding Note, Blur and Circle. Each is shown as the thing itself on a small card (a sticky note, a frosted blur, a hand-drawn circle) so it reads as something to drag onto a screen; dropped, it lands centred where it's let go. All three are only dragged and dropped: clicking them does nothing, and none of them is ever picked as a tool, so clicking a screen never adds anything. A small fixed caption, "Drag these onto a screen!", sits under the tools. The zoom level sits at the foot of the sidebar, as in Figma: clicking "70%" opens a menu with a field to type a level, Zoom in / out / to fit with their shortcuts, and 50%, 100% and 200%. Blur: drop it on a screen, then move and resize it over part of the screen to hide sensitive information; on the canvas it looks frosted, and every export (PNG, PDF, the screenshots zip, Copy for Figma and Copy for Google Slides) pixelates and blurs the image itself, so what's under it can't be read or recovered. Circle: a black, hand-drawn circle to point something out, dropped and then moved and resized around it. Both land at a standard size. Blurs and circles can be moved by dragging, resized from their bottom-right corner, and deleted with their × or the Delete key. With one selected, ⌘D (Ctrl+D on Windows) puts a copy just beside it, and ⌘C then ⌘V copies and pastes it; ⌘V pastes onto the screen the pointer is over, or else the one last clicked (or the screen of whichever blur or circle is selected). On another screen the first paste lands in the same spot and at the same size as the original; each paste after that lands a little further along.
- **Navigation:** scroll to pan. Zoom from the zoom menu at the foot of the sidebar, with the zoom level between them (click it to type a zoom level), or ⌘+ / ⌘− / ⌘0, ⇧1 to fit, and trackpad pinch. Zooming changes only the flow, never the top bar.
- **Screen editing:** rename, drag to reorder, delete. Changes save automatically.
- **Renaming a screen:** click its name above the card (a pencil shows on hover), type, then Enter or click away. Escape cancels; clearing it goes back to the page's title. Placeholders for pages opened in a new tab are renamed the same way. Names are used in exports: the flow image's captions and the screenshots' file names.
- **Deleting a screen:** hovering a screen shows an × in its top-right corner, for removing duplicates. The screen fades out, the screens after it slide over to close the gap, and the screens on either side connect directly, from the click on the earlier one. "Screen deleted · Undo" shows for a few seconds. A default flow name updates its step count; a name the user chose stays.
- **Top bar:** FlowSnap, the flow name (plain title text; hovering shows a grey background, click to rename) and screen count on the left. Continue capture (a plain back link with an arrow), the Download menu (an outlined button) and Copy for Figma (the filled plum main button, as most flows end up in Figma, and the only one that keeps its name in a narrower window) together, on the right.
- **Copy for Figma:** copies the whole flow (also ⌘C on the canvas) as SVG, which Figma turns into layers when pasted: each screen a group named after it, holding its screenshot, the arrows and click dots as vectors, and the numbers and names as text, laid out like the exported image, on a transparent background. Screenshots are copied at full resolution: as PNGs when the flow is small enough, otherwise as high-quality JPEGs so Figma still pastes quickly, and at standard resolution only for very large flows. Tall screens are copied as stacked slices, since Figma shrinks any image over 4096 pixels.
- **Copy for Google Slides (switched off for now):** the button is hidden because the image Slides accepts from the clipboard is too low resolution to read the screens; the code stays, behind `SLIDES_COPY` in the canvas, to bring back once it's sharp enough. When on, it copies the flow as an image for pasting into Google Slides or Docs (or Keynote, PowerPoint, Slack). The flow is laid out in rows shaped like a 16:9 slide (5 screens as 3 + 2, 9 as 3 × 3), with arrows wrapping from the end of one row to the start of the next, so each screen is large on the slide and sharp when zoomed in. Google turns down images over about 25 megapixels, so it stays just under that. Blurred areas are blurred in it too.
- **Continue capture:** goes back to the tab the flow was last recorded in (where its latest screen was captured, even if that's a tab added partway through) (or reopens its last page if that tab is closed) and keeps recording into the same flow, adding screens after the existing ones. A page identical to the last screen isn't captured twice. Stopping the recording returns to the same canvas tab, refreshed with the new screens. If another flow is still being recorded (often in a tab the user has lost track of), that one is saved as it is and stopped first, as the toolbar icon does, so continuing never gets stuck.
- **My flows:** linked from the top bar once that page exists.
- **Default name:** when recording stops, the flow is named after the website and its number of screenshots, like "Airbnb Mapped User Journey (4 Steps)", at most 60 characters. The website's name comes from what the site calls itself (its og:site_name tag) when that's short, otherwise from its address. Once the user renames a flow, FlowSnap never replaces their name.

## Blur tool

Users can hide sensitive information, like names, emails, account numbers or private messages, before exporting.

### How it works

- Pick **Blur** from the canvas toolbar, then drag a box over any part of a screen.
- The blur appears right away on the canvas, exactly as it will look in the export. The canvas preview uses the same blur as the export.
- Blur boxes can be moved, resized and deleted. Each one belongs to its screen, so it moves with that screen when the screen is dragged or reordered.
- A screen can have any number of blur boxes.

### Strength

- The blur is extreme. Only rough colors remain, whatever the text size or box size.
- Text underneath can't be read, recovered or guessed, even by someone who knows roughly what it says.

### In exports

- Blurs are applied to both exports: the full flow image and every individual screenshot.
- Blurs are built into the exported image's pixels, never laid on top as a separate layer.
- The original screenshots stay unblurred in the user's browser, so removing a blur box in the editor brings the content back. Exported files are always blurred and can't be un-blurred.

## Export

The canvas's top bar has one **Download** button. It opens a menu:

- **Save user journey as:** PNG or PDF, for the whole flow.
- **Include all screenshots:** a checkbox, unticked each time the menu opens. The button reads **Download Flow** either way.
- **Defaults:** each time the menu opens, it starts with the screenshots included and the flow in one row.
- **Number of rows:** below the checkbox, a − / + stepper (showing just the number: 1, 2, 3 …) sets how many rows the flow image is laid out in, stepping only through counts the screens divide into, with at least 2 screens in a full row. Rows wrap with an arrow from the end of one row to the start of the next. A small preview shows the shape (the flow in a frame on a dotted canvas, zoomed to fit; at most 7 screens across and 4 rows down, with "⋯" where it carries on), with a caption like "4 screens per row". It's used for both PNG and PDF, including inside the zip. Flows too short to wrap don't show it.

```
Downloads/
  [Flow name].png or .pdf          without screenshots
  [Flow name].zip                  with screenshots, opens as a folder:
    [Flow name]/
      [Flow name].png or .pdf
      Screenshots/
        01 – Homepage.png          in click order, named after each screen
        02 – Search results.png
```

- **File names:** always end in "Mapped User Journey (N Steps)" with the flow's current number of screenshots, whatever the flow is called: "Airbnb Mapped User Journey (4 Steps).png", or "Booking in Paris Mapped User Journey (4 Steps).pdf" after renaming.
- **Numbering:** every card in the flow image is numbered in order, as on the canvas, including added steps and pages in tabs that weren't recorded. Screenshots in the zip keep their number from the flow, so "03 – Checkout.png" is step 03 in the image (numbers may skip where a step has no screenshot). Two digits (01, 02 … 10), so they stay in order when sorted by name. Renaming or reordering screens on the canvas changes the exported names and numbers.
- **Square screens:** exported screens have square corners, so no part of a screenshot is cut off. The rounded corners are only on the canvas.
- **Resolution:** the flow image is drawn at a whole 2× (3× for 3× screenshots), with each screen sized so its screenshot lands pixel for pixel (a 2560-pixel Retina screenshot is 1280 points wide), so it's sharp on Retina screens and when zoomed in. Very long flows drop below 2× only if the image would pass what a browser can save. The PDF holds the same image on one page. PNGs are tagged with their resolution (144 dpi for 2×), as macOS does for its own screenshots, so Preview and Quick Look show them sharp instead of at double size. Very long flows are drawn smaller to stay within what Chrome can save.
- **No extra permission:** every download is a single file, so it needs no permission and Chrome never asks about multiple downloads.
- Blurs are applied to everything exported.

## My flows

- A page listing past recordings with the flow name, date, number of screens and a thumbnail.
- Actions on each flow: Open, Continue recording, Delete.
- Flows that were interrupted (the tab or Chrome closed mid-recording) are marked Incomplete in their saved status. The canvas doesn't show it: what was captured is all there, and Continue capture picks the flow back up.
- Opened from the canvas header or by right-clicking the FlowSnap icon.

## Recording states

| State | What's on the page | Main actions |
| --- | --- | --- |
| Idle | Nothing | Click the icon to start recording · Right-click the icon for My flows |
| Recording | Recording panel (red pulsing dot) | Finish & view flow · Capture extra screen · Cancel/Discard |
| Adding to a flow | Panel shows "Adding to: [flow name]" | Same as Recording |
| Recording an added tab | Panel in the added tab shows "Rec", as in the original tab | Same as Recording |

## Rules

- Clicking the icon always starts a new, separate flow, in the same tab or any other. A recording still going (including one picked back up with Continue capture) is saved first. **Continue capture is the only way to add to an existing flow.**
- The one exception: clicking the icon in a tab the flow itself opened (a link that opened in a new tab) adds that tab to the current flow (see "Adding a tab").
- Finishing ends the recording. The panel disappears, nothing more is captured, and the original tab goes back to normal browsing. Finishing only happens from the panel.
- Continuing a flow is always a deliberate choice, made from **Continue capture** on the canvas or **Continue recording** on the My flows page.
- New screens are added to the end. Earlier edits (names, order, deletions, blurs) are kept.
- If recording resumes on a different page, the first new screen connects with a dashed "connection not recorded" arrow. Users can drag it to the right click point.
- To put a screen in the middle, users add it at the end and drag it into place.
- Closing the tab or Chrome mid-recording auto-saves what was captured. The flow appears in My flows marked Incomplete.
- New tabs aren't followed automatically. If a click opens a new tab, the panel shows a short note that FlowSnap is only recording the original tab, and the flow gets a placeholder screen in that spot: a dashed card saying "Opened in a new tab" with the page's title and address. The click that opened it is marked on the screen before. The panel note also says you can click FlowSnap in the new tab to add it.
- Popup windows are the exception. A popup opened from the flow (like "Sign in with Google") has no toolbar to click FlowSnap in, and it's always part of the flow, so it's recorded automatically. Its first screen replaces the placeholder, and the panel shrinks to fit the popup if needed.
- **Pages FlowSnap can't record:** Chrome blocks extensions on some pages, like Chrome settings and the Chrome Web Store. Clicking the icon there shows a short message instead of failing silently.

## Scope

| Must have | Nice to have | Later (v2+) |
| --- | --- | --- |
| One-click recording in a single tab | Flow stats (screens, clicks, time) | Publish flows to a public gallery |
| Recording panel (draggable, cancel) | Notes on screens | Drag in extra screenshots (emails, other tabs) |
| Automatic capture on meaningful changes | Copy into Figma | Native Figma import |
| Capture extra screen button | Grid layout for very long flows | Compare two competitors side by side |
| Clean captures (no FlowSnap UI) | | Suggested blur areas (e.g., emails) |
| Long pages as one tall screen | | |
| Click points marked on each screen | | |
| One-row canvas with arrows | | |
| Rename, reorder, delete | | |
| Blur tool (applied to all exports) | | |
| Export flow as PNG and PDF + zip of numbered screens | | |
| My flows + continue recording | | |

If time runs short, cut "My flows + continue recording" first.

## Key design decisions

- **One click to record.** Clicking the icon starts recording immediately. The goal is removing busywork, so there's no menu or Record button in the way. Accidental starts are undone with Cancel, and finishing only happens in the panel, so a stray click never ends a flow.
- **A floating panel instead of a toolbar popup.** Chrome's popup closes when you click the page, so it can't stay visible during recording. The panel keeps status and controls in view.
- **No mini flow in the panel.** It previewed the flow taking shape, but something moving on every click was distracting while documenting busy pages. The screen count is enough confirmation.
- **Automatic capture plus a manual button.** Automation handles most screens, and "Capture extra screen" covers what it misses.
- **One row instead of a grid.** It reads left to right like a story, matches how designers lay out flows in Figma, and keeps arrows short and clear.
- **Stay in one tab, with deliberate side trips.** Following users across tabs automatically is confusing, and most flows stay in one tab. When a flow does move into another tab, one click adds it. Only the tab in front is ever captured, so nothing is recorded by surprise.
- **Capture what you cause, ignore what you don't.** Dropdowns, search suggestions and tooltips are part of how a product works, so they become screens. Carousels, ads and animations change on their own, so they never do.
- **Arrows start from the click point.** That's what makes the result read as a flow rather than a pile of screenshots.
- **Finishing is a clear stop.** Recording never quietly continues, which builds trust for an extension that can see websites.
- **Blur before sharing.** Competitor research often includes logged-in screens with personal details. Blurring in the editor, with the same result in every export, makes flows safe to share. It's also the foundation for a public gallery later.
- **Blur that can't be undone.** The blur is extreme and built into the exported pixels, because flows are meant to be shared.
- **Local-only storage.** Screenshots stay in the user's browser. It's free at any number of users, private, and there's nothing to secure or pay for.
- **Ask for access only when it's needed.** No website access is requested at install, so the store listing shows no warning up front. Access is requested at the first recording, with a plain explanation. 

## Distribution

| What | Where | Cost |
| --- | --- | --- |
| Extension | Chrome Web Store, public listing | $5 one time |
| Code | Public GitHub repo with setup steps and an installable build | Free |
| Click-through demo | The canvas as a web page with a sample flow | Free |
| Privacy policy | A page on the demo site | Free |

## Success metrics

- A 10-screen flow goes from first click to exported image in under 2 minutes.
- At least 4 of 5 recorded flows need little or no manual fixing.
- FlowSnap's UI never appears in any captured screenshot.
- Every blurred area appears blurred in both the flow image and every individual screenshot.
- Click dots land within a few pixels of the actual click, including on Retina screens.
- Fast clicking never drops a capture.
- Tall pages export with no repeated headers, no blank sections and no visible seams on 4 of 5 tested sites.
- Peers say they'd use it for their next benchmark.
- Listed on the Chrome Web Store.

## Risks and open questions

- Some content won't capture cleanly, like embedded video or third-party widgets.
- Capturing dropdowns and tooltips may produce more screens than people want in some flows. Watch whether deleting extras on the canvas feels like busywork.
- Telling user-caused changes from automatic ones (carousels, live feeds) will be tuned by testing on real sites. It's the biggest unknown.
- Tall pages: sticky headers, scroll-loaded content, infinite feeds and pages with their own internal scroll areas need testing site by site.
- The panel may cover part of the page being recorded. Dragging helps, and the panel is never captured.
- The panel stays in its corner of what the user can see at its normal size, whether they resize the window, zoom the page with ⌘+, or pinch to zoom in on part of it.
- One-click start means some recordings will start by accident. Cancel needs to be obvious in the first few seconds.
- Right-click to reach My flows is easy to miss. Watch whether people find it.
- Users may forget to blur something. A later version could suggest areas to blur automatically.
- The website-access permission may slow store review and make some users hesitate, even when it's requested on first use. The in-context explanation needs to build trust.
- Before a public gallery (v2): sign-in, cloud storage costs, moderation and an updated privacy policy.

## Vision (v2)

Users can publish a flow to a public, searchable gallery of real product flows, a shared benchmarking library built by the community. Publishing is opt-in, and local-only recording stays the default. Before publishing, FlowSnap prompts users to review and blur sensitive information.

## Challenge deliverables

- **Link:** the GitHub repo and demo page, plus the Chrome Web Store listing (or "submitted, pending review").
- **Video (under 3 min):** why the problem matters to me, key decisions, how I used AI, a demo and the v2 vision.

## Design references

- `designs/recording-panel.png`: wireframe of the recording panel at 1–4 screens captured.
