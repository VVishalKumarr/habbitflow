import { AlertTriangle, CalendarCheck, CheckCheck, ChartNoAxesColumn, Flame, ListChecks, ListTodo, Target, Trophy } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChartCard, pct } from '../components/charts/ChartCard'
import { CompletionChart, type TrendPoint } from '../components/charts/CompletionChart'
import { DonutChart } from '../components/charts/DonutChart'
import { TaskPerformance } from '../components/charts/TaskPerformance'
import { TaskProgressChart } from '../components/charts/TaskProgressChart'
import { WeeklyChart } from '../components/charts/WeeklyChart'
import { PomodoroProgress } from '../components/progress/PomodoroProgress'
import { TrackerSelector } from '../components/dashboard/TrackerHeader'
import { EmptyState } from '../components/ui/EmptyState'
import { Modal } from '../components/ui/Modal'
import { Skeleton } from '../components/ui/Spinner'
import { CATEGORY_STYLE } from '../lib/category'
import { DAY_NAMES, addDays, formatDate, type ISODate } from '../lib/dates'
import type { DayStat, HabitStat } from '../lib/stats'
import { useTrackerData } from '../store/trackerData'
import { useTrackers } from '../store/trackers'
import { useTrackerStats } from '../store/useTrackerStats'
import { useToday } from '../store/view'
import { RangeToggle } from '../components/charts/RangeToggle'
import { AdSlot } from '../components/ads/AdSlot'
import { analytics } from '../lib/analytics'
import { ScoreBar, ScoreRing } from '../components/score/Score'
import { useInView } from '../components/score/useReveal'
import { computeScores, scoreColor, type Scores } from '../lib/scores'

function ProgressCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
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

function trendData(daily: DayStat[], today: ISODate, days: number): TrendPoint[] {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const out: TrendPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i)
    const d = byDate.get(date)
    out.push({
      date,
      completed: d?.completed ?? 0,
      scheduled: d?.scheduled ?? 0,
      rate: d && d.scheduled ? d.completed / d.scheduled : null,
    })
  }
  return out
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Game-style score card: Overall vs Potential, plus the scores behind them. */
function ScoreCard({ scores }: { scores: Scores }) {
  const [ref, inView] = useInView<HTMLElement>(0.2)
  const gap = scores.potential - scores.overall
  return (
    <section ref={ref} className="card relative overflow-hidden p-5 sm:p-6" aria-label="Your scores">
      <div
        className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full opacity-15 blur-3xl"
        style={{ background: scoreColor(scores.overall) }}
        aria-hidden="true"
      />
      <div className="relative grid items-center gap-6 md:grid-cols-[auto_1fr]">
        <div className="flex flex-col items-center gap-2">
          <ScoreRing value={scores.overall} run={inView} size={150} sub="overall" />
          <p className="max-w-44 text-center text-sm text-muted">
            {gap > 0 ? (
              <>
                <strong className="text-ink">+{gap}</strong> to reach your potential
              </>
            ) : (
              'You’re at your potential — raise the bar!'
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <ScoreBar label="Overall" value={scores.overall} potential={scores.potential} run={inView} hint="Completion over the last 30 days" />
          <ScoreBar label="Potential" value={scores.potential} run={inView} hint="Based on your best 7-day run" />
          <ScoreBar label="Consistency" value={scores.consistency} run={inView} hint="Days with 80% or more done, last 30 days" />
          <ScoreBar label="This week" value={scores.week} run={inView} hint="Completion this week so far" />
          <ScoreBar label="Streak power" value={scores.streak} run={inView} hint="Current streak compared with your best" />
          <ScoreBar label={scores.topHabitTitle ? `Top: ${scores.topHabitTitle}` : 'Top habit'} value={scores.topHabit} run={inView} hint="Your most consistent habit" />
        </div>
      </div>
    </section>
  )
}

function HabitDetail({ habit, onClose }: { habit: HabitStat; onClose: () => void }) {
  const days = useTrackerData((s) => {
    const set = new Set(s.tasks.filter((t) => habit.taskIds.includes(t.id)).map((t) => t.day_of_week))
    return [...set].sort().map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')
  })
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={habit.title}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${CATEGORY_STYLE[habit.category].dot}`} aria-hidden="true" />
          {CATEGORY_STYLE[habit.category].label} · {days}
        </span>
      }
    >
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Completion', `${habit.completedDays} / ${habit.scheduledDays} days`],
          ['Completion rate', `${(habit.rate * 100).toFixed(1)}%`],
          ['Current streak', plural(habit.streak.current, 'day')],
          ['Longest streak', plural(habit.streak.longest, 'day')],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-subtle px-3.5 py-3">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-0.5 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <TaskProgressChart habit={habit} />
    </Modal>
  )
}

function TimetableProgress() {
  const navigate = useNavigate()
  const trackersStatus = useTrackers((s) => s.status)
  const tracker = useTrackers((s) => s.trackers.find((t) => t.id === s.selectedId))
  const dataStatus = useTrackerData((s) => s.status)
  const dataError = useTrackerData((s) => s.error)
  const stats = useTrackerStats()
  const today = useToday()
  const [range, setRange] = useState(30)
  const [habitKey, setHabitKey] = useState<string | null>(null)

  const trend = useMemo(() => trendData(stats.daily, today, range), [stats.daily, today, range])
  const scores = useMemo(() => computeScores(stats, today), [stats, today])
  const habit = stats.habits.find((h) => h.key === habitKey)

  if (trackersStatus !== 'ready' || (tracker && (dataStatus === 'loading' || dataStatus === 'idle'))) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-14 w-64" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  if (!tracker) {
    return (
      <div className="card mx-auto max-w-2xl">
        <EmptyState
          icon={ChartNoAxesColumn}
          title="No statistics yet"
          message="Create a tracker and add some tasks — your progress will show up here."
          action={
            <button type="button" className="btn-primary" onClick={() => navigate('/dashboard')}>
              Go to dashboard
            </button>
          }
        />
      </div>
    )
  }

  if (dataStatus === 'error') {
    return (
      <div className="card">
        <EmptyState icon={AlertTriangle} title="Couldn’t load statistics" message={dataError ?? ''} />
      </div>
    )
  }

  const noTasks = stats.habits.length === 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted">Timetable progress</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">{tracker.name}</h1>
          {stats.firstDate && (
            <p className="mt-1 text-sm text-muted">Tracking since {formatDate(stats.firstDate, { month: 'long', day: 'numeric', year: 'numeric' })}</p>
          )}
        </div>
        <TrackerSelector />
      </div>

      {noTasks ? (
        <div className="card">
          <EmptyState
            icon={ListTodo}
            title="No tasks in this tracker yet"
            message="Add tasks to your timetable and tick them off — charts and streaks will appear here."
            action={
              <button type="button" className="btn-primary" onClick={() => navigate('/dashboard')}>
                Open timetable
              </button>
            }
          />
        </div>
      ) : (
        <>
          <ScoreCard scores={scores} />

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <ProgressCard icon={<Target />} label="Overall completion" value={pct(stats.totals.rate)} detail="All time, up to today" />
            <ProgressCard
              icon={<CheckCheck />}
              label="Completed today"
              value={`${stats.today.completed} / ${stats.today.scheduled}`}
              detail={`${stats.today.scheduled - stats.today.completed} remaining today`}
            />
            <ProgressCard
              icon={<CalendarCheck />}
              label="Weekly progress"
              value={pct(stats.weekTotals.rate)}
              detail={`${stats.weekTotals.completed} of ${stats.weekTotals.scheduled} this week`}
            />
            <ProgressCard icon={<ListTodo />} label="Remaining today" value={String(stats.today.scheduled - stats.today.completed)} detail="Tasks still to do" />
            <ProgressCard icon={<Flame />} label="Current streak" value={plural(stats.streak.current, 'day')} detail="Days with every task done" />
            <ProgressCard icon={<Trophy />} label="Longest streak" value={plural(stats.streak.longest, 'day')} detail="Your best run" />
            <ProgressCard icon={<CheckCheck />} label="Total completed" value={String(stats.totals.completed)} detail="Tasks ticked off" />
            <ProgressCard icon={<ListChecks />} label="Total scheduled" value={String(stats.totals.scheduled)} detail="Up to and including today" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="This week" subtitle="Share of each day’s tasks completed">
              <WeeklyChart week={stats.week} today={today} />
            </ChartCard>
            <ChartCard
              title="Completion trend"
              subtitle="Daily completion rate vs your potential"
              action={
                <RangeToggle value={range} onChange={setRange} />
              }
            >
              <CompletionChart data={trend} potential={scores.potential / 100} caption={`Daily completion rate, last ${range} days; potential ${scores.potential}%`} />
            </ChartCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <ChartCard title="Task performance" subtitle="How consistently each task gets done — tap one for details">
              <TaskPerformance habits={stats.habits} onSelect={setHabitKey} />
            </ChartCard>
            <ChartCard title="Completion" subtitle="All scheduled tasks up to today">
              <div className="flex flex-1 items-center justify-center">
                <DonutChart completed={stats.totals.completed} total={stats.totals.scheduled} />
              </div>
            </ChartCard>
          </div>
        </>
      )}

      {habit && <HabitDetail habit={habit} onClose={() => setHabitKey(null)} />}
    </div>
  )
}

type ProgressTab = 'timetable' | 'pomodoro'

/** Timetable and Pomodoro progress are tracked and shown separately. */
export default function ProgressPage() {
  const [params, setParams] = useSearchParams()
  const tab: ProgressTab = params.get('view') === 'pomodoro' ? 'pomodoro' : 'timetable'
  useEffect(() => {
    analytics.track('progress_viewed', { tab })
  }, [tab])
  const tabs: { value: ProgressTab; label: string }[] = [
    { value: 'timetable', label: 'Timetable' },
    { value: 'pomodoro', label: 'Pomodoro' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex w-full rounded-xl bg-subtle p-1 sm:w-fit" role="tablist" aria-label="Progress type">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`progress-tab-${t.value}`}
            aria-selected={tab === t.value}
            aria-controls="progress-panel"
            onClick={() => setParams(t.value === 'timetable' ? {} : { view: t.value }, { replace: true })}
            className={`h-9 flex-1 rounded-lg px-5 text-sm font-medium transition-colors sm:flex-none ${
              tab === t.value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="progress-panel" role="tabpanel" aria-labelledby={`progress-tab-${tab}`}>
        {tab === 'timetable' ? <TimetableProgress /> : <PomodoroProgress />}
      </div>
      <AdSlot placement="progress" />
    </div>
  )
}
