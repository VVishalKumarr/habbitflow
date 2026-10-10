import { Archive, CheckCircle2, Plus, Sprout, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { gradeSort, uniqueGrades, useStructure } from '../../components/school/data'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { isStaff } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

interface Programme {
  id: string
  title: string
  description: string | null
  category: string
  grade: string | null
  class_id: string | null
  class_name: string | null
  starts_on: string
  ends_on: string | null
  weekly_target: number
  status: 'active' | 'archived'
  can_manage: boolean
  joined: boolean
  my_checkins_this_week: number
  my_checked_in_today: boolean
  members: number | null
  checkin_rate_4w: number | null
}

const CATEGORIES = ['habit', 'skill', 'sport', 'arts', 'service', 'academic', 'other']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const audience = (p: Programme) => (p.class_name ? p.class_name : p.grade ? `Grade ${p.grade}` : 'Whole institution')

export default function ProgrammesPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const staff = isStaff(inst.role)
  const { data, error, loading, reload } = useLoad(async () => unwrap(await supabase.rpc('programmes_overview', { p_inst: inst.institution_id })) as Programme[], [inst.institution_id])
  const [editing, setEditing] = useState<Programme | 'new' | null>(null)
  const [members, setMembers] = useState<Programme | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (id: string, fn: () => PromiseLike<{ error: unknown }>, ok: string) => {
    setBusy(id)
    const { error: e } = await fn()
    setBusy(null)
    if (e) return toast.error(friendlyError(e))
    toast.success(ok)
    reload()
  }

  if (loading && !data) return <Loading />
  if (error || !data) return <ErrorNote>{error}</ErrorNote>
  const active = data.filter((p) => p.status === 'active')
  const archived = data.filter((p) => p.status === 'archived')

  return (
    <div className="space-y-5">
      <PageHeader
        title="Programmes"
        description={staff ? 'Development and habit programmes students can join. Check-ins count towards the extracurricular part of development scores.' : 'Join a programme and check in when you do it. Check-ins count towards your development score.'}
        actions={staff && can('manage_programmes') && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden="true" />
            New programme
          </button>
        )}
      />

      {active.length === 0 && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted">{staff ? 'No programmes yet.' : 'No programmes are open to you right now.'}</p>
        </Panel>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {active.map((p) => (
          <section key={p.id} className="card flex flex-col p-4 sm:p-5" aria-label={p.title}>
            <div className="mb-2 flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Sprout className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold break-words">{p.title}</h2>
                <p className="text-xs text-muted">{cap(p.category)} · {audience(p)} · target {p.weekly_target}× a week{p.ends_on ? ` · until ${new Date(`${p.ends_on}T12:00:00`).toLocaleDateString()}` : ''}</p>
              </div>
              {p.joined && <Pill tone="success">Joined</Pill>}
            </div>
            {p.description && <p className="mb-3 text-sm whitespace-pre-line">{p.description}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
              {staff ? (
                <>
                  <span className="mr-auto text-sm text-muted">
                    {p.members ?? 0} member{p.members === 1 ? '' : 's'}{p.checkin_rate_4w !== null ? ` · ${Math.round(Number(p.checkin_rate_4w) * 100)}% of target (4 weeks)` : ''}
                  </span>
                  <button type="button" className="btn-secondary h-9 min-h-9" onClick={() => setMembers(p)}>
                    <Users className="size-4" aria-hidden="true" /> Members
                  </button>
                  {p.can_manage && (
                    <>
                      <button type="button" className="btn-secondary h-9 min-h-9" onClick={() => setEditing(p)}>Edit</button>
                      <button type="button" className="btn-ghost h-9 min-h-9" disabled={busy === p.id}
                        onClick={() => act(p.id, () => supabase.from('development_programmes').update({ status: 'archived' }).eq('id', p.id), 'Programme archived.')}>
                        <Archive className="size-4" aria-hidden="true" /> Archive
                      </button>
                    </>
                  )}
                </>
              ) : p.joined ? (
                <>
                  <span className="mr-auto text-sm text-muted">This week: {p.my_checkins_this_week} of {p.weekly_target}</span>
                  <button type="button" className={p.my_checked_in_today ? 'btn-secondary h-9 min-h-9' : 'btn-primary h-9 min-h-9'} disabled={busy === p.id}
                    onClick={() => act(p.id, () => supabase.rpc('programme_checkin', { p_programme: p.id, p_remove: p.my_checked_in_today }), p.my_checked_in_today ? 'Check-in removed.' : 'Checked in for today.')}>
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    {p.my_checked_in_today ? 'Checked in today' : 'Check in today'}
                  </button>
                  <button type="button" className="btn-ghost h-9 min-h-9" disabled={busy === p.id}
                    onClick={() => act(p.id, () => supabase.rpc('join_programme', { p_programme: p.id, p_join: false }), 'You left the programme.')}>
                    Leave
                  </button>
                </>
              ) : (
                <button type="button" className="btn-primary h-9 min-h-9" disabled={busy === p.id}
                  onClick={() => act(p.id, () => supabase.rpc('join_programme', { p_programme: p.id }), `You joined ${p.title}.`)}>
                  Join
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {staff && archived.length > 0 && (
        <Panel title="Archived">
          <List>
            {archived.map((p) => (
              <Row key={p.id}>
                <span className="flex-1 text-sm">{p.title} <span className="text-muted">· {audience(p)}</span></span>
                {p.can_manage && (
                  <button type="button" className="btn-secondary h-9 min-h-9"
                    onClick={() => act(p.id, () => supabase.from('development_programmes').update({ status: 'active' }).eq('id', p.id), 'Programme restored.')}>
                    Restore
                  </button>
                )}
              </Row>
            ))}
          </List>
        </Panel>
      )}

      {editing && <ProgrammeForm inst={inst.institution_id} programme={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={reload} />}
      {members && <MembersModal programme={members} onClose={() => setMembers(null)} />}
    </div>
  )
}

function ProgrammeForm({ inst, programme, onClose, onDone }: { inst: string; programme: Programme | null; onClose: () => void; onDone: () => void }) {
  const { data: s } = useStructure(inst)
  const classes = (s?.classes ?? []).filter((c) => !c.archived).sort((a, b) => gradeSort(a.grade, b.grade) || a.name.localeCompare(b.name))
  const grades = s ? uniqueGrades(s.classes) : []
  const [title, setTitle] = useState(programme?.title ?? '')
  const [description, setDescription] = useState(programme?.description ?? '')
  const [category, setCategory] = useState(programme?.category ?? 'habit')
  const [target, setTarget] = useState(programme?.weekly_target ?? 3)
  const [aud, setAud] = useState(programme?.class_id ? `c:${programme.class_id}` : programme?.grade ? `g:${programme.grade}` : 'all')
  const [starts, setStarts] = useState(programme?.starts_on ?? new Date().toISOString().slice(0, 10))
  const [ends, setEnds] = useState(programme?.ends_on ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('Give the programme a title.')
    if (ends && ends < starts) return setError('The end date must be after the start date.')
    setBusy(true)
    setError(null)
    const row = {
      title: title.trim(), description: description.trim() || null, category, weekly_target: target,
      grade: aud.startsWith('g:') ? aud.slice(2) : null, class_id: aud.startsWith('c:') ? aud.slice(2) : null,
      starts_on: starts, ends_on: ends || null,
    }
    const { error: err } = programme
      ? await supabase.from('development_programmes').update(row).eq('id', programme.id)
      : await supabase.from('development_programmes').insert({ institution_id: inst, ...row })
    setBusy(false)
    if (err) return setError(/row-level security/i.test(err.message) ? 'You can’t create a programme for this audience.' : friendlyError(err))
    toast.success(programme ? 'Programme saved.' : 'Programme created.')
    onDone()
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={programme ? 'Edit programme' : 'New programme'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="programme-form" className="btn-primary" disabled={busy}>{busy && <Spinner className="size-4" />}Save</button>
        </>
      }>
      <form id="programme-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        <Field label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 20 minutes of reading" />
        <TextArea label="Description" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} hint="What students do, and how to check in." />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
          </SelectField>
          <SelectField label="Check-ins per week" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
          </SelectField>
        </div>
        <SelectField label="Open to" value={aud} onChange={(e) => setAud(e.target.value)}>
          <option value="all">Whole institution</option>
          {grades.map((g) => <option key={g} value={`g:${g}`}>Grade {g}</option>)}
          {classes.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="field-label">Starts</span>
            <input type="date" className="input" value={starts} onChange={(e) => setStarts(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="field-label">Ends <span className="font-normal text-muted">(optional)</span></span>
            <input type="date" className="input" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} />
          </label>
        </div>
      </form>
    </Modal>
  )
}

function MembersModal({ programme, onClose }: { programme: Programme; onClose: () => void }) {
  const { data, error, loading } = useLoad(
    async () => unwrap(await supabase.rpc('programme_members_report', { p_programme: programme.id })) as { student_id: string; student: string; class_name: string | null; checkins_4w: number; last_checkin: string | null }[],
    [programme.id],
  )
  return (
    <Modal open onClose={onClose} title={`${programme.title}: members`} subtitle={`Check-ins in the last 4 weeks (target ${programme.weekly_target * 4})`}
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {loading && !data && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (
        <List empty="No members you can see yet.">
          {data.map((m) => (
            <Row key={m.student_id} className="py-2">
              <span className="flex-1 text-sm">{m.student}{m.class_name && <span className="text-muted"> · {m.class_name}</span>}</span>
              <span className="text-sm tabular-nums">{m.checkins_4w} check-ins{m.last_checkin && <span className="text-muted"> · last {new Date(`${m.last_checkin}T12:00:00`).toLocaleDateString()}</span>}</span>
            </Row>
          ))}
        </List>
      )}
    </Modal>
  )
}
