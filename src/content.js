/* Orchestrator: mounts the shadow-DOM UI, owns the hotkeys, and inserts drafts.
   SAFETY INVARIANT — this file never clicks LinkedIn's Send button, never
   dispatches Enter/keypress into the composer, and never calls form.submit().
   Text is placed in the input and the human presses Send. Do not add code that
   simulates a send; that is the one thing this extension must not do. */
(function () {
  // After an extension reload the worker re-injects into open tabs. A previous
  // instance may still be sitting in this isolated world with live listeners and
  // a dead chrome.runtime handle, so retire it rather than refusing to load.
  if (typeof globalThis.__LLA_TEARDOWN === 'function') {
    try {
      globalThis.__LLA_TEARDOWN();
    } catch (err) {
      console.warn('[LLA] teardown of previous instance failed', err);
    }
  }
  // Belt and braces: if the worlds turned out not to be shared, the old UI is
  // still in the DOM and unreachable from here.
  document.getElementById('lla-host')?.remove();
  document.getElementById('lla-hint')?.remove();

  const LLA = (globalThis.LLA = globalThis.LLA || {});
  let ui = null;
  let busy = false;
  let genId = 0;

  /* ---------- UI ---------- */

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'lla-host';
    host.style.cssText = 'all:initial;display:block;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar { display:flex; align-items:center; gap:8px; padding:6px 10px;
               font:13px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
               border-top:1px solid #e0e0e0; background:#fafafa; color:#333; }
        button { font:inherit; cursor:pointer; border-radius:14px; padding:4px 12px;
                 border:1px solid #0a66c2; background:#0a66c2; color:#fff; }
        button.ghost { background:transparent; color:#0a66c2; }
        button:disabled { opacity:.5; cursor:default; }
        .status { flex:1; color:#666; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .status.err { color:#b3261e; }
      </style>
      <div class="bar">
        <button class="draft">Draft reply</button>
        <button class="regen ghost" disabled>Regenerate</button>
        <button class="link ghost" title="Insert your booking link at the cursor">Add meeting link</button>
        <span class="status"></span>
        <button class="swap ghost" style="display:none"></button>
      </div>`;

    const q = (s) => shadow.querySelector(s);
    ui = {
      host,
      shadow,
      draftBtn: q('.draft'),
      regenBtn: q('.regen'),
      linkBtn: q('.link'),
      status: q('.status'),
      swapBtn: q('.swap')
    };
    ui.draftBtn.addEventListener('click', () => run(false));
    ui.regenBtn.addEventListener('click', () => run(true));
    ui.linkBtn.addEventListener('click', insertMeetingLink);
    return host;
  }

  function setStatus(text, isError) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.classList.toggle('err', Boolean(isError));
  }

  function resetStatus() {
    if (!ui) return;
    ui.status.classList.remove('err');
    ui.status.textContent = '';
  }

  LLA.toast = function (msg, ms = 3000) {
    setStatus(msg);
    setTimeout(resetStatus, ms);
  };

  function mount() {
    if (document.getElementById('lla-host')?.isConnected) return;
    const anchor = LLA.resolve('formAnchor');
    if (!anchor?.el.parentElement) return;
    const host = buildUI();
    anchor.el.parentElement.insertBefore(host, anchor.el);
    LLA.log('UI mounted above', anchor.selector);
  }

  /* ---------- Shortcut hint overlay ----------
     One bubble carrying every shortcut, pinned to the left edge of the browser
     window near the top. Fixed positioning, so nothing to recompute on scroll. */

  let hint = null;

  function renderHint() {
    if (!LLA.settings.showShortcutHint || !location.pathname.startsWith('/messaging')) {
      hint?.host.remove();
      hint = null;
      return;
    }

    if (!hint || !hint.host.isConnected) {
      const host = document.createElement('div');
      host.id = 'lla-hint';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          .chip { position:fixed; left:16px; top:100px; z-index:9999;
                  display:flex; flex-direction:column; align-items:flex-start; gap:6px;
                  background:rgba(17,17,17,.92); color:#fff; backdrop-filter:blur(6px);
                  font:12px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
                  padding:8px 30px 8px 10px; border-radius:14px;
                  box-shadow:0 2px 10px rgba(0,0,0,.25); white-space:nowrap; }
          .row { display:flex; align-items:center; gap:6px; }
          kbd { font:11px/1 ui-monospace, monospace; background:rgba(255,255,255,.16);
                border-radius:3px; padding:3px 5px; min-width:22px; text-align:center; }
          .state { font-weight:600; padding:2px 7px; border-radius:9px; }
          .on  { background:#14632c; }
          .off { background:rgba(255,255,255,.16); }
          .x { position:absolute; top:5px; right:9px;
               cursor:pointer; opacity:.55; font-size:14px; line-height:1; }
          .x:hover { opacity:1; }
        </style>
        <div class="chip">
          <span class="x" title="Hide (re-enable in Settings)">&times;</span>
          <div class="row"><kbd>⌥U</kbd> unread <span class="state off">off</span></div>
          <div class="row"><kbd>⌥N</kbd> next conversation</div>
        </div>`;
      shadow.querySelector('.x').addEventListener('click', () => {
        LLA.saveSettings({ showShortcutHint: false }).then(renderHint);
      });
      document.documentElement.appendChild(host);
      hint = { host, shadow };
    }

    const on = unreadFilterIsOn(findUnreadControl());
    const badge = hint.shadow.querySelector('.state');
    badge.textContent = on ? 'on' : 'off';
    badge.className = 'state ' + (on ? 'on' : 'off');
  }

  /* ---------- Draft insertion (no send, ever) ---------- */

  function writeToComposer(text, { replace }) {
    const hit = LLA.resolve('chatInput');
    if (!hit) {
      setStatus('Chat input not found — use the popup\'s element picker to rebind it.', true);
      return false;
    }
    const el = hit.el;
    el.focus();

    const sel = window.getSelection();
    if (replace) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
      // Caret is elsewhere (the user just clicked our button) — append at the end.
      const end = document.createRange();
      end.selectNodeContents(el);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
    }

    // execCommand fires the composition/input events LinkedIn's editor listens for.
    const inserted = document.execCommand('insertText', false, text);

    if (!inserted) {
      // Fallback for editors that ignore execCommand.
      if (replace) {
        el.textContent = '';
        const p = document.createElement('p');
        p.textContent = text;
        el.appendChild(p);
      } else {
        (el.lastElementChild || el).append(document.createTextNode(text));
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    // Park the caret at the end so the user can keep typing.
    const end = document.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    sel.removeAllRanges();
    sel.addRange(end);
    return true;
  }

  const insertDraft = (text) => writeToComposer(text, { replace: true });

  /* Paste the booking link without disturbing whatever is already drafted. */
  function insertMeetingLink() {
    const url = LLA.settings.bookingLink || globalThis.LLA_DEFAULT_SETTINGS.bookingLink;
    if (!url) {
      setStatus('No meeting link set — add one in Settings.', true);
      return;
    }
    const hit = LLA.resolve('chatInput');
    const existing = hit ? hit.el.textContent : '';
    const prefix = existing.length && !/\s$/.test(existing) ? ' ' : '';
    if (writeToComposer(prefix + url, { replace: false })) {
      LLA.toast('Meeting link added.', 2500);
    }
  }

  /* A call into a dead context throws a bare "Extension context invalidated".
     Translate it into something the user can act on. */
  async function send(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error('Extension context invalidated.');
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (/context invalidated|Receiving end does not exist|message port closed/i.test(err.message)) {
        return { ok: false, stale: true, error: 'Extension was reloaded — reload this tab (⌘R) to reconnect.' };
      }
      return { ok: false, error: err.message };
    }
  }

  /* ---------- Generation ---------- */

  async function run(isRegen, modelOverride) {
    if (busy) return;
    busy = true;
    const myGen = ++genId;
    if (ui) {
      ui.draftBtn.disabled = true;
      ui.regenBtn.disabled = true;
      ui.swapBtn.style.display = 'none';
    }
    setStatus(isRegen ? 'Regenerating…' : 'Drafting…');

    try {
      const ctx = LLA.scrapeContext();
      if (!ctx.messages.length) {
        LLA.log('no messages scraped — drafting from header context only');
      }
      const extra = isRegen ? 'Your previous attempt was rejected. Write a clearly different reply — different angle, different opening.' : '';
      const messages = LLA.buildMessages(ctx, extra);
      const res = await send({ type: 'lla:generate', messages, modelOverride });
      if (myGen !== genId) return; // superseded mid-flight; let the newer run own the UI

      if (!res?.ok) {
        setStatus(res?.error || 'Generation failed.', true);
        return;
      }
      const draft = LLA.cleanDraft(res.text);
      if (!draft) {
        setStatus('Model returned an empty draft.', true);
        return;
      }
      if (insertDraft(draft)) {
        setStatus(`Draft ready (${res.model}, ${(res.elapsedMs / 1000).toFixed(1)}s) — review, then hit Send yourself.`);
        setTimeout(resetStatus, 6000);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    } finally {
      if (myGen !== genId) return; // a newer run superseded this one
      busy = false;
      if (ui) {
        ui.draftBtn.disabled = false;
        ui.regenBtn.disabled = false;
      }
    }
  }

  /* ---------- Watchdog swap offer ---------- */

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'lla:slow' && ui) {
      setStatus(`${msg.model} is taking a while…`);
      ui.swapBtn.textContent = `Retry on ${msg.lightModel}`;
      ui.swapBtn.style.display = '';
      ui.swapBtn.onclick = () => {
        ui.swapBtn.style.display = 'none';
        busy = false; // supersede the in-flight call; its finally() will no-op
        run(false, msg.lightModel);
      };
      return false;
    }
    if (msg?.type === 'lla:diagnose') {
      sendResponse({ ok: true, results: LLA.diagnose(), context: safeContext() });
      return false;
    }
    if (msg?.type === 'lla:pick') {
      LLA.startPicker(msg.key);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'lla:settings-changed') {
      LLA.loadSettings();
      return false;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  function safeContext() {
    try {
      const c = LLA.scrapeContext();
      const rows = conversationItems();
      return {
        name: c.recipient.name,
        headline: c.recipient.headline,
        messageCount: c.messages.length,
        conversationRows: rows.length,
        activeRow: rows.findIndex(isActiveConversation),
        unreadOn: unreadFilterIsOn(findUnreadControl())
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  /* ---------- Unread filter toggle ----------
     LinkedIn's own filter control. CSS alone cannot match on text, so fall back
     to scanning for a control literally labelled "Unread", then to the URL. */

  /* Safety predicate, shared by every path that clicks a LinkedIn control.
     Word-boundary matched so "sender" or "recommended" are not caught. */
  function looksLikeSendControl(el) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
    return /\bsend\b/.test(label);
  }

  function findUnreadControl() {
    const hit = LLA.resolve('unreadFilter');
    if (hit) return hit.el;
    const candidates = document.querySelectorAll(
      'button, [role="radio"], [role="menuitem"], [role="tab"]'
    );
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (/^unread$/i.test(label)) return el;
    }
    return null;
  }

  function unreadFilterIsOn(el) {
    if (el) {
      const pressed = el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || el.getAttribute('aria-selected');
      if (pressed !== null) return pressed === 'true';
      if (Array.from(el.classList).some((c) => /selected|active/.test(c))) return true;
    }
    return /[?&]filter=unread/.test(location.search);
  }

  function toggleUnreadFilter() {
    if (!location.pathname.startsWith('/messaging')) return;
    const el = findUnreadControl();

    // Never let this path touch a send control, whatever the DOM looks like.
    if (el && looksLikeSendControl(el)) {
      LLA.log('refusing to click a control labelled "send"', el);
      return;
    }

    const wasOn = unreadFilterIsOn(el);
    if (el) {
      el.click();
      LLA.log('toggled unread filter via control', el);
    } else {
      // No control found — drive it off the URL instead.
      const url = wasOn ? '/messaging/' : '/messaging/?filter=unread';
      LLA.log('no unread control found; navigating to', url);
      location.assign(url);
    }
    // Let LinkedIn re-render before reading the new state back.
    setTimeout(() => renderHint(), 400);
  }

  /* ---------- Conversation navigation ---------- */

  function conversationItems() {
    const { nodes, selector } = LLA.resolveAll('conversationItem');
    // offsetParent is null for anything inside a position:fixed ancestor even
    // when it is plainly visible, so measure instead.
    const visible = nodes.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0;
    });
    LLA.log(`conversation rows: ${visible.length} visible of ${nodes.length} matched by ${selector}`);
    return visible;
  }

  /* The open thread's id is in the URL — /messaging/thread/<id>/ — which is far
     more dependable than LinkedIn's selected-row CSS classes. */
  function activeThreadId(pathname) {
    const m = (pathname || location.pathname).match(/\/messaging\/thread\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function rowThreadIds(el) {
    return Array.from(el.querySelectorAll('a[href*="/messaging/thread/"]'))
      .map((a) => activeThreadId(a.getAttribute('href') || ''))
      .filter(Boolean);
  }

  function isActiveConversation(el) {
    const openId = activeThreadId();
    if (openId) {
      const ids = rowThreadIds(el);
      if (ids.length) return ids.includes(openId);
    }
    if (el.getAttribute('aria-current')) return true;
    if (el.querySelector('[aria-current]')) return true;
    const classes = [el, el.firstElementChild]
      .filter(Boolean)
      .map((n) => (typeof n.className === 'string' ? n.className : ''))
      .join(' ');
    return /is-selected|--active|\bactive\b/.test(classes);
  }

  let lastNavIndex = null;

  function nextConversation() {
    if (!location.pathname.startsWith('/messaging')) return;
    const items = conversationItems();
    if (!items.length) {
      LLA.log('no conversation rows found — rebind "Conversation list item" in the popup');
      return;
    }

    let current = items.findIndex(isActiveConversation);
    LLA.log('active conversation index', current, 'of', items.length);

    if (current === -1 && lastNavIndex !== null && lastNavIndex < items.length) {
      // Detection missed. Advance from where we last moved rather than jumping
      // back to the top of the list.
      current = lastNavIndex;
      LLA.log('detection missed; continuing from last position', current);
    }
    // Nothing selected yet: start at the top rather than jumping to the second row.
    const target = current === -1 ? items[0] : items[current + 1];
    if (!target) {
      LLA.log('already on the last conversation');
      return;
    }

    const clickable = target.querySelector('a, [role="link"], .msg-conversation-listitem__link') || target;
    if (looksLikeSendControl(clickable)) {
      LLA.log('refusing to click a control labelled "send"', clickable);
      return;
    }

    LLA.log('clicking', clickable.tagName, clickable.className, '→', (clickable.textContent || '').trim().slice(0, 40));
    lastNavIndex = current === -1 ? 0 : current + 1;
    clickable.click();
    target.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- Auto-start the engine when you land in Messages ---------- */

  let autoStartTried = false;

  async function maybeAutoStart() {
    if (autoStartTried || !LLA.settings.autoStartOllama) return;
    if (!location.pathname.startsWith('/messaging')) return;
    autoStartTried = true;

    const alive = await send({ type: 'lla:ping' });
    if (alive?.ok) return;

    setStatus('Starting Ollama…');
    const res = await send({ type: 'lla:ollama', cmd: 'start' });
    if (res?.ok) {
      LLA.toast(res.already ? 'Ollama already running.' : 'Ollama started.', 3000);
    } else if (res?.stale) {
      setStatus(res.error, true);
    } else {
      setStatus(res?.error || 'Could not start Ollama.', true);
      autoStartTried = false; // let a later navigation retry
    }
  }

  /* ---------- Hotkeys ---------- */

  function onHotkey(e) {
    const key = (e.key || '').toLowerCase();

    // Unread toggle. On macOS Alt+letter emits a dead key rather than the
    // letter itself, hence the e.code check alongside e.key.
    if ((key === 'u' || e.code === 'KeyU') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleUnreadFilter();
      return;
    }

    if ((key === 'n' || e.code === 'KeyN') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      nextConversation();
    }
  }

  document.addEventListener('keydown', onHotkey, true);

  /* ---------- Lifecycle: LinkedIn is an SPA, so re-mount on DOM churn ---------- */

  let pending = null;
  const observer = new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      mount();
      renderHint();
      maybeAutoStart();
    }, 300);
  });

  function onStorageChanged(changes) {
    if (changes.settings) LLA.loadSettings();
  }

  /* Let the next injected instance retire this one cleanly. */
  globalThis.__LLA_TEARDOWN = function () {
    observer.disconnect();
    clearTimeout(pending);
    document.removeEventListener('keydown', onHotkey, true);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // context already dead; the listeners die with it
    }
    document.getElementById('lla-host')?.remove();
    document.getElementById('lla-hint')?.remove();
    ui = null;
    hint = null;
  };

  LLA.loadSettings().then(() => {
    mount();
    renderHint();
    maybeAutoStart();
    observer.observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener(onStorageChanged);
    LLA.log('content script ready');
  });
})();
