import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { randomBytes } from 'node:crypto'
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
import * as ig from './instagram.ts'
import * as camp from './campaigns.ts'
import * as pol from './policy.ts'
import { startCampaign, pauseCampaign, campaignAccountIds, fireFirstNow } from './engine.ts'
import { render } from './engine.ts'
import { parseSequence, fallbackSequence, asSend, firstNode, type Sequence } from './sequence.ts'
import { aiAvailable } from './ai.ts'
import { igLeadAvailable } from './iglead.ts'
import * as src from './sourcing.ts'
import * as dedupe from './dedupe.ts'
import * as qual from './qualify.ts'
import * as google from './google.ts'
import * as onb from './onboarding.ts'
import * as brands from './brands.ts'
import * as pitchgen from './pitchgen.ts'
import * as templates from './templates.ts'
import { fetchPageText } from './ai.ts'
import { createTenantWithGoogle } from './auth.ts'
import { landingView, authView, dashboardView, onboardingView, startOnboardingView, sourceView, qualifyingView, brandsView, creatorIqView, matchView, proposalPublicView } from './views.ts'
import * as creatoriq from './creatoriq.ts'
import * as brandmatch from './brandmatch.ts'
import * as proposals from './proposals.ts'

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

// --- TEMP: cross-origin CORS for the one-off onbento brand seed ingest (/api/seed/*).
// Secret-gated (see route); exists only to let the in-browser harvester POST from app.onbento.com.
const SEED_ORIGIN = process.env.SEED_ALLOW_ORIGIN ?? 'https://app.onbento.com'
app.use('/api/seed/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', SEED_ORIGIN)
  c.header('Access-Control-Allow-Headers', 'content-type, x-seed-secret')
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// --- CSRF: same-origin check on mutating requests (works with SameSite=Lax cookies) ---
app.use('*', async (c, next) => {
  const m = c.req.method
  if ((m === 'POST' || m === 'PUT' || m === 'DELETE') && !c.req.path.startsWith('/api/seed/')) {
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

// Public proposal page — NO auth: the opaque token IS the access control. GROSS-ONLY rendering.
app.get('/p/:token', (c) => {
  const proposal = proposals.getProposalByToken(c.req.param('token'))
  if (!proposal) return c.text('not found', 404)
  return c.html(proposalPublicView(proposal))
})

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
  return c.redirect(postAuthRedirect(tenantId))
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
  return c.redirect(postAuthRedirect(tenant.id))
})

// New / unfinished users land in the intake wizard; everyone else lands on the dashboard.
function postAuthRedirect(tenantId: string): string {
  return onb.hasIntake(tenantId) ? '/dashboard' : '/start-onboarding'
}

app.post('/logout', (c) => {
  deleteSession(getCookie(c, 'sid'))
  deleteCookie(c, 'sid', { path: '/' })
  return c.redirect('/')
})

// --- the three product tabs (auth) ---
app.get('/dashboard', pageAuth, (c) => c.html(onboardingView(emailOf(c.get('tenantId')))))
app.get('/outbound', pageAuth, (c) => c.html(dashboardView(emailOf(c.get('tenantId')))))
app.get('/source', pageAuth, (c) => c.html(sourceView(emailOf(c.get('tenantId')))))
app.get('/qualifying', pageAuth, (c) => c.html(qualifyingView(emailOf(c.get('tenantId')))))
app.get('/creator-iq', pageAuth, (c) => c.html(creatorIqView(emailOf(c.get('tenantId')))))
app.get('/match', pageAuth, (c) => c.html(matchView(emailOf(c.get('tenantId')))))
app.get('/dashboard/brands', pageAuth, (c) => c.html(brandsView(emailOf(c.get('tenantId')))))
app.get('/brands', pageAuth, (c) => c.redirect('/dashboard/brands')) // back-compat
app.get('/api/brands', apiAuth, (c) => {
  const q = c.req.query()
  // Shared global catalog — every tenant sees the same brands (not scoped to c.get('tenantId')).
  const data = brands.listBrands({
    search: q.search,
    category: q.category,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  })
  return c.json({ ok: true, ...data })
})
app.get('/api/brands/categories', apiAuth, (c) => c.json({ ok: true, categories: brands.categoryFacets() }))
app.get('/app', pageAuth, (c) => c.redirect('/outbound')) // back-compat

// --- onboarding (2-step intake wizard; stores per-tenant, then migrates to /dashboard) ---
app.get('/start-onboarding', pageAuth, (c) => c.html(startOnboardingView(emailOf(c.get('tenantId')))))

app.get('/api/onboarding', apiAuth, (c) => c.json({ ok: true, ...onb.snapshot(c.get('tenantId')) }))

app.post('/api/onboarding/intake', apiAuth, async (c) => {
  try {
    const b = (await c.req.json()) as Record<string, any>
    const name = String(b.name ?? '').trim()
    const roles = Array.isArray(b.roles) ? b.roles.map(String) : []
    const pitchTo = String(b.pitchTo ?? '').trim()
    if (!name) return c.json({ ok: false, error: 'name required' }, 400)
    if (!roles.length) return c.json({ ok: false, error: 'select who you are' }, 400)
    if (!pitchTo) return c.json({ ok: false, error: 'tell us who you want to pitch to' }, 400)
    onb.saveIntake(c.get('tenantId'), {
      name,
      roles,
      pitchTo,
      journey: String(b.journey ?? ''),
      heardFrom: String(b.heardFrom ?? ''),
      brandCategories: Array.isArray(b.brandCategories) ? b.brandCategories.map(String) : [],
    })
    return c.json({ ok: true, next: '/dashboard' })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.post('/api/onboarding/link', apiAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { link?: unknown }
  const link = typeof body.link === 'string' ? body.link.trim() : ''
  if (!/^https?:\/\/.+/i.test(link)) return c.json({ ok: false, error: 'enter a valid URL' }, 400)
  onb.setLink(c.get('tenantId'), link)
  return c.json({ ok: true })
})

app.post('/api/onboarding/pitch-template', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { body?: unknown }
  const body = typeof b.body === 'string' ? b.body : ''
  if (!body.trim()) return c.json({ ok: false, error: 'write your pitch' }, 400)
  onb.setPitchTemplate(c.get('tenantId'), body)
  return c.json({ ok: true })
})

app.post('/api/onboarding/followup-template', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { body?: unknown }
  const body = typeof b.body === 'string' ? b.body : ''
  if (!body.trim()) return c.json({ ok: false, error: 'write your follow-up' }, 400)
  onb.setFollowupTemplate(c.get('tenantId'), body)
  return c.json({ ok: true })
})

// "Bento writes it" — generate a reusable pitch/follow-up template via GPT-5.4-mini + the pitch
// guide. Both kinds share this; only `kind` (and the prior pitch passed to follow-ups) differs.
async function runGenerate(c: import('hono').Context, kind: pitchgen.PitchKind) {
  if (!pitchgen.pitchGenAvailable()) return c.json({ ok: false, error: 'AI is not configured (OPENAI_API_KEY)' }, 400)
  const b = (await c.req.json().catch(() => ({}))) as {
    about?: string
    aboutUrl?: string
    aboutText?: string
    work?: string
    workUrl?: string
  }
  const snap = onb.snapshot(c.get('tenantId'))
  const profile = snap.profile ?? { name: '', roles: [], pitchTo: '', brandCategories: [] }

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const aboutIsUrl = str(b.about).toLowerCase() !== 'write about yourself' // dropdown: "Portfolio" vs "Write about yourself"
  const portfolioUrl = str(b.aboutUrl)
  const workUrl = str(b.workUrl)

  // Best-effort: pull real text from the portfolio + best-work links so the pitch is grounded.
  const [portfolioText, workText] = await Promise.all([
    aboutIsUrl && portfolioUrl ? fetchPageText(portfolioUrl) : Promise.resolve(''),
    workUrl ? fetchPageText(workUrl) : Promise.resolve(''),
  ])

  const result = await pitchgen.generate({
    kind,
    name: profile.name,
    roles: profile.roles,
    pitchTo: profile.pitchTo,
    brandCategories: profile.brandCategories,
    aboutText: aboutIsUrl ? '' : str(b.aboutText),
    portfolioUrl: aboutIsUrl ? portfolioUrl : '',
    portfolioText,
    workKind: str(b.work),
    workUrl,
    workText,
    priorPitchBody: kind === 'followup' ? snap.pitchTemplate : '',
  })
  const noun = kind === 'followup' ? 'follow-up' : 'pitch'
  if (!result) return c.json({ ok: false, error: `could not generate a ${noun} — try again` }, 502)
  return c.json({ ok: true, ...result })
}

app.post('/api/onboarding/generate-pitch', apiAuth, (c) => runGenerate(c, 'outreach'))
app.post('/api/onboarding/generate-followup', apiAuth, (c) => runGenerate(c, 'followup'))

// --- saved templates (the "Modify your template" editor: persist + save-as-new) ---
// Saving also ticks the matching onboarding step (pitch -> outreach, follow-up -> followup) so the
// checklist reflects that at least one template of that kind now exists.
function markTemplateStep(tenantId: string, type: string, body: string) {
  if (type === 'followup') onb.setFollowupTemplate(tenantId, body)
  else onb.setPitchTemplate(tenantId, body)
}

app.get('/api/templates', apiAuth, (c) => {
  const type = c.req.query('type')
  return c.json({ ok: true, templates: templates.listTemplates(c.get('tenantId'), type) })
})

app.post('/api/templates', apiAuth, async (c) => {
  try {
    const b = (await c.req.json()) as templates.TemplateInput
    const row = templates.createTemplate(c.get('tenantId'), b)
    markTemplateStep(c.get('tenantId'), row.type, row.body)
    return c.json({ ok: true, template: row })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.put('/api/templates/:id', apiAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ ok: false, error: 'invalid template id' }, 400)
    const b = (await c.req.json()) as templates.TemplateInput
    const row = templates.updateTemplate(c.get('tenantId'), id, b)
    markTemplateStep(c.get('tenantId'), row.type, row.body)
    return c.json({ ok: true, template: row })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.delete('/api/templates/:id', apiAuth, (c) => {
  try {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ ok: false, error: 'invalid template id' }, 400)
    templates.deleteTemplate(c.get('tenantId'), id)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// --- "Continue with Google" + Gmail read/send ---
// Redirect URI must exactly match one registered on the OAuth client. Defaults to this host.
function googleRedirectUri(c: import('hono').Context): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI
  const proto = c.req.header('x-forwarded-proto') ?? (isProd ? 'https' : 'http')
  return `${proto}://${c.req.header('host')}/auth/google/callback`
}

// Start OAuth. Works logged-out (sign-in/sign-up) or logged-in (connect Gmail to this tenant).
app.get('/auth/google', (c) => {
  if (!google.googleConfigured()) return c.redirect('/login?google=unconfigured')
  if (limited('google:' + ipOf(c), 20)) return c.redirect('/login?google=ratelimited')
  const state = randomBytes(16).toString('hex')
  setCookie(c, 'g_state', state, { httpOnly: true, secure: isProd, sameSite: 'Lax', path: '/', maxAge: 600 })
  return c.redirect(google.authorizeUrl(googleRedirectUri(c), state))
})

app.get('/auth/google/callback', async (c) => {
  if (c.req.query('error')) return c.redirect('/login?google=denied')
  const code = c.req.query('code')
  const state = c.req.query('state')
  const saved = getCookie(c, 'g_state')
  deleteCookie(c, 'g_state', { path: '/' })
  if (!code || !state || !saved || state !== saved) return c.redirect('/login?google=badstate')

  const sessionTenant = getSessionTenant(getCookie(c, 'sid'))
  try {
    if (sessionTenant) {
      // logged-in: connect Gmail to the existing tenant
      await google.completeConnect(sessionTenant, code, googleRedirectUri(c))
      return c.redirect(onb.hasIntake(sessionTenant) ? '/outbound?google=connected' : '/start-onboarding?google=connected')
    }
    // logged-out: exchange once, resolve identity, find-or-create tenant, start a session
    const r = await google.exchangeAndIdentify(code, googleRedirectUri(c))
    let tenantId = google.findTenantByGoogleSub(r.sub)
    if (!tenantId) {
      const existing = findTenantByEmail(r.email.toLowerCase())
      tenantId = existing?.id ?? createTenantWithGoogle(r.email.toLowerCase())
    }
    google.saveConnection(tenantId, {
      email: r.email,
      sub: r.sub,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? null,
      expiresAt: r.expiresAt,
    })
    const token = createSession(tenantId)
    setCookie(c, 'sid', token, sessionCookie(token))
    return c.redirect(postAuthRedirect(tenantId))
  } catch {
    return c.redirect('/login?google=error')
  }
})

app.get('/api/google/status', apiAuth, (c) =>
  c.json({ ok: true, configured: google.googleConfigured(), ...google.getConnection(c.get('tenantId')) }),
)

app.post('/api/google/disconnect', apiAuth, (c) => {
  google.clearConnection(c.get('tenantId'))
  return c.json({ ok: true })
})

// --- lead sourcing (Source tab): discover handles + find phones, fill a list ---
app.get('/api/source/lists', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const lists = camp.listLeadLists(tid).filter((l) => l.type === 'sourced')
  return c.json({ ok: true, lists, hiker: src.hikerAvailable(), ai: igLeadAvailable() })
})

app.post('/api/source/lists', apiAuth, async (c) => {
  try {
    const b = (await c.req.json()) as { name?: string; niche?: string; hashtags?: string[]; targetHandles?: number; targetPhones?: number }
    const niche = String(b.niche ?? b.name ?? '').trim()
    if (!niche) return c.json({ ok: false, error: 'niche required' }, 400)
    const tags = (b.hashtags ?? [])
      .map((t) => String(t).trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean)
    if (!tags.length) return c.json({ ok: false, error: 'at least one hashtag required' }, 400)
    const cfg = src.defaultConfig(niche, tags)
    if (Number.isFinite(b.targetHandles)) cfg.targetHandles = Math.max(1, Math.min(2000, Number(b.targetHandles)))
    if (Number.isFinite(b.targetPhones)) cfg.targetPhones = Math.max(1, Math.min(500, Number(b.targetPhones)))
    const id = camp.createSourcedList(c.get('tenantId'), (b.name || niche).trim(), cfg)
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
    targetHandles: Number.isFinite(b.targetHandles) ? Math.max(1, Math.min(2000, Number(b.targetHandles))) : cur.targetHandles,
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

// Create a blank, manually-fillable list with an auto name ("New list N").
app.post('/api/source/lists/blank', apiAuth, (c) => {
  const tid = c.get('tenantId')
  const name = camp.nextDefaultListName(tid)
  const id = camp.createSourcedList(tid, name, src.defaultConfig('', []))
  return c.json({ ok: true, id, name })
})

const rowFromBody = (b: Record<string, unknown>) => ({
  name: (b.name as string)?.trim() || null,
  phone: String((b.phone as string) ?? '').trim(),
  instagram_handle: (b.instagram_handle as string)?.trim().replace(/^@/, '') || null,
  event_link: (b.event_link as string)?.trim() || null,
  category: (b.category as string)?.trim() || null,
  source: 'manual',
})

// Manual row CRUD on a list's table.
app.post('/api/source/lists/:id/rows', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const ok = camp.addListRow(c.get('tenantId'), Number(c.req.param('id')), rowFromBody(b))
  return c.json({ ok })
})
app.put('/api/source/lists/:id/rows/:idx', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const ok = camp.updateListRow(c.get('tenantId'), Number(c.req.param('id')), Number(c.req.param('idx')), rowFromBody(b))
  return c.json({ ok })
})
app.delete('/api/source/lists/:id/rows/:idx', apiAuth, (c) => {
  const ok = camp.deleteListRow(c.get('tenantId'), Number(c.req.param('id')), Number(c.req.param('idx')))
  return c.json({ ok })
})

// AI dedupe + cleanup pass over a list's table (gpt-5.4, strict schema). Caps at 300 rows/call.
app.post('/api/source/lists/:id/dedupe', apiAuth, async (c) => {
  if (!dedupe.dedupeAvailable()) return c.json({ ok: false, error: 'OPENAI_API_KEY not set on the server' }, 400)
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const rows = camp.getListRows(tid, id)
  if (!rows.length) return c.json({ ok: true, removed: 0, modified: 0, note: 'list is empty' })
  const CAP = 300
  const head = rows.slice(0, CAP)
  const tail = rows.slice(CAP)
  try {
    const ops = await dedupe.dedupe(head.map((r) => ({
      instagram_handle: r.instagram_handle ?? null,
      name: r.name ?? null,
      phone: r.phone || null,
      event_link: r.event_link ?? null,
      category: r.category ?? null,
    })))
    const applied = dedupe.applyOps(head as Record<string, unknown>[] as never, ops)
    camp.setListRows(tid, id, [...(applied.rows as unknown as typeof rows), ...tail])
    return c.json({ ok: true, removed: applied.removed, modified: applied.modified, capped: rows.length > CAP })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// Import from Attio → ADD the pulled rows onto an existing list (materialized once, not a live list).
app.post('/api/source/lists/:id/import-attio', apiAuth, async (c) => {
  const key = attioKey(c)
  if (!key) return c.json({ ok: false, error: 'connect Attio first' }, 400)
  const id = Number(c.req.param('id'))
  const list = camp.getLeadList(c.get('tenantId'), id)
  if (!list) return c.json({ ok: false, error: 'list not found' }, 404)
  try {
    const b = (await c.req.json()) as { object?: string; listId?: string; mapping?: attio.AttioMapping; filter?: attio.AttioFilterConfig }
    if (!b.object || !b.mapping) return c.json({ ok: false, error: 'object and mapping required' }, 400)
    const pull = await attio.pullContacts(key, { object: b.object, listId: b.listId || undefined, mapping: b.mapping, filter: b.filter })
    const rows = pull.contacts.map((ct) => ({
      name: ct.name,
      phone: ct.phone || '',
      instagram_handle: ct.vars.instagram_handle ?? null,
      event_link: ct.vars.event_link ?? null,
      category: ct.vars.category ?? null,
      source: 'attio',
      vars: ct.vars,
    }))
    const added = camp.addListRows(c.get('tenantId'), id, rows)
    return c.json({ ok: true, added, total: pull.total, skippedNoPhone: pull.skipped.noPhone, skippedSuppressed: pull.skipped.suppressed })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

// --- lead qualifying (Qualifying tab): score a list's rows against an ICP description ---
// Lists that can be qualified = anything with stored rows (sourced + csv/imported).
app.get('/api/qualify/lists', apiAuth, (c) => {
  const lists = camp.listLeadLists(c.get('tenantId')).filter((l) => l.type === 'sourced' || l.type === 'csv')
  return c.json({ ok: true, lists, ai: qual.qualifyAvailable() })
})

// Snapshot: progress, scored rows, tier counts, current criteria.
app.get('/api/qualify/lists/:id/status', apiAuth, (c) => {
  const st = qual.qualifyStatus(c.get('tenantId'), Number(c.req.param('id')))
  if (!st) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, ...st })
})

// Save the edited criteria prompt without running.
app.put('/api/qualify/lists/:id', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { criteria?: string }
  const ok = qual.saveCriteria(c.get('tenantId'), Number(c.req.param('id')), String(b.criteria ?? '').trim())
  return c.json({ ok })
})

// Run the qualifier over the whole list (background). Persists criteria first if provided.
app.post('/api/qualify/lists/:id/run', apiAuth, async (c) => {
  if (!qual.qualifyAvailable()) return c.json({ ok: false, error: 'OPENAI_API_KEY not set on the server' }, 400)
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as { criteria?: string }
  if (typeof b.criteria === 'string' && b.criteria.trim()) qual.saveCriteria(tid, id, b.criteria.trim())
  if (!camp.getLeadList(tid, id)) return c.json({ ok: false, error: 'not found' }, 404)
  void qual.runQualify(tid, id).catch(() => {})
  return c.json({ ok: true })
})

// Spin off a NEW csv list containing only the qualified rows (score >= min). `min`: 70 hot, 40 warm+.
app.post('/api/qualify/lists/:id/spinoff', apiAuth, async (c) => {
  const tid = c.get('tenantId')
  const id = Number(c.req.param('id'))
  const list = camp.getLeadList(tid, id)
  if (!list) return c.json({ ok: false, error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { min?: number; name?: string }
  const min = Number.isFinite(b.min) ? Math.max(0, Math.min(100, Number(b.min))) : 70
  const rows = qual.qualifiedRows(tid, id, min)
  if (!rows.length) return c.json({ ok: false, error: 'no leads at or above that score' }, 400)
  const tierName = min >= 70 ? 'hot' : min >= 40 ? 'warm+' : 'scored'
  const name = (b.name && String(b.name).trim()) || `${list.name} — ${tierName} (${rows.length})`
  const newId = camp.createCsvList(tid, name, rows)
  return c.json({ ok: true, id: newId, name, count: rows.length })
})

// --- Creator IQ (stage 1): build ONE structured creator profile for this tenant ---
// Start generation (background). The runner writes status:'error' to the row on failure, surfaced by /status.
app.post('/api/creator-iq/generate', apiAuth, (c) => {
  if (!creatoriq.creatorIqAvailable())
    return c.json({ ok: false, error: 'OPENAI_API_KEY not set on the server' }, 400)
  const tid = c.get('tenantId')
  void creatoriq.runCreatorIq(tid).catch(() => {})
  return c.json({ ok: true })
})

// Snapshot the FE polls (~2.5s while running): status/error/signalsUsed/demographics + profile.
app.get('/api/creator-iq/status', apiAuth, (c) => {
  const st = creatoriq.creatorIqStatus(c.get('tenantId'))
  if (!st) return c.json({ ok: false, error: 'no profile' }, 404)
  return c.json({ ok: true, ...st })
})

// --- Brand matching (stage 2): rank a shortlist of target brands for a creator profile ---
// Creators that HAVE a profile row — the selectable input for the match page.
app.get('/api/match/creators', apiAuth, (c) =>
  c.json({
    ok: true,
    creators: brandmatch.matchableCreators(c.get('tenantId')),
    ai: brandmatch.matchAvailable(),
    hiker: src.hikerAvailable(),
  }),
)

// Snapshot the ranked shortlist (404 if no profile row for this creator).
app.get('/api/match/:creatorId/status', apiAuth, (c) => {
  const st = brandmatch.matchStatus(c.get('tenantId'), Number(c.req.param('creatorId')))
  if (!st) return c.json({ ok: false, error: 'no profile' }, 404)
  return c.json({ ok: true, ...st })
})

// Run the matcher (background). The runner records errors on the run-state, surfaced by /status.
app.post('/api/match/:creatorId/run', apiAuth, (c) => {
  if (!brandmatch.matchAvailable())
    return c.json({ ok: false, error: 'OPENAI_API_KEY not set on the server' }, 400)
  void brandmatch.runMatch(c.get('tenantId'), Number(c.req.param('creatorId'))).catch(() => {})
  return c.json({ ok: true })
})

// Mark a shortlist row selected/rejected (user action).
app.post('/api/match/:creatorId/select', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { brandId?: number; matchId?: number; status?: string }
  const brandId = Number(b.brandId ?? b.matchId)
  const status = b.status === 'selected' || b.status === 'rejected' || b.status === 'suggested' ? b.status : undefined
  if (!Number.isFinite(brandId) || !status)
    return c.json({ ok: false, error: 'brandId and a valid status are required' }, 400)
  const ok = brandmatch.setMatchStatus(c.get('tenantId'), Number(c.req.param('creatorId')), brandId, status)
  if (!ok) return c.json({ ok: false, error: 'match row not found' }, 404)
  return c.json({ ok: true })
})

// --- Proposals (stage 3): priced, brand-specific proposal with a public brand-facing page ---
// Generate (await): pulls profile+match, packages+prices+writes prose, persists. Engine errors -> 502.
app.post('/api/proposals/generate', apiAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    creatorProfileId?: number
    brandMatchId?: number
    takeRateOverride?: number | null
  }
  if (!Number.isFinite(Number(b.creatorProfileId)) || !Number.isFinite(Number(b.brandMatchId)))
    return c.json({ ok: false, error: 'creatorProfileId and brandMatchId are required' }, 400)
  try {
    const row = await proposals.generateProposal(c.get('tenantId'), {
      creatorProfileId: Number(b.creatorProfileId),
      brandMatchId: Number(b.brandMatchId),
      takeRateOverride: b.takeRateOverride ?? null,
    })
    return c.json({ ok: true, id: row.id, public_token: row.public_token, proposal: row })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502)
  }
})

// Creator's own dashboard view — net/cut/take-rate ARE allowed here (tenant-scoped, NOT the public page).
app.get('/api/proposals/:id', apiAuth, (c) => {
  const row = proposals.getProposal(c.get('tenantId'), Number(c.req.param('id')))
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, proposal: row })
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

// --- Instagram integration (Business Login: the creator connects their OWN account) ---
// Redirect URI must exactly match one registered in the Meta App Dashboard. Defaults to the
// request's own host; override with IG_REDIRECT_URI if you host the callback elsewhere.
function igRedirectUri(c: import('hono').Context): string {
  if (process.env.IG_REDIRECT_URI) return process.env.IG_REDIRECT_URI
  const proto = c.req.header('x-forwarded-proto') ?? (isProd ? 'https' : 'http')
  return `${proto}://${c.req.header('host')}/auth/instagram/callback`
}

// Step 1: kick off OAuth. Stores a short-lived state cookie for CSRF, redirects to Instagram.
app.get('/connect/instagram', pageAuth, (c) => {
  if (!ig.igConfigured()) return c.redirect('/outbound?ig=unconfigured')
  const state = randomBytes(16).toString('hex')
  setCookie(c, 'ig_state', state, { httpOnly: true, secure: isProd, sameSite: 'Lax', path: '/', maxAge: 600 })
  return c.redirect(ig.authorizeUrl(igRedirectUri(c), state))
})

// Step 2: Instagram redirects back here with ?code (session cookie rides along on this top-level GET).
app.get('/auth/instagram/callback', pageAuth, async (c) => {
  if (c.req.query('error')) return c.redirect('/outbound?ig=denied')
  const code = c.req.query('code')
  const state = c.req.query('state')
  const saved = getCookie(c, 'ig_state')
  deleteCookie(c, 'ig_state', { path: '/' })
  if (!code || !state || !saved || state !== saved) return c.redirect('/outbound?ig=badstate')
  try {
    await ig.completeConnect(c.get('tenantId'), code, igRedirectUri(c))
    return c.redirect('/outbound?ig=connected')
  } catch {
    return c.redirect('/outbound?ig=error')
  }
})

app.get('/api/instagram/status', apiAuth, (c) =>
  c.json({ ok: true, configured: ig.igConfigured(), ...ig.getConnection(c.get('tenantId')) }),
)

app.post('/api/instagram/disconnect', apiAuth, (c) => {
  ig.clearConnection(c.get('tenantId'))
  return c.json({ ok: true })
})

// The twin payload: live profile + real follower demographics (age/gender/country/city).
app.get('/api/instagram/report', apiAuth, async (c) => {
  try {
    return c.json({ ok: true, ...(await ig.fetchReport(c.get('tenantId'))) })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
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

app.post('/api/attio/disconnect', apiAuth, (c) => {
  camp.clearAttioKey(c.get('tenantId'))
  return c.json({ ok: true })
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
    if (!b.object || !b.mapping) return c.json({ ok: false, error: 'object and mapping required' }, 400)
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

app.post('/api/campaigns/:id/start', apiAuth, async (c) => {
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
    const immediate = await fireFirstNow(tid, id) // fire one send right now; rest paced by the runner
    return c.json({ ok: true, immediate })
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

// --- TEMP one-off seed ingest: receives normalized brands from the in-browser onbento harvester.
// Secret-gated via x-seed-secret (set SEED_SECRET in .env). Not part of the product surface —
// remove once the brands table is seeded. Tenant is passed explicitly (no session cross-origin).
app.post('/api/seed/bento', async (c) => {
  const secret = process.env.SEED_SECRET
  if (!secret || c.req.header('x-seed-secret') !== secret) return c.json({ ok: false, error: 'forbidden' }, 403)
  let body: { tenantId?: string; brands?: brands.BrandInput[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'bad json' }, 400)
  }
  const tenantId = body.tenantId?.trim()
  if (!tenantId || !(db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)))
    return c.json({ ok: false, error: 'unknown tenant' }, 400)
  const rows = Array.isArray(body.brands) ? body.brands : []
  const res = brands.upsertBrands(tenantId, rows)
  return c.json({ ok: true, ...res, total: brands.brandCount() })
})

serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`WA Connect listening on :${info.port}`))
