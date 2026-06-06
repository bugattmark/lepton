# Project conventions

## Nothing is hardcoded

The most important rule in this codebase: **never hardcode what should be data.**

State, content, and config must come from real sources — the SQLite DB, an API
response, env vars, or per-tenant config — not from literals baked into views,
scripts, or modules.

Concretely:
- **UI state is derived, never assumed.** Onboarding step completion/locks, whether
  a template/link/brand exists, counts, ticks, badges — all computed from real data
  (DB / `/api/*`), never a hardcoded `active`/`done`/`locked` class or a fixed number.
- **`localStorage` is a temporary stand-in only.** Where a branch lacks a backend yet,
  client-side `localStorage` may bridge the gap, but it must be clearly marked TEMP and
  replaced with real persistence (table + API) before it's considered done. It is not an
  acceptable final state.
- **No hardcoded secrets, tokens, org/tenant IDs, or magic values.** Use `.env` / config
  (e.g. `HIKER_API_KEY`, `DB_PATH`, per-tenant Attio/IG tokens). Never paste a token or an
  org id into source.
- **No hardcoded lists that belong in data.** Categories, taxonomies, brand seeds, copy
  that varies per tenant — load them, don't inline them.
- **Everything is tenant-scoped** and read through the DB layer, not assumed for a single user.

If you catch yourself typing a literal that represents user/runtime data, stop and wire it
to a source instead.
