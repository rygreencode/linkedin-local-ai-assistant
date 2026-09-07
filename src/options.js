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
  renderBookingCurrent();
  $('autoStartOllama').checked = Boolean(settings.autoStartOllama);
  $('autoStopOllama').checked = Boolean(settings.autoStopOllama);
  $('showShortcutHint').checked = Boolean(settings.showShortcutHint);
  renderOverrides();
}

/* Show what is actually stored, so it is obvious whose link is in play. */
function renderBookingCurrent() {
  const box = $('bookingCurrent');
  const value = (settings.bookingLink || '').trim();
  box.classList.toggle('unset', !value);
  box.querySelector('span').textContent = value || '';
  box.firstChild.nodeValue = value ? 'Currently in use: ' : 'No meeting link set — the button and ⌥M will do nothing.';
}

/* Accept only an absolute http(s) URL; a bare "cal.com/me" pastes as broken text. */
function bookingError(value) {
  if (!value) return null; // empty is allowed — it disables the feature
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a full URL. Include https:// — for example https://cal.com/you';
  }
  if (!/^https?:$/.test(url.protocol)) return 'Use an http:// or https:// link.';
  return null;
}

function renderOverrides() {
  const o = settings.selectorOverrides || {};
  $('overrides').textContent = Object.keys(o).length
    ? Object.entries(o).map(([k, v]) => `${globalThis.LLA_SELECTOR_LABELS[k] || k}: ${v}`).join('\n')
    : 'none';
}

async function save() {
  const bookingValue = $('bookingLink').value.trim();
  const err = bookingError(bookingValue);
  $('bookingError').hidden = !err;
  $('bookingError').textContent = err || '';
  $('bookingLink').classList.toggle('invalid', Boolean(err));
  if (err) {
    $('bookingLink').focus();
    return; // nothing is saved until the link is valid or empty
  }

  TEXT_FIELDS.forEach((k) => (settings[k] = $(k).value.trim()));
  NUM_FIELDS.forEach((k) => (settings[k] = Number($(k).value) || globalThis.LLA_DEFAULT_SETTINGS[k]));
  settings.styleSamples = $('styleSamples').value.split('\n').map((s) => s.trim()).filter(Boolean);
  settings.debug = $('debug').checked;
  settings.autoStartOllama = $('autoStartOllama').checked;
  settings.autoStopOllama = $('autoStopOllama').checked;
  settings.showShortcutHint = $('showShortcutHint').checked;
  await chrome.storage.local.set({ settings });
  renderBookingCurrent();
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
