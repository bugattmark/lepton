// MCP server for Claude Code. A thin client over the WA Connect REST API so that
// campaigns/accounts/Attio can be driven from an agent. Sockets + the send engine
// stay in the running web server — this just calls its API with your token.
//
// Run:  WA_API_URL=https://www.lepton.live WA_API_TOKEN=wa_... node src/mcp.ts
// (Get the token from the dashboard → "API token", or GET /api/token while logged in.)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.WA_API_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const TOKEN = process.env.WA_API_TOKEN ?? ''

async function api(path: string, method = 'GET', body?: unknown): Promise<string> {
  if (!TOKEN) return JSON.stringify({ ok: false, error: 'set WA_API_TOKEN' })
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return await res.text()
  } catch (e) {
    return JSON.stringify({ ok: false, error: (e as Error).message })
  }
}
const out = (text: string) => ({ content: [{ type: 'text' as const, text }] })

const server = new McpServer({ name: 'wa-connect', version: '1.0.0' })

// --- read ---
server.tool('list_accounts', 'List connected WhatsApp numbers (baileys + cloud) and their status.', {}, async () =>
  out(await api('/api/accounts')),
)
server.tool('list_campaigns', 'List campaigns with per-campaign stats (pending/sent/replied/failed).', {}, async () =>
  out(await api('/api/campaigns')),
)
server.tool('contacts_summary', 'Total and messageable contact counts plus a sample.', {}, async () =>
  out(await api('/api/contacts')),
)
server.tool('list_profiles', 'List reusable send-engine profiles and the default config.', {}, async () =>
  out(await api('/api/profiles')),
)
server.tool('settings', 'Show AI availability, Attio connection, and write-back state.', {}, async () =>
  out(await api('/api/settings')),
)

// --- campaigns ---
server.tool(
  'create_campaign',
  'Create a campaign on an account. Use list_accounts for accountId; template supports {{var}} placeholders.',
  {
    name: z.string(),
    template: z.string(),
    accountId: z.string(),
    profileId: z.number().optional(),
    aiPersonalize: z.boolean().optional(),
    aiPrompt: z.string().optional(),
    aiResearchFields: z.array(z.string()).optional(),
    followupTemplate: z.string().optional(),
    followupAfterDays: z.number().optional(),
    cloudTemplate: z.string().optional(),
    cloudLang: z.string().optional(),
  },
  async (args) => out(await api('/api/campaigns', 'POST', args)),
)
server.tool('start_campaign', 'Start (or resume) a campaign. Account must be connected.', { id: z.number() }, async ({ id }) =>
  out(await api(`/api/campaigns/${id}/start`, 'POST')),
)
server.tool('pause_campaign', 'Pause a running campaign.', { id: z.number() }, async ({ id }) =>
  out(await api(`/api/campaigns/${id}/pause`, 'POST')),
)

// --- send profiles ---
server.tool(
  'create_profile',
  'Create a reusable send-engine profile (pacing/caps/window/warm-up/reply toggles).',
  { name: z.string(), config: z.record(z.any()).optional() },
  async (args) => out(await api('/api/profiles', 'POST', args)),
)

// --- attio ---
server.tool('attio_objects', 'List Attio object types in the connected workspace.', {}, async () =>
  out(await api('/api/attio/objects')),
)
server.tool('attio_attributes', 'List attributes (fields) for an Attio object.', { object: z.string() }, async ({ object }) =>
  out(await api(`/api/attio/objects/${object}/attributes`)),
)
server.tool('attio_lists', 'List Attio lists whose parent is the given object.', { object: z.string() }, async ({ object }) =>
  out(await api(`/api/attio/objects/${object}/lists`)),
)
server.tool(
  'import_from_attio',
  'Import contacts from Attio. Map which attribute slug is the phone (required), name (optional), and which become template vars.',
  {
    object: z.string(),
    listId: z.string().optional(),
    phone: z.string(),
    name: z.string().optional(),
    vars: z.array(z.string()).optional(),
  },
  async ({ object, listId, phone, name, vars }) =>
    out(await api('/api/attio/import', 'POST', { object, listId, mapping: { phone, name, vars } })),
)

const transport = new StdioServerTransport()
await server.connect(transport)
