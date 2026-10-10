import { create } from 'zustand'
import { analytics } from '../lib/analytics'
import { friendlyError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import type { Tracker } from '../lib/types'
import { useAuth } from './auth'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TrackersState {
  status: Status
  error: string | null
  trackers: Tracker[]
  selectedId: string | null
  load: () => Promise<void>
  select: (id: string) => void
  create: (name: string) => Promise<Tracker>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reset: () => void
}

const cleanName = (n: string) => n.trim().replace(/\s+/g, ' ')

export function validateTrackerName(name: string): string | null {
  const n = cleanName(name)
  if (!n) return 'Tracker name is required.'
  if (n.length > 60) return 'Tracker name must be at most 60 characters.'
  return null
}

function rememberSelection(id: string | null) {
  const { profile, updateProfile } = useAuth.getState()
  if (profile && profile.last_tracker_id !== id) updateProfile({ last_tracker_id: id }).catch(() => {})
}

export const useTrackers = create<TrackersState>((set, get) => ({
  status: 'idle',
  error: null,
  trackers: [],
  selectedId: null,

  load: async () => {
    set({ status: 'loading', error: null })
    const { data, error } = await supabase
      .from('trackers')
      .select('id, name, created_at, updated_at')
      .order('created_at', { ascending: true })
    if (error) {
      set({ status: 'error', error: friendlyError(error) })
      return
    }
    const trackers = data as Tracker[]
    const preferred = useAuth.getState().profile?.last_tracker_id
    const current = get().selectedId
    const selectedId =
      trackers.find((t) => t.id === current)?.id ??
      trackers.find((t) => t.id === preferred)?.id ??
      trackers[0]?.id ??
      null
    set({ status: 'ready', trackers, selectedId })
  },

  select: (id) => {
    if (get().selectedId === id) return
    set({ selectedId: id })
    rememberSelection(id)
  },

  create: async (name) => {
    const { data, error } = await supabase
      .from('trackers')
      .insert({ name: cleanName(name) })
      .select('id, name, created_at, updated_at')
      .single()
    if (error) throw new Error(friendlyError(error))
    const tracker = data as Tracker
    analytics.track('tracker_created')
    set({ trackers: [...get().trackers, tracker], selectedId: tracker.id })
    rememberSelection(tracker.id)
    return tracker
  },

  rename: async (id, name) => {
    const prev = get().trackers
    const clean = cleanName(name)
    set({ trackers: prev.map((t) => (t.id === id ? { ...t, name: clean } : t)) })
    const { error } = await supabase.from('trackers').update({ name: clean }).eq('id', id)
    if (error) {
      set({ trackers: prev })
      throw new Error(friendlyError(error))
    }
  },

  remove: async (id) => {
    const { error } = await supabase.from('trackers').delete().eq('id', id)
    if (error) throw new Error(friendlyError(error))
    analytics.track('tracker_deleted')
    const trackers = get().trackers.filter((t) => t.id !== id)
    const selectedId = get().selectedId === id ? (trackers[0]?.id ?? null) : get().selectedId
    set({ trackers, selectedId })
    rememberSelection(selectedId)
  },

  reset: () => set({ status: 'idle', error: null, trackers: [], selectedId: null }),
}))
