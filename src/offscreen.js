// Offscreen document: clipboard access on behalf of the service worker, which has no DOM.
//
// Only ever asked to clear the clipboard, and only when it still holds the value that was
// copied -- compared by hash, so the secret itself is never passed here or stored.

const scratch = document.getElementById('scratch');

function readClipboard() {
  scratch.value = '';
  scratch.focus();
  document.execCommand('paste');
  const text = scratch.value;
  scratch.value = '';
  return text;
}

function writeClipboard(text) {
  scratch.value = text;
  scratch.select();
  document.execCommand('copy');
  scratch.value = '';
}

async function sha256B64(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'CLEAR_IF_MATCHES') {
    (async () => {
      try {
        const current = readClipboard();
        // Nothing copied since, or the user has already moved on -- either way, only
        // overwrite when the secret is still sitting there.
        if (current && (await sha256B64(current)) === msg.hash) {
          writeClipboard('');
          sendResponse({ cleared: true });
        } else {
          sendResponse({ cleared: false });
        }
      } catch {
        sendResponse({ cleared: false });
      }
    })();
    return true;
  }

  return false;
});
