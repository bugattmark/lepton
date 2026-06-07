// Foundation seed tests (pure data, no FK setup). Sets DB_PATH to a throwaway temp file BEFORE
// importing db.ts (which opens the DB at module load), so the real volume DB is never touched.
//   node --test scripts/seed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DB_PATH = join(tmpdir(), `lepton-seed-test-${process.pid}.db`)

// Dynamic import AFTER setting DB_PATH (static imports hoist and would open the real DB first).
const { db, seedRateCards, seedPricingConfig } = await import('../src/db.ts')
const { brandCount, categoryFacets } = await import('../src/brands.ts')

test('seedRateCards is idempotent and seeds the spec GBP bands', () => {
  // db.ts already seeded once at import; re-run to prove no duplication.
  seedRateCards()
  const count1 = (db.prepare('SELECT COUNT(*) c FROM rate_cards').get() as { c: number }).c
  seedRateCards()
  const count2 = (db.prepare('SELECT COUNT(*) c FROM rate_cards').get() as { c: number }).c
  assert.equal(count1, count2, 're-running the seed must not duplicate rows')
  assert.equal(count1, 24, 'expect 19 content + 5 event GBP rows')

  const nanoPost = db
    .prepare(
      "SELECT low, mid, high FROM rate_cards WHERE tier='nano' AND platform='instagram' AND format='post' AND currency='GBP'",
    )
    .get() as { low: number; mid: number; high: number }
  assert.equal(nanoPost.low, 50)
  assert.equal(nanoPost.high, 300)
  assert.equal(nanoPost.mid, 175, 'mid = round((low+high)/2)')

  const booth = db
    .prepare("SELECT low, high FROM rate_cards WHERE tier='event' AND platform='event' AND format='booth' AND currency='GBP'")
    .get() as { low: number; high: number }
  assert.equal(booth.low, 300)
  assert.equal(booth.high, 2000)
})

test('seedPricingConfig seeds every default key and round-trips JSON', () => {
  seedPricingConfig()
  const keys = (db.prepare('SELECT key FROM pricing_config').all() as { key: string }[]).map((r) => r.key)
  for (const k of [
    'take_rate', 'bundle_adjustment', 'niche_multipliers', 'usage_rights_uplift',
    'exclusivity_uplift', 'er_curve', 'cpm_rails', 'guarantee', 'usd_fx_from_gbp',
  ]) {
    assert.ok(keys.includes(k), `missing pricing_config key: ${k}`)
  }

  const takeRate = JSON.parse(
    (db.prepare("SELECT value_json FROM pricing_config WHERE key='take_rate'").get() as { value_json: string }).value_json,
  )
  assert.equal(takeRate, 0.15)

  const guarantee = JSON.parse(
    (db.prepare("SELECT value_json FROM pricing_config WHERE key='guarantee'").get() as { value_json: string }).value_json,
  )
  assert.equal(guarantee.threshold, 1000)
})

test('starter brands seed at boot — catalog floor + sector vocabulary', () => {
  // db.ts runs seedStarterBrands() at import (boot), so a fresh DB self-populates.
  assert.ok(brandCount() >= 74, `expected >=74 starter brands, got ${brandCount()}`)
  const facets = categoryFacets().map((c) => c.name)
  for (const cat of ['Fashion', 'Beauty', 'Skincare', 'Fitness', 'Supplements', 'Equestrian']) {
    assert.ok(facets.includes(cat), `sector vocabulary missing ${cat}`)
  }
})
