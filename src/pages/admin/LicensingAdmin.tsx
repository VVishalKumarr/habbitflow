import { Copy, Download, KeyRound, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ErrorNote, List, Loading, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { FEATURE_LABELS, type Feature } from '../../config'
import { friendlyError } from '../../lib/errors'
import { formatDateTime } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useSubscriptionStore, type Plan } from '../../store/subscription'
import { toast } from '../../store/ui'

type CodeKind = 'gift' | 'individual' | 'institution'
const KIND_LABEL: Record<CodeKind, string> = { gift: 'Gift code', individual: 'Personal licence', institution: 'Institution licence' }

interface CodeRow {
  id: string
  kind: CodeKind
  code_hint: string
  plan_name: string
  duration_days: number
  max_redemptions: number
  redemption_count: number
  redeem_by: string | null
  institution_name: string | null
  note: string | null
  status: 'active' | 'revoked'
  revoked_reason: string | null
  created_at: string
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function usePlans() {
  return useLoad(async () => (unwrap(await supabase.from('plans').select('id, name, rank, limits, features')) as Plan[]).sort((a, b) => a.rank - b.rank), [])
}

/* ------------------------------------------------------------------ */
/* Codes                                                               */
/* ------------------------------------------------------------------ */

export function CodesTab({ institutions }: { institutions: { id: string; name: string }[] }) {
  const [kind, setKind] = useState<CodeKind | ''>('')
  const [generating, setGenerating] = useState(false)
  const [details, setDetails] = useState<CodeRow | null>(null)
  const list = useLoad(async () => unwrap(await supabase.rpc('platform_codes', { p_kind: kind || null })) as CodeRow[], [kind])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:w-60">
          <SelectField label="Show" value={kind} onChange={(e) => setKind(e.target.value as CodeKind | '')}>
            <option value="">All codes</option>
            {(Object.keys(KIND_LABEL) as CodeKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}s
              </option>
            ))}
          </SelectField>
        </div>
        <button type="button" className="btn-primary" onClick={() => setGenerating(true)}>
          <KeyRound className="size-4" aria-hidden="true" />
          Generate codes
        </button>
      </div>
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <Panel>
          <List empty="No codes yet.">
            {(list.data ?? []).map((c) => (
              <Row key={c.id}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDetails(c)}>
                  <p className="truncate font-medium text-brand hover:underline">
                    …{c.code_hint} · {KIND_LABEL[c.kind]} · {c.plan_name} · {c.duration_days} days
                  </p>
                  <p className="text-sm text-muted">
                    {c.redemption_count}/{c.max_redemptions} used
                    {c.institution_name && ` · ${c.institution_name}`}
                    {c.redeem_by && ` · redeem by ${day(c.redeem_by)}`}
                    {c.note && ` · ${c.note}`} · created {day(c.created_at)}
                  </p>
                </button>
                <Pill tone={c.status === 'revoked' ? 'danger' : c.redemption_count >= c.max_redemptions ? 'muted' : 'success'}>
                  {c.status === 'revoked' ? 'revoked' : c.redemption_count >= c.max_redemptions ? 'used' : 'active'}
                </Pill>
              </Row>
            ))}
          </List>
        </Panel>
      )}
      {generating && <GenerateModal institutions={institutions} onClose={() => (setGenerating(false), list.reload())} />}
      {details && <CodeDetails code={details} onClose={() => (setDetails(null), list.reload())} />}
    </div>
  )
}

function GenerateModal({ institutions, onClose }: { institutions: { id: string; name: string }[]; onClose: () => void }) {
  const plans = usePlans()
  const [kind, setKind] = useState<CodeKind>('gift')
  const [plan, setPlan] = useState('plus')
  const [count, setCount] = useState('1')
  const [days, setDays] = useState('30')
  const [uses, setUses] = useState('1')
  const [redeemBy, setRedeemBy] = useState('')
  const [institution, setInstitution] = useState('')
  const [grace, setGrace] = useState('7')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const inst = kind === 'institution'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('platform_generate_codes', {
      p_kind: kind,
      p_plan: plan,
      p_count: inst ? 1 : Number(count),
      p_duration_days: Number(days),
      p_max_redemptions: inst ? 1 : Number(uses),
      p_redeem_by: redeemBy ? new Date(`${redeemBy}T23:59:59`).toISOString() : null,
      p_institution: inst ? institution || null : null,
      p_note: note || null,
      p_grace_days: Number(grace),
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    setCodes((data as { code: string }[]).map((r) => r.code))
  }

  if (codes) return <ShowCodes codes={codes} label={`${KIND_LABEL[kind]} · ${plan} · ${days} days`} onClose={onClose} />

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate codes"
      subtitle="Codes are random and stored only as hashes. You’ll see them once — copy or download them before closing."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="gen-codes" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Generate
          </button>
        </>
      }
    >
      <form id="gen-codes" onSubmit={submit} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as CodeKind)}>
            {(Object.keys(KIND_LABEL) as CodeKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {(plans.data ?? []).filter((p) => p.id !== 'free').map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        </div>
        {inst && (
          <SelectField label="Institution" value={institution} onChange={(e) => setInstitution(e.target.value)}>
            <option value="">Choose…</option>
            {institutions.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </SelectField>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={inst ? 'Licence length (days)' : 'Access length (days)'} type="number" min={1} max={3660} value={days} onChange={(e) => setDays(e.target.value)} />
          {!inst && <Field label="How many codes" type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />}
          {!inst && <Field label="Uses per code" type="number" min={1} max={100000} value={uses} onChange={(e) => setUses(e.target.value)} />}
          {inst && <Field label="Grace period (days)" type="number" min={0} max={60} value={grace} onChange={(e) => setGrace(e.target.value)} />}
        </div>
        <Field label="Redeem by (optional)" type="date" value={redeemBy} onChange={(e) => setRedeemBy(e.target.value)} hint="After this date the code can’t be redeemed. Access already granted isn’t affected." />
        <TextArea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} hint="For your records, e.g. order number or campaign." />
      </form>
    </Modal>
  )
}

function ShowCodes({ codes, label, onClose }: { codes: string[]; label: string; onClose: () => void }) {
  const text = codes.join('\n')
  const download = () => {
    const blob = new Blob([`code\n${text}\n`], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `habitflow-codes-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${codes.length} code${codes.length === 1 ? '' : 's'} generated`}
      subtitle={`${label}. These can’t be shown again — store them somewhere safe.`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={download}>
            <Download className="size-4" aria-hidden="true" />
            Download CSV
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Copied.'), () => toast.error('Couldn’t copy.'))}
          >
            <Copy className="size-4" aria-hidden="true" />
            Copy all
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <pre aria-label="Generated codes" className="max-h-72 overflow-auto rounded-xl bg-subtle p-3 font-mono text-sm leading-6">
        {text}
      </pre>
    </Modal>
  )
}

function CodeDetails({ code, onClose }: { code: CodeRow; onClose: () => void }) {
  const who = useLoad(
    async () => unwrap(await supabase.rpc('platform_code_redemptions', { p_code: code.id })) as { redeemed_at: string; who: string; institution_name: string | null; expires_at: string | null; active: boolean }[],
    [code.id],
  )
  const [reason, setReason] = useState('')
  const [endAccess, setEndAccess] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const revoke = async () => {
    setBusy(true)
    const { error: err } = await supabase.rpc('platform_revoke_code', { p_code: code.id, p_reason: reason, p_end_access: endAccess })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Code revoked.')
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={`Code …${code.code_hint}`} subtitle={`${KIND_LABEL[code.kind]} · ${code.plan_name} · ${code.duration_days} days`}>
      <div className="space-y-4">
        <ErrorNote>{error ?? who.error}</ErrorNote>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Redemptions ({code.redemption_count}/{code.max_redemptions})</h3>
          {who.loading && !who.data ? (
            <Loading />
          ) : (
            <List empty="Not redeemed yet.">
              {(who.data ?? []).map((r, i) => (
                <Row key={i}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{r.institution_name ?? r.who}</p>
                    <p className="text-sm text-muted">
                      {formatDateTime(r.redeemed_at)}
                      {r.expires_at && ` · until ${day(r.expires_at)}`}
                    </p>
                  </div>
                  <Pill tone={r.active ? 'success' : 'muted'}>{r.active ? 'active' : 'ended'}</Pill>
                </Row>
              ))}
            </List>
          )}
        </div>
        {code.status === 'active' ? (
          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="text-sm font-semibold">Revoke</h3>
            <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={endAccess} onChange={(e) => setEndAccess(e.target.checked)} />
              <span>Also end access already granted by this code (e.g. refunds or abuse). Otherwise only new redemptions stop.</span>
            </label>
            <button type="button" className="btn-danger" disabled={busy || reason.trim().length < 3} onClick={revoke}>
              {busy && <Spinner className="size-4" />}
              Revoke code
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted">Revoked{code.revoked_reason && `: ${code.revoked_reason}`}</p>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Institution licences                                                */
/* ------------------------------------------------------------------ */

interface LicenceRow {
  id: string
  institution_name: string
  plan_name: string
  starts_at: string
  expires_at: string
  grace_days: number
  state: 'scheduled' | 'active' | 'grace' | 'expired' | 'revoked'
  activated_at: string
  revoked_reason: string | null
  code_hint: string | null
}

const LICENCE_TONE = { scheduled: 'brand', active: 'success', grace: 'warning', expired: 'muted', revoked: 'danger' } as const

export function LicencesTab() {
  const list = useLoad(async () => unwrap(await supabase.rpc('platform_licenses')) as LicenceRow[], [])
  const [revoking, setRevoking] = useState<LicenceRow | null>(null)
  return (
    <div className="space-y-4">
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <Panel description="Activated institution licences. Generate a key under Codes (type: Institution licence); the principal or director activates it in School → Settings → Licence.">
          <List empty="No institution has activated a licence yet.">
            {(list.data ?? []).map((l) => (
              <Row key={l.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {l.institution_name} · {l.plan_name}
                  </p>
                  <p className="text-sm text-muted">
                    {day(l.starts_at)} – {day(l.expires_at)} · grace {l.grace_days} days{l.code_hint && ` · key …${l.code_hint}`}
                    {l.revoked_reason && ` · revoked: ${l.revoked_reason}`}
                  </p>
                </div>
                <Pill tone={LICENCE_TONE[l.state]}>{l.state}</Pill>
                {l.state !== 'revoked' && l.state !== 'expired' && (
                  <button type="button" className="btn-ghost text-danger" onClick={() => setRevoking(l)}>
                    Revoke
                  </button>
                )}
              </Row>
            ))}
          </List>
        </Panel>
      )}
      {revoking && <RevokeLicence licence={revoking} onClose={() => (setRevoking(null), list.reload())} />}
    </div>
  )
}

function RevokeLicence({ licence, onClose }: { licence: LicenceRow; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async () => {
    setBusy(true)
    const { error: err } = await supabase.rpc('platform_revoke_license', { p_license: licence.id, p_reason: reason })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Licence revoked.')
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Revoke ${licence.institution_name}’s licence?`}
      subtitle="Members lose licensed features immediately (no grace period). Their data and academic records are kept."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-danger" disabled={busy || reason.trim().length < 3} onClick={revoke}>
            {busy && <Spinner className="size-4" />}
            Revoke
          </button>
        </>
      }
    >
      <ErrorNote>{error}</ErrorNote>
      <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Plans: limits and features                                          */
/* ------------------------------------------------------------------ */

const LIMIT_LABEL: Record<string, string> = { trackers: 'Trackers', friends: 'Friends (incl. sent requests)', history_days: 'History (days)' }

export function PlansTab() {
  const plans = usePlans()
  const [editing, setEditing] = useState<Plan | null>(null)
  return (
    <div className="space-y-4">
      <ErrorNote>{plans.error}</ErrorNote>
      {plans.loading && !plans.data ? (
        <Loading />
      ) : (
        <Panel description="Limits and features are enforced by the database for every account. Prices are set with the payment providers (see MONETIZATION.md). Empty limit = unlimited.">
          <List>
            {(plans.data ?? []).map((p) => (
              <Row key={p.id}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-sm text-muted">
                    {Object.entries(p.limits)
                      .map(([k, v]) => `${LIMIT_LABEL[k] ?? k}: ${v ?? 'unlimited'}`)
                      .join(' · ')}
                  </p>
                  <p className="text-sm text-muted">{p.features.length} features</p>
                </div>
                <button type="button" className="btn-secondary" onClick={() => setEditing(p)}>
                  Edit
                </button>
              </Row>
            ))}
          </List>
        </Panel>
      )}
      {editing && <EditPlan plan={editing} onClose={() => (setEditing(null), plans.reload(), useSubscriptionStore.getState().load())} />}
    </div>
  )
}

function EditPlan({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const keys = Array.from(new Set([...Object.keys(LIMIT_LABEL), ...Object.keys(plan.limits)]))
  const [limits, setLimits] = useState<Record<string, string>>(Object.fromEntries(keys.map((k) => [k, plan.limits[k as keyof Plan['limits']] == null ? '' : String(plan.limits[k as keyof Plan['limits']])])))
  const allFeatures = Array.from(new Set([...(Object.keys(FEATURE_LABELS) as Feature[]), ...plan.features]))
  const [features, setFeatures] = useState<Set<string>>(new Set(plan.features))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const out: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(limits)) {
      if (v.trim() === '') out[k] = null
      else if (!/^\d+$/.test(v.trim())) return setError(`${LIMIT_LABEL[k] ?? k}: enter a whole number or leave empty for unlimited.`)
      else out[k] = Number(v)
    }
    setBusy(true)
    const { error: err } = await supabase.rpc('platform_update_plan', { p_plan: plan.id, p_limits: out, p_features: [...features] })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success(`${plan.name} updated.`)
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${plan.name}`}
      subtitle="Changes apply to everyone on this plan straight away. Lowering a limit never deletes anything — people just can’t add more."
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="edit-plan" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Save
          </button>
        </>
      }
    >
      <form id="edit-plan" onSubmit={save} className="space-y-5">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-3">
          {keys.map((k) => (
            <Field key={k} label={LIMIT_LABEL[k] ?? k} inputMode="numeric" value={limits[k]} placeholder="unlimited" onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
          ))}
        </div>
        <fieldset>
          <legend className="field-label">Features</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {allFeatures.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={features.has(f)}
                  onChange={(e) => {
                    const next = new Set(features)
                    if (e.target.checked) next.add(f)
                    else next.delete(f)
                    setFeatures(next)
                  }}
                />
                {FEATURE_LABELS[f as Feature] ?? f}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Accounts: look up, grant, end                                       */
/* ------------------------------------------------------------------ */

interface UserPlan {
  username: string
  plan: string
  limits: Record<string, number | null>
  subscriptions: { id: string; provider: string; plan: string; status: string; started_at: string | null; expires_at: string | null; current: boolean }[]
}

export function AccountsTab() {
  const plans = usePlans()
  const [q, setQ] = useState('')
  const [user, setUser] = useState<UserPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState('plus')
  const [days, setDays] = useState('30')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    const { data, error: err } = await supabase.rpc('platform_user_plan', { p_username: q })
    if (err) return (setUser(null), setError(friendlyError(err)))
    setUser(data as UserPlan)
  }
  const grant = async () => {
    setBusy(true)
    const { error: err } = await supabase.rpc('platform_grant_plan', { p_username: user!.username, p_plan: plan, p_days: Number(days), p_note: note })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Plan granted.')
    setNote('')
    lookup()
  }
  const end = async (id: string) => {
    const reason = window.prompt('Reason for ending this access?')
    if (!reason) return
    const { error: err } = await supabase.rpc('platform_end_subscription', { p_subscription: id, p_reason: reason })
    if (err) return setError(friendlyError(err))
    toast.success('Access ended.')
    lookup()
  }

  return (
    <div className="space-y-4">
      <Panel description="Look up a personal account by username to see its plan, or grant a plan by hand (support, partners). Payments are managed with the provider.">
        <form onSubmit={lookup} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="Username" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </div>
          <button type="submit" className="btn-secondary h-11" disabled={!q.trim()}>
            <Search className="size-4" aria-hidden="true" />
            Look up
          </button>
        </form>
      </Panel>
      <ErrorNote>{error}</ErrorNote>
      {user && (
        <Panel title={`${user.username} · ${user.plan}`} description={Object.entries(user.limits).map(([k, v]) => `${LIMIT_LABEL[k] ?? k}: ${v ?? 'unlimited'}`).join(' · ')}>
          <div className="space-y-5">
            <List empty="No subscriptions.">
              {user.subscriptions.map((s) => (
                <Row key={s.id}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {s.plan} · {s.provider} · {s.status}
                    </p>
                    <p className="text-sm text-muted">
                      {s.started_at && `from ${day(s.started_at)}`}
                      {s.expires_at && ` until ${day(s.expires_at)}`}
                    </p>
                  </div>
                  <Pill tone={s.current ? 'success' : 'muted'}>{s.current ? 'current' : 'ended'}</Pill>
                  {s.current && ['manual', 'gift'].includes(s.provider) && (
                    <button type="button" className="btn-ghost text-danger" onClick={() => end(s.id)}>
                      End
                    </button>
                  )}
                </Row>
              ))}
            </List>
            <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_8rem]">
              <SelectField label="Grant plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {(plans.data ?? []).filter((p) => p.id !== 'free').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
              <Field label="Days" type="number" min={1} max={3660} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <Field label="Why (kept in the history)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
            <button type="button" className="btn-primary" disabled={busy || note.trim().length < 3} onClick={grant}>
              {busy && <Spinner className="size-4" />}
              Grant
            </button>
          </div>
        </Panel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

const RECORD_LABEL: Record<string, string> = { license_code: 'Code', institution_license: 'Institution licence', plan: 'Plan', subscription: 'Subscription' }

export function LicenceHistoryTab() {
  const list = useLoad(
    async () =>
      unwrap(await supabase.rpc('platform_license_audit')) as { created_at: string; action: string; record_type: string; institution_name: string | null; new_value: Record<string, unknown> | null; reason: string | null; actor: string }[],
    [],
  )
  return (
    <div className="space-y-4">
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <Panel description="Generated, redeemed, activated and revoked codes and licences, plan changes and manual grants. Append-only.">
          <List empty="Nothing yet.">
            {(list.data ?? []).map((a, i) => (
              <Row key={i}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {RECORD_LABEL[a.record_type] ?? a.record_type} · {a.action}
                    {a.institution_name && ` · ${a.institution_name}`}
                  </p>
                  <p className="text-sm break-words text-muted">
                    {formatDateTime(a.created_at)} · {a.actor}
                    {a.new_value && ` · ${Object.entries(a.new_value).filter(([k]) => !k.endsWith('_id')).map(([k, v]) => `${k}: ${typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? day(v) : JSON.stringify(v)}`).join(', ')}`}
                    {a.reason && ` · “${a.reason}”`}
                  </p>
                </div>
              </Row>
            ))}
          </List>
        </Panel>
      )}
    </div>
  )
}
