import * as M from '../messages.js';
import * as BIO from '../biometric.js';
import { fromB64 } from '../crypto.js';

const $ = (id) => document.getElementById(id);

let settings = null;

function rpc(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response || { ok: false, error: 'The extension is not responding.' });
    });
  });
}

function result(id, message, bad) {
  const el = $(id);
  el.textContent = message || '';
  el.classList.toggle('bad', !!bad);
  el.hidden = !message;
}

/* ------------------------------------------------------------------- startup */

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('welcome').hidden = location.hash !== '#welcome';

  await renderShortcuts();

  const status = await rpc(M.STATUS);
  $('no-vault-notice').hidden = status.hasVault;
  $('locked-notice').hidden = !status.hasVault || status.unlocked;
  $('settings-body').hidden = !status.unlocked;
  if (!status.unlocked) return;

  const res = await rpc(M.GET_SETTINGS);
  settings = res.settings;

  $('autolock').value = String(settings.autoLockMinutes);
  $('clipboard').value = String(settings.clipboardClearSeconds);
  $('autosave').checked = settings.autoSavePrompt;
  $('autosave-silent').checked = settings.autoSaveSilently;
  $('autosave-silent').disabled = !settings.autoSavePrompt;
  $('suggest').checked = settings.suggestOnFocus;
  $('autosubmit').checked = settings.autoSubmit;
  $('lockidle').checked = settings.lockOnSystemIdle;

  renderNeverList();
  await refreshBiometric();
}

async function renderShortcuts() {
  const labels = {
    'fill-credentials': 'Fill username and password',
    'save-credentials': 'Save the credentials on this page',
    'lock-vault': 'Lock the vault',
    _execute_action: 'Open the vault',
  };
  const commands = await chrome.commands.getAll();
  $('shortcut-rows').replaceChildren(...commands.map((c) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = labels[c.name] || c.description || c.name;
    const key = document.createElement('td');
    const kbd = document.createElement('kbd');
    kbd.textContent = c.shortcut || 'not set';
    if (!c.shortcut) kbd.className = 'unset';
    key.appendChild(kbd);
    tr.append(name, key);
    return tr;
  }));
}

function renderNeverList() {
  const list = settings.neverSave || [];
  $('never-empty').hidden = list.length > 0;
  $('never-list').replaceChildren(...list.map((domain) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', `Stop ignoring ${domain}`);
    btn.addEventListener('click', async () => {
      const next = settings.neverSave.filter((d) => d !== domain);
      settings = (await rpc(M.SET_SETTINGS, { patch: { neverSave: next } })).settings;
      renderNeverList();
    });
    li.append(span, btn);
    return li;
  }));
}

/* ------------------------------------------------------------------ Touch ID */

async function refreshBiometric() {
  const support = await BIO.isSupported();
  const { record } = await rpc(M.GET_BIOMETRIC);
  const enrollBtn = $('btn-bio-enroll');
  const disableBtn = $('btn-bio-disable');

  if (!support.ok) {
    $('bio-state').textContent = `Not available on this device. ${support.reason}`;
    $('bio-state').classList.add('bad');
    enrollBtn.disabled = true;
    disableBtn.hidden = true;
    return;
  }

  $('bio-state').classList.remove('bad');
  if (record) {
    $('bio-state').textContent = `On — set up ${new Date(record.enrolledAt).toLocaleDateString()}.`;
    enrollBtn.textContent = 'Set up again';
    disableBtn.hidden = false;
  } else {
    $('bio-state').textContent = 'Off.';
    enrollBtn.textContent = 'Turn on Touch ID';
    disableBtn.hidden = true;
  }
}

$('btn-bio-enroll').addEventListener('click', async () => {
  result('bio-result', 'Follow the Touch ID prompt…');
  $('btn-bio-enroll').disabled = true;
  try {
    // Enrolment protects the vault's live key, so the vault must be open.
    const keyRes = await rpc(M.GET_RAW_KEY);
    if (!keyRes.ok) throw new Error('Unlock the vault first.');

    const record = await BIO.enroll(fromB64(keyRes.raw));
    const saved = await rpc(M.SET_BIOMETRIC, { record });
    if (!saved.ok) throw new Error(saved.error);

    result('bio-result', 'Touch ID is on. You will be asked for your fingerprint when the vault is locked.');
    await refreshBiometric();
  } catch (err) {
    const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
    result('bio-result', cancelled ? 'Cancelled.' : err.message, !cancelled);
  } finally {
    $('btn-bio-enroll').disabled = false;
  }
});

$('btn-bio-disable').addEventListener('click', async () => {
  await rpc(M.CLEAR_BIOMETRIC);
  result('bio-result', 'Touch ID is off. You can remove the passkey it created in Chrome’s passkey settings.');
  await refreshBiometric();
});

/* ------------------------------------------------------------ security check */

const SCORE_WORDS = ['very weak', 'very weak', 'weak', 'fair', 'strong'];

$('btn-audit').addEventListener('click', async () => {
  const res = await rpc(M.AUDIT);
  if (!res.ok) {
    result('audit-summary', res.error, true);
    $('audit-out').hidden = false;
    $('audit-detail').replaceChildren();
    return;
  }

  const { total, reused, weak } = res.audit;
  const reusedCount = reused.reduce((n, group) => n + group.length, 0);
  $('audit-out').hidden = false;

  const parts = [];
  // reusedCount counts only entries inside a duplicate group, so it is never 1.
  if (reusedCount) parts.push(`${reusedCount} share a password with another login`);
  if (weak.length) parts.push(weak.length === 1 ? '1 is weak' : `${weak.length} are weak`);
  result(
    'audit-summary',
    parts.length ? `Checked ${total} logins: ${parts.join(', ')}.` : `Checked ${total} logins. Nothing to fix.`,
    parts.length > 0,
  );

  const detail = document.createDocumentFragment();

  if (reused.length) {
    detail.appendChild(heading('Reused passwords'));
    for (const group of reused) {
      const ul = document.createElement('ul');
      ul.className = 'audit';
      for (const e of group) ul.appendChild(auditItem(e, 'shared with the others in this group'));
      detail.appendChild(ul);
    }
  }

  if (weak.length) {
    detail.appendChild(heading('Weak passwords'));
    const ul = document.createElement('ul');
    ul.className = 'audit';
    for (const e of weak) ul.appendChild(auditItem(e, SCORE_WORDS[e.score]));
    detail.appendChild(ul);
  }

  $('audit-detail').replaceChildren(detail);
});

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function auditItem(entry, note) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = `${entry.title || entry.domain}${entry.username ? ` — ${entry.username}` : ''}`;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = note;
  li.append(name, tag);
  return li;
}

/* ------------------------------------------------------------------- import */

// Chrome exports name,url,username,password,note -- quoted fields, embedded newlines, and
// "" as an escaped quote. Small enough to parse by hand and keep auditable.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* handled by the \n branch */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

function csvToEntries(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  // Column names as exported by Chrome, Firefox, 1Password and Bitwarden.
  const iUrl = col('url', 'website', 'login_uri', 'site', 'uri');
  const iUser = col('username', 'login_username', 'login', 'email', 'account');
  const iPass = col('password', 'login_password');
  const iName = col('name', 'title');
  const iNote = col('note', 'notes');

  if (iUrl < 0 || iPass < 0) {
    throw new Error('That file has no website or password column. Is it a password export?');
  }

  return rows.slice(1).map((r) => ({
    url: (r[iUrl] || '').trim(),
    username: iUser >= 0 ? (r[iUser] || '').trim() : '',
    password: iPass >= 0 ? r[iPass] || '' : '',
    title: iName >= 0 ? (r[iName] || '').trim() : '',
    notes: iNote >= 0 ? (r[iNote] || '').trim() : '',
  })).filter((e) => e.url && e.password);
}

$('csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  result('csv-result', 'Reading…');

  try {
    const entries = csvToEntries(await file.text());
    if (!entries.length) {
      result('csv-result', 'No usable rows in that file.', true);
      return;
    }
    const res = await rpc(M.IMPORT_ENTRIES, { entries });
    if (!res.ok) throw new Error(res.error);
    result(
      'csv-result',
      `Added ${res.added}, updated ${res.updated}, skipped ${res.skipped}. `
      + 'Now delete the file you imported — it is not encrypted.',
    );
  } catch (err) {
    result('csv-result', err.message, true);
  } finally {
    e.target.value = '';
  }
});

/* -------------------------------------------------------------------- backup */

$('btn-export').addEventListener('click', async () => {
  const res = await rpc(M.EXPORT_VAULT);
  if (!res.ok || !res.blob) {
    result('backup-result', res.error || 'Nothing to back up yet.', true);
    return;
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(res.blob, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `password-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  result('backup-result', 'Backup downloaded.');
});

$('btn-restore-pick').addEventListener('click', () => $('restore-file').click());

$('restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const res = await rpc(M.RESTORE_VAULT, { blob: JSON.parse(await file.text()) });
    if (!res.ok) throw new Error(res.error);
    result('backup-result', 'Restored. Unlock with the master password that backup was made under.');
    setTimeout(() => location.reload(), 1400);
  } catch {
    result('backup-result', 'That file could not be restored.', true);
  } finally {
    e.target.value = '';
  }
});

/* ------------------------------------------------------------------ settings */

function bindSetting(id, key, read) {
  $(id).addEventListener('change', async (e) => {
    settings = (await rpc(M.SET_SETTINGS, { patch: { [key]: read(e.target) } })).settings;
  });
}

bindSetting('autolock', 'autoLockMinutes', (el) => Number(el.value));
bindSetting('clipboard', 'clipboardClearSeconds', (el) => Number(el.value));
bindSetting('autosave', 'autoSavePrompt', (el) => el.checked);
bindSetting('autosave-silent', 'autoSaveSilently', (el) => el.checked);

// Saving silently is a mode of the save offer, so it means nothing while that is off.
$('autosave').addEventListener('change', (e) => {
  $('autosave-silent').disabled = !e.target.checked;
});
bindSetting('suggest', 'suggestOnFocus', (el) => el.checked);
bindSetting('autosubmit', 'autoSubmit', (el) => el.checked);
bindSetting('lockidle', 'lockOnSystemIdle', (el) => el.checked);

$('btn-shortcuts').addEventListener('click', () => {
  // A plain link to a chrome:// URL is blocked; tabs.create is not.
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('btn-dismiss-welcome').addEventListener('click', () => {
  $('welcome').hidden = true;
  history.replaceState(null, '', location.pathname);
});

/* --------------------------------------------------------- master + unlocking */

$('form-master').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = $('master-new').value;
  if (next.length < 8) {
    result('master-result', 'Use at least 8 characters.', true);
    return;
  }
  if (next !== $('master-new2').value) {
    result('master-result', 'The two new passwords do not match.', true);
    return;
  }
  const res = await rpc(M.CHANGE_MASTER, {
    oldPassword: $('master-old').value,
    newPassword: next,
  });
  if (!res.ok) {
    result('master-result', res.error, true);
    return;
  }
  $('form-master').reset();
  result('master-result', 'Master password changed.');
  await refreshBiometric();
});

$('form-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await rpc(M.UNLOCK, { password: $('unlock-pw').value });
  if (!res.ok) {
    $('unlock-error').textContent = res.error;
    $('unlock-error').hidden = false;
    $('unlock-pw').select();
    return;
  }
  location.reload();
});

init().catch(() => {
  document.body.textContent = 'Password Vault settings could not load. Try reopening this page.';
});
