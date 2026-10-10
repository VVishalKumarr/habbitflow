// Google Play Billing verification for the Android app.
// POST { purchaseToken, productId }  (signed in)
// Verifies the purchase with the Google Play Developer API using a service
// account (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) and only then grants Pro.
// The app must pass the user's id as obfuscatedAccountId when purchasing so a
// token can't be reused by another account.
// NOTE: untested end-to-end until a Play Console app, subscription product and
// service account exist (see PLAY_STORE_CHECKLIST.md).
import { adminClient, env, json, preflight, rateLimited, readJson, userFromRequest } from '../_shared/http.ts'

interface ServiceAccount {
  client_email: string
  private_key: string
}

const b64url = (data: ArrayBuffer | string) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function googleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  )
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  })
  if (!res.ok) throw new Error(`Google OAuth ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

const STATE: Record<string, string> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'past_due',
  SUBSCRIPTION_STATE_ON_HOLD: 'past_due',
  SUBSCRIPTION_STATE_PAUSED: 'expired',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'created',
}

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const pkg = env('GOOGLE_PLAY_PACKAGE_NAME')
  const saJson = env('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')
  if (!pkg || !saJson) return json(req, { error: 'Google Play billing isn’t set up yet.', code: 'play_not_configured' }, 503)

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  if (await rateLimited(who.user.id, 'play_verify', 20, 3600)) return json(req, { error: 'Too many attempts.' }, 429)

  const body = await readJson<{ purchaseToken?: string; productId?: string }>(req)
  const token = body?.purchaseToken ?? ''
  if (!token || token.length > 4096) return json(req, { error: 'Missing purchase token.' }, 400)

  const admin = adminClient()
  const { data: plans } = await admin.from('plans').select('id, google_play_product_id').not('google_play_product_id', 'is', null)
  if (!plans?.length) return json(req, { error: 'Google Play products aren’t configured.' }, 503)

  try {
    const access = await googleAccessToken(JSON.parse(saJson) as ServiceAccount)
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/purchases`
    const res = await fetch(`${base}/subscriptionsv2/tokens/${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${access}` } })
    if (!res.ok) return json(req, { error: 'Google Play could not verify this purchase.' }, 400)
    const purchase = (await res.json()) as {
      subscriptionState?: string
      acknowledgementState?: string
      startTime?: string
      lineItems?: { productId: string; expiryTime?: string }[]
      externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string }
    }

    // Which of our plans was bought (each paid plan has its own Play product).
    const item = purchase.lineItems?.find((l) => plans.some((p) => p.google_play_product_id === l.productId))
    const plan = plans.find((p) => p.google_play_product_id === item?.productId)
    if (!item || !plan) return json(req, { error: 'This purchase is not for a HabitFlow plan.' }, 400)
    if (purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId !== who.user.id) {
      return json(req, { error: 'This purchase belongs to a different account.' }, 403)
    }

    const status = STATE[purchase.subscriptionState ?? ''] ?? 'created'
    const { error } = await admin.from('subscriptions').upsert(
      {
        user_id: who.user.id,
        provider: 'google_play',
        provider_subscription_id: token,
        plan: plan.id,
        status,
        started_at: purchase.startTime ?? null,
        expires_at: item.expiryTime ?? null,
      },
      { onConflict: 'provider,provider_subscription_id' },
    )
    if (error) throw error

    if (purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && status === 'active') {
      await fetch(`${base}/subscriptions/${encodeURIComponent(item.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    }
    return json(req, { ok: true, status })
  } catch (e) {
    console.error('play verify failed', String(e))
    return json(req, { error: 'Could not verify the purchase right now.' }, 502)
  }
})
