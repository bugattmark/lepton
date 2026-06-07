// Manually (re-)seed the curated starter brand catalog into whatever DB_PATH points at. The same seed
// also runs automatically at boot (src/db.ts -> seedStarterBrands), so this is only for ad-hoc reseeds
// or seeding a specific DB. Idempotent (upsertBrands merges on UNIQUE(name)).
//   node --env-file=.env scripts/seed-brands.ts
const { seedStarterBrands, STARTER_BRANDS } = await import('../src/brandseed.ts')
const { brandCount, categoryFacets } = await import('../src/brands.ts')

seedStarterBrands()
console.log(`brand catalog: ${STARTER_BRANDS.length} starter brands seeded → ${brandCount()} total`)
console.log('sector vocabulary:', categoryFacets().map((c) => `${c.name}(${c.count})`).join(', '))
