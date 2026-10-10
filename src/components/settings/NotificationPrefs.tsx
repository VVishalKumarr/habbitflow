import { BellRing, Mail, Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { channelConfig, disableWebPush, enableAndroidPush, enableWebPush, pushSupport, webPushEnabled, type ChannelConfig } from '../../lib/push'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useAuth } from '../../store/auth'
import { toast } from '../../store/ui'
import { Spinner } from '../ui/Spinner'

const KINDS: { kind: string; label: string }[] = [
  { kind: 'deadline_reminder', label: 'Homework due within 24 hours' },
  { kind: 'overdue', label: 'Overdue homework' },
  { kind: 'exam_reminder', label: 'Exams tomorrow' },
  { kind: 'submission_received', label: 'Submission confirmations' },
  { kind: 'submission_reviewed', label: 'Teacher feedback on work' },
  { kind: 'marks_published', label: 'New marks' },
  { kind: 'marks_corrected', label: 'Corrected marks' },
  { kind: 'announcement', label: 'School announcements' },
  { kind: 'timetable_changed', label: 'Your class teacher changed your timetable' },
  { kind: 'message', label: 'Messages' },
  { kind: 'meeting_request', label: 'Meeting requests' },
  { kind: 'meeting_response', label: 'Replies to meeting requests' },
  { kind: 'guardian_request', label: 'Parent link requests (staff)' },
  { kind: 'license_expiring', label: 'Licence renewal reminders (heads)' },
]

type Channel = 'in_app' | 'email' | 'push'
type Pref = { kind: string } & Record<Channel, boolean>
const DEFAULTS: Record<Channel, boolean> = { in_app: true, email: false, push: false }

interface Delivery {
  id: string
  channel: 'email' | 'push'
  status: 'pending' | 'sent' | 'skipped' | 'failed'
  reason: string | null
  created_at: string
  notifications: { title: string } | null
}

/** Per kind: in the app, by email, by push. Plus this device's push and a test. */
export function NotificationPrefs() {
  const userId = useAuth((s) => s.session?.user.id)
  const { data, setData } = useLoad(async () => unwrap(await supabase.from('notification_prefs').select('kind, in_app, email, push')) as Pref[], [userId])
  const { data: reach, reload: reloadReach } = useLoad(async () => unwrap(await supabase.rpc('my_notification_channels')) as { email: string | null; devices: number }, [userId])
  const [cfg, setCfg] = useState<ChannelConfig | null>(null)
  const [here, setHere] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const support = pushSupport()

  useEffect(() => {
    channelConfig().then(setCfg, () => setCfg({ email: false, web_push: false, vapid_public_key: null, android_push: false }))
    if (support === 'web') webPushEnabled().then(setHere, () => setHere(false))
  }, [support])

  const value = (kind: string, ch: Channel) => data?.find((p) => p.kind === kind)?.[ch] ?? DEFAULTS[ch]

  const toggle = async (kind: string, ch: Channel, v: boolean) => {
    const current = data?.find((p) => p.kind === kind) ?? { kind, ...DEFAULTS }
    const next = { ...current, [ch]: v }
    setData([...(data ?? []).filter((p) => p.kind !== kind), next])
    const { error } = await supabase.from('notification_prefs').upsert({ user_id: userId, kind, in_app: next.in_app, email: next.email, push: next.push, updated_at: new Date().toISOString() })
    if (error) toast.error('Couldn’t save. Please try again.')
  }

  const enableHere = async () => {
    setBusy('device')
    try {
      if (support === 'android') await enableAndroidPush()
      else await enableWebPush()
      setHere(true)
      reloadReach()
      toast.success('Push notifications are on for this device. Now choose which kinds to push below.')
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const disableHere = async () => {
    setBusy('device')
    try {
      await disableWebPush()
      setHere(false)
      reloadReach()
      toast.success('Push turned off for this browser.')
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    const { error } = await supabase.rpc('send_test_notification')
    setBusy(null)
    if (error) toast.error(friendlyError(error))
    else toast.success('Test sent. It arrives within a minute on every channel you have.')
  }

  const serverPush = support === 'android' ? cfg?.android_push : cfg?.web_push

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3.5 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium"><Mail className="size-4 text-muted" aria-hidden="true" /> Email</p>
          <p className="text-muted">
            {cfg && !cfg.email
              ? 'Email isn’t set up on the server yet. Your choices are saved for when it is.'
              : reach?.email
                ? `Sent to ${reach.email}, 10 minutes later and only if you haven’t seen it in the app or by push.`
                : 'Add and confirm a recovery email (Account) to get emails.'}
          </p>
        </div>
        <div className="rounded-xl border border-line p-3.5 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium"><Smartphone className="size-4 text-muted" aria-hidden="true" /> Push on this device</p>
          {support === 'unsupported' ? (
            <p className="text-muted">This browser can’t receive push notifications.</p>
          ) : support === 'android-not-built' ? (
            <p className="text-muted">Push for the Android app is coming with a future update.</p>
          ) : cfg && !serverPush ? (
            <p className="text-muted">Push isn’t set up on the server yet.</p>
          ) : (
            <>
              <p className="text-muted">
                {here ? 'On for this device.' : 'Off for this device.'} {reach ? `${reach.devices} device${reach.devices === 1 ? '' : 's'} on your account.` : ''}
              </p>
              <div className="mt-2">
                {here && support === 'web' ? (
                  <button type="button" className="btn-secondary h-9 min-h-9" onClick={disableHere} disabled={!!busy}>Turn off here</button>
                ) : (
                  <button type="button" className="btn-primary h-9 min-h-9" onClick={enableHere} disabled={!!busy || !cfg}>
                    {busy === 'device' && <Spinner className="size-4" />}
                    Turn on push here
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[420px] text-[15px]">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-2 font-medium">Notify me about</th>
              <th className="w-16 pb-2 text-center font-medium">In app</th>
              <th className="w-16 pb-2 text-center font-medium">Email</th>
              <th className="w-16 pb-2 text-center font-medium">Push</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {KINDS.map(({ kind, label }) => (
              <tr key={kind}>
                <td className="py-2 pr-3">{label}</td>
                {(['in_app', 'email', 'push'] as Channel[]).map((ch) => (
                  <td key={ch} className="py-2 text-center">
                    <input type="checkbox" className="size-5 accent-[var(--brand)]" checked={value(kind, ch)} disabled={!data} onChange={(e) => toggle(kind, ch, e.target.checked)}
                      aria-label={`${label}: ${ch === 'in_app' ? 'in app' : ch}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        Each notification reaches you once per channel. If push reaches one of your devices, the email for it is skipped.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" onClick={test} disabled={!!busy}>
          {busy === 'test' ? <Spinner className="size-4" /> : <BellRing className="size-4" aria-hidden="true" />}
          Send a test notification
        </button>
      </div>
      <RecentDeliveries />
    </div>
  )
}

const STATUS = { pending: 'Waiting', sent: 'Sent', skipped: 'Not sent', failed: 'Failed' }

function RecentDeliveries() {
  const userId = useAuth((s) => s.session?.user.id)
  const { data, reload } = useLoad(
    async () => unwrap(await supabase.from('notification_deliveries').select('id, channel, status, reason, created_at, notifications(title)').order('created_at', { ascending: false }).limit(8)) as unknown as Delivery[],
    [userId],
  )
  if (!data?.length) return null
  return (
    <details className="text-sm" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && reload()}>
      <summary className="cursor-pointer font-medium">Recent emails and push</summary>
      <ul className="mt-2 divide-y divide-line" aria-label="Recent deliveries">
        {data.map((d) => (
          <li key={d.id} className="flex flex-wrap gap-x-2 py-1.5">
            <span className="min-w-0 flex-1 break-words">{d.notifications?.title ?? 'Notification'}</span>
            <span className="text-muted">{d.channel === 'email' ? 'Email' : 'Push'} · {STATUS[d.status]}{d.reason ? ` (${d.reason})` : ''}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
