import { AlertTriangle, CheckCircle2, Mic, Plus, RotateCcw, School, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { quotaMessage, QUOTA_CODES } from '../../lib/aiQuota'
import { analytics } from '../../lib/analytics'
import { friendlyError } from '../../lib/errors'
import { FunctionError } from '../../lib/functions'
import { useSpeech } from '../../lib/speech'
import {
  applyChange, FOCUS_TIMES, GOALS, loadAnswers, loadContext, proposalToOps, saveAnswers, STUDY_HOURS, timetableAi, validTime,
  type Answers, type Commitment, type GenerateResult, type TimetableContext,
} from '../../lib/timetableAi'
import { useTrackers } from '../../store/trackers'
import { toast } from '../../store/ui'
import { usePrefs } from '../../store/view'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Chips, DayChips, ProposalPreview } from './shared'

type Step = 'loading' | 'questions' | 'thinking' | 'review'

const sectionCls = 'min-w-0 space-y-2.5 border-0 p-0'

/** Needs check → AI proposal → review → save as a new timetable. Nothing is saved without "Save". */
export function BuildTimetableModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { weekStart, timeFormat } = usePrefs()
  const [step, setStep] = useState<Step>('loading')
  const [ctx, setCtx] = useState<TimetableContext | null>(null)
  const [answers, setAnswers] = useState<Answers>({})
  const [saved, setSaved] = useState(false)
  const [subjectsText, setSubjectsText] = useState('')
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('loading')
    setResult(null)
    setError(null)
    Promise.all([loadContext().catch(() => null), loadAnswers().catch(() => ({}) as Answers)]).then(([c, a]) => {
      setCtx(c)
      setAnswers(a)
      setSaved(Object.keys(a).length > 0)
      setSubjectsText((a.focus_subjects ?? []).join(', '))
      setStep('questions')
    })
  }, [open])

  const speech = useSpeech((text) => setAnswers((a) => ({ ...a, extra: `${a.extra ? `${a.extra} ` : ''}${text}`.slice(0, 500) })))
  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setAnswers((a) => ({ ...a, [k]: v }))
  const schoolKnown = !!ctx?.periods.length
  const subjects = [...new Set((ctx?.periods ?? []).map((p) => p.subject).filter((s): s is string => !!s))]
  const commitments = answers.commitments ?? []
  const setCommitment = (i: number, patch: Partial<Commitment>) => set('commitments', commitments.map((c, n) => (n === i ? { ...c, ...patch } : c)))

  const generate = async (e?: FormEvent) => {
    e?.preventDefault()
    const clean: Answers = {
      ...answers,
      focus_subjects: subjectsText.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8),
      commitments: commitments.filter((c) => c.label.trim() && c.days.length && validTime(c.start) && validTime(c.end) && c.end > c.start),
    }
    if (clean.wake && clean.sleep && clean.wake === clean.sleep) return setError('Wake-up and sleep times can’t be the same.')
    setError(null)
    setAnswers(clean)
    saveAnswers(clean).catch(() => {})
    setStep('thinking')
    try {
      const r = await timetableAi.generate(clean)
      setResult(r)
      setName(r.name)
      setStep('review')
      analytics.track('ai_timetable_generated')
    } catch (err) {
      const f = err as FunctionError
      setError(QUOTA_CODES.has(f.code ?? '') ? quotaMessage(f) : f.code === 'ai_not_configured' ? 'The AI timetable builder isn’t switched on yet. Please try again later.' : f.message)
      setStep('questions')
    }
  }

  const save = async () => {
    if (!result) return
    const n = name.trim()
    if (!n || n.length > 60) return setError('Give the timetable a name (up to 60 characters).')
    setBusy(true)
    setError(null)
    try {
      const res = await applyChange(null, { name: n, source: 'ai_generate', summary: `Created “${n}” with the AI timetable builder`, ops: proposalToOps(result.proposal) })
      await useTrackers.getState().load()
      useTrackers.getState().select(res.tracker_id)
      toast.success(`“${n}” saved. It’s now your selected timetable.`)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const footer =
    step === 'questions' ? (
      <>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" form="ai-build-form" className="btn-primary">
          Build my timetable
        </button>
      </>
    ) : step === 'review' ? (
      <>
        <button type="button" className="btn-secondary" onClick={() => setStep('questions')} disabled={busy}>
          <RotateCcw className="size-4" aria-hidden="true" />
          Change answers
        </button>
        <button type="button" className="btn-primary" onClick={save} disabled={busy || !result?.proposal.entries.length}>
          {busy && <Spinner className="size-4" />}
          Save as new timetable
        </button>
      </>
    ) : undefined

  return (
    <Modal open={open} onClose={onClose} size="lg" title={step === 'review' ? 'Your proposed timetable' : 'Build a timetable with AI'}
      subtitle={step === 'review' ? 'Nothing is saved until you choose Save.' : 'A few questions first. Skip anything you like; your answers are saved for next time.'}
      footer={footer}>
      {(step === 'loading' || step === 'thinking') && (
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
          <Spinner className="size-5" /> {step === 'loading' ? 'Loading…' : 'Building your timetable… this can take up to a minute.'}
        </p>
      )}

      {error && (
        <p className="mb-4 flex gap-2 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {step === 'questions' && (
        <form id="ai-build-form" onSubmit={generate} className="space-y-6">
          {saved && <p className="text-sm text-muted">Your answers from last time are filled in — change anything that’s different now.</p>}
          {ctx?.student && (
            <div className="flex gap-2.5 rounded-xl bg-subtle px-3.5 py-3 text-sm">
              <School className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
              <p>
                Already known from your school: {schoolKnown ? 'class timetable' : 'no class timetable yet'}
                {`, ${ctx.deadlines.length} homework deadline${ctx.deadlines.length === 1 ? '' : 's'}`}
                {`, ${ctx.exams.length} exam${ctx.exams.length === 1 ? '' : 's'}`}
                {ctx.holidays.length ? `, ${ctx.holidays.length} holiday${ctx.holidays.length === 1 ? '' : 's'}` : ''}. These are used automatically and never changed.
              </p>
            </div>
          )}

          <fieldset className={sectionCls}>
            <legend className="field-label">What matters most right now?</legend>
            <Chips label="Main goals" options={GOALS} value={answers.goals ?? []} onChange={(v) => set('goals', v)} />
          </fieldset>

          <div className={sectionCls}>
            <label htmlFor="ai-subjects" className="field-label">
              Subjects that need more time
            </label>
            {subjects.length > 0 && (
              <Chips label="Your school subjects" options={subjects} value={subjectsText.split(',').map((s) => s.trim()).filter(Boolean)}
                onChange={(v) => setSubjectsText(v.join(', '))} />
            )}
            <input id="ai-subjects" className="input" placeholder="e.g. Maths, Chemistry" value={subjectsText} maxLength={300} onChange={(e) => setSubjectsText(e.target.value)} />
          </div>

          {!schoolKnown && (
            <fieldset className={sectionCls}>
              <legend className="field-label">School or college hours</legend>
              <DayChips label="School days" weekStart={weekStart} value={answers.school_days ?? []} onChange={(v) => set('school_days', v)} />
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="mb-1 block text-muted">Starts</span>
                  <input type="time" className="input" value={answers.school_start ?? ''} onChange={(e) => set('school_start', e.target.value || undefined)} aria-label="School starts" />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted">Ends</span>
                  <input type="time" className="input" value={answers.school_end ?? ''} onChange={(e) => set('school_end', e.target.value || undefined)} aria-label="School ends" />
                </label>
              </div>
            </fieldset>
          )}

          <fieldset className={sectionCls}>
            <legend className="field-label">Fixed commitments (tuition, sports, chores…)</legend>
            {commitments.map((c, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-line p-3">
                <div className="flex gap-2">
                  <input className="input" aria-label={`Commitment ${i + 1} name`} placeholder="e.g. Maths tuition" value={c.label} maxLength={60} onChange={(e) => setCommitment(i, { label: e.target.value })} />
                  <button type="button" className="icon-btn" aria-label={`Remove commitment ${i + 1}`} onClick={() => set('commitments', commitments.filter((_, n) => n !== i))}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <DayChips label={`Commitment ${i + 1} days`} weekStart={weekStart} value={c.days} onChange={(v) => setCommitment(i, { days: v })} />
                <div className="grid grid-cols-2 gap-3">
                  <input type="time" className="input" aria-label={`Commitment ${i + 1} starts`} value={c.start} onChange={(e) => setCommitment(i, { start: e.target.value })} />
                  <input type="time" className="input" aria-label={`Commitment ${i + 1} ends`} value={c.end} onChange={(e) => setCommitment(i, { end: e.target.value })} />
                </div>
              </div>
            ))}
            {commitments.length < 10 && (
              <button type="button" className="btn-ghost text-brand" onClick={() => set('commitments', [...commitments, { label: '', days: [], start: '17:00', end: '18:00' }])}>
                <Plus className="size-4" aria-hidden="true" />
                Add a commitment
              </button>
            )}
          </fieldset>

          <fieldset className={sectionCls}>
            <legend className="field-label">Sleep</legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-muted">Wake up</span>
                <input type="time" className="input" value={answers.wake ?? ''} onChange={(e) => set('wake', e.target.value || undefined)} aria-label="Wake-up time" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">Go to sleep</span>
                <input type="time" className="input" value={answers.sleep ?? ''} onChange={(e) => set('sleep', e.target.value || undefined)} aria-label="Sleep time" />
              </label>
            </div>
          </fieldset>

          <fieldset className={sectionCls}>
            <legend className="field-label">When do you focus best?</legend>
            <Chips label="Best focus time" options={FOCUS_TIMES} value={answers.best_focus ? [answers.best_focus] : []} onChange={(v) => set('best_focus', v[v.length - 1])} />
          </fieldset>

          <fieldset className={sectionCls}>
            <legend className="field-label">Study time you can manage on a school day</legend>
            <Chips label="Study hours per day" options={STUDY_HOURS} value={answers.study_hours ? [answers.study_hours] : []} onChange={(v) => set('study_hours', v[v.length - 1])} />
          </fieldset>

          <div className={`grid gap-3 sm:grid-cols-2 ${sectionCls}`}>
            <label className="text-sm">
              <span className="field-label">Activities to keep</span>
              <input className="input" placeholder="e.g. evening walk, guitar" value={answers.keep ?? ''} maxLength={200} onChange={(e) => set('keep', e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="field-label">Things to drop or reduce</span>
              <input className="input" placeholder="e.g. late-night study" value={answers.drop ?? ''} maxLength={200} onChange={(e) => set('drop', e.target.value)} />
            </label>
          </div>

          <div className={sectionCls}>
            <label htmlFor="ai-extra" className="field-label">
              Anything else? <span className="font-normal text-muted">(type or speak)</span>
            </label>
            <div className="flex gap-2">
              <textarea id="ai-extra" className="input h-20 py-2.5" maxLength={500} placeholder="e.g. I want Sundays mostly free" value={speech.state === 'listening' && speech.interim ? speech.interim : (answers.extra ?? '')}
                onChange={(e) => set('extra', e.target.value)} />
              {speech.supported && (
                <button type="button" className={`icon-btn ${speech.state === 'listening' ? 'bg-danger-soft text-danger' : ''}`} onClick={speech.state === 'listening' ? speech.stop : speech.start}
                  aria-label={speech.state === 'listening' ? 'Stop listening' : 'Speak your answer'} aria-pressed={speech.state === 'listening'}>
                  <Mic className="size-5" aria-hidden="true" />
                </button>
              )}
            </div>
            {speech.error && <p className="field-error">{speech.error}</p>}
          </div>
          <p className="text-xs text-muted">
            Sent to the AI: these answers and your school’s class times, subjects, deadlines and exam dates. Not your name, email or marks.
          </p>
        </form>
      )}

      {step === 'review' && result && (
        <div className="space-y-5">
          {result.summary && <p className="text-[15px]">{result.summary}</p>}
          {result.choices.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">What I included and why</h3>
              <ul className="space-y-2">
                {result.choices.map((c, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    <span>
                      <span className="font-medium">{c.what}</span> — {c.why}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(result.impossible.length > 0 || result.dropped.length > 0) && (
            <section className="rounded-xl border border-line bg-subtle p-3.5">
              <h3 className="mb-1.5 text-sm font-semibold">What didn’t fit</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {result.impossible.map((x, i) => <li key={`i${i}`}>{x}</li>)}
                {result.dropped.slice(0, 8).map((d, i) => <li key={`d${i}`}>{d.what}: removed — {d.reason}.</li>)}
              </ul>
            </section>
          )}
          {result.proposal.entries.length === 0 ? (
            <p className="text-sm text-muted">The AI couldn’t fit anything into the free time you described. Change your answers and try again.</p>
          ) : (
            <ProposalPreview proposal={result.proposal} busy={result.busy} timeFormat={timeFormat} weekStart={weekStart} />
          )}
          <div>
            <label htmlFor="ai-tt-name" className="field-label">
              Timetable name
            </label>
            <input id="ai-tt-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1.5 text-xs text-muted">It’s saved as a new timetable; your current ones aren’t changed.</p>
          </div>
        </div>
      )}
    </Modal>
  )
}
