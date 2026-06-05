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
} from './auth.ts'
import * as wa from './sessions.ts'
import { landingView, authView, dashboardView } from './views.ts'

const isProd = process.env.NODE_ENV === 'production'
const PORT = Number(process.env.PORT ?? 8080)

const app = new Hono<{ Variables: { tenantId: string } }>()

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
  const tenantId = getSessionTenant(getCookie(c, 'sid'))
  if (!tenantId) return c.json({ ok: false, error: 'unauthorized' }, 401)
  c.set('tenantId', tenantId)
  await next()
}

const emailOf = (tenantId: string) =>
  (db.prepare('SELECT email FROM tenants WHERE id = ?').get(tenantId) as { email: string } | undefined)?.email ?? ''

// --- public pages ---
app.get('/', (c) => (getSessionTenant(getCookie(c, 'sid')) ? c.redirect('/app') : c.html(landingView())))
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
  return c.redirect('/app')
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
  return c.redirect('/app')
})

app.post('/logout', (c) => {
  deleteSession(getCookie(c, 'sid'))
  deleteCookie(c, 'sid', { path: '/' })
  return c.redirect('/')
})

// --- dashboard (auth) ---
app.get('/app', pageAuth, (c) => c.html(dashboardView(emailOf(c.get('tenantId')))))

// --- tenant API (auth + isolated by tenantId from session, never from client) ---
app.post('/api/connect', apiAuth, async (c) => {
  await wa.connect(c.get('tenantId'))
  return c.json({ ok: true })
})

app.post('/api/disconnect', apiAuth, async (c) => {
  await wa.disconnect(c.get('tenantId'))
  return c.json({ ok: true })
})

app.get('/api/status', apiAuth, (c) => c.json(wa.getStatus(c.get('tenantId'))))

app.get('/api/qr.png', apiAuth, async (c) => {
  const qr = wa.getQr(c.get('tenantId'))
  if (!qr) return c.text('no qr', 404)
  const png = await QRCode.toBuffer(qr, { width: 320, margin: 2 })
  return c.body(png, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
})

app.post('/api/send', apiAuth, async (c) => {
  try {
    const { to, text } = (await c.req.json()) as { to?: string; text?: string }
    if (!to || !text) return c.json({ ok: false, error: 'to and text required' }, 400)
    const id = await wa.send(c.get('tenantId'), to, text)
    return c.json({ ok: true, id })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400)
  }
})

app.get('/healthz', (c) => c.text('ok'))

serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`WA Connect listening on :${info.port}`))
