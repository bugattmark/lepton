// AI dedupe + cleanup agent for a lead-list table. Runs AFTER rows are added (Instagram
// sourcing or Attio import) — both just append NEW rows, so this is the consolidation pass.
//
// Given the table, a small gpt-5.4 agent returns a list of operations, enforced by the
// OpenAI structured-outputs json_schema (strict) — the API-side equivalent of a Pydantic model:
//   - op="remove": drop a redundant duplicate row              ( the "- row X" case )
//   - op="modify": keep one row but replace it with a cleaned/  ( the "= row X, vals…" case )
//                  merged version (all column fields provided)
//
// Needs OPENAI_API_KEY. Never throws on a missing key (returns no operations).

const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'
const ENDPOINT = 'https://api.openai.com/v1/responses'

export const dedupeAvailable = () => !!process.env.OPENAI_API_KEY

export interface DedupeRow {
  instagram_handle: string | null
  name: string | null
  phone: string | null
  event_link: string | null
  category: string | null
}

export type DedupeOp = {
  op: 'remove' | 'modify'
  index: number
  instagram_handle: string | null
  name: string | null
  phone: string | null
  event_link: string | null
  category: string | null
  reason: string
}

// Strict json_schema — every property required + additionalProperties:false (structured-output rules).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['remove', 'modify'] },
          index: { type: 'integer', description: '0-based row index in the provided table' },
          instagram_handle: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          event_link: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['op', 'index', 'instagram_handle', 'name', 'phone', 'event_link', 'category', 'reason'],
      },
    },
  },
  required: ['operations'],
}

function buildPrompt(rows: DedupeRow[]): string {
  const table = JSON.stringify(rows.map((r, i) => ({ index: i, ...r })))
  return (
    `You are a CRM dedupe + cleanup agent for an outbound lead table. ` +
    `Columns: instagram_handle, name, phone, event_link, category.\n\n` +
    `Table as JSON (index = row position):\n${table}\n\n` +
    `Find genuine DUPLICATES — the same person/business appearing in more than one row ` +
    `(same instagram_handle, same phone number, or unmistakably the same entity by name). ` +
    `For each duplicate cluster, emit operations:\n` +
    `- op="remove" — drop the redundant extra copies (give the index of each copy to delete).\n` +
    `- op="modify" — keep ONE row of the cluster and replace it with the best merged/cleaned ` +
    `version: fill blank fields from the duplicates, normalise obvious formatting. Provide ALL ` +
    `column fields for the replacement row.\n\n` +
    `Rules: only act on real duplicates or rows clearly needing a cleanup merge. Never invent data ` +
    `that isn't present in the rows. Leave unique, already-clean rows untouched (emit no operation ` +
    `for them). Every index must reference the original table positions above.`
  )
}

function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text
  let txt = ''
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') for (const c of item?.content ?? []) if (c?.text) txt += c.text
  }
  return txt
}

// Returns the operations the agent proposes. Empty array on missing key.
export async function dedupe(rows: DedupeRow[]): Promise<DedupeOp[]> {
  const key = process.env.OPENAI_API_KEY
  if (!key || !rows.length) return []
  const body = JSON.stringify({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: buildPrompt(rows),
    text: { format: { type: 'json_schema', name: 'dedupe_ops', strict: true, schema: SCHEMA } },
  })
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body,
  })
  if (!res.ok) throw new Error(`dedupe LLM HTTP ${res.status}`)
  const data = await res.json()
  const parsed = JSON.parse(extractText(data) || '{"operations":[]}')
  return (parsed.operations ?? []) as DedupeOp[]
}

// Apply operations to a rows array: modify in place, then drop removed indices. Pure — returns
// the new rows. `keepExtra` carries any non-table fields (source, vars) on modified rows.
export function applyOps<T extends DedupeRow & Record<string, unknown>>(rows: T[], ops: DedupeOp[]): { rows: T[]; removed: number; modified: number } {
  const remove = new Set<number>()
  let modified = 0
  for (const op of ops) {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index >= rows.length) continue
    if (op.op === 'remove') {
      remove.add(op.index)
    } else if (op.op === 'modify') {
      rows[op.index] = {
        ...rows[op.index],
        instagram_handle: op.instagram_handle,
        name: op.name,
        phone: op.phone ?? '',
        event_link: op.event_link,
        category: op.category,
      }
      modified++
    }
  }
  const out = rows.filter((_, i) => !remove.has(i))
  return { rows: out, removed: remove.size, modified }
}
