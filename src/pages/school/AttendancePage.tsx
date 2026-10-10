import { Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useStructure, type SchoolStructure } from '../../components/school/data'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, Stat, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { addDays, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import { formatDay, isHead, type InstitutionSettings, type MyInstitution } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'
import { CalendarCheck } from 'lucide-react'

interface AttendanceRecord {
  id: string
  class_id: string
  subject_id: string | null
  session_date: string
  period: number
  student_id: string
  status: string
  note: string | null
  correction_reason: string | null
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'muted'> = { present: 'success', absent: 'danger', late: 'warning', excused: 'muted' }

export default function AttendancePage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const structure = useStructure(inst.institution_id)
  const settings = useLoad(async () => unwrap(await supabase.rpc('institution_settings', { p_inst: inst.institution_id })) as InstitutionSettings, [inst.institution_id])
  if (structure.loading && !structure.data) return <Loading />
  if (!structure.data || !settings.data) return <ErrorNote>{structure.error ?? settings.error}</ErrorNote>
  return inst.role === 'student' ? (
    <StudentAttendance inst={inst} s={structure.data} />
  ) : (
    <Register inst={inst} s={structure.data} statuses={settings.data.attendance_statuses} />
  )
}

/** Sessions the signed-in teacher may record: daily for their own class, per subject they teach. */
function useSessions(inst: MyInstitution, s: SchoolStructure) {
  return useMemo(() => {
    const out: { value: string; label: string; classId: string; subjectId: string | null }[] = []
    for (const c of s.classes.filter((x) => !x.archived)) {
      const head = isHead(inst.role)
      if (head || c.class_teacher_id === inst.membership_id) out.push({ value: `${c.id}|`, label: `${c.name} · daily register`, classId: c.id, subjectId: null })
      for (const t of s.teaching.filter((x) => x.class_id === c.id && (head || x.teacher_id === inst.membership_id))) {
        const sub = s.subjects.find((x) => x.id === t.subject_id)
        const v = `${c.id}|${t.subject_id}`
        if (sub && !out.some((o) => o.value === v)) out.push({ value: v, label: `${c.name} · ${sub.name}`, classId: c.id, subjectId: t.subject_id })
      }
    }
    return out
  }, [inst, s])
}

function Register({ inst, s, statuses }: { inst: MyInstitution; s: SchoolStructure; statuses: string[] }) {
  const { can } = useCurrentInstitution()
  const sessions = useSessions(inst, s)
  const [session, setSession] = useState(sessions[0]?.value ?? '')
  const [date, setDate] = useState(todayISO())
  const [period, setPeriod] = useState(0)
  const [marks, setMarks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [needReason, setNeedReason] = useState(false)
  const chosen = sessions.find((x) => x.value === session)
  const students = chosen
    ? s.members.filter((m) => s.enrollments.some((e) => e.class_id === chosen.classId && e.student_id === m.id)).sort((a, b) => a.display_name.localeCompare(b.display_name))
    : []

  const existing = useLoad(async () => {
    if (!chosen) return [] as AttendanceRecord[]
    let q = supabase.from('attendance_records').select('*').eq('class_id', chosen.classId).eq('session_date', date).eq('period', period)
    q = chosen.subjectId ? q.eq('subject_id', chosen.subjectId) : q.is('subject_id', null)
    return unwrap(await q) as AttendanceRecord[]
  }, [session, date, period])

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const r of existing.data ?? []) next[r.student_id] = r.status
    setMarks(next)
  }, [existing.data])

  const recorded = (existing.data ?? []).length > 0
  const save = async (reason?: string) => {
    if (!chosen) return
    const entries = students.filter((m) => marks[m.id]).map((m) => ({ student_id: m.id, status: marks[m.id] }))
    if (entries.length === 0) return toast.error('Mark at least one student.')
    setBusy(true)
    const { data, error } = await supabase.rpc('record_attendance', {
      p_class: chosen.classId,
      p_subject: chosen.subjectId,
      p_date: date,
      p_period: period,
      p_entries: entries,
      p_reason: reason ?? null,
    })
    setBusy(false)
    if (error) {
      if (/CORRECTION_REASON_REQUIRED/.test(error.message)) return setNeedReason(true)
      return toast.error(friendlyError(error))
    }
    setNeedReason(false)
    toast.success(data ? `Saved ${data} record${data === 1 ? '' : 's'}.` : 'No changes.')
    existing.reload()
  }

  if (!can('record_attendance') || sessions.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader title="Attendance" />
        <Summary inst={inst} s={s} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Attendance" description="Record attendance for your class or the subjects you teach. Changing a saved record needs a reason and keeps the previous value in the audit history." />
      <Panel>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_160px]">
          <SelectField label="Class / session" value={session} onChange={(e) => setSession(e.target.value)}>
            {sessions.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </SelectField>
          <Field label="Date" type="date" value={date} max={todayISO()} min={addDays(todayISO(), -366)} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <SelectField label="Period" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
            <option value={0}>Whole day</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                Period {i + 1}
              </option>
            ))}
          </SelectField>
        </div>
      </Panel>
      <Panel
        title={`${chosen?.label ?? ''} · ${formatDay(date)}`}
        description={recorded ? 'Already recorded — changes are corrections.' : 'Not recorded yet.'}
        actions={
          <>
            <button type="button" className="btn-ghost h-9 px-3" disabled={existing.loading} onClick={() => setMarks(Object.fromEntries(students.map((m) => [m.id, 'present'])))}>
              All present
            </button>
            <button type="button" className="btn-primary h-9 px-3" onClick={() => save()} disabled={busy || existing.loading}>
              {busy ? <Spinner className="size-4" /> : <Save className="size-4" aria-hidden="true" />}
              Save
            </button>
          </>
        }
      >
        {existing.loading ? (
          <Loading />
        ) : (
          <List empty="No students in this class.">
            {students.map((m) => (
              <Row key={m.id} className="py-2">
                <span className="min-w-0 flex-1 truncate font-medium">{m.display_name}</span>
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Attendance for ${m.display_name}`}>
                  {statuses.map((st) => (
                    <button
                      key={st}
                      type="button"
                      role="radio"
                      aria-checked={marks[m.id] === st}
                      onClick={() => setMarks({ ...marks, [m.id]: st })}
                      className={`h-9 rounded-lg border px-3 text-sm font-medium transition-colors ${
                        marks[m.id] === st ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-muted hover:text-ink'
                      }`}
                    >
                      {label(st)}
                    </button>
                  ))}
                </div>
              </Row>
            ))}
          </List>
        )}
      </Panel>
      <Summary inst={inst} s={s} />
      {needReason && <ReasonModal busy={busy} onClose={() => setNeedReason(false)} onSave={(r) => save(r)} />}
    </div>
  )
}

function ReasonModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title="Reason for the correction"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => onSave(reason.trim())}>
            Save correction
          </button>
        </>
      }
    >
      <TextArea label="Why is this record changing?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} hint="Kept with the previous value in the audit history." />
    </Modal>
  )
}

/** Attendance rates over the last 30 days for the classes the viewer can see. */
function Summary({ inst, s }: { inst: MyInstitution; s: SchoolStructure }) {
  const since = addDays(todayISO(), -30)
  const { data } = useLoad(
    async () => unwrap(await supabase.from('attendance_records').select('class_id, student_id, status').eq('institution_id', inst.institution_id).gte('session_date', since).limit(5000)) as AttendanceRecord[],
    [inst.institution_id],
  )
  const byClass = s.classes
    .map((c) => {
      const recs = (data ?? []).filter((r) => r.class_id === c.id)
      const present = recs.filter((r) => r.status === 'present' || r.status === 'late').length
      return { c, n: recs.length, rate: recs.length ? present / recs.length : null }
    })
    .filter((x) => x.n > 0)
  return (
    <Panel title="Last 30 days" description="Present or late, as a share of recorded sessions.">
      <List empty="No attendance recorded in the last 30 days.">
        {byClass.map(({ c, n, rate }) => (
          <Row key={c.id} className="py-2">
            <span className="flex-1 font-medium">{c.name}</span>
            <span className="text-sm text-muted">{n} records</span>
            <Pill tone={rate! >= 0.9 ? 'success' : rate! >= 0.75 ? 'warning' : 'danger'}>{Math.round(rate! * 100)}%</Pill>
          </Row>
        ))}
      </List>
    </Panel>
  )
}

function StudentAttendance({ inst, s }: { inst: MyInstitution; s: SchoolStructure }) {
  const { data, loading } = useLoad(
    async () => unwrap(await supabase.from('attendance_records').select('*').eq('institution_id', inst.institution_id).order('session_date', { ascending: false }).limit(400)) as AttendanceRecord[],
    [inst.institution_id],
  )
  if (loading && !data) return <Loading />
  const recs = data ?? []
  const present = recs.filter((r) => r.status === 'present' || r.status === 'late').length
  return (
    <div className="space-y-5">
      <PageHeader title="Your attendance" description="Recorded by your teachers. If something looks wrong, ask your class teacher — they can correct it." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat icon={CalendarCheck} label="Attendance rate" value={recs.length ? `${Math.round((present / recs.length) * 100)}%` : '—'} hint={recs.length ? `${recs.length} sessions` : 'Nothing recorded yet'} />
        <Stat icon={CalendarCheck} label="Absent" value={recs.filter((r) => r.status === 'absent').length} tone="muted" />
        <Stat icon={CalendarCheck} label="Late" value={recs.filter((r) => r.status === 'late').length} tone="muted" />
      </div>
      <Panel>
        <List empty="No attendance recorded yet.">
          {recs.map((r) => (
            <Row key={r.id} className="py-2">
              <span className="w-32 shrink-0 text-sm font-medium">{formatDay(r.session_date)}</span>
              <span className="flex-1 text-sm text-muted">
                {r.subject_id ? s.subjects.find((x) => x.id === r.subject_id)?.name : 'Daily register'}
                {r.period ? ` · period ${r.period}` : ''}
              </span>
              <Pill tone={TONE[r.status] ?? 'muted'}>{label(r.status)}</Pill>
            </Row>
          ))}
        </List>
      </Panel>
    </div>
  )
}
