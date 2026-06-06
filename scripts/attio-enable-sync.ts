// Enable reply-driven stage sync for a tenant. Run once to set the config.
//
//   node --env-file=.env scripts/attio-enable-sync.ts [tenantId]
//
// If no tenantId is given, uses the first tenant in the DB.

import { db } from '../src/db.ts'
import { saveSyncConfig, saveBusinessDescription } from '../src/campaigns.ts'

const SALES_LIST = 'b4f74368-a14a-4f89-a33f-91958c23529f'
const STAGE_OPTIONS = [
  'Prospecting', 'Needs Contact', 'Qualified', 'Disqualify',
  'Outbounded', 'Replied', 'Meeting', 'Demo sent',
  'In negotiation', 'Paused', 'Onboarded', 'Won', 'Lost', 'Churned', 'No reply',
]

const tenantId = process.argv[2] ||
  (db.prepare('SELECT id FROM tenants LIMIT 1').get() as { id: string } | undefined)?.id

if (!tenantId) { console.error('✗ no tenant found'); process.exit(1) }

saveSyncConfig(tenantId, {
  salesListId: SALES_LIST,
  stageAttr: 'stage',
  summaryAttr: 'notes',
  jidAttr: 'whatsapp_jid',
  stageOptions: STAGE_OPTIONS,
  debounceMinutes: 10,
})

// Set a business description if not already set
const existing = db.prepare('SELECT business_description FROM tenants WHERE id = ?').get(tenantId) as { business_description: string | null } | undefined
if (!existing?.business_description) {
  saveBusinessDescription(tenantId, 'Events and ticketing platform selling to organisers, venues, and promoters via WhatsApp.')
}

console.log(`✓ stage sync enabled for tenant ${tenantId}`)
console.log(`  salesListId: ${SALES_LIST}`)
console.log(`  stageOptions: ${STAGE_OPTIONS.length} stages`)
console.log(`  debounce: 10 min`)
