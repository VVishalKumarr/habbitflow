import { KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { friendlyError } from '../../lib/errors'
import { formatDateTime } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useSubscriptionStore } from '../../store/subscription'
import { toast } from '../../store/ui'
import { Field } from '../ui/Field'
import { Spinner } from '../ui/Spinner'
import { ErrorNote, List, Loading, Panel, Pill, Row } from './ui'

interface LicenceStatus {
  state: 'active' | 'grace' | 'expired' | 'none'
  plan_name: string | null
  expires_at: string | null
  grace_ends_at: string | null
  members_covered: number
  history: {
    id: string
    plan_name: string
    starts_at: string
    expires_at: string
    status: 'active' | 'revoked'
    activated_at: string
    activated_by: string | null
    revoked_reason: string | null
  }[]
}

const STATE: Record<LicenceStatus['state'], { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
  active: { label: 'Active', tone: 'success' },
  grace: { label: 'Expired — grace period', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
  none: { label: 'No licence', tone: 'muted' },
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Principal/director: current licence, activation of a new key (renewals start when the current one ends), history. */
export function LicencePanel({ institutionId }: { institutionId: string }) {
  const { data, error, loading, reload } = useLoad(
    async () => unwrap(await supabase.rpc('institution_license_status', { p_inst: institutionId })) as LicenceStatus,
    [institutionId],
  )
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activate = async (e: FormEvent) => {
    e.preventDefault()
    if (key.replace(/[^a-z0-9]/gi, '').length < 10) return setKeyError('Enter the whole licence key.')
    setBusy(true)
    setKeyError(null)
    const { error: err } = await supabase.rpc('activate_institution_license', { p_inst: institutionId, p_code: key })
    setBusy(false)
    if (err) return setKeyError(friendlyError(err))
    setKey('')
    toast.success('Licence activated.')
    reload()
    useSubscriptionStore.getState().load()
  }

  if (loading && !data) return <Loading />
  if (error || !data) return <ErrorNote>{error}</ErrorNote>
  const st = STATE[data.state]

  return (
    <Panel
      title="Licence"
      description="Your institution’s licence unlocks paid features for every active staff member and student — no personal payments needed. It never changes anyone’s permissions. If it lapses, access continues for a short grace period and no records are ever deleted."
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={st.tone}>{st.label}</Pill>
          {data.state !== 'none' && (
            <p className="text-sm">
              <span className="font-medium">{data.plan_name}</span>
              {data.expires_at && (data.state === 'active' ? ` · valid until ${day(data.expires_at)}` : ` · ended ${day(data.expires_at)}`)}
              {data.state === 'grace' && data.grace_ends_at && ` · features stop ${day(data.grace_ends_at)}`}
              {` · covers ${data.members_covered} member${data.members_covered === 1 ? '' : 's'}`}
            </p>
          )}
        </div>
        {data.state === 'none' && <p className="text-sm text-muted">No licence yet. Enter the key you received from us to activate it.</p>}

        <form onSubmit={activate} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Field
              label={data.state === 'none' ? 'Licence key' : 'New or renewal key'}
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              error={keyError}
              hint="Looks like HFI-XXXX-XXXX-XXXX-XXXX. A renewal starts when the current licence ends."
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
            />
          </div>
          <button type="submit" className="btn-primary h-11 sm:mt-7" disabled={busy}>
            {busy ? <Spinner className="size-4" /> : <KeyRound className="size-4" aria-hidden="true" />}
            Activate
          </button>
        </form>

        {data.history.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">History</h3>
            <List>
              {data.history.map((h) => (
                <Row key={h.id}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {h.plan_name} · {day(h.starts_at)} – {day(h.expires_at)}
                    </p>
                    <p className="text-sm text-muted">
                      Activated {formatDateTime(h.activated_at)}
                      {h.activated_by && ` by ${h.activated_by}`}
                      {h.revoked_reason && ` · revoked: ${h.revoked_reason}`}
                    </p>
                  </div>
                  <Pill tone={h.status === 'revoked' ? 'danger' : 'muted'}>{h.status}</Pill>
                </Row>
              ))}
            </List>
          </div>
        )}
      </div>
    </Panel>
  )
}
