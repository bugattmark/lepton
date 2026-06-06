// "Bento writes it" — generates a reusable creator → brand pitch TEMPLATE with GPT-5.4-mini,
// using src/pitch/CLAUDE.md (the authoritative pitch-voice spec) as the system prompt.
//
// Output is a reusable email template: brand-specific bits are left as {{...}} placeholders
// the send engine fills per lead ({{first_name}}, {{last_name}}, {{brand_name}}).
//
// Needs OPENAI_API_KEY. If absent, generate() returns null and the caller falls back to a
// blank template (the user can still write their own).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const GUIDE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pitch', 'CLAUDE.md'), 'utf8')

// gpt-5.4-mini: cheap + fast, plenty for a short templated pitch. Override with PITCH_MODEL.
const MODEL = process.env.PITCH_MODEL ?? 'gpt-5.4-mini'
const ENDPOINT = 'https://api.openai.com/v1/responses'

export const pitchGenAvailable = () => !!process.env.OPENAI_API_KEY

export interface PitchInput {
  // creator (from the onboarding profile)
  name?: string
  roles?: string[] // "who are you" — niche/role
  pitchTo?: string // who they want to pitch to
  brandCategories?: string[]
  // "tell us about yourself"
  aboutText?: string // free text, OR
  portfolioText?: string // text fetched from their portfolio URL
  portfolioUrl?: string
  // "show your best work"
  workKind?: string // e.g. "Top performing post", "Social media page"
  workUrl?: string
  workText?: string // text fetched from the best-work URL
}

export interface PitchOutput {
  subject: string
  body: string
}

// The placeholders the send engine can fill per lead. The model is told to use these
// instead of inventing a brand name or recipient name.
const PLACEHOLDERS = '{{first_name}}, {{last_name}}, {{brand_name}}'

function buildContext(input: PitchInput): string {
  const lines: string[] = []
  if (input.name) lines.push(`Creator name: ${input.name}`)
  if (input.roles?.length) lines.push(`Who they are: ${input.roles.join(', ')}`)
  if (input.pitchTo) lines.push(`Who they want to pitch to: ${input.pitchTo}`)
  if (input.brandCategories?.length) lines.push(`Brand categories of interest: ${input.brandCategories.join(', ')}`)
  if (input.aboutText) lines.push(`About the creator (their own words):\n${input.aboutText.slice(0, 1500)}`)
  if (input.portfolioUrl) lines.push(`Portfolio: ${input.portfolioUrl}`)
  if (input.portfolioText) lines.push(`Portfolio page content:\n${input.portfolioText.slice(0, 2500)}`)
  if (input.workKind) lines.push(`Best work they want to highlight: ${input.workKind}${input.workUrl ? ` (${input.workUrl})` : ''}`)
  if (input.workText) lines.push(`Best-work page content:\n${input.workText.slice(0, 2000)}`)
  return lines.join('\n') || '(no extra details provided)'
}

const TASK =
  `You are writing a REUSABLE cold EMAIL pitch TEMPLATE for the creator below to send to brands.\n` +
  `Because it's a template reused across many brands, DO NOT name a specific brand or recipient — ` +
  `instead use these placeholders exactly where a brand-specific or recipient-specific value belongs:\n` +
  `  ${PLACEHOLDERS}\n` +
  `Use {{first_name}} (and optionally {{last_name}}) to address the recipient, and {{brand_name}} ` +
  `wherever the brand's name would go. Use double curly braces exactly as shown. Do NOT invent any ` +
  `other placeholder syntax, and never leave a real name hardcoded.\n\n` +
  `Follow the pitch guide's structure, length (cold email = 90–150 words), and hard rules. ` +
  `Never invent stats, results, or past clients that aren't in the creator's details — if a proof ` +
  `point is missing, lean on audience fit and the idea instead.\n\n` +
  `Return ONLY a JSON object: {"subject": "...", "body": "..."}. The subject follows the guide's ` +
  `"[Creator] x {{brand_name}} — [idea]" shape. The body is the full email with real line breaks (\\n).`

export async function generate(input: PitchInput): Promise<PitchOutput | null> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null

  const body = JSON.stringify({
    model: MODEL,
    instructions: `${GUIDE}\n\n---\n\n${TASK}`,
    input: `CREATOR DETAILS:\n${buildContext(input)}`,
    reasoning: { effort: 'low' },
    text: {
      format: {
        type: 'json_schema',
        name: 'pitch_template',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['subject', 'body'],
        },
      },
    },
  })

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    const text = extractText(data)
    if (!text) return null
    const parsed = JSON.parse(text) as PitchOutput
    if (!parsed?.subject || !parsed?.body) return null
    return { subject: String(parsed.subject).trim(), body: String(parsed.body).trim() }
  } catch {
    return null
  }
}

// Pull the assistant's text out of a /v1/responses payload (output_text or nested content).
function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
  const out = data?.output
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string' && c.text.trim()) return c.text
        }
      }
    }
  }
  return ''
}
