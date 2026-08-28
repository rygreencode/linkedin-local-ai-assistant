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
  let lastContext = null;
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
        kbd { font:11px/1 monospace; background:#eee; border:1px solid #ccc;
              border-radius:3px; padding:1px 4px; color:#555; }
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
    if (!anchor) return;
    const host = buildUI();
    anchor.el.parentElement.insertBefore(host, anchor.el);
    LLA.log('UI mounted above', anchor.selector);
  }

  /* ---------- Shortcut hint overlay ---------- */

  let hint = null;

  function positionHint() {
    if (!hint?.host.isConnected) return;
    const chip = hint.shadow.querySelector('.chip');
    const target = findUnreadControl();

    if (!target) {
      // Nothing to anchor to — park it bottom-left rather than lose it.
      chip.classList.add('floating');
      chip.style.left = '16px';
      chip.style.top = '';
      chip.style.bottom = '16px';
      chip.style.setProperty('--arrow', '-99px');
      return;
    }

    const r = target.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    const gap = 10;

    // Centre on the control, then clamp so it never leaves the viewport.
    let left = r.left + r.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = r.top - box.height - gap;

    // No room above (control near the top of the window) — sit below instead.
    const below = top < 8;
    if (below) top = r.bottom + gap;

    chip.classList.remove('floating');
    chip.classList.toggle('below', below);
    chip.style.left = `${Math.round(left)}px`;
    chip.style.top = `${Math.round(top)}px`;
    chip.style.bottom = '';
    // Point the arrow at the control's centre, in chip-local coordinates.
    chip.style.setProperty('--arrow', `${Math.round(r.left + r.width / 2 - left)}px`);
  }

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
          .chip { position:fixed; z-index:9999; left:-9999px; top:0;
                  display:flex; align-items:center; gap:10px;
                  background:rgba(17,17,17,.92); color:#fff; backdrop-filter:blur(6px);
                  font:12px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
                  padding:7px 10px; border-radius:16px; box-shadow:0 2px 10px rgba(0,0,0,.25);
                  white-space:nowrap; }
          /* Arrow pointing down at the unread control (or up, when flipped). */
          .chip::after { content:""; position:absolute; left:var(--arrow, 50%);
                         margin-left:-5px; border:5px solid transparent; }
          .chip:not(.below):not(.floating)::after { top:100%; border-top-color:rgba(17,17,17,.92); }
          .chip.below::after { bottom:100%; border-bottom-color:rgba(17,17,17,.92); }
          .chip.floating::after { display:none; }
          kbd { font:11px/1 ui-monospace, monospace; background:rgba(255,255,255,.16);
                border-radius:3px; padding:2px 5px; }
          .sep { opacity:.35; }
          .state { font-weight:600; padding:2px 7px; border-radius:9px; }
          .on  { background:#14632c; }
          .off { background:rgba(255,255,255,.16); }
          .x { cursor:pointer; opacity:.55; padding:0 2px; font-size:14px; }
          .x:hover { opacity:1; }
        </style>
        <div class="chip">
          <span><kbd>⌥U</kbd> unread <span class="state off">off</span></span>
          <span class="x" title="Hide (re-enable in Settings)">&times;</span>
        </div>`;
      shadow.querySelector('.x').addEventListener('click', () => {
        LLA.saveSettings({ showShortcutHint: false }).then(renderHint);
      });
      document.documentElement.appendChild(host);
      hint = { host, shadow };
      window.addEventListener('scroll', positionHint, { passive: true, capture: true });
      window.addEventListener('resize', positionHint, { passive: true });
    }

    const on = unreadFilterIsOn(findUnreadControl());
    const badge = hint.shadow.querySelector('.state');
    badge.textContent = on ? 'on' : 'off';
    badge.className = 'state ' + (on ? 'on' : 'off');
    positionHint();
    // The first pass can measure a pre-reflow layout; settle it on the next frame.
    requestAnimationFrame(positionHint);
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
      lastContext = ctx;
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  });

  function safeContext() {
    try {
      const c = LLA.scrapeContext();
      return { name: c.recipient.name, headline: c.recipient.headline, messageCount: c.messages.length };
    } catch {
      return null;
    }
  }

  /* ---------- Unread filter toggle ----------
     LinkedIn's own filter control. CSS alone cannot match on text, so fall back
     to scanning for a control literally labelled "Unread", then to the URL. */

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
      if (/selected|active/.test(el.className || '')) return true;
    }
    return /[?&]filter=unread/.test(location.search);
  }

  function toggleUnreadFilter() {
    if (!location.pathname.startsWith('/messaging')) return;
    const el = findUnreadControl();

    // Never let this path touch a send control, whatever the DOM looks like.
    if (el) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (label.includes('send')) {
        LLA.log('refusing to click a control labelled "send"', el);
        return;
      }
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
    } catch {
      // context already dead; the listener dies with it
    }
    document.getElementById('lla-host')?.remove();
    document.getElementById('lla-hint')?.remove();
    window.removeEventListener('scroll', positionHint, { capture: true });
    window.removeEventListener('resize', positionHint);
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
