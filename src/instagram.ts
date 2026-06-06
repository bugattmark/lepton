// Instagram connector via the official "Instagram API with Instagram Login" (Business Login).
// The creator authorizes their OWN Instagram professional (Business/Creator) account; we store
// a 60-day token per tenant and read profile + real follower demographics straight from Meta.
// No scraping, no creator screenshots — this is the audience data nothing else can give us.
//
// Flow:
//   /connect/instagram → instagram.com/oauth/authorize → callback?code=…
//   → exchange code for a short-lived token → exchange that for a long-lived (60d) token → store.
// Token is refreshable for another 60 days as long as we refresh before it expires.
//
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
//
// Server config (env): IG_APP_ID, IG_APP_SECRET (from the Meta App Dashboard → Instagram →
// API setup with Instagram login), and optionally IG_REDIRECT_URI (else derived from the request).

import { db } from './db.ts'
import { enc, dec } from './secret.ts'

const OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize'
const OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token'
const GRAPH = 'https://graph.instagram.com'

// basic = identity + media; manage_insights = follower_demographics + reach.
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights']

const DAY = 86_400_000

export class IgError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'IgError'
    this.status = status
  }
}

// Whether the server has the Meta app credentials wired up at all.
export const igConfigured = (): boolean => !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET)

// --- OAuth step 1: the authorize URL the creator is redirected to ---
export function authorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(OAUTH_AUTHORIZE)
  u.searchParams.set('client_id', process.env.IG_APP_ID ?? '')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(','))
  u.searchParams.set('state', state)
  return u.toString()
}

// --- OAuth step 2: code → short-lived token ---
async function exchangeCode(code: string, redirectUri: string): Promise<{ access_token: string; user_id: string }> {
  const form = new URLSearchParams({
    client_id: process.env.IG_APP_ID ?? '',
    client_secret: process.env.IG_APP_SECRET ?? '',
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  })
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new IgError(j?.error_message || `token exchange failed (HTTP ${res.status})`, res.status)
  // Response shape varies: { access_token, user_id, permissions } or { data: [ {…} ] }.
  const d = Array.isArray(j?.data) ? j.data[0] : j
  if (!d?.access_token) throw new IgError('no access token in token response')
  return { access_token: d.access_token, user_id: String(d.user_id ?? '') }
}

// --- OAuth step 3: short-lived → long-lived (60 days) ---
async function exchangeLongLived(shortToken: string): Promise<{ access_token: string; expires_in: number }> {
  const u = new URL(`${GRAPH}/access_token`)
  u.searchParams.set('grant_type', 'ig_exchange_token')
  u.searchParams.set('client_secret', process.env.IG_APP_SECRET ?? '')
  u.searchParams.set('access_token', shortToken)
  const res = await fetch(u)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new IgError(j?.error?.message || `long-lived exchange failed (HTTP ${res.status})`, res.status)
  return { access_token: j.access_token, expires_in: Number(j.expires_in ?? 0) }
}

// Refresh a long-lived token (valid only if it's >24h old and not yet expired).
async function refreshLongLived(longToken: string): Promise<{ access_token: string; expires_in: number }> {
  const u = new URL(`${GRAPH}/refresh_access_token`)
  u.searchParams.set('grant_type', 'ig_refresh_token')
  u.searchParams.set('access_token', longToken)
  const res = await fetch(u)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new IgError(j?.error?.message || `token refresh failed (HTTP ${res.status})`, res.status)
  return { access_token: j.access_token, expires_in: Number(j.expires_in ?? 0) }
}

// Full connect: code → short → long → fetch identity → store. Returns the live profile.
export async function completeConnect(tenantId: string, code: string, redirectUri: string): Promise<IgProfile> {
  const short = await exchangeCode(code, redirectUri)
  const long = await exchangeLongLived(short.access_token)
  const profile = await fetchProfile(long.access_token)
  saveConnection(tenantId, {
    userId: profile.user_id || short.user_id,
    username: profile.username,
    token: long.access_token,
    expiresAt: Date.now() + long.expires_in * 1000,
  })
  return profile
}

// --- per-tenant token store (token is encrypted at rest via secret.ts) ---
interface StoredConn {
  userId: string
  username: string
  token: string
  expiresAt: number
}

export function saveConnection(tenantId: string, c: StoredConn): void {
  db.prepare(
    'UPDATE tenants SET ig_user_id=?, ig_username=?, ig_access_token=?, ig_token_expires_at=?, ig_connected_at=? WHERE id=?',
  ).run(c.userId, c.username, enc(c.token), c.expiresAt, Date.now(), tenantId)
}

export function clearConnection(tenantId: string): void {
  db.prepare(
    'UPDATE tenants SET ig_user_id=NULL, ig_username=NULL, ig_access_token=NULL, ig_token_expires_at=NULL, ig_connected_at=NULL WHERE id=?',
  ).run(tenantId)
}

export interface IgConnection {
  connected: boolean
  username: string | null
  userId: string | null
  expiresAt: number | null
}

export function getConnection(tenantId: string): IgConnection {
  const r = db
    .prepare('SELECT ig_user_id, ig_username, ig_access_token, ig_token_expires_at FROM tenants WHERE id=?')
    .get(tenantId) as
    | { ig_user_id: string | null; ig_username: string | null; ig_access_token: string | null; ig_token_expires_at: number | null }
    | undefined
  return {
    connected: !!r?.ig_access_token,
    username: r?.ig_username ?? null,
    userId: r?.ig_user_id ?? null,
    expiresAt: r?.ig_token_expires_at ?? null,
  }
}

// Return a usable access token, lazily refreshing it when it's within 7 days of expiry
// (and old enough that Meta will accept the refresh). Null when the tenant isn't connected.
async function validToken(tenantId: string): Promise<string | null> {
  const r = db
    .prepare('SELECT ig_access_token, ig_token_expires_at FROM tenants WHERE id=?')
    .get(tenantId) as { ig_access_token: string | null; ig_token_expires_at: number | null } | undefined
  if (!r?.ig_access_token) return null
  let token = dec(r.ig_access_token)
  if (!token) return null
  const expiresAt = Number(r.ig_token_expires_at ?? 0)
  const left = expiresAt - Date.now()
  if (expiresAt && left < 7 * DAY && left > DAY) {
    try {
      const fresh = await refreshLongLived(token)
      token = fresh.access_token
      db.prepare('UPDATE tenants SET ig_access_token=?, ig_token_expires_at=? WHERE id=?').run(
        enc(token),
        Date.now() + fresh.expires_in * 1000,
        tenantId,
      )
    } catch {
      /* keep the existing token; refresh is best-effort */
    }
  }
  return token
}

// --- profile + insights ---
export interface IgProfile {
  user_id: string
  username: string
  account_type?: string
  followers_count?: number
  follows_count?: number
  media_count?: number
}

async function fetchProfile(token: string): Promise<IgProfile> {
  const u = new URL(`${GRAPH}/me`)
  u.searchParams.set('fields', 'user_id,username,account_type,followers_count,follows_count,media_count')
  u.searchParams.set('access_token', token)
  const res = await fetch(u)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new IgError(j?.error?.message || `profile fetch failed (HTTP ${res.status})`, res.status)
  return {
    user_id: String(j.user_id ?? ''),
    username: j.username ?? '',
    account_type: j.account_type,
    followers_count: j.followers_count,
    follows_count: j.follows_count,
    media_count: j.media_count,
  }
}

export interface IgDemographics {
  age?: Record<string, number>
  gender?: Record<string, number>
  country?: Record<string, number>
  city?: Record<string, number>
}

// follower_demographics, one call per breakdown dimension. Parses the nested
// total_value.breakdowns[].results[] into a flat { key: count } map.
async function demographicBreakdown(userId: string, token: string, breakdown: string): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/${userId}/insights`)
  u.searchParams.set('metric', 'follower_demographics')
  u.searchParams.set('period', 'lifetime')
  u.searchParams.set('metric_type', 'total_value')
  u.searchParams.set('timeframe', 'last_90_days')
  u.searchParams.set('breakdown', breakdown)
  u.searchParams.set('access_token', token)
  const res = await fetch(u)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new IgError(j?.error?.message || `insights failed (HTTP ${res.status})`, res.status)
  const results = j?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []
  const out: Record<string, number> = {}
  for (const r of results) {
    const dv = r?.dimension_values
    // dimension_values may be ["country"] or ["LAST_90_DAYS","country"]; the real key is last.
    const keyVal = Array.isArray(dv) ? dv[dv.length - 1] : dv
    if (keyVal != null) out[String(keyVal)] = Number(r?.value ?? 0)
  }
  return out
}

// The twin payload: live identity + real follower demographics. Best-effort on demographics
// (Meta only returns them for professional accounts with 100+ followers); returns what it can
// and surfaces a reason in `demographicsError` rather than throwing.
export interface IgReport {
  profile: IgProfile
  demographics: IgDemographics
  demographicsError?: string
}

export async function fetchReport(tenantId: string): Promise<IgReport> {
  const token = await validToken(tenantId)
  if (!token) throw new IgError('Instagram not connected', 401)
  const profile = await fetchProfile(token)
  const userId = profile.user_id || getConnection(tenantId).userId || ''
  const demographics: IgDemographics = {}
  let demographicsError: string | undefined
  try {
    const [age, gender, country, city] = await Promise.all([
      demographicBreakdown(userId, token, 'age').catch(() => ({})),
      demographicBreakdown(userId, token, 'gender').catch(() => ({})),
      demographicBreakdown(userId, token, 'country').catch(() => ({})),
      demographicBreakdown(userId, token, 'city').catch(() => ({})),
    ])
    demographics.age = age
    demographics.gender = gender
    demographics.country = country
    demographics.city = city
    if (!Object.keys(age).length && !Object.keys(country).length)
      demographicsError = 'No audience demographics yet — needs a professional account with 100+ followers.'
  } catch (e) {
    demographicsError = (e as Error).message
  }
  return { profile, demographics, demographicsError }
}
