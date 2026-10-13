// Stripe webhook signature check (https://docs.stripe.com/webhooks#verify-manually).
// Pure function, no imports: used by the stripe-webhook function and the unit tests.
// Header: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}` with the endpoint secret>[,v1=…]"

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** True when the header carries a valid signature made within `toleranceSeconds` of `nowSeconds`. */
export async function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!secret || !header) return false
  const parts = header.split(',').map((p) => p.trim().split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '')
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = await hmacHex(secret, `${t}.${rawBody}`)
  return sigs.some((s) => safeEqual(s, expected))
}

/** Builds a header the way Stripe does (for tests). */
export async function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`
}
