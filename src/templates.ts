// Per-tenant saved email templates (the "Modify your template" editor's store).
// Two types: 'outreach' (first message) and 'followup' (the chase). Everything is
// tenant-scoped and read/written through the single db handle.
import { db } from './db.ts'
import type { TemplateRow } from './db.ts'

export type TemplateType = 'outreach' | 'followup'

const TYPES: TemplateType[] = ['outreach', 'followup']

function normType(t: unknown): TemplateType {
  const v = String(t ?? '').trim().toLowerCase()
  if (!TYPES.includes(v as TemplateType)) {
    throw new Error(`invalid template type "${String(t)}" — expected one of ${TYPES.join(', ')}`)
  }
  return v as TemplateType
}

export interface TemplateInput {
  type: TemplateType | string
  name: string
  subject?: string
  body?: string
}

export function listTemplates(tenantId: string, type?: TemplateType | string): TemplateRow[] {
  if (type !== undefined) {
    return db
      .prepare('SELECT * FROM templates WHERE tenant_id=? AND type=? ORDER BY updated_at DESC')
      .all(tenantId, normType(type)) as TemplateRow[]
  }
  return db
    .prepare('SELECT * FROM templates WHERE tenant_id=? ORDER BY updated_at DESC')
    .all(tenantId) as TemplateRow[]
}

export function getTemplate(tenantId: string, id: number): TemplateRow | undefined {
  return db.prepare('SELECT * FROM templates WHERE tenant_id=? AND id=?').get(tenantId, id) as
    | TemplateRow
    | undefined
}

// Insert a new template. Throws on missing name so the caller (and the FE) sees the failure.
export function createTemplate(tenantId: string, input: TemplateInput): TemplateRow {
  const type = normType(input.type)
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('template name is required')
  const now = Date.now()
  const info = db
    .prepare('INSERT INTO templates (tenant_id, type, name, subject, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(tenantId, type, name, String(input.subject ?? ''), String(input.body ?? ''), now, now)
  const row = getTemplate(tenantId, Number(info.lastInsertRowid))
  if (!row) throw new Error('failed to read back the template just created')
  return row
}

// Update an existing template in place. Throws if the id isn't this tenant's.
export function updateTemplate(tenantId: string, id: number, input: TemplateInput): TemplateRow {
  const existing = getTemplate(tenantId, id)
  if (!existing) throw new Error(`template ${id} not found for this account`)
  const type = normType(input.type)
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('template name is required')
  db.prepare('UPDATE templates SET type=?, name=?, subject=?, body=?, updated_at=? WHERE tenant_id=? AND id=?').run(
    type,
    name,
    String(input.subject ?? ''),
    String(input.body ?? ''),
    Date.now(),
    tenantId,
    id,
  )
  return getTemplate(tenantId, id)!
}

export function deleteTemplate(tenantId: string, id: number): void {
  const info = db.prepare('DELETE FROM templates WHERE tenant_id=? AND id=?').run(tenantId, id)
  if (info.changes === 0) throw new Error(`template ${id} not found for this account`)
}
