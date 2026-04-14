/**
 * Contentful Text Replacer — options.js
 *
 * Manages sound settings on the extension Options page.
 * Reads from and writes to chrome.storage.sync (key: ctrSettings)
 * alongside the rules managed by content.js.
 */

// NOTE: These constants are intentionally duplicated from content.js.
// Content scripts and Options pages run in separate browser contexts,
// so a shared module is not possible without a bundler. Keep these in sync
// if you add or remove sound files.
const AVAILABLE_SOUNDS = ['pop.wav', 'chime.wav', 'success.wav'];

// Storage key shared with content.js — must match exactly.
const STORAGE_KEY = 'ctrSettings';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Show a transient status message below the controls.
 *
 * @param {string} message
 * @param {number} [durationMs]
 */
function showStatus(message, durationMs = 1800) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = message;
  setTimeout(() => { el.textContent = ''; }, durationMs);
}

/* ------------------------------------------------------------------ */
/*  Options page functions                                              */
/* ------------------------------------------------------------------ */

/**
 * Populate the sound-file <select> with entries from AVAILABLE_SOUNDS.
 */
function populateSoundSelector() {
  const select = document.getElementById('sound-select');
  if (!select) return;
  AVAILABLE_SOUNDS.forEach((filename) => {
    const option = document.createElement('option');
    option.value = filename;
    option.textContent = filename;
    select.appendChild(option);
  });
}

/**
 * Load current settings from chrome.storage.sync and populate the form.
 */
function loadOptions() {
  chrome.storage.sync.get(STORAGE_KEY, (data) => {
    const stored = (data && data[STORAGE_KEY]) || {};

    const soundEnabled = typeof stored.soundEnabled === 'boolean'
      ? stored.soundEnabled
      : true; // default: enabled

    const selectedSoundFile =
      (typeof stored.selectedSoundFile === 'string' &&
       AVAILABLE_SOUNDS.includes(stored.selectedSoundFile))
        ? stored.selectedSoundFile
        : 'pop.wav';

    const enabledEl = document.getElementById('sound-enabled');
    if (enabledEl) enabledEl.checked = soundEnabled;

    const selectEl = document.getElementById('sound-select');
    if (selectEl) selectEl.value = selectedSoundFile;
  });
}

/**
 * Persist the current form state to chrome.storage.sync.
 * Merges only the sound keys so that the rules set by content.js are preserved.
 */
function saveOptions() {
  chrome.storage.sync.get(STORAGE_KEY, (data) => {
    const current = (data && data[STORAGE_KEY]) || {};

    const enabledEl = document.getElementById('sound-enabled');
    const selectEl  = document.getElementById('sound-select');

    current.soundEnabled = enabledEl ? enabledEl.checked : true;
    if (selectEl && AVAILABLE_SOUNDS.includes(selectEl.value)) {
      current.selectedSoundFile = selectEl.value;
    }

    chrome.storage.sync.set({ [STORAGE_KEY]: current }, () => {
      showStatus('Settings saved.');
    });
  });
}

/**
 * Immediately attempt to play the currently selected sound file.
 * Errors are caught silently; a small inline message is shown if playback fails.
 */
function testSelectedSound() {
  const selectEl = document.getElementById('sound-select');
  const filename = (selectEl && AVAILABLE_SOUNDS.includes(selectEl.value))
    ? selectEl.value
    : 'pop.wav';

  const url = chrome.runtime.getURL(`assets/sounds/${filename}`);
  const audio = new Audio(url);
  audio.volume = 0.7;
  audio.play().catch(() => {
    showStatus('Playback blocked by the browser. Try clicking the button after interacting with the page.', 3000);
  });
}

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  populateSoundSelector();
  loadOptions();

  const enabledEl      = document.getElementById('sound-enabled');
  const selectEl       = document.getElementById('sound-select');
  const testSoundBtn   = document.getElementById('test-sound-btn');

  if (enabledEl)    enabledEl.addEventListener('change', saveOptions);
  if (selectEl)     selectEl.addEventListener('change', saveOptions);
  if (testSoundBtn) testSoundBtn.addEventListener('click', testSelectedSound);
});
