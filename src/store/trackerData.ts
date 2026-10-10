import { create } from 'zustand'
import { analytics } from '../lib/analytics'
import { friendlyError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { sortSlots } from '../lib/time'
import { completionKey, type Completion, type Task, type TaskInput, type TimeSlot } from '../lib/types'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TrackerDataState {
  trackerId: string | null
  status: Status
  error: string | null
  slots: TimeSlot[]
  tasks: Task[]
  /** "<taskId>|<date>" -> completed */
  completions: Record<string, boolean>

  load: (trackerId: string | null) => Promise<void>
  /** Re-reads the current timetable without showing the loading state (after a saved change). */
  refresh: () => Promise<void>
  addSlot: (start: string, end: string) => Promise<TimeSlot>
  updateSlot: (id: string, start: string, end: string) => Promise<void>
  deleteSlot: (id: string) => Promise<void>
  addTask: (input: TaskInput) => Promise<Task>
  updateTask: (id: string, input: TaskInput) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  setCompleted: (taskId: string, date: string, completed: boolean) => Promise<void>
  reset: () => void
}

const SLOT_COLS = 'id, tracker_id, start_time, end_time, created_at'
const TASK_COLS = 'id, tracker_id, time_slot_id, day_of_week, title, description, category, created_at, updated_at'
const PAGE = 1000

let loadSeq = 0
/** Latest write per completion key, so out-of-order responses can't clobber newer clicks. */
const toggleSeq = new Map<string, number>()

async function fetchAllCompletions(trackerId: string): Promise<Completion[]> {
  const rows: Completion[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('task_completions')
      .select('task_id, completion_date, completed')
      .eq('tracker_id', trackerId)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data as Completion[]))
    if (data.length < PAGE) return rows
  }
}

const cleanTask = (input: TaskInput) => ({
  title: input.title.trim().replace(/\s+/g, ' '),
  description: input.description?.trim() || null,
  category: input.category,
  time_slot_id: input.time_slot_id,
  day_of_week: input.day_of_week,
})

export const useTrackerData = create<TrackerDataState>((set, get) => ({
  trackerId: null,
  status: 'idle',
  error: null,
  slots: [],
  tasks: [],
  completions: {},

  refresh: async () => {
    const trackerId = get().trackerId
    if (trackerId) await loadInto(trackerId, true)
  },

  load: async (trackerId) => {
    if (!trackerId) {
      ++loadSeq
      set({ trackerId: null, status: 'idle', error: null, slots: [], tasks: [], completions: {} })
      return
    }
    await loadInto(trackerId, false)
  },

  addSlot: async (start, end) => {
    const trackerId = get().trackerId
    if (!trackerId) throw new Error('No tracker selected.')
    const { data, error } = await supabase
      .from('time_slots')
      .insert({ tracker_id: trackerId, start_time: start, end_time: end })
      .select(SLOT_COLS)
      .single()
    if (error) throw new Error(friendlyError(error))
    const slot = data as TimeSlot
    set({ slots: sortSlots([...get().slots, slot]) })
    return slot
  },

  updateSlot: async (id, start, end) => {
    const { data, error } = await supabase
      .from('time_slots')
      .update({ start_time: start, end_time: end })
      .eq('id', id)
      .select(SLOT_COLS)
      .single()
    if (error) throw new Error(friendlyError(error))
    set({ slots: sortSlots(get().slots.map((s) => (s.id === id ? (data as TimeSlot) : s))) })
  },

  deleteSlot: async (id) => {
    const { error } = await supabase.from('time_slots').delete().eq('id', id)
    if (error) throw new Error(friendlyError(error))
    const removed = new Set(get().tasks.filter((t) => t.time_slot_id === id).map((t) => t.id))
    const completions = Object.fromEntries(
      Object.entries(get().completions).filter(([k]) => !removed.has(k.split('|')[0])),
    )
    set({
      slots: get().slots.filter((s) => s.id !== id),
      tasks: get().tasks.filter((t) => t.time_slot_id !== id),
      completions,
    })
  },

  addTask: async (input) => {
    const trackerId = get().trackerId
    if (!trackerId) throw new Error('No tracker selected.')
    const { data, error } = await supabase
      .from('tasks')
      .insert({ tracker_id: trackerId, ...cleanTask(input) })
      .select(TASK_COLS)
      .single()
    if (error) throw new Error(friendlyError(error))
    const task = data as Task
    analytics.track('task_created')
    set({ tasks: [...get().tasks, task] })
    return task
  },

  updateTask: async (id, input) => {
    const { data, error } = await supabase
      .from('tasks')
      .update(cleanTask(input))
      .eq('id', id)
      .select(TASK_COLS)
      .single()
    if (error) throw new Error(friendlyError(error))
    set({ tasks: get().tasks.map((t) => (t.id === id ? (data as Task) : t)) })
  },

  deleteTask: async (id) => {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) throw new Error(friendlyError(error))
    const completions = Object.fromEntries(
      Object.entries(get().completions).filter(([k]) => !k.startsWith(`${id}|`)),
    )
    set({ tasks: get().tasks.filter((t) => t.id !== id), completions })
  },

  setCompleted: async (taskId, date, completed) => {
    const trackerId = get().trackerId
    if (!trackerId) return
    const key = completionKey(taskId, date)
    const previous = get().completions[key]
    const seq = (toggleSeq.get(key) ?? 0) + 1
    toggleSeq.set(key, seq)
    // Optimistic: only this key changes, so only the affected cell re-renders.
    set({ completions: { ...get().completions, [key]: completed } })
    const { error } = await supabase
      .from('task_completions')
      .upsert(
        { task_id: taskId, tracker_id: trackerId, completion_date: date, completed },
        { onConflict: 'task_id,completion_date' },
      )
    if (!error) analytics.track(completed ? 'task_completed' : 'task_uncompleted')
    if (error && toggleSeq.get(key) === seq && get().trackerId === trackerId) {
      const next = { ...get().completions }
      if (previous === undefined) delete next[key]
      else next[key] = previous
      set({ completions: next })
      throw new Error(friendlyError(error, 'Could not save. Please try again.'))
    }
  },

  reset: () => {
    loadSeq++
    set({ trackerId: null, status: 'idle', error: null, slots: [], tasks: [], completions: {} })
  },
}))

/** Loads a timetable into the store; quiet keeps the current data on screen until the new data arrives. */
async function loadInto(trackerId: string, quiet: boolean) {
  const seq = ++loadSeq
  const set = useTrackerData.setState
  if (!quiet) set({ trackerId, status: 'loading', error: null, slots: [], tasks: [], completions: {} })
  try {
    const [slotsRes, tasksRes, completions] = await Promise.all([
      supabase.from('time_slots').select(SLOT_COLS).eq('tracker_id', trackerId),
      supabase.from('tasks').select(TASK_COLS).eq('tracker_id', trackerId).order('created_at'),
      fetchAllCompletions(trackerId),
    ])
    if (slotsRes.error) throw slotsRes.error
    if (tasksRes.error) throw tasksRes.error
    if (seq !== loadSeq) return
    const map: Record<string, boolean> = {}
    for (const c of completions) map[completionKey(c.task_id, c.completion_date)] = c.completed
    set({
      status: 'ready',
      slots: sortSlots(slotsRes.data as TimeSlot[]),
      tasks: tasksRes.data as Task[],
      completions: map,
    })
  } catch (err) {
    // a quiet refresh keeps what's on screen if it fails
    if (seq === loadSeq && !quiet) set({ status: 'error', error: friendlyError(err) })
  }
}
