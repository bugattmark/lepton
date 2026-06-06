// Audience + campaign + template persistence. Thin DB layer the routes call into.
import { db } from './db.ts'
import type { CampaignRow, ContactRow, SendProfileRow, LeadListRow } from './db.ts'
import type { PulledContact } from './attio.ts'
import { enc, dec } from './secret.ts'
import { parseSequence, fallbackSequence, firstNode, nodeById, outgoing, type Sequence } from './sequence.ts'
import { getPolicy } from './policy.ts'
import { createHash } from 'node:crypto'

// --- Attio key (per tenant) — encrypted at rest ---
export function saveAttioKey(tenantId: string, key: string): void {
  db.prepare('UPDATE tenants SET attio_api_key = ? WHERE id = ?').run(enc(key), tenantId)
}
export function clearAttioKey(tenantId: string): void {
  db.prepare('UPDATE tenants SET attio_api_key = NULL WHERE id = ?').run(tenantId)
}
export function getAttioKey(tenantId: string): string | null {
  const raw = (db.prepare('SELECT attio_api_key FROM tenants WHERE id = ?').get(tenantId) as { attio_api_key: string | null })
    ?.attio_api_key
  return raw ? dec(raw) || null : null
}

export function setWriteback(tenantId: string, on: boolean): void {
  db.prepare('UPDATE tenants SET attio_writeback = ? WHERE id = ?').run(on ? 1 : 0, tenantId)
}
export function getWriteback(tenantId: string): boolean {
  return (
    ((db.prepare('SELECT attio_writeback FROM tenants WHERE id = ?').get(tenantId) as { attio_writeback: number | null })
      ?.attio_writeback ?? 0) === 1
  )
}

// Best-effort: log an activity note back to the contact's Attio record (if enabled).
export function writebackNote(tenantId: string, contactId: number, text: string): void {
  if (!getWriteback(tenantId)) return
  const key = getAttioKey(tenantId)
  if (!key) return
  const c = db
    .prepare('SELECT attio_record_id, attio_object FROM contacts WHERE id = ? AND tenant_id = ?')
    .get(contactId, tenantId) as { attio_record_id: string | null; attio_object: string | null } | undefined
  if (!c?.attio_record_id) return
  void import('./attio.ts').then((a) =>
    a.writeNote(key, c.attio_object ?? 'people', c.attio_record_id as string, 'WhatsApp', text).catch(() => {}),
  )
}

// --- reply-driven Attio stage sync config ---
export interface SyncConfig {
  salesListId: string
  stageAttr: string
  summaryAttr: string
  jidAttr: string
  stageOptions: string[]
  debounceMinutes?: number
}

export function saveSyncConfig(tenantId: string, config: SyncConfig): void {
  db.prepare('UPDATE tenants SET attio_stage_sync = 1, attio_sync_config = ? WHERE id = ?').run(
    JSON.stringify(config),
    tenantId,
  )
}

export function getSyncConfig(tenantId: string): SyncConfig | null {
  const row = db.prepare('SELECT attio_stage_sync, attio_sync_config FROM tenants WHERE id = ?').get(tenantId) as {
    attio_stage_sync: number | null
    attio_sync_config: string | null
  } | undefined
  if (!row || row.attio_stage_sync !== 1 || !row.attio_sync_config) return null
  try {
    return JSON.parse(row.attio_sync_config) as SyncConfig
  } catch {
    return null
  }
}

export function getBusinessDescription(tenantId: string): string | null {
  const row = db.prepare('SELECT business_description FROM tenants WHERE id = ?').get(tenantId) as {
    business_description: string | null
  } | undefined
  return row?.business_description ?? null
}

export function saveBusinessDescription(tenantId: string, desc: string): void {
  db.prepare('UPDATE tenants SET business_description = ? WHERE id = ?').run(desc, tenantId)
}

const summaryHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export async function syncStageOnReply(tenantId: string, contactId: number): Promise<void> {
  const cfg = getSyncConfig(tenantId)
  if (!cfg) return

  const apiKey = getAttioKey(tenantId)
  if (!apiKey) return

  const contact = db
    .prepare('SELECT phone, name, attio_record_id, attio_object, attio_synced_at, attio_synced_stage, attio_summary_hash FROM contacts WHERE id = ? AND tenant_id = ?')
    .get(contactId, tenantId) as {
      phone: string; name: string | null; attio_record_id: string | null; attio_object: string | null;
      attio_synced_at: number | null; attio_synced_stage: string | null; attio_summary_hash: string | null;
    } | undefined
  if (!contact) return

  const debounceMs = (cfg.debounceMinutes ?? 10) * 60_000
  if (contact.attio_synced_at && Date.now() - contact.attio_synced_at < debounceMs) return

  const jid = contact.phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
  const msgs = db
    .prepare('SELECT direction, body FROM messages WHERE tenant_id = ? AND jid = ? ORDER BY created_at ASC')
    .all(tenantId, jid) as { direction: string; body: string | null }[]
  if (!msgs.length) return
  const transcript = msgs
    .filter((m) => m.body)
    .map((m) => `${m.direction === 'out' ? 'Us' : 'Them'}: ${m.body}`)
    .join('\n')
  if (!transcript) return

  const ai = await import('./ai.ts')
  const bizDesc = getBusinessDescription(tenantId)
  const result = await ai.assessConversation({
    transcript,
    contactName: contact.name,
    stageOptions: cfg.stageOptions,
    businessDescription: bizDesc,
  })
  if (!result) return

  db.prepare('UPDATE contacts SET attio_synced_at = ? WHERE id = ?').run(Date.now(), contactId)

  const newHash = summaryHash(result.summary)
  if (result.stage === contact.attio_synced_stage && newHash === contact.attio_summary_hash) return

  const attio = await import('./attio.ts')

  let companyId: string | null = null
  const byJid = await attio.queryEntryByJid(apiKey, cfg.salesListId, jid).catch(() => null)
  if (byJid) {
    companyId = byJid.parentRecordId
  }

  if (!companyId && contact.attio_record_id) {
    companyId = await attio.getPersonCompany(apiKey, contact.attio_record_id).catch(() => null)
  }

  if (!companyId) return

  await attio.upsertSalesEntry(apiKey, cfg.salesListId, companyId, {
    stage: result.stage,
    notes: result.summary,
    whatsapp_jid: jid,
  })

  db.prepare('UPDATE contacts SET attio_synced_stage = ?, attio_summary_hash = ? WHERE id = ?').run(
    result.stage,
    newHash,
    contactId,
  )
}

// --- 10-day suppression (don't cold-contact someone messaged within the window) ---
export const SUPPRESS_DAYS = 10
const DAY_MS = 86_400_000

// Drop contact ids messaged within the suppression window (local record of our own sends).
export function filterSuppressed(tenantId: string, ids: number[]): number[] {
  if (!ids.length) return ids
  const cutoff = Date.now() - SUPPRESS_DAYS * DAY_MS
  const stmt = db.prepare('SELECT last_messaged_at FROM contacts WHERE id = ? AND tenant_id = ?')
  return ids.filter((id) => {
    const r = stmt.get(id, tenantId) as { last_messaged_at: number | null } | undefined
    return !r?.last_messaged_at || r.last_messaged_at < cutoff
  })
}

// Cache of the per-object "last WhatsApp contact" date attribute slug (write-back target).
const waSlugCache = new Map<string, string | null>()
async function whatsappDateSlugFor(key: string, object: string): Promise<string | null> {
  if (waSlugCache.has(object)) return waSlugCache.get(object) ?? null
  const a = await import('./attio.ts')
  const slug = a.whatsappDateSlug(await a.listObjectAttributes(key, object)) ?? null
  waSlugCache.set(object, slug)
  return slug
}

// Record a successful send: stamp last_messaged_at locally and (if enabled) write today's
// date onto the contact's Attio last-WhatsApp-contact attribute for cross-tool suppression.
export function markMessaged(tenantId: string, contactId: number): void {
  db.prepare('UPDATE contacts SET last_messaged_at = ? WHERE id = ? AND tenant_id = ?').run(Date.now(), contactId, tenantId)
  if (!getWriteback(tenantId)) return
  const key = getAttioKey(tenantId)
  if (!key) return
  const c = db
    .prepare('SELECT attio_record_id, attio_object FROM contacts WHERE id = ? AND tenant_id = ?')
    .get(contactId, tenantId) as { attio_record_id: string | null; attio_object: string | null } | undefined
  if (!c?.attio_record_id) return
  const object = c.attio_object ?? 'people'
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  void whatsappDateSlugFor(key, object)
    .then((slug) => {
      if (slug) return import('./attio.ts').then((a) => a.writeDateAttr(key, object, c.attio_record_id as string, slug, today))
    })
    .catch(() => {})
}

// Cache the is-on-WhatsApp result so we only query Baileys once per contact.
export function cacheWhatsappRegistered(tenantId: string, contactId: number, registered: boolean): void {
  db.prepare('UPDATE contacts SET wa_registered = ?, wa_checked_at = ? WHERE id = ? AND tenant_id = ?').run(
    registered ? 1 : 0,
    Date.now(),
    contactId,
    tenantId,
  )
}

export function contactByPhone(tenantId: string, phone: string): { id: number } | undefined {
  return db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND phone = ?').get(tenantId, phone) as
    | { id: number }
    | undefined
}

// --- contacts ---
const onlyDigits = (s: string) => (s || '').replace(/[^0-9]/g, '')

export interface UpsertRow {
  name?: string | null
  phone: string
  vars?: Record<string, string>
  instagram_handle?: string | null
  event_link?: string | null
  category?: string | null
  source?: string
  attioRecordId?: string | null
  attioObject?: string | null
}

// Upsert contacts (deduped by phone within the tenant) and return their ids in input order.
export function upsertContacts(tenantId: string, rows: UpsertRow[]): number[] {
  const ins = db.prepare(
    `INSERT INTO contacts (tenant_id, name, phone, vars, source, attio_record_id, attio_object,
       instagram_handle, event_link, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, phone) DO UPDATE SET
       name = COALESCE(excluded.name, contacts.name),
       vars = excluded.vars,
       attio_record_id = COALESCE(excluded.attio_record_id, contacts.attio_record_id),
       attio_object = COALESCE(excluded.attio_object, contacts.attio_object),
       instagram_handle = COALESCE(excluded.instagram_handle, contacts.instagram_handle),
       event_link = COALESCE(excluded.event_link, contacts.event_link),
       category = COALESCE(excluded.category, contacts.category)`,
  )
  const find = db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND phone = ?')
  const ids: number[] = []
  const now = Date.now()
  for (const r of rows) {
    const phone = onlyDigits(r.phone)
    if (!phone) continue
    ins.run(
      tenantId,
      r.name ?? null,
      phone,
      JSON.stringify(r.vars ?? {}),
      r.source ?? 'manual',
      r.attioRecordId ?? null,
      r.attioObject ?? null,
      r.instagram_handle ?? null,
      r.event_link ?? null,
      r.category ?? null,
      now,
    )
    const row = find.get(tenantId, phone) as { id: number } | undefined
    if (row) ids.push(row.id)
  }
  return ids
}

// Attio pull → upsert (kept for the Attio path).
export function importAttioContacts(tenantId: string, pulled: PulledContact[], object = 'people'): number[] {
  return upsertContacts(
    tenantId,
    pulled
      .filter((c) => c.phone)
      .map((c) => ({
        name: c.name,
        phone: c.phone as string,
        vars: c.vars,
        source: 'attio',
        attioRecordId: c.attioRecordId,
        attioObject: object,
        instagram_handle: c.vars?.instagram_handle ?? c.vars?.instagram ?? null,
        event_link: c.vars?.instagram_link ?? c.vars?.event_link ?? null,
        category: c.vars?.category ?? null,
      })),
  )
}

// --- tiny CSV parser (handles quoted fields + commas/newlines inside quotes) ---
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const cells: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (row.length > 1 || row[0] !== '') cells.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      quoted = true
      i++
    } else if (ch === ',') {
      pushField()
      i++
    } else if (ch === '\n') {
      pushRow()
      i++
    } else if (ch === '\r') {
      i++
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || row.length) pushRow()
  const headers = (cells.shift() ?? []).map((h) => h.trim())
  return { headers, rows: cells }
}

// Map CSV rows → UpsertRow by sniffing headers. Phone is required; the rest are best-effort.
export function csvToContacts(text: string): { contacts: UpsertRow[]; scanned: number; noPhone: number } {
  const { headers, rows } = parseCsv(text)
  const low = headers.map((h) => h.toLowerCase())
  const find = (preds: string[]) => low.findIndex((h) => preds.some((p) => h.includes(p)))
  const iPhone = find(['phone', 'number', 'whatsapp', 'mobile', 'tel'])
  const iHandle = find(['instagram', 'handle', 'ig', 'username'])
  const iLink = find(['link', 'event', 'url', 'profile'])
  const iCategory = low.findIndex((h) => h === 'category' || h.includes('categor') || h.includes('segment') || h.includes('type'))
  const iName = low.findIndex((h) => h === 'name' || h.includes('name'))
  const contacts: UpsertRow[] = []
  let noPhone = 0
  for (const r of rows) {
    const phone = iPhone >= 0 ? onlyDigits(r[iPhone] ?? '') : ''
    if (!phone) {
      noPhone++
      continue
    }
    const vars: Record<string, string> = {}
    headers.forEach((h, idx) => {
      const key = h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      if (key && r[idx]) vars[key] = r[idx]
    })
    const handle = iHandle >= 0 ? (r[iHandle] ?? '').trim() : ''
    const link = iLink >= 0 ? (r[iLink] ?? '').trim() : ''
    const category = iCategory >= 0 ? (r[iCategory] ?? '').trim() : ''
    if (handle) vars.instagram_handle = handle
    if (link) vars.instagram_link = link
    if (category) vars.category = category
    contacts.push({
      name: iName >= 0 ? (r[iName] ?? '').trim() || null : null,
      phone,
      vars,
      source: 'csv',
      instagram_handle: handle || null,
      event_link: link || null,
      category: category || null,
    })
  }
  return { contacts, scanned: rows.length, noPhone }
}

export function listContacts(tenantId: string, limit = 50): ContactRow[] {
  return db
    .prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit) as ContactRow[]
}
export function countContacts(tenantId: string): { total: number; messageable: number } {
  const total = (db.prepare('SELECT COUNT(*) n FROM contacts WHERE tenant_id = ?').get(tenantId) as { n: number }).n
  const messageable = (db
    .prepare('SELECT COUNT(*) n FROM contacts WHERE tenant_id = ? AND opted_out = 0')
    .get(tenantId) as { n: number }).n
  return { total, messageable }
}

// --- send templates (reusable 3-knob engine presets, applied to a Send block) ---
export interface TemplateConfig {
  hourlyCap: number
  minGap: number
  maxGap: number
}
export const DEFAULT_TEMPLATE: TemplateConfig = { hourlyCap: 25, minGap: 25, maxGap: 70 }

export function listProfiles(tenantId: string): SendProfileRow[] {
  return db.prepare('SELECT * FROM send_profiles WHERE tenant_id = ? ORDER BY id').all(tenantId) as SendProfileRow[]
}
export function getProfile(tenantId: string, id: number): SendProfileRow | undefined {
  return db.prepare('SELECT * FROM send_profiles WHERE id = ? AND tenant_id = ?').get(id, tenantId) as
    | SendProfileRow
    | undefined
}
export function createProfile(tenantId: string, name: string, config: Partial<TemplateConfig>): number {
  const cfg: TemplateConfig = { ...DEFAULT_TEMPLATE, ...config }
  const info = db
    .prepare('INSERT INTO send_profiles (tenant_id, name, config, created_at) VALUES (?, ?, ?, ?)')
    .run(tenantId, name, JSON.stringify(cfg), Date.now())
  return Number(info.lastInsertRowid)
}
export function updateProfile(tenantId: string, id: number, name: string, config: Partial<TemplateConfig>): void {
  const cfg: TemplateConfig = { ...DEFAULT_TEMPLATE, ...config }
  db.prepare('UPDATE send_profiles SET name = ?, config = ? WHERE id = ? AND tenant_id = ?').run(
    name,
    JSON.stringify(cfg),
    id,
    tenantId,
  )
}
export function deleteProfile(tenantId: string, id: number): void {
  db.prepare('DELETE FROM send_profiles WHERE id = ? AND tenant_id = ?').run(id, tenantId)
}

// --- saved lead lists (the sources a campaign's Lead-list block fetches from) ---
export interface AttioListConfig {
  object: string
  listId?: string
  mapping: import('./attio.ts').AttioMapping
  filter?: import('./attio.ts').AttioFilterConfig
}
export interface ListSummary {
  id: number
  name: string
  type: 'csv' | 'attio' | 'sourced'
  size: number // best-effort: snapshot row count, or 0 for live attio
}

export function listLeadLists(tenantId: string): ListSummary[] {
  const rows = db.prepare('SELECT * FROM lead_lists WHERE tenant_id = ? ORDER BY id DESC').all(tenantId) as LeadListRow[]
  return rows.map((r) => {
    let size = 0
    try {
      const cfg = JSON.parse(r.config)
      if (r.type === 'csv' || r.type === 'sourced') size = (cfg.rows?.length as number) ?? 0
    } catch { /* ignore */ }
    return { id: r.id, name: r.name, type: r.type, size }
  })
}

// --- sourced lists (filled by the sourcing engine; stored as a snapshot like CSV) ---
export function createSourcedList(tenantId: string, name: string, sourcing: unknown): number {
  const info = db
    .prepare("INSERT INTO lead_lists (tenant_id, name, type, config, created_at) VALUES (?, ?, 'sourced', ?, ?)")
    .run(tenantId, name, JSON.stringify({ rows: [], sourcing }), Date.now())
  return Number(info.lastInsertRowid)
}
// Next default name for a manually-created list: "New list 1", "New list 2", …
export function nextDefaultListName(tenantId: string): string {
  const rows = db.prepare('SELECT name FROM lead_lists WHERE tenant_id = ?').all(tenantId) as { name: string }[]
  let max = 0
  for (const r of rows) {
    const m = /^New list (\d+)$/.exec(r.name ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `New list ${max + 1}`
}

// Append a manually-entered row to a sourced/csv list's stored rows.
export function addListRow(tenantId: string, id: number, row: UpsertRow): boolean {
  const list = getLeadList(tenantId, id)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return false
  const cfg = JSON.parse(list.config)
  cfg.rows = Array.isArray(cfg.rows) ? cfg.rows : []
  cfg.rows.push(row)
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(cfg), id, tenantId)
  return true
}

// Update a row in place (manual inline editing).
export function updateListRow(tenantId: string, id: number, idx: number, patch: Partial<UpsertRow>): boolean {
  const list = getLeadList(tenantId, id)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return false
  const cfg = JSON.parse(list.config)
  if (!Array.isArray(cfg.rows) || idx < 0 || idx >= cfg.rows.length) return false
  cfg.rows[idx] = { ...cfg.rows[idx], ...patch }
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(cfg), id, tenantId)
  return true
}

// Overwrite a list's rows wholesale (used by the dedupe agent to persist its result).
export function setListRows(tenantId: string, id: number, rows: UpsertRow[]): boolean {
  const list = getLeadList(tenantId, id)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return false
  const cfg = JSON.parse(list.config)
  cfg.rows = rows
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(cfg), id, tenantId)
  return true
}

// Read a list's raw stored rows.
export function getListRows(tenantId: string, id: number): UpsertRow[] {
  const list = getLeadList(tenantId, id)
  if (!list) return []
  try { return (JSON.parse(list.config).rows as UpsertRow[]) ?? [] } catch { return [] }
}

// Append many rows at once (used by Attio import → materialize onto a list).
export function addListRows(tenantId: string, id: number, rows: UpsertRow[]): number {
  const list = getLeadList(tenantId, id)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return 0
  const cfg = JSON.parse(list.config)
  cfg.rows = Array.isArray(cfg.rows) ? cfg.rows : []
  cfg.rows.push(...rows)
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(cfg), id, tenantId)
  return rows.length
}

// Remove a row by its index in the stored rows array.
export function deleteListRow(tenantId: string, id: number, idx: number): boolean {
  const list = getLeadList(tenantId, id)
  if (!list || (list.type !== 'sourced' && list.type !== 'csv')) return false
  const cfg = JSON.parse(list.config)
  if (!Array.isArray(cfg.rows) || idx < 0 || idx >= cfg.rows.length) return false
  cfg.rows.splice(idx, 1)
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(cfg), id, tenantId)
  return true
}

export function updateSourcing(tenantId: string, id: number, sourcing: unknown): void {
  const list = getLeadList(tenantId, id)
  if (!list || list.type !== 'sourced') return
  const cfg = JSON.parse(list.config)
  db.prepare('UPDATE lead_lists SET config = ? WHERE id = ? AND tenant_id = ?').run(
    JSON.stringify({ rows: cfg.rows ?? [], sourcing }),
    id,
    tenantId,
  )
}
export function getLeadList(tenantId: string, id: number): LeadListRow | undefined {
  return db.prepare('SELECT * FROM lead_lists WHERE id = ? AND tenant_id = ?').get(id, tenantId) as LeadListRow | undefined
}
export function createCsvList(tenantId: string, name: string, rows: UpsertRow[]): number {
  const info = db
    .prepare("INSERT INTO lead_lists (tenant_id, name, type, config, created_at) VALUES (?, ?, 'csv', ?, ?)")
    .run(tenantId, name, JSON.stringify({ rows }), Date.now())
  return Number(info.lastInsertRowid)
}
export function createAttioList(tenantId: string, name: string, config: AttioListConfig): number {
  const info = db
    .prepare("INSERT INTO lead_lists (tenant_id, name, type, config, created_at) VALUES (?, ?, 'attio', ?, ?)")
    .run(tenantId, name, JSON.stringify(config), Date.now())
  return Number(info.lastInsertRowid)
}
export function deleteLeadList(tenantId: string, id: number): void {
  db.prepare('DELETE FROM lead_lists WHERE id = ? AND tenant_id = ?').run(id, tenantId)
}

// Pull contacts FROM a saved list into the tenant's contacts (live for Attio, snapshot for CSV).
export async function fetchListContacts(tenantId: string, listId: number): Promise<number[]> {
  const list = getLeadList(tenantId, listId)
  if (!list) return []
  const cfg = JSON.parse(list.config)
  // csv + sourced are snapshots of rows; upsert only those with a phone (empty phones are skipped)
  if (list.type === 'csv' || list.type === 'sourced') return upsertContacts(tenantId, (cfg.rows as UpsertRow[]) ?? [])
  // attio: re-query live so new records flow in on every fetch
  const key = getAttioKey(tenantId)
  if (!key) return []
  const attio = await import('./attio.ts')
  const pull = await attio.pullContacts(key, {
    object: cfg.object,
    listId: cfg.listId || undefined,
    mapping: cfg.mapping,
    filter: cfg.filter,
    suppressDays: SUPPRESS_DAYS,
  })
  return importAttioContacts(tenantId, pull.contacts, cfg.object)
}

// Read a saved list's people for preview (no upsert/mutation). CSV = snapshot, Attio = live pull.
export interface ListPreviewRow { name: string | null; phone: string; instagram_handle: string | null; event_link: string | null; category: string | null }
export async function previewListContacts(tenantId: string, id: number): Promise<ListPreviewRow[]> {
  const list = getLeadList(tenantId, id)
  if (!list) return []
  const cfg = JSON.parse(list.config)
  const map = (r: { name?: string | null; phone: string; instagram_handle?: string | null; event_link?: string | null; category?: string | null; vars?: Record<string, string> }): ListPreviewRow => ({
    name: r.name ?? null,
    phone: r.phone,
    instagram_handle: r.instagram_handle ?? r.vars?.instagram_handle ?? r.vars?.instagram ?? null,
    event_link: r.event_link ?? r.vars?.instagram_link ?? r.vars?.event_link ?? null,
    category: r.category ?? r.vars?.category ?? null,
  })
  if (list.type === 'csv' || list.type === 'sourced') return ((cfg.rows as UpsertRow[]) ?? []).map(map)
  const key = getAttioKey(tenantId)
  if (!key) return []
  const attio = await import('./attio.ts')
  const pull = await attio.pullContacts(key, {
    object: cfg.object,
    listId: cfg.listId || undefined,
    mapping: cfg.mapping,
    filter: cfg.filter,
    suppressDays: SUPPRESS_DAYS,
  })
  return pull.contacts.map((c) => map({ name: c.name, phone: c.phone as string, vars: c.vars }))
}

// The list a campaign's Lead-list (start) block points at, if any.
export function campaignListId(c: CampaignRow): number | null {
  const seq = parseSequence(c.sequence)
  if (!seq) return null
  const start = seq.nodes.find((n) => n.type === 'start')
  const id = (start?.data as { listId?: number } | undefined)?.listId
  return id ? Number(id) : null
}

// Fetch from the campaign's list and enroll any new contacts. Returns how many were added.
export async function fetchAndEnroll(tenantId: string, campaignId: number): Promise<{ enrolled: number }> {
  const c = getCampaign(tenantId, campaignId)
  if (!c) return { enrolled: 0 }
  const listId = campaignListId(c)
  if (!listId) return { enrolled: 0 }
  const ids = await fetchListContacts(tenantId, listId)
  return enrollContacts(tenantId, campaignId, ids)
}

// --- campaigns ---
export interface NewCampaign {
  name: string
  sequence?: Sequence | null
  accountIds?: string[]
  cloudTemplate?: string | null
  cloudLang?: string | null
}

export function createCampaign(tenantId: string, c: NewCampaign): number {
  const seq = c.sequence ?? fallbackSequence('')
  // keep `template` populated from the first send block for backward compat / display
  const firstSend = seq.nodes.find((n) => n.type === 'send')
  const template = (firstSend?.data as { message?: string } | undefined)?.message ?? ''
  const info = db
    .prepare(
      `INSERT INTO campaigns (tenant_id, name, template, status, config, created_at, sequence, cloud_template, cloud_lang)
       VALUES (?, ?, ?, 'draft', '{}', ?, ?, ?, ?)`,
    )
    .run(tenantId, c.name, template, Date.now(), JSON.stringify(seq), c.cloudTemplate ?? null, c.cloudLang ?? null)
  const campaignId = Number(info.lastInsertRowid)
  if (c.accountIds?.length) setCampaignAccounts(tenantId, campaignId, c.accountIds)
  return campaignId
}

export function updateCampaign(
  tenantId: string,
  campaignId: number,
  patch: { name?: string; sequence?: Sequence; accountIds?: string[]; cloudTemplate?: string | null; cloudLang?: string | null },
): void {
  const c = getCampaign(tenantId, campaignId)
  if (!c) throw new Error('not found')
  if (patch.name != null) db.prepare('UPDATE campaigns SET name = ? WHERE id = ?').run(patch.name, campaignId)
  if (patch.sequence) {
    const firstSend = patch.sequence.nodes.find((n) => n.type === 'send')
    const template = (firstSend?.data as { message?: string } | undefined)?.message ?? c.template
    db.prepare('UPDATE campaigns SET sequence = ?, template = ? WHERE id = ?').run(
      JSON.stringify(patch.sequence),
      template,
      campaignId,
    )
  }
  if (patch.cloudTemplate !== undefined || patch.cloudLang !== undefined)
    db.prepare('UPDATE campaigns SET cloud_template = ?, cloud_lang = ? WHERE id = ?').run(
      patch.cloudTemplate ?? c.cloud_template,
      patch.cloudLang ?? c.cloud_lang,
      campaignId,
    )
  if (patch.accountIds) {
    setCampaignAccounts(tenantId, campaignId, patch.accountIds)
    rebalanceAssignments(campaignId) // spread any unsent leads across the new account set
  }
}

export function deleteCampaign(tenantId: string, campaignId: number): void {
  db.prepare('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?').run(campaignId, tenantId)
}

// --- the account checklist ---
export function setCampaignAccounts(tenantId: string, campaignId: number, accountIds: string[]): void {
  db.prepare('DELETE FROM campaign_accounts WHERE campaign_id = ?').run(campaignId)
  const ins = db.prepare('INSERT OR IGNORE INTO campaign_accounts (campaign_id, account_id, tenant_id) VALUES (?, ?, ?)')
  for (const a of accountIds) {
    const owns = db.prepare('SELECT 1 FROM accounts WHERE id = ? AND tenant_id = ?').get(a, tenantId)
    if (owns) ins.run(campaignId, a, tenantId)
  }
}
export function getCampaignAccounts(campaignId: number): string[] {
  return (db.prepare('SELECT account_id FROM campaign_accounts WHERE campaign_id = ?').all(campaignId) as {
    account_id: string
  }[]).map((r) => r.account_id)
}

// Expand the account set into a weighted rotation list, e.g. weights {A:3, B:1} → [A,A,A,B].
// Higher weight = a larger share of leads (tier 2 distribution control).
function weightedRotation(accts: string[]): string[] {
  const out: string[] = []
  for (const a of accts) {
    const w = Math.max(1, Math.round(getPolicy(a).weight || 1))
    for (let i = 0; i < w; i++) out.push(a)
  }
  return out.length ? out : accts
}

// --- enrolling leads into a campaign (with weighted round-robin account assignment) ---
export function enrollContacts(tenantId: string, campaignId: number, contactIds: number[]): { enrolled: number } {
  const c = getCampaign(tenantId, campaignId)
  if (!c) throw new Error('not found')
  const accts = weightedRotation(getCampaignAccounts(campaignId))
  const seq = parseSequence(c.sequence) ?? fallbackSequence(c.template)
  const start = firstNode(seq)
  // 10-day suppression: skip contacts we've cold-messaged within the window
  contactIds = filterSuppressed(tenantId, contactIds)
  // continue round-robin from however many are already assigned
  let rr = (db.prepare('SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id = ?').get(campaignId) as { n: number }).n
  const ins = db.prepare(
    `INSERT INTO campaign_contacts (campaign_id, contact_id, tenant_id, status, account_id, node_id)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(campaign_id, contact_id) DO NOTHING`,
  )
  let enrolled = 0
  for (const cid of contactIds) {
    const acct = accts.length ? accts[rr % accts.length] : null
    const info = ins.run(campaignId, cid, tenantId, acct, start)
    if (info.changes) {
      enrolled++
      rr++
    }
  }
  return { enrolled }
}

// Re-spread not-yet-sent leads across the current account set (after the checklist changes).
export function rebalanceAssignments(campaignId: number): void {
  const accts = weightedRotation(getCampaignAccounts(campaignId))
  if (!accts.length) return
  const pending = db
    .prepare(`SELECT id FROM campaign_contacts WHERE campaign_id = ? AND status = 'pending' ORDER BY id`)
    .all(campaignId) as { id: number }[]
  const upd = db.prepare('UPDATE campaign_contacts SET account_id = ? WHERE id = ?')
  pending.forEach((row, i) => upd.run(accts[i % accts.length], row.id))
}

// --- the lead table (one campaign's enrolled leads) ---
export interface LeadRow {
  ccId: number
  contactId: number
  name: string | null
  phone: string
  instagram_handle: string | null
  event_link: string | null
  category: string | null
  account_id: string | null
  status: string // pending | sent | replied | failed | skipped | completed
}
export function listLeads(tenantId: string, campaignId: number, limit = 500): LeadRow[] {
  return db
    .prepare(
      `SELECT cc.id ccId, c.id contactId, c.name name, c.phone phone,
              c.instagram_handle instagram_handle, c.event_link event_link, c.category category,
              cc.account_id account_id, cc.status status
       FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.campaign_id = ? AND cc.tenant_id = ? ORDER BY cc.id LIMIT ?`,
    )
    .all(campaignId, tenantId, limit) as LeadRow[]
}

export interface CampaignStats {
  pending: number
  sent: number
  replied: number
  failed: number
  skipped: number
  completed: number
  total: number
}
export function campaignStats(campaignId: number): CampaignStats {
  const rows = db
    .prepare(`SELECT status, COUNT(*) n FROM campaign_contacts WHERE campaign_id = ? GROUP BY status`)
    .all(campaignId) as { status: string; n: number }[]
  const s: CampaignStats = { pending: 0, sent: 0, replied: 0, failed: 0, skipped: 0, completed: 0, total: 0 }
  for (const r of rows) {
    if (r.status in s) (s as unknown as Record<string, number>)[r.status] = r.n
    s.total += r.n
  }
  return s
}

export interface CampaignWithStats extends CampaignRow {
  stats: CampaignStats
  accountIds: string[]
}
export function listCampaigns(tenantId: string): CampaignWithStats[] {
  const rows = db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY id DESC').all(tenantId) as CampaignRow[]
  return rows.map((c) => ({ ...c, stats: campaignStats(c.id), accountIds: getCampaignAccounts(c.id) }))
}

export function getCampaign(tenantId: string, campaignId: number): CampaignRow | undefined {
  return db.prepare('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?').get(campaignId, tenantId) as
    | CampaignRow
    | undefined
}
