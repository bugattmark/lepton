# Priced Proposal Generator + Take-Rate — design

**Date:** 2026-06-07
**Status:** Draft (approved direction; pending spec review)
**Stage:** 3 of 3 in the creator-first intelligence trilogy
**Builds on:** `2026-06-06-dual-mode-outreach-platform-design.md` §6–§7 (Proposal Generation +
Landing Page) — this spec makes those concrete and adds defensible pricing + the take-rate.
**Reads:** `2026-06-07-creator-iq-design.md` (creator profile) + `2026-06-07-brand-matching-design.md`
(a matched brand).
**External data sources:** `2026-06-07-external-data-sources-design.md` proposes Exa to seed `rate_cards`/`pricing_config` with cited 2025–2026 market rates (offline job; the engine still reads the table deterministically at quote time).

## Overview

A **priced proposal** is a second-stage, brand-facing artifact: after the brand signals interest,
it turns "what would this look like?" into a concrete offer — deliverables packaged into 2–3 tiers,
each with a **defensible price**, with the platform's **15% take baked in**. It is the "once I know
the scope" deliverable the cold pitch deliberately defers.

The single hardest part is **defensibility**, not arithmetic. A brand manager buys creators for a
living; a price 3× off market kills the proposal and the product's credibility. So the core problem
is producing a number the system can *show its work for* — from a seeded, configurable, auditable
rate-card table — not an opaque LLM guess. **The LLM packages deliverables and writes prose; the
price is deterministic.**

## Locked decisions

- **15% default take, negotiable, no payment rails.** The take defaults to **15%**, baked into the
  quoted (gross) price as a hidden markup (brand sees one number, creator sees their net). **Bigger
  creators can negotiate a lower rate**, so `take_rate` is a per-creator/per-tenant override over the
  global default, never a constant. Settlement is **manual** for v1 — no Stripe / escrow / payout
  rails. The system *shows and records* the cut; it does not move money.
- **The split is flexible but follows a set process now.** The exact division between platform and
  creator, and the money-back-guarantee mechanics, will evolve over time — so all of it lives in
  `pricing_config` and changes by config, never by code edit. Concrete defaults are set now.

## Pricing model — deterministic rate-card engine, LLM-wrapped

Price is computed by a transparent formula over a seeded `rate_cards` table; the LLM only picks the
deliverable mix and writes copy. This is the opposite of "ask GPT for a number," and the only
version that is defensible to a brand and honest per CLAUDE.md ("nothing is hardcoded / fail loud").

**Per-deliverable, summed per tier:**

```
unit_price = base_rate(tier, platform, format)
           × niche_multiplier
           × engagement_factor
           × usage_rights_uplift
           × exclusivity_uplift
tier_gross = ( Σ unit_prices ) × (1 + bundle_adjustment)          // small multi-deliverable discount
creator_net = tier_gross × (1 − take_rate)                        // take_rate = 0.15, hidden markup
platform_cut = tier_gross − creator_net
```

- **base_rate** — from `rate_cards` keyed on `(tier, platform, format, currency)`. The card is
  **currency-aware**; the UK is the primary market (the qualify default ICP is UK-based), so we seed
  **GBP** rates calibrated against real 2026 UK creator estimates, with a USD card as secondary
  (≈ ×1.27). UK rates run ~10–20% under the US benchmarks.

  **GBP content rates (per deliverable):**

  | Tier (IG followers) | IG post | IG Reel | IG Story | TikTok | UGC (no posting) |
  |---|---|---|---|---|---|
  | Nano (1–10K) | 50–300 | 80–450 | 30–150 | 50–300 | 80–250 |
  | Micro (10–50K) | 150–800 | 250–1,200 | 80–350 | 150–900 | 150–400 |
  | Mid (50–250K) | 500–2,500 | 800–3,500 | 250–1,000 | 500–2,500 | n/a |
  | Macro (250K–1M) | 2,000–8,000 | 3,000–12,000 | 800–3,000 | 2,000–9,000 | n/a |
  | Mega (1M+) | 5,000–25,000+ | — | — | — | — |

  Format relations: **Reel ≈ 2–3× a static post; Story bundle ≈ 30–50% of a feed post.**

  **Two calibration rules these UK benchmarks forced** (see the 2026-06-07 benchmark review):
  - **50–250K is a real band, not a gap.** The original Micro→Mid jump (10–50K → 100K+) skipped the
    50–100K creators who price highest *per follower* (real examples: 64.6K and 79.1K creators both
    estimated £500–1,500). The new **Mid** band covers them.
  - **Headline follower counts are not bookable audience.** "6M+ across socials" is an aggregate
    vanity number — such a creator may book at £2–10k, not £20k+. Price off the **primary platform's
    engaged** followers (the `engagement_factor` does this); treat combined cross-platform reach as a
    *soft uplift only*, never the tier driver. A `combined`/`across-socials` count is discounted to an
    estimated primary-platform equivalent before tiering.

  **GBP event-sponsorship rates** (for `creator_type` = events; priced off **event reach** = attendee
  estimate + organiser audience, not followers alone), seeded the same way under an `event` platform
  family in `rate_cards`:

  | Event deliverable | Typical band |
  |---|---|
  | Stage / Story shoutout at the event | 100–600 |
  | Logo on event marketing (flyers / socials) | 150–1,000 |
  | Booth / stall presence | 300–2,000 |
  | Host / creator appearance | 500–3,000+ |
  | Event recap content package (recap Reel + Stories) | 300–1,500 |
- **engagement_factor** — uses the creator's *real* ER (from Creator IQ / `instagram.ts`). Map ER
  vs. the tier's expected ER to a 0.7–1.5× factor (a 22K creator at 6% ER is worth materially more
  than one at 1.5%). This is "audience fit over follower count" expressed in dollars.
- **niche_multiplier** — finance/SaaS/B2B ≈ 3–5× lifestyle; derived from the matched brand's
  `categories` + creator niche.
- **usage_rights_uplift** (+20–50% to repurpose as paid ads), **exclusivity_uplift** (window-based).
- **CPM sanity rail (fail loud):** compute implied CPM (`gross ÷ expected_impressions × 1000`);
  assert it lands in band (IG $5–12, TikTok $2–8, YouTube $8–15). Out of band ⇒ a **visible warning
  in the proposal builder**, never a silently-shipped number. Flat fee is the headline; CPM is the
  justification + guardrail.

**Where the data lives (must NOT be hardcoded):**
- `rate_cards` — seeded once, idempotently (same pattern as the Bento seed / `upsertBrands`),
  refreshable, with `source` provenance on every row so the proposal can footnote "based on 2025
  market rates."
- `pricing_config` — niche multipliers, usage/exclusivity uplifts, the ER curve, `take_rate`
  (default `0.15`), bundle adjustment. One seeded JSON config row (per-tenant override allowed).
  **No literals in `proposals.ts`.** Missing config ⇒ the proposal build *errors* (never ships a
  0% cut).

## Take-rate / monetization

- **Model:** hidden markup. `gross_price`, `creator_net`, `platform_cut`, `take_rate_applied`
  stored per proposal (auditable). The brand-facing `/p/:token` page shows only `gross`; the
  creator's dashboard shows their **net** ("you net £2,125 of this £2,500 package").

- **Two revenue modes** (both config-driven via `pricing_config`):
  1. **Creator-pitched deal (default).** A creator pitches a brand; the platform takes its % (default
     15%) of the agreed deal as a hidden markup. The per-proposal path above.
  2. **Direct platform campaign.** A brand contracts the *platform* to run a campaign across **many**
     creators/organisers (a company sponsoring lots of our organisers' events, or running a campaign
     across lots of our influencers). The brand pays the platform a **flat rate**; the platform pays
     each creator their rate. Here the platform receives the **full** payment and splits it per
     `pricing_config`, rather than marking up a single creator's deal. Modelled as a
     `deal_type = 'platform_campaign'` proposal that fans out to multiple creators.

- **Money-back guarantee (what the take initially funds).** For a signed contract **≥ £1,000**, the
  platform's take initially backs a **money-back guarantee** to the brand (campaign doesn't deliver to
  the agreed terms → the brand is refunded). Once the guarantee window passes, the take becomes a
  **revenue split** — of the 15% on a creator-pitched deal, or of the full payment on a direct
  platform campaign. The threshold (£1,000), window, and split %s are all `pricing_config` values
  (flexible; defaults set now). Recorded per proposal as a `guarantee` block so the obligation is
  auditable, never implicit.

- **The line (explicit):** showing the number + the split + the guarantee state + storing it = **in
  scope**. Processing payments, escrow, payout, invoicing, Stripe Connect, refunds-as-money-movement,
  contracts = **OUT of scope** for v1 (manual settlement). The guarantee is *recorded and surfaced*
  now; actually moving refunded money is later plumbing.

## Deliverables modeling (brand-wants × creator-delivers)

A *constrained* LLM call over two structured inputs that already exist:
1. **Infer brand wants** from the matched brand's `categories` + `description` + `enrichment`
   (a DTC brand posting mostly Reels → wants Reels + usage rights; a local hotel → location Reel +
   Stories, the travel-deal special case from `pitch/CLAUDE.md`).
2. **Constrain to creator-can-deliver** from the Creator IQ profile (primary platform, content
   style, ER, real past work) — never propose YouTube long-form for an IG-only creator.
3. **Emit a structured deliverable list** `{type, count, platform, format, usage_rights,
   description}` — the LLM sets the *mix*, the deterministic engine attaches the *dollars*.
   For an `events`-type creator (per Creator IQ's `creator_type`) the vocabulary expands to
   **sponsorship** deliverables (logo placement, in-person banners, booth, stage/Story shoutout, host
   appearance, event recap package) priced off the `event` rate family. **Packages are hybrid:** an
   event sponsorship can also include social posts (priced off the content family) *and* an **in-kind
   line** where the sponsor covers event costs (catering, venue, prizes) — recorded as a deliverable
   with an `in_kind: true` flag + estimated value that counts toward the package total but is settled
   in goods, not cash. `creator_type` selects the *default* vocabulary; the LLM may mix content +
   event + in-kind lines in one package.
4. **Tier it** into Standard / Premium (+ optional **stretch goals** — performance bonuses flexible on
   views or conversions, e.g. "+£500 at 100K views", "3% of sales via code"). For direct platform
   campaigns especially, stretch goals are the main performance lever and stay flexible on the
   view / conversion target per `pricing_config`.

## How it extends the existing pitch generator (no fork)

**Real entry points** (verified): `src/pitchgen.ts` `generate(input: PitchInput)` with
`PitchKind = 'outreach' | 'followup'`, GPT-5.4-mini over `pitch/CLAUDE.md` as system prompt, strict
`json_schema`. Routed via `runGenerate` in `src/server.ts` and per-tenant templates in
`src/templates.ts`.

**Key difference from today's generator:** `pitchgen` currently produces *reusable templates* with
`{{first_name}}/{{brand_name}}` placeholders. A **proposal is brand-specific, one-to-one — no
placeholders.** So the new kind fills real values, not templates.

**Extension (one new kind + one new module, not a parallel generator):**
- Add `PitchKind = 'proposal'` with a `TASK_PROPOSAL` prompt (brand-specific; the COMMON_RULES
  placeholder block is skipped for this kind).
- New `src/proposals.ts` runs **first**: pulls Creator IQ + matched brand → packages deliverables
  (LLM) → prices them (deterministic) → persists. It then passes the **finished numbers** into
  `pitchgen.generate({kind:'proposal', ...})` so the model writes prose *around* fixed figures,
  told explicitly "do not alter these prices." Reuse `extractText`, the timeout/abort pattern,
  `PITCH_MODEL`. New route `/api/proposals/generate` mirrors `runGenerate`.

**Voice reconciliation (the `pitch/CLAUDE.md` conflict).** That spec says *never set or demand a
price in a cold pitch*. The proposal respects this by being **a different artifact at a different
stage** — exactly the "once I know the scope" deliverable. The cold `outreach`/`followup` kinds
stay price-free and unchanged. The proposal is generated/sent **only after the brand opts in**, and
the codebase already detects that transition (`sessions.ts` flips leads to `replied`; `ai.ts`
`assessConversation` stages the deal) — so the trigger is real: a lead reaching `replied`/interested
unlocks the proposal CTA. **Planned edit:** add one paragraph to `pitch/CLAUDE.md` codifying that
the no-price rule governs *first touch only*, and that a separate priced-proposal artifact exists
for the post-interest stage — so the authoritative spec evolves consciously rather than silently
contradicting itself. *(Flagged for your sign-off in the review gate.)*

**Delivery surface:** the priced proposal lives on a hosted `/p/:token` page (server-rendered via
`views.ts`, token = access control like `auth.ts` API tokens); the WhatsApp/email message just
links it. This keeps even the warm message clean — no price pasted inline.

## Data model

Extend the dual-mode `proposals` table (§6) with money + linkage columns; add `rate_cards` and
`pricing_config`. All seeded idempotently.

```
rate_cards     ( id, tier, platform, format, low, mid, high, currency, source, updated_at )
pricing_config ( id, key, value_json, updated_at )
  -- niche/usage/exclusivity/ER/take_rate/bundle/guarantee/split — ALL config, no code edits

proposals (
  ... existing dual-mode columns (id, creator_profile_id, tiers JSON, stretch_goals JSON,
      status, public_token, created_at) ...
  brand_id          INTEGER REFERENCES brands(id),
  deal_type         TEXT,    -- 'creator_pitched' (default) | 'platform_campaign'
  gross_price       INTEGER,
  creator_net       INTEGER,
  platform_cut      INTEGER,
  take_rate_applied REAL,    -- the negotiated rate actually used (defaults to pricing_config)
  guarantee         TEXT,    -- JSON {threshold, window_ends_at, state:'active'|'released'|'refunded'}
  tenant_id         TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  updated_at        INTEGER
)

-- platform_campaign proposals fan out to many creators: a proposal_creators(proposal_id, creator_id,
-- rate, status) join holds each creator's rate; the brand pays one flat gross_price to the platform.
proposal_creators ( id, proposal_id REFERENCES proposals(id), creator_id, rate INTEGER, status )
```

`tiers` JSON carries prices inside (the dual-mode tier shape). `proposals` reads Creator IQ
(`creator_profiles`) + the matched brand (`brands` via `creator_brand_matches.brand_id`).

## Open questions

**Resolved (locked):** 15% hidden markup; payments out of scope (manual settlement v1).

**Resolved (this round):** `take_rate` = global `0.15` default, **negotiable per creator/tenant**
(bigger creators get a lower rate) via a `pricing_config` override; guarantee threshold/window/split
likewise config-driven and flexible. Hybrid event packages (content + event + in-kind cost coverage)
and direct platform-campaign deals are in scope.

**Remaining for review:**
1. **Amend `pitch/CLAUDE.md`** to codify "no price = first-touch only; priced proposal is a
   separate post-interest artifact"? Needed to evolve the spec consciously. *(Recommend yes.)*
2. **Stretch-goal tracking** (views/coupon conversion) — display-only in v1, or wire tracking?
   Default: display-only; tracking is a later phase (matches dual-mode Phase 3).
3. **Platform-campaign timing** — ship the per-creator pitched path (creator_pitched) first and layer
   `platform_campaign` fan-out as a follow phase? Default: yes (see build phases).

## Build phases

1. **S** — `rate_cards` + `pricing_config` tables + idempotent seed; `proposals` money columns.
2. **S** — deterministic pricing function (formula + CPM sanity rail) in `src/proposals.ts`.
3. **M** — deliverables packaging (constrained LLM) + `PitchKind:'proposal'` prompt in `pitchgen.ts`.
4. **S** — `/api/proposals/generate` + `/api/proposals/:id` routes (mirror `runGenerate`).
5. **M** — hosted `/p/:token` proposal page (public route + `views.ts` render; gross-only to brand,
   net shown to creator in dashboard).
6. **S** — gate the proposal CTA on a lead reaching `replied`/interested; amend `pitch/CLAUDE.md`.
7. **M (follow phase)** — `deal_type='platform_campaign'` fan-out (`proposal_creators` join) +
   money-back-guarantee state tracking surfaced in the dashboard. The per-creator pitched path (1–6)
   ships first; platform campaigns layer on once it works end to end. (Guarantee *recording* lands in
   phase 2's pricing function; this phase adds the multi-creator fan-out + state UI.)

## Files affected

- **New:** `src/proposals.ts`.
- **Modified:** `src/db.ts` (rate_cards, pricing_config, proposals columns), `src/pitchgen.ts`
  (`'proposal'` kind, brand-specific path), `src/server.ts` (proposal routes + public `/p/:token`),
  `src/views.ts` (proposal page + creator-net display), `src/pitch/CLAUDE.md` (codify the
  first-touch-only no-price rule).
- **Reused:** `creator_profiles` (Creator IQ), `creator_brand_matches`/`brands` (stage 2),
  `src/sessions.ts` + `src/ai.ts` (interest detection → CTA trigger), `auth.ts` token pattern.
