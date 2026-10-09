// Forgot password.
// POST { identifier }  (username, recovery email or institutional login email; no login needed)
// Uses Supabase Auth's own recovery tokens (generateLink): single-use,
// time-limited and verified by Supabase. We only deliver the link to the
// account's *confirmed* recovery email. The response is the same whether or
// not an account matched, so it can't be used to discover accounts.
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { adminClient, clientIp, isEmail, json, preflight, rateLimited, readJson, siteUrl } from '../_shared/http.ts'

const GENERIC = {
  ok: true,
  message: 'If that account has a confirmed recovery email, we’ve sent a password reset link to it. The link expires in 1 hour.',
}

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  if (!emailConfigured() || !siteUrl()) {
    return json(req, { error: 'Password recovery emails aren’t set up on this server yet.', code: 'email_not_configured' }, 503)
  }

  const body = await readJson<{ identifier?: string }>(req)
  const identifier = (body?.identifier ?? '').trim().toLowerCase()
  if (!identifier || identifier.length > 254) return json(req, { error: 'Enter your username or recovery email.' }, 400)

  if (
    (await rateLimited(clientIp(req), 'reset_ip', 10, 3600)) ||
    (await rateLimited(identifier, 'reset_identifier', 3, 3600))
  ) {
    return json(req, { error: 'Too many reset requests. Please try again in an hour.' }, 429)
  }

  // Look up and send in the background so the response time doesn't reveal whether an account matched.
  const work = sendResetLinks(identifier)
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (runtime) runtime.waitUntil(work)
  else await work

  return json(req, GENERIC)
})

async function sendResetLinks(identifier: string): Promise<void> {
  const admin = adminClient()
  let accounts: { user_id: string; recovery_email: string; username: string }[] = []

  if (isEmail(identifier)) {
    const { data } = await admin
      .from('account_private')
      .select('user_id, recovery_email, email_verified_at')
      .eq('recovery_email', identifier) // stored lower-case
      .not('email_verified_at', 'is', null)
      .limit(5)
    const ids = (data ?? []).map((r) => r.user_id)
    if (ids.length) {
      const { data: profiles } = await admin.from('profiles').select('id, username').in('id', ids)
      accounts = (data ?? []).map((r) => ({
        user_id: r.user_id,
        recovery_email: r.recovery_email!,
        username: profiles?.find((p) => p.id === r.user_id)?.username ?? '',
      }))
    }
    // Institutional accounts sign in with their (verified) institutional address.
    const { data: institutional } = await admin.rpc('institutional_login_exists', { p_email: identifier })
    if (institutional === true) {
      await sendLink(identifier, identifier, identifier)
    }
  } else {
    const { data: profile } = await admin.from('profiles').select('id, username').eq('username', identifier).maybeSingle()
    if (profile) {
      const { data } = await admin
        .from('account_private')
        .select('recovery_email, email_verified_at')
        .eq('user_id', profile.id)
        .maybeSingle()
      if (data?.recovery_email && data.email_verified_at) {
        accounts = [{ user_id: profile.id, recovery_email: data.recovery_email, username: profile.username }]
      }
    }
  }

  for (const acct of accounts) {
    const { data: user } = await admin.auth.admin.getUserById(acct.user_id)
    const loginEmail = user.user?.email
    if (loginEmail) await sendLink(loginEmail, acct.recovery_email, acct.username)
  }
}

async function sendLink(loginEmail: string, to: string, accountName: string): Promise<void> {
  try {
    const { data, error } = await adminClient().auth.admin.generateLink({ type: 'recovery', email: loginEmail })
    if (error || !data.properties?.hashed_token) throw error ?? new Error('no token')
    const link = `${siteUrl()}/reset-password?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=recovery`
    await sendEmail(
      to,
      'Reset your HabitFlow password',
      renderEmail({
        heading: 'Reset your password',
        lines: [
          `We received a request to reset the password for the HabitFlow account “${accountName}”.`,
          'This link works once and expires in 1 hour.',
        ],
        button: { label: 'Choose a new password', url: link },
        footer: 'If you didn’t ask for this, ignore this email — your password won’t change.',
      }),
    )
  } catch (e) {
    console.error('password reset send failed', String(e))
  }
}
