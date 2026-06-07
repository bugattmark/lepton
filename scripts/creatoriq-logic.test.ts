// Creator IQ — pure-logic tests (no network). Covers engagement-rate computation (sourcing.ts),
// authority-tier derivation, the inference-input/closed-set builder (asserting it only ever emits
// categoryFacets() names), the sector post-filter, and the row→PitchInput adapter (asserting that
// inferred_audience and unconfirmed source:'caption' deals never leak into a pitch).
//
//   node --test scripts/creatoriq-logic.test.ts
//
// db.ts opens the DB at module load, so set DB_PATH to a throwaway temp file BEFORE importing
// anything that transitively imports db.ts (creatoriq.ts does). See scripts/seed.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DB_PATH = join(tmpdir(), `lepton-creatoriq-test-${process.pid}.db`)

// Dynamic import AFTER setting DB_PATH (static imports hoist and would open the real DB first).
const { computeEngagementRate } = await import('../src/sourcing.ts')
const { authorityTierOf, buildInferenceInput, filterSectors, rowToPitchInput } = await import('../src/creatoriq.ts')

const media = (...pairs: [number, number][]) =>
  pairs.map(([likes, comments], i) => ({
    id: String(i),
    caption: '',
    imageUrl: null,
    isVideo: false,
    likes,
    comments,
    takenAt: null,
  }))

test('computeEngagementRate: empty media → null', () => {
  assert.equal(computeEngagementRate([], 1000), null)
})

test('computeEngagementRate: zero / negative followers → null', () => {
  assert.equal(computeEngagementRate(media([10, 1]), 0), null)
  assert.equal(computeEngagementRate(media([10, 1]), -5), null)
})

test('computeEngagementRate: known case from the bench fixture (so_last_century)', () => {
  // followers 24388; mean(likes+comments) = (93 + 91)/2 = 92; 92/24388 ≈ 0.003772 → 0.0038 (4dp).
  assert.equal(computeEngagementRate(media([90, 3], [88, 3]), 24388), 0.0038)
})

test('computeEngagementRate: clamps absurd input (engagement > followers) to 1', () => {
  assert.equal(computeEngagementRate(media([5000, 5000]), 100), 1)
})

test('computeEngagementRate: rounds to exactly 4 dp', () => {
  // mean = 1; 1/3 = 0.33333… → 0.3333
  assert.equal(computeEngagementRate(media([1, 0], [1, 0], [1, 0]), 3), 0.3333)
})

test('authorityTierOf: boundary table', () => {
  assert.equal(authorityTierOf(100), 'strong')
  assert.equal(authorityTierOf(70), 'strong')
  assert.equal(authorityTierOf(69), 'some')
  assert.equal(authorityTierOf(40), 'some')
  assert.equal(authorityTierOf(39), 'none')
  assert.equal(authorityTierOf(0), 'none')
})

const CLOSED = ['Beauty', 'Activewear', 'Homeware']

test('buildInferenceInput: omits missing signals (no "null" strings) and includes the closed list', () => {
  const out = buildInferenceInput({
    bio: 'fitness coach',
    closedCategories: CLOSED,
    // demographics, captions, engagementRate all absent
  })
  assert.match(out, /fitness coach/)
  assert.doesNotMatch(out, /null/, 'missing signals must be omitted, never serialized as "null"')
  assert.doesNotMatch(out, /demographics/i)
  for (const c of CLOSED) assert.ok(out.includes(c), `closed category ${c} must appear`)
  assert.match(out, /CLOSED CATEGORY LIST/)
})

test('buildInferenceInput: engagement rate framed as a credibility weight, not a sector signal', () => {
  const out = buildInferenceInput({ engagementRate: 0.05, closedCategories: CLOSED })
  assert.match(out, /CREDIBILITY WEIGHT/)
  assert.match(out, /5\.00%/)
})

test('filterSectors: only emits closed-set names; hallucinations move to other_sectors with a drop count', () => {
  const { sectors, otherSectors, dropped } = filterSectors(
    [
      { category: 'Beauty', score: 82, reason: 'a' },
      { category: 'Crypto', score: 90, reason: 'hallucinated — not in catalog' },
      { category: 'Homeware', score: 55, reason: 'b' },
    ],
    CLOSED,
  )
  assert.equal(dropped, 1)
  // every emitted sector category MUST be in the closed set
  for (const s of sectors) assert.ok(CLOSED.includes(s.category), `${s.category} leaked outside the closed set`)
  assert.ok(otherSectors.includes('Crypto'), 'dropped category must land in other_sectors')
  assert.ok(!sectors.some((s) => s.category === 'Crypto'))
})

test('filterSectors: sorts kept sectors by score desc and attaches code-derived authority', () => {
  const { sectors } = filterSectors(
    [
      { category: 'Homeware', score: 41, reason: 'b' },
      { category: 'Beauty', score: 82, reason: 'a' },
    ],
    CLOSED,
  )
  assert.deepEqual(sectors.map((s) => s.category), ['Beauty', 'Homeware'])
  assert.equal(sectors[0].authority, 'strong')
  assert.equal(sectors[1].authority, 'some')
})

// --- row→PitchInput adapter (pure given a row object — no DB) ---
function makeRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    tenant_id: 't1',
    name: 'Ada Creator',
    instagram_handle: 'ada',
    tiktok_handle: null,
    youtube_channel: null,
    website: null,
    bio: null,
    profile_data: null,
    created_at: 0,
    updated_at: 0,
    creator_type: 'content',
    visual_signals: null,
    niche: 'home interiors',
    content_style: 'aspirational reels',
    engagement_rate: 0.04,
    demographics: null,
    demographics_source: 'ig_business',
    sectors: JSON.stringify({
      sectors: [
        { category: 'Homeware', score: 80, authority: 'strong', reason: 'shows interiors' },
        { category: 'Beauty', score: 50, authority: 'some', reason: 'some beauty' },
        { category: 'Activewear', score: 10, authority: 'none', reason: 'rare' },
      ],
      other_sectors: ['Crypto'],
    }),
    inferred_audience: JSON.stringify({
      summary: 'SECRET_INFERRED_3000_FOLLOWERS_BOUGHT_X',
      likely_buyer_sectors: [{ category: 'Beauty', reason: 'skews female' }],
      confidence: 'inferred',
    }),
    past_deals: JSON.stringify([{ brand: 'UNCONFIRMED_CAPTION_BRAND', result: null, source: 'caption' }]),
    signals_used: null,
    summary: 'Ada makes aspirational home-interior reels for a UK audience.',
    status: 'done',
    error: null,
    generated_at: 1,
    ...overrides,
  }
}

test('rowToPitchInput: maps authority≠none sectors → brandCategories sorted by score desc', () => {
  const pi = rowToPitchInput(makeRow(), 'homeware brands')
  assert.deepEqual(pi.brandCategories, ['Homeware', 'Beauty'])
  assert.ok(!pi.brandCategories!.includes('Activewear'), 'authority:none sectors must be excluded')
})

test('rowToPitchInput: maps summary→aboutText and niche/content_style→roles, plus name/pitchTo', () => {
  const pi = rowToPitchInput(makeRow(), 'homeware brands')
  assert.equal(pi.name, 'Ada Creator')
  assert.equal(pi.pitchTo, 'homeware brands')
  assert.equal(pi.aboutText, 'Ada makes aspirational home-interior reels for a UK audience.')
  assert.deepEqual(pi.roles, ['home interiors', 'aspirational reels'])
})

test('rowToPitchInput: inferred_audience text/counts NEVER leak into the PitchInput (hard rule)', () => {
  const pi = rowToPitchInput(makeRow(), 'homeware brands')
  const blob = JSON.stringify(pi)
  assert.doesNotMatch(blob, /SECRET_INFERRED_3000_FOLLOWERS_BOUGHT_X/, 'inferred_audience must never reach a pitch')
  assert.doesNotMatch(blob, /3000/)
})

test('rowToPitchInput: unconfirmed source:caption past deals NEVER leak into the PitchInput', () => {
  const pi = rowToPitchInput(makeRow(), 'homeware brands')
  const blob = JSON.stringify(pi)
  assert.doesNotMatch(blob, /UNCONFIRMED_CAPTION_BRAND/, 'unconfirmed caption deals must never reach a pitch')
})

test('rowToPitchInput: a thin row (only niche) still returns a valid PitchInput with the rest omitted', () => {
  const thin = makeRow({
    name: null,
    content_style: null,
    summary: null,
    sectors: null,
    inferred_audience: null,
    past_deals: null,
    niche: 'fitness',
  })
  const pi = rowToPitchInput(thin)
  assert.deepEqual(pi.roles, ['fitness'])
  assert.equal(pi.name, undefined)
  assert.equal(pi.brandCategories, undefined)
  assert.equal(pi.aboutText, undefined)
})
