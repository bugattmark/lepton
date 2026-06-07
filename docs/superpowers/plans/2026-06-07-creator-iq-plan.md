# Creator IQ — Implementation Plan (Stage 1)

**Date:** 2026-06-07
**Spec:** `docs/superpowers/specs/2026-06-07-creator-iq-design.md`
**Scope:** Stage 1 of the creator-first trilogy. Build the engine that produces one structured
`creator_profiles` row per tenant: niche, content style, engagement rate, demographics, a
sector vector scored against the live brand-category vocabulary, an inferred audience, and a
`PitchInput` adapter for stage 3.

**Out of scope (other tracks / later stages):**
- `creator_profiles` table + column DDL in `src/db.ts` — **owned by the foundation track**. This
  plan treats the columns in the spec's "Data model" block as given. Any column this plan needs
  beyond the spec is flagged in §0 (Foundation dependency), not added here.
- Brand matching (stage 2), pricing (stage 3), commerce connectors (Tier 3).

**Conventions this plan obeys (from `CLAUDE.md`):** Hono + `node:sqlite`; no build step; import
local modules with the `.ts` extension; `tenantId` is always derived from the session cookie via
`apiAuth`/`pageAuth`, never client input; nothing hardcoded (the sector vocabulary is `categoryFacets()`
data, models come from env); **fail loud** — no `catch {}` that hides a real failure, every failure
reaches the FE as a non-2xx `{error}` and a visible banner; reuse existing wrappers (`ai.ts`,
`instagram.ts`, `sourcing.ts`, `brands.ts`, `onboarding.ts`); pure logic is unit-tested with `node:test`.

> **One deliberate divergence from `qualify.ts` / `sourcing.ts`, justified:** those modules predate the
> current "fail loud" rule and use `.catch(() => null)` / `catch { return fallback }` to keep a *batch
> of many leads* moving past one bad row. Creator IQ profiles **a single creator (the tenant)** — there
> is no batch to protect, so a failure is not a "skip one row" event, it is *the* result. Therefore
> Creator IQ records each tier failure in `signals_used` (loud, surfaced) and only writes `status:'error'`
> + `error` when a **required** step fails. We mirror qualify's *shape* (background runner, in-flight Set,
> strict json_schema, code-derived tier, incremental persist) but **not** its silent swallow. This is
> called out again at each step.

---

## 0. Foundation dependency (verify before starting)

The foundation track must have created `creator_profiles` with **at least** these columns (spec
"Data model"). This plan reads/writes them as given:

```
id, tenant_id, name, instagram_handle,            -- existing dual-mode columns
creator_type        TEXT,   -- 'content' | 'events' | 'both'
visual_signals      TEXT,   -- JSON (Tier 0.5 vision output)
niche               TEXT,
content_style       TEXT,
engagement_rate     REAL,
demographics        TEXT,   -- JSON {age,gender,country,city}
demographics_source TEXT,   -- 'ig_business' | 'none'
sectors             TEXT,   -- JSON [{category,score,reason}]
inferred_audience   TEXT,   -- JSON {summary, likely_buyer_sectors[], confidence}
past_deals          TEXT,   -- JSON [{brand,result,source}]
signals_used        TEXT,   -- JSON (fail-loud transparency)
summary             TEXT,
status              TEXT,   -- 'idle'|'running'|'done'|'error'
error               TEXT,
generated_at        INTEGER,
updated_at          INTEGER
```

**Flag to the foundation plan (columns this plan needs that the spec does NOT list):**
1. **`authority_tier` is intentionally NOT a column** — derived per-sector in code (see §2.4). No request.
2. **A unique key for "the tenant's working row."** The spec says "one row per tenant for v1" but the
   dual-mode table keys by `id` with `tenant_id`. This plan assumes **`UNIQUE(tenant_id)` (or a
   `is_primary` flag)** so `getProfile(tenantId)` / upsert is unambiguous. **If the foundation table
   has no such constraint, request `UNIQUE(tenant_id)` for v1** (a `creatorProfile` is per-tenant
   singular here). Do not add the constraint from this track. If it cannot be added, this plan falls
   back to "newest row by `updated_at` for the tenant" and documents it — but flag it.
3. **No other columns required.** `inferred_audience.confidence` and `past_deals[].source` live inside
   the existing JSON columns, not new columns.

Add **one helper to the foundation's `db.ts` only if it doesn't exist** — otherwise put it in
`creatoriq.ts`: `getCreatorProfile(tenantId)` returning the row or `undefined`. Prefer to keep all
read/write SQL for `creator_profiles` **inside `creatoriq.ts`** (mirroring how `qualify.ts`/`sourcing.ts`
own their `lead_lists` config reads), so this track owns its data access and doesn't fork SQL elsewhere.

---

## 1. `src/sourcing.ts` — extend `enrichHandle` (Tier 0 captions/media + engagement rate)

**Goal:** make `enrichHandle` optionally return recent captions + media image/thumbnail URLs and a
computed engagement rate, **without breaking `qualify.ts`** which already calls
`enrichHandle(handle)` and reads `{followers, isBusiness, category, bio, externalUrl}`.

### 1.1 Back-compat strategy (do NOT change the existing return shape's required fields)

`qualify.ts` line 186 calls `await enrichHandle(handle)` and `dossier()` reads `enriched.followers`,
`.isBusiness`, `.category`, `.bio`, `.externalUrl`. **Extend the `Enriched` type with new OPTIONAL
fields** and gate the extra HikerAPI call behind an options arg so the existing call path makes
**zero** extra requests.

**Signature change:**

```ts
export type EnrichedMedia = {
  id: string
  caption: string
  imageUrl: string | null   // display/thumbnail URL for the vision pass (Tier 0.5)
  isVideo: boolean
  likes: number
  comments: number
  takenAt: number | null    // epoch ms, for recency ordering
}

export type Enriched = {
  username: string
  fullName: string
  followers: number
  isBusiness: boolean
  category: string
  publicPhone: string | null
  externalUrl: string | null
  bio: string
  // NEW — present only when enrichHandle is called with { withMedia: true }
  media?: EnrichedMedia[]          // most-recent-first, capped at opts.mediaCount (default 12)
  engagementRate?: number | null   // mean(likes+comments)/followers over fetched media, 0..1; null if uncomputable
  recentCaptions?: string[]        // convenience: media.map(m => m.caption).filter(Boolean)
}

export async function enrichHandle(
  username: string,
  opts: { withMedia?: boolean; mediaCount?: number } = {},
): Promise<Enriched | null>
```

- When `opts.withMedia` is falsy → **identical behaviour to today** (one `/v1/user/by/username` call,
  no `media`/`engagementRate`/`recentCaptions` keys). `qualify.ts` and `sourcing.ts` keep working
  untouched. **Do not edit their call sites.**
- When `opts.withMedia` is true → after the by-username call, fetch recent media via the HikerAPI
  user-medias endpoint and attach `media`, `recentCaptions`, `engagementRate`.

### 1.2 Media fetch (reuse the existing `hiker()` helper)

Add `export async function fetchRecentMedia(userIdOrUsername, count): Promise<EnrichedMedia[]>` that
calls HikerAPI's user-medias endpoint via the existing `hiker(path, params)` helper (which already
throws `HikerAPI <status>` on non-2xx — keep that; it is the fail-loud path).

- **Endpoint to confirm against the live HikerAPI account** (the bench fixtures don't include a medias
  call): the by-username response already returns `user.pk`/`id`; use the user-medias endpoint
  (`/v1/user/medias` or `/v2/user/medias`, param `user_id` or `username`, plus `amount`/`count`).
  Mirror `discoverByHashtag`'s tolerant array extraction (`Array.isArray(data) ? data : data.response ?? data.items ?? []`).
- Per item, map: caption (`caption.text` / `caption_text`), likes (`like_count`), comments
  (`comment_count`), `taken_at` (seconds → ms), `media_type`/`product_type` → `isVideo`, and the
  image URL: prefer `thumbnail_url` / `image_versions2.candidates[0].url` / `display_url`. Reels/videos
  expose a thumbnail — use it. **Tolerant field reads** (HikerAPI shapes vary), but **do not** wrap the
  whole fetch in a silent `try/catch` that returns `[]` — let `hiker()`'s throw propagate so the caller
  (`creatoriq.ts`) decides whether the failure is fatal or a recorded-in-`signals_used` degrade.

### 1.3 Engagement rate (pure, unit-tested — see §6)

Add and export a **pure** function so it's testable without the network:

```ts
// mean(likes+comments) across media, divided by followers. Returns 0..1, or null when
// it cannot be computed (no followers, or no media). Rounded to 4 dp.
export function computeEngagementRate(media: EnrichedMedia[], followers: number): number | null
```

- `followers <= 0` → `null`. `media.length === 0` → `null`.
- `er = mean(m.likes + m.comments) / followers`, clamp to `[0,1]`, round to 4 dp.
- Saves are not available from HikerAPI media — spec mentions "saves" but the source doesn't expose
  them; **document this omission in the function comment** (fail-loud-on-paper: don't pretend we have
  saves). Likes+comments is the standard public-ER proxy (matches the bench fixture's `avg_likes`/
  `avg_comments`).
- `enrichHandle({withMedia:true})` sets `engagementRate = computeEngagementRate(media, followers)`.

**Reuse vs add:** reuse `hiker()`, the `Enriched` type, and `discoverByHashtag`'s extraction idiom.
Add `EnrichedMedia`, `fetchRecentMedia`, `computeEngagementRate`, and the optional `Enriched` fields.
**Fail-loud:** `hiker()` already throws on HTTP error; `computeEngagementRate` returns `null` only for
genuinely-absent inputs (not to mask an error).

---

## 2. `src/creatoriq.ts` (new module) — the engine

Sibling to `qualify.ts`/`sourcing.ts`. Owns all `creator_profiles` read/write SQL, the tiered build,
the sector-inference LLM call, the inferred-audience step, the background runner, and the adapter.

### 2.1 Availability + imports

```ts
import { db } from './db.ts'
import { enrichHandle, hikerAvailable, type Enriched, type EnrichedMedia } from './sourcing.ts'
import { fetchReport, getConnection, type IgReport, type IgDemographics } from './instagram.ts'
import { snapshot } from './onboarding.ts'         // intake (Tier 2)
import { categoryFacets } from './brands.ts'       // live sector vocabulary
import { analyzeMedia } from './ai.ts'             // NEW vision helper (see §3)
import type { PitchInput } from './pitchgen.ts'

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'   // same default as qualify.ts
const ENDPOINT = 'https://api.openai.com/v1/responses'
export const creatorIqAvailable = () => !!process.env.OPENAI_API_KEY
```

### 2.2 `signals_used` — the fail-loud transparency object

Every run accumulates exactly what was present vs missing/failed. This is **the** mechanism that keeps
a thin profile from looking complete. Shape:

```ts
type SignalState = 'present' | 'missing' | 'error'
interface SignalsUsed {
  hiker:        { state: SignalState; detail?: string }  // Tier 0 captions/media/ER
  vision:       { state: SignalState; detail?: string }  // Tier 0.5
  demographics: { state: SignalState; detail?: string }  // Tier 1
  intake:       { state: SignalState; detail?: string }  // Tier 2
  inference:    { state: SignalState; detail?: string }  // sector LLM
}
```

- `missing` = the input legitimately isn't available (e.g. IG not connected) — lowers confidence, not
  an error. `error` = a call we expected to work threw (HikerAPI 500, OpenAI non-2xx) — surfaced as a
  red signal and, when the step is **required**, escalates to `status:'error'`.
- Persisted into `creator_profiles.signals_used` on **every** incremental write so the view shows it live.

### 2.3 Tiered profile build

A `buildProfile(tenantId)` orchestrator that calls tier helpers in order, writing incrementally after
each so the view fills live (mirroring `runQualify`'s per-row persist). Each tier helper returns its
slice + sets its `signals_used` entry; **none silently swallows** — they either return data, mark
`missing`, or record `error` and (for required tiers) throw.

- **Tier 0 — HikerAPI (required-ish).** `handle = getConnection(tenantId).username ?? snapshot(tenantId).profile?... ?? creator_profiles.instagram_handle`. If `hikerAvailable()` and a handle exist:
  `const e = await enrichHandle(handle, { withMedia: true })`. Sets `niche` seed (bio/IG category),
  `engagement_rate`, `recentCaptions`. On HikerAPI throw → `signals_used.hiker = {state:'error', detail}`;
  if Tier 0 produced **no** usable signal AND there's no intake fallback, the run is too thin → still
  proceed to inference but the inference's confidence is low (sectors may be empty). **No silent skip.**
  If `!hikerAvailable()` or no handle → `{state:'missing'}`.
- **Tier 0.5 — Vision** (see §3). Best-effort: pass `e.media` image URLs to `analyzeMedia`. Store
  `visual_signals` JSON. Failure → `signals_used.vision = {state:'error', detail}`, **recorded not
  swallowed**, build continues (vision is enriching, not required).
- **Tier 1 — Demographics.** `const rep = await fetchReport(tenantId)` **only when**
  `getConnection(tenantId).connected`. On success store `demographics` + `demographics_source='ig_business'`.
  When not connected → `demographics_source='none'`, `signals_used.demographics={state:'missing'}` (this
  drives the IG-connect upgrade CTA in the view). `fetchReport` throws `IgError('Instagram not connected',401)`
  if called without a token — so **gate on `connected` first**; if connected but `fetchReport` throws,
  record `{state:'error', detail}` (do not crash the whole build — demographics is an upgrade, not required).
  Note: `fetchReport` itself returns a soft `demographicsError` for pro-account-with-<100-followers — surface
  that string into `signals_used.demographics.detail`.
- **Tier 2 — Intake.** `const snap = snapshot(tenantId)`; pull `profile.name/roles/pitchTo/brandCategories/journey`
  and self-reported deals (if any captured). Always `present` when intake exists, else `missing`.

### 2.4 Sector inference — clone `qualify.ts`'s `judge()` exactly in shape

A single `gpt-5.4` `/v1/responses` call, `reasoning:{effort:'low'}`, **strict `json_schema`**
(`additionalProperties:false`), **tier derived in code**. This is the structural twin of `judge()`.

**Vocabulary is data, not a literal:** build the closed category set from
`categoryFacets()` (top-N by count, env-overridable `CREATOR_IQ_SECTOR_TOPN`, default 40) **unioned with
the creator's self-declared `brandCategories`** from intake. Pass that list into the prompt as the closed
set the model scores against. If `categoryFacets()` is empty (no brands seeded yet), **fail loud**:
record `signals_used.inference={state:'error', detail:'no brand categories in catalog — seed brands first'}`,
set `status:'error'`, surface in the view. (An inference against an empty vocabulary is worthless — exactly
the coupling the spec calls load-bearing.)

**Strict output schema (the model never sees the tier threshold — same trick as `tierOf`):**

```jsonc
{
  "type":"object","additionalProperties":false,
  "properties":{
    "primary_niche":{"type":"string"},
    "content_style":{"type":"string"},
    "creator_type":{"type":"string","enum":["content","events","both"]},
    "summary":{"type":"string"},
    "sectors":{"type":"array","items":{
      "type":"object","additionalProperties":false,
      "properties":{
        "category":{"type":"string","description":"MUST be one of the provided category names"},
        "score":{"type":"integer","description":"authority 0-100"},
        "reason":{"type":"string"}
      },"required":["category","score","reason"]
    }},
    "other_sectors":{"type":"array","items":{"type":"string"}}
  },
  "required":["primary_niche","content_style","creator_type","summary","sectors","other_sectors"]
}
```

**Prompt** carries qualify's rule verbatim in spirit: *"Score ONLY from the data provided; a missing
signal lowers confidence, never invent."* Inputs (all grounded): bio/IG category, **recent caption
corpus**, `visual_signals` (subjects/aesthetic/on-camera brands), demographics, engagement rate (framed
as a *credibility weight*, not a sector signal), self-reported deals + target categories, and the closed
category list.

**Post-processing in code (not the model):**
- `tierOf(score)` → `authority` per sector: `score>=70 ? 'strong' : score>=40 ? 'some' : 'none'`. Export
  this as `authorityTierOf(score)` (the structural twin of `qualify.ts#tierOf`), unit-tested (§6).
- **Hard-filter `sectors`** to only those whose `category` is in the closed set (drop hallucinated names
  defensively even though the schema asks for membership — strict schema doesn't enforce enum over a
  dynamic list). Dropped entries that aren't already in `other_sectors` get appended to `other_sectors`
  (low-confidence, **excluded from hard matching** per spec). **Record the drop count** in
  `signals_used.inference.detail` — never silently discard.
- `creator_type` stored to the `creator_type` column (downstream hint).

**Fail-loud divergence from `judge()`:** `judge()` returns a `{score:0}` fallback on any error so a batch
continues. Creator IQ inference is the whole product — on OpenAI non-2xx or parse failure, **throw**
`new Error('creator-iq inference failed: …', {cause})`; the runner catches it → `status:'error'` + `error`
+ `signals_used.inference={state:'error'}`. No `{score:0}` fallback that would look like a real profile.

### 2.5 Inferred audience (speculation, flagged `confidence:'inferred'`)

A **second** small LLM call (or a same-call sub-object — keep it a separate strict call for clarity and
so a demographics-less profile simply skips it). Input: the **real** Tier-1 demographics + primary niche.
Output strict-schema:

```jsonc
{ "summary":"string",
  "likely_buyer_sectors":[{"category":"<from the closed set>","reason":"string"}] }
```

Stored as `inferred_audience` JSON with `confidence:'inferred'` **set in code** (never from the model).
- **Only runs when `demographics_source==='ig_business'`** and demographics non-empty — otherwise
  `inferred_audience=null` and `signals_used` already shows demographics missing. (No real demographics →
  no speculation; we don't fabricate from nothing.)
- **Hard rule enforced structurally:** `inferred_audience` is stored as a *targeting hint only*. The
  adapter (§2.7) **must not** map it into any `PitchInput` field that becomes a factual claim. Add a code
  comment + a test asserting the adapter never copies `inferred_audience` counts into pitch-facing text.
- The `confidence` field is the seam for Tier 3: when a commerce connector later lands, it flips to
  `'measured'`. No connector built now.

### 2.6 Background runner (mirror `runQualify`/`runSourcing`)

```ts
const running = new Set<string>()                 // keyed by tenantId (single profile per tenant)
export const isGenerating = (tenantId: string) => running.has(tenantId)

export async function runCreatorIq(tenantId: string): Promise<void> {
  if (running.has(tenantId)) return
  running.add(tenantId)
  // upsert row, set status:'running', error=null, persist
  try {
    await buildProfile(tenantId)   // writes slices incrementally; sets status:'done', generated_at
  } catch (err) {
    // status:'error', error = (err as Error).message, persist  ← LOUD
  } finally {
    running.delete(tenantId)
  }
}
```

- In-flight `Set` keyed by **`tenantId`** (not listId) — one profile per tenant, single-instance per
  `CLAUDE.md`. Incremental persist after each tier so `getStatus` reflects partial progress live.
- `status` source of truth is the DB column; `getStatus` reports `running.has(tenantId) ? 'running' : row.status`
  (same idiom qualify uses).

### 2.7 `creatorProfileToPitchInput(tenantId): PitchInput` adapter

Reads the `creator_profiles` row, maps to `pitchgen.ts`'s `PitchInput`. **No re-cobbling from
`onboarding.snapshot()`** at pitch time — the profile is the grounded source.

| PitchInput field | Source |
|---|---|
| `name` | `name` (profile) ‹fallback intake name› |
| `roles` | `[niche, content_style]` filtered, or intake `roles` |
| `pitchTo` | intake `pitchTo` |
| `brandCategories` | `sectors` with `authority!=='none'`, mapped to `category`, sorted by score desc (these are *grounded* targets, not self-report) |
| `aboutText` | `summary` (the grounded profile summary) |
| `portfolioText`/`workText` | recent captions corpus (grounded "their own words"), capped |
| (none) | **`inferred_audience` is NOT mapped** — internal hint only, per §2.5 hard rule |

- Return a valid `PitchInput` even from a thin profile (missing fields just omitted — `pitchgen` already
  tolerates absent fields). If no profile row exists, **throw** `new Error('no creator profile for tenant; run Creator IQ first')`
  so the caller surfaces it rather than silently pitching from nothing. (Optionally the caller can decide
  to fall back to `onboarding.snapshot()` — but the adapter itself fails loud.)

### 2.8 Status snapshot for the view

```ts
export function creatorIqStatus(tenantId: string): {
  status: 'idle'|'running'|'done'|'error'
  error: string | null
  signalsUsed: SignalsUsed | null
  demographicsSource: 'ig_business'|'none'|null
  igConnected: boolean                 // getConnection().connected → drives upgrade CTA
  igConfigured: boolean                // ig.igConfigured() → whether connect is even possible
  profile: { niche, contentStyle, engagementRate, creatorType, summary,
             sectors:[{category,score,authority,reason}], demographics, inferredAudience,
             pastDeals, visualSignals, generatedAt } | null
} | null
```

Reads the row, parses JSON columns, derives `authority` per sector via `authorityTierOf`. Returns `null`
when no row exists yet (view shows the empty/generate state).

---

## 3. Visual analysis (Tier 0.5) — add `analyzeMedia` to `src/ai.ts`

**Reuse `ai.ts`** (the spec's instruction) rather than a new vision module. Add a multimodal Claude call.

### 3.1 Model gotcha (must fix)

`ai.ts`'s `MODEL` defaults to `claude-3-haiku-20240307` — **Haiku 3 is not reliably vision-capable** for
this analysis. Do **not** reuse the opener `MODEL` for vision. Add a separate env-driven model:

```ts
// Vision-capable model for Creator IQ media analysis. Override with VISION_MODEL.
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-haiku-4-5'
```

(Per repo convention, model ids come from env, never hardcoded business logic; the default must be a
current vision-capable Claude id — confirm against the Anthropic model list at build time.)

### 3.2 Signature + behaviour

```ts
export interface VisualSignals {
  subjects: string[]        // what/who appears (e.g. "fitness", "home interiors")
  aesthetic: string         // setting/style in a phrase
  topics: string[]          // recurring themes
  onCameraBrands: string[]  // brands/products visibly featured — warm leads for stage 2
}

// Fetch each image URL, send to Claude vision with the others, get one grounded VisualSignals.
// Best-effort on a per-image fetch (a 404 thumbnail is skipped + counted) but FAIL LOUD on the
// LLM call: throws on missing key / non-2xx / unparseable, so creatoriq records signals_used.vision='error'.
export async function analyzeMedia(
  imageUrls: string[],
  context?: { handle?: string; bio?: string },
): Promise<VisualSignals>
```

- **Image fetch:** download up to N (env `VISION_MAX_IMAGES`, default 6) image/thumbnail URLs as bytes,
  base64-encode, build Anthropic `content` blocks: `{type:'image', source:{type:'base64', media_type, data}}`
  interleaved with one `{type:'text', ...}` instruction. (Reuse the `AbortController`+timeout idiom already
  in `fetchPageText`.) A single image URL that 404s is skipped and counted in the returned detail — but if
  **zero** images load, return empty `VisualSignals` with all arrays `[]` and let the caller mark
  `vision:'missing'` (no images ≠ error). HikerAPI CDN URLs are expiring-signed (see bench fixture) — fetch
  promptly during the run, don't persist URLs for later.
- **LLM call:** strict-ish — request JSON only, parse, and **throw** on non-2xx / unparseable (unlike the
  opener helpers that `return null`). This is the fail-loud divergence again: vision failure must be
  *recorded*, and the only way `creatoriq` can record it is if `analyzeMedia` throws or returns a clearly
  empty result. **Choose throw for real errors, empty-result for genuinely-no-images.**
- **Prompt:** "Describe ONLY what is visibly present in these images; do not guess brands or settings not
  shown. List brands/logos only if clearly visible." (grounding rule, matches "never invent").

**Reuse vs add:** reuse `fetchPageText`'s timeout idiom and the `ANTHROPIC_API_KEY`/headers pattern; add
`VISION_MODEL`, `VisualSignals`, `analyzeMedia`. Keep `personalizeOpener` untouched.

---

## 4. Routes (`src/server.ts`) — mirror the qualify surface

`tenantId` always from `c.get('tenantId')` (session-derived via `apiAuth`). Every failure returns
non-2xx `{ok:false, error}`. Place these next to the qualify routes (~line 585) and import
`* as ciq from './creatoriq.ts'`.

| Method & path | Auth | Body | Response | Notes |
|---|---|---|---|---|
| `POST /api/creator-iq/generate` | `apiAuth` | `{}` | `200 {ok:true}` / `400 {ok:false,error}` | If `!ciq.creatorIqAvailable()` → `400 {error:'OPENAI_API_KEY not set on the server'}`. Else `void ciq.runCreatorIq(tid)` (background) and return immediately, exactly like `/api/qualify/lists/:id/run`. **Do not** `.catch(()=>{})`-swallow — the runner writes `status:'error'` to the row, which the status route surfaces. |
| `GET /api/creator-iq/status` | `apiAuth` | — | `200 {ok:true, ...status}` / `404 {ok:false,error:'no profile'}` | `ciq.creatorIqStatus(tid)`; `null` → 404. Poll target for the view. Includes `igConnected`/`igConfigured`/`demographicsSource` for the upgrade CTA. |
| `GET /api/creator-iq/profile` | `apiAuth` | — | `200 {ok:true, profile}` | (Optional convenience; status already carries `profile`.) Omit if status suffices. |

- Page route: `app.get('/creator-iq', pageAuth, (c) => c.html(creatorIqView(emailOf(c.get('tenantId')))))`
  registered next to `/qualifying` (line 201), and add `creatorIqView` to the `views.ts` import (line 38).
- **Reuse** the existing `/connect/instagram` route (line 754) for the upgrade CTA — the view links to it,
  no new connect route needed.

---

## 5. View (`src/views.ts`) — `creatorIqView`

Add `export function creatorIqView(email: string): string` modelled on `qualifyingView` (lines
1209–end): `page(...)`, `shellNav(email, 'creator-iq')`, the `$`/`J`/`POST` helpers, a poll loop.
Add `'creator-iq'` to `shellNav`'s tab set.

**Sections (all derived from `/api/creator-iq/status`, nothing hardcoded):**
1. **Header + Generate button** — "Generate profile" / "Regenerate". Disabled with a note when
   `creatorIqAvailable` is false (status carries an `ai` flag like qualify's `qAiNote`, or read from a
   small addition to status).
2. **Status line** — `idle/running/done/error`, polled every ~2.5s while `running` (clear interval on
   `done`/`error`, like qualify's poll).
3. **Error banner** — when `status==='error'`, render `error` in a visible red banner (reuse qualify's
   badge/error styling). **Never** a silent no-op or a spinner that never resolves.
4. **`signals_used` panel** — one row per tier with present/missing/error chip + detail. This is the
   fail-loud surface: a thin profile visibly shows what was missing. (green=present, grey=missing,
   red=error.)
5. **Sector vector** — table/bars of `sectors` sorted by score desc: `category · score · authority chip
   (strong/some/none) · reason`. `other_sectors` shown separately, labelled "low-confidence, not matched on."
6. **Demographics** — when `demographics_source==='ig_business'`: render age/gender/country/city. When
   `'none'`: render the **IG-connect upgrade CTA** — a visible card "Connect Instagram to add real
   audience demographics (raises profile confidence)" linking to `/connect/instagram`, shown only when
   `igConfigured` (else a muted "Instagram not configured on this server" note). This reuses the spec's
   `demographicsError` intent as an upgrade prompt.
7. **Inferred audience** — when present, render with an explicit **"Inferred — internal targeting hint,
   not a pitch claim"** label (enforces the hard rule visually).
8. **Visual signals** — subjects/aesthetic/topics/on-camera brands chips when present.

**Pattern reuse:** copy `qualifyingView`'s `$`/`J`/`POST`/`esc` helpers and poll structure verbatim;
copy the `.badge` CSS. Keep it plain HTML/JS strings (no framework), per `CLAUDE.md`.

---

## 6. Tests (`node:test`) — pure pieces only (`scripts/creatoriq-logic.test.ts`)

Match `scripts/attio-logic.test.ts` style: `import { test } from 'node:test'`, `assert`, import the
pure exports, no network. Run: `node --test scripts/creatoriq-logic.test.ts`.

**`computeEngagementRate` (from `sourcing.ts`):**
- empty media → `null`.
- `followers === 0` (and negative) → `null`.
- known case: media `[{likes:90,comments:3},{likes:88,comments:3}]`, followers 24388 → mean(184/2... )
  → assert ≈ `0.0039` (4dp) (uses the bench fixture's numbers as the oracle).
- clamps absurd input (likes > followers) to `1`.
- rounds to 4 dp (assert exact decimal).

**`authorityTierOf` (from `creatoriq.ts`):**
- 70 → `'strong'`, 69 → `'some'`, 40 → `'some'`, 39 → `'none'`, 0 → `'none'`, 100 → `'strong'`
  (boundary table — exact mirror of qualify's `tierOf` test intent).

**Dossier/feature builder (pure helper extracted from §2.4, e.g. `buildInferenceInput(parts)`):**
- includes only present signals (missing demographics/captions omitted, not `"null"` strings).
- includes the closed category list passed in.
- engagement rate framed as credibility (assert the label text present).

**Sector post-filter (pure helper, e.g. `filterSectors(raw, closedSet)`):**
- drops a sector whose `category` is not in the closed set; moves it to `other_sectors`.
- keeps valid ones; sorts by score desc; attaches `authority` via `authorityTierOf`.
- records dropped count (assert the returned detail/number).

**`creatorProfileToPitchInput` mapping (pure given a row object — inject the row, no DB):**
- maps `sectors` (authority≠none) → `brandCategories` sorted by score desc.
- maps `summary`→`aboutText`, `niche/content_style`→`roles`.
- **asserts `inferred_audience` text/counts do NOT appear** anywhere in the produced `PitchInput`
  (the hard-rule guard).
- thin row (only niche) → still returns a valid `PitchInput` with the rest omitted.

> Refactor note: to keep these pure, extract `buildInferenceInput`, `filterSectors`, and a row→PitchInput
> mapper that take **plain arguments** (not `tenantId`), so the DB-touching wrappers are thin. Same
> separation `attio.ts` uses for `suggestMapping`.

---

## 7. Defaults applied (spec "Open questions", locked)

1. **IG connect = optional upgrade, not a hard gate.** A profile generates and is usable without IG;
   `demographics_source='none'`, `signals_used.demographics='missing'`, profile flagged lower-confidence
   in the view, and the IG-connect **upgrade CTA** is shown (§5.6). The runner never blocks on IG.
2. **Caption-inferred past deals = suggest-then-confirm.** Where `#ad`/paid-partnership signals appear in
   captions (HikerAPI exposes `has_paid_partnership` per the bench fixture; per-post `#ad` from captions),
   surface suggested past deals stored as `past_deals[] = {brand, result:null, source:'caption'}`. These
   are **suggestions pending confirmation** — the view marks them "suggested from your posts — confirm?"
   and they stay `source:'caption'` until the user confirms (then `source:'self'`). Self-reported intake
   deals are `source:'self'` immediately. **Unconfirmed `source:'caption'` deals are NOT mapped into
   `PitchInput`** (don't pitch an unconfirmed claim) — same hard-rule discipline as inferred_audience.
   *(v1 may ship the suggestion+storage; the confirm UI is a small follow-on if time-boxed — but storage
   must already carry `source` so nothing is later mis-attributed.)*

---

## Shared-file touchpoints (coordinate with other tracks)

- **`src/sourcing.ts`** — `enrichHandle` signature gains an optional `opts` arg + optional return fields;
  `Enriched` type extended. **Shared with `qualify.ts` (line 186) — the no-opts call path is byte-for-byte
  unchanged; verify qualify still type-checks (`npx tsc`).** New exports: `EnrichedMedia`, `fetchRecentMedia`,
  `computeEngagementRate`.
- **`src/ai.ts`** — new `analyzeMedia` + `VisualSignals` + `VISION_MODEL`. `personalizeOpener`/
  `assessConversation` untouched (they keep their own `MODEL`).
- **`src/server.ts`** — 1 import line (38), 1 page route (~201), 3 API routes (~585), `* as ciq` import.
- **`src/views.ts`** — 1 import addition (38), `creatorIqView` export, `'creator-iq'` added to `shellNav`.
- **`src/db.ts`** — **read-only dependency** on the foundation track's `creator_profiles` columns; this
  track adds **no** DDL. All `creator_profiles` SQL lives in `creatoriq.ts`.
- **`src/pitchgen.ts`** — **no change required**: `PitchInput` already fits; the adapter fills it. (If a
  future field is wanted, that's a separate change — not in this plan.)

## Dependencies (ordered)

1. **Foundation track `creator_profiles` table** (§0) — blocks `creatoriq.ts` read/write and the adapter.
   Confirm the `UNIQUE(tenant_id)`/primary-row question (§0.2) before coding the upsert.
2. **`brands` catalog seeded** — `categoryFacets()` must be non-empty or inference fails loud (§2.4). The
   Bento seed (recent commit `75d3eab`) provides this.
3. `OPENAI_API_KEY` (inference, required), `HIKER_API_KEY` (Tier 0/0.5 media — without it, `missing`),
   `ANTHROPIC_API_KEY` + vision-capable `VISION_MODEL` (Tier 0.5), `IG_APP_ID/SECRET` + tenant IG connect
   (Tier 1 upgrade). All degrade to `missing` (loud), never silent.

## Risks / unknowns

- **HikerAPI media endpoint shape (§1.2) is unverified** — the bench fixtures only cover by-username/iglead,
  not a per-post medias call. The exact path (`/v1/user/medias` vs `/v2/...`), param name (`user_id` vs
  `username`), and the image-URL field must be confirmed against the live key during implementation;
  build `fetchRecentMedia` tolerant + log the raw shape once. This is the single biggest implementation
  unknown.
- **HikerAPI image URLs are expiring-signed** (bench fixture shows `Expires=`/`Signature=` CloudFront
  URLs) — must be fetched for the vision pass **during the run**, not stored and re-fetched later.
- **Vision model id** must be a current vision-capable Claude (the `ai.ts` Haiku-3 default would silently
  produce garbage on images) — pin via `VISION_MODEL` env, confirm the default against the live model list.
- **Strict json_schema cannot enforce a dynamic enum** (the category list is runtime data) — the §2.4
  code-side `filterSectors` guard is mandatory, not optional, or hallucinated categories would poison the
  stage-2 join.
- **Empty brand catalog** → inference is worthless; handled by failing loud (§2.4) rather than producing a
  plausible-but-useless profile.
- **"saves" in engagement rate** are not available from HikerAPI media; ER uses likes+comments only,
  documented in-code so the number isn't mistaken for the spec's literal formula.
- **Cost/latency:** a generate runs HikerAPI media + up to 6 image downloads + a vision call + 1–2 gpt-5.4
  calls. Single-tenant, user-initiated, backgrounded — acceptable, but the in-flight `Set` must prevent
  double-starts (mirrors qualify).
```
