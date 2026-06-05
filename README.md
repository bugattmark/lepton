# WA Connect — multi-tenant WhatsApp outbound

A single always-on Node service: black-&-white landing, secure multi-tenant auth, and a
dashboard to run **AI-assisted WhatsApp outbound** safely. Every account is isolated.

## What it does
- **Multiple numbers per tenant** — mix **private** (Baileys / QR linked-device) and
  **official** (WhatsApp Cloud API) accounts.
- **Audience from Attio** — connect with an API key, pick any **object** + **list**, and
  **map** which attribute is the phone / name / personalization vars (no schema assumptions).
- **Campaigns** — message template with `{{var}}` placeholders, bound to a number.
- **Send engine (the safety core)** — per number: random delays, hourly/daily caps,
  warm-up ramp (tied to number age), send window, rest breaks, pause-on-reply, opt-out on
  STOP. All knobs live in reusable **send-profiles** you assign to numbers/campaigns.
- **AI-personalized openers** — Claude rewrites the opener per contact from a steering
  prompt + Attio fields + **websites it reads** (from a URL field you map). Needs `ANTHROPIC_API_KEY`.
- **Follow-up sequences** — auto step-2 if no reply in N days.
- **Attio write-back** — logs messaged / replied / opted-out as notes (toggle).
- **MCP server** — drive everything from Claude Code (see [MCP.md](MCP.md)).

> **Why one always-on server (not Vercel / Cloudflare Workers):** Baileys holds a live socket to WhatsApp open 24/7 per tenant. Serverless platforms kill code between requests, so the connection would drop. This must run on an always-on host (Railway / Render / Fly).

## Stack
- **Hono** (tiny, fast web framework) on `@hono/node-server`
- **node:sqlite** (built-in — zero native deps) for tenants, sessions, messages
- **Baileys** for the WhatsApp linked-device sessions
- **node:crypto** for scrypt password hashing + opaque server-side sessions
- TypeScript run directly by Node 24 (native type stripping — no build step)

## Layout
```
src/
  db.ts        SQLite schema (tenants, accounts, send_profiles, contacts, campaigns, …)
  auth.ts      password hashing + sessions + API tokens
  sessions.ts  Baileys manager (1 socket per ACCOUNT) + inbound reply/opt-out handling
  cloud.ts     official WhatsApp Cloud API transport
  accounts.ts  account CRUD + unified send() dispatch (baileys | cloud)
  attio.ts     Attio connector (objects, attributes, lists, mapped pull, note write-back)
  ai.ts        Claude opener personalization + website research
  engine.ts    per-account send engine (pacing, caps, warm-up, follow-ups, AI)
  campaigns.ts audience + campaign + send-profile persistence
  views.ts     B&W landing / auth / dashboard
  server.ts    Hono routes + security middleware
  mcp.ts       MCP server for Claude Code (thin REST client)
Dockerfile     one-image deploy
```

## Security
- Passwords hashed with **scrypt** + per-user salt; constant-time compare.
- Sessions are random 32-byte opaque tokens, stored server-side, in an **HttpOnly, Secure (prod), SameSite=Lax** cookie.
- **CSRF**: same-origin check on every POST/PUT/DELETE (pairs with SameSite=Lax).
- **CSP + security headers** via Hono `secureHeaders`.
- **Tenant isolation**: every API derives `tenantId` from the session cookie — never from client input. One tenant cannot touch another's session or messages.
- Basic per-IP **rate limiting** on login/signup.

## Run locally
```
npm install
cp .env.example .env
npm run dev          # http://localhost:8080
```
Sign up → Connect WhatsApp → scan the QR → send a test. (Link a number you're OK risking — unofficial linked-device sessions carry ban risk on cold outbound.)

## Deploy to Railway
1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick it. Railway detects the `Dockerfile` and builds.
3. **Add a Volume** (Service → Variables/Volumes) mounted at **`/app/data`** — this persists the SQLite DB + each tenant's WhatsApp auth across restarts. *Without this, everyone has to re-scan after every deploy.*
4. Set env var **`NODE_ENV=production`** (enables Secure cookies). `PORT` is injected by Railway automatically.
5. Keep it at **1 instance / no autoscaling** — sessions live in memory on one machine; multiple replicas would split/duplicate them.

## Your custom domain
1. Railway → Service → **Settings → Networking → Custom Domain** → enter your domain.
2. Railway shows a **CNAME target** — add that CNAME at your registrar (or in Cloudflare DNS).
3. *(Optional, free)* Put **Cloudflare in front**: add the domain to Cloudflare, point the CNAME there with proxy on → free SSL + CDN + WAF. Cloudflare only proxies; Railway still runs the app.

## Known limits (v1)
- **Single instance** by design (in-memory sessions). Scaling to many tenants later = a session-router across multiple workers + moving auth state to the DB/object storage.
- Unofficial WhatsApp (Baileys) → **ban risk** on cold first-contact. This is the stopgap transport; the official Cloud API is the long-term spine.
- QR/status use light polling; fine at this scale.
