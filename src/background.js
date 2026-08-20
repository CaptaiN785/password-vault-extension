// Service worker: shortcut commands, frame routing, and the RPC surface for the popup,
// options page and content scripts.
//
// Holds no long-lived state -- MV3 terminates this worker after seconds of idle, so
// anything that must survive lives in chrome.storage.

import * as V from './vault.js';
import * as M from './messages.js';
import * as C from './crypto.js';
import { domainOfUrl, isSupportedUrl, matchEntries } from './domain.js';

const ALARM_AUTOLOCK = 'autolock-tick';
const ALARM_CLIPBOARD = 'clipboard-clear';
const S_LAST_PROMPT = 'lastPromptSig';
const S_CLIP_HASH = 'clipboardHash';
const OFFSCREEN_PATH = 'src/offscreen.html';
const IDLE_SECONDS = 60;

/* --------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(async (details) => {
  await V.hardenSessionStorage();
  chrome.alarms.create(ALARM_AUTOLOCK, { periodInMinutes: 1 });
  chrome.idle.setDetectionInterval(IDLE_SECONDS);
  await reinjectContentScripts();
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await V.hardenSessionStorage();
  await V.lock();
  chrome.alarms.create(ALARM_AUTOLOCK, { periodInMinutes: 1 });
  chrome.idle.setDetectionInterval(IDLE_SECONDS);
});

// After an install or reload, tabs that were already open are running the previous
// content script with a dead runtime connection. Push the current one into them so the
// shortcuts work immediately instead of only after the user reloads every tab.
async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map(async (tab) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/content/content.js'],
      });
    } catch {
      // Restricted pages simply refuse.
    }
  }));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_AUTOLOCK) {
    await V.getKey(); // clears an expired key as a side effect
    await refreshTitle();
  } else if (alarm.name === ALARM_CLIPBOARD) {
    await clearClipboard();
  }
});

// Walking away from the machine should close the vault, whatever the auto-lock clock says.
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'active') return;
  const { lockOnSystemIdle } = await V.getSettings();
  if (!lockOnSystemIdle) return;
  await V.lock();
  await refreshTitle();
});

/* ------------------------------------------------------------------ action */

async function refreshTitle() {
  const hasVault = await V.hasVault();
  const unlocked = await V.isUnlocked();
  await chrome.action.setTitle({
    title: !hasVault ? 'Password Vault — set up'
      : unlocked ? 'Password Vault — unlocked'
        : 'Password Vault — locked',
  });
}

// Transient feedback for pages where no content script can run.
let badgeTimer = null;
async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    await chrome.action.setBadgeText({ text: '' });
    await refreshTitle();
  }, 2500);
}

/* ----------------------------------------------------------- frame routing */

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
        void chrome.runtime.lastError; // no receiver in that frame -- expected
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// Enumerating frames via a trivial allFrames injection keeps this to the "scripting"
// permission; webNavigation.getAllFrames() would cost a browsing-history warning.
async function listFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    return results.map((r) => r.frameId);
  } catch {
    return [0];
  }
}

// Login forms are frequently inside an iframe, so probe every frame and act on the one
// that actually reported a password field.
async function findLoginFrame(tabId) {
  const frameIds = await listFrameIds(tabId);
  const probes = await Promise.all(
    frameIds.map(async (frameId) => ({
      frameId,
      result: await sendToFrame(tabId, frameId, { type: M.DETECT }),
    })),
  );
  const live = probes.filter((p) => p.result);
  return (
    live.find((p) => p.result.hasPassword)
    || live.find((p) => p.result.hasUsername)
    || live.find((p) => p.frameId === 0)
    || null
  );
}

async function toast(tabId, message, sub, kind) {
  const sent = await sendToFrame(tabId, 0, { type: M.TOAST, message, sub, kind });
  if (!sent) await flashBadge(kind === 'warn' ? '!' : '✓', kind === 'warn' ? '#b45309' : '#2563eb');
}

/* --------------------------------------------------------------- unlocking */

// openPopup() needs Chrome 127+ and is not always permitted; fall back to a small window.
//
// With Touch ID enrolled we always take the window path: the macOS WebAuthn sheet steals
// focus, and an action popup closes the moment it loses focus -- taking the pending
// credential request down with it. A real window survives.
async function promptUnlock() {
  const biometric = await V.getBiometric();

  if (!biometric) {
    try {
      await chrome.action.openPopup();
      return;
    } catch {
      /* fall through */
    }
  }

  const url = chrome.runtime.getURL(
    `src/popup/popup.html?mode=unlock${biometric ? '&bio=1' : ''}`,
  );
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true, drawAttention: true });
    return;
  }
  await chrome.windows.create({ url, type: 'popup', width: 400, height: 400 });
}

async function requireUnlocked(tabId) {
  if (await V.isUnlocked()) return true;
  if (!(await V.hasVault())) {
    if (tabId) await toast(tabId, 'Set up your vault first', 'Open the extension to get started', 'warn');
  } else if (tabId) {
    await toast(tabId, 'Vault is locked', 'Unlock to continue', 'warn');
  }
  await promptUnlock();
  return false;
}

/* ------------------------------------------------------------------ filling */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Only ever hand a page's context the fields it needs to draw a menu. Passwords cross
// that boundary once, on an explicit choice, and never as part of a list.
function publicEntry(entry) {
  return {
    id: entry.id,
    username: entry.username,
    title: entry.title,
    domain: entry.domain,
  };
}

async function fillEntryInTab(tab, entry, knownFrame) {
  const frame = knownFrame || await findLoginFrame(tab.id);
  if (!frame) {
    await toast(tab.id, 'No login form found on this page', null, 'warn');
    return false;
  }

  const { autoSubmit } = await V.getSettings();
  const result = await sendToFrame(tab.id, frame.frameId, {
    type: M.FILL,
    username: entry.username,
    password: entry.password,
    submit: autoSubmit,
  });

  if (!result || (!result.filledUsername && !result.filledPassword)) {
    await toast(tab.id, 'Could not find fields to fill', null, 'warn');
    return false;
  }

  await V.markUsed(entry.id);
  const what = result.filledPassword && result.filledUsername
    ? 'Filled username and password'
    : result.filledPassword ? 'Filled password' : 'Filled username';
  await toast(tab.id, `${what} — ${entry.domain}`, entry.username || '', 'ok');
  return true;
}

async function commandFill() {
  const tab = await activeTab();
  if (!tab) return;

  if (!isSupportedUrl(tab.url)) {
    await flashBadge('n/a', '#b45309');
    return;
  }
  if (!(await requireUnlocked(tab.id))) return;

  const entries = await V.readEntries();
  const matches = matchEntries(entries, tab.url);

  if (!matches.length) {
    await toast(
      tab.id,
      `No saved login for ${domainOfUrl(tab.url)}`,
      'Fill the form, then press the save shortcut',
      'warn',
    );
    return;
  }

  // Resolve the frame once and reuse it, so the picker renders in the same frame the fill
  // lands in; otherwise an iframe login gets its menu in the top document, anchored to a
  // field that is not there.
  const frame = await findLoginFrame(tab.id);

  if (matches.length === 1) {
    await fillEntryInTab(tab, matches[0], frame);
    return;
  }

  if (!frame) {
    await toast(tab.id, 'No login form found on this page', null, 'warn');
    return;
  }

  const choice = await sendToFrame(tab.id, frame.frameId, {
    type: M.PICK,
    entries: matches.map(publicEntry),
  });
  if (!choice || !choice.id) return;
  const entry = matches.find((e) => e.id === choice.id);
  if (entry) await fillEntryInTab(tab, entry, frame);
}

/* ------------------------------------------------------------------- saving */

async function commandSave() {
  const tab = await activeTab();
  if (!tab) return;

  if (!isSupportedUrl(tab.url)) {
    await flashBadge('n/a', '#b45309');
    return;
  }
  if (!(await requireUnlocked(tab.id))) return;

  const frame = await findLoginFrame(tab.id);
  const captured = frame ? await sendToFrame(tab.id, frame.frameId, { type: M.CAPTURE }) : null;

  if (!captured || !captured.password) {
    await toast(tab.id, 'Nothing to save', 'Type a password into the form first', 'warn');
    return;
  }

  const url = captured.url || tab.url;
  const domain = domainOfUrl(url);
  const existing = await V.findByDomainAndUser(domain, captured.username);

  if (existing && existing.password === captured.password) {
    await toast(tab.id, 'Already saved', `${domain} — ${captured.username}`, 'ok');
    return;
  }

  await V.upsertEntry({
    id: existing ? existing.id : undefined,
    title: existing ? existing.title : (captured.title || domain),
    url,
    username: captured.username,
    password: captured.password,
    notes: existing ? existing.notes : '',
  });

  await toast(
    tab.id,
    existing ? 'Password updated' : 'Password saved',
    `${domain} — ${captured.username || 'no username'}`,
    'ok',
  );
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'fill-credentials') await commandFill();
    else if (command === 'save-credentials') await commandSave();
    else if (command === 'lock-vault') {
      await V.lock();
      await refreshTitle();
      await flashBadge('lock', '#64748b');
    }
  } catch (err) {
    if (String(err && err.message) === 'LOCKED') await promptUnlock();
  }
});

/* -------------------------------------------------- offer to save on submit */

let promptOpen = false;

async function handleSubmission(msg, sender) {
  if (promptOpen || !sender.tab || !msg.password) return;
  if (!(await V.isUnlocked())) return;

  const settings = await V.getSettings();
  if (!settings.autoSavePrompt) return;

  const url = msg.url || sender.tab.url;
  const domain = domainOfUrl(url);
  if (!domain || settings.neverSave.includes(domain)) return;

  const existing = await V.findByDomainAndUser(domain, msg.username);
  if (existing && existing.password === msg.password) return;

  // The submit heuristics in the content script can each fire for a single login.
  const sig = `${domain}|${msg.username}|${msg.password.length}`;
  const { [S_LAST_PROMPT]: last } = await chrome.storage.session.get(S_LAST_PROMPT);
  if (last && last.sig === sig && Date.now() - last.at < 10000) return;
  await chrome.storage.session.set({ [S_LAST_PROMPT]: { sig, at: Date.now() } });

  promptOpen = true;
  try {
    const answer = await sendToFrame(sender.tab.id, 0, {
      type: M.SAVE_PROMPT,
      domain,
      username: msg.username,
      isUpdate: !!existing,
    });

    if (!answer) return;
    if (answer.action === 'never') {
      await V.setSettings({ neverSave: [...settings.neverSave, domain] });
    } else if (answer.action === 'save') {
      await V.upsertEntry({
        id: existing ? existing.id : undefined,
        title: existing ? existing.title : (msg.title || domain),
        url,
        username: msg.username,
        password: msg.password,
        notes: existing ? existing.notes : '',
      });
      await toast(sender.tab.id, existing ? 'Password updated' : 'Password saved', domain, 'ok');
    }
  } finally {
    promptOpen = false;
  }
}

/* ---------------------------------------------------------------- clipboard */

let offscreenPending = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  // Two concurrent creates throw; collapse them onto one promise.
  if (!offscreenPending) {
    offscreenPending = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Clear a copied password from the clipboard.',
    }).finally(() => { offscreenPending = null; });
  }
  await offscreenPending;
}

// Only overwrite the clipboard if it still holds what we put there -- compared by hash,
// so the copied secret is never stored anywhere to make the comparison.
async function clearClipboard() {
  const { [S_CLIP_HASH]: hash } = await chrome.storage.session.get(S_CLIP_HASH);
  if (!hash) return;
  await chrome.storage.session.remove(S_CLIP_HASH);

  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CLEAR_IF_MATCHES', hash });
  } catch {
    // Nothing actionable; the copy stays until the user copies something else.
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch { /* already gone */ }
  }
}

/* -------------------------------------------------------------- RPC router */

// Internal signals become something a person can act on. Raw failures never reach the UI.
const PASS_THROUGH = [
  'Too many attempts', 'Master password must', 'This vault was created',
  'No vault has been', 'A vault already',
];

function friendlyError(err) {
  const message = String((err && err.message) || err);
  if (message === 'LOCKED') return 'The vault is locked.';
  if (message === 'WRONG_PASSWORD') return 'That password is not correct.';
  if (PASS_THROUGH.some((prefix) => message.startsWith(prefix))) return message;
  return 'Something went wrong. Please try again.';
}

const handlers = {
  async [M.STATUS]() {
    return {
      hasVault: await V.hasVault(),
      unlocked: await V.isUnlocked(),
      hasBiometric: (await V.getBiometric()) !== null,
      cooldownMs: await V.unlockCooldownMs(),
    };
  },

  async [M.CREATE_VAULT]({ password }) {
    await V.createVault(password);
    await refreshTitle();
    return { ok: true };
  },

  async [M.UNLOCK]({ password }) {
    await V.unlock(password);
    await refreshTitle();
    return { ok: true };
  },

  async [M.LOCK]() {
    await V.lock();
    await refreshTitle();
    return { ok: true };
  },

  async [M.LIST_ENTRIES]({ url }) {
    const entries = await V.readEntries();
    await V.touchUnlock();
    return {
      entries,
      matchedIds: url ? matchEntries(entries, url).map((e) => e.id) : [],
      domain: url ? domainOfUrl(url) : '',
    };
  },

  async [M.SAVE_ENTRY]({ entry }) {
    return { entry: await V.upsertEntry(entry) };
  },

  async [M.DELETE_ENTRY]({ id }) {
    await V.deleteEntry(id);
    return { ok: true };
  },

  async [M.FILL_ENTRY]({ id, tabId }, sender) {
    const target = tabId || (sender.tab && sender.tab.id);
    const tab = target ? await chrome.tabs.get(target) : await activeTab();
    if (!tab) return { ok: false, error: 'No active tab.' };
    const entries = await V.readEntries();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'That login no longer exists.' };
    return { ok: await fillEntryInTab(tab, entry) };
  },

  // Asked by a content script when the user focuses a login field.
  async [M.SUGGEST_REQUEST](msg, sender) {
    if (!sender.tab) return { entries: [] };
    const settings = await V.getSettings();
    if (!settings.suggestOnFocus) return { entries: [] };
    if (!(await V.isUnlocked())) return { entries: [], locked: true };
    const entries = await V.readEntries();
    return { entries: matchEntries(entries, msg.url || sender.tab.url).map(publicEntry) };
  },

  async [M.IMPORT_ENTRIES]({ entries }) {
    return V.importEntries(entries);
  },

  async [M.EXPORT_VAULT]() {
    return { blob: await V.getVaultBlob() };
  },

  // Replaces the whole encrypted blob. The restored vault opens with whatever master
  // password it was created under, so lock afterwards and make the user re-enter it.
  async [M.RESTORE_VAULT]({ blob }) {
    if (!blob || !blob.kdf || !blob.iv || !blob.ct) {
      return { ok: false, error: 'That file is not a vault backup.' };
    }
    if (blob.v !== V.VAULT_VERSION) {
      return { ok: false, error: 'That backup was made by a different version.' };
    }
    await chrome.storage.local.set({ vault: blob });
    await V.clearBiometric();
    await V.lock();
    await refreshTitle();
    return { ok: true };
  },

  async [M.CHANGE_MASTER]({ oldPassword, newPassword }) {
    await V.changeMaster(oldPassword, newPassword);
    return { ok: true };
  },

  async [M.AUDIT]() {
    return { audit: await V.auditEntries() };
  },

  async [M.GET_RAW_KEY]() {
    return { raw: C.toB64(await V.getRawKeyBytes()) };
  },

  async [M.GET_BIOMETRIC]() {
    return { record: await V.getBiometric() };
  },

  async [M.SET_BIOMETRIC]({ record }) {
    await V.setBiometric(record);
    return { ok: true };
  },

  async [M.CLEAR_BIOMETRIC]() {
    await V.clearBiometric();
    return { ok: true };
  },

  async [M.UNLOCK_WITH_KEY]({ raw }) {
    try {
      await V.unlockWithRawKey(C.fromB64(raw));
    } catch {
      return { ok: false, error: 'That key does not open this vault.' };
    }
    await refreshTitle();
    return { ok: true };
  },

  async [M.GET_SETTINGS]() {
    return { settings: await V.getSettings() };
  },

  async [M.SET_SETTINGS]({ patch }) {
    return { settings: await V.setSettings(patch) };
  },

  async [M.SCHEDULE_CLIPBOARD_CLEAR]({ hash }) {
    const { clipboardClearSeconds } = await V.getSettings();
    if (clipboardClearSeconds > 0 && hash) {
      await chrome.storage.session.set({ [S_CLIP_HASH]: hash });
      chrome.alarms.create(ALARM_CLIPBOARD, { when: Date.now() + clipboardClearSeconds * 1000 });
    }
    return { ok: true };
  },

  async [M.SUBMIT_DETECTED](msg, sender) {
    await handleSubmission(msg, sender);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'offscreen') return false; // belongs to the offscreen document
  const handler = msg && handlers[msg.type];
  if (!handler) return false;

  handler(msg, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: friendlyError(err) }));
  return true; // async response
});

refreshTitle();
