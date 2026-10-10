import { create } from 'zustand'
import { friendlyError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import type { PomodoroSession } from '../lib/types'
import { useAuth } from './auth'

type Status = 'idle' | 'loading' | 'ready' | 'error'

export type NewSession = Omit<PomodoroSession, 'id'>

interface SessionsState {
  status: Status
  error: string | null
  sessions: PomodoroSession[]
  load: () => Promise<void>
  /** Saves a finished session; if offline it is queued and retried on the next save / load. */
  log: (s: NewSession) => Promise<void>
  remove: (id: string) => Promise<void>
  reset: () => void
}

const COLS = 'id, label, planned_minutes, focus_seconds, completed, session_date, started_at, ended_at'
const PAGE = 1000
/** Unsaved sessions are kept per user so they can never be uploaded to another account. */
const queueKey = () => `habitflow-pomodoro-queue:${useAuth.getState().session?.user.id ?? 'none'}`

function readQueue(): NewSession[] {
  try {
    return JSON.parse(localStorage.getItem(queueKey()) ?? '[]') as NewSession[]
  } catch {
    return []
  }
}

function writeQueue(q: NewSession[]) {
  try {
    if (q.length) localStorage.setItem(queueKey(), JSON.stringify(q))
    else localStorage.removeItem(queueKey())
  } catch {
    /* storage unavailable */
  }
}

const byEnd = (a: PomodoroSession, b: PomodoroSession) => b.ended_at.localeCompare(a.ended_at)

let loadSeq = 0

export const usePomodoroSessions = create<SessionsState>((set, get) => {
  /** Inserts every queued session; returns the ones that were saved. Runs one at a time so nothing is sent twice. */
  let chain: Promise<unknown> = Promise.resolve()
  const flush = (): Promise<PomodoroSession[]> => {
    const run = chain.catch(() => {}).then(async () => {
      const queue = readQueue()
      if (!queue.length) return []
      const { data, error } = await supabase.from('pomodoro_sessions').insert(queue).select(COLS)
      // Invalid rows (constraint errors) would never succeed, so drop them instead of retrying forever.
      if (error && !error.code?.startsWith('23')) throw error
      writeQueue(readQueue().slice(queue.length))
      if (error) throw error
      return data as PomodoroSession[]
    })
    chain = run
    return run
  }

  return {
    status: 'idle',
    error: null,
    sessions: [],

    load: async () => {
      const seq = ++loadSeq
      set({ status: 'loading', error: null })
      try {
        await flush().catch(() => {})
        const rows: PomodoroSession[] = []
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('pomodoro_sessions')
            .select(COLS)
            .order('ended_at', { ascending: false })
            .range(from, from + PAGE - 1)
          if (error) throw error
          rows.push(...(data as PomodoroSession[]))
          if (data.length < PAGE) break
        }
        if (seq === loadSeq) set({ status: 'ready', sessions: rows })
      } catch (err) {
        if (seq === loadSeq) set({ status: 'error', error: friendlyError(err) })
      }
    },

    log: async (session) => {
      writeQueue([...readQueue(), { ...session, label: session.label.trim().replace(/\s+/g, ' ').slice(0, 100) }])
      try {
        const saved = await flush()
        set({ sessions: [...saved, ...get().sessions].sort(byEnd) })
      } catch (err) {
        throw new Error(friendlyError(err, 'Could not save the session — it will be retried.'))
      }
    },

    remove: async (id) => {
      const { error } = await supabase.from('pomodoro_sessions').delete().eq('id', id)
      if (error) throw new Error(friendlyError(error))
      set({ sessions: get().sessions.filter((s) => s.id !== id) })
    },

    reset: () => {
      loadSeq++
      set({ status: 'idle', error: null, sessions: [] })
    },
  }
})
