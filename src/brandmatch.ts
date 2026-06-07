// Stage-2 brand estimation matcher (v1). Given a Creator IQ profile, produce a ranked, reasoned
// shortlist of target brands for THIS creator, scored by sector overlap + audience/geo fit + brand
// size band, seeded warm by the creator's own on-camera / past-deal brands, plus a net-new
// sector-fit pool (sector-fit MINUS brands that obviously already do influencer marketing).
//
// Mirrors qualify.ts end to end: a background runner with an in-flight Set, incremental persist
// after every row, a status-snapshot the FE polls, deterministic tierOf-style scoring, and an LLM
// used ONLY for a one-sentence reason (strict json_schema, reason-only) + a fuzzy sector-reconcile
// at the taxonomy gap. The bulk ranking is deterministic; spend is bounded by POOL_CAP + concurrency.
//
// Needs OPENAI_API_KEY (per-row reason + sector reconcile). HIKER_API_KEY only when the catalog is
// THIN for this creator's sectors and we must snowball net-new brands (< MIN_POOL). Fails LOUD:
// missing OpenAI key, missing creator_profiles row / sectors, and missing creator_brand_matches
// table all throw — never a silent empty shortlist.
//
// WAVE 2 (routes + views — out of this change; clone the qualify block at server.ts ~585-632):
//   GET  /api/match/creators              -> creators that HAVE a creator_profiles row (selector input)
//                                            { ok, creators:[{id,name,handle}], ai: matchAvailable(), hiker: hikerAvailable() }
//   GET  /api/match/:creatorId/status     -> { ok, ...matchStatus() }; 404 if no profile row
//   POST /api/match/:creatorId/run        -> 400 if !matchAvailable(); void runMatch(tid,cid).catch(()=>{}); { ok:true }
//   POST /api/match/:creatorId/select     -> body {brandId, status:'selected'|'rejected'|'suggested'}; { ok }
//   GET  /match (pageAuth)                -> c.html(matchView(emailOf(tid)))
// WAVE 2: tenantId ALWAYS from the session middleware (apiAuth), never client input. Add
//   `import * as match from './brandmatch.ts'` and a `matchView` clone of qualifyingView + a `match`
//   nav entry in shellNav, plus .badge.netnew/.estimate/.comparable styles next to hot/warm/cold.

import { db } from './db.ts'
import { listBrands, upsertBrands, categoryFacets } from './brands.ts'
import { hikerAvailable, enrichHandle, discoverByHashtag } from './sourcing.ts'

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'
const ENDPOINT = 'https://api.openai.com/v1/responses'

export const matchAvailable = () => !!process.env.OPENAI_API_KEY // LLM reason needs it

// ---------------------------------------------------------------------------
// Scoring coefficients — the documented exception to "nothing hardcoded": these are algorithm
// constants (the analog of qualify's tierOf thresholds), exported so tests pin them and a later
// config can override. Geo is folded into f_audience (audience encodes geo) so the weights total 1.
// ---------------------------------------------------------------------------
export const W_SECTOR = 0.5 // sector-overlap Jaccard weight
export const W_AUDIENCE = 0.3 // audience↔customer (geo) fit weight
export const W_SIZE = 0.2 // brand size-band ambition-match weight
export const SEED_BOOST = 15 // flat boost added (post weighted-sum, capped 100) for warm-seed brands
export const NET_NEW_HAIRCUT = 10 // confidence haircut subtracted for net-new (lower-confidence) rows
// Brand size bands (on `brands.followers`) — match ambition to the creator's audience, not maximize.
// bandIndex buckets a value into the count of thresholds it meets: <1k=0, 1-10k=1, 10-100k=2,
// 100k-1M=3, 1-10M=4, 10M+=5. Unknown size -> -1 (treated neutrally by sizeFit).
export const SIZE_BANDS = [1e3, 1e4, 1e5, 1e6, 1e7] as const

const SNOWBALL_DEPTH = 1 // spec OQ#3 default (depth 2 balloons cost)
const MIN_POOL = 25 // below this, snowball to net-new brands (thin catalog)
const POOL_CAP = 200 // cap brands scored per run (bounded spend)

export type Tier = 'hot' | 'warm' | 'cold'
export const tierOf = (s: number): Tier => (s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold') // mirror qualify

export type Move = 'estimate' | 'net_new' // 'comparable' reserved for phase 2  [P2 SEAM]

// Row shape listBrands returns (after JSON parse) — the ranker reads these columns.
export interface BrandRow {
  id: number
  name: string
  logo_url?: string | null
  instagram_handle?: string | null
  instagram_url?: string | null
  followers?: number | null
  website?: string | null
  description?: string | null
  location_city?: string | null
  location_region?: string | null
  location_country?: string | null
  categories?: { main?: string[]; secondary?: string[] } | null
  status?: string | null
}

// Normalized creator signals — the single adapter output. All Creator IQ schema risk is isolated
// in readCreatorProfile; the rest of the module only sees this shape.
export type CreatorSignals = {
  creatorId: number
  sectors: string[] // normalized category names (categoryFacets names)
  audience: { country: string | null; region: string | null; size: number | null }
  seedBrands: string[] // visual_signals.brands ∪ past_deals[].brand (warm seed), lowercased
  creatorType: string[] // read-through for the phase-2 event branch  [P2 SEAM]
}

// A scored+reasoned shortlist row (pre-persist). brand_id references brands.id.
export type MatchRow = {
  brand_id: number
  brand: BrandRow
  score: number
  tier: Tier
  move: Move
  reason: string
  evidence: Record<string, unknown>
}

export type MatchRunState = {
  status: 'idle' | 'running' | 'done' | 'error'
  scanned: number
  total: number
  errors: number
  lastRun: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Pure scoring helpers (all unit-tested in scripts/brandmatch-logic.test.ts)
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase()

// Jaccard overlap of two tag sets, case-insensitive, after de-duping. 0 when either set is empty.
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a.map(norm).filter(Boolean))
  const B = new Set(b.map(norm).filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

// Bucket a follower/audience count into a size band 0..SIZE_BANDS.length. Unknown (null/NaN) -> -1.
export function bandIndex(n: number | null): number {
  if (n == null || !Number.isFinite(n)) return -1
  let i = 0
  for (const edge of SIZE_BANDS) if (n >= edge) i++
  return i
}

// Brand size-band ambition match: 1.0 same band, decaying linearly to 0 at >=3 bands apart.
// Either side unknown -> 0.5 neutral (qualify rule: missing = lower, not fabricated; never 0).
export function sizeFit(creatorSize: number | null, brandFollowers: number | null): number {
  const cb = bandIndex(creatorSize)
  const bb = bandIndex(brandFollowers)
  if (cb < 0 || bb < 0) return 0.5
  return 1 - Math.min(Math.abs(cb - bb), 3) / 3
}

// Audience↔customer geo fit. 1.0 same country; 0.0 both known but different; 0.5 when either side
// unknown (unknown ≠ penalty-to-zero). Same region (when both known) is a tie-break toward 1.0.
export function geoFit(
  audCountry: string | null,
  brandCountry: string | null,
  audRegion: string | null = null,
  brandRegion: string | null = null,
): number {
  const ac = audCountry ? norm(audCountry) : null
  const bc = brandCountry ? norm(brandCountry) : null
  if (ac && bc) {
    if (ac !== bc) return 0
    const ar = audRegion ? norm(audRegion) : null
    const br = brandRegion ? norm(brandRegion) : null
    // same country; region agreement keeps it at 1, region disagreement is a mild nudge down.
    if (ar && br && ar !== br) return 0.75
    return 1
  }
  // exactly one (or neither) side known
  return 0.5
}

// Is a brand in the creator's warm seed set (own on-camera / past-deal brands)? Matches on name or
// instagram_handle (both lowercased, '@' stripped) against the seed set.
function isSeed(brand: BrandRow, seed: Set<string>): boolean {
  if (seed.size === 0) return false
  const name = brand.name ? norm(brand.name) : ''
  const handle = brand.instagram_handle ? norm(brand.instagram_handle).replace(/^@/, '') : ''
  return (!!name && seed.has(name)) || (!!handle && seed.has(handle))
}

// Deterministic score for one brand against the creator. Geo is encoded inside f_audience so the
// weights total cleanly; warm-seed brands get a flat SEED_BOOST after the weighted sum (capped 100).
export function scoreBrand(
  signals: CreatorSignals,
  brand: BrandRow,
): { score: number; tier: Tier; features: Record<string, number>; seed: boolean } {
  const brandCats = [...(brand.categories?.main ?? []), ...(brand.categories?.secondary ?? [])]
  const fSector = jaccard(signals.sectors, brandCats)
  const fAudience = geoFit(
    signals.audience.country,
    brand.location_country ?? null,
    signals.audience.region,
    brand.location_region ?? null,
  )
  const fSize = sizeFit(signals.audience.size, brand.followers ?? null)

  // P2: + W_COMP * f_comparable (lookalike deal-graph affinity) — same weighted-sum, no restructure. [P2 SEAM]
  const base = 100 * (W_SECTOR * fSector + W_AUDIENCE * fAudience + W_SIZE * fSize)

  const seedSet = new Set(signals.seedBrands.map(norm))
  const seed = isSeed(brand, seedSet)
  const score = Math.max(0, Math.min(100, Math.round(base) + (seed ? SEED_BOOST : 0)))
  return { score, tier: tierOf(score), features: { fSector, fAudience, fSize }, seed }
}

// Light v1 absence-of-influencer-marketing heuristic. true => the brand obviously ALREADY does
// influencer marketing (so it is NOT net-new). Cheap local signals only, no new API calls.
// P2: replace this body with `NOT IN (SELECT brand_id FROM creator_brand_deals)` — same signature. [P2 SEAM]
export function isLikelyAlreadyMarketing(brand: BrandRow): boolean {
  if (brand.status === 'contacted' || brand.status === 'enriched') return true // we/others already engaged
  const top = SIZE_BANDS[SIZE_BANDS.length - 1] // ~10M+ band edge: big brands run influencer programs
  if (brand.followers != null && brand.followers >= top) return true
  const hay = `${brand.description ?? ''} ${(brand.categories?.main ?? []).join(' ')} ${(
    brand.categories?.secondary ?? []
  ).join(' ')}`.toLowerCase()
  const markers = ['ambassador', 'creator program', '#ad', 'affiliate', 'ugc', 'influencer']
  return markers.some((m) => new RegExp(`(^|[^a-z0-9])${escapeRe(m)}([^a-z0-9]|$)`).test(hay))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Net-new = sector-fit pool MINUS brands that obviously already do influencer marketing.
export function netNewSet(pool: BrandRow[]): BrandRow[] {
  return pool.filter((b) => !isLikelyAlreadyMarketing(b))
}

// ---------------------------------------------------------------------------
// Creator IQ adapter — isolates schema risk. Throws a clear error if no profile / no sectors.
// ---------------------------------------------------------------------------

const parseJson = (s: unknown): any => {
  if (typeof s !== 'string' || !s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// sectors column is JSON [{category,score,reason}] (Creator IQ shape) OR a plain string[] — accept both.
function readSectors(raw: unknown): string[] {
  const v = parseJson(raw)
  if (!Array.isArray(v)) return []
  const names = v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.category ?? x.name : null))
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return [...new Set(names.map((s) => s.trim()))]
}

export function readCreatorProfile(tenantId: string, creatorId: number): CreatorSignals {
  const row = db
    .prepare('SELECT * FROM creator_profiles WHERE id = ? AND tenant_id = ?')
    .get(creatorId, tenantId) as any
  if (!row) {
    throw new Error(`profile not generated yet: no creator_profiles row for creator ${creatorId}`)
  }
  const sectors = readSectors(row.sectors)
  if (sectors.length === 0) {
    throw new Error('creator profile incomplete: no sectors — generate the Creator IQ profile first')
  }

  // demographics: JSON {age,gender,country,city}; inferred_audience may carry a size/geo estimate.
  const demo = parseJson(row.demographics) ?? {}
  const inferred = parseJson(row.inferred_audience) ?? {}
  const audGeo = inferred.geo ?? demo.geo ?? {}
  const country = audGeo.country ?? demo.country ?? null
  const region = audGeo.region ?? demo.region ?? demo.city ?? null
  // audience size: prefer an explicit estimate; fall back to null (unknown lowers score, never fabricated).
  const size = Number.isFinite(Number(inferred.size ?? demo.size))
    ? Number(inferred.size ?? demo.size)
    : null

  // warm seed: visual_signals.brands ∪ past_deals[].brand, lowercased, '@'-stripped.
  const visual = parseJson(row.visual_signals) ?? {}
  const past = parseJson(row.past_deals)
  const seedRaw: string[] = []
  for (const b of Array.isArray(visual.brands) ? visual.brands : []) if (typeof b === 'string') seedRaw.push(b)
  for (const d of Array.isArray(past) ? past : []) {
    const b = typeof d === 'string' ? d : d && typeof d === 'object' ? d.brand ?? d.handle : null
    if (typeof b === 'string') seedRaw.push(b)
  }
  const seedBrands = [...new Set(seedRaw.map((s) => norm(s).replace(/^@/, '')).filter(Boolean))]

  // creator_type read-through for the P2 event branch (we do NOT branch on it in v1).  [P2 SEAM]
  const ctRaw = row.creator_type
  const creatorType =
    typeof ctRaw === 'string' && ctRaw ? (ctRaw === 'both' ? ['content', 'events'] : [ctRaw]) : []

  return { creatorId, sectors, audience: { country, region, size }, seedBrands, creatorType }
}

// ---------------------------------------------------------------------------
// Candidate pool — sector-fit from the catalog, reusing the brands.ts token-match idiom.
// ---------------------------------------------------------------------------

function sectorFitPool(sectors: string[]): { pool: BrandRow[]; emptySectors: string[] } {
  const seen = new Map<number, BrandRow>()
  const emptySectors: string[] = []
  for (const sector of sectors) {
    // listBrands already applies `categories LIKE '%"sector"%'` and parses the JSON for us.
    const { brands } = listBrands({ category: sector, limit: 200 })
    if (brands.length === 0) emptySectors.push(sector)
    for (const b of brands) seen.set(Number(b.id), b as unknown as BrandRow)
  }
  return { pool: [...seen.values()].slice(0, POOL_CAP), emptySectors }
}

// ---------------------------------------------------------------------------
// LLM helpers (clone qualify's mechanism: Responses API, strict json_schema, low reasoning effort).
// ---------------------------------------------------------------------------

function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text
  let txt = ''
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') for (const c of item?.content ?? []) if (c?.text) txt += c.text
  }
  return txt
}

async function callResponses(input: string, schema: object, schemaName: string): Promise<any> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set on the server')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: 'low' },
      input,
      text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return JSON.parse(extractText(data) || '{}')
}

// reason-only schema — score is deterministic and kept OUT of the schema so the model can't disagree.
const REASON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', description: 'one concise sentence justifying the fit, citing only provided data' },
  },
  required: ['reason'],
}

// One-sentence grounded reason for a single brand. Throws on LLM failure (caller records the
// per-row error into evidence.reasonError and keeps the deterministic score — never drops the brand).
async function reasonFor(
  signals: CreatorSignals,
  brand: BrandRow,
  feat: Record<string, number>,
  seed: boolean,
  move: Move,
): Promise<string> {
  const dossier = JSON.stringify({
    creator_sectors: signals.sectors,
    creator_audience: signals.audience,
    brand: {
      name: brand.name,
      categories: brand.categories,
      followers: brand.followers ?? null,
      country: brand.location_country ?? null,
      region: brand.location_region ?? null,
      description: brand.description ?? null,
    },
    computed_features: feat,
    warm_seed: seed,
    move,
  })
  const input =
    `You are a brand-partnership analyst. In ONE sentence, justify why this brand is (or isn't) a ` +
    `good outreach target for this creator. Cite only the provided data; do not invent facts.\n` +
    (seed ? `Note: the creator already works with / shows this brand (warm seed).\n` : '') +
    (move === 'net_new'
      ? `Note: this is a net-new target with no obvious public influencer-marketing footprint (light v1 signal) — lower confidence.\n`
      : '') +
    `\nDATA (JSON — the ONLY facts you may use):\n${dossier}`
  const parsed = await callResponses(input, REASON_SCHEMA, 'brand_match_reason')
  return String(parsed.reason ?? '').slice(0, 240)
}

const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sector: { type: 'string' },
          matches: { type: 'array', items: { type: 'string' } },
        },
        required: ['sector', 'matches'],
      },
    },
  },
  required: ['mappings'],
}

// Fuzzy sector-reconcile: map each unmatched creator sector → nearest existing category names.
// Only invoked for sectors whose catalog query returned zero brands. Throws on LLM failure
// (caller records evidence.reconcileError and proceeds with the exact-match pool — no fabrication).
async function reconcileSectors(sectors: string[], known: string[]): Promise<Record<string, string[]>> {
  const input =
    `Map each creator SECTOR to the closest matching names from the KNOWN brand-category list. ` +
    `Only return names that appear verbatim in KNOWN. If nothing fits, return an empty array for that sector.\n\n` +
    `SECTORS: ${JSON.stringify(sectors)}\n` +
    `KNOWN: ${JSON.stringify(known)}`
  const parsed = await callResponses(input, RECONCILE_SCHEMA, 'sector_reconcile')
  const out: Record<string, string[]> = {}
  const knownSet = new Set(known.map(norm))
  for (const m of Array.isArray(parsed.mappings) ? parsed.mappings : []) {
    const sector = String(m?.sector ?? '')
    const matches = (Array.isArray(m?.matches) ? m.matches : [])
      .filter((x: unknown): x is string => typeof x === 'string' && knownSet.has(norm(x)))
    if (sector) out[sector] = matches
  }
  return out
}

// ---------------------------------------------------------------------------
// Net-new snowball — only when the catalog pool is thin (< MIN_POOL). Writes discovered brands
// through upsertBrands (single write path), then re-reads the sector-fit pool to pick them up.
// ---------------------------------------------------------------------------

// Per BRANDS.md ("filter the thin objects FIRST — drop private / non-business / out of follower
// band"): isBusiness alone is far too permissive — IG flags creators, public figures, and media
// (e.g. 'ABC News') as 'business' accounts, so they leak into the catalog as fake brands. A real
// brand is a business account, in a sane follower band, with a website, and NOT a person/media category.
const MIN_BRAND_FOLLOWERS = 2_000
const NON_BRAND_CATEGORIES = new Set([
  'digital creator', 'public figure', 'blogger', 'content creator', 'personal blog', 'just for fun',
  'author', 'artist', 'musician/band', 'musician', 'video creator', 'athlete', 'influencer', 'creator',
  'journalist', 'media/news company', 'news & media website', 'entrepreneur', 'gamer', 'comedian',
  'actor', 'model', 'photographer', 'coach', 'personal trainer',
])
type EnrichLike = {
  isBusiness?: boolean | null
  followers?: number | null
  externalUrl?: string | null
  category?: string | null
} | null | undefined
function looksLikeBrand(e: EnrichLike): boolean {
  if (!e) return false
  if (!e.isBusiness) return false
  if ((e.followers ?? 0) < MIN_BRAND_FOLLOWERS) return false
  if (!e.externalUrl) return false // a brand sells something -> almost always has a website
  const cat = (e.category ?? '').trim().toLowerCase()
  if (cat && NON_BRAND_CATEGORIES.has(cat)) return false // clearly a person / media account, not a brand
  return true
}

async function snowballNetNew(tenantId: string, signals: CreatorSignals): Promise<void> {
  if (!hikerAvailable()) {
    throw new Error('HIKER_API_KEY not set — cannot expand a thin catalog for this creator’s sectors')
  }
  const seenHandles = new Set<string>()
  // depth 1: sector terms → hashtag explore seeds → enrich → upsert as brands.  [P2 SEAM: deeper mining]
  for (let depth = 0; depth < SNOWBALL_DEPTH; depth++) {
    for (const sector of signals.sectors) {
      const tag = sector.replace(/[^a-z0-9]/gi, '')
      if (!tag) continue
      const handles = await discoverByHashtag(tag, 30)
      const found: import('./brands.ts').BrandInput[] = []
      for (const h of handles) {
        if (seenHandles.has(h)) continue
        seenHandles.add(h)
        const e = await enrichHandle(h)
        if (!e || !looksLikeBrand(e)) continue // BRANDS.md gate: drop private/non-business/out-of-band/personal/media
        found.push({
          name: e.fullName || e.username,
          instagramHandle: e.username,
          followers: e.followers,
          website: e.externalUrl,
          description: e.bio,
          categories: { main: [sector], secondary: [] },
          source: 'hiker',
          sourceRef: e.username,
        })
      }
      if (found.length) upsertBrands(tenantId, found)
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — deterministic ranking + per-row reason. No persistence (the runner persists).
// PHASE 2: the comparable-deal engine plugs in here with the SAME signature — it adds a
// `comparableAffinity` feature term to scoreBrand's weighted sum and a `move:'comparable'` label,
// fed by src/deals.ts + the creator_brand_deals table. No restructure of rankBrands required.
// ---------------------------------------------------------------------------

export async function rankBrands(
  tenantId: string,
  signals: CreatorSignals,
  opts: { concurrency?: number; onRow?: (row: MatchRow) => void; runState?: MatchRunState } = {},
): Promise<MatchRow[]> {
  const concurrency = opts.concurrency ?? 6
  const evidenceRun: Record<string, unknown> = {}

  // 1) sector-fit pool from the catalog.
  let { pool, emptySectors } = sectorFitPool(signals.sectors)

  // 1b) fuzzy sector-reconcile for sectors that returned zero brands → re-query with mapped names.
  if (emptySectors.length) {
    try {
      const known = categoryFacets().map((f) => f.name)
      const mapped = await reconcileSectors(emptySectors, known)
      const extraSectors = [...new Set(Object.values(mapped).flat())]
      if (extraSectors.length) {
        const merged = new Map(pool.map((b) => [b.id, b]))
        for (const b of sectorFitPool(extraSectors).pool) merged.set(b.id, b)
        pool = [...merged.values()].slice(0, POOL_CAP)
      }
    } catch (e) {
      evidenceRun.reconcileError = (e as Error).message // recorded, proceed with exact-match pool
    }
  }

  // 2) thin catalog → snowball net-new brands, then re-read the pool. Throws if no HIKER key.
  if (pool.length < MIN_POOL) {
    await snowballNetNew(tenantId, signals)
    pool = sectorFitPool(signals.sectors).pool
  }

  if (opts.runState) opts.runState.total = pool.length

  // 3) net-new label: sector-fit MINUS already-marketing brands.
  const netNew = new Set(netNewSet(pool).map((b) => b.id))

  // 4) score + reason each brand (concurrency-capped, like qualify).
  const rows: MatchRow[] = new Array(pool.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= pool.length) return
      const brand = pool[i]
      const { score: baseScore, tier: _t, features, seed } = scoreBrand(signals, brand)
      const isNet = netNew.has(brand.id)
      const move: Move = isNet ? 'net_new' : 'estimate'
      const score = Math.max(0, Math.min(100, baseScore - (isNet ? NET_NEW_HAIRCUT : 0)))
      const tier = tierOf(score)
      const evidence: Record<string, unknown> = { features, seed, netNew: isNet }
      let reason = ''
      try {
        reason = await reasonFor(signals, brand, features, seed, move)
      } catch (e) {
        evidence.reasonError = (e as Error).message // keep the deterministic row; surface the error
        if (opts.runState) opts.runState.errors++
        reason = isNet
          ? 'no obvious public influencer-marketing footprint (light v1 signal); reason generation failed'
          : 'sector/audience fit (reason generation failed)'
      }
      const row: MatchRow = { brand_id: brand.id, brand, score, tier, move, reason, evidence }
      rows[i] = row
      opts.onRow?.(row)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pool.length) || 1 }, worker))

  const out = rows.filter(Boolean)
  if (Object.keys(evidenceRun).length && out[0]) {
    out[0].evidence = { ...out[0].evidence, run: evidenceRun }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// ---------------------------------------------------------------------------
// Persistence — incremental, mirrors qualify's per-row write. brand_id always references brands.id.
// ---------------------------------------------------------------------------

// NOTE: the foundation creator_brand_matches table carries no UNIQUE(tenant_id, creator_id, brand_id)
// constraint, so we cannot use ON CONFLICT. We emulate the upsert with a check-then-write inside a
// transaction: an existing row's score/tier/move/reason/evidence are refreshed, but a user's
// 'selected'/'rejected' status is PRESERVED (only score/reason/evidence refresh on re-run).
const findMatch = db.prepare(
  'SELECT id FROM creator_brand_matches WHERE tenant_id = ? AND creator_id = ? AND brand_id = ?',
)
const updateMatch = db.prepare(`
  UPDATE creator_brand_matches
     SET score = @score, tier = @tier, move = @move, reason = @reason, evidence = @evidence, updated_at = @now
   WHERE id = @id
`)
const insertMatch = db.prepare(`
  INSERT INTO creator_brand_matches
    (tenant_id, creator_id, brand_id, score, tier, move, reason, evidence, status, created_at, updated_at)
  VALUES (@tenant_id, @creator_id, @brand_id, @score, @tier, @move, @reason, @evidence, 'suggested', @now, @now)
`)

function upsertMatchRow(tenantId: string, creatorId: number, row: MatchRow): void {
  const args = {
    tenant_id: tenantId,
    creator_id: creatorId,
    brand_id: row.brand_id,
    score: row.score,
    tier: row.tier,
    move: row.move,
    reason: row.reason,
    evidence: JSON.stringify(row.evidence),
    now: Date.now(),
  }
  db.exec('BEGIN')
  try {
    const existing = findMatch.get(tenantId, creatorId, row.brand_id) as { id: number } | undefined
    if (existing) updateMatch.run({ ...args, id: existing.id }) // status preserved
    else insertMatch.run(args)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`persist match (creator ${creatorId}, brand ${row.brand_id}) failed: ${(e as Error).message}`, {
      cause: e,
    })
  }
}

// ---------------------------------------------------------------------------
// Background runner — mirrors runQualify (in-flight Set, run-state Map, incremental persist).
// Run-state is in-memory (single-instance per CLAUDE.md); rows persist durably.
// ---------------------------------------------------------------------------

const running = new Set<string>()
const RUNS = new Map<string, MatchRunState>()
const keyOf = (tenantId: string, creatorId: number) => `${tenantId}:${creatorId}`

export const isMatching = (tenantId: string, creatorId: number) => running.has(keyOf(tenantId, creatorId))

function guardTable(): void {
  const ok = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_brand_matches'")
    .get()
  if (!ok) throw new Error('creator_brand_matches table not found — run the foundation migration')
}

export async function runMatch(tenantId: string, creatorId: number, concurrency = 6): Promise<void> {
  const k = keyOf(tenantId, creatorId)
  if (running.has(k)) return
  guardTable() // fail loud if the foundation table is missing
  if (!matchAvailable()) throw new Error('OPENAI_API_KEY not set on the server')

  running.add(k)
  const state: MatchRunState = { status: 'running', scanned: 0, total: 0, errors: 0, lastRun: null, error: null }
  RUNS.set(k, state)
  try {
    const signals = readCreatorProfile(tenantId, creatorId) // throws 'profile not generated yet'
    await rankBrands(tenantId, signals, {
      concurrency,
      runState: state,
      onRow: (row) => {
        upsertMatchRow(tenantId, creatorId, row) // incremental → live shortlist
        state.scanned++
      },
    })
    state.status = 'done'
    state.lastRun = Date.now()
  } catch (err) {
    state.status = 'error'
    state.error = (err as Error).message
    throw err
  } finally {
    running.delete(k)
  }
}

// ---------------------------------------------------------------------------
// Status snapshot + select/reject — for the (Wave 2) poll route.
// ---------------------------------------------------------------------------

export type ShortlistRow = {
  brand_id: number
  name: string | null
  logo_url: string | null
  instagram_handle: string | null
  followers: number | null
  location_country: string | null
  score: number | null
  tier: Tier | null
  move: Move | null
  reason: string | null
  status: string
}

export function matchStatus(tenantId: string, creatorId: number) {
  guardTable()
  const k = keyOf(tenantId, creatorId)
  const state = RUNS.get(k)
  const rows = db
    .prepare(
      `SELECT m.brand_id, m.score, m.tier, m.move, m.reason, m.status,
              b.name, b.logo_url, b.instagram_handle, b.followers, b.location_country
       FROM creator_brand_matches m
       JOIN brands b ON b.id = m.brand_id
       WHERE m.tenant_id = ? AND m.creator_id = ?
       ORDER BY m.score DESC, b.name ASC`,
    )
    .all(tenantId, creatorId) as any[]
  const shortlist: ShortlistRow[] = rows.map((r) => ({
    brand_id: Number(r.brand_id),
    name: r.name ?? null,
    logo_url: r.logo_url ?? null,
    instagram_handle: r.instagram_handle ?? null,
    followers: r.followers != null ? Number(r.followers) : null,
    location_country: r.location_country ?? null,
    score: r.score != null ? Number(r.score) : null,
    tier: (r.tier as Tier) ?? null,
    move: (r.move as Move) ?? null,
    reason: r.reason ?? null,
    status: r.status ?? 'suggested',
  }))
  const counts = { hot: 0, warm: 0, cold: 0, estimate: 0, net_new: 0 }
  for (const r of shortlist) {
    if (r.tier && r.tier in counts) (counts as any)[r.tier]++
    if (r.move && r.move in counts) (counts as any)[r.move]++
  }
  return {
    status: running.has(k) ? 'running' : state?.status ?? 'idle',
    scanned: state?.scanned ?? shortlist.length,
    total: state?.total ?? shortlist.length,
    errors: state?.errors ?? 0,
    error: state?.error ?? null,
    lastRun: state?.lastRun ?? null,
    counts,
    rows: shortlist,
  }
}

// Mark a shortlist row selected/rejected (user action). Does not touch score/reason. Returns false
// when the row doesn't exist for this tenant/creator.
export function setMatchStatus(
  tenantId: string,
  creatorId: number,
  brandId: number,
  status: 'selected' | 'rejected' | 'suggested',
): boolean {
  guardTable()
  const res = db
    .prepare(
      `UPDATE creator_brand_matches SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND creator_id = ? AND brand_id = ?`,
    )
    .run(status, Date.now(), tenantId, creatorId, brandId)
  return res.changes > 0
}

// Creators that HAVE a profile row (the selectable input for the match page).
export function matchableCreators(tenantId: string): { id: number; name: string; handle: string | null }[] {
  const rows = db
    .prepare(
      `SELECT id, name, instagram_handle FROM creator_profiles
       WHERE tenant_id = ? AND sectors IS NOT NULL
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(tenantId) as any[]
  return rows.map((r) => ({ id: Number(r.id), name: r.name, handle: r.instagram_handle ?? null }))
}
