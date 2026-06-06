// Accounts = connected WhatsApp numbers. A tenant can have many, mixing 'baileys'
// (unofficial, QR) and 'cloud' (official Graph API). This module is the single place
// that knows how to talk to each transport — the engine just calls send().

import { randomUUID } from 'node:crypto'
import { db } from './db.ts'
import type { AccountRow } from './db.ts'
import * as baileys from './sessions.ts'
import { cloudSendText, cloudSendTemplate, cloudVerify, type CloudConfig } from './cloud.ts'
import { enc, dec } from './secret.ts'
import { getPolicy, warmupDay, dailyCapNow, type SendPolicy } from './policy.ts'

const row = (id: string) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined

export function getAccount(tenantId: string, id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND tenant_id = ?').get(id, tenantId) as AccountRow | undefined
}

// Returned to the browser — deliberately WITHOUT `config` (it holds the Cloud API token).
export interface AccountView {
  id: string
  type: 'baileys' | 'cloud'
  label: string
  profile_id: number | null
  created_at: number
  status: string
  hasQr: boolean
  jid: string | null
  policy: SendPolicy
  warmupDay: number
  dailyCapToday: number
  sentToday: number
}

const startOfToday = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function listAccounts(tenantId: string): AccountView[] {
  const rows = db.prepare('SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at').all(tenantId) as AccountRow[]
  return rows.map((a) => {
    const pol = getPolicy(a.id)
    const sent = (db
      .prepare(`SELECT COUNT(*) n FROM messages WHERE account_id = ? AND direction = 'out' AND created_at >= ?`)
      .get(a.id, startOfToday()) as { n: number }).n
    const base = {
      id: a.id, type: a.type, label: a.label, profile_id: a.profile_id, created_at: a.created_at,
      policy: pol, warmupDay: warmupDay(pol), dailyCapToday: dailyCapNow(pol), sentToday: sent,
    }
    if (a.type === 'baileys') {
      const s = baileys.getStatus(a.id)
      return { ...base, status: s.status, hasQr: s.hasQr, jid: s.jid }
    }
    const cfg = parseCloud(a.config) // token may be encrypted; truthiness is all we need here
    return { ...base, status: cfg.token && cfg.phoneNumberId ? 'connected' : 'disconnected', hasQr: false, jid: cfg.phoneNumberId ?? null }
  })
}

function parseCloud(raw: string): Partial<CloudConfig> {
  try {
    return JSON.parse(raw) as Partial<CloudConfig>
  } catch {
    return {}
  }
}

// Decrypted Cloud config for actually sending (server-side only — never returned to clients).
function cloudConfigOf(a: AccountRow): CloudConfig {
  const c = parseCloud(a.config)
  return { phoneNumberId: c.phoneNumberId ?? '', token: dec(c.token), graphVersion: c.graphVersion }
}

export async function createAccount(
  tenantId: string,
  type: 'baileys' | 'cloud',
  label: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  let toStore = config
  if (type === 'cloud') {
    const cfg = config as Partial<CloudConfig>
    if (!cfg.token || !cfg.phoneNumberId) throw new Error('cloud accounts need token and phoneNumberId')
    await cloudVerify(cfg as CloudConfig) // validates credentials (plaintext) before saving
    toStore = { ...config, token: enc(cfg.token) } // encrypt the token at rest
  }
  const id = randomUUID()
  db.prepare('INSERT INTO accounts (id, tenant_id, type, label, config, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    tenantId,
    type,
    label,
    JSON.stringify(toStore),
    Date.now(),
  )
  return id
}

export async function deleteAccount(tenantId: string, id: string): Promise<void> {
  const a = getAccount(tenantId, id)
  if (!a) return
  if (a.type === 'baileys') await baileys.disconnect(id)
  db.prepare('DELETE FROM accounts WHERE id = ? AND tenant_id = ?').run(id, tenantId)
}

export function setProfile(tenantId: string, id: string, profileId: number | null): void {
  db.prepare('UPDATE accounts SET profile_id = ? WHERE id = ? AND tenant_id = ?').run(profileId, id, tenantId)
}

// --- connection controls (baileys only; cloud is always "on" once saved) ---
export async function connect(tenantId: string, id: string): Promise<void> {
  const a = getAccount(tenantId, id)
  if (!a || a.type !== 'baileys') return
  await baileys.connect(id, tenantId)
}
export async function disconnect(tenantId: string, id: string): Promise<void> {
  const a = getAccount(tenantId, id)
  if (!a || a.type !== 'baileys') return
  await baileys.disconnect(id)
}
export function status(id: string) {
  const a = row(id)
  if (!a) return { status: 'disconnected', hasQr: false, jid: null }
  if (a.type === 'baileys') return baileys.getStatus(id)
  const cfg = parseCloud(a.config)
  return { status: cfg.token && cfg.phoneNumberId ? 'connected' : 'disconnected', hasQr: false, jid: cfg.phoneNumberId ?? null }
}
export const getQr = (id: string) => baileys.getQr(id)

export function isConnected(id: string): boolean {
  return status(id).status === 'connected'
}

export function accountType(id: string): 'baileys' | 'cloud' | undefined {
  return row(id)?.type
}

// Is a number on WhatsApp? Only meaningful for Baileys (cloud can't query) — null = unknown.
export async function checkOnWhatsApp(accountId: string, phone: string): Promise<boolean | null> {
  if (accountType(accountId) !== 'baileys') return null
  return baileys.isOnWhatsApp(accountId, phone)
}

// --- the one send the engine calls ---
export interface SendOpts {
  cloudTemplate?: string | null
  cloudLang?: string | null
  cloudVars?: string[]
}

export async function send(accountId: string, to: string, text: string, opts: SendOpts = {}): Promise<string | undefined> {
  const a = row(accountId)
  if (!a) throw new Error('account not found')

  let wamid: string | undefined
  if (a.type === 'cloud') {
    const cfg = cloudConfigOf(a)
    if (opts.cloudTemplate) {
      wamid = await cloudSendTemplate(cfg, to, opts.cloudTemplate, opts.cloudLang ?? 'en_US', opts.cloudVars ?? [text])
    } else {
      wamid = await cloudSendText(cfg, to, text) // only valid inside the 24h window
    }
  } else {
    wamid = await baileys.baileysSend(accountId, to, text)
  }

  db.prepare(
    'INSERT INTO messages (tenant_id, account_id, direction, jid, body, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(a.tenant_id, accountId, 'out', to.replace(/[^0-9]/g, '') + '@s.whatsapp.net', text, wamid ?? '', Date.now())
  return wamid
}
