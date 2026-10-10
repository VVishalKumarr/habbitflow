import { useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { resetsIn } from '../../lib/aiQuota'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { toast } from '../../store/ui'
import { Spinner } from '../ui/Spinner'
import { ErrorNote, List, Loading, Panel, Row } from './ui'

interface Feature {
  feature: string
  label: string
  period: 'day' | 'week' | 'month'
  platform_enabled: boolean
  platform_max: number | null
  enabled: boolean
  max_requests: number | null
  used_this_period: number
  students_using: number
}
interface Overview {
  features: Feature[]
  pool: { monthly_requests: number | null; used_requests: number; monthly_token_cap: number | null; used_tokens: number; resets_at: string } | null
  students: { name: string; membership_id: string; total: number; by_feature: Record<string, number> }[]
}

const PER = { day: 'day', week: 'week', month: 'month' } as const

/** Principal/director: switch AI features on/off and lower per-student limits (never above the platform's). */
export function AiPanel({ institutionId }: { institutionId: string }) {
  const { data, error, loading, reload } = useLoad(async () => unwrap(await supabase.rpc('institution_ai_overview', { p_inst: institutionId })) as Overview, [institutionId])
  if (loading && !data) return <Loading />
  if (error || !data) return <ErrorNote>{error}</ErrorNote>
  const label = Object.fromEntries(data.features.map((f) => [f.feature, f.label]))

  return (
    <Panel
      title="AI features"
      description="Limits apply to each student separately. You can switch features off or set a lower limit than the platform’s. Students who also have their own Plus or Pro plan get whichever is more. Only counts are stored — never what students asked."
    >
      <div className="space-y-6">
        {data.pool && (
          <div className="rounded-xl bg-subtle px-4 py-3 text-sm">
            <p className="font-medium">Shared school credits this month</p>
            <p className="text-muted">
              {data.pool.used_requests} of {data.pool.monthly_requests ?? 'unlimited'} requests used
              {data.pool.monthly_token_cap != null && ` · ${data.pool.used_tokens.toLocaleString()} of ${data.pool.monthly_token_cap.toLocaleString()} tokens`}
              {' · '}resets {resetsIn(data.pool.resets_at)}. Requests beyond a student’s personal plan use these credits.
            </p>
          </div>
        )}
        <List>
          {data.features.map((f) => (
            <FeatureRow key={f.feature} inst={institutionId} f={f} onSaved={reload} />
          ))}
        </List>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Use by student this month</h3>
          <List empty="No AI requests from students this month.">
            {data.students.map((s) => (
              <Row key={s.membership_id}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name}</p>
                  <p className="text-sm text-muted">
                    {Object.entries(s.by_feature ?? {})
                      .map(([k, n]) => `${label[k] ?? k}: ${n}`)
                      .join(' · ')}
                  </p>
                </div>
                <span className="text-sm font-medium tabular-nums">{s.total}</span>
              </Row>
            ))}
          </List>
        </div>
      </div>
    </Panel>
  )
}

function FeatureRow({ inst, f, onSaved }: { inst: string; f: Feature; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(f.enabled)
  const [max, setMax] = useState(f.max_requests == null ? '' : String(f.max_requests))
  const [busy, setBusy] = useState(false)
  const dirty = enabled !== f.enabled || max !== (f.max_requests == null ? '' : String(f.max_requests))
  const n = max.trim() === '' ? null : Number(max)
  const valid = n === null || (Number.isInteger(n) && n >= 0 && (f.platform_max == null || n <= f.platform_max))

  const save = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('institution_set_ai_quota', { p_inst: inst, p_feature: f.feature, p_enabled: enabled, p_max_requests: n })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${f.label} saved.`)
    onSaved()
  }

  if (!f.platform_enabled) {
    return (
      <Row>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{f.label}</p>
          <p className="text-sm text-muted">Not included in your institution’s plan.</p>
        </div>
      </Row>
    )
  }

  return (
    <Row className="flex-wrap">
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium">{f.label}</p>
        <p className="text-sm text-muted">
          {f.used_this_period} used {f.period === 'day' ? 'today' : `this ${f.period}`} by {f.students_using} student{f.students_using === 1 ? '' : 's'}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label={`${f.label} on`} />
        On
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="whitespace-nowrap">Per student / {PER[f.period]}</span>
        <input
          className="input h-10 w-24"
          inputMode="numeric"
          value={max}
          placeholder={f.platform_max == null ? 'no limit' : String(f.platform_max)}
          aria-label={`${f.label} limit per student`}
          aria-invalid={!valid}
          disabled={!enabled}
          onChange={(e) => setMax(e.target.value)}
        />
      </label>
      <button type="button" className="btn-secondary h-10" disabled={!dirty || !valid || busy} onClick={save}>
        {busy && <Spinner className="size-4" />}
        Save
      </button>
      {!valid && <p className="w-full text-sm text-danger">Choose 0 to {f.platform_max ?? 'any number'}, or leave empty for the platform limit.</p>}
    </Row>
  )
}
