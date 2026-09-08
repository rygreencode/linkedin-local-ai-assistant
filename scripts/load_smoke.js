/* Loads the content scripts in order under minimal DOM/chrome stubs and runs one
   sync, the way a page would. Catches load-time and first-run failures that
   `node --check` cannot see — a call to a deleted function, a temporal dead zone,
   a bad scope — without needing a browser.

     node scripts/load_smoke.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json')))
  .content_scripts[0].js.map((p) => p.replace(/^src\//, ''));

const noop = () => {};
const rect = () => ({ top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 });

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, className: '', id: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false, [Symbol.iterator]: function* () {} },
    children: [], isConnected: true, textContent: '', innerHTML: '',
    addEventListener: noop, removeEventListener: noop, appendChild: noop, append: noop,
    insertBefore: noop, remove: noop, focus: noop, blur: noop, click: noop,
    setAttribute: noop, getAttribute: () => null, matches: () => false,
    querySelector: () => makeEl(), querySelectorAll: () => [],
    getBoundingClientRect: rect, scrollIntoView: noop, contains: () => false,
    attachShadow() { this.shadowRoot = makeEl('shadow'); return this.shadowRoot; }
  };
  return el;
}

const document = {
  body: makeEl('body'), documentElement: makeEl('html'), head: makeEl('head'),
  createElement: (t) => makeEl(t), createRange: () => ({ selectNodeContents: noop, collapse: noop }),
  createTextNode: (t) => ({ textContent: t }),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  execCommand: () => true, elementFromPoint: () => null, activeElement: null
};

const calls = [];
const sandbox = {
  console: { log: (...a) => calls.push(['log', a.join(' ')]), warn: noop, error: (...a) => calls.push(['error', a.join(' ')]) },
  document,
  location: { pathname: '/messaging/thread/abc/', search: '', assign: noop },
  setTimeout: (fn) => { calls.push(['setTimeout']); return 0; },
  clearTimeout: noop, requestAnimationFrame: noop, setInterval: noop, clearInterval: noop,
  MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
  InputEvent: class {}, KeyboardEvent: class {}, CSS: { escape: (s) => s },
  getSelection: () => ({ removeAllRanges: noop, addRange: noop, rangeCount: 0, anchorNode: null }),
  chrome: {
    runtime: {
      id: 'stub', getManifest: () => ({ version: '0.0.0-test' }),
      sendMessage: async () => ({ ok: false }),
      onMessage: { addListener: noop, removeListener: noop },
      getURL: (p) => 'chrome-extension://stub/' + p
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: noop, removeListener: noop } }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = noop;
sandbox.window.removeEventListener = noop;
sandbox.window.innerWidth = 1280;
sandbox.window.innerHeight = 800;

vm.createContext(sandbox);

let failed = false;
for (const file of FILES) {
  try {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), sandbox, { filename: file });
    console.log(`  loaded ${file}`);
  } catch (err) {
    console.error(`  FAILED loading ${file}: ${err.constructor.name}: ${err.message}`);
    failed = true;
  }
}

// Let the settings promise resolve, then report anything the first sync logged.
setTimeout(() => {
  const errors = calls.filter(([k]) => k === 'error');
  if (errors.length) {
    console.error('\nErrors during first sync:');
    for (const [, msg] of errors) console.error('  ' + msg);
    failed = true;
  } else {
    console.log('\nFirst sync completed with no errors.');
  }
  process.exit(failed ? 1 : 0);
}, 50);
