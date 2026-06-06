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
  'contact page and directories (OpenTable, Eventbrite, Yell, Facebook About, Companies House). ' +
  'Reject venue/box-office/ticketing lines. If none confidently found, output none.'

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
  if (!res.ok) throw new Error(`HikerAPI ${res.status}`)
  return res.json()
}

// Pull candidate usernames posting under a hashtag's top media. Deduped, capped.
export async function discoverByHashtag(tag: string, cap = 30): Promise<string[]> {
  const data = await hiker('/v1/hashtag/medias/top', { name: tag.replace(/^#/, '') }).catch(() => null)
  if (!data) return []
  const list: any[] = Array.isArray(data) ? data : data.response ?? data.items ?? []
  const seen = new Set<string>()
  for (const m of list) {
    const un = m?.user?.username
    if (un && !seen.has(un)) seen.add(un)
    if (seen.size >= cap) break
  }
  return [...seen]
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
}

// HikerAPI by-username → the fields we filter and seed on.
export async function enrichHandle(username: string): Promise<Enriched | null> {
  const d = await hiker('/v1/user/by/username', { username }).catch(() => null)
  if (!d || d.exists === false) return null
  const u = d.user ?? d
  return {
    username,
    fullName: u.full_name ?? '',
    followers: Number(u.follower_count ?? 0),
    isBusiness: !!(u.is_business ?? u.is_business_account),
    category: u.category ?? '',
    publicPhone: u.public_phone_number || u.contact_phone_number || null,
    externalUrl: u.external_url || null,
    bio: u.biography ?? '',
  }
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
