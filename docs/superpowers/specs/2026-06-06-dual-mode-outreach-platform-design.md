# Lepton: Dual-Mode Outreach Platform

**Date:** 2026-06-06
**Status:** Draft

## Overview

Lepton evolves from a single-purpose WhatsApp outbound tool into a dual-mode outreach platform serving two distinct customer types on a shared engine.

**Mode 1 — Direct Outreach:** Users contact event organisers, small businesses, and other targets that respond best on WhatsApp. The platform is used directly by the operator (not white-labeled). Lead sources include Hiker (social scraping via AI-generated search terms), Attio (CRM), and CSV import. A qualification stage evaluates candidates against a user-defined ideal client profile before outreach begins.

**Mode 2 — Influencer-to-Brand Platform ("One Influence"):** Creators onboard with their social profiles. The system builds a creator profile, researches matching brands, generates tiered proposal packages, and sends WhatsApp outreach with a link to a hosted proposal page. The brand clicks through to view the proposal and gets onboarded onto the creator's white-labeled platform simultaneously.

**Shared core:** WhatsApp outbound engine (accounts, pacing, sequences), campaign management, contact storage, AI personalization, tab-based campaign hub.

## Architecture

### Approach: Sequential Build (Mode 1 first)

The existing campaign engine, sequence canvas, and Attio/CSV sources are already 70% of Mode 1's backbone. We extend with the tab manager, Hiker source, and qualification stage first. Mode 2 layers on top with creator profiles, brand research, proposal generation, and white-label proposal pages.

Alternatives considered:
- **Parallel build**: Design both modes' schemas from day one, build UI simultaneously. Higher coordination cost, more moving parts before anything ships.
- **Plugin architecture**: Abstract "mode plugins" for sources, qualifiers, outputs. Over-engineered for two known modes.

## Design

### 1. Campaign Hub (Tab Manager)

The current flat campaign list becomes a persistent tab bar at the top of the dashboard.

**UX flow:**
- Top of dashboard: horizontal tab bar showing active campaigns by name + status badge
- "+" button opens a New Campaign modal:
  - Mode selector (if tenant has both modes enabled): "Direct Outreach" or "Influencer → Brand"
  - Source selector: "Fresh from Hiker" / "Load from Attio" / "Import CSV"
- Clicking a tab switches the right panel to that campaign's editor (sequence canvas, leads, preview)
- Closing a tab doesn't delete — campaigns persist and can be reopened from an "All Campaigns" drawer
- Each tab remembers scroll position, selected block, inspector state

**Data model changes:**
- `campaigns.mode TEXT DEFAULT 'direct'` — `'direct'` or `'influencer'`
- `campaigns.last_opened_at INTEGER` — for tab ordering

No other schema changes. The tab bar is a UI layer reading `GET /api/campaigns`.

### 2. Hiker Lead Source

A new lead source alongside CSV and Attio. When the user picks "Fresh from Hiker," they describe their target in natural language and AI generates search terms.

**UX flow:**
1. User clicks "Fresh from Hiker" in the Lead List block inspector
2. Text area: "Tell us what you're working on" — e.g. "fitness coaches in London who run transformation challenges"
3. Submit → AI generates 5-10 hashtags / search terms / keywords, displayed as editable chips
4. User tweaks and confirms → system calls Hiker API with those terms
5. Results flow into a new lead list, saved as `type: 'hiker'`
6. Re-fetchable on a cadence (same loop-back pattern as Attio lists)

**AI prompt:** Takes the user's description, returns structured JSON:
```json
{
  "hashtags": ["#fitnesschallenge", "#transformationcoach", "#londonpt"],
  "searchTerms": ["fitness coach London", "30 day transformation"],
  "keywords": ["HIIT", "nutrition coaching", "body composition"]
}
```

**Data model:**
- `lead_lists.type` gains `'hiker'` as a valid value
- `lead_lists.config` for hiker lists: `{ description: string, terms: string[], hikerQuery: object }`

**New module:** `src/hiker.ts` — thin wrapper around Hiker's API. Follows the same pattern as `src/attio.ts` (fetch, map to `PulledContact[]`).

### 3. Qualification Stage

A new step between sourcing leads and entering the outreach sequence. Each lead is scored by AI against a user-defined Ideal Client Profile (ICP).

**UX flow:**
1. New canvas block type: **Qualify** (sits between Lead List and first Send)
2. Qualify block inspector:
   - "Who is your ideal client?" — prompt template with `{{variables}}`
   - Example: "We work with {{niche}} creators who have at least {{min_followers}} followers and post about {{topics}}"
   - Variable inputs: user fills in values (niche = "fitness", min_followers = "10k")
   - Threshold slider: "Accept if score >= 7/10"
3. When leads flow in, each is evaluated: AI sees lead profile data + ICP prompt → returns 1-10 score + one-line reasoning
4. Below threshold → status `'disqualified'`, skipped with reason stored
5. Above threshold → continues into sequence

**Data model:**
- New node type `'qualify'` in `sequence.ts`:
  ```typescript
  interface QualifyData {
    prompt: string
    variables: Record<string, string>
    threshold: number // 1-10, default 7
  }
  ```
- `campaign_contacts.status` gains `'disqualified'` as a value
- New columns: `campaign_contacts.qualify_score INTEGER`, `campaign_contacts.qualify_reason TEXT`

**Engine change:** `engine.ts` `stepLead` adds a handler for `qualify` nodes — calls AI, scores, gates passage. Uses the same Anthropic API pattern as `ai.ts` but with a scoring-focused system prompt.

### 4. Creator Profiles (Mode 2)

A new entity holding a creator's social presence, content style, audience data, and AI-generated profile analysis.

**UX flow:**
1. Creator (or manager) logs in, navigates to "Creator Profile" section
2. Submits: Instagram handle, TikTok handle, YouTube channel URL, website URLs
3. System fetches public data (follower count, recent posts, engagement rates, content themes)
4. AI builds a profile summary: niche, content style, audience demographics, deliverable quality assessment
5. Creator reviews and edits the profile
6. Profile drives brand matching and proposal generation downstream

**Data model:**
```sql
CREATE TABLE creator_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  instagram_handle TEXT,
  tiktok_handle   TEXT,
  youtube_channel TEXT,
  website         TEXT,
  bio             TEXT,
  profile_data    TEXT, -- JSON: AI-generated analysis (niche, style, demographics, strengths)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER
);
```

A campaign with `mode: 'influencer'` links to a creator profile via `campaigns.creator_profile_id INTEGER`.

### 5. Brand Research + Matching (Mode 2)

Given a creator profile, AI researches and suggests brands that would be a good fit.

**UX flow:**
1. In an influencer-mode campaign, after creator profile is set, user clicks "Find Brands"
2. AI researches: uses creator's niche/audience to identify brand categories, then specific brands
3. Results appear as brand cards: name, why they're a fit, past campaign examples, estimated budget range
4. User selects which brands to pursue → these become the campaign's contacts
5. For each selected brand, system finds the contact person (marketing manager, partnerships lead) via Hiker/Attio/manual

**Data model:**
```sql
CREATE TABLE brand_matches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  brand_name      TEXT NOT NULL,
  brand_data      TEXT, -- JSON: research results, past campaigns, budget range
  match_score     INTEGER,
  match_reasoning TEXT,
  status          TEXT NOT NULL DEFAULT 'suggested', -- 'suggested' | 'selected' | 'rejected'
  created_at      INTEGER NOT NULL
);
```

Brand contacts flow into the existing `contacts` table with `source: 'brand_research'`.

### 6. Proposal Generation (Mode 2)

For each selected brand, AI generates a tiered pitch package.

**Proposal structure:**
- **Premium tier**: Full deliverables — e.g. 2 dedicated videos, 3 Instagram stories, 5 edited shorts, behind-the-scenes content, usage rights
- **Standard tier**: Reduced scope — e.g. 1 video, 2 stories, 2 shorts
- **Stretch goals**: Performance bonuses — e.g. "+$500 if video hits 100k views", "3% of sales via tracking code"
- Each tier has a price point suggested by AI based on creator audience size and brand's typical spend

**Data model:**
```sql
CREATE TABLE proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id         INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  brand_match_id      INTEGER REFERENCES brand_matches(id),
  creator_profile_id  INTEGER NOT NULL REFERENCES creator_profiles(id),
  tiers               TEXT NOT NULL, -- JSON array of tier objects
  stretch_goals       TEXT,          -- JSON array of stretch goal objects
  status              TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'sent' | 'viewed' | 'accepted'
  public_token        TEXT UNIQUE,   -- for the proposal page URL
  created_at          INTEGER NOT NULL
);
```

**Tier JSON shape:**
```json
{
  "name": "Premium",
  "price": 2500,
  "deliverables": [
    { "type": "video", "count": 2, "description": "Dedicated YouTube videos (5-10 min)" },
    { "type": "story", "count": 3, "description": "Instagram stories with swipe-up" },
    { "type": "short", "count": 5, "description": "Edited shorts for Reels/TikTok" }
  ]
}
```

**Stretch goal JSON shape:**
```json
{
  "trigger": "100k views on the main video",
  "bonus": 500,
  "type": "views"
}
```

### 7. Proposal Landing Page (Mode 2)

A public route `/p/:token` rendering a branded proposal page.

**UX flow:**
1. WhatsApp outreach includes link: `https://oneinfluence.com/p/abc123`
2. Brand clicks → sees proposal page:
   - Creator profile (photo, stats, content samples)
   - Tiered packages with pricing
   - Stretch goals with performance terms
   - "Accept Proposal" / "Request Changes" buttons
3. "Accept" captures brand email, onboards them, notifies creator
4. Page is white-labeled (creator's branding, not Lepton's)

**Implementation:** Server-rendered HTML (same `views.ts` pattern). Lookup by `proposals.public_token`. No auth required — the token IS the access control (unguessable random string like the API token pattern in `auth.ts`).

### 8. Workspace Modes

Tenants can operate in one or both modes.

**Data model:** `tenants.mode TEXT DEFAULT 'direct'` — values: `'direct'`, `'influencer'`, `'both'`

**UI behavior:**
- `'direct'` — dashboard shows direct outreach UI (campaigns with Hiker/Attio/CSV, qualification, sequences)
- `'influencer'` — dashboard shows influencer UI (creator profiles section, brand matching, proposals)
- `'both'` — mode switcher in nav; new campaign modal asks which mode

This is a UI toggle, not a hard permission gate. All API endpoints work regardless of mode.

## Build Order

### Phase 1 — Shared Infrastructure (extends what exists)
1. Tab manager UI (campaign hub with horizontal tabs, "+" new campaign flow)
2. `mode` and `last_opened_at` columns on campaigns table
3. Qualification block type (new canvas node + AI scoring in engine)
4. Hiker lead source (API wrapper + AI term generation + lead list type)

### Phase 2 — Influencer Platform
5. Creator profiles (table, CRUD API, profile UI, social scraping + AI analysis)
6. Brand research + matching (AI research, brand_matches table, selection UI)
7. Proposal generation (tiers + stretch goals, proposals table, generation API)
8. Proposal landing page (`/p/:token` public route, server-rendered)
9. White-label theming (creator branding on proposal pages)

### Phase 3 — Polish
10. Tab persistence (last-opened ordering, inspector state memory)
11. Proposal analytics (view tracking, acceptance rates)
12. Stretch goal tracking (view counts, coupon/conversion code integration)
13. Workspace mode switcher (for tenants using both modes)

## Files Affected

**Modified:**
- `src/db.ts` — new tables (creator_profiles, brand_matches, proposals) + new columns on campaigns and campaign_contacts
- `src/views.ts` — tab manager UI, qualify block inspector, creator profile section, proposal landing page
- `src/sequence.ts` — new `'qualify'` node type + QualifyData interface
- `src/engine.ts` — qualify node handler in stepLead
- `src/campaigns.ts` — CRUD for creator profiles, brand matches, proposals; qualify scoring
- `src/server.ts` — new routes for profiles, brands, proposals, Hiker, public proposal page
- `src/ai.ts` — new prompts for term generation, qualification scoring, brand research, proposal generation

**New:**
- `src/hiker.ts` — Hiker API wrapper (search by terms, map to PulledContact[])
- `src/proposals.ts` — proposal generation, tier/stretch-goal logic, public token management
- `src/brands.ts` — brand research + matching logic

## Open Questions

1. **Hiker API:** What are the actual endpoints and auth mechanism? Need API docs or access to implement `src/hiker.ts`.
2. **White-label domain:** Do proposals live on `oneinfluence.com` or per-creator custom domains? Custom domains add deployment complexity.
3. **Brand contact discovery:** How do we find the right person at a brand to message? Is this manual, or do we scrape LinkedIn/websites?
4. **Proposal images:** "Generate a bunch of pictures" — is this AI image generation (DALL-E/Midjourney style) or curating from the creator's existing content?
5. **Payment/pricing:** Do proposals include actual payment processing, or just display pricing for offline negotiation?
