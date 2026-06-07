// Pure-logic tests for the deterministic pricing engine (src/proposals.ts). Concrete GBP numbers from
// docs/superpowers/specs/2026-06-07-proposal-pricing-design.md. The pricing math is injected with an
// explicit PricingConfig so it does not depend on the seed; the DB-bound READERS (loadPricingConfig /
// lookupRate) are exercised against a throwaway temp DB seeded at import, per scripts/seed.test.ts.
//   node --test scripts/proposals-logic.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PricingConfig, CreatorProfileInput, Deliverable } from '../src/proposals.ts'

// Set DB_PATH to a throwaway temp file BEFORE importing db.ts (it opens + seeds the DB at module load).
process.env.DB_PATH = join(tmpdir(), `lepton-proposals-test-${process.pid}.db`)

const { db } = await import('../src/db.ts')
const {
  loadPricingConfig,
  lookupRate,
  tierFor,
  nicheMultiplier,
  engagementFactor,
  usageUplift,
  exclusivityUplift,
  bundleAdjustment,
  priceProposal,
} = await import('../src/proposals.ts')

// A deterministic config mirroring the seeded defaults (injected so the math is independent of the seed).
const CFG: PricingConfig = {
  take_rate: 0.15,
  bundle_adjustment: -0.1,
  niche_multipliers: { default: 1.0, lifestyle: 1.0, finance: 4.0, saas: 4.0, b2b: 3.5 },
  usage_rights_uplift: { none: 0.0, organic: 0.0, paid_ads: 0.35, full_buyout: 0.5 },
  exclusivity_uplift: { none: 0.0, '3mo': 0.15, '6mo': 0.3, '12mo': 0.5 },
  er_curve: { expected: { nano: 0.04, micro: 0.03, mid: 0.025, macro: 0.018, mega: 0.012 }, floor: 0.7, ceil: 1.5 },
  cpm_rails: { instagram: [5, 12], tiktok: [2, 8], youtube: [8, 15] },
  guarantee: { threshold: 1000, window_days: 30, split: { platform: 0.5, creator: 0.5 } },
  currency: 'GBP',
}

const MICRO_CREATOR: CreatorProfileInput = {
  primaryPlatform: 'instagram',
  followers: 22_000,
  engagementRate: 0.06, // 6% — above the micro expected 3%
  creatorType: 'content',
  niche: 'lifestyle',
}

// ---- 1. Base-rate lookup (DB reader against the seeded temp DB) ---------------------------------------
test('lookupRate returns the seeded Micro IG Reel band and uses mid as base', () => {
  const r = lookupRate({ tier: 'micro', platform: 'instagram', format: 'reel', currency: 'GBP' })
  assert.equal(r.low, 250)
  assert.equal(r.high, 1200)
  assert.equal(r.mid, 725, 'mid = round((250+1200)/2)')
  assert.equal(r.source, '2026-uk-benchmark')
})

// ---- 2. Each multiplier in isolation -----------------------------------------------------------------
test('nicheMultiplier: finance premium vs lifestyle baseline', () => {
  assert.equal(nicheMultiplier(['finance'], 'lifestyle', CFG), 4.0)
  assert.equal(nicheMultiplier(['lifestyle'], 'lifestyle', CFG), 1.0)
  // picks the highest among brand categories + creator niche
  assert.equal(nicheMultiplier(['lifestyle', 'b2b'], 'lifestyle', CFG), 3.5)
  // unknown category falls back to default
  assert.equal(nicheMultiplier(['unknowncat'], 'unknownniche', CFG), 1.0)
})

test('engagementFactor: high ER lifts and clamps to ceil; low ER drops and clamps to floor', () => {
  // 6% vs expected micro 3% => ratio 2.0, clamped to ceil 1.5
  assert.equal(engagementFactor(0.06, 'micro', CFG), 1.5)
  // 1.5% vs 3% => ratio 0.5, clamped to floor 0.7
  assert.equal(engagementFactor(0.015, 'micro', CFG), 0.7)
  // on-curve => exactly 1.0
  assert.equal(engagementFactor(0.03, 'micro', CFG), 1.0)
})

test('usageUplift and exclusivityUplift read the configured fractions', () => {
  assert.equal(usageUplift('paid_ads', CFG), 0.35)
  assert.equal(usageUplift('none', CFG), 0.0)
  assert.equal(exclusivityUplift('12mo', CFG), 0.5)
  assert.equal(exclusivityUplift(null, CFG), 0.0) // null => 'none'
})

test('bundleAdjustment applies only for multi-deliverable packages', () => {
  assert.equal(bundleAdjustment(1, CFG), 0)
  assert.equal(bundleAdjustment(3, CFG), -0.1)
})

// ---- 3. Take-rate / net / cut ------------------------------------------------------------------------
test('take-rate splits gross into creator_net and platform_cut at 15%', () => {
  // Construct a deliverable mix that grosses exactly £2,500 with a single line (no bundle adjustment):
  //   base £1,250 × niche 1 × engagement 1 (on-curve) × usage 1 × excl 1 = £1,250 unit, count 2 = £2,500.
  // Easiest deterministic route: a single £2,500 line via in_kind_value, on-curve ER, lifestyle niche.
  const creator: CreatorProfileInput = { ...MICRO_CREATOR, engagementRate: 0.03 } // on-curve => factor 1
  const deliverable: Deliverable = {
    type: 'flat', count: 1, platform: 'instagram', format: 'reel',
    usage_rights: 'none', exclusivity: 'none', description: 'flat package',
    in_kind: true, in_kind_value: 2500,
  }
  const res = priceProposal(
    [{ name: 'Standard', deliverables: [deliverable] }],
    creator,
    { categories: ['lifestyle'] },
    { tenantId: 't', cfg: CFG },
  )
  const t = res.tiers[0]
  assert.equal(t.gross_price, 2500)
  assert.equal(t.creator_net, 2125)
  assert.equal(t.platform_cut, 375)
  assert.equal(t.take_rate_applied, 0.15)
  assert.equal(res.take_rate_applied, 0.15)
})

// ---- 4. Negotiated-rate override (incl. throw on invalid) --------------------------------------------
test('takeRateOverride replaces the default and is validated 0 <= r < 1', () => {
  const creator: CreatorProfileInput = { ...MICRO_CREATOR, engagementRate: 0.03 }
  const deliverable: Deliverable = {
    type: 'flat', count: 1, platform: 'instagram', format: 'reel',
    usage_rights: 'none', exclusivity: 'none', description: 'flat', in_kind: true, in_kind_value: 2500,
  }
  const res = priceProposal(
    [{ name: 'Standard', deliverables: [deliverable] }],
    creator,
    { categories: ['lifestyle'] },
    { tenantId: 't', cfg: CFG, takeRateOverride: 0.1 },
  )
  assert.equal(res.tiers[0].creator_net, 2250)
  assert.equal(res.tiers[0].platform_cut, 250)
  assert.equal(res.take_rate_applied, 0.1)

  for (const bad of [1.2, -0.1, 1, NaN]) {
    assert.throws(
      () =>
        priceProposal(
          [{ name: 'Standard', deliverables: [deliverable] }],
          creator,
          { categories: ['lifestyle'] },
          { tenantId: 't', cfg: CFG, takeRateOverride: bad },
        ),
      /invalid take_rate override/,
      `override ${bad} must throw`,
    )
  }
})

// ---- 5. CPM rail trigger (warn-not-ship) -------------------------------------------------------------
test('CPM rail sets a warning out of band but still returns a price', () => {
  // 22K @ 6% => ~1,320 expected impressions. A £2,500 gross => implied CPM ~£1,894, far above IG £5–12.
  const deliverable: Deliverable = {
    type: 'flat', count: 1, platform: 'instagram', format: 'reel',
    usage_rights: 'none', exclusivity: 'none', description: 'flat', in_kind: true, in_kind_value: 2500,
  }
  const res = priceProposal(
    [{ name: 'Standard', deliverables: [deliverable] }],
    MICRO_CREATOR,
    { categories: ['lifestyle'] },
    { tenantId: 't', cfg: CFG },
  )
  const t = res.tiers[0]
  assert.ok(t.gross_price > 0, 'still returns a price')
  assert.equal(t.cpm.inBand, false)
  assert.ok(t.cpmWarning && /CPM/.test(t.cpmWarning), 'cpmWarning is set out of band')

  // An in-band mix => no warning. Need implied CPM within £5–12 => gross between ~£6.6 and ~£15.8 for the
  // ~1,320 impressions. Use a tiny in_kind_value of £10 => implied CPM ~£7.6.
  const cheap: Deliverable = { ...deliverable, in_kind_value: 10 }
  const res2 = priceProposal(
    [{ name: 'Standard', deliverables: [cheap] }],
    MICRO_CREATOR,
    { categories: ['lifestyle'] },
    { tenantId: 't', cfg: CFG },
  )
  assert.equal(res2.tiers[0].cpm.inBand, true)
  assert.equal(res2.tiers[0].cpmWarning, null)
})

// ---- 6. Guarantee threshold --------------------------------------------------------------------------
test('guarantee attaches only at/above the configured threshold', () => {
  const creator: CreatorProfileInput = { ...MICRO_CREATOR, engagementRate: 0.03 }
  const below: Deliverable = {
    type: 'flat', count: 1, platform: 'instagram', format: 'reel',
    usage_rights: 'none', exclusivity: 'none', description: 'flat', in_kind: true, in_kind_value: 999,
  }
  const at: Deliverable = { ...below, in_kind_value: 1000 }

  const r1 = priceProposal([{ name: 'Standard', deliverables: [below] }], creator, { categories: ['lifestyle'] }, { tenantId: 't', cfg: CFG })
  assert.equal(r1.guarantee, null, '£999 headline => no guarantee')

  const r2 = priceProposal([{ name: 'Standard', deliverables: [at] }], creator, { categories: ['lifestyle'] }, { tenantId: 't', cfg: CFG })
  assert.ok(r2.guarantee, '£1,000 headline => guarantee block')
  assert.equal(r2.guarantee!.threshold, 1000)
  assert.equal(r2.guarantee!.state, 'active')
  assert.deepEqual(r2.guarantee!.split, { platform: 0.5, creator: 0.5 })
  assert.ok(r2.guarantee!.window_ends_at > Date.now(), 'window_ends_at is in the future')
})

// ---- 7. Fail-loud readers (never a £0 / 0% cut) ------------------------------------------------------
test('loadPricingConfig throws on a missing config key (never defaults)', () => {
  // Delete a required key from the temp DB and assert the reader throws rather than defaulting.
  db.exec("DELETE FROM pricing_config WHERE key='take_rate'")
  assert.throws(() => loadPricingConfig('no-such-tenant'), /pricing_config missing key: take_rate/)
  // restore so later runs in the same process see it again
  db.prepare("INSERT INTO pricing_config (key, value_json, updated_at) VALUES ('take_rate', '0.15', ?)").run(Date.now())
})

test('lookupRate throws on a missing rate card (never a £0 deliverable)', () => {
  assert.throws(
    () => lookupRate({ tier: 'micro', platform: 'instagram', format: 'nonexistent', currency: 'GBP' }),
    /rate_cards missing row/,
  )
})

test('tierFor implements the spec bands and the combined-reach calibration', () => {
  assert.equal(tierFor({ ...MICRO_CREATOR, followers: 5_000 }, CFG), 'nano')
  assert.equal(tierFor({ ...MICRO_CREATOR, followers: 22_000 }, CFG), 'micro')
  assert.equal(tierFor({ ...MICRO_CREATOR, followers: 79_100 }, CFG), 'mid', '50–250K is a real band')
  assert.equal(tierFor({ ...MICRO_CREATOR, followers: 400_000 }, CFG), 'macro')
  assert.equal(tierFor({ ...MICRO_CREATOR, followers: 2_000_000 }, CFG), 'mega')

  // A combined count without a configured discount factor THROWS (never tier off a vanity aggregate).
  assert.throws(
    () => tierFor({ ...MICRO_CREATOR, followers: 6_000_000, followersAreCombined: true }, CFG),
    /combined_reach_discount/,
  )
  // With a discount factor, the combined count is discounted to a primary-platform equivalent first.
  const withDiscount: PricingConfig = { ...CFG, combined_reach_discount: 0.1 }
  assert.equal(
    tierFor({ ...MICRO_CREATOR, followers: 6_000_000, followersAreCombined: true }, withDiscount),
    'macro',
    '6M combined × 0.1 = 600K => macro, not mega',
  )
})
