// Sends queued notification deliveries (email and push). No user session:
// called every minute by pg_cron — only when something is due — with the
// x-job-secret header, which must equal the NOTIFY_JOB_SECRET secret
// (scripts/setup-notify-job.mjs). See NOTIFICATIONS.md.
//
// The database decides what to send (delivery_claim: preferences, skip
// rules, leases) and records each outcome (delivery_result). A channel
// without credentials is recorded as skipped, never as sent.
import { emailConfigured, renderEmail, sendEmail } from '../_shared/email.ts'
import { parseServiceAccount, sendFcm } from '../_shared/fcm.ts'
import { adminClient, env, siteUrl } from '../_shared/http.ts'
import { sendWebPush } from '../_shared/webpush.ts'

interface Delivery {
  id: string
  channel: 'email' | 'push'
  kind: string
  title: string
  body: string | null
  link: string | null
  attempt: number
  email: string | null
  subscriptions: { id: string; kind: 'web' | 'fcm'; endpoint: string; p256dh: string | null; auth: string | null }[] | null
}

const KIND_LABEL: Record<string, string> = {
  deadline_reminder: 'Homework due soon',
  overdue: 'Overdue homework',
  exam_reminder: 'Exam reminders',
  submission_received: 'Submission confirmations',
  submission_reviewed: 'Teacher feedback',
  marks_published: 'New marks',
  marks_corrected: 'Corrected marks',
  announcement: 'Announcements',
  message: 'Messages',
  meeting_request: 'Meeting requests',
  meeting_response: 'Meeting replies',
  guardian_request: 'Parent link requests',
  timetable_changed: 'Timetable changes',
  license_expiring: 'Licence reminders',
  test: 'Test notifications',
}

function sameSecret(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const vapid = () =>
  env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
    ? { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY'), subject: env('VAPID_SUBJECT') || siteUrl() || 'mailto:admin@example.org' }
    : null

async function deliverEmail(d: Delivery): Promise<[string, string | null]> {
  if (!emailConfigured()) return ['skipped', 'email isn’t set up on the server']
  const url = `${siteUrl()}${d.link ?? '/'}`
  try {
    await sendEmail(d.email!, d.title, renderEmail({
      heading: d.title,
      lines: d.body ? [d.body] : [],
      button: { label: 'Open HabitFlow', url },
      footer: `You get these emails because “${KIND_LABEL[d.kind] ?? d.kind}” email notifications are on. Change this in HabitFlow → Settings → Notifications.`,
    }))
    return ['sent', null]
  } catch (e) {
    return ['retry', String(e instanceof Error ? e.message : e).slice(0, 200)]
  }
}

async function deliverPush(d: Delivery, admin: ReturnType<typeof adminClient>): Promise<[string, string | null]> {
  const keys = vapid()
  const sa = parseServiceAccount(env('FCM_SERVICE_ACCOUNT'))
  const payload = { title: d.title, body: d.body ?? '', url: d.link ?? '/', tag: d.kind }
  let sent = 0
  let retry = false
  let unconfigured = 0
  for (const s of d.subscriptions ?? []) {
    if ((s.kind === 'web' && !keys) || (s.kind === 'fcm' && !sa)) {
      unconfigured++
      continue
    }
    try {
      const r = s.kind === 'web'
        ? await sendWebPush({ endpoint: s.endpoint, p256dh: s.p256dh!, auth: s.auth! }, payload, keys!)
        : await sendFcm(sa!, s.endpoint, { title: d.title, body: d.body ?? '', link: d.link ?? '/', tag: d.kind })
      await admin.rpc('push_subscription_result', { p_id: s.id, p_ok: r.ok, p_gone: r.gone })
      if (r.ok) sent++
      else if (r.retry) retry = true
      else if (!r.gone) console.error('push rejected', s.kind, r.status)
    } catch (e) {
      console.error('push failed', s.kind, String(e))
      retry = true
    }
  }
  if (sent) return ['sent', `${sent} device${sent === 1 ? '' : 's'}`]
  if (retry) return ['retry', 'push service unavailable']
  if (unconfigured === (d.subscriptions ?? []).length) return ['skipped', 'push isn’t set up on the server']
  return ['skipped', 'no reachable devices']
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const secret = env('NOTIFY_JOB_SECRET')
  if (!secret || !sameSecret(req.headers.get('x-job-secret') ?? '', secret)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  }
  const admin = adminClient()
  const counts: Record<string, number> = {}
  const started = Date.now()
  // A few batches per run; the next minute picks up the rest.
  for (let batch = 0; batch < 5 && Date.now() - started < 40_000; batch++) {
    const { data, error } = await admin.rpc('delivery_claim', { p_limit: 50 })
    if (error) {
      console.error('delivery_claim failed', error.message)
      break
    }
    const items = (data ?? []) as Delivery[]
    if (!items.length) break
    await Promise.all(items.map(async (d) => {
      const [status, reason] = d.channel === 'email' ? await deliverEmail(d) : await deliverPush(d, admin)
      await admin.rpc('delivery_result', { p_id: d.id, p_status: status, p_reason: reason })
      counts[`${d.channel}_${status}`] = (counts[`${d.channel}_${status}`] ?? 0) + 1
    }))
  }
  return new Response(JSON.stringify({ ok: true, ...counts }), { headers: { 'Content-Type': 'application/json' } })
})
