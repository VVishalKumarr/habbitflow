// Web Push without dependencies (WebCrypto only; runs in Deno and Node):
// VAPID (RFC 8292) request signing and aes128gcm payload encryption
// (RFC 8291 / RFC 8188). Keys are base64url strings:
//   VAPID public key  = 65-byte uncompressed P-256 point
//   VAPID private key = 32-byte scalar (d)

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

function publicJwk(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Expected an uncompressed P-256 public key')
  return { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), ext: true }
}

/** A new VAPID key pair (base64url). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return { publicKey: b64url(raw), privateKey: jwk.d! }
}

/** Authorization header value for a push service (RFC 8292). */
export async function vapidAuthorization(endpoint: string, vapid: { publicKey: string; privateKey: string; subject: string }, expiresIn = 12 * 3600): Promise<string> {
  const pub = unb64url(vapid.publicKey)
  const key = await crypto.subtle.importKey('jwk', { ...publicJwk(pub), d: vapid.privateKey }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + expiresIn, sub: vapid.subject })))
  // WebCrypto ECDSA signatures are already the raw r||s form JWS needs.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`
}

/**
 * Encrypts a payload for one subscription (aes128gcm, single record).
 * `testing` fixes the salt and server key pair (tests only).
 */
export async function encryptPayload(
  payload: Uint8Array,
  sub: { p256dh: string; auth: string },
  testing?: { salt: Uint8Array; serverKeys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = unb64url(sub.p256dh)
  const authSecret = unb64url(sub.auth)
  const server = testing?.serverKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey))
  const uaKey = await crypto.subtle.importKey('jwk', publicJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256))
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = testing?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // payload, then the 0x02 delimiter of the last (only) record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))))
  const rs = new Uint8Array([0, 0, 16, 0]) // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

export interface PushResult {
  ok: boolean
  /** the subscription no longer exists — remove it */
  gone: boolean
  status: number
  retry: boolean
}

/** Sends one notification to one browser subscription. */
export async function sendWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttl = 86400,
): Promise<PushResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub)
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body,
  })
  await res.body?.cancel()
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status, retry: res.status === 429 || res.status >= 500 }
}
