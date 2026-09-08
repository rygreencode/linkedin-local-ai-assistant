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

  /* Commands are remappable at chrome://extensions/shortcuts, so the bubble
     should show what is actually bound rather than the shipped default. */
  let boundShortcuts = null;

  function applyBoundShortcuts() {
    if (!hint || !boundShortcuts) return;
    const pretty = (s) => s.replace(/Alt\+/g, '⌥').replace(/Command\+/g, '⌘').replace(/Ctrl\+/g, '⌃').toLowerCase();
    for (const [command, key] of Object.entries(boundShortcuts)) {
      const kbd = hint.shadow.querySelector(`kbd[data-command="${command}"]`);
      if (kbd) kbd.textContent = key ? pretty(key) : '—';
    }
  }

  send({ type: 'lla:shortcuts' }).then((res) => {
    if (res?.ok) {
      boundShortcuts = res.shortcuts;
      applyBoundShortcuts();
    }
  });

  /* findUnreadControl() walks every button and menu item on the page. Called
     from each sync on a page that mutates continuously, that is real work for a
     value that changes only when the user clicks a filter. */
  let unreadStateCache = { at: 0, on: false };

  function cachedUnreadState(force) {
    if (!force && Date.now() - unreadStateCache.at < 500) return unreadStateCache.on;
    unreadStateCache = { at: Date.now(), on: unreadFilterIsOn(findUnreadControl()) };
    return unreadStateCache.on;
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
          .chip { position:fixed; left:16px; top:100px; z-index:9999;
                  display:flex; flex-direction:column; align-items:flex-start; gap:6px;
                  background:rgba(17,17,17,.92); color:#fff; backdrop-filter:blur(6px);
                  font:12px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
                  padding:8px 30px 8px 10px; border-radius:14px;
                  box-shadow:0 2px 10px rgba(0,0,0,.25); white-space:nowrap; }
          .row { display:flex; align-items:center; gap:6px; }
          /* LinkedIn's own shortcut, shown for reference — the extension does
             not bind it. Muted and ruled off so it reads as not-ours. */
          .row.native { opacity:.72; border-top:1px solid rgba(255,255,255,.14);
                        padding-top:6px; margin-top:1px; width:100%; }
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
          <div class="row"><kbd data-command="toggle-unread">⌥f</kbd> unread <span class="state off">off</span></div>
          <div class="row"><kbd data-command="next-conversation">⌥d</kbd> next conversation</div>
          <div class="row"><kbd data-command="insert-meeting-link">⌥m</kbd> meeting link</div>
          <div class="row native"><kbd>⌘↩</kbd> send (LinkedIn)</div>
        </div>`;
      shadow.querySelector('.x').addEventListener('click', () => {
        LLA.saveSettings({ showShortcutHint: false }).then(renderHint);
      });
      document.documentElement.appendChild(host);
      hint = { host, shadow };
    }

    applyBoundShortcuts();
    const on = cachedUnreadState();
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
    // No fallback to the shipped default: if someone clears the field and saves,
    // an empty link must mean empty, not quietly the previous owner's link.
    const url = (LLA.settings.bookingLink || '').trim();
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
    if (msg?.type === 'lla:command') {
      runAction(msg.command, 'browser command');
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'lla:debug-dump') {
      // LLA lives in the isolated world, so it is not reachable from the page
      // console without switching execution context. Collect it here instead.
      const safely = (label, fn) => {
        try {
          return fn();
        } catch (err) {
          return { error: `${label}: ${err.message}` };
        }
      };
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version,
        url: location.pathname,
        selectors: safely('diagnose', () => LLA.diagnose()),
        nav: safely('debugNav', () => LLA.debugNav()),
        unread: safely('debugUnread', () => LLA.debugUnread())
      });
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
        unreadLabel: (() => {
          const el = findUnreadControl();
          return el ? (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) : null;
        })(),
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

  /* "Is this rendered?" — not "does it have area". checkVisibility accounts for
     display, visibility and content-visibility, and unlike measuring a rect it
     does not misjudge a block element in a narrow viewport. */
  const warnedSelectors = new Set();
  const droppedOverrides = new Set();

  /* Discard a stored override that resolves to the wrong element. Non-destructive
     in effect — the built-in tiers take over immediately and the picker can bind
     it again — but it stops one bad binding disabling a feature indefinitely. */
  function dropOverride(key, resolvedLabel) {
    if (droppedOverrides.has(key)) return;
    droppedOverrides.add(key);
    const overrides = { ...(LLA.settings.selectorOverrides || {}) };
    if (!(key in overrides)) return;
    delete overrides[key];
    console.warn(
      `[LLA] Your saved "${globalThis.LLA_SELECTOR_LABELS[key] || key}" selector resolved to ` +
        `"${resolvedLabel}", which is wrong — discarding it and falling back to the built-in selectors.`
    );
    LLA.saveSettings({ selectorOverrides: overrides });
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility();
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  /* "Unread", "Unread (3)", "Unread messages" — but not "Mark as unread". */
  function labelLooksUnread(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    const text = (el.textContent || '').trim();
    for (const label of [aria, text]) {
      if (!label || label.length > 40) continue;
      // Anchored: "Unread", "Unread (3)" — never "Mark as unread".
      if (/^unread\b/i.test(label)) return true;
    }
    return false;
  }

  function unreadCandidates(root = document) {
    return Array.from(
      root.querySelectorAll('button, [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"]')
    );
  }

  function findUnreadControl() {
    const hit = LLA.resolve('unreadFilter');
    // Validate the label on every hit, including a user override from the
    // picker. Trusting an override blindly meant a mis-bound or since-shifted
    // selector clicked a neighbouring filter — "Jobs" instead of "Unread" —
    // which is worse than doing nothing.
    if (hit && isVisible(hit.el)) {
      if (labelLooksUnread(hit.el)) return hit.el;

      const label = (hit.el.getAttribute('aria-label') || hit.el.textContent || '').trim().slice(0, 40);
      if (hit.tier === -1) {
        // A picker override that resolves to the wrong control is worthless and
        // outranks every built-in tier, so drop it rather than asking the user
        // to go and clear it. Re-Pick if it really was deliberate.
        dropOverride('unreadFilter', label);
      } else if (!warnedSelectors.has(hit.selector)) {
        warnedSelectors.add(hit.selector);
        console.warn(`[LLA] "${hit.selector}" resolves to "${label}", which is not the Unread filter — ignoring it.`);
      }
    }

    // Visibility matters: a match inside a closed menu is clickable in the DOM
    // sense but does nothing the user can see.
    const visible = unreadCandidates().filter((el) => isVisible(el) && labelLooksUnread(el));
    if (visible.length) return visible[0];
    return null;
  }

  function unreadFilterIsOn(el) {
    if (el) {
      const pressed =
        el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || el.getAttribute('aria-selected');
      if (pressed !== null) return pressed === 'true';
      if (Array.from(el.classList).some((c) => /selected|active/.test(c))) return true;
    }
    return /[?&]filter=unread/.test(location.search);
  }

  /* LinkedIn keeps the filters behind a dropdown in some layouts, so the Unread
     item does not exist until the menu is open. Open it, then look again. */
  function findFilterMenuTrigger() {
    return unreadCandidates().find((el) => {
      if (!isVisible(el)) return false;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      return /filter/.test(label) && !/\bsend\b/.test(label);
    }) || null;
  }

  function withOpenFilterMenu(callback) {
    const trigger = findFilterMenuTrigger();
    if (!trigger) {
      LLA.log('no filter dropdown trigger found');
      callback(null);
      return;
    }
    LLA.log('opening filter dropdown', trigger.getAttribute('aria-label') || trigger.textContent.trim());
    trigger.click();

    const deadline = Date.now() + 900;
    const poll = () => {
      const el = findUnreadControl();
      if (el) return callback(el);
      if (Date.now() < deadline) return setTimeout(poll, 90);
      // Nothing turned up — put the menu back the way we found it.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      callback(null);
    };
    setTimeout(poll, 90);
  }

  /* Paste LLA.debugUnread() into the console on a LinkedIn messaging page to see
     exactly what the page offers. */
  LLA.debugUnread = function () {
    const dump = (el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent || '').trim().slice(0, 40),
      visible: isVisible(el),
      pressed: el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || el.getAttribute('aria-selected'),
      classes: (typeof el.className === 'string' ? el.className : '').slice(0, 90)
    });
    const all = unreadCandidates();
    return {
      url: location.pathname + location.search,
      selectorHit: LLA.resolve('unreadFilter')?.selector || null,
      resolved: findUnreadControl() ? dump(findUnreadControl()) : null,
      filterTrigger: findFilterMenuTrigger() ? dump(findFilterMenuTrigger()) : null,
      unreadish: all.filter(labelLooksUnread).map(dump),
      filterish: all
        .filter((el) => /filter|unread|focused|other/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')))
        .slice(0, 25)
        .map(dump)
    };
  };

  function clickUnread(el, wasOn) {
    if (looksLikeSendControl(el)) {
      LLA.log('refusing to click a control labelled "send"', el);
      return;
    }
    el.click();
    LLA.log('toggled unread filter via control', el.getAttribute('aria-label') || el.textContent.trim());
    setTimeout(() => {
      cachedUnreadState(true); // bypass the cache: the state just changed
      renderHint();
    }, 400);
  }

  function toggleUnreadFilter() {
    if (!location.pathname.startsWith('/messaging')) return;

    const el = findUnreadControl();
    const wasOn = unreadFilterIsOn(el);

    if (el) {
      clickUnread(el, wasOn);
      return;
    }

    // Not on the page as it stands — it may live behind the filter dropdown.
    withOpenFilterMenu((fromMenu) => {
      if (fromMenu) {
        clickUnread(fromMenu, wasOn);
        return;
      }
      const url = wasOn ? '/messaging/' : '/messaging/?filter=unread';
      LLA.log('no unread control anywhere; falling back to', url);
      location.assign(url);
    });
  }

  /* ---------- Conversation navigation ---------- */

  const THREAD_LINK = 'a[href*="/messaging/thread/"]';

  /* Rows are whatever LinkedIn wraps a thread link in, and that wrapper has
     changed repeatedly — li, then a div, then something else. The thread link
     itself is the stable thing: it is what identifies the conversation, what we
     compare against the URL, and what we click. So treat the links as the rows
     and stop modelling the container at all. Selector tiers remain as a
     fallback for a layout that somehow has no thread anchors. */
  function threadLinkRows() {
    const seen = new Set();
    return Array.from(document.querySelectorAll(THREAD_LINK)).filter((a) => {
      if (!isVisible(a)) return false;
      const id = activeThreadId(a.getAttribute('href') || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function conversationItems() {
    const links = threadLinkRows();
    if (links.length) {
      LLA.log(`conversation rows: ${links.length} from thread links`);
      return links;
    }
    const { nodes, selector } = LLA.resolveAll('conversationItem');
    // offsetParent is null for anything inside a position:fixed ancestor even
    // when it is plainly visible, so measure instead.
    const visible = nodes.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0;
    });
    // A real conversation row links to a thread. The broadest tier can match
    // unrelated lists, so prefer rows that carry that link when any do.
    const withThread = visible.filter((el) => el.querySelector(THREAD_LINK));
    const rows = withThread.length ? withThread : visible;
    LLA.log(
      `conversation rows: ${rows.length} usable (${visible.length} visible of ${nodes.length} matched by ${selector})`
    );
    return rows;
  }

  /* The open thread's id is in the URL — /messaging/thread/<id>/ — which is far
     more dependable than LinkedIn's selected-row CSS classes. */
  function activeThreadId(pathname) {
    const m = (pathname || location.pathname).match(/\/messaging\/thread\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function rowThreadIds(el) {
    const links = el.matches?.(THREAD_LINK) ? [el] : Array.from(el.querySelectorAll(THREAD_LINK));
    return links.map((a) => activeThreadId(a.getAttribute('href') || '')).filter(Boolean);
  }

  /* LinkedIn marks the open conversation with a class on a *descendant* of the
     row — msg-conversations-container__convo-item-link--active on the inner
     link — not on the row itself and not on its first child. Checking only the
     row and its first child found nothing, so every press reopened row 0. */
  const ACTIVE_MARKER = '[class*="--active"], [class*="is-selected"], [class*="is-active"], [aria-current]';

  function isActiveConversation(el) {
    const openId = activeThreadId();
    if (openId) {
      const ids = rowThreadIds(el);
      if (ids.length) return ids.includes(openId); // only decisive when rows link to threads
    }
    if (el.getAttribute('aria-current')) return true;
    if (el.matches?.(ACTIVE_MARKER) || el.querySelector(ACTIVE_MARKER)) return true;
    const own = typeof el.className === 'string' ? el.className : '';
    return /is-selected|--active|\bactive\b/.test(own);
  }

  LLA.debugNav = function () {
    const { nodes, selector } = LLA.resolveAll('conversationItem');
    const rows = conversationItems();
    const describe = (el) => {
      const thread = el.matches?.(THREAD_LINK) ? el : el.querySelector(THREAD_LINK);
      const first = el.querySelector('a');
      return {
        active: isActiveConversation(el),
        threadHref: thread ? thread.getAttribute('href') : null,
        firstAnchorHref: first ? first.getAttribute('href') : null,
        wouldClick: (
          el.querySelector(THREAD_LINK) ||
          el.querySelector('.msg-conversation-listitem__link') ||
          el.querySelector('[role="link"], button') ||
          el
        ).getAttribute?.('href') || '(element, not a link)',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      };
    };
    return {
      url: location.pathname,
      openThreadId: activeThreadId(),
      selector,
      matched: nodes.length,
      usableRows: rows.length,
      activeIndex: rows.findIndex(isActiveConversation),
      rows: rows.slice(0, 8).map(describe)
    };
  };

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

    const clickable =
      (target.matches?.(THREAD_LINK) ? target : null) ||
      target.querySelector(THREAD_LINK) ||
      target.querySelector('.msg-conversation-listitem__link') ||
      target.querySelector('[role="link"], button') ||
      target;
    if (looksLikeSendControl(clickable)) {
      LLA.log('refusing to click a control labelled "send"', clickable);
      return;
    }

    LLA.log('clicking', clickable.tagName, clickable.className, '→', (clickable.textContent || '').trim().slice(0, 40));
    lastNavIndex = current === -1 ? 0 : current + 1;
    const previousThreadId = activeThreadId();
    clickable.click();
    target.scrollIntoView({ block: 'nearest' });
    focusComposerAfterNavigation(previousThreadId);
  }

  /* After ⌥D the thread swaps out. Put the caret back in the composer so the
     user can start typing straight away, once the new thread has rendered. */
  function focusComposerAfterNavigation(previousThreadId, timeoutMs = 2500) {
    const started = Date.now();

    const focusIt = () => {
      const hit = LLA.resolve('chatInput');
      if (hit?.el && hit.el.getBoundingClientRect().height > 0) {
        hit.el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(hit.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        LLA.log('composer focused after navigation');
        return true;
      }
      return false;
    };

    const poll = () => {
      const arrived = activeThreadId() !== previousThreadId;
      // Wait for the new thread before focusing, or the old composer gets it.
      if ((arrived && focusIt()) || Date.now() - started > timeoutMs) {
        if (!arrived) LLA.log('thread did not change within', timeoutMs, 'ms; focusing anyway');
        if (!arrived) focusIt();
        return;
      }
      setTimeout(poll, 120);
    };

    setTimeout(poll, 120);
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

  /* The shortcuts deliberately avoid macOS's Option dead keys — e, i, n, u and
     backtick — because with focus in a text field their character arrives
     through the composition path, which preventDefault() on keydown does not
     always suppress. ⌥N used to type "˜" into the composer for exactly that
     reason. This net stays as insurance for any binding added later. */
  const DEAD_KEY_CHARS = /^[\u02dc\u00a8\u00b4\u02c6\u0060\u00b5\u02da]$/;
  let suppressInsertUntil = 0;

  function claimKey(e) {
    e.preventDefault();
    e.stopPropagation();
    suppressInsertUntil = Date.now() + 250;
  }

  function onStrayInsert(e) {
    if (Date.now() > suppressInsertUntil) return;
    const data = e.data || '';
    if (DEAD_KEY_CHARS.test(data)) {
      e.preventDefault();
      e.stopPropagation();
      LLA.log('suppressed stray dead-key insertion', JSON.stringify(data));
    }
  }

  /* Console probe: LLA.probeKeys() then press the shortcut. */
  LLA.probeKeys = function (count = 5) {
    let seen = 0;
    const log = (e) => {
      console.log('[LLA probe]', {
        type: e.type,
        key: e.key,
        code: e.code,
        alt: e.altKey,
        meta: e.metaKey,
        data: e.data,
        inputType: e.inputType,
        defaultPrevented: e.defaultPrevented,
        target: e.target?.tagName + (e.target?.isContentEditable ? '[contenteditable]' : '')
      });
      if (++seen >= count * 2) stop();
    };
    const stop = () => {
      document.removeEventListener('keydown', log, true);
      document.removeEventListener('beforeinput', log, true);
      console.log('[LLA probe] stopped');
    };
    document.addEventListener('keydown', log, true);
    document.addEventListener('beforeinput', log, true);
    console.log(`[LLA probe] listening for ${count} keystrokes — press the shortcut now`);
    return 'listening';
  };

  const ACTIONS = {
    'toggle-unread': () => toggleUnreadFilter(),
    'next-conversation': () => nextConversation(),
    'insert-meeting-link': () => insertMeetingLink()
  };

  /* The command and the in-page listener can both arrive for one keystroke.
     Collapse them, keeping whichever wins the race. */
  const lastRun = {};
  function runAction(name, via) {
    const now = Date.now();
    if (now - (lastRun[name] || 0) < 400) {
      LLA.log(`ignoring duplicate ${name} from ${via}`);
      return;
    }
    lastRun[name] = now;
    LLA.log(`${name} via ${via}`);
    ACTIONS[name]?.();
  }

  function onHotkey(e) {
    const key = (e.key || '').toLowerCase();

    // Unread toggle. On macOS Alt+letter emits a dead key rather than the
    // letter itself, hence the e.code check alongside e.key.
    if ((key === 'f' || e.code === 'KeyF') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      claimKey(e);
      runAction('toggle-unread', 'page listener');
      return;
    }

    if ((key === 'd' || e.code === 'KeyD') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      claimKey(e);
      runAction('next-conversation', 'page listener');
      return;
    }

    if ((key === 'm' || e.code === 'KeyM') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      claimKey(e);
      runAction('insert-meeting-link', 'page listener');
    }
  }

  // window capture runs before document capture, so a page listener on document
  // cannot stopImmediatePropagation us out of existence.
  window.addEventListener('keydown', onHotkey, true);
  window.addEventListener('beforeinput', onStrayInsert, true);

  /* ---------- Lifecycle: LinkedIn is an SPA, so re-mount on DOM churn ---------- */

  let pending = null;
  let lastSync = 0;
  const SYNC_DEBOUNCE_MS = 300;
  const SYNC_MAX_WAIT_MS = 1000;

  function syncNow() {
    clearTimeout(pending);
    pending = null;
    lastSync = Date.now();
    for (const step of [mount, renderHint, maybeAutoStart]) {
      try {
        step();
      } catch (err) {
        // An exception here used to abort the whole tick — and, on the first
        // run, prevent the observer ever being attached, so the bar never
        // appeared again. Each step now fails alone.
        console.error(`[LLA] ${step.name}() failed:`, err);
      }
    }
  }

  /* A plain debounce starves here: LinkedIn mutates the DOM continuously
     (presence dots, typing indicators, lazy images, the virtualised list), so
     every tick reset the timer and it could never fire. If the first mount()
     ran before the composer existed, the bar then never appeared. Guarantee a
     run at least every SYNC_MAX_WAIT_MS however busy the page is. */
  function scheduleSync() {
    if (Date.now() - lastSync >= SYNC_MAX_WAIT_MS) {
      syncNow();
      return;
    }
    clearTimeout(pending);
    pending = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleSync);

  function onStorageChanged(changes) {
    if (changes.settings) LLA.loadSettings();
  }

  /* Let the next injected instance retire this one cleanly. */
  globalThis.__LLA_TEARDOWN = function () {
    observer.disconnect();
    clearTimeout(pending);
    window.removeEventListener('keydown', onHotkey, true);
    window.removeEventListener('beforeinput', onStrayInsert, true);
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
    observer.observe(document.body, { childList: true, subtree: true });
    syncNow();
    chrome.storage.onChanged.addListener(onStorageChanged);
    // Which build is actually live? Reloading a tab does not reload the
    // extension, so this is the quickest way to tell a stale copy apart.
    LLA.version = chrome.runtime.getManifest().version;
    console.log(`[LLA] v${LLA.version} ready`);
  });
})();
