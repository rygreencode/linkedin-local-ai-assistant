const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['endpoint', 'model', 'lightModel', 'keepAlive', 'name', 'company', 'bio', 'offer', 'bookingLink', 'guidelines'];
const NUM_FIELDS = ['watchdogMs', 'hardTimeoutMs', 'autoStopGraceMin'];

let settings = { ...globalThis.LLA_DEFAULT_SETTINGS };

async function load() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}) };
  TEXT_FIELDS.forEach((k) => ($(k).value = settings[k] ?? ''));
  NUM_FIELDS.forEach((k) => ($(k).value = settings[k] ?? ''));
  $('styleSamples').value = (settings.styleSamples || []).join('\n');
  $('debug').checked = Boolean(settings.debug);
  $('autoStartOllama').checked = Boolean(settings.autoStartOllama);
  $('autoStopOllama').checked = Boolean(settings.autoStopOllama);
  $('showShortcutHint').checked = Boolean(settings.showShortcutHint);
  $('showNavHint').checked = Boolean(settings.showNavHint);
  renderOverrides();
}

function renderOverrides() {
  const o = settings.selectorOverrides || {};
  $('overrides').textContent = Object.keys(o).length
    ? Object.entries(o).map(([k, v]) => `${globalThis.LLA_SELECTOR_LABELS[k] || k}: ${v}`).join('\n')
    : 'none';
}

async function save() {
  TEXT_FIELDS.forEach((k) => (settings[k] = $(k).value.trim()));
  NUM_FIELDS.forEach((k) => (settings[k] = Number($(k).value) || globalThis.LLA_DEFAULT_SETTINGS[k]));
  settings.styleSamples = $('styleSamples').value.split('\n').map((s) => s.trim()).filter(Boolean);
  settings.debug = $('debug').checked;
  settings.autoStartOllama = $('autoStartOllama').checked;
  settings.autoStopOllama = $('autoStopOllama').checked;
  settings.showShortcutHint = $('showShortcutHint').checked;
  settings.showNavHint = $('showNavHint').checked;
  await chrome.storage.local.set({ settings });
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 1500);
}

$('save').onclick = save;
$('clearOverrides').onclick = async () => {
  settings.selectorOverrides = {};
  await chrome.storage.local.set({ settings });
  renderOverrides();
};
load();
