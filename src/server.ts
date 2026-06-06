import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import QRCode from 'qrcode'
import { db } from './db.ts'
import {
  createTenant,
  findTenantByEmail,
  verifyPassword,
  createSession,
  getSessionTenant,
  deleteSession,
  ensureApiToken,
  getTenantByApiToken,
} from './auth.ts'
import * as acct from './accounts.ts'
import * as attio from './attio.ts'
import * as camp from './campaigns.ts'
import * as pol from './policy.ts'
import { startCampaign, pauseCampaign, campaignAccountIds } from './engine.ts'
import { render } from './engine.ts'
import { parseSequence, fallbackSequence, asSend, firstNode, type Sequence } from './sequence.ts'
import { aiAvailable } from './ai.ts'
import { igLeadAvailable } from './iglead.ts'
import * as src from './sourcing.ts'
import { landingView, authView, dashboardView, sourceView, qualifyingView } from './views.ts'

const isProd = process.env.NODE_ENV === 'production'
const PORT = Number(process.env.PORT ?? 8080)

const app = new Hono<{ Variables: { tenantId: string } }>()

// --- landing page is a Webflow clone that loads external CDN assets; relax CSP for '/' only ---
const LANDING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.prod.website-files.com https://d3e54v103j8qbb.cloudfront.net https://ajax.googleapis.com https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.prod.website-files.com https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.prod.website-files.com",
  "img-src 'self' data: https://cdn.prod.website-files.com",
  "connect-src 'self' https://cdn.prod.website-files.com",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')
// runs before secureHeaders → its response phase fires last and overrides CSP on '/'
app.use('*', async (c, next) => {
  await next()
  if (c.req.path === '/') c.header('Content-Security-Policy', LANDING_CSP)
})

// --- security headers ---
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'same-origin',
  }),
)

// --- CSRF: same-origin check on mutating requests (works with SameSite=Lax cookies) ---
app.use('*', async (c, next) => {
  const m = c.req.method
  if (m === 'POST' || m === 'PUT' || m === 'DELETE') {
    const origin = c.req.header('origin')
    if (origin) {
      try {
        if (new URL(origin).host !== c.req.header('host')) return c.text('bad origin', 403)
      } catch {
        return c.text('bad origin', 403)
      }
    }
  }
  await next()
})

// --- tiny in-memory rate limiter (per IP, for auth endpoints) ---
const hits = new Map<string, { n: number; reset: number }>()
function limited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now()
  const e = hits.get(key)
  if (!e || e.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs })
    return false
  }
  e.n++
  return e.n > max
}
const ipOf = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

const sessionCookie = (token: string) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: 60 * 60 * 24 * 30,
})

const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)

// --- auth guards ---
async function pageAuth(c: import('hono').Context<{ Variables: { tenantId: string } }>, next: () => Promise<void>) {
  const tenantId = getSessionTenant(getCookie(c, 'sid'))
  if (!tenantId) return c.redirect('/login')
  c.set('tenantId', tenantId)
  await next()
}
async function apiAuth(c: import('hono').Context<{ Variables: { tenantId: string } }>, next: () => Promise<void>) {
  // session cookie OR Bearer API token (for the MCP server / programmatic clients)
  let tenantId = getSessionTenant(getCookie(c, 'sid'))
  if (!tenantId) {
    const auth = c.req.header('authorization')
    const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
    tenantId = getTenantByApiToken(bearer)
  }
  if (!tenantId) return c.json({ ok: false, error: 'unauthorized' }, 401)
  c.set('tenantId', tenantId)
  await next()
}

const emailOf = (tenantId: string) =>
  (db.prepare('SELECT email FROM tenants WHERE id = ?').get(tenantId) as { email: string } | undefined)?.email ?? ''

// --- public pages ---
app.get('/', (c) => (getSessionTenant(getCookie(c, 'sid')) ? c.redirect('/outbound') : c.html(landingView())))
app.get('/login', (c) => c.html(authView('login')))
app.get('/signup', (c) => c.html(authView('signup')))

app.post('/signup', async (c) => {
  if (limited('signup:' + ipOf(c))) return c.html(authView('signup', 'Too many attempts. Try again shortly.'), 429)
  const body = await c.req.parseBody()
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!validEmail(email) || password.length < 8)
    return c.html(authView('signup', 'Enter a valid email and a password of at least 8 characters.'), 400)
  if (findTenantByEmail(email)) return c.html(authView('signup', 'That email is already registered.'), 409)
  const tenantId = createTenant(email, password)
  const token = createSession(tenantId)
  setCookie(c, 'sid', token, sessionCookie(token))
  return c.redirect('/outbound')
})

app.post('/login', async (c) => {
  if (limited('login:' + ipOf(c))) return c.html(authView('login', 'Too many attempts. Try again shortly.'), 429)
  const body = await c.req.parseBody()
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const tenant = findTenantByEmail(email)
  if (!tenant || !verifyPassword(password, tenant.password_hash))
    return c.html(authView('login', 'Invalid email or password.'), 401)
  const token = createSession(tenant.id)
  setCookie(c, 'sid', token, sessionCookie(token))
  return c.redirect('/outbound')
})

app.post('/logout', (c) => {
  deleteSession(getCookie(c, 'sid'))
  deleteCookie(c, 'sid', { path: '/' })
  return c.redirect('/')
})

// --- the three product tabs (auth) ---
app.get('/outbound', pageAuth, (c) => c.html(dashboardView(emailOf(c.get('tenantId')))))
app.get('/source', pageAuth, (c) => c.html(sourceView(emailOf(c.get('tenantId')))))
app.get('/qualifying', pageAuth, (c) => c.html(qualifyingView(emailOf(c.get('tenantId')))))
app.get('/app', pageAuth, (c) => c.redirect('/outbound')) // back-compat

// --- lead sourcing (Source tab): discover handles + find phones, fill a list ---
app.get('/api/source/lists', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const lists = camp.listLeadLists(tid).filter((l) => l.type === 'sourced')
  return c.json({ ok: true, lists, hiker: src.hikerAvailable(), ai: igLeadAvailable() })
})

app.post('/api/source/lists', apiAuth, async (c) => {
  try {
    const b = (await c.req.json()) as { name?: string; niche?: string; hashtags?: string[] }
    const niche = String(b.niche ?? b.name ?? '').trim()
    if (!niche) return c.json({ ok: false, error: 'niche required' }, 400)
    const tags = (b.hashtags ?? [])
      .map((t) => String(t).trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean)
    if (!tags.length) return c.json({ ok: false, error: 'at least one hashtag required' }, 400)
    const id = camp.createSourcedList(c.get('tenantId'), (b.name || niche).trim(), src.defaultConfig(niche, tags))
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.put('/api/source/lists/:id', apiAuth, async (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const list = camp.getLeadList(tid, id)
  if (!list || list.type !== 'sourced') return c.json({ ok: false, error: 'not found' }, 404)
  const cur = (JSON.parse(list.config).sourcing ?? {}) as src.SourcingConfig
  const b = (await c.req.json()) as Partial<src.SourcingConfig>
  const next: src.SourcingConfig = {
    ...cur,
    niche: b.niche != null ? String(b.niche).trim() : cur.niche,
    hashtags: Array.isArray(b.hashtags)
      ? b.hashtags.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
      : cur.hashtags,
    instruction: b.instruction != null ? String(b.instruction) : cur.instruction,
    targetPhones: Number.isFinite(b.targetPhones) ? Math.max(1, Math.min(500, Number(b.targetPhones))) : cur.targetPhones,
    refreshDays: Number.isFinite(b.refreshDays) ? Math.max(0, Math.min(60, Number(b.refreshDays))) : cur.refreshDays,
    minFollowers: Number.isFinite(b.minFollowers) ? Math.max(0, Number(b.minFollowers)) : cur.minFollowers,
    maxFollowers: Number.isFinite(b.maxFollowers) ? Math.max(1, Number(b.maxFollowers)) : cur.maxFollowers,
  }
  camp.updateSourcing(tid, id, next)
  return c.json({ ok: true })
})

app.post('/api/source/lists/:id/start', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const list = camp.getLeadList(tid, id)
  if (!list || list.type !== 'sourced') return c.json({ ok: false, error: 'not found' }, 404)
  if (!src.hikerAvailable()) return c.json({ ok: false, error: 'HIKER_API_KEY not set on the server' }, 400)
  void src.runSourcing(tid, id).catch(() => {})
  return c.json({ ok: true })
})

app.get('/api/source/lists/:id/status', apiAuth, (c) => {
  const st = src.sourcingStatus(c.get('tenantId'), Number(c.req.param('id')))
  if (!st) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, ...st })
})

app.delete('/api/source/lists/:id', apiAuth, (c) => {
  camp.deleteLeadList(c.get('tenantId'), Number(c.req.param('id')))
  return c.json({ ok: true })
})

// --- accounts (multiple WhatsApp numbers per tenant; baileys + cloud) ---
app.get('/api/accounts', apiAuth, (c) => c.json({ ok: true, accounts: acct.listAccounts(c.get('tenantId')) }))

app.post('/api/accounts', apiAuth, async (c) => {
  try {
    const { type, label, config } = (await c.req.json()) as {
      type?: 'baileys' | 'cloud'
      label?: string
      config?: Record<string, unknown>
    }
    if (type !== 'baileys' && type !== 'cloud') return c.json({ ok: false, error: 'type must be baileys or cloud' }, 400)
    if (!label) return c.json({ ok: false, error: 'label required' }, 400)
    const id = await acct.createAccount(c.get('tenantId'), type, label.trim(), config ?? {})
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.delete('/api/accounts/:id', apiAuth, async (c) => {
  await acct.deleteAccount(c.get('tenantId'), c.req.param('id'))
  return c.json({ ok: true })
})

app.put('/api/accounts/:id/profile', apiAuth, async (c) => {
  if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
  const { profileId } = (await c.req.json()) as { profileId?: number | null }
  acct.setProfile(c.get('tenantId'), c.req.param('id'), profileId ?? null)
  return c.json({ ok: true })
})

// Per-number send policy: warmup (tier 1), distribution weight + daily cap (tier 2), send window (tier 4).
app.put('/api/accounts/:id/policy', apiAuth, async (c) => {
  if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
  const body = (await c.req.json()) as Partial<import('./policy.ts').SendPolicy>
  const patch: Partial<import('./policy.ts').SendPolicy> = {}
  if (typeof body.warmupEnabled === 'boolean') patch.warmupEnabled = body.warmupEnabled
  if (Number.isFinite(body.weight)) patch.weight = Math.max(1, Math.min(20, Math.round(body.weight as number)))
  if (Number.isFinite(body.dailyCap)) patch.dailyCap = Math.max(1, Math.min(5000, Math.round(body.dailyCap as number)))
  if (Number.isFinite(body.windowStart)) patch.windowStart = Math.max(0, Math.min(23, Math.round(body.windowStart as number)))
  if (Number.isFinite(body.windowEnd)) patch.windowEnd = Math.max(0, Math.min(24, Math.round(body.windowEnd as number)))
  const policy = pol.setPolicy(c.req.param('id'), patch)
  return c.json({ ok: true, policy })
})

const ownsAccount = (c: import('hono').Context<{ Variables: { tenantId: string } }>) =>
  acct.getAccount(c.get('tenantId'), c.req.param('id'))

app.post('/api/accounts/:id/connect', apiAuth, async (c) => {
  if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
  await acct.connect(c.get('tenantId'), c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/accounts/:id/disconnect', apiAuth, async (c) => {
  if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
  await acct.disconnect(c.get('tenantId'), c.req.param('id'))
  return c.json({ ok: true })
})

app.get('/api/accounts/:id/status', apiAuth, (c) => {
  if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json(acct.status(c.req.param('id')))
})

app.get('/api/accounts/:id/qr.png', apiAuth, async (c) => {
  if (!ownsAccount(c)) return c.text('not found', 404)
  const qr = acct.getQr(c.req.param('id'))
  if (!qr) return c.text('no qr', 404)
  const png = await QRCode.toBuffer(qr, { width: 320, margin: 2 })
  return c.body(png, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
})

app.post('/api/accounts/:id/send', apiAuth, async (c) => {
  try {
    if (!ownsAccount(c)) return c.json({ ok: false, error: 'not found' }, 404)
    const { to, text } = (await c.req.json()) as { to?: string; text?: string }
    if (!to || !text) return c.json({ ok: false, error: 'to and text required' }, 400)
    const id = await acct.send(c.req.param('id'), to, text)
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// --- send templates (reusable 3-knob engine presets, applied to a Send block) ---
app.get('/api/profiles', apiAuth, (c) =>
  c.json({ ok: true, profiles: camp.listProfiles(c.get('tenantId')), defaults: camp.DEFAULT_TEMPLATE }),
)
app.post('/api/profiles', apiAuth, async (c) => {
  try {
    const { name, config } = (await c.req.json()) as { name?: string; config?: Record<string, unknown> }
    if (!name) return c.json({ ok: false, error: 'name required' }, 400)
    const id = camp.createProfile(c.get('tenantId'), name.trim(), config ?? {})
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})
app.put('/api/profiles/:id', apiAuth, async (c) => {
  const { name, config } = (await c.req.json()) as { name?: string; config?: Record<string, unknown> }
  if (!name) return c.json({ ok: false, error: 'name required' }, 400)
  camp.updateProfile(c.get('tenantId'), Number(c.req.param('id')), name.trim(), config ?? {})
  return c.json({ ok: true })
})
app.delete('/api/profiles/:id', apiAuth, (c) => {
  camp.deleteProfile(c.get('tenantId'), Number(c.req.param('id')))
  return c.json({ ok: true })
})

// --- Attio integration ---
app.post('/api/attio/connect', apiAuth, async (c) => {
  try {
    const { key } = (await c.req.json()) as { key?: string }
    if (!key || key.length < 10) return c.json({ ok: false, error: 'paste your Attio API key' }, 400)
    const ws = await attio.testKey(key.trim())
    camp.saveAttioKey(c.get('tenantId'), key.trim())
    return c.json({ ok: true, workspace: ws.workspace_name ?? 'connected' })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

const attioKey = (c: import('hono').Context<{ Variables: { tenantId: string } }>) => camp.getAttioKey(c.get('tenantId'))

app.get('/api/attio/objects', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  try {
    return c.json({ ok: true, objects: await attio.listObjects(key) })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.get('/api/attio/objects/:obj/attributes', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  try {
    return c.json({ ok: true, attributes: await attio.listObjectAttributes(key, c.req.param('obj')) })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.get('/api/attio/objects/:obj/lists', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  try {
    return c.json({ ok: true, lists: await attio.listLists(key, c.req.param('obj')) })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// Auto-mapping: suggest which attributes are phone/name/email/IG/link (skipping empty fields),
// so the UI fills the mapping in for the user instead of asking them to pick every column.
app.get('/api/attio/objects/:obj/suggest', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  const obj = c.req.param('obj')
  try {
    const attrs = await attio.listObjectAttributes(key, obj)
    const coverage = await attio.sampleCoverage(key, obj).catch(() => ({}))
    const channelSlug = attio.channelSelectSlug(attrs)
    const channelOptions = channelSlug ? await attio.listSelectOptions(key, obj, channelSlug).catch(() => []) : []
    const hasEmail = attrs.some((a) => a.type === 'email-address')
    return c.json({ ok: true, mapping: attio.suggestMapping(attrs, coverage), coverage, channelOptions, hasEmail })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// --- saved lead lists (the sources a campaign's Lead-list block pulls from) ---
app.get('/api/lists', apiAuth, (c) => c.json({ ok: true, lists: camp.listLeadLists(c.get('tenantId')) }))

app.post('/api/lists/csv', apiAuth, async (c) => {
  try {
    const { name, csv } = (await c.req.json()) as { name?: string; csv?: string }
    if (!csv) return c.json({ ok: false, error: 'csv text required' }, 400)
    const { contacts, scanned, noPhone } = camp.csvToContacts(csv)
    if (!contacts.length) return c.json({ ok: false, error: 'no rows with a phone column found' }, 400)
    const id = camp.createCsvList(c.get('tenantId'), (name || 'CSV list').trim(), contacts)
    return c.json({ ok: true, id, size: contacts.length, scanned, noPhone })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.post('/api/lists/attio', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  try {
    const b = (await c.req.json()) as {
      name?: string
      object?: string
      listId?: string
      mapping?: attio.AttioMapping
      filter?: attio.AttioFilterConfig
    }
    if (!b.object || !b.mapping?.phone) return c.json({ ok: false, error: 'object and phone mapping required' }, 400)
    const id = camp.createAttioList(c.get('tenantId'), (b.name || 'Attio list').trim(), {
      object: b.object,
      listId: b.listId || undefined,
      mapping: b.mapping,
      filter: b.filter,
    })
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.delete('/api/lists/:id', apiAuth, (c) => {
  camp.deleteLeadList(c.get('tenantId'), Number(c.req.param('id')))
  return c.json({ ok: true })
})
app.get('/api/lists/:id/contacts', apiAuth, async (c) => {
  const rows = await camp.previewListContacts(c.get('tenantId'), Number(c.req.param('id')))
  return c.json({ ok: true, contacts: rows })
})

// --- API token (for the MCP server). Cookie-auth only; never exposed via bearer. ---
app.get('/api/token', apiAuth, (c) => {
  if (!getSessionTenant(getCookie(c, 'sid'))) return c.json({ ok: false, error: 'use the web session' }, 403)
  return c.json({ ok: true, token: ensureApiToken(c.get('tenantId')) })
})

// --- settings (AI availability + Attio write-back toggle) ---
app.get('/api/settings', apiAuth, (c) =>
  c.json({
    ok: true,
    ai: aiAvailable(),
    attioConnected: !!camp.getAttioKey(c.get('tenantId')),
    writeback: camp.getWriteback(c.get('tenantId')),
  }),
)
app.post('/api/settings/writeback', apiAuth, async (c) => {
  const { on } = (await c.req.json()) as { on?: boolean }
  camp.setWriteback(c.get('tenantId'), !!on)
  return c.json({ ok: true })
})

// --- contacts ---
app.get('/api/contacts', apiAuth, (c) => {
  const tid = c.get('tenantId')
  return c.json({ ok: true, ...camp.countContacts(tid), sample: camp.listContacts(tid, 20) })
})

// --- campaigns ---
app.get('/api/campaigns', apiAuth, (c) => c.json({ ok: true, campaigns: camp.listCampaigns(c.get('tenantId')) }))

app.post('/api/campaigns', apiAuth, async (c) => {
  try {
    const b = (await c.req.json()) as Record<string, any>
    if (!b.name) return c.json({ ok: false, error: 'name required' }, 400)
    const id = camp.createCampaign(c.get('tenantId'), {
      name: String(b.name).trim(),
      sequence: (b.sequence as Sequence) ?? null,
      accountIds: Array.isArray(b.accountIds) ? b.accountIds.map(String) : [],
      cloudTemplate: b.cloudTemplate ?? null,
      cloudLang: b.cloudLang ?? null,
    })
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.get('/api/campaigns/:id', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const campaign = camp.getCampaign(tid, id)
  if (!campaign) return c.json({ ok: false, error: 'not found' }, 404)
  const seq = parseSequence(campaign.sequence) ?? fallbackSequence(campaign.template)
  return c.json({
    ok: true,
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    sequence: seq,
    accountIds: camp.getCampaignAccounts(id),
    leads: camp.listLeads(tid, id),
    stats: camp.campaignStats(id),
  })
})

app.put('/api/campaigns/:id', apiAuth, async (c) => {
  try {
    const tid = c.get('tenantId')
    const id = Number(c.req.param('id'))
    if (!camp.getCampaign(tid, id)) return c.json({ ok: false, error: 'not found' }, 404)
    const b = (await c.req.json()) as Record<string, any>
    camp.updateCampaign(tid, id, {
      name: b.name != null ? String(b.name).trim() : undefined,
      sequence: (b.sequence as Sequence) ?? undefined,
      accountIds: Array.isArray(b.accountIds) ? b.accountIds.map(String) : undefined,
      cloudTemplate: b.cloudTemplate,
      cloudLang: b.cloudLang,
    })
    // attaching/refreshing a list? pull an initial batch so the lead table fills immediately
    if (b.sequence) void camp.fetchAndEnroll(tid, id).catch(() => {})
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.delete('/api/campaigns/:id', apiAuth, (c) => {
  camp.deleteCampaign(c.get('tenantId'), Number(c.req.param('id')))
  return c.json({ ok: true })
})

app.get('/api/campaigns/:id/leads', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  if (!camp.getCampaign(tid, id)) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, leads: camp.listLeads(tid, id), stats: camp.campaignStats(id) })
})

app.post('/api/campaigns/:id/fetch', apiAuth, async (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  if (!camp.getCampaign(tid, id)) return c.json({ ok: false, error: 'not found' }, 404)
  try {
    const r = await camp.fetchAndEnroll(tid, id)
    return c.json({ ok: true, ...r })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// Preview: render the campaign's first Send block against a few real leads.
app.get('/api/campaigns/:id/preview', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const campaign = camp.getCampaign(tid, id)
  if (!campaign) return c.json({ ok: false, error: 'not found' }, 404)
  const seq = parseSequence(campaign.sequence) ?? fallbackSequence(campaign.template)
  const sendNode = seq.nodes.find((n) => n.type === 'send')
  const send = asSend(sendNode)
  const leads = camp.listLeads(tid, id, 5)
  const samples = leads.map((l) => {
    const vars: Record<string, string> = {}
    if (l.name) vars.name = l.name
    if (l.instagram_handle) vars.instagram_handle = l.instagram_handle
    if (l.event_link) vars.instagram_link = l.event_link
    return { to: l.name || l.phone, handle: l.instagram_handle, text: render(send?.message ?? '', vars) }
  })
  return c.json({ ok: true, message: send?.message ?? '', samples, hasLeads: leads.length > 0 })
})

app.post('/api/campaigns/:id/start', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const campaign = camp.getCampaign(tid, id)
  if (!campaign) return c.json({ ok: false, error: 'not found' }, 404)
  const accts = campaignAccountIds(id)
  if (!accts.length) return c.json({ ok: false, error: 'select at least one WhatsApp number' }, 400)
  if (!accts.some((a) => acct.isConnected(a)))
    return c.json({ ok: false, error: 'none of the selected numbers are connected' }, 400)
  try {
    startCampaign(tid, id)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.post('/api/campaigns/:id/pause', apiAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!camp.getCampaign(c.get('tenantId'), id)) return c.json({ ok: false, error: 'not found' }, 404)
  pauseCampaign(c.get('tenantId'), id)
  return c.json({ ok: true })
})

app.get('/healthz', (c) => c.text('ok'))

serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`WA Connect listening on :${info.port}`))
