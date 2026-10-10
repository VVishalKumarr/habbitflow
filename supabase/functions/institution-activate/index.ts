// Institutional account activation (no login needed).
// POST { action: 'inspect', token }            → what the link is for
// POST { action: 'activate', token, password } → creates the account
//
// Opening the emailed link proves ownership of the address, so the account is
// created with a confirmed email. The password goes straight to Supabase Auth
// (bcrypt) and is never stored or logged here. The database trigger
// handle_new_user() re-checks the invitation (pending, not expired, same
// address, matching token hash) and creates the profile + membership in the
// same transaction.
import { adminClient, clientIp, json, preflight, rateLimited, readJson, sha256Hex } from '../_shared/http.ts'

type Preview = {
  id: string
  email: string
  role: string
  display_name: string
  institution: string
  expired: boolean
  status: string
  account_exists: boolean
}

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const body = await readJson<{ action?: string; token?: string; password?: string }>(req)
  const token = String(body?.token ?? '')
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return json(req, { error: 'This activation link is invalid.' }, 400)

  const tooMany = () => json(req, { error: 'Too many attempts. Please try again in an hour.', code: 'rate_limited' }, 429)
  const admin = adminClient()
  const { data, error } = await admin.rpc('invitation_preview', { p_token_hash: await sha256Hex(token) })
  const inv = data as Preview | null
  // Only unknown links count towards the limit (opening a valid link is harmless).
  if (error || !inv) {
    if (await rateLimited(clientIp(req), 'activate_miss', 30, 3600)) return tooMany()
    return json(req, { error: 'This activation link is invalid or has already been used.' }, 404)
  }
  if (inv.status !== 'pending') return json(req, { error: 'This activation link has already been used or was withdrawn.' }, 410)
  if (inv.expired) return json(req, { error: 'This activation link has expired. Ask your institution to send a new one.', code: 'expired' }, 410)

  const summary = {
    email: inv.email,
    role: inv.role,
    display_name: inv.display_name,
    institution: inv.institution,
    account_exists: inv.account_exists,
  }

  if (body?.action === 'inspect') return json(req, { ok: true, invitation: summary })
  if (body?.action !== 'activate') return json(req, { error: 'Unknown action.' }, 400)

  if (inv.account_exists) {
    // Already has an institutional account: they log in and accept instead.
    return json(req, { error: 'You already have an account. Log in with this email to accept the invitation.', code: 'account_exists' }, 409)
  }

  // Valid links are unguessable, so this is only a backstop. It stays high because a
  // whole class may activate at once from one school network (one public IP).
  if (await rateLimited(clientIp(req), 'activate_ip', 300, 3600)) return tooMany()

  const password = String(body?.password ?? '')
  if (password.length < 8 || password.length > 72) {
    return json(req, { error: 'Choose a password of 8 to 72 characters.' }, 400)
  }

  // The database checks the token against the invitation and strips it from
  // the stored metadata before the account row is written.
  const { error: createError } = await admin.auth.admin.createUser({
    email: inv.email,
    password,
    email_confirm: true,
    user_metadata: { activation_token: token },
  })
  if (createError) {
    console.error('activation failed', createError.message)
    if (/password/i.test(createError.message)) return json(req, { error: createError.message }, 400)
    return json(req, { error: 'This activation link is invalid or has expired.' }, 400)
  }
  return json(req, { ok: true, email: inv.email })
})
