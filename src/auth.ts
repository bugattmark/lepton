import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto'
import { db } from './db.ts'
import type { TenantRow } from './db.ts'

// --- password hashing (scrypt, no external deps) ---
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// --- tenants ---
export function createTenant(email: string, password: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO tenants (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, email, hashPassword(password), Date.now())
  return id
}

export function findTenantByEmail(email: string): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE email = ?').get(email) as TenantRow | undefined
}

// --- sessions (random opaque token, stored server-side) ---
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

export function createSession(tenantId: string): string {
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (token, tenant_id, expires_at) VALUES (?, ?, ?)')
    .run(token, tenantId, Date.now() + SESSION_TTL_MS)
  return token
}

export function getSessionTenant(token: string | undefined): string | null {
  if (!token) return null
  const row = db.prepare('SELECT tenant_id, expires_at FROM sessions WHERE token = ?').get(token) as
    | { tenant_id: string; expires_at: number }
    | undefined
  if (!row) return null
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  return row.tenant_id
}

export function deleteSession(token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}
