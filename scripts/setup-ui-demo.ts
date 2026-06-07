// Seed a persistent demo DB (./data/ui-demo.db) for a browser walk-through: a real tenant you can log
// in as, a seeded brand catalog, a REAL Creator IQ profile for @graceelilyy_, its brand-match shortlist,
// and a generated priced proposal. Prints the login creds + the /p/:token. Boot the app against the same
// DB:  DB_PATH=./data/ui-demo.db node --env-file=.env src/server.ts
import { rmSync } from 'node:fs'
process.env.DB_PATH = './data/ui-demo.db'
try { rmSync('./data/ui-demo.db', { force: true }); rmSync('./data/ui-demo.db-wal', { force: true }); rmSync('./data/ui-demo.db-shm', { force: true }) } catch {}

const { db } = await import('../src/db.ts')
const { createTenant } = await import('../src/auth.ts')
const { upsertBrands } = await import('../src/brands.ts')
const creatoriq = await import('../src/creatoriq.ts')
const brandmatch = await import('../src/brandmatch.ts')
const proposals = await import('../src/proposals.ts')

const EMAIL = 'demo@ui.local'
const PASSWORD = 'demopass123'

const BRANDS = [
  { name: 'PrettyLittleThing', instagramHandle: 'prettylittlething', followers: 17_000_000, website: 'prettylittlething.com', main: ['Fashion'] },
  { name: 'ASOS', instagramHandle: 'asos', followers: 12_000_000, website: 'asos.com', main: ['Fashion'] },
  { name: 'Oh Polly', instagramHandle: 'ohpolly', followers: 3_500_000, website: 'ohpolly.com', main: ['Fashion'] },
  { name: 'Charlotte Tilbury', instagramHandle: 'charlottetilbury', followers: 3_700_000, website: 'charlottetilbury.com', main: ['Beauty'] },
  { name: 'Rare Beauty', instagramHandle: 'rarebeauty', followers: 6_000_000, website: 'rarebeauty.com', main: ['Beauty'] },
  { name: 'MAC Cosmetics', instagramHandle: 'maccosmetics', followers: 26_000_000, website: 'maccosmetics.com', main: ['Beauty'] },
  { name: 'Olaplex', instagramHandle: 'olaplex', followers: 2_400_000, website: 'olaplex.com', main: ['Haircare', 'Beauty'] },
  { name: 'Gymshark', instagramHandle: 'gymshark', followers: 7_000_000, website: 'gymshark.com', main: ['Fitness', 'Activewear'] },
  { name: 'Alphalete', instagramHandle: 'alphalete', followers: 2_000_000, website: 'alphalete.com', main: ['Activewear', 'Fitness'] },
  { name: 'Represent', instagramHandle: 'represent', followers: 1_200_000, website: 'representclo.com', main: ['Fashion', 'Activewear'] },
  { name: 'Lounge Underwear', instagramHandle: 'lounge', followers: 2_000_000, website: 'loungeunderwear.com', main: ['Fashion'] },
  { name: 'Myprotein', instagramHandle: 'myprotein', followers: 2_800_000, website: 'myprotein.com', main: ['Supplements', 'Health'] },
]

const tenantId = createTenant(EMAIL, PASSWORD)
upsertBrands(tenantId, BRANDS.map((b) => ({
  name: b.name, instagramHandle: b.instagramHandle, followers: b.followers, website: b.website,
  locationCountry: 'United Kingdom', categories: { main: b.main, secondary: [] }, source: 'manual',
})))

const now = Date.now()
const info = db
  .prepare('INSERT INTO creator_profiles (tenant_id, name, instagram_handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run(tenantId, 'Grace Lily', 'graceelilyy_', now, now)
const creatorId = Number(info.lastInsertRowid)

console.log('running Creator IQ (real HikerAPI + vision + inference)…')
await creatoriq.runCreatorIq(tenantId)
const p = creatoriq.getCreatorProfile(tenantId)!
console.log(`  niche=${p.niche} ER=${p.engagement_rate} sectors=${p.sectors}`)

console.log('running Brand Match…')
await brandmatch.runMatch(tenantId, creatorId)
const top = db
  .prepare('SELECT id FROM creator_brand_matches WHERE tenant_id=? AND creator_id=? ORDER BY score DESC LIMIT 1')
  .get(tenantId, creatorId) as { id: number } | undefined

let token = '(no proposal)'
if (top) {
  console.log('generating priced proposal…')
  const prop = await proposals.generateProposal(tenantId, { creatorProfileId: creatorId, brandMatchId: top.id })
  token = prop.public_token ?? '(none)'
}

console.log('\n=== UI DEMO READY ===')
console.log(`login:    ${EMAIL} / ${PASSWORD}`)
console.log(`pages:    /creator-iq   /match`)
console.log(`proposal: /p/${token}`)
console.log('boot:     DB_PATH=./data/ui-demo.db node --env-file=.env src/server.ts')
