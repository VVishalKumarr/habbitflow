import { CheckCircle2, CircleDot, Coffee, Pause, Play, RotateCcw, SkipForward, SlidersHorizontal, Square, Timer } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { FocusSounds } from '../components/focus/FocusSounds'
import { EmptyState } from '../components/ui/EmptyState'
import { Modal } from '../components/ui/Modal'
import { dayOfWeek } from '../lib/dates'
import { formatDuration } from '../lib/pomodoroStats'
import { formatTime } from '../lib/time'
import { MIN_SAVE_MS, MODE_LABEL, formatClock, useRemaining, usePomodoro, type PomoMode, type PomoSettings } from '../store/pomodoro'
import { usePomodoroSessions } from '../store/pomodoroSessions'
import { useTrackerData } from '../store/trackerData'
import { usePrefs, useToday } from '../store/view'

const MODES: PomoMode[] = ['focus', 'short', 'long']

function Ring({ progress, children }: { progress: number; children: ReactNode }) {
  const r = 110
  const c = 2 * Math.PI * r
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[18rem]">
      <svg viewBox="0 0 240 240" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="120" cy="120" r={r} fill="none" stroke="var(--subtle)" strokeWidth="10" />
        <circle
          cx="120"
          cy="120"
          r={r}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
          className="transition-[stroke-dashoffset] duration-300 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  )
}

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = usePomodoro((s) => s.settings)
  const update = usePomodoro((s) => s.updateSettings)
  const [draft, setDraft] = useState<PomoSettings>(settings)
  const [error, setError] = useState<string | null>(null)

  const fields: { key: 'focus' | 'short' | 'long' | 'longEvery'; label: string; max: number; unit: string }[] = [
    { key: 'focus', label: 'Focus', max: 240, unit: 'min' },
    { key: 'short', label: 'Short break', max: 60, unit: 'min' },
    { key: 'long', label: 'Long break', max: 90, unit: 'min' },
    { key: 'longEvery', label: 'Long break after', max: 12, unit: 'sessions' },
  ]

  const submit = (e: FormEvent) => {
    e.preventDefault()
    for (const f of fields) {
      const v = draft[f.key]
      if (!Number.isInteger(v) || v < 1 || v > f.max) {
        setError(`${f.label} must be a whole number from 1 to ${f.max}.`)
        return
      }
    }
    update(draft)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Timer settings"
      subtitle="Saved on this device."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pomo-settings" className="btn-primary">
            Save
          </button>
        </>
      }
    >
      <form id="pomo-settings" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-4">
          {fields.map((f) => (
            <div key={f.key}>
              <label htmlFor={`pomo-${f.key}`} className="field-label">
                {f.label} <span className="font-normal text-muted">({f.unit})</span>
              </label>
              <input
                id={`pomo-${f.key}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={f.max}
                className="input"
                value={Number.isNaN(draft[f.key]) ? '' : draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.valueAsNumber })}
              />
            </div>
          ))}
        </div>
        <label className="flex items-center gap-3 text-[15px]">
          <input
            type="checkbox"
            className="size-5 accent-[var(--brand)]"
            checked={draft.autoStart}
            onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}
          />
          Start the next timer automatically
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

/** Today's timetable tasks and recent Pomodoro names, to fill the task name in one tap. */
function useSuggestions(): string[] {
  const today = useToday()
  const tasks = useTrackerData((s) => s.tasks)
  const sessions = usePomodoroSessions((s) => s.sessions)
  return useMemo(() => {
    const dow = dayOfWeek(today)
    const seen = new Set<string>()
    const out: string[] = []
    const add = (l: string) => {
      const k = l.trim().toLowerCase()
      if (k && !seen.has(k) && out.length < 8) {
        seen.add(k)
        out.push(l.trim())
      }
    }
    tasks.filter((t) => t.day_of_week === dow).forEach((t) => add(t.title))
    sessions.slice(0, 50).forEach((s) => add(s.label))
    return out
  }, [today, tasks, sessions])
}

function TodaySessions() {
  const today = useToday()
  const { timeFormat } = usePrefs()
  const all = usePomodoroSessions((s) => s.sessions)
  const status = usePomodoroSessions((s) => s.status)
  const sessions = useMemo(() => all.filter((s) => s.session_date === today), [all, today])
  const total = sessions.reduce((a, s) => a + s.focus_seconds, 0)
  const clock = (iso: string) => {
    const d = new Date(iso)
    return formatTime(`${d.getHours()}:${d.getMinutes()}`, timeFormat)
  }

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="today-focus">
      <h2 id="today-focus" className="font-semibold">
        Today
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-subtle px-3.5 py-3">
          <p className="text-xs text-muted">Focus time</p>
          <p className="mt-0.5 text-xl font-semibold">{formatDuration(total)}</p>
        </div>
        <div className="rounded-xl bg-subtle px-3.5 py-3">
          <p className="text-xs text-muted">Sessions</p>
          <p className="mt-0.5 text-xl font-semibold">{sessions.length}</p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <p className="mt-5 text-sm text-muted">{status === 'loading' ? 'Loading…' : 'No focus sessions yet today.'}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              {s.completed ? (
                <CheckCircle2 className="size-[18px] shrink-0 text-success" aria-label="Full session" />
              ) : (
                <CircleDot className="size-[18px] shrink-0 text-muted" aria-label="Finished early" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
              <span className="text-xs text-muted tabular-nums">{clock(s.ended_at)}</span>
              <span className="w-14 text-right text-sm font-semibold tabular-nums">{formatDuration(s.focus_seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function FocusPage() {
  const mode = usePomodoro((s) => s.mode)
  const running = usePomodoro((s) => s.endAt !== null)
  const started = usePomodoro((s) => s.startedAt !== null)
  const label = usePomodoro((s) => s.label)
  const settings = usePomodoro((s) => s.settings)
  const cycle = usePomodoro((s) => s.cycle)
  const { setLabel, setMode, start, pause, finishEarly, discard, skip } = usePomodoro.getState()
  const remaining = useRemaining()
  const suggestions = useSuggestions()
  const [showSettings, setShowSettings] = useState(false)

  const total = settings[mode] * 60_000
  const progress = total ? 1 - remaining / total : 0
  const focusedMs = total - remaining
  const isFocus = mode === 'focus'

  const onStart = (e: FormEvent) => {
    e.preventDefault()
    if (running) pause()
    else start()
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Focus timer</h1>
          <p className="mt-1 text-muted">Pomodoro sessions are tracked separately from your timetable.</p>
        </div>
        <button type="button" className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Timer settings">
          <SlidersHorizontal className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <form className="card p-5 sm:p-8" onSubmit={onStart}>
          <div className="mx-auto flex max-w-md rounded-xl bg-subtle p-1" role="radiogroup" aria-label="Timer type">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={started && mode !== m}
                onClick={() => setMode(m)}
                className={`h-9 flex-1 rounded-lg px-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  mode === m ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>

          <div className="mt-8">
            <Ring progress={progress}>
              <span className="text-sm font-medium text-muted">{isFocus ? 'Focus' : MODE_LABEL[mode]}</span>
              <span className="mt-1 text-6xl font-semibold tracking-tight tabular-nums" role="timer" aria-live="off">
                {formatClock(remaining)}
              </span>
              <span className="mt-2 text-xs text-muted">
                {isFocus ? `Session ${cycle + 1} of ${settings.longEvery}` : 'Relax — you earned it'}
              </span>
            </Ring>
          </div>

          <div className="mx-auto mt-8 max-w-md">
            {isFocus ? (
              <>
                <label htmlFor="pomo-label" className="field-label">
                  What are you working on?
                </label>
                <input
                  id="pomo-label"
                  className="input"
                  placeholder="e.g. Maths revision"
                  maxLength={100}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  autoComplete="off"
                />
                {suggestions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggestions">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setLabel(s)}
                        aria-pressed={label.trim().toLowerCase() === s.toLowerCase()}
                        className="max-w-full truncate rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-subtle hover:text-ink aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-ink"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="flex items-center justify-center gap-2 text-sm text-muted">
                <Coffee className="size-4" aria-hidden="true" />
                Next up: {label.trim() || 'focus'}
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button type="submit" className="btn-primary min-w-36 text-base">
                {running ? <Pause className="size-5" aria-hidden="true" /> : <Play className="size-5" aria-hidden="true" />}
                {running ? 'Pause' : started ? 'Resume' : 'Start'}
              </button>
              {isFocus && started && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={finishEarly}
                  disabled={focusedMs < MIN_SAVE_MS}
                  title={focusedMs < MIN_SAVE_MS ? 'Focus for at least a minute to save' : undefined}
                >
                  <Square className="size-4" aria-hidden="true" />
                  Finish & save
                </button>
              )}
              {started && (
                <button type="button" className="btn-ghost" onClick={discard}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  {isFocus ? 'Discard' : 'Reset'}
                </button>
              )}
              {!isFocus && (
                <button type="button" className="btn-ghost" onClick={skip}>
                  <SkipForward className="size-4" aria-hidden="true" />
                  Skip break
                </button>
              )}
            </div>
          </div>
        </form>

        <div className="space-y-6">
          <TodaySessions />
          <FocusSounds />
          <section className="card">
            <EmptyState
              icon={Timer}
              title="How it works"
              message={`Focus for ${settings.focus} min, then take a ${settings.short} min break. After ${settings.longEvery} sessions, take a longer ${settings.long} min break. Every finished session is saved to your Pomodoro progress.`}
              className="py-8"
            />
          </section>
        </div>
      </div>

      {showSettings && <SettingsModal open onClose={() => setShowSettings(false)} />}
    </div>
  )
}
