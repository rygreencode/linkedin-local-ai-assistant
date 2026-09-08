# Architecture

How the extension is put together, and how it survives LinkedIn changing its
markup. For installing and using it, see the [README](../README.md).

---

## Layout

```
manifest.json          MV3 manifest — permissions, content scripts, icons
src/
  defaults.js          default settings + the tiered selector table
  selectors.js         override-aware resolution, diagnostics snapshot
  scraper.js           recipient metadata + last 5 messages
  prompt.js            prompt assembly, model-output cleanup
  background.js        Ollama client, watchdog, native host, idle shutdown
  content.js           shadow-DOM UI, hotkeys, composer insertion, triage actions
  picker.js            element picker overlay
  popup.html/.js       diagnostics panel, start/stop controls
  options.html/.js     knowledge base + engine configuration
native/
  ollama_launcher.py   native messaging host: status / start / stop
  install_host.py      registers the host, computes the extension ID
scripts/
  apply_env.py         compiles .env into config.local.json
.env.example           template; copy to .env (gitignored)
.env                   your values — gitignored, never committed
config.local.json      generated from .env — gitignored, fetched by the worker
test/
  composer-fixture.html  contenteditable harness for insertion behaviour
  messaging/index.html   unread-filter toggle harness (must be served at /messaging/)
  popup-fixture.html     popup harness with a stubbed chrome API
icons/                 16/32/48/128, generated from a 2048px source
```

## Notes on structure

**Content scripts share a global, not ES modules.** MV3 content scripts cannot be
ES modules, so the six files are listed in order in the manifest and communicate
through a `globalThis.LLA` namespace. Load order matters.

**Shadow DOM isolation.** All injected UI lives in a shadow root with
`all: initial`, so LinkedIn's stylesheet cannot leak in and the extension's CSS
cannot leak out.

**Instance handover.** After an extension reload, the service worker re-injects
into open LinkedIn tabs. Each instance publishes `globalThis.__LLA_TEARDOWN`; the
next one calls it to disconnect observers, drop listeners, and strip the stale UI
before mounting. Without this, an orphaned script sits on the page throwing
*"Extension context invalidated"* on every keystroke.

---

## DOM resilience

LinkedIn changes its CSS class names without warning. Three stages of defence:

**1. Tiered selectors.** Every element has an ordered candidate list in
`src/defaults.js` — current CSS classes first, then semantic ARIA and structural
attributes that survive class churn:

```js
chatInput: [
  'div.msg-form__contenteditable[contenteditable="true"]',   // tier 0: current classes
  'form.msg-form div[contenteditable="true"][role="textbox"]', // tier 1: structural
  'div[contenteditable="true"][role="textbox"]'               // tier 2: semantic only
]
```

**2. Diagnostics.** The popup shows every element as **OK** or **FAILED**, plus
which tier matched — so you can see degradation before it becomes breakage. The
eight resolvable elements:

| Key | Popup label | Used for |
| --- | --- | --- |
| `chatInput` | Chat input | where drafts and the booking link are written |
| `formAnchor` | Compose box (UI anchor) | what the button bar is inserted above |
| `threadContainer` | Message list | scope for scraping messages |
| `messageNode` | Message bubble | the individual messages scraped |
| `headerName` | Recipient name | recipient name for the prompt |
| `headerSubtitle` | Recipient headline | title and company for the prompt |
| `unreadFilter` | Unread filter | the control `⌥F` toggles |
| `conversationItem` | Conversation list item | the rows `⌥D` walks |

A user override set by the picker is stored per key in `selectorOverrides` and
tried ahead of every built-in tier.

**3. Element picker.** For anything FAILED, click **Pick**, then click the real
element on the page. The extension generates a selector, verifies uniqueness,
saves it to `chrome.storage.local`, and tries it ahead of all built-in tiers.
Clear overrides from Settings.
