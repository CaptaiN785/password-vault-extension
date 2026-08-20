// Content script: field detection, filling, capture, and the in-page overlays.
//
// Deliberately NOT an ES module, and it never touches crypto or the vault. It receives one
// credential at a time, in response to an explicit user action, and leaves nothing
// identifying in the page. Message-type strings are duplicated from src/messages.js
// because content scripts cannot import.

(() => {
  'use strict';

  // Reloading an unpacked extension orphans the content script already running in open
  // tabs: its listeners survive but its runtime connection is dead. The worker re-injects
  // on update, so the guard is keyed on the version rather than a plain boolean --
  // otherwise the stale script would block its own replacement.
  let VERSION = '0';
  try {
    VERSION = chrome.runtime.getManifest().version;
  } catch {
    return; // no runtime to talk to
  }
  if (window.__pwVaultBuild === VERSION) return;
  window.__pwVaultBuild = VERSION;

  const MSG = {
    PING: 'PING',
    DETECT: 'DETECT',
    FILL: 'FILL',
    CAPTURE: 'CAPTURE',
    TOAST: 'TOAST',
    PICK: 'PICK',
    SAVE_PROMPT: 'SAVE_PROMPT',
    SUBMIT_DETECTED: 'SUBMIT_DETECTED',
    SUGGEST_REQUEST: 'SUGGEST_REQUEST',
    FILL_ENTRY: 'FILL_ENTRY',
  };

  const USER_HINT = /user|email|e-mail|login|account|identifier|signin|sign-in|handle|phone/i;
  const NOT_USER_HINT = /search|captcha|otp|one-?time|verification|coupon|promo|zip|postal|card|cvv/i;
  const SUBMIT_TEXT = /log ?in|sign ?in|submit|continue|next|entrar|anmelden|se connecter/i;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null); // extension reloaded out from under us
      }
    });
  }

  /* ------------------------------------------------------------ DOM helpers */

  // Walks open shadow roots too -- plenty of login forms are inside web components.
  function deepQueryAll(root, predicate) {
    const out = [];
    const visit = (node) => {
      let els;
      try {
        els = node.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of els) {
        if (predicate(el)) out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function isVisible(el) {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    return true;
  }

  function isTextLike(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return t === 'text' || t === 'email' || t === 'tel' || t === '';
  }

  function isPasswordField(el) {
    return !!el && el.tagName === 'INPUT'
      && (el.getAttribute('type') || '').toLowerCase() === 'password';
  }

  function labelTextFor(el) {
    try {
      if (el.labels && el.labels.length) return el.labels[0].textContent || '';
      const root = el.getRootNode();
      if (el.id && root.querySelector) {
        const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent || '';
      }
      const wrapper = el.closest('label');
      return wrapper ? wrapper.textContent || '' : '';
    } catch {
      return '';
    }
  }

  function haystack(el) {
    return [
      el.name, el.id, el.placeholder,
      el.getAttribute('aria-label'), el.getAttribute('autocomplete'),
      el.className, labelTextFor(el),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function scoreUsername(el) {
    let score = 0;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'username') score += 120;
    else if (ac === 'email') score += 100;
    if ((el.getAttribute('type') || '').toLowerCase() === 'email') score += 60;
    const hay = haystack(el);
    if (USER_HINT.test(hay)) score += 40;
    if (NOT_USER_HINT.test(hay)) score -= 120;
    if ((el.getAttribute('type') || '').toLowerCase() === 'search') score -= 120;
    if (el.value) score += 5;
    return score;
  }

  // Document order, tolerant of elements sitting in different shadow trees.
  function precedes(a, b) {
    try {
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------- detection */

  // The element the caret is in, following it through shadow boundaries.
  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // A page can carry more than one login form. Narrow to the form the event (or the
  // caret) belongs to, so we never fill or capture a neighbouring form's fields.
  function scopeFor(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const form = el.closest('form');
    if (form) return form;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root : null;
  }

  function findPasswordField(root) {
    const fields = deepQueryAll(root, (el) => isPasswordField(el) && isVisible(el));
    if (!fields.length) return null;
    // Prefer a current-password field; on a signup page the first box is a new password.
    return fields.find(
      (el) => (el.getAttribute('autocomplete') || '').toLowerCase() === 'current-password',
    ) || fields[0];
  }

  function findUsernameField(passwordField, root, scoped) {
    const candidates = deepQueryAll(root, (el) => isTextLike(el) && isVisible(el));
    if (!candidates.length) return null;

    const scored = candidates.map((el) => {
      let score = scoreUsername(el);
      if (passwordField) {
        // The username box almost always sits just above the password box.
        if (precedes(el, passwordField)) score += 50;
        else score -= 40;
        if (passwordField.form && el.form === passwordField.form) score += 40;
        if (el.getRootNode() === passwordField.getRootNode()) score += 10;
      }
      return { el, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    // Searching the whole document with no password field to anchor on, only a confident
    // match counts (step-1 logins). Inside a known form, take the best candidate.
    if (!passwordField && !scoped && best.score < 40) return null;
    return best.score > -40 ? best.el : null;
  }

  // `hint` is the element that triggered this -- a submitted form, a clicked button, or
  // the focused input. Without one we fall back to the caret, then to the whole document.
  function detect(hint) {
    const scope = scopeFor(hint || deepActiveElement());
    if (scope) {
      const password = findPasswordField(scope);
      const username = findUsernameField(password, scope, true);
      if (password || username) return { password, username };
    }
    const password = findPasswordField(document);
    const username = findUsernameField(password, document, false);
    return { password, username };
  }

  /* ---------------------------------------------------------------- filling */

  // React and Vue track an input's value on the DOM node and ignore a plain assignment,
  // so go through the prototype's native setter, then fire the events they listen for.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;

    try {
      el.focus({ preventScroll: true });
    } catch { /* some inputs refuse focus */ }

    setter.call(el, value);

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'a' }));
  }

  function submitForm(field) {
    const form = field && field.form;
    if (!form) return;
    // requestSubmit() runs validation and fires submit handlers, unlike form.submit().
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    const button = form.querySelector('button[type=submit], input[type=submit]');
    if (button) button.click();
  }

  function fill(username, password, hint, autoSubmit) {
    const { password: pwEl, username: userEl } = detect(hint);
    let filledUsername = false;
    let filledPassword = false;

    if (userEl && username) {
      setValue(userEl, username);
      filledUsername = true;
    }
    if (pwEl && password) {
      setValue(pwEl, password);
      filledPassword = true;
      // Leave the caret in the password box so Enter submits.
      try {
        pwEl.focus({ preventScroll: true });
      } catch { /* ignore */ }
    } else if (userEl && !pwEl) {
      try {
        userEl.focus({ preventScroll: true });
      } catch { /* ignore */ }
    }

    if (autoSubmit && filledPassword) setTimeout(() => submitForm(pwEl), 120);
    return { filledUsername, filledPassword };
  }

  function capture(hint) {
    const { password: pwEl, username: userEl } = detect(hint);
    return {
      username: userEl ? userEl.value : '',
      password: pwEl ? pwEl.value : '',
      hasPassword: !!pwEl,
      hasUsername: !!userEl,
      url: location.href,
      title: document.title,
    };
  }

  /* -------------------------------------------------------------- overlay UI */

  const CSS_TEXT = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
    }
    .wrap.anchored { right: auto; bottom: auto; }
    .card {
      background: #fff; border: 1px solid #d7dde5; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, .18);
      min-width: 260px; max-width: 340px; overflow: hidden;
      animation: appear .12s ease-out;
    }
    .wrap.anchored .card { min-width: 0; max-width: none; width: 100%; }
    @keyframes appear { from { opacity: 0; transform: translateY(-3px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }

    .row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
    .mark {
      width: 18px; height: 18px; border-radius: 5px; flex: 0 0 auto;
      background: #2563eb; color: #fff; font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .mark.warn { background: #b45309; }
    .msg { flex: 1 1 auto; min-width: 0; }
    .sub { color: #64748b; font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
    .head {
      padding: 9px 12px; border-bottom: 1px solid #eef2f7;
      font-size: 11px; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; color: #64748b;
    }
    ul { list-style: none; margin: 0; padding: 4px; max-height: 264px; overflow-y: auto; }
    ul:focus { outline: none; }
    li > button {
      display: block; width: 100%; text-align: left; background: none; border: 0;
      padding: 8px 9px; border-radius: 6px; cursor: pointer; font: inherit; color: inherit;
    }
    li > button:hover, li > button[aria-selected="true"] { background: #eff6ff; }
    .u { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .actions {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-top: 1px solid #eef2f7;
    }
    .actions button {
      font: inherit; padding: 6px 11px; border-radius: 6px; cursor: pointer;
      border: 1px solid #d7dde5; background: #fff; color: #0f172a;
    }
    .actions button:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
    .actions .primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .actions .spacer { flex: 1 1 auto; }
    .actions .ghost { border-color: transparent; color: #64748b; }

    @media (prefers-color-scheme: dark) {
      .wrap { color: #e2e8f0; }
      .card { background: #1e293b; border-color: #334155; color: #e2e8f0; }
      .head, .actions { border-color: #334155; }
      li > button:hover, li > button[aria-selected="true"] { background: #334155; }
      .actions button { background: #1e293b; border-color: #475569; color: #e2e8f0; }
      .actions .primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
      .actions .ghost { border-color: transparent; color: #94a3b8; }
      .sub { color: #94a3b8; }
    }
  `;

  let hostEl = null;
  let shadow = null;

  // A closed shadow root: page CSS cannot restyle it and page script cannot read it.
  // The host carries no attributes -- nothing here should be detectable by the page.
  function ui() {
    if (shadow && hostEl && hostEl.isConnected) return shadow;
    hostEl = document.createElement('div');
    hostEl.style.cssText = 'all:initial;position:static;';
    shadow = hostEl.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(hostEl);
    return shadow;
  }

  function clearUi() {
    if (!shadow) return;
    for (const node of [...shadow.children]) {
      if (node.tagName !== 'STYLE') node.remove();
    }
  }

  function makeWrap(anchored) {
    const root = ui();
    clearUi();
    const wrap = document.createElement('div');
    wrap.className = anchored ? 'wrap anchored' : 'wrap';
    root.appendChild(wrap);
    return wrap;
  }

  // Hang the panel off the field it will fill, the way a browser's own autofill menu does.
  // The wrap is position:fixed inside the shadow root, so viewport coordinates apply
  // directly -- inside an iframe they are already relative to that frame.
  const EDGE = 8;
  const GAP = 4;

  function positionAt(wrap, target) {
    let rect = target.getBoundingClientRect();

    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      try {
        target.scrollIntoView({ block: 'center' });
      } catch { /* ignore */ }
      rect = target.getBoundingClientRect();
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const width = Math.min(Math.max(rect.width, 260), Math.max(200, vw - EDGE * 2));
    wrap.style.width = `${width}px`;

    const height = wrap.offsetHeight; // measured once the content is in the DOM
    let top = rect.bottom + GAP;
    if (top + height > vh - EDGE) {
      const above = rect.top - GAP - height;
      top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - height);
    }
    const left = Math.min(Math.max(EDGE, rect.left), Math.max(EDGE, vw - width - EDGE));

    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
  }

  // Keep the panel glued to the field while the page moves underneath it.
  function trackAnchor(wrap, target) {
    const reposition = () => positionAt(wrap, target);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }

  /* ------------------------------------------------------------------ toast */

  let toastTimer = null;

  function toast(message, sub, kind) {
    const wrap = makeWrap(false);
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const row = document.createElement('div');
    row.className = 'row';
    const mark = document.createElement('div');
    mark.className = kind === 'warn' ? 'mark warn' : 'mark';
    mark.textContent = kind === 'warn' ? '!' : '✓';
    mark.setAttribute('aria-hidden', 'true');
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = message;
    if (sub) {
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = sub;
      msg.appendChild(s);
    }
    row.append(mark, msg);
    card.appendChild(row);
    wrap.appendChild(card);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(clearUi, 3200);
  }

  /* ------------------------------------------------------------------- menu */

  let menuOpen = false;

  // Shared by the explicit picker and the focus suggestions. `takeFocus` is true only for
  // the picker: the user asked for it, so keyboard focus belongs in the list. Suggestions
  // must never steal focus from someone mid-type.
  function openMenu({ entries, anchor, heading, takeFocus }) {
    return new Promise((resolve) => {
      menuOpen = true;
      const previousFocus = deepActiveElement();
      const wrap = makeWrap(!!anchor);

      const card = document.createElement('div');
      card.className = 'card';

      const head = document.createElement('div');
      head.className = 'head';
      head.textContent = heading;
      card.appendChild(head);

      const list = document.createElement('ul');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', heading);
      if (takeFocus) list.tabIndex = -1;

      let selected = 0;
      const buttons = [];

      entries.forEach((entry, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'option');
        btn.id = `pv-option-${i}`;
        const u = document.createElement('div');
        u.className = 'u';
        u.textContent = entry.username || 'No username';
        const t = document.createElement('div');
        t.className = 'sub';
        t.textContent = entry.title || entry.domain || '';
        btn.append(u, t);
        btn.addEventListener('click', () => finish(entry.id));
        btn.addEventListener('mousemove', () => select(i));
        li.appendChild(btn);
        list.appendChild(li);
        buttons.push(btn);
      });

      card.appendChild(list);
      wrap.appendChild(card);

      let untrack = () => {};
      if (anchor) {
        positionAt(wrap, anchor);
        untrack = trackAnchor(wrap, anchor);
      }

      function select(i) {
        selected = (i + buttons.length) % buttons.length;
        buttons.forEach((b, n) => b.setAttribute('aria-selected', String(n === selected)));
        list.setAttribute('aria-activedescendant', buttons[selected].id);
        buttons[selected].scrollIntoView({ block: 'nearest' });
      }

      function finish(id) {
        menuOpen = false;
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onOutside, true);
        untrack();
        clearUi();
        if (takeFocus && previousFocus && previousFocus.focus) {
          try {
            previousFocus.focus({ preventScroll: true });
          } catch { /* ignore */ }
        }
        resolve({ id });
      }

      // Clicking anywhere else dismisses it, like any other menu. Clicks inside the closed
      // shadow root are retargeted to the host, so that is the test.
      function onOutside(e) {
        if (e.target !== hostEl) finish(null);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(entries[selected].id); }
        else if (e.key === 'Tab') { finish(null); }
      }

      select(0);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onOutside, true);
      if (takeFocus) list.focus({ preventScroll: true });
    });
  }

  function pick(entries) {
    const fields = detect();
    return openMenu({
      entries,
      anchor: fields.username || fields.password,
      heading: 'Choose a login',
      takeFocus: true,
    });
  }

  /* ------------------------------------------------------------ save prompt */

  function savePrompt({ domain, username, isUpdate }) {
    return new Promise((resolve) => {
      const wrap = makeWrap(false);
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', isUpdate ? 'Update saved password' : 'Save password');

      const row = document.createElement('div');
      row.className = 'row';
      const mark = document.createElement('div');
      mark.className = 'mark';
      mark.textContent = '✓';
      mark.setAttribute('aria-hidden', 'true');
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = isUpdate ? `Update password for ${domain}?` : `Save password for ${domain}?`;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = username || 'No username detected';
      msg.appendChild(sub);
      row.append(mark, msg);
      card.appendChild(row);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const save = document.createElement('button');
      save.className = 'primary';
      save.textContent = isUpdate ? 'Update' : 'Save';
      const later = document.createElement('button');
      later.textContent = 'Not now';
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      const never = document.createElement('button');
      never.className = 'ghost';
      never.textContent = 'Never here';
      actions.append(save, later, spacer, never);
      card.appendChild(actions);
      wrap.appendChild(card);

      let timer = null;
      const finish = (action) => {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey, true);
        clearUi();
        resolve({ action });
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish('dismiss'); }
      };

      save.addEventListener('click', () => finish('save'));
      later.addEventListener('click', () => finish('dismiss'));
      never.addEventListener('click', () => finish('never'));
      document.addEventListener('keydown', onKey, true);
      save.focus();

      // Never leave a prompt sitting on the page indefinitely.
      timer = setTimeout(() => finish('dismiss'), 30000);
    });
  }

  /* --------------------------------------------------- suggestions on focus */

  // Offering the saved logins when someone clicks into an empty login box removes the
  // need for the shortcut entirely. Kept deliberately quiet: only for empty fields, only
  // once per field, and never while another overlay is up.
  const dismissed = new WeakSet();
  let suggestToken = 0;

  async function maybeSuggest(field) {
    if (menuOpen || !field || field.value || dismissed.has(field)) return;

    const { password, username } = detect(field);
    if (field !== password && field !== username) return;

    const token = ++suggestToken;
    const response = await send({ type: MSG.SUGGEST_REQUEST, url: location.href });
    if (!response || token !== suggestToken) return;
    if (!response.entries || !response.entries.length) return;
    // The user may have typed or moved on while we were asking.
    if (menuOpen || deepActiveElement() !== field || field.value) return;

    const choice = await openMenu({
      entries: response.entries,
      anchor: field,
      heading: 'Saved logins',
      takeFocus: false,
    });

    if (choice && choice.id) send({ type: MSG.FILL_ENTRY, id: choice.id });
    else dismissed.add(field); // dismissed once means dismissed for this field
  }

  document.addEventListener('focusin', (e) => {
    const el = (e.composedPath && e.composedPath()[0]) || e.target;
    if (isPasswordField(el) || isTextLike(el)) maybeSuggest(el);
  }, true);

  /* ------------------------------------------------ submit -> offer to save */

  let lastCapture = null;

  function rememberCapture(hint) {
    const c = capture(hint);
    if (c.password) lastCapture = c;
  }

  function reportSubmission(hint) {
    rememberCapture(hint);
    if (!lastCapture || !lastCapture.password) return;
    const payload = lastCapture;
    lastCapture = null;
    send({
      type: MSG.SUBMIT_DETECTED,
      username: payload.username,
      password: payload.password,
      url: payload.url,
      title: payload.title,
    });
  }

  document.addEventListener('submit', (e) => reportSubmission(e.target), true);

  // Many login forms never fire submit -- they are a button with a click handler.
  document.addEventListener('click', (e) => {
    // Inside a shadow root e.target is retargeted to the host, which loses the form we
    // need; composedPath()[0] is the element actually clicked.
    const clicked = (e.composedPath && e.composedPath()[0]) || e.target;
    const el = clicked instanceof Element
      ? clicked.closest('button, input[type=submit], [role=button]')
      : null;
    if (!el) return;
    const text = `${el.textContent || ''} ${el.value || ''} ${el.id || ''} ${el.className || ''}`;
    if (SUBMIT_TEXT.test(text)) {
      rememberCapture(el);
      setTimeout(() => reportSubmission(el), 60);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || menuOpen) return;
    const el = (e.composedPath && e.composedPath()[0]) || e.target;
    if (isPasswordField(el) || isTextLike(el)) {
      rememberCapture(el);
      setTimeout(() => reportSubmission(el), 60);
    }
  }, true);

  /* ----------------------------------------------------------- message port */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case MSG.PING:
        sendResponse({ ok: true, version: VERSION });
        return false;

      case MSG.DETECT: {
        const { password, username } = detect();
        sendResponse({
          hasPassword: !!password,
          hasUsername: !!username,
          url: location.href,
          title: document.title,
          isTop: window.top === window,
          version: VERSION,
        });
        return false;
      }

      case MSG.FILL:
        sendResponse(fill(msg.username, msg.password, null, msg.submit));
        return false;

      case MSG.CAPTURE:
        sendResponse(capture());
        return false;

      case MSG.TOAST:
        toast(msg.message, msg.sub, msg.kind);
        sendResponse({ ok: true });
        return false;

      case MSG.PICK:
        pick(msg.entries || []).then(sendResponse);
        return true;

      case MSG.SAVE_PROMPT:
        savePrompt(msg).then(sendResponse);
        return true;

      default:
        return false;
    }
  });
})();
