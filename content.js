/**
 * Contentful Text Replacer — content.js
 *
 * Manifest V3 content script that:
 *  1. Injects a draggable overlay UI (top-right corner).
 *  2. Loads saved rules from chrome.storage.sync on start.
 *  3. Waits ~1500 ms after page load, then runs the first replacement scan.
 *  4. Runs find-and-replace on every DOM mutation (debounced).
 *  5. Shows a fading toast after each scan that made replacements.
 *  6. Plays a bundled sound effect and spawns confetti when replacements are made.
 *
 * Only runs on app.contentful.com (and *.contentful.com) pages.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const OVERLAY_ID              = 'ctr-overlay';
const TOAST_ID                = 'ctr-toast';
const DEBOUNCE_MS             = 400;    // MutationObserver debounce delay
const MUTATION_REACTION_MS    = 400;    // extra delay inside debounce before running
const TOAST_VISIBLE_MS        = 3500;   // how long the toast stays visible
const INITIAL_DELAY           = 1500;   // delay before first auto-scan (lets Contentful finish rendering)
const RETRY_DELAY_MS          = 800;    // retry interval when editable fields are not yet present
const MAX_RETRIES             = 5;      // max number of retries on initial scan
const NUM_RULES               = 3;
const SOUND_THROTTLE_MS       = 1500;   // minimum ms between successive sound plays
const PARTICLE_COUNT          = 22;     // number of confetti particles per celebration

// Bundled sound files in assets/sounds/
const AVAILABLE_SOUNDS = ['pop.wav', 'chime.wav', 'success.wav'];

// Confetti particle colours
const PARTICLE_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#f97316', '#ec4899'];

// Selector for all Contentful editable fields
const EDITABLE_SELECTOR = [
  'textarea',
  'input[type="text"]',
  'input:not([type])',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(', ');

// Tags whose text content should never be touched
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

/* ------------------------------------------------------------------ */
/*  State                                                               */
/* ------------------------------------------------------------------ */

/** @type {{ enabled: boolean, soundEnabled: boolean, selectedSoundFile: string, rules: Array<{findText:string, replaceText:string, enabled:boolean}> }} */
let settings = {
  enabled:           true,
  soundEnabled:      true,
  selectedSoundFile: 'pop.wav',
  rules: Array.from({ length: NUM_RULES }, () => ({
    findText:    '',
    replaceText: '',
    enabled:     true,
  })),
};

let mutationObserver  = null;   // MutationObserver instance
let debounceTimer     = null;   // debounce timeout id
let scanInProgress    = false;  // guard against re-entrant scans
let toastTimer        = null;   // timeout id for hiding the toast
let lastSoundPlayedAt = 0;      // timestamp of last sound play (for throttle)

// True while the extension is writing to the DOM — the MutationObserver
// callback skips reactions to changes made by the extension itself.
let isInternalUpdate = false;

// Per-element processing lock: prevents re-entering the update logic for
// an element that is already being written (e.g. if events re-trigger a scan).
const processingElements = new WeakSet();

// Tracks the last value that the extension set on each input/textarea so
// we can skip fields whose content has not changed since the last scan.
const lastAppliedValues = new WeakMap();

/* ------------------------------------------------------------------ */
/*  Helpers — text escaping                                             */
/* ------------------------------------------------------------------ */

/**
 * Escape a string so it can be used safely as a literal pattern
 * inside a RegExp.  User-supplied strings must always go through
 * this function before being compiled into a RegExp.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/*  Helpers — node filtering                                            */
/* ------------------------------------------------------------------ */

/**
 * Return true if the node (or any of its ancestors) belongs to the
 * extension overlay or toast — we never touch those elements.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isInsideExtensionUI(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el) {
    const id = el.id;
    if (id === OVERLAY_ID || id === TOAST_ID) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Return true if the element tag should be skipped entirely.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function shouldSkipElement(el) {
  return SKIP_TAGS.has(el.tagName);
}

/* ------------------------------------------------------------------ */
/*  Core replacement engine                                             */
/* ------------------------------------------------------------------ */

/**
 * Build an array of active replacement rules from the current settings,
 * filtering out disabled rules and rules with empty find values.
 *
 * @returns {Array<{index:number, findText:string, replaceText:string, regex:RegExp}>}
 */
function getActiveRules() {
  if (!settings.enabled) return [];
  return settings.rules
    .map((rule, index) => ({ ...rule, index }))
    .filter(rule => rule.enabled && rule.findText.trim() !== '')
    .map(rule => ({
      index:       rule.index,
      findText:    rule.findText,
      replaceText: rule.replaceText,
      // 'g' flag replaces ALL occurrences; escaping prevents regex injection
      regex: new RegExp(escapeRegExp(rule.findText), 'g'),
    }));
}

/**
 * Apply every active rule to `text`, replacing ALL occurrences of each
 * find string.  Updates `counts[rule.index]` for each replacement made.
 * Returns the fully-replaced string.
 *
 * @param {string} text
 * @param {Array}  rules   — active rules array from getActiveRules()
 * @param {number[]} counts — per-rule replacement counter (mutated in place)
 * @returns {string}
 */
function applyRulesToText(text, rules, counts) {
  for (const rule of rules) {
    text = text.replace(rule.regex, () => {
      counts[rule.index]++;
      return rule.replaceText;
    });
    // Reset lastIndex so the stateful 'g' regex is safe to reuse
    rule.regex.lastIndex = 0;
  }
  return text;
}

/**
 * Capture selectionStart/selectionEnd, run `callback`, then restore the
 * cursor position.  Safe to call on elements that do not support selection
 * (errors are silently ignored).
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} el
 * @param {Function} callback
 */
function preserveSelection(el, callback) {
  let start = null;
  let end   = null;
  try { start = el.selectionStart; end = el.selectionEnd; } catch (_) { /* not selectable */ }
  callback();
  if (start !== null) {
    try { el.setSelectionRange(start, end); } catch (_) { /* ignore */ }
  }
}

/**
 * Update an <input type="text"> (or no-type input) in a way that React's
 * synthetic event system recognises as user input:
 *   focus → beforeinput → native value setter → input → change → blur
 *
 * A per-element processing lock prevents re-entrant calls on the same
 * element, and lastAppliedValues tracks the last value we wrote so
 * idempotent scans never re-trigger a React re-render.
 *
 * @param {HTMLInputElement} el
 * @param {string} newValue
 */
function safelyUpdateInput(el, newValue) {
  if (processingElements.has(el)) return;
  processingElements.add(el);
  try {
    const wasFocused = document.activeElement === el;
    if (!wasFocused) el.focus({ preventScroll: true });

    // Signal intent before mutation so editors that intercept beforeinput work correctly
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: newValue,
    }));

    // Use the native prototype setter so React's internal fiber state is updated
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    preserveSelection(el, () => setter.call(el, newValue));

    // Dispatch the events React's onChange handler listens to
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: false }));
    el.dispatchEvent(new Event(     'change', { bubbles: true }));

    lastAppliedValues.set(el, newValue);
    if (!wasFocused) el.blur();
  } finally {
    processingElements.delete(el);
  }
}

/**
 * Update a <textarea> using the same user-like event sequence as
 * safelyUpdateInput, but using HTMLTextAreaElement.prototype.value.
 *
 * @param {HTMLTextAreaElement} el
 * @param {string} newValue
 */
function safelyUpdateTextarea(el, newValue) {
  if (processingElements.has(el)) return;
  processingElements.add(el);
  try {
    const wasFocused = document.activeElement === el;
    if (!wasFocused) el.focus({ preventScroll: true });

    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: newValue,
    }));

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    preserveSelection(el, () => setter.call(el, newValue));

    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: false }));
    el.dispatchEvent(new Event(     'change', { bubbles: true }));

    lastAppliedValues.set(el, newValue);
    if (!wasFocused) el.blur();
  } finally {
    processingElements.delete(el);
  }
}

/**
 * Update text inside a contenteditable / [role="textbox"] element by
 * walking every Text node and applying rules individually, thereby
 * preserving the rich-text DOM structure (paragraphs, spans, marks) that
 * ProseMirror / Slate editors rely on.  A single bubbling "input" event is
 * dispatched after all mutations so the host framework can re-sync.
 *
 * A per-element processing lock prevents concurrent mutations on the same
 * editor node.
 *
 * @param {Element}  el
 * @param {Array}    rules   — active rules from getActiveRules()
 * @param {number[]} counts  — per-rule counter (mutated in place)
 */
function safelyUpdateContentEditable(el, rules, counts) {
  if (processingElements.has(el)) return;
  processingElements.add(el);
  try {
    // Collect all text nodes first so the walker is not invalidated by
    // in-place nodeValue mutations.
    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node);
      node = walker.nextNode();
    }

    let anyChanged = false;
    for (const textNode of textNodes) {
      const original = textNode.nodeValue;
      const updated  = applyRulesToText(original, rules, counts);
      if (updated !== original) {
        textNode.nodeValue = updated;
        anyChanged = true;
      }
    }

    // Notify the framework of the change without firing beforeinput here,
    // since the DOM mutation has already occurred and ProseMirror / Slate
    // will reconcile from the input event.
    if (anyChanged) {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false }));
    }
  } finally {
    processingElements.delete(el);
  }
}

/**
 * Route an editable element to the correct update function based on its
 * type.  For input/textarea, applies all rules at once to the full value
 * string and delegates to safelyUpdateInput / safelyUpdateTextarea.
 * For contenteditable / role="textbox", delegates to
 * safelyUpdateContentEditable which walks inner text nodes.
 *
 * An idempotency check (lastAppliedValues) skips input/textarea fields
 * whose value has not changed since the extension last wrote to them.
 *
 * @param {Element}  el
 * @param {Array}    rules
 * @param {number[]} counts
 */
function replaceInEditableElement(el, rules, counts) {
  const tag  = el.tagName;
  const type = (el.getAttribute('type') || '').toLowerCase();

  if (tag === 'TEXTAREA') {
    const original = el.value;
    // Skip if the extension already set this exact value (prevents pointless re-renders)
    if (lastAppliedValues.has(el) && lastAppliedValues.get(el) === original) return;
    const updated = applyRulesToText(original, rules, counts);
    if (updated !== original) safelyUpdateTextarea(el, updated);
    return;
  }

  if (tag === 'INPUT' && (type === 'text' || type === '')) {
    const original = el.value;
    if (lastAppliedValues.has(el) && lastAppliedValues.get(el) === original) return;
    const updated = applyRulesToText(original, rules, counts);
    if (updated !== original) safelyUpdateInput(el, updated);
    return;
  }

  if (
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('role') === 'textbox'
  ) {
    safelyUpdateContentEditable(el, rules, counts);
  }
}

/**
 * Walk all text nodes in `root` that are NOT inside an editable field
 * (those are handled by the sequential editable-field loop in
 * runReplacementScan) and apply the active rules to each.
 *
 * @param {Element} root
 * @param {Array}   rules
 * @param {number[]} counts
 */
function replaceInVisibleTextNodes(root, rules, counts) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (isInsideExtensionUI(node)) return NodeFilter.FILTER_REJECT;

        if (node.nodeType === Node.ELEMENT_NODE) {
          if (shouldSkipElement(node)) return NodeFilter.FILTER_REJECT;
          // Skip editable subtrees — already handled by the editable-field loop
          if (
            node.tagName === 'TEXTAREA' ||
            node.tagName === 'INPUT' ||
            node.getAttribute('contenteditable') === 'true' ||
            node.getAttribute('role') === 'textbox'
          ) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }

        // Text node — accept
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  // Collect before iterating so in-place mutations don't confuse the walker
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const original = textNode.nodeValue;
    const updated  = applyRulesToText(original, rules, counts);
    if (updated !== original) {
      textNode.nodeValue = updated;
    }
  }
}

/**
 * Run a full scan of the page and return a structured result.
 *
 * Pass 1 — editable fields processed ONE AT A TIME with a queueMicrotask
 * yield between each field.  Processing one field at a time means React
 * can reconcile each individual update before the next mutation begins,
 * avoiding conflicting intermediate states and preventing one field's
 * change from destabilising another.
 *
 * Pass 2 — all remaining visible text nodes outside editable fields,
 * updated synchronously after all editable fields are done.
 *
 * @returns {Promise<{ totalReplacements: number, rules: Array }>}
 */
async function runReplacementScan() {
  const rules  = getActiveRules();
  const counts = Array.from({ length: NUM_RULES }, () => 0);

  if (rules.length === 0) {
    return { totalReplacements: 0, rules: buildResultRules(counts) };
  }

  if (isInsideExtensionUI(document.body) || shouldSkipElement(document.body)) {
    return { totalReplacements: 0, rules: buildResultRules(counts) };
  }

  // Pass 1: process every editable field sequentially.  The microtask yield
  // between fields keeps updates deterministic without introducing noticeable
  // delay to the user.
  const fields = Array.from(document.querySelectorAll(EDITABLE_SELECTOR));
  for (const field of fields) {
    if (isInsideExtensionUI(field)) continue;
    replaceInEditableElement(field, rules, counts);
    // Yield to the microtask queue so the event loop can process React
    // state updates triggered by the previous field before we touch the next.
    await new Promise(resolve => queueMicrotask(resolve));
  }

  // Pass 2: remaining visible text nodes (skips editable subtrees)
  replaceInVisibleTextNodes(document.body, rules, counts);

  const totalReplacements = counts.reduce((sum, n) => sum + n, 0);
  return { totalReplacements, rules: buildResultRules(counts) };
}

/**
 * Build the per-rule result array for the scan result object.
 *
 * @param {number[]} counts
 * @returns {Array<{index:number, findText:string, replaceText:string, replacements:number}>}
 */
function buildResultRules(counts) {
  return settings.rules.map((rule, index) => ({
    index,
    findText:     rule.findText,
    replaceText:  rule.replaceText,
    replacements: counts[index] || 0,
  }));
}

/* ------------------------------------------------------------------ */
/*  Sound helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the chrome-extension:// URL for the currently selected sound file.
 *
 * @returns {string}
 */
function getSelectedSoundUrl() {
  return chrome.runtime.getURL(`assets/sounds/${settings.selectedSoundFile}`);
}

/**
 * Play the selected bundled sound if sound is enabled and the throttle
 * window has elapsed.  Errors from autoplay restrictions are silently
 * swallowed so they never break replacements or animations.
 */
function tryPlaySuccessSound() {
  if (!settings.soundEnabled) return;
  const now = Date.now();
  if (now - lastSoundPlayedAt < SOUND_THROTTLE_MS) return;
  lastSoundPlayedAt = now;

  const audio = new Audio(getSelectedSoundUrl());
  audio.volume = 0.7;
  audio.play().catch(() => { /* autoplay blocked — ignore */ });
}

/**
 * Unlock future autoplay by playing the current sound at near-zero volume
 * in direct response to a user gesture (the "Unlock audio" button click).
 */
function unlockAudio() {
  const audio = new Audio(getSelectedSoundUrl());
  audio.volume = 0.01;
  audio.play().then(() => {
    audio.pause();
  }).catch(() => { /* still blocked — nothing to do */ });
}

/* ------------------------------------------------------------------ */
/*  Celebration particles                                               */
/* ------------------------------------------------------------------ */

/**
 * Spawn PARTICLE_COUNT confetti particles that burst outward from the
 * centre of the toast element, then remove themselves when the CSS
 * animation ends.
 */
function spawnCelebrationParticles() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;

  const rect    = toast.getBoundingClientRect();
  const centerX = rect.left + rect.width  / 2;
  const centerY = rect.top  + rect.height / 2;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const particle = document.createElement('div');
    particle.className = 'ctr-particle';

    const angle    = (i / PARTICLE_COUNT) * 360;
    const distance = 45 + Math.random() * 65;
    const dx       = Math.cos((angle * Math.PI) / 180) * distance;
    const dy       = Math.sin((angle * Math.PI) / 180) * distance;
    const size     = 5 + Math.random() * 6;
    const color    = PARTICLE_COLORS[i % PARTICLE_COLORS.length];

    particle.style.cssText =
      `left:${centerX}px;top:${centerY}px;` +
      `width:${size}px;height:${size}px;` +
      `background:${color};` +
      `--ctr-dx:${dx}px;--ctr-dy:${dy}px;`;

    document.documentElement.appendChild(particle);
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Toast notification                                                  */
/* ------------------------------------------------------------------ */

/**
 * Show (or reuse) the toast element with the latest scan result.
 * Only shows when at least one replacement was made.
 *
 * @param {{ totalReplacements: number, rules: Array }} result
 */
function showScanSummaryToast(result) {
  if (result.totalReplacements === 0) return;

  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    document.documentElement.appendChild(toast);
  }

  // Clear any pending hide timer (prevents stacking)
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  const activeRuleLines = result.rules
    .filter(r => r.findText && r.replacements > 0)
    .map(
      r =>
        `<div class="ctr-toast-rule">` +
        `Rule ${r.index + 1}: '${escapeHtml(r.findText)}' → '${escapeHtml(r.replaceText)}' (${r.replacements})` +
        `</div>`,
    )
    .join('');

  toast.innerHTML =
    `<div class="ctr-toast-total">${result.totalReplacements} replacement${result.totalReplacements !== 1 ? 's' : ''} made</div>` +
    activeRuleLines;

  // Fade in (force reflow so transition fires even if already visible)
  toast.classList.remove('ctr-toast-visible');
  // eslint-disable-next-line no-void
  void toast.offsetWidth;
  toast.classList.add('ctr-toast-visible');

  // Fade out after TOAST_VISIBLE_MS
  toastTimer = setTimeout(() => {
    toast.classList.remove('ctr-toast-visible');
    toastTimer = null;
  }, TOAST_VISIBLE_MS);
}

/**
 * Minimal HTML-escape to prevent XSS in toast content.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/*  Status text helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Update the persistent status line inside the overlay.
 *
 * @param {{ totalReplacements: number, rules: Array }} result
 */
function updateStatus(result) {
  const statusEl = document.getElementById('ctr-status');
  if (!statusEl) return;

  if (result.totalReplacements === 0) {
    statusEl.textContent = 'Last scan: no matches found';
    return;
  }

  const parts = result.rules
    .filter(r => r.findText && r.replacements > 0)
    .map(r => `R${r.index + 1}: ${r.replacements}`);

  statusEl.textContent = `Last scan: ${result.totalReplacements} replacement${result.totalReplacements !== 1 ? 's' : ''} (${parts.join(', ')})`;
}

/* ------------------------------------------------------------------ */
/*  Scan orchestration                                                  */
/* ------------------------------------------------------------------ */

/**
 * Execute a scan, update the UI, and show the toast.
 * A guard prevents re-entrant / concurrent scans.
 *
 * isInternalUpdate is raised for the entire duration of the async scan so
 * that any MutationObserver callbacks that fire between microtask yields
 * are recognised as extension-originated and suppressed.  The observer is
 * also disconnected before the scan and reconnected afterwards as an
 * additional safety net.
 */
async function executeScan() {
  if (scanInProgress) return;
  scanInProgress    = true;
  isInternalUpdate  = true;

  // Disconnect observer before touching the DOM.  It is reconnected in the
  // finally block after the full async scan (including all awaits) completes.
  if (mutationObserver) mutationObserver.disconnect();

  try {
    const result = await runReplacementScan();
    updateStatus(result);
    showScanSummaryToast(result);

    if (result.totalReplacements > 0) {
      // Wait one animation frame so the toast is laid out before we read its rect
      requestAnimationFrame(() => spawnCelebrationParticles());
      tryPlaySuccessSound();
    }
  } finally {
    scanInProgress   = false;
    isInternalUpdate = false;
    // Reconnect after the full async scan is done
    if (mutationObserver) {
      mutationObserver.observe(document.body, OBSERVER_CONFIG);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  MutationObserver                                                    */
/* ------------------------------------------------------------------ */

const OBSERVER_CONFIG = {
  childList:     true,
  subtree:       true,
  characterData: true,
};

/**
 * Start watching document.body for DOM mutations.
 * Each mutation batch is debounced, then an additional small delay is
 * applied before running so React has time to finish rendering.
 */
function startObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
  }

  mutationObserver = new MutationObserver((mutations) => {
    // Ignore mutations that the extension itself caused (field value writes,
    // toast/overlay updates, etc.)
    if (isInternalUpdate) return;

    // Skip if the only mutations were caused by the extension UI itself
    const nonUIChange = mutations.some(m => !isInsideExtensionUI(m.target));
    if (!nonUIChange) return;

    // Don't schedule a re-scan while one is already in progress
    if (scanInProgress) return;

    // Debounce: cancel the previous timer and restart
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Extra delay to let React finish rendering before we read field values
      setTimeout(executeScan, MUTATION_REACTION_MS);
    }, DEBOUNCE_MS);
  });

  mutationObserver.observe(document.body, OBSERVER_CONFIG);
}

/* ------------------------------------------------------------------ */
/*  Overlay UI                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build and inject the overlay element if it does not already exist.
 * The overlay is appended to <html> (document.documentElement) rather
 * than <body> so that even aggressive Contentful re-renders that swap
 * out <body> children cannot remove it.
 */
function ensureOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;

  overlay.innerHTML = buildOverlayHTML();
  document.documentElement.appendChild(overlay);

  // Populate inputs from current settings
  syncOverlayFromSettings();

  // Wire up event listeners
  attachOverlayListeners(overlay);

  // Make the overlay draggable
  makeDraggable(overlay, document.getElementById('ctr-overlay-header'));
}

/**
 * Build the overlay inner HTML string.
 *
 * @returns {string}
 */
function buildOverlayHTML() {
  let rulesHTML = '';
  for (let i = 0; i < NUM_RULES; i++) {
    rulesHTML += `
      <div class="ctr-rule-row" data-rule="${i}">
        <div class="ctr-rule-label">Rule ${i + 1}</div>
        <input class="ctr-input ctr-find"    type="text" placeholder="Find…"    data-rule="${i}" />
        <input class="ctr-input ctr-replace" type="text" placeholder="Replace…" data-rule="${i}" />
        <input class="ctr-rule-enabled"      type="checkbox" data-rule="${i}" title="Enable rule ${i + 1}" />
      </div>`;
  }

  const soundOptions = AVAILABLE_SOUNDS
    .map(f => `<option value="${f}">${f}</option>`)
    .join('');

  return `
    <div id="ctr-overlay-header">
      <span id="ctr-overlay-title">Text Replacer</span>
      <label id="ctr-global-toggle-label" title="Enable/disable all replacements">
        <input type="checkbox" id="ctr-global-toggle" />
        Active
      </label>
    </div>
    <div id="ctr-sound-section">
      <div id="ctr-sound-row">
        <label id="ctr-sound-toggle-label" title="Play a sound when replacements are made">
          <input type="checkbox" id="ctr-sound-toggle" />
          Sound effects
        </label>
        <select id="ctr-sound-select" title="Choose sound file">${soundOptions}</select>
      </div>
      <button class="ctr-btn" id="ctr-unlock-audio-btn" title="Click to allow sound playback">🔊 Unlock audio</button>
    </div>
    <div id="ctr-rules">${rulesHTML}</div>
    <div id="ctr-status">Not yet run</div>
    <div id="ctr-footer">
      <button class="ctr-btn" id="ctr-save-btn">Save</button>
      <button class="ctr-btn" id="ctr-run-btn">Run now</button>
    </div>`;
}

/**
 * Copy the current settings values into the overlay inputs.
 */
function syncOverlayFromSettings() {
  const globalToggle = document.getElementById('ctr-global-toggle');
  if (globalToggle) globalToggle.checked = settings.enabled;

  const soundToggle = document.getElementById('ctr-sound-toggle');
  if (soundToggle) soundToggle.checked = settings.soundEnabled;

  const soundSelect = document.getElementById('ctr-sound-select');
  if (soundSelect) soundSelect.value = settings.selectedSoundFile;

  for (let i = 0; i < NUM_RULES; i++) {
    const rule     = settings.rules[i];
    const findEl   = document.querySelector(`.ctr-find[data-rule="${i}"]`);
    const replEl   = document.querySelector(`.ctr-replace[data-rule="${i}"]`);
    const checkEl  = document.querySelector(`.ctr-rule-enabled[data-rule="${i}"]`);
    if (findEl)  findEl.value    = rule.findText;
    if (replEl)  replEl.value    = rule.replaceText;
    if (checkEl) checkEl.checked = rule.enabled;
  }
}

/**
 * Read the overlay input values back into the settings object.
 */
function syncSettingsFromOverlay() {
  const globalToggle = document.getElementById('ctr-global-toggle');
  if (globalToggle) settings.enabled = globalToggle.checked;

  const soundToggle = document.getElementById('ctr-sound-toggle');
  if (soundToggle) settings.soundEnabled = soundToggle.checked;

  const soundSelect = document.getElementById('ctr-sound-select');
  if (soundSelect && AVAILABLE_SOUNDS.includes(soundSelect.value)) {
    settings.selectedSoundFile = soundSelect.value;
  }

  for (let i = 0; i < NUM_RULES; i++) {
    const findEl  = document.querySelector(`.ctr-find[data-rule="${i}"]`);
    const replEl  = document.querySelector(`.ctr-replace[data-rule="${i}"]`);
    const checkEl = document.querySelector(`.ctr-rule-enabled[data-rule="${i}"]`);
    settings.rules[i].findText    = findEl  ? findEl.value    : '';
    settings.rules[i].replaceText = replEl  ? replEl.value    : '';
    settings.rules[i].enabled     = checkEl ? checkEl.checked : true;
  }
}

/**
 * Wire up the Save and Run buttons inside the overlay.
 *
 * @param {HTMLElement} overlay
 */
function attachOverlayListeners(overlay) {
  const saveBtn        = overlay.querySelector('#ctr-save-btn');
  const runBtn         = overlay.querySelector('#ctr-run-btn');
  const unlockAudioBtn = overlay.querySelector('#ctr-unlock-audio-btn');

  saveBtn.addEventListener('click', () => {
    syncSettingsFromOverlay();
    saveSettings();
  });

  runBtn.addEventListener('click', () => {
    syncSettingsFromOverlay();
    executeScan();
  });

  unlockAudioBtn.addEventListener('click', () => {
    syncSettingsFromOverlay();
    unlockAudio();
  });
}

/* ------------------------------------------------------------------ */
/*  Draggable overlay                                                   */
/* ------------------------------------------------------------------ */

/**
 * Make `panelEl` draggable by holding `handleEl`.
 *
 * @param {HTMLElement} panelEl
 * @param {HTMLElement} handleEl
 */
function makeDraggable(panelEl, handleEl) {
  if (!handleEl) return;

  let startX = 0;
  let startY = 0;
  let origRight  = 16;
  let origTop    = 16;

  handleEl.addEventListener('mousedown', (e) => {
    // Ignore clicks on the toggle checkbox
    if (e.target.tagName === 'INPUT') return;

    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;

    const rect = panelEl.getBoundingClientRect();
    origRight = window.innerWidth - rect.right;
    origTop   = rect.top;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  });

  function onMouseMove(e) {
    const dx       = e.clientX - startX;
    const dy       = e.clientY - startY;
    const newRight = Math.max(0, origRight - dx);
    const newTop   = Math.max(0, origTop   + dy);

    panelEl.style.right = `${newRight}px`;
    panelEl.style.top   = `${newTop}px`;
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
  }
}

/* ------------------------------------------------------------------ */
/*  Persistence — chrome.storage.sync                                  */
/* ------------------------------------------------------------------ */

/**
 * Load settings from chrome.storage.sync.
 * Merges stored values over the defaults so missing keys stay valid.
 *
 * @returns {Promise<void>}
 */
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('ctrSettings', (data) => {
      if (data.ctrSettings) {
        const stored = data.ctrSettings;
        // Merge top-level keys
        if (typeof stored.enabled === 'boolean') {
          settings.enabled = stored.enabled;
        }
        if (typeof stored.soundEnabled === 'boolean') {
          settings.soundEnabled = stored.soundEnabled;
        }
        if (typeof stored.selectedSoundFile === 'string' &&
            AVAILABLE_SOUNDS.includes(stored.selectedSoundFile)) {
          settings.selectedSoundFile = stored.selectedSoundFile;
        }
        if (Array.isArray(stored.rules)) {
          stored.rules.forEach((r, i) => {
            if (i < NUM_RULES) {
              if (typeof r.findText    === 'string')  settings.rules[i].findText    = r.findText;
              if (typeof r.replaceText === 'string')  settings.rules[i].replaceText = r.replaceText;
              if (typeof r.enabled     === 'boolean') settings.rules[i].enabled     = r.enabled;
            }
          });
        }
      }
      resolve();
    });
  });
}

/**
 * Persist current settings to chrome.storage.sync.
 */
function saveSettings() {
  chrome.storage.sync.set({ ctrSettings: settings });
}

/* ------------------------------------------------------------------ */
/*  Boot sequence                                                       */
/* ------------------------------------------------------------------ */

/**
 * Wait until at least one editable field is present in the DOM, then
 * execute the first replacement scan.  Retries up to MAX_RETRIES times
 * with RETRY_DELAY_MS between attempts if no fields are found yet.
 *
 * @param {number} [retriesLeft]
 */
function waitAndRunInitialScan(retriesLeft = MAX_RETRIES) {
  const fields = document.querySelectorAll(EDITABLE_SELECTOR);
  if (fields.length > 0) {
    executeScan();
    return;
  }
  if (retriesLeft <= 0) {
    // No editable fields found after all retries — run anyway (text nodes may still apply)
    executeScan();
    return;
  }
  setTimeout(() => waitAndRunInitialScan(retriesLeft - 1), RETRY_DELAY_MS);
}

/**
 * Main entry point — called once when the content script loads.
 */
async function init() {
  // 1. Load persisted settings
  await loadSettings();

  // 2. Inject the overlay UI
  ensureOverlay();

  // 3. Re-inject the overlay if Contentful ever removes it from the DOM.
  //    We watch document.documentElement (one level above body) for this.
  const rootObserver = new MutationObserver(() => {
    ensureOverlay();
  });
  rootObserver.observe(document.documentElement, { childList: true });

  // 4. Start the MutationObserver on body
  startObserver();

  // 5. After INITIAL_DELAY, wait for editable fields to appear then scan.
  //    The delay is required because Contentful is a React SPA and fields
  //    are not rendered synchronously on page load.
  if (settings.enabled) {
    setTimeout(() => waitAndRunInitialScan(), INITIAL_DELAY);
  }
}

// Kick everything off
init();
