// Curated starter brand catalog — a canonical seed (like rate_cards) that guarantees the shared
// `brands` catalog has a floor of real brands across the main sectors. This is what makes the pipeline
// work on a FRESH deploy (e.g. a new Railway volume): Creator IQ needs a non-empty sector vocabulary
// (categoryFacets over brands.categories) and Brand Match needs targets, the moment the app boots.
//
// Idempotent: upsertBrands merges on UNIQUE(name) (ON CONFLICT DO UPDATE), so re-seeding on every boot
// refreshes rather than duplicates and never clobbers sourced/edited brands (COALESCE keeps richer
// values). The catalog still GROWS beyond this floor via the matcher's HikerAPI snowball.
//
// The `categories.main` names ARE the sector vocabulary — keep them clean + canonical.
import { upsertBrands, type BrandInput } from './brands.ts'

// [name, instagram handle, followers (approx), website, country, [main categories]]
type Row = [string, string, number, string, string, string[]]
const UK = 'United Kingdom'
const ROWS: Row[] = [
  // Fashion
  ['ASOS', 'asos', 12_000_000, 'asos.com', UK, ['Fashion']],
  ['PrettyLittleThing', 'prettylittlething', 17_000_000, 'prettylittlething.com', UK, ['Fashion']],
  ['Boohoo', 'boohoo', 9_000_000, 'boohoo.com', UK, ['Fashion']],
  ['Oh Polly', 'ohpolly', 3_500_000, 'ohpolly.com', UK, ['Fashion']],
  ['In The Style', 'inthestyle', 1_500_000, 'inthestyle.com', UK, ['Fashion']],
  ['Lounge Underwear', 'lounge', 2_000_000, 'loungeunderwear.com', UK, ['Fashion']],
  ['White Fox Boutique', 'whitefoxboutique', 3_000_000, 'whitefoxboutique.com', 'Australia', ['Fashion']],
  ['Princess Polly', 'princesspolly', 2_500_000, 'princesspolly.com', 'Australia', ['Fashion']],
  ['Edikted', 'edikted', 1_200_000, 'edikted.com', 'United States', ['Fashion']],
  ['Meshki', 'meshki', 1_800_000, 'meshki.com', 'Australia', ['Fashion']],
  ['Reformation', 'reformation', 3_500_000, 'thereformation.com', 'United States', ['Fashion']],
  ['& Other Stories', 'andotherstories', 3_000_000, 'stories.com', 'Sweden', ['Fashion']],
  // Beauty
  ['Charlotte Tilbury', 'charlottetilbury', 3_700_000, 'charlottetilbury.com', UK, ['Beauty']],
  ['Rare Beauty', 'rarebeauty', 6_000_000, 'rarebeauty.com', 'United States', ['Beauty']],
  ['MAC Cosmetics', 'maccosmetics', 26_000_000, 'maccosmetics.com', 'United States', ['Beauty']],
  ['Fenty Beauty', 'fentybeauty', 12_000_000, 'fentybeauty.com', 'United States', ['Beauty']],
  ['Huda Beauty', 'hudabeauty', 54_000_000, 'hudabeauty.com', 'United Arab Emirates', ['Beauty']],
  ['Makeup Revolution', 'makeuprevolution', 4_000_000, 'revolutionbeauty.com', UK, ['Beauty']],
  ['e.l.f. Cosmetics', 'elfcosmetics', 6_000_000, 'elfcosmetics.com', 'United States', ['Beauty']],
  ['Refy', 'refy', 1_000_000, 'refybeauty.com', UK, ['Beauty']],
  ['Made by Mitchell', 'madebymitchell', 1_500_000, 'madebymitchell.com', UK, ['Beauty']],
  ['NYX Cosmetics', 'nyxcosmetics', 16_000_000, 'nyxcosmetics.com', 'United States', ['Beauty']],
  // Skincare
  ['The Ordinary', 'theordinary', 3_000_000, 'theordinary.com', UK, ['Skincare']],
  ['CeraVe', 'cerave', 1_500_000, 'cerave.com', 'United States', ['Skincare']],
  ['La Roche-Posay', 'larocheposay', 2_000_000, 'laroche-posay.com', 'France', ['Skincare']],
  ['Beauty Pie', 'beautypie', 300_000, 'beautypie.com', UK, ['Skincare', 'Beauty']],
  ['Byoma', 'byoma', 400_000, 'byoma.com', UK, ['Skincare']],
  ['Medik8', 'medik8', 500_000, 'medik8.com', UK, ['Skincare']],
  ['Drunk Elephant', 'drunkelephant', 1_300_000, 'drunkelephant.com', 'United States', ['Skincare']],
  // Haircare
  ['Olaplex', 'olaplex', 2_400_000, 'olaplex.com', 'United States', ['Haircare', 'Beauty']],
  ['Color Wow', 'colorwowhair', 800_000, 'colorwowhair.com', 'United States', ['Haircare']],
  ['Gisou', 'gisou', 1_500_000, 'gisou.com', 'Netherlands', ['Haircare']],
  ['Ouai', 'theouai', 900_000, 'theouai.com', 'United States', ['Haircare']],
  ['Hershesons', 'hershesons', 200_000, 'hershesons.com', UK, ['Haircare']],
  // Activewear / Fitness
  ['Gymshark', 'gymshark', 7_000_000, 'gymshark.com', UK, ['Fitness', 'Activewear']],
  ['Alphalete', 'alphalete', 2_000_000, 'alphalete.com', 'United States', ['Activewear', 'Fitness']],
  ['Lululemon', 'lululemon', 4_500_000, 'lululemon.com', 'Canada', ['Activewear', 'Fitness']],
  ['Represent', 'represent', 1_200_000, 'representclo.com', UK, ['Fashion', 'Activewear']],
  ['Castore', 'castore', 400_000, 'castore.com', UK, ['Activewear', 'Fitness']],
  ['Oner Active', 'oneractive', 700_000, 'oneractive.com', UK, ['Activewear', 'Fitness']],
  ['Bo+Tee', 'boandtee', 600_000, 'boandtee.com', UK, ['Activewear', 'Fashion']],
  ['Adanola', 'adanola', 1_000_000, 'adanola.com', UK, ['Activewear', 'Fashion']],
  ['TALA', 'wearetala', 600_000, 'wearetala.com', UK, ['Activewear', 'Fitness']],
  ['Vuori', 'vuoriclothing', 1_000_000, 'vuoriclothing.com', 'United States', ['Activewear', 'Fitness']],
  // Supplements / Nutrition
  ['Myprotein', 'myprotein', 2_800_000, 'myprotein.com', UK, ['Supplements', 'Health']],
  ['Huel', 'huel', 500_000, 'huel.com', UK, ['Supplements', 'Health']],
  ['Bulk', 'bulk', 600_000, 'bulk.com', UK, ['Supplements', 'Health']],
  ['Form Nutrition', 'formnutrition', 200_000, 'formnutrition.com', UK, ['Supplements', 'Health']],
  ['Innermost', 'liveinnermost', 150_000, 'liveinnermost.com', UK, ['Supplements', 'Health']],
  ['Free Soul', 'yourfreesoul', 200_000, 'yourfreesoul.com', UK, ['Supplements', 'Health']],
  ['Grenade', 'grenadeofficial', 700_000, 'grenade.com', UK, ['Supplements', 'Health']],
  ['Applied Nutrition', 'appliednutrition', 500_000, 'appliednutrition.uk', UK, ['Supplements', 'Health']],
  // Wellness
  ['Wild', 'wild', 200_000, 'wearewild.com', UK, ['Wellness', 'Health']],
  ['Symprove', 'symprove', 80_000, 'symprove.com', UK, ['Wellness', 'Health']],
  // Food / Drink
  ['HelloFresh UK', 'hellofresh_uk', 600_000, 'hellofresh.co.uk', UK, ['Food']],
  ['Gousto', 'goustocooking', 300_000, 'gousto.co.uk', UK, ['Food']],
  ['Mindful Chef', 'mindfulchef', 200_000, 'mindfulchef.com', UK, ['Food']],
  ['Surreal', 'eatsurreal', 100_000, 'eatsurreal.co', UK, ['Food']],
  ['TRIP Drinks', 'trip.drinks', 400_000, 'trip-drinks.com', UK, ['Drink']],
  ['Innocent', 'innocent', 300_000, 'innocentdrinks.co.uk', UK, ['Drink']],
  ['Oatly', 'oatly', 300_000, 'oatly.com', 'Sweden', ['Drink', 'Food']],
  // Home
  ['Dunelm', 'dunelm', 600_000, 'dunelm.com', UK, ['Home']],
  ['Oliver Bonas', 'oliverbonas', 700_000, 'oliverbonas.com', UK, ['Home', 'Fashion']],
  ['H&M Home', 'hmhome', 5_000_000, 'hm.com', 'Sweden', ['Home']],
  // Equestrian
  ['LeMieux', 'lemieuxofficial', 400_000, 'lemieux.com', UK, ['Equestrian']],
  ['Aztec Diamond Equestrian', 'aztecdiamondequestrian', 250_000, 'aztecdiamondequestrian.com', UK, ['Equestrian']],
  ['Premier Equine', 'premierequine', 150_000, 'premierequine.co.uk', UK, ['Equestrian']],
  // Jewellery
  ['Astrid & Miyu', 'astridandmiyu', 600_000, 'astridandmiyu.com', UK, ['Jewellery']],
  ['Missoma', 'missoma', 700_000, 'missoma.com', UK, ['Jewellery']],
  ['Abbott Lyon', 'abbottlyon', 1_000_000, 'abbottlyon.com', UK, ['Jewellery']],
  ['Daisy London', 'daisyjewellery', 200_000, 'daisyjewellery.com', UK, ['Jewellery']],
  // Footwear
  ['Dr. Martens', 'drmartens', 3_000_000, 'drmartens.com', UK, ['Footwear', 'Fashion']],
  ['New Balance', 'newbalance', 7_000_000, 'newbalance.com', 'United States', ['Footwear', 'Activewear']],
  ['Vans', 'vans', 17_000_000, 'vans.com', 'United States', ['Footwear', 'Fashion']],
]

export const STARTER_BRANDS: BrandInput[] = ROWS.map(
  ([name, instagramHandle, followers, website, locationCountry, main]) => ({
    name, instagramHandle, followers, website, locationCountry,
    categories: { main, secondary: [] }, source: 'manual',
  }),
)

// Seed the starter catalog with NO tenant provenance (a system seed — null tenant_id). Idempotent.
// Called at boot from db.ts (after the brands table exists), so a fresh volume self-populates.
export function seedStarterBrands(): void {
  upsertBrands(null, STARTER_BRANDS)
}
