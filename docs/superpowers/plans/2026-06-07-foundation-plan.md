# Foundation — DB schema + seeds for the creator-first trilogy

**Date:** 2026-06-07
**Status:** Plan (zero-guesswork; ready to execute)
**Scope:** the shared DB layer + idempotent seeds underpinning three feature specs:
- `2026-06-07-creator-iq-design.md` (stage 1 → `creator_profiles`)
- `2026-06-07-brand-matching-design.md` (stage 2 → `creator_brand_matches`, `creator_brand_deals`)
- `2026-06-07-proposal-pricing-design.md` (stage 3 → `rate_cards`, `pricing_config`, `proposals`, `proposal_creators`)

**This plan changes exactly one production file: `src/db.ts`** (plus one new test file under `scripts/`). No
routes, no views, no feature modules. The three feature tracks build on top of what this lands.

> Conventions this plan obeys (from `CLAUDE.md`): `node:sqlite` only, no build step, import local modules
> with the `.ts` extension, everything tenant-scoped through `src/db.ts`, **nothing hardcoded** (rate cards /
> pricing live in DB rows, seeded from data — not literals scattered in feature modules), **fail loud** (a
> seed that can't apply throws; no silent `catch {}`). Seeds mirror the idempotent merge model of
> `upsertBrands` in `src/brands.ts`.

---

## 0. Ground truth (verified against `src/db.ts` and `src/brands.ts`, read 2026-06-07)

How `src/db.ts` declares schema today (the style every change below must match):
- One big `db.exec(\`...\`)` with `CREATE TABLE IF NOT EXISTS` blocks (lines 10–103, 168–259).
- A local helper `addColumn(table, col, decl)` (lines 106–112) that runs `ALTER TABLE … ADD COLUMN` inside a
  `try { } catch { /* already exists */ }` — the idempotent "add column if missing" idiom. **This is the only
  place in the file that swallows an error, and it does so deliberately because sqlite's `ALTER … ADD COLUMN`
  has no `IF NOT EXISTS`.** Reuse it; do **not** invent a second migration mechanism.
- A one-off table-rebuild migration for `brands` (lines 267–327) showing the file's pattern for guarded,
  fail-loud structural migrations: detect-by-DDL, `BEGIN`/`COMMIT`, `throw new Error(…, { cause })` on
  failure inside `catch`, `PRAGMA foreign_keys` toggled in `finally`.
- Row interfaces exported at the bottom (lines 329–474). New tables that feature code will read should get a
  matching `export interface …Row`.
- The whole file runs as **import-time side effects**; `src/server.ts` does `import { db } from './db.ts'`
  (line 7). So anything added here (tables, column migrations, seeds) executes once at process start, before
  any request. Seeds therefore live in `db.ts` (or a `seed.ts` it imports) — not behind a route.

`src/brands.ts` `upsertBrands` (lines 41–115) is the **idempotent-seed reference**: `INSERT … ON CONFLICT(<unique>)
DO UPDATE SET …` wrapped in `BEGIN`/`COMMIT`, `ROLLBACK`+`throw` on error. Seeds below copy this shape exactly
(minus the COALESCE-merge nuance, which only `upsertBrands` needs).

---

## 1. Reconciliation table — spec needs vs. reality

Verified by `grep -rn` across `src/` and `scripts/`: **none** of `creator_profiles`, `brand_matches`,
`creator_brand_*`, `proposals`, `proposal_creators`, `rate_cards`, `pricing_config`, or `profile_data` exist
anywhere in code. They were declared **only as SQL inside the dual-mode markdown spec**
(`2026-06-06-dual-mode-outreach-platform-design.md` lines 117–183) and **never built**. So every table below
is **net-new to the database**; the dual-mode "existing columns" the three specs reference are *spec text*,
not live columns — we create them fresh here, shaped by the dual-mode DDL + the stage-specific additions.

| Table / column | Declared in dual-mode spec? | In `src/db.ts` today? | This plan |
|---|---|---|---|
| `creator_profiles` (base: id, tenant_id, name, instagram_handle, tiktok_handle, youtube_channel, website, bio, profile_data, created_at, updated_at) | Yes (lines 117–129) | **No** | **CREATE net-new** with base cols |
| `creator_profiles` (+ creator_type, visual_signals, niche, content_style, engagement_rate, demographics, demographics_source, sectors, inferred_audience, past_deals, signals_used, summary, status, error, generated_at, updated_at) | No (stage-1 addition) | No | **ADD via `addColumn`** after create |
| `creator_brand_matches` (id, tenant_id, creator_id, brand_id, score, tier, move, reason, evidence, status, created_at, updated_at) | Partially — dual-mode had a *different*, campaign-scoped `brand_matches` (lines 147–156). Stage-2 **replaces** it with this creator-scoped table. | **No** | **CREATE net-new** (creator-scoped). Do **not** build dual-mode `brand_matches`. |
| `creator_brand_deals` (id, creator_handle, brand_id, brand_name, brand_handle, source, evidence_url, confidence, seen_at) + `idx_deals_brand`, `idx_deals_handle` | No (stage-2 addition; phase-2 feature) | No | **CREATE net-new** (table is phase-2 *use*, but we land schema now per the brief) |
| `rate_cards` (id, tier, platform, format, low, mid, high, currency, source, updated_at) | No (stage-3 addition) | No | **CREATE net-new** + seed |
| `pricing_config` (id, key, value_json, updated_at) | No (stage-3 addition) | No | **CREATE net-new** + seed |
| `proposals` (base: id, campaign_id, brand_match_id, creator_profile_id, tiers, stretch_goals, status, public_token, created_at) | Yes (lines 173–183) | **No** | **CREATE net-new** with base cols |
| `proposals` (+ brand_id, deal_type, gross_price, creator_net, platform_cut, take_rate_applied, guarantee, tenant_id, updated_at) | No (stage-3 addition) | No | **ADD via `addColumn`** after create |
| `proposal_creators` (id, proposal_id, creator_id, rate, status) | No (stage-3 addition; follow-phase) | No | **CREATE net-new** |

**Spec-vs-reality note for the build agent:** the dual-mode `brand_matches` (campaign-scoped, line 147) and
its `match_score`/`match_reasoning`/`brand_data` columns are **superseded** and NOT built. Stage 2's
`creator_brand_matches` is the creator-scoped successor. Likewise the dual-mode `proposals` has a
`campaign_id NOT NULL` + `brand_match_id`; the stage-3 model is **creator/brand-scoped** (`creator_profile_id`,
`brand_id`, `tenant_id`). To avoid a misleading `NOT NULL campaign_id` that stage 3 never populates, build the
**stage-3 shape** of `proposals` (keep `campaign_id` nullable for optional linkage; drop the `NOT NULL`). See
§2.4 for the exact reconciled DDL.

---

## 2. Exact schema changes to `src/db.ts` (in dependency order)

All edits go in `src/db.ts`. **Ordering matters** because of FK references:
`brands` and `tenants` already exist → `creator_profiles` → `creator_brand_matches` (FK `brands`) →
`creator_brand_deals` (FK `brands`) → `proposals` (FK `brands`, `tenants`) → `proposal_creators` (FK
`proposals`). `rate_cards`/`pricing_config` have no FKs and can be created anywhere in the block.

**Where to insert:** append a new `db.exec(\`…\`)` block **after** the existing `templates` table block (after
line 259) and **after** the `brands` rebuild migration (after line 327, so `brands` is in its final shape
before anything FKs to it). Put the new `addColumn` calls immediately after that new `db.exec`, then the seed
calls, then the new `export interface …Row` declarations at the bottom with the others.

### 2.1 `creator_profiles` — create base, then add stage-1 columns

Create with the dual-mode base columns, then promote stage-1 fields via `addColumn` (so the create stays a
faithful copy of the dual-mode declaration and the stage-1 promotion is visibly additive — and so a DB that
*had* somehow gotten the base table early still receives the new columns).

```ts
db.exec(`
  -- Creator IQ (stage 1): one structured profile per tenant. Base shape from the dual-mode spec;
  -- stage-1 fields promoted to real columns below via addColumn (queryable/joinable; rich detail stays JSON).
  CREATE TABLE IF NOT EXISTS creator_profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    instagram_handle TEXT,
    tiktok_handle    TEXT,
    youtube_channel  TEXT,
    website          TEXT,
    bio              TEXT,
    profile_data     TEXT,        -- JSON: legacy/overflow analysis blob (dual-mode)
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_creator_profiles_tenant ON creator_profiles(tenant_id);
`)

// Creator IQ stage-1 promoted columns (creatoriq.ts writes these incrementally; views/stage-2 read them).
addColumn('creator_profiles', 'creator_type',        'TEXT')    // 'content' | 'events' | 'both' (inferred)
addColumn('creator_profiles', 'visual_signals',      'TEXT')    // JSON: multimodal vision pass (subjects, aesthetic, on-camera brands)
addColumn('creator_profiles', 'niche',               'TEXT')
addColumn('creator_profiles', 'content_style',       'TEXT')
addColumn('creator_profiles', 'engagement_rate',     'REAL')
addColumn('creator_profiles', 'demographics',        'TEXT')    // JSON {age,gender,country,city} (instagram.ts fetchReport)
addColumn('creator_profiles', 'demographics_source', 'TEXT')    // 'ig_business' | 'none'
addColumn('creator_profiles', 'sectors',             'TEXT')    // JSON [{category,score,reason}] — categoryFacets() names; joins to brands.categories
addColumn('creator_profiles', 'inferred_audience',   'TEXT')    // JSON {summary, likely_buyer_sectors[], confidence:'inferred'|'measured'}
addColumn('creator_profiles', 'past_deals',          'TEXT')    // JSON [{brand,result,source:'self'|'caption'}]
addColumn('creator_profiles', 'signals_used',        'TEXT')    // JSON: which tiers/signals present vs missing (fail-loud)
addColumn('creator_profiles', 'summary',             'TEXT')
addColumn('creator_profiles', 'status',              'TEXT')    // 'idle'|'running'|'done'|'error'
addColumn('creator_profiles', 'error',               'TEXT')
addColumn('creator_profiles', 'generated_at',        'INTEGER')
// NOTE: updated_at already exists in the base CREATE above — do NOT addColumn it again (it would no-op via the
// catch, but leaving it out keeps intent clear).
```

### 2.2 `creator_brand_matches` + `creator_brand_deals` (+ indexes)

```ts
db.exec(`
  -- Stage 2 output: per-creator ranked brand shortlist (tenant-scoped). Fills live like Source/Qualify.
  -- Brand identity always lives in the shared `brands` catalog (written via upsertBrands); this references it.
  CREATE TABLE IF NOT EXISTS creator_brand_matches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    brand_id    INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    score       INTEGER,
    tier        TEXT,                          -- hot/warm/cold (derived in code, qualify-style)
    move        TEXT,                          -- 'comparable' | 'net_new'
    reason      TEXT,
    evidence    TEXT,                          -- JSON: lookalikes / Ad-Library campaigns / tags that drove it
    status      TEXT NOT NULL DEFAULT 'suggested', -- 'suggested'|'selected'|'rejected'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_cbm_creator ON creator_brand_matches(creator_id, status);
  CREATE INDEX IF NOT EXISTS idx_cbm_tenant  ON creator_brand_matches(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_cbm_brand   ON creator_brand_matches(brand_id);

  -- Stage 2 phase-2 dataset: mined PUBLIC deals about OTHER creators → global cache (provenance, like brands),
  -- reusable across tenants. NOT tenant-scoped on purpose. brand_id resolved when possible (else name/handle).
  CREATE TABLE IF NOT EXISTS creator_brand_deals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_handle TEXT NOT NULL,
    brand_id       INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    brand_name     TEXT,
    brand_handle   TEXT,
    source         TEXT NOT NULL,   -- 'ad_library'|'sponsor_tag'|'caption'|'usertag'|'event_sponsor'
    evidence_url   TEXT,
    confidence     TEXT,
    seen_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deals_brand  ON creator_brand_deals(brand_id);
  CREATE INDEX IF NOT EXISTS idx_deals_handle ON creator_brand_deals(creator_handle);
`)
```

> `creator_brand_deals` is **phase-2** for stage 2 (the brief asks us to land it now anyway). It's harmless
> empty schema; the index names `idx_deals_brand`/`idx_deals_handle` match the spec verbatim so phase-2 SQL
> (`GROUP BY brand_id`, `NOT IN (SELECT brand_id …)`) hits them.

### 2.3 `rate_cards` + `pricing_config`

```ts
db.exec(`
  -- Stage 3 pricing source-of-truth. SEEDED idempotently (see seedRateCards below). Currency-aware.
  -- low/mid/high are integer minor-unit-free whole-currency amounts (GBP pounds / USD dollars), matching the
  -- spec's benchmark tables. `source` is provenance so a proposal can footnote "based on 2026 UK market rates".
  CREATE TABLE IF NOT EXISTS rate_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tier       TEXT NOT NULL,     -- 'nano'|'micro'|'mid'|'macro'|'mega'  (content) | 'event' (event family)
    platform   TEXT NOT NULL,     -- 'instagram'|'tiktok'|'ugc'|'event'
    format     TEXT NOT NULL,     -- 'post'|'reel'|'story'|'video'|'ugc' | event deliverable slug
    low        INTEGER,
    mid        INTEGER,
    high       INTEGER,
    currency   TEXT NOT NULL,     -- 'GBP'|'USD'
    source     TEXT NOT NULL,     -- provenance string (e.g. '2026-uk-benchmark')
    updated_at INTEGER NOT NULL,
    UNIQUE(tier, platform, format, currency)   -- dedupe key for the idempotent seed
  );
  CREATE INDEX IF NOT EXISTS idx_rate_cards_lookup ON rate_cards(tier, platform, format, currency);

  -- Stage 3 pricing config: niche/usage/exclusivity/ER-curve/take_rate/bundle/guarantee/split — ALL config,
  -- never literals in proposals.ts. One row per key; value_json holds the structured value. Per-tenant
  -- override pattern: tenant-specific rows can be added later keyed e.g. 'take_rate:<tenantId>' (v1 seeds
  -- the global defaults only). Missing config => the pricing engine THROWS (never ships a 0% cut).
  CREATE TABLE IF NOT EXISTS pricing_config (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)
```

### 2.4 `proposals` (reconciled stage-3 shape) + `proposal_creators`

Create with the dual-mode base columns but with the **reconciliations** noted in §1 (campaign_id nullable, no
`NOT NULL` that stage 3 won't fill; `brand_match_id` kept nullable for optional linkage), then add the
stage-3 money/linkage columns via `addColumn`.

```ts
db.exec(`
  -- Stage 3: a priced, brand-facing proposal. Base shape from dual-mode spec, reconciled to creator/brand
  -- scope (campaign_id made nullable — stage 3 keys off creator_profile_id + brand_id, not a campaign).
  CREATE TABLE IF NOT EXISTS proposals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id        INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,  -- optional linkage (nullable; was NOT NULL in dual-mode)
    brand_match_id     INTEGER REFERENCES creator_brand_matches(id) ON DELETE SET NULL,
    creator_profile_id INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    tiers              TEXT NOT NULL,   -- JSON array of tier objects (prices live inside, dual-mode shape)
    stretch_goals      TEXT,            -- JSON array
    status             TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'sent'|'viewed'|'accepted'
    public_token       TEXT UNIQUE,     -- /p/:token access control (auth.ts token pattern)
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_creator ON proposals(creator_profile_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_token   ON proposals(public_token);
`)

// Stage-3 money + linkage columns (deterministic pricing engine writes these; /p/:token reads them).
addColumn('proposals', 'brand_id',          'INTEGER REFERENCES brands(id) ON DELETE SET NULL')
addColumn('proposals', 'deal_type',         "TEXT")       // 'creator_pitched' (default) | 'platform_campaign'
addColumn('proposals', 'gross_price',       'INTEGER')    // brand-facing total (take baked in)
addColumn('proposals', 'creator_net',       'INTEGER')    // gross × (1 − take_rate_applied)
addColumn('proposals', 'platform_cut',      'INTEGER')    // gross − creator_net
addColumn('proposals', 'take_rate_applied', 'REAL')       // negotiated rate actually used
addColumn('proposals', 'guarantee',         'TEXT')       // JSON {threshold, window_ends_at, state:'active'|'released'|'refunded'}
addColumn('proposals', 'tenant_id',         'TEXT REFERENCES tenants(id) ON DELETE CASCADE')
addColumn('proposals', 'updated_at',        'INTEGER')

db.exec(`
  -- Stage 3 follow-phase: platform_campaign proposals fan out to many creators. The brand pays one flat
  -- gross_price to the platform; each row holds a creator's individual rate. Per-creator pitched proposals
  -- never use this table. (Schema landed now; populated by the follow phase.)
  CREATE TABLE IF NOT EXISTS proposal_creators (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    rate        INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_creators_prop ON proposal_creators(proposal_id);
`)
```

> **`addColumn` caveat the build agent must know:** sqlite forbids adding a column with a non-constant default
> or certain FK forms in some versions, but a **plain `REFERENCES … ` clause with no default is accepted** by
> `ALTER TABLE … ADD COLUMN` in the sqlite shipped with Node 26 (verified shape matches existing `addColumn`
> usages like `account_id TEXT`). The FK on an added column is *declared but not retro-enforced* on existing
> rows — fine here, since these tables are net-new and empty. If any `addColumn` with a `REFERENCES` clause
> throws on the target runtime, fall back to a bare type (`'INTEGER'` / `'TEXT'`) — the application layer
> already scopes by tenant/keys; do **not** silently drop the column.

### 2.5 New `export interface …Row` declarations (bottom of file, with the others)

Add `CreatorProfileRow`, `CreatorBrandMatchRow`, `CreatorBrandDealRow`, `RateCardRow`, `PricingConfigRow`,
`ProposalRow`, `ProposalCreatorRow` mirroring the columns above (all nullable except PKs / `NOT NULL`
columns), so `creatoriq.ts` / `brandmatch.ts` / `proposals.ts` read typed rows. (Illustrative — match the
existing interface style exactly; JSON columns typed `string | null` with a `// JSON …` comment as the file
already does.)

---

## 3. Idempotent seeds (mirror `upsertBrands` / the Bento ingest)

Two seed functions. **Where they live:** add them to `src/db.ts` directly (so they run at import-time after
the tables exist), OR create `src/seed.ts` exporting `seedRateCards()` + `seedPricingConfig()` and `import`
+ call them at the bottom of `db.ts`. **Recommendation: a new `src/seed.ts`** — keeps `db.ts` focused on
schema, and the seed data (benchmark tables) is sizeable. `db.ts` ends with:

```ts
import { seedRateCards, seedPricingConfig } from './seed.ts'
seedRateCards()
seedPricingConfig()
```

Both must be **re-runnable without duplicating** (UNIQUE + `ON CONFLICT … DO UPDATE`, exactly like
`upsertBrands`), wrapped in `BEGIN`/`COMMIT` with `ROLLBACK`+`throw` on failure (fail loud — a seed that can't
apply must blow up at boot, not leave pricing half-populated).

### 3.1 `seedRateCards()` — GBP content + event-sponsorship benchmark tables (spec 3)

Data is a **literal-in-seed array** (this is the canonical source datum, not app state — analogous to the
benchmark tables in the spec; it lands in the DB so `proposals.ts` reads rows, never inlines numbers). Values
come straight from spec-3's tables. **`low`/`high` are the band ends; `mid` = rounded midpoint** (the pricing
engine picks within the band; storing `mid` gives it a default without a second source).

**GBP content rates** (`currency:'GBP'`, `source:'2026-uk-benchmark'`), `low`–`high` from spec-3:

| tier | platform | format | low | high |
|---|---|---|---|---|
| nano | instagram | post | 50 | 300 |
| nano | instagram | reel | 80 | 450 |
| nano | instagram | story | 30 | 150 |
| nano | tiktok | video | 50 | 300 |
| nano | ugc | ugc | 80 | 250 |
| micro | instagram | post | 150 | 800 |
| micro | instagram | reel | 250 | 1200 |
| micro | instagram | story | 80 | 350 |
| micro | tiktok | video | 150 | 900 |
| micro | ugc | ugc | 150 | 400 |
| mid | instagram | post | 500 | 2500 |
| mid | instagram | reel | 800 | 3500 |
| mid | instagram | story | 250 | 1000 |
| mid | tiktok | video | 500 | 2500 |
| macro | instagram | post | 2000 | 8000 |
| macro | instagram | reel | 3000 | 12000 |
| macro | instagram | story | 800 | 3000 |
| macro | tiktok | video | 2000 | 9000 |
| mega | instagram | post | 5000 | 25000 |

> `ugc` has no Mid/Macro/Mega row (spec marks "n/a"); Mega has only the IG-post row (spec marks "—" elsewhere).
> Seed exactly the rows above — **do not invent** the n/a cells. `mid` = `Math.round((low+high)/2)`.

**GBP event-sponsorship rates** (`tier:'event'`, `platform:'event'`, `currency:'GBP'`,
`source:'2026-uk-benchmark'`), formats = the deliverable slugs from spec-3:

| format | low | high |
|---|---|---|
| stage_shoutout | 100 | 600 |
| logo_placement | 150 | 1000 |
| booth | 300 | 2000 |
| host_appearance | 500 | 3000 |
| recap_package | 300 | 1500 |

Seed shape (mirrors `upsertBrands`):

```ts
export function seedRateCards(): void {
  const now = Date.now()
  const rows = [ /* the table above as {tier,platform,format,low,high} objects */ ]
  const ins = db.prepare(`
    INSERT INTO rate_cards (tier, platform, format, low, mid, high, currency, source, updated_at)
    VALUES (@tier, @platform, @format, @low, @mid, @high, @currency, @source, @now)
    ON CONFLICT(tier, platform, format, currency) DO UPDATE SET
      low = excluded.low, mid = excluded.mid, high = excluded.high,
      source = excluded.source, updated_at = excluded.updated_at
  `)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      ins.run({ ...r, mid: Math.round((r.low + r.high) / 2),
                currency: 'GBP', source: '2026-uk-benchmark', now })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`seedRateCards failed: ${(e as Error).message}`, { cause: e })
  }
}
```

> **USD secondary card (spec: "≈ ×1.27"):** out of scope to seed by hand — note for the build agent that USD
> rows are derivable later by multiplying GBP `low/mid/high` by a `pricing_config` FX factor at seed time
> (add a `usd_fx_from_gbp` config key, §3.2). v1 seeds **GBP only**; the pricing engine errors loud if asked
> for a currency with no card, rather than guessing.

### 3.2 `seedPricingConfig()` — defaults (spec 3 "Locked decisions")

One row per `key`; `value_json` is `JSON.stringify(value)`. **Idempotent via `ON CONFLICT(key) DO UPDATE`.**
Concrete defaults from spec-3 (`take_rate=0.15`; niche/usage/exclusivity/ER-curve multipliers; bundle
adjustment; guarantee `{threshold:1000, window, split}`):

```ts
const DEFAULTS: Record<string, unknown> = {
  take_rate: 0.15,                                   // global default; per-creator override = key 'take_rate:<tenantId>'
  bundle_adjustment: -0.10,                          // small multi-deliverable discount (spec: "(1 + bundle_adjustment)")
  niche_multipliers: {                               // matched-brand category → multiplier (spec: finance/SaaS/B2B 3–5× lifestyle)
    default: 1.0, lifestyle: 1.0, beauty: 1.1, fashion: 1.1,
    fitness: 1.2, food: 1.0, travel: 1.1,
    finance: 4.0, saas: 4.0, b2b: 3.5, tech: 2.0,
  },
  usage_rights_uplift: { none: 0.0, organic: 0.0, paid_ads: 0.35, full_buyout: 0.5 }, // +20–50%
  exclusivity_uplift:  { none: 0.0, '3mo': 0.15, '6mo': 0.3, '12mo': 0.5 },           // window-based
  er_curve: { expected: { nano: 0.04, micro: 0.03, mid: 0.025, macro: 0.018, mega: 0.012 },
              floor: 0.7, ceil: 1.5 },               // ER vs expected → 0.7–1.5× engagement_factor
  cpm_rails: { instagram: [5, 12], tiktok: [2, 8], youtube: [8, 15] },                // sanity rail (USD CPM bands)
  guarantee: { threshold: 1000, window_days: 30,                                       // signed ≥ £1,000 → money-back window
               split: { platform: 0.5, creator: 0.5 } },                              // post-window revenue split of the take
  usd_fx_from_gbp: 1.27,                              // for the secondary USD card (§3.1 note)
}
```

```ts
export function seedPricingConfig(): void {
  const now = Date.now()
  const ins = db.prepare(`
    INSERT INTO pricing_config (key, value_json, updated_at)
    VALUES (@key, @value_json, @now)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `)
  db.exec('BEGIN')
  try {
    for (const [key, value] of Object.entries(DEFAULTS))
      ins.run({ key, value_json: JSON.stringify(value), now })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`seedPricingConfig failed: ${(e as Error).message}`, { cause: e })
  }
}
```

> **Re-run safety:** `ON CONFLICT … DO UPDATE` means re-running at every boot **refreshes** defaults in place
> (no duplicate rows). This is intentional for `pricing_config` defaults. **Trade-off the build agent must
> flag:** if a tenant later overrides a *global default key* in place (rather than via a `key:<tenantId>`
> override row), the boot seed would overwrite it. Mitigation: per-creator/tenant overrides MUST use a
> distinct key namespace (`take_rate:<tenantId>`), never mutate the global `take_rate` row — the seed only
> ever owns the bare-key global defaults. Document this in `seed.ts` as a header comment. (Numeric defaults
> here are interpretable amounts; the exact niche/usage values are the spec's "defaults set now, evolve by
> config" — they are deliberately config, not code.)

---

## 4. Tiny `node:test` plan (pure logic only)

The foundation lands **data**, not pricing arithmetic — so there is almost no pure logic to test here. The
deterministic pricing function (formula + CPM rail) and any `getConfig`/`baseRate` helpers belong to the
**pricing track** (spec-3 build phase 2, `src/proposals.ts`) and are tested there, mirroring
`scripts/attio-logic.test.ts`. Two small, genuinely-foundation tests are worth adding now:

Create `scripts/seed.test.ts` (run with `node --test scripts/seed.test.ts`):
1. **Idempotency** — call `seedRateCards()` twice; assert `SELECT COUNT(*) FROM rate_cards` is identical after
   the second run (no duplication), and a known row (`nano/instagram/post/GBP`) has `low=50, high=300`.
2. **Config completeness + parse** — call `seedPricingConfig()`; assert every key in `DEFAULTS` is present and
   `JSON.parse(value_json)` round-trips (esp. `take_rate === 0.15` and `guarantee.threshold === 1000`).

> These tests import `src/db.ts`, which opens the DB at `DB_PATH`. To avoid touching the real volume DB, the
> test must set `process.env.DB_PATH` to a temp path **before** importing (e.g. a `:memory:`-style temp file
> via `os.tmpdir()`), since `db.ts` reads `DB_PATH` at module load. Note this in the test header. If a clean
> isolated-DB harness is more than the foundation warrants, **downgrade scope to test #2 only** (config
> round-trip is pure and needs no FK setup) and explicitly punt rate-card idempotency to the pricing track —
> do not skip silently.

No test is needed for the `addColumn` migrations or `CREATE TABLE IF NOT EXISTS` blocks (they're sqlite DDL,
exercised the moment the app boots; a boot failure is the loud signal).

---

## 5. Migration safety

- **Add columns to a possibly-existing table** with the existing `addColumn(table, col, decl)` helper (lines
  106–112): it wraps `ALTER TABLE … ADD COLUMN` in `try/catch` so a column that already exists is a no-op.
  This is the **one sanctioned swallow** in the codebase (sqlite has no `ADD COLUMN IF NOT EXISTS`). Reuse it
  for every `creator_profiles` / `proposals` promoted column above. Existing rows get the new column as `NULL`
  — safe, because all new feature code treats these as nullable/optional.
- **Create tables** with `CREATE TABLE IF NOT EXISTS` (the file's universal pattern) — re-running boot is a
  no-op. FK order matters (§2): create referenced tables (`creator_profiles`, `brands` already exists) before
  referencers (`creator_brand_matches`, `proposals`, `proposal_creators`).
- **No destructive rebuild needed.** Unlike the `brands` shared-catalog migration (lines 267–327), nothing
  here changes an existing table's shape — every table is net-new and every column is additive. So **no
  `PRAGMA foreign_keys=OFF` / table-swap dance is required.** (If a future change must alter one of these,
  follow the `brands` rebuild template: detect-by-DDL, `BEGIN`/transaction, `throw` with `cause` on failure.)
- **Fail loud if a seed can't apply:** both seed functions `ROLLBACK` + `throw new Error(…, { cause })` on any
  error (§3) — a malformed benchmark row or a constraint violation aborts boot with a real message, never a
  half-seeded `rate_cards`. This matches `upsertBrands`'s `catch { ROLLBACK; throw }`.
- **FK on `addColumn`'d columns** (`proposals.brand_id`, `proposals.tenant_id`): see the caveat in §2.4 — if
  the runtime rejects a `REFERENCES` clause on `ADD COLUMN`, fall back to the bare type; never drop the column.

---

## 6. Ordered execution checklist (zero-guesswork)

1. **`src/db.ts`** — after the `templates` block (line 259) and after the `brands` rebuild migration
   (line 327), append the new `db.exec` blocks in this order: `creator_profiles` (§2.1) → its `addColumn`s →
   `creator_brand_matches` + `creator_brand_deals` (§2.2) → `rate_cards` + `pricing_config` (§2.3) →
   `proposals` (§2.4) → its `addColumn`s → `proposal_creators` (§2.4).
2. **`src/seed.ts`** (new) — `seedRateCards()` + `seedPricingConfig()` per §3, with the header comment about
   the global-vs-`key:<tenantId>` override namespace.
3. **`src/db.ts`** — at the very bottom, `import { seedRateCards, seedPricingConfig } from './seed.ts'` and
   call both (after all tables exist).
4. **`src/db.ts`** — add the `export interface …Row` declarations (§2.5) with the existing interfaces.
5. **`scripts/seed.test.ts`** (new) — the two tests in §4 (or the downgraded scope), temp `DB_PATH` set before
   import.
6. **Verify:** `npx tsc` (no emit; type-check passes), then `node --test scripts/seed.test.ts`, then boot the
   app (`npm run dev`) and confirm it starts clean (tables + seeds apply at import without throwing). Spot-check
   `SELECT * FROM pricing_config` and `SELECT count(*) FROM rate_cards` (expect 24 GBP rows: 19 content + 5
   event).

---

## 7. Shared-file touchpoints, post-conditions, and risks

**Shared-file touchpoints.** Everything lands in **`src/db.ts`** (schema + column migrations + seed wiring) and
one **new `src/seed.ts`** + one **new `scripts/seed.test.ts`**. Because `db.ts` is a single file the three
feature tracks all import, **this foundation must land as one commit before any track starts** — there is no
parallel-edit story here; the tracks edit *other* files (`creatoriq.ts`, `brandmatch.ts`, `proposals.ts`) and
only *read* these tables/interfaces. No track should add columns to these tables independently — route any
later column through `addColumn` in `db.ts`.

**What each track can assume exists after this lands.**
- **Creator IQ (stage 1):** `creator_profiles` with all promoted columns + `idx_creator_profiles_tenant`, and
  the `CreatorProfileRow` type. It writes `status`/`error`/`sectors`/… incrementally; `sectors` uses
  `categoryFacets()` names to join `brands.categories`.
- **Brand Matching (stage 2):** `creator_brand_matches` (+ creator/tenant/brand indexes) referencing
  `brands.id` and `creator_profiles.id`; `creator_brand_deals` (+ `idx_deals_brand`/`idx_deals_handle`) ready
  for phase-2 mining. Brand identity still flows only through `upsertBrands` (this plan adds no second brand
  write-path).
- **Proposal Pricing (stage 3):** seeded `rate_cards` (GBP content + event family, queryable by
  `(tier,platform,format,currency)`) and `pricing_config` (all defaults incl. `take_rate=0.15`, guarantee
  block); `proposals` with money/linkage columns + `proposal_creators`. The pricing engine reads config/cards
  and **throws on any missing key/card** (never a 0% cut, never a guessed price).

**Risks / ambiguities to surface at review.**
1. **Dual-mode `brand_matches` is superseded, not built** (§1). If anything downstream still expects the
   campaign-scoped dual-mode shape, this plan diverges intentionally — flagged.
2. **`proposals.campaign_id` made nullable** (was `NOT NULL` in dual-mode). Justified because stage-3
   proposals are creator/brand-scoped, but it's a conscious deviation from the dual-mode DDL.
3. **`pricing_config` boot-refresh vs. tenant overrides** (§3.2): the seed overwrites bare-key global rows on
   every boot, so overrides MUST use the `key:<tenantId>` namespace. If the pricing track instead wants
   editable global config, switch the seed to **insert-only-if-absent** (`ON CONFLICT … DO NOTHING`) — call
   this out before building the editor.
4. **`addColumn` with a `REFERENCES` clause** (§2.4) may not be accepted by every sqlite build; fallback to
   bare type documented, but verify on the deploy runtime (Node 26 here, Railway).
5. **USD card deferred** (§3.1) — v1 is GBP-only; any USD request errors loud until the FX-derived seed is
   added. Confirm GBP-only is acceptable for v1.
6. **Test isolation** (§4) depends on setting `DB_PATH` before importing `db.ts`; if that harness is deemed
   heavier than the foundation warrants, scope down to the config round-trip test and punt rate-card
   idempotency to the pricing track — stated, not silent.
