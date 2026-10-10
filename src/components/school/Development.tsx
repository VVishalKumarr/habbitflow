import { FileDown, Lightbulb, RefreshCw, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { COMPONENT_LABEL, COMPONENTS, explain, scoreTone, suggestions, type DevelopmentScore } from '../../lib/development'
import { friendlyError } from '../../lib/errors'
import { studentReportPdf } from '../../lib/reportPdf'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useAuth } from '../../store/auth'
import { toast } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Pill } from './ui'

const TONE = { success: 'text-success', brand: 'text-brand', danger: 'text-danger', muted: 'text-muted' } as const

/** Score, components with explanations, and suggestions. */
export function DevelopmentView({ score }: { score: DevelopmentScore }) {
  const tips = suggestions(score)
  return (
    <div className="space-y-5">
      <div className="flex items-end gap-3">
        <p className={`text-5xl font-semibold tabular-nums ${TONE[scoreTone(score.score)]}`}>{score.score === null ? '—' : Number(score.score).toFixed(1)}</p>
        <div className="pb-1.5 text-sm text-muted">
          <p>{score.score === null ? 'Not enough data yet for an overall score' : 'out of 10'}</p>
          <p>
            {new Date(`${score.period_from}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} –{' '}
            {new Date(`${score.period_to}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
          </p>
        </div>
      </div>
      <ul className="space-y-3.5" aria-label="Score components">
        {COMPONENTS.map((k) => {
          const c = score.components[k]
          if (!c) return null
          const value = c.has_data && c.score !== null ? Math.round(Number(c.score) * 100) : null
          return (
            <li key={k}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">
                  {COMPONENT_LABEL[k]} <span className="font-normal text-muted">· weight {c.weight}%</span>
                </span>
                <span className="tabular-nums">{value === null ? <Pill>No data</Pill> : `${value}%`}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                {value !== null && <div className={`h-full rounded-full ${value < 50 ? 'bg-danger' : 'bg-brand'}`} style={{ width: `${value}%` }} />}
              </div>
              <p className="mt-1 text-xs text-muted">{explain(k, c)}</p>
            </li>
          )
        })}
      </ul>
      {tips.length > 0 && (
        <section className="rounded-xl bg-subtle p-3.5">
          <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <Lightbulb className="size-4 text-brand" aria-hidden="true" /> How to improve
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {tips.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted">
        Parts without enough data are left out instead of counting as zero. Very long or late-night personal schedules aren’t rewarded.
      </p>
    </div>
  )
}

/** A student's report: latest score, recalculate, history, PDF. Staff and the student themselves. */
export function StudentReportModal({ studentId, student, className, institution, onClose }: {
  studentId: string
  student: string
  className?: string | null
  institution: string
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const { data, error, loading, reload } = useLoad(
    async () =>
      unwrap(await supabase.from('development_scores').select('*').eq('student_id', studentId).order('created_at', { ascending: false }).limit(12)) as DevelopmentScore[],
    [studentId],
  )
  const latest = data?.[0]

  const recalc = async () => {
    setBusy(true)
    try {
      unwrap(await supabase.rpc('calculate_development_score', { p_student: studentId }))
      reload()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={`Development: ${student}`} subtitle={[className, 'last 90 days'].filter(Boolean).join(' · ')}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={recalc} disabled={busy}>
            {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" aria-hidden="true" />}
            {latest ? 'Recalculate' : 'Calculate'}
          </button>
          <button type="button" className="btn-primary" disabled={!latest} onClick={() => latest && studentReportPdf(latest, { institution, student, className }).catch((e) => toast.error(friendlyError(e)))}>
            <FileDown className="size-4" aria-hidden="true" />
            Download PDF
          </button>
        </>
      }>
      {loading && !data && <p className="flex justify-center py-10"><Spinner /></p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {data && !latest && <p className="py-6 text-center text-sm text-muted">No score calculated yet. Choose Calculate.</p>}
      {latest && (
        <div className="space-y-6">
          <DevelopmentView score={latest} />
          {data!.length > 1 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <TrendingUp className="size-4 text-muted" aria-hidden="true" /> History
              </h3>
              <ul className="divide-y divide-line text-sm">
                {data!.map((h) => (
                  <li key={h.id} className="flex justify-between py-1.5">
                    <span className="text-muted">{new Date(h.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}{h.calculated_by ? '' : ' · weekly'}</span>
                    <span className="tabular-nums">{h.score === null ? 'insufficient data' : Number(h.score).toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Student overview card: latest score, the report, and the choice to share habits. */
export function MyDevelopmentCard({ studentId, student, institution }: { studentId: string; student: string; institution: string }) {
  const [open, setOpen] = useState(false)
  const userId = useAuth((s) => s.profile?.id ?? '')
  const [shared, setShared] = useState<boolean | null>(null)
  const { data } = useLoad(async () => {
    const [scores, prof] = await Promise.all([
      supabase.from('development_scores').select('score, insufficient, created_at').eq('student_id', studentId).order('created_at', { ascending: false }).limit(1),
      supabase.from('profiles').select('share_habits_with_school').eq('id', userId).maybeSingle(),
    ])
    setShared(!!prof.data?.share_habits_with_school)
    return (unwrap(scores) as { score: number | null; insufficient: boolean; created_at: string }[])[0] ?? null
  }, [studentId, open])

  const toggle = async (v: boolean) => {
    setShared(v)
    const { error } = await supabase.from('profiles').update({ share_habits_with_school: v }).eq('id', userId)
    if (error) {
      setShared(!v)
      toast.error(friendlyError(error))
    } else toast.success(v ? 'Your habit consistency now counts in your development report.' : 'Your habits are no longer used in development reports.')
  }

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="dev-title">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="dev-title" className="font-semibold">Your development</h2>
          <p className="text-sm text-muted">
            {data === undefined ? 'Loading…' : data === null ? 'No score yet — open your report to calculate it.' : data.score === null ? 'Not enough data yet for an overall score.' : `Latest score ${Number(data.score).toFixed(1)} out of 10.`}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>Open my report</button>
      </div>
      <label className="mt-4 flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-5 accent-brand" checked={!!shared} disabled={shared === null} onChange={(e) => toggle(e.target.checked)} />
        <span>
          Share my habit consistency with my school
          <span className="block text-xs text-muted">Lets “Planning & habits” count: how many planned activities you tick, and completed skill goals. Your teachers still don’t see your tasks or ticks.</span>
        </span>
      </label>
      {open && <StudentReportModal studentId={studentId} student={student} institution={institution} onClose={() => setOpen(false)} />}
    </section>
  )
}
