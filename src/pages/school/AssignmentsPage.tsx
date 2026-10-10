import { ClipboardList, Pencil, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useStructure, type SchoolStructure } from '../../components/school/data'
import { StudentSubmission, SubmissionsModal } from '../../components/school/Submissions'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, TextArea } from '../../components/school/ui'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { formatDateTime, isStaff, toLocalInput, withinOneMonth, type Assignment, type AssignmentKind, type MyInstitution } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

interface Progress {
  assignment_id: string
  enrolled: number
  submitted: number
  late: number
  accepted: number
  needs_changes: number
}

const KIND_LABEL: Record<AssignmentKind, string> = { homework: 'Homework', classwork: 'Classwork', project: 'Project', assessment: 'Assessment' }

export default function AssignmentsPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const structure = useStructure(inst.institution_id)
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming')
  const [editing, setEditing] = useState<Assignment | 'new' | null>(null)
  const [reviewing, setReviewing] = useState<Assignment | null>(null)
  const list = useLoad(async () => {
    let q = supabase.from('assignments').select('*').eq('institution_id', inst.institution_id)
    const now = new Date().toISOString()
    if (filter === 'upcoming') q = q.gte('due_at', now).order('due_at')
    else if (filter === 'past') q = q.lt('due_at', now).order('due_at', { ascending: false })
    else q = q.order('due_at', { ascending: false })
    const rows = unwrap(await q.limit(300)) as Assignment[]
    // Submission counts for staff (the function returns nothing for students).
    const progress = isStaff(inst.role) && rows.length
      ? (unwrap(await supabase.rpc('assignment_progress', { p_assignments: rows.map((a) => a.id) })) as Progress[])
      : []
    return rows.map((a) => ({ ...a, progress: progress.find((p) => p.assignment_id === a.id) ?? null }))
  }, [inst.institution_id, filter])

  const s = structure.data
  if ((structure.loading && !s) || (list.loading && !list.data)) return <Loading />
  if (!s) return <ErrorNote>{structure.error}</ErrorNote>

  const myTeaching = s.teaching.filter((t) => t.teacher_id === inst.membership_id)
  const canCreate = can('create_assignments') && myTeaching.length > 0
  const student = inst.role === 'student'
  const now = Date.now()

  return (
    <div className="space-y-5">
      <PageHeader
        title={student ? 'Your assignments' : 'Assignments'}
        description={
          student
            ? 'Homework and classwork set by your teachers. Your teacher records when work is accepted.'
            : 'Submission windows are at most one calendar month. Students upload PDF, JPG or PNG files (4 MB max); you accept the work or ask for changes.'
        }
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" />
              New assignment
            </button>
          )
        }
      />

      <div className="flex rounded-xl bg-subtle p-1 sm:w-fit" role="tablist" aria-label="Which assignments">
        {(['upcoming', 'past', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`h-9 flex-1 rounded-lg px-4 text-sm font-medium capitalize sm:flex-none ${filter === f ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
          >
            {f}
          </button>
        ))}
      </div>

      <ErrorNote>{list.error}</ErrorNote>
      {list.data && list.data.length === 0 ? (
        <div className="card">
          <EmptyState icon={ClipboardList} title="No assignments" message={filter === 'upcoming' ? 'Nothing is due soon.' : 'Nothing to show.'} />
        </div>
      ) : (
        <Panel>
          <List>
            {(list.data ?? []).map((a) => {
              const due = new Date(a.due_at).getTime()
              const dueToday = new Date(a.due_at).toDateString() === new Date().toDateString()
              const overdue = due < now
              const editable = isStaff(inst.role) && (a.teacher_id === inst.membership_id || can('manage_classes'))
              return (
                <Row key={a.id}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {a.title} {a.status !== 'published' && <Pill tone={a.status === 'draft' ? 'warning' : 'muted'}>{a.status}</Pill>}
                    </p>
                    <p className="text-sm text-muted">
                      {KIND_LABEL[a.kind]} · {s.subjects.find((x) => x.id === a.subject_id)?.name} · {s.classes.find((c) => c.id === a.class_id)?.name}
                      {!student && ` · ${s.members.find((m) => m.id === a.teacher_id)?.display_name ?? ''}`}
                    </p>
                    <p className="text-sm">
                      Opens {formatDateTime(a.opens_at)} · <strong>Due {formatDateTime(a.due_at)}</strong>
                    </p>
                    {a.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description}</p>}
                    {student && a.status !== 'draft' && <StudentSubmission assignment={a} />}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {a.status === 'published' && (dueToday ? <Pill tone="warning">Due today</Pill> : overdue ? <Pill>Deadline passed</Pill> : null)}
                    {a.progress && (
                      <button type="button" className="btn-secondary h-9 px-3" onClick={() => setReviewing(a)}>
                        Submissions {a.progress.submitted}/{a.progress.enrolled}
                        {a.progress.late > 0 && <span className="text-xs text-muted">· {a.progress.late} late</span>}
                      </button>
                    )}
                    {editable && (
                      <button type="button" className="btn-ghost h-9 px-2.5" onClick={() => setEditing(a)}>
                        <Pencil className="size-4" aria-hidden="true" />
                        Edit
                      </button>
                    )}
                  </div>
                </Row>
              )
            })}
          </List>
        </Panel>
      )}

      {reviewing && (
        <SubmissionsModal
          assignment={reviewing}
          canHold={can('set_homework_retention')}
          students={s.members.filter((m) => s.enrollments.some((e) => e.class_id === reviewing.class_id && e.student_id === m.id))}
          onClose={() => (setReviewing(null), list.reload())}
        />
      )}
      {editing && <AssignmentModal inst={inst} s={s} assignment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={list.reload} />}
    </div>
  )
}

function AssignmentModal({ inst, s, assignment, onClose, onDone }: { inst: MyInstitution; s: SchoolStructure; assignment: Assignment | null; onClose: () => void; onDone: () => void }) {
  const mine = s.teaching.filter((t) => t.teacher_id === inst.membership_id)
  const pairs = mine.map((t) => ({ value: `${t.class_id}|${t.subject_id}`, label: `${s.classes.find((c) => c.id === t.class_id)?.name} · ${s.subjects.find((x) => x.id === t.subject_id)?.name}` }))
  const start = new Date()
  start.setMinutes(0, 0, 0)
  const due = new Date(start.getTime() + 7 * 86400_000)
  due.setHours(23, 59, 0, 0)

  const [pair, setPair] = useState(assignment ? `${assignment.class_id}|${assignment.subject_id}` : pairs[0]?.value ?? '')
  const [title, setTitle] = useState(assignment?.title ?? '')
  const [description, setDescription] = useState(assignment?.description ?? '')
  const [kind, setKind] = useState<AssignmentKind>(assignment?.kind ?? 'homework')
  const [opensAt, setOpensAt] = useState(toLocalInput(assignment?.opens_at ?? start))
  const [dueAt, setDueAt] = useState(toLocalInput(assignment?.due_at ?? due))
  const [status, setStatus] = useState<Assignment['status']>(assignment?.status ?? 'published')
  const [latePolicy, setLatePolicy] = useState<Assignment['late_policy']>(assignment?.late_policy ?? 'accept_marked_late')
  const [types, setTypes] = useState<Assignment['allowed_types']>(assignment?.allowed_types ?? ['pdf', 'jpg', 'png'])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const [classId, subjectId] = pair.split('|')
    const o = new Date(opensAt)
    const d = new Date(dueAt)
    if (!title.trim()) return setError('Give the assignment a title.')
    if (!classId) return setError('Choose a class and subject you teach.')
    if (Number.isNaN(o.getTime()) || Number.isNaN(d.getTime())) return setError('Enter the submission start and deadline.')
    if (d <= o) return setError('The deadline must be after the submission start.')
    if (!withinOneMonth(o, d)) return setError('The submission window can’t be longer than one calendar month.')
    if (types.length === 0) return setError('Allow at least one file type.')
    const row = {
      title: title.trim(),
      description: description.trim() || null,
      kind,
      opens_at: o.toISOString(),
      due_at: d.toISOString(),
      status,
      late_policy: latePolicy,
      allowed_types: types,
      max_file_mb: 4,
    }
    setBusy(true)
    const { error: err } = assignment
      ? await supabase.from('assignments').update({ ...row, subject_id: subjectId }).eq('id', assignment.id)
      : await supabase.from('assignments').insert({ ...row, institution_id: inst.institution_id, class_id: classId, subject_id: subjectId, teacher_id: inst.membership_id })
    setBusy(false)
    if (err) return setError(/check constraint/i.test(err.message) ? 'The submission window must start before the deadline and be at most one calendar month.' : friendlyError(err))
    toast.success(assignment ? 'Assignment updated.' : 'Assignment created.')
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={assignment ? 'Edit assignment' : 'New assignment'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="assignment-form" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            {assignment ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <form id="assignment-form" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Class and subject" value={pair} onChange={(e) => setPair(e.target.value)} disabled={!!assignment}>
            {pairs.length === 0 && assignment && <option value={pair}>{s.classes.find((c) => c.id === assignment.class_id)?.name}</option>}
            {pairs.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as AssignmentKind)}>
            {(Object.keys(KIND_LABEL) as AssignmentKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </SelectField>
        </div>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        <TextArea label="Instructions" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Submission opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          <Field label="Deadline" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} hint="At most one calendar month after opening." />
          <SelectField label="Late submissions" value={latePolicy} onChange={(e) => setLatePolicy(e.target.value as Assignment['late_policy'])}>
            <option value="accept_marked_late">Accept, marked late</option>
            <option value="reject">Don’t accept</option>
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as Assignment['status'])}>
            <option value="published">Published (students see it)</option>
            <option value="draft">Draft (only staff)</option>
            {assignment && <option value="closed">Closed</option>}
            {assignment && <option value="cancelled">Cancelled</option>}
          </SelectField>
        </div>
        <fieldset>
          <legend className="field-label">Allowed files (max 4 MB each)</legend>
          <div className="flex flex-wrap gap-4">
            {(['pdf', 'jpg', 'png'] as const).map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm uppercase">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand)]"
                  checked={types.includes(t)}
                  onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))}
                />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted">
          Uploaded files are kept for the review/retention interval set by coordinators ({assignment?.review_retention_days ?? 'institution default'} days after the deadline or last upload), then deleted automatically. Review records and marks are kept.
        </p>
      </form>
    </Modal>
  )
}
