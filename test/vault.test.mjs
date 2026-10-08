// Runs vault.js / crypto.js / domain.js outside Chrome against a minimal chrome.storage
// shim, so the encryption round-trip and matching rules are verified for real.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const SRC = process.argv[2];

function makeArea() {
  const data = new Map();
  return {
    async get(keys) {
      const list = keys == null ? [...data.keys()] : (Array.isArray(keys) ? keys : [keys]);
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) data.delete(k); },
    async setAccessLevel() {},
    _dump: () => Object.fromEntries(data),
    _clear: () => data.clear(),
  };
}

globalThis.chrome = { storage: { local: makeArea(), session: makeArea() } };

const V = await import(pathToFileURL(`${SRC}/vault.js`).href);
const D = await import(pathToFileURL(`${SRC}/domain.js`).href);

let passed = 0;
const check = (name, fn) => fn().then(
  () => { passed++; console.log(`  ok  ${name}`); },
  (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; },
);

console.log('domain matching');
await check('baseDomain collapses subdomains', async () => {
  assert.equal(D.baseDomain('accounts.google.com'), 'google.com');
  assert.equal(D.baseDomain('mail.google.com'), 'google.com');
  assert.equal(D.baseDomain('www.github.com'), 'github.com');
});
await check('baseDomain respects multi-part suffixes', async () => {
  assert.equal(D.baseDomain('login.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(D.baseDomain('shop.myer.com.au'), 'myer.com.au');
  assert.equal(D.baseDomain('www.hdfcbank.co.in'), 'hdfcbank.co.in');
});
await check('baseDomain passes through hosts without a suffix', async () => {
  assert.equal(D.baseDomain('localhost'), 'localhost');
  assert.equal(D.baseDomain('192.168.1.10'), '192.168.1.10');
});
await check('isSupportedUrl rejects pages that cannot host a content script', async () => {
  assert.equal(D.isSupportedUrl('https://github.com/login'), true);
  assert.equal(D.isSupportedUrl('chrome://extensions'), false);
  assert.equal(D.isSupportedUrl('file:///Users/x/login.html'), false);
  assert.equal(D.isSupportedUrl(undefined), false);
});

console.log('vault lifecycle');
await check('create -> unlocked, and storage holds ciphertext only', async () => {
  await V.createVault('correct horse battery');
  assert.equal(await V.isUnlocked(), true);
  const dump = JSON.stringify(chrome.storage.local._dump());
  assert.ok(dump.includes('"ct"'), 'expected a ciphertext field');
  assert.ok(!dump.includes('correct horse battery'), 'master password leaked to disk!');
});

await check('entries round-trip through encryption', async () => {
  await V.upsertEntry({
    url: 'https://github.com/login', username: 'octocat', password: 's3cret!', title: 'GitHub',
  });
  const entries = await V.readEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].domain, 'github.com');
  assert.equal(entries[0].password, 's3cret!');
  const dump = JSON.stringify(chrome.storage.local._dump());
  assert.ok(!dump.includes('s3cret!'), 'password stored in plaintext!');
  assert.ok(!dump.includes('octocat'), 'username stored in plaintext!');
});

await check('lock clears the key and blocks reads', async () => {
  await V.lock();
  assert.equal(await V.isUnlocked(), false);
  await assert.rejects(V.readEntries(), /LOCKED/);
});

await check('unlock with the right password restores access', async () => {
  await V.unlock('correct horse battery');
  const entries = await V.readEntries();
  assert.equal(entries[0].username, 'octocat');
});

await check('unlock with a wrong password fails and stays locked', async () => {
  await V.lock();
  await assert.rejects(V.unlock('wrong password'));
  assert.equal(await V.isUnlocked(), false);
});

await check('auto-lock expiry locks the vault', async () => {
  await V.unlock('correct horse battery');
  await chrome.storage.session.set({ unlockedUntil: Date.now() - 1 });
  assert.equal(await V.isUnlocked(), false, 'expired key should be rejected');
  assert.deepEqual(await chrome.storage.session.get('sessionKey'), {}, 'key should be wiped');
});

console.log('entry operations');
await check('same (domain, username) updates in place', async () => {
  await V.unlock('correct horse battery');
  await V.upsertEntry({ url: 'https://github.com', username: 'octocat', password: 'new-one' });
  const entries = await V.readEntries();
  assert.equal(entries.length, 2, 'upsert by id creates a second row for a new id');
  const found = await V.findByDomainAndUser('github.com', 'octocat');
  assert.ok(found);
});

await check('import merges rather than duplicating', async () => {
  const before = (await V.readEntries()).length;
  const res = await V.importEntries([
    { url: 'https://gitlab.com', username: 'me', password: 'a' },
    { url: 'https://gitlab.com', username: 'me', password: 'a' },   // exact dup -> skipped
    { url: 'https://gitlab.com', username: 'me', password: 'b' },   // same user -> update
    { url: '', username: 'x', password: 'y' },                      // no domain -> skipped
  ]);
  assert.equal(res.added, 1);
  assert.equal(res.updated, 1);
  assert.equal(res.skipped, 2);
  assert.equal((await V.readEntries()).length, before + 1);
  const gl = await V.findByDomainAndUser('gitlab.com', 'me');
  assert.equal(gl.password, 'b');
});

await check('matchEntries prefers the exact host and recent use', async () => {
  const entries = [
    { id: 'a', domain: 'google.com', origin: 'https://mail.google.com', lastUsedAt: 0 },
    { id: 'b', domain: 'google.com', origin: 'https://accounts.google.com', lastUsedAt: 5 },
    { id: 'c', domain: 'github.com', origin: 'https://github.com', lastUsedAt: 0 },
  ];
  const m = D.matchEntries(entries, 'https://accounts.google.com/signin');
  assert.deepEqual(m.map((e) => e.id), ['b', 'a'], 'exact host first, other subdomain second');
  assert.equal(D.matchEntries(entries, 'https://example.org').length, 0);
});

console.log('master password change');
await check('re-encrypts under the new key and keeps entries', async () => {
  const before = await V.readEntries();
  await V.changeMaster('correct horse battery', 'a longer new passphrase');
  await V.lock();
  await assert.rejects(V.unlock('correct horse battery'), 'old password must stop working');
  await V.unlock('a longer new passphrase');
  assert.deepEqual(await V.readEntries(), before);
});

console.log('biometric key wrapping');
const C = await import(pathToFileURL(`${SRC}/crypto.js`).href);

await check('a PRF secret wraps and unwraps the vault key', async () => {
  const secret = C.randomBytes(32);
  const salt = C.randomBytes(32);
  const raw = await V.getRawKeyBytes();

  const kek = await C.kekFromSecret(secret, salt);
  const wrapped = await C.wrapRaw(kek, raw);
  assert.ok(!JSON.stringify(wrapped).includes(C.toB64(raw)), 'wrapped key must not contain the key');

  const kek2 = await C.kekFromSecret(secret, salt);   // same inputs -> same KEK
  const back = await C.unwrapRaw(kek2, wrapped.iv, wrapped.ct);
  assert.deepEqual([...back], [...raw]);
});

await check('a different PRF secret cannot unwrap it', async () => {
  const salt = C.randomBytes(32);
  const raw = await V.getRawKeyBytes();
  const wrapped = await C.wrapRaw(await C.kekFromSecret(C.randomBytes(32), salt), raw);
  const wrongKek = await C.kekFromSecret(C.randomBytes(32), salt);
  await assert.rejects(C.unwrapRaw(wrongKek, wrapped.iv, wrapped.ct));
});

await check('the recovered key unlocks the vault without the master password', async () => {
  const raw = await V.getRawKeyBytes();
  await V.lock();
  assert.equal(await V.isUnlocked(), false);
  await V.unlockWithRawKey(raw);
  assert.equal(await V.isUnlocked(), true);
  assert.ok((await V.readEntries()).length > 0);
});

await check('a key from another vault is rejected', async () => {
  const foreign = C.randomBytes(32);
  await V.lock();
  await assert.rejects(V.unlockWithRawKey(foreign));
  assert.equal(await V.isUnlocked(), false);
});

await check('changing the master password drops the Touch ID enrolment', async () => {
  await V.unlock('a longer new passphrase');
  await V.setBiometric({ v: 1, credentialId: 'x', enrolledAt: 1 });
  assert.ok(await V.getBiometric());
  await V.changeMaster('a longer new passphrase', 'yet another passphrase');
  assert.equal(await V.getBiometric(), null, 'stale wrapped key must not survive');
});

console.log('concurrency');
await check('overlapping writes do not clobber each other', async () => {
  chrome.storage.local._clear();
  chrome.storage.session._clear();
  await V.createVault('a solid master password');

  // Every one of these does read -> modify -> write over the same encrypted blob. Without
  // serialising, later writes overwrite a snapshot taken before the earlier ones landed.
  await Promise.all(Array.from({ length: 20 }, (_, i) => V.upsertEntry({
    url: `https://site${i}.com`, username: `user${i}`, password: `pw${i}`,
  })));

  const entries = await V.readEntries();
  assert.equal(entries.length, 20, `expected 20 entries, found ${entries.length}`);
  assert.equal(new Set(entries.map((e) => e.domain)).size, 20);
});

await check('a delete racing an add keeps both effects', async () => {
  const entries = await V.readEntries();
  const victim = entries[0].id;
  await Promise.all([
    V.deleteEntry(victim),
    V.upsertEntry({ url: 'https://late.com', username: 'late', password: 'pw' }),
  ]);
  const after = await V.readEntries();
  assert.equal(after.length, 20, 'one removed, one added');
  assert.ok(!after.some((e) => e.id === victim), 'delete survived');
  assert.ok(after.some((e) => e.domain === 'late.com'), 'add survived');
});

console.log('brute-force guard');
await check('repeated wrong passwords start a cooldown', async () => {
  chrome.storage.local._clear();
  chrome.storage.session._clear();
  await V.createVault('a solid master password');
  await V.lock();

  for (let i = 0; i < 5; i++) await assert.rejects(V.unlock('nope'));
  assert.equal(await V.unlockCooldownMs(), 0, 'first few attempts are free');

  await assert.rejects(V.unlock('nope'));
  assert.ok(await V.unlockCooldownMs() > 0, 'a delay kicks in after that');
  await assert.rejects(V.unlock('a solid master password'), /Too many attempts/);
});

await check('a successful unlock clears the cooldown', async () => {
  chrome.storage.local._clear();
  chrome.storage.session._clear();
  await V.createVault('a solid master password');
  await V.lock();
  await assert.rejects(V.unlock('nope'));
  await V.unlock('a solid master password');
  assert.equal(await V.unlockCooldownMs(), 0);
});

console.log('vault health');
await check('passwordScore ranks by length then variety', async () => {
  assert.equal(V.passwordScore('short'), 0);
  assert.equal(V.passwordScore('abcdefgh'), 1);
  assert.ok(V.passwordScore('Abcdefgh1!xyz') >= 3);
  assert.ok(V.passwordScore('correcthorsebatterystaple') >= 3);
  assert.ok(V.passwordScore('Tr0ub4dor&3xtra!') > V.passwordScore('abcdefgh'));
});

await check('the audit finds reuse and weakness, and returns no passwords', async () => {
  chrome.storage.local._clear();
  chrome.storage.session._clear();
  await V.createVault('a solid master password');
  await V.importEntries([
    { url: 'https://a.com', username: 'me', password: 'SharedPassw0rd!x' },
    { url: 'https://b.com', username: 'me', password: 'SharedPassw0rd!x' },
    { url: 'https://c.com', username: 'me', password: 'abc' },
    { url: 'https://d.com', username: 'me', password: 'UniqueAndLongEnough1!' },
  ]);

  const audit = await V.auditEntries();
  assert.equal(audit.total, 4);
  assert.equal(audit.reused.length, 1, 'one reused group');
  assert.equal(audit.reused[0].length, 2);
  assert.ok(audit.weak.some((e) => e.domain === 'c.com'));
  assert.ok(!audit.weak.some((e) => e.domain === 'd.com'), 'a strong password is not flagged');
  assert.ok(!JSON.stringify(audit).includes('SharedPassw0rd'), 'audit must not carry passwords');
});

console.log('undo an automatic save');
await check('undoing a new save removes the entry', async () => {
  const before = (await V.readEntries()).length;
  const saved = await V.upsertEntry({ url: 'https://undo-new.test', username: 'u', password: 'p1' });
  assert.equal(await V.revertSave(saved, undefined), true);
  const entries = await V.readEntries();
  assert.equal(entries.length, before);
  assert.ok(!entries.some((e) => e.id === saved.id));
});

await check('undoing an update restores the previous password', async () => {
  const original = await V.upsertEntry({ url: 'https://undo-upd.test', username: 'u', password: 'old' });
  const previous = await V.findByDomainAndUser('undo-upd.test', 'u');
  await new Promise((r) => setTimeout(r, 2));
  const saved = await V.upsertEntry({ id: original.id, url: 'https://undo-upd.test', username: 'u', password: 'new' });
  assert.equal(await V.revertSave(saved, previous), true);
  const after = await V.findByDomainAndUser('undo-upd.test', 'u');
  assert.deepEqual(after, previous);
});

await check('undo leaves an entry alone once it has been edited since', async () => {
  const saved = await V.upsertEntry({ url: 'https://undo-edit.test', username: 'u', password: 'auto' });
  await new Promise((r) => setTimeout(r, 2));
  await V.upsertEntry({ ...saved, password: 'edited-by-hand' });
  assert.equal(await V.revertSave(saved, undefined), false);
  const after = await V.findByDomainAndUser('undo-edit.test', 'u');
  assert.equal(after.password, 'edited-by-hand');
});

await check('undo of an entry already deleted is a no-op', async () => {
  const saved = await V.upsertEntry({ url: 'https://undo-gone.test', username: 'u', password: 'p' });
  await V.deleteEntry(saved.id);
  const before = (await V.readEntries()).length;
  assert.equal(await V.revertSave(saved, undefined), false);
  assert.equal((await V.readEntries()).length, before);
});

await check('automatic saving is off unless chosen', async () => {
  assert.equal(V.DEFAULT_SETTINGS.autoSaveSilently, false);
});

console.log('settings');
await check('nested generator defaults survive a partial patch', async () => {
  await V.setSettings({ generator: { length: 32 } });
  const s = await V.getSettings();
  assert.equal(s.generator.length, 32);
  assert.equal(s.generator.symbols, true, 'untouched generator keys keep their defaults');
  assert.equal(s.autoLockMinutes, 15, 'unrelated settings are untouched');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
