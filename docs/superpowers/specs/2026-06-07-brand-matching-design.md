# Brand Matching & Discovery — design

**Date:** 2026-06-07
**Status:** Draft (approved direction; pending spec review)
**Stage:** 2 of 3 in the creator-first intelligence trilogy
**Builds on:** `2026-06-06-dual-mode-outreach-platform-design.md` §5 (Brand Research + Matching) — this
spec replaces that campaign-scoped sketch with a creator-scoped matcher + a reusable deal graph.
**Reads:** `2026-06-07-creator-iq-design.md` output (`creator_profiles.sectors`).
**Feeds:** `2026-06-07-proposal-pricing-design.md` (matched brand → priced proposal).
**External data sources:** `2026-06-07-external-data-sources-design.md` pins the Apify Ad-Library actor for `src/deals.ts` and adds Exa for net-new discovery + the influencer-marketing absence cross-check.

## Overview

Given a Creator IQ profile, produce a **ranked, reasoned shortlist of target brands for this
specific creator**. The existing catalog (`brands.ts`, `BRANDS.md`) is sourced *brand-first* (by
category/region via HikerAPI snowball). This stage is the **creator-first matching layer on top**,
plus two opinionated discovery moves the founder asked for:

1. **Comparable-deal mining** (warm, competitive): find creators *like* this one, see which brands
   sponsored them, infer those brands want this creator too.
2. **Net-new discovery** (cold, bigger TAM): deliberately go *outside* that set — sector-fit brands
   that have likely never done influencer/event marketing.

The single hardest part is comparable-deal mining's data dependency: it needs a historical
creator↔brand deal graph. Research resolved this **in our favour** — it's buildable from public
data, so we own it rather than buying a black box.

**Build sequence (decided).** Comparable-deal mining is the hardest piece, so it is **not** v1.
**v1 = a rough brand estimation:** from the creator's sectors + expected audience, produce a ranked
shortlist of brands worth outreaching — drawn from the existing catalog/snowball and scored by sector
overlap + audience fit + brand size band + geo, seeded warm by the creator's *own* on-camera/past-deal
brands (from Creator IQ's `visual_signals`/`past_deals`). Once that works end to end, the
**comparable-deal engine** (lookalike creators → their sponsors) layers on as **phase 2** to sharpen
the warm list. Net-new discovery rides along with the estimation pool. The sections below describe the
full system; the build phases mark what is v1 vs phase 2.

## Locked decisions

- **Build the deal graph from public sources** (Meta Ad Library branded-content + HikerAPI
  `sponsor_tags`/caption mining). **An Apify actor is allowed** for the Ad Library extraction.
  No Modash/HypeAuditor purchase (their "brand affinity" *is* caption tag-mining over ~180 days —
  replicable with the HikerAPI key we already have).
- **Events are first-class in v1.** The matcher serves event organisers (→ event sponsors) as well
  as content creators (→ product brands); same machinery, shifted signals (see "Event-sponsorship
  matching").

## Non-goals

- **No graph database, graph engine, in-memory graph, or native vector extension.** The creator↔brand
  graph IS the existing edge tables (`creator_brand_deals`, `creator_brand_matches`) plus the
  JSON-embedded category/sector edges (`brands.categories`, `creator_profiles.sectors`), traversed
  with plain SQL (JOIN / GROUP BY / `NOT IN` set-difference). A graph DB or a `sqlite-vec` /
  `loadExtension` vector index would ship a compiled native binary per platform — violating lepton's
  zero-native-deps / single-instance / no-build-step rules. Arbitrary-depth `WITH RECURSIVE` over the
  same tables is the upgrade path *if* a future multi-hop feature needs it; v1's traversals are 1–2
  hops and don't.

## Comparable-deal mining

**Step A — Lookalike creators.** Reuse the `BRANDS.md` snowball pointed at *creators*: seed with
the creator's own handle (+ any `past_deals` handles from Creator IQ), then
`GET /v2/user/suggested/profiles` + `/v2/user/explore/...` → ~80 IG-similar peers (the suggestion
graph is audience/niche-correlated, so they're genuine lookalikes). Filter to the creator's
follower band (±1 order of magnitude) and same sector via `category_name`. ~2 HikerAPI calls/seed.

**Step B — Extract each lookalike's deals (the new dataset).** Two complementary public sources:

- **PRIMARY — Meta Ad Library "Search Branded Content."** Searchable by username; returns every
  disclosed paid-partnership post with brand partner, content type, dates, links (IG+FB). This is
  literally a creator↔brand deal record, public and free in-UI, and extractable via an **Apify
  branded-content actor** (~$0.005/ad → cents at our volume). Highest-confidence source.
- **SECONDARY/RECALL — HikerAPI post-tag mining.** Pull each lookalike's recent posts via
  `user_medias`; read per-post `sponsor_tags` / `coauthor_producers` / `usertags` + caption
  `@brand` mentions + `#ad`/`#sponsored`/`#gifted`. Catches gifted/affiliate/organic-tag deals the
  Ad Library never indexes (small/regional creators rarely run *ads*, so they're under-indexed
  there). ~$0.002–0.005/lookalike.

**Step C — Aggregate to brand affinity.** Count lookalikes per brand, weight by lookalike
similarity + recency. A brand that 6 of 80 lookalikes partnered with in the last 6 months is a top
warm target. Map each discovered brand back into the catalog via **`upsertBrands()`** (net-new
brands become shared inventory for everyone, COALESCE-merged).

**Cost per creator (end-to-end):** ~$0.30–$0.80 API spend + a handful of LLM calls for
name-normalization/aggregation. **Confidence:** HIGH for the deal's *existence* (Ad Library =
disclosed truth; `sponsor_tags` = high precision; caption mentions = medium). The inferential leap
("they'll want our creator too") is surfaced as a *reason*, never a guarantee.

**Primary path:** Ad Library (Apify) + HikerAPI `sponsor_tags`. **Fallback** (thin-niche): HikerAPI
post-tag mining alone — lower precision, full control, key already owned.

## Net-new discovery

**Step A — Sector-fit pool.** Reuse the `BRANDS.md` snowball *as-is*, seeded from the creator's
sector + region (the regional-seed trick keeps it geo-correct). Already brand-first category
discovery — no new machinery — yielding hundreds of sector brands incl. obscure ones.

**Step B — Absence-of-influencer-marketing heuristic.** "Never done influencer marketing" is an
*absence* signal; detect it with negative evidence across the same channels, inverted. A brand
scores net-new when, for its IG handle:
1. **No branded-content history in Meta Ad Library** (strongest single signal; Meta's own
   disclosure index; free).
2. **Low/zero `coauthor` posts / creator reposts** on the brand's own `user_medias`.
3. **Few tagged-by-creator posts** — `user_tag_medias` returns few/no posts from accounts in the
   creator-follower band (creators aren't already tagging them in `#ad`s).
4. *(optional)* lower follower band / small social team — proxy for "hasn't professionalized."

`net_new = sector_fit AND NOT (any deal-signal above)`. Crucially, take the **union of all brands
found in comparable mining (any lookalike's deal graph) and exclude them** — that set-subtraction
*is* "outside the brands that worked with those other creators." Absence detection is 2–3 cheap
lookups per candidate, run only on the already-paid-for snowball pool.

**Confidence:** detecting absence is weaker than detecting presence (a brand may have done a
private/undisclosed deal). Net-new scores mean "no *public* influencer-marketing footprint,"
flagged honestly in the reason — not "definitely virgin."

## Event-sponsorship matching (event-type creators)

When a creator's `creator_type` (from Creator IQ) includes `events`, the match target is **event
sponsors**, not product brands — the same machinery, with shifted signals:
- **Lookalike *event organisers*** via the snowball (seed = the creator's handle + similar event accounts).
- **Their sponsors**, harvested from event-recap content: caption `@sponsor` mentions, "sponsored by" /
  "in partnership with" text, `usertags` on flyer/recap posts, plus Ad-Library branded-content where a
  sponsor ran paid promo around the event. Stored in `creator_brand_deals` with `source:'event_sponsor'`.
- **Net-new event sponsors** = local/sector businesses with budget that have never sponsored a
  comparable event (absence of sponsor-tags across the lookalike organisers' recaps).
Sponsors flow into the same `brands` catalog via `upsertBrands`. **Event reach** (attendee estimate +
organiser audience) joins follower-fit as a ranking feature. Image-logo OCR on flyers/posters is a
fast-follow; v1 leans on caption / tag / Ad-Library *text* signals first.

## Ranking / match model

Two-stage, pushing most work onto cheap deterministic features (most signals here are structured),
LLM only for tie-break/reason — mirrors `qualify.ts` but cheaper:

**Deterministic features** (from `brands` catalog + Creator IQ + deal graph):
- **Sector overlap** — Jaccard of `creator_profiles.sectors` vs brand `categories.main/secondary`
  (reuse the same JSON token-match `listBrands`/`categoryFacets` already use).
- **Comparable-deal affinity** — count + similarity-weight of lookalikes who partnered with the
  brand. The single most predictive feature for the warm list.
- **Audience↔customer fit** — Creator IQ demographics (geo/age/gender) vs brand `location_*` +
  follower band + category-implied customer.
- **Brand size band** — `followers` bucket, to *match ambition* (don't pitch a nano-creator to a
  mega-brand), not maximize.
- **Geography** — brand `location_country/region` vs audience geo.
- **Activity proxy** — Ad-Library presence ⇒ has budget: a *plus* for the warm list, the
  *exclusion* criterion for net-new.

**Score** = weighted sum → 0–100, deterministic tier (reuse a `tierOf`-style threshold). **LLM used
only for** (a) a one-sentence grounded **reason** per brand (qualify's strict-json `{score,reason}`,
reason-only or light score-adjust) and (b) fuzzy sector-match when taxonomy tokens don't align. The
bulk ranking is deterministic — far cheaper than LLM-scoring every brand; spend stays bounded the
way qualify's concurrency cap does.

## Data model

Reads Creator IQ as structured input (`creator_profiles.sectors`, `demographics`, `past_deals`).
Two new tables; reconciles the dual-mode §5 `brand_matches` (campaign-scoped) into a
creator-scoped shortlist + a reusable deal cache.

```
-- per-creator shortlist (tenant-scoped). The output surface; fills live like Source/Qualify.
creator_brand_matches (
  id, tenant_id, creator_id,
  brand_id      INTEGER REFERENCES brands(id),   -- shared catalog
  score         INTEGER,
  tier          TEXT,                             -- hot/warm/cold (derived in code)
  move          TEXT,                             -- 'comparable' | 'net_new'
  reason        TEXT,
  evidence      TEXT,   -- JSON: which lookalikes / Ad-Library campaigns / tags drove it
  status        TEXT,   -- 'suggested'|'selected'|'rejected'
  created_at, updated_at
)

-- the mined deal graph. About OTHER creators' PUBLIC deals → cacheable + reusable across
-- creators/tenants. Global with provenance, like `brands`, so overlapping niches share the harvest.
creator_brand_deals (
  id,
  creator_handle TEXT,
  brand_id       INTEGER REFERENCES brands(id),  -- when resolvable
  brand_name     TEXT,
  brand_handle   TEXT,
  source         TEXT,   -- 'ad_library' | 'sponsor_tag' | 'caption' | 'usertag' | 'event_sponsor'
  evidence_url   TEXT,
  confidence     TEXT,
  seen_at        INTEGER
)

-- traversal indexes: the 2-hop affinity GROUP BY and the net-new NOT IN both hit these.
CREATE INDEX idx_deals_brand  ON creator_brand_deals(brand_id);
CREATE INDEX idx_deals_handle ON creator_brand_deals(creator_handle);
```

Every brand discovered by either move goes through the existing **`upsertBrands()`** single
write-path (never write brand identity directly — `creator_brand_matches` references `brands.id`).

## Module & runtime

- **New `src/brandmatch.ts`** — orchestrates lookalike snowball → deal aggregation → net-new
  pool → ranking → persist. Comparable-mining, net-new, and ranking are three SQL-backed traversal
  helpers here (`comparableBrands` / `netNewBrands` / `rankBrands`): the deal graph is queried
  **relationally** (2-hop affinity = JOIN + GROUP BY weighted by lookalike similarity; net-new =
  `NOT IN (SELECT brand_id FROM creator_brand_deals)`), no graph store.
- **New `src/deals.ts`** — the deal-extraction layer: Apify Ad Library branded-content actor
  (`APIFY_TOKEN` env) + HikerAPI `sponsor_tags`/caption mining, normalizing both into
  `creator_brand_deals`. Apify is the one external moving part; HikerAPI is the fallback.
- **Background runner** mirroring `runSourcing`/`runQualify` (in-flight `Set`, incremental persist,
  status snapshot endpoint to poll). Single-instance per CLAUDE.md.
- **Fail loud:** any HikerAPI / Ad-Library / Apify / LLM error surfaces per-row in the match table
  and as non-2xx `{error}` — never a silent skip. If `APIFY_TOKEN`/`HIKER_API_KEY` are missing, the
  run errors visibly rather than returning an empty shortlist that looks "done."

## Open questions

**Resolved (locked):** build deal graph from public sources; Apify actor allowed; **events
first-class in v1**.

**Remaining for review:**
1. **Flyer/poster logo mining depth.** v1 default: **text/tag/Ad-Library signals first**, image-logo
   OCR/vision on event flyers as a fast-follow. Confirm that's the right v1 line.
2. **Net-new appetite.** Ship comparable-mining first and treat net-new as a v2 toggle, or both day
   one? Default: both, but net-new clearly labelled lower-confidence.
3. **Snowball depth.** Default depth 1 (`BRANDS.md` warns depth 2 balloons cost). Confirm.

## Build phases

**v1 — rough brand estimation (build first, end to end):**
1. **S** — `creator_brand_matches` table + indexes (migration). (`creator_brand_deals` lands in phase 2.)
2. **S** — estimation matcher in `src/brandmatch.ts`: from `creator_profiles.sectors` + expected
   audience, pull sector-fit brands from the catalog/snowball, score by **sector overlap + audience
   fit + brand size band + geo**, seeded warm by the creator's own on-camera/past-deal brands.
3. **S** — net-new path: snowball sector pool → absence heuristic → label `move:'net_new'`.
4. **S–M** — ranking (deterministic features + LLM reason, qualify clone) → `tier`.
5. **M** — background runner + status/poll route + match shortlist view in `views.ts`.

**Phase 2 — comparable-deal engine (sharpens the warm list):**
6. **S** — `creator_brand_deals` table + traversal indexes (migration).
7. **M** — `src/deals.ts`: Apify Ad Library extraction + HikerAPI `sponsor_tags` mining + normalize.
   *The one genuinely new dataset.*
8. **M** — comparable path in `brandmatch.ts`: lookalike snowball → aggregate affinity →
   `upsertBrands` discovered brands → fold `move:'comparable'` + deal-affinity into the ranking.
9. **M** — event-sponsorship mining variant (organisers → sponsors), per "Event-sponsorship matching".

## Files affected

- **New:** `src/brandmatch.ts`, `src/deals.ts`.
- **Modified:** `src/db.ts` (two tables), `src/brands.ts` (read path for ranking; `upsertBrands`
  already the write path), `src/server.ts` (match generate/status/select routes), `src/views.ts`
  (shortlist surface), `.env.example` (`APIFY_TOKEN`).
- **Reused:** `src/sourcing.ts` (snowball/`enrichHandle`), `src/qualify.ts` (scoring pattern),
  `creator_profiles` (Creator IQ output).
