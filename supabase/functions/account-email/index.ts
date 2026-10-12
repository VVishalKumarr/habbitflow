// Add or change the optional recovery email.
// POST { email, password }  (signed in)
// Stores the new address as *pending* with a random one-time token (only its
// SHA-256 hash is saved) and emails a confirmation link. A previously verified
// address stays in place until the new one is confirmed.
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { adminClient, isEmail, json, preflight, randomToken, rateLimited, readJson, sha256Hex, siteUrl, userFromRequest } from '../_shared/http.ts'

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)

  if (!emailConfigured() || !siteUrl()) {
    return json(req, { error: 'Email sending isn’t set up on this server yet, so recovery emails can’t be verified.', code: 'email_not_configured' }, 503)
  }

  const body = await readJson<{ email?: string; password?: string }>(req)
  const email = (body?.email ?? '').trim().toLowerCase()
  if (!isEmail(email)) return json(req, { error: 'Enter a valid email address.' }, 400)

  if (await rateLimited(who.user.id, 'recovery_email', 5, 3600)) {
    return json(req, { error: 'Too many attempts. Please try again in an hour.' }, 429)
  }

  // Current password is required so a stolen session can't redirect recovery.
  const { data: ok, error: pwError } = await who.client.rpc('check_password', { p_password: body?.password ?? '' })
  if (pwError) return json(req, { error: pwError.message }, 429)
  if (!ok) return json(req, { error: 'Current password is incorrect.' }, 403)

  const admin = adminClient()
  const { data: existing } = await admin
    .from('account_private')
    .select('recovery_email, email_verified_at')
    .eq('user_id', who.user.id)
    .maybeSingle()
  if (existing?.recovery_email === email && existing.email_verified_at) {
    return json(req, { error: 'That email is already your confirmed recovery email.' }, 400)
  }

  const token = randomToken()
  const { error } = await admin.from('account_private').upsert({
    user_id: who.user.id,
    recovery_email: existing?.recovery_email ?? null,
    email_verified_at: existing?.email_verified_at ?? null,
    pending_email: email,
    pending_token_hash: await sha256Hex(token),
    pending_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    updated_at: new Date().toISOString(),
  })
  if (error) {
    console.error('account-email upsert', error.message)
    return json(req, { error: 'Could not save the email. Please try again.' }, 500)
  }

  const { data: profile } = await admin.from('profiles').select('username').eq('id', who.user.id).single()
  const username = profile?.username ?? 'your account'
  const link = `${siteUrl()}/verify-email?token=${encodeURIComponent(token)}`

  try {
    await sendEmail(
      email,
      'Confirm your HabbitFlows recovery email',
      renderEmail({
        heading: 'Confirm your recovery email',
        lines: [
          `Someone (hopefully you) added this address as the recovery email for the HabbitFlows account “${username}”.`,
          'Confirm it so you can reset your password if you ever forget it. The link works once and expires in 24 hours.',
        ],
        button: { label: 'Confirm email', url: link },
        footer: 'If you didn’t request this, you can ignore this email — nothing will change.',
      }),
    )
    if (existing?.recovery_email && existing.email_verified_at && existing.recovery_email !== email) {
      await sendEmail(
        existing.recovery_email,
        'Your HabbitFlows recovery email is being changed',
        renderEmail({
          heading: 'Recovery email change requested',
          lines: [
            `A new recovery email was requested for the HabbitFlows account “${username}”.`,
            'This address stays active until the new one is confirmed. If this wasn’t you, log in and change your password.',
          ],
          footer: 'HabbitFlows',
        }),
      ).catch((e) => console.error('notice email failed', String(e)))
    }
  } catch (e) {
    console.error('verification email failed', String(e))
    return json(req, { error: 'We couldn’t send the confirmation email. Please try again later.' }, 502)
  }

  return json(req, { ok: true, pending_email: email })
})
