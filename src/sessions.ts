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

const logger = pino({ level: 'silent' })

export type Status = 'connecting' | 'qr' | 'connected' | 'disconnected'
interface TenantSession {
  sock?: WASocket
  status: Status
  qr?: string // raw QR payload; rendered to PNG on demand
  jid?: string
  reconnects: number
}

// One in-memory session per tenant. This is why the app needs a persistent
// Node host (not a Worker): each socket stays open to WhatsApp continuously.
const sessions = new Map<string, TenantSession>()

const DATA_DIR = process.env.DATA_DIR ?? './data'
const authDir = (tenantId: string) => join(DATA_DIR, 'auth', tenantId)
const toJid = (num: string) => num.replace(/[^0-9]/g, '') + '@s.whatsapp.net'

export function getStatus(tenantId: string) {
  const s = sessions.get(tenantId)
  return { status: s?.status ?? 'disconnected', hasQr: !!s?.qr, jid: s?.jid ?? null }
}

export function getQr(tenantId: string): string | undefined {
  return sessions.get(tenantId)?.qr
}

export async function connect(tenantId: string): Promise<void> {
  const existing = sessions.get(tenantId)
  if (existing && existing.status !== 'disconnected') return // already live/connecting
  await startSocket(tenantId)
}

async function startSocket(tenantId: string): Promise<void> {
  const session: TenantSession = sessions.get(tenantId) ?? { status: 'connecting', reconnects: 0 }
  session.status = 'connecting'
  sessions.set(tenantId, session)

  const { state, saveCreds } = await useMultiFileAuthState(authDir(tenantId))
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
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        sessions.delete(tenantId)
        try { rmSync(authDir(tenantId), { recursive: true, force: true }) } catch { /* ignore */ }
      } else if (session.reconnects < 5) {
        session.reconnects++
        void startSocket(tenantId)
      } else {
        session.status = 'disconnected'
      }
    }
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (!m.message) continue
      const body = m.message.conversation ?? m.message.extendedTextMessage?.text ?? null
      db.prepare(
        'INSERT INTO messages (tenant_id, direction, jid, body, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(tenantId, m.key.fromMe ? 'out' : 'in', m.key.remoteJid ?? '', body, m.key.id ?? '', Date.now())
    }
  })
}

export async function disconnect(tenantId: string): Promise<void> {
  const s = sessions.get(tenantId)
  try { await s?.sock?.logout() } catch { /* may already be gone */ }
  try { s?.sock?.end?.(undefined) } catch { /* ignore */ }
  sessions.delete(tenantId)
  try { rmSync(authDir(tenantId), { recursive: true, force: true }) } catch { /* ignore */ }
}

export async function send(tenantId: string, to: string, text: string): Promise<string | undefined> {
  const s = sessions.get(tenantId)
  if (!s?.sock || s.status !== 'connected') throw new Error('not connected')
  const sent = await s.sock.sendMessage(toJid(to), { text })
  db.prepare(
    'INSERT INTO messages (tenant_id, direction, jid, body, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(tenantId, 'out', toJid(to), text, sent?.key?.id ?? '', Date.now())
  return sent?.key?.id ?? undefined
}
