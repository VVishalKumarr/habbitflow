import { useEffect, useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { saveRules, type StudyRules } from '../../lib/studyInsights'
import { supabase } from '../../lib/supabase'
import { toast } from '../../store/ui'
import { Field } from '../ui/Field'
import { Spinner } from '../ui/Spinner'
import { Panel } from './ui'

type NumKey = Exclude<keyof StudyRules, 'extra_minutes'>
const FIELDS: { key: NumKey; label: string; hint: string }[] = [
  { key: 'attention_below', label: 'Needs attention below', hint: 'Indicator 0–100 from recent results and homework' },
  { key: 'strong_from', label: 'Strong from', hint: 'Indicator at or above this' },
  { key: 'decline_points', label: 'Decline (points)', hint: 'A drop this large against earlier results is flagged' },
  { key: 'homework_attention_below', label: 'Homework handed in below (%)', hint: 'Flags a subject even if marks are fine' },
  { key: 'min_assessments', label: 'Marks needed', hint: 'Published marks before marks are used' },
  { key: 'min_homework', label: 'Homework needed', hint: 'Pieces due before homework is used' },
  { key: 'marks_weight', label: 'Marks weight (%)', hint: 'The rest comes from homework' },
  { key: 'window_days', label: 'Look back (days)', hint: 'Older results are ignored' },
  { key: 'refresh_days', label: 'Re-analyse at least every (days)', hint: 'New marks and homework re-analyse at once' },
  { key: 'exam_bonus_minutes', label: 'Extra minutes before an exam', hint: 'Per week, when an exam is within 3 weeks' },
  { key: 'max_daily_study_minutes', label: 'Default daily study limit (min)', hint: 'Students can choose their own' },
]
const EXTRA: { key: keyof StudyRules['extra_minutes']; label: string }[] = [
  { key: 'needs_attention', label: 'Needs attention' },
  { key: 'improving', label: 'Improving' },
  { key: 'on_track', label: 'On track' },
  { key: 'strong', label: 'Strong (negative = give time away)' },
]

/** Heads: the transparent rules behind study insights. */
export function StudyRulesPanel({ institutionId }: { institutionId: string }) {
  const [rules, setRules] = useState<StudyRules | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase.rpc('study_rules', { p_inst: institutionId }).then(({ data, error }) => (error ? toast.error(friendlyError(error)) : setRules(data as StudyRules)))
  }, [institutionId])
  if (!rules) return null

  const save = async () => {
    setBusy(true)
    try {
      const { kind_weights: _k, ...rest } = rules as StudyRules & { kind_weights?: unknown }
      setRules(await saveRules(institutionId, rest))
      toast.success('Study insight rules saved.')
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  const num = (v: string) => (v === '' ? 0 : Number(v))

  return (
    <Panel
      title="Study insights"
      description="How subjects are classified (needs attention, improving, on track, strong) and how much extra weekly study is suggested. Missing marks never count as zero; subjects with too little data are labelled “Not enough data”. Changes apply at the next analysis and are recorded in the audit history."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} type="number" inputMode="numeric" value={String(rules[f.key] ?? '')}
            onChange={(e) => setRules({ ...rules, [f.key]: num(e.target.value) })} />
        ))}
      </div>
      <p className="mt-4 mb-2 text-sm font-medium">Suggested extra study per week (minutes)</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EXTRA.map((f) => (
          <Field key={f.key} label={f.label} type="number" value={String(rules.extra_minutes[f.key] ?? 0)}
            onChange={(e) => setRules({ ...rules, extra_minutes: { ...rules.extra_minutes, [f.key]: num(e.target.value) } })} />
        ))}
      </div>
      <button type="button" className="btn-primary mt-4" onClick={save} disabled={busy}>
        {busy && <Spinner className="size-4" />}
        Save rules
      </button>
    </Panel>
  )
}
