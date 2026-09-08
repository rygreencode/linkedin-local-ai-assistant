const $ = (id) => document.getElementById(id);

/* Model names and error strings come from Ollama and the native host. They land
   in innerHTML, so escape them rather than trusting their shape. */
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

async function activeLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/www\.linkedin\.com\//.test(tab.url || '') ? tab : null;
}

async function startOllama() {
  const box = $('engine');
  box.innerHTML = 'Starting Ollama…';
  const res = await chrome.runtime.sendMessage({ type: 'lla:ollama', cmd: 'start' });
  if (res.ok) {
    await checkEngine();
  } else {
    box.innerHTML = `<b style="color:#b3261e">Could not start</b> — ${esc(res.error)}`;
    if (res.notInstalled) {
      box.innerHTML += `<br>Then reload the extension.`;
    }
  }
}

async function stopOllama() {
  $('engine').innerHTML = 'Stopping…';
  const res = await chrome.runtime.sendMessage({ type: 'lla:ollama', cmd: 'stop' });
  if (!res.ok) $('engine').innerHTML = `<b style="color:#b3261e">Could not stop</b> — ${esc(res.error)}`;
  else await checkEngine();
}

async function checkEngine() {
  const res = await chrome.runtime.sendMessage({ type: 'lla:ping' });
  if (res.ok) {
    const has = res.models.includes(res.model);
    $('engine').innerHTML = has
      ? `<b style="color:#14632c">Connected</b> — ${res.models.length} model(s) at <code>${esc(res.endpoint)}</code>. Using <code>${esc(res.model)}</code>.`
      : `<b style="color:#b3261e">Model missing</b> — <code>${esc(res.model)}</code> is not installed. Run <code>ollama pull ${esc(res.model)}</code>, or pick one of: ${esc(res.models.join(', ')) || 'none'}.`;
    const stop = document.createElement('button');
    stop.textContent = 'Stop Ollama';
    stop.style.marginTop = '6px';
    stop.title = 'Only stops a server this extension started';
    stop.onclick = stopOllama;
    $('engine').appendChild(document.createElement('br'));
    $('engine').appendChild(stop);
  } else {
    $('engine').innerHTML =
      `<b style="color:#b3261e">Not running</b> at <code>${esc(res.endpoint)}</code>.<br>`;
    const btn = document.createElement('button');
    btn.textContent = 'Start Ollama';
    btn.style.cssText = 'margin-top:6px;border-color:#0a66c2;background:#0a66c2;color:#fff';
    btn.onclick = startOllama;
    $('engine').appendChild(btn);
  }
}

async function checkDom() {
  const tab = await activeLinkedInTab();
  if (!tab) {
    $('diag').textContent = 'Open a LinkedIn tab to run diagnostics.';
    return;
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'lla:diagnose' });
  } catch {
    $('diag').textContent = 'Content script not loaded — reload the LinkedIn tab.';
    return;
  }
  $('diag').innerHTML = '';
  for (const r of res.results) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<span class="name">${r.label}</span>` +
      `<span class="tier">${r.ok ? (r.overridden && r.tier === -1 ? 'custom' : `tier ${r.tier}`) : ''}</span>` +
      `<span class="pill ${r.ok ? 'ok' : 'fail'}">${r.ok ? 'OK' : 'FAILED'}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Pick';
    btn.title = 'Click the element on the page to rebind this selector';
    btn.onclick = async () => {
      await chrome.tabs.sendMessage(tab.id, { type: 'lla:pick', key: r.key });
      window.close();
    };
    row.appendChild(btn);
    $('diag').appendChild(row);
  }
  if (res.context) {
    const info = document.createElement('div');
    info.className = 'tier';
    info.style.marginTop = '8px';
    const ctx = res.context;
    if (ctx.error) {
      info.textContent = `Could not read the page: ${ctx.error}`;
    } else {
      const active = ctx.activeRow === -1 ? 'none detected' : `#${ctx.activeRow}`;
      info.innerHTML =
        `Thread: ${esc(ctx.name) || '(no name)'} — ${ctx.messageCount} message(s).<br>` +
        `Conversation rows: <b>${ctx.conversationRows}</b>, active row: <b>${active}</b>.<br>` +
        `Unread control: ${ctx.unreadLabel ? '<b>' + esc(ctx.unreadLabel) + '</b>' : '<b>none found</b>'}` +
      ` (${ctx.unreadOn ? 'on' : 'off'}).`;
    }
    $('diag').appendChild(info);
  }
}

/* ---------- Meeting link ----------
   Editable here as well as on the options page; both write the same
   settings.bookingLink, so whatever is saved last is what gets pasted. */

async function loadBooking() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}) };
  $('bookingLink').value = settings.bookingLink || '';
  renderBookingCurrent(settings.bookingLink);
}

function renderBookingCurrent(value) {
  const box = $('bookingCurrent');
  const v = (value || '').trim();
  box.classList.toggle('unset', !v);
  box.textContent = v
    ? `In use: ${v}`
    : 'Not set — the button and ⌥M will do nothing.';
}

/* Empty is allowed and disables the feature; anything else must be a real
   absolute URL, or it pastes into the composer as broken text. */
function bookingError(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Not a full URL — include https://';
  }
  if (!/^https?:$/.test(url.protocol)) return 'Use an http:// or https:// link.';
  return null;
}

async function saveBooking() {
  const value = $('bookingLink').value.trim();
  const err = bookingError(value);
  $('bookingErr').hidden = !err;
  $('bookingErr').textContent = err || '';
  $('bookingLink').classList.toggle('invalid', Boolean(err));
  if (err) {
    $('bookingLink').focus();
    return;
  }
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}), bookingLink: value };
  await chrome.storage.local.set({ settings });
  renderBookingCurrent(value);
  $('bookingSaved').classList.add('show');
  setTimeout(() => $('bookingSaved').classList.remove('show'), 1500);
}

/* A stale override — one the element picker bound to something that has since
   moved, or the wrong element — silently outranks every built-in selector, so
   clearing it wants to be one click from the diagnostics that reveal it. */
$('clearOverrides').onclick = async () => {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}), selectorOverrides: {} };
  await chrome.storage.local.set({ settings });
  $('overridesCleared').classList.add('show');
  setTimeout(() => $('overridesCleared').classList.remove('show'), 1500);
  checkDom();
};

$('saveBooking').onclick = saveBooking;
$('bookingLink').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBooking();
});

/* One button, one paste — no console context switching required. */
$('copyDiag').onclick = async () => {
  const note = $('diagCopied');
  note.classList.remove('err');
  note.textContent = 'Collecting…';

  const tab = await activeLinkedInTab();
  const report = { generated: new Date().toISOString() };

  try {
    report.engine = await chrome.runtime.sendMessage({ type: 'lla:ping' });
  } catch (err) {
    report.engine = { error: err.message };
  }

  if (!tab) {
    report.page = { error: 'No LinkedIn tab active' };
  } else {
    try {
      report.page = await chrome.tabs.sendMessage(tab.id, { type: 'lla:debug-dump' });
    } catch (err) {
      report.page = { error: `Content script not reachable: ${err.message}` };
    }
  }

  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = `Copied ${text.length} characters to the clipboard.`;
  } catch {
    note.classList.add('err');
    note.textContent = 'Could not copy — see the console for the report.';
    console.log(text);
  }
};

$('recheck').onclick = () => {
  checkEngine();
  checkDom();
};
$('options').onclick = () => chrome.runtime.openOptionsPage();
checkEngine();
checkDom();
loadBooking();
