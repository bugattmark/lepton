# Implementation plan — v1 brand estimation matcher (Stage 2, v1 only)

**Date:** 2026-06-07
**Spec:** `docs/superpowers/specs/2026-06-07-brand-matching-design.md` — build phases **v1 (1–5)** only.
**Scope:** the *rough brand estimation* matcher. Given a Creator IQ profile, produce a ranked,
reasoned brand shortlist by **sector overlap + audience fit + brand size band + geo**, seeded warm
by the creator's own on-camera / past-deal brands, plus a **net-new** sector-fit pool.
**OUT OF SCOPE (phase 2, follow-up only):** the comparable-deal engine — `src/deals.ts`, the
`creator_brand_deals` table, Apify Ad-Library extraction, HikerAPI `sponsor_tag` mining, lookalike
snowball, event-sponsor mining. This plan leaves clean seams where those plug in (marked **[P2 SEAM]**).

This mirrors the **`qualify.ts` pattern** end to end: a background runner with an in-flight `Set`,
incremental persist after every row, a status-snapshot endpoint the FE polls, deterministic
`tierOf`-style scoring, and an LLM used *only* for a one-sentence reason via strict `json_schema`.

---

## Cross-track ownership (assume; do not build)

- **Foundation track owns `db.ts`** — the `creator_brand_matches` table + indexes. This plan
  **references the columns** the spec defines (below) and **must not re-declare the table**. If the
  table is absent at build time, the runner fails loud (see §0 guard).
- **Creator IQ track owns `creator_profiles`** — produced upstream, read-only here. We consume
  `sectors`, `inferred_audience` / `demographics`, `visual_signals`, `past_deals`. If the profile
  row is missing, the matcher **fails loud** with `"profile not generated yet"` — never an empty list.

### Columns this plan depends on (spec §Data model — reference only)
```
creator_brand_matches(
  id, tenant_id, creator_id,
  brand_id  INTEGER REFERENCES brands(id),
  score     INTEGER,
  tier      TEXT,                       -- hot|warm|cold (derived in code)
  move      TEXT,                       -- 'comparable' | 'net_new'  (v1 writes 'net_new' + 'estimate')
  reason    TEXT,
  evidence  TEXT,                       -- JSON: which features/seeds drove the score
  status    TEXT,                       -- 'suggested'|'selected'|'rejected'
  created_at, updated_at )
-- indexes (foundation): UNIQUE(tenant_id, creator_id, brand_id); idx on (tenant_id, creator_id).
```

> **`move` value note for review.** Spec enumerates `move ∈ {'comparable','net_new'}`. v1 has no
> comparable engine, so the warm/sector-fit rows can't honestly be `'comparable'`. **Decision:** v1
> emits two move values — **`'estimate'`** (sector-fit / seeded-warm rows — the default path) and
> **`'net_new'`** (sector-fit minus already-marketing brands). Phase 2 introduces `'comparable'` and
> may re-label a subset of `'estimate'` rows. This keeps v1 labels truthful and leaves the
> `'comparable'` token free for P2. **Flagged for confirmation** — alternative is to write
> `'comparable'` now and treat it as "warm estimate," but that overstates confidence.

### Creator IQ input shape this plan assumes (read-only)
The matcher reads one `creator_profiles` row. Expected fields (JSON columns parsed in code):
- `sectors: string[]` — e.g. `["Skincare","Wellness","Fitness"]` — the primary match key.
- `inferred_audience` / `demographics: { geo?: {country?,region?}, age?, gender?, size?: number }`
  — audience country/region + an audience-size estimate (follower band proxy).
- `visual_signals: { brands?: string[] }` — brands seen on-camera (warm seed).
- `past_deals: { brand?: string, handle?: string }[]` — brands they've already worked with (warm seed).
- `creator_type?: string[]` — may include `'events'`; v1 does **not** branch on this (event-sponsor
  mining is P2) but the field is read into evidence so P2 can branch without a schema change. **[P2 SEAM]**

**Adapter, not assumption.** Because the Creator IQ schema is owned elsewhere and may differ, all
field access goes through **one** `readCreatorProfile(tenantId, creatorId)` adapter in `brandmatch.ts`
that parses the row and normalizes to a local `CreatorSignals` type. If a required field
(`sectors`) is missing/empty, it throws `Error('creator profile incomplete: no sectors — generate the Creator IQ profile first')`.
Adjacent fields default to empty (audience unknown lowers score, never fabricated — qualify rule).

---

## Step 0 — Preconditions & fail-loud guards (in `src/brandmatch.ts`)

**Reuse:** `hikerAvailable()` from `sourcing.ts`, `qualifyAvailable()`-style key check pattern.

Add at module top:
```ts
export const matchAvailable = () => !!process.env.OPENAI_API_KEY   // LLM reason needs it
// HikerAPI only needed when the catalog is THIN and we must snowball (see Step 2).
```

Guards (all throw real `Error`s, surfaced as non-2xx `{error}` by routes — never swallow):
1. `creator_brand_matches` table missing → throw `'creator_brand_matches table not found — run the foundation migration'`.
   Detect via `db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_brand_matches'").get()`.
2. `creator_profiles` row missing / no `sectors` → throw `'profile not generated yet'` (per ownership note).
3. Snowball needed but `HIKER_API_KEY` absent → throw `'HIKER_API_KEY not set — cannot expand a thin catalog'`
   (only when the sector-fit pool falls below `MIN_POOL`, see Step 2). Catalog-only runs don't need it.
4. LLM reason needed but `OPENAI_API_KEY` absent → throw at run start
   (`'OPENAI_API_KEY not set on the server'`), matching qualify's 400.

**No `catch {} return []`.** Every guard throws; the runner records `status:'error' + error` on the
match-run state and the route returns non-2xx — same contract as `runQualify`.

---

## Step 1 — `src/brandmatch.ts`: the estimation matcher (core)

**New module.** File: `/Users/eddydavies/code/mvps/lepton/src/brandmatch.ts`.
**Reuse:** `db` (db.ts), `listBrands`/`categoryFacets`/`upsertBrands` (brands.ts), `enrichHandle`/
`hikerAvailable` (sourcing.ts), `tierOf`/`extractText`-style LLM call (clone from qualify.ts).

### 1a. Types & constants
```ts
import { db } from './db.ts'
import { listBrands, upsertBrands, categoryFacets } from './brands.ts'
import { hikerAvailable, enrichHandle } from './sourcing.ts'

export type Tier = 'hot' | 'warm' | 'cold'
export const tierOf = (s: number): Tier => (s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold') // mirror qualify

export type Move = 'estimate' | 'net_new'              // 'comparable' reserved for P2  [P2 SEAM]

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'     // same default as qualify/sourcing
const RESP_ENDPOINT = 'https://api.openai.com/v1/responses'
const SNOWBALL_DEPTH = 1                                // open-question default (spec OQ#3)
const MIN_POOL = 25                                     // below this, snowball to net-new brands
const POOL_CAP = 200                                    // cap brands scored per run (bounded spend)

// Brand size bands — match ambition to the creator's audience size, not maximize.
// Bucketed on `brands.followers`; band index compared to the creator's own audience band.
const SIZE_BANDS = [1e3, 1e4, 1e5, 1e6, 1e7] as const   // <1k,1-10k,10-100k,100k-1M,1-10M,10M+
```

### 1b. Local signal types (the adapter output)
```ts
export type CreatorSignals = {
  creatorId: number
  sectors: string[]                 // normalized, lowercased for token-match
  audience: { country: string | null; region: string | null; size: number | null }
  seedBrands: string[]              // visual_signals.brands ∪ past_deals[].brand (warm seed)
  creatorType: string[]             // read-through for P2 event branch  [P2 SEAM]
}
function readCreatorProfile(tenantId: string, creatorId: number): CreatorSignals // throws if no sectors
```

### 1c. Candidate pool — sector-fit from the catalog (reuse brands.ts idiom)
The catalog read uses the **same JSON token-match idiom** as `listBrands`/`categoryFacets`:
`categories LIKE '%"<name>"%'` matching a quoted category token. Do **not** hand-roll new SQL access
to `brands` — call `listBrands({ category })` once per sector token and union by `brands.id`.

```ts
function sectorFitPool(signals: CreatorSignals): BrandRow[] {
  const seen = new Map<number, BrandRow>()
  for (const sector of signals.sectors) {
    // listBrands already applies categories LIKE '%"sector"%' and parses JSON for us.
    const { brands } = listBrands({ category: sector, limit: 200 })
    for (const b of brands) seen.set(Number(b.id), b as BrandRow)
  }
  return [...seen.values()].slice(0, POOL_CAP)
}
```
`BrandRow` = the row shape `listBrands` returns (id, name, followers, categories{main,secondary},
location_country/region, instagram_handle, description, status). **Ranking happens in JS** (spec:
"ranking in JS"); SQL only does the cheap category filter.

> **Token reconciliation.** Creator `sectors` and brand `categories` are free-text taxonomies that
> won't always align (e.g. `"Skincare"` vs brand `"Health/beauty"`). v1: (a) exact + case-insensitive
> token match first; (b) for sectors that returned **zero** brands, one LLM **fuzzy sector-reconcile**
> call (Step 4b) maps the creator's sector → the nearest existing `categoryFacets()` names, then we
> re-query with those. This keeps the deterministic path primary and uses the LLM only at the gap.

### 1d. Deterministic feature scoring (spell out the math)
For each candidate brand, compute four features in `[0,1]`, combine with fixed weights → `0–100`.

**Inputs:** `creator.sectors` (set), brand category set `B = main ∪ secondary` (set), creator
audience `{country, region, size}`, brand `{followers, location_country, location_region}`,
`creator.seedBrands` (set of names/handles).

1. **Sector overlap — Jaccard.**
   `Sset = lowercased creator.sectors`, `Bset = lowercased brand categories (main ∪ secondary)`.
   `jaccard = |Sset ∩ Bset| / |Sset ∪ Bset|`  (0 when either set empty).
   Token match uses the brands.ts idiom semantics (a brand category token equals a sector token, or
   one contains the other as a whole word → counts as intersection). `f_sector = jaccard`.

2. **Audience ↔ customer fit (geo + band proxy).** Two sub-parts averaged:
   - `geo`: `1.0` if `brand.location_country == creator.audience.country`; `0.5` if region/country
     unknown on either side (unknown ≠ penalty-to-zero — qualify's "missing = lower, not fabricated");
     `0.0` if both known and different.
   - `bandProxy`: brand follower band vs creator audience-size band (see #3) → reused so #2 and #3
     don't double-count; **`f_audience = geo`** only (band lives entirely in #3). *(Decision: keep
     audience = geo to avoid coupling; band is its own weighted feature.)*

3. **Brand size band — match ambition (not maximize).**
   `cb = bandIndex(creator.audience.size)`, `bb = bandIndex(brand.followers)` over `SIZE_BANDS`.
   `f_size = 1 - min(|cb - bb|, 3) / 3`  → 1.0 same band, decaying to 0 at ≥3 bands apart.
   If either size unknown → `f_size = 0.5` (neutral, not 0).

4. **Geo** — folded into #2 above as `geo`. *(Spec lists geo + audience as related features; v1
   implements geo as the audience sub-feature to avoid double-weighting. Documented here so the
   weight table totals cleanly.)* If a reviewer wants geo separate, split `f_geo = geo` and reduce
   `f_audience` to a future demographic match — left as a one-line change.

**Warm seed boost.** If the brand's `name` or `instagram_handle` is in `creator.seedBrands`
(the creator's own on-camera / past-deal brands), add a **flat `+15` after the weighted sum**
(capped at 100) and tag `evidence.seed = true`. This is the "seeded warm" requirement — a brand the
creator already works with / shows ranks at the top regardless of token overlap.

**Weighted score:**
```
base = 100 * ( 0.45*f_sector + 0.25*f_audience + 0.20*f_size + 0.10*f_geoConst )
```
where, since geo is inside `f_audience`, the cleaner v1 form actually used is:
```
base = 100 * ( 0.50*f_sector + 0.30*f_audience + 0.20*f_size )   // f_audience already encodes geo
score = clamp(round(base) + (seedMatch ? 15 : 0), 0, 100)
tier  = tierOf(score)
```
> **Weights are constants in code (not hardcoded *data*).** They are model coefficients, the
> analog of qualify's `tierOf` thresholds — acceptable as named consts (`W_SECTOR=0.5`, etc.), not
> per-tenant config in v1. Exposed as exported consts so tests pin them and a later config can
> override. **This is the documented exception to "nothing hardcoded"**: scoring coefficients, like
> the qualify tier thresholds already in the codebase, are algorithm constants, not runtime data.

**Function signatures (all pure, all unit-tested in Step 6):**
```ts
export function jaccard(a: string[], b: string[]): number
export function bandIndex(n: number | null): number              // 0..SIZE_BANDS.length
export function sizeFit(creatorSize: number|null, brandFollowers: number|null): number
export function geoFit(audCountry: string|null, brandCountry: string|null,
                       audRegion: string|null, brandRegion: string|null): number
export function scoreBrand(signals: CreatorSignals, brand: BrandRow): {
  score: number; tier: Tier; features: Record<string, number>; seed: boolean
}
```

### 1e. Per-brand LLM reason (clone qualify's `judge`)
**Reuse the exact qualify mechanism:** strict `json_schema` `{reason}` (reason-only — score is
deterministic, kept out of the schema so the model can't disagree), `reasoning:{effort:'low'}`,
`extractText` helper copied/imported, `MODEL=gpt-5.4`. The prompt is grounded: it receives the
brand dossier + the computed features + the creator's sectors/audience and must justify in **one
sentence**, citing only provided data, no fabrication. **Fail-loud variant:** unlike qualify's
best-effort fallback, on LLM failure record the per-row error into `evidence.reasonError` and keep
the deterministic score+tier (the row is still valid), and bump a run-level `errors` counter shown
in the FE. We never silently drop the brand.

```ts
async function reasonFor(signals: CreatorSignals, brand: BrandRow,
                         feat: Record<string,number>, seed: boolean): Promise<string>
```

### 1f. Orchestrator (the pure-ish ranking entrypoint, no persistence)
```ts
export async function rankBrands(signals: CreatorSignals, opts: { concurrency?: number } = {})
  : Promise<MatchRow[]>          // sorted score desc; each row carries brand_id, score, tier, move, reason, evidence
```
Flow: `sectorFitPool` → (if `< MIN_POOL`) snowball net-new (Step 2) → `scoreBrand` each →
`reasonFor` each (concurrency-capped like qualify, default 6) → sort desc → return. Persistence is
Step 3 (the runner calls `rankBrands` then writes incrementally).

> **[P2 SEAM]** `rankBrands` takes the deterministic feature vector as the single ranking input.
> Phase 2 adds a `comparableAffinity` feature (lookalike deal-graph count) to the same weighted sum
> and a `'comparable'` move — a new feature term + weight, no restructure. Leave a `// P2: + W_COMP*f_comparable`
> comment at the weighted-sum site.

---

## Step 2 — Net-new path (sector-fit minus already-marketing brands)

**Reuse:** `BRANDS.md` snowball helpers in `sourcing.ts` (`discoverByHashtag`/`enrichHandle`) +
`upsertBrands` (write path). **Depth 1** (spec OQ#3 default).

### 2a. When to snowball
Only when `sectorFitPool` < `MIN_POOL` (thin catalog for this creator's sectors) — most runs are
catalog-only and need no HikerAPI. When thin **and** `HIKER_API_KEY` present: snowball from the
creator's sectors (sector terms → hashtag/explore seeds, depth 1, dedupe by handle), enrich, and
**write discovered brands through `upsertBrands`** (never insert into `brands` directly). Then
re-run `sectorFitPool` to pick up the new rows. If thin and no key → throw (Step 0 guard #3).

### 2b. Absence-of-influencer-marketing heuristic (v1 = light)
Spec: keep absence detection **light for v1**; heavier signals (Ad-Library, coauthor/usertag mining)
are **[P2 SEAM]**. v1 net-new label = **sector-fit pool MINUS brands that obviously already do
influencer marketing**, where "obviously" is a cheap, local signal set (no new API calls):

```ts
export function isLikelyAlreadyMarketing(brand: BrandRow): boolean
// true (=> NOT net-new) when ANY light signal present:
//   - brand.status in ('contacted','enriched')           // we/others already engaged
//   - followers very high (>= SIZE_BANDS top band, ~1M+)  // big brands run influencer programs
//   - description/categories contain marketing-program markers
//     (case-insensitive whole-word: 'ambassador','creator program','#ad','affiliate','ugc','influencer')
```
**Net-new set:**
```ts
export function netNewSet(pool: BrandRow[]): BrandRow[]   // pool.filter(b => !isLikelyAlreadyMarketing(b))
```
Rows in `netNewSet` get `move:'net_new'` and a **−10 confidence haircut** on the deterministic score
(net-new is honestly lower-confidence per spec OQ#2 default), with `evidence.netNew = true` and a
reason noting "no obvious public influencer-marketing footprint (light v1 signal)." Brands not in
the net-new set keep `move:'estimate'`.

> **[P2 SEAM]** Spec's true net-new definition is *set-subtraction against the comparable mining
> union* (`net_new = sector_fit AND NOT IN (any lookalike's deal graph)`). v1's `isLikelyAlreadyMarketing`
> is the placeholder for that subtraction. Phase 2 replaces the heuristic body with
> `NOT IN (SELECT brand_id FROM creator_brand_deals)` — **same function name & signature**, so the
> ranker and tests don't change. Leave a `// P2: replace with NOT IN creator_brand_deals` comment.

---

## Step 3 — Persistence (incremental, mirrors qualify's per-row write)

**Reuse:** `upsertBrands` (any net-new discovered brand), `db` prepared statements. **Never write
brand identity directly** — `creator_brand_matches.brand_id` references `brands.id`, and any brand
not already in the catalog is first run through `upsertBrands` then its id read back by `name`.

### 3a. Run-state storage
Match-run progress (status/scanned/total/error/counts) needs somewhere to live so the status route
can poll it like qualify does. **Decision (flagged):** qualify stores its `QualifyConfig` inside the
lead-list `config` JSON; there is no equivalent owner row for a creator match-run. Two options:

- **(A) chosen for v1** — store run-state in an **in-memory `Map<creatorId, MatchRunState>`** keyed
  by `${tenantId}:${creatorId}`, exactly the single-instance assumption the engine/sessions already
  rely on (CLAUDE.md: "Single instance by design"). Rows themselves persist to `creator_brand_matches`
  (durable); only the transient progress counter is in memory. On restart, an interrupted run shows
  `idle` and its already-written rows remain — acceptable, matches how `running:Set` works today.
- **(B)** add a `match_runs` row — but that's foundation-track schema and out of this plan's lane.

→ **Use (A).** `MatchRunState = { status:'idle'|'running'|'done'|'error', scanned:number,
total:number, errors:number, lastRun:number|null, error:string|null }`. An in-flight `Set<string>`
(`${tenantId}:${creatorId}`) prevents double-start, exactly like `running` in qualify/sourcing.

### 3b. Incremental write
```ts
function upsertMatchRow(tenantId, creatorId, row: MatchRow): void
// INSERT ... ON CONFLICT(tenant_id, creator_id, brand_id) DO UPDATE
//   SET score,tier,move,reason,evidence,updated_at  (status preserved if already 'selected'/'rejected')
```
The runner writes each row **as it's scored+reasoned** (like qualify's `writeList` per row) and
bumps `state.scanned`, so the shortlist view fills live. Net-new brands discovered via snowball are
`upsertBrands`-ed first (Step 2a), their `brands.id` resolved, then the match row written.

`status` defaults `'suggested'`; a re-run **must not** clobber a user's `'selected'`/`'rejected'`
(the ON CONFLICT preserves status — only score/reason/evidence refresh). Fail-loud: a write error
throws and the runner records `state.error` + `status:'error'`.

---

## Step 4 — Background runner + routes

### 4a. Runner (in `brandmatch.ts`, mirrors `runQualify`)
```ts
const running = new Set<string>()                              // `${tenantId}:${creatorId}`
const RUNS = new Map<string, MatchRunState>()
export const isMatching = (tenantId: string, creatorId: number) => running.has(`${tenantId}:${creatorId}`)

export async function runMatch(tenantId: string, creatorId: number, concurrency = 6): Promise<void>
```
Body (qualify-shaped): guard double-start → `readCreatorProfile` (throws → state.error) → set
`status:'running'`, reset counters → `rankBrands` with a per-row callback that `upsertMatchRow`s and
bumps `scanned` (incremental) → `status:'done' + lastRun` on success → `status:'error' + error` in
catch → `running.delete` in finally. All errors recorded, none swallowed.

```ts
export function matchStatus(tenantId: string, creatorId: number)
// { status, scanned, total, errors, counts:{hot,warm,cold,net_new,estimate}, rows: ShortlistRow[] }
// rows joined creator_brand_matches ⨝ brands → {brand_id,name,logo_url,instagram_handle,followers,
//   location_country, score, tier, move, reason, status}
export function setMatchStatus(tenantId, creatorId, brandId, status:'selected'|'rejected'|'suggested'): boolean
```

### 4b. LLM fuzzy sector-reconcile (the one extra LLM use beyond per-row reason)
```ts
async function reconcileSectors(sectors: string[], known: string[]): Promise<Record<string,string[]>>
```
Only invoked for sectors whose catalog query returned zero brands (Step 1c). Strict `json_schema`,
maps each unmatched creator sector → nearest `categoryFacets()` names. Result re-queries the pool.
Fail-loud: on error, record `evidence.reconcileError` on the run and proceed with the exact-match
pool (don't fabricate mappings).

### 4c. Routes (in `src/server.ts`, mirror the qualify block at lines 585–632)
`tenantId` always from session middleware (`apiAuth`), never client input. All non-2xx return real
`{ ok:false, error }`.

```
GET  /api/match/creators                 -> list creators that HAVE a creator_profiles row (the selectable input)
                                            { ok, creators:[{id,name,handle}], ai: matchAvailable(), hiker: hikerAvailable() }
GET  /api/match/:creatorId/status        -> { ok, ...matchStatus() }            404 if no profile row
POST /api/match/:creatorId/run           -> 400 if !matchAvailable();
                                            void runMatch(tid, cid).catch(()=>{}); { ok:true }
                                            (errors surface via the status poll's state.error — same as qualify)
POST /api/match/:creatorId/select        -> body {brandId, status:'selected'|'rejected'|'suggested'}; { ok }
GET  /match (pageAuth)                    -> c.html(matchView(emailOf(tid)))    (Step 5)
```
Register imports alongside the existing `import * as qual from './qualify.ts'`:
`import * as match from './brandmatch.ts'` and add `matchView` to the views import on line 38.

> **Fail-loud at the route boundary:** `/run` returns 400 when `OPENAI_API_KEY` missing (qualify
> parity). The status route returns 404 when the creator has no profile — and `runMatch` itself
> throws `'profile not generated yet'` which the poll surfaces as `state.error` in a banner, so a
> missing profile is **never** a silent empty shortlist.

---

## Step 5 — View (`src/views.ts`): polling shortlist surface

**Reuse:** clone `qualifyingView` (lines 1209+) structure — `page()`, `shellNav(email,'match')`,
the `$`/`J`/`POST` helpers, the 3s poll loop, the `.badge` styles. Add the nav entry for `match`
wherever `shellNav` enumerates tabs (same place `qualifying` is registered).

```ts
export function matchView(email: string): string
```
Surface:
- **Creator selector** (`<select>` from `/api/match/creators`) — like qualify's list selector. Shows
  an AI-key note + a Hiker-key note when absent (so a thin-catalog snowball failure is pre-warned).
- **Run button** + status line (`● ranking… N/M scored`, error state shown inline — never a stuck
  spinner). Polls `/api/match/:creatorId/status` every 3s while `status==='running'`.
- **Tier breakdown badges** (`hot/warm/cold`) + **move counts** (`estimate N`, `net_new N`).
- **Ranked brand cards** (sorted score desc): brand name + logo + followers + country, the **score**
  (tabular-nums), a **tier badge**, a **move badge** — `comparable` (reserved/greyed for P2),
  `net_new` (amber, "lower-confidence" tooltip), `estimate` (neutral) — the one-sentence **reason**,
  and a **select / reject** action that `POST`s `/select` and updates the card state optimistically
  then reconciles on next poll.
- **Empty/error states explicit:** if `state.error` set → red banner with the message
  (`profile not generated yet`, missing key, etc.). Never render a blank "done" list on error.

Add a `.badge.netnew`/`.badge.estimate`/`.badge.comparable` style next to the existing hot/warm/cold
badge CSS.

---

## Step 6 — Tests (`node:test`, pure scoring only)

**New file:** `/Users/eddydavies/code/mvps/lepton/scripts/brandmatch-logic.test.ts`
(mirrors `scripts/attio-logic.test.ts`; run: `node --test scripts/brandmatch-logic.test.ts`).
Tests import the **pure exports** from `brandmatch.ts` — no DB, no network, no LLM.

Concrete cases:
1. **`jaccard`** — `(["a","b"],["b","c"]) → 1/3`; identical sets → `1`; disjoint → `0`; either
   empty → `0`; case-insensitive (`["Skincare"]` vs `["skincare"]` → `1`).
2. **`bandIndex`** — `null → -1`-or-`0` boundary (pin the chosen convention); `500 → 0`;
   `50_000 → 2`; `5_000_000 → 4`; values exactly on a `SIZE_BANDS` edge land in the documented band.
3. **`sizeFit`** — same band → `1`; 3+ bands apart → `0`; one band apart → `~0.667`; either null → `0.5`.
4. **`geoFit`** — same country → `1`; different known country → `0`; one side unknown → `0.5`;
   same region tie-break (if implemented) → `1`.
5. **`scoreBrand` weighted sum** — a brand with full sector overlap + same geo + same band →
   `score ≈ 100`; a half-overlap mid case → assert the exact weighted value (pins `W_SECTOR/AUDIENCE/SIZE`);
   **seed-match boost** adds exactly `+15` and caps at `100`.
6. **`tierOf`** — `70→hot`, `69→warm`, `40→warm`, `39→cold` (boundary triple).
7. **`netNewSet` / `isLikelyAlreadyMarketing`** — set-subtraction: pool of 4 with 1 high-follower +
   1 `status:'contacted'` + 1 with `'ambassador'` in description → only the remaining brand is
   net-new; assert the `−10` haircut and `move:'net_new'` on it, `move:'estimate'` on the others.

> Coefficients (`W_SECTOR`, `W_AUDIENCE`, `W_SIZE`, seed boost, net-new haircut, `SIZE_BANDS`) are
> **exported consts** so tests pin them and a change is a deliberate, test-breaking edit.

---

## Step 7 — Defaults for the spec's open questions (decided for v1)

- **OQ#2 Net-new appetite** → **ship day-one, labelled lower-confidence.** `move:'net_new'` rows
  appear in the shortlist with an amber badge + a `−10` score haircut + a reason noting the
  light-signal basis. (Spec default.)
- **OQ#3 Snowball depth** → **depth 1** (`SNOWBALL_DEPTH = 1`), only triggered when the catalog
  sector pool is thin (`< MIN_POOL`). (Spec/`BRANDS.md` default — depth 2 balloons cost.)
- **OQ#1 Flyer/logo OCR** → **out of v1** (event-sponsor mining is P2 entirely); text/tag signals
  only. Noted, no v1 work.

---

## Shared-file touchpoints

| File | Change | Notes |
|---|---|---|
| `src/brandmatch.ts` | **new** | the whole matcher (Steps 0–4b). |
| `src/server.ts` | +5 routes + 1 import | clone the qualify block (≈ lines 585–632); add `import * as match`; add `matchView` to the line-38 views import; `tenantId` from session only. |
| `src/views.ts` | +`matchView`, +badge CSS, +nav entry | clone `qualifyingView` (≈ line 1209); register `match` tab in `shellNav`. |
| `scripts/brandmatch-logic.test.ts` | **new** | pure scoring tests. |
| `src/brands.ts` | **read-only reuse** | `listBrands`/`categoryFacets`/`upsertBrands` — **no edits**; if `listBrands` needs to expose a field the ranker requires (e.g. it already returns all needed cols), extend in place rather than fork. |
| `src/db.ts` | **none in this plan** | `creator_brand_matches` is foundation-track; matcher only reads/writes via prepared statements + a `sqlite_master` existence guard. |

## Dependencies (external to this plan)
- **Foundation:** `creator_brand_matches` table + indexes must exist (Step 0 guard #1 fails loud if not).
- **Creator IQ:** `creator_profiles` rows with `sectors` (required) + audience/seed fields (Step 0 guard #2).
- **Env:** `OPENAI_API_KEY` (per-row reason + sector reconcile); `HIKER_API_KEY` (only for thin-catalog
  snowball). `IGLEAD_MODEL` optional (defaults `gpt-5.4`, shared with qualify/sourcing).

## Risks & mitigations
1. **Creator IQ schema drift** — fields may not match assumptions. *Mitigate:* single
   `readCreatorProfile` adapter; required-field absence throws a clear error, not a blank list.
2. **`move` semantics ambiguity** — spec enumerates `'comparable'|'net_new'`; v1 has no comparable
   engine. *Mitigate:* v1 uses `'estimate'`+`'net_new'`, reserves `'comparable'` for P2. **Flagged
   for confirmation** (could instead write `'comparable'` as "warm estimate" — overstates confidence).
3. **Token taxonomy mismatch** (sectors vs brand categories) yielding empty pools. *Mitigate:* LLM
   fuzzy sector-reconcile at the zero-result gap + thin-catalog snowball.
4. **Scoring coefficients as constants** — documented exception to "nothing hardcoded," analogous to
   qualify's `tierOf` thresholds; exported + test-pinned so they're auditable, not buried literals.
5. **Run-state in memory** (Step 3a option A) — lost on restart. *Mitigate:* matches persist durably;
   only the transient progress counter is volatile — consistent with single-instance design. Foundation
   could later add a `match_runs` row if durable progress is wanted.
6. **Spend** — bounded by `POOL_CAP` (≤200 brands/run) + qualify-style `concurrency` cap on LLM calls.

## Phase-2 seams (where the comparable engine plugs in — leave clean)
- **[P2 SEAM] ranking** — add a `comparableAffinity` feature + weight to `scoreBrand`'s weighted sum
  and a `'comparable'` move; marked with a `// P2:` comment at the sum site. No restructure.
- **[P2 SEAM] net-new** — replace `isLikelyAlreadyMarketing` body with
  `NOT IN (SELECT brand_id FROM creator_brand_deals)`; **same signature**, ranker/tests unchanged.
- **[P2 SEAM] event branch** — `CreatorSignals.creatorType` is already read; P2 branches on
  `'events'` to event-sponsor mining without a schema change.
- **[P2 SEAM] data layer** — `src/deals.ts` + `creator_brand_deals` table + Apify/HikerAPI mining are
  entirely P2; v1 never references them, so they add (not modify) when they land.
```
