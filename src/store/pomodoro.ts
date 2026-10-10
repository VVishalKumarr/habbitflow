import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { analytics } from '../lib/analytics'
import { localDateOf } from '../lib/dates'
import { usePomodoroSessions } from './pomodoroSessions'
import { toast } from './ui'

export type PomoMode = 'focus' | 'short' | 'long'

export interface PomoSettings {
  /** minutes */
  focus: number
  short: number
  long: number
  /** long break after this many focus sessions */
  longEvery: number
  /** start the next timer automatically when one ends */
  autoStart: boolean
}

export const MODE_LABEL: Record<PomoMode, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' }
export const DEFAULT_SETTINGS: PomoSettings = { focus: 25, short: 5, long: 15, longEvery: 4, autoStart: false }
/** Shortest focus that is worth saving. */
export const MIN_SAVE_MS = 60_000

interface PersistedTimer {
  settings: PomoSettings
  mode: PomoMode
  /** epoch ms the timer hits zero; null while paused / not started */
  endAt: number | null
  /** ms left while paused / not started */
  remaining: number
  /** first start of the current timer (ISO); null = not started */
  startedAt: string | null
  label: string
  /** focus sessions finished since the last long break */
  cycle: number
}

interface TimerState extends PersistedTimer {
  setLabel: (label: string) => void
  setMode: (mode: PomoMode) => void
  updateSettings: (patch: Partial<PomoSettings>) => void
  start: () => void
  pause: () => void
  /** Ends the current focus early and saves what was done. */
  finishEarly: () => void
  /** Discards the current timer. */
  discard: () => void
  /** Skips a break. */
  skip: () => void
  /** Called by the ticker; completes the timer once it reaches zero. */
  tick: () => void
  resetAll: () => void
}

const STORAGE_KEY = 'habitflow-pomodoro'
const minutesOf = (s: PomoSettings, m: PomoMode) => s[m]
const durationMs = (s: PomoSettings, m: PomoMode) => minutesOf(s, m) * 60_000

function initial(): PersistedTimer {
  const fresh: PersistedTimer = {
    settings: DEFAULT_SETTINGS,
    mode: 'focus',
    endAt: null,
    remaining: durationMs(DEFAULT_SETTINGS, 'focus'),
    startedAt: null,
    label: '',
    cycle: 0,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PersistedTimer | null
    if (saved && saved.settings && saved.mode) return { ...fresh, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } }
  } catch {
    /* ignore */
  }
  return fresh
}

/** Time left right now, whether running or paused. */
export const remainingNow = (s: Pick<PersistedTimer, 'endAt' | 'remaining'>, now = Date.now()) =>
  s.endAt === null ? s.remaining : Math.max(0, s.endAt - now)

/** Short three-note chime (plus a vibration on phones) when a timer ends. */
function chime() {
  try {
    navigator.vibrate?.([200, 100, 200])
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    ;[660, 880, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      osc.connect(gain)
      gain.connect(ctx.destination)
      const t = ctx.currentTime + i * 0.22
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      osc.start(t)
      osc.stop(t + 0.55)
    })
    setTimeout(() => ctx.close(), 1500)
  } catch {
    /* audio unavailable */
  }
}

export const usePomodoro = create<TimerState>((set, get) => {
  const idle = (mode: PomoMode, extra: Partial<PersistedTimer> = {}) => {
    const settings = extra.settings ?? get().settings
    set({ mode, endAt: null, remaining: durationMs(settings, mode), startedAt: null, ...extra })
  }

  /** Saves a focus session that ran from startedAt for `focusMs`, ending at `endedAt`. */
  const save = (focusMs: number, endedAt: number, completed: boolean) => {
    const { label, settings, startedAt } = get()
    analytics.track('focus_session_completed', { mode: completed ? 'full' : 'early' })
    const ended = new Date(endedAt).toISOString()
    usePomodoroSessions
      .getState()
      .log({
        label: label.trim() || 'Focus',
        planned_minutes: settings.focus,
        focus_seconds: Math.min(14_400, Math.round(focusMs / 1000)),
        completed,
        session_date: localDateOf(ended),
        started_at: startedAt ?? ended,
        ended_at: ended,
      })
      .catch((e: Error) => toast.error(e.message))
  }

  /** Moves on from a finished (or early-finished) focus session to the right break. */
  const afterFocus = () => {
    const { settings } = get()
    const cycle = get().cycle + 1
    const longBreak = cycle >= settings.longEvery
    idle(longBreak ? 'long' : 'short', { cycle: longBreak ? 0 : cycle })
  }

  const autoStart = () => {
    if (get().settings.autoStart) get().start()
  }

  return {
    ...initial(),

    setLabel: (label) => set({ label: label.slice(0, 100) }),

    setMode: (mode) => {
      if (get().startedAt) return
      idle(mode)
    },

    updateSettings: (patch) => {
      const settings = { ...get().settings, ...patch }
      if (get().startedAt) set({ settings })
      else idle(get().mode, { settings })
    },

    start: () => {
      const s = get()
      if (s.endAt !== null) return
      if (s.mode === 'focus' && !s.label.trim()) {
        toast.error('Name the task you are focusing on first.')
        return
      }
      set({ endAt: Date.now() + s.remaining, startedAt: s.startedAt ?? new Date().toISOString() })
    },

    pause: () => {
      const s = get()
      if (s.endAt === null) return
      set({ endAt: null, remaining: remainingNow(s) })
    },

    finishEarly: () => {
      const s = get()
      if (s.mode !== 'focus' || !s.startedAt) return
      const focused = durationMs(s.settings, 'focus') - remainingNow(s)
      if (focused < MIN_SAVE_MS) {
        toast.info('Focus for at least a minute to save a session.')
        return
      }
      save(focused, Date.now(), false)
      toast.success(`Saved ${Math.round(focused / 60_000)} min of focus on “${s.label.trim()}”.`)
      afterFocus()
    },

    discard: () => idle(get().mode),

    skip: () => {
      if (get().mode === 'focus') return
      idle('focus')
    },

    tick: () => {
      const s = get()
      if (s.endAt === null || s.endAt > Date.now()) return
      const endedAt = s.endAt
      chime()
      if (s.mode === 'focus') {
        save(durationMs(s.settings, 'focus'), endedAt, true)
        afterFocus()
        toast.success(`Focus session done — time for a ${get().mode === 'long' ? 'long ' : ''}break.`)
      } else {
        idle('focus')
        toast.info('Break over — ready to focus?')
      }
      autoStart()
    },

    /** Clears the running timer and task name (e.g. on logout); duration settings stay on this device. */
    resetAll: () => idle('focus', { label: '', cycle: 0 }),
  }
})

// Keep the timer across reloads / app restarts.
usePomodoro.subscribe((s) => {
  const { settings, mode, endAt, remaining, startedAt, label, cycle } = s
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, mode, endAt, remaining, startedAt, label, cycle }))
  } catch {
    /* storage unavailable */
  }
})

/** Re-renders the caller every `ms` while the timer runs and returns the time left. */
export function useRemaining(ms = 250): number {
  const endAt = usePomodoro((s) => s.endAt)
  const remaining = usePomodoro((s) => s.remaining)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (endAt === null) return
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [endAt, ms])
  return remainingNow({ endAt, remaining }, endAt === null ? undefined : now)
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
