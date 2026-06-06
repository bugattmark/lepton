# Attio Reply-Driven Stage Write-back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a lead replies on WhatsApp, use an LLM to assess the conversation and write the predicted sale stage + rolling summary back onto the company's Sales-list entry in Attio.

**Architecture:** Hook into `handleInbound` (sessions.ts). New orchestrator `syncStageOnReply` in campaigns.ts reconstructs the transcript from the messages table, calls `assessConversation` (ai.ts) for an LLM stage prediction, resolves the Sales-list entry via JID → company fallback → upsert, and writes stage + summary with a single `PUT /v2/lists/{list}/entries`. Debounce (10 min) and change-gate (skip write when stage + summary unchanged) keep Attio traffic minimal.

**Tech Stack:** Node 23+, native `fetch`, Anthropic Messages API (Haiku 3 default), Attio REST v2, SQLite via `node:sqlite`.

**Worktree:** `../lepton-stage-writeback` on branch `attio-stage-writeback-wt`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/db.ts` | Modify (lines ~157+) | Add 5 `addColumn` calls + update `TenantRow`/`ContactRow` interfaces |
| `src/ai.ts` | Modify (append) | Add `assessConversation()` — LLM call + JSON parse, no DB/Attio knowledge |
| `src/attio.ts` | Modify (append) | Add `getPersonCompany()`, `upsertSalesEntry()`, `queryEntryByJid()` — raw REST |
| `src/campaigns.ts` | Modify (append) | Add config helpers + `syncStageOnReply()` orchestrator |
| `src/sessions.ts` | Modify (line ~152) | Add one `void import(...).then(...)` call in `handleInbound` |

No new files. Every change is an append or a small insertion into an existing module.

---

### Task 1: Schema — add columns and update type interfaces

**Files:**
- Modify: `src/db.ts:157+` (after the last `addColumn` block)
- Modify: `src/db.ts:235-253` (`TenantRow` interface)
- Modify: `src/db.ts:326-342` (`ContactRow` interface)

- [ ] **Step 1: Add the 5 new `addColumn` calls**

Append after line 157 (`addColumn('tenants', 'google_connected_at', ...)`) in `src/db.ts`:

```typescript
// --- reply-driven Attio stage write-back ---
addColumn('tenants', 'attio_stage_sync', 'INTEGER') // 1 = reply-triggered stage assessment on
addColumn('tenants', 'attio_sync_config', 'TEXT') // JSON SyncConfig (salesListId, stageOptions, etc.)
addColumn('tenants', 'business_description', 'TEXT') // one-liner about their business (LLM prompt context)
addColumn('contacts', 'attio_synced_at', 'INTEGER') // last successful assessment (debounce)
addColumn('contacts', 'attio_synced_stage', 'TEXT') // last stage written to Attio
addColumn('contacts', 'attio_summary_hash', 'TEXT') // hash of last summary written
```

- [ ] **Step 2: Update the `TenantRow` interface**

Add three optional fields at the end of the `TenantRow` interface (after `google_connected_at`):

```typescript
  attio_stage_sync?: number | null
  attio_sync_config?: string | null
  business_description?: string | null
```

- [ ] **Step 3: Update the `ContactRow` interface**

Add three optional fields at the end of the `ContactRow` interface (after `wa_checked_at`):

```typescript
  attio_synced_at?: number | null
  attio_synced_stage?: string | null
  attio_summary_hash?: string | null
```

- [ ] **Step 4: Verify the app still starts**

Run: `cd ../lepton-stage-writeback && node --env-file=.env src/server.ts &`
Expected: server starts without errors. Kill it after confirming (`kill %1`).

- [ ] **Step 5: Commit**

```bash
cd ../lepton-stage-writeback
git add src/db.ts
git commit -m "schema: add columns for reply-driven Attio stage write-back"
```

---

### Task 2: AI — add `assessConversation` to ai.ts

**Files:**
- Modify: `src/ai.ts` (append after `personalizeOpener`)

- [ ] **Step 1: Add the `assessConversation` function**

Append to the end of `src/ai.ts`:

```typescript
export interface AssessInput {
  transcript: string // "Us: ...\nThem: ..." formatted conversation
  contactName: string | null
  stageOptions: string[] // exact titles the model must pick from
  businessDescription?: string | null // tenant's one-liner about their business
}

export interface AssessResult {
  stage: string // one of stageOptions
  summary: string // rolling conversation summary
}

export async function assessConversation(input: AssessInput): Promise<AssessResult | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  const stageList = input.stageOptions.map((s, i) => `${i + 1}. ${s}`).join('\n')
  const bizCtx = input.businessDescription
    ? `The sender's business: ${input.businessDescription}`
    : 'This is B2B WhatsApp outbound sales outreach.'

  const prompt =
    `You are a sales analyst assessing a WhatsApp conversation between a business ("Us") and a lead ("Them").\n` +
    `${bizCtx}\n\n` +
    `CONVERSATION:\n${input.transcript}\n\n` +
    (input.contactName ? `Contact name: ${input.contactName}\n\n` : '') +
    `PIPELINE STAGES (pick exactly one):\n${stageList}\n\n` +
    `Return a JSON object with two fields:\n` +
    `- "stage": the exact stage title from the list above that best describes where this deal stands right now\n` +
    `- "summary": a concise 1-3 sentence summary of the conversation state and what happened\n\n` +
    `Return ONLY valid JSON, no markdown fences, no extra text.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return null
    const j: any = await res.json()
    const text = j?.content?.[0]?.text
    if (typeof text !== 'string') return null
    const parsed = JSON.parse(text.replace(/^```json\s*|```\s*$/g, '').trim())
    if (typeof parsed?.stage !== 'string' || typeof parsed?.summary !== 'string') return null
    if (!input.stageOptions.includes(parsed.stage)) return null
    return { stage: parsed.stage, summary: parsed.summary }
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Verify the module parses**

Run: `cd ../lepton-stage-writeback && node -e "import('./src/ai.ts').then(m => console.log('assessConversation' in m ? 'OK' : 'MISSING'))"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd ../lepton-stage-writeback
git add src/ai.ts
git commit -m "feat(ai): add assessConversation for reply-driven stage prediction"
```

---

### Task 3: Attio — add list-entry helpers to attio.ts

**Files:**
- Modify: `src/attio.ts` (append after `writeDateAttr`)

These are thin REST wrappers. They know nothing about contacts, the DB, or the LLM.

- [ ] **Step 1: Add `queryEntryByJid`**

Append to `src/attio.ts`:

```typescript
// Query a Sales-list entry by its whatsapp_jid attribute. Returns the first match's entry_id, or null.
export async function queryEntryByJid(
  apiKey: string,
  listId: string,
  jid: string,
): Promise<{ entryId: string; parentRecordId: string } | null> {
  const j = await attio(apiKey, `/lists/${listId}/entries/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { whatsapp_jid: jid }, limit: 1 }),
  })
  const entry = j?.data?.[0]
  if (!entry) return null
  const entryId = entry?.id?.entry_id ?? entry?.id
  const parentRecordId = entry?.parent_record_id
  return entryId ? { entryId, parentRecordId } : null
}
```

- [ ] **Step 2: Add `getPersonCompany`**

```typescript
// Read a People record's company reference. Returns the first linked company record id, or null.
export async function getPersonCompany(apiKey: string, personRecordId: string): Promise<string | null> {
  const j = await attio(apiKey, `/objects/people/records/${personRecordId}`)
  const companyVals = j?.data?.values?.company
  if (!Array.isArray(companyVals) || !companyVals.length) return null
  return companyVals[0]?.target_record_id ?? null
}
```

- [ ] **Step 3: Add `upsertSalesEntry`**

```typescript
// Upsert a Sales-list entry (create if missing, update if exists) with stage + notes + jid.
// Uses PUT /v2/lists/{list}/entries which is Attio's native upsert-by-parent.
export async function upsertSalesEntry(
  apiKey: string,
  listId: string,
  companyRecordId: string,
  values: { stage?: string; notes?: string; whatsapp_jid?: string },
): Promise<string> {
  const entry_values: Record<string, string> = {}
  if (values.stage) entry_values.stage = values.stage
  if (values.notes) entry_values.notes = values.notes
  if (values.whatsapp_jid) entry_values.whatsapp_jid = values.whatsapp_jid
  const j = await attio(apiKey, `/lists/${listId}/entries`, {
    method: 'PUT',
    body: JSON.stringify({
      data: {
        parent_record_id: companyRecordId,
        parent_object: 'companies',
        entry_values,
      },
    }),
  })
  return j?.data?.id?.entry_id ?? ''
}
```

- [ ] **Step 4: Verify the module parses**

Run: `cd ../lepton-stage-writeback && node -e "import('./src/attio.ts').then(m => console.log(['queryEntryByJid','getPersonCompany','upsertSalesEntry'].every(k => k in m) ? 'OK' : 'MISSING'))"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd ../lepton-stage-writeback
git add src/attio.ts
git commit -m "feat(attio): add list-entry upsert, JID query, person→company helpers"
```

---

### Task 4: Campaigns — config helpers + `syncStageOnReply` orchestrator

**Files:**
- Modify: `src/campaigns.ts` (append after the existing writeback helpers, around line 44+)

This is the largest task — the orchestrator that ties everything together.

- [ ] **Step 1: Add the `SyncConfig` interface and config helpers**

Append after the `writebackNote` function (around line 44 in campaigns.ts):

```typescript
// --- reply-driven Attio stage sync config ---
export interface SyncConfig {
  salesListId: string // UUID of the Sales list
  stageAttr: string // entry attribute slug for stage (default "stage")
  summaryAttr: string // entry attribute slug for summary (default "notes")
  jidAttr: string // entry attribute slug for WhatsApp JID (default "whatsapp_jid")
  stageOptions: string[] // allowed stage titles (must match Attio status options exactly)
  debounceMinutes?: number // skip re-assessment within this window (default 10)
}

export function saveSyncConfig(tenantId: string, config: SyncConfig): void {
  db.prepare('UPDATE tenants SET attio_stage_sync = 1, attio_sync_config = ? WHERE id = ?').run(
    JSON.stringify(config),
    tenantId,
  )
}

export function getSyncConfig(tenantId: string): SyncConfig | null {
  const row = db.prepare('SELECT attio_stage_sync, attio_sync_config FROM tenants WHERE id = ?').get(tenantId) as {
    attio_stage_sync: number | null
    attio_sync_config: string | null
  } | undefined
  if (!row || row.attio_stage_sync !== 1 || !row.attio_sync_config) return null
  try {
    return JSON.parse(row.attio_sync_config) as SyncConfig
  } catch {
    return null
  }
}

export function getBusinessDescription(tenantId: string): string | null {
  const row = db.prepare('SELECT business_description FROM tenants WHERE id = ?').get(tenantId) as {
    business_description: string | null
  } | undefined
  return row?.business_description ?? null
}

export function saveBusinessDescription(tenantId: string, desc: string): void {
  db.prepare('UPDATE tenants SET business_description = ? WHERE id = ?').run(desc, tenantId)
}
```

- [ ] **Step 2: Add the `syncStageOnReply` orchestrator**

Append immediately after the config helpers:

```typescript
// --- the orchestrator: called from handleInbound on every reply ---
import { createHash } from 'node:crypto'

const summaryHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export async function syncStageOnReply(tenantId: string, contactId: number): Promise<void> {
  // Guard 1: feature enabled + config exists
  const cfg = getSyncConfig(tenantId)
  if (!cfg) return

  // Guard 2: Attio key
  const apiKey = getAttioKey(tenantId)
  if (!apiKey) return

  // Guard 3: contact has an attio_record_id + check debounce
  const contact = db
    .prepare('SELECT phone, name, attio_record_id, attio_object, attio_synced_at, attio_synced_stage, attio_summary_hash FROM contacts WHERE id = ? AND tenant_id = ?')
    .get(contactId, tenantId) as {
      phone: string; name: string | null; attio_record_id: string | null; attio_object: string | null;
      attio_synced_at: number | null; attio_synced_stage: string | null; attio_summary_hash: string | null;
    } | undefined
  if (!contact) return

  // Guard 4: debounce
  const debounceMs = (cfg.debounceMinutes ?? 10) * 60_000
  if (contact.attio_synced_at && Date.now() - contact.attio_synced_at < debounceMs) return

  // Build transcript
  const jid = contact.phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
  const msgs = db
    .prepare('SELECT direction, body FROM messages WHERE tenant_id = ? AND jid = ? ORDER BY created_at ASC')
    .all(tenantId, jid) as { direction: string; body: string | null }[]
  if (!msgs.length) return
  const transcript = msgs
    .filter((m) => m.body)
    .map((m) => `${m.direction === 'out' ? 'Us' : 'Them'}: ${m.body}`)
    .join('\n')
  if (!transcript) return

  // Assess
  const ai = await import('./ai.ts')
  const bizDesc = getBusinessDescription(tenantId)
  const result = await ai.assessConversation({
    transcript,
    contactName: contact.name,
    stageOptions: cfg.stageOptions,
    businessDescription: bizDesc,
  })
  if (!result) return // LLM failure — don't update synced_at so next reply retries

  // Update synced_at (assessment succeeded, regardless of whether we write to Attio)
  db.prepare('UPDATE contacts SET attio_synced_at = ? WHERE id = ?').run(Date.now(), contactId)

  // Change gate: skip Attio write if nothing changed
  const newHash = summaryHash(result.summary)
  if (result.stage === contact.attio_synced_stage && newHash === contact.attio_summary_hash) return

  // Resolve the Sales-list entry
  const attio = await import('./attio.ts')

  // Path 1: JID match
  let companyId: string | null = null
  const byJid = await attio.queryEntryByJid(apiKey, cfg.salesListId, jid).catch(() => null)
  if (byJid) {
    companyId = byJid.parentRecordId
  }

  // Path 2: person → company
  if (!companyId && contact.attio_record_id) {
    companyId = await attio.getPersonCompany(apiKey, contact.attio_record_id).catch(() => null)
  }

  // No company resolvable — can't write
  if (!companyId) return

  // Upsert (creates entry if missing, updates if exists)
  await attio.upsertSalesEntry(apiKey, cfg.salesListId, companyId, {
    stage: result.stage,
    notes: result.summary,
    whatsapp_jid: jid,
  })

  // Persist sync state
  db.prepare('UPDATE contacts SET attio_synced_stage = ?, attio_summary_hash = ? WHERE id = ?').run(
    result.stage,
    newHash,
    contactId,
  )
}
```

- [ ] **Step 3: Add the `createHash` import at the top of campaigns.ts**

Add this import at the top of `src/campaigns.ts`, after the existing `import { getPolicy } from './policy.ts'` line:

```typescript
import { createHash } from 'node:crypto'
```

The `const summaryHash = ...` line and `syncStageOnReply` function from step 2 both rely on this top-level import.

- [ ] **Step 4: Verify the module parses**

Run: `cd ../lepton-stage-writeback && node -e "import('./src/campaigns.ts').then(m => console.log(['syncStageOnReply','saveSyncConfig','getSyncConfig','saveBusinessDescription'].every(k => k in m) ? 'OK' : 'MISSING'))"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd ../lepton-stage-writeback
git add src/campaigns.ts
git commit -m "feat(campaigns): add syncStageOnReply orchestrator + config helpers"
```

---

### Task 5: Hook — wire `syncStageOnReply` into `handleInbound`

**Files:**
- Modify: `src/sessions.ts:152` (after the existing `writebackNote` call)

- [ ] **Step 1: Add the hook**

In `src/sessions.ts`, after line 152 (the closing `.catch(() => {})` of the `writebackNote` call), add:

```typescript
  // best-effort Attio stage assessment (reply-driven)
  void import('./campaigns.ts')
    .then((m) => m.syncStageOnReply(tenantId, contact.id))
    .catch(() => {})
```

The full end of `handleInbound` should now read:

```typescript
  // best-effort Attio write-back
  void import('./campaigns.ts')
    .then((m) => m.writebackNote(tenantId, contact.id, body && OPT_OUT.test(body) ? 'Opted out (STOP) on WhatsApp' : 'Replied on WhatsApp'))
    .catch(() => {})

  // best-effort Attio stage assessment (reply-driven)
  void import('./campaigns.ts')
    .then((m) => m.syncStageOnReply(tenantId, contact.id))
    .catch(() => {})
}
```

- [ ] **Step 2: Verify the app starts**

Run: `cd ../lepton-stage-writeback && timeout 5 node --env-file=.env src/server.ts 2>&1 || true`
Expected: server starts, no import errors.

- [ ] **Step 3: Commit**

```bash
cd ../lepton-stage-writeback
git add src/sessions.ts
git commit -m "feat(sessions): hook syncStageOnReply into handleInbound"
```

---

### Task 6: Smoke test — verify the Attio payload format against the live workspace

**Files:**
- Create: `scripts/attio-entry-probe.ts`

This is a read-only probe that validates our assumptions about the Attio API entry format before any real writes happen.

- [ ] **Step 1: Write the probe script**

Create `scripts/attio-entry-probe.ts`:

```typescript
// Read-only probe: verify the payload format for the Sales-list entry upsert.
// Tests queryEntryByJid + getPersonCompany + a dry-run of the upsert shape.
//
//   node --env-file=.env scripts/attio-entry-probe.ts
//
// Does NOT write to Attio — it only reads entries and records.

import { queryEntryByJid, getPersonCompany } from '../src/attio.ts'

const key = process.env.ATTIO_API_KEY
if (!key) { console.error('✗ ATTIO_API_KEY not set.'); process.exit(1) }

const SALES_LIST = 'b4f74368-a14a-4f89-a33f-91958c23529f'

async function main() {
  // 1. Query an entry by JID (expect none for a fake number)
  console.log('→ queryEntryByJid (fake number)')
  const fake = await queryEntryByJid(key!, SALES_LIST, '0000000000@s.whatsapp.net')
  console.log(`  result: ${fake ? JSON.stringify(fake) : 'null (expected)'}`)

  // 2. Try reading a real person's company
  // Grab the first person record that has an attio_record_id in our DB (if the DB exists)
  console.log('\n→ getPersonCompany (first person with a company)')
  try {
    // Use the Attio API directly to find a person with a company
    const res = await fetch('https://api.attio.com/v2/objects/people/records/query', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })
    const j = await res.json() as any
    for (const r of j?.data ?? []) {
      const rid = r?.id?.record_id
      if (!rid) continue
      const companyId = await getPersonCompany(key!, rid)
      const name = r?.values?.name?.[0]?.full_name ?? '(unnamed)'
      console.log(`  person ${name} [${rid}] → company: ${companyId ?? 'null'}`)
      if (companyId) break // found one, that's enough
    }
  } catch (e: any) {
    console.log(`  error: ${e.message}`)
  }

  // 3. Query the first Sales entry to show its shape
  console.log('\n→ first Sales entry (shape check)')
  const res = await fetch(`https://api.attio.com/v2/lists/${SALES_LIST}/entries/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 1 }),
  })
  const ej = await res.json() as any
  const entry = ej?.data?.[0]
  if (entry) {
    console.log(`  entry_id: ${entry?.id?.entry_id}`)
    console.log(`  parent_record_id: ${entry?.parent_record_id}`)
    console.log(`  stage: ${entry?.entry_values?.stage?.[0]?.status?.title ?? '(none)'}`)
    console.log(`  notes: ${(entry?.entry_values?.notes?.[0]?.value ?? '(empty)').slice(0, 80)}`)
    console.log(`  whatsapp_jid: ${entry?.entry_values?.whatsapp_jid?.[0]?.value ?? '(empty)'}`)
  } else {
    console.log('  (no entries found)')
  }

  console.log('\n✓ probe complete (read-only, nothing written)')
}

main().catch((e) => { console.error('✗ FAILED:', e.message); process.exit(1) })
```

- [ ] **Step 2: Run the probe**

Run: `cd ../lepton-stage-writeback && node --env-file=.env scripts/attio-entry-probe.ts`
Expected: prints entry shape, person→company resolution, and JID query result. No errors.

- [ ] **Step 3: Commit**

```bash
cd ../lepton-stage-writeback
git add scripts/attio-entry-probe.ts
git commit -m "test: add attio entry probe script for payload verification"
```

---

### Task 7: Integration test — enable for a tenant and verify end-to-end

This task enables the feature for the dev tenant and simulates the flow.

**Files:**
- Create: `scripts/attio-enable-sync.ts`

- [ ] **Step 1: Write the enablement script**

Create `scripts/attio-enable-sync.ts`:

```typescript
// Enable reply-driven stage sync for a tenant. Run once to set the config.
//
//   node --env-file=.env scripts/attio-enable-sync.ts [tenantId]
//
// If no tenantId is given, uses the first tenant in the DB.

import { db } from '../src/db.ts'
import { saveSyncConfig, saveBusinessDescription } from '../src/campaigns.ts'

const SALES_LIST = 'b4f74368-a14a-4f89-a33f-91958c23529f'
const STAGE_OPTIONS = [
  'Prospecting', 'Needs Contact', 'Qualified', 'Disqualify',
  'Outbounded', 'Replied', 'Meeting', 'Demo sent',
  'In negotiation', 'Paused', 'Onboarded', 'Won', 'Lost', 'Churned', 'No reply',
]

const tenantId = process.argv[2] ||
  (db.prepare('SELECT id FROM tenants LIMIT 1').get() as { id: string } | undefined)?.id

if (!tenantId) { console.error('✗ no tenant found'); process.exit(1) }

saveSyncConfig(tenantId, {
  salesListId: SALES_LIST,
  stageAttr: 'stage',
  summaryAttr: 'notes',
  jidAttr: 'whatsapp_jid',
  stageOptions: STAGE_OPTIONS,
  debounceMinutes: 10,
})

// Set a business description if not already set
const existing = db.prepare('SELECT business_description FROM tenants WHERE id = ?').get(tenantId) as { business_description: string | null } | undefined
if (!existing?.business_description) {
  saveBusinessDescription(tenantId, 'Events and ticketing platform selling to organisers, venues, and promoters via WhatsApp.')
}

console.log(`✓ stage sync enabled for tenant ${tenantId}`)
console.log(`  salesListId: ${SALES_LIST}`)
console.log(`  stageOptions: ${STAGE_OPTIONS.length} stages`)
console.log(`  debounce: 10 min`)
```

- [ ] **Step 2: Run the enablement script**

Run: `cd ../lepton-stage-writeback && node --env-file=.env scripts/attio-enable-sync.ts`
Expected: prints confirmation with tenant id.

- [ ] **Step 3: Manual verification**

Start the server, then send a test inbound message (or have a real reply come in). Verify:
1. The `contacts` row gets `attio_synced_at`, `attio_synced_stage`, `attio_summary_hash` populated.
2. The Sales-list entry in Attio gets its `stage` and `notes` updated (check via the Attio UI or the probe script).

Run: `cd ../lepton-stage-writeback && node --env-file=.env src/server.ts`
Then trigger a reply via WhatsApp. After ~2 seconds, check:
```bash
sqlite3 data/app.db "SELECT attio_synced_at, attio_synced_stage, attio_summary_hash FROM contacts WHERE attio_synced_at IS NOT NULL LIMIT 5"
```

- [ ] **Step 4: Commit**

```bash
cd ../lepton-stage-writeback
git add scripts/attio-enable-sync.ts
git commit -m "test: add enablement script for reply-driven stage sync"
```

---

## Summary of commits

1. `schema: add columns for reply-driven Attio stage write-back` — db.ts
2. `feat(ai): add assessConversation for reply-driven stage prediction` — ai.ts
3. `feat(attio): add list-entry upsert, JID query, person→company helpers` — attio.ts
4. `feat(campaigns): add syncStageOnReply orchestrator + config helpers` — campaigns.ts
5. `feat(sessions): hook syncStageOnReply into handleInbound` — sessions.ts
6. `test: add attio entry probe script for payload verification` — scripts/
7. `test: add enablement script for reply-driven stage sync` — scripts/
