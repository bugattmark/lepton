// IG-lead phone sourcing. Given a small business / event-organiser lead (an Instagram
// handle and/or a website), find a WhatsApp-reachable UK phone number using OpenAI's
// `gpt-5.5` with the built-in `web_search` tool — the same thing as typing the question
// into ChatGPT, but as one API call we control.
//
// Benchmarked on 78 UK event organisers (see bench/RESULTS.md):
//   - effort=medium + forced search + venue-rejection ≈ 50%+ valid-mobile fill
//   - ~one API call/lead, no scraping stack (no HikerAPI / Apify / GMaps needed)
//   - the remaining ~45% genuinely publish no phone (email/form-only) — a true ceiling,
//     confirmed independently by a careful manual ChatGPT pass.
//
// Needs OPENAI_API_KEY. If absent, lookupPhone() returns { phone: null } and never throws —
// phone sourcing is best-effort and must never block the rest of a campaign import.

// gpt-5.4 is the cost/result sweet spot: ~$0.16 per phone found vs ~$0.20 on gpt-5.5
// (5.5 has higher recall — 44% vs 34% — set IGLEAD_MODEL=gpt-5.5 if coverage matters more
// than cost). Do NOT use a -mini tier: it skips the web_search loop and returns ~1% recall.
const MODEL = process.env.IGLEAD_MODEL ?? 'gpt-5.4'
const EFFORT = process.env.IGLEAD_EFFORT ?? 'medium' // none|low|medium|high|xhigh
const ENDPOINT = 'https://api.openai.com/v1/responses'

export const igLeadAvailable = () => !!process.env.OPENAI_API_KEY

export type Lead = {
  name?: string
  handle?: string // instagram handle, with or without leading @
  website?: string
  area?: string // city/region — disambiguates same-named orgs
}

export type PhoneResult = {
  phone: string | null // E.164, e.g. +447875106134, or null if none found
  type: 'mobile' | 'landline' | 'none'
  source: string | null // URL the number was cited from, if any
  raw: string // the model's short reply, for audit/debugging
}

// Build the lead-shaped question. Deliberately terse — mirrors what a human types into
// ChatGPT. The bare prompt (no venue-rejection clause) is the benchmark's best-recall config:
// the reject-venue/ticketing wording over-rejected legitimate landlines and cut recall
// (5.5: 44%→35%). Precision is handled afterward by normalizeUk() instead. See RESULTS.md.
function query(l: Lead): string {
  const who = (l.handle && '@' + l.handle.replace(/^@/, '')) || l.website || l.name || ''
  const ctx = [l.name && l.name, l.area && l.area].filter(Boolean).join(', ')
  return (
    `can u find phone number for these guys: ${who}${ctx ? ` (${ctx})` : ''}? ` +
    `output phone number in the format +44. mobile phone num preferred. ` +
    `if none confidently found, output none.`
  )
}

// Normalise a UK number to E.164 and classify. Returns null for junk / non-UK / placeholders.
function normalizeUk(text: string): { phone: string; type: 'mobile' | 'landline' } | null {
  const compact = text.replace(/\(0\)/g, '').replace(/[\s\-().]/g, '')
  // mobile first (we want WhatsApp-capable): 07XXXXXXXXX / +447XXXXXXXXX
  const mob = compact.match(/(?:\+?44|0)7\d{9}/)
  const land = compact.match(/(?:\+?44|0)[12389]\d{8,9}/)
  const hit = mob ?? land
  if (!hit) return null
  let d = hit[0].replace(/\D/g, '')
  if (d.startsWith('0')) d = '44' + d.slice(1)
  if (!d.startsWith('44')) return null
  const phone = '+' + d
  // placeholder / repeated-digit guard
  if (/(\d)\1{5,}/.test(d) || d.endsWith('123456789')) return null
  return /^\+447\d{9}$/.test(phone) ? { phone, type: 'mobile' } : { phone, type: 'landline' }
}

// Extract the assistant text from a Responses API payload (handles output_text shortcut
// and the structured output[] array).
function extractText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text
  let txt = ''
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') {
      for (const c of item?.content ?? []) {
        if (c?.type === 'output_text' || c?.type === 'text') txt += c.text ?? ''
      }
    }
  }
  return txt
}

/**
 * Look up a WhatsApp-reachable phone for one lead. Best-effort: never throws, returns
 * { phone: null } on missing key, API error, or genuine no-phone-published lead.
 */
export async function lookupPhone(lead: Lead, opts: { timeoutMs?: number; retries?: number } = {}): Promise<PhoneResult> {
  const empty = (raw = ''): PhoneResult => ({ phone: null, type: 'none', source: null, raw })
  const key = process.env.OPENAI_API_KEY
  if (!key) return empty()

  const body = JSON.stringify({
    model: MODEL,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required', // force ≥1 search — otherwise the model often answers "none" without looking
    reasoning: { effort: EFFORT },
    input: query(lead),
  })

  const retries = opts.retries ?? 4
  let lastErr = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 240_000)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
        if ([429, 500, 502, 503, 504].includes(res.status)) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          continue
        }
        return empty(lastErr)
      }
      const data = await res.json()
      const txt = extractText(data)
      const src = txt.match(/https?:\/\/[^\s")\]]+/)?.[0] ?? null
      const num = normalizeUk(txt)
      if (!num) return { phone: null, type: 'none', source: src, raw: txt.slice(0, 200) }
      return { phone: num.phone, type: num.type, source: src, raw: txt.slice(0, 200) }
    } catch (e) {
      clearTimeout(timer)
      lastErr = `ERR ${(e as Error).message}`
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  return empty(lastErr)
}

/**
 * Look up many leads concurrently. `concurrency` caps in-flight requests (default 12).
 * Order of results matches input order. Each lead is ~$0.02-0.04 at effort=medium.
 */
export async function lookupPhones(
  leads: Lead[],
  opts: { concurrency?: number; timeoutMs?: number; onResult?: (i: number, r: PhoneResult) => void } = {},
): Promise<PhoneResult[]> {
  const limit = Math.max(1, opts.concurrency ?? 12)
  const results = new Array<PhoneResult>(leads.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= leads.length) return
      results[i] = await lookupPhone(leads[i], { timeoutMs: opts.timeoutMs })
      opts.onResult?.(i, results[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, leads.length) }, worker))
  return results
}
