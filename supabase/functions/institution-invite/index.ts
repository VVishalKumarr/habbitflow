// Institutional invitations (signed in).
// POST { action: 'invite', institution_id, email, role, display_name, external_id? }
// POST { action: 'resend', invitation_id }
//
// The caller's session is verified here; the database (create_invitation /
// rotate_invitation) decides whether this caller may invite that role and
// whether the address is on the institution's approved list.
// The one-time activation token is random (32 bytes), stored only as a
// SHA-256 hash and emailed to the invitee. It is returned to the inviter only
// when email isn't configured AND the ALLOW_MANUAL_INVITE_LINKS secret is
// "true" (setup/testing mode, see INSTITUTION_ONBOARDING.md).
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { adminClient, env, json, preflight, randomToken, rateLimited, readJson, sha256Hex, siteUrl, userFromRequest } from '../_shared/http.ts'

const ROLE_LABEL: Record<string, string> = {
  principal: 'Principal',
  director: 'Director',
  coordinator: 'Coordinator',
  class_teacher: 'Class Teacher',
  subject_teacher: 'Subject Teacher',
  student: 'Student',
}

type Body = {
  action?: string
  institution_id?: string
  email?: string
  role?: string
  display_name?: string
  external_id?: string
  invitation_id?: string
}

type Invite = { id: string; email: string; expires_at: string; institution: string; role: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)

  const manualLinks = !emailConfigured() && env('ALLOW_MANUAL_INVITE_LINKS') === 'true'
  if (!siteUrl() || (!emailConfigured() && !manualLinks)) {
    return json(req, { error: 'Invitation emails aren’t set up on this server yet.', code: 'email_not_configured' }, 503)
  }

  const body = await readJson<Body>(req)
  if (!body) return json(req, { error: 'Invalid request.' }, 400)

  if (await rateLimited(who.user.id, 'invite', 300, 3600)) {
    return json(req, { error: 'Too many invitations in the last hour. Please try again later.', code: 'rate_limited' }, 429)
  }

  const admin = adminClient()
  const token = randomToken(32)
  const tokenHash = await sha256Hex(token)
  let invite: Invite

  if (body.action === 'invite') {
    if (!uuid.test(body.institution_id ?? '')) return json(req, { error: 'Choose an institution.' }, 400)
    const { data, error } = await admin.rpc('create_invitation', {
      p_actor: who.user.id,
      p_inst: body.institution_id,
      p_email: String(body.email ?? '').slice(0, 254),
      p_role: String(body.role ?? ''),
      p_name: String(body.display_name ?? '').slice(0, 80),
      p_external_id: body.external_id ? String(body.external_id).slice(0, 40) : null,
      p_token_hash: tokenHash,
    })
    if (error) return json(req, { error: error.message }, 400)
    invite = data as Invite
  } else if (body.action === 'resend') {
    if (!uuid.test(body.invitation_id ?? '')) return json(req, { error: 'Invitation not found.' }, 400)
    const { data, error } = await admin.rpc('rotate_invitation', {
      p_actor: who.user.id,
      p_invitation: body.invitation_id,
      p_token_hash: tokenHash,
    })
    if (error) return json(req, { error: error.message }, 400)
    invite = data as Invite
  } else {
    return json(req, { error: 'Unknown action.' }, 400)
  }

  const link = `${siteUrl()}/activate?token=${encodeURIComponent(token)}`
  const expires = new Date(invite.expires_at).toUTCString().replace(/:\d\d GMT$/, ' GMT')

  if (manualLinks) {
    // Setup/testing mode: the inviter delivers the link themselves.
    return json(req, { ok: true, id: invite.id, emailed: false, activation_link: link, expires_at: invite.expires_at })
  }

  try {
    await sendEmail(
      invite.email,
      `You're invited to ${invite.institution} on HabitFlow`,
      renderEmail({
        heading: `Join ${invite.institution}`,
        lines: [
          `You've been invited to ${invite.institution} on HabitFlow as ${ROLE_LABEL[invite.role] ?? invite.role}.`,
          'Open the link to confirm your email address and choose your password. You will then sign in with this email address and that password.',
          `The link works once and expires on ${expires}.`,
        ],
        button: { label: 'Activate my account', url: link },
        footer: 'If you weren’t expecting this, you can ignore this email — no account is created until the link is used.',
      }),
    )
  } catch (e) {
    console.error('invitation email failed', String(e))
    return json(req, { error: 'The invitation was saved but the email could not be sent. Try “Resend” in a minute.', id: invite.id }, 502)
  }
  return json(req, { ok: true, id: invite.id, emailed: true, expires_at: invite.expires_at })
})
