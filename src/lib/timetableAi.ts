// AI timetable assistant: calls to the timetable-ai function, saving changes
// (always through apply_timetable_change after the student confirms), the
// needs-check questions and an offline command parser.
import {
  CATEGORIES, mins, normalizeCommand, type Busy, type Category, type Command, type Evaluation, type Move, type Op, type Proposal,
} from '../../supabase/functions/_shared/timetable-core.ts'
import { callFunction } from './functions'
import { supabase } from './supabase'

export * from '../../supabase/functions/_shared/timetable-core.ts'

export interface Commitment {
  label: string
  days: number[]
  start: string
  end: string
}
export interface Answers {
  goals?: string[]
  focus_subjects?: string[]
  commitments?: Commitment[]
  wake?: string
  sleep?: string
  school_days?: number[]
  school_start?: string
  school_end?: string
  best_focus?: string
  study_hours?: string
  keep?: string
  drop?: string
  extra?: string
}

export interface TimetableContext {
  student: boolean
  institution: string | null
  classes: string[]
  periods: { day: number; start: string; end: string; subject: string | null }[]
  deadlines: { title: string; subject: string | null; kind: string; due_at: string }[]
  exams: { title: string; subject: string | null; starts_on: string; ends_on: string }[]
  holidays: { title: string; starts_on: string; ends_on: string }[]
}

export interface GenerateResult {
  name: string
  summary: string
  choices: { what: string; why: string }[]
  impossible: string[]
  proposal: Proposal
  dropped: { what: string; reason: string }[]
  busy: Busy[]
}
/** Why the AI part wasn't used (quota, not configured…); the rest of the answer still stands. */
export interface AiNote {
  code: string
  error: string
  resets_at?: string
  institution?: boolean
}
export interface EvaluateResult {
  evaluation: Evaluation
  advice: { summary: string; items: { title: string; detail: string }[] } | null
  ai: AiNote | null
}
export interface RescheduleInput {
  label: string
  days: number[]
  start: string | null
  end: string | null
}
export interface RescheduleResult {
  version: string
  displaced: number
  moves: Move[]
  explanation: string
  ai: AiNote | null
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rid = () => crypto.randomUUID()

export const timetableAi = {
  generate: (answers: Answers) => callFunction<GenerateResult>('timetable-ai', { action: 'generate', answers, today: today(), request_id: rid() }),
  evaluate: (trackerId: string) => callFunction<EvaluateResult>('timetable-ai', { action: 'evaluate', tracker_id: trackerId, today: today(), request_id: rid() }),
  reschedule: (trackerId: string, event: RescheduleInput) =>
    callFunction<RescheduleResult>('timetable-ai', { action: 'reschedule', tracker_id: trackerId, event, today: today(), request_id: rid() }),
  command: async (text: string) => {
    const now = new Date()
    const res = await callFunction<{ command: Command }>('timetable-ai', {
      action: 'command',
      text,
      today: today(),
      now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      request_id: rid(),
    })
    return normalizeCommand(res.command)
  },
}

export async function loadContext(): Promise<TimetableContext> {
  const { data, error } = await supabase.rpc('my_timetable_context')
  if (error) throw error
  return data as TimetableContext
}

export async function loadAnswers(): Promise<Answers> {
  const { data } = await supabase.from('timetable_preferences').select('answers').maybeSingle()
  return (data?.answers as Answers) ?? {}
}

export async function saveAnswers(answers: Answers) {
  const { error } = await supabase.from('timetable_preferences').upsert({ answers }, { onConflict: 'user_id' })
  if (error) throw error
}

export async function timetableVersion(trackerId: string): Promise<string> {
  const { data, error } = await supabase.rpc('timetable_version', { p_tracker: trackerId })
  if (error) throw error
  return data as string
}

export type ChangeSource = 'ai_generate' | 'ai_reschedule' | 'voice'

/** Saves a confirmed change in one transaction. trackerId null = new timetable named `name`. */
export async function applyChange(trackerId: string | null, opts: { name?: string; base?: string | null; source: ChangeSource; summary: string; ops: Op[] }) {
  const { data, error } = await supabase.rpc('apply_timetable_change', {
    p_tracker: trackerId,
    p_new_name: opts.name ?? null,
    p_base_version: opts.base ?? null,
    p_source: opts.source,
    p_summary: opts.summary.slice(0, 300),
    p_ops: opts.ops,
  })
  if (error) throw error
  return data as { tracker_id: string; change_id: string; version: string }
}

export interface ChangeRow {
  id: string
  tracker_id: string
  source: ChangeSource | 'undo' | 'teacher'
  /** set when a class teacher made the change */
  actor_name: string | null
  summary: string
  inverse: unknown[] | null
  undo_of: string | null
  undone_at: string | null
  created_at: string
}

export async function loadHistory(trackerId: string): Promise<ChangeRow[]> {
  const { data, error } = await supabase
    .from('timetable_changes')
    .select('id, tracker_id, source, summary, inverse, undo_of, undone_at, created_at, actor_name')
    .eq('tracker_id', trackerId)
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw error
  return data as ChangeRow[]
}

export async function undoChange(id: string) {
  const { error } = await supabase.rpc('undo_timetable_change', { p_change: id })
  if (error) throw error
}

/** The one change that can be undone right now: the newest one not yet undone. */
export const undoable = (rows: ChangeRow[]) => rows.find((r) => r.source !== 'undo' && !r.undone_at && r.inverse)?.id ?? null

// ---------------------------------------------------------------------------
// Needs check
// ---------------------------------------------------------------------------
export const GOALS = ['Exam preparation', 'Catching up on a subject', 'Homework on time', 'Learning a new skill', 'Fitness', 'Better sleep', 'More free time']
export const FOCUS_TIMES = ['Early morning', 'Morning', 'Afternoon', 'Evening', 'Late evening']
export const STUDY_HOURS = ['Under 1 hour', '1–2 hours', '2–3 hours', '3–4 hours', 'More than 4 hours']

export const categoryOk = (c: string): c is Category => (CATEGORIES as string[]).includes(c)
export const validTime = (t: string) => mins(t) !== null
