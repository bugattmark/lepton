// Lead sourcing engine. Given a niche (a set of Instagram hashtags), discover the handles
// of people running events, then find their WhatsApp-reachable phone using the same gpt-5.4
// strategy benchmarked in bench/RESULTS.md. Results materialize into a 'sourced' lead_list
// so the rest of the app (Lead-list block, campaigns) treats them like any other list.
//
// Pipeline (validated in bench/):
//   1. HikerAPI hashtag/medias/top  → candidate usernames posting under the niche
//   2. HikerAPI user/by/username    → enrich + filter (follower range, real account, public_phone)
//   3. gpt-5.4 web_search (iglead)  → find a phone where IG doesn't declare one
//   4. push rows with a valid phone until we hit the target count
//
// Needs HIKER_API_KEY (discovery + enrich) and OPENAI_API_KEY (phone lookup, via iglead).

import { db } from './db.ts'
import { getLeadList } from './campaigns.ts'
import type { UpsertRow } from './campaigns.ts'
import { lookupPhone } from './iglead.ts'

const HIKER = 'https://api.hikerapi.com'

export const hikerAvailable = () => !!process.env.HIKER_API_KEY

export type SourcingConfig = {
  niche: string // human label, e.g. "London supper clubs"
  hashtags: string[] // discovery hashtags, e.g. ["supperclublondon","londonsupperclub"]
  instruction: string // editable phone-finder prompt (passed through to the lead query context)
  targetHandles: number // how many candidate handles to scan before stopping (default 40)
  targetPhones: number // stop once this many leads have a phone (default 10)
  refreshDays: number // re-run cadence (default 2)
  minFollowers: number // filter floor (default 500)
  maxFollowers: number // filter ceiling (default 100000)
  status: 'idle' | 'running' | 'done' | 'error'
  scanned: number // candidate handles examined so far
  lastRun: number | null
  error?: string | null
}

export const DEFAULT_INSTRUCTION =
  'Find the organiser’s own UK mobile (+447…) for WhatsApp outreach. Check their site’s ' +
  'contact page and directories. If none confidently found, output none.'

export function defaultConfig(niche: string, hashtags: string[]): SourcingConfig {
  return {
    niche,
    hashtags,
    instruction: DEFAULT_INSTRUCTION,
    targetHandles: 40,
    targetPhones: 10,
    refreshDays: 2,
    minFollowers: 500,
    maxFollowers: 100000,
    status: 'idle',
    scanned: 0,
    lastRun: null,
    error: null,
  }
}

// --- HikerAPI helpers -------------------------------------------------------
async function hiker(path: string, params: Record<string, string>): Promise<any> {
  const key = process.env.HIKER_API_KEY
  if (!key) throw new Error('HIKER_API_KEY not set')
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${HIKER}${path}?${qs}`, {
    headers: { 'x-access-key': key, 'user-agent': 'Mozilla/5.0' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let detail = body.slice(0, 200)
    try {
      const j = JSON.parse(body)
      if (j?.error) detail = String(j.error)
    } catch {
      // non-JSON body — fall back to the raw text snippet above
    }
    throw new Error(`HikerAPI ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return res.json()
}

// Pull candidate usernames posting under a hashtag's top media. Deduped, capped.
export async function discoverByHashtag(tag: string, cap = 30): Promise<string[]> {
  // Do NOT swallow: hiker() throws `HikerAPI <status>` on non-2xx (e.g. 402 InsufficientFunds when
  // the account is out of credits). Let it propagate so runSourcing records it and the UI shows why
  // the run produced nothing, instead of silently returning [] and looking like "0 found / turned off".
  const data = await hiker('/v1/hashtag/medias/top', { name: tag.replace(/^#/, '') })
  const list: any[] = Array.isArray(data) ? data : data.response ?? data.items ?? []
  const seen = new Set<string>()
  for (const m of list) {
    const un = m?.user?.username
    if (un && !seen.has(un)) seen.add(un)
    if (seen.size >= cap) break
  }
  return [...seen]
}

// One recent post/reel, normalized from HikerAPI's (varying) media shape. Used by Creator IQ
// (Tier 0 captions + Tier 0.5 vision over imageUrl). imageUrl is an expiring-signed CDN URL —
// fetch it promptly during the run, never persist it.
export type EnrichedMedia = {
  id: string
  caption: string
  imageUrl: string | null // display/thumbnail URL for the vision pass (Tier 0.5)
  isVideo: boolean
  likes: number
  comments: number
  takenAt: number | null // epoch ms, for recency ordering
}

export type Enriched = {
  username: string
  fullName: string
  followers: number
  isBusiness: boolean
  category: string
  publicPhone: string | null
  externalUrl: string | null
  bio: string
  // NEW — present only when enrichHandle is called with { withMedia: true }. The existing
  // no-opts call path (qualify.ts line ~186) never sees these keys, so it is byte-for-byte unchanged.
  media?: EnrichedMedia[] // most-recent-first, capped at opts.mediaCount (default 12)
  engagementRate?: number | null // mean(likes+comments)/followers over fetched media, 0..1; null if uncomputable
  recentCaptions?: string[] // convenience: media.map(m => m.caption).filter(Boolean)
}

// mean(likes+comments) across media, divided by followers. Returns 0..1, or null when it cannot
// be computed (no followers, or no media). Rounded to 4 dp.
//
// NOTE: "saves" are part of the textbook engagement-rate formula but HikerAPI media does NOT expose
// them — we deliberately use likes+comments only (the standard public-ER proxy, matching the bench
// fixture's avg_likes/avg_comments). We do not pretend to have saves; the omission is documented here
// rather than fabricated as a zero.
export function computeEngagementRate(media: EnrichedMedia[], followers: number): number | null {
  if (!(followers > 0)) return null
  if (!media.length) return null
  let sum = 0
  for (const m of media) sum += (Number(m.likes) || 0) + (Number(m.comments) || 0)
  const mean = sum / media.length
  const er = Math.max(0, Math.min(1, mean / followers))
  return Math.round(er * 10000) / 10000
}

// Tolerant extraction of an image/thumbnail URL from a HikerAPI media item (shape varies by
// endpoint/version). Reels/videos expose a thumbnail — use it.
function mediaImageUrl(m: any): string | null {
  return (
    m?.thumbnail_url ||
    m?.image_versions2?.candidates?.[0]?.url ||
    m?.image_versions?.items?.[0]?.url ||
    m?.display_url ||
    m?.display_uri ||
    (Array.isArray(m?.resources) ? m.resources[0]?.thumbnail_url ?? null : null) ||
    null
  )
}

// Pull a user's recent media. RISK: the bench fixtures don't cover a medias call, so the exact
// path/params/shape are unverified against the live key — we read fields tolerantly and reuse
// discoverByHashtag's array-extraction idiom. We do NOT wrap this in a silent try/catch: hiker()
// throws `HikerAPI <status>` on a non-2xx and that throw propagates, so the caller (creatoriq.ts)
// decides fatal-vs-recorded-degrade. userId is preferred (from the by-username response); username
// is the fallback param.
export async function fetchRecentMedia(userIdOrUsername: string, count = 12): Promise<EnrichedMedia[]> {
  const isNumericId = /^[0-9]+$/.test(userIdOrUsername)
  const params: Record<string, string> = isNumericId
    ? { user_id: userIdOrUsername, amount: String(count) }
    : { username: userIdOrUsername, amount: String(count) }
  const data = await hiker('/v1/user/medias', params)
  const list: any[] = Array.isArray(data) ? data : data.response ?? data.items ?? data.medias ?? []
  const out: EnrichedMedia[] = []
  for (const m of list) {
    const takenSec = Number(m?.taken_at ?? m?.taken_at_ts ?? 0)
    const mediaType = Number(m?.media_type ?? 0)
    const productType = String(m?.product_type ?? '')
    out.push({
      id: String(m?.id ?? m?.pk ?? m?.code ?? ''),
      caption: String(m?.caption_text ?? m?.caption?.text ?? '').trim(),
      imageUrl: mediaImageUrl(m),
      isVideo: mediaType === 2 || productType === 'clips' || !!m?.video_url || !!m?.video_versions,
      likes: Number(m?.like_count ?? m?.likes ?? 0) || 0,
      comments: Number(m?.comment_count ?? m?.comments ?? 0) || 0,
      takenAt: Number.isFinite(takenSec) && takenSec > 0 ? takenSec * 1000 : null,
    })
  }
  out.sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0))
  return out.slice(0, count)
}

// HikerAPI by-username → the fields we filter and seed on. With { withMedia: true } it additionally
// fetches recent media and computes an engagement rate (Creator IQ Tier 0). Without opts it is
// IDENTICAL to the original single-call behaviour (no extra request, no extra keys).
export async function enrichHandle(
  username: string,
  opts: { withMedia?: boolean; mediaCount?: number } = {},
): Promise<Enriched | null> {
  const d = await hiker('/v1/user/by/username', { username }).catch(() => null)
  if (!d || d.exists === false) return null
  const u = d.user ?? d
  const enriched: Enriched = {
    username,
    fullName: u.full_name ?? '',
    followers: Number(u.follower_count ?? 0),
    isBusiness: !!(u.is_business ?? u.is_business_account),
    category: u.category ?? '',
    publicPhone: u.public_phone_number || u.contact_phone_number || null,
    externalUrl: u.external_url || null,
    bio: u.biography ?? '',
  }
  if (opts.withMedia) {
    const pk = String(u.pk ?? u.id ?? '') || username
    const media = await fetchRecentMedia(pk, opts.mediaCount ?? 12)
    enriched.media = media
    enriched.recentCaptions = media.map((m) => m.caption).filter(Boolean)
    enriched.engagementRate = computeEngagementRate(media, enriched.followers)
  }
  return enriched
}

const onlyDigits = (s: string) => (s || '').replace(/[^0-9]/g, '')
function toE164(raw: string): string | null {
  let d = onlyDigits(raw)
  if (!d) return null
  if (d.startsWith('0')) d = '44' + d.slice(1)
  if (d.startsWith('7') && d.length === 10) d = '44' + d
  if (!d.startsWith('44')) return d.length >= 10 ? '+' + d : null
  return '+' + d
}

// Does this enriched handle look like an event organiser worth contacting?
function passesFilter(e: Enriched, cfg: SourcingConfig): boolean {
  if (e.followers < cfg.minFollowers || e.followers > cfg.maxFollowers) return false
  return true
}

// --- the run ----------------------------------------------------------------
function readCfg(listId: number, tenantId: string): { rows: UpsertRow[]; sourcing: SourcingConfig } | null {
  const list = getLeadList(tenantId, listId)
  if (!list || list.type !== 'sourced') return null
  const cfg = JSON.parse(list.config)
  return { rows: (cfg.rows as UpsertRow[]) ?? [], sourcing: cfg.sourcing as SourcingConfig }
}
function writeCfg(listId: number, tenantId: string, rows: UpsertRow[], sourcing: SourcingConfig): void {
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(
    JSON.stringify({ rows, sourcing }),
    listId,
    tenantId,
  )
}

// Track in-flight runs so we don't double-start a list.
const running = new Set<number>()
export const isSourcing = (listId: number) => running.has(listId)

// Fill a 'sourced' list up to its targetPhones. Runs in the background; persists incrementally
// so the Source-page table fills live as leads come in.
export async function runSourcing(tenantId: string, listId: number): Promise<void> {
  if (running.has(listId)) return
  running.add(listId)
  const init = readCfg(listId, tenantId)
  if (!init) {
    running.delete(listId)
    return
  }
  const rows = init.rows
  const cfg = init.sourcing
  const have = new Set(rows.map((r) => r.instagram_handle).filter(Boolean) as string[])
  cfg.status = 'running'
  cfg.error = null
  writeCfg(listId, tenantId, rows, cfg)

  const withPhone = () => rows.filter((r) => r.phone).length

  try {
    for (const tag of cfg.hashtags) {
      if (withPhone() >= cfg.targetPhones) break
      if (cfg.scanned >= cfg.targetHandles) break
      const candidates = await discoverByHashtag(tag, cfg.targetHandles)
      for (const username of candidates) {
        if (withPhone() >= cfg.targetPhones) break
        if (cfg.scanned >= cfg.targetHandles) break
        if (have.has(username)) continue
        have.add(username)
        cfg.scanned++

        const e = await enrichHandle(username).catch(() => null)
        if (!e || !passesFilter(e, cfg)) {
          writeCfg(listId, tenantId, rows, cfg)
          continue
        }

        // 1) trust IG's declared public phone if present (cheap, precise)
        let phone = e.publicPhone ? toE164(e.publicPhone) : null
        // 2) else use the gpt-5.4 web-search strategy
        if (!phone) {
          const r = await lookupPhone({
            name: e.fullName || username,
            handle: username,
            website: e.externalUrl ?? undefined,
          }).catch(() => null)
          if (r?.phone) phone = r.phone
        }

        rows.push({
          name: e.fullName || null,
          phone: phone ?? '',
          instagram_handle: username,
          event_link: e.externalUrl ?? null,
          category: cfg.niche,
          source: 'sourced',
          vars: {
            instagram_handle: username,
            ...(e.externalUrl ? { instagram_link: e.externalUrl } : {}),
            category: cfg.niche,
          },
        })
        writeCfg(listId, tenantId, rows, cfg) // incremental → live table
      }
    }
    cfg.status = 'done'
    cfg.lastRun = Date.now()
  } catch (err) {
    cfg.status = 'error'
    cfg.error = (err as Error).message
  } finally {
    writeCfg(listId, tenantId, rows, cfg)
    running.delete(listId)
  }
}

// Status snapshot for the Source page to poll.
export function sourcingStatus(tenantId: string, listId: number) {
  const c = readCfg(listId, tenantId)
  if (!c) return null
  const found = c.rows.filter((r) => r.phone).length
  return {
    status: running.has(listId) ? 'running' : c.sourcing.status,
    error: c.sourcing.error ?? null,
    scanned: c.sourcing.scanned,
    found,
    target: c.sourcing.targetPhones,
    targetHandles: c.sourcing.targetHandles,
    config: {
      niche: c.sourcing.niche,
      hashtags: c.sourcing.hashtags,
      instruction: c.sourcing.instruction,
      targetHandles: c.sourcing.targetHandles,
      targetPhones: c.sourcing.targetPhones,
      refreshDays: c.sourcing.refreshDays,
      minFollowers: c.sourcing.minFollowers,
      maxFollowers: c.sourcing.maxFollowers,
    },
    rows: c.rows,
  }
}
