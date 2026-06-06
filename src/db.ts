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
  -- One row per (tenant, brand). Contact + IG + socials live in JSON blobs so a source
  -- can capture everything it returns without churning the schema.
  CREATE TABLE IF NOT EXISTS brands (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
    UNIQUE(tenant_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_brands_tenant ON brands(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_brands_handle ON brands(tenant_id, instagram_handle);

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
`)

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
