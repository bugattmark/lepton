// Per-number send policy: warmup ramp (tier 1), distribution weight + daily cap (tier 2),
// send window + human spacing (tier 4). Grounded in 2026 community anti-ban guidance:
//   • new numbers: ~20-50 sends/day, roughly double every 3 days, reach normal volume by day ~14
//   • stay under ~30/hr and ~200/day on a mature number
//   • spread sends across daytime, jitter the gaps (cluster mid-range, not uniform)
import { db } from './db.ts'

export interface SendPolicy {
  weight: number // distribution share across the campaign's numbers (tier 2)
  dailyCap: number // hard ceiling of sends/day for this number (tier 2)
  warmupEnabled: boolean // ramp the daily cap up over the first ~2 weeks (tier 1)
  warmupStartedAt: number // epoch ms the ramp counts from (defaults to when the number was added)
  windowStart: number // local hour sends may begin (0-23) (tier 4)
  windowEnd: number // local hour sends must stop (0-23)
}

export const DEFAULT_POLICY: SendPolicy = {
  weight: 1,
  dailyCap: 200,
  warmupEnabled: true,
  warmupStartedAt: 0,
  windowStart: 8,
  windowEnd: 21,
}

const WARMUP_BASE = 40 // sends/day on days 1-3 of a fresh number

interface AcctPolicyRow {
  send_policy: string | null
  created_at: number
}

export function getPolicy(accountId: string): SendPolicy {
  const row = db.prepare('SELECT send_policy, created_at FROM accounts WHERE id = ?').get(accountId) as AcctPolicyRow | undefined
  let saved: Partial<SendPolicy> = {}
  if (row?.send_policy) {
    try {
      saved = JSON.parse(row.send_policy) as Partial<SendPolicy>
    } catch {
      /* ignore bad JSON */
    }
  }
  const p = { ...DEFAULT_POLICY, ...saved }
  if (!p.warmupStartedAt) p.warmupStartedAt = row?.created_at ?? Date.now()
  return p
}

export function setPolicy(accountId: string, patch: Partial<SendPolicy>): SendPolicy {
  const next = { ...getPolicy(accountId), ...patch }
  db.prepare('UPDATE accounts SET send_policy = ? WHERE id = ?').run(JSON.stringify(next), accountId)
  return next
}

// Which warmup day (1-based) the number is on.
export function warmupDay(p: SendPolicy, now = Date.now()): number {
  return Math.max(1, Math.floor((now - (p.warmupStartedAt || now)) / 86_400_000) + 1)
}

// Today's effective daily cap: warmup ramp clamped by the hard daily cap.
export function dailyCapNow(p: SendPolicy, now = Date.now()): number {
  if (!p.warmupEnabled) return p.dailyCap
  const steps = Math.floor((warmupDay(p, now) - 1) / 3) // double every 3 days
  const ramped = WARMUP_BASE * Math.pow(2, steps)
  return Math.min(p.dailyCap, Math.round(ramped))
}

// Is the number still ramping (today's cap below its ceiling)?
export function isWarming(p: SendPolicy, now = Date.now()): boolean {
  return p.warmupEnabled && dailyCapNow(p, now) < p.dailyCap
}

// Is `d` inside the allowed send window? Handles windows that wrap past midnight.
export function inWindow(p: SendPolicy, d = new Date()): boolean {
  const h = d.getHours()
  if (p.windowStart === p.windowEnd) return true // 24h
  return p.windowStart < p.windowEnd ? h >= p.windowStart && h < p.windowEnd : h >= p.windowStart || h < p.windowEnd
}

// Human-like gap (seconds) between sends: Gaussian, clustered mid-range, clamped to [lo,hi].
export function gaussGap(lo: number, hi: number): number {
  const u1 = Math.random() || 1e-9
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) // standard normal
  const mid = (lo + hi) / 2
  const spread = (hi - lo) / 4 // ~95% of mass inside [lo,hi]
  return Math.min(hi, Math.max(lo, mid + z * spread))
}
