import { AlertTriangle, CalendarCheck, CheckCircle2, CircleDot, Clock, Flame, Hourglass, Timer, Trash2, Trophy } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDate } from '../../lib/dates'
import { computePomodoroStats, focusSeries, formatDuration } from '../../lib/pomodoroStats'
import type { PomodoroSession } from '../../lib/types'
import { usePomodoroSessions } from '../../store/pomodoroSessions'
import { toast } from '../../store/ui'
import { usePrefs, useToday } from '../../store/view'
import { ChartCard } from '../charts/ChartCard'
import { FocusChart } from '../charts/FocusChart'
import { ConfirmModal } from '../ui/ConfirmModal'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Spinner'
import { RangeToggle } from '../charts/RangeToggle'

function StatCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="card flex flex-col justify-between gap-3 p-4 sm:p-5">
      <div className="flex items-start gap-2 text-sm leading-tight text-muted">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand [&_svg]:size-[18px]">{icon}</span>
        <span className="min-w-0 pt-2 sm:pt-1.5">{label}</span>
      </div>
      <div>
        <p className="text-2xl font-semibold tracking-tight sm:text-[28px]">{value}</p>
        {detail && <p className="mt-0.5 text-xs leading-snug text-muted">{detail}</p>}
      </div>
    </div>
  )
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function PomodoroProgress() {
  const navigate = useNavigate()
  const status = usePomodoroSessions((s) => s.status)
  const error = usePomodoroSessions((s) => s.error)
  const sessions = usePomodoroSessions((s) => s.sessions)
  const remove = usePomodoroSessions((s) => s.remove)
  const { weekStart } = usePrefs()
  const today = useToday()
  const [range, setRange] = useState(7)
  const [showAll, setShowAll] = useState(false)
  const [toDelete, setToDelete] = useState<PomodoroSession | null>(null)

  const stats = useMemo(() => computePomodoroStats(sessions, today, weekStart), [sessions, today, weekStart])
  const series = useMemo(() => focusSeries(stats.byDate, today, range), [stats.byDate, today, range])

  if (status === 'idle' || (status === 'loading' && sessions.length === 0)) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="card">
        <EmptyState icon={AlertTriangle} title="Couldn’t load Pomodoro history" message={error ?? ''} />
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={Timer}
          title="No focus sessions yet"
          message="Start a Pomodoro timer, name what you're working on, and your focus time will show up here."
          action={
            <button type="button" className="btn-primary" onClick={() => navigate('/focus')}>
              Start focusing
            </button>
          }
        />
      </div>
    )
  }

  const maxLabel = stats.labels[0]?.seconds ?? 1
  const recent = showAll ? sessions : sessions.slice(0, 10)

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">Pomodoro progress</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Focus time</h1>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard icon={<Clock />} label="Focus today" value={formatDuration(stats.today.seconds)} detail={plural(stats.today.sessions, 'session')} />
        <StatCard icon={<CalendarCheck />} label="This week" value={formatDuration(stats.weekSeconds)} detail={plural(stats.week.reduce((a, d) => a + d.sessions, 0), 'session')} />
        <StatCard icon={<Hourglass />} label="Total focus" value={formatDuration(stats.totalSeconds)} detail={`Across ${plural(stats.activeDays, 'day')}`} />
        <StatCard
          icon={<CheckCircle2 />}
          label="Sessions"
          value={String(stats.totalSessions)}
          detail={`${stats.fullSessions} full, ${stats.totalSessions - stats.fullSessions} finished early`}
        />
        <StatCard icon={<Flame />} label="Current streak" value={plural(stats.streak.current, 'day')} detail="Days with a focus session" />
        <StatCard icon={<Trophy />} label="Longest streak" value={plural(stats.streak.longest, 'day')} detail="Your best run" />
        <StatCard
          icon={<Timer />}
          label="Average session"
          value={formatDuration(stats.totalSeconds / stats.totalSessions)}
          detail="Focus per session"
        />
        <StatCard
          icon={<CalendarCheck />}
          label="Daily average"
          value={formatDuration(stats.totalSeconds / Math.max(1, stats.activeDays))}
          detail="On days you focused"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <ChartCard
          title="Focus minutes"
          subtitle="Time spent focusing each day"
          action={
            <RangeToggle value={range} onChange={setRange} />
          }
        >
          <FocusChart data={series} caption={`Focus minutes per day, last ${range} days`} />
        </ChartCard>

        <ChartCard title="By task" subtitle="Where your focus time went">
          <ul className="space-y-3">
            {stats.labels.slice(0, 8).map((l) => (
              <li key={l.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{l.label}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-semibold">{formatDuration(l.seconds)}</span>
                    <span className="ml-1.5 text-xs text-muted">{plural(l.sessions, 'session')}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, (l.seconds / maxLabel) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
          {stats.labels.length > 8 && <p className="mt-4 text-xs text-muted">+ {stats.labels.length - 8} more tasks</p>}
        </ChartCard>
      </div>

      <ChartCard title="Recent sessions" subtitle="Every saved focus session">
        <ul className="-mx-2 divide-y divide-line">
          {recent.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-2 py-2.5">
              {s.completed ? (
                <CheckCircle2 className="size-[18px] shrink-0 text-success" aria-label="Full session" />
              ) : (
                <CircleDot className="size-[18px] shrink-0 text-muted" aria-label="Finished early" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.label}</span>
                <span className="block text-xs text-muted">{formatDate(s.session_date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </span>
              <span className="text-sm font-semibold tabular-nums">{formatDuration(s.focus_seconds)}</span>
              <button type="button" className="icon-btn size-9" onClick={() => setToDelete(s)} aria-label={`Delete session “${s.label}”`}>
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {sessions.length > 10 && (
          <button type="button" className="btn-ghost mt-3 self-start" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${sessions.length}`}
          </button>
        )}
      </ChartCard>

      <ConfirmModal
        open={toDelete !== null}
        title="Delete this session?"
        message={toDelete ? `“${toDelete.label}” (${formatDuration(toDelete.focus_seconds)}) will be removed from your focus history.` : ''}
        confirmLabel="Delete"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return
          try {
            await remove(toDelete.id)
            toast.success('Session deleted.')
            setToDelete(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </div>
  )
}
