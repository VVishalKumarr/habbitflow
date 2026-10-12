// Institutional invitations (signed in).
// POST { action: 'invite', institution_id, email, role, display_name, external_id? }
// POST { action: 'resend', invitation_id }
// POST { action: 'approve_guardian', link_id }  (approve a student's parent/guardian link)
// POST { action: 'bulk_import', institution_id, role, file_name, first_row, rows: [{ email, name, external_id?, class? }] }
//      CSV import, up to 50 rows per request; the role comes from the request (chosen in the app), never from the file.
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
  parent: 'Parent / Guardian',
}

type Body = {
  action?: string
  institution_id?: string
  email?: string
  role?: string
  display_name?: string
  external_id?: string
  invitation_id?: string
  link_id?: string
  file_name?: string
  first_row?: number
  rows?: { row?: number; email?: string; name?: string; external_id?: string; class?: string }[]
}

type Invite = { id: string; email: string; expires_at: string; institution: string; role: string; student?: string }

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

  if (body.action === 'bulk_import') return bulkImport(req, who.user.id, body, manualLinks)

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
  } else if (body.action === 'approve_guardian') {
    if (!uuid.test(body.link_id ?? '')) return json(req, { error: 'Request not found.' }, 400)
    const { data, error } = await admin.rpc('create_guardian_invitation', {
      p_actor: who.user.id,
      p_link: body.link_id,
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
      `You're invited to ${invite.institution} on HabbitFlows`,
      renderEmail({
        heading: `Join ${invite.institution}`,
        lines: [
          invite.role === 'parent' && invite.student
            ? `${invite.institution} confirmed you as a parent or guardian of ${invite.student} on HabbitFlows. You'll be able to see their timetable, homework, attendance and marks, and message their teachers.`
            : `You've been invited to ${invite.institution} on HabbitFlows as ${ROLE_LABEL[invite.role] ?? invite.role}.`,
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

/** Sends the invitation email; returns an error message instead of throwing. */
async function sendInvite(invite: Invite, link: string): Promise<string | null> {
  const expires = new Date(invite.expires_at).toUTCString().replace(/:\d\d GMT$/, ' GMT')
  try {
    await sendEmail(
      invite.email,
      `You're invited to ${invite.institution} on HabbitFlows`,
      renderEmail({
        heading: `Join ${invite.institution}`,
        lines: [
          `You've been invited to ${invite.institution} on HabbitFlows as ${ROLE_LABEL[invite.role] ?? invite.role}.`,
          'Open the link to confirm your email address and choose your password. You will then sign in with this email address and that password.',
          `The link works once and expires on ${expires}.`,
        ],
        button: { label: 'Activate my account', url: link },
        footer: 'If you weren’t expecting this, you can ignore this email — no account is created until the link is used.',
      }),
    )
    return null
  } catch (e) {
    console.error('invitation email failed', String(e))
    return 'Invitation saved, but the email could not be sent — use “Resend” on the People page.'
  }
}

const BATCH = 50

async function bulkImport(req: Request, actor: string, body: Body, manualLinks: boolean): Promise<Response> {
  if (!uuid.test(body.institution_id ?? '')) return json(req, { error: 'Choose an institution.' }, 400)
  const role = String(body.role ?? '')
  if (!['student', 'coordinator', 'class_teacher', 'subject_teacher'].includes(role)) return json(req, { error: 'Choose who you are importing.' }, 400)
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length || rows.length > BATCH) return json(req, { error: `Send 1 to ${BATCH} rows at a time.` }, 400)
  const first = Number.isInteger(body.first_row) && body.first_row! > 0 ? body.first_row! : 1
  const admin = adminClient()
  const results: Record<string, unknown>[] = []
  for (const [i, r] of rows.entries()) {
    const token = randomToken(32)
    const { data, error } = await admin.rpc('import_person', {
      p_actor: actor,
      p_inst: body.institution_id,
      p_role: role,
      p_email: String(r.email ?? '').slice(0, 254),
      p_name: String(r.name ?? '').slice(0, 80),
      p_external_id: r.external_id ? String(r.external_id).slice(0, 40) : null,
      p_class: r.class ? String(r.class).slice(0, 60) : null,
      p_token_hash: await sha256Hex(token),
    })
    // the file's own line number when the app sends a subset of rows
    const row = Number.isInteger(r.row) && r.row! > 0 ? r.row! : first + i
    if (error) {
      results.push({ row, status: 'error', messages: [error.message] })
      continue
    }
    const res = data as { status: string; action?: string; invite?: Invite; messages?: string[] }
    const out: Record<string, unknown> = { row, status: res.status, action: res.action, messages: res.messages ?? [] }
    if (res.action === 'invited' && res.invite) {
      const link = `${siteUrl()}/activate?token=${encodeURIComponent(token)}`
      if (manualLinks) {
        out.activation_link = link
      } else {
        const failed = await sendInvite(res.invite, link)
        if (failed) out.messages = [...(res.messages ?? []), failed]
      }
    }
    results.push(out)
  }
  const kind = role === 'student' ? 'students' : 'staff'
  const nums = results.map((x) => Number(x.row))
  const file = `${String(body.file_name ?? 'import.csv').slice(0, 150)} (rows ${Math.min(...nums)}–${Math.max(...nums)})`
  const { error } = await admin.rpc('record_import', { p_actor: actor, p_inst: body.institution_id, p_kind: kind, p_file: file, p_results: results })
  if (error) console.error('record_import failed', error.message)
  return json(req, { ok: true, emailed: !manualLinks, results })
}
