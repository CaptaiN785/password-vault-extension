# Privacy Policy — Password Vault

_Last updated: 20 August 2026_

## Summary

Password Vault does not collect, transmit, or share any of your data. It makes no network
requests. Everything it stores stays on your own computer.

## What the extension stores

Password Vault stores the logins you choose to save — website address, username, password,
and any notes you add — together with your settings.

All of it is encrypted with AES-GCM-256 before being written to your browser's local
extension storage. The encryption key is derived from your master password using
PBKDF2-SHA256 with 600,000 iterations. Your master password itself is never stored, in any
form, anywhere.

If you turn on Touch ID unlock, a second copy of the encryption key is stored wrapped under
a key that your Mac's Secure Enclave will only reproduce after a successful fingerprint
check.

## What the extension sends

Nothing. Password Vault has no server, no account system, no analytics, no crash reporting,
and no telemetry. It makes no outbound network requests of any kind. Your data cannot be
sold or shared because it never leaves your device.

## What the extension reads

To fill a login, the extension needs to see the page you are on:

- **The current tab's address**, so it can offer only the logins saved for that site.
- **Sign-in form fields on pages you visit**, so it can put your username and password in
  the right boxes.

It reads and writes only login form fields, only on your instruction, and it does not record
your browsing history or the content of pages.

## Clipboard

When you copy a username or password, it goes to your system clipboard. After a delay you
control (30 seconds by default), the extension clears it — but only after checking that the
clipboard still holds what it put there, so anything you copied since is left alone. That
check compares a cryptographic hash, so the copied value is never stored to perform it.

## Data you export

The backup file the extension produces is encrypted and cannot be read without your master
password. If you import passwords from a browser's export file, that file is plaintext and
is created by your browser, not by this extension — delete it once the import is done.

## Deleting your data

Removing the extension from Chrome deletes its stored data. You can also delete individual
logins at any time from the extension's list.

## Recovery

There is no recovery mechanism. If you forget your master password, your vault cannot be
decrypted by anyone, including the developer. Keep an encrypted backup.

## Contact

<!-- Replace with the address you want listed publicly. -->
_Add a contact email address here before publishing._
