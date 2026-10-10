import { Building2, ChevronLeft, MailPlus, Plus, ShieldCheck, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { FullPageLoader, Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { callFunction } from '../../lib/functions'
import { formatDateTime, ROLE_LABEL, type Invitation } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useInstitutionStore } from '../../store/institution'
import { toast } from '../../store/ui'
import { AiTab } from './AiAdmin'
import { AccountsTab, CodesTab, LicenceHistoryTab, LicencesTab, PlansTab } from './LicensingAdmin'

const TABS = [
  ['institutions', 'Institutions'],
  ['codes', 'Codes'],
  ['licences', 'Licences'],
  ['plans', 'Plans'],
  ['ai', 'AI'],
  ['accounts', 'Accounts'],
  ['history', 'History'],
] as const
type Tab = (typeof TABS)[number][0]

interface PlatformInstitution {
  id: string
  name: string
  short_name: string | null
  kind: string
  status: 'active' | 'suspended' | 'archived'
  timezone: string
  created_at: string
  members: number
  students: number
  staff: number
  heads: number
  pending_invitations: number
  allowlist_entries: number
}

interface AllowEntry {
  id: string
  kind: 'email' | 'domain'
  value: string
  status: 'active' | 'revoked'
  note: string | null
  created_at: string
}

/** Platform owner console: institutions, approved emails and head invitations. No student data. */
export default function PlatformAdminPage() {
  const status = useInstitutionStore((s) => s.status)
  const isAdmin = useInstitutionStore((s) => s.isPlatformAdmin)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState<Tab>('institutions')
  const list = useLoad(async () => (isAdmin ? (unwrap(await supabase.rpc('platform_institutions')) as PlatformInstitution[]) : []), [isAdmin])

  if (status === 'idle' || status === 'loading') return <FullPageLoader />
  if (!isAdmin) return <Navigate to="/dashboard" replace />

  const inst = list.data?.find((i) => i.id === selected)
  if (inst) return <InstitutionAdmin inst={inst} onBack={() => (setSelected(null), list.reload())} />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform administration"
        description="Institutions, licences, gift codes and plans. Academic records stay with each institution."
        actions={
          tab === 'institutions' && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New institution
            </button>
          )
        }
      />
      <div role="tablist" aria-label="Administration sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`h-9 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors ${tab === id ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-subtle hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'codes' && <CodesTab institutions={(list.data ?? []).map((i) => ({ id: i.id, name: i.name }))} />}
      {tab === 'licences' && <LicencesTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'ai' && <AiTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'history' && <LicenceHistoryTab />}
      {tab === 'institutions' && <ErrorNote>{list.error}</ErrorNote>}
      {tab !== 'institutions' ? null : list.loading && !list.data ? (
        <Loading />
      ) : (
        <Panel>
          <List empty="No institutions yet.">
            {(list.data ?? []).map((i) => (
              <Row key={i.id}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(i.id)}>
                  <p className="truncate font-medium text-brand hover:underline">{i.name}</p>
                  <p className="text-sm text-muted">
                    {i.kind} · {i.heads} head{i.heads === 1 ? '' : 's'} · {i.staff} staff · {i.students} students · {i.allowlist_entries} approved entries · {i.pending_invitations} pending invites
                  </p>
                </button>
                <Pill tone={i.status === 'active' ? 'success' : i.status === 'suspended' ? 'warning' : 'muted'}>{i.status}</Pill>
              </Row>
            ))}
          </List>
        </Panel>
      )}
      {creating && <CreateInstitution onClose={() => setCreating(false)} onDone={(id) => (list.reload(), setSelected(id))} />}
    </div>
  )
}

function CreateInstitution({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [kind, setKind] = useState('school')
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { data, error: err } = await supabase.rpc('platform_create_institution', { p_name: name, p_kind: kind, p_timezone: tz, p_short_name: shortName || null })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Institution created.')
    onDone(data as string)
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New institution"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-inst" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Create
          </button>
        </>
      }
    >
      <form id="create-inst" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <Field label="Short name (optional)" value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={30} />
        <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="school">School</option>
          <option value="college">College</option>
          <option value="coaching">Coaching centre</option>
          <option value="other">Other</option>
        </SelectField>
        <Field label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} hint="IANA name, e.g. Asia/Kolkata" />
      </form>
    </Modal>
  )
}

function InstitutionAdmin({ inst, onBack }: { inst: PlatformInstitution; onBack: () => void }) {
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [statusModal, setStatusModal] = useState(false)
  const [inviting, setInviting] = useState(false)
  const allow = useLoad(
    async () => unwrap(await supabase.from('institution_email_allowlist').select('*').eq('institution_id', inst.id).order('created_at', { ascending: false })) as AllowEntry[],
    [inst.id],
  )
  const heads = useLoad(async () => {
    const [m, i] = await Promise.all([
      supabase.from('institution_memberships').select('id, display_name, role, status').eq('institution_id', inst.id),
      supabase.from('institution_invitations').select('id, email, role, display_name, status, expires_at, send_count, created_at').eq('institution_id', inst.id).in('role', ['principal', 'director']).order('created_at', { ascending: false }),
    ])
    return { members: unwrap(m) as { id: string; display_name: string; role: string; status: string }[], invites: unwrap(i) as Invitation[] }
  }, [inst.id])

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim().toLowerCase().replace(/^@/, '')
    const kind = v.includes('@') ? 'email' : 'domain'
    const { error } = await supabase.from('institution_email_allowlist').insert({ institution_id: inst.id, kind, value: v, note: note.trim() || null })
    if (error) return toast.error(error.code === '23505' ? 'Already on the list.' : error.code === '23514' ? 'That isn’t a valid email address or domain.' : friendlyError(error))
    setValue('')
    setNote('')
    allow.reload()
  }
  const setEntry = async (id: string, status: 'active' | 'revoked') => {
    const { error } = await supabase.from('institution_email_allowlist').update({ status }).eq('id', id)
    if (error) toast.error(friendlyError(error))
    allow.reload()
  }

  return (
    <div className="space-y-5">
      <button type="button" className="btn-ghost -ml-2 h-9 px-2" onClick={onBack}>
        <ChevronLeft className="size-4" aria-hidden="true" />
        All institutions
      </button>
      <PageHeader
        title={inst.name}
        description={`${inst.kind} · ${inst.timezone} · created ${formatDateTime(inst.created_at)}`}
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setStatusModal(true)}>
              {inst.status === 'active' ? 'Suspend institution' : 'Reactivate institution'}
            </button>
            <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
              <MailPlus className="size-4" aria-hidden="true" />
              Invite principal / director
            </button>
          </>
        }
      />

      <Panel
        title="Approved email addresses and domains"
        description="Only these can be invited. A domain lets the institution invite any staff or student address on it; principals and directors need their exact address here. Public providers like gmail.com can’t be approved as a domain."
      >
        <form onSubmit={add} className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Email address or domain" value={value} onChange={(e) => setValue(e.target.value)} placeholder="principal@school.edu or school.edu" autoCapitalize="none" spellCheck={false} />
          </div>
          <div className="sm:w-56">
            <Field label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Contract #, contact…" />
          </div>
          <button type="submit" className="btn-primary h-11" disabled={!value.trim()}>
            Approve
          </button>
        </form>
        <ErrorNote>{allow.error}</ErrorNote>
        <List empty="Nothing approved yet.">
          {(allow.data ?? []).map((a) => (
            <Row key={a.id}>
              <div className="min-w-0 flex-1">
                <p className={`truncate font-medium ${a.status === 'revoked' ? 'text-muted line-through' : ''}`}>{a.kind === 'domain' ? `@${a.value}` : a.value}</p>
                <p className="text-sm text-muted">
                  {a.kind === 'domain' ? 'Domain' : 'Exact address'} · added {formatDateTime(a.created_at)}
                  {a.note ? ` · ${a.note}` : ''}
                </p>
              </div>
              <button type="button" className="btn-ghost h-9 px-3" onClick={() => setEntry(a.id, a.status === 'active' ? 'revoked' : 'active')}>
                {a.status === 'active' ? (
                  <>
                    <X className="size-4" aria-hidden="true" /> Revoke
                  </>
                ) : (
                  'Restore'
                )}
              </button>
            </Row>
          ))}
        </List>
      </Panel>

      <Panel title="Principals and directors">
        <List empty="No principal or director yet.">
          {(heads.data?.members ?? []).map((m) => (
            <Row key={m.id}>
              <ShieldCheck className="size-4 text-muted" aria-hidden="true" />
              <span className="flex-1 font-medium">{m.display_name}</span>
              <span className="text-sm text-muted">{ROLE_LABEL[m.role as 'principal']}</span>
              {m.status !== 'active' && <Pill tone="warning">{m.status}</Pill>}
            </Row>
          ))}
          {(heads.data?.invites ?? [])
            .filter((i) => i.status === 'pending')
            .map((i) => (
              <Row key={i.id}>
                <Building2 className="size-4 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {i.display_name} <span className="text-sm text-muted">· {i.email}</span>
                </span>
                <Pill tone={new Date(i.expires_at) < new Date() ? 'danger' : 'brand'}>{new Date(i.expires_at) < new Date() ? 'Invite expired' : 'Invited'}</Pill>
                <ResendButton id={i.id} />
              </Row>
            ))}
        </List>
      </Panel>

      {inviting && <InviteHead institutionId={inst.id} onClose={() => (setInviting(false), heads.reload())} />}
      {statusModal && <StatusModal inst={inst} onClose={() => setStatusModal(false)} onDone={onBack} />}
    </div>
  )
}

function ResendButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const resend = async () => {
    setBusy(true)
    try {
      const r = await callFunction<{ activation_link?: string }>('institution-invite', { action: 'resend', invitation_id: id })
      if (r.activation_link) setLink(r.activation_link)
      else toast.success('Invitation sent again.')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (link) return <CopyLink link={link} />
  return (
    <button type="button" className="btn-ghost h-9 px-3" onClick={resend} disabled={busy}>
      Resend
    </button>
  )
}

function CopyLink({ link }: { link: string }) {
  return (
    <div className="w-full rounded-xl border border-line bg-subtle p-3 text-sm">
      <p className="font-medium">Email isn’t set up — send this one-time link privately to the invited person:</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">{link}</code>
        <button type="button" className="btn-secondary h-9 px-3" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Copied.'))}>
          Copy
        </button>
      </div>
    </div>
  )
}

function InviteHead({ institutionId, onClose }: { institutionId: string; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'principal' | 'director'>('principal')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)

  const send = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction<{ activation_link?: string }>('institution-invite', { action: 'invite', institution_id: institutionId, email: email.trim().toLowerCase(), role, display_name: name.trim() })
      if (r.activation_link) setLink(r.activation_link)
      else {
        toast.success('Invitation sent.')
        onClose()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Invite principal or director"
      subtitle="Their exact email address must be on the approved list first."
      footer={
        link ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" form="invite-head" className="btn-primary" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Invite
            </button>
          </>
        )
      }
    >
      {link ? (
        <CopyLink link={link} />
      ) : (
        <form id="invite-head" onSubmit={send} className="space-y-4">
          <ErrorNote>{error}</ErrorNote>
          <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as 'principal' | 'director')}>
            <option value="principal">Principal</option>
            <option value="director">Director</option>
          </SelectField>
        </form>
      )}
    </Modal>
  )
}

function StatusModal({ inst, onClose, onDone }: { inst: PlatformInstitution; onClose: () => void; onDone: () => void }) {
  const next = inst.status === 'active' ? 'suspended' : 'active'
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const { error: err } = await supabase.rpc('platform_set_institution_status', { p_inst: inst.id, p_status: next, p_reason: reason })
    if (err) return setError(friendlyError(err))
    toast.success(next === 'active' ? 'Institution reactivated.' : 'Institution suspended.')
    onClose()
    onDone()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={next === 'active' ? 'Reactivate institution?' : 'Suspend institution?'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={next === 'active' ? 'btn-primary' : 'btn-danger'} onClick={save}>
            {next === 'active' ? 'Reactivate' : 'Suspend'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {next === 'active' ? 'Members regain access with their existing roles.' : 'Members lose access to institutional data until reactivated. No records are deleted.'}
        </p>
        <ErrorNote>{error}</ErrorNote>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  )
}
