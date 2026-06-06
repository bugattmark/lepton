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
    case 'date':
      return v.value ?? ''
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
  lastContactAt?: number | null // ms epoch from the last-WhatsApp-contact date attr, if present
  skipReason?: string // set when the record can't be messaged (no phone / opted out)
}

const digits = (s: string) => s.replace(/[^0-9]/g, '')

// POST /v2/objects/{object}/records/query — page through records (optionally a subset of
// record IDs when importing from a list, and/or a server-side attribute filter).
async function queryRecords(
  apiKey: string,
  object: string,
  recordIds?: string[],
  filter?: Record<string, unknown>,
): Promise<any[]> {
  const out: any[] = []
  const PAGE = 100
  if (recordIds && recordIds.length === 0) return out

  if (recordIds) {
    for (let i = 0; i < recordIds.length; i += PAGE) {
      const chunk = recordIds.slice(i, i + PAGE)
      const j = await attio(apiKey, `/objects/${object}/records/query`, {
        method: 'POST',
        body: JSON.stringify({ filter: { ...(filter ?? {}), record_id: { $in: chunk } }, limit: PAGE }),
      })
      out.push(...(j?.data ?? []))
    }
    return out
  }

  for (let offset = 0; ; offset += PAGE) {
    const j = await attio(apiKey, `/objects/${object}/records/query`, {
      method: 'POST',
      body: JSON.stringify({ ...(filter ? { filter } : {}), limit: PAGE, offset }),
    })
    const page = j?.data ?? []
    out.push(...page)
    if (page.length < PAGE) break
    if (offset > 50_000) break // safety stop
  }
  return out
}

// Lightweight one-page sample → per-attribute coverage (fraction of records with a value),
// used to drive auto-mapping suggestions without paging the whole object.
export async function sampleCoverage(apiKey: string, object: string, sampleSize = 100): Promise<Record<string, number>> {
  const j = await attio(apiKey, `/objects/${object}/records/query`, {
    method: 'POST',
    body: JSON.stringify({ limit: Math.min(sampleSize, 500) }),
  })
  const recs = j?.data ?? []
  const cov: Record<string, number> = {}
  if (!recs.length) return cov
  const counts: Record<string, number> = {}
  for (const r of recs) {
    const values = r?.values ?? {}
    for (const slug of Object.keys(values)) {
      const v = values[slug]
      if (Array.isArray(v) ? v.length > 0 : v != null) counts[slug] = (counts[slug] ?? 0) + 1
    }
  }
  for (const slug of Object.keys(counts)) cov[slug] = counts[slug] / recs.length
  return cov
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
  contacts: PulledContact[] // messageable (have a phone, not recently contacted)
  skipped: { noPhone: number; optedOut: number; suppressed: number }
  total: number
}

const DAY_MS = 86_400_000

export interface AttioMapping {
  phone?: string // attribute slug holding the phone number (optional — blank when unmapped)
  name?: string // attribute slug holding the name (optional)
  instagram?: string // attribute slug → our Instagram column
  link?: string // attribute slug → our Link column
  category?: string // attribute slug → our Category column
  vars?: string[] // extra attribute slugs to expose as template variables
}

// --- auto-mapping: guess which attributes are phone/name/ig/link/email from type + slug/title,
// so the user confirms a filled-in mapping instead of picking every field by hand. ---
const kw = (a: AttioAttr, ...words: string[]) => {
  const hay = (a.api_slug + ' ' + a.title).toLowerCase()
  return words.some((w) => hay.includes(w))
}
// Whole-token match (so "linkedin" doesn't match "link", "avatar_url" doesn't count as a link).
const tok = (a: AttioAttr): string[] => (a.api_slug + ' ' + a.title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const tokAny = (a: AttioAttr, ...words: string[]) => {
  const t = tok(a)
  return words.some((w) => t.includes(w))
}

export interface SuggestedMapping extends AttioMapping {
  email?: string // email attribute slug (exposed as an {{email}} var)
  instagram?: string // IG-handle attribute slug
  link?: string // URL/link attribute slug
}

// Pure heuristic. `coverage` (slug -> fraction with data, 0..1) lets us avoid suggesting
// fields that are present in the schema but empty in practice (e.g. an unused IG column).
export function suggestMapping(attrs: AttioAttr[], coverage: Record<string, number> = {}): SuggestedMapping {
  const has = (slug?: string) => !!slug && (coverage[slug] === undefined || coverage[slug] > 0)
  const byType = (t: string) => attrs.find((a) => a.type === t)?.api_slug
  const byKw = (...w: string[]) => attrs.find((a) => kw(a, ...w))?.api_slug

  // phone-number type is authoritative; otherwise a field whose name is literally phone/mobile.
  // (Deliberately NOT matching "whatsapp" — that hits jid/date columns, not dial-able numbers.)
  const phone = byType('phone-number') ?? attrs.find((a) => tokAny(a, 'phone', 'mobile'))?.api_slug ?? ''
  const name = byType('personal-name') ?? byKw('name')
  const email = byType('email-address')
  const igRaw = attrs.find((a) => tokAny(a, 'instagram', 'ig', 'handle'))?.api_slug
  // a real link/url, not the avatar/logo image url and not a named social (linkedin/twitter)
  const linkRaw = attrs.find(
    (a) => tokAny(a, 'url', 'urls', 'link', 'links', 'website', 'bio') && !tokAny(a, 'avatar', 'image', 'logo', 'photo'),
  )?.api_slug
  const instagram = has(igRaw) ? igRaw : undefined
  const link = has(linkRaw) ? linkRaw : undefined

  // template vars: email + the IG/link we found, plus any short text field that actually has data
  const vars: string[] = []
  for (const slug of [email, instagram, link]) if (slug && !vars.includes(slug)) vars.push(slug)

  return { phone, name, email: has(email) ? email : undefined, instagram, link, vars }
}

// A date attribute that records the last WhatsApp contact (suppression source + write-back target).
export function whatsappDateSlug(attrs: AttioAttr[]): string | undefined {
  return attrs.find((a) => a.type === 'date' && kw(a, 'whatsapp'))?.api_slug
}

// The select attribute that holds a contact's preferred channel (filter candidate).
export function channelSelectSlug(attrs: AttioAttr[]): string | undefined {
  return attrs.find((a) => a.type === 'select' && kw(a, 'channel'))?.api_slug
}

// GET /v2/objects/{object}/attributes/{slug}/options — active option titles for a select attr.
export async function listSelectOptions(apiKey: string, object: string, slug: string): Promise<string[]> {
  const j = await attio(apiKey, `/objects/${object}/attributes/${slug}/options`)
  return (j?.data ?? []).filter((o: any) => !o?.is_archived).map((o: any) => o?.title).filter(Boolean)
}

// --- server-side filters (narrow the pull in Attio rather than after) ---
export interface AttioFilterConfig {
  primaryChannel?: string // select-attribute equality, e.g. "WhatsApp"
  hasEmail?: boolean // require a non-empty email address
}

// Translate our friendly filter config into an Attio query `filter` object using the object's
// own attributes (slugs/types vary per object). Returns undefined when nothing is set.
function buildFilter(cfg: AttioFilterConfig | undefined, attrs: AttioAttr[]): Record<string, unknown> | undefined {
  if (!cfg) return undefined
  const filter: Record<string, unknown> = {}
  if (cfg.primaryChannel) {
    const sel = attrs.find((a) => a.type === 'select' && kw(a, 'channel'))?.api_slug ?? 'primary_channel'
    filter[sel] = cfg.primaryChannel
  }
  if (cfg.hasEmail) {
    const email = attrs.find((a) => a.type === 'email-address')?.api_slug
    if (email) filter[email] = { $contains: '@' } // every address contains '@' → "has email"
  }
  return Object.keys(filter).length ? filter : undefined
}

// Generic pull: any object, any list, with the user's own attribute mapping. Optional
// server-side filter, and 10-day suppression off the workspace's last-WhatsApp-contact date.
export async function pullContacts(
  apiKey: string,
  opts: { object: string; listId?: string; mapping: AttioMapping; filter?: AttioFilterConfig; suppressDays?: number },
): Promise<PullResult> {
  const { object, listId, mapping, filter, suppressDays } = opts
  const attrs = await listObjectAttributes(apiKey, object)
  const typeOf: Record<string, string> = {}
  for (const a of attrs) typeOf[a.api_slug] = a.type

  const attioFilter = buildFilter(filter, attrs)
  const waDateSlug = suppressDays ? whatsappDateSlug(attrs) : undefined
  const cutoff = suppressDays ? Date.now() - suppressDays * DAY_MS : 0

  const records = listId
    ? await queryRecords(apiKey, object, await listEntryRecordIds(apiKey, listId), attioFilter)
    : await queryRecords(apiKey, object, undefined, attioFilter)

  const contacts: PulledContact[] = []
  const skipped = { noPhone: 0, optedOut: 0, suppressed: 0 }

  for (const rec of records) {
    const values = rec?.values ?? {}
    // phone is optional: if no attribute is mapped, import the row with a blank phone.
    const phone = mapping.phone ? digits(extract(values, mapping.phone, typeOf[mapping.phone] ?? 'phone-number')) : ''
    if (mapping.phone && !phone) {
      // a phone WAS mapped but this record has none → skip it
      skipped.noPhone++
      continue
    }

    // 10-day suppression off Attio's own last-WhatsApp-contact date (cross-tool dedup)
    let lastContactAt: number | null = null
    if (waDateSlug) {
      const raw = extract(values, waDateSlug, 'date')
      const t = raw ? Date.parse(raw) : NaN
      if (!Number.isNaN(t)) lastContactAt = t
    }
    if (waDateSlug && lastContactAt != null && lastContactAt >= cutoff) {
      skipped.suppressed++
      continue
    }

    const name = mapping.name ? extract(values, mapping.name, typeOf[mapping.name] ?? 'text') || null : null

    const vars: Record<string, string> = {}
    for (const slug of mapping.vars ?? []) {
      const val = extract(values, slug, typeOf[slug] ?? 'text')
      if (val) vars[slug] = val
    }
    // explicit column slots → canonical keys the list-preview/table reads
    const slot = (slug?: string) => (slug ? extract(values, slug, typeOf[slug] ?? 'text') : '')
    const ig = slot(mapping.instagram)
    if (ig) vars.instagram_handle = String(ig).replace(/^@/, '')
    const link = slot(mapping.link)
    if (link) vars.event_link = link
    const cat = slot(mapping.category)
    if (cat) vars.category = cat
    // convenience name parts when the name attribute is a personal-name
    if (mapping.name && typeOf[mapping.name] === 'personal-name') {
      const nv = Array.isArray(values[mapping.name]) ? values[mapping.name][0] : undefined
      if (nv?.first_name) vars.first_name = nv.first_name
      if (nv?.last_name) vars.last_name = nv.last_name
      if (nv?.full_name) vars.full_name = nv.full_name
    }

    contacts.push({ name, phone, attioRecordId: rec?.id?.record_id ?? '', vars, lastContactAt })
  }
  return { contacts, skipped, total: records.length }
}

// Write a date (YYYY-MM-DD) onto a single-value date attribute — the last-WhatsApp-contact
// stamp used for suppression. Best-effort; callers swallow errors.
export async function writeDateAttr(
  apiKey: string,
  object: string,
  recordId: string,
  slug: string,
  isoDate: string,
): Promise<void> {
  if (!recordId || !slug) return
  await attio(apiKey, `/objects/${object}/records/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { values: { [slug]: isoDate } } }),
  })
}
