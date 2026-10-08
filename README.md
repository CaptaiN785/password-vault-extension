# Password Vault

A Manifest V3 Chrome extension that keeps your logins in a locally encrypted vault, fills
them into a page with a keyboard shortcut or a click, and saves new ones as you sign in.

No build step, no dependencies, no network access. Plain JS, HTML and CSS.

---

## The one thing to know first

**A Chrome extension cannot read Chrome's built-in password manager.** There is no API for
it, and no extension — 1Password, Bitwarden or otherwise — can reach it. This extension
therefore keeps its own vault.

To bring your existing passwords across, use Chrome's own export, once:

> Chrome → Settings → Autofill and passwords → Google Password Manager → Settings →
> **Export passwords**

then load that file in **Settings → Import**. The exported file is plaintext — delete it as
soon as the import finishes.

---

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select this `password-vault/` folder.
4. Click the extension icon and create a master password.

| Action | macOS | Windows / Linux |
|---|---|---|
| Fill username and password | `⌘⇧L` | `Ctrl+Shift+L` |
| Save the credentials on this page | `⌘⇧Y` | `Ctrl+Shift+Y` |
| Open the vault | `⌘⇧P` | `Ctrl+Shift+P` |
| Lock the vault | unbound | unbound |

Chrome silently drops a suggested shortcut another extension already claimed; Settings shows
"not set" when that happens, and links to `chrome://extensions/shortcuts`.

## Using it

- **Fill** — click into a login box and pick from the list that appears, or press the fill
  shortcut. One saved login fills straight away; several show a picker (arrows, Enter,
  Escape). The caret lands in the password box so Enter submits.
- **Save** — sign in as usual and accept the *Save password?* prompt, or press the save
  shortcut at any time. **Never here** stops the prompt for that site.
  Prefer no prompt? Settings → *Save it straight away instead of asking*: the login is
  saved on submit and a card offers **Undo** for 10 seconds.
- **Manage** — the popup lists logins for the current site first. Search matches names,
  sites, usernames and notes; Enter fills the top result.
- **Touch ID** — Settings → Touch ID. Unlock with a fingerprint instead of typing your
  master password.
- **Security check** — Settings → Security check finds reused and weak passwords. It runs
  entirely on your machine; nothing is sent anywhere.

## How it works

| File | Role |
|---|---|
| `src/crypto.js` | PBKDF2-SHA256 (600k iterations) → AES-GCM-256; encryption and key wrapping |
| `src/vault.js` | Storage, locking, entry CRUD, import merge, health check |
| `src/domain.js` | Registrable-domain matching, so `mail.` and `accounts.` share one login |
| `src/biometric.js` | Touch ID enrolment and unlock via the WebAuthn PRF extension |
| `src/background.js` | Service worker: commands, frame routing, save prompts, RPC |
| `src/offscreen.js` | Clipboard access for the worker, which has no DOM |
| `src/content/content.js` | Field detection, filling, capture, in-page overlays |
| `src/popup/`, `src/options/` | The two user interfaces |

Five details are load-bearing:

**Filling goes through the native setter.** React and Vue track an input's value on the DOM
node and ignore a plain `el.value = x`, so the fill writes via
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and then fires
`input` and `change`. `test/react.html` reproduces React's tracker so this stays honest.

**Detection scopes to one form.** A page can hold several login forms. `detect()` narrows to
the form owning the triggering event — the submitted form, the clicked button, or the
focused input — and only falls back to a document-wide search when there is none. Without
it, filling and saving silently target the first password field on the page.

**The unlocked key lives in `chrome.storage.session`.** MV3 kills the service worker after
seconds of idle, so an in-memory key would mean re-typing the master password constantly.
Session storage is memory-only, wiped when Chrome exits, and pinned to `TRUSTED_CONTEXTS`
so content scripts cannot read it.

**Every vault mutation is serialised.** Entry changes are read-modify-write over one
encrypted blob, so two overlapping callers would each decrypt the same snapshot and the
second write would drop the first. A promise queue in `vault.js` prevents it — with a test
that fails loudly if the queue is removed.

**Touch ID derives a key, it does not merely gate one.** Enrolment creates a platform
passkey with the WebAuthn PRF extension; the Secure Enclave produces a stable secret only
after a successful fingerprint check, and the vault key is stored wrapped under a KEK
derived from it. Copying the Chrome profile elsewhere yields a wrapped key that will not
open. Changing the master password invalidates the enrolment, because the wrapped key no
longer matches.

## Security

- One AES-GCM-256 blob in `chrome.storage.local`. No entry metadata — not even the site
  list — is readable without the key.
- The master password is never stored in any form. **There is no recovery.** Keep a backup
  (Settings → Backup); it is encrypted and useless without the password.
- A wrong password is caught by GCM authentication failing, so there is no separate password
  hash to attack. Repeated wrong attempts trigger an escalating cooldown.
- The vault locks on inactivity, when the machine goes idle, and whenever Chrome quits.
- Copied passwords are cleared from the clipboard after 30 seconds — and only if the
  clipboard still holds them, compared by hash so the secret is never stored to check.
- Page contexts receive usernames and titles to draw a menu; a password crosses that
  boundary once, on an explicit choice. The overlay lives in a closed shadow root and leaves
  no attributes in the page.

**Honest limits.** There is no sync, and while the vault is *unlocked* anything with access
to your Chrome profile can reach the key. For the highest-value accounts — banking, primary
email, work SSO — use a dedicated password manager.

## Testing

Logic tests run under Node against a `chrome.storage` shim, no browser needed:

```sh
npm test          # 31 checks: encryption, locking, matching, concurrency, audit, undo
npm run check     # syntax-check every source file
```

Browser fixtures, each isolating one thing that commonly breaks autofill:

```sh
npm run fixtures  # serves test/ on :8000
```

then open `http://localhost:8000/login.html`. Save a login for `localhost` first. Content
scripts do not run on `file://` URLs, which is why this needs a server.

| Fixture | What it proves |
|---|---|
| `plain.html` | The baseline: a real form with autocomplete hints |
| `react.html` | The fill goes through the native value setter, not a plain assignment |
| `shadow.html` | Inputs inside an open shadow root are found |
| `frame.html` | Picker and fill are routed to the child frame, not the top document |
| `multi.html` | Fill and save target the form your caret is in, not the first on the page |

Worth checking by hand:

- `chrome.storage.local.get(console.log)` in the service worker console — only
  `{v, kdf, iv, ct}`, no plaintext.
- Hit **Terminate** on the service worker at `chrome://extensions`, then fill: it must still
  work, proving the vault survives a worker restart.
- Quit Chrome and reopen: it must ask for the master password again.

## Development notes

Reloading an unpacked extension orphans the content script in already-open tabs. The worker
re-injects on install and update, and the injection guard is keyed on the manifest version
so a newer build can take over from a stale one. Bump `version` in `manifest.json` when
changing the content script.
