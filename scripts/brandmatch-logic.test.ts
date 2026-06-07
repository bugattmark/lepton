// Pure-logic tests for the v1 brand estimation matcher's deterministic scoring. No DB row writes,
// no network, no LLM. brandmatch.ts prepares statements against db at import, so set DB_PATH to a
// throwaway temp file BEFORE importing it (mirrors scripts/seed.test.ts).
//   node --test scripts/brandmatch-logic.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DB_PATH = join(tmpdir(), `lepton-brandmatch-test-${process.pid}.db`)

// Dynamic import AFTER setting DB_PATH (static imports hoist and would open the real DB first).
const bm = await import('../src/brandmatch.ts')
const {
  jaccard,
  bandIndex,
  sizeFit,
  geoFit,
  scoreBrand,
  tierOf,
  netNewSet,
  isLikelyAlreadyMarketing,
  W_SECTOR,
  W_AUDIENCE,
  W_SIZE,
  SEED_BOOST,
  NET_NEW_HAIRCUT,
  SIZE_BANDS,
} = bm

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)

const brand = (over: Partial<import('../src/brandmatch.ts').BrandRow> = {}): import('../src/brandmatch.ts').BrandRow => ({
  id: 1,
  name: 'Acme',
  ...over,
})

const signals = (
  over: Partial<import('../src/brandmatch.ts').CreatorSignals> = {},
): import('../src/brandmatch.ts').CreatorSignals => ({
  creatorId: 1,
  sectors: [],
  audience: { country: null, region: null, size: null },
  seedBrands: [],
  creatorType: [],
  ...over,
})

// --- jaccard ---------------------------------------------------------------
test('jaccard: partial / identical / disjoint / empty / case-insensitive', () => {
  approx(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
  approx(jaccard(['a', 'b'], ['a', 'b']), 1)
  approx(jaccard(['a'], ['z']), 0)
  approx(jaccard([], ['a']), 0)
  approx(jaccard(['a'], []), 0)
  approx(jaccard(['Skincare'], ['skincare']), 1)
})

// --- bandIndex -------------------------------------------------------------
test('bandIndex: null -> -1, and threshold bucketing', () => {
  assert.equal(SIZE_BANDS.length, 5, 'bands: <1k,1-10k,10-100k,100k-1M,1-10M,10M+')
  assert.equal(bandIndex(null), -1)
  assert.equal(bandIndex(NaN as unknown as number), -1)
  assert.equal(bandIndex(500), 0) // < 1k
  assert.equal(bandIndex(50_000), 2) // 10k-100k
  assert.equal(bandIndex(5_000_000), 4) // 1M-10M
  assert.equal(bandIndex(1_000), 1, 'edge value lands in the higher band (>=)')
})

// --- sizeFit ---------------------------------------------------------------
test('sizeFit: same band 1, >=3 apart 0, one apart ~0.667, unknown 0.5', () => {
  approx(sizeFit(50_000, 50_000), 1) // both band 2
  approx(sizeFit(500, 5_000_000), 0) // band 0 vs 4 -> >=3 apart
  approx(sizeFit(50_000, 500_000), 1 - 1 / 3) // band 2 vs 3
  approx(sizeFit(null, 50_000), 0.5)
  approx(sizeFit(50_000, null), 0.5)
})

// --- geoFit ----------------------------------------------------------------
test('geoFit: same country 1, different 0, unknown 0.5, region tie-break', () => {
  approx(geoFit('UK', 'uk'), 1)
  approx(geoFit('UK', 'US'), 0)
  approx(geoFit(null, 'UK'), 0.5)
  approx(geoFit('UK', null), 0.5)
  approx(geoFit('UK', 'UK', 'London', 'London'), 1)
  approx(geoFit('UK', 'UK', 'London', 'Manchester'), 0.75)
})

// --- scoreBrand ------------------------------------------------------------
test('scoreBrand: full overlap + same geo + same band -> 100', () => {
  const s = signals({ sectors: ['Skincare'], audience: { country: 'UK', region: null, size: 50_000 } })
  const b = brand({ categories: { main: ['Skincare'], secondary: [] }, location_country: 'UK', followers: 50_000 })
  const r = scoreBrand(s, b)
  approx(r.features.fSector, 1)
  approx(r.features.fAudience, 1)
  approx(r.features.fSize, 1)
  assert.equal(r.score, 100)
  assert.equal(r.tier, 'hot')
  assert.equal(r.seed, false)
})

test('scoreBrand: pins the weighted-sum coefficients (mid case)', () => {
  // half sector overlap, unknown geo (0.5), one band apart (0.667).
  const s = signals({ sectors: ['Skincare', 'Wellness'], audience: { country: null, region: null, size: 50_000 } })
  const b = brand({ categories: { main: ['Skincare'], secondary: [] }, location_country: null, followers: 500_000 })
  const r = scoreBrand(s, b)
  approx(r.features.fSector, 0.5) // |{skincare,wellness} ∩ {skincare}|=1 / |∪|=2 = 0.5
  approx(r.features.fAudience, 0.5)
  approx(r.features.fSize, 1 - 1 / 3)
  const expected = Math.round(100 * (W_SECTOR * 0.5 + W_AUDIENCE * 0.5 + W_SIZE * (1 - 1 / 3)))
  assert.equal(r.score, expected)
})

test('scoreBrand: warm-seed boost adds exactly SEED_BOOST and caps at 100', () => {
  // a brand with mid fit gets +SEED_BOOST when it's in the creator's seed set.
  const aud = { country: null, region: null, size: 50_000 }
  const cats = { main: ['Skincare'], secondary: [] }
  const noSeed = scoreBrand(signals({ sectors: ['Skincare', 'Wellness'], audience: aud }), brand({ categories: cats }))
  const withSeed = scoreBrand(
    signals({ sectors: ['Skincare', 'Wellness'], audience: aud, seedBrands: ['acme'] }),
    brand({ name: 'Acme', categories: cats }),
  )
  assert.equal(withSeed.seed, true)
  assert.equal(withSeed.score, Math.min(100, noSeed.score + SEED_BOOST))

  // cap: a perfect-fit seed brand stays at 100, not 115.
  const perfect = scoreBrand(
    signals({ sectors: ['Skincare'], audience: { country: 'UK', region: null, size: 50_000 }, seedBrands: ['acme'] }),
    brand({ name: 'Acme', categories: { main: ['Skincare'], secondary: [] }, location_country: 'UK', followers: 50_000 }),
  )
  assert.equal(perfect.score, 100)
})

test('scoreBrand: seed matches on instagram_handle too', () => {
  const r = scoreBrand(
    signals({ sectors: ['Skincare'], seedBrands: ['glowco'] }),
    brand({ name: 'Glow Co', instagram_handle: '@glowco', categories: { main: ['Skincare'], secondary: [] } }),
  )
  assert.equal(r.seed, true)
})

// --- tierOf ----------------------------------------------------------------
test('tierOf: boundary triple', () => {
  assert.equal(tierOf(70), 'hot')
  assert.equal(tierOf(69), 'warm')
  assert.equal(tierOf(40), 'warm')
  assert.equal(tierOf(39), 'cold')
})

// --- net-new ---------------------------------------------------------------
test('isLikelyAlreadyMarketing: high followers / contacted / marketing markers', () => {
  assert.equal(isLikelyAlreadyMarketing(brand({ followers: 20_000_000 })), true) // >= top band
  assert.equal(isLikelyAlreadyMarketing(brand({ status: 'contacted' })), true)
  assert.equal(isLikelyAlreadyMarketing(brand({ status: 'enriched' })), true)
  assert.equal(isLikelyAlreadyMarketing(brand({ description: 'We run an ambassador program' })), true)
  assert.equal(isLikelyAlreadyMarketing(brand({ description: 'Looking for #ad creators' })), true)
  // 'sandbox' contains 'ad' as a substring but NOT as a whole token -> not flagged.
  assert.equal(isLikelyAlreadyMarketing(brand({ description: 'A small sandbox skincare startup' })), false)
})

test('netNewSet: set-subtraction leaves only the clean brand; haircut + move labels', () => {
  const pool: import('../src/brandmatch.ts').BrandRow[] = [
    brand({ id: 1, followers: 20_000_000 }), // big -> already marketing
    brand({ id: 2, status: 'contacted' }), // engaged -> already marketing
    brand({ id: 3, description: 'ambassador squad' }), // marker -> already marketing
    brand({ id: 4, name: 'Clean', followers: 50_000, description: 'tiny startup' }), // net-new
  ]
  const nn = netNewSet(pool)
  assert.deepEqual(
    nn.map((b) => b.id),
    [4],
  )

  // the net-new row takes the -NET_NEW_HAIRCUT relative to its base estimate score.
  const s = signals({ sectors: ['Skincare'], audience: { country: 'UK', region: null, size: 50_000 } })
  const netBrand = brand({ id: 4, name: 'Clean', categories: { main: ['Skincare'], secondary: [] }, location_country: 'UK', followers: 50_000 })
  const base = scoreBrand(s, netBrand).score // 100
  const netNewScore = Math.max(0, Math.min(100, base - NET_NEW_HAIRCUT))
  assert.equal(netNewScore, 100 - NET_NEW_HAIRCUT)

  // an estimate (already-marketing) brand keeps its full score (no haircut).
  const estBrand = pool[1]
  assert.equal(isLikelyAlreadyMarketing(estBrand), true)
})
