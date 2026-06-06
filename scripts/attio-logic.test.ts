// Pure-logic tests for the auto-mapper + helpers. Run: node --test scripts/attio-logic.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestMapping, whatsappDateSlug, channelSelectSlug, type AttioAttr } from '../src/attio.ts'

const A = (api_slug: string, type: string, title = api_slug): AttioAttr => ({ api_slug, title, type })

const peopleAttrs: AttioAttr[] = [
  A('name', 'personal-name', 'Name'),
  A('phone_numbers', 'phone-number', 'Phone numbers'),
  A('email_addresses', 'email-address', 'Email addresses'),
  A('instagram', 'text', 'Instagram'),
  A('urls', 'text', 'urls'),
  A('job_title', 'text', 'Job title'),
  A('last_whatsapp_contact', 'date', 'Last WhatsApp Contact'),
  A('primary_channel', 'select', 'Primary channel'),
]

test('suggestMapping picks phone + name by type', () => {
  const m = suggestMapping(peopleAttrs)
  assert.equal(m.phone, 'phone_numbers')
  assert.equal(m.name, 'name')
  assert.equal(m.email, 'email_addresses')
})

test('suggestMapping finds instagram + link by keyword', () => {
  const m = suggestMapping(peopleAttrs)
  assert.equal(m.instagram, 'instagram')
  assert.equal(m.link, 'urls')
  assert.ok(m.vars?.includes('email_addresses'))
})

test('suggestMapping skips fields with zero coverage', () => {
  const m = suggestMapping(peopleAttrs, { instagram: 0, urls: 0, email_addresses: 0.9 })
  assert.equal(m.instagram, undefined, 'empty instagram dropped')
  assert.equal(m.link, undefined, 'empty urls dropped')
  assert.equal(m.email, 'email_addresses', 'covered email kept')
})

test('suggestMapping falls back to keyword phone when no phone-number type', () => {
  const m = suggestMapping([A('mobile_no', 'text', 'Mobile')])
  assert.equal(m.phone, 'mobile_no')
})

test('link detection ignores avatar_url and linkedin (token, not substring)', () => {
  const attrs = [
    A('phone_numbers', 'phone-number'),
    A('avatar_url', 'text', 'Avatar URL'),
    A('linkedin', 'text', 'LinkedIn'),
    A('urls', 'text', 'urls'),
  ]
  const m = suggestMapping(attrs)
  assert.equal(m.link, 'urls', 'should pick urls, not avatar_url or linkedin')
})

test('instagram detection is token-based (not matched inside other words)', () => {
  const m = suggestMapping([A('phone_numbers', 'phone-number'), A('instagram', 'text', 'Instagram')])
  assert.equal(m.instagram, 'instagram')
})

test('whatsappDateSlug + channelSelectSlug detect the right attrs', () => {
  assert.equal(whatsappDateSlug(peopleAttrs), 'last_whatsapp_contact')
  assert.equal(channelSelectSlug(peopleAttrs), 'primary_channel')
})
