// Crypto primitives for the vault.
//
// Master password --PBKDF2-SHA256--> AES-GCM-256 key --> one encrypted blob holding
// every entry. The master password itself is never stored, hashed or otherwise.

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const DEFAULT_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits, the size AES-GCM is specified for

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomSalt() {
  return randomBytes(SALT_BYTES);
}

// Extractable is required: the raw key is stashed in chrome.storage.session so the
// vault survives a service-worker restart without re-prompting for the master password.
export async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    'raw', ENC.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const plaintext = ENC.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: toB64(iv), ct: toB64(ct) };
}

// Throws on a wrong key -- AES-GCM authentication failure is how we detect a bad
// master password, so there is nothing else to verify against.
export async function decryptJSON(key, ivB64, ctB64) {
  const iv = fromB64(ivB64);
  const ct = fromB64(ctB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(DEC.decode(plaintext));
}

export async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(rawB64) {
  return crypto.subtle.importKey(
    'raw', fromB64(rawB64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

export function newId() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------- key wrapping (biometric) */

// The WebAuthn PRF extension hands back a raw 32-byte secret. Run it through HKDF
// rather than using it as an AES key directly, so the key is domain-separated from any
// other use of the same credential.
export async function kekFromSecret(secretBytes, saltBytes) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: ENC.encode('password-vault/biometric-kek/v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Wraps the vault's own AES key so Touch ID can recover it without the master password.
export async function wrapRaw(kek, rawBytes) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawBytes);
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function unwrapRaw(kek, ivB64, ctB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) }, kek, fromB64(ctB64),
  );
  return new Uint8Array(plain);
}

// Used to check whether the clipboard still holds a copied secret without storing the
// secret itself anywhere.
export async function sha256B64(text) {
  const digest = await crypto.subtle.digest('SHA-256', ENC.encode(text));
  return toB64(digest);
}
