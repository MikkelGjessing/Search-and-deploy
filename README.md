# Contentful Text Replacer

A lightweight Chrome extension (Manifest V3) that automatically finds and replaces text on Contentful pages.  
It injects a small overlay UI in the top-right corner and re-runs on every DOM change so you never have to click "Replace" manually.

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
- **Persistent settings** stored in `chrome.storage.sync` — survive browser restarts and sync across Chrome profiles.
- **Draggable overlay** — grab the title bar and drag it anywhere on screen.

---

## Files

| File           | Purpose |
|----------------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `content.js`    | All extension logic — overlay UI, replacement engine, MutationObserver, toast |
| `content.css`   | Styles for the overlay and toast |
| `README.md`     | This file |

---

## Installation (load unpacked in Chrome)

1. **Download / clone** this repository to your local machine.

   ```bash
   git clone https://github.com/MikkelGjessing/Search-and-deploy.git
   # The repository is named "Search-and-deploy" and contains the Contentful Text Replacer extension.
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

### Global enable / disable

The **Active** checkbox in the overlay header disables all replacements at once without losing your rules.  Click **Save** to persist the change.

---

## How it works (technical summary)

1. **On load** — settings are loaded from `chrome.storage.sync`.  If globally enabled, after `INITIAL_DELAY` (1500 ms) the extension calls `waitAndRunInitialScan()`, which checks whether editable fields are present and retries up to 5 times (every 800 ms) if not.
2. **MutationObserver** watches `document.body` for any DOM changes.  After 400 ms of silence (debounce) plus an additional 400 ms reaction delay, a fresh scan runs automatically.  Each triggered scan is always a **full-page** scan — there is no partial or incremental scan mode.
3. **Replacement engine** (`runReplacementScan`):
   - **Pass 1 — editable fields** (`replaceInAllEditableElements`): iterates every `textarea`, `input[type="text"]`, `input` (no type), `[contenteditable="true"]`, and `[role="textbox"]` element returned by `querySelectorAll` — no cap, no early exit.
   - **Pass 2 — visible text nodes** (`replaceInVisibleTextNodes`): a `TreeWalker` handles any remaining text nodes outside of editable fields.
4. **React compatibility** — `setNativeValue()` sets input/textarea values via the native prototype setter and dispatches `input` + `change` events so React re-syncs.  All active rules are applied to the local string first; `setNativeValue` is called **once** per element (not once per rule), avoiding unnecessary React re-renders mid-scan.
5. **ProseMirror / Slate compatibility** — `replaceInContentEditable()` uses a `TreeWalker` to update individual `Text` nodes inside the editor element rather than overwriting `innerText`, which would destroy the rich-text DOM structure and trigger editor resets.  A single `input` event is dispatched on the element after all its text nodes are updated.
6. **`applyRulesToText(text, rules, counts)`** — shared helper used by all replacement functions.  Applies every active rule with a global (`g`) regex so every occurrence inside a string is replaced, not just the first.
7. **Anti-loop guard** — the MutationObserver is disconnected during a scan and reconnected immediately after, and a `scanInProgress` flag prevents concurrent scans.

---

## Data model (chrome.storage.sync key: `ctrSettings`)

```json
{
  "enabled": true,
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
| `storage`  | Saves and loads your find/replace rules via `chrome.storage.sync` |

No network access, no tab permissions, no host permissions beyond Contentful URLs.
