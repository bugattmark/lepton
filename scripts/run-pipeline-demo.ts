// End-to-end demo: run the creator-first pipeline (Creator IQ -> Brand Match -> Priced Proposal) on a
// few real creators. Uses an ISOLATED temp DB (never touches the real volume DB) seeded with a curated
// brand catalog, plus the real HikerAPI / OpenAI / Claude keys from the environment.
//
//   node --env-file=.env scripts/run-pipeline-demo.ts
//
// This is a throwaway harness (not app code): it drives the exported engine functions directly the way
// the Wave-2 HTTP routes will, so a green run here means the routes will work too.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Isolate: point DB_PATH at a throwaway file BEFORE importing db.ts (it opens the DB at module load).
process.env.DB_PATH = join(tmpdir(), `lepton-demo-${process.pid}.db`)

const { db } = await import('../src/db.ts')
const { upsertBrands, categoryFacets } = await import('../src/brands.ts')
const creatoriq = await import('../src/creatoriq.ts')
const brandmatch = await import('../src/brandmatch.ts')
const proposals = await import('../src/proposals.ts')

// --- a curated demo brand catalog spanning the example creators' niches (fashion/beauty/haircare/
//     skincare/fitness/activewear/supplements/health/equestrian/food/travel/home). Real brands; the
//     `categories.main` strings BECOME the sector vocabulary categoryFacets() exposes. ---
type B = { name: string; instagramHandle: string; followers: number; website: string; main: string[]; country?: string }
const BRANDS: B[] = [
  { name: 'PrettyLittleThing', instagramHandle: 'prettylittlething', followers: 17_000_000, website: 'prettylittlething.com', main: ['Fashion'], country: 'United Kingdom' },
  { name: 'Oh Polly', instagramHandle: 'ohpolly', followers: 3_500_000, website: 'ohpolly.com', main: ['Fashion'], country: 'United Kingdom' },
  { name: 'ASOS', instagramHandle: 'asos', followers: 12_000_000, website: 'asos.com', main: ['Fashion'], country: 'United Kingdom' },
  { name: 'Charlotte Tilbury', instagramHandle: 'charlottetilbury', followers: 3_700_000, website: 'charlottetilbury.com', main: ['Beauty'], country: 'United Kingdom' },
  { name: 'Rare Beauty', instagramHandle: 'rarebeauty', followers: 6_000_000, website: 'rarebeauty.com', main: ['Beauty'] },
  { name: 'MAC Cosmetics', instagramHandle: 'maccosmetics', followers: 26_000_000, website: 'maccosmetics.com', main: ['Beauty'] },
  { name: 'Olaplex', instagramHandle: 'olaplex', followers: 2_400_000, website: 'olaplex.com', main: ['Haircare', 'Beauty'] },
  { name: 'The Ordinary', instagramHandle: 'theordinary', followers: 3_000_000, website: 'theordinary.com', main: ['Skincare'], country: 'United Kingdom' },
  { name: 'CeraVe', instagramHandle: 'cerave', followers: 1_500_000, website: 'cerave.com', main: ['Skincare'] },
  { name: 'Beauty Pie', instagramHandle: 'beautypie', followers: 300_000, website: 'beautypie.com', main: ['Beauty', 'Skincare'], country: 'United Kingdom' },
  { name: 'Gymshark', instagramHandle: 'gymshark', followers: 7_000_000, website: 'gymshark.com', main: ['Fitness', 'Activewear'], country: 'United Kingdom' },
  { name: 'Alphalete', instagramHandle: 'alphalete', followers: 2_000_000, website: 'alphalete.com', main: ['Activewear', 'Fitness'] },
  { name: 'Represent', instagramHandle: 'represent', followers: 1_200_000, website: 'representclo.com', main: ['Fashion', 'Activewear'], country: 'United Kingdom' },
  { name: 'Myprotein', instagramHandle: 'myprotein', followers: 2_800_000, website: 'myprotein.com', main: ['Supplements', 'Health'], country: 'United Kingdom' },
  { name: 'Huel', instagramHandle: 'huel', followers: 500_000, website: 'huel.com', main: ['Supplements', 'Health'], country: 'United Kingdom' },
  { name: 'Form Nutrition', instagramHandle: 'formnutrition', followers: 200_000, website: 'formnutrition.com', main: ['Supplements', 'Health'], country: 'United Kingdom' },
  { name: 'LeMieux', instagramHandle: 'lemieuxofficial', followers: 400_000, website: 'lemieux.com', main: ['Equestrian'], country: 'United Kingdom' },
  { name: 'Aztec Diamond Equestrian', instagramHandle: 'aztecdiamondequestrian', followers: 250_000, website: 'aztecdiamondequestrian.com', main: ['Equestrian'], country: 'United Kingdom' },
  { name: 'Premier Equine', instagramHandle: 'premierequine', followers: 150_000, website: 'premierequine.co.uk', main: ['Equestrian'], country: 'United Kingdom' },
  { name: 'HelloFresh UK', instagramHandle: 'hellofresh_uk', followers: 600_000, website: 'hellofresh.co.uk', main: ['Food'], country: 'United Kingdom' },
  { name: 'Gousto', instagramHandle: 'goustocooking', followers: 300_000, website: 'gousto.co.uk', main: ['Food'], country: 'United Kingdom' },
  { name: 'Lounge Underwear', instagramHandle: 'lounge', followers: 2_000_000, website: 'loungeunderwear.com', main: ['Fashion'], country: 'United Kingdom' },
]

function seedBrands(provenanceTenant: string): void {
  const res = upsertBrands(
    provenanceTenant,
    BRANDS.map((b) => ({
      name: b.name,
      instagramHandle: b.instagramHandle,
      followers: b.followers,
      website: b.website,
      locationCountry: b.country ?? null,
      categories: { main: b.main, secondary: [] },
      source: 'manual',
    })),
  )
  console.log(`seeded brands: +${res.inserted} new, ${res.updated} updated`)
  console.log('sector vocabulary (categoryFacets):', categoryFacets().map((c) => `${c.name}(${c.count})`).join(', '))
}

function makeTenant(label: string): string {
  const id = `demo-${label}-${randomUUID().slice(0, 8)}`
  db.prepare('INSERT INTO tenants (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id, `${id}@demo.local`, 'x', Date.now(),
  )
  return id
}

function seedCreatorRow(tenantId: string, name: string, handle: string): number {
  const now = Date.now()
  const info = db
    .prepare('INSERT INTO creator_profiles (tenant_id, name, instagram_handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, name, handle, now, now)
  return Number(info.lastInsertRowid)
}

// --- SYNTHETIC stage-1 fallback (used only when Tier 0/HikerAPI yields nothing — e.g. dead key) ---
// Known public stats for the example creators, so stages 2-3 (real LLM) can be demonstrated without
// the IG ingest. Sectors use categoryFacets() names so brand matching joins to the seeded catalog.
const SYNTH: Record<string, { followers: number; er: number; niche: string; sectors: [string, number][] }> = {
  graceelilyy_: { followers: 14_700, er: 0.045, niche: 'Fashion & Beauty', sectors: [['Fashion', 88], ['Beauty', 82]] },
  ambertutton: { followers: 79_100, er: 0.032, niche: 'Equestrian / Fashion / Beauty', sectors: [['Equestrian', 90], ['Fashion', 68], ['Beauty', 60]] },
  ariannakennedy1: { followers: 64_600, er: 0.03, niche: 'Sports / Travel / Beauty / Supplements', sectors: [['Supplements', 80], ['Beauty', 70], ['Fitness', 65], ['Health', 60]] },
}
function seedSynthetic(tenantId: string, handle: string): boolean {
  const s = SYNTH[handle]
  if (!s) return false
  const sectors = s.sectors.map(([category, score]) => ({
    category, score, reason: `known ${category.toLowerCase()} creator (synthetic stage-1: HikerAPI key is 401)`,
  }))
  db.prepare(
    `UPDATE creator_profiles SET niche=?, engagement_rate=?, creator_type='content', sectors=?, profile_data=?,
       status='done', error=NULL, updated_at=? WHERE tenant_id=?`,
  ).run(s.niche, s.er, JSON.stringify(sectors), JSON.stringify({ followers: s.followers }), Date.now(), tenantId)
  return true
}

const hr = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`)

async function runCreator(name: string, handle: string): Promise<void> {
  hr(`CREATOR: ${name}  (@${handle})`)
  const tenantId = makeTenant(handle)
  const creatorId = seedCreatorRow(tenantId, name, handle)

  // ---- Stage 1: Creator IQ ----
  try {
    await creatoriq.runCreatorIq(tenantId)
  } catch (e) {
    console.log(`  [creator-iq] threw: ${(e as Error).message}`)
  }
  const p = creatoriq.getCreatorProfile(tenantId)
  if (!p) { console.log('  no profile row — aborting this creator'); return }
  let sectors = p.sectors ? JSON.parse(p.sectors) : []
  const followers = p.profile_data ? (JSON.parse(p.profile_data).followers ?? null) : null
  const visual = p.visual_signals ? JSON.parse(p.visual_signals) : null
  console.log(`  [stage 1] status=${p.status}  error=${(p.error ?? '-').toString().slice(0, 80)}`)
  console.log(`  niche=${p.niche ?? '-'}  ER=${p.engagement_rate ?? '-'}  followers=${followers ?? '-'}  type=${p.creator_type ?? '-'}`)
  if (visual) console.log(`  visual: ${(visual.summary ?? JSON.stringify(visual)).toString().slice(0, 200)}`)
  console.log(`  sectors: ${sectors.length ? sectors.slice(0, 6).map((s: any) => `${s.category} ${s.score}`).join(', ') : '(none)'}`)

  if (!sectors.length) {
    console.log('  ⚠ Tier 0 (HikerAPI) gave no data — seeding SYNTHETIC stage-1 from known public stats so stages 2-3 (real LLM) can run.')
    if (!seedSynthetic(tenantId, handle)) { console.log('  no synthetic profile for this handle; skipping'); return }
    const p2 = creatoriq.getCreatorProfile(tenantId)!
    sectors = p2.sectors ? JSON.parse(p2.sectors) : []
    console.log(`  [synthetic] niche=${p2.niche}  ER=${p2.engagement_rate}  followers=${JSON.parse(p2.profile_data!).followers}  sectors=${sectors.map((x: any) => `${x.category} ${x.score}`).join(', ')}`)
  }

  // ---- Stage 2: Brand Match ----
  try {
    await brandmatch.runMatch(tenantId, creatorId)
  } catch (e) {
    console.log(`  [brand-match] threw: ${(e as Error).message}`)
  }
  const ms = brandmatch.matchStatus(tenantId, creatorId)
  console.log(`  match status=${ms.status}  shortlist=${ms.rows.length}  (est ${ms.counts.estimate}, net-new ${ms.counts.net_new})`)
  for (const r of ms.rows.slice(0, 5)) {
    console.log(`    [${r.tier}/${r.move}] ${r.score}  ${r.name}  — ${r.reason ?? ''}`)
  }
  if (!ms.rows.length) { console.log('  empty shortlist; skipping proposal'); return }

  // ---- Stage 3: Priced Proposal (top match) ----
  const top = db
    .prepare('SELECT id, brand_id FROM creator_brand_matches WHERE tenant_id=? AND creator_id=? ORDER BY score DESC LIMIT 1')
    .get(tenantId, creatorId) as { id: number; brand_id: number } | undefined
  if (!top) { console.log('  no top match id; skipping proposal'); return }
  try {
    const prop = await proposals.generateProposal(tenantId, { creatorProfileId: creatorId, brandMatchId: top.id })
    const parsed = JSON.parse(prop.tiers) as { tiers: any[]; prose: { subject?: string; body: string } }
    console.log(`  PROPOSAL #${prop.id}  brand_id=${prop.brand_id}  /p/${prop.public_token}`)
    console.log(`    headline gross=£${prop.gross_price}  creator_net=£${prop.creator_net}  platform_cut=£${prop.platform_cut}  take=${prop.take_rate_applied}`)
    for (const t of parsed.tiers) {
      const dels = (t.deliverables ?? []).map((d: any) => `${d.count}×${d.format}`).join(' + ')
      console.log(`    tier "${t.name}": £${t.gross_price}  [${dels}]`)
    }
    console.log(`    subject: ${parsed.prose?.subject ?? '-'}`)
  } catch (e) {
    console.log(`  [proposal] threw: ${(e as Error).message}`)
  }
}

// --- main ---
const provenance = makeTenant('catalog')
seedBrands(provenance)

const CREATORS: [string, string][] = [
  ['Grace Lily', 'graceelilyy_'],
  ['Amber Tutton', 'ambertutton'],
  ['Arianna Kennedy', 'ariannakennedy1'],
]
for (const [name, handle] of CREATORS) {
  await runCreator(name, handle)
}
hr('DONE')
