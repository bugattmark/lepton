# Drive WA Connect from Claude Code (MCP)

The MCP server (`src/mcp.ts`) is a thin client over the app's REST API. It lets an agent
list/create/start campaigns, manage numbers, and import from Attio. The actual sending
(WhatsApp sockets + the send engine) stays in the running web app — the MCP server just
calls its API with your token.

## 1. Get your API token
Log into the dashboard → **API token → Show token** (or `GET /api/token` while logged in).
It looks like `wa_…`. Keep it secret.

## 2. Register the server with Claude Code
Add to your project's `.mcp.json` (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "wa-connect": {
      "command": "node",
      "args": ["/Users/bugatt/Downloads/wa-saas/src/mcp.ts"],
      "env": {
        "WA_API_URL": "https://www.lepton.live",
        "WA_API_TOKEN": "wa_your_token_here"
      }
    }
  }
}
```

Use `http://localhost:8080` for `WA_API_URL` when running the app locally.

## 3. Tools exposed
- `list_accounts`, `list_campaigns`, `contacts_summary`, `list_profiles`, `settings`
- `create_campaign`, `start_campaign`, `pause_campaign`
- `create_profile`
- `attio_objects`, `attio_attributes`, `attio_lists`, `import_from_attio`

Example asks:
- "List my WhatsApp numbers and any running campaigns."
- "Import people from the Attio list X mapping phone_numbers → phone, name → name."
- "Create a campaign on account <id> with this template and start it."
