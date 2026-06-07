# Creator IQ — design

**Date:** 2026-06-07
**Status:** Draft (approved direction; pending spec review)
**Stage:** 1 of 3 in the creator-first intelligence trilogy
**Builds on:** `2026-06-06-dual-mode-outreach-platform-design.md` §4 (Creator Profiles) — this spec makes that sketch concrete and structured.
**Feeds:** `2026-06-07-brand-matching-design.md` (stage 2), `2026-06-07-proposal-pricing-design.md` (stage 3).
**External data sources:** `2026-06-07-external-data-sources-design.md` proposes Apify (cross-platform reach, Tier 1.5) + Exa (creator web footprint, Tier 1.6) as additive tiers here.

## Overview

Creator IQ is the **front door** of the creator-first pipeline. Given a creator (the tenant
themselves, via their own Instagram), it builds one structured `creator_profiles` row that
answers: *what do they create, who is their audience, and — therefore — which sectors do they
have authority in?* That profile is the single source of truth that stage 2 (brand matching)
and stage 3 (priced proposals) both read.

**Creator type is irrelevant to the engine.** A pure content creator and an event organiser are
profiled identically: both post content and have an audience, so the same content+audience inference
yields their sectors and who's interested in them. They differ only *downstream* — an event
organiser's matches are *event sponsors* (stage 2) and their proposal deliverables are *sponsorship
packages* (stage 3), not Reels. Creator IQ records an inferred `creator_type`
(`content` | `events` | `both`) as a hint for the later stages, derived from the same signals (event
posts, ticket/RSVP links, venue tags).

The whole pipeline composes only because of one load-bearing decision: **Creator IQ scores a
creator's expertise against the live brand-category taxonomy** (`brands.categories`, surfaced by
`categoryFacets()` in `src/brands.ts`), not an invented vocabulary. A sector label that doesn't
exist in the brands catalog is worthless to the matcher. This coupling is the reason stage 1
must ship first.

The codebase already contains the exact blueprint: `src/qualify.ts`'s **enrich-then-classify**
pattern (HikerAPI dossier → strict `json_schema` LLM call → incremental persist). Creator IQ
mirrors it, pointed at one creator (the tenant's own handle) instead of a list of leads.

## Goals / non-goals

**Goals**
- Produce a structured, regenerable `creator_profiles` row per tenant.
- Emit, at minimum, every creator input `src/pitchgen.ts`'s `PitchInput` already consumes
  (niche/roles, content style, engagement rate, audience demographics, past deals, target
  categories) — richly grounded instead of cobbled from onboarding text alone.
- Produce a **sector vector**: `[{category, score, reason}]` where `category` ∈ the live
  brand-category vocabulary, so stage 2 can rank brands by sector overlap with a trivial join.
- Degrade gracefully: a thin profile is allowed, but it must declare what was missing
  (fail-loud), never look "complete" when it isn't.

**Non-goals**
- Building Shopify / Eventbrite / Stripe connectors now (see "Audience & buyer signals").
- Profiling arbitrary third-party creators (this profiles the tenant's *own* presence). A future
  "scout creators" inverse feature can reuse the engine but is out of scope here.
- Any brand matching or pricing (stages 2 and 3).

## Data sources — what's obtainable, per the locked decision

The creator is the **tenant themselves**, which unlocks a privileged path the lead pipeline
never has: IG Business Login on their *own* account (`src/instagram.ts` already implements the
full OAuth → 60-day token → `fetchReport()` returning real `follower_demographics`).

Built as **progressive tiers** that degrade gracefully (matching the app's best-effort-enrich grain):

| Tier | Source | Signals | Effort | Confidence |
|---|---|---|---|---|
| **0** | HikerAPI on the handle (`enrichHandle` in `sourcing.ts`, extended to pull recent captions/media) | bio, IG category, follower count, recent captions, **computed engagement rate** | zero (no auth) | high |
| **0.5** | **Visual content analysis** — pull recent post images / video thumbnails, run a multimodal vision pass (Claude via `ai.ts`) | what they actually show & talk about, setting/aesthetic, **products & brands visible on-camera**, who-they-are signals captions miss | zero (no auth) | medium–high |
| **1** | IG Business Login (`instagram.ts` `fetchReport()`) | **real audience demographics** (age, gender, top countries/cities) — "the most important asset" per the pitch spec | one click | high (when connected) |
| **2** | Onboarding intake (`onboarding.ts` `IntakeProfile`: name, roles, pitchTo, brandCategories, journey) | personality, goals, self-reported target categories, self-reported past deals | already captured | self-report |
| **3** | Commerce connector seam (Shopify/Eventbrite/Stripe) — **designed, not built** | real event attendees / merch buyers | deferred | — |

### Audience & buyer signals (the events/merch decision)

The vision asked for "who attends their events / buys their merch." That raw data is **not
obtainable** without the creator connecting a commerce backend (confirmed: not in IG, not in
HikerAPI, not scrapable). Per the locked decision, v1 does **not** drop the concept and does
**not** build connectors — instead it **speculates**:

- Derive an **inferred audience/buyer profile** from the *real* Tier-1 demographics + niche
  (e.g. "audience skews 78% women 22–35 UK → likely buyers of beauty / activewear / homeware").
  This is an LLM inference over real demographic data, stored as `inferred_audience` JSON and
  **explicitly flagged `confidence: 'inferred'`**.
- **Hard rule (per `pitch/CLAUDE.md` and CLAUDE.md "never invent"):** inferred buyer/attendee
  signals may inform *sector scoring and brand matching*, but must **never** be surfaced to a
  brand as a factual proof point ("3,000 of my followers bought X"). They are internal
  targeting hints, not pitch claims. The pitch generator already refuses to state unprovided
  stats; we keep that boundary.
- Leave a **Tier-3 connector seam** (a `creator_connections` shape, unbuilt) so that when a
  creator later connects Shopify/Eventbrite/Stripe, real buyer data replaces the inference and
  upgrades `inferred_audience.confidence` to `'measured'`.

### Visual content analysis (Tier 0.5)

Captions and bios under-describe a creator; the imagery is often the truer signal of *who they are
and what they talk about*. Pull the creator's recent post images and video thumbnails (via the
extended `enrichHandle` media fetch) and run a **multimodal vision pass** through `ai.ts` (Claude is
vision-capable): extract the subjects/settings they appear in, the aesthetic, recurring topics, and
**products/brands visibly featured on-camera**. This feeds two things — (a) the sector inference
below, grounding it in what's *shown* not just written, and (b) a head-start on stage-2 brand
discovery (brands already appearing in their content are warm). Vision output is stored as
`visual_signals` JSON and treated as grounded observation, never invented. Best-effort + fail-loud:
a failed vision call is recorded in `signals_used`, not silently skipped.

## Sector / expertise inference (the core)

A single LLM call mirroring `qualify.ts`'s `judge()`: `gpt-5.4`, `reasoning:{effort:'low'}`,
OpenAI `/v1/responses`, strict `json_schema` (`additionalProperties:false`), incremental persist.

**Inputs (all grounded, never invented):** niche/bio/IG category, recent caption corpus (the
highest-signal source — exactly what Modash/HypeAuditor mine), audience demographics, engagement
rate (a credibility weight, not a sector signal), self-reported deals + target categories.

**The vocabulary is data, not a literal (satisfies "nothing is hardcoded").** The inference is
handed the **live list of brand categories** (`categoryFacets()` names, bounded to the top-N by
count plus the creator's self-declared `brandCategories`) as the closed set it scores against.
It returns, per relevant category, a `0–100 authority score` + a one-sentence grounded reason —
structurally identical to qualify's `{score, reason}`, just N categories. An `other: []`
free-text overflow is allowed but flagged lower-confidence and **excluded from hard matching**.

```jsonc
// LLM output schema (strict)
{
  "primary_niche": "string",
  "content_style": "string",
  "summary": "string",
  "sectors": [
    { "category": "<must be a categoryFacets() name>", "score": 0, "reason": "string" }
  ],
  "other_sectors": ["string"]   // free-text overflow, low confidence, not matched on
}
```

The `authority` tier (`strong` ≥70 / `some` ≥40 / `none`) is derived **in code** from `score`
(kept out of the schema so the model can't disagree with the threshold — the same trick
`qualify.ts` uses for `tierOf`). The prompt carries qualify's rule verbatim in spirit:
*"Score only from the data provided; a missing signal lowers confidence, never invent."*

## Data model

Extend the `creator_profiles` table already declared in the dual-mode spec (§4) rather than
forking a new one. Today it has `profile_data TEXT` (a JSON blob); we promote the
stage-2-critical fields to real columns (queryable, joinable) and keep rich detail in JSON.
One row per tenant for v1 (the dual-mode table keys by `id` with `tenant_id`; we keep that and
treat the tenant's primary profile as the working row).

New / promoted columns (added via the existing `addColumn`/`CREATE TABLE IF NOT EXISTS`
convention in `db.ts`):

```
creator_profiles (
  ... existing dual-mode columns (id, tenant_id, name, instagram_handle, ...) ...
  creator_type        TEXT,   -- 'content' | 'events' | 'both' (inferred; selects downstream paths)
  visual_signals      TEXT,   -- JSON: multimodal vision pass over recent media (subjects, aesthetic, on-camera brands)
  niche               TEXT,
  content_style       TEXT,
  engagement_rate     REAL,
  demographics        TEXT,   -- JSON {age,gender,country,city}  (instagram.ts fetchReport)
  demographics_source TEXT,   -- 'ig_business' | 'none'
  sectors             TEXT,   -- JSON [{category,score,reason}]  ← joins to brands.categories
  inferred_audience   TEXT,   -- JSON {summary, likely_buyer_sectors[], confidence:'inferred'|'measured'}
  past_deals          TEXT,   -- JSON [{brand,result,source:'self'|'caption'}]
  signals_used        TEXT,   -- JSON: which tiers/signals were present vs missing (fail-loud)
  summary             TEXT,
  status              TEXT,   -- 'idle'|'running'|'done'|'error'
  error               TEXT,
  generated_at        INTEGER,
  updated_at          INTEGER
)
```

## Module & runtime

- **New module `src/creatoriq.ts`** (sibling to `qualify.ts` / `sourcing.ts`). Does *not*
  overload `onboarding.ts` (a checklist state machine) but *reads from* it for intake fields.
- **Background runner** mirroring `runQualify`: an in-flight `Set`, writes `status`/`error` to
  the row, persists incrementally so the profile view fills live. Single-instance per CLAUDE.md.
- **Adapter `creatorProfileToPitchInput(tenantId): PitchInput`** so `pitchgen.ts` pulls the full
  grounded profile instead of cobbling inputs from `onboarding.snapshot()`. `PitchInput`'s shape
  already aligns — Creator IQ just fills it richly. This is the clean handoff into stage 3.
- **Stage-2 handoff:** stage 2 reads `creator_profiles.sectors` (category→score) and ranks
  `brands` by category overlap. No contract beyond "sectors uses `categoryFacets()` names."

## Error handling (fail loud, per CLAUDE.md)

- Generation writes `status`/`error` to the row; the dashboard renders a real error banner if
  HikerAPI/OpenAI fail. No silent `return null` that leaves a blank profile looking "done."
- When IG isn't connected, demographics are absent and `demographics_source='none'`; the profile
  view surfaces the existing `demographicsError` prompt as a visible **upgrade CTA**, and
  `signals_used` records the gap. A profile built without demographics is marked lower-confidence,
  not silently equivalent to a connected one.
- Every API route returns non-2xx `{error}` on failure; the view renders it.

## Open questions

**Resolved (locked):**
- Sectors scored against the live brand-category vocabulary — **yes**.
- Events/merch — **speculate from real demographics now (`inferred_audience`), connector seam for
  real data later**; never surface inferred buyer counts as pitch proof.

**Remaining for review:**
1. IG connect — **upgrade or hard gate?** Default: optional upgrade (a profile is usable without
   it but flagged lower-confidence). Confirm you don't want to *require* it before a profile counts.
2. Caption-inferred past deals — auto-suggest likely past brand deals from `#ad`/tagged posts for
   the creator to *confirm* (convenient, low-confidence), or only ever use self-reported deals?
   Default: suggest-then-confirm, stored with `source:'caption'` until confirmed.

## Build phases

1. **XS** — `creator_profiles` column migration (existing `addColumn` pattern).
2. **S** — Tier 0: extend `enrichHandle` to return recent captions/media + compute engagement rate.
2.5. **S–M** — Tier 0.5 visual analysis: fetch recent images/thumbnails, multimodal vision pass via
   `ai.ts` → `visual_signals` (subjects, aesthetic, on-camera brands).
3. **XS** — Tier 1: call `instagram.ts` `fetchReport()` (already built) into `demographics`.
4. **M** — sector-inference LLM (clone `qualify.ts` shape, feed `categoryFacets()`), the
   `inferred_audience` speculation step, confidence/missing-signal handling. *The real work.*
5. **S** — `creatorProfileToPitchInput` adapter; wire into `pitchgen.ts`.
6. **S–M** — profile view in `views.ts` (regenerate action, fail-loud banners, IG-connect upgrade
   CTA), polling like the Source/Qualify tables.

## Files affected

- **New:** `src/creatoriq.ts`.
- **Modified:** `src/db.ts` (creator_profiles columns), `src/sourcing.ts` (`enrichHandle` returns
  captions/media + ER), `src/pitchgen.ts` (accept richer `PitchInput` from the adapter),
  `src/server.ts` (profile generate/status routes), `src/views.ts` (profile surface).
- **Reused unchanged:** `src/instagram.ts` (`fetchReport`), `src/onboarding.ts` (intake),
  `src/ai.ts` (URL research), `src/brands.ts` (`categoryFacets`).
