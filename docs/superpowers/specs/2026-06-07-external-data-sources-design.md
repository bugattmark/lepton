# External Data Sources — Exa + Apify — design

**Date:** 2026-06-07
**Status:** Draft (proposal; pending spec review)
**Cross-cutting:** spans all three stages of the creator-first intelligence trilogy.
**Reads / extends:** `2026-06-07-creator-iq-design.md` (stage 1), `2026-06-07-brand-matching-design.md`
(stage 2), `2026-06-07-proposal-pricing-design.md` (stage 3).

## Overview

The trilogy's specs each leave a data seam open that the existing key set (HikerAPI, OpenAI,
Instagram Business Login) cannot fill. This spec proposes two additional **production** data
sources to fill those seams — **Exa** (neural web search) and **Apify** (managed scraping actors) —
and pins down *exactly where each plugs in, what it must NOT do, and how it stays consistent with
CLAUDE.md* (nothing hardcoded, fail loud, best-effort tiers behind `xAvailable()` checks).

These are **not** new hard dependencies. Each is an additive tier or a fallback, env-gated
(`EXA_API_KEY` / `APIFY_TOKEN`), best-effort, and fail-loud — exactly the grain of `iglead.ts` /
`qualify.ts` today. With neither key set, every stage still functions at its currently-specced tiers.

This is a design proposal, not a build order; the per-stage build phases in the three stage specs
remain authoritative. The "Build phases" here only sequences the *external-source additions*.

## Why these two (the gaps they fill)

| Gap (from the stage specs) | Today's keys | Filled by |
|---|---|---|
| Cross-platform reach/ER (TikTok, YouTube) — needed for stage-3 "primary-platform-equivalent" pricing & soft cross-platform uplift | HikerAPI + IG Login are **IG-only** → uncomputable | **Apify** (TikTok/YouTube/social-finder actors) |
| Creator web footprint beyond IG (press, own site / media kit, podcast spots, collabs reported in articles) for sector authority + `past_deals` | none | **Exa** |
| Historical creator↔brand deal graph (comparable-deal mining) | partial (HikerAPI sponsor_tags only) | **Apify** Ad-Library branded-content (already committed in stage 2) |
| Net-new brand discovery + open-web cross-check of the weak "never did influencer marketing" absence signal | Ad-Library absence alone (weak) | **Exa** |
| `rate_cards` seed with real, cited 2025–2026 market rates + `source` provenance ("nothing hardcoded") | hand-typed table in the stage-3 spec | **Exa** (offline seeding job) |

## Locked-style decisions (proposed)

- **Exa for pricing is an offline seeding/refresh job, NEVER a live per-quote call.** Stage 3 is
  emphatic that *price is deterministic*. Exa populates/refreshes the `rate_cards` table (with human
  review of the numbers); the pricing engine reads the table deterministically at quote time. A live
  web search at quote time would destroy defensibility and is explicitly out of scope.
- **Exa MAY be live per-request** for stage-1 (creator web footprint) and stage-2 (net-new / absence
  cross-check), as best-effort fail-loud tiers — those are not on the deterministic-pricing path.
- **Apify is async + scraping, behind a seam.** Actor runs are job/poll (not a sync REST call) and
  carry ToS / anti-ban / reliability risk. All Apify access lives behind a module seam (`src/deals.ts`
  for stage 2; a sibling helper for stage-1 cross-platform) with a non-Apify fallback (HikerAPI
  sponsor_tags for stage 2; "IG-only, flagged incomplete" for stage 1). Results are **cached** so cost
  and flakiness amortize.
- **Neither is a hard dependency.** `exaAvailable()` / `apifyAvailable()` gate each tier; absence
  degrades to the currently-specced tiers and is recorded in `signals_used`, never silently.

## Stage 1 — Creator IQ additions

Two new progressive tiers, slotting into the existing tier ladder (extends the table in the Creator
IQ spec; same best-effort-enrich grain):

- **Tier 1.5 — cross-platform reach (Apify).** Resolve the creator's other platforms via
  `tri_angle/social-media-finder`, then pull TikTok / YouTube follower count + recent-post engagement
  via a TikTok actor (`clockworks/tiktok-profile-scraper`, 4.7★) and a YouTube actor. Stored as
  `cross_platform` JSON on `creator_profiles` (`[{platform, handle, followers, er, source}]`).
  *Why it's load-bearing:* stage 3 needs to discount a "6M across socials" vanity number to a
  primary-platform-engaged equivalent and apply cross-platform as a *soft* uplift — both impossible
  without the other platforms' real numbers. Best-effort; a failed actor run is recorded in
  `signals_used`, not silently skipped.
- **Tier 1.6 — creator web footprint (Exa, live).** Neural search on the creator's name + handle →
  press mentions, their own website / media kit, podcast / guest appearances, brand collabs reported
  in articles. Feeds (a) the sector inference (grounding authority in off-IG evidence) and (b)
  `past_deals` candidates (`source:'web'`, suggest-then-confirm, same as the caption-inferred deals
  open question). Stored as `web_signals` JSON with `evidence_url`s. Grounded observation only —
  never invented, same hard rule as `visual_signals`.

Both feed the existing sector-inference LLM call as additional grounded inputs. No change to the
deterministic/`json_schema` core.

## Stage 2 — Brand matching additions

- **Apify Ad-Library branded-content (already committed; this pins the actor).** `src/deals.ts`'s
  primary extractor. Evaluate two actors behind the seam:
  - `apify/brand-collaboration-scraper` — 5.0★, **purpose-built for creator↔brand branded-content**
    (best semantic match; lower run volume → less battle-tested).
  - `apify/facebook-ads-scraper` — 1.2M runs/30d but **2.9★** (general Ad-Library workhorse;
    reliability caveat — use as the high-coverage fallback).
  Normalize either into `creator_brand_deals` (`source:'ad_library'`). HikerAPI `sponsor_tags` remains
  the no-Apify fallback exactly as the stage-2 spec specifies.
- **Exa net-new discovery + absence cross-check (live, best-effort).** Stage 2's net-new "never did
  influencer marketing" signal is admittedly *weak* (Ad-Library absence ≠ truly virgin). Exa
  strengthens it two ways: (a) surface sector-fit brands with a real web presence that aren't yet in
  the catalog (feed through `upsertBrands()`), and (b) cross-check a candidate against the open web for
  press releases / "partnered with <creator>" articles before labelling it `net_new` — downgrading the
  label honestly when public evidence of past influencer work exists. Also enriches `brands.enrichment`
  (the JSON column already reserved for "raw Exa/research findings + provenance" in `db.ts`).

## Stage 3 — Proposal pricing addition

- **Exa rate-card seeding (offline job).** Replace the hand-typed rate table with an Exa research pass
  that populates `rate_cards` rows with real 2025–2026 market rates **and `source` URL + year on every
  row** — directly satisfying the stage-3 spec's "footnote based on market rates" and CLAUDE.md's
  "nothing hardcoded." Run as an idempotent seed/refresh (same pattern as the Bento seed /
  `upsertBrands`), with the produced numbers **reviewed by a human before they go live** (pricing is
  defensibility-critical). The `pricing_config` multipliers (niche, usage-rights, exclusivity) and the
  CPM sanity-rail bands are seeded the same way, each with provenance.
  *Validation that this is feasible:* a 2026-06-07 Exa pass returned concrete, citable UK bands
  (≈£150–500 nano IG post → £30k+ mega; Reel ≈1.45× post; TikTok ≈70% of IG; finance/B2B niche
  ≈3–5×; per-platform CPM bands) — enough to seed the table with sources.
  **The engine still reads `rate_cards` deterministically at quote time.** Exa never runs in the
  quote path.

## Data model touch-points

No new tables solely for this; extends columns the stage specs already introduce.

- `creator_profiles`: add `cross_platform TEXT` (JSON), `web_signals TEXT` (JSON). `signals_used`
  records Exa/Apify tier presence vs absence.
- `creator_brand_deals`: unchanged — `source` already enumerates `'ad_library'`; Apify writes here.
- `brands.enrichment`: already JSON for "raw Exa/research findings + provenance" — Exa writes here.
- `rate_cards.source` / `pricing_config`: already carry provenance — Exa seeding populates them.

## Modules & runtime

- **Stage 2:** `src/deals.ts` (already specced) gains the concrete Apify actor calls + an Apify
  run/poll helper. A new `src/exa.ts` wrapper (mirrors `iglead.ts`'s no-throw-without-key shape, but
  fail-loud on a real error) is the single Exa entry point reused by all stages.
- **Stage 1:** cross-platform pull via an Apify helper (sibling to `enrichHandle`); web footprint via
  `src/exa.ts`. Both feed the Creator IQ background runner; incremental persist; status to the row.
- **Stage 3:** an offline seed script (`scripts/seed-rate-cards.ts`, run on demand) calls `src/exa.ts`,
  writes `rate_cards`/`pricing_config` with provenance, prints a diff for human review. Not in any
  request path.

## Error handling (fail loud, per CLAUDE.md)

- `exaAvailable()` / `apifyAvailable()` gate each tier. Missing key ⇒ that tier is skipped and the
  gap is recorded (`signals_used` / a visible "source unavailable" note), never a silent empty result
  that looks "done."
- A *real* failure of a configured source (Apify run error, Exa auth/rate-limit, bad response) **fails
  loud**: written to the row's `status`/`error`, returned as non-2xx `{error}`, rendered in the view —
  same as HikerAPI/OpenAI failures today. No `catch {}`-and-continue.
- Apify ToS/empty-actor-result is treated as a real failure to surface, with the HikerAPI fallback
  attempted explicitly and the downgrade recorded — not a silent swap.

## Build phases (external-source additions only)

1. **S** — `src/exa.ts` wrapper + `EXA_API_KEY`; `apifyAvailable()` + `APIFY_TOKEN`; `.env.example`
   entries flipped from commented placeholders to live.
2. **M** — Stage 3 offline `rate_cards`/`pricing_config` Exa seeding job + human-review diff. *(Highest
   ROI, lowest risk — no request-path change, removes the only hardcoded pricing table.)*
3. **M** — Stage 2 Apify Ad-Library actor in `src/deals.ts` (evaluate both actors) + HikerAPI fallback.
4. **S–M** — Stage 2 Exa net-new discovery + absence cross-check + `brands.enrichment` writes.
5. **M** — Stage 1 Tier 1.5 cross-platform (Apify) + Tier 1.6 web footprint (Exa).

## Files affected

- **New:** `src/exa.ts`, `scripts/seed-rate-cards.ts`.
- **Modified:** `src/deals.ts` (stage-2 Apify actor), `src/creatoriq.ts` (stage-1 tiers),
  `src/db.ts` (`cross_platform`, `web_signals` columns), `.env.example` (`APIFY_TOKEN`, `EXA_API_KEY`).
- **Reused:** `upsertBrands()` (net-new + brand enrichment write-path), `brands.enrichment`,
  `rate_cards`/`pricing_config` (provenance columns), the qualify/sourcing background-runner pattern.

## Open questions

1. **Rate-card refresh cadence** — manual on-demand reseed, or a scheduled refresh (with human-review
   gate before publish)? Default: manual on-demand for v1; scheduling is later.
2. **Apify Ad-Library actor choice** — ship `brand-collaboration-scraper` (best fit, less proven) or
   `facebook-ads-scraper` (proven volume, low rating) first, or run both and merge? Default: run both
   behind the seam, prefer the purpose-built one, fall back on the high-volume one.
3. **Stage-1 cross-platform depth** — IG+TikTok+YouTube in v1, or IG+TikTok only (add YouTube later)?
   Default: TikTok first (highest creator overlap), YouTube fast-follow.
