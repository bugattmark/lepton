// "Continue with Google" + Gmail read/send. The user authorizes their own Google account;
// we store an OIDC identity (email + sub) and OAuth tokens per tenant, refreshing lazily.
//
// Flow:
//   /auth/google → accounts.google.com/o/oauth2/v2/auth → /auth/google/callback?code=…
//   → exchange code for { access_token, refresh_token, id_token } → store.
//
// Scopes: openid + email + profile (identity) and gmail.readonly + gmail.send (read/send mail).
// access_type=offline + prompt=consent ensures Google returns a refresh_token.
//
// Server config (env): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (OAuth 2.0 Web client from the
// Google Cloud Console), and optionally GOOGLE_REDIRECT_URI (else derived from the request).

import { db } from './db.ts'
import { enc, dec } from './secret.ts'

const OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

export const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

export class GoogleError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GoogleError'
    this.status = status
  }
}

// Whether the server has the Google OAuth client credentials wired up.
export const googleConfigured = (): boolean => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

// --- OAuth step 1: the authorize URL the user is redirected to ---
export function authorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(OAUTH_AUTHORIZE)
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID ?? '')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline') // ask for a refresh_token
  u.searchParams.set('include_granted_scopes', 'true')
  u.searchParams.set('prompt', 'consent') // force refresh_token on re-consent
  u.searchParams.set('state', state)
  return u.toString()
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
  scope?: string
}

// --- OAuth step 2: code → tokens ---
async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  })
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const j = (await res.json().catch(() => ({}))) as TokenResponse & { error_description?: string; error?: string }
  if (!res.ok || !j.access_token)
    throw new GoogleError(j.error_description || j.error || `token exchange failed (HTTP ${res.status})`, res.status)
  return j
}

async function refreshToken(refresh: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    grant_type: 'refresh_token',
    refresh_token: refresh,
  })
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const j = (await res.json().catch(() => ({}))) as TokenResponse & { error_description?: string }
  if (!res.ok || !j.access_token)
    throw new GoogleError(j.error_description || `token refresh failed (HTTP ${res.status})`, res.status)
  return j
}

interface GoogleIdentity {
  email: string
  sub: string
  name?: string
  picture?: string
}

async function fetchIdentity(accessToken: string): Promise<GoogleIdentity> {
  const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } })
  const j = (await res.json().catch(() => ({}))) as Record<string, string>
  if (!res.ok || !j.email) throw new GoogleError(`userinfo failed (HTTP ${res.status})`, res.status)
  return { email: j.email, sub: j.sub, name: j.name, picture: j.picture }
}

// Full connect: code → tokens → identity → store. Returns the connected identity.
export async function completeConnect(tenantId: string, code: string, redirectUri: string): Promise<GoogleIdentity> {
  const tok = await exchangeCode(code, redirectUri)
  const id = await fetchIdentity(tok.access_token)
  saveConnection(tenantId, {
    email: id.email,
    sub: id.sub,
    accessToken: tok.access_token,
    // Google omits refresh_token on repeat consent; keep any prior one.
    refreshToken: tok.refresh_token ?? currentRefreshToken(tenantId),
    expiresAt: Date.now() + tok.expires_in * 1000,
  })
  return id
}

// Sign-in path: exchange the code once and resolve identity, WITHOUT writing to a tenant
// (the caller find-or-creates the tenant first, then calls saveConnection).
export async function exchangeAndIdentify(
  code: string,
  redirectUri: string,
): Promise<{ email: string; sub: string; accessToken: string; refreshToken: string | null; expiresAt: number }> {
  const tok = await exchangeCode(code, redirectUri)
  const id = await fetchIdentity(tok.access_token)
  return {
    email: id.email,
    sub: id.sub,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: Date.now() + tok.expires_in * 1000,
  }
}

// --- per-tenant token store (tokens encrypted at rest via secret.ts) ---
interface StoredGoogle {
  email: string
  sub: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number
}

function currentRefreshToken(tenantId: string): string | null {
  const r = db.prepare('SELECT google_refresh_token FROM tenants WHERE id=?').get(tenantId) as
    | { google_refresh_token: string | null }
    | undefined
  return r?.google_refresh_token ? dec(r.google_refresh_token) : null
}

export function saveConnection(tenantId: string, c: StoredGoogle): void {
  db.prepare(
    `UPDATE tenants SET google_email=?, google_sub=?, google_access_token=?, google_refresh_token=?,
       google_token_expires_at=?, google_connected_at=COALESCE(google_connected_at, ?) WHERE id=?`,
  ).run(
    c.email,
    c.sub,
    enc(c.accessToken),
    c.refreshToken ? enc(c.refreshToken) : null,
    c.expiresAt,
    Date.now(),
    tenantId,
  )
}

export function clearConnection(tenantId: string): void {
  db.prepare(
    `UPDATE tenants SET google_email=NULL, google_sub=NULL, google_access_token=NULL,
       google_refresh_token=NULL, google_token_expires_at=NULL, google_connected_at=NULL WHERE id=?`,
  ).run(tenantId)
}

// Find a tenant by their Google identity (for "Continue with Google" sign-in).
export function findTenantByGoogleSub(sub: string): string | null {
  const r = db.prepare('SELECT id FROM tenants WHERE google_sub=?').get(sub) as { id: string } | undefined
  return r?.id ?? null
}

export interface GoogleConnection {
  connected: boolean
  email: string | null
  expiresAt: number | null
}

export function getConnection(tenantId: string): GoogleConnection {
  const r = db
    .prepare('SELECT google_email, google_access_token, google_token_expires_at FROM tenants WHERE id=?')
    .get(tenantId) as
    | { google_email: string | null; google_access_token: string | null; google_token_expires_at: number | null }
    | undefined
  return {
    connected: !!r?.google_access_token,
    email: r?.google_email ?? null,
    expiresAt: r?.google_token_expires_at ?? null,
  }
}

// Return a usable access token, refreshing it when within 2 min of expiry. Null if not connected
// (or if the refresh fails and the current token is already expired).
export async function validToken(tenantId: string): Promise<string | null> {
  const r = db
    .prepare('SELECT google_access_token, google_refresh_token, google_token_expires_at FROM tenants WHERE id=?')
    .get(tenantId) as
    | { google_access_token: string | null; google_refresh_token: string | null; google_token_expires_at: number | null }
    | undefined
  if (!r?.google_access_token) return null
  let token = dec(r.google_access_token)
  const expiresAt = Number(r.google_token_expires_at ?? 0)
  if (expiresAt && expiresAt - Date.now() < 120_000 && r.google_refresh_token) {
    try {
      const fresh = await refreshToken(dec(r.google_refresh_token))
      token = fresh.access_token
      db.prepare('UPDATE tenants SET google_access_token=?, google_token_expires_at=? WHERE id=?').run(
        enc(token),
        Date.now() + fresh.expires_in * 1000,
        tenantId,
      )
    } catch {
      if (expiresAt < Date.now()) return null
    }
  }
  return token
}
