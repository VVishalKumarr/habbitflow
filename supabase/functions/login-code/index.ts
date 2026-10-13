// Log in with a one-time code sent by email (instead of a password).
// POST { action: 'send', identifier }               -> { request_id }   (username or email)
// POST { action: 'verify', request_id, code, username? }
//        -> { token_hash }        (the app finishes with supabase.auth.verifyOtp)
//        -> { choose: [usernames] } when one email has several accounts
// Never reveals whether an account exists: 'send' always answers the same way.
// Codes: 6 digits, only the salted hash is stored, 10 minutes, 5 attempts, single use.
import { CODE_MAX_ATTEMPTS, CODE_TTL_MINUTES, cleanCode, hashCode, newCode, sameHash } from '../_shared/codes.ts'
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { adminClient, json, preflight, rateLimited, readJson } from '../_shared/http.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SENT = 'If that account exists and has a confirmed email, we’ve sent it a 6-digit code.'
const WRONG = 'That code is wrong or has expired. Check the latest email, or ask for a new code.'

type Account = { user_id: string; username: string; login_email: string; destination: string }

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early
  if (!emailConfigured()) {
    return json(req, { error: 'Login codes aren’t available yet. Use your password.', code: 'email_not_configured' }, 503)
  }
  const body = await readJson<Record<string, unknown>>(req)
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  const admin = adminClient()

  if (body?.action === 'send') {
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim().toLowerCase().slice(0, 254) : ''
    if (identifier.length < 3) return json(req, { error: 'Enter your username or email.' }, 400)
    if ((await rateLimited(`ip:${ip}`, 'login_code_ip', 30, 3600)) || (await rateLimited(`id:${identifier}`, 'login_code_send', 5, 3600))) {
      return json(req, { error: 'Too many codes requested. Please wait a while, or use your password.' }, 429)
    }
    // Housekeeping: codes are useless after a day.
    await admin.from('login_codes').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString())

    const { data } = await admin.rpc('login_code_accounts', { p_identifier: identifier })
    const accounts = (data ?? []) as Account[]
    const destinations = [...new Set(accounts.map((a) => a.destination))]
    const id = crypto.randomUUID()
    const code = newCode()
    // One email gets the code; several matching addresses (a username can only match one) use the first.
    if (destinations.length) {
      const destination = destinations[0]
      const ids = accounts.filter((a) => a.destination === destination).map((a) => a.user_id)
      const { error } = await admin.from('login_codes').insert({
        id,
        destination,
        user_ids: ids,
        code_hash: await hashCode(id, code),
        expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString(),
      })
      if (error) {
        console.error('login code insert', error.message)
        return json(req, { error: 'Something went wrong. Please try again.' }, 500)
      }
      try {
        await sendEmail(
          destination,
          `${code} is your HabbitFlows login code`,
          renderEmail({
            heading: 'Your login code',
            lines: [
              `Enter this code to log in to HabbitFlows: ${code}`,
              `It works once and expires in ${CODE_TTL_MINUTES} minutes. Never share it — HabbitFlows staff will never ask for it.`,
            ],
            footer: 'If you didn’t try to log in, ignore this email. Nobody can log in without this code.',
          }),
        )
      } catch (e) {
        console.error('login code email failed', String(e))
        return json(req, { error: 'We couldn’t send the email. Please try again, or use your password.' }, 502)
      }
    }
    // Same answer (and a request id) whether or not an account was found.
    return json(req, { request_id: id, message: SENT })
  }

  if (body?.action === 'verify') {
    const requestId = typeof body.request_id === 'string' && uuid.test(body.request_id) ? body.request_id : null
    const code = cleanCode(body.code)
    if (!requestId || !code) return json(req, { error: 'Enter the 6-digit code from the email.' }, 400)
    if (await rateLimited(`ip:${ip}`, 'login_code_verify', 60, 3600)) return json(req, { error: 'Too many attempts. Please wait a while.' }, 429)

    const { data: row } = await admin.from('login_codes').select('*').eq('id', requestId).maybeSingle()
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date() || row.attempts >= CODE_MAX_ATTEMPTS) {
      return json(req, { error: WRONG }, 400)
    }
    if (!sameHash(await hashCode(requestId, code), row.code_hash)) {
      await admin.from('login_codes').update({ attempts: row.attempts + 1 }).eq('id', requestId)
      return json(req, { error: WRONG }, 400)
    }

    // Correct code. Which account?
    const { data: profiles } = await admin.from('profiles').select('id, username').in('id', row.user_ids as string[])
    const list = (profiles ?? []) as { id: string; username: string }[]
    const wanted = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const chosen = list.length === 1 ? list[0] : list.find((p) => p.username === wanted)
    if (!chosen) {
      if (list.length > 1) return json(req, { choose: list.map((p) => p.username).sort() })
      return json(req, { error: WRONG }, 400)
    }

    const { data: user } = await admin.auth.admin.getUserById(chosen.id)
    const loginEmail = user.user?.email
    if (!loginEmail) return json(req, { error: WRONG }, 400)
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: loginEmail })
    if (error || !link.properties?.hashed_token) {
      console.error('login link failed', error?.message)
      return json(req, { error: 'Something went wrong. Please try again.' }, 500)
    }
    // Single use: a second verify with the same code fails.
    const { data: used } = await admin
      .from('login_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', requestId)
      .is('consumed_at', null)
      .select('id')
    if (!used?.length) return json(req, { error: WRONG }, 400)
    return json(req, { token_hash: link.properties.hashed_token })
  }

  return json(req, { error: 'Unknown action.' }, 400)
})
