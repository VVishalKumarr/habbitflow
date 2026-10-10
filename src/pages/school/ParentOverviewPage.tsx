import { Award, CalendarCheck, ClipboardList, MessageSquare, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { STATUS_LABEL, STATUS_TONE, type SubmissionStatus } from '../../components/school/Submissions'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, Stat } from '../../components/school/ui'
import { EmptyState } from '../../components/ui/EmptyState'
import { DAY_SHORT } from '../../lib/dates'
import { EVENT_LABEL, formatDateTime, formatDay, type EventKind } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'

interface Child {
  student_id: string
  institution_id: string
  institution: string
  name: string
  relationship: string
  classes: string | null
}

interface ChildView {
  student: { id: string; name: string }
  classes: { id: string; name: string; grade: string; class_teacher: string | null }[]
  timetable: { day: number; start: string; end: string; subject: string | null; label: string | null; room: string | null }[]
  assignments: { id: string; title: string; kind: string; subject: string; opens_at: string; due_at: string; status: SubmissionStatus; is_late: boolean; feedback: string | null }[]
  attendance: { date: string; period: number; subject: string | null; status: string }[]
  marks: { title: string; kind: string; subject: string; date: string; max: number; obtained: number | null; absent: boolean; feedback: string | null; grade: string | null }[]
  events: { id: string; kind: EventKind; title: string; starts_on: string; ends_on: string; start_time: string | null; subject: string | null }[]
}

const CHILD_KEY = 'habitflow-child'

/** Parent dashboard: only verified, linked children (guardian_children / guardian_child_view). */
export default function ParentOverviewPage() {
  const kids = useLoad(async () => unwrap(await supabase.rpc('guardian_children')) as Child[], [])
  const [childId, setChildId] = useState<string | null>(null)

  useEffect(() => {
    if (!kids.data?.length) return
    let stored: string | null = null
    try {
      stored = localStorage.getItem(CHILD_KEY)
    } catch {
      /* storage unavailable */
    }
    setChildId((c) => c ?? kids.data!.find((k) => k.student_id === stored)?.student_id ?? kids.data![0].student_id)
  }, [kids.data])

  const view = useLoad(async () => (childId ? (unwrap(await supabase.rpc('guardian_child_view', { p_student: childId })) as ChildView) : null), [childId])

  if (kids.loading && !kids.data) return <Loading />
  if (kids.error) return <ErrorNote>{kids.error}</ErrorNote>
  if (!kids.data?.length) {
    return (
      <div className="card">
        <EmptyState icon={Users} title="No linked children" message="When your child adds you as a parent or guardian and the school approves it, their information appears here." />
      </div>
    )
  }

  const pick = (id: string) => {
    setChildId(id)
    try {
      localStorage.setItem(CHILD_KEY, id)
    } catch {
      /* storage unavailable */
    }
  }
  const v = view.data
  const recent = v?.attendance ?? []
  const present = recent.filter((a) => a.status === 'present' || a.status === 'late').length
  const scored = (v?.marks ?? []).filter((m) => !m.absent && m.obtained !== null)
  const avg = scored.length ? scored.reduce((n, m) => n + (Number(m.obtained) / Number(m.max)) * 100, 0) / scored.length : null
  const now = Date.now()
  const due = (v?.assignments ?? []).filter((a) => new Date(a.due_at).getTime() > now)

  return (
    <div className="space-y-5">
      <PageHeader
        title={v ? v.student.name : 'Your child'}
        description={v ? v.classes.map((c) => `${c.name}${c.class_teacher ? ` · class teacher ${c.class_teacher}` : ''}`).join(' · ') : undefined}
        actions={
          <Link to="/school/messages" className="btn-secondary">
            <MessageSquare className="size-4" aria-hidden="true" />
            Message a teacher
          </Link>
        }
      />
      {kids.data.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Child">
          {kids.data.map((k) => (
            <button
              key={k.student_id}
              type="button"
              role="tab"
              aria-selected={k.student_id === childId}
              onClick={() => pick(k.student_id)}
              className={`h-10 rounded-xl px-4 text-sm font-medium ${k.student_id === childId ? 'bg-brand text-white' : 'border border-line bg-surface text-muted hover:text-ink'}`}
            >
              {k.name}
            </button>
          ))}
        </div>
      )}
      {view.loading && !v ? (
        <Loading />
      ) : !v ? (
        <ErrorNote>{view.error}</ErrorNote>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat icon={ClipboardList} label="Homework due" value={due.length} hint={`${due.filter((a) => a.status === 'not_submitted').length} not submitted yet`} />
            <Stat icon={CalendarCheck} label="Attendance (60 days)" value={recent.length ? `${Math.round((present / recent.length) * 100)}%` : '—'} hint={recent.length ? `${recent.length} sessions` : 'Nothing recorded'} tone="muted" />
            <Stat icon={Award} label="Average mark" value={avg === null ? '—' : `${avg.toFixed(0)}%`} hint={scored.length ? `${scored.length} published` : 'No marks yet'} tone="muted" />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel title="Homework and deadlines" description="Last 45 days and upcoming. Teachers decide when work is accepted.">
              <List empty="No homework yet.">
                {v.assignments.slice(0, 12).map((a) => (
                  <Row key={a.id}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.title}</p>
                      <p className="text-sm text-muted">
                        {a.subject} · due {formatDateTime(a.due_at)}
                      </p>
                      {a.feedback && <p className="mt-0.5 text-sm">“{a.feedback}”</p>}
                    </div>
                    <span className="flex gap-1">
                      <Pill tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Pill>
                      {a.is_late && <Pill tone="warning">Late</Pill>}
                    </span>
                  </Row>
                ))}
              </List>
            </Panel>
            <Panel title="Marks and feedback">
              <List empty="No published marks yet.">
                {v.marks.slice(0, 12).map((m, i) => (
                  <Row key={i}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{m.title}</p>
                      <p className="text-sm text-muted">
                        {m.subject} · {formatDay(m.date)}
                      </p>
                      {m.feedback && <p className="mt-0.5 text-sm">“{m.feedback}”</p>}
                    </div>
                    {m.absent ? <Pill>Absent</Pill> : <span className="font-semibold tabular-nums">{Number(m.obtained)}/{Number(m.max)}{m.grade && <span className="ml-1.5 text-sm font-normal text-muted">{m.grade}</span>}</span>}
                  </Row>
                ))}
              </List>
            </Panel>
            <Panel title="Exams and events (next 60 days)">
              <List empty="Nothing scheduled.">
                {v.events.map((e) => (
                  <Row key={e.id}>
                    <span className="w-28 shrink-0 text-sm font-medium">{formatDay(e.starts_on)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {e.title}
                      {e.subject && <span className="text-muted"> · {e.subject}</span>}
                    </span>
                    <Pill tone={e.kind === 'exam' ? 'brand' : 'muted'}>{EVENT_LABEL[e.kind]}</Pill>
                  </Row>
                ))}
              </List>
            </Panel>
            <Panel title="Attendance">
              <List empty="Nothing recorded in the last 60 days.">
                {v.attendance.slice(0, 15).map((a, i) => (
                  <Row key={i} className="py-2">
                    <span className="w-28 shrink-0 text-sm font-medium">{formatDay(a.date)}</span>
                    <span className="flex-1 text-sm text-muted">{a.subject ?? 'Daily register'}</span>
                    <Pill tone={a.status === 'present' ? 'success' : a.status === 'absent' ? 'danger' : 'warning'}>{a.status}</Pill>
                  </Row>
                ))}
              </List>
            </Panel>
          </div>

          {v.timetable.length > 0 && (
            <Panel title="Class timetable">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3, 4, 5, 6, 0]
                  .filter((d) => v.timetable.some((p) => p.day === d))
                  .map((d) => (
                    <div key={d} className="rounded-xl border border-line p-3">
                      <p className="mb-1.5 text-sm font-semibold">{DAY_SHORT[d]}</p>
                      <ul className="space-y-1 text-sm">
                        {v.timetable
                          .filter((p) => p.day === d)
                          .map((p, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="w-24 shrink-0 text-muted tabular-nums">
                                {p.start.slice(0, 5)}–{p.end.slice(0, 5)}
                              </span>
                              <span className="truncate">{p.subject ?? p.label}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}
