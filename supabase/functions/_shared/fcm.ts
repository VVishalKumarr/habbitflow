// Android push through Firebase Cloud Messaging (HTTP v1), WebCrypto only.
// Configure with the FCM_SERVICE_ACCOUNT secret: the JSON key of a Firebase
// service account (Firebase console → Project settings → Service accounts).

export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function parseServiceAccount(raw: string): ServiceAccount | null {
  try {
    const sa = JSON.parse(raw) as ServiceAccount
    return sa.project_id && sa.client_email && sa.private_key?.includes('PRIVATE KEY') ? sa : null
  } catch {
    return null
  }
}

/** Signed JWT for Google's OAuth token endpoint (RS256). */
export async function serviceAccountJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claims = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })))
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)))
  return `${header}.${claims}.${b64url(sig)}`
}

let cached: { token: string; until: number } | null = null

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await serviceAccountJwt(sa) }),
  })
  if (!res.ok) throw new Error(`FCM auth failed (${res.status})`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cached = { token: data.access_token, until: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

/** The FCM v1 message for one device. */
export function fcmMessage(token: string, n: { title: string; body: string; link: string; tag?: string }) {
  return {
    message: {
      token,
      notification: { title: n.title, body: n.body },
      data: { link: n.link },
      android: { priority: 'high', notification: { tag: n.tag, channel_id: 'default' } },
    },
  }
}

export async function sendFcm(sa: ServiceAccount, token: string, n: { title: string; body: string; link: string; tag?: string }) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fcmMessage(token, n)),
  })
  const text = await res.text()
  // UNREGISTERED / invalid token: the app was removed or the token rotated.
  const gone = res.status === 404 || (res.status === 400 && /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text))
  return { ok: res.ok, gone, status: res.status, retry: res.status === 429 || res.status >= 500 }
}
