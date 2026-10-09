import { Copy, MailPlus, Pencil, RotateCw, Search, ShieldOff, UserCheck, UserX, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStructure } from '../../components/school/data'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { callFunction } from '../../lib/functions'
import {
  formatDateTime,
  isHead,
  ROLE_LABEL,
  STAFF_ROLES,
  type InstRole,
  type Invitation,
  type InvitableRole,
  type Membership,
  type MemberStatus,
} from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

type Tab = 'staff' | 'students' | 'invitations'

export default function PeoplePage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) ?? 'staff'
  const [query, setQuery] = useState('')
  const structure = useStructure(inst.institution_id)
  const canStaff = can('manage_staff')
  const canStudents = can('manage_students')
  const invitations = useLoad(async () => {
    if (!canStaff && !canStudents) return [] as Invitation[]
    return unwrap(
      await supabase
        .from('institution_invitations')
        .select('id, institution_id, email, role, display_name, external_id, status, expires_at, send_count, last_sent_at, accepted_at, created_at')
        .eq('institution_id', inst.institution_id)
        .order('created_at', { ascending: false })
        .limit(300),
    ) as Invitation[]
  }, [inst.institution_id, canStaff, canStudents])

  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<Membership | null>(null)
  const [statusChange, setStatusChange] = useState<{ member: Membership; status: MemberStatus } | null>(null)

  const s = structure.data
  const classOf = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!s) return map
    for (const e of s.enrollments) {
      const c = s.classes.find((x) => x.id === e.class_id)
      if (c) map.set(e.student_id, [...(map.get(e.student_id) ?? []), c.name])
    }
    return map
  }, [s])

  if (structure.loading && !s) return <Loading />
  if (structure.error || !s) return <ErrorNote>{structure.error}</ErrorNote>

  const q = query.trim().toLowerCase()
  const matches = (m: Membership) => !q || m.display_name.toLowerCase().includes(q) || (m.external_id ?? '').toLowerCase().includes(q)
  const staff = s.members.filter((m) => STAFF_ROLES.includes(m.role) && matches(m))
  const students = s.members.filter((m) => m.role === 'student' && matches(m))
  const invites = (invitations.data ?? []).filter((i) => !q || i.email.includes(q) || i.display_name.toLowerCase().includes(q))

  const canAdminister = (m: Membership) => (isHead(m.role) ? false : m.role === 'student' ? canStudents : canStaff)
  const setTab = (t: Tab) => setParams(t === 'staff' ? {} : { tab: t }, { replace: true })
  const reload = () => {
    structure.reload()
    invitations.reload()
  }

  const tabs: { id: Tab; label: string; count: number; show: boolean }[] = [
    { id: 'staff', label: 'Staff', count: staff.length, show: true },
    { id: 'students', label: 'Students', count: students.length, show: true },
    { id: 'invitations', label: 'Invitations', count: invites.filter((i) => i.status === 'pending').length, show: canStaff || canStudents },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="People"
        description="Staff and student accounts. Removing someone suspends or revokes access; their academic records are kept."
        actions={
          (canStaff || canStudents) && (
            <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
              <MailPlus className="size-4" aria-hidden="true" />
              Invite
            </button>
          )
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex rounded-xl bg-subtle p-1" role="tablist" aria-label="People">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${tab === t.id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
              >
                {t.label}
                <span className="text-xs text-muted tabular-nums">{t.count}</span>
              </button>
            ))}
        </div>
        <label className="relative sm:ml-auto sm:w-72">
          <span className="sr-only">Search people</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input className="input h-10 pl-9" placeholder="Search by name, ID or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {tab !== 'invitations' && (
        <Panel>
          <List empty={tab === 'staff' ? 'No staff found.' : 'No students you can see yet.'}>
            {(tab === 'staff' ? staff : students).slice(0, 300).map((m) => (
              <Row key={m.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {m.display_name}
                    {m.external_id && <span className="ml-2 text-sm font-normal text-muted">#{m.external_id}</span>}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {ROLE_LABEL[m.role]}
                    {m.role === 'student' && classOf.get(m.id) ? ` · ${classOf.get(m.id)!.join(', ')}` : ''}
                    {m.role === 'coordinator' && scopeText(s.scopes.filter((x) => x.coordinator_id === m.id).map((x) => x.grade))}
                  </p>
                  {m.status !== 'active' && m.status_reason && <p className="mt-0.5 text-xs text-muted">Reason: {m.status_reason}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {m.status !== 'active' && <Pill tone={m.status === 'revoked' ? 'danger' : 'warning'}>{m.status === 'revoked' ? 'Revoked' : 'Suspended'}</Pill>}
                  {canAdminister(m) && m.id !== inst.membership_id && (
                    <>
                      <button type="button" className="btn-ghost h-9 px-2.5" onClick={() => setEditing(m)} aria-label={`Edit ${m.display_name}`}>
                        <Pencil className="size-4" aria-hidden="true" />
                        <span className="sm:sr-only">Edit</span>
                      </button>
                      {m.status === 'active' ? (
                        <button type="button" className="btn-ghost h-9 px-2.5" onClick={() => setStatusChange({ member: m, status: 'suspended' })}>
                          <UserX className="size-4" aria-hidden="true" />
                          Suspend
                        </button>
                      ) : (
                        <button type="button" className="btn-ghost h-9 px-2.5" onClick={() => setStatusChange({ member: m, status: 'active' })}>
                          <UserCheck className="size-4" aria-hidden="true" />
                          Reactivate
                        </button>
                      )}
                      {m.status !== 'revoked' && (
                        <button type="button" className="btn-ghost h-9 px-2.5 text-danger hover:text-danger" onClick={() => setStatusChange({ member: m, status: 'revoked' })}>
                          <ShieldOff className="size-4" aria-hidden="true" />
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </div>
              </Row>
            ))}
          </List>
        </Panel>
      )}

      {tab === 'staff' && canStaff && <CoordinatorScopes inst={inst.institution_id} members={s.members} scopes={s.scopes} grades={[...new Set(s.classes.map((c) => c.grade))]} onChange={structure.reload} />}

      {tab === 'invitations' && (
        <Panel description="Invitation links expire after 7 days and work once. Resending makes the previous link stop working.">
          {invitations.error && <ErrorNote>{invitations.error}</ErrorNote>}
          <List empty="No invitations yet.">
            {invites.map((i) => (
              <InvitationRow key={i.id} invite={i} canManage={i.role === 'student' ? canStudents : canStaff} onChange={invitations.reload} />
            ))}
          </List>
        </Panel>
      )}

      <InviteModal
        open={inviting}
        onClose={() => setInviting(false)}
        institutionId={inst.institution_id}
        roles={[...(canStaff ? (['coordinator', 'class_teacher', 'subject_teacher'] as InvitableRole[]) : []), ...(canStudents ? (['student'] as InvitableRole[]) : [])]}
        onDone={reload}
      />
      {editing && <EditMemberModal member={editing} canChangeRole={canStaff} onClose={() => setEditing(null)} onDone={structure.reload} />}
      {statusChange && <StatusModal {...statusChange} onClose={() => setStatusChange(null)} onDone={structure.reload} />}
    </div>
  )
}

const scopeText = (grades: string[]) => (grades.length ? ` · ${grades.includes('*') ? 'All grades' : `Grades ${grades.join(', ')}`}` : ' · No grades assigned')

function InvitationRow({ invite: i, canManage, onChange }: { invite: Invitation; canManage: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const expired = i.status === 'pending' && new Date(i.expires_at) < new Date()

  const resend = async () => {
    setBusy(true)
    try {
      const r = await callFunction<{ emailed: boolean; activation_link?: string }>('institution-invite', { action: 'resend', invitation_id: i.id })
      if (r.activation_link) setLink(r.activation_link)
      else toast.success(`Invitation sent again to ${i.email}.`)
      onChange()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const revoke = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('revoke_invitation', { p_invitation: i.id })
    setBusy(false)
    if (error) toast.error(friendlyError(error))
    else {
      toast.success('Invitation withdrawn.')
      onChange()
    }
  }

  return (
    <Row>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{i.display_name}</p>
        <p className="truncate text-sm text-muted">
          {i.email} · {ROLE_LABEL[i.role]}
        </p>
        <p className="text-xs text-muted">
          {i.status === 'accepted' && i.accepted_at ? `Activated ${formatDateTime(i.accepted_at)}` : `Sent ${i.send_count}× · expires ${formatDateTime(i.expires_at)}`}
        </p>
        {link && <ManualLink link={link} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={i.status === 'accepted' ? 'success' : i.status === 'revoked' ? 'muted' : expired ? 'danger' : 'brand'}>
          {i.status === 'pending' ? (expired ? 'Expired' : 'Pending') : i.status === 'accepted' ? 'Activated' : 'Withdrawn'}
        </Pill>
        {canManage && i.status === 'pending' && (
          <>
            <button type="button" className="btn-ghost h-9 px-2.5" onClick={resend} disabled={busy}>
              <RotateCw className="size-4" aria-hidden="true" />
              Resend
            </button>
            <button type="button" className="btn-ghost h-9 px-2.5" onClick={revoke} disabled={busy}>
              <X className="size-4" aria-hidden="true" />
              Withdraw
            </button>
          </>
        )}
      </div>
    </Row>
  )
}

/** Shown only when invitation emails aren't configured on the server (setup mode). */
function ManualLink({ link }: { link: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Activation link copied.')
    } catch {
      toast.error('Couldn’t copy. Select the link and copy it manually.')
    }
  }
  return (
    <div className="mt-2 rounded-xl border border-line bg-subtle p-3 text-sm">
      <p className="font-medium">Email isn’t set up yet — deliver this one-time link yourself</p>
      <p className="mt-0.5 text-xs text-muted">Send it only to the invited person, privately. Anyone with the link can activate the account. It expires in 7 days.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">{link}</code>
        <button type="button" className="btn-secondary h-9 shrink-0 px-3" onClick={copy}>
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </button>
      </div>
    </div>
  )
}

function InviteModal({ open, onClose, institutionId, roles, onDone }: { open: boolean; onClose: () => void; institutionId: string; roles: InvitableRole[]; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [externalId, setExternalId] = useState('')
  const [role, setRole] = useState<InvitableRole | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)

  const close = () => {
    setEmail('')
    setName('')
    setExternalId('')
    setRole('')
    setError(null)
    setLink(null)
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const chosen = role || roles[0]
    if (!name.trim()) return setError('Enter the person’s name.')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter a valid email address.')
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction<{ emailed: boolean; activation_link?: string }>('institution-invite', {
        action: 'invite',
        institution_id: institutionId,
        email: email.trim().toLowerCase(),
        role: chosen,
        display_name: name.trim(),
        external_id: externalId.trim() || undefined,
      })
      onDone()
      if (r.activation_link) setLink(r.activation_link)
      else {
        toast.success(`Invitation emailed to ${email.trim()}.`)
        close()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={link ? 'Invitation created' : 'Invite someone'}
      subtitle={link ? undefined : 'They receive a one-time link to confirm their email and choose a password. Only approved addresses can be invited.'}
      footer={
        link ? (
          <button type="button" className="btn-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button type="submit" form="invite-form" className="btn-primary" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Send invitation
            </button>
          </>
        )
      }
    >
      {link ? (
        <ManualLink link={link} />
      ) : (
        <form id="invite-form" onSubmit={submit} className="space-y-4" noValidate>
          <ErrorNote>{error}</ErrorNote>
          <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Field label="Institutional email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} />
          <SelectField label="Role" value={role || roles[0]} onChange={(e) => setRole(e.target.value as InvitableRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectField>
          <Field label="Admission / staff number (optional)" value={externalId} onChange={(e) => setExternalId(e.target.value)} maxLength={40} />
          <p className="text-xs text-muted">Principal and director accounts are set up by the platform owner.</p>
        </form>
      )}
    </Modal>
  )
}

function EditMemberModal({ member, canChangeRole, onClose, onDone }: { member: Membership; canChangeRole: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(member.display_name)
  const [externalId, setExternalId] = useState(member.external_id ?? '')
  const [role, setRole] = useState<InstRole>(member.role)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const staffRoles: InstRole[] = ['coordinator', 'class_teacher', 'subject_teacher']
  const roleEditable = canChangeRole && staffRoles.includes(member.role)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { error: err } = await supabase.rpc('update_member', { p_membership: member.id, p_name: name, p_external_id: externalId, p_role: role })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Saved.')
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${member.display_name}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="edit-member" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Save
          </button>
        </>
      }
    >
      <form id="edit-member" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Field label="Admission / staff number" value={externalId} onChange={(e) => setExternalId(e.target.value)} maxLength={40} />
        {roleEditable && (
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as InstRole)} hint="Changing a coordinator’s role removes their grade scopes.">
            {staffRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectField>
        )}
      </form>
    </Modal>
  )
}

function StatusModal({ member, status, onClose, onDone }: { member: Membership; status: MemberStatus; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const copy = {
    suspended: { title: `Suspend ${member.display_name}?`, body: 'They are signed out everywhere and can’t open institutional data until reactivated. Records are kept.', button: 'Suspend' },
    revoked: { title: `Remove ${member.display_name}?`, body: 'Their access is revoked and they are signed out everywhere. Academic records (marks, attendance, submissions) are kept for the institution. A head can restore access later.', button: 'Remove access' },
    active: { title: `Reactivate ${member.display_name}?`, body: 'They can sign in and use the institution again with their previous role.', button: 'Reactivate' },
  }[status]

  const confirm = async () => {
    if (status !== 'active' && reason.trim().length < 3) return setError('Give a reason (at least 3 characters). It is kept in the audit history.')
    setBusy(true)
    const { error: err } = await supabase.rpc('set_member_status', { p_membership: member.id, p_status: status, p_reason: reason.trim() || null })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Access updated.')
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={status === 'active' ? 'btn-primary' : 'btn-danger'} onClick={confirm} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            {copy.button}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{copy.body}</p>
        <ErrorNote>{error}</ErrorNote>
        <TextArea label={status === 'active' ? 'Note (optional)' : 'Reason'} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  )
}

/** Heads choose which grades each coordinator oversees ("All grades" = every grade). */
function CoordinatorScopes({ inst, members, scopes, grades, onChange }: { inst: string; members: Membership[]; scopes: { id: string; coordinator_id: string; grade: string }[]; grades: string[]; onChange: () => void }) {
  const coordinators = members.filter((m) => m.role === 'coordinator' && m.status === 'active')
  const [pick, setPick] = useState<Record<string, string>>({})
  if (coordinators.length === 0) return null

  const add = async (coordinatorId: string) => {
    const grade = pick[coordinatorId]
    if (!grade) return
    const { error } = await supabase.from('coordinator_scopes').insert({ institution_id: inst, coordinator_id: coordinatorId, grade })
    if (error) toast.error(friendlyError(error))
    else onChange()
  }
  const remove = async (id: string) => {
    const { error } = await supabase.from('coordinator_scopes').delete().eq('id', id)
    if (error) toast.error(friendlyError(error))
    else onChange()
  }

  return (
    <Panel title="Coordinator scopes" description="Coordinators manage only the grades listed here.">
      <List>
        {coordinators.map((c) => {
          const mine = scopes.filter((s) => s.coordinator_id === c.id)
          const options = ['*', ...grades].filter((g) => !mine.some((s) => s.grade === g))
          return (
            <Row key={c.id}>
              <p className="min-w-0 flex-1 truncate font-medium">{c.display_name}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {mine.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand-ink">
                    {s.grade === '*' ? 'All grades' : `Grade ${s.grade}`}
                    <button type="button" className="rounded-full p-0.5 hover:bg-brand/15" onClick={() => remove(s.id)} aria-label={`Remove ${s.grade === '*' ? 'all grades' : `grade ${s.grade}`}`}>
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {options.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <select className="input h-9 w-36 text-sm" value={pick[c.id] ?? ''} onChange={(e) => setPick({ ...pick, [c.id]: e.target.value })} aria-label={`Add grade for ${c.display_name}`}>
                      <option value="">Add grade…</option>
                      {options.map((g) => (
                        <option key={g} value={g}>
                          {g === '*' ? 'All grades' : `Grade ${g}`}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn-secondary h-9 px-3" onClick={() => add(c.id)} disabled={!pick[c.id]}>
                      Add
                    </button>
                  </span>
                )}
              </div>
            </Row>
          )
        })}
      </List>
    </Panel>
  )
}
