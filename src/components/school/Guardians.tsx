import { Check, Copy, UserPlus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { friendlyError } from '../../lib/errors'
import { callFunction } from '../../lib/functions'
import { formatDateTime } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { toast } from '../../store/ui'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { ErrorNote, List, Loading, Panel, Pill, Row, SelectField, TextArea } from './ui'

export interface GuardianLink {
  id: string
  institution_id: string
  student_id: string
  guardian_email: string
  guardian_name: string
  relationship: 'mother' | 'father' | 'guardian' | 'grandparent' | 'other'
  guardian_user_id: string | null
  status: 'requested' | 'approved' | 'active' | 'declined' | 'revoked'
  approved_at: string | null
  activated_at: string | null
  close_reason: string | null
  created_at: string
}

export const RELATIONSHIP_LABEL: Record<GuardianLink['relationship'], string> = {
  mother: 'Mother',
  father: 'Father',
  guardian: 'Guardian',
  grandparent: 'Grandparent',
  other: 'Other',
}

const STATUS: Record<GuardianLink['status'], { label: string; tone: 'muted' | 'brand' | 'success' | 'danger' | 'warning' }> = {
  requested: { label: 'Waiting for school approval', tone: 'warning' },
  approved: { label: 'Invitation sent', tone: 'brand' },
  active: { label: 'Linked', tone: 'success' },
  declined: { label: 'Declined', tone: 'muted' },
  revoked: { label: 'Removed', tone: 'muted' },
}

function CloseModal({ link, onClose }: { link: GuardianLink; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const { error: err } = await supabase.rpc('close_guardian_link', { p_link: link.id, p_reason: reason })
    if (err) return setError(friendlyError(err))
    toast.success('Done.')
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={link.status === 'requested' ? 'Decline request' : `Remove ${link.guardian_name}?`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={save}>
            {link.status === 'requested' ? 'Decline' : 'Remove'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">They lose access to the student’s information at once. The reason is kept in the audit history.</p>
        <ErrorNote>{error}</ErrorNote>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  )
}

/** Student overview panel: link parents/guardians and see their status. */
export function StudentGuardians({ institutionId, studentId }: { institutionId: string; studentId: string }) {
  const { data, reload } = useLoad(
    async () => unwrap(await supabase.from('guardian_links').select('*').eq('student_id', studentId).order('created_at', { ascending: false })) as GuardianLink[],
    [studentId],
  )
  const [adding, setAdding] = useState(false)
  const [closing, setClosing] = useState<GuardianLink | null>(null)
  const open = (data ?? []).filter((l) => ['requested', 'approved', 'active'].includes(l.status))

  return (
    <Panel
      title="Parents & guardians"
      description="Linked parents can see your timetable, homework, attendance and published marks, and message your teachers. Your school approves each link."
      actions={
        open.length < 4 && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            <UserPlus className="size-4" aria-hidden="true" />
            Add parent/guardian
          </button>
        )
      }
    >
      <List empty="No parent or guardian linked yet.">
        {open.map((l) => (
          <Row key={l.id}>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {l.guardian_name} <span className="text-sm font-normal text-muted">· {RELATIONSHIP_LABEL[l.relationship]}</span>
              </p>
              <p className="truncate text-sm text-muted">{l.guardian_email}</p>
            </div>
            <Pill tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Pill>
            <button type="button" className="btn-ghost h-9 px-3" onClick={() => setClosing(l)}>
              Remove
            </button>
          </Row>
        ))}
      </List>
      {adding && <AddGuardian institutionId={institutionId} onClose={() => (setAdding(false), reload())} />}
      {closing && <CloseModal link={closing} onClose={() => (setClosing(null), reload())} />}
    </Panel>
  )
}

function AddGuardian({ institutionId, onClose }: { institutionId: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [relationship, setRelationship] = useState<GuardianLink['relationship']>('mother')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Enter their name.')
    setBusy(true)
    const { error: err } = await supabase.rpc('request_guardian_link', { p_inst: institutionId, p_email: email.trim(), p_name: name.trim(), p_relationship: relationship })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Request sent to your school for approval.')
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a parent or guardian"
      subtitle="Your class teacher checks the request. Then your parent gets an email to set up their account."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-guardian" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Send request
          </button>
        </>
      }
    >
      <form id="add-guardian" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Their name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Field label="Their email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} />
        <SelectField label="Relationship" value={relationship} onChange={(e) => setRelationship(e.target.value as GuardianLink['relationship'])}>
          {Object.entries(RELATIONSHIP_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
      </form>
    </Modal>
  )
}

/** Staff: approve or decline requests, see and remove active links. */
export function GuardianRequests({ institutionId, studentName }: { institutionId: string; studentName: (id: string) => string }) {
  const { data, loading, error, reload } = useLoad(
    async () =>
      unwrap(
        await supabase.from('guardian_links').select('*').eq('institution_id', institutionId).in('status', ['requested', 'approved', 'active']).order('created_at', { ascending: false }).limit(500),
      ) as GuardianLink[],
    [institutionId],
  )
  const [closing, setClosing] = useState<GuardianLink | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})

  const approve = async (l: GuardianLink) => {
    setBusy(l.id)
    try {
      const r = await callFunction<{ emailed: boolean; activation_link?: string }>('institution-invite', { action: 'approve_guardian', link_id: l.id })
      if (r.activation_link) setLinks({ ...links, [l.id]: r.activation_link })
      else toast.success(`Approved. ${l.guardian_name} has been emailed.`)
      reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (loading && !data) return <Loading />
  const pending = (data ?? []).filter((l) => l.status !== 'active')
  const active = (data ?? []).filter((l) => l.status === 'active')
  return (
    <div className="space-y-5">
      <ErrorNote>{error}</ErrorNote>
      <Panel title="Requests" description="Check that the person is really the student’s parent or guardian before approving. Approving emails them a one-time link (7 days).">
        <List empty="No pending requests.">
          {pending.map((l) => (
            <Row key={l.id} className="items-start sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {l.guardian_name} <span className="text-sm font-normal text-muted">· {RELATIONSHIP_LABEL[l.relationship]} of {studentName(l.student_id)}</span>
                </p>
                <p className="truncate text-sm text-muted">
                  {l.guardian_email} · requested {formatDateTime(l.created_at)}
                </p>
                {links[l.id] && <SetupLink link={links[l.id]} />}
              </div>
              <Pill tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Pill>
              <button type="button" className="btn-primary h-9 px-3" onClick={() => approve(l)} disabled={busy === l.id}>
                {busy === l.id ? <Spinner className="size-4" /> : <Check className="size-4" aria-hidden="true" />}
                {l.status === 'approved' ? 'Send again' : 'Approve'}
              </button>
              <button type="button" className="btn-ghost h-9 px-3" onClick={() => setClosing(l)}>
                <X className="size-4" aria-hidden="true" />
                Decline
              </button>
            </Row>
          ))}
        </List>
      </Panel>
      <Panel title="Linked parents & guardians">
        <List empty="No active links you can see.">
          {active.map((l) => (
            <Row key={l.id}>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{l.guardian_name}</span>{' '}
                <span className="text-sm text-muted">
                  · {RELATIONSHIP_LABEL[l.relationship]} of {studentName(l.student_id)}
                </span>
              </span>
              <button type="button" className="btn-ghost h-9 px-3" onClick={() => setClosing(l)}>
                Remove link
              </button>
            </Row>
          ))}
        </List>
      </Panel>
      {closing && <CloseModal link={closing} onClose={() => (setClosing(null), reload())} />}
    </div>
  )
}

function SetupLink({ link }: { link: string }) {
  return (
    <div className="mt-2 rounded-xl border border-line bg-subtle p-3 text-sm">
      <p className="font-medium">Email isn’t set up yet — give this one-time link to the parent privately:</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">{link}</code>
        <button type="button" className="btn-secondary h-9 px-3" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Copied.'))}>
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </button>
      </div>
    </div>
  )
}
