# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WA Connect (deployed as **lepton.live**) — a single always-on, multi-tenant Node service for
**AI-assisted WhatsApp outbound** aimed at creator → brand pitching. One process serves the
B&W landing, multi-tenant auth, the dashboard, and the send engine. Every account is isolated.

The pipeline the product is built around: **source** leads (Instagram niche → handles → phones)
→ **qualify** them (LLM scoring) → **pitch** them over WhatsApp via a canvas sequence, with
per-number anti-ban pacing and Attio write-back.

## Commands

```bash
npm install
cp .env.example .env
npm run dev          # node --watch src/server.ts  → http://localhost:8080
npm start            # node src/server.ts (no watch)
npm run mcp          # run the MCP server (src/mcp.ts) for driving the app from Claude Code

node --test scripts/attio-logic.test.ts      # run a test file
node --test scripts/attio-logic.test.ts --test-name-pattern "suggestMapping picks phone"   # single test
```

There is **no build step and no linter**. TypeScript is run directly by Node ≥23.6 via native
type-stripping (`tsconfig.json` is `noEmit`, `allowImportingTsExtensions`). Always import local
modules with the **`.ts` extension** (e.g. `import { db } from './db.ts'`) — required by
`verbatimModuleSyntax` + NodeNext. Type-check with `npx tsc` if needed; nothing runs it for you.

Tests use the built-in `node:test` runner and only cover pure logic (e.g. the Attio auto-mapper).
There is no integration/e2e harness — anything touching WhatsApp, Attio, or the LLMs is exercised
by running the app.

## Architecture

Stack: **Hono** on `@hono/node-server`, **`node:sqlite`** (built-in, zero native deps), **Baileys**
for unofficial WhatsApp sessions, **`node:crypto`** for auth + at-rest encryption. Server-rendered
HTML (no frontend framework); the dashboard is plain HTML/JS strings in `src/views.ts`.

**Single instance by design.** WhatsApp sockets and the send-engine runners live in memory on one
machine. Do not introduce work that assumes multiple replicas — scaling later means a session router
+ moving auth state out of memory, not horizontal replicas today. Keep Railway at 1 instance.

### Request & data flow
- `src/server.ts` — all Hono routes + security middleware. Pages render via `src/views.ts`; data
  endpoints live under `/api/*`. **`tenantId` is always derived from the session cookie** via
  middleware (`pageAuth`/`apiAuth`), never from client input — this is the tenant-isolation boundary.
- `src/db.ts` — the single SQLite schema + `db` handle. Every other module reads/writes through it.
  Tables: tenants, sessions, messages, contacts, campaigns, accounts, send_profiles,
  campaign_contacts, campaign_accounts, lead_lists, brands, onboarding. **Everything is tenant-scoped.**
- `src/auth.ts` — scrypt password hashing, opaque server-side sessions, `wa_…` API tokens.
- `src/secret.ts` — AES-256-GCM at-rest encryption (`enc`/`dec`) for stored Cloud API tokens & Attio
  keys, keyed off `APP_SECRET`. Backward-compatible with plaintext values written before a key existed.

### Sending (the safety core)
- `src/accounts.ts` — account CRUD + a unified `send()` that dispatches to **baileys** (`sessions.ts`)
  or **cloud** (`cloud.ts`) per account type. New transports plug in here.
- `src/sessions.ts` — Baileys manager: **one socket per account**, QR linking, and inbound
  reply/opt-out (STOP) handling that flips leads to `replied`/`opted-out`.
- `src/cloud.ts` — official WhatsApp Cloud API transport.
- `src/sequence.ts` — the **canvas sequence** is the source of truth for what a campaign does:
  `start → send → wait → ifreply` nodes + edges. A `wait → send` edge *is* the follow-up loop;
  there is no separate follow-up knob. Send blocks carry the pacing knobs (hourly cap, min/max gap).
- `src/policy.ts` — per-number `SendPolicy`: warm-up ramp, daily cap, distribution weight, send window.
- `src/engine.ts` — the send engine. Runs **per account**, walks each lead through the campaign's
  sequence, enforces caps/gaps/window/warm-up, and calls the AI opener. `startCampaign`/`pauseCampaign`/
  `kick`/`resumePausedFor` are the control surface. Sleeps in ≤5s slices so pause/disconnect is noticed
  fast. State (`running`/`pending`/`sent`/`replied`/`done`) lives in the DB, not in the loop.

### Lead pipeline (source → qualify)
- `src/sourcing.ts` — niche (IG hashtags) → candidate handles via **HikerAPI**, enrich/filter, then
  phone lookup via `iglead.ts`. Materializes into a `sourced` lead_list so the rest of the app treats
  it like any other list. Needs `HIKER_API_KEY` (+ `OPENAI_API_KEY` for phones).
- `src/iglead.ts` — finds a WhatsApp-reachable phone from an IG handle/website using OpenAI
  `web_search` (default model `gpt-5.4`; see `bench/RESULTS.md` for the benchmarked strategy).
  Best-effort: returns `{ phone: null }` and never throws when `OPENAI_API_KEY` is absent.
- `src/qualify.ts` — scores each lead 0–100 + tier (hot/warm/cold) + reason. Enrich-then-classify:
  re-pull HikerAPI signals, then an LLM with strict json_schema; tier is derived from score. Writes
  `qual_score`/`qual_tier`/`qual_reason` onto row vars, persisted incrementally for live tables.
- `src/dedupe.ts` — LLM consolidation pass run *after* rows are appended (remove/modify ops).
- `src/campaigns.ts` — lead-list + campaign + send-profile persistence (`getLeadList`, `UpsertRow`).
- `src/qualify.ts`/`sourcing.ts`/`dedupe.ts` are best-effort and degrade silently without their keys.

### Connectors & AI
- `src/attio.ts` — Attio connector: objects/attributes/lists, an **auto-detected** column mapping
  (`suggestMapping`, the part with unit tests), mapped pulls, and note write-back. Tested in
  `scripts/attio-logic.test.ts`.
- `src/instagram.ts` — official Instagram Business Login (OAuth) → 60-day token → real follower
  demographics. `IG_APP_ID`/`IG_APP_SECRET`.
- `src/google.ts` — "Continue with Google" (OIDC) + Gmail read/send. `GOOGLE_CLIENT_ID`/`SECRET`.
- `src/ai.ts` — Claude opener personalization + website research (`ANTHROPIC_API_KEY`, `AI_MODEL`).
- `src/onboarding.ts` — per-tenant onboarding checklist (`link → pitch → followup → first_send →
  ten_pitches`); `/dashboard` reads it to know whether onboarding is complete.
- `src/mcp.ts` — MCP server: a **thin REST client** over the app's own `/api/*`. It calls the running
  web app; all sending stays in the app. See `MCP.md`.

### Pitch generation
`src/pitch/CLAUDE.md` is the **authoritative spec for the creator → brand pitch voice** (structure,
length per channel, hard "never" rules, "write like a human" rules, worked examples). Read it before
touching anything that generates or prompts for pitch copy.

## Key references
- `README.md` — product overview, stack, security model, run/deploy summary.
- `DEPLOY.md` — Railway + custom-domain deploy (volume at `/app/data` is **critical** for persistence).
- `BRANDS.md` — the brands directory feature, data model & extraction.
- `MCP.md` — registering and using the MCP server.
- `bench/RESULTS.md` + `bench/` — the phone-sourcing model/strategy benchmarks that justify the
  `gpt-5.4` defaults in `iglead.ts`/`qualify.ts`/`dedupe.ts`.
- `docs/superpowers/specs/` — design specs (e.g. the dual-mode outreach platform design).

## Project conventions

### Nothing is hardcoded

The most important rule in this codebase: **never hardcode what should be data, and never leave
something static — wire it in.**

State, content, and config must come from real sources — the SQLite DB, an API response, env vars,
or per-tenant config — not from literals baked into views, scripts, or modules. A view that shows a
fixed placeholder, a count that's typed in, a feature that "looks done" but isn't connected to its
backend — none of these are acceptable as a finished state.

Concretely:
- **UI state is derived, never assumed.** Onboarding step completion/locks, whether a
  template/link/brand exists, counts, ticks, badges — all computed from real data (DB / `/api/*`),
  never a hardcoded `active`/`done`/`locked` class or a fixed number.
- **Never leave it static — actually wire it in.** If you add UI, connect it to a real endpoint and
  real persistence. If you add an endpoint, connect it to the DB and to the UI that uses it. "Static
  for now" / "stubbed" / "TODO: connect" is not done — finish the wiring in the same change.
- **`localStorage` is a temporary stand-in only.** Where a branch lacks a backend yet, client-side
  `localStorage` may bridge the gap, but it must be clearly marked TEMP and replaced with real
  persistence (table + API) before it's considered done. It is not an acceptable final state.
- **No hardcoded secrets, tokens, org/tenant IDs, or magic values.** Use `.env` / config (e.g.
  `HIKER_API_KEY`, `DB_PATH`, per-tenant Attio/IG tokens). Never paste a token or org id into source.
- **No hardcoded lists that belong in data.** Categories, taxonomies, brand seeds, copy that varies
  per tenant — load them, don't inline them.
- **Everything is tenant-scoped** and read through the DB layer, not assumed for a single user.

If you catch yourself typing a literal that represents user/runtime data, stop and wire it to a
source instead.

### Fail hard, fail loud — never swallow errors

When something goes wrong, **it must blow up visibly, not limp along.** A silent catch, a
swallowed exception, a default-on-error, a `catch {}` that hides the cause — all forbidden. We
would rather see a loud, ugly error than a feature that quietly does the wrong thing.

- **Don't catch to hide.** Only catch an error if you genuinely handle it (retry, add context, then
  re-throw). Never `catch` just to `return null`/`[]`/`undefined` and carry on as if nothing failed.
  No empty catches, no `|| fallback` that masks a real failure, no `.catch(() => {})`.
- **Throw with context.** Throw real `Error`s with a message that says what failed and why
  (include the operation, the tenant/account/id involved). A bare `throw e` that loses context is
  worse than wrapping: `throw new Error(\`send to \${accountId} failed: \${e.message}\`, { cause: e })`.
- **Always surface the error in the FE.** Every failure must reach the user. API routes return a
  non-2xx with a real `{ error }` message (not a generic 200-with-empty-body); the dashboard/views
  render that message visibly — a banner, an inline error, a failed-state badge — never a silent
  no-op or a spinner that never resolves. If the engine or a send fails, that state is written to
  the DB and shown in the UI, not logged-and-forgotten.
- **No silent partial success.** If a batch/loop hits an error, don't quietly skip the row and move
  on. Either fail the operation loudly or record the per-item failure and surface the count + reasons
  to the user.
- **No degrading silently — anywhere.** Even where code used to be "best-effort" (e.g.
  `iglead.ts`, `qualify.ts`, `sourcing.ts`, `dedupe.ts`), a real failure (network, auth, bad
  response, missing required config) must fail loud and surface in the FE. Do not swallow it as a
  silent degrade.

### Reuse what exists

Before writing new code, look for what's already here and use it. **Reuse existing modules, services,
helpers, and patterns rather than re-implementing them.**
- Send through `accounts.send()` / the engine — don't open your own WhatsApp socket.
- Read/write via the `db` handle and `campaigns.ts` helpers (`getLeadList`, `UpsertRow`) — don't hand-roll SQL access elsewhere.
- Encrypt credentials with `secret.ts` (`enc`/`dec`); derive tenants via the auth middleware; render through `views.ts`.
- Reach LLMs/providers through the existing wrappers (`ai.ts`, `iglead.ts`, `attio.ts`, `instagram.ts`, `google.ts`) so keys, models, and best-effort/no-throw behavior stay consistent.

If an existing helper *almost* fits, extend it in place rather than forking a parallel version.
