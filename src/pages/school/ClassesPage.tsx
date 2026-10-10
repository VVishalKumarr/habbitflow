import { Archive, ArchiveRestore, CalendarClock, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { gradeSort, useStructure, type SchoolStructure } from '../../components/school/data'
import { StudentTimetableModal } from '../../components/school/StudentTimetable'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { isHead, ROLE_LABEL, STAFF_ROLES, type MyInstitution, type SchoolClass } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { DAY_SHORT } from '../../lib/dates'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

export default function ClassesPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const { data: s, error, loading, reload } = useStructure(inst.institution_id)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [timetableOf, setTimetableOf] = useState<string | null>(null)
  // Students whose personal timetables I may edit (class teachers, if the school allows it).
  const { data: editable } = useLoad(
    async () => (inst.role === 'class_teacher' ? new Set((unwrap(await supabase.rpc('my_editable_students')) as string[]) ?? []) : new Set<string>()),
    [inst.institution_id, inst.role],
  )

  if (loading && !s) return <Loading />
  if (error || !s) return <ErrorNote>{error}</ErrorNote>

  const myScopes = s.scopes.filter((x) => x.coordinator_id === inst.membership_id).map((x) => x.grade.toLowerCase())
  const canManageGrade = (grade: string) =>
    can('manage_classes') && (isHead(inst.role) || (inst.role === 'coordinator' && (myScopes.includes('*') || myScopes.includes(grade.toLowerCase()))))
  const canManage = (c: SchoolClass) => canManageGrade(c.grade) || (can('manage_classes') && c.class_teacher_id === inst.membership_id)
  // Class timetable: manage_classes as above, or the narrower manage_timetable.
  const canEditPeriods = (c: SchoolClass) =>
    canManage(c) ||
    (can('manage_timetable') &&
      (isHead(inst.role) ||
        (inst.role === 'coordinator' && (myScopes.includes('*') || myScopes.includes(c.grade.toLowerCase()))) ||
        (inst.role === 'class_teacher' && c.class_teacher_id === inst.membership_id)))
  const grades = [...new Set(s.classes.map((c) => c.grade))].sort(gradeSort)
  const canCreate = can('manage_classes') && (isHead(inst.role) || myScopes.length > 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Classes & subjects"
        description="Classes, who teaches what, and which students are in each class. Teachers only see the classes they are assigned to."
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New class
            </button>
          )
        }
      />

      <SubjectsPanel inst={inst} s={s} canEdit={can('manage_classes')} onChange={reload} />

      {grades.length === 0 && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted">{canCreate ? 'No classes yet. Create the first one.' : 'You aren’t assigned to any classes yet.'}</p>
        </Panel>
      )}

      {grades.map((g) => (
        <Panel key={g} title={/^\d/.test(g) ? `Grade ${g}` : g}>
          <ul className="divide-y divide-line">
            {s.classes
              .filter((c) => c.grade === g)
              .map((c) => {
                const teacher = s.members.find((m) => m.id === c.class_teacher_id)
                const count = s.enrollments.filter((e) => e.class_id === c.id).length
                const isOpen = open === c.id
                return (
                  <li key={c.id} className="py-1">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2.5 text-left hover:bg-subtle"
                      onClick={() => setOpen(isOpen ? null : c.id)}
                      aria-expanded={isOpen}
                    >
                      <span className="font-medium">{c.name}</span>
                      {c.archived && <Pill>Archived</Pill>}
                      <span className="text-sm text-muted">
                        {teacher ? `Class teacher: ${teacher.display_name}` : 'No class teacher'} · {count} student{count === 1 ? '' : 's'}
                      </span>
                      <ChevronDown className={`ml-auto size-4 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {isOpen && (
                      <ClassDetail inst={inst.institution_id} c={c} s={s} editable={canManage(c)} periodsEditable={canEditPeriods(c)}
                        timetableStudents={editable ?? new Set()} onTimetable={setTimetableOf} onChange={reload} />
                    )}
                  </li>
                )
              })}
          </ul>
        </Panel>
      ))}

      {can('manage_classes') && <ConflictsPanel inst={inst.institution_id} />}

      {timetableOf && <StudentTimetableModal studentId={timetableOf} onClose={() => setTimetableOf(null)} />}
      {creating && <NewClassModal inst={inst} s={s} canManageGrade={canManageGrade} onClose={() => setCreating(false)} onDone={reload} />}
    </div>
  )
}

function SubjectsPanel({ inst, s, canEdit, onChange }: { inst: MyInstitution; s: SchoolStructure; canEdit: boolean; onChange: () => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const { error } = await supabase.from('subjects').insert({ institution_id: inst.institution_id, name: name.trim(), code: code.trim() || null })
    setBusy(false)
    if (error) return toast.error(error.code === '23505' ? 'That subject already exists.' : friendlyError(error))
    setName('')
    setCode('')
    onChange()
  }
  const toggle = async (id: string, archived: boolean) => {
    const { error } = await supabase.from('subjects').update({ archived }).eq('id', id)
    if (error) toast.error(friendlyError(error))
    else onChange()
  }

  return (
    <Panel title="Subjects" description={canEdit ? 'Archive a subject instead of deleting it; past records keep their subject.' : undefined}>
      <div className="flex flex-wrap gap-2">
        {s.subjects.length === 0 && <p className="text-sm text-muted">No subjects yet.</p>}
        {s.subjects.map((sub) => (
          <span key={sub.id} className={`inline-flex items-center gap-1.5 rounded-full border border-line py-1 pr-1.5 pl-3 text-sm ${sub.archived ? 'text-muted line-through' : ''}`}>
            {sub.name}
            {sub.code && <span className="text-xs text-muted">{sub.code}</span>}
            {canEdit && (
              <button type="button" className="rounded-full p-1 text-muted hover:bg-subtle hover:text-ink" onClick={() => toggle(sub.id, !sub.archived)} aria-label={sub.archived ? `Restore ${sub.name}` : `Archive ${sub.name}`} title={sub.archived ? 'Restore' : 'Archive'}>
                {sub.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
              </button>
            )}
          </span>
        ))}
      </div>
      {canEdit && (
        <form onSubmit={add} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="New subject" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Mathematics" />
          </div>
          <div className="sm:w-36">
            <Field label="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} />
          </div>
          <button type="submit" className="btn-secondary h-11" disabled={busy || !name.trim()}>
            Add subject
          </button>
        </form>
      )}
    </Panel>
  )
}

function ClassDetail({ inst, c, s, editable, periodsEditable, timetableStudents, onTimetable, onChange }: {
  inst: string
  c: SchoolClass
  s: SchoolStructure
  editable: boolean
  periodsEditable: boolean
  timetableStudents: Set<string>
  onTimetable: (studentId: string) => void
  onChange: () => void
}) {
  const staff = s.members.filter((m) => STAFF_ROLES.includes(m.role) && m.status === 'active' && m.role !== 'principal' && m.role !== 'director')
  const enrolled = s.enrollments.filter((e) => e.class_id === c.id)
  const enrolledIds = new Set(enrolled.map((e) => e.student_id))
  const available = s.members.filter((m) => m.role === 'student' && m.status === 'active' && !enrolledIds.has(m.id))
  const teaching = s.teaching.filter((t) => t.class_id === c.id)
  const [student, setStudent] = useState('')
  const [subject, setSubject] = useState('')
  const [teacher, setTeacher] = useState('')
  const name = (id: string) => s.members.find((m) => m.id === id)?.display_name ?? 'Unknown'

  const run = async (p: PromiseLike<{ error: unknown }>, ok?: string) => {
    const { error } = await p
    if (error) toast.error(friendlyError(error))
    else {
      if (ok) toast.success(ok)
      onChange()
    }
  }

  return (
    <div className="mb-3 space-y-5 rounded-xl bg-subtle/60 p-3 sm:p-4">
      {editable && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Class teacher"
            value={c.class_teacher_id ?? ''}
            onChange={(e) => run(supabase.from('classes').update({ class_teacher_id: e.target.value || null }).eq('id', c.id), 'Class teacher updated.')}
          >
            <option value="">None</option>
            {staff.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name} ({ROLE_LABEL[m.role]})
              </option>
            ))}
          </SelectField>
          <div className="flex items-end">
            <button type="button" className="btn-secondary h-11" onClick={() => run(supabase.from('classes').update({ archived: !c.archived }).eq('id', c.id), c.archived ? 'Class restored.' : 'Class archived.')}>
              {c.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {c.archived ? 'Restore class' : 'Archive class'}
            </button>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Subjects and teachers</h3>
        <List empty="No subject teachers assigned.">
          {teaching.map((t) => (
            <Row key={t.id} className="py-2">
              <span className="flex-1 text-sm">
                <span className="font-medium">{s.subjects.find((x) => x.id === t.subject_id)?.name}</span> · {name(t.teacher_id)}
              </span>
              {editable && (
                <button type="button" className="icon-btn size-9" onClick={() => run(supabase.from('teaching_assignments').delete().eq('id', t.id))} aria-label="Remove subject teacher">
                  <Trash2 className="size-4" />
                </button>
              )}
            </Row>
          ))}
        </List>
        {editable && (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <select className="input h-10 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
              <option value="">Subject…</option>
              {s.subjects.filter((x) => !x.archived).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select className="input h-10 text-sm" value={teacher} onChange={(e) => setTeacher(e.target.value)} aria-label="Teacher">
              <option value="">Teacher…</option>
              {staff.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary h-10 shrink-0"
              disabled={!subject || !teacher}
              onClick={() => {
                run(supabase.from('teaching_assignments').insert({ institution_id: inst, class_id: c.id, subject_id: subject, teacher_id: teacher }))
                setSubject('')
                setTeacher('')
              }}
            >
              Assign
            </button>
          </div>
        )}
      </div>

      <PeriodsEditor inst={inst} c={c} s={s} editable={periodsEditable} onChange={onChange} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Students ({enrolled.length})</h3>
        <List empty="No students enrolled.">
          {enrolled
            .map((e) => ({ e, n: name(e.student_id) }))
            .sort((a, b) => a.n.localeCompare(b.n))
            .map(({ e, n }) => (
              <Row key={e.id} className="py-2">
                <span className="flex-1 text-sm">
                  {n}
                  {e.roll_no && <span className="text-muted"> · Roll {e.roll_no}</span>}
                </span>
                {timetableStudents.has(e.student_id) && (
                  <button type="button" className="btn-ghost h-9 min-h-9 px-2.5 text-brand" onClick={() => onTimetable(e.student_id)} aria-label={`Timetable of ${n}`}>
                    <CalendarClock className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Timetable</span>
                  </button>
                )}
                {editable && (
                  <button type="button" className="icon-btn size-9" onClick={() => run(supabase.from('class_enrollments').delete().eq('id', e.id))} aria-label={`Remove ${n} from class`}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </Row>
            ))}
        </List>
        {editable && (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <select className="input h-10 text-sm" value={student} onChange={(e) => setStudent(e.target.value)} aria-label="Student to enrol">
              <option value="">{available.length ? 'Add a student…' : 'No unassigned students you can see'}</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                  {m.external_id ? ` (#${m.external_id})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary h-10 shrink-0"
              disabled={!student}
              onClick={() => {
                run(supabase.from('class_enrollments').insert({ institution_id: inst, class_id: c.id, student_id: student }))
                setStudent('')
              }}
            >
              Enrol
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NewClassModal({ inst, s, canManageGrade, onClose, onDone }: { inst: MyInstitution; s: SchoolStructure; canManageGrade: (g: string) => boolean; onClose: () => void; onDone: () => void }) {
  const current = s.years.find((y) => y.is_current)
  const [grade, setGrade] = useState('')
  const [section, setSection] = useState('')
  const [name, setName] = useState('')
  const [year, setYear] = useState(current?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const autoName = [grade.trim(), section.trim()].filter(Boolean).join(' ')

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!grade.trim()) return setError('Enter a grade or year, e.g. 10 or “FY BSc”.')
    if (!canManageGrade(grade.trim())) return setError('You can only create classes in the grades you coordinate.')
    setBusy(true)
    const { error: err } = await supabase.from('classes').insert({
      institution_id: inst.institution_id,
      grade: grade.trim(),
      section: section.trim() || null,
      name: (name.trim() || autoName).slice(0, 60),
      academic_year_id: year || null,
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Class created.')
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New class"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-class" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Create
          </button>
        </>
      }
    >
      <form id="new-class" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Grade / year" value={grade} onChange={(e) => setGrade(e.target.value)} maxLength={30} placeholder="10" />
          <Field label="Section" value={section} onChange={(e) => setSection(e.target.value)} maxLength={20} placeholder="A" />
        </div>
        <Field label="Class name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={autoName || '10 A'} hint="Leave empty to use grade and section." />
        <SelectField label="Academic year" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">Not set</option>
          {s.years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
              {y.is_current ? ' (current)' : ''}
            </option>
          ))}
        </SelectField>
      </form>
    </Modal>
  )
}

/** Weekly class timetable: fixed school periods (used by the parent view and the AI planner). */
function PeriodsEditor({ inst, c, s, editable, onChange }: { inst: string; c: SchoolClass; s: SchoolStructure; editable: boolean; onChange: () => void }) {
  const periods = s.periods.filter((p) => p.class_id === c.id)
  const [day, setDay] = useState(1)
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('09:45')
  const [subject, setSubject] = useState('')
  const [label, setLabel] = useState('')
  const teacherFor = (subjectId: string) => s.teaching.find((t) => t.class_id === c.id && t.subject_id === subjectId)?.teacher_id ?? null

  const add = async () => {
    if (!subject && !label.trim()) return toast.error('Choose a subject or type a label such as Lunch.')
    const { error } = await supabase.from('class_periods').insert({
      institution_id: inst,
      class_id: c.id,
      day_of_week: day,
      start_time: start,
      end_time: end,
      subject_id: subject || null,
      teacher_id: subject ? teacherFor(subject) : null,
      label: subject ? null : label.trim(),
    })
    if (error) return toast.error(friendlyError(error))
    onChange()
  }
  const remove = async (id: string) => {
    const { error } = await supabase.from('class_periods').delete().eq('id', id)
    if (error) toast.error(friendlyError(error))
    else onChange()
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Weekly timetable</h3>
      {periods.length === 0 ? (
        <p className="text-sm text-muted">No periods yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6, 0]
            .filter((d) => periods.some((p) => p.day_of_week === d))
            .map((d) => (
              <div key={d} className="rounded-xl border border-line bg-surface p-2.5">
                <p className="mb-1 text-xs font-semibold text-muted">{DAY_SHORT[d]}</p>
                <ul className="space-y-0.5 text-sm">
                  {periods
                    .filter((p) => p.day_of_week === d)
                    .map((p) => (
                      <li key={p.id} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 text-muted tabular-nums">
                          {p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{p.subject_id ? s.subjects.find((x) => x.id === p.subject_id)?.name : p.label}</span>
                        {editable && (
                          <button type="button" className="rounded p-1 text-muted hover:text-danger" onClick={() => remove(p.id)} aria-label="Remove period">
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
        </div>
      )}
      {editable && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[100px_110px_110px_minmax(0,1fr)_auto]">
          <select className="input h-10 text-sm" value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <option key={d} value={d}>
                {DAY_SHORT[d]}
              </option>
            ))}
          </select>
          <input type="time" className="input h-10 text-sm" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time" />
          <input type="time" className="input h-10 text-sm" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End time" />
          <select className="input h-10 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Period subject">
            <option value="">Other (label)…</option>
            {s.teaching
              .filter((t) => t.class_id === c.id)
              .map((t) => (
                <option key={t.id} value={t.subject_id}>
                  {s.subjects.find((x) => x.id === t.subject_id)?.name}
                </option>
              ))}
          </select>
          {!subject && <input className="input h-10 text-sm" placeholder="Label, e.g. Lunch" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} aria-label="Period label" />}
          <button type="button" className="btn-secondary h-10" onClick={add}>
            Add period
          </button>
        </div>
      )}
    </div>
  )
}

/** Teachers timetabled in two classes at the same time. */
function ConflictsPanel({ inst }: { inst: string }) {
  const { data } = useLoad(
    async () =>
      unwrap(await supabase.rpc('timetable_conflicts', { p_inst: inst })) as {
        teacher: string
        day_of_week: number
        a_class: string
        a_start: string
        a_end: string
        b_class: string
        b_start: string
        b_end: string
      }[],
    [inst],
  )
  if (!data) return null
  return (
    <Panel title="Timetable conflicts" description="Teachers scheduled in two classes at once.">
      <List empty="No clashes in the class timetables you can see.">
        {data.map((x, i) => (
          <Row key={i} className="py-2">
            <span className="flex-1 text-sm">
              <span className="font-medium">{x.teacher}</span> · {DAY_SHORT[x.day_of_week]}: {x.a_class} {x.a_start.slice(0, 5)}–{x.a_end.slice(0, 5)} and {x.b_class}{' '}
              {x.b_start.slice(0, 5)}–{x.b_end.slice(0, 5)}
            </span>
            <Pill tone="danger">Double-booked</Pill>
          </Row>
        ))}
      </List>
    </Panel>
  )
}
