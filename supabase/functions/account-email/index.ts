// The account's email (personal accounts): add, change and confirm it with a
// 6-digit code. Email is required for personal accounts; it is used for login
// codes and password resets.
// POST { action: 'status' }                    -> { email_configured }
// POST { action: 'send', email, password? }    -> { ok, pending_email }   (signed in)
//        The current password is needed only to *replace* an already
//        confirmed email, so a stolen session can't take over recovery.
// POST { action: 'verify', code }              -> { ok, email }           (signed in)
// A previously confirmed address stays in place until the new one is confirmed.
import { CODE_MAX_ATTEMPTS, cleanCode, hashCode, newCode, sameHash } from '../_shared/codes.ts'
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { adminClient, isEmail, json, preflight, rateLimited, readJson, userFromRequest } from '../_shared/http.ts'

const CONFIRM_MINUTES = 15

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early
  const body = await readJson<{ action?: string; email?: string; password?: string; code?: string }>(req)

  if (body?.action === 'status') return json(req, { email_configured: emailConfigured() })

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  if (!emailConfigured()) {
    return json(req, { error: 'Email sending isn’t set up on this server yet.', code: 'email_not_configured' }, 503)
  }
  const admin = adminClient()
  const { data: existing } = await admin
    .from('account_private')
    .select('recovery_email, email_verified_at, pending_email, pending_token_hash, pending_expires_at, pending_attempts')
    .eq('user_id', who.user.id)
    .maybeSingle()

  // Older clients send { email, password } without an action.
  if (body?.action === 'send' || (!body?.action && body?.email)) {
    const email = (body?.email ?? '').trim().toLowerCase()
    if (!isEmail(email)) return json(req, { error: 'Enter a valid email address.' }, 400)
    if (email.endsWith('@habitflow.local')) return json(req, { error: 'Enter your own email address.' }, 400)
    if (await rateLimited(who.user.id, 'recovery_email', 5, 3600)) {
      return json(req, { error: 'Too many attempts. Please try again in an hour.' }, 429)
    }
    if (existing?.recovery_email === email && existing.email_verified_at) {
      return json(req, { error: 'That email is already confirmed on your account.' }, 400)
    }
    if (existing?.email_verified_at) {
      const { data: ok, error: pwError } = await who.client.rpc('check_password', { p_password: body?.password ?? '' })
      if (pwError) return json(req, { error: pwError.message }, 429)
      if (!ok) return json(req, { error: 'Current password is incorrect.', code: 'password_required' }, 403)
    }

    const code = newCode()
    const { error } = await admin.from('account_private').upsert({
      user_id: who.user.id,
      recovery_email: existing?.recovery_email ?? null,
      email_verified_at: existing?.email_verified_at ?? null,
      pending_email: email,
      pending_token_hash: await hashCode(who.user.id, code),
      pending_expires_at: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString(),
      pending_attempts: 0,
      updated_at: new Date().toISOString(),
    })
    if (error) {
      console.error('account-email upsert', error.message)
      return json(req, { error: 'Could not save the email. Please try again.' }, 500)
    }
    const { data: profile } = await admin.from('profiles').select('username').eq('id', who.user.id).single()
    const username = profile?.username ?? 'your account'
    try {
      await sendEmail(
        email,
        `${code} is your HabbitFlows confirmation code`,
        renderEmail({
          heading: 'Confirm your email',
          lines: [
            `Enter this code in HabbitFlows to confirm this email for the account “${username}”: ${code}`,
            `It expires in ${CONFIRM_MINUTES} minutes. You’ll use this email to log in with a code and to reset your password.`,
          ],
          footer: 'If you didn’t request this, you can ignore this email — nothing will change.',
        }),
      )
      if (existing?.recovery_email && existing.email_verified_at && existing.recovery_email !== email) {
        await sendEmail(
          existing.recovery_email,
          'Your HabbitFlows email is being changed',
          renderEmail({
            heading: 'Email change requested',
            lines: [
              `A new email was requested for the HabbitFlows account “${username}”.`,
              'This address stays active until the new one is confirmed. If this wasn’t you, log in and change your password.',
            ],
            footer: 'HabbitFlows',
          }),
        ).catch((e) => console.error('notice email failed', String(e)))
      }
    } catch (e) {
      console.error('confirmation email failed', String(e))
      return json(req, { error: 'We couldn’t send the email. Please check the address and try again.' }, 502)
    }
    return json(req, { ok: true, pending_email: email })
  }

  if (body?.action === 'verify') {
    const code = cleanCode(body.code)
    if (!code) return json(req, { error: 'Enter the 6-digit code from the email.' }, 400)
    const wrong = 'That code is wrong or has expired. Check the latest email, or send a new code.'
    if (!existing?.pending_email || !existing.pending_token_hash || !existing.pending_expires_at ||
        new Date(existing.pending_expires_at) < new Date() || (existing.pending_attempts ?? 0) >= CODE_MAX_ATTEMPTS) {
      return json(req, { error: wrong }, 400)
    }
    if (!sameHash(await hashCode(who.user.id, code), existing.pending_token_hash)) {
      await admin.from('account_private').update({ pending_attempts: (existing.pending_attempts ?? 0) + 1 }).eq('user_id', who.user.id)
      return json(req, { error: wrong }, 400)
    }
    const { error } = await admin
      .from('account_private')
      .update({
        recovery_email: existing.pending_email,
        email_verified_at: new Date().toISOString(),
        pending_email: null,
        pending_token_hash: null,
        pending_expires_at: null,
        pending_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', who.user.id)
    if (error) return json(req, { error: 'Could not confirm the email. Please try again.' }, 500)
    return json(req, { ok: true, email: existing.pending_email })
  }

  return json(req, { error: 'Unknown action.' }, 400)
})
