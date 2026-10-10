import { AlertTriangle, CalendarClock, Clock, Plus, Sparkles } from 'lucide-react'
import { TodayPanel } from '../components/dashboard/TodayPanel'
import { TodayProgressCard } from '../components/dashboard/TodayProgressCard'
import { TrackerHeader } from '../components/dashboard/TrackerHeader'
import { TimetableAssistant } from '../components/timetable-ai/TimetableAssistant'
import { WeekNavigator } from '../components/dashboard/WeekNavigator'
import { MobileDaySelector, MobileDayView } from '../components/timetable/MobileDayView'
import { Timetable } from '../components/timetable/Timetable'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Spinner'
import { DAY_NAMES, dayOfWeek, formatDate, startOfWeek, weekDates } from '../lib/dates'
import { useAuth } from '../store/auth'
import { dialogs } from '../store/dialogs'
import { useTrackerData } from '../store/trackerData'
import { useTrackers } from '../store/trackers'
import { useTrackerStats } from '../store/useTrackerStats'
import { usePrefs, useToday, useView } from '../store/view'

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-16 w-72" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
      </div>
      <Skeleton className="h-96" />
    </div>
  )
}

/** Isolated so ticking a task only re-renders the progress widgets, not the timetable. */
function DashboardProgress() {
  const stats = useTrackerStats()
  return (
    <TodayProgressCard
      completed={stats.today.completed}
      scheduled={stats.today.scheduled}
      weekRate={stats.weekTotals.rate}
      streak={stats.streak.current}
      week={stats.week}
      today={stats.today.date}
    />
  )
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card">
      <EmptyState
        icon={AlertTriangle}
        title="Couldn’t load your data"
        message={message}
        action={
          <button type="button" className="btn-primary" onClick={onRetry}>
            Try again
          </button>
        }
      />
    </div>
  )
}

export default function DashboardPage() {
  const username = useAuth((s) => s.profile?.username ?? '')
  const trackersStatus = useTrackers((s) => s.status)
  const trackersError = useTrackers((s) => s.error)
  const loadTrackers = useTrackers((s) => s.load)
  const hasTrackers = useTrackers((s) => s.trackers.length > 0)
  const selectedId = useTrackers((s) => s.selectedId)
  const dataStatus = useTrackerData((s) => s.status)
  const dataError = useTrackerData((s) => s.error)
  const loadData = useTrackerData((s) => s.load)
  const slots = useTrackerData((s) => s.slots)
  const { weekStart, timeFormat } = usePrefs()
  const today = useToday()
  const selectedDate = useView((s) => s.selectedDate)

  if (trackersStatus === 'idle' || trackersStatus === 'loading') return <DashboardSkeleton />
  if (trackersStatus === 'error') return <ErrorCard message={trackersError ?? ''} onRetry={loadTrackers} />

  if (!hasTrackers) {
    return (
      <div className="mx-auto mt-4 max-w-2xl space-y-6">
      <div className="card">
        <EmptyState
          icon={Sparkles}
          title={`Welcome, ${username}!`}
          message="No trackers yet. Create your first routine and start building better habits."
          action={
            <button type="button" className="btn-primary h-11 px-5" onClick={dialogs.createTracker}>
              <Plus className="size-4" aria-hidden="true" />
              Create tracker
            </button>
          }
        />
      </div>
      <TimetableAssistant />
      </div>
    )
  }

  const weekStartDate = startOfWeek(selectedDate, weekStart)
  const dates = weekDates(weekStartDate)
  const isCurrentWeek = startOfWeek(today, weekStart) === weekStartDate
  const loading = dataStatus === 'loading' || dataStatus === 'idle'

  return (
    <div className="space-y-6">
      <TrackerHeader username={username} />

      {dataStatus === 'error' ? (
        <ErrorCard message={dataError ?? ''} onRetry={() => loadData(selectedId)} />
      ) : loading ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <DashboardProgress />
            <div className="hidden lg:flex">
              <div className="flex w-full flex-col">
                <TodayPanel slots={slots} today={today} timeFormat={timeFormat} />
              </div>
            </div>
          </div>

          <section className="card" aria-labelledby="timetable-title">
            <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex items-center gap-2">
                <CalendarClock className="size-5 text-brand" aria-hidden="true" />
                <h2 id="timetable-title" className="font-semibold">
                  Weekly timetable
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <WeekNavigator weekStartDate={weekStartDate} isCurrentWeek={isCurrentWeek} />
                {slots.length > 0 && (
                  <button type="button" className="btn-secondary hidden h-10 lg:inline-flex" onClick={dialogs.addSlot}>
                    <Clock className="size-4" aria-hidden="true" />
                    Add time slot
                  </button>
                )}
              </div>
            </div>

            {slots.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="Add your first time slot"
                message="Time slots are the rows of your timetable — e.g. 5:00 PM – 6:00 PM. Any length works."
                action={
                  <button type="button" className="btn-primary" onClick={dialogs.addSlot}>
                    <Plus className="size-4" aria-hidden="true" />
                    Add time slot
                  </button>
                }
              />
            ) : (
              <>
                <div className="hidden p-2 lg:block">
                  <Timetable slots={slots} dates={dates} today={today} timeFormat={timeFormat} />
                </div>
                <div className="p-4 sm:p-6 lg:hidden">
                  <MobileDaySelector dates={dates} selected={selectedDate} today={today} />
                  <div className="mt-5 mb-4 flex items-baseline justify-between">
                    <h3 className="text-lg font-semibold">
                      {selectedDate === today ? 'Today' : DAY_NAMES[dayOfWeek(selectedDate)]}
                    </h3>
                    <span className="text-sm text-muted">{formatDate(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                  </div>
                  <MobileDayView slots={slots} date={selectedDate} timeFormat={timeFormat} />
                </div>
                <div className="border-t border-line p-3 lg:hidden">
                  <button type="button" className="btn-ghost h-11 w-full text-brand" onClick={dialogs.addSlot}>
                    <Plus className="size-4" aria-hidden="true" />
                    Add time slot
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {/* Outside the loading state so a saved change (which reloads the timetable) keeps the assistant open. */}
      {dataStatus !== 'error' && <TimetableAssistant />}
    </div>
  )
}
