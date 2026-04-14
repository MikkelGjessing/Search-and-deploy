# Contentful Text Replacer

A lightweight Chrome extension (Manifest V3) that automatically finds and replaces text on Contentful pages.  
It injects a small overlay UI in the top-right corner and re-runs on every DOM change so you never have to click "Replace" manually.  
When replacements are made it plays a short bundled sound effect and fires a confetti particle burst around the toast notification.

---

## Features

- **3 configurable find / replace rules** — each can be independently enabled or disabled.
- **Auto-run on page load** — waits ~1500 ms after page load (configurable `INITIAL_DELAY` constant) to let Contentful's React SPA finish rendering, then retries until editable fields are present.
- **MutationObserver** with 400 ms debounce + 400 ms reaction delay keeps performance impact minimal while still catching dynamically loaded content.
- **Covers all Contentful editable fields**:
  - `<textarea>`
  - `<input type="text">` / `<input>` (no type)
  - `[contenteditable="true"]`
  - `[role="textbox"]`
- **React-compatible value updates** — uses the native `HTMLInputElement.prototype.value` setter and dispatches `input` + `change` events so React's internal state stays in sync.
- **Toast notification** summarises how many replacements were made and which rules fired (only shown when at least one replacement occurs).
- **Confetti celebration** — colourful particle burst radiates from the toast on every successful scan.
- **Sound effects** — plays a bundled `.wav` file when replacements are made.  Throttled to once per 1500 ms so rapid MutationObserver re-scans don't spam the audio.  Sound settings (enabled toggle, file selection, test button) live on the **extension Options page**.
- **Persistent settings** stored in `chrome.storage.sync` — survive browser restarts and sync across Chrome profiles.
- **Draggable overlay** — grab the title bar and drag it anywhere on screen.

---

## Files

| Path | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `content.js` | All extension logic — overlay UI, replacement engine, MutationObserver, toast, sound, confetti |
| `content.css` | Styles for the overlay, toast, and confetti particles |
| `options.html` | Extension Options page (sound settings) |
| `options.css` | Styles for the Options page |
| `options.js` | Logic for loading, saving, and testing sound settings |
| `assets/sounds/pop.wav` | Short percussive pop sound |
| `assets/sounds/chime.wav` | Bell-like chime sound |
| `assets/sounds/success.wav` | Ascending C–E–G arpeggio |
| `README.md` | This file |

---

## Installation (load unpacked in Chrome)

1. **Download / clone** this repository to your local machine.

   ```bash
   git clone https://github.com/MikkelGjessing/Search-and-deploy.git
   ```

2. Open Chrome and go to **`chrome://extensions`**.

3. Enable **Developer mode** (toggle in the top-right corner of the Extensions page).

4. Click **"Load unpacked"**.

5. Select the folder that contains `manifest.json` (the root of the cloned repository).

6. The extension is now installed.  Navigate to [https://app.contentful.com](https://app.contentful.com) — the overlay will appear in the top-right corner automatically.

---

## Usage

### Setting up rules

1. Open any Contentful page — the **Text Replacer** overlay appears in the top-right corner.
2. Enter a **Find** value and a **Replace** value in one or more of the three rule rows.
3. Make sure the rule's checkbox (right side of the row) is ticked to enable it.
4. Click **Save** to persist the rules across page reloads.

### Running replacements

Replacements run **automatically** ~1–2 seconds after each page load and on every subsequent DOM change.  You can also:

- Click **Run now** to trigger an immediate scan.
- Watch the **status line** below the rules for a summary of the last scan.
- A **toast popup** (top-right, to the left of the overlay) fades in briefly after each scan that made at least one replacement.
- A **confetti burst** animates around the toast each time replacements are made.

### Sound effects

Sound settings are managed on the **extension Options page** — right-click the extension icon and choose **Options**, or open `chrome://extensions` and click the **Details** link next to the extension, then click **Extension options**.

On the Options page you can:

- Toggle sound effects on or off.
- Choose the playback file (`pop.wav`, `chime.wav`, or `success.wav`).
- Click **▶ Test sound** to verify playback immediately.

Sound is throttled: the selected file plays at most once every 1500 ms even if multiple replacement scans fire in quick succession.  The toast and confetti still appear on every successful scan regardless of throttling.

### Global enable / disable

The **Active** checkbox in the overlay header disables all replacements at once without losing your rules.  Click **Save** to persist the change.

---

## How it works (technical summary)

1. **On load** — settings are loaded from `chrome.storage.sync`.  If globally enabled, after `INITIAL_DELAY` (1500 ms) the extension calls `waitAndRunInitialScan()`, which checks whether editable fields are present and retries up to 5 times (every 800 ms) if not.
2. **MutationObserver** watches `document.body` for any DOM changes.  After 400 ms of silence (debounce) plus an additional 400 ms reaction delay, a fresh scan runs automatically.  Each triggered scan is always a **full-page** scan — there is no partial or incremental scan mode.
3. **Replacement engine** (`runReplacementScan` — async):
   - **Pass 1 — editable fields (sequential)**: iterates every `textarea`, `input[type="text"]`, `input` (no type), `[contenteditable="true"]`, and `[role="textbox"]` element one at a time.  A `queueMicrotask` yield between each field gives React time to reconcile the previous update before the next mutation begins, preventing conflicting intermediate states.
   - **Pass 2 — visible text nodes**: a `TreeWalker` handles any remaining text nodes outside of editable fields synchronously after all editable fields are done.
4. **Stable, user-like updates** — three helpers handle field types separately:
   - `safelyUpdateInput(el, newValue)` — focuses the field (if not already focused), dispatches a `beforeinput` event, uses the **native `HTMLInputElement.prototype.value` setter** so React's fiber state updates, dispatches `input` + `change` events with `bubbles: true`, preserves the cursor position via `setSelectionRange`, and blurs only if the field was not previously focused.
   - `safelyUpdateTextarea(el, newValue)` — identical sequence using `HTMLTextAreaElement.prototype.value`.
   - `safelyUpdateContentEditable(el, rules, counts)` — walks inner `Text` nodes individually (never touches `innerHTML` or `innerText`) to preserve the rich-text DOM structure (paragraphs, spans, marks) used by ProseMirror / Slate.  Dispatches a single `input` event on the element after all mutations.
5. **Per-element processing lock** — a `WeakSet` (`processingElements`) prevents re-entrant mutations on the same field if events synchronously trigger another scan callback mid-update.
6. **Idempotency guard** — a `WeakMap` (`lastAppliedValues`) records the last value the extension wrote to each input/textarea.  If a field's current value matches the stored value, the extension skips it without dispatching any events, preventing pointless React re-renders on subsequent scans.
7. **`isInternalUpdate` flag** — set to `true` for the entire duration of `executeScan` (including all async yields).  The MutationObserver callback checks this flag first and returns immediately if set, so extension-originated DOM mutations never schedule a re-scan.  The observer is also disconnected before the async scan starts and reconnected in the `finally` block for defence in depth.
8. **`applyRulesToText(text, rules, counts)`** — shared helper used by all replacement functions.  Applies every active rule with a global (`g`) regex so every occurrence inside a string is replaced, not just the first.
9. **Sound playback** — `tryPlaySuccessSound()` builds the sound URL with `chrome.runtime.getURL('assets/sounds/<file>')`, instantiates an `Audio` object, and calls `.play()`.  Errors (e.g. autoplay restrictions) are silently caught.  A `lastSoundPlayedAt` timestamp guard enforces the 1500 ms throttle.  Sound settings (enabled, file) are configured on the **Options page** and stored in `chrome.storage.sync`.
10. **Confetti** — `spawnCelebrationParticles()` appends `<div class="ctr-particle">` elements to `document.documentElement` with CSS custom properties `--ctr-dx` / `--ctr-dy` that drive the keyframe animation.  Particles remove themselves via `animationend`.

---

## Adding or replacing sound files

1. Drop a new `.wav` (or `.mp3`) file into `assets/sounds/`.
2. Add the filename to the `AVAILABLE_SOUNDS` array near the top of both `content.js` **and** `options.js`.
3. Reload the extension in `chrome://extensions`.

The `web_accessible_resources` entry in `manifest.json` already grants the content script access to all `assets/sounds/*.wav` and `assets/sounds/*.mp3` files.

---

## Data model (chrome.storage.sync key: `ctrSettings`)

```json
{
  "enabled": true,
  "soundEnabled": true,
  "selectedSoundFile": "pop.wav",
  "rules": [
    { "findText": "Old brand", "replaceText": "New brand", "enabled": true },
    { "findText": "Draft",     "replaceText": "Published", "enabled": true },
    { "findText": "",          "replaceText": "",           "enabled": true }
  ]
}
```

---

## Permissions

| Permission | Reason |
|------------|--------|
| `storage`  | Saves and loads your find/replace rules and sound settings via `chrome.storage.sync` |

No network access, no tab permissions, no host permissions beyond Contentful URLs.

