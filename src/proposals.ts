// Stage 3 — the priced proposal generator + deterministic pricing engine (v1: creator_pitched).
//
// "The LLM packages deliverables and writes prose; the price is deterministic." This module owns the
// arithmetic. Every number comes from the seeded `rate_cards` + `pricing_config` rows (see db.ts) —
// NOTHING is hardcoded here, and a missing config key / rate card THROWS (spec: never ship a 0% cut
// or a guessed £0 price). The deliverable MIX comes from one constrained LLM call (its own fetch,
// strict json_schema, mirroring pitchgen.ts); the engine attaches the prices.
//
// Pipeline: packageDeliverables (LLM) -> priceProposal (deterministic) -> pitchgen.generate(
// {kind:'proposal'}) (prose around fixed numbers) -> createProposal (persist + public_token).
//
// ----------------------------------------------------------------------------------------------------
// WAVE 2 (routes + views — NOT built here; src/server.ts + src/views.ts are out of scope for this wave):
//
//   POST /api/proposals/generate   (apiAuth, tenant-scoped) — body {creatorProfileId, brandMatchId,
//     takeRateOverride?}. GATE THE CTA ON INTEREST before generating. The real hook found in this
//     codebase: an inbound reply flips campaign_contacts.status='replied' (src/sessions.ts handleInbound,
//     ~line 143); campaigns.syncStageOnReply (src/campaigns.ts:90) then runs ai.assessConversation
//     (src/ai.ts:113) to stage the deal. v1 gate floor = the matched lead's campaign_contacts.status=
//     'replied' (always present, every tenant). Where tenants.attio_stage_sync is on, ADDITIONALLY accept
//     contacts.attio_synced_stage in the configured interested stages. Not yet replied/interested ->
//     400 {ok:false, error:'proposal unlocks after the brand replies'} (UI: disabled CTA + reason).
//     On pass: await generateProposal(tenantId, args) -> c.json({ok:true, proposal}). try/catch only to
//     convert thrown engine errors into c.json({ok:false, error:e.message}, 502) — never a generic 200.
//   GET  /api/proposals/:id        (apiAuth, tenant-scoped) — getProposal(tenantId, id); creator's own
//     dashboard, so creator_net/platform_cut/take_rate_applied/cpmWarning ARE allowed here. 404 if not owned.
//   GET  /p/:token                 (PUBLIC — register before pageAuth, alongside / and /login). Token IS
//     the access control. getProposalByToken(token). BRAND-FACING = GROSS ONLY: render gross_price per
//     tier + prose + "based on <source> market rates" footnote; MUST NOT show creator_net, platform_cut,
//     take_rate_applied, guarantee split internals, or cpmWarning. 404 -> plain "not found".
//   Views: proposalPublicView (gross-only) + a creator net/cut + guarantee + cpmWarning panel in the
//     authed dashboard. Generation errors render as a visible banner (CLAUDE.md fail-loud-in-FE), never a
//     spinner that never resolves.
//
// WAVE 2 (needs sign-off — proposed src/pitch/CLAUDE.md amendment, do NOT edit that file until approved):
//
//   > **Scope of the no-price rule.** The "never set or demand a price" rule above governs the **first
//   > touch and the cold/follow-up chase only**. Once the brand replies and signals interest, pricing is
//   > not just allowed but expected: a separate, brand-specific **priced proposal** artifact (the "once I
//   > know the scope" deliverable) carries the numbers. That proposal is a different document at a
//   > different stage, generated only after interest, and is the right place for deliverables, tiers, and
//   > defensible prices. Keep the cold pitch price-free; let the proposal do the money.
//
// PHASE 2 (deferred fan-out — clean seam, NOT stubbed here): deal_type='platform_campaign' proposals fan
//   out to many creators. The `proposal_creators` join (db.ts) + the `deal_type` column already exist and
//   stay UNUSED in v1. generateProposal takes a single creatorProfileId; the fan-out phase loops it and
//   splits the brand's full flat payment per pricing_config rather than marking up one creator's deal. No
//   platform_campaign code paths, revenue-split-of-full-payment logic, or multi-creator UI land in v1.
// ----------------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto'
import { db } from './db.ts'
import type { ProposalRow } from './db.ts'
import { extractText } from './pitchgen.ts'

const PITCH_MODEL = process.env.PITCH_MODEL ?? 'gpt-5.4-mini'
const ENDPOINT = 'https://api.openai.com/v1/responses'

// =====================================================================================================
// Config + rate-card readers (fail loud)
// =====================================================================================================

export interface PricingConfig {
  take_rate: number // default 0.15 (global); per-creator/tenant override may replace it
  bundle_adjustment: number // small multi-deliverable discount, applied as (1 + bundle_adjustment); negative
  niche_multipliers: Record<string, number> // { finance:4, saas:4, b2b:3.5, lifestyle:1, default:1, ... }
  usage_rights_uplift: Record<string, number> // { none:0, paid_ads:0.35, full_buyout:0.5, ... }
  exclusivity_uplift: Record<string, number> // keyed by window: { none:0, '3mo':0.15, '12mo':0.5, ... }
  er_curve: { expected: Record<string, number>; floor: number; ceil: number } // engagement clamp + expected ER per tier
  cpm_rails: Record<string, [number, number]> // { instagram:[5,12], tiktok:[2,8], youtube:[8,15] } — [low,high]
  guarantee: { threshold: number; window_days: number; split: Record<string, number> }
  combined_reach_discount?: number // optional: factor applied to a combined/cross-platform follower count
  currency: string // 'GBP' primary
}

// Read a single pricing_config value by key, layering a per-tenant override ('key:<tenantId>') over the
// bare global row. THROWS if neither exists — a missing config key is a loud failure, never a default.
function readConfigValue(key: string, tenantId: string): unknown {
  const row =
    (db
      .prepare('SELECT value_json FROM pricing_config WHERE key = ?')
      .get(`${key}:${tenantId}`) as { value_json: string } | undefined) ??
    (db.prepare('SELECT value_json FROM pricing_config WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined)
  if (!row) throw new Error(`pricing_config missing key: ${key} (tenant ${tenantId})`)
  try {
    return JSON.parse(row.value_json)
  } catch (e) {
    throw new Error(`pricing_config key ${key} holds invalid JSON: ${(e as Error).message}`, { cause: e })
  }
}

// Optional read: returns undefined when neither the tenant override nor the global row exists, but still
// THROWS on a present-but-invalid JSON value (a malformed override must not silently fall back).
function readConfigValueOptional(key: string, tenantId: string): unknown {
  const row =
    (db
      .prepare('SELECT value_json FROM pricing_config WHERE key = ?')
      .get(`${key}:${tenantId}`) as { value_json: string } | undefined) ??
    (db.prepare('SELECT value_json FROM pricing_config WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined)
  if (!row) return undefined
  try {
    return JSON.parse(row.value_json)
  } catch (e) {
    throw new Error(`pricing_config key ${key} holds invalid JSON: ${(e as Error).message}`, { cause: e })
  }
}

// Load the full pricing config for a tenant (override layered over global). Read once per generate()
// and threaded through — no module-level cache that could go stale across a re-seed. `currency` is not a
// seeded key; it defaults to GBP (primary) and is passed in by the orchestrator for a USD proposal.
export function loadPricingConfig(tenantId: string, currency = 'GBP'): PricingConfig {
  const combined = readConfigValueOptional('combined_reach_discount', tenantId)
  return {
    take_rate: readConfigValue('take_rate', tenantId) as number,
    bundle_adjustment: readConfigValue('bundle_adjustment', tenantId) as number,
    niche_multipliers: readConfigValue('niche_multipliers', tenantId) as Record<string, number>,
    usage_rights_uplift: readConfigValue('usage_rights_uplift', tenantId) as Record<string, number>,
    exclusivity_uplift: readConfigValue('exclusivity_uplift', tenantId) as Record<string, number>,
    er_curve: readConfigValue('er_curve', tenantId) as PricingConfig['er_curve'],
    cpm_rails: readConfigValue('cpm_rails', tenantId) as Record<string, [number, number]>,
    guarantee: readConfigValue('guarantee', tenantId) as PricingConfig['guarantee'],
    combined_reach_discount: typeof combined === 'number' ? combined : undefined,
    currency,
  }
}

export interface RateLookup {
  low: number
  mid: number
  high: number
  source: string
}

// One rate-card lookup, keyed (tier, platform, format, currency). THROWS if the row is absent OR if its
// mid is null — a missing/empty card is a loud failure, never a £0 deliverable. base_rate = mid.
export function lookupRate(
  key: { tier: string; platform: string; format: string; currency: string },
): RateLookup {
  const row = db
    .prepare(
      'SELECT low, mid, high, source FROM rate_cards WHERE tier = ? AND platform = ? AND format = ? AND currency = ?',
    )
    .get(key.tier, key.platform, key.format, key.currency) as
    | { low: number | null; mid: number | null; high: number | null; source: string }
    | undefined
  if (!row || row.mid == null) {
    throw new Error(
      `rate_cards missing row: ${key.tier}/${key.platform}/${key.format}/${key.currency}`,
    )
  }
  return { low: row.low ?? row.mid, mid: row.mid, high: row.high ?? row.mid, source: row.source }
}

// =====================================================================================================
// Tiering the creator (follower -> band) — spec calibration rules
// =====================================================================================================

export interface CreatorProfileInput {
  // The subset of the Creator IQ `creator_profiles` row the engine needs. Defined here so the Creator IQ
  // track's exact column names map onto it in ONE place.
  primaryPlatform: string // 'instagram' | 'tiktok' | 'youtube' | ...
  followers: number
  followersAreCombined?: boolean // true => `followers` is an aggregate across socials, not bookable audience
  engagementRate: number // real ER as a fraction (e.g. 0.06 = 6%)
  creatorType: string // 'content' | 'events' | 'both'
  niche: string
}

// Maps a creator to a rate-card tier from PRIMARY-platform engaged followers, NOT aggregate reach.
// Spec calibration rules:
//   - 50–250K is a real band ('mid'), not a gap.
//   - A combined/across-socials count is discounted to a primary-platform-equivalent BEFORE tiering
//     (soft uplift only, never the tier driver) via pricing_config `combined_reach_discount`. If the
//     count is flagged combined but no discount factor is configured, THROW (never silently tier off a
//     vanity aggregate). For a single-platform count the discount key is never read.
// Bands: nano 1–10K, micro 10–50K, mid 50–250K, macro 250K–1M, mega 1M+.
export function tierFor(profile: CreatorProfileInput, cfg: PricingConfig): string {
  let effective = profile.followers
  if (profile.followersAreCombined) {
    if (typeof cfg.combined_reach_discount !== 'number') {
      throw new Error(
        'pricing_config missing key: combined_reach_discount (required to tier a combined/cross-platform follower count)',
      )
    }
    effective = profile.followers * cfg.combined_reach_discount
  }
  if (effective < 10_000) return 'nano'
  if (effective < 50_000) return 'micro'
  if (effective < 250_000) return 'mid'
  if (effective < 1_000_000) return 'macro'
  return 'mega'
}

// =====================================================================================================
// The five factors (each pure, each from config)
// =====================================================================================================

// niche_multiplier — finance/SaaS/B2B premium vs lifestyle. Picks the HIGHEST multiplier among the
// matched brand's categories and the creator's niche (the deal is worth the premium category it touches),
// falling back to the configured `default`. Lookups are case-insensitive against the config keys.
export function nicheMultiplier(brandCategories: string[], creatorNiche: string, cfg: PricingConfig): number {
  const table = cfg.niche_multipliers
  const fallback = typeof table.default === 'number' ? table.default : 1
  const lower: Record<string, number> = {}
  for (const [k, v] of Object.entries(table)) lower[k.toLowerCase()] = v
  const candidates = [...brandCategories, creatorNiche]
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => lower[c.trim().toLowerCase()])
    .filter((v): v is number => typeof v === 'number')
  return candidates.length ? Math.max(...candidates) : fallback
}

// engagement_factor — compare the creator's REAL ER to the tier's expected ER; ratio clamped into
// [er_curve.floor, er_curve.ceil]. A 22K @ 6% ER is worth materially more than @ 1.5%.
export function engagementFactor(realER: number, tier: string, cfg: PricingConfig): number {
  const expected = cfg.er_curve.expected[tier]
  if (typeof expected !== 'number' || expected <= 0) {
    throw new Error(`er_curve.expected missing/invalid for tier: ${tier}`)
  }
  const ratio = realER / expected
  return Math.min(cfg.er_curve.ceil, Math.max(cfg.er_curve.floor, ratio))
}

// usage_rights_uplift — returns the +fraction (e.g. paid_ads -> 0.35). Missing key THROWS (an unpriceable
// usage-rights term must not silently become +0).
export function usageUplift(usageRights: string, cfg: PricingConfig): number {
  const v = cfg.usage_rights_uplift[usageRights]
  if (typeof v !== 'number') throw new Error(`usage_rights_uplift missing key: ${usageRights}`)
  return v
}

// exclusivity_uplift — window-based +fraction. A null/absent window means no exclusivity -> reads the
// configured 'none' (which itself must exist; missing 'none' THROWS rather than defaulting to 0).
export function exclusivityUplift(window: string | null | undefined, cfg: PricingConfig): number {
  const key = window ?? 'none'
  const v = cfg.exclusivity_uplift[key]
  if (typeof v !== 'number') throw new Error(`exclusivity_uplift missing key: ${key}`)
  return v
}

// bundle_adjustment — a small negative fraction for multi-deliverable packages. Config carries ONE
// `bundle_adjustment` value (the package discount); applied once when the package has >1 deliverable,
// zero for a single deliverable. (Spec: "small multi-deliverable discount.")
export function bundleAdjustment(deliverableCount: number, cfg: PricingConfig): number {
  return deliverableCount > 1 ? cfg.bundle_adjustment : 0
}

// =====================================================================================================
// Per-deliverable price + per-tier total
// =====================================================================================================

export interface Deliverable {
  type: string
  count: number
  platform: string
  format: string
  usage_rights: string
  exclusivity?: string | null
  description: string
  in_kind?: boolean // event packages: sponsor covers a cost; counts toward total, settled in goods
  in_kind_value?: number | null // estimated £ value of an in-kind line (used in total, flagged in UI)
}

export interface PricedDeliverable extends Deliverable {
  unit_price: number
  line_total: number
  breakdown: {
    base: number
    niche: number
    engagement: number
    usage: number
    exclusivity: number
    source: string
  }
}

export interface PriceCtx {
  tier: string
  currency: string
  cfg: PricingConfig
  brandCategories: string[]
  creatorNiche: string
  realER: number
}

// unit_price = base_rate(tier,platform,format) × niche × engagement × (1+usageUplift) × (1+exclusivityUplift)
// in_kind lines: priced the same (their estimated value, or the rate card if no estimate given), flagged
// in_kind so the UI shows "covered in goods". line_total = unit_price × count.
export function priceDeliverable(d: Deliverable, ctx: PriceCtx): PricedDeliverable {
  const niche = nicheMultiplier(ctx.brandCategories, ctx.creatorNiche, ctx.cfg)
  const engagement = engagementFactor(ctx.realER, ctx.tier, ctx.cfg)
  const usage = usageUplift(d.usage_rights, ctx.cfg)
  const exclusivity = exclusivityUplift(d.exclusivity, ctx.cfg)

  // Event deliverables price off the `event` tier/platform family; content off the creator's tier.
  const isEvent = d.platform === 'event'
  const rate = lookupRate({
    tier: isEvent ? 'event' : ctx.tier,
    platform: d.platform,
    format: d.format,
    currency: ctx.currency,
  })

  // An in-kind line with an explicit estimated value uses that value as its base (the sponsor's cost),
  // otherwise it prices off the rate card like any other line.
  const base = d.in_kind && typeof d.in_kind_value === 'number' ? d.in_kind_value : rate.mid

  const unit_price = Math.round(base * niche * engagement * (1 + usage) * (1 + exclusivity))
  const count = d.count > 0 ? d.count : 1
  return {
    ...d,
    unit_price,
    line_total: unit_price * count,
    breakdown: { base, niche, engagement, usage, exclusivity, source: rate.source },
  }
}

// =====================================================================================================
// Tier rollup + take-rate + guarantee + CPM rail
// =====================================================================================================

export interface StretchGoal {
  metric: 'views' | 'conversions' | 'sales_pct'
  target: number
  bonus: number | null
  bonus_pct: number | null
  description: string
}

export interface PricedTier {
  name: string // 'Standard' | 'Premium' | (optional 3rd)
  deliverables: PricedDeliverable[]
  stretchGoals: StretchGoal[] // display-only in v1; NOT added to gross
  gross_price: number // (Σ line_total) × (1 + bundleAdjustment), rounded to whole currency unit
  creator_net: number // gross × (1 − take_rate_applied)
  platform_cut: number // gross − creator_net
  take_rate_applied: number
  cpm: { implied: number; band: { low: number; high: number } | null; inBand: boolean }
  cpmWarning: string | null // non-null when out of band — WARN, do not throw, do not block
}

export interface GuaranteeBlock {
  threshold: number
  window_ends_at: number
  state: 'active' | 'released' | 'refunded'
  split: Record<string, number>
}

export interface PriceResult {
  currency: string
  tiers: PricedTier[]
  guarantee: GuaranteeBlock | null // set when the headline tier gross ≥ cfg.guarantee.threshold
  take_rate_applied: number
}

const DAY_MS = 24 * 60 * 60 * 1000

// CPM sanity rail. impliedCPM = gross ÷ expectedImpressions × 1000; expectedImpressions estimated from
// followers × ER (a single round of content reaches roughly the engaged audience). Compared against
// cfg.cpm_rails[platform]. Out of band ⇒ cpmWarning set — WARN, never throw, never block.
function computeCpm(
  gross: number,
  profile: CreatorProfileInput,
  cfg: PricingConfig,
): PricedTier['cpm'] & { warning: string | null } {
  const platform = profile.primaryPlatform
  const band = cfg.cpm_rails[platform]
  const expectedImpressions = Math.max(1, Math.round(profile.followers * profile.engagementRate))
  const implied = Math.round((gross / expectedImpressions) * 1000)
  if (!band) {
    return { implied, band: null, inBand: true, warning: null }
  }
  const [low, high] = band
  const inBand = implied >= low && implied <= high
  const warning = inBand
    ? null
    : `implied CPM ${cfg.currency} ${implied} is ${implied < low ? 'below' : 'above'} the ${platform} ${low}–${high} band — review the deliverable mix`
  return { implied, band: { low, high }, inBand, warning }
}

// Price a set of tiers deterministically. The headline tier (the first / Standard tier) drives the
// guarantee check. take_rate override is validated 0 ≤ rate < 1 (a negotiated 0% or >100% is a loud
// error, not a silent clamp).
export function priceProposal(
  tiersIn: { name: string; deliverables: Deliverable[]; stretchGoals?: StretchGoal[] }[],
  profile: CreatorProfileInput,
  brand: { categories: string[]; description?: string },
  opts: { tenantId: string; takeRateOverride?: number | null; cfg?: PricingConfig },
): PriceResult {
  if (!tiersIn.length) throw new Error('priceProposal: no tiers to price')

  const cfg = opts.cfg ?? loadPricingConfig(opts.tenantId)
  const currency = cfg.currency

  let take_rate_applied = cfg.take_rate
  if (opts.takeRateOverride != null) {
    const r = opts.takeRateOverride
    if (typeof r !== 'number' || Number.isNaN(r) || r < 0 || r >= 1) {
      throw new Error(`invalid take_rate override: ${r} (must be 0 ≤ rate < 1)`)
    }
    take_rate_applied = r
  }

  const tier = tierFor(profile, cfg)
  const ctx: PriceCtx = {
    tier,
    currency,
    cfg,
    brandCategories: brand.categories,
    creatorNiche: profile.niche,
    realER: profile.engagementRate,
  }

  const tiers: PricedTier[] = tiersIn.map((t) => {
    const deliverables = t.deliverables.map((d) => priceDeliverable(d, ctx))
    const lineSum = deliverables.reduce((s, d) => s + d.line_total, 0)
    const adj = bundleAdjustment(deliverables.length, cfg)
    const gross_price = Math.round(lineSum * (1 + adj))
    const creator_net = Math.round(gross_price * (1 - take_rate_applied))
    const platform_cut = gross_price - creator_net
    const cpm = computeCpm(gross_price, profile, cfg)
    return {
      name: t.name,
      deliverables,
      stretchGoals: t.stretchGoals ?? [],
      gross_price,
      creator_net,
      platform_cut,
      take_rate_applied,
      cpm: { implied: cpm.implied, band: cpm.band, inBand: cpm.inBand },
      cpmWarning: cpm.warning,
    }
  })

  // Guarantee: recorded only (no money movement). Keyed off the HEADLINE tier (first tier).
  const headline = tiers[0]
  let guarantee: GuaranteeBlock | null = null
  if (headline.gross_price >= cfg.guarantee.threshold) {
    guarantee = {
      threshold: cfg.guarantee.threshold,
      window_ends_at: Date.now() + cfg.guarantee.window_days * DAY_MS,
      state: 'active',
      split: cfg.guarantee.split,
    }
  }

  return { currency, tiers, guarantee, take_rate_applied }
}

// =====================================================================================================
// Deliverables packaging (constrained LLM; engine attaches prices)
// =====================================================================================================

export const packagingAvailable = () => !!process.env.OPENAI_API_KEY

// The platform/format pairs the LLM may emit, derived from the SEEDED rate cards so the model can NEVER
// return an unpriceable line. Read live from the DB (currency-scoped) — nothing hardcoded.
function priceableLines(
  currency: string,
  tier: string,
  creatorType: string,
): { platforms: string[]; formats: string[]; pairs: string[] } {
  // Content lines are only priceable at the CREATOR'S tier (e.g. UGC exists for nano/micro but not
  // mid+); the event family (tier='event') is available only to events/both creators. Filtering here
  // is what guarantees the LLM can never emit an unpriceable line for THIS creator.
  const includeEvent = creatorType === 'events' || creatorType === 'both' ? 1 : 0
  const rows = db
    .prepare(
      `SELECT DISTINCT platform, format FROM rate_cards
       WHERE currency = ? AND (tier = ? OR (? = 1 AND platform = 'event'))`,
    )
    .all(currency, tier, includeEvent) as { platform: string; format: string }[]
  if (!rows.length) {
    throw new Error(`no rate_cards for currency ${currency} / tier ${tier} — cannot package deliverables`)
  }
  const platforms = [...new Set(rows.map((r) => r.platform))]
  const formats = [...new Set(rows.map((r) => r.format))]
  const pairs = rows.map((r) => `${r.platform}/${r.format}`)
  return { platforms, formats, pairs }
}

export interface PackagedTiers {
  tiers: { name: string; deliverables: Deliverable[]; stretchGoals: StretchGoal[] }[]
}

// Emit a structured deliverable list ONLY (no prices — the engine attaches the numbers). `creator_type`
// selects the DEFAULT vocabulary; the LLM MAY mix content + event + in_kind lines. The platform/format
// enums are constrained to exactly the seeded rate-card keys so an unpriceable line is impossible.
// Mirrors pitchgen.ts: PITCH_MODEL, OpenAI /v1/responses, strict json_schema, abort/timeout, extractText.
// FAIL LOUD (unlike pitchgen's best-effort return null): a packaging failure / empty list THROWS.
export async function packageDeliverables(input: {
  brand: { categories: string[]; description?: string; enrichment?: unknown }
  creator: CreatorProfileInput & { contentStyle?: string; pastWork?: string }
  tier: string // the creator's rate-card tier (constrains which lines are priceable)
  currency?: string
}): Promise<PackagedTiers> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('packageDeliverables requires OPENAI_API_KEY')

  const currency = input.currency ?? 'GBP'
  const { platforms, formats, pairs } = priceableLines(currency, input.tier, input.creator.creatorType)

  const context = [
    `BRAND categories: ${input.brand.categories.join(', ') || '(none)'}`,
    input.brand.description ? `BRAND description: ${input.brand.description.slice(0, 1500)}` : '',
    `CREATOR primary platform: ${input.creator.primaryPlatform}`,
    `CREATOR type: ${input.creator.creatorType}`,
    `CREATOR niche: ${input.creator.niche}`,
    `CREATOR followers: ${input.creator.followers}${input.creator.followersAreCombined ? ' (combined across socials)' : ''}`,
    `CREATOR engagement rate: ${(input.creator.engagementRate * 100).toFixed(1)}%`,
    input.creator.contentStyle ? `CREATOR content style: ${input.creator.contentStyle}` : '',
    input.creator.pastWork ? `CREATOR past work: ${input.creator.pastWork.slice(0, 1000)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const instructions =
    `You package a creator's collaboration with a brand into 2-3 priced TIERS of deliverables. ` +
    `You DO NOT set any price — output ONLY the deliverable MIX; a separate deterministic engine attaches ` +
    `the numbers. Choose deliverables that the brand wants AND the creator can actually deliver: never ` +
    `propose a platform the creator isn't on (e.g. no YouTube for an IG-only creator).\n` +
    `creator_type selects the default vocabulary: 'content' => content deliverables (IG post/reel/story, ` +
    `TikTok, UGC); 'events' => sponsorship vocabulary (event deliverables) priced off the event family, ` +
    `PLUS optional content posts, PLUS an optional in_kind cost-coverage line (sponsor covers catering/` +
    `venue/prizes — set in_kind:true with an estimated in_kind_value). 'both' may mix freely.\n` +
    `Group into tiers named "Standard", "Premium" (and optionally a third). Add flexible stretch goals ` +
    `(performance bonuses on views/conversions/sales_pct) per tier — these are display-only.\n` +
    `platform MUST be one of: ${platforms.join(', ')}. format MUST be one of: ${formats.join(', ')}. ` +
    `Only these exact platform/format PAIRS are priceable for this creator — use ONLY these pairs: ${pairs.join(', ')}. ` +
    `usage_rights ∈ {none, organic, paid_ads, full_buyout}. ` +
    `exclusivity ∈ {none, '3mo', '6mo', '12mo'} or null. ` +
    `'description' describes ONE unit of the deliverable and MUST NOT restate the count (the 'count' field carries it).`

  const deliverableSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      platform: { type: 'string', enum: platforms },
      format: { type: 'string', enum: formats },
      usage_rights: { type: 'string', enum: ['none', 'organic', 'paid_ads', 'full_buyout'] },
      exclusivity: { type: ['string', 'null'], enum: ['none', '3mo', '6mo', '12mo', null] },
      description: { type: 'string' },
      in_kind: { type: 'boolean' },
      in_kind_value: { type: ['number', 'null'] },
    },
    required: [
      'type', 'count', 'platform', 'format', 'usage_rights', 'exclusivity',
      'description', 'in_kind', 'in_kind_value',
    ],
  }
  const stretchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      metric: { type: 'string', enum: ['views', 'conversions', 'sales_pct'] },
      target: { type: 'number' },
      bonus: { type: ['number', 'null'] },
      bonus_pct: { type: ['number', 'null'] },
      description: { type: 'string' },
    },
    required: ['metric', 'target', 'bonus', 'bonus_pct', 'description'],
  }

  const body = JSON.stringify({
    model: PITCH_MODEL,
    instructions,
    input: `INPUTS:\n${context}`,
    reasoning: { effort: 'low' },
    text: {
      format: {
        type: 'json_schema',
        name: 'proposal_deliverables',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tiers: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  deliverables: { type: 'array', minItems: 1, items: deliverableSchema },
                  stretchGoals: { type: 'array', items: stretchSchema },
                },
                required: ['name', 'deliverables', 'stretchGoals'],
              },
            },
          },
          required: ['tiers'],
        },
      },
    },
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new Error(`packageDeliverables request failed: ${(e as Error).message}`, { cause: e })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`packageDeliverables HTTP ${res.status}: ${detail.slice(0, 500)}`)
  }
  const data = await res.json()
  const text = extractText(data)
  if (!text) throw new Error('packageDeliverables: model returned no parseable text')
  let parsed: PackagedTiers
  try {
    parsed = JSON.parse(text) as PackagedTiers
  } catch (e) {
    throw new Error(`packageDeliverables: invalid JSON from model: ${(e as Error).message}`, { cause: e })
  }
  if (!parsed?.tiers?.length || parsed.tiers.some((t) => !t.deliverables?.length)) {
    throw new Error('packageDeliverables: model returned an empty deliverable list')
  }
  return parsed
}

// =====================================================================================================
// Persistence
// =====================================================================================================

function newPublicToken(): string {
  // Same generator family as auth.ts (randomBytes hex). Unguessable; uniqueness enforced by the
  // proposals.public_token UNIQUE index — a collision would throw, which is the right loud failure.
  return randomBytes(24).toString('hex')
}

// Insert a proposals row (tenant-scoped) + a unique public_token. tiers/stretch_goals stored as JSON
// (prices live inside the tiers JSON, per spec). Returns the full persisted row.
export function createProposal(
  tenantId: string,
  data: {
    creatorProfileId: number
    brandId: number
    brandMatchId?: number | null
    deal_type: 'creator_pitched'
    result: PriceResult
    tiers: PricedTier[]
    bodyProse: { subject?: string; body: string }
  },
): ProposalRow {
  const now = Date.now()
  const token = newPublicToken()
  const headline = data.tiers[0]
  const stretch = data.tiers.flatMap((t) => t.stretchGoals)

  const info = db
    .prepare(
      `INSERT INTO proposals (
         tenant_id, creator_profile_id, brand_id, brand_match_id, deal_type,
         tiers, stretch_goals, status, public_token,
         gross_price, creator_net, platform_cut, take_rate_applied, guarantee,
         created_at, updated_at
       ) VALUES (
         @tenant_id, @creator_profile_id, @brand_id, @brand_match_id, @deal_type,
         @tiers, @stretch_goals, 'draft', @public_token,
         @gross_price, @creator_net, @platform_cut, @take_rate_applied, @guarantee,
         @now, @now
       )`,
    )
    .run({
      tenant_id: tenantId,
      creator_profile_id: data.creatorProfileId,
      brand_id: data.brandId,
      brand_match_id: data.brandMatchId ?? null,
      deal_type: data.deal_type,
      tiers: JSON.stringify({ tiers: data.tiers, prose: data.bodyProse }),
      stretch_goals: JSON.stringify(stretch),
      public_token: token,
      gross_price: headline.gross_price,
      creator_net: headline.creator_net,
      platform_cut: headline.platform_cut,
      take_rate_applied: data.result.take_rate_applied,
      guarantee: data.result.guarantee ? JSON.stringify(data.result.guarantee) : null,
      now,
    })

  const row = db
    .prepare('SELECT * FROM proposals WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as ProposalRow | undefined
  if (!row) throw new Error('createProposal: row vanished immediately after insert')
  return row
}

// Public page (no tenant scope — the token IS the access control).
export function getProposalByToken(token: string): ProposalRow | null {
  if (!token) return null
  return (db.prepare('SELECT * FROM proposals WHERE public_token = ?').get(token) as ProposalRow | undefined) ?? null
}

// Dashboard (tenant-scoped).
export function getProposal(tenantId: string, id: number): ProposalRow | null {
  return (
    (db.prepare('SELECT * FROM proposals WHERE id = ? AND tenant_id = ?').get(id, tenantId) as
      | ProposalRow
      | undefined) ?? null
  )
}

// =====================================================================================================
// Orchestrator (v1 entry) — pull inputs -> package (LLM) -> price (deterministic) -> prose -> persist
// =====================================================================================================

// Top-level v1 entry. Pulls the Creator IQ profile + the selected brand-match -> matched brand, packages
// deliverables (LLM), prices them deterministically, writes prose around the FINISHED numbers via
// pitchgen.generate({kind:'proposal'}), and persists. Returns the row. Fail loud throughout — a missing
// profile/match/brand/config/card or a packaging failure THROWS (surfaced by the Wave 2 route as a 502).
export async function generateProposal(
  tenantId: string,
  args: { creatorProfileId: number; brandMatchId: number; takeRateOverride?: number | null },
): Promise<ProposalRow> {
  const { generate } = await import('./pitchgen.ts')

  const profileRow = db
    .prepare('SELECT * FROM creator_profiles WHERE id = ? AND tenant_id = ?')
    .get(args.creatorProfileId, tenantId) as Record<string, any> | undefined
  if (!profileRow) throw new Error(`creator_profiles row not found: ${args.creatorProfileId} (tenant ${tenantId})`)

  const match = db
    .prepare('SELECT * FROM creator_brand_matches WHERE id = ? AND tenant_id = ?')
    .get(args.brandMatchId, tenantId) as Record<string, any> | undefined
  if (!match) throw new Error(`creator_brand_matches row not found: ${args.brandMatchId} (tenant ${tenantId})`)

  const brandRow = db.prepare('SELECT * FROM brands WHERE id = ?').get(match.brand_id) as
    | Record<string, any>
    | undefined
  if (!brandRow) throw new Error(`brands row not found: ${match.brand_id} (referenced by match ${args.brandMatchId})`)

  // Map the Creator IQ row onto CreatorProfileInput (the one place column names are bound).
  const primaryPlatform = profileRow.instagram_handle
    ? 'instagram'
    : profileRow.tiktok_handle
      ? 'tiktok'
      : profileRow.youtube_channel
        ? 'youtube'
        : 'instagram'
  if (typeof profileRow.engagement_rate !== 'number') {
    throw new Error(`creator_profiles ${args.creatorProfileId} has no engagement_rate — cannot price (fail loud)`)
  }
  const brandCats = parseBrandCategories(brandRow.categories)
  const creator: CreatorProfileInput & { contentStyle?: string; pastWork?: string } = {
    primaryPlatform,
    followers: numFromProfile(profileRow),
    engagementRate: profileRow.engagement_rate,
    creatorType: profileRow.creator_type ?? 'content',
    niche: profileRow.niche ?? 'lifestyle',
    contentStyle: profileRow.content_style ?? undefined,
    pastWork: profileRow.past_deals ?? undefined,
  }

  const cfg = loadPricingConfig(tenantId)
  const tier = tierFor(creator, cfg)
  const packaged = await packageDeliverables({
    brand: { categories: brandCats, description: brandRow.description ?? undefined, enrichment: brandRow.enrichment },
    creator,
    tier,
    currency: cfg.currency,
  })

  const result = priceProposal(
    packaged.tiers,
    creator,
    { categories: brandCats, description: brandRow.description ?? undefined },
    { tenantId, takeRateOverride: args.takeRateOverride ?? null, cfg },
  )

  // Prose around the FINISHED numbers. For kind:'proposal', a null result is a loud failure (the caller
  // decides), unlike the template kinds' silent return null.
  const prose = await generate({
    kind: 'proposal',
    name: profileRow.name ?? undefined,
    brandName: brandRow.name,
    pricedTiers: result.tiers,
    currency: result.currency,
  })
  if (!prose) throw new Error(`pitchgen proposal prose failed for creator ${args.creatorProfileId} / brand ${match.brand_id}`)

  return createProposal(tenantId, {
    creatorProfileId: args.creatorProfileId,
    brandId: match.brand_id,
    brandMatchId: args.brandMatchId,
    deal_type: 'creator_pitched',
    result,
    tiers: result.tiers,
    bodyProse: { subject: prose.subject, body: prose.body },
  })
}

// brands.categories is JSON {main:[],secondary:[]}; flatten to a single category list for the engine.
function parseBrandCategories(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const j = JSON.parse(raw) as { main?: string[]; secondary?: string[] } | null
    return [...(j?.main ?? []), ...(j?.secondary ?? [])].filter((c): c is string => typeof c === 'string')
  } catch (e) {
    throw new Error(`brands.categories holds invalid JSON: ${(e as Error).message}`, { cause: e })
  }
}

// Follower count for tiering: prefer a structured demographics/profile_data follower field if present,
// else fall back to 0 (which tiers as 'nano') — but a present-but-non-numeric value is a loud failure.
function numFromProfile(profileRow: Record<string, any>): number {
  const pd = profileRow.profile_data
  if (typeof pd === 'string' && pd.trim()) {
    try {
      const j = JSON.parse(pd) as Record<string, any>
      const f = j?.followers ?? j?.follower_count
      if (f != null) {
        const n = Number(f)
        if (Number.isNaN(n)) throw new Error(`creator_profiles.profile_data.followers is not numeric: ${f}`)
        return n
      }
    } catch (e) {
      throw new Error(`creator_profiles.profile_data holds invalid JSON: ${(e as Error).message}`, { cause: e })
    }
  }
  return 0
}
