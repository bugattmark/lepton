// Encryption-at-rest for stored credentials (Cloud API tokens, Attio keys).
// Simple AES-256-GCM keyed off APP_SECRET. Backward-compatible: values written before
// a secret was set (or with none set) are plain text and read back as-is.
//
// Set APP_SECRET in production (Railway → Variables). Without it, secrets are stored
// UNENCRYPTED and a one-time warning is logged.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
let warned = false

function key(): Buffer | null {
  const s = process.env.APP_SECRET
  if (!s) {
    if (!warned) {
      console.warn('[secret] APP_SECRET not set — credentials stored UNENCRYPTED. Set APP_SECRET in production.')
      warned = true
    }
    return null
  }
  return scryptSync(s, 'wa-connect-secret-v1', 32)
}

export function enc(plain: string): string {
  if (!plain) return plain
  const k = key()
  if (!k) return plain // dev / no secret → store as-is
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':')
}

export function dec(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored // plaintext / written before encryption
  const k = key()
  if (!k) return '' // encrypted but no key available → can't read
  try {
    const [, , ivh, tagh, cth] = stored.split(':')
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(ivh, 'hex'))
    d.setAuthTag(Buffer.from(tagh, 'hex'))
    return Buffer.concat([d.update(Buffer.from(cth, 'hex')), d.final()]).toString('utf8')
  } catch {
    return ''
  }
}
