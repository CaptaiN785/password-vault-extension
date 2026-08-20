import * as M from '../messages.js';
import * as BIO from '../biometric.js';
import { toB64, sha256B64 } from '../crypto.js';
import { domainOfUrl, isSupportedUrl } from '../domain.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STANDALONE = params.get('mode') === 'unlock';
const AUTO_BIOMETRIC = params.get('bio') === '1';

let currentTab = null;
let entries = [];
let matchedIds = new Set();
let settings = null;
let bioRecord = null;

function rpc(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response) return reject(new Error('The extension is not responding.'));
      resolve(response);
    });
  });
}

function show(view) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${view}`;
}

let flashTimer = null;
function flash(message) {
  const el = $('flash');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.hidden = !message;
}

/* -------------------------------------------------------------------- start */

async function init() {
  decorate('btn-add', 'plus');
  decorate('btn-lock', 'lock');
  decorate('btn-settings', 'settings');
  decorate('btn-back', 'back');

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTab = tab && isSupportedUrl(tab.url) ? tab : null;

  await labelShortcuts();

  const status = await rpc(M.STATUS);
  if (!status.hasVault) {
    show('setup');
    $('setup-pw').focus();
    return;
  }
  if (!status.unlocked) {
    show('locked');
    await setUpBiometric(status.hasBiometric);
    if (status.cooldownMs > 0) {
      showError('unlock-error', `Too many attempts. Try again in ${Math.ceil(status.cooldownMs / 1000)}s.`);
    }
    $('unlock-pw').focus();
    return;
  }
  await loadEntries();
}

// Reflect whatever is actually bound at chrome://extensions/shortcuts.
async function labelShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const find = (name) => (commands.find((c) => c.name === name) || {}).shortcut || 'not set';
    $('kbd-fill').textContent = find('fill-credentials');
    $('kbd-save').textContent = find('save-credentials');
  } catch {
    /* leave the defaults in the markup */
  }
}

async function loadEntries() {
  const [list, config] = await Promise.all([
    rpc(M.LIST_ENTRIES, { url: currentTab ? currentTab.url : '' }),
    rpc(M.GET_SETTINGS),
  ]);
  if (!list.ok) {
    show('locked');
    $('unlock-pw').focus();
    return;
  }
  entries = list.entries;
  matchedIds = new Set(list.matchedIds);
  settings = config.settings;
  show('list');
  render();
  $('search').focus();
}

/* ----------------------------------------------------------------- Touch ID */

async function setUpBiometric(hasBiometric) {
  $('bio-block').hidden = !hasBiometric;
  if (!hasBiometric) return;

  const res = await rpc(M.GET_BIOMETRIC).catch(() => ({ record: null }));
  bioRecord = res.record;
  if (!bioRecord) {
    $('bio-block').hidden = true;
    return;
  }

  // The Touch ID sheet takes focus, and an action popup closes when it loses focus --
  // which would abandon the request. The standalone window has no such problem.
  if (STANDALONE) {
    $('btn-bio').addEventListener('click', runBiometric);
    if (AUTO_BIOMETRIC) runBiometric();
  } else {
    $('btn-bio').addEventListener('click', openBiometricWindow);
  }
}

async function openBiometricWindow() {
  await chrome.windows.create({
    url: chrome.runtime.getURL('src/popup/popup.html?mode=unlock&bio=1'),
    type: 'popup',
    width: 400,
    height: 400,
  });
  window.close();
}

async function runBiometric() {
  if (!bioRecord) return;
  $('btn-bio').disabled = true;
  $('bio-status').textContent = 'Waiting for Touch ID…';
  showError('unlock-error', '');

  try {
    const raw = await BIO.unlock(bioRecord);
    const res = await rpc(M.UNLOCK_WITH_KEY, { raw: toB64(raw) });
    if (!res.ok) throw new Error(res.error);
    if (STANDALONE) {
      window.close();
      return;
    }
    await loadEntries();
  } catch (err) {
    const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
    $('bio-status').textContent = cancelled
      ? 'Cancelled. Use your master password instead.'
      : (err.message || 'Touch ID did not work.');
    $('btn-bio').disabled = false;
    $('unlock-pw').focus();
  }
}

/* ------------------------------------------------------------------- render */

// Chrome's locally cached favicons -- no request is made to the site.
function faviconUrl(entry) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', entry.origin || `https://${entry.domain}`);
  url.searchParams.set('size', '32');
  return url.toString();
}

// A site with no cached icon would otherwise render the browser's broken-image glyph.
function favicon(entry) {
  const img = document.createElement('img');
  img.className = 'fav';
  img.src = faviconUrl(entry);
  img.alt = '';
  img.addEventListener('error', () => {
    const letter = document.createElement('div');
    letter.className = 'fav letter';
    letter.textContent = (entry.title || entry.domain || '?').trim().charAt(0).toUpperCase();
    letter.setAttribute('aria-hidden', 'true');
    img.replaceWith(letter);
  });
  return img;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Small stroked glyphs, drawn inline so nothing is loaded from outside the extension.
const ICONS = {
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  lock: ['M4 7.5h8v6H4z', 'M6 7.5V5.5a2 2 0 0 1 4 0v2'],
  settings: ['M2.5 5h4', 'M9.5 5h4', 'M2.5 11h7', 'M12.5 11h1', 'M8 5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', 'M11 11m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'],
  user: ['M8 4.2m-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0', 'M3.6 13c0-2.3 2-3.7 4.4-3.7s4.4 1.4 4.4 3.7'],
  key: ['M6 8m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0', 'M8.6 8H13', 'M11 8v2.2', 'M13 8v2.6'],
  edit: ['M10.9 2.9l2.2 2.2L5.8 12.4l-2.9.7.7-2.9z'],
  back: ['M9.5 3.5L5 8l4.5 4.5'],
};

function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function iconButton(name, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(svgIcon(name));
  b.addEventListener('click', onClick);
  return b;
}

// The buttons declared in the markup get their glyphs the same way.
function decorate(id, name) {
  const el = $(id);
  if (el) el.replaceChildren(svgIcon(name));
}

function entryRow(entry) {
  const li = document.createElement('li');

  li.appendChild(favicon(entry));

  const main = document.createElement('button');
  main.className = 'entry-main';
  main.type = 'button';
  main.title = 'Fill this login on the current page';
  const title = document.createElement('div');
  title.className = 'entry-title';
  title.textContent = entry.title || entry.domain;
  const sub = document.createElement('div');
  sub.className = 'entry-sub';
  sub.textContent = entry.username || 'No username';
  main.append(title, sub);
  main.addEventListener('click', () => fillEntry(entry));

  li.append(
    main,
    iconButton('user', 'Copy username', () => copy(entry.username, 'Username copied', false)),
    iconButton('key', 'Copy password', () => copy(entry.password, 'Password copied', true)),
    iconButton('edit', 'Edit login', () => openEdit(entry)),
  );
  return li;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const matches = (e) => !q
    || (e.title || '').toLowerCase().includes(q)
    || (e.domain || '').toLowerCase().includes(q)
    || (e.username || '').toLowerCase().includes(q)
    || (e.notes || '').toLowerCase().includes(q);

  const visible = entries.filter(matches);
  const site = visible.filter((e) => matchedIds.has(e.id));
  const rest = visible
    .filter((e) => !matchedIds.has(e.id))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  $('site-list').replaceChildren(...site.map(entryRow));
  $('site-section').hidden = site.length === 0;
  if (currentTab) $('site-heading').textContent = domainOfUrl(currentTab.url);

  $('all-list').replaceChildren(...rest.map(entryRow));
  $('all-heading').hidden = rest.length === 0;
  $('all-heading').textContent = site.length ? 'Other logins' : 'All logins';

  $('empty').hidden = entries.length !== 0;
  $('no-results').hidden = entries.length === 0 || visible.length !== 0;
}

/* ------------------------------------------------------------------ actions */

async function fillEntry(entry) {
  if (!currentTab) {
    flash('This page cannot be filled');
    return;
  }
  const res = await rpc(M.FILL_ENTRY, { id: entry.id, tabId: currentTab.id });
  if (res.ok) window.close();
  else flash(res.error || 'Could not fill this page');
}

async function copy(text, message, isSecret) {
  if (!text) {
    flash('Nothing to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    flash('Could not copy');
    return;
  }
  flash(message);
  // The worker clears the clipboard later, but only if it still holds this value. It is
  // given the hash, never the secret.
  if (isSecret) rpc(M.SCHEDULE_CLIPBOARD_CLEAR, { hash: await sha256B64(text) }).catch(() => {});
}

/* ---------------------------------------------------------------- generator */

const AMBIGUOUS = /[Il1O0o]/g;

function generatePassword(opts) {
  let alphabet = 'abcdefghijklmnopqrstuvwxyz';
  if (opts.upper) alphabet += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (opts.digits) alphabet += '0123456789';
  if (opts.symbols) alphabet += '!@#$%^&*-_=+?';
  if (!opts.ambiguous) alphabet = alphabet.replace(AMBIGUOUS, '');

  const chars = [...new Set(alphabet)];
  // Rejection sampling: a raw byte taken modulo the alphabet size would make the earliest
  // characters of the alphabet marginally more likely.
  const limit = Math.floor(256 / chars.length) * chars.length;
  const out = [];
  while (out.length < opts.length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(opts.length))) {
      if (byte >= limit) continue;
      out.push(chars[byte % chars.length]);
      if (out.length === opts.length) break;
    }
  }
  return out.join('');
}

function strengthText(password) {
  if (!password) return ['', ''];
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 8) return ['Too short — use at least 8 characters', 'poor'];
  if (password.length >= 16 && classes >= 3) return ['Strong', 'good'];
  if (password.length >= 12 && classes >= 2) return ['Reasonable — longer is better', ''];
  return ['Weak — use a longer passphrase', 'poor'];
}

function setStrength(id, password) {
  const [text, cls] = strengthText(password);
  const el = $(id);
  el.textContent = text;
  el.className = `strength ${cls}`.trim();
}

function generatorOptions() {
  return {
    length: Number($('gen-length').value),
    upper: $('gen-upper').checked,
    digits: $('gen-digits').checked,
    symbols: $('gen-symbols').checked,
    ambiguous: $('gen-ambiguous').checked,
  };
}

function applyGeneratorSettings(gen) {
  $('gen-length').value = String(gen.length);
  $('gen-length-out').textContent = String(gen.length);
  $('gen-upper').checked = gen.upper;
  $('gen-digits').checked = gen.digits;
  $('gen-symbols').checked = gen.symbols;
  $('gen-ambiguous').checked = gen.ambiguous;
}

function regenerate() {
  $('edit-pass').value = generatePassword(generatorOptions());
  $('edit-pass').type = 'text';
  $('btn-reveal').setAttribute('aria-pressed', 'true');
  $('btn-reveal').textContent = 'Hide';
  setStrength('edit-strength', $('edit-pass').value);
}

/* ---------------------------------------------------------------- edit view */

function openEdit(entry) {
  $('edit-title').textContent = entry ? 'Edit login' : 'Add login';
  $('edit-id').value = entry ? entry.id : '';
  $('edit-name').value = entry ? entry.title : '';
  $('edit-url').value = entry
    ? (entry.origin || `https://${entry.domain}`)
    : (currentTab ? new URL(currentTab.url).origin : '');
  $('edit-user').value = entry ? entry.username : '';
  $('edit-pass').value = entry ? entry.password : '';
  $('edit-pass').type = 'password';
  $('btn-reveal').setAttribute('aria-pressed', 'false');
  $('btn-reveal').textContent = 'Show';
  $('edit-notes').value = entry ? entry.notes : '';
  $('btn-delete').hidden = !entry;
  $('gen-panel').hidden = true;
  $('btn-generate').setAttribute('aria-expanded', 'false');
  applyGeneratorSettings(settings.generator);
  setStrength('edit-strength', $('edit-pass').value);
  disarmDelete();
  showError('edit-error', '');
  show('edit');
  $(entry ? 'edit-pass' : 'edit-name').focus();
}

/* ------------------------------------------------------------------- wiring */

$('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('setup-pw').value;
  if (pw.length < 8) {
    showError('setup-error', 'Use at least 8 characters.');
    return;
  }
  if (pw !== $('setup-pw2').value) {
    showError('setup-error', 'The two passwords do not match.');
    return;
  }
  const res = await rpc(M.CREATE_VAULT, { password: pw });
  if (!res.ok) {
    showError('setup-error', res.error);
    return;
  }
  await loadEntries();
});

$('setup-pw').addEventListener('input', () => setStrength('setup-strength', $('setup-pw').value));

$('form-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await rpc(M.UNLOCK, { password: $('unlock-pw').value });
  if (!res.ok) {
    showError('unlock-error', res.error);
    $('unlock-pw').select();
    return;
  }
  $('unlock-pw').value = '';
  if (STANDALONE) {
    window.close();
    return;
  }
  await loadEntries();
});

$('search').addEventListener('input', render);

// Enter in the search box fills the top result -- the common case in one keystroke.
$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('site-list').querySelector('.entry-main')
    || $('all-list').querySelector('.entry-main');
  if (first) {
    e.preventDefault();
    first.click();
  }
});

$('btn-add').addEventListener('click', () => openEdit(null));
$('btn-back').addEventListener('click', () => { show('list'); render(); });
$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('link-options-empty').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('btn-lock').addEventListener('click', async () => {
  await rpc(M.LOCK);
  entries = [];
  show('locked');
  const status = await rpc(M.STATUS);
  await setUpBiometric(status.hasBiometric);
  $('unlock-pw').focus();
});

$('btn-reveal').addEventListener('click', () => {
  const el = $('edit-pass');
  const revealing = el.type === 'password';
  el.type = revealing ? 'text' : 'password';
  $('btn-reveal').setAttribute('aria-pressed', String(revealing));
  $('btn-reveal').textContent = revealing ? 'Hide' : 'Show';
});

$('btn-generate').addEventListener('click', () => {
  const panel = $('gen-panel');
  panel.hidden = !panel.hidden;
  $('btn-generate').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) regenerate();
});

for (const id of ['gen-length', 'gen-upper', 'gen-digits', 'gen-symbols', 'gen-ambiguous']) {
  $(id).addEventListener('input', () => {
    $('gen-length-out').textContent = $('gen-length').value;
    regenerate();
  });
}

$('btn-gen-apply').addEventListener('click', async () => {
  $('gen-panel').hidden = true;
  $('btn-generate').setAttribute('aria-expanded', 'false');
  // Remember the shape of password this user prefers.
  const res = await rpc(M.SET_SETTINGS, { patch: { generator: generatorOptions() } });
  settings = res.settings;
  $('edit-pass').focus();
});

$('edit-pass').addEventListener('input', () => setStrength('edit-strength', $('edit-pass').value));

$('form-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('edit-url').value.trim();
  if (!raw) {
    showError('edit-error', 'A website address is required.');
    return;
  }
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') throw new Error('host');
  } catch {
    showError('edit-error', 'That website address does not look valid.');
    return;
  }
  if (!$('edit-pass').value) {
    showError('edit-error', 'A password is required.');
    return;
  }

  const res = await rpc(M.SAVE_ENTRY, {
    entry: {
      id: $('edit-id').value || undefined,
      title: $('edit-name').value,
      url,
      username: $('edit-user').value,
      password: $('edit-pass').value,
      notes: $('edit-notes').value,
    },
  });
  if (!res.ok) {
    showError('edit-error', res.error);
    return;
  }
  flash('Saved');
  await loadEntries();
});

// window.confirm() can dismiss the whole popup, so confirm inline: the first click arms
// the button, a second within 4s deletes.
let deleteArmed = false;
let deleteTimer = null;

function disarmDelete() {
  clearTimeout(deleteTimer);
  deleteArmed = false;
  $('btn-delete').textContent = 'Delete';
}

$('btn-delete').addEventListener('click', async () => {
  const id = $('edit-id').value;
  if (!id) return;

  if (!deleteArmed) {
    deleteArmed = true;
    $('btn-delete').textContent = 'Click again to delete';
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(disarmDelete, 4000);
    return;
  }

  disarmDelete();
  await rpc(M.DELETE_ENTRY, { id });
  flash('Deleted');
  await loadEntries();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('gen-panel').hidden) {
    $('gen-panel').hidden = true;
    $('btn-generate').setAttribute('aria-expanded', 'false');
    return;
  }
  if (!$('view-edit').hidden) {
    show('list');
    render();
  }
});

init().catch(() => {
  document.body.textContent = 'Password Vault could not start. Try reopening it.';
});
