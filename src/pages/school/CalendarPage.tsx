import { AlertTriangle, CalendarPlus, Check, ChevronLeft, ChevronRight, Clock, Trash2, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { uniqueGrades, useStructure, type SchoolStructure } from '../../components/school/data'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { addDays, DAY_SHORT, todayISO, toISODate } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import {
  EVENT_LABEL,
  FLAG_LABEL,
  formatDateTime,
  formatDay,
  isStaff,
  SERIOUS_FLAGS,
  toLocalInput,
  withinOneMonth,
  type Assignment,
  type CalendarEvent,
  type DeadlineDay,
  type DeadlineRequest,
  type EventKind,
  type MyInstitution,
} from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

type View = 'month' | 'deadlines' | 'requests'

const KIND_TONE: Record<EventKind, string> = {
  exam: 'bg-brand-soft text-brand-ink',
  holiday: 'bg-success-soft text-success',
  event: 'bg-subtle text-ink',
  workshop: 'bg-subtle text-ink',
  programme: 'bg-subtle text-ink',
  ptm: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  other: 'bg-subtle text-ink',
}

export default function CalendarPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View) ?? 'month'
  const setView = (v: View) => setParams(v === 'month' ? {} : { view: v }, { replace: true })
  const structure = useStructure(inst.institution_id)
  const staff = isStaff(inst.role)
  const [adding, setAdding] = useState(false)
  // Remounts the views after an event is added so they refetch.
  const [version, setVersion] = useState(0)

  const views: { id: View; label: string; show: boolean }[] = [
    { id: 'month', label: 'Calendar', show: true },
    { id: 'deadlines', label: 'Cross-subject deadlines', show: true },
    { id: 'requests', label: 'Deadline changes', show: staff },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Academic calendar"
        description="Examinations, holidays, events and every assignment deadline in one place."
        actions={
          can('manage_calendar') && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <CalendarPlus className="size-4" aria-hidden="true" />
              Add event
            </button>
          )
        }
      />
      <div className="scrollbar-none flex w-full overflow-x-auto rounded-xl bg-subtle p-1 sm:w-fit" role="tablist" aria-label="Calendar view">
        {views
          .filter((v) => v.show)
          .map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={`h-9 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${view === v.id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
            >
              {v.label}
            </button>
          ))}
      </div>

      {structure.loading && !structure.data ? (
        <Loading />
      ) : structure.error || !structure.data ? (
        <ErrorNote>{structure.error}</ErrorNote>
      ) : view === 'month' ? (
        <MonthView key={version} inst={inst} s={structure.data} />
      ) : view === 'deadlines' ? (
        <DeadlineView key={version} inst={inst} s={structure.data} />
      ) : (
        <RequestsView inst={inst} s={structure.data} />
      )}

      {adding && structure.data && <EventModal inst={inst} s={structure.data} onClose={() => (setAdding(false), setVersion((v) => v + 1))} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Month view                                                          */
/* ------------------------------------------------------------------ */

function monthGrid(year: number, month: number) {
  const first = new Date(year, month, 1)
  const start = addDays(toISODate(first), -((first.getDay() + 6) % 7)) // weeks start Monday
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function MonthView({ inst, s }: { inst: MyInstitution; s: SchoolStructure }) {
  const today = todayISO()
  const [cursor, setCursor] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }))
  const days = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor])
  const from = days[0]
  const to = days[days.length - 1]
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<CalendarEvent | null>(null)
  const { can } = useCurrentInstitution()

  const { data, error, loading, reload } = useLoad(async () => {
    const [events, deadlines] = await Promise.all([
      supabase.from('calendar_events').select('*').eq('institution_id', inst.institution_id).lte('starts_on', to).gte('ends_on', from).order('starts_on'),
      supabase.rpc('deadline_calendar', { p_inst: inst.institution_id, p_from: from, p_to: to }),
    ])
    return { events: unwrap(events) as CalendarEvent[], deadlines: unwrap(deadlines) as DeadlineDay[] }
  }, [inst.institution_id, from, to])

  const onDay = (d: string) => ({
    events: (data?.events ?? []).filter((e) => e.starts_on <= d && e.ends_on >= d),
    deadlines: (data?.deadlines ?? []).filter((x) => x.day === d),
  })
  const shift = (n: number) => setCursor(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }))
  const title = new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const focus = selected ?? (days.includes(today) ? today : null)
  const focusData = focus ? onDay(focus) : null
  const className = (id: string | null) => s.classes.find((c) => c.id === id)?.name

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 font-semibold">{title}</h2>
          {loading && <Spinner className="size-4" />}
          <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft className="size-5" />
          </button>
          <button type="button" className="btn-secondary h-9 px-3" onClick={() => (setCursor({ y: new Date().getFullYear(), m: new Date().getMonth() }), setSelected(today))}>
            Today
          </button>
          <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight className="size-5" />
          </button>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid-cols-7 text-center text-xs font-medium text-muted">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <div key={d} className="pb-2">
              {DAY_SHORT[d]}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-line bg-line">
          {days.map((d) => {
            const { events, deadlines } = onDay(d)
            const inMonth = Number(d.slice(5, 7)) - 1 === cursor.m
            const serious = deadlines.some((x) => x.flags.some((f) => SERIOUS_FLAGS.includes(f)))
            const count = deadlines.reduce((n, x) => n + x.deadline_count, 0)
            return (
              <button
                key={d}
                type="button"
                onClick={() => setSelected(d)}
                aria-label={`${formatDay(d)}: ${events.length} events, ${count} deadlines${serious ? ', has conflicts' : ''}`}
                aria-pressed={focus === d}
                className={`flex min-h-16 flex-col items-stretch gap-0.5 p-1 text-left sm:min-h-24 sm:p-1.5 ${inMonth ? 'bg-surface' : 'bg-subtle/60 text-muted'} ${focus === d ? 'ring-2 ring-brand ring-inset' : ''}`}
              >
                <span className={`flex items-center gap-1 text-xs font-medium ${d === today ? 'text-brand' : ''}`}>
                  {Number(d.slice(8))}
                  {serious && <AlertTriangle className="size-3 text-danger" aria-hidden="true" />}
                </span>
                {events.slice(0, 2).map((e) => (
                  <span key={e.id} className={`hidden truncate rounded px-1 text-[11px] leading-4 sm:block ${KIND_TONE[e.kind]} ${e.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>
                    {e.title}
                  </span>
                ))}
                {count > 0 && <span className="hidden truncate px-1 text-[11px] leading-4 text-muted sm:block">{count} due</span>}
                {/* Phones: dots only */}
                <span className="mt-auto flex gap-0.5 sm:hidden" aria-hidden="true">
                  {events.length > 0 && <span className="size-1.5 rounded-full bg-brand" />}
                  {count > 0 && <span className={`size-1.5 rounded-full ${serious ? 'bg-danger' : 'bg-muted'}`} />}
                </span>
              </button>
            )
          })}
        </div>
      </Panel>

      <Panel title={focus ? formatDay(focus) : 'Pick a day'}>
        {!focusData ? (
          <p className="text-sm text-muted">Select a day to see its events and deadlines.</p>
        ) : focusData.events.length === 0 && focusData.deadlines.length === 0 ? (
          <p className="text-sm text-muted">Nothing on this day.</p>
        ) : (
          <ul className="space-y-3">
            {focusData.events.map((e) => (
              <li key={e.id} className="rounded-xl border border-line p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium ${e.status === 'cancelled' ? 'line-through' : ''}`}>{e.title}</p>
                    <p className="text-sm text-muted">
                      {EVENT_LABEL[e.kind]}
                      {e.class_id ? ` · ${className(e.class_id)}` : e.grade ? ` · Grade ${e.grade}` : ' · Whole institution'}
                      {e.start_time ? ` · ${e.start_time.slice(0, 5)}${e.end_time ? `–${e.end_time.slice(0, 5)}` : ''}` : ''}
                    </p>
                    {e.description && <p className="mt-1 text-sm whitespace-pre-line">{e.description}</p>}
                  </div>
                  {can('manage_calendar') && (
                    <button type="button" className="btn-ghost h-8 px-2 text-sm" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                  )}
                </div>
              </li>
            ))}
            {focusData.deadlines.map((x) => (
              <li key={x.class_id} className="rounded-xl border border-line p-3">
                <p className="font-medium">
                  {x.class_name} <span className="text-sm font-normal text-muted">· {x.deadline_count} due</span>
                </p>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {x.deadlines.map((a) => (
                    <li key={a.id} className="truncate">
                      {a.title} <span className="text-muted">· {a.subject}</span>
                    </li>
                  ))}
                </ul>
                {x.flags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {x.flags.map((f) => (
                      <Pill key={f} tone={SERIOUS_FLAGS.includes(f) ? 'danger' : 'muted'}>
                        {FLAG_LABEL[f]}
                      </Pill>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing && <EventModal inst={inst} s={s} event={editing} onClose={() => (setEditing(null), reload())} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Cross-subject deadline calendar                                     */
/* ------------------------------------------------------------------ */

function DeadlineView({ inst, s }: { inst: MyInstitution; s: SchoolStructure }) {
  const today = todayISO()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(addDays(today, 30))
  const [classId, setClassId] = useState('')
  const [grade, setGrade] = useState('')
  const [subject, setSubject] = useState('')
  const [teacher, setTeacher] = useState('')
  const [onlyConflicts, setOnlyConflicts] = useState(false)
  const [proposing, setProposing] = useState<{ id: string; title: string; opens_at: string; due_at: string } | null>(null)
  const staff = isStaff(inst.role)

  const { data, error, loading } = useLoad(
    async () =>
      unwrap(
        await supabase.rpc('deadline_calendar', {
          p_inst: inst.institution_id,
          p_from: from,
          p_to: to,
          p_class: classId || null,
          p_grade: grade || null,
          p_subject: subject || null,
          p_teacher: teacher || null,
        }),
      ) as DeadlineDay[],
    [inst.institution_id, from, to, classId, grade, subject, teacher],
  )

  const rows = (data ?? []).filter((d) => !onlyConflicts || d.flags.some((f) => SERIOUS_FLAGS.includes(f)))
  const teachers = s.members.filter((m) => s.teaching.some((t) => t.teacher_id === m.id))
  const conflictCount = (data ?? []).filter((d) => d.flags.some((f) => SERIOUS_FLAGS.includes(f))).length

  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <Field label="To" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          <SelectField label="Grade" value={grade} onChange={(e) => (setGrade(e.target.value), setClassId(''))}>
            <option value="">All</option>
            {uniqueGrades(s.classes).map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </SelectField>
          <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">All</option>
            {s.classes
              .filter((c) => !c.archived && (!grade || c.grade === grade))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </SelectField>
          <SelectField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">All</option>
            {s.subjects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          {staff && (
            <SelectField label="Teacher" value={teacher} onChange={(e) => setTeacher(e.target.value)}>
              <option value="">All</option>
              {teachers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </SelectField>
          )}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={onlyConflicts} onChange={(e) => setOnlyConflicts(e.target.checked)} />
          Only show days with conflicts ({conflictCount})
        </label>
      </Panel>

      <ErrorNote>{error}</ErrorNote>
      {loading && !data ? (
        <Loading />
      ) : (
        <Panel>
          <List empty={onlyConflicts ? 'No conflicts in this range.' : 'No deadlines or exams in this range.'}>
            {rows.map((d) => (
              <Row key={`${d.day}-${d.class_id}`} className="items-start sm:items-start">
                <div className="w-36 shrink-0">
                  <p className="font-medium">{formatDay(d.day)}</p>
                  <p className="text-sm text-muted">{d.class_name}</p>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  {d.exams.map((e) => (
                    <p key={e.id} className="text-sm">
                      <Pill tone="brand">Exam</Pill> {e.title}
                      {e.subject && <span className="text-muted"> · {e.subject}</span>}
                    </p>
                  ))}
                  {d.deadlines.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                      <Clock className="size-3.5 text-muted" aria-hidden="true" />
                      <span className="font-medium">{a.title}</span>
                      <span className="text-muted">
                        {a.subject} · {a.teacher} · due {new Date(a.due_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </span>
                      {staff && (
                        <button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => setProposing(a)}>
                          Propose new date
                        </button>
                      )}
                    </div>
                  ))}
                  {d.is_holiday && <p className="text-sm text-muted">Holiday: {d.holiday}</p>}
                </div>
                <div className="flex flex-wrap gap-1 sm:max-w-56 sm:justify-end">
                  {d.flags.map((f) => (
                    <Pill key={f} tone={SERIOUS_FLAGS.includes(f) ? 'danger' : 'muted'}>
                      {FLAG_LABEL[f]}
                    </Pill>
                  ))}
                  <span className="text-xs text-muted">{d.week_deadlines} this week</span>
                </div>
              </Row>
            ))}
          </List>
          <p className="mt-3 text-xs text-muted">Submission and completion statistics appear here once homework submissions are enabled (Phase 2).</p>
        </Panel>
      )}
      {proposing && <ProposeModal inst={inst} assignment={proposing} onClose={() => setProposing(null)} />}
    </div>
  )
}

function ProposeModal({ inst, assignment, onClose }: { inst: MyInstitution; assignment: { id: string; title: string; opens_at: string; due_at: string }; onClose: () => void }) {
  const [due, setDue] = useState(toLocalInput(assignment.due_at))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const dueDate = new Date(due)
    const opens = new Date(assignment.opens_at)
    if (!(dueDate > opens)) return setError('The deadline must be after the submission start.')
    if (!withinOneMonth(opens, dueDate)) return setError('The submission window can’t be longer than one calendar month.')
    if (reason.trim().length < 3) return setError('Explain why (at least 3 characters).')
    setBusy(true)
    const { error: err } = await supabase.from('deadline_change_requests').insert({
      institution_id: inst.institution_id,
      assignment_id: assignment.id,
      proposed_due_at: dueDate.toISOString(),
      reason: reason.trim(),
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Change proposed. The teacher or a coordinator can approve it.')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Propose a new deadline"
      subtitle={assignment.title}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="propose" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Propose
          </button>
        </>
      }
    >
      <form id="propose" onSubmit={submit} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <p className="text-sm text-muted">Current deadline: {formatDateTime(assignment.due_at)}. Nothing changes until it is approved.</p>
        <Field label="New deadline" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Clashes with the maths unit test" />
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Deadline change requests                                            */
/* ------------------------------------------------------------------ */

function RequestsView({ inst, s }: { inst: MyInstitution; s: SchoolStructure }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const reqs = unwrap(
      await supabase.from('deadline_change_requests').select('*').eq('institution_id', inst.institution_id).order('created_at', { ascending: false }).limit(100),
    ) as DeadlineRequest[]
    const ids = [...new Set(reqs.map((r) => r.assignment_id))]
    const assignments = ids.length ? (unwrap(await supabase.from('assignments').select('*').in('id', ids)) as Assignment[]) : []
    return { reqs, assignments }
  }, [inst.institution_id])

  const decide = async (id: string, approve: boolean) => {
    const { error: err } = await supabase.rpc('decide_deadline_change', { p_request: id, p_approve: approve })
    if (err) toast.error(friendlyError(err))
    else {
      toast.success(approve ? 'Deadline changed.' : 'Request declined.')
      reload()
    }
  }

  if (loading && !data) return <Loading />
  return (
    <Panel description="Proposed changes to assignment deadlines. Approving applies the change and records it in the audit history.">
      <ErrorNote>{error}</ErrorNote>
      <List empty="No deadline change requests.">
        {(data?.reqs ?? []).map((r) => {
          const a = data!.assignments.find((x) => x.id === r.assignment_id)
          return (
            <Row key={r.id}>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {a?.title ?? 'Assignment'}{' '}
                  <span className="text-sm font-normal text-muted">
                    · {s.classes.find((c) => c.id === a?.class_id)?.name} · {s.subjects.find((x) => x.id === a?.subject_id)?.name}
                  </span>
                </p>
                <p className="text-sm">
                  {a && <span className="text-muted">{formatDateTime(a.due_at)} → </span>}
                  <strong>{formatDateTime(r.proposed_due_at)}</strong>
                </p>
                <p className="text-sm text-muted">“{r.reason}”</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={r.status === 'approved' ? 'success' : r.status === 'pending' ? 'brand' : 'muted'}>{r.status}</Pill>
                {r.status === 'pending' && (
                  <>
                    <button type="button" className="btn-secondary h-9 px-3" onClick={() => decide(r.id, true)}>
                      <Check className="size-4" aria-hidden="true" />
                      Approve
                    </button>
                    <button type="button" className="btn-ghost h-9 px-3" onClick={() => decide(r.id, false)}>
                      <X className="size-4" aria-hidden="true" />
                      Decline
                    </button>
                  </>
                )}
              </div>
            </Row>
          )
        })}
      </List>
    </Panel>
  )
}

/* ------------------------------------------------------------------ */
/* Add / edit event                                                    */
/* ------------------------------------------------------------------ */

function EventModal({ inst, s, event, onClose }: { inst: MyInstitution; s: SchoolStructure; event?: CalendarEvent; onClose: () => void }) {
  const [kind, setKind] = useState<EventKind>(event?.kind ?? 'exam')
  const [title, setTitle] = useState(event?.title ?? '')
  const [startsOn, setStartsOn] = useState(event?.starts_on ?? todayISO())
  const [endsOn, setEndsOn] = useState(event?.ends_on ?? todayISO())
  const [startTime, setStartTime] = useState(event?.start_time?.slice(0, 5) ?? '')
  const [endTime, setEndTime] = useState(event?.end_time?.slice(0, 5) ?? '')
  const [scope, setScope] = useState(event?.class_id ? `class:${event.class_id}` : event?.grade ? `grade:${event.grade}` : 'all')
  const [subject, setSubject] = useState(event?.subject_id ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('Give the event a title.')
    if (endsOn < startsOn) return setError('The end date can’t be before the start date.')
    if (startTime && endTime && endTime <= startTime) return setError('The end time must be after the start time.')
    const row = {
      kind,
      title: title.trim(),
      starts_on: startsOn,
      ends_on: endsOn,
      start_time: startTime || null,
      end_time: endTime || null,
      class_id: scope.startsWith('class:') ? scope.slice(6) : null,
      grade: scope.startsWith('grade:') ? scope.slice(6) : null,
      subject_id: subject || null,
      description: description.trim() || null,
    }
    setBusy(true)
    const { error: err } = event
      ? await supabase.from('calendar_events').update(row).eq('id', event.id)
      : await supabase.from('calendar_events').insert({ ...row, institution_id: inst.institution_id })
    setBusy(false)
    if (err) return setError(/row-level security/i.test(err.message) ? 'You can only add events for the grades and classes you manage.' : friendlyError(err))
    toast.success(event ? 'Event updated.' : 'Event added.')
    onClose()
  }

  const setStatus = async (status: 'scheduled' | 'cancelled') => {
    const { error: err } = await supabase.from('calendar_events').update({ status }).eq('id', event!.id)
    if (err) return setError(friendlyError(err))
    onClose()
  }
  const remove = async () => {
    const { error: err } = await supabase.from('calendar_events').delete().eq('id', event!.id)
    if (err) return setError(friendlyError(err))
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={event ? 'Edit event' : 'Add event'}
      size="lg"
      footer={
        <>
          {event && (
            <div className="mr-auto flex gap-1">
              <button type="button" className="btn-ghost h-10 px-3" onClick={() => setStatus(event.status === 'cancelled' ? 'scheduled' : 'cancelled')}>
                {event.status === 'cancelled' ? 'Restore' : 'Cancel event'}
              </button>
              <button type="button" className="icon-btn text-danger" onClick={remove} aria-label="Delete event">
                <Trash2 className="size-4" />
              </button>
            </div>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" form="event-form" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Save
          </button>
        </>
      }
    >
      <form id="event-form" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
            {(Object.keys(EVENT_LABEL) as EventKind[]).map((k) => (
              <option key={k} value={k}>
                {EVENT_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Applies to" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">Whole institution</option>
            {uniqueGrades(s.classes).map((g) => (
              <option key={g} value={`grade:${g}`}>
                Grade {g}
              </option>
            ))}
            {s.classes
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={`class:${c.id}`}>
                  Class {c.name}
                </option>
              ))}
          </SelectField>
        </div>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" type="date" value={startsOn} onChange={(e) => (setStartsOn(e.target.value), endsOn < e.target.value && setEndsOn(e.target.value))} />
          <Field label="Ends" type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />
          <Field label="Start time (optional)" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Field label="End time (optional)" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        {kind === 'exam' && (
          <SelectField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">Several / not specific</option>
            {s.subjects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
        )}
        <TextArea label="Details (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </form>
    </Modal>
  )
}

