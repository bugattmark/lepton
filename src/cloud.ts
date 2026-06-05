// Official WhatsApp Business Cloud API transport (Meta Graph).
// Cold/first contact MUST be an approved template; free text only works inside the
// 24h customer-service window. Ported from the wa-connector product.

export interface CloudConfig {
  token: string // permanent System User access token
  phoneNumberId: string // the registered number's Phone Number ID
  graphVersion?: string // defaults to v23.0
}

export class CloudError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    super(`WhatsApp Cloud API error ${status}: ${JSON.stringify(body).slice(0, 300)}`)
    this.name = 'CloudError'
    this.status = status
    this.body = body
  }
}

const endpoint = (cfg: CloudConfig) =>
  `https://graph.facebook.com/${cfg.graphVersion ?? 'v23.0'}/${cfg.phoneNumberId}/messages`

async function post(cfg: CloudConfig, payload: Record<string, unknown>): Promise<string | undefined> {
  const res = await fetch(endpoint(cfg), {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new CloudError(res.status, body)
  return body?.messages?.[0]?.id
}

const e164 = (num: string) => num.replace(/[^0-9]/g, '') // Graph wants the number without '+'

export function cloudSendText(cfg: CloudConfig, to: string, body: string): Promise<string | undefined> {
  return post(cfg, { to: e164(to), type: 'text', text: { body } })
}

// Template send — variables fill the body component's {{1}}, {{2}}, … in order.
export function cloudSendTemplate(
  cfg: CloudConfig,
  to: string,
  name: string,
  languageCode = 'en_US',
  variables: string[] = [],
): Promise<string | undefined> {
  return post(cfg, {
    to: e164(to),
    type: 'template',
    template: {
      name,
      language: { code: languageCode },
      ...(variables.length
        ? { components: [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  })
}

// Validate credentials by reading the number's display name.
export async function cloudVerify(cfg: CloudConfig): Promise<{ name: string; number: string }> {
  const res = await fetch(
    `https://graph.facebook.com/${cfg.graphVersion ?? 'v23.0'}/${cfg.phoneNumberId}?fields=verified_name,display_phone_number`,
    { headers: { Authorization: `Bearer ${cfg.token}` } },
  )
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new CloudError(res.status, body)
  return { name: body?.verified_name ?? 'WhatsApp', number: body?.display_phone_number ?? '' }
}
