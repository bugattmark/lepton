// Read-only probe: verify the payload format for the Sales-list entry upsert.
// Tests queryEntryByJid + getPersonCompany + a dry-run of the upsert shape.
//
//   node --env-file=.env scripts/attio-entry-probe.ts
//
// Does NOT write to Attio — it only reads entries and records.

import { queryEntryByJid, getPersonCompany } from '../src/attio.ts'

const key = process.env.ATTIO_API_KEY
if (!key) { console.error('✗ ATTIO_API_KEY not set.'); process.exit(1) }

const SALES_LIST = 'b4f74368-a14a-4f89-a33f-91958c23529f'

async function main() {
  // 1. Query an entry by JID (expect none for a fake number)
  console.log('→ queryEntryByJid (fake number)')
  const fake = await queryEntryByJid(key!, SALES_LIST, '0000000000@s.whatsapp.net')
  console.log(`  result: ${fake ? JSON.stringify(fake) : 'null (expected)'}`)

  // 2. Try reading a real person's company
  // Grab the first person record that has an attio_record_id in our DB (if the DB exists)
  console.log('\n→ getPersonCompany (first person with a company)')
  try {
    // Use the Attio API directly to find a person with a company
    const res = await fetch('https://api.attio.com/v2/objects/people/records/query', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })
    const j = await res.json() as any
    for (const r of j?.data ?? []) {
      const rid = r?.id?.record_id
      if (!rid) continue
      const companyId = await getPersonCompany(key!, rid)
      const name = r?.values?.name?.[0]?.full_name ?? '(unnamed)'
      console.log(`  person ${name} [${rid}] → company: ${companyId ?? 'null'}`)
      if (companyId) break // found one, that's enough
    }
  } catch (e: any) {
    console.log(`  error: ${e.message}`)
  }

  // 3. Query the first Sales entry to show its shape
  console.log('\n→ first Sales entry (shape check)')
  const res = await fetch(`https://api.attio.com/v2/lists/${SALES_LIST}/entries/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 1 }),
  })
  const ej = await res.json() as any
  const entry = ej?.data?.[0]
  if (entry) {
    console.log(`  entry_id: ${entry?.id?.entry_id}`)
    console.log(`  parent_record_id: ${entry?.parent_record_id}`)
    console.log(`  stage: ${entry?.entry_values?.stage?.[0]?.status?.title ?? '(none)'}`)
    console.log(`  notes: ${(entry?.entry_values?.notes?.[0]?.value ?? '(empty)').slice(0, 80)}`)
    console.log(`  whatsapp_jid: ${entry?.entry_values?.whatsapp_jid?.[0]?.value ?? '(empty)'}`)
  } else {
    console.log('  (no entries found)')
  }

  console.log('\n✓ probe complete (read-only, nothing written)')
}

main().catch((e) => { console.error('✗ FAILED:', e.message); process.exit(1) })
