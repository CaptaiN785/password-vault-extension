// Touch ID unlock, built on the WebAuthn PRF extension.
//
// The important property: this is NOT a decorative "prove it's you, then read the key off
// disk" gate. PRF returns a stable 32-byte secret that only the platform authenticator can
// produce, and only after a successful user-verification (Touch ID). We derive a KEK from
// that secret and use it to wrap the vault's AES key. The wrapped key on disk is useless
// to anyone who cannot pass the fingerprint check -- copying the Chrome profile does not
// get them in.
//
// The master password remains the root credential. Touch ID is a second door to the same
// key, never a replacement, and changing the master password invalidates the enrolment.

import * as C from './crypto.js';

const RP_NAME = 'Password Vault';
const TIMEOUT = 60000;

// On a chrome-extension:// page, location.hostname is the extension id, which is the
// only RP ID Chrome will accept for an extension origin.
function rpId() {
  return location.hostname;
}

function bufToBytes(buf) {
  return new Uint8Array(buf);
}

/* ---------------------------------------------------------------- capability */

export async function isSupported() {
  if (!window.PublicKeyCredential) return { ok: false, reason: 'WebAuthn is unavailable.' };

  const uvpa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    .catch(() => false);
  if (!uvpa) {
    return { ok: false, reason: 'No built-in authenticator (Touch ID) on this device.' };
  }

  // getClientCapabilities is Chrome 133+; older builds simply have to try and see.
  if (PublicKeyCredential.getClientCapabilities) {
    const caps = await PublicKeyCredential.getClientCapabilities().catch(() => null);
    if (caps && caps['extension:prf'] === false) {
      return { ok: false, reason: 'This Chrome build does not support the WebAuthn PRF extension.' };
    }
  }
  return { ok: true };
}

/* ----------------------------------------------------------------- enrolment */

// Registers a platform passkey and wraps `rawKeyBytes` (the vault's AES key) under a KEK
// derived from that credential's PRF output. Returns the record to persist.
export async function enroll(rawKeyBytes) {
  const salt = C.randomBytes(32);
  const prfInput = C.randomBytes(32);

  const created = await navigator.credentials.create({
    publicKey: {
      challenge: C.randomBytes(32),
      rp: { id: rpId(), name: RP_NAME },
      user: {
        id: C.randomBytes(16),
        name: 'vault@local',
        displayName: 'Password Vault',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },    // ES256
        { type: 'public-key', alg: -257 },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      // Asking for eval up front lets Chrome return the secret from the create() call on
      // authenticators that allow it, saving the user a second Touch ID prompt.
      extensions: { prf: { eval: { first: prfInput } } },
      timeout: TIMEOUT,
    },
  });

  if (!created) throw new Error('Enrolment was cancelled.');

  const ext = created.getClientExtensionResults();
  if (!ext.prf || ext.prf.enabled === false) {
    throw new Error(
      'This authenticator will not produce a PRF secret, so it cannot unlock the vault.',
    );
  }

  const credentialId = C.toB64(bufToBytes(created.rawId));

  // Some authenticators only evaluate PRF on an assertion, not at creation time.
  let secret = ext.prf.results && ext.prf.results.first;
  if (!secret) {
    secret = await evaluatePrf(credentialId, prfInput);
  }

  const kek = await C.kekFromSecret(bufToBytes(secret), salt);
  const wrapped = await C.wrapRaw(kek, rawKeyBytes);

  return {
    v: 1,
    credentialId,
    prfInput: C.toB64(prfInput),
    salt: C.toB64(salt),
    wrapped,
    enrolledAt: Date.now(),
  };
}

/* -------------------------------------------------------------------- unlock */

async function evaluatePrf(credentialIdB64, prfInputBytes) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: C.randomBytes(32),
      rpId: rpId(),
      allowCredentials: [{
        type: 'public-key',
        id: C.fromB64(credentialIdB64),
        transports: ['internal'],
      }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfInputBytes } } },
      timeout: TIMEOUT,
    },
  });

  if (!assertion) throw new Error('Touch ID was cancelled.');

  const results = assertion.getClientExtensionResults().prf;
  if (!results || !results.results || !results.results.first) {
    throw new Error('The authenticator returned no PRF secret.');
  }
  return results.results.first;
}

// Prompts for Touch ID and returns the vault's raw AES key bytes.
export async function unlock(record) {
  if (!record || record.v !== 1) throw new Error('Touch ID is not set up for this vault.');

  const secret = await evaluatePrf(record.credentialId, C.fromB64(record.prfInput));
  const kek = await C.kekFromSecret(bufToBytes(secret), C.fromB64(record.salt));

  try {
    return await C.unwrapRaw(kek, record.wrapped.iv, record.wrapped.ct);
  } catch {
    // Wrong secret -> GCM authentication failure. In practice this means the enrolment no
    // longer matches the vault (master password changed, or the vault was restored).
    throw new Error('Touch ID no longer matches this vault. Unlock with your master password and re-enrol.');
  }
}
