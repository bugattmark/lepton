import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.DB_PATH ?? './data/app.db'
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tenants (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    direction  TEXT NOT NULL,            -- 'in' | 'out'
    jid        TEXT NOT NULL,
    body       TEXT,
    wamid      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, created_at);

  -- Audience: one row per person we can message, scoped to a tenant.
  CREATE TABLE IF NOT EXISTS contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT,
    phone           TEXT NOT NULL,        -- normalized digits, no '+'
    vars            TEXT,                 -- JSON of personalization fields (job_title, company, ...)
    source          TEXT NOT NULL,        -- 'attio' | 'csv' | 'manual'
    attio_record_id TEXT,
    opted_out       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    UNIQUE(tenant_id, phone)
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);

  -- A campaign = a message template + throttle config + an audience.
  CREATE TABLE IF NOT EXISTS campaigns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    template   TEXT NOT NULL,             -- body with {{var}} placeholders
    status     TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'running'|'paused'|'done'
    config     TEXT NOT NULL,             -- JSON throttle/safety config
    created_at INTEGER NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);

  -- A connected WhatsApp number. Many per tenant; mix of 'baileys' (QR) and 'cloud' (official).
  CREATE TABLE IF NOT EXISTS accounts (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,            -- 'baileys' | 'cloud'
    label      TEXT NOT NULL,
    config     TEXT NOT NULL DEFAULT '{}', -- cloud: {phoneNumberId, token, graphVersion}; baileys: {}
    profile_id INTEGER,                   -- default send-profile to prefill campaigns
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id);

  -- Reusable send-engine settings ("templates") a user can apply to any number/campaign.
  CREATE TABLE IF NOT EXISTS send_profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL,            -- JSON CampaignConfig
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_profiles_tenant ON send_profiles(tenant_id);

  -- The send queue: one row per (campaign, contact).
  CREATE TABLE IF NOT EXISTS campaign_contacts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'sent'|'replied'|'failed'|'skipped'
    sent_at      INTEGER,
    replied_at   INTEGER,
    wamid        TEXT,
    error        TEXT,
    UNIQUE(campaign_id, contact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cc_campaign ON campaign_contacts(campaign_id, status);
  CREATE INDEX IF NOT EXISTS idx_cc_contact ON campaign_contacts(contact_id, status);
`)

// --- lightweight column migrations (ALTER has no IF NOT EXISTS in sqlite) ---
function addColumn(table: string, col: string, decl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  } catch {
    /* already exists */
  }
}
addColumn('tenants', 'attio_api_key', 'TEXT') // per-tenant Attio token (paste once)
addColumn('tenants', 'api_token', 'TEXT') // for the MCP server / programmatic access
addColumn('tenants', 'attio_writeback', 'INTEGER') // 1 = log messaged/replied as Attio notes
addColumn('campaigns', 'account_id', 'TEXT') // which number sends this campaign
addColumn('campaigns', 'profile_id', 'INTEGER') // send-profile this campaign was built from
addColumn('campaigns', 'cloud_template', 'TEXT') // cloud accounts: approved template name for cold sends
addColumn('campaigns', 'cloud_lang', 'TEXT') // cloud template language code
addColumn('campaigns', 'followup_template', 'TEXT') // step-2 message if no reply
addColumn('campaigns', 'followup_after_days', 'INTEGER') // days to wait before step 2
addColumn('campaigns', 'ai_personalize', 'INTEGER') // 1 = Claude writes a tailored opener
addColumn('campaigns', 'ai_prompt', 'TEXT') // user's steering instruction for the AI opener
addColumn('campaigns', 'ai_research_fields', 'TEXT') // JSON array of var slugs holding URLs to read
addColumn('messages', 'account_id', 'TEXT') // which number sent/received this
addColumn('campaign_contacts', 'followup_sent_at', 'INTEGER') // when step-2 went out
addColumn('contacts', 'attio_object', 'TEXT') // source object slug (for write-back)

// --- v3: lemlist-style canvas sequences, per-campaign lead lists, multi-account rotation ---
addColumn('contacts', 'instagram_handle', 'TEXT') // lead-table column + {{instagram_handle}} var
addColumn('contacts', 'event_link', 'TEXT') // the "Event (Instagram link)" column + {{instagram_link}} var
addColumn('contacts', 'category', 'TEXT') // lead-table column + {{category}} var
addColumn('accounts', 'send_policy', 'TEXT') // per-number warmup + distribution + window (JSON SendPolicy)
addColumn('campaigns', 'sequence', 'TEXT') // JSON {nodes,edges} drawn on the canvas (source of truth)
addColumn('campaign_contacts', 'account_id', 'TEXT') // which number sends THIS lead (rotated across the checklist)
addColumn('campaign_contacts', 'node_id', 'TEXT') // where this lead currently sits in the sequence
addColumn('campaign_contacts', 'next_due_at', 'INTEGER') // earliest time to act on this lead (wait blocks)

// --- suppression + is-on-WhatsApp gate ---
addColumn('contacts', 'last_messaged_at', 'INTEGER') // last successful WhatsApp send (10-day suppression window)
addColumn('contacts', 'wa_registered', 'INTEGER') // 1/0 = number is/ isn't on WhatsApp (null = unchecked)
addColumn('contacts', 'wa_checked_at', 'INTEGER') // when we last ran the onWhatsApp check (cache)

// --- Instagram connection (creator authorizes their own account via Business Login) ---
addColumn('tenants', 'ig_user_id', 'TEXT') // their Instagram professional account ID
addColumn('tenants', 'ig_username', 'TEXT') // their @handle
addColumn('tenants', 'ig_access_token', 'TEXT') // long-lived (60d) token, encrypted at rest
addColumn('tenants', 'ig_token_expires_at', 'INTEGER') // epoch ms; refreshed lazily before expiry
addColumn('tenants', 'ig_connected_at', 'INTEGER') // when they first connected

// --- Google connection ("Continue with Google" + Gmail read/send) ---
addColumn('tenants', 'google_email', 'TEXT') // the Google account email they connected
addColumn('tenants', 'google_sub', 'TEXT') // stable Google user id (OIDC 'sub')
addColumn('tenants', 'google_access_token', 'TEXT') // short-lived access token
addColumn('tenants', 'google_refresh_token', 'TEXT') // long-lived refresh token (offline access)
addColumn('tenants', 'google_token_expires_at', 'INTEGER') // epoch ms; refreshed lazily before expiry
addColumn('tenants', 'google_connected_at', 'INTEGER') // when they first connected Google

// --- reply-driven Attio stage write-back ---
addColumn('tenants', 'attio_stage_sync', 'INTEGER') // 1 = reply-triggered stage assessment on
addColumn('tenants', 'attio_sync_config', 'TEXT') // JSON SyncConfig (salesListId, stageOptions, etc.)
addColumn('tenants', 'business_description', 'TEXT') // one-liner about their business (LLM prompt context)
addColumn('contacts', 'attio_synced_at', 'INTEGER') // last successful assessment (debounce)
addColumn('contacts', 'attio_synced_stage', 'TEXT') // last stage written to Attio
addColumn('contacts', 'attio_summary_hash', 'TEXT') // hash of last summary written

// The checklist: which WhatsApp numbers a campaign sends from (sends rotate across them).
db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_accounts (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ca_campaign ON campaign_accounts(campaign_id);

  -- Saved lead sources. A campaign's "Lead list" block points at one of these and
  -- fetches from it (CSV snapshot or a live Attio list) — re-pulling on the loop cadence.
  CREATE TABLE IF NOT EXISTS lead_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,            -- 'csv' | 'attio'
    config     TEXT NOT NULL,            -- csv: {rows:[...]}; attio: {object,listId,mapping}
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_lists_tenant ON lead_lists(tenant_id);

  -- Brand directory: discoverable companies to pitch (the /dashboard/brands page).
  -- SHARED GLOBAL CATALOG — one row per brand, visible to every tenant (not siloed per
  -- account). tenant_id is provenance only (who first added it) and is nullable with
  -- ON DELETE SET NULL so the catalog survives a tenant being deleted. Dedupe is global on
  -- name. Contact + IG + socials live in JSON blobs so a source can capture everything it
  -- returns without churning the schema.
  CREATE TABLE IF NOT EXISTS brands (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id          TEXT REFERENCES tenants(id) ON DELETE SET NULL, -- provenance (nullable); catalog is shared
    name               TEXT NOT NULL,
    logo_url           TEXT,
    instagram_handle   TEXT,                  -- without '@'
    instagram_url      TEXT,
    followers          INTEGER,               -- IG follower count (normalized number)
    website            TEXT,
    email              TEXT,                  -- primary outreach email (enriched)
    phone              TEXT,
    description        TEXT,
    location_city      TEXT,
    location_region    TEXT,                  -- state / county
    location_country   TEXT,
    categories         TEXT,                  -- JSON: {main:[...], secondary:[...]}
    socials            TEXT,                  -- JSON: {facebook,youtube,linkedin,tiktok,twitter,pinterest,...}
    contacts           TEXT,                  -- JSON array of {name,role,email,phone,source}
    enrichment         TEXT,                  -- JSON: raw Exa/research findings + provenance
    source             TEXT NOT NULL DEFAULT 'manual', -- 'hiker'|'exa'|'bento'|'manual'|'csv'
    source_ref         TEXT,                  -- external id/url at the source
    status             TEXT NOT NULL DEFAULT 'new',     -- 'new'|'enriching'|'enriched'|'contacted'|'archived'
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    UNIQUE(name)
  );
  CREATE INDEX IF NOT EXISTS idx_brands_handle ON brands(instagram_handle);
  CREATE INDEX IF NOT EXISTS idx_brands_followers ON brands(followers);

  -- Onboarding state, one row per tenant. The /start-onboarding wizard writes here;
  -- the /dashboard reads it (shared contract). intake_* = the 2-step intake answers;
  -- steps_done = JSON array of completed onboarding-step keys; completed_at set when finished.
  CREATE TABLE IF NOT EXISTS onboarding (
    tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    name              TEXT,                 -- "Your Name"
    roles             TEXT,                 -- JSON array: "Who are you?" (multi)
    pitch_to          TEXT,                 -- "Who do you want to pitch to?" (free text)
    journey           TEXT,                 -- "Where are you in your brand deal journey?" (single)
    heard_from        TEXT,                 -- "How did you hear about us?" (single)
    brand_categories  TEXT,                 -- JSON array: "What brand categories..." (multi)
    link              TEXT,                 -- onboarding step: "Add a Link"
    pitch_template    TEXT,                 -- onboarding step: pitch email body
    followup_template TEXT,                 -- onboarding step: follow-up email body
    steps_done        TEXT NOT NULL DEFAULT '[]', -- JSON array of completed step keys
    pitches_sent      INTEGER NOT NULL DEFAULT 0,  -- progress toward "Send 10 Brand Pitches"
    intake_done_at    INTEGER,              -- when the 2-step intake was submitted
    completed_at      INTEGER,              -- when all onboarding steps finished (-> /dashboard)
    updated_at        INTEGER NOT NULL
  );

  -- Saved email templates, one row per (tenant, template). The "Modify your template"
  -- editor reads/writes these; "Save template" updates one, "Save as new template" inserts.
  -- type splits the first message ('outreach') from the chase ('followup').
  CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'outreach', -- 'outreach' | 'followup'
    name       TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id, type);
`)

// --- migration: make the brands directory a SHARED GLOBAL catalog ---
// The original brands table siloed rows per tenant (UNIQUE(tenant_id,name) + tenant_id NOT
// NULL ON DELETE CASCADE), so each account saw only its own brands and deleting a tenant
// would wipe the catalog. Rebuild in place to the global schema: tenant_id nullable
// (provenance, ON DELETE SET NULL) and dedupe UNIQUE(name). Detected by the old UNIQUE so it
// runs exactly once; fails loud (throws) if the rebuild can't complete.
{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='brands'").get() as
    | { sql?: string }
    | undefined
  const ddl = row?.sql ?? ''
  if (/UNIQUE\s*\(\s*tenant_id\s*,\s*name\s*\)/i.test(ddl)) {
    // FK enforcement must be off while we drop/rename a table other rows reference.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE brands_new (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id          TEXT REFERENCES tenants(id) ON DELETE SET NULL,
          name               TEXT NOT NULL,
          logo_url           TEXT,
          instagram_handle   TEXT,
          instagram_url      TEXT,
          followers          INTEGER,
          website            TEXT,
          email              TEXT,
          phone              TEXT,
          description        TEXT,
          location_city      TEXT,
          location_region    TEXT,
          location_country   TEXT,
          categories         TEXT,
          socials            TEXT,
          contacts           TEXT,
          enrichment         TEXT,
          source             TEXT NOT NULL DEFAULT 'manual',
          source_ref         TEXT,
          status             TEXT NOT NULL DEFAULT 'new',
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL,
          UNIQUE(name)
        );
        INSERT INTO brands_new (
          id, tenant_id, name, logo_url, instagram_handle, instagram_url, followers, website,
          email, phone, description, location_city, location_region, location_country,
          categories, socials, contacts, enrichment, source, source_ref, status, created_at, updated_at
        )
        SELECT
          id, tenant_id, name, logo_url, instagram_handle, instagram_url, followers, website,
          email, phone, description, location_city, location_region, location_country,
          categories, socials, contacts, enrichment, source, source_ref, status, created_at, updated_at
        FROM brands;
        DROP TABLE brands;
        ALTER TABLE brands_new RENAME TO brands;
        CREATE INDEX IF NOT EXISTS idx_brands_handle ON brands(instagram_handle);
        CREATE INDEX IF NOT EXISTS idx_brands_followers ON brands(followers);
      `)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`brands shared-catalog migration failed: ${(e as Error).message}`, { cause: e })
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
}

// ============================================================================
// Creator-first pipeline — stage 1 (Creator IQ), stage 2 (Brand Matching), stage 3 (Proposals).
// All net-new tables: the 2026-06-06 dual-mode spec *declared* creator_profiles/proposals but they
// were never built, so there is nothing to migrate. FK order: tenants/brands (exist) ->
// creator_profiles -> creator_brand_matches/_deals -> proposals -> proposal_creators. rate_cards /
// pricing_config have no FKs. See docs/superpowers/plans/2026-06-07-foundation-plan.md.
// ============================================================================
db.exec(`
  -- Creator IQ (stage 1): one structured profile per tenant. Base shape from the dual-mode spec;
  -- stage-1 fields promoted to real columns below (queryable/joinable; rich detail stays JSON).
  CREATE TABLE IF NOT EXISTS creator_profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    instagram_handle TEXT,
    tiktok_handle    TEXT,
    youtube_channel  TEXT,
    website          TEXT,
    bio              TEXT,
    profile_data     TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    UNIQUE(tenant_id)              -- v1: one working profile per tenant (clean ON CONFLICT upsert)
  );
  CREATE INDEX IF NOT EXISTS idx_creator_profiles_tenant ON creator_profiles(tenant_id);
`)

// Creator IQ stage-1 promoted columns (creatoriq.ts writes these incrementally; stage-2/views read them).
addColumn('creator_profiles', 'creator_type', 'TEXT')        // 'content' | 'events' | 'both' (inferred)
addColumn('creator_profiles', 'visual_signals', 'TEXT')      // JSON: multimodal vision pass (subjects, aesthetic, on-camera brands)
addColumn('creator_profiles', 'niche', 'TEXT')
addColumn('creator_profiles', 'content_style', 'TEXT')
addColumn('creator_profiles', 'engagement_rate', 'REAL')
addColumn('creator_profiles', 'demographics', 'TEXT')        // JSON {age,gender,country,city}
addColumn('creator_profiles', 'demographics_source', 'TEXT') // 'ig_business' | 'none'
addColumn('creator_profiles', 'sectors', 'TEXT')             // JSON [{category,score,reason}] — categoryFacets() names
addColumn('creator_profiles', 'inferred_audience', 'TEXT')   // JSON {summary, likely_buyer_sectors[], confidence}
addColumn('creator_profiles', 'past_deals', 'TEXT')          // JSON [{brand,result,source:'self'|'caption'}]
addColumn('creator_profiles', 'signals_used', 'TEXT')        // JSON: which signals present vs missing (fail-loud)
addColumn('creator_profiles', 'summary', 'TEXT')
addColumn('creator_profiles', 'status', 'TEXT')              // 'idle'|'running'|'done'|'error'
addColumn('creator_profiles', 'error', 'TEXT')
addColumn('creator_profiles', 'generated_at', 'INTEGER')
// External data sources (2026-06-07-external-data-sources-design.md): additive, env-gated tiers.
addColumn('creator_profiles', 'cross_platform', 'TEXT') // JSON [{platform,handle,followers,er,source}] (Apify Tier 1.5)
addColumn('creator_profiles', 'web_signals', 'TEXT')    // JSON {press,site,podcasts,collabs,evidence_url[]} (Exa Tier 1.6)

db.exec(`
  -- Stage 2 output: per-creator ranked brand shortlist (tenant-scoped). Brand identity lives in the
  -- shared brands catalog (written via upsertBrands); this references it.
  CREATE TABLE IF NOT EXISTS creator_brand_matches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    brand_id    INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    score       INTEGER,
    tier        TEXT,
    move        TEXT,                              -- 'estimate' | 'net_new' (v1); 'comparable' reserved for phase 2
    reason      TEXT,
    evidence    TEXT,                              -- JSON
    status      TEXT NOT NULL DEFAULT 'suggested', -- 'suggested'|'selected'|'rejected'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_cbm_creator ON creator_brand_matches(creator_id, status);
  CREATE INDEX IF NOT EXISTS idx_cbm_tenant  ON creator_brand_matches(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_cbm_brand   ON creator_brand_matches(brand_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cbm_unique ON creator_brand_matches(tenant_id, creator_id, brand_id);

  -- Stage 2 phase-2 dataset: mined PUBLIC deals about OTHER creators -> global cache (provenance).
  CREATE TABLE IF NOT EXISTS creator_brand_deals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_handle TEXT NOT NULL,
    brand_id       INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    brand_name     TEXT,
    brand_handle   TEXT,
    source         TEXT NOT NULL,   -- 'ad_library'|'sponsor_tag'|'caption'|'usertag'|'event_sponsor'
    evidence_url   TEXT,
    confidence     TEXT,
    seen_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deals_brand  ON creator_brand_deals(brand_id);
  CREATE INDEX IF NOT EXISTS idx_deals_handle ON creator_brand_deals(creator_handle);

  -- Stage 3 pricing source-of-truth. SEEDED idempotently below. Currency-aware; low/mid/high are
  -- whole-currency amounts (GBP). source = provenance.
  CREATE TABLE IF NOT EXISTS rate_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tier       TEXT NOT NULL,    -- 'nano'|'micro'|'mid'|'macro'|'mega' | 'event'
    platform   TEXT NOT NULL,    -- 'instagram'|'tiktok'|'ugc'|'event'
    format     TEXT NOT NULL,    -- 'post'|'reel'|'story'|'video'|'ugc' | event deliverable slug
    low        INTEGER,
    mid        INTEGER,
    high       INTEGER,
    currency   TEXT NOT NULL,    -- 'GBP'|'USD'
    source     TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tier, platform, format, currency)
  );
  CREATE INDEX IF NOT EXISTS idx_rate_cards_lookup ON rate_cards(tier, platform, format, currency);

  -- Stage 3 pricing config: take_rate/niche/usage/exclusivity/ER-curve/bundle/guarantee/split.
  -- ALL config, never literals in proposals.ts. Global defaults seeded; per-tenant overrides use a
  -- 'key:<tenantId>' namespace (never mutate the bare global row). Missing config => pricing THROWS.
  CREATE TABLE IF NOT EXISTS pricing_config (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Stage 3: a priced, brand-facing proposal. Base from dual-mode spec, reconciled to creator/brand
  -- scope (campaign_id nullable — stage 3 keys off creator_profile_id + brand_id).
  CREATE TABLE IF NOT EXISTS proposals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id        INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    brand_match_id     INTEGER REFERENCES creator_brand_matches(id) ON DELETE SET NULL,
    creator_profile_id INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    tiers              TEXT NOT NULL,
    stretch_goals      TEXT,
    status             TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'sent'|'viewed'|'accepted'
    public_token       TEXT UNIQUE,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_creator ON proposals(creator_profile_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_token   ON proposals(public_token);
`)

// Stage-3 money + linkage columns (pricing engine writes; /p/:token reads).
addColumn('proposals', 'brand_id', 'INTEGER REFERENCES brands(id) ON DELETE SET NULL')
addColumn('proposals', 'deal_type', 'TEXT')          // 'creator_pitched' | 'platform_campaign'
addColumn('proposals', 'gross_price', 'INTEGER')
addColumn('proposals', 'creator_net', 'INTEGER')
addColumn('proposals', 'platform_cut', 'INTEGER')
addColumn('proposals', 'take_rate_applied', 'REAL')
addColumn('proposals', 'guarantee', 'TEXT')          // JSON {threshold, window_ends_at, state}
addColumn('proposals', 'tenant_id', 'TEXT REFERENCES tenants(id) ON DELETE CASCADE')
addColumn('proposals', 'updated_at', 'INTEGER')

db.exec(`
  -- Stage 3 follow-phase: platform_campaign proposals fan out to many creators. Schema landed now;
  -- populated by the follow phase. Per-creator pitched proposals never use this table.
  CREATE TABLE IF NOT EXISTS proposal_creators (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
    rate        INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_creators_prop ON proposal_creators(proposal_id);
`)

// --- Stage-3 pricing seeds (idempotent; fail loud at boot) ---------------------------------------
// Canonical pricing data from docs/superpowers/specs/2026-06-07-proposal-pricing-design.md (GBP UK
// benchmark). It lands in the DB so proposals.ts reads rows, never inlines numbers ("nothing
// hardcoded"). low/high = band ends; mid = rounded midpoint. Both seeds mirror upsertBrands:
// INSERT ... ON CONFLICT DO UPDATE in BEGIN/COMMIT, ROLLBACK+throw on failure (a bad seed aborts boot
// rather than half-populating). OVERRIDE NAMESPACE: these seeds own only the bare global pricing_config
// keys and refresh them every boot; per-creator/tenant overrides MUST use a 'key:<tenantId>' namespace
// and are never touched here.
const CONTENT_RATES: { tier: string; platform: string; format: string; low: number; high: number }[] = [
  { tier: 'nano', platform: 'instagram', format: 'post', low: 50, high: 300 },
  { tier: 'nano', platform: 'instagram', format: 'reel', low: 80, high: 450 },
  { tier: 'nano', platform: 'instagram', format: 'story', low: 30, high: 150 },
  { tier: 'nano', platform: 'tiktok', format: 'video', low: 50, high: 300 },
  { tier: 'nano', platform: 'ugc', format: 'ugc', low: 80, high: 250 },
  { tier: 'micro', platform: 'instagram', format: 'post', low: 150, high: 800 },
  { tier: 'micro', platform: 'instagram', format: 'reel', low: 250, high: 1200 },
  { tier: 'micro', platform: 'instagram', format: 'story', low: 80, high: 350 },
  { tier: 'micro', platform: 'tiktok', format: 'video', low: 150, high: 900 },
  { tier: 'micro', platform: 'ugc', format: 'ugc', low: 150, high: 400 },
  { tier: 'mid', platform: 'instagram', format: 'post', low: 500, high: 2500 },
  { tier: 'mid', platform: 'instagram', format: 'reel', low: 800, high: 3500 },
  { tier: 'mid', platform: 'instagram', format: 'story', low: 250, high: 1000 },
  { tier: 'mid', platform: 'tiktok', format: 'video', low: 500, high: 2500 },
  { tier: 'macro', platform: 'instagram', format: 'post', low: 2000, high: 8000 },
  { tier: 'macro', platform: 'instagram', format: 'reel', low: 3000, high: 12000 },
  { tier: 'macro', platform: 'instagram', format: 'story', low: 800, high: 3000 },
  { tier: 'macro', platform: 'tiktok', format: 'video', low: 2000, high: 9000 },
  { tier: 'mega', platform: 'instagram', format: 'post', low: 5000, high: 25000 },
]
const EVENT_RATES: { format: string; low: number; high: number }[] = [
  { format: 'stage_shoutout', low: 100, high: 600 },
  { format: 'logo_placement', low: 150, high: 1000 },
  { format: 'booth', low: 300, high: 2000 },
  { format: 'host_appearance', low: 500, high: 3000 },
  { format: 'recap_package', low: 300, high: 1500 },
]

// Pricing knobs (spec-3 "Locked decisions"); defaults set now, evolve by config not code.
const PRICING_DEFAULTS: Record<string, unknown> = {
  take_rate: 0.15, // global default; per-creator override = key 'take_rate:<tenantId>'
  bundle_adjustment: -0.1, // small multi-deliverable discount, applied as (1 + bundle_adjustment)
  niche_multipliers: {
    default: 1.0, lifestyle: 1.0, beauty: 1.1, fashion: 1.1, fitness: 1.2, food: 1.0, travel: 1.1,
    finance: 4.0, saas: 4.0, b2b: 3.5, tech: 2.0,
  },
  usage_rights_uplift: { none: 0.0, organic: 0.0, paid_ads: 0.35, full_buyout: 0.5 },
  exclusivity_uplift: { none: 0.0, '3mo': 0.15, '6mo': 0.3, '12mo': 0.5 },
  er_curve: {
    expected: { nano: 0.04, micro: 0.03, mid: 0.025, macro: 0.018, mega: 0.012 },
    floor: 0.7, ceil: 1.5,
  },
  cpm_rails: { instagram: [5, 12], tiktok: [2, 8], youtube: [8, 15] }, // USD CPM sanity bands
  guarantee: { threshold: 1000, window_days: 30, split: { platform: 0.5, creator: 0.5 } },
  usd_fx_from_gbp: 1.27, // for the secondary USD card (not seeded in v1)
  combined_reach_discount: 0.5, // 'X across socials' aggregate -> est. primary-platform-equivalent (soft; evolve by config)
}

// Seed the GBP rate cards. Re-runnable: UNIQUE(tier,platform,format,currency) + ON CONFLICT DO UPDATE.
export function seedRateCards(): void {
  const now = Date.now()
  const ins = db.prepare(`
    INSERT INTO rate_cards (tier, platform, format, low, mid, high, currency, source, updated_at)
    VALUES (@tier, @platform, @format, @low, @mid, @high, @currency, @source, @now)
    ON CONFLICT(tier, platform, format, currency) DO UPDATE SET
      low = excluded.low, mid = excluded.mid, high = excluded.high,
      source = excluded.source, updated_at = excluded.updated_at
  `)
  const rows = [
    ...CONTENT_RATES,
    ...EVENT_RATES.map((r) => ({ tier: 'event', platform: 'event', format: r.format, low: r.low, high: r.high })),
  ]
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      ins.run({
        tier: r.tier, platform: r.platform, format: r.format,
        low: r.low, mid: Math.round((r.low + r.high) / 2), high: r.high,
        currency: 'GBP', source: '2026-uk-benchmark', now,
      })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`seedRateCards failed: ${(e as Error).message}`, { cause: e })
  }
}

// Seed the global pricing config defaults. Re-runnable: UNIQUE(key) + ON CONFLICT DO UPDATE.
export function seedPricingConfig(): void {
  const now = Date.now()
  const ins = db.prepare(`
    INSERT INTO pricing_config (key, value_json, updated_at)
    VALUES (@key, @value_json, @now)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `)
  db.exec('BEGIN')
  try {
    for (const [key, value] of Object.entries(PRICING_DEFAULTS)) {
      ins.run({ key, value_json: JSON.stringify(value), now })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`seedPricingConfig failed: ${(e as Error).message}`, { cause: e })
  }
}

seedRateCards()
seedPricingConfig()

export interface TenantRow {
  id: string
  email: string
  password_hash: string
  created_at: number
  attio_api_key?: string | null
  api_token?: string | null
  ig_user_id?: string | null
  ig_username?: string | null
  ig_access_token?: string | null
  ig_token_expires_at?: number | null
  ig_connected_at?: number | null
  google_email?: string | null
  google_sub?: string | null
  google_access_token?: string | null
  google_refresh_token?: string | null
  google_token_expires_at?: number | null
  google_connected_at?: number | null
  attio_stage_sync?: number | null
  attio_sync_config?: string | null
  business_description?: string | null
}

export interface OnboardingRow {
  tenant_id: string
  name: string | null
  roles: string | null
  pitch_to: string | null
  journey: string | null
  heard_from: string | null
  brand_categories: string | null
  link: string | null
  pitch_template: string | null
  followup_template: string | null
  steps_done: string
  pitches_sent: number
  intake_done_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface TemplateRow {
  id: number
  tenant_id: string
  type: string
  name: string
  subject: string
  body: string
  created_at: number
  updated_at: number
}

export interface BrandRow {
  id: number
  tenant_id: string
  name: string
  logo_url: string | null
  instagram_handle: string | null
  instagram_url: string | null
  followers: number | null
  website: string | null
  email: string | null
  phone: string | null
  description: string | null
  location_city: string | null
  location_region: string | null
  location_country: string | null
  categories: string | null // JSON {main:[],secondary:[]}
  socials: string | null // JSON
  contacts: string | null // JSON array
  enrichment: string | null // JSON
  source: string
  source_ref: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface AccountRow {
  id: string
  tenant_id: string
  type: 'baileys' | 'cloud'
  label: string
  config: string
  profile_id: number | null
  created_at: number
}

export interface SendProfileRow {
  id: number
  tenant_id: string
  name: string
  config: string
  created_at: number
}

export interface LeadListRow {
  id: number
  tenant_id: string
  name: string
  type: 'csv' | 'attio' | 'sourced'
  config: string
  created_at: number
}

export interface ContactRow {
  id: number
  tenant_id: string
  name: string | null
  phone: string
  vars: string | null
  source: string
  attio_record_id: string | null
  opted_out: number
  created_at: number
  instagram_handle: string | null
  event_link: string | null
  category: string | null
  last_messaged_at: number | null
  wa_registered: number | null
  wa_checked_at: number | null
  attio_synced_at?: number | null
  attio_synced_stage?: string | null
  attio_summary_hash?: string | null
}

export interface CampaignRow {
  id: number
  tenant_id: string
  name: string
  template: string
  status: 'draft' | 'running' | 'paused' | 'done'
  config: string
  created_at: number
  started_at: number | null
  account_id: string | null
  profile_id: number | null
  cloud_template: string | null
  cloud_lang: string | null
  followup_template: string | null
  followup_after_days: number | null
  ai_personalize: number | null
  ai_prompt: string | null
  ai_research_fields: string | null
  sequence: string | null
}

// --- creator-first pipeline rows ---

export interface CreatorProfileRow {
  id: number
  tenant_id: string
  name: string
  instagram_handle: string | null
  tiktok_handle: string | null
  youtube_channel: string | null
  website: string | null
  bio: string | null
  profile_data: string | null // JSON (legacy/overflow)
  created_at: number
  updated_at: number | null
  creator_type: string | null // 'content' | 'events' | 'both'
  visual_signals: string | null // JSON
  niche: string | null
  content_style: string | null
  engagement_rate: number | null
  demographics: string | null // JSON {age,gender,country,city}
  demographics_source: string | null // 'ig_business' | 'none'
  sectors: string | null // JSON [{category,score,reason}]
  inferred_audience: string | null // JSON {summary, likely_buyer_sectors[], confidence}
  past_deals: string | null // JSON [{brand,result,source}]
  signals_used: string | null // JSON
  summary: string | null
  status: string | null // 'idle'|'running'|'done'|'error'
  error: string | null
  generated_at: number | null
  cross_platform: string | null // JSON (Apify Tier 1.5)
  web_signals: string | null // JSON (Exa Tier 1.6)
}

export interface CreatorBrandMatchRow {
  id: number
  tenant_id: string
  creator_id: number
  brand_id: number
  score: number | null
  tier: string | null
  move: string | null // 'estimate' | 'net_new' (v1); 'comparable' phase 2
  reason: string | null
  evidence: string | null // JSON
  status: string
  created_at: number
  updated_at: number | null
}

export interface CreatorBrandDealRow {
  id: number
  creator_handle: string
  brand_id: number | null
  brand_name: string | null
  brand_handle: string | null
  source: string // 'ad_library'|'sponsor_tag'|'caption'|'usertag'|'event_sponsor'
  evidence_url: string | null
  confidence: string | null
  seen_at: number
}

export interface RateCardRow {
  id: number
  tier: string
  platform: string
  format: string
  low: number | null
  mid: number | null
  high: number | null
  currency: string
  source: string
  updated_at: number
}

export interface PricingConfigRow {
  id: number
  key: string
  value_json: string // JSON
  updated_at: number
}

export interface ProposalRow {
  id: number
  campaign_id: number | null
  brand_match_id: number | null
  creator_profile_id: number
  tiers: string // JSON array of tier objects
  stretch_goals: string | null // JSON array
  status: string // 'draft'|'sent'|'viewed'|'accepted'
  public_token: string | null
  created_at: number
  brand_id: number | null
  deal_type: string | null // 'creator_pitched' | 'platform_campaign'
  gross_price: number | null
  creator_net: number | null
  platform_cut: number | null
  take_rate_applied: number | null
  guarantee: string | null // JSON {threshold, window_ends_at, state}
  tenant_id: string | null
  updated_at: number | null
}

export interface ProposalCreatorRow {
  id: number
  proposal_id: number
  creator_id: number
  rate: number | null
  status: string
}
