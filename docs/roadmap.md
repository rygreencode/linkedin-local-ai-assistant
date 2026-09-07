# Roadmap

What is deliberately unbuilt, and what is blocked on something outside this
repository.

---

## Not built yet

From the original spec, deliberately deferred:

- **Suggested message chips** — three drafts offered at once, `Alt + 1/2/3` to pick
- **Visual intent badging** — a single-token classification pass tagging threads
  `[Cold Pitch]`, `[Warm Lead]`, `[Recruiter]`, `[Spam]`

The scraper and prompt layers already return everything both features need.

---

## Future integrations

### Antler Hub side panel

**Status: investigated, blocked on credentials. No code written.**

The idea: a Chrome side panel (`chrome.sidePanel`, MV3) showing Antler Hub records
for whoever is currently in view — the recipient of the open conversation, or the
subject of a `/in/<slug>` profile page — opened by a button beside **Settings** in
the popup, which kicks off the lookup on click. Roughly what the Attio extension
does for its CRM.

The design principle worth keeping: this data is **displayed to the reader, not
injected into the model's prompt**. A wrong match then costs a glance, not a
fabricated draft.

#### What the investigation found

**A browser extension cannot call an MCP server.** MCP connectors are
authenticated, session-bound, and speak stdio/SSE. There is no browser-reachable
endpoint, so any Hub integration needs a bridge process.

**The Hub MCP connector is bound to a Claude session, not to this machine.**

| | |
| --- | --- |
| Authenticated as | `ryan.green@antler.co`, role `OPERATIONS` |
| Lane / scopes | `staff_scoped_read`, `postgres:read` |
| Credentials on disk | none — no API key, no environment variable |

The native messaging host could host a bridge, but it has nothing to
authenticate with. **This is the blocker**: it needs a token-authenticated Hub
endpoint, which is a question for whoever operates Hub, not something that can be
solved from this repo.

Worth noting for whoever picks this up: for a deterministic sidebar you probably
want the API *underneath* Hub's MCP rather than MCP itself. MCP is a wrapper for
model tool-calling; a panel doing "show me this person" lookups wants the source
directly.

#### Coverage and matching are inversely matched

| | Covers | Matches on |
| --- | --- | --- |
| **Hub** | applicants, residency founders, portfolio founders, staff, sourcing leads | name and email only |
| **`antler-search`** (local, port 8000) | 312 companies, 514 founders — 412 with LinkedIn URLs | canonical `/in/<slug>/`, exact |

Hub knows more people; the local database identifies them far more reliably.
Hub's `person_search` returns no LinkedIn field, so a profile-page lookup would
have to match on display name. That is not merely imprecise: a search for a
common first name returned a hit on an unrelated person via an email substring.
Any name-matched result must be shown with its confidence, never presented as
certain.

#### The path that needs no permissions

Extend the existing Harmonic enrichment workflow in `antler-search` to also sync
Hub **leads and applicants** into the local SQLite alongside founders. That buys
Hub's breadth with the local database's slug-matching precision, no runtime
authentication, and no change to the localhost-only privacy property. A live Hub
token would then only be needed for real-time freshness rather than for the
feature to exist at all.

The panel itself is independent of all this — it should be built against a
pluggable data source so the backing store can change without touching the UI.
