// Notification channels for the app (signed in).
// POST { action: 'config' } → which channels the server can deliver, and the
// public VAPID key browsers need to subscribe to push.
import { emailConfigured } from '../_shared/email.ts'
import { parseServiceAccount } from '../_shared/fcm.ts'
import { env, json, preflight, readJson, userFromRequest } from '../_shared/http.ts'

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early
  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  const body = await readJson<{ action?: string }>(req)
  if (body?.action !== 'config') return json(req, { error: 'Unknown action.' }, 400)
  const vapid = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY') ? env('VAPID_PUBLIC_KEY') : null
  return json(req, {
    email: emailConfigured(),
    web_push: !!vapid,
    vapid_public_key: vapid,
    android_push: !!parseServiceAccount(env('FCM_SERVICE_ACCOUNT')),
  })
})
