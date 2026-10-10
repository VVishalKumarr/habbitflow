import { AlertTriangle, Award, BookOpenCheck, CalendarCheck, CalendarClock, CalendarDays, ClipboardList, GraduationCap, MailPlus, ShieldAlert, UserCog, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { StudentGuardians } from '../../components/school/Guardians'
import { ErrorNote, Loading, Panel, PageHeader, Pill, Stat } from '../../components/school/ui'
import ParentOverviewPage from './ParentOverviewPage'
import { addDays } from '../../lib/dates'
import {
  EVENT_LABEL,
  FLAG_LABEL,
  formatDay,
  isHead,
  isStaff,
  ROLE_LABEL,
  SERIOUS_FLAGS,
  type CalendarEvent,
  type DeadlineDay,
  type Overview,
} from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'

interface TodayPeriod {
  start_time: string
  end_time: string
  label: string | null
  subjects: { name: string } | null
}

interface AcademicSummary {
  attendance: { records: number; present_rate: number | null }
  homework: { expected: number; submitted: number; accepted: number; completion_rate: number | null }
  marks: { marks: number; average_pct: number | null }
}

const GREETING: Record<string, string> = {
  principal: 'Institution overview',
  director: 'Institution overview',
  coordinator: 'Coordination overview',
  class_teacher: 'Your class at a glance',
  subject_teacher: 'Your teaching at a glance',
  student: 'Your school week',
}

export default function OverviewPage() {
  const { current } = useCurrentInstitution()
  return current?.role === 'parent' ? <ParentOverviewPage /> : <InstitutionOverview />
}

function InstitutionOverview() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const { data, error, loading } = useLoad(async () => {
    const overview = unwrap(await supabase.rpc('institution_overview', { p_inst: inst.institution_id })) as Overview
    const from = overview.today
    const to = addDays(from, 14)
    const [days, events] = await Promise.all([
      supabase.rpc('deadline_calendar', { p_inst: inst.institution_id, p_from: from, p_to: to }),
      supabase
        .from('calendar_events')
        .select('*')
        .eq('institution_id', inst.institution_id)
        .eq('status', 'scheduled')
        .gte('ends_on', from)
        .lte('starts_on', to)
        .order('starts_on')
        .limit(8),
    ])
    const summary = unwrap(await supabase.rpc('academic_summary', { p_inst: inst.institution_id })) as AcademicSummary
    const today = new Date().getDay()
    const periods =
      inst.role === 'student'
        ? (unwrap(await supabase.from('class_periods').select('start_time, end_time, label, subjects(name)').eq('day_of_week', today).order('start_time')) as unknown as TodayPeriod[])
        : []
    return { overview, days: unwrap(days) as DeadlineDay[], events: unwrap(events) as CalendarEvent[], summary, periods }
  }, [inst.institution_id])

  if (loading && !data) return <Loading />
  if (error || !data) return <ErrorNote>{error}</ErrorNote>

  const { overview: o, days, events, summary, periods } = data
  const staffView = isStaff(inst.role)
  const conflicts = days.filter((d) => d.flags.some((f) => SERIOUS_FLAGS.includes(f)))
  const upcoming = days.flatMap((d) => d.deadlines.map((x) => ({ ...x, class_name: d.class_name, day: d.day }))).slice(0, 8)

  return (
    <div className="space-y-5">
      <PageHeader
        title={GREETING[inst.role] ?? 'Overview'}
        description={
          <>
            {inst.name}
            {o.current_year && <> · Academic year {o.current_year.name}</>}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {staffView ? (
          <>
            <Stat icon={GraduationCap} label={isHead(inst.role) ? 'Students' : 'Students you can see'} value={o.students} />
            <Stat icon={Users} label="Staff" value={o.staff} hint={staffHint(o)} />
            <Stat icon={BookOpenCheck} label={isHead(inst.role) ? 'Classes' : 'Your classes'} value={o.classes} hint={`${o.subjects} subjects`} />
            <Stat
              icon={AlertTriangle}
              label="Deadline conflicts (30 days)"
              value={o.conflicts_30d}
              tone={o.conflicts_30d ? 'danger' : 'success'}
              hint={<Link to="/school/calendar?view=deadlines" className="text-brand hover:underline">Open deadline calendar</Link>}
            />
          </>
        ) : (
          <>
            <Stat icon={ClipboardList} label="Due in the next 7 days" value={o.deadlines_7d} />
            <Stat icon={CalendarClock} label="Exams in the next 14 days" value={o.upcoming_exams} />
            <Stat icon={BookOpenCheck} label="Your classes" value={o.classes} />
            <Stat icon={AlertTriangle} label="Busy days ahead" value={conflicts.length} tone={conflicts.length ? 'danger' : 'success'} />
          </>
        )}
      </div>

      {staffView && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat icon={ClipboardList} label="Deadlines in the next 7 days" value={o.deadlines_7d} tone="muted" />
          <Stat icon={CalendarClock} label="Exams in the next 14 days" value={o.upcoming_exams} tone="muted" />
          {o.pending_invitations !== null && (
            <Stat icon={MailPlus} label="Pending invitations" value={o.pending_invitations} tone="muted" hint={<Link to="/school/people?tab=invitations" className="text-brand hover:underline">Manage</Link>} />
          )}
          {o.pending_deadline_requests !== null && (
            <Stat icon={UserCog} label="Deadline change requests" value={o.pending_deadline_requests} tone={o.pending_deadline_requests ? 'brand' : 'muted'} hint={<Link to="/school/calendar?view=requests" className="text-brand hover:underline">Review</Link>} />
          )}
          {!!o.suspended && <Stat icon={ShieldAlert} label="Suspended accounts" value={o.suspended} tone="muted" />}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel
          title="Workload warnings"
          description="Days where a class has too many deadlines, a deadline on an exam day or a holiday (next 14 days)."
          actions={<Link to="/school/calendar?view=deadlines" className="btn-secondary">Deadline calendar</Link>}
        >
          {conflicts.length === 0 ? (
            <p className="py-4 text-sm text-muted">No conflicts in the next two weeks.</p>
          ) : (
            <ul className="divide-y divide-line">
              {conflicts.slice(0, 8).map((d) => (
                <li key={`${d.day}-${d.class_id}`} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="w-28 shrink-0 text-sm font-medium">{formatDay(d.day)}</span>
                  <span className="text-sm">{d.class_name}</span>
                  <span className="text-sm text-muted">
                    {d.deadline_count} deadline{d.deadline_count === 1 ? '' : 's'}
                    {d.exam_count ? ` · ${d.exam_count} exam${d.exam_count === 1 ? '' : 's'}` : ''}
                  </span>
                  <span className="flex flex-wrap gap-1 sm:ml-auto">
                    {d.flags.filter((f) => SERIOUS_FLAGS.includes(f)).map((f) => (
                      <Pill key={f} tone="danger">
                        {FLAG_LABEL[f]}
                      </Pill>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Coming up" actions={<Link to="/school/calendar" className="btn-secondary">Calendar</Link>}>
          {events.length === 0 && upcoming.length === 0 ? (
            <p className="py-4 text-sm text-muted">Nothing scheduled in the next two weeks.</p>
          ) : (
            <ul className="divide-y divide-line">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <CalendarDays className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="w-28 shrink-0 text-sm font-medium">{formatDay(e.starts_on)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{e.title}</span>
                  <Pill tone={e.kind === 'exam' ? 'brand' : e.kind === 'holiday' ? 'success' : 'muted'}>{EVENT_LABEL[e.kind]}</Pill>
                </li>
              ))}
              {upcoming.map((a) => (
                <li key={`${a.id}-${a.class_name}`} className="flex flex-wrap items-center gap-2 py-2.5">
                  <ClipboardList className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="w-28 shrink-0 text-sm font-medium">{formatDay(a.day)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {a.title} <span className="text-muted">· {a.subject} · {a.class_name}</span>
                  </span>
                  <Pill>{a.kind}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={staffView ? 'Attendance, homework and marks' : 'Your progress'} description="Last 30 days of recorded data (marks: last 90 days). Only real records are used — nothing is estimated.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            icon={CalendarCheck}
            label="Attendance"
            value={summary.attendance.records ? `${Math.round(summary.attendance.present_rate! * 100)}%` : '—'}
            hint={summary.attendance.records ? `${summary.attendance.records} records` : 'Not recorded yet'}
            tone="muted"
          />
          <Stat
            icon={ClipboardList}
            label="Homework submitted"
            value={summary.homework.completion_rate === null ? '—' : `${Math.round(summary.homework.completion_rate * 100)}%`}
            hint={summary.homework.expected ? `${summary.homework.submitted} of ${summary.homework.expected} · ${summary.homework.accepted} accepted` : 'No past deadlines yet'}
            tone="muted"
          />
          <Stat
            icon={Award}
            label="Average mark"
            value={summary.marks.average_pct === null ? '—' : `${summary.marks.average_pct}%`}
            hint={summary.marks.marks ? `${summary.marks.marks} marks` : 'No marks yet'}
            tone="muted"
          />
        </div>
      </Panel>

      {!staffView && periods.length > 0 && (
        <Panel title="Today at school">
          <ul className="divide-y divide-line">
            {periods.map((p, i) => (
              <li key={i} className="flex gap-3 py-2 text-sm">
                <span className="w-28 shrink-0 text-muted tabular-nums">
                  {p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}
                </span>
                <span>{p.subjects?.name ?? p.label}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {inst.role === 'student' && <StudentGuardians institutionId={inst.institution_id} studentId={inst.membership_id} />}

      {!staffView && (
        <Panel title="Your habits and timetable">
          <p className="text-sm text-muted">
            Your personal habit trackers and weekly timetable stay private to you.{' '}
            <Link to="/dashboard" className="font-medium text-brand hover:underline">
              Open your timetable
            </Link>{' '}
            or{' '}
            <Link to="/school/goals" className="font-medium text-brand hover:underline">
              set a goal
            </Link>
            .
          </p>
        </Panel>
      )}

      {can('manage_staff') && o.staff <= 1 && (
        <Panel title="Get started">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>
              Set the academic year, grading scale and branding in <Link to="/school/settings" className="text-brand hover:underline">Settings</Link>.
            </li>
            <li>
              Add subjects and classes in <Link to="/school/classes" className="text-brand hover:underline">Classes &amp; subjects</Link>.
            </li>
            <li>
              Invite coordinators, teachers and students in <Link to="/school/people" className="text-brand hover:underline">People</Link>.
            </li>
          </ol>
        </Panel>
      )}
    </div>
  )
}

function staffHint(o: Overview) {
  const parts = Object.entries(o.staff_by_role)
    .filter(([, n]) => n)
    .map(([r, n]) => `${n} ${ROLE_LABEL[r as keyof typeof ROLE_LABEL].toLowerCase()}${n === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
