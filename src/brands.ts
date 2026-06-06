// Brands directory persistence (see BRANDS.md). One row per (tenant_id, name).
// upsertBrand is the single write path — used by the onbento seed ingest and any future
// brand source (hiker/exa/csv). It merges on the UNIQUE(tenant_id, name) constraint so a
// re-run updates in place instead of duplicating.
import { db } from './db.ts'

// Normalized brand shape every source produces before it hits the DB.
export interface BrandInput {
  name: string
  logoUrl?: string | null
  instagramHandle?: string | null // without '@'
  instagramUrl?: string | null
  followers?: number | null
  website?: string | null
  email?: string | null // full address; null when only a masked/domain hint is known
  phone?: string | null
  description?: string | null
  locationCity?: string | null
  locationRegion?: string | null
  locationCountry?: string | null
  categories?: { main?: string[]; secondary?: string[] } | null
  socials?: Record<string, string> | null // {instagram,tiktok,facebook,youtube,linkedin,twitter,pinterest}
  contacts?: unknown[] | null // [{name,role,email,emailDomain,hunterScore,source,...}]
  enrichment?: unknown | null // raw provider signals + provenance
  source?: string // 'hiker'|'exa'|'bento'|'manual'|'csv'
  sourceRef?: string | null // external id/url at the source
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v))

export interface UpsertResult {
  inserted: number
  updated: number
}

// Insert or merge a batch of brands for one tenant. COALESCE keeps any existing non-null
// value when an incoming field is null, so a thinner later source never wipes richer data.
export function upsertBrands(tenantId: string, brands: BrandInput[]): UpsertResult {
  const now = Date.now()
  const res: UpsertResult = { inserted: 0, updated: 0 }

  const insert = db.prepare(`
    INSERT INTO brands (
      tenant_id, name, logo_url, instagram_handle, instagram_url, followers, website,
      email, phone, description, location_city, location_region, location_country,
      categories, socials, contacts, enrichment, source, source_ref, status, created_at, updated_at
    ) VALUES (
      @tenant_id, @name, @logo_url, @instagram_handle, @instagram_url, @followers, @website,
      @email, @phone, @description, @location_city, @location_region, @location_country,
      @categories, @socials, @contacts, @enrichment, @source, @source_ref, 'new', @now, @now
    )
    ON CONFLICT(tenant_id, name) DO UPDATE SET
      logo_url         = COALESCE(excluded.logo_url, brands.logo_url),
      instagram_handle = COALESCE(excluded.instagram_handle, brands.instagram_handle),
      instagram_url    = COALESCE(excluded.instagram_url, brands.instagram_url),
      followers        = COALESCE(excluded.followers, brands.followers),
      website          = COALESCE(excluded.website, brands.website),
      email            = COALESCE(excluded.email, brands.email),
      phone            = COALESCE(excluded.phone, brands.phone),
      description      = COALESCE(excluded.description, brands.description),
      location_city    = COALESCE(excluded.location_city, brands.location_city),
      location_region  = COALESCE(excluded.location_region, brands.location_region),
      location_country = COALESCE(excluded.location_country, brands.location_country),
      categories       = COALESCE(excluded.categories, brands.categories),
      socials          = COALESCE(excluded.socials, brands.socials),
      contacts         = COALESCE(excluded.contacts, brands.contacts),
      enrichment       = COALESCE(excluded.enrichment, brands.enrichment),
      source           = excluded.source,
      source_ref       = COALESCE(excluded.source_ref, brands.source_ref),
      updated_at       = @now
  `)

  const exists = db.prepare('SELECT 1 FROM brands WHERE tenant_id = ? AND name = ?')
  db.exec('BEGIN')
  try {
    for (const b of brands) {
      const name = (b.name ?? '').trim()
      if (!name) continue
      const before = exists.get(tenantId, name)
      insert.run({
        tenant_id: tenantId,
        name,
        logo_url: b.logoUrl ?? null,
        instagram_handle: b.instagramHandle ?? null,
        instagram_url: b.instagramUrl ?? null,
        followers: b.followers ?? null,
        website: b.website ?? null,
        email: b.email ?? null,
        phone: b.phone ?? null,
        description: b.description ?? null,
        location_city: b.locationCity ?? null,
        location_region: b.locationRegion ?? null,
        location_country: b.locationCountry ?? null,
        categories: j(b.categories),
        socials: j(b.socials),
        contacts: j(b.contacts),
        enrichment: j(b.enrichment),
        source: b.source ?? 'manual',
        source_ref: b.sourceRef ?? null,
        now,
      })
      if (before) res.updated++
      else res.inserted++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return res
}

export function brandCount(tenantId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM brands WHERE tenant_id = ?').get(tenantId) as { c: number }).c
}

const parseJson = (s: unknown) => {
  if (typeof s !== 'string') return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Paged, searchable list for the /brands directory page. Highest-follower brands first
// (SQLite sorts NULL followers last under DESC). Search matches name / handle / website / country.
export function listBrands(
  tenantId: string,
  opts: { search?: string; category?: string; limit?: number; offset?: number } = {},
): { total: number; brands: Record<string, unknown>[] } {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const q = (opts.search ?? '').trim()
  const where = ['tenant_id = ?']
  const args: unknown[] = [tenantId]
  if (q) {
    where.push('(name LIKE ? OR instagram_handle LIKE ? OR website LIKE ? OR location_country LIKE ?)')
    const like = `%${q}%`
    args.push(like, like, like, like)
  }
  const cat = (opts.category ?? '').trim()
  if (cat) {
    // categories is JSON like {"main":["Haircare"],"secondary":[]}; match the quoted name token.
    where.push('categories LIKE ?')
    args.push(`%"${cat.replace(/["%_]/g, '')}"%`)
  }
  const whereSql = where.join(' AND ')
  const total = (db.prepare(`SELECT COUNT(*) c FROM brands WHERE ${whereSql}`).get(...args) as { c: number }).c
  const rows = db
    .prepare(
      `SELECT id, name, logo_url, instagram_handle, instagram_url, followers, website, email,
              description, location_city, location_region, location_country, categories, socials,
              contacts, source, status
       FROM brands WHERE ${whereSql}
       ORDER BY followers DESC, name ASC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as Record<string, unknown>[]
  const brands = rows.map((r) => ({
    ...r,
    categories: parseJson(r.categories),
    socials: parseJson(r.socials),
    contacts: parseJson(r.contacts),
  }))
  return { total, brands }
}

// Distinct category names (main + secondary) with brand counts, for the filter UI.
// Sorted by count desc. Computed in JS since categories is stored as a JSON blob.
export function categoryFacets(tenantId: string): { name: string; count: number }[] {
  const rows = db
    .prepare('SELECT categories FROM brands WHERE tenant_id = ? AND categories IS NOT NULL')
    .all(tenantId) as { categories: string }[]
  const counts = new Map<string, number>()
  for (const r of rows) {
    const c = parseJson(r.categories) as { main?: string[]; secondary?: string[] } | null
    if (!c) continue
    const names = new Set([...(c.main ?? []), ...(c.secondary ?? [])].filter(Boolean))
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
