import { AlertTriangle, ArrowLeft, UserX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChartCard, pct } from '../components/charts/ChartCard'
import { CompareFocusChart, CompareLegend, CompareRateChart, ME_COLOR, THEM_COLOR, type ComparePoint } from '../components/charts/CompareCharts'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Spinner'
import { addDays } from '../lib/dates'
import { formatDuration } from '../lib/pomodoroStats'
import type { CompareRow } from '../lib/types'
import { useAuth } from '../store/auth'
import { fetchComparison, useFriends } from '../store/friends'
import { useToday } from '../store/view'
import { RangeToggle } from '../components/charts/RangeToggle'

interface Totals {
  seconds: number
  sessions: number
  focusDays: number
  done: number
  scheduled: number
  perfectDays: number
}

function totals(rows: CompareRow[]): Totals {
  const t: Totals = { seconds: 0, sessions: 0, focusDays: 0, done: 0, scheduled: 0, perfectDays: 0 }
  for (const r of rows) {
    t.seconds += r.focus_seconds
    t.sessions += r.sessions
    if (r.sessions > 0) t.focusDays++
    t.done += r.tasks_completed
    t.scheduled += r.tasks_scheduled
    if (r.tasks_scheduled > 0 && r.tasks_completed === r.tasks_scheduled) t.perfectDays++
  }
  return t
}

/** One metric, you vs friend, with the leader marked in text (not only by colour). */
function Duel({ label, name, me, them, meText, themText }: { label: string; name: string; me: number; them: number; meText: string; themText: string }) {
  const max = Math.max(me, them, 1e-9)
  const lead = me === them ? null : me > them ? 'me' : 'them'
  return (
    <div className="rounded-xl bg-subtle p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-muted">{label}</p>
        <p className="text-xs font-medium text-muted">{lead === null ? 'Tied' : lead === 'me' ? 'You lead' : `${name} leads`}</p>
      </div>
      {[
        { who: 'You', v: me, text: meText, color: ME_COLOR },
        { who: name, v: them, text: themText, color: THEM_COLOR },
      ].map((x) => (
        <div key={x.who} className="mt-3">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted">{x.who}</span>
            <span className="font-semibold tabular-nums">{x.text}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface" aria-hidden="true">
            <div className="h-full rounded-full" style={{ width: `${Math.max(x.v > 0 ? 3 : 0, (x.v / max) * 100)}%`, background: x.color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function NoData({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">{text}</p>
}

export default function ComparePage() {
  const { friendId = '' } = useParams()
  const navigate = useNavigate()
  const myId = useAuth((s) => s.session?.user.id)
  const friendsStatus = useFriends((s) => s.status)
  const friend = useFriends((s) => s.friends.find((f) => f.friend_id === friendId && f.status === 'accepted'))
  const loadFriends = useFriends((s) => s.load)
  const today = useToday()
  const [range, setRange] = useState(7)
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (friendsStatus === 'idle') loadFriends()
  }, [friendsStatus, loadFriends])

  useEffect(() => {
    if (!friend) return
    let cancelled = false
    setError(null)
    fetchComparison(friendId, addDays(today, -(range - 1)), today)
      .then((r) => !cancelled && setRows(r))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [friend, friendId, range, today])

  const view = useMemo(() => {
    if (!rows) return null
    const mine = rows.filter((r) => r.user_id === myId)
    const theirs = rows.filter((r) => r.user_id === friendId)
    const themBy = new Map(theirs.map((r) => [r.day, r]))
    const points: ComparePoint[] = mine.map((m) => {
      const t = themBy.get(m.day)
      return {
        date: m.day,
        meSeconds: m.focus_seconds,
        themSeconds: t?.focus_seconds ?? 0,
        meRate: m.tasks_scheduled ? m.tasks_completed / m.tasks_scheduled : null,
        themRate: t && t.tasks_scheduled ? t.tasks_completed / t.tasks_scheduled : null,
        meDone: m.tasks_completed,
        meScheduled: m.tasks_scheduled,
        themDone: t?.tasks_completed ?? 0,
        themScheduled: t?.tasks_scheduled ?? 0,
      }
    })
    return { points, me: totals(mine), them: totals(theirs) }
  }, [rows, myId, friendId])

  const back = (
    <button type="button" className="btn-ghost -ml-3" onClick={() => navigate('/friends')}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      Friends
    </button>
  )

  if (friendsStatus === 'ready' && !friend) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {back}
        <div className="card">
          <EmptyState icon={UserX} title="Not in your friends list" message="You can only compare progress with people who accepted your friend request." />
        </div>
      </div>
    )
  }

  const name = friend?.username ?? '…'
  const rate = (t: Totals) => (t.scheduled ? t.done / t.scheduled : 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {back}
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">You vs {name}</h1>
          <div className="mt-2">
            <CompareLegend me="You" them={name} />
          </div>
        </div>
        <RangeToggle value={range} onChange={setRange} size="md" />
      </div>

      {error ? (
        <div className="card">
          <EmptyState icon={AlertTriangle} title="Couldn’t load the comparison" message={error} />
        </div>
      ) : !view ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : (
        <>
          <ChartCard title="Pomodoro" subtitle={`Focus time over the last ${range} days`}>
            <div className="mb-6 grid gap-3 sm:grid-cols-3">
              <Duel name={name} label="Focus time" me={view.me.seconds} them={view.them.seconds} meText={formatDuration(view.me.seconds)} themText={formatDuration(view.them.seconds)} />
              <Duel name={name} label="Sessions" me={view.me.sessions} them={view.them.sessions} meText={String(view.me.sessions)} themText={String(view.them.sessions)} />
              <Duel name={name} label="Days focused" me={view.me.focusDays} them={view.them.focusDays} meText={`${view.me.focusDays} / ${range}`} themText={`${view.them.focusDays} / ${range}`} />
            </div>
            {view.me.sessions + view.them.sessions === 0 ? (
              <NoData text={`Neither of you saved a focus session in the last ${range} days.`} />
            ) : (
              <CompareFocusChart data={view.points} me="You" them={name} />
            )}
          </ChartCard>

          <ChartCard title="Timetable" subtitle={`Share of scheduled tasks completed over the last ${range} days`}>
            <div className="mb-6 grid gap-3 sm:grid-cols-3">
              <Duel name={name} label="Completion rate" me={rate(view.me)} them={rate(view.them)} meText={pct(rate(view.me))} themText={pct(rate(view.them))} />
              <Duel name={name} label="Tasks completed" me={view.me.done} them={view.them.done} meText={`${view.me.done} / ${view.me.scheduled}`} themText={`${view.them.done} / ${view.them.scheduled}`} />
              <Duel name={name} label="Perfect days" me={view.me.perfectDays} them={view.them.perfectDays} meText={String(view.me.perfectDays)} themText={String(view.them.perfectDays)} />
            </div>
            {view.me.scheduled + view.them.scheduled === 0 ? (
              <NoData text={`Neither of you had timetable tasks scheduled in the last ${range} days.`} />
            ) : (
              <CompareRateChart data={view.points} me="You" them={name} />
            )}
          </ChartCard>
        </>
      )}
    </div>
  )
}
