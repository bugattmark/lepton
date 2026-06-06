import { join } from 'node:path'
import { rmSync } from 'node:fs'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from './db.ts'
import { resumePausedFor } from './engine.ts'

const logger = pino({ level: 'silent' })

export type Status = 'connecting' | 'qr' | 'connected' | 'disconnected'
interface AccountSession {
  tenantId: string
  sock?: WASocket
  status: Status
  qr?: string
  jid?: string
  reconnects: number
}

// One in-memory Baileys socket per ACCOUNT (a tenant may have several). Cloud accounts
// hold no socket — they send over stateless HTTP (see cloud.ts / accounts.ts).
const sessions = new Map<string, AccountSession>()

const DATA_DIR = process.env.DATA_DIR ?? './data'
const authDir = (accountId: string) => join(DATA_DIR, 'auth', accountId)
const toJid = (num: string) => num.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
const phoneOf = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g, '')
const OPT_OUT = /^\s*(stop|unsubscribe|opt[\s-]?out|remove me)\b/i

export function getStatus(accountId: string) {
  const s = sessions.get(accountId)
  return { status: s?.status ?? 'disconnected', hasQr: !!s?.qr, jid: s?.jid ?? null }
}

export function getQr(accountId: string): string | undefined {
  return sessions.get(accountId)?.qr
}

export async function connect(accountId: string, tenantId: string): Promise<void> {
  const existing = sessions.get(accountId)
  if (existing && existing.status !== 'disconnected') return
  await startSocket(accountId, tenantId)
}

async function startSocket(accountId: string, tenantId: string): Promise<void> {
  const session: AccountSession = sessions.get(accountId) ?? { tenantId, status: 'connecting', reconnects: 0 }
  session.tenantId = tenantId
  session.status = 'connecting'
  sessions.set(accountId, session)

  const { state, saveCreds } = await useMultiFileAuthState(authDir(accountId))
  const { version } = await fetchLatestBaileysVersion() // current WA version or handshake 405s
  const sock = makeWASocket({ version, auth: state, logger })
  session.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      session.status = 'qr'
      session.qr = qr
    }
    if (connection === 'open') {
      session.status = 'connected'
      session.qr = undefined
      session.jid = sock.user?.id
      session.reconnects = 0
      try { resumePausedFor(accountId) } catch { /* engine optional */ }
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        sessions.delete(accountId)
        try { rmSync(authDir(accountId), { recursive: true, force: true }) } catch { /* ignore */ }
      } else if (session.reconnects < 5) {
        session.reconnects++
        void startSocket(accountId, tenantId)
      } else {
        session.status = 'disconnected'
      }
    }
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue // outbound is logged at send-time
      const jid = m.key.remoteJid ?? ''
      if (!jid.endsWith('@s.whatsapp.net')) continue // ignore groups/status
      const body = m.message.conversation ?? m.message.extendedTextMessage?.text ?? null
      db.prepare(
        'INSERT INTO messages (tenant_id, account_id, direction, jid, body, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(tenantId, accountId, 'in', jid, body, m.key.id ?? '', Date.now())
      handleInbound(tenantId, accountId, jid, body)
    }
  })
}

export async function disconnect(accountId: string): Promise<void> {
  const s = sessions.get(accountId)
  try { await s?.sock?.logout() } catch { /* may already be gone */ }
  try { s?.sock?.end?.(undefined) } catch { /* ignore */ }
  sessions.delete(accountId)
  try { rmSync(authDir(accountId), { recursive: true, force: true }) } catch { /* ignore */ }
}

export async function baileysSend(accountId: string, to: string, text: string): Promise<string | undefined> {
  const s = sessions.get(accountId)
  if (!s?.sock || s.status !== 'connected') throw new Error('not connected')
  const sent = await s.sock.sendMessage(toJid(to), { text })
  return sent?.key?.id ?? undefined
}

// Is this number registered on WhatsApp? Returns true/false, or null when we can't tell
// (account not connected / not a Baileys socket) — callers treat null as "don't block".
export async function isOnWhatsApp(accountId: string, phone: string): Promise<boolean | null> {
  const s = sessions.get(accountId)
  if (!s?.sock || s.status !== 'connected') return null
  try {
    const [res] = await s.sock.onWhatsApp(toJid(phone))
    return !!res?.exists
  } catch {
    return null // network blip — don't wrongly mark the contact unreachable
  }
}

// A reply arrived on this account. Reply always stops further sends to that lead (the
// WhatsApp-native pattern + the canvas "If reply" branch reads this), and "STOP" opts out.
function handleInbound(tenantId: string, accountId: string, jid: string, body: string | null): void {
  const phone = phoneOf(jid)
  const contact = db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND phone = ?').get(tenantId, phone) as
    | { id: number }
    | undefined
  if (!contact) return

  // Mark replied on this lead's enrolment(s) sent from this number — stops the sequence for them.
  db.prepare(
    `UPDATE campaign_contacts SET status = 'replied', replied_at = ?, next_due_at = NULL
     WHERE contact_id = ? AND account_id = ? AND status IN ('sent','pending')`,
  ).run(Date.now(), contact.id, accountId)

  if (body && OPT_OUT.test(body)) db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = ?').run(contact.id)

  // best-effort Attio write-back
  void import('./campaigns.ts')
    .then((m) => m.writebackNote(tenantId, contact.id, body && OPT_OUT.test(body) ? 'Opted out (STOP) on WhatsApp' : 'Replied on WhatsApp'))
    .catch(() => {})
}
