// Vault storage layer.
//
// At rest (chrome.storage.local):  { v, kdf: {salt, iterations}, iv, ct }  -- ciphertext only.
// While unlocked (chrome.storage.session): the raw AES key + an expiry timestamp.
//
// chrome.storage.session is memory-only and wiped when Chrome exits, which is the lifetime
// we want for an unlocked key. It also survives service-worker restarts; an in-memory
// variable would not, and MV3 kills the worker after seconds of idle.

import * as C from './crypto.js';
import { baseDomain, hostnameOf, originOf } from './domain.js';

const K_VAULT = 'vault';
const K_SETTINGS = 'settings';
const K_BIOMETRIC = 'biometric';
const K_GUARD = 'unlockGuard';
const S_KEY = 'sessionKey';
const S_UNTIL = 'unlockedUntil';

export const VAULT_VERSION = 1;

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 15,
  lockOnSystemIdle: true,
  clipboardClearSeconds: 30,
  neverSave: [],
  autoSavePrompt: true,
  autoSaveSilently: false,
  suggestOnFocus: true,
  autoSubmit: false,
  generator: { length: 20, upper: true, digits: true, symbols: true, ambiguous: false },
};

// Content scripts (and so, indirectly, web pages) must never read the key.
export async function hardenSessionStorage() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older builds already default to TRUSTED_CONTEXTS.
  }
}

/* --------------------------------------------------------------- serialising */

// Entry mutations are read-modify-write over the whole encrypted blob. Two overlapping
// callers -- a save prompt resolving while the popup writes an edit, say -- would each
// decrypt the same snapshot, and the second write would silently drop the first. Every
// mutation goes through this queue instead.
let chain = Promise.resolve();

function serialize(fn) {
  const result = chain.then(fn);
  chain = result.then(() => {}, () => {});
  return result;
}

/* ------------------------------------------------------------------ settings */

export async function getSettings() {
  const { [K_SETTINGS]: s } = await chrome.storage.local.get(K_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    generator: { ...DEFAULT_SETTINGS.generator, ...((s && s.generator) || {}) },
  };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}

/* --------------------------------------------------------------- vault state */

export async function getVaultBlob() {
  const { [K_VAULT]: v } = await chrome.storage.local.get(K_VAULT);
  return v || null;
}

function assertReadable(blob) {
  if (!blob) throw new Error('No vault has been created yet.');
  if (typeof blob.v !== 'number' || blob.v > VAULT_VERSION) {
    throw new Error('This vault was created by a newer version of the extension.');
  }
}

export async function hasVault() {
  return (await getVaultBlob()) !== null;
}

export async function isUnlocked() {
  return (await getKey()) !== null;
}

export async function getKey() {
  const { [S_KEY]: raw, [S_UNTIL]: until } = await chrome.storage.session.get([S_KEY, S_UNTIL]);
  if (!raw) return null;
  if (until && Date.now() > until) {
    await lock();
    return null;
  }
  return C.importKey(raw);
}

async function storeKey(key) {
  const { autoLockMinutes } = await getSettings();
  await chrome.storage.session.set({
    [S_KEY]: await C.exportKey(key),
    [S_UNTIL]: Date.now() + autoLockMinutes * 60000,
  });
}

// Active use keeps the vault open; the auto-lock clock measures idleness, not uptime.
export async function touchUnlock() {
  const { [S_KEY]: raw } = await chrome.storage.session.get(S_KEY);
  if (!raw) return;
  const { autoLockMinutes } = await getSettings();
  await chrome.storage.session.set({ [S_UNTIL]: Date.now() + autoLockMinutes * 60000 });
}

export async function lock() {
  await chrome.storage.session.remove([S_KEY, S_UNTIL]);
}

/* ---------------------------------------------------------- brute-force guard */

// The encrypted blob sits on disk, so anyone holding the file can attack it offline at
// their own pace -- that is what the 600k PBKDF2 iterations are for. This guard addresses
// the other case: someone at the keyboard of an unattended machine guessing interactively.
const GUARD_FREE_ATTEMPTS = 5;
const GUARD_MAX_DELAY_MS = 5 * 60 * 1000;

async function getGuard() {
  const { [K_GUARD]: g } = await chrome.storage.local.get(K_GUARD);
  return g || { fails: 0, nextAllowedAt: 0 };
}

export async function unlockCooldownMs() {
  const guard = await getGuard();
  return Math.max(0, guard.nextAllowedAt - Date.now());
}

async function recordFailure() {
  const guard = await getGuard();
  const fails = guard.fails + 1;
  const over = fails - GUARD_FREE_ATTEMPTS;
  const delay = over <= 0 ? 0 : Math.min(2 ** over * 1000, GUARD_MAX_DELAY_MS);
  await chrome.storage.local.set({
    [K_GUARD]: { fails, nextAllowedAt: Date.now() + delay },
  });
  return delay;
}

async function clearGuard() {
  await chrome.storage.local.remove(K_GUARD);
}

/* ----------------------------------------------------------- create / unlock */

export async function createVault(masterPassword) {
  if (await hasVault()) throw new Error('A vault already exists.');
  if (!masterPassword || masterPassword.length < 8) {
    throw new Error('Master password must be at least 8 characters.');
  }
  const salt = C.randomSalt();
  const key = await C.deriveKey(masterPassword, salt, C.DEFAULT_ITERATIONS);
  const { iv, ct } = await C.encryptJSON(key, []);
  await chrome.storage.local.set({
    [K_VAULT]: {
      v: VAULT_VERSION,
      kdf: { salt: C.toB64(salt), iterations: C.DEFAULT_ITERATIONS },
      iv,
      ct,
    },
  });
  await clearGuard();
  await storeKey(key);
}

export async function unlock(masterPassword) {
  const cooldown = await unlockCooldownMs();
  if (cooldown > 0) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  const blob = await getVaultBlob();
  assertReadable(blob);

  const key = await C.deriveKey(
    masterPassword, C.fromB64(blob.kdf.salt), blob.kdf.iterations,
  );

  try {
    // A wrong password fails GCM authentication here; that is the whole check.
    await C.decryptJSON(key, blob.iv, blob.ct);
  } catch {
    await recordFailure();
    throw new Error('WRONG_PASSWORD');
  }

  await clearGuard();
  await storeKey(key);
}

export function changeMaster(oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    return Promise.reject(new Error('Master password must be at least 8 characters.'));
  }
  return serialize(async () => {
    const blob = await getVaultBlob();
    assertReadable(blob);

    const oldKey = await C.deriveKey(
      oldPassword, C.fromB64(blob.kdf.salt), blob.kdf.iterations,
    );

    let entries;
    try {
      entries = await C.decryptJSON(oldKey, blob.iv, blob.ct);
    } catch {
      throw new Error('WRONG_PASSWORD');
    }

    const salt = C.randomSalt();
    const newKey = await C.deriveKey(newPassword, salt, C.DEFAULT_ITERATIONS);
    const { iv, ct } = await C.encryptJSON(newKey, entries);
    await chrome.storage.local.set({
      [K_VAULT]: {
        v: VAULT_VERSION,
        kdf: { salt: C.toB64(salt), iterations: C.DEFAULT_ITERATIONS },
        iv,
        ct,
      },
    });
    await storeKey(newKey);
    // The old key is gone, so any wrapped copy of it no longer opens this vault.
    await clearBiometric();
  });
}

/* ------------------------------------------------------------------ biometric */

export async function getBiometric() {
  const { [K_BIOMETRIC]: b } = await chrome.storage.local.get(K_BIOMETRIC);
  return b || null;
}

export async function setBiometric(record) {
  await chrome.storage.local.set({ [K_BIOMETRIC]: record });
}

export async function clearBiometric() {
  await chrome.storage.local.remove(K_BIOMETRIC);
}

// Handed to the enrolment flow so it can wrap the vault key under the Touch ID KEK.
export async function getRawKeyBytes() {
  const key = await getKey();
  if (!key) throw new Error('LOCKED');
  return C.fromB64(await C.exportKey(key));
}

// The biometric path recovers the AES key directly rather than deriving it from a
// password, so verify it actually opens this vault before accepting it.
export async function unlockWithRawKey(rawBytes) {
  const blob = await getVaultBlob();
  assertReadable(blob);
  const key = await C.importKey(C.toB64(rawBytes));
  await C.decryptJSON(key, blob.iv, blob.ct);
  await clearGuard();
  await storeKey(key);
}

/* --------------------------------------------------------------- entry access */

export async function readEntries() {
  const key = await getKey();
  if (!key) throw new Error('LOCKED');
  const blob = await getVaultBlob();
  assertReadable(blob);
  return C.decryptJSON(key, blob.iv, blob.ct);
}

async function writeEntriesNow(entries) {
  const key = await getKey();
  if (!key) throw new Error('LOCKED');
  const blob = await getVaultBlob();
  assertReadable(blob);
  const { iv, ct } = await C.encryptJSON(key, entries);
  await chrome.storage.local.set({ [K_VAULT]: { ...blob, iv, ct } });
  await touchUnlock();
}

export function writeEntries(entries) {
  return serialize(() => writeEntriesNow(entries));
}

// Read and write as one unit, so a concurrent mutation cannot land between them.
function mutate(fn) {
  return serialize(async () => {
    const entries = await readEntries();
    const result = await fn(entries);
    await writeEntriesNow(entries);
    return result;
  });
}

export function normaliseEntry(input) {
  const url = input.url || input.origin || '';
  const host = hostnameOf(url);
  const now = Date.now();
  return {
    id: input.id || C.newId(),
    title: (input.title || host || 'Untitled').trim(),
    domain: input.domain || baseDomain(host),
    origin: originOf(url) || input.origin || '',
    username: (input.username || '').trim(),
    password: input.password || '',
    notes: input.notes || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastUsedAt: input.lastUsedAt || 0,
  };
}

export function upsertEntry(input) {
  return mutate((entries) => {
    const entry = normaliseEntry(input);
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      entry.createdAt = entries[i].createdAt;
      entry.lastUsedAt = entries[i].lastUsedAt;
      entries[i] = entry;
    } else {
      entries.push(entry);
    }
    return entry;
  });
}

export function deleteEntry(id) {
  return mutate((entries) => {
    const i = entries.findIndex((e) => e.id === id);
    if (i >= 0) entries.splice(i, 1);
  });
}

// Undo for an automatic save: put back what was there before, unless the entry has been
// edited since -- reverting then would throw away a newer change.
export function revertSave(saved, previous) {
  return mutate((entries) => {
    const i = entries.findIndex((e) => e.id === saved.id);
    if (i < 0 || entries[i].updatedAt !== saved.updatedAt) return false;

    if (previous) entries[i] = previous;
    else entries.splice(i, 1);

    return true;
  });
}

export function markUsed(id) {
  return mutate((entries) => {
    const e = entries.find((x) => x.id === id);
    if (e) e.lastUsedAt = Date.now();
  });
}

// Used by the save flow: an existing (domain, username) pair is an update, not a new entry.
export async function findByDomainAndUser(domain, username) {
  const entries = await readEntries();
  const u = (username || '').trim().toLowerCase();
  return entries.find(
    (e) => e.domain === domain && (e.username || '').toLowerCase() === u,
  ) || null;
}

// Import merges rather than replaces: same (domain, username) updates in place.
export function importEntries(incoming) {
  return mutate((entries) => {
    const index = new Map(
      entries.map((e, i) => [`${e.domain} ${(e.username || '').toLowerCase()}`, i]),
    );
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of incoming) {
      const entry = normaliseEntry(raw);
      if (!entry.password || !entry.domain) { skipped++; continue; }
      const k = `${entry.domain} ${entry.username.toLowerCase()}`;
      if (index.has(k)) {
        const i = index.get(k);
        if (entries[i].password === entry.password) { skipped++; continue; }
        entry.id = entries[i].id;
        entry.createdAt = entries[i].createdAt;
        entry.lastUsedAt = entries[i].lastUsedAt;
        entries[i] = entry;
        updated++;
      } else {
        entries.push(entry);
        index.set(k, entries.length - 1);
        added++;
      }
    }
    return { added, updated, skipped };
  });
}

/* --------------------------------------------------------------- health check */

// Deliberately crude: length dominates, character variety is a tiebreak. Enough to flag
// "change this one" without pretending to be an entropy estimate.
export function passwordScore(password) {
  if (!password) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 8) return 0;
  if (password.length < 10) return 1;
  if (password.length < 12) return classes >= 3 ? 2 : 1;
  if (password.length < 16) return classes >= 3 ? 3 : 2;
  return classes >= 2 ? 4 : 3;
}

// Reuse and weakness are the two problems a local vault can find on its own, without
// sending anything anywhere. No password ever leaves this function.
export async function auditEntries() {
  const entries = await readEntries();

  const byPassword = new Map();
  for (const e of entries) {
    if (!e.password) continue;
    if (!byPassword.has(e.password)) byPassword.set(e.password, []);
    byPassword.get(e.password).push(e);
  }

  const strip = ({ id, title, domain, username }) => ({ id, title, domain, username });

  return {
    total: entries.length,
    reused: [...byPassword.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map(strip)),
    weak: entries
      .filter((e) => e.password && passwordScore(e.password) < 3)
      .map((e) => ({ ...strip(e), score: passwordScore(e.password) })),
  };
}
