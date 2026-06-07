// Creator IQ (stage 1) — the engine that builds ONE structured creator_profiles row per tenant.
//
// Given a creator (the tenant themselves, via their own Instagram), it answers: what do they
// create, who is their audience, and — therefore — which sectors do they have authority in? That
// sector vector (scored against the LIVE brand-category vocabulary, categoryFacets()) is the single
// source of truth stage 2 (brand matching) and stage 3 (priced proposals) both read.
//
// Architecture mirrors qualify.ts's enrich-then-classify, pointed at one creator instead of a list:
//   Tier 0   HikerAPI on the handle → bio, IG category, followers, recent captions, engagement rate.
//   Tier 0.5 Visual analysis — recent images/thumbnails → a vision pass (Claude) → visual_signals.
//   Tier 1   IG Business Login demographics (instagram.ts fetchReport) — an OPTIONAL upgrade.
//   Tier 2   Onboarding intake (name/roles/pitchTo/brandCategories/journey + self-reported deals).
//   Inference  gpt-5.4 strict json_schema, scored against categoryFacets() names; tier derived in code.
//   inferred_audience  speculation over REAL demographics, flagged confidence:'inferred' IN CODE.
//
// DELIBERATE DIVERGENCE from qualify.ts/sourcing.ts (which predate the "fail loud" rule and use
// .catch(()=>null) to keep a BATCH of many leads moving): Creator IQ profiles a SINGLE creator, so a
// failure is THE result, not a skipped row. Each tier records present/missing/error in signals_used
// (loud, surfaced); a REQUIRED step's failure escalates to status:'error' + error on the row. We
// mirror runQualify's SHAPE (in-flight Set, strict schema, code-derived tier, incremental persist)
// but never its silent swallow.
//
// WAVE 2 (routes + views are wired separately; describe-only here so Wave 2 has the contract):
//   POST /api/creator-iq/generate  (apiAuth) → if !creatorIqAvailable() 400 {error:'OPENAI_API_KEY not
//     set on the server'}; else void runCreatorIq(tid) (background) and return 200 {ok:true}. Do NOT
//     .catch(()=>{})-swallow — the runner writes status:'error' to the row, which the status route surfaces.
//   GET  /api/creator-iq/status    (apiAuth) → creatorIqStatus(tid); null → 404 {ok:false,error:'no profile'}.
//     Carries status/error/signalsUsed/demographicsSource/igConnected/igConfigured/aiAvailable + profile.
//     Poll every ~2.5s while status==='running'.
//   GET  /creator-iq               (pageAuth) → page; add 'creator-iq' to shellNav's tab set.
//   The IG-connect upgrade CTA reuses the existing /connect/instagram route — no new connect route.
//
// Needs OPENAI_API_KEY (inference, required). HIKER_API_KEY (Tier 0/0.5 — without it: 'missing'),
// ANTHROPIC_API_KEY + a vision-capable VISION_MODEL (Tier 0.5), IG connect (Tier 1 upgrade). All
// degrade to 'missing' (loud, surfaced), never silent.

import { db, type CreatorProfileRow } from './db.ts'
import { enrichHandle, hikerAvailable, type EnrichedMedia } from './sourcing.ts'
import { fetchReport, getConnection, igConfigured, type IgDemographics } from './instagram.ts'
import { snapshot } from './onboarding.ts'
import { categoryFacets } from './brands.ts'
import type { PitchInput } from './pitchgen.ts'

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4' // same default as qualify.ts
const ENDPOINT = 'https://api.openai.com/v1/responses'
// Vision-capable Claude for Tier 0.5 media analysis. NOT ai.ts's MODEL (which defaults to non-vision
// Haiku 3); override with VISION_MODEL. Default is a current vision-capable Claude id.
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-sonnet-4-6'
const SECTOR_TOPN = Number(process.env.CREATOR_IQ_SECTOR_TOPN ?? 40)
const VISION_MAX_IMAGES = Number(process.env.VISION_MAX_IMAGES ?? 6)

export const creatorIqAvailable = () => !!process.env.OPENAI_API_KEY

// --- authority tier (derived in code from score; kept out of the LLM schema so the model can't
// disagree with the threshold — the structural twin of qualify.ts#tierOf) ---
export type Authority = 'strong' | 'some' | 'none'
export const authorityTierOf = (score: number): Authority =>
  score >= 70 ? 'strong' : score >= 40 ? 'some' : 'none'

// --- signals_used: the fail-loud transparency object. 'missing' = legitimately absent (lowers
// confidence, not an error); 'error' = a call we expected to work threw (surfaced red, and for a
// required step escalates to status:'error'). Persisted on EVERY incremental write. ---
export type SignalState = 'present' | 'missing' | 'error'
export interface SignalsUsed {
  hiker: { state: SignalState; detail?: string } // Tier 0 captions/media/ER
  vision: { state: SignalState; detail?: string } // Tier 0.5
  demographics: { state: SignalState; detail?: string } // Tier 1
  intake: { state: SignalState; detail?: string } // Tier 2
  inference: { state: SignalState; detail?: string } // sector LLM
}
function freshSignals(): SignalsUsed {
  return {
    hiker: { state: 'missing' },
    vision: { state: 'missing' },
    demographics: { state: 'missing' },
    intake: { state: 'missing' },
    inference: { state: 'missing' },
  }
}

// --- vision (Tier 0.5) — own Anthropic helper, NOT routed through ai.ts ---
export interface VisualSignals {
  subjects: string[] // what/who appears (e.g. "fitness", "home interiors")
  aesthetic: string // setting/style in a phrase
  topics: string[] // recurring themes
  onCameraBrands: string[] // brands/products visibly featured — warm leads for stage 2
}

const MEDIA_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}
function guessMediaType(url: string, contentType: string | null): string {
  if (contentType && contentType.startsWith('image/')) return contentType.split(';')[0]
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase()
  return MEDIA_TYPE[ext] ?? 'image/jpeg'
}

// Fetch one image URL → base64 block. A single 404/expired URL is skipped + counted (best-effort
// per-image), but the LLM call itself fails loud (throws) so creatoriq records vision:'error'.
async function fetchImageBlock(url: string): Promise<{ media_type: string; data: string } | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 WAConnect' } })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    return { media_type: guessMediaType(url, res.headers.get('content-type')), data: buf.toString('base64') }
  } catch {
    // A single image failing to download is not a build failure — it's counted by the caller
    // (zero-images → vision:'missing'). The LLM call below is the fail-loud path.
    return null
  } finally {
    clearTimeout(t)
  }
}

function emptyVisual(): VisualSignals {
  return { subjects: [], aesthetic: '', topics: [], onCameraBrands: [] }
}

// Run the multimodal vision pass. Returns an EMPTY VisualSignals when ZERO images loaded (no images
// ≠ error — caller marks vision:'missing'). THROWS on missing key / non-2xx / unparseable so the
// failure is recorded, never swallowed.
export async function analyzeMedia(
  imageUrls: string[],
  context?: { handle?: string; bio?: string },
): Promise<{ signals: VisualSignals; loaded: number; skipped: number }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('creator-iq vision: ANTHROPIC_API_KEY not set')
  const urls = imageUrls.filter(Boolean).slice(0, VISION_MAX_IMAGES)
  const blocks = await Promise.all(urls.map((u) => fetchImageBlock(u)))
  const images = blocks.filter((b): b is { media_type: string; data: string } => !!b)
  const skipped = urls.length - images.length
  if (!images.length) return { signals: emptyVisual(), loaded: 0, skipped }

  const ctx =
    (context?.handle ? `Instagram handle: @${context.handle}\n` : '') +
    (context?.bio ? `Bio: ${context.bio}\n` : '')
  const instruction =
    `These are recent Instagram posts from one creator.\n${ctx}\n` +
    `Describe ONLY what is visibly present in these images; do not guess brands, settings, or topics ` +
    `not actually shown. List brands/logos under onCameraBrands ONLY if a brand or product is clearly ` +
    `visible. Return ONLY a JSON object with this exact shape, no markdown fences:\n` +
    `{"subjects":["string"],"aesthetic":"string","topics":["string"],"onCameraBrands":["string"]}`

  const content: any[] = images.map((im) => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type, data: im.data },
  }))
  content.push({ type: 'text', text: instruction })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: VISION_MODEL, max_tokens: 600, messages: [{ role: 'user', content }] }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`creator-iq vision: Anthropic ${res.status} ${body.slice(0, 200)}`)
  }
  const j: any = await res.json()
  const text = j?.content?.find((c: any) => c?.type === 'text')?.text ?? j?.content?.[0]?.text ?? ''
  let parsed: any
  try {
    parsed = JSON.parse(stripFences(String(text)))
  } catch (e) {
    throw new Error(`creator-iq vision: unparseable model output: ${(e as Error).message}`)
  }
  const signals: VisualSignals = {
    subjects: asStrArr(parsed?.subjects),
    aesthetic: String(parsed?.aesthetic ?? '').slice(0, 200),
    topics: asStrArr(parsed?.topics),
    onCameraBrands: asStrArr(parsed?.onCameraBrands),
  }
  return { signals, loaded: images.length, skipped }
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : []
}

// --- closed sector vocabulary (DATA, not a literal): top-N brand categories by count, unioned with
// the creator's self-declared brandCategories. THROWS if the catalog is empty (an inference against
// an empty vocabulary is worthless — the load-bearing coupling). ---
export function closedSectorSet(selfDeclared: string[] = []): string[] {
  const facets = categoryFacets()
  if (!facets.length) {
    throw new Error('no brand categories in catalog — seed brands first')
  }
  const set = new Set<string>(facets.slice(0, SECTOR_TOPN).map((f) => f.name))
  for (const c of selfDeclared) if (c && c.trim()) set.add(c.trim())
  return [...set]
}

// --- inference input builder (PURE — unit-tested). Includes only present signals; a missing signal
// is OMITTED (never a "null" string). Engagement rate is framed as a CREDIBILITY weight, not a sector
// signal. The closed category list is always included. ---
export interface InferenceParts {
  handle?: string | null
  bio?: string | null
  igCategory?: string | null
  recentCaptions?: string[]
  visualSignals?: VisualSignals | null
  demographics?: IgDemographics | null
  engagementRate?: number | null
  selfReportedDeals?: { brand: string; result: string | null; source: string }[]
  targetCategories?: string[]
  roles?: string[]
  closedCategories: string[]
}

export function buildInferenceInput(parts: InferenceParts): string {
  const lines: string[] = []
  if (parts.handle) lines.push(`Instagram handle: @${parts.handle}`)
  if (parts.roles?.length) lines.push(`Self-described roles: ${parts.roles.join(', ')}`)
  if (parts.bio) lines.push(`Bio: ${parts.bio}`)
  if (parts.igCategory) lines.push(`Instagram category: ${parts.igCategory}`)
  if (parts.recentCaptions?.length) {
    lines.push(`Recent post captions (their own words):\n- ${parts.recentCaptions.slice(0, 24).join('\n- ')}`)
  }
  if (parts.visualSignals) {
    const vs = parts.visualSignals
    const vparts: string[] = []
    if (vs.subjects.length) vparts.push(`subjects: ${vs.subjects.join(', ')}`)
    if (vs.aesthetic) vparts.push(`aesthetic: ${vs.aesthetic}`)
    if (vs.topics.length) vparts.push(`topics: ${vs.topics.join(', ')}`)
    if (vs.onCameraBrands.length) vparts.push(`brands visible on-camera: ${vs.onCameraBrands.join(', ')}`)
    if (vparts.length) lines.push(`Visual content analysis (what is actually shown): ${vparts.join('; ')}`)
  }
  if (parts.demographics) {
    const top = (m?: Record<string, number>) =>
      Object.entries(m ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ')
    const d = parts.demographics
    const dparts: string[] = []
    if (Object.keys(d.age ?? {}).length) dparts.push(`age ${top(d.age)}`)
    if (Object.keys(d.gender ?? {}).length) dparts.push(`gender ${top(d.gender)}`)
    if (Object.keys(d.country ?? {}).length) dparts.push(`country ${top(d.country)}`)
    if (Object.keys(d.city ?? {}).length) dparts.push(`city ${top(d.city)}`)
    if (dparts.length) lines.push(`Real audience demographics: ${dparts.join('; ')}`)
  }
  if (parts.engagementRate != null) {
    // Credibility weight, NOT a sector signal — labelled so the model treats it as such.
    lines.push(`Engagement rate (a CREDIBILITY WEIGHT, not a sector signal): ${(parts.engagementRate * 100).toFixed(2)}%`)
  }
  if (parts.selfReportedDeals?.length) {
    lines.push(
      `Self-reported past brand deals: ${parts.selfReportedDeals
        .map((d) => `${d.brand}${d.result ? ` (${d.result})` : ''}`)
        .join('; ')}`,
    )
  }
  if (parts.targetCategories?.length) {
    lines.push(`Self-declared target brand categories: ${parts.targetCategories.join(', ')}`)
  }
  lines.push(
    `\nCLOSED CATEGORY LIST — every sector you return MUST use a category name EXACTLY from this list:\n` +
      parts.closedCategories.join(', '),
  )
  return lines.join('\n')
}

// --- sector post-filter (PURE — unit-tested). Strict json_schema can't enforce a dynamic enum, so
// we defensively drop any sector whose category isn't in the closed set, move it to other_sectors
// (low-confidence, excluded from hard matching), record the drop count, sort kept by score desc, and
// attach the code-derived authority. ---
export interface RawSector {
  category: string
  score: number
  reason: string
}
export interface FilteredSector {
  category: string
  score: number
  authority: Authority
  reason: string
}
export function filterSectors(
  raw: RawSector[],
  closedSet: string[],
  rawOther: string[] = [],
): { sectors: FilteredSector[]; otherSectors: string[]; dropped: number } {
  const allowed = new Set(closedSet)
  const sectors: FilteredSector[] = []
  const other = new Set<string>(rawOther.filter(Boolean))
  let dropped = 0
  for (const s of raw ?? []) {
    const category = String(s?.category ?? '').trim()
    if (!category) continue
    if (allowed.has(category)) {
      const score = Math.max(0, Math.min(100, Math.round(Number(s?.score) || 0)))
      sectors.push({ category, score, authority: authorityTierOf(score), reason: String(s?.reason ?? '').slice(0, 240) })
    } else {
      dropped++
      other.add(category)
    }
  }
  sectors.sort((a, b) => b.score - a.score)
  return { sectors, otherSectors: [...other], dropped }
}

const INFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    primary_niche: { type: 'string' },
    content_style: { type: 'string' },
    creator_type: { type: 'string', enum: ['content', 'events', 'both'] },
    summary: { type: 'string' },
    sectors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', description: 'MUST be one of the provided category names' },
          score: { type: 'integer', description: 'authority 0-100' },
          reason: { type: 'string' },
        },
        required: ['category', 'score', 'reason'],
      },
    },
    other_sectors: { type: 'array', items: { type: 'string' } },
  },
  required: ['primary_niche', 'content_style', 'creator_type', 'summary', 'sectors', 'other_sectors'],
}

const AUDIENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    likely_buyer_sectors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['category', 'reason'],
      },
    },
  },
  required: ['summary', 'likely_buyer_sectors'],
}

function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
  let txt = ''
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') for (const c of item?.content ?? []) if (c?.text) txt += c.text
  }
  return txt
}

// One OpenAI /v1/responses call, strict json_schema. FAIL LOUD (unlike judge()'s {score:0} fallback):
// throws on non-2xx / unparseable so the runner writes status:'error' rather than a plausible-but-fake
// profile.
async function callResponses(input: string, schemaName: string, schema: unknown): Promise<any> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('creator-iq inference: OPENAI_API_KEY not set')
  const body = JSON.stringify({
    model: MODEL,
    reasoning: { effort: 'low' },
    input,
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
  })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`creator-iq inference failed: OpenAI ${res.status} ${t.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = extractText(data)
  try {
    return JSON.parse(text || '{}')
  } catch (e) {
    throw new Error(`creator-iq inference failed: unparseable model output: ${(e as Error).message}`)
  }
}

// --- creator_profiles read/write (this track owns its data access; no SQL forked elsewhere) ---
export function getCreatorProfile(tenantId: string): CreatorProfileRow | undefined {
  return db.prepare('SELECT * FROM creator_profiles WHERE tenant_id = ?').get(tenantId) as
    | CreatorProfileRow
    | undefined
}

type ProfilePatch = Partial<{
  name: string
  instagram_handle: string | null
  profile_data: string | null
  creator_type: string | null
  visual_signals: string | null
  niche: string | null
  content_style: string | null
  engagement_rate: number | null
  demographics: string | null
  demographics_source: string | null
  sectors: string | null
  inferred_audience: string | null
  past_deals: string | null
  signals_used: string | null
  summary: string | null
  status: string | null
  error: string | null
  generated_at: number | null
}>

// Upsert the tenant's single working profile (UNIQUE(tenant_id) → clean ON CONFLICT). Writes only the
// provided columns; always bumps updated_at.
function upsertProfile(tenantId: string, patch: ProfilePatch): void {
  const existing = getCreatorProfile(tenantId)
  const now = Date.now()
  if (!existing) {
    db.prepare(
      'INSERT INTO creator_profiles (tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(tenantId, patch.name ?? snapshot(tenantId).profile?.name ?? 'Creator', now, now)
  }
  const cols = Object.keys(patch)
  if (!cols.length) {
    db.prepare('UPDATE creator_profiles SET updated_at = ? WHERE tenant_id = ?').run(now, tenantId)
    return
  }
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  const vals = cols.map((c) => (patch as Record<string, unknown>)[c])
  db.prepare(`UPDATE creator_profiles SET ${sets}, updated_at = ? WHERE tenant_id = ?`).run(
    ...(vals as any[]),
    now,
    tenantId,
  )
}

function readSignals(tenantId: string): SignalsUsed {
  const row = getCreatorProfile(tenantId)
  if (!row?.signals_used) return freshSignals()
  try {
    return { ...freshSignals(), ...(JSON.parse(row.signals_used) as SignalsUsed) }
  } catch {
    return freshSignals()
  }
}
function persistSignals(tenantId: string, signals: SignalsUsed): void {
  upsertProfile(tenantId, { signals_used: JSON.stringify(signals) })
}

// --- the tiered build orchestrator. Writes incrementally after each tier so the view fills live.
// None silently swallows: each tier returns data, marks 'missing', or records 'error' (and required
// tiers throw). ---
async function buildProfile(tenantId: string): Promise<void> {
  const signals = freshSignals()

  // Tier 2 (intake) is read first because it both feeds the closed set and provides a name/handle fallback.
  const snap = snapshot(tenantId)
  const intake = snap.profile
  if (intake && (intake.name || intake.roles.length || intake.pitchTo || intake.brandCategories.length)) {
    signals.intake = { state: 'present' }
  } else {
    signals.intake = { state: 'missing', detail: 'no onboarding intake captured' }
  }
  const selfDeals: { brand: string; result: string | null; source: string }[] = []

  // Resolve the handle: IG-connected username → row → intake has no handle field, so fall back to the
  // existing creator_profiles.instagram_handle.
  const conn = getConnection(tenantId)
  const row = getCreatorProfile(tenantId)
  const handle = (conn.username ?? row?.instagram_handle ?? '').replace(/^@/, '') || null
  if (handle) upsertProfile(tenantId, { instagram_handle: handle })
  persistSignals(tenantId, signals)

  // --- Tier 0: HikerAPI ---
  let recentCaptions: string[] = []
  let media: EnrichedMedia[] = []
  let bio: string | null = null
  let igCategory: string | null = null
  let engagementRate: number | null = null
  if (hikerAvailable() && handle) {
    try {
      const e = await enrichHandle(handle, { withMedia: true })
      if (!e) {
        signals.hiker = { state: 'error', detail: `HikerAPI returned no profile for @${handle}` }
      } else {
        bio = e.bio || null
        igCategory = e.category || null
        media = e.media ?? []
        recentCaptions = e.recentCaptions ?? []
        engagementRate = e.engagementRate ?? null
        signals.hiker = {
          state: 'present',
          detail: `${media.length} recent posts, ${recentCaptions.length} captions`,
        }
        upsertProfile(tenantId, {
          niche: igCategory ?? bio?.slice(0, 80) ?? null,
          engagement_rate: engagementRate,
          // Persist followers (+ context) in profile_data JSON so the proposal pricing engine can tier
          // off a real follower count (creator_profiles has no dedicated followers column).
          profile_data: JSON.stringify({ followers: e.followers ?? null, ig_category: igCategory, bio }),
        })
        // Caption-inferred past deals: suggest-then-confirm. A #ad / paid-partnership signal in a
        // caption is stored as a SUGGESTION (source:'caption', result:null) pending user confirmation.
        // These are EXCLUDED from the PitchInput adapter until confirmed (→ source:'self').
        const captionDeals = suggestCaptionDeals(media)
        if (captionDeals.length) {
          upsertProfile(tenantId, { past_deals: JSON.stringify([...selfDeals, ...captionDeals]) })
        }
      }
    } catch (err) {
      // Recorded, not swallowed. Tier 0 is required-ish: we still proceed to inference (which may then
      // be thin) rather than aborting — the error is loud in signals_used.
      signals.hiker = { state: 'error', detail: (err as Error).message }
    }
  } else {
    signals.hiker = {
      state: 'missing',
      detail: !hikerAvailable() ? 'HIKER_API_KEY not set' : 'no Instagram handle for this tenant',
    }
  }
  persistSignals(tenantId, signals)

  // --- Tier 0.5: vision (enriching, NOT required) ---
  let visual: VisualSignals | null = null
  const imageUrls = media.map((m) => m.imageUrl).filter((u): u is string => !!u)
  if (imageUrls.length) {
    try {
      const out = await analyzeMedia(imageUrls, { handle: handle ?? undefined, bio: bio ?? undefined })
      if (out.loaded > 0) {
        visual = out.signals
        signals.vision = {
          state: 'present',
          detail: `${out.loaded} images analysed${out.skipped ? `, ${out.skipped} skipped` : ''}`,
        }
        upsertProfile(tenantId, { visual_signals: JSON.stringify(visual) })
      } else {
        signals.vision = { state: 'missing', detail: 'no post images could be downloaded' }
      }
    } catch (err) {
      signals.vision = { state: 'error', detail: (err as Error).message }
    }
  } else {
    signals.vision = {
      state: 'missing',
      detail: media.length ? 'recent posts have no usable image URLs' : 'no media available for vision',
    }
  }
  persistSignals(tenantId, signals)

  // --- Tier 1: demographics (OPTIONAL upgrade; gate on connected first) ---
  let demographics: IgDemographics | null = null
  if (conn.connected) {
    try {
      const rep = await fetchReport(tenantId)
      demographics = rep.demographics
      const hasAny =
        Object.keys(rep.demographics.age ?? {}).length || Object.keys(rep.demographics.country ?? {}).length
      if (hasAny) {
        signals.demographics = { state: 'present', detail: rep.demographicsError ?? undefined }
        upsertProfile(tenantId, {
          demographics: JSON.stringify(rep.demographics),
          demographics_source: 'ig_business',
        })
      } else {
        // Connected but Meta returned nothing (e.g. <100 followers) — surface the soft reason.
        demographics = null
        signals.demographics = {
          state: 'missing',
          detail: rep.demographicsError ?? 'Instagram returned no audience demographics',
        }
        upsertProfile(tenantId, { demographics_source: 'none' })
      }
    } catch (err) {
      // Demographics is an upgrade, not required — record the error, don't crash the build.
      signals.demographics = { state: 'error', detail: (err as Error).message }
      upsertProfile(tenantId, { demographics_source: 'none' })
    }
  } else {
    signals.demographics = { state: 'missing', detail: 'Instagram not connected — connect to add real demographics' }
    upsertProfile(tenantId, { demographics_source: 'none' })
  }
  persistSignals(tenantId, signals)

  // --- Sector inference (REQUIRED — fails loud) ---
  const closed = closedSectorSet(intake?.brandCategories ?? []) // throws if catalog empty
  const inferInput = buildInferenceInput({
    handle,
    bio,
    igCategory,
    recentCaptions,
    visualSignals: visual,
    demographics,
    engagementRate,
    selfReportedDeals: selfDeals,
    targetCategories: intake?.brandCategories ?? [],
    roles: intake?.roles ?? [],
    closedCategories: closed,
  })
  const prompt =
    `You are a creator-intelligence analyst. From the GROUNDED creator data below, infer their primary ` +
    `niche, content style, creator_type, a one-paragraph summary, and an authority score (0-100) for each ` +
    `relevant sector.\n\n` +
    `Score ONLY from the data provided; a missing signal lowers confidence, never invent. Every "category" ` +
    `in "sectors" MUST be a name from the closed list. Put anything relevant but NOT in the list into ` +
    `"other_sectors" as free text.\n\n` +
    `CREATOR DATA:\n${inferInput}`

  let inferred: any
  try {
    inferred = await callResponses(prompt, 'creator_sectors', INFERENCE_SCHEMA)
    signals.inference = { state: 'present' }
  } catch (err) {
    signals.inference = { state: 'error', detail: (err as Error).message }
    persistSignals(tenantId, signals)
    throw err // → runner writes status:'error' + error
  }

  const { sectors, dropped } = filterSectors(
    Array.isArray(inferred.sectors) ? inferred.sectors : [],
    closed,
    Array.isArray(inferred.other_sectors) ? inferred.other_sectors.map(String) : [],
  )
  if (dropped) {
    signals.inference = {
      state: 'present',
      detail: `${dropped} hallucinated categor${dropped === 1 ? 'y' : 'ies'} dropped`,
    }
  }
  const creatorType = ['content', 'events', 'both'].includes(inferred.creator_type) ? inferred.creator_type : 'content'
  upsertProfile(tenantId, {
    niche: String(inferred.primary_niche ?? '').slice(0, 120) || igCategory || null,
    content_style: String(inferred.content_style ?? '').slice(0, 120) || null,
    creator_type: creatorType,
    summary: String(inferred.summary ?? '').slice(0, 2000) || null,
    // sectors column = BARE ARRAY [{category,score,reason}] per the spec + brandmatch/proposal contract.
    // (other_sectors = dropped hallucinations; recorded in signals above, not persisted.)
    sectors: JSON.stringify(sectors),
  })
  persistSignals(tenantId, signals)

  // --- inferred_audience (speculation; confidence:'inferred' SET IN CODE, never by the model). Only
  // when REAL demographics exist — no real demographics → no speculation (we don't fabricate). ---
  if (demographics && (Object.keys(demographics.age ?? {}).length || Object.keys(demographics.country ?? {}).length)) {
    try {
      const audInput =
        `From the REAL Instagram audience demographics and the creator's primary niche below, infer who ` +
        `their audience is likely to be (buyers/attendees). Each likely_buyer_sectors.category MUST be a ` +
        `name from the closed list.\n\n` +
        buildInferenceInput({
          handle,
          demographics,
          closedCategories: closed,
        }) +
        `\n\nPrimary niche: ${inferred.primary_niche ?? ''}`
      const aud = await callResponses(audInput, 'inferred_audience', AUDIENCE_SCHEMA)
      const buyers = (Array.isArray(aud.likely_buyer_sectors) ? aud.likely_buyer_sectors : [])
        .map((b: any) => ({ category: String(b?.category ?? '').trim(), reason: String(b?.reason ?? '').slice(0, 240) }))
        .filter((b: any) => b.category)
      upsertProfile(tenantId, {
        inferred_audience: JSON.stringify({
          summary: String(aud.summary ?? '').slice(0, 1000),
          likely_buyer_sectors: buyers,
          confidence: 'inferred', // SET IN CODE — never from the model; flips to 'measured' when a Tier-3 connector lands.
        }),
      })
    } catch (err) {
      // Speculation is enriching, not required — record on the inference signal, don't fail the build.
      signals.inference = {
        state: signals.inference.state === 'error' ? 'error' : 'present',
        detail: `${signals.inference.detail ? signals.inference.detail + '; ' : ''}inferred_audience skipped: ${(err as Error).message}`,
      }
      persistSignals(tenantId, signals)
    }
  }

  // Done.
  upsertProfile(tenantId, { status: 'done', error: null, generated_at: Date.now() })
  persistSignals(tenantId, signals)
}

// Suggest past deals from caption signals (#ad / paid partnership). Stored source:'caption' until the
// user confirms (→ source:'self'). NOT mapped into PitchInput while unconfirmed.
function suggestCaptionDeals(media: EnrichedMedia[]): { brand: string; result: null; source: 'caption' }[] {
  const out: { brand: string; result: null; source: 'caption' }[] = []
  const seen = new Set<string>()
  for (const m of media) {
    const cap = m.caption || ''
    if (!/#ad\b|#sponsored|paid partnership|#gifted/i.test(cap)) continue
    // Best-effort brand extraction from an @mention adjacent to the ad signal.
    const mention = cap.match(/@([a-z0-9_.]{2,30})/i)
    const brand = mention ? mention[1] : ''
    if (!brand || seen.has(brand.toLowerCase())) continue
    seen.add(brand.toLowerCase())
    out.push({ brand, result: null, source: 'caption' })
    if (out.length >= 8) break
  }
  return out
}

// --- background runner (mirrors runQualify/runSourcing; keyed by tenantId — one profile per tenant,
// single-instance per CLAUDE.md). LOUD: on any failure writes status:'error' + error to the row. ---
const running = new Set<string>()
export const isGenerating = (tenantId: string) => running.has(tenantId)

export async function runCreatorIq(tenantId: string): Promise<void> {
  if (running.has(tenantId)) return
  running.add(tenantId)
  try {
    upsertProfile(tenantId, { status: 'running', error: null, signals_used: JSON.stringify(freshSignals()) })
    await buildProfile(tenantId)
  } catch (err) {
    upsertProfile(tenantId, { status: 'error', error: (err as Error).message })
  } finally {
    running.delete(tenantId)
  }
}

// --- adapter: creator_profiles row → pitchgen.ts PitchInput. The grounded profile is the source at
// pitch time (no re-cobbling from onboarding.snapshot()). inferred_audience and unconfirmed
// source:'caption' deals are NEVER mapped — they're internal hints, not pitch claims. ---
export function rowToPitchInput(row: CreatorProfileRow, intakePitchTo?: string): PitchInput {
  const sectorsBlob = parseJson<{ sectors?: FilteredSector[]; other_sectors?: string[] }>(row.sectors) ?? {}
  const sectors = (sectorsBlob.sectors ?? [])
    .filter((s) => s.authority !== 'none')
    .sort((a, b) => b.score - a.score)
  const brandCategories = sectors.map((s) => s.category)
  const roles = [row.niche, row.content_style].filter((x): x is string => !!x && !!x.trim())
  const recentCaptions = (() => {
    // Captions corpus, if a Tier-0 build stored visual/profile text — derived from past_deals/summary
    // is NOT a caption corpus, so we only surface the summary here (grounded "their own words").
    return ''
  })()

  const input: PitchInput = {}
  if (row.name) input.name = row.name
  if (roles.length) input.roles = roles
  if (intakePitchTo) input.pitchTo = intakePitchTo
  if (brandCategories.length) input.brandCategories = brandCategories
  if (row.summary) input.aboutText = row.summary
  if (recentCaptions) input.workText = recentCaptions
  // NOTE: inferred_audience is intentionally NOT mapped (internal targeting hint, not a pitch claim).
  // NOTE: past_deals with source:'caption' (unconfirmed) are intentionally NOT mapped.
  return input
}

export function creatorProfileToPitchInput(tenantId: string): PitchInput {
  const row = getCreatorProfile(tenantId)
  if (!row) throw new Error('no creator profile for tenant; run Creator IQ first')
  const pitchTo = snapshot(tenantId).profile?.pitchTo || undefined
  return rowToPitchInput(row, pitchTo)
}

// --- status snapshot for the view (Wave 2). null when no row exists yet. ---
export interface CreatorIqStatus {
  status: 'idle' | 'running' | 'done' | 'error'
  error: string | null
  aiAvailable: boolean
  signalsUsed: SignalsUsed | null
  demographicsSource: 'ig_business' | 'none' | null
  igConnected: boolean
  igConfigured: boolean
  profile: {
    niche: string | null
    contentStyle: string | null
    engagementRate: number | null
    creatorType: string | null
    summary: string | null
    sectors: FilteredSector[]
    otherSectors: string[]
    demographics: IgDemographics | null
    inferredAudience: unknown
    pastDeals: unknown
    visualSignals: VisualSignals | null
    generatedAt: number | null
  } | null
}

export function creatorIqStatus(tenantId: string): CreatorIqStatus | null {
  const row = getCreatorProfile(tenantId)
  if (!row) return null
  const conn = getConnection(tenantId)
  const sectors = (parseJson<FilteredSector[]>(row.sectors) ?? []).map((s) => ({
    ...s,
    authority: authorityTierOf(s.score), // derive defensively
  }))
  return {
    status: (running.has(tenantId) ? 'running' : (row.status as any)) ?? 'idle',
    error: row.error ?? null,
    aiAvailable: creatorIqAvailable(),
    signalsUsed: parseJson<SignalsUsed>(row.signals_used),
    demographicsSource: (row.demographics_source as 'ig_business' | 'none' | null) ?? null,
    igConnected: conn.connected,
    igConfigured: igConfigured(),
    profile:
      row.status === 'done' || row.niche || sectors.length
        ? {
            niche: row.niche,
            contentStyle: row.content_style,
            engagementRate: row.engagement_rate,
            creatorType: row.creator_type,
            summary: row.summary,
            sectors,
            otherSectors: [], // other_sectors no longer persisted (low-value dropped hallucinations)
            demographics: parseJson<IgDemographics>(row.demographics),
            inferredAudience: parseJson(row.inferred_audience),
            pastDeals: parseJson(row.past_deals),
            visualSignals: parseJson<VisualSignals>(row.visual_signals),
            generatedAt: row.generated_at,
          }
        : null,
  }
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}
