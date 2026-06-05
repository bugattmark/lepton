// AI-personalized openers. Given the campaign's template, the user's own steering
// prompt, the contact's Attio fields, and (optionally) text fetched from websites
// referenced in those fields, Claude writes ONE tailored WhatsApp opener.
//
// Needs ANTHROPIC_API_KEY. If absent, callers fall back to the plain rendered template —
// personalization is best-effort and never blocks a send.

// Dirt-cheap by default (Haiku 3 ≈ $0.25/$1.25 per Mtok) — fine for a 1-2 sentence opener.
// Override with AI_MODEL for higher quality (e.g. claude-3-5-haiku-latest, claude-haiku-4-5).
const MODEL = process.env.AI_MODEL ?? 'claude-3-haiku-20240307'

export const aiAvailable = () => !!process.env.ANTHROPIC_API_KEY

const looksLikeUrl = (s: string) => /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(s.trim())
const toUrl = (s: string) => (/^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^\/+/, ''))

// Fetch a page and crudely strip it to text (no deps). Capped so prompts stay small.
export async function fetchPageText(url: string, maxChars = 2500): Promise<string> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(toUrl(url), { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 WAConnect' } })
    clearTimeout(t)
    if (!res.ok) return ''
    const html = await res.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, maxChars)
  } catch {
    return ''
  }
}

// Gather research text from the contact's URL-bearing fields. If researchFields is given,
// only those var slugs are used; otherwise any var that looks like a URL is tried (max 2).
export async function gatherResearch(
  vars: Record<string, string>,
  researchFields?: string[],
): Promise<string> {
  let urls: string[] = []
  if (researchFields && researchFields.length) {
    urls = researchFields.map((f) => vars[f]).filter((v): v is string => !!v && looksLikeUrl(v))
  } else {
    urls = Object.values(vars).filter((v) => looksLikeUrl(v))
  }
  urls = urls.slice(0, 2)
  if (!urls.length) return ''
  const pages = await Promise.all(urls.map((u) => fetchPageText(u)))
  return pages
    .map((p, i) => (p ? `Source ${urls[i]}:\n${p}` : ''))
    .filter(Boolean)
    .join('\n\n')
}

export interface PersonalizeInput {
  template: string
  customPrompt?: string | null // the user's steering instruction
  name: string | null
  vars: Record<string, string>
  research?: string // pre-fetched website text
}

export async function personalizeOpener(input: PersonalizeInput): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  const details = Object.entries({ name: input.name ?? '', ...input.vars })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const prompt =
    `You write ONE short, warm, natural WhatsApp opener for outreach.\n` +
    `Tailor it to the contact using their details and any research below. Keep the template's intent and any opt-out line.\n` +
    `Rules: 1-2 sentences, no "Dear"/formal greeting, no emojis unless the template has them, sound human, leave NO placeholders.\n` +
    (input.customPrompt ? `\nADDITIONAL INSTRUCTION FROM THE SENDER:\n${input.customPrompt}\n` : '') +
    `\nTEMPLATE:\n${input.template}\n\nCONTACT:\n${details || '(no extra details)'}` +
    (input.research ? `\n\nRESEARCH (from the contact's links):\n${input.research.slice(0, 4000)}` : '') +
    `\n\nReturn ONLY the message text.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 320, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return null
    const j: any = await res.json()
    const text = j?.content?.[0]?.text
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}
