# Implementation Plan — Priced Proposal Generator + Pricing Engine + Take-Rate (Stage 3, v1)

**Date:** 2026-06-07
**Spec:** `docs/superpowers/specs/2026-06-07-proposal-pricing-design.md`
**Scope of this plan:** v1 = the **creator-pitched** path (`deal_type='creator_pitched'`). The
`platform_campaign` fan-out is a follow phase — noted with a clean seam, not planned in depth.

## Conventions this plan obeys (from CLAUDE.md)

- Hono + `node:sqlite`, **no build step**, **`.ts` import extensions** everywhere
  (`import { db } from './db.ts'`).
- **Nothing hardcoded.** Rate cards + every pricing knob (multipliers, take_rate, uplifts, ER curve,
  bundle adjustment, CPM bands, guarantee threshold/window/split) are **read from the seeded DB**
  (`rate_cards`, `pricing_config`), never literals in `proposals.ts`.
- **Fail loud.** A missing config key or a missing rate-card row **throws** (spec: never ship a 0%
  cut, never ship a silent £0 price). Routes return non-2xx `{ ok:false, error }`; views render the
  error visibly. No `catch {}` that returns a fallback price.
- **Reuse what exists.** Extend `pitchgen.ts` (don't fork); reuse `extractText`, the abort/timeout
  pattern, `PITCH_MODEL`; reuse `ai.ts` for the Anthropic wrapper; reuse the `auth.ts` token shape;
  reuse `upsertBrands`-style idempotent seeding; reuse the `runGenerate` route shape.
- **Tenant-scoped.** `proposals` rows carry `tenant_id`; `tenantId` always comes from the auth
  middleware, never client input. `rate_cards`/`pricing_config` are global seed with a per-tenant
  override row allowed (same as brands being global-with-provenance).

## Cross-track ownership (assumed; this plan READS, does not create)

- **Foundation track owns** `db.ts`: the `rate_cards` (GBP primary, USD secondary) + `pricing_config`
  tables and their **idempotent seed**, plus the `proposals` money/linkage columns and the
  `proposal_creators` join. This plan references those shapes (see spec §"Data model") and reads them.
  **If a needed `pricing_config` key or `rate_cards` row is absent at runtime, the build fails loud**
  (this plan owns that assertion in `proposals.ts`, not the schema).
- **Creator IQ track owns** `creator_profiles`. This plan treats a `creator_profiles` row as an
  available structured input (primary platform, follower count, real ER, `creator_type`, content
  style, past work).
- **Brand-match track owns** `creator_brand_matches`. This plan reads the *selected* match row to get
  `brand_id` → the matched `brands` row (categories, description, enrichment) via `brands.ts`.

Where this plan needs a field one of those tracks hasn't finalized, the integration point is named
explicitly so it can be wired without guesswork.

---

## Step 1 — `src/proposals.ts` (new): the deterministic pricing engine

**File:** `src/proposals.ts` (new). Pure-logic core + thin DB readers. No LLM in the pricing path.

**Reuse:** `db` from `./db.ts`. **Add:** the engine functions below. **Do NOT** inline any rate or
multiplier — every number comes from `rate_cards` / `pricing_config`.

### 1a. Config + rate-card readers (fail loud)

```ts
// All config is read once per generate() call and threaded through — no module-level cache that
// could go stale across a re-seed.
export interface PricingConfig {
  take_rate: number              // default 0.15 (global); per-creator/tenant override may replace it
  niche_multipliers: Record<string, number>   // e.g. { finance: 4, saas: 4, b2b: 3.5, lifestyle: 1 }
  usage_rights_uplift: Record<string, number> // e.g. { none: 0, paid_ads: 0.35, full_buyout: 0.5 }
  exclusivity_uplift: Record<string, number>  // keyed by window, e.g. { none: 0, '3mo': 0.2, '12mo': 0.5 }
  er_curve: { floor: number; ceil: number }   // engagement_factor clamp, e.g. {floor:0.7, ceil:1.5}
  expected_er: Record<string, number>         // expected ER per tier, to compare the real ER against
  bundle_adjustment: { perExtraDeliverable: number; max: number } // small multi-deliverable discount (negative)
  cpm_bands: Record<string, { low: number; high: number }>        // { instagram:{low:5,high:12}, tiktok:{low:2,high:8}, youtube:{low:8,high:15} }
  guarantee: { threshold: number; windowDays: number; split: Record<string, number> } // £1000, window, split %s
  currency: string               // 'GBP' primary
}

// Reads the seeded pricing_config rows (key/value_json), tenant override layered over global.
// THROWS `Error('pricing_config missing key: <k>')` if any required key is absent — never defaults
// to 0 or silently fills. tenantId lets a tenant override take_rate etc.
export function loadPricingConfig(tenantId: string): PricingConfig

// One rate-card lookup. Keyed (tier, platform, format, currency). Returns {low,mid,high,source}.
// THROWS `Error('rate_cards missing row: <tier>/<platform>/<format>/<currency>')` if not found —
// a missing card is a loud failure, not a £0 deliverable.
export function lookupRate(
  key: { tier: string; platform: string; format: string; currency: string },
): { low: number; mid: number; high: number; source: string }
```

`base_rate` from a card = **mid** by default (the engagement/niche factors move it within band; the
low/high carry into the CPM rail + the proposal footnote "based on <source> market rates"). The
chosen point (low/mid/high) is part of the returned breakdown so the view can show provenance.

### 1b. Tiering the creator (follower → band) — spec calibration rules

```ts
// Maps a creator to a rate-card tier from PRIMARY-platform engaged followers, NOT aggregate reach.
// Implements the two spec calibration rules:
//  - 50–250K is a real band ('mid'), not a gap.
//  - A `combined`/`across-socials` count is discounted to a primary-platform-equivalent BEFORE tiering
//    (soft uplift only; never the tier driver). The discount factor is a pricing_config value.
// Bands: nano 1–10K, micro 10–50K, mid 50–250K, macro 250K–1M, mega 1M+.
export function tierFor(profile: CreatorProfileInput, cfg: PricingConfig): string
```

`CreatorProfileInput` is the subset of the Creator IQ `creator_profiles` row the engine needs
(`primaryPlatform`, `followers`, `followersAreCombined?`, `engagementRate`, `creatorType`, `niche`).
Defined here as an interface so the Creator IQ track's exact column names map onto it in one place.

### 1c. The five factors (each pure, each from config)

```ts
export function nicheMultiplier(brandCategories: string[], creatorNiche: string, cfg: PricingConfig): number
export function engagementFactor(realER: number, tier: string, cfg: PricingConfig): number // clamp to [floor,ceil]
export function usageUplift(usageRights: string, cfg: PricingConfig): number   // returns the +fraction
export function exclusivityUplift(window: string | null, cfg: PricingConfig): number
export function bundleAdjustment(deliverableCount: number, cfg: PricingConfig): number // negative fraction, capped
```

`engagementFactor`: compare `realER` to `cfg.expected_er[tier]`; ratio → clamped into
`[er_curve.floor, er_curve.ceil]`. (Spec: a 22K @ 6% ER is worth materially more than @ 1.5%.)

### 1d. Per-deliverable price + per-tier total

```ts
export interface Deliverable {
  type: string; count: number; platform: string; format: string
  usage_rights: string; exclusivity?: string | null
  description: string
  in_kind?: boolean              // event packages: sponsor covers a cost; counts toward total, settled in goods
  in_kind_value?: number | null  // estimated £ value of an in-kind line (used in total, flagged in UI)
}

export interface PricedDeliverable extends Deliverable {
  unit_price: number; line_total: number
  breakdown: { base: number; niche: number; engagement: number; usage: number; exclusivity: number; source: string }
}

// unit_price = base_rate(tier,platform,format) × niche × engagement × usageUplift+1 × exclusivityUplift+1
// in_kind lines: priced the same (their estimated value), flagged in_kind so the UI shows "covered in goods".
export function priceDeliverable(d: Deliverable, ctx: PriceCtx): PricedDeliverable

// PriceCtx bundles { tier, currency, cfg, brandCategories, creatorNiche, realER } so callers pass it once.
```

### 1e. Tier rollup + take-rate + guarantee + CPM rail

```ts
export interface PricedTier {
  name: string                   // 'Standard' | 'Premium' | (optional 3rd)
  deliverables: PricedDeliverable[]
  stretchGoals: StretchGoal[]    // display-only in v1 (see Step 8); not added to gross
  gross_price: number            // (Σ line_total) × (1 + bundleAdjustment)  — rounded to whole currency unit
  creator_net: number            // gross × (1 − take_rate_applied)
  platform_cut: number           // gross − creator_net
  take_rate_applied: number      // the negotiated rate actually used (from override or cfg default)
  cpm: { implied: number; band: {low:number;high:number} | null; inBand: boolean } // sanity rail
  cpmWarning: string | null      // non-null when out of band — WARN, do not throw, do not block
}

export interface PriceResult {
  currency: string
  tiers: PricedTier[]
  guarantee: GuaranteeBlock | null   // set when the SELECTED/headline tier gross ≥ cfg.guarantee.threshold
  take_rate_applied: number
}

// CPM rail: impliedCPM = gross ÷ expectedImpressions × 1000. expectedImpressions estimated from
// followers × ER (per platform). Compare against cfg.cpm_bands[platform]. Out of band ⇒ set
// cpmWarning (e.g. "implied CPM £18 is above the IG £5–12 band — review the deliverable mix").
// Spec: warn-not-ship. The warning is surfaced in the builder/proposal view, never swallowed.
export function priceProposal(
  tiersIn: { name: string; deliverables: Deliverable[]; stretchGoals?: StretchGoal[] }[],
  profile: CreatorProfileInput,
  brand: { categories: string[]; description?: string },
  opts: { tenantId: string; takeRateOverride?: number | null },
): PriceResult
```

- **Negotiated take_rate override:** `opts.takeRateOverride` (a per-creator/tenant value) takes
  precedence over `cfg.take_rate`; the value actually used is recorded as `take_rate_applied` on the
  result and persisted per proposal. **Validate** `0 ≤ rate < 1`, else throw (a negotiated 0% or
  >100% is a loud error, not a silent clamp).
- **Guarantee recording:** if the headline tier `gross_price ≥ cfg.guarantee.threshold` (default
  £1000), attach `guarantee = { threshold, window_ends_at: now + windowDays·day, state: 'active',
  split: cfg.guarantee.split }`. This is **recorded only** — no money movement (spec: manual
  settlement v1). Persisted as the `proposals.guarantee` JSON column.
- **Currency:** `currency` flows from config (`GBP` primary). All lookups pass `currency`; a USD
  proposal reads the USD card. Rounding to whole currency units happens at the tier-gross level.

### 1f. Persistence

```ts
export interface ProposalRow { /* mirrors proposals columns incl. money fields + guarantee + public_token */ }

// Inserts a proposals row (tenant-scoped) + a unique public_token (Step 4 shape). tiers/stretch_goals
// stored as JSON (prices live inside tiers JSON, per spec). Returns the row incl. token + id.
export function createProposal(tenantId: string, data: {
  creatorProfileId: number; brandId: number; deal_type: 'creator_pitched';
  result: PriceResult; tiers: PricedTier[]; bodyProse: { subject?: string; body: string };
}): ProposalRow

export function getProposalByToken(token: string): ProposalRow | null          // public page (no tenant scope; token IS the auth)
export function getProposal(tenantId: string, id: number): ProposalRow | null    // dashboard (tenant-scoped)
```

**Fail-loud summary for Step 1:** missing config key → throw; missing rate card → throw; invalid
negotiated rate → throw; CPM out of band → warn (attach `cpmWarning`), never throw. No catch returns
a fallback number.

---

## Step 2 — Deliverables packaging (constrained LLM; engine attaches prices)

**File:** `src/proposals.ts` (same module; the LLM call sits *before* `priceProposal`).
**Reuse:** the `pitchgen.ts` request scaffolding (`PITCH_MODEL`/`PITCH_MODEL ?? 'gpt-5.4-mini'`,
strict `json_schema`, `extractText`, abort/timeout). Factor the OpenAI `/v1/responses` POST into a
small shared helper if duplication is ugly — but prefer importing `extractText` from `pitchgen.ts`
(export it) over re-implementing.

### 2a. Inputs (both already structured, per cross-track ownership)

- **Brand wants** from the matched `brands` row: `categories` (main/secondary), `description`,
  `enrichment` (raw provider signals). Inferred via the LLM, e.g. DTC reels-heavy brand → wants Reels
  + usage rights; a local hotel → location Reel + Stories (the `pitch/CLAUDE.md` travel special case).
- **Creator can deliver** from the Creator IQ `creator_profiles` row: `primaryPlatform`, content
  style, real ER, past work, **`creator_type`**. Constraint: never propose YouTube long-form for an
  IG-only creator.

### 2b. The constrained call

```ts
// Emits a structured deliverable list ONLY (no prices — the engine attaches dollars).
// `creator_type` selects the DEFAULT vocabulary; the LLM may MIX content + event + in-kind lines.
//   - content creator → content deliverables (IG post/Reel/Story, TikTok, UGC)
//   - events creator   → sponsorship vocabulary (logo placement, banners, booth, stage/Story shoutout,
//                        host appearance, event recap package) priced off the `event` rate family,
//                        PLUS optional content posts, PLUS an optional in_kind cost-coverage line.
// Then groups into 2–3 tiers (Standard / Premium [/ optional]) + flexible stretch goals.
export async function packageDeliverables(input: {
  brand: { categories: string[]; description?: string; enrichment?: unknown }
  creator: CreatorProfileInput & { contentStyle?: string; pastWork?: string }
}): Promise<{ tiers: { name: string; deliverables: Deliverable[]; stretchGoals: StretchGoal[] }[] }>
```

- **Strict `json_schema`** over the `Deliverable` shape (`type,count,platform,format,usage_rights,
  exclusivity?,description,in_kind?,in_kind_value?`) so the LLM cannot return prose where structure
  is required. `additionalProperties:false`, `required` on the non-optional fields.
- The LLM sets the **mix**; `priceProposal` (Step 1) attaches the **numbers**. The two are
  deliberately separate so the price is auditable and the LLM never invents a figure.
- **StretchGoal** shape: `{ metric:'views'|'conversions'|'sales_pct', target:number, bonus:number|null,
  bonus_pct:number|null, description:string }` — flexible per `pricing_config`; **display-only in v1**.
- **Fail loud:** if the LLM call errors / returns no parseable JSON / returns an empty deliverable
  list, **throw** with context (`packageDeliverables failed for brand <id>: <reason>`). Unlike
  today's `pitchgen.generate` (best-effort, returns null), a proposal with no deliverables is a hard
  failure surfaced to the user, not a silent blank. (Matches CLAUDE.md "no degrading silently — even
  where code used to be best-effort.")

### 2c. Orchestrator

```ts
// The top-level v1 entry: pull Creator IQ + matched brand → packageDeliverables (LLM)
//   → priceProposal (deterministic) → pitchgen prose (Step 3) → createProposal (persist). Returns the row.
export async function generateProposal(tenantId: string, args: {
  creatorProfileId: number; brandMatchId: number; takeRateOverride?: number | null;
}): Promise<ProposalRow>
```

---

## Step 3 — `src/pitchgen.ts` extension: `PitchKind='proposal'`

**File:** `src/pitchgen.ts`. **Extend, do not fork.** Exact diff shape:

1. `export type PitchKind = 'outreach' | 'followup' | 'proposal'`.
2. Add proposal fields to `PitchInput`:
   ```ts
   brandName?: string                 // REAL brand name — proposal is one-to-one, NO placeholders
   recipientName?: string             // real contact, if known
   pricedTiers?: PricedTier[]         // the FINISHED numbers from proposals.ts
   currency?: string
   proposalUrl?: string               // the /p/:token link, if the prose should reference it
   ```
3. Add `const TASK_PROPOSAL`:
   - **Skips `COMMON_RULES`** entirely (that block is the `{{placeholder}}` instruction — a proposal
     is brand-specific with real values, so placeholders must NOT appear). State explicitly:
     "Use the REAL brand and recipient names provided. Do NOT use any `{{...}}` placeholder."
   - Feeds the **finished numbers** verbatim with the hard rule: *"These prices are final. Quote them
     exactly. Do NOT alter, recompute, round, or invent any figure. Write the prose AROUND them."*
   - Voice: the proposal is the post-interest "once I know the scope" artifact — warm, concrete,
     references the brand specifically, follows the `pitch/CLAUDE.md` human-writing rules (no em
     dashes, no corporate filler) but **is allowed to state price** (it is not a cold pitch).
   - Output schema: extend or branch the `json_schema` to return the prose block(s) — e.g.
     `{ subject, intro, tierBlurbs: [{name, blurb}], closing }` — so the view can interleave prose
     with the engine's numbers rather than the model re-stating prices in free text.
4. In `generate()`, branch `const task = input.kind === 'proposal' ? TASK_PROPOSAL : input.kind === 'followup' ? TASK_FOLLOWUP : TASK_OUTREACH`, and include the priced tiers in the `input` context string.
5. **`export` `extractText`** so `proposals.ts` reuses it (Step 2) instead of re-implementing.
6. **Fail-loud nuance:** for `kind:'proposal'`, a null/empty model result should propagate as a
   thrown error to `generateProposal` (the caller decides), rather than the silent `return null` the
   template kinds use — a proposal with priced tiers but no prose is a loud failure. Keep the
   existing `return null` behavior for `outreach`/`followup` unchanged (surgical).

---

## Step 4 — Routes in `src/server.ts`

**File:** `src/server.ts`. **Reuse** the `runGenerate` shape and `apiAuth` middleware; reuse the
`auth.ts` token convention for the public link.

### 4a. `POST /api/proposals/generate` (auth: `apiAuth`, tenant-scoped)

```
body: { creatorProfileId, brandMatchId, takeRateOverride? }
```
- **Gate the CTA on interest** (spec): before generating, assert the lead has reached
  `replied`/interested. **Real hook:** a reply flips `campaign_contacts.status='replied'`
  (`src/sessions.ts` `handleInbound`, line ~143), and `campaigns.syncStageOnReply`
  (`src/campaigns.ts:90`) runs `ai.assessConversation` (`src/ai.ts:113`) to stage the deal.
  v1 gate = the matched lead's `campaign_contacts.status='replied'` (the concrete, always-present
  signal); where `attio_stage_sync` is on, additionally accept `contacts.attio_synced_stage` ∈ the
  configured interested stages. If not yet replied/interested → return `400 { ok:false, error:
  'proposal unlocks after the brand replies' }` (surfaced in the UI as a disabled CTA + reason).
- On pass: `await proposals.generateProposal(tenantId, args)` → `c.json({ ok:true, proposal })`.
- **Fail loud:** wrap in try/catch only to convert thrown engine errors (missing config/card,
  packaging failure) into `c.json({ ok:false, error: e.message }, 502)` — propagate the real message,
  never a generic 200.

### 4b. `GET /api/proposals/:id` (auth: `apiAuth`, tenant-scoped)

`proposals.getProposal(tenantId, id)` → returns the row **including `creator_net`/`platform_cut`**
(this is the creator's own dashboard view, so net/cut are allowed here). 404 if not found/owned.

### 4c. `GET /p/:token` (PUBLIC — no session; token IS the access control)

- Register **before** `pageAuth`-guarded routes, alongside the other public routes
  (`/`, `/login`, near `src/server.ts:154`).
- `proposals.getProposalByToken(token)` (token = `randomBytes(24).toString('hex')`, same generator
  family as `auth.ts` `wa_…` tokens / session tokens; constant-time compare not required since it is
  a single-row unique lookup, but the token must be unguessable). 404 → render a plain "not found".
- **Brand-facing = gross only.** The public render shows `gross_price` per tier and the prose; it
  **must NOT** include `creator_net`, `platform_cut`, `take_rate_applied`, or the guarantee split
  internals. (Brand sees one number; the cut is hidden. Spec §"Take-rate".)
- Surfaces the `cpmWarning` **only in the authenticated builder**, never on the public brand page.

---

## Step 5 — View in `src/views.ts`

**File:** `src/views.ts`. **Reuse** the existing `*View(): string` server-rendered pattern
(e.g. `brandsView`, `dashboardView`) and the shared CSS in the head.

1. `export function proposalPublicView(proposal): string` — the hosted `/p/:token` page. Renders:
   per-tier cards with deliverable list + **gross price** + prose blurbs + a "based on <source> 2025
   market rates" footnote (from each priced deliverable's `breakdown.source`). In-kind lines shown
   as "covered in goods (est. £X)". **No net/cut/take-rate anywhere on this page.** Stretch goals
   listed as display-only performance bonuses.
2. Creator-facing net/cut display in the **dashboard** (the authenticated surface): a panel that,
   for a proposal, shows "you net £2,125 of this £2,500 package" (`creator_net` of `gross_price`),
   the `take_rate_applied`, and the guarantee state (`active`/`released`/`refunded`) when present.
   Wire this into the existing dashboard view (or a new `proposalDetailView`) reading
   `GET /api/proposals/:id`. Render the `cpmWarning` here as a visible amber note when set.
3. **Fail-loud in UI:** if generation returned an error, the dashboard renders the `{ error }`
   message as a banner (per CLAUDE.md), never a spinner that never resolves.

---

## Step 6 — `src/pitch/CLAUDE.md` amendment (founder sign-off)

**File:** `src/pitch/CLAUDE.md`. **One-paragraph addition**, placed under the "Hard rules — never do
these" no-price bullet (line ~110), codifying that the rule is first-touch-only. Proposed text:

> **Scope of the no-price rule.** The "never set or demand a price" rule above governs the **first
> touch and the cold/follow-up chase only**. Once the brand replies and signals interest, pricing is
> not just allowed but expected: a separate, brand-specific **priced proposal** artifact (the "once I
> know the scope" deliverable) carries the numbers. That proposal is a different document at a
> different stage, generated only after interest, and is the right place for deliverables, tiers, and
> defensible prices. Keep the cold pitch price-free; let the proposal do the money.

**Flag:** this changes the authoritative voice spec — **needs founder sign-off in the review gate.
Recommend yes** (otherwise the proposal artifact silently contradicts the spec it inherits from).

---

## Step 7 — Tests (`node:test`)

**File:** `scripts/proposals-pricing.test.ts` (new; mirrors `scripts/attio-logic.test.ts`).
Run: `node --test scripts/proposals-pricing.test.ts`. The pricing engine is **pure logic** — test it
directly with a stub `PricingConfig` + stub `lookupRate` (inject config so tests don't depend on the
foundation seed being present; or seed a temp in-memory `rate_cards`/`pricing_config` if the readers
are DB-bound — prefer dependency-injected config to keep tests pure). Concrete cases, numbers from the
spec's GBP tables:

1. **Base-rate lookup** — `lookupRate({tier:'micro',platform:'instagram',format:'reel',currency:'GBP'})`
   returns the seeded Micro IG Reel band (£250–1,200); asserts mid is used as base.
2. **Each multiplier in isolation** —
   - `nicheMultiplier(['finance'], …)` ≈ 3–5× vs `['lifestyle']` = 1× (finance/SaaS/B2B premium).
   - `engagementFactor`: 22K @ 6% ER (above expected micro ER) → factor > 1, clamped ≤ ceil (1.5);
     22K @ 1.5% → factor < 1, clamped ≥ floor (0.7).
   - `usageUplift('paid_ads')` ≈ +0.35; `exclusivityUplift('12mo')` ≈ +0.5.
   - `bundleAdjustment(3)` returns a small negative fraction, capped at `max`.
3. **Take-rate / net / cut** — gross £2,500 @ 15% → `creator_net=2125`, `platform_cut=375`,
   `take_rate_applied=0.15`.
4. **Negotiated-rate override** — `takeRateOverride:0.10` on the same £2,500 → net £2,250, cut £250,
   `take_rate_applied=0.10`; **invalid override** (`1.2`, `-0.1`) → **throws**.
5. **CPM rail trigger** — a deliverable mix whose implied CPM exceeds the IG £5–12 band sets
   `cpmWarning` (non-null) but **still returns a price** (warn-not-ship); an in-band mix → `null`.
6. **Guarantee threshold** — headline gross £999 → `guarantee:null`; £1,000 → `guarantee` block with
   `state:'active'`, `window_ends_at` = now + configured window, split from config.
7. **Fail-loud readers** — missing `pricing_config` key → `loadPricingConfig` throws; missing
   `rate_cards` row → `lookupRate` throws (no silent £0).

(LLM packaging and routes are exercised by running the app — no integration harness exists, per
CLAUDE.md. Tests cover only the deterministic engine.)

---

## Step 8 — Defaults for the spec's open questions

1. **Stretch-goal tracking:** **display-only in v1.** `StretchGoal` is rendered on the proposal but
   no view/coupon tracking is wired and stretch bonuses are **not** added to `gross_price`. Tracking
   is a later phase (matches dual-mode Phase 3). Leave the `metric`/`target` fields populated so a
   future tracker can read them.
2. **`platform_campaign` fan-out:** **deferred to a follow phase.** Leave a clean seam:
   `deal_type` column already distinguishes `'creator_pitched'` (v1) from `'platform_campaign'`; the
   `proposal_creators` join table (foundation-owned) exists but is unused in v1; `generateProposal`
   takes a single `creatorProfileId` (fan-out would loop). No `platform_campaign` code paths,
   revenue-split-of-full-payment logic, or multi-creator UI in v1 — only the column + table + the
   single-creator orchestrator that a follow phase extends. Do **not** stub half a fan-out.

---

## Shared-file touchpoints

| File | Owner | This plan's touch |
|---|---|---|
| `src/db.ts` | **Foundation** | READ-ONLY here. `rate_cards`, `pricing_config`, `proposals` money cols, `proposal_creators` — referenced, asserted-present (fail loud), never created by this plan. |
| `src/proposals.ts` | **This plan (new)** | Pricing engine + packaging + persistence + orchestrator. |
| `src/pitchgen.ts` | shared | Add `'proposal'` kind + `TASK_PROPOSAL` + proposal `PitchInput` fields; `export extractText`. Outreach/followup unchanged. |
| `src/server.ts` | shared | Add 3 routes (`/api/proposals/generate`, `/api/proposals/:id`, public `/p/:token`). Reuse `apiAuth`, `runGenerate` shape. |
| `src/views.ts` | shared | Add `proposalPublicView` (gross-only) + creator net/cut + guarantee + CPM-warning panel in the authed dashboard. |
| `src/pitch/CLAUDE.md` | shared | One-paragraph first-touch-only amendment (founder sign-off). |
| `scripts/proposals-pricing.test.ts` | **This plan (new)** | Pure-logic engine tests. |

## Dependencies (must land first / be available)

- **Foundation seeds** — `rate_cards` (GBP primary, USD secondary) + `pricing_config` (take_rate,
  niche/usage/exclusivity multipliers, ER curve, bundle, CPM bands, guarantee) seeded **idempotently**
  (`upsertBrands`-style). Without them, `proposals.ts` **fails loud** by design. The exact
  `pricing_config` key names this plan reads (Step 1a) must match what foundation seeds — coordinate
  the key list.
- **Creator IQ** — `creator_profiles` with `primaryPlatform`, `followers` (+ a `followersAreCombined`
  / aggregate flag for the calibration rule), real `engagementRate`, `creator_type`, content style,
  past work. Mapped onto `CreatorProfileInput`.
- **Brand-match** — a selected `creator_brand_matches` row → `brand_id` → `brands` (categories,
  description, enrichment) via `brands.ts`.

## Risks / watch-items

1. **Config/seed key drift.** The engine reads named `pricing_config` keys; if foundation seeds
   different names, every generate fails loud (good — not silent) but blocks the feature. **Mitigation:**
   agree the key list (Step 1a interface) across tracks before foundation seeds.
2. **Defensibility of the GBP numbers.** The whole product credibility rests on the seeded bands being
   right (spec: a 3×-off price kills it). The engine is correct-by-construction, but the **seed values
   are the real risk** — they live in foundation's seed and must be calibrated to the spec's 2026 UK
   tables with `source` provenance on every row.
3. **CPM rail false alarms.** `expectedImpressions` is estimated (followers × ER); a noisy ER could
   trigger spurious warnings. It only warns (never blocks), so the failure mode is a visible note, not
   a broken proposal — acceptable for v1.
4. **Creator IQ field shape not final.** `CreatorProfileInput` is an interface precisely so the mapping
   lives in one place; if Creator IQ renames a field, only the mapper changes.
5. **LLM returns an unpriceable deliverable** (a platform/format with no rate card). The engine throws
   (loud) rather than guessing a price — surfaced as a generate error. **Mitigation:** constrain the
   packaging schema's `platform`/`format` enums to exactly the seeded rate-card keys so the LLM cannot
   emit an unpriceable line.
6. **Interest-gate coverage.** The reliable v1 signal is `campaign_contacts.status='replied'`; the
   richer `attio_synced_stage` only exists when a tenant has `attio_stage_sync` on. Gate on `replied`
   as the floor so the CTA works for every tenant, treat stage as an additional unlock — don't make
   the proposal depend on Attio being configured.
