// Lead qualifier (Qualifying tab). Given a lead list and a plain-English description of the
// ideal lead, score every row 0-100 with a tier (hot/warm/cold) and a one-sentence reason.
//
// Architecture follows the industry consensus (Clay / lemlist AI agents / LangChain):
//   1. ENRICH from a provider, don't let the model invent data. For each row with an Instagram
//      handle we re-pull fresh HikerAPI signals (followers, bio, business flag, category, link).
//   2. CLASSIFY with an LLM over that grounded dossier — gpt-5.4, strict json_schema output.
//      The prompt forbids guessing: missing signals are treated as unknown, never fabricated.
//   3. Output {score, tier, reason}; tier is derived deterministically from score so it's stable.
//
// Results are written onto each row's vars (qual_score / qual_tier / qual_reason) and persisted
// incrementally, so the Qualifying table fills live exactly like the Source table.
//
// Needs OPENAI_API_KEY (judging) and, for richer judging on IG handles, HIKER_API_KEY (enrich).
// Best-effort: a row that can't be enriched is still judged from whatever fields it already has.

import { db } from './db.ts'
import { getLeadList } from './campaigns.ts'
import type { UpsertRow } from './campaigns.ts'
import { enrichHandle, hikerAvailable } from './sourcing.ts'

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'
const ENDPOINT = 'https://api.openai.com/v1/responses'

export const qualifyAvailable = () => !!process.env.OPENAI_API_KEY

export const DEFAULT_CRITERIA =
  'Qualify this Instagram account as a lead for WhatsApp outreach.\n' +
  'GOOD FIT: actively runs in-person events; UK-based; 1k–100k followers; posts recently; ' +
  'a real organiser (not a venue, ticketing, or box-office account).\n' +
  'DISQUALIFY: dormant, reseller/aggregator, an agency representing others, outside the UK, ' +
  'or clearly not events-related.\n' +
  'Judge ONLY from the data provided. If a signal is missing, treat it as unknown — do not guess.'

export type Tier = 'hot' | 'warm' | 'cold'
export const tierOf = (score: number): Tier => (score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold')

export type QualResult = { score: number; tier: Tier; reason: string }

export type QualifyConfig = {
  criteria: string
  status: 'idle' | 'running' | 'done' | 'error'
  scanned: number
  total: number
  lastRun: number | null
  error?: string | null
}
export function defaultQualify(): QualifyConfig {
  return { criteria: DEFAULT_CRITERIA, status: 'idle', scanned: 0, total: 0, lastRun: null, error: null }
}

// Strict json_schema — score + reason. tier is derived in code (kept out of the schema so the
// model can't disagree with the threshold).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer', description: 'fit score 0-100; 0 = clear disqualify, 100 = perfect ICP match' },
    reason: { type: 'string', description: 'one concise sentence justifying the score, citing the data used' },
  },
  required: ['score', 'reason'],
}

// Build the grounded dossier passed to the model. Only includes signals we actually have.
function dossier(row: UpsertRow, enriched: Awaited<ReturnType<typeof enrichHandle>> | null): string {
  const v = row.vars ?? {}
  const fields: Record<string, unknown> = {
    instagram_handle: row.instagram_handle ?? v.instagram_handle ?? null,
    name: row.name ?? null,
    category: row.category ?? v.category ?? null,
    event_link: row.event_link ?? v.instagram_link ?? null,
    has_phone: !!row.phone,
  }
  if (enriched) {
    fields.followers = enriched.followers
    fields.is_business = enriched.isBusiness
    fields.ig_category = enriched.category || null
    fields.bio = enriched.bio || null
    fields.website = enriched.externalUrl || null
  }
  // carry any other user-provided vars the row already holds (e.g. from an Attio import)
  for (const [k, val] of Object.entries(v)) {
    if (!(k in fields) && k !== 'instagram_handle' && k !== 'instagram_link' && k !== 'category') fields[k] = val
  }
  return JSON.stringify(fields)
}

function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text
  let txt = ''
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') for (const c of item?.content ?? []) if (c?.text) txt += c.text
  }
  return txt
}

// Score a single grounded dossier. Best-effort: returns a cold/0 fallback on any failure so a
// qualify run never stalls on one bad row.
async function judge(criteria: string, doss: string): Promise<QualResult> {
  const key = process.env.OPENAI_API_KEY
  const fallback: QualResult = { score: 0, tier: 'cold', reason: 'could not evaluate' }
  if (!key) return fallback
  const input =
    `You are a B2B lead-qualification analyst. Score how well this lead fits the criteria below.\n\n` +
    `QUALIFICATION CRITERIA:\n${criteria}\n\n` +
    `LEAD DATA (JSON — these are the ONLY facts you may use; do not invent or assume anything else):\n${doss}\n\n` +
    `Return a fit score 0-100 and one sentence explaining it. Lower the score when key signals are ` +
    `missing rather than guessing. Apply any disqualifiers as a score below 40.`
  const body = JSON.stringify({
    model: MODEL,
    reasoning: { effort: 'low' },
    input,
    text: { format: { type: 'json_schema', name: 'lead_score', strict: true, schema: SCHEMA } },
  })
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
    })
    if (!res.ok) return fallback
    const data = await res.json()
    const parsed = JSON.parse(extractText(data) || '{}')
    let score = Number(parsed.score)
    if (!Number.isFinite(score)) return fallback
    score = Math.max(0, Math.min(100, Math.round(score)))
    return { score, tier: tierOf(score), reason: String(parsed.reason ?? '').slice(0, 240) }
  } catch {
    return fallback
  }
}

// --- list config plumbing (qualify state lives alongside rows in the list's config JSON) ---
function readList(tenantId: string, listId: number): { cfg: any; rows: UpsertRow[]; qualify: QualifyConfig } | null {
  const list = getLeadList(tenantId, listId)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return null
  const cfg = JSON.parse(list.config)
  return { cfg, rows: (cfg.rows as UpsertRow[]) ?? [], qualify: (cfg.qualify as QualifyConfig) ?? defaultQualify() }
}
function writeList(tenantId: string, listId: number, cfg: any, rows: UpsertRow[], qualify: QualifyConfig): void {
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(
    JSON.stringify({ ...cfg, rows, qualify }),
    listId,
    tenantId,
  )
}

const running = new Set<number>()
export const isQualifying = (listId: number) => running.has(listId)

// Persist the criteria a user edited without running a pass yet.
export function saveCriteria(tenantId: string, listId: number, criteria: string): boolean {
  const r = readList(tenantId, listId)
  if (!r) return false
  r.qualify.criteria = criteria
  writeList(tenantId, listId, r.cfg, r.rows, r.qualify)
  return true
}

// Score every row in a list against its stored criteria. Runs in the background; persists after
// each row so the table fills live. Concurrency-capped to keep OpenAI spend predictable.
export async function runQualify(tenantId: string, listId: number, concurrency = 6): Promise<void> {
  if (running.has(listId)) return
  running.add(listId)
  const init = readList(tenantId, listId)
  if (!init) {
    running.delete(listId)
    return
  }
  const { cfg, rows } = init
  const q = init.qualify
  q.status = 'running'
  q.error = null
  q.scanned = 0
  q.total = rows.length
  writeList(tenantId, listId, cfg, rows, q)

  let next = 0
  const useHiker = hikerAvailable()
  async function worker() {
    while (true) {
      const i = next++
      if (i >= rows.length) return
      const row = rows[i]
      const handle = (row.instagram_handle ?? row.vars?.instagram_handle ?? '').replace(/^@/, '')
      const enriched = useHiker && handle ? await enrichHandle(handle).catch(() => null) : null
      const result = await judge(q.criteria, dossier(row, enriched))
      row.vars = {
        ...(row.vars ?? {}),
        qual_score: String(result.score),
        qual_tier: result.tier,
        qual_reason: result.reason,
      }
      q.scanned++
      writeList(tenantId, listId, cfg, rows, q) // incremental → live table
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) || 1 }, worker))
    q.status = 'done'
    q.lastRun = Date.now()
  } catch (err) {
    q.status = 'error'
    q.error = (err as Error).message
  } finally {
    writeList(tenantId, listId, cfg, rows, q)
    running.delete(listId)
  }
}

export type QualRow = {
  instagram_handle: string | null
  name: string | null
  phone: string
  event_link: string | null
  category: string | null
  score: number | null
  tier: Tier | null
  reason: string | null
}

// Status snapshot for the Qualifying page to poll: progress + the scored rows + a tier breakdown.
export function qualifyStatus(tenantId: string, listId: number) {
  const r = readList(tenantId, listId)
  if (!r) return null
  const rows: QualRow[] = r.rows.map((row) => {
    const v = row.vars ?? {}
    const score = v.qual_score != null ? Number(v.qual_score) : null
    return {
      instagram_handle: row.instagram_handle ?? v.instagram_handle ?? null,
      name: row.name ?? null,
      phone: row.phone || '',
      event_link: row.event_link ?? v.instagram_link ?? null,
      category: row.category ?? v.category ?? null,
      score: Number.isFinite(score as number) ? (score as number) : null,
      tier: (v.qual_tier as Tier) ?? null,
      reason: v.qual_reason ?? null,
    }
  })
  const counts = { hot: 0, warm: 0, cold: 0, scored: 0 }
  for (const row of rows) if (row.tier) { counts[row.tier]++; counts.scored++ }
  return {
    status: running.has(listId) ? 'running' : r.qualify.status,
    scanned: r.qualify.scanned,
    total: r.qualify.total || rows.length,
    criteria: r.qualify.criteria,
    counts,
    rows,
  }
}

// Pull the UpsertRows that qualified, for spinning off a new list. `min` is the score floor
// (e.g. 70 for hot only, 40 for warm+). Returns clean UpsertRows ready for createCsvList.
export function qualifiedRows(tenantId: string, listId: number, min: number): UpsertRow[] {
  const r = readList(tenantId, listId)
  if (!r) return []
  return r.rows.filter((row) => {
    const s = Number(row.vars?.qual_score)
    return Number.isFinite(s) && s >= min
  })
}
