import { ArrowDownRight, ArrowUpRight, CalendarClock, Check, History, Info, Lightbulb, Minus, Plus, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { friendlyError } from '../../lib/errors'
import {
  applyPlan, loadInsights, loadPlanSettings, makePlan, MODE_LABEL, savePlanSettings, setConfidence, STATUS_LABEL, STATUS_ORDER, STATUS_TONE, studyAdvice,
  type AdviceResult, type PlanMode, type PlanSettings, type StudyInsights, type SubjectInsightFull,
} from '../../lib/studyInsights'
import { DAYS, fmtMin, type StudyPlan } from '../../lib/timetableAi'
import { useLoad } from '../../lib/useLoad'
import { useTrackerData } from '../../store/trackerData'
import { useTrackers } from '../../store/trackers'
import { toast } from '../../store/ui'
import { HistoryModal } from '../timetable-ai/HistoryModal'
import { AiNoteBox } from '../timetable-ai/shared'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Pill, SelectField } from './ui'

const dateText = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const REASON_TONE = { concern: 'text-amber-700 dark:text-amber-300', strength: 'text-success', info: 'text-muted' } as const

export const GUIDANCE_NOTE =
  'This is guidance from published marks and homework, not a judgement of ability. Subjects without enough data are left out instead of counting as zero.'

/** One subject: status, why, recent results and what to do. */
export function SubjectInsightCard({ s, viewer, onConfidence }: {
  s: SubjectInsightFull
  viewer: StudyInsights['viewer']
  onConfidence?: (value: number | null) => void
}) {
  const e = s.evidence ?? {}
  const trend = e.change === null || e.change === undefined ? null : e.change
  const TrendIcon = trend === null ? null : trend > 2 ? ArrowUpRight : trend < -2 ? ArrowDownRight : Minus
  return (
    <li className="card min-w-0 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{s.subject}</h3>
          <p className="text-xs text-muted">Analysed {dateText(s.analysed_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          {s.indicator !== null && (
            <span className="text-sm tabular-nums text-muted" title="Indicator from recent results and homework (0–100)">
              {Math.round(Number(s.indicator))}
            </span>
          )}
          {TrendIcon && <TrendIcon className={`size-4 ${trend! < -2 ? 'text-danger' : trend! > 2 ? 'text-success' : 'text-muted'}`} aria-label={`Change ${trend} points`} />}
          <Pill tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Pill>
        </div>
      </div>

      {s.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {s.reasons.map((r) => (
            <li key={r.text} className={`flex gap-2 ${REASON_TONE[r.kind]}`}>
              <span aria-hidden="true">{r.kind === 'concern' ? '•' : r.kind === 'strength' ? '✓' : '–'}</span>
              <span className="min-w-0 break-words">{r.text}</span>
            </li>
          ))}
        </ul>
      )}

      {e.assessments && e.assessments.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-muted">Recent results</p>
          <ol className="flex flex-wrap gap-1.5" aria-label="Recent results, oldest first">
            {e.assessments.map((a) => (
              <li key={`${a.date}-${a.title}`} className="rounded-lg bg-subtle px-2 py-1 text-xs tabular-nums" title={`${a.title} · ${a.date}`}>
                {Math.round(a.pct)}%
              </li>
            ))}
          </ol>
        </div>
      )}
      {e.revisit && e.revisit.length > 0 && (
        <p className="mt-2 text-xs text-muted">Worth revisiting: {e.revisit.join(', ')}. Topic-level detail isn’t recorded, so ask your teacher which topics to focus on.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm">
        <span>
          {s.recommended_minutes > 0 ? (
            <><Plus className="mr-1 inline size-3.5 text-brand" aria-hidden="true" />{fmtMin(s.recommended_minutes)} extra study a week suggested</>
          ) : s.recommended_minutes < 0 ? (
            <span className="text-muted">Could give {fmtMin(-s.recommended_minutes)} a week to other subjects</span>
          ) : (
            <span className="text-muted">No change suggested</span>
          )}
        </span>
        {viewer === 'student' && onConfidence && (
          <label className="flex items-center gap-2 text-xs text-muted">
            My confidence
            <select
              className="input h-8 w-auto py-0 text-sm"
              value={e.confidence ?? ''}
              onChange={(ev) => onConfidence(ev.target.value ? Number(ev.target.value) : null)}
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
            </select>
          </label>
        )}
      </div>
      {s.history.length > 1 && (
        <p className="mt-2 text-xs text-muted">
          Earlier: {s.history.slice(0, -1).map((h) => `${STATUS_LABEL[h.status]} (${dateText(h.at)})`).join(' → ')}
        </p>
      )}
    </li>
  )
}

export function SubjectInsightList({ data, onConfidence }: { data: StudyInsights; onConfidence?: (subjectId: string, value: number | null) => void }) {
  if (!data.subjects.length) {
    return <p className="py-6 text-center text-sm text-muted">No subjects to analyse yet. Subjects appear once a class has teachers or published marks.</p>
  }
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {data.subjects.map((s) => (
        <SubjectInsightCard key={s.subject_id} s={s} viewer={data.viewer} onConfidence={onConfidence ? (v) => onConfidence(s.subject_id, v) : undefined} />
      ))}
    </ul>
  )
}

/** Staff (by subject) and parents (summary) view one student. */
export function StudentInsightsModal({ studentId, student, onClose }: { studentId: string; student: string; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => loadInsights(studentId), [studentId])
  return (
    <Modal open onClose={onClose} size="lg" title={`Study insights: ${student}`} subtitle={data?.viewer === 'staff' ? 'Subjects you can see' : undefined}
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {loading && !data && <p className="flex justify-center py-10"><Spinner /></p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {data && (
        <div className="space-y-4">
          <SubjectInsightList data={data} />
          <p className="text-xs text-muted">{GUIDANCE_NOTE} Wrong marks can be corrected by the subject teacher on the Marks page (with a reason); the analysis updates automatically.</p>
        </div>
      )}
    </Modal>
  )
}

/** Short summary for a student's or parent's overview. */
export function StudyInsightsSummary({ studentId, link }: { studentId: string; link?: string }) {
  const { data, error } = useLoad(() => loadInsights(studentId), [studentId])
  if (error) return null
  const attention = data?.subjects.filter((s) => s.status === 'needs_attention') ?? []
  const improving = data?.subjects.filter((s) => s.status === 'improving') ?? []
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="study-sum">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Lightbulb className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="study-sum" className="font-semibold">Study insights</h2>
          <p className="text-sm text-muted">
            {!data ? 'Loading…'
              : !data.subjects.length ? 'Nothing to analyse yet.'
              : attention.length ? `Needs attention: ${attention.map((s) => s.subject).join(', ')}.${improving.length ? ` Improving: ${improving.map((s) => s.subject).join(', ')}.` : ''}`
              : improving.length ? `Improving: ${improving.map((s) => s.subject).join(', ')}. No subject needs extra attention right now.`
              : 'No subject needs extra attention right now.'}
          </p>
        </div>
        {link && <Link to={link} className="btn-secondary">Open</Link>}
      </div>
      {data && !link && data.subjects.length > 0 && (
        <ul className="mt-4 divide-y divide-line text-sm">
          {data.subjects.map((s) => (
            <li key={s.subject_id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="font-medium">{s.subject}</p>
                {s.reasons[0] && <p className="text-xs text-muted">{s.reasons.find((r) => r.kind === 'concern')?.text ?? s.reasons[0].text}</p>}
              </div>
              <Pill tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Pill>
            </li>
          ))}
        </ul>
      )}
      {data && !link && <p className="mt-3 text-xs text-muted">{GUIDANCE_NOTE}</p>}
    </section>
  )
}

/** The student's plan: settings, preview with reasons, apply, history/undo. */
export function StudyPlanPanel({ insights, onApplied }: { insights: StudyInsights; onApplied?: () => void }) {
  const trackers = useTrackers((s) => s.trackers)
  const selectedTracker = useTrackers((s) => s.selectedId)
  const [settings, setSettings] = useState<PlanSettings | null>(null)
  const [preview, setPreview] = useState<{ plan: StudyPlan; version: string } | null>(null)
  const [advice, setAdvice] = useState<AdviceResult | null>(null)
  const [busy, setBusy] = useState<'plan' | 'apply' | 'advice' | null>(null)
  const [history, setHistory] = useState(false)

  useEffect(() => {
    if (useTrackers.getState().status === 'idle') useTrackers.getState().load()
    loadPlanSettings().then(setSettings, (e) => toast.error(friendlyError(e)))
  }, [])
  const trackerId = settings?.tracker_id ?? selectedTracker
  const limit = settings?.max_daily_study_minutes ?? insights.rules.max_daily_study_minutes

  const update = async (patch: Partial<PlanSettings>) => {
    const next = { ...settings!, ...patch }
    setSettings(next)
    setPreview(null)
    setAdvice(null)
    try {
      await savePlanSettings(patch)
    } catch (e) {
      toast.error(friendlyError(e))
    }
  }

  const build = async () => {
    if (!trackerId || !settings) return
    setBusy('plan')
    setAdvice(null)
    try {
      setPreview(await makePlan(trackerId, insights, settings))
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const explain = async () => {
    if (!trackerId) return
    setBusy('advice')
    try {
      const r = await studyAdvice(insights.student_id, trackerId)
      setAdvice(r)
      setPreview({ plan: r.plan, version: r.version })
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const apply = async () => {
    if (!trackerId || !preview) return
    setBusy('apply')
    try {
      await applyPlan(trackerId, preview.plan, preview.version)
      if (useTrackers.getState().selectedId === trackerId) await useTrackerData.getState().refresh()
      toast.success('Study plan saved. You can undo it from History.')
      setPreview(null)
      setAdvice(null)
      onApplied?.()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  if (!settings) return <div className="card flex justify-center p-8"><Spinner /></div>
  const plan = preview?.plan

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="plan-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="plan-title" className="flex items-center gap-2 font-semibold"><CalendarClock className="size-5 text-brand" aria-hidden="true" /> My study plan</h2>
          <p className="mt-0.5 text-sm text-muted">
            Changes only your study sessions — never school periods, exams, fixed commitments or other activities. Every change is shown with its reason and can be undone.
          </p>
        </div>
        {trackerId && (
          <button type="button" className="btn-secondary" onClick={() => setHistory(true)}>
            <History className="size-4" aria-hidden="true" /> History
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Mode" value={settings.mode} onChange={(e) => update({ mode: e.target.value as PlanMode })}>
          {(['recommend', 'auto', 'off'] as PlanMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </SelectField>
        <SelectField label="Timetable" value={trackerId ?? ''} onChange={(e) => update({ tracker_id: e.target.value || null })}>
          {!trackers.length && <option value="">No timetables yet</option>}
          {trackers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </SelectField>
        <SelectField label="Most study a day" value={String(limit)} onChange={(e) => update({ max_daily_study_minutes: Number(e.target.value) })}
          hint={settings.max_daily_study_minutes === null ? 'Your school’s default' : undefined}>
          {[60, 90, 120, 150, 180, 240, 300].map((m) => <option key={m} value={m}>{fmtMin(m)}</option>)}
        </SelectField>
      </div>
      {settings.mode === 'auto' && (
        <p className="mt-3 flex gap-2 rounded-xl bg-subtle px-3.5 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          When your results change, HabbitFlows adjusts your study sessions within these limits the next time you open the app, and tells you. Undo any change from History.
        </p>
      )}

      {settings.mode !== 'off' && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={build} disabled={!trackerId || !!busy}>
            {busy === 'plan' ? <Spinner className="size-4" /> : <RefreshCw className="size-4" aria-hidden="true" />}
            {plan ? 'Recalculate' : 'Preview changes'}
          </button>
          <button type="button" className="btn-secondary" onClick={explain} disabled={!trackerId || !!busy}>
            {busy === 'advice' ? <Spinner className="size-4" /> : <Sparkles className="size-4 text-brand" aria-hidden="true" />}
            Explain with AI
          </button>
        </div>
      )}
      {!trackerId && <p className="mt-3 text-sm text-muted">Create a timetable on the Dashboard first.</p>}

      {advice?.ai && <div className="mt-4"><AiNoteBox note={advice.ai} fallback="The plan below still works without it." /></div>}
      {advice?.advice && (
        <section className="mt-4 rounded-xl bg-subtle p-3.5 text-sm">
          <p>{advice.advice.summary}</p>
          {advice.advice.tips.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {advice.advice.tips.map((t) => <li key={t.title}><span className="font-medium">{t.title}.</span> {t.detail}</li>)}
            </ul>
          )}
        </section>
      )}

      {plan && (
        <div className="mt-4 space-y-3">
          {plan.changes.length === 0 ? (
            <p className="rounded-xl bg-subtle px-3.5 py-3 text-sm">No changes needed — your study time already matches what your results suggest.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {plan.changes.map((c) => (
                <li key={`${c.slot_id}-${c.day}`} className="p-3 text-sm">
                  <p className="font-medium">
                    {DAYS[c.day]} {c.start}–{c.end}: {c.kind === 'add' ? <>add <span className="text-brand">{c.title}</span></> : <>“{c.from_title}” → <span className="text-brand">{c.title}</span></>}
                    <span className="font-normal text-muted"> · {fmtMin(c.minutes)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{c.reason}</p>
                </li>
              ))}
            </ul>
          )}
          {plan.tradeoffs.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {plan.tradeoffs.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
          {plan.changes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={apply} disabled={!!busy}>
                {busy === 'apply' ? <Spinner className="size-4" /> : <Check className="size-4" aria-hidden="true" />}
                Save these changes
              </button>
              <button type="button" className="btn-secondary" onClick={() => setPreview(null)} disabled={!!busy}>Not now</button>
            </div>
          )}
        </div>
      )}
      {trackerId && <HistoryModal open={history} onClose={() => setHistory(false)} trackerId={trackerId} />}
    </section>
  )
}

/** The student's whole view: insights with confidence, then the plan. */
export function MyStudyInsights({ studentId, institutionId }: { studentId: string; institutionId: string }) {
  const { data, error, loading, reload, setData } = useLoad(() => loadInsights(studentId), [studentId])
  const confidence = async (subjectId: string, value: number | null) => {
    try {
      await setConfidence(institutionId, subjectId, value)
      reload()
    } catch (e) {
      toast.error(friendlyError(e))
    }
  }
  if (loading && !data) return <div className="card flex justify-center p-10"><Spinner /></div>
  if (error || !data) return <p className="text-sm text-danger" role="alert">{error}</p>
  const counts = STATUS_ORDER.map((s) => [s, data.subjects.filter((x) => x.status === s).length] as const).filter(([, n]) => n)
  return (
    <div className="space-y-5">
      {counts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {counts.map(([s, n]) => <Pill key={s} tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}: {n}</Pill>)}
        </div>
      )}
      <SubjectInsightList data={data} onConfidence={confidence} />
      <p className="text-xs text-muted">
        {GUIDANCE_NOTE} Updated when new marks or homework results arrive, and at least every {data.rules.refresh_days} days. If a mark looks wrong, ask your teacher — they can correct it.
      </p>
      <StudyPlanPanel insights={data} onApplied={() => setData({ ...data })} />
    </div>
  )
}
