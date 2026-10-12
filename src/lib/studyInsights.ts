// Study insights (weak-subject detection) and study plans. The database
// decides who sees what (study_insights / class_study_insights); plans are
// computed with the shared timetable rules and saved through
// apply_timetable_change, so they appear in History and can be undone.
import { callFunction } from './functions'
import { supabase } from './supabase'
import {
  applyChange, loadAnswers, loadContext, planStudyBoost, schoolBlocks, timetableVersion,
  type AiNote, type Busy, type InsightStatus, type StudyPlan, type SubjectInsight,
} from './timetableAi'

export interface Reason {
  kind: 'concern' | 'strength' | 'info'
  text: string
}
export interface SubjectEvidence {
  assessments?: { date: string; title: string; kind: string; pct: number }[]
  marks_count?: number
  recent_avg?: number | null
  overall_avg?: number | null
  change?: number | null
  absent?: number
  homework?: { expected: number; missing: number; late: number; needs_changes: number; completion: number | null }
  confidence?: number | null
  exam?: { title: string; starts_on: string } | null
  revisit?: string[]
  topics_available?: boolean
}
export interface SubjectInsightFull extends SubjectInsight {
  indicator: number | null
  reasons: Reason[]
  evidence: SubjectEvidence
  analysed_at: string
  history: { status: InsightStatus; indicator: number | null; at: string }[]
}
export interface StudyRules {
  window_days: number
  min_assessments: number
  min_homework: number
  attention_below: number
  strong_from: number
  decline_points: number
  homework_attention_below: number
  marks_weight: number
  refresh_days: number
  extra_minutes: Record<'needs_attention' | 'improving' | 'on_track' | 'strong', number>
  exam_bonus_minutes: number
  max_daily_study_minutes: number
}
export interface StudyInsights {
  student_id: string
  student: string
  institution_id: string
  viewer: 'student' | 'staff' | 'parent'
  analysed_at: string
  rules: StudyRules
  subjects: SubjectInsightFull[]
}
export interface ClassInsightRow {
  student_id: string
  student: string
  roll_no: string | null
  subject_id: string
  subject: string
  status: InsightStatus
  indicator: number | null
  recommended_minutes: number
  top_reason: string | null
}
export type PlanMode = 'off' | 'recommend' | 'auto'
export interface PlanSettings {
  mode: PlanMode
  max_daily_study_minutes: number | null
  tracker_id: string | null
  last_applied_signature: string | null
  last_applied_at: string | null
}

export const STATUS_LABEL: Record<InsightStatus, string> = {
  needs_attention: 'Needs attention',
  improving: 'Improving',
  on_track: 'On track',
  strong: 'Strong',
  insufficient_data: 'Not enough data',
}
export const STATUS_TONE: Record<InsightStatus, 'danger' | 'brand' | 'muted' | 'success' | 'warning'> = {
  needs_attention: 'warning',
  improving: 'brand',
  on_track: 'muted',
  strong: 'success',
  insufficient_data: 'muted',
}
export const STATUS_ORDER: InsightStatus[] = ['needs_attention', 'improving', 'on_track', 'strong', 'insufficient_data']
export const MODE_LABEL: Record<PlanMode, string> = {
  off: 'Off',
  recommend: 'Suggest changes for me to review',
  auto: 'Adjust my study sessions automatically',
}

export async function loadInsights(studentId: string): Promise<StudyInsights> {
  const { data, error } = await supabase.rpc('study_insights', { p_student: studentId })
  if (error) throw error
  const r = data as StudyInsights
  r.subjects.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.subject.localeCompare(b.subject))
  return r
}

export async function loadClassInsights(classId: string): Promise<ClassInsightRow[]> {
  const { data, error } = await supabase.rpc('class_study_insights', { p_class: classId })
  if (error) throw error
  return data as ClassInsightRow[]
}

export async function setConfidence(institutionId: string, subjectId: string, confidence: number | null) {
  const { error } = await supabase.rpc('set_subject_confidence', { p_inst: institutionId, p_subject: subjectId, p_confidence: confidence })
  if (error) throw error
}

export async function saveRules(institutionId: string, rules: Partial<StudyRules>) {
  const { data, error } = await supabase.rpc('set_study_rules', { p_inst: institutionId, p_rules: rules })
  if (error) throw error
  return data as StudyRules
}

const DEFAULT_SETTINGS: PlanSettings = { mode: 'recommend', max_daily_study_minutes: null, tracker_id: null, last_applied_signature: null, last_applied_at: null }

export async function loadPlanSettings(): Promise<PlanSettings> {
  const { data, error } = await supabase.from('study_plan_settings').select('mode, max_daily_study_minutes, tracker_id, last_applied_signature, last_applied_at').maybeSingle()
  if (error) throw error
  return (data as PlanSettings | null) ?? DEFAULT_SETTINGS
}

export async function savePlanSettings(patch: Partial<PlanSettings>) {
  const { error } = await supabase.from('study_plan_settings').upsert(patch, { onConflict: 'user_id' })
  if (error) throw error
}

/** Everything the plan respects: school periods, fixed commitments, waking hours. */
export async function planInputs(): Promise<{ busy: Busy[]; wake: string | null; sleep: string | null }> {
  const [ctx, answers] = await Promise.all([loadContext(), loadAnswers()])
  const busy = schoolBlocks(ctx.periods)
  for (const c of answers.commitments ?? []) for (const d of c.days ?? []) busy.push({ day: d, start: c.start, end: c.end, label: c.label })
  return { busy, wake: answers.wake ?? null, sleep: answers.sleep ?? null }
}

/** The timetable as the plan needs it, read with the student's own access. */
export async function loadTimetable(trackerId: string) {
  const [sl, tk, version] = await Promise.all([
    supabase.from('time_slots').select('id, start_time, end_time').eq('tracker_id', trackerId),
    supabase.from('tasks').select('id, time_slot_id, day_of_week, title, category, description').eq('tracker_id', trackerId),
    timetableVersion(trackerId),
  ])
  if (sl.error) throw sl.error
  if (tk.error) throw tk.error
  return { slots: sl.data, tasks: tk.data, version }
}

export async function makePlan(trackerId: string, insights: StudyInsights, settings: PlanSettings): Promise<{ plan: StudyPlan; version: string }> {
  const [tt, inputs] = await Promise.all([loadTimetable(trackerId), planInputs()])
  const plan = planStudyBoost(tt.slots, tt.tasks, insights.subjects, {
    ...inputs,
    maxDailyStudy: settings.max_daily_study_minutes ?? insights.rules.max_daily_study_minutes,
  })
  return { plan, version: tt.version }
}

/** Saves a plan (one transaction, refused if the timetable changed since it was made). */
export async function applyPlan(trackerId: string, plan: StudyPlan, version: string) {
  const res = await applyChange(trackerId, { base: version, source: 'ai_study_plan', summary: plan.summary, ops: plan.ops })
  await savePlanSettings({ last_applied_signature: plan.signature, last_applied_at: new Date().toISOString() })
  return res
}

/**
 * Automatic mode: applies the plan once per set of insights (signature), only
 * to study sessions, and only within the student's limits. Returns the plan
 * that was applied, or null when nothing was done.
 */
export async function autoApply(studentId: string, fallbackTrackerId: string | null): Promise<StudyPlan | null> {
  const settings = await loadPlanSettings()
  const trackerId = settings.tracker_id ?? fallbackTrackerId
  if (settings.mode !== 'auto' || !trackerId) return null
  const insights = await loadInsights(studentId)
  const { plan, version } = await makePlan(trackerId, insights, settings)
  if (!plan.ops.length || plan.signature === settings.last_applied_signature) return null
  await applyPlan(trackerId, plan, version)
  return plan
}

export interface AdviceResult {
  plan: StudyPlan
  version: string
  advice: { summary: string; tips: { title: string; detail: string }[] } | null
  ai: AiNote | null
}
export const studyAdvice = (studentId: string, trackerId: string) =>
  callFunction<AdviceResult>('timetable-ai', { action: 'study_advice', student_id: studentId, tracker_id: trackerId, request_id: crypto.randomUUID() })
