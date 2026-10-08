# Chrome Web Store listing — prepared copy

Everything the listing form asks for, ready to paste. Fields marked **YOU** need a decision
or an asset only you can provide.

---

## Store listing tab

**Item name** (45 chars max) — **YOU**
`Password Vault` is almost certainly taken; the store rejects confusingly similar names.
Pick a distinctive one, e.g. `Keyhold — Local Password Vault` or `Strongbox Local`.

**Short description** (132 chars max)

```
Encrypted password vault that fills your logins with a keyboard shortcut or a click. Everything stays on your computer.
```

**Detailed description**

```
Password Vault keeps your logins in an encrypted vault on your own computer and fills them
into sign-in forms for you. Nothing is uploaded, synced, or sent anywhere — there is no
account to create and no server involved.

FILLING
• Click into a username box and pick from your saved logins, or press the fill shortcut
  (Cmd+Shift+L / Ctrl+Shift+L).
• Works on ordinary forms, single-page apps, forms inside iframes, and inputs built with
  web components — the places autofill usually gives up.
• When several logins match a site, a picker appears next to the field. Arrow keys and
  Enter, or click.

SAVING
• Sign in as usual and accept the "Save password?" prompt, or press Cmd+Shift+Y at any time.
• "Never here" stops the prompt for a site you do not want saved.
• Or let it save straight away on sign-in, with an Undo if you did not want it.

SECURITY
• Your vault is encrypted with AES-GCM-256. The key is derived from your master password
  using PBKDF2-SHA256 at 600,000 iterations.
• Your master password is never stored anywhere, in any form.
• The vault locks on inactivity, when your computer goes idle, and whenever Chrome quits.
• Copied passwords are cleared from the clipboard automatically — and only if the clipboard
  still holds them.
• Repeated wrong master-password attempts trigger an escalating delay.

TOUCH ID (macOS)
Unlock with your fingerprint instead of typing your master password. This uses the Secure
Enclave through WebAuthn: the key that opens your vault is stored wrapped under a secret
that only exists after a successful fingerprint check.

BRINGING YOUR PASSWORDS ACROSS
Chrome does not let any extension read its built-in password manager. To move your existing
passwords in, export them from Chrome (Settings → Autofill and passwords → Google Password
Manager → Settings → Export passwords) and import the file in this extension's settings.
Delete the exported file afterwards — it is not encrypted.

SECURITY CHECK
Find reused and weak passwords across your vault. The check runs entirely on your machine;
no password is ever sent anywhere, not even in hashed form.

WHAT THIS IS NOT
There is no sync between devices and no cloud backup. If you forget your master password,
your vault cannot be recovered — export an encrypted backup and keep it somewhere safe.
While the vault is unlocked, anyone using your computer can see your saved logins, so lock
it when you step away.
```

**Category** — `Productivity`
**Language** — `English`

---

## Graphic assets — **YOU** (files must be uploaded)

| Asset | Size | Required |
|---|---|---|
| Store icon | 128×128 PNG | Yes — `icons/icon128.png` exists but is a plain placeholder |
| Screenshot | 1280×800 or 640×400 | Yes, at least 1 (up to 5) |
| Small promo tile | 440×280 | Only if you want to be featured |

Good screenshots to take: the popup with a few saved logins; the picker anchored under a
login field; the settings page; the security check results.

---

## Privacy tab

**Single purpose description**

```
Store the user's login credentials in an encrypted vault on their own device and fill them
into sign-in forms on websites at the user's request.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Stores the encrypted vault and the user's settings on their own device. |
| `scripting` | Locates sign-in forms across a page's frames so the correct field is filled. |
| `tabs` | Reads the current tab's address to show only the logins saved for that site. |
| `alarms` | Runs the auto-lock timer and the delayed clipboard clear. |
| `idle` | Locks the vault when the user steps away from the computer. |
| `offscreen` | Clears a copied password from the clipboard; the service worker has no DOM of its own. |
| `favicon` | Shows each saved site's icon in the list, using icons the browser has already cached. |
| `clipboardWrite` | Copies a username or password when the user clicks copy, and blanks the clipboard afterwards. |
| `clipboardRead` | Confirms the clipboard still holds the copied password before overwriting it, so unrelated clipboard content is never destroyed. |
| Host permission (`http://*/*`, `https://*/*`) | Sign-in forms exist on any site, so the extension must be able to detect and fill fields wherever the user chooses to log in. It reads and writes only login form fields, and only when the user asks it to. |

**Remote code** — `No, I am not using remote code.`
(True: no CDN, no eval, no remotely hosted scripts.)

**Data usage** — tick **Authentication information** only. Then certify:
- Not being sold to third parties ✓
- Not being used for purposes unrelated to the item's single purpose ✓
- Not being used to determine creditworthiness or for lending ✓

Nothing else should be ticked — the extension makes no network requests at all.

**Privacy policy URL** — **YOU**. Mandatory, because the extension handles authentication
information. Host `PRIVACY.md` somewhere public (a GitHub repo, a Gist, or GitHub Pages)
and paste the URL.

---

## Distribution tab — **YOU**

**Visibility** — decide between:
- **Private** — only you (or your Google Workspace) can install. Right choice for personal use.
- **Unlisted** — anyone with the link can install, not searchable.
- **Public** — listed in the store. Expect a slow, strict review: password managers with
  broad host permissions and clipboard access get heightened scrutiny.

---

## Before submitting

- The `name` and `description` in `manifest.json` must match the listing name you choose.
- Zip the folder's **contents** (manifest.json at the root of the zip, not inside a folder),
  and exclude `test/`, `package.json`, `store-listing.md` and `PRIVACY.md` from the upload.
