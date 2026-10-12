import { useState, type FormEvent } from 'react'
import { ErrorNote, List, Loading, Panel, Row, SelectField } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { toast } from '../../store/ui'

interface Settings {
  quota_timezone: string
  max_input_chars: number
  max_output_tokens: number
  hourly_burst: number
  monthly_token_cap: number | null
  usd_per_mtok_input: number
  usd_per_mtok_output: number
}
interface FeatureRow {
  feature: string
  label: string
  period: 'day' | 'week' | 'month'
  enabled: boolean
}
interface Quota {
  plan_key: string
  feature: string
  enabled: boolean
  max_requests: number | null
}
interface Pool {
  enabled: boolean
  monthly_requests: number | null
  monthly_token_cap: number | null
}
interface Overview {
  settings: Settings
  features: FeatureRow[]
  quotas: Quota[]
  plans: { key: string; name: string }[]
  month: {
    requests: number
    refused: number
    refunded: number
    tokens_in: number
    tokens_out: number
    by_feature: Record<string, number>
    by_plan: Record<string, number>
    by_refusal: Record<string, number>
  }
  institutions: { id: string; name: string; requests: number; tokens: number; pool: Pool | null }[]
  top_users: { username: string; requests: number }[]
}

const REFUSAL: Record<string, string> = {
  quota_exceeded: 'limit reached',
  feature_disabled: 'not on plan',
  rate_limited: 'hourly burst',
  pool_exhausted: 'school pool used up',
  spend_cap: 'monthly token cap',
  too_large: 'too long',
}

/** Platform owner: AI features, per-plan quotas, cost controls, institution pools, usage. */
export function AiTab() {
  const ov = useLoad(async () => unwrap(await supabase.rpc('platform_ai_overview')) as Overview, [])
  const [pool, setPool] = useState<Overview['institutions'][number] | null>(null)
  if (ov.loading && !ov.data) return <Loading />
  if (ov.error || !ov.data) return <ErrorNote>{ov.error}</ErrorNote>
  const d = ov.data
  const label = Object.fromEntries(d.features.map((f) => [f.feature, f.label]))
  const est = (d.month.tokens_in / 1e6) * d.settings.usd_per_mtok_input + (d.month.tokens_out / 1e6) * d.settings.usd_per_mtok_output

  return (
    <div className="space-y-5">
      <Panel title="This month">
        <div className="grid gap-4 sm:grid-cols-4">
          <Figure label="Requests" value={d.month.requests.toLocaleString()} />
          <Figure label="Refused / refunded" value={`${d.month.refused} / ${d.month.refunded}`} />
          <Figure label="Tokens in / out (measured)" value={`${d.month.tokens_in.toLocaleString()} / ${d.month.tokens_out.toLocaleString()}`} />
          <Figure label="Cost (estimate)" value={`≈ $${est.toFixed(2)}`} hint="At the paid model’s token prices below — an upper bound, since Free requests run on the much cheaper fast model. Not a bill." />
        </div>
        <p className="mt-4 text-sm text-muted">
          By feature: {Object.entries(d.month.by_feature).map(([k, n]) => `${label[k] ?? k} ${n}`).join(' · ') || '—'}
          <br />
          By plan: {Object.entries(d.month.by_plan).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}
          <br />
          Refusals: {Object.entries(d.month.by_refusal).map(([k, n]) => `${REFUSAL[k] ?? k} ${n}`).join(' · ') || '—'}
        </p>
      </Panel>

      <QuotaMatrix d={d} onSaved={ov.reload} />
      <SettingsForm s={d.settings} onSaved={ov.reload} />

      <Panel title="Institutions" description="Requests this month by members, tokens charged to each institution, and optional shared credit pools.">
        <List empty="No institutions yet.">
          {d.institutions.map((i) => (
            <Row key={i.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{i.name}</p>
                <p className="text-sm text-muted">
                  {i.requests} requests · {i.tokens.toLocaleString()} tokens
                  {i.pool?.enabled ? ` · pool ${i.pool.monthly_requests ?? 'unlimited'} requests/month` : ' · no pool'}
                </p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setPool(i)}>
                Credit pool
              </button>
            </Row>
          ))}
        </List>
      </Panel>

      <Panel title="Most active personal accounts this month" description="Institution members aren’t listed individually here; their school sees its own students.">
        <List empty="No requests yet.">
          {d.top_users.map((u) => (
            <Row key={u.username}>
              <p className="min-w-0 flex-1 truncate">{u.username}</p>
              <span className="text-sm tabular-nums">{u.requests}</span>
            </Row>
          ))}
        </List>
      </Panel>
      {pool && <PoolModal inst={pool} onClose={() => (setPool(null), ov.reload())} />}
    </div>
  )
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-sm text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  )
}

function QuotaMatrix({ d, onSaved }: { d: Overview; onSaved: () => void }) {
  return (
    <Panel
      title="Features and limits per plan"
      description="Requests per student per period. Empty = unlimited; untick to switch a feature off for that plan. “Institution” is the most a licensed school can give its students (schools can lower it). Changes apply at once."
    >
      <List>
        {d.features.map((f) => (
          <FeatureEditor key={f.feature} f={f} plans={d.plans} quotas={d.quotas.filter((q) => q.feature === f.feature)} onSaved={onSaved} />
        ))}
      </List>
    </Panel>
  )
}

function FeatureEditor({ f, plans, quotas, onSaved }: { f: FeatureRow; plans: Overview['plans']; quotas: Quota[]; onSaved: () => void }) {
  const init = () => Object.fromEntries(plans.map((p) => {
    const q = quotas.find((x) => x.plan_key === p.key)
    return [p.key, { enabled: q?.enabled ?? false, max: q?.max_requests == null ? '' : String(q.max_requests) }]
  }))
  const [cells, setCells] = useState(init)
  const [period, setPeriod] = useState(f.period)
  const [on, setOn] = useState(f.enabled)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    for (const [k, c] of Object.entries(cells)) {
      if (c.max.trim() !== '' && !/^\d+$/.test(c.max.trim())) return toast.error(`${k}: enter a whole number or leave empty.`)
    }
    setBusy(true)
    const results = await Promise.all([
      supabase.rpc('platform_set_ai_feature', { p_feature: f.feature, p_enabled: on, p_period: period }),
      ...Object.entries(cells).map(([k, c]) =>
        supabase.rpc('platform_set_ai_quota', { p_plan_key: k, p_feature: f.feature, p_enabled: c.enabled, p_max_requests: c.max.trim() === '' ? null : Number(c.max) }),
      ),
    ])
    setBusy(false)
    const err = results.find((r) => r.error)?.error
    if (err) return toast.error(friendlyError(err))
    toast.success(`${f.label} saved.`)
    onSaved()
  }

  return (
    <Row className="flex-col items-stretch gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 font-medium">{f.label}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          Available
        </label>
        <select className="input h-9 w-28" value={period} aria-label={`${f.label} period`} onChange={(e) => setPeriod(e.target.value as FeatureRow['period'])}>
          <option value="day">per day</option>
          <option value="week">per week</option>
          <option value="month">per month</option>
        </select>
        <button type="button" className="btn-secondary h-9" disabled={busy} onClick={save}>
          {busy && <Spinner className="size-4" />}
          Save
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {plans.map((p) => (
          <div key={p.key} className="flex items-center gap-2 rounded-lg bg-subtle px-2 py-1.5">
            <input
              type="checkbox"
              checked={cells[p.key].enabled}
              aria-label={`${f.label} on ${p.name}`}
              onChange={(e) => setCells({ ...cells, [p.key]: { ...cells[p.key], enabled: e.target.checked } })}
            />
            <span className="w-20 shrink-0 truncate text-sm">{p.name}</span>
            <input
              className="input h-8 min-w-0 flex-1 px-2"
              inputMode="numeric"
              placeholder="∞"
              aria-label={`${f.label} limit on ${p.name}`}
              disabled={!cells[p.key].enabled}
              value={cells[p.key].max}
              onChange={(e) => setCells({ ...cells, [p.key]: { ...cells[p.key], max: e.target.value } })}
            />
          </div>
        ))}
      </div>
    </Row>
  )
}

function SettingsForm({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const [v, setV] = useState({
    quota_timezone: s.quota_timezone,
    max_input_chars: String(s.max_input_chars),
    max_output_tokens: String(s.max_output_tokens),
    hourly_burst: String(s.hourly_burst),
    monthly_token_cap: s.monthly_token_cap == null ? '' : String(s.monthly_token_cap),
    usd_per_mtok_input: String(s.usd_per_mtok_input),
    usd_per_mtok_output: String(s.usd_per_mtok_output),
  })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase.rpc('platform_update_ai_settings', {
      p: {
        quota_timezone: v.quota_timezone,
        max_input_chars: Number(v.max_input_chars),
        max_output_tokens: Number(v.max_output_tokens),
        hourly_burst: Number(v.hourly_burst),
        monthly_token_cap: v.monthly_token_cap.trim() === '' ? null : Number(v.monthly_token_cap),
        usd_per_mtok_input: Number(v.usd_per_mtok_input),
        usd_per_mtok_output: Number(v.usd_per_mtok_output),
      },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('AI settings saved.')
    onSaved()
  }

  return (
    <Panel title="Cost controls" description="Apply to every AI request on the platform. Token prices are only used for the cost estimate above.">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Max request length (characters)" inputMode="numeric" value={v.max_input_chars} onChange={set('max_input_chars')} />
          <Field label="Max answer length (tokens)" inputMode="numeric" value={v.max_output_tokens} onChange={set('max_output_tokens')} />
          <Field label="Requests per student per hour" inputMode="numeric" value={v.hourly_burst} onChange={set('hourly_burst')} />
          <Field label="Platform token cap per month" inputMode="numeric" placeholder="no cap" value={v.monthly_token_cap} onChange={set('monthly_token_cap')} hint="AI pauses for everyone when reached." />
          <Field label="$ per million input tokens" inputMode="decimal" value={v.usd_per_mtok_input} onChange={set('usd_per_mtok_input')} />
          <Field label="$ per million output tokens" inputMode="decimal" value={v.usd_per_mtok_output} onChange={set('usd_per_mtok_output')} />
        </div>
        <div className="sm:w-72">
          <Field label="Time zone for daily/weekly/monthly resets" value={v.quota_timezone} onChange={set('quota_timezone')} hint="e.g. Asia/Kolkata" />
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          Save
        </button>
      </form>
    </Panel>
  )
}

function PoolModal({ inst, onClose }: { inst: Overview['institutions'][number]; onClose: () => void }) {
  const [enabled, setEnabled] = useState(inst.pool?.enabled ?? false)
  const [requests, setRequests] = useState(inst.pool?.monthly_requests == null ? '' : String(inst.pool.monthly_requests))
  const [tokens, setTokens] = useState(inst.pool?.monthly_token_cap == null ? '' : String(inst.pool.monthly_token_cap))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    const { error: err } = await supabase.rpc('platform_set_ai_pool', {
      p_inst: inst.id,
      p_enabled: enabled,
      p_monthly_requests: requests.trim() === '' ? null : Number(requests),
      p_monthly_token_cap: tokens.trim() === '' ? null : Number(tokens),
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Credit pool saved.')
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${inst.name}: shared AI credits`}
      subtitle="When on, requests a student makes beyond their personal plan draw from this monthly pool, on top of each student’s own limit."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>
            {busy && <Spinner className="size-4" />}
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <SelectField label="Pool" value={enabled ? 'on' : 'off'} onChange={(e) => setEnabled(e.target.value === 'on')}>
          <option value="off">Off — only per-student limits</option>
          <option value="on">On — shared monthly credits</option>
        </SelectField>
        <Field label="Requests per month" inputMode="numeric" placeholder="unlimited" value={requests} onChange={(e) => setRequests(e.target.value)} disabled={!enabled} />
        <Field label="Token cap per month" inputMode="numeric" placeholder="no cap" value={tokens} onChange={(e) => setTokens(e.target.value)} disabled={!enabled} />
      </div>
    </Modal>
  )
}
