# Contentful Text Replacer

A lightweight Chrome extension (Manifest V3) that automatically finds and replaces text on Contentful pages.  
It injects a small overlay UI in the top-right corner and re-runs on every DOM change so you never have to click "Replace" manually.

---

## Features

- **3 configurable find / replace rules** — each can be independently enabled or disabled.
- **Auto-run on page load** and on every DOM mutation (Contentful is a SPA — new content appears without a full page reload).
- **MutationObserver** with 400 ms debounce keeps performance impact minimal.
- **Toast notification** summarises how many replacements were made and which rules fired.
- **Persistent settings** stored in `chrome.storage.sync` — survive browser restarts and sync across Chrome profiles.
- **Draggable overlay** — grab the title bar and drag it anywhere on screen.
- Works with React-controlled `<input>` / `<textarea>` elements by dispatching native `input` and `change` events.

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

Replacements run **automatically** every time the page changes.  You can also:

- Click **Run now** to trigger an immediate scan.
- Watch the **status line** below the rules for a summary of the last scan.
- A **toast popup** (top-right, to the left of the overlay) fades in briefly after each scan that made at least one replacement.

### Global enable / disable

The **Active** checkbox in the overlay header disables all replacements at once without losing your rules.  Click **Save** to persist the change.

---

## How it works (technical summary)

1. **On load** — settings are loaded from `chrome.storage.sync`.  If globally enabled, an initial scan runs 600 ms after page load to let Contentful finish rendering.
2. **MutationObserver** watches `document.body` for any DOM changes.  After 400 ms of silence, a fresh scan runs automatically.
3. **Replacement engine** walks the DOM with a `TreeWalker`, skipping `<script>`, `<style>`, `<noscript>` tags and the extension's own UI elements.  It replaces text in:
   - visible text nodes
   - `<textarea>` values
   - `<input type="text">` values
   - contenteditable regions (via text nodes)
4. **React compatibility** — input values are updated via the native `HTMLInputElement.prototype.value` setter and synthetic `input` / `change` events are dispatched so React re-syncs its internal state.
5. **Anti-loop guard** — the observer is disconnected during a scan and reconnected immediately after, preventing the extension's own DOM writes from triggering a new scan.

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
