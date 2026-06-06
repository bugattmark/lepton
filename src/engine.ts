// The send engine — runs PER ACCOUNT (one WhatsApp number) and walks each lead through
// the campaign's canvas sequence (send → wait → ifreply → loop). Survivability knobs,
// per the product, are just three and they live on each Send block:
//   • per-hour cap   (stay under velocity ban triggers)
//   • min/max gap    (random human-like spacing between sends)
// A reply flips the lead to 'replied' (sessions.ts) which stops further sends — the
// WhatsApp-native "one message, maybe one follow-up, then stop" pattern.

import { db } from './db.ts'
import type { CampaignRow } from './db.ts'
import * as accounts from './accounts.ts'
import { getPolicy, dailyCapNow, inWindow, gaussGap } from './policy.ts'
import { personalizeOpener } from './ai.ts'
import {
  type Sequence,
  type SendData,
  parseSequence,
  fallbackSequence,
  nodeById,
  outgoing,
  firstNode,
  asSend,
  asWait,
  DEFAULT_SEND,
} from './sequence.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

// Sleep in slices so a pause/disconnect is noticed within ~5s instead of after a full gap.
async function sleepUntil(ms: number, keepGoing: () => boolean): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!keepGoing()) return false
    await sleep(Math.min(5000, end - Date.now()))
  }
  return true
}

// --- cap accounting (per account = per number), counted from the outbound message log ---
const sentSince = (accountId: string, since: number): number =>
  (db
    .prepare(`SELECT COUNT(*) n FROM messages WHERE account_id = ? AND direction = 'out' AND created_at >= ?`)
    .get(accountId, since) as { n: number }).n

const startOfToday = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const sentToday = (accountId: string): number => sentSince(accountId, startOfToday())

// --- template rendering ---
// Spintax: pick one option from each {a|b|c} group so every send is textually unique
// (identical text across a batch is a top WhatsApp spam-fingerprint). Resolves innermost
// groups first so nesting like {hey|hi|{yo|sup}} works. Runs AFTER {{var}} substitution,
// and only touches single-brace groups that contain a pipe — {{vars}} are never affected.
export function spin(text: string): string {
  const re = /\{([^{}]*\|[^{}]*)\}/
  let out = text
  for (let guard = 0; guard < 50 && re.test(out); guard++) {
    out = out.replace(re, (_, group: string) => {
      const opts = group.split('|')
      return opts[Math.floor(Math.random() * opts.length)]
    })
  }
  return out
}

export function render(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
  return spin(filled).trim()
}

function varsForLead(l: Lead): Record<string, string> {
  let v: Record<string, string> = {}
  try {
    v = l.vars ? (JSON.parse(l.vars) as Record<string, string>) : {}
  } catch { /* ignore */ }
  if (l.name) v.name = v.name ?? l.name
  if (v.first_name && !v.name) v.name = v.first_name
  if (l.instagram_handle) v.instagram_handle = l.instagram_handle
  if (l.event_link) v.instagram_link = l.event_link
  if (l.category) v.category = l.category
  return v
}

// --- DB helpers ---
const campaignById = (id: number) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined

// Campaigns that are running AND send from this account (via the checklist, or the legacy single account_id).
function runningCampaignsForAccount(accountId: string): CampaignRow[] {
  return db
    .prepare(
      `SELECT * FROM campaigns
       WHERE status = 'running' AND (
         account_id = ? OR id IN (SELECT campaign_id FROM campaign_accounts WHERE account_id = ?)
       ) ORDER BY id`,
    )
    .all(accountId, accountId) as CampaignRow[]
}

function sequenceOf(c: CampaignRow): Sequence {
  return parseSequence(c.sequence) ?? fallbackSequence(c.template)
}

interface Lead {
  ccId: number
  contactId: number
  phone: string
  name: string | null
  vars: string | null
  instagram_handle: string | null
  event_link: string | null
  category: string | null
  status: string
  node_id: string | null
  replied_at: number | null
}

// The next lead this account should act on, across all its running campaigns.
function nextLead(accountId: string): { lead: Lead; camp: CampaignRow } | undefined {
  const camps = runningCampaignsForAccount(accountId)
  for (const camp of camps) {
    const l = db
      .prepare(
        `SELECT cc.id ccId, c.id contactId, c.phone phone, c.name name, c.vars vars,
                c.instagram_handle instagram_handle, c.event_link event_link, c.category category,
                cc.status status, cc.node_id node_id, cc.replied_at replied_at
         FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
         WHERE cc.campaign_id = ? AND cc.account_id = ? AND c.opted_out = 0
           AND cc.status IN ('pending','sent')
           AND (cc.next_due_at IS NULL OR cc.next_due_at <= ?)
         ORDER BY (cc.next_due_at IS NULL) DESC, cc.next_due_at, cc.id
         LIMIT 1`,
      )
      .get(camp.id, accountId, Date.now()) as Lead | undefined
    if (l) return { lead: l, camp }
  }
  return undefined
}

// Is there work parked for later (so the runner should idle, not exit)?
function hasFutureWork(accountId: string): boolean {
  return (
    (db
      .prepare(
        `SELECT COUNT(*) n FROM campaign_contacts cc JOIN campaigns ca ON ca.id = cc.campaign_id
         WHERE cc.account_id = ? AND ca.status = 'running' AND cc.status IN ('pending','sent')`,
      )
      .get(accountId) as { n: number }).n > 0
  )
}

function markDoneIfFinished(c: CampaignRow): void {
  const n = (db
    .prepare(`SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id = ? AND status IN ('pending','sent')`)
    .get(c.id) as { n: number }).n
  if (n === 0) db.prepare(`UPDATE campaigns SET status = 'done' WHERE id = ? AND status = 'running'`).run(c.id)
}

async function composeSend(camp: CampaignRow, send: SendData, lead: Lead): Promise<string> {
  const vars = varsForLead(lead)
  if (send.aiPersonalize) {
    const ai = await personalizeOpener({ template: send.message, customPrompt: send.aiPrompt ?? null, name: lead.name, vars })
    if (ai) return ai
  }
  return render(send.message, vars)
}

function writeback(tenantId: string, contactId: number, note: string): void {
  void import('./campaigns.ts').then((m) => m.writebackNote(tenantId, contactId, note)).catch(() => {})
}

// Record a successful send (local 10-day suppression stamp + optional Attio date write-back).
function recordSend(tenantId: string, contactId: number): void {
  void import('./campaigns.ts').then((m) => m.markMessaged(tenantId, contactId)).catch(() => {})
}

// Is this contact reachable on WhatsApp? Cached on the contact; only Baileys can check
// (cloud/unknown → null, which we treat as "send anyway, don't block").
async function ensureRegistered(
  tenantId: string,
  contactId: number,
  accountId: string,
  phone: string,
): Promise<boolean | null> {
  const row = db.prepare('SELECT wa_registered FROM contacts WHERE id = ?').get(contactId) as
    | { wa_registered: number | null }
    | undefined
  if (row?.wa_registered === 0) return false
  if (row?.wa_registered === 1) return true
  const reg = await accounts.checkOnWhatsApp(accountId, phone)
  if (reg === null) return null
  void import('./campaigns.ts').then((m) => m.cacheWhatsappRegistered(tenantId, contactId, reg)).catch(() => {})
  return reg
}

// Advance a lead one or more non-sending blocks; perform at most one send per call.
// Returns the send config used (so the runner can apply min/max gap), or null if no send happened.
async function stepLead(camp: CampaignRow, seq: Sequence, lead: Lead): Promise<SendData | null | 'disconnected'> {
  let nodeId = lead.node_id ?? firstNode(seq)
  // resolve "replied" once — used by every ifreply on this pass
  const replied = lead.status === 'replied' || lead.replied_at != null

  for (let guard = 0; guard < 12; guard++) {
    const node = nodeById(seq, nodeId)
    if (!node || node.type === 'start') {
      // start just routes forward; nothing else means the sequence ended
      if (!node) {
        db.prepare(`UPDATE campaign_contacts SET status = 'completed', node_id = NULL WHERE id = ?`).run(lead.ccId)
        return null
      }
      nodeId = outgoing(seq, node.id)
      continue
    }

    if (node.type === 'wait') {
      const mins = Math.max(0, asWait(node)?.minutes ?? 0)
      const next = outgoing(seq, node.id)
      db.prepare(`UPDATE campaign_contacts SET node_id = ?, next_due_at = ? WHERE id = ?`).run(
        next,
        Date.now() + mins * 60_000,
        lead.ccId,
      )
      return null // lead is parked until next_due_at
    }

    if (node.type === 'ifreply') {
      nodeId = outgoing(seq, node.id, replied ? 'yes' : 'no')
      db.prepare(`UPDATE campaign_contacts SET node_id = ?, next_due_at = NULL WHERE id = ?`).run(nodeId, lead.ccId)
      continue
    }

    // node.type === 'send'
    const send = { ...DEFAULT_SEND, ...(asSend(node) ?? {}) }
    const accountId = (lead as LeadWithAccount).account_id ?? ''

    // is-on-WhatsApp gate (first contact only — a mid-sequence lead already passed it)
    if (lead.status === 'pending') {
      const reg = await ensureRegistered(camp.tenant_id, lead.contactId, accountId, lead.phone)
      if (reg === false) {
        db.prepare(`UPDATE campaign_contacts SET status = 'skipped', error = ? WHERE id = ?`).run(
          'not on WhatsApp',
          lead.ccId,
        )
        return null
      }
    }

    const text = await composeSend(camp, send, lead)
    try {
      const wamid = await accounts.send(accountId, lead.phone, text, {
        cloudTemplate: camp.cloud_template,
        cloudLang: camp.cloud_lang,
        cloudVars: [text],
      })
      const next = outgoing(seq, node.id)
      const firstTime = lead.status === 'pending'
      db.prepare(
        `UPDATE campaign_contacts SET status = 'sent', node_id = ?, next_due_at = NULL,
           sent_at = COALESCE(sent_at, ?), wamid = ? WHERE id = ?`,
      ).run(next, Date.now(), wamid ?? '', lead.ccId)
      recordSend(camp.tenant_id, lead.contactId)
      writeback(camp.tenant_id, lead.contactId, firstTime ? 'Messaged via WhatsApp' : 'Followed up via WhatsApp')
      return send
    } catch (e) {
      const msg = (e as Error).message
      if (/not connected/i.test(msg)) return 'disconnected'
      db.prepare(`UPDATE campaign_contacts SET status = 'failed', error = ? WHERE id = ?`).run(msg.slice(0, 200), lead.ccId)
      return null
    }
  }
  return null
}

// inject account_id onto the lead row (used by stepLead's send) without another query
interface LeadWithAccount extends Lead {
  account_id?: string | null
}

// --- the runner: one loop per account ---
const runners = new Set<string>()

export function kick(accountId: string): void {
  if (runners.has(accountId)) return
  runners.add(accountId)
  run(accountId).finally(() => runners.delete(accountId))
}

async function run(accountId: string): Promise<void> {
  for (;;) {
    if (!runners.has(accountId)) return
    if (!accounts.isConnected(accountId)) return
    const camps = runningCampaignsForAccount(accountId)
    if (!camps.length) return

    const picked = nextLead(accountId)
    if (!picked) {
      camps.forEach(markDoneIfFinished)
      if (!hasFutureWork(accountId)) return
      await sleepUntil(60_000, () => runners.has(accountId)) // parked work; re-check in a minute
      continue
    }

    const { lead, camp } = picked
    const seq = sequenceOf(camp)
    ;(lead as LeadWithAccount).account_id = (db
      .prepare('SELECT account_id FROM campaign_contacts WHERE id = ?')
      .get(lead.ccId) as { account_id: string | null }).account_id ?? accountId

    // gate sends on this number's policy: send window (tier 4), warmup/daily cap (tiers 1+2),
    // then per-hour velocity cap. Park the lead and retry rather than dropping it.
    const cur = nodeById(seq, lead.node_id ?? firstNode(seq))
    if (cur?.type === 'send') {
      const pol = getPolicy(accountId)
      // outside the daytime window → hold until it likely reopens
      if (!inWindow(pol)) {
        db.prepare('UPDATE campaign_contacts SET next_due_at = ? WHERE id = ?').run(Date.now() + 15 * 60_000, lead.ccId)
        await sleepUntil(15 * 60_000, () => runners.has(accountId))
        continue
      }
      // warmup ramp / hard daily cap reached → hold until tomorrow
      if (sentToday(accountId) >= dailyCapNow(pol)) {
        db.prepare('UPDATE campaign_contacts SET next_due_at = ? WHERE id = ?').run(Date.now() + 30 * 60_000, lead.ccId)
        await sleepUntil(30 * 60_000, () => runners.has(accountId))
        continue
      }
      // per-hour velocity cap (the Send block's knob)
      const cap = (asSend(cur) ?? DEFAULT_SEND).hourlyCap
      if (sentSince(accountId, Date.now() - 3_600_000) >= cap) {
        db.prepare('UPDATE campaign_contacts SET next_due_at = ? WHERE id = ?').run(Date.now() + 60_000, lead.ccId)
        await sleepUntil(60_000, () => runners.has(accountId))
        continue
      }
    }

    const result = await stepLead(camp, seq, lead as LeadWithAccount)
    if (result === 'disconnected') return
    const keepGoing = () => campaignById(camp.id)?.status === 'running' && runners.has(accountId)
    if (result) {
      // a message went out — space the next send with human-like (Gaussian) jitter
      await sleepUntil(gaussGap(result.minGap, result.maxGap) * 1000, keepGoing)
    } else {
      await sleepUntil(800, keepGoing) // non-send step; brief breather to avoid a busy loop
    }
  }
}

// --- fetching new leads from the campaign's Lead-list block (live Attio / CSV snapshot) ---
// Cadence = the Wait block that loops back to the Lead-list (start) node, else fetch once.
function refetchMinutes(seq: Sequence): number | null {
  const start = seq.nodes.find((n) => n.type === 'start')
  if (!start) return null
  const mins = seq.nodes
    .filter((n) => n.type === 'wait' && outgoing(seq, n.id) === start.id)
    .map((n) => Math.max(1, asWait(n)?.minutes ?? 0))
  return mins.length ? Math.min(...mins) : null
}

const lastFetch = new Map<number, number>()

function fetchInto(tenantId: string, campaignId: number): void {
  void import('./campaigns.ts')
    .then((m) => m.fetchAndEnroll(tenantId, campaignId))
    .then((r) => {
      if (r.enrolled) for (const a of campaignAccountIds(campaignId)) kick(a)
    })
    .catch(() => {})
}

// Background ticker: top up running campaigns from their lists on the loop cadence.
setInterval(() => {
  const running = db.prepare(`SELECT * FROM campaigns WHERE status = 'running'`).all() as CampaignRow[]
  const now = Date.now()
  for (const c of running) {
    const every = refetchMinutes(sequenceOf(c))
    if (!every) continue
    const last = lastFetch.get(c.id) ?? 0
    if (now - last >= every * 60_000) {
      lastFetch.set(c.id, now)
      fetchInto(c.tenant_id, c.id)
    }
  }
}, 60_000).unref?.()

// --- public controls ---
export function startCampaign(tenantId: string, campaignId: number): void {
  const c = campaignById(campaignId)
  if (!c || c.tenant_id !== tenantId) throw new Error('not found')
  const accts = campaignAccountIds(campaignId)
  if (!accts.length) throw new Error('campaign has no WhatsApp number selected')
  db.prepare(
    `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND tenant_id = ?`,
  ).run(Date.now(), campaignId, tenantId)
  lastFetch.set(campaignId, Date.now())
  fetchInto(tenantId, campaignId) // pull an initial batch immediately
  for (const a of accts) kick(a)
}

export function pauseCampaign(tenantId: string, campaignId: number): void {
  db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ? AND tenant_id = ? AND status = 'running'`).run(
    campaignId,
    tenantId,
  )
}

export function campaignAccountIds(campaignId: number): string[] {
  const rows = db.prepare('SELECT account_id FROM campaign_accounts WHERE campaign_id = ?').all(campaignId) as {
    account_id: string
  }[]
  if (rows.length) return rows.map((r) => r.account_id)
  const legacy = (db.prepare('SELECT account_id FROM campaigns WHERE id = ?').get(campaignId) as {
    account_id: string | null
  }).account_id
  return legacy ? [legacy] : []
}

// Resume any campaigns that were paused by a disconnect, once the account is back.
export function resumePausedFor(accountId: string): void {
  kick(accountId)
}
