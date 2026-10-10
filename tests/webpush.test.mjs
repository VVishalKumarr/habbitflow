// Web Push protocol tests (no network): RFC 8291 encryption against the RFC's
// own example, a receiver-side round trip, and the VAPID JWT (RFC 8292).
//   node tests/webpush.test.mjs
import assert from 'node:assert/strict'
import { b64url, encryptPayload, generateVapidKeys, unb64url, vapidAuthorization } from '../supabase/functions/_shared/webpush.ts'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 4).join('\n    ')}`)
  }
}
console.log('Web Push protocol')
const enc = new TextEncoder()
const jwk = (pub, d) => ({ kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ...(d ? { d } : {}) })

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8))
}
/** Receiver side of RFC 8291, written independently of the sender code. */
async function decrypt(body, uaPublic, uaPrivateD, authSecret) {
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ct = body.slice(21 + idlen)
  const ua = await crypto.subtle.importKey('jwk', jwk(uaPublic, uaPrivateD), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const as = await crypto.subtle.importKey('jwk', jwk(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, ua, 256))
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
  const ikm = await hkdf(authSecret, secret, info, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct))
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  assert.equal(plain[end], 2, 'last-record delimiter')
  return new TextDecoder().decode(plain.slice(0, end))
}

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

await test('decrypting the RFC 8291 example gives its plaintext (checks the test’s receiver)', async () => {
  assert.equal(await decrypt(unb64url(RFC.body), unb64url(RFC.uaPublic), RFC.uaPrivate, unb64url(RFC.auth)), RFC.plaintext)
})

await test('encryption reproduces the RFC 8291 example byte for byte', async () => {
  const asPub = unb64url(RFC.asPublic)
  const serverKeys = {
    privateKey: await crypto.subtle.importKey('jwk', jwk(asPub, RFC.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('jwk', jwk(asPub), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  }
  const body = await encryptPayload(enc.encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: unb64url(RFC.salt), serverKeys })
  assert.equal(b64url(body), RFC.body)
})

await test('a fresh subscription round-trips a JSON payload (random salt and server key)', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const d = (await crypto.subtle.exportKey('jwk', ua.privateKey)).d
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const msg = JSON.stringify({ title: 'Homework due tomorrow', body: 'Maths — algebra sheet ✏️', url: '/school/assignments' })
  const a = await encryptPayload(enc.encode(msg), { p256dh: b64url(uaPublic), auth: b64url(auth) })
  const b = await encryptPayload(enc.encode(msg), { p256dh: b64url(uaPublic), auth: b64url(auth) })
  assert.notEqual(b64url(a), b64url(b), 'every message uses a new salt and key')
  assert.equal(await decrypt(a, uaPublic, d, auth), msg)
  assert.ok(a.length < 4096, 'fits one record')
})

await test('VAPID header: valid ES256 JWT for the push service origin', async () => {
  const keys = await generateVapidKeys()
  assert.equal(unb64url(keys.publicKey).length, 65)
  assert.equal(unb64url(keys.privateKey).length, 32)
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', { ...keys, subject: 'https://example.org' })
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
  assert.ok(m, header)
  assert.equal(m[4], keys.publicKey)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64url(m[1]))), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(new TextDecoder().decode(unb64url(m[2])))
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.sub, 'https://example.org')
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'expiry within 24 h (RFC 8292)')
  const pub = await crypto.subtle.importKey('jwk', jwk(unb64url(keys.publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[3]), enc.encode(`${m[1]}.${m[2]}`))
  assert.ok(ok, 'signature verifies with the public key')
  assert.equal(unb64url(m[3]).length, 64, 'raw r||s signature')
})


// ---- Firebase Cloud Messaging (Android) ----
const { serviceAccountJwt, parseServiceAccount, fcmMessage } = await import('../supabase/functions/_shared/fcm.ts')
await test('FCM: service-account JWT is a valid RS256 token for Google OAuth', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`
  const sa = parseServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'demo-app', client_email: 'push@demo-app.iam.gserviceaccount.com', private_key: pem }))
  assert.ok(sa)
  assert.equal(parseServiceAccount('{"project_id":"x"}'), null)
  assert.equal(parseServiceAccount('not json'), null)
  const jwt = await serviceAccountJwt(sa, 1_800_000_000)
  const [h, c, s] = jwt.split('.')
  const claims = JSON.parse(new TextDecoder().decode(unb64url(c)))
  assert.deepEqual(claims, { iss: 'push@demo-app.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 })
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, unb64url(s), enc.encode(`${h}.${c}`)))
  const msg = fcmMessage('device-token', { title: 'T', body: 'B', link: '/school' })
  assert.deepEqual(msg.message.data, { link: '/school' })
  assert.equal(msg.message.token, 'device-token')
})
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
