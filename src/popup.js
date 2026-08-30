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
        `Unread filter: ${ctx.unreadOn ? 'on' : 'off'}.`;
    }
    $('diag').appendChild(info);
  }
}

$('recheck').onclick = () => {
  checkEngine();
  checkDom();
};
$('options').onclick = () => chrome.runtime.openOptionsPage();
checkEngine();
checkDom();
