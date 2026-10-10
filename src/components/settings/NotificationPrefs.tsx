import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useAuth } from '../../store/auth'
import { toast } from '../../store/ui'

const KINDS: { kind: string; label: string }[] = [
  { kind: 'deadline_reminder', label: 'Homework due within 24 hours' },
  { kind: 'overdue', label: 'Overdue homework' },
  { kind: 'exam_reminder', label: 'Exams tomorrow' },
  { kind: 'submission_received', label: 'Submission confirmations' },
  { kind: 'submission_reviewed', label: 'Teacher feedback on work' },
  { kind: 'marks_published', label: 'New marks' },
  { kind: 'announcement', label: 'School announcements' },
  { kind: 'timetable_changed', label: 'Your class teacher changed your timetable' },
  { kind: 'message', label: 'Messages' },
  { kind: 'meeting_request', label: 'Meeting requests' },
  { kind: 'guardian_request', label: 'Parent link requests (staff)' },
]

/** Per-kind in-app notification switches. Email and push need server setup (NOTIFICATIONS.md). */
export function NotificationPrefs() {
  const userId = useAuth((s) => s.session?.user.id)
  const { data, setData } = useLoad(async () => unwrap(await supabase.from('notification_prefs').select('kind, in_app')) as { kind: string; in_app: boolean }[], [userId])
  const on = (kind: string) => data?.find((p) => p.kind === kind)?.in_app ?? true

  const toggle = async (kind: string, value: boolean) => {
    setData([...(data ?? []).filter((p) => p.kind !== kind), { kind, in_app: value }])
    const { error } = await supabase.from('notification_prefs').upsert({ user_id: userId, kind, in_app: value, updated_at: new Date().toISOString() })
    if (error) toast.error('Couldn’t save. Please try again.')
  }

  return (
    <div className="space-y-3">
      {KINDS.map(({ kind, label }) => (
        <label key={kind} className="flex items-center justify-between gap-4 text-[15px]">
          <span>{label}</span>
          <input type="checkbox" className="size-5 shrink-0 accent-[var(--brand)]" checked={on(kind)} onChange={(e) => toggle(kind, e.target.checked)} />
        </label>
      ))}
      <p className="text-sm text-muted">These control in-app notifications. Email and phone notifications will appear here once your institution’s administrator turns them on.</p>
    </div>
  )
}
