/* Service worker. All Ollama traffic goes through here on purpose: a content
   script's fetch carries LinkedIn's origin, which OLLAMA_ORIGINS="chrome-extension://*"
   would reject. The worker's origin is chrome-extension://<id>, so it matches. */
importScripts('defaults.js');

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function generate({ messages, modelOverride }, tabId) {
  const s = await getSettings();
  const model = modelOverride || s.model;
  const controller = new AbortController();
  const started = Date.now();

  // Watchdog: nudge the UI at the soft deadline, keep generating to the hard one.
  const watchdog = setTimeout(() => {
    if (tabId != null && model !== s.lightModel) {
      chrome.tabs.sendMessage(tabId, { type: 'lla:slow', model, lightModel: s.lightModel }).catch(() => {});
    }
  }, s.watchdogMs);
  const hardStop = setTimeout(() => controller.abort(), s.hardTimeoutMs);

  try {
    const res = await fetch(`${s.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        keep_alive: s.keepAlive,
        options: { temperature: 0.6, num_predict: 220 }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Ollama returned ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    return {
      ok: true,
      text: data?.message?.content || '',
      model,
      elapsedMs: Date.now() - started
    };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? `Generation exceeded ${s.hardTimeoutMs}ms and was cancelled.`
        : `Could not reach Ollama at ${s.endpoint}. Is it running with OLLAMA_ORIGINS="chrome-extension://*"? (${err.message})`
    };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(hardStop);
  }
}

const NATIVE_HOST = 'com.ryangreen.ollama_launcher';

/* Talk to the native messaging host that can spawn `ollama serve`. Absent host
   = not installed; say so plainly rather than surfacing Chrome's raw error. */
async function ollamaControl(cmd) {
  const s = await getSettings();
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd, endpoint: s.endpoint });
    return res || { ok: false, error: 'Native host returned nothing.' };
  } catch (err) {
    const missing = /not found|Specified native messaging host not found/i.test(err.message || '');
    return {
      ok: false,
      notInstalled: missing,
      error: missing
        ? 'Native host not registered. Run: python3 native/install_host.py'
        : `Native host error: ${err.message}`
    };
  }
}

async function ping() {
  const s = await getSettings();
  try {
    const res = await fetch(`${s.endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name), endpoint: s.endpoint, model: s.model };
  } catch (err) {
    return { ok: false, error: err.message, endpoint: s.endpoint, model: s.model };
  }
}

/* Re-inject into already-open LinkedIn tabs so an extension reload does not
   force the user to reload every tab by hand. */
const LINKEDIN_TABS = { url: 'https://www.linkedin.com/*' };

async function reinjectOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query(LINKEDIN_TABS);
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    } catch (err) {
      console.warn('[LLA] could not inject into tab', tab.id, err.message);
    }
  }
}

chrome.runtime.onInstalled.addListener(reinjectOpenTabs);
chrome.runtime.onStartup.addListener(reinjectOpenTabs);

/* ---------- Idle shutdown ----------
   Stop the server once no LinkedIn tab is left. The host only ever kills the pid
   it recorded itself, so a server you started by hand is never touched. */

const IDLE_ALARM = 'lla-idle-shutdown';

async function linkedInTabCount() {
  const tabs = await chrome.tabs.query(LINKEDIN_TABS);
  return tabs.length;
}

async function evaluateIdle() {
  const s = await getSettings();
  if (!s.autoStopOllama) {
    await chrome.alarms.clear(IDLE_ALARM);
    return;
  }
  if ((await linkedInTabCount()) > 0) {
    await chrome.alarms.clear(IDLE_ALARM); // still in use — cancel any pending stop
    return;
  }
  chrome.alarms.create(IDLE_ALARM, { delayInMinutes: Math.max(1, Number(s.autoStopGraceMin) || 5) });
}

chrome.tabs.onRemoved.addListener(() => evaluateIdle());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url) evaluateIdle();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== IDLE_ALARM) return;
  if ((await linkedInTabCount()) > 0) return; // a tab reopened during the grace period
  const res = await ollamaControl('stop');
  console.log('[LLA] idle shutdown:', res);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'lla:generate') {
    generate(msg, sender.tab?.id).then(sendResponse);
    return true;
  }
  if (msg?.type === 'lla:ollama') {
    ollamaControl(msg.cmd).then(sendResponse);
    return true;
  }
  if (msg?.type === 'lla:ping') {
    ping().then(sendResponse);
    return true;
  }
  return false;
});
