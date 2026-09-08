# Testing and performance

There is no test runner. The tricky parts — caret handling, selector
resolution, the settings round-trip — are covered by browser fixtures that
load the shipping files directly, so they cannot drift from the code.

---

## Fixtures

`test/composer-fixture.html` is a standalone harness for the trickiest logic —
caret handling and append-vs-replace insertion into a `contenteditable`.

It needs a real origin; `file://` will not execute the script. Serve it:

```bash
python3 -m http.server 8777 --directory test
```

Then open `http://localhost:8777/composer-fixture.html` and call `runTests()` in
the console. Covered cases:

| Case | Expected |
| --- | --- |
| Link into an empty composer | URL only, one `input` event |
| Draft, then link | single separating space |
| Draft already ends in whitespace | no double space |
| Draft twice | second replaces the first, no append |

`test/popup-fixture.html` drives the real `popup.html` and `popup.js` against a
stubbed `chrome` API, covering the meeting-link field: it shows the stored link,
rejects a bare domain without saving, saves a new link, and — the case that
matters — clears to empty rather than re-filling itself. It
loads the shipping files by path, so it cannot drift from them. Serve the
repository root rather than `test/`:

```bash
python3 -m http.server 8778
```

then open `http://localhost:8778/test/popup-fixture.html`.

`test/messaging/index.html` covers the unread-filter toggle. With the same server
running, open `http://localhost:8777/messaging/` — the path matters, the code only
acts under `/messaging`. Call `runTests()`:

| Case | Expected |
| --- | --- |
| Finds the filter control | resolves via the tiered selectors |
| Toggle on / off | clicks the control, state reads back correctly |
| Mis-bound to a send control | **refused**, nothing clicked |
| No control in the DOM | falls back to `?filter=unread` |

`runNavTests()` on the same page covers `Alt + D`:

| Case | Expected |
| --- | --- |
| URL points at a middle row | moves to the row below |
| URL points at the last row | stops, does not wrap |
| URL points at the first row | moves to the second |
| Detection fails, three presses | walks down three rows, does not reopen the top |

`runFocusTest()` on the same page covers the post-navigation caret:

| Case | Expected |
| --- | --- |
| Thread changes | composer of the new thread takes focus |
| Thread never changes | focuses anyway once the timeout elapses |

The prompt-assembly layer is testable in plain Node, since it touches no DOM:

```bash
node -e "globalThis.LLA={settings:{guidelines:'Under 3 sentences.',styleSamples:['Thanks for reaching out.']}}; require('./src/prompt.js'); console.log(LLA.buildMessages({recipient:{name:'Alex'},messages:[]},'')[0].content)"
```

---

## Static checks

`node --check` validates syntax only, so a call to a function that has been
deleted passes cleanly and fails at runtime. That happened once: a region was
spliced out of `content.js` by index and took `unreadFilterIsOn` with it. The
content script then threw during its first sync, before the MutationObserver was
attached — so the button bar never appeared and never retried.

```bash
python3 scripts/check_refs.py
node scripts/load_smoke.js
```

`load_smoke.js` goes further than a name check: it loads the content scripts in
manifest order inside a `vm` context with stubbed DOM and `chrome` APIs, waits
for the settings promise, and reports anything the first sync logs as an error.
That exercises the real execution path — hoisting, temporal dead zones, scope —
without a browser. A missing function surfaces as a failing first sync rather
than as a mystery on a live page.

Pools every definition across `src/` (content scripts share one global scope) and
reports bare calls with no definition anywhere. Run it alongside `node --check`
before committing.

Two lessons are baked into the code as a result:

- `syncNow()` runs `mount`, `renderHint` and `maybeAutoStart` each in its own
  `try`/`catch`, so one broken step cannot take the others down
- the observer is attached **before** the first sync, so a failing first run can
  never leave the page without a retry

---

## Performance

Measured with `qwen2.5:3b` on Apple silicon:

| | |
| --- | --- |
| Cold generation (model loading) | ~2.4 s |
| Warm generation | well under 1 s |
| Model footprint while resident | ~2.2 GB |
| Idle server process | 26–48 MB |

The default `watchdogMs` of 2500 sits just above the warm case and just below the
cold one, so your first draft after a pause may offer the lighter model
unnecessarily. Raise it to ~4000 if that annoys you.
