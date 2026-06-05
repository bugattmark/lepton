// Attio connector: each tenant pastes their own Attio API key. We read their
// People records (from a List or the whole object) and pull phone + name + a few
// personalization fields. Nothing is written back in v1.
//
// Attio REST: https://docs.attio.com/rest-api — Bearer auth, limit/offset paging.

const BASE = 'https://api.attio.com/v2'

export class AttioError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AttioError'
    this.status = status
  }
}

async function attio(apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new AttioError('Invalid or unauthorized Attio API key', res.status)
    throw new AttioError(`Attio ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
  return res.json()
}

export interface AttioWorkspace {
  workspace_name?: string
  workspace_id?: string
}

// GET /v2/self — validates the key and returns workspace identity.
export async function testKey(apiKey: string): Promise<AttioWorkspace> {
  const j = await attio(apiKey, '/self')
  return { workspace_name: j?.data?.workspace_name, workspace_id: j?.data?.workspace_id }
}

export interface AttioObject {
  api_slug: string
  singular: string
  plural: string
}

// GET /v2/objects — every object type in the workspace (people, companies, custom…).
export async function listObjects(apiKey: string): Promise<AttioObject[]> {
  const j = await attio(apiKey, '/objects')
  return (j?.data ?? []).map((o: any) => ({
    api_slug: o?.api_slug ?? '',
    singular: o?.singular_noun ?? o?.api_slug ?? '',
    plural: o?.plural_noun ?? o?.api_slug ?? '',
  }))
}

export interface AttioAttr {
  api_slug: string
  title: string
  type: string
}

// GET /v2/objects/{object}/attributes — so the user can map which field is the phone, etc.
export async function listObjectAttributes(apiKey: string, object: string): Promise<AttioAttr[]> {
  const j = await attio(apiKey, `/objects/${object}/attributes?limit=100`)
  return (j?.data ?? [])
    .filter((a: any) => !a?.is_archived)
    .map((a: any) => ({ api_slug: a?.api_slug ?? '', title: a?.title ?? a?.api_slug ?? '', type: a?.type ?? 'text' }))
}

export interface AttioList {
  id: string
  name: string
  api_slug: string
  parent_object: string
}

// GET /v2/lists — optionally filtered to those whose parent is a given object.
export async function listLists(apiKey: string, object?: string): Promise<AttioList[]> {
  const j = await attio(apiKey, '/lists')
  const lists = (j?.data ?? []).map((l: any) => ({
    id: l?.id?.list_id ?? l?.id,
    name: l?.name ?? '(untitled)',
    api_slug: l?.api_slug ?? '',
    parent_object: Array.isArray(l?.parent_object) ? l.parent_object[0] : l?.parent_object ?? '',
  }))
  return object ? lists.filter((l: AttioList) => l.parent_object === object) : lists
}

// POST /v2/notes — write a timeline note on a record (used for activity write-back).
export async function writeNote(
  apiKey: string,
  object: string,
  recordId: string,
  title: string,
  content: string,
): Promise<void> {
  if (!recordId) return
  await attio(apiKey, '/notes', {
    method: 'POST',
    body: JSON.stringify({
      data: { parent_object: object, parent_record_id: recordId, title, format: 'plaintext', content },
    }),
  })
}

// Pull a single string out of an Attio attribute value, by attribute type.
function extract(values: any, slug: string, type: string): string {
  const arr = values?.[slug]
  if (!Array.isArray(arr) || !arr.length) return ''
  const v = arr[0]
  switch (type) {
    case 'phone-number':
      return v.phone_number ?? v.original_phone_number ?? ''
    case 'personal-name':
      return v.full_name ?? [v.first_name, v.last_name].filter(Boolean).join(' ') ?? ''
    case 'email-address':
      return v.email_address ?? ''
    case 'select':
      return v.option?.title ?? ''
    case 'status':
      return v.status?.title ?? ''
    case 'number':
    case 'rating':
      return v.value != null ? String(v.value) : ''
    case 'currency':
      return v.currency_value != null ? String(v.currency_value) : ''
    case 'text':
    default:
      return typeof v === 'string' ? v : v.value ?? ''
  }
}

export interface PulledContact {
  name: string | null
  phone: string // normalized digits, no '+'
  attioRecordId: string
  vars: Record<string, string>
  skipReason?: string // set when the record can't be messaged (no phone / opted out)
}

const digits = (s: string) => s.replace(/[^0-9]/g, '')

// POST /v2/objects/{object}/records/query — page through records (optionally a subset of
// record IDs when importing from a list).
async function queryRecords(apiKey: string, object: string, recordIds?: string[]): Promise<any[]> {
  const out: any[] = []
  const PAGE = 100
  if (recordIds && recordIds.length === 0) return out

  if (recordIds) {
    for (let i = 0; i < recordIds.length; i += PAGE) {
      const chunk = recordIds.slice(i, i + PAGE)
      const j = await attio(apiKey, `/objects/${object}/records/query`, {
        method: 'POST',
        body: JSON.stringify({ filter: { record_id: { $in: chunk } }, limit: PAGE }),
      })
      out.push(...(j?.data ?? []))
    }
    return out
  }

  for (let offset = 0; ; offset += PAGE) {
    const j = await attio(apiKey, `/objects/${object}/records/query`, {
      method: 'POST',
      body: JSON.stringify({ limit: PAGE, offset }),
    })
    const page = j?.data ?? []
    out.push(...page)
    if (page.length < PAGE) break
    if (offset > 50_000) break // safety stop
  }
  return out
}

// POST /v2/lists/{list}/entries/query — page through entries, collect parent person IDs.
async function listEntryRecordIds(apiKey: string, listId: string): Promise<string[]> {
  const ids: string[] = []
  const PAGE = 500
  for (let offset = 0; ; offset += PAGE) {
    const j = await attio(apiKey, `/lists/${listId}/entries/query`, {
      method: 'POST',
      body: JSON.stringify({ limit: PAGE, offset }),
    })
    const page = j?.data ?? []
    for (const e of page) {
      const rid = e?.parent_record_id ?? e?.parent_record?.record_id
      if (rid) ids.push(rid)
    }
    if (page.length < PAGE) break
    if (offset > 50_000) break
  }
  return ids
}

export interface PullResult {
  contacts: PulledContact[] // messageable (have a phone)
  skipped: { noPhone: number; optedOut: number }
  total: number
}

export interface AttioMapping {
  phone: string // attribute slug holding the phone number
  name?: string // attribute slug holding the name (optional)
  vars?: string[] // attribute slugs to expose as template variables
}

// Generic pull: any object, any list, with the user's own attribute mapping.
export async function pullContacts(
  apiKey: string,
  opts: { object: string; listId?: string; mapping: AttioMapping },
): Promise<PullResult> {
  const { object, listId, mapping } = opts
  const attrs = await listObjectAttributes(apiKey, object)
  const typeOf: Record<string, string> = {}
  for (const a of attrs) typeOf[a.api_slug] = a.type

  const records = listId
    ? await queryRecords(apiKey, object, await listEntryRecordIds(apiKey, listId))
    : await queryRecords(apiKey, object)

  const contacts: PulledContact[] = []
  const skipped = { noPhone: 0, optedOut: 0 }

  for (const rec of records) {
    const values = rec?.values ?? {}
    const phone = digits(extract(values, mapping.phone, typeOf[mapping.phone] ?? 'phone-number'))
    if (!phone) {
      skipped.noPhone++
      continue
    }
    const name = mapping.name ? extract(values, mapping.name, typeOf[mapping.name] ?? 'text') || null : null

    const vars: Record<string, string> = {}
    for (const slug of mapping.vars ?? []) {
      const val = extract(values, slug, typeOf[slug] ?? 'text')
      if (val) vars[slug] = val
    }
    // convenience name parts when the name attribute is a personal-name
    if (mapping.name && typeOf[mapping.name] === 'personal-name') {
      const nv = Array.isArray(values[mapping.name]) ? values[mapping.name][0] : undefined
      if (nv?.first_name) vars.first_name = nv.first_name
      if (nv?.last_name) vars.last_name = nv.last_name
      if (nv?.full_name) vars.full_name = nv.full_name
    }

    contacts.push({ name, phone, attioRecordId: rec?.id?.record_id ?? '', vars })
  }
  return { contacts, skipped, total: records.length }
}
