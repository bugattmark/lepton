# Brands directory — sourcing, data model & extraction

The `/dashboard/brands` feature: a per-tenant directory of companies to pitch, with
contacts, IG page, categories and location. Backed by the `brands` table (see `src/db.ts`).

## Data model (`brands` table)

One row per `(tenant_id, name)`. Stable, queryable columns for the things we filter/sort on
(name, instagram_handle, followers, location_*, status, source); everything richer rides in
JSON blobs so a new source can't break the schema:

| column | meaning |
|---|---|
| `name`, `logo_url`, `description` | brand identity |
| `instagram_handle` / `instagram_url`, `followers` | IG page (handle stored without `@`) |
| `website`, `email`, `phone` | primary outreach contact (email/phone enriched) |
| `location_city` / `location_region` / `location_country` | geo for region filtering |
| `categories` (JSON) | `{main:[...], secondary:[...]}` — IG/Bento business taxonomy |
| `socials` (JSON) | `{facebook,youtube,linkedin,tiktok,twitter,pinterest,...}` |
| `contacts` (JSON) | array of `{name, role, email, phone, source}` |
| `enrichment` (JSON) | raw research findings + provenance |
| `source` | `hiker` \| `exa` \| `bento` \| `manual` \| `csv` |
| `status` | `new` \| `enriching` \| `enriched` \| `contacted` \| `archived` |

Dedupe key is `(tenant_id, name)`; also indexed on `(tenant_id, instagram_handle)`.

## How to source brands by category / region — HikerAPI (the defensible path)

Validated against the live HikerAPI (see `bench/brandprobe*.py`, `bench/branddemo.py`). The
consensus + measured winner is **seed → recommender snowball**, NOT keyword search.

1. **Seeds** — 1–3 known brands per category (bootstrap with `/v3/fbsearch/accounts` or
   `/gql/topsearch` if you have none). Seed quality dominates the whole run.
2. **Expand (the engine)** — for each seed business:
   - `GET /v2/user/explore/businesses/by/id?user_id=` → ~27 same-category brands, **category
     label inline** (`Health/beauty`, `Clothing (Brand)`, `Jewelry & Watches Store`, …).
   - `GET /v2/user/suggested/profiles?user_id=` → ~80 "similar accounts" peers.
   - BFS, depth 1–2 only (depth 2 balloons to hundreds/seed). Dedupe by `pk`. One seed
     (`@glossier`) → 106 unique candidates in 2 calls.
3. **Cross-confirm (optional)** — intersect with hashtag-author harvest
   (`/v2/hashtag/medias/top`, niche tags) and, for region, place-author harvest
   (`/v3/fbsearch/places` → `/v1/location/medias/top`). Accounts seen in ≥2 sources are
   highest-confidence.
4. **Enrich + filter** — filter the thin objects FIRST (drop private / non-business / out of
   follower band — enrichment is the cost driver), then `GET /v1/user/by/username` for
   `category_name`/`business_category_name`, followers, `public_email`, `public_phone_number`,
   `external_url`, `city`. Region = `city` / `external_url` TLD / `instagram_location_id`.

**Region trick:** snowball from a *regional seed* stays regional (IG suggestions are
geo/audience-correlated) — far cleaner than scraping `location/medias` (mostly tourists).

**Gotchas:** param names are `user_id` / `location_pk` (not `id`); `/v1/fbsearch/topsearch`
is dead (→ `/gql/topsearch`); billing multipliers (stories 2×, highlights 3×); you pay for
403/404 too; suggestion graph drifts ~10–30%/week (re-run & merge). `$0.0006/req`.

## OneBento extraction (the seed-from-competitor path)

OneBento serves its directory from a private JSON API:

```
GET https://app.onbento.com/api/organization/<ORG_ID>/bento-brands
    ?query=&size=20&sort=recommended&category_ids=<id>&category_ids=<sub_id>...
```

- The sidebar `category_ids=N:all` URL param expands to a parent id + all its sub-category ids.
- Auth is a short-lived **Clerk JWT** Bearer token (≈60s TTL) — must be refreshed from the
  Clerk session, not pasted once. Bulk extraction is auth-gated and **likely violates OneBento
  ToS** — treat Bento output as a *seed list only* and re-source/enrich via HikerAPI+Exa so
  stored data comes from primary sources we own.
- Detail fields available per brand: name, logo, IG handle + followers, website, description,
  city/region/country, main+secondary categories, social links (site, IG, FB, YT, LinkedIn,
  TikTok, Twitter, Pinterest). Email/partnership data is plan-gated.

## Status

- [x] `brands` table + `BrandRow` (this branch)
- [ ] `src/brands.ts` — CRUD + importer + enrichment
- [ ] `/dashboard/brands` page (category sidebar + filter bar + cards + detail modal)
- [ ] "Let's Get To Know You" modal (location + dream brands) — note overlap with onboarding
- [ ] Populate: HikerAPI+Exa workflow (one agent per category) / Bento seed import
