// Unit tests: one-time email codes and Stripe webhook signatures (no network).
// Run: node tests/codes.test.mjs
import assert from 'node:assert/strict'
import { cleanCode, hashCode, newCode, sameHash } from '../supabase/functions/_shared/codes.ts'
import { signStripePayload, verifyStripeSignature } from '../supabase/functions/_shared/stripe-signature.ts'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
  }
}
console.log('Email codes and payment signatures')

await test('codes are 6 digits, vary, and cover the whole range', () => {
  const codes = Array.from({ length: 2000 }, newCode)
  assert.ok(codes.every((c) => /^\d{6}$/.test(c)))
  assert.ok(new Set(codes).size > 1990, 'practically no repeats')
  assert.ok(codes.some((c) => c.startsWith('0')), 'leading zeros are kept')
  const firstDigits = new Set(codes.map((c) => c[0]))
  assert.equal(firstDigits.size, 10)
})

await test('only salted hashes are compared; the same code hashes differently per request', async () => {
  const a = await hashCode('req-1', '123456')
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, await hashCode('req-1', '123456'))
  assert.notEqual(a, await hashCode('req-2', '123456'))
  assert.ok(sameHash(a, await hashCode('req-1', '123456')))
  assert.ok(!sameHash(a, await hashCode('req-1', '123457')))
  assert.ok(!sameHash(a, a.slice(1)))
})

await test('typed codes are cleaned; anything else is refused', () => {
  assert.equal(cleanCode('123456'), '123456')
  assert.equal(cleanCode(' 123 456 '), '123456')
  assert.equal(cleanCode('123-456'), '123456')
  for (const bad of ['12345', '1234567', 'abcdef', '', null, 123456, '12 34 5x']) assert.equal(cleanCode(bad), null, String(bad))
})

await test('Stripe signatures: valid accepted; tampered, wrong-secret, stale and malformed refused', async () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' })
  const secret = 'whsec_test_123'
  const now = 1_800_000_000
  const header = await signStripePayload(body, secret, now)
  assert.ok(await verifyStripeSignature(body, header, secret, now))
  assert.ok(await verifyStripeSignature(body, `${header},v1=deadbeef`, secret, now), 'any matching v1 (secret rotation)')
  assert.ok(!(await verifyStripeSignature(body.replace('evt_1', 'evt_2'), header, secret, now)), 'tampered body')
  assert.ok(!(await verifyStripeSignature(body, header, 'whsec_other', now)), 'wrong secret')
  assert.ok(!(await verifyStripeSignature(body, header, secret, now + 301)), 'older than 5 minutes (replay)')
  assert.ok(!(await verifyStripeSignature(body, header, '', now)), 'no secret configured')
  for (const h of ['', 'garbage', `t=${now}`, `v1=${header.split('v1=')[1]}`]) assert.ok(!(await verifyStripeSignature(body, h, secret, now)), h)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
