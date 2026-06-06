// Standalone Attio connector smoke test. Reads ATTIO_API_KEY from the environment
// and exercises the real connector end-to-end against the live Attio workspace.
//
//   node --env-file=.env scripts/attio-test.ts [objectSlug]
//
// Defaults to the "people" object. Pass another slug to test a different object.
// Read-only: it never writes notes or records.

import {
  testKey,
  listObjects,
  listObjectAttributes,
  listLists,
  pullContacts,
  type AttioAttr,
  type AttioMapping,
} from '../src/attio.ts'

const key = process.env.ATTIO_API_KEY
if (!key) {
  console.error('✗ ATTIO_API_KEY not set. Add it to .env (ATTIO_API_KEY=attio_...) and re-run.')
  process.exit(1)
}

// Mirror the heuristic the UI uses today (first phone-number / personal-name attr),
// so the pull works without a hand-built mapping.
function autoMap(attrs: AttioAttr[]): AttioMapping | null {
  const phone = attrs.find((a) => a.type === 'phone-number')?.api_slug
  if (!phone) return null
  const name = attrs.find((a) => a.type === 'personal-name')?.api_slug
  return { phone, name, vars: [] }
}

const objectSlug = process.argv[2] || 'people'

async function main() {
  console.log('→ GET /self (validate key)')
  const ws = await testKey(key!)
  console.log(`  ✓ workspace: ${ws.workspace_name ?? '(unnamed)'} [${ws.workspace_id ?? '?'}]\n`)

  console.log('→ GET /objects')
  const objects = await listObjects(key!)
  console.log(`  ✓ ${objects.length} objects: ${objects.map((o) => o.api_slug).join(', ')}\n`)

  console.log(`→ GET /objects/${objectSlug}/attributes`)
  const attrs = await listObjectAttributes(key!, objectSlug)
  console.log(`  ✓ ${attrs.length} attributes:`)
  for (const a of attrs) console.log(`    - ${a.api_slug} (${a.type}) "${a.title}"`)
  console.log()

  console.log('→ GET /lists (for this object)')
  const lists = await listLists(key!, objectSlug)
  console.log(`  ✓ ${lists.length} lists: ${lists.map((l) => `${l.name}[${l.id}]`).join(', ') || '(none)'}\n`)

  const mapping = autoMap(attrs)
  if (!mapping) {
    console.error(`✗ no phone-number attribute on "${objectSlug}" — cannot pull contacts.`)
    process.exit(2)
  }
  console.log(`→ pullContacts (object=${objectSlug}, phone=${mapping.phone}, name=${mapping.name ?? '—'})`)
  const res = await pullContacts(key!, { object: objectSlug, mapping })
  console.log(`  ✓ ${res.total} records scanned`)
  console.log(`    messageable: ${res.contacts.length}`)
  console.log(`    skipped: noPhone=${res.skipped.noPhone} optedOut=${res.skipped.optedOut}`)
  console.log('    sample (first 5):')
  for (const ct of res.contacts.slice(0, 5)) {
    console.log(`      ${ct.name ?? '(no name)'} — ${ct.phone}  rec=${ct.attioRecordId}`)
  }
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e?.message ?? e)
  if (e?.status) console.error('  HTTP status:', e.status)
  process.exit(1)
})
