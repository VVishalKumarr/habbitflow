import { Award, Plus, Send } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useStructure, type SchoolStructure } from '../../components/school/data'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField, Stat, TextArea } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import { formatDay, type InstitutionSettings, type MyInstitution } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

type AssessmentKind = 'internal' | 'external' | 'project' | 'practical'
const KIND_LABEL: Record<AssessmentKind, string> = { internal: 'Internal assessment', external: 'External examination', project: 'Project', practical: 'Practical' }

interface Assessment {
  id: string
  class_id: string
  subject_id: string
  term_id: string | null
  teacher_id: string
  title: string
  kind: AssessmentKind
  max_marks: number
  assessment_date: string
  status: 'draft' | 'published'
  published_at: string | null
}

interface Mark {
  id: string
  assessment_id: string
  student_id: string
  obtained: number | null
  absent: boolean
  feedback: string | null
}

function gradeOf(scale: InstitutionSettings['grading_scale'], pct: number) {
  return [...scale].sort((a, b) => b.min - a.min).find((g) => pct >= g.min)?.label ?? '—'
}

export default function MarksPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const structure = useStructure(inst.institution_id)
  const data = useLoad(async () => {
    const [a, m, st] = await Promise.all([
      supabase.from('assessments').select('*').eq('institution_id', inst.institution_id).order('assessment_date', { ascending: false }).limit(300),
      supabase.from('marks').select('*').eq('institution_id', inst.institution_id).limit(5000),
      supabase.rpc('institution_settings', { p_inst: inst.institution_id }),
    ])
    return { assessments: unwrap(a) as Assessment[], marks: unwrap(m) as Mark[], settings: unwrap(st) as InstitutionSettings }
  }, [inst.institution_id])
  const [creating, setCreating] = useState(false)
  const [entering, setEntering] = useState<Assessment | null>(null)

  const s = structure.data
  if ((structure.loading && !s) || (data.loading && !data.data)) return <Loading />
  if (!s || !data.data) return <ErrorNote>{structure.error ?? data.error}</ErrorNote>
  const { assessments, marks, settings } = data.data
  const subject = (id: string) => s.subjects.find((x) => x.id === id)?.name ?? ''
  const klass = (id: string) => s.classes.find((x) => x.id === id)?.name ?? ''

  if (inst.role === 'student') {
    const mine = assessments
      .map((a) => ({ a, m: marks.find((k) => k.assessment_id === a.id) }))
      .filter((x) => x.m)
    const scored = mine.filter((x) => !x.m!.absent && x.m!.obtained !== null)
    const avg = scored.length ? scored.reduce((n, x) => n + (Number(x.m!.obtained) / Number(x.a.max_marks)) * 100, 0) / scored.length : null
    return (
      <div className="space-y-5">
        <PageHeader title="Your marks" description="Published marks and feedback from your teachers." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat icon={Award} label="Average" value={avg === null ? '—' : `${avg.toFixed(1)}%`} hint={avg === null ? 'No marks yet' : `Grade ${gradeOf(settings.grading_scale, avg)}`} />
          <Stat icon={Award} label="Assessments" value={mine.length} tone="muted" />
        </div>
        <Panel>
          <List empty="No published marks yet.">
            {mine.map(({ a, m }) => {
              const pct = m!.obtained !== null ? (Number(m!.obtained) / Number(a.max_marks)) * 100 : null
              return (
                <Row key={a.id}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{a.title}</p>
                    <p className="text-sm text-muted">
                      {subject(a.subject_id)} · {KIND_LABEL[a.kind]} · {formatDay(a.assessment_date)}
                    </p>
                    {m!.feedback && <p className="mt-1 text-sm">“{m!.feedback}”</p>}
                  </div>
                  {m!.absent ? (
                    <Pill>Absent</Pill>
                  ) : (
                    <div className="text-right">
                      <p className="font-semibold tabular-nums">
                        {Number(m!.obtained)} / {Number(a.max_marks)}
                      </p>
                      <p className="text-xs text-muted">
                        {pct!.toFixed(0)}% · {gradeOf(settings.grading_scale, pct!)}
                      </p>
                    </div>
                  )}
                </Row>
              )
            })}
          </List>
        </Panel>
      </div>
    )
  }

  const mineToTeach = s.teaching.filter((t) => t.teacher_id === inst.membership_id)
  const canEnter = (a: Assessment) => mineToTeach.some((t) => t.class_id === a.class_id && t.subject_id === a.subject_id) && current!.permissions.includes('enter_marks')

  return (
    <div className="space-y-5">
      <PageHeader
        title="Marks"
        description="Internal and external assessments. Students see marks only after you publish; corrections after publishing need a reason and are kept in the audit history."
        actions={
          mineToTeach.length > 0 && current!.permissions.includes('enter_marks') && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New assessment
            </button>
          )
        }
      />
      <Panel>
        <List empty="No assessments yet.">
          {assessments.map((a) => {
            const ms = marks.filter((k) => k.assessment_id === a.id && !k.absent && k.obtained !== null)
            const avg = ms.length ? ms.reduce((n, k) => n + Number(k.obtained), 0) / ms.length : null
            return (
              <Row key={a.id}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {a.title} {a.status === 'draft' && <Pill tone="warning">Draft</Pill>}
                  </p>
                  <p className="text-sm text-muted">
                    {klass(a.class_id)} · {subject(a.subject_id)} · {KIND_LABEL[a.kind]} · {formatDay(a.assessment_date)} · out of {Number(a.max_marks)}
                  </p>
                </div>
                <span className="text-sm text-muted">{avg === null ? 'No marks yet' : `Average ${avg.toFixed(1)} (${((avg / a.max_marks) * 100).toFixed(0)}%)`}</span>
                {canEnter(a) && (
                  <button type="button" className="btn-secondary h-9 px-3" onClick={() => setEntering(a)}>
                    Enter marks
                  </button>
                )}
              </Row>
            )
          })}
        </List>
      </Panel>
      {creating && <NewAssessment inst={inst} s={s} onClose={() => setCreating(false)} onDone={data.reload} />}
      {entering && (
        <MarksModal
          assessment={entering}
          students={s.members.filter((m) => s.enrollments.some((e) => e.class_id === entering.class_id && e.student_id === m.id))}
          marks={marks.filter((k) => k.assessment_id === entering.id)}
          onClose={() => (setEntering(null), data.reload())}
        />
      )}
    </div>
  )
}

function NewAssessment({ inst, s, onClose, onDone }: { inst: MyInstitution; s: SchoolStructure; onClose: () => void; onDone: () => void }) {
  const pairs = s.teaching.filter((t) => t.teacher_id === inst.membership_id)
  const [pair, setPair] = useState(pairs[0] ? `${pairs[0].class_id}|${pairs[0].subject_id}` : '')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<AssessmentKind>('internal')
  const [max, setMax] = useState('50')
  const [date, setDate] = useState(todayISO())
  const [term, setTerm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const [classId, subjectId] = pair.split('|')
    const mx = Number(max)
    if (!title.trim()) return setError('Give the assessment a title.')
    if (!(mx > 0 && mx <= 1000)) return setError('Maximum marks must be between 1 and 1000.')
    setBusy(true)
    const { error: err } = await supabase.from('assessments').insert({
      institution_id: inst.institution_id,
      class_id: classId,
      subject_id: subjectId,
      teacher_id: inst.membership_id,
      term_id: term || null,
      title: title.trim(),
      kind,
      max_marks: mx,
      assessment_date: date,
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New assessment"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-assessment" className="btn-primary" disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <form id="new-assessment" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <SelectField label="Class and subject" value={pair} onChange={(e) => setPair(e.target.value)}>
          {pairs.map((t) => (
            <option key={t.id} value={`${t.class_id}|${t.subject_id}`}>
              {s.classes.find((c) => c.id === t.class_id)?.name} · {s.subjects.find((x) => x.id === t.subject_id)?.name}
            </option>
          ))}
        </SelectField>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Unit test 1" />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as AssessmentKind)}>
            {(Object.keys(KIND_LABEL) as AssessmentKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <Field label="Maximum marks" type="number" min={1} max={1000} value={max} onChange={(e) => setMax(e.target.value)} />
          <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <SelectField label="Term" value={term} onChange={(e) => setTerm(e.target.value)}>
            <option value="">—</option>
            {s.terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
        </div>
      </form>
    </Modal>
  )
}

function MarksModal({ assessment: a, students, marks, onClose }: { assessment: { id: string; title: string; max_marks: number; status: string }; students: { id: string; display_name: string }[]; marks: Mark[]; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, { obtained: string; absent: boolean; feedback: string }>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [askReason, setAskReason] = useState(false)
  const published = a.status === 'published'

  useEffect(() => {
    const next: typeof rows = {}
    for (const st of students) {
      const m = marks.find((k) => k.student_id === st.id)
      next[st.id] = { obtained: m?.obtained != null ? String(Number(m.obtained)) : '', absent: m?.absent ?? false, feedback: m?.feedback ?? '' }
    }
    setRows(next)
    // Initialise once per assessment so edits aren't overwritten by parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id])

  const invalid = Object.values(rows).some((r) => r.obtained !== '' && (Number.isNaN(Number(r.obtained)) || Number(r.obtained) < 0 || Number(r.obtained) > Number(a.max_marks)))

  const save = async (andPublish: boolean) => {
    if (invalid) return setError(`Marks must be between 0 and ${Number(a.max_marks)}.`)
    setBusy(true)
    setError(null)
    const entries = Object.entries(rows).map(([student_id, r]) => ({ student_id, obtained: r.obtained === '' ? null : Number(r.obtained), absent: r.absent, feedback: r.feedback }))
    const { error: err } = await supabase.rpc('save_marks', { p_assessment: a.id, p_entries: entries, p_reason: reason.trim() || null })
    if (err) {
      setBusy(false)
      if (/CORRECTION_REASON_REQUIRED/.test(err.message)) return setAskReason(true)
      return setError(friendlyError(err))
    }
    if (andPublish) {
      const { data, error: pubErr } = await supabase.rpc('publish_assessment', { p_assessment: a.id })
      setBusy(false)
      if (pubErr) return setError(friendlyError(pubErr))
      toast.success(`Published. ${data} student${data === 1 ? '' : 's'} notified.`)
    } else {
      setBusy(false)
      toast.success('Marks saved.')
    }
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={a.title}
      subtitle={`Out of ${Number(a.max_marks)} · ${published ? 'published' : 'draft — students can’t see these yet'}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => save(false)} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Save
          </button>
          {!published && (
            <button type="button" className="btn-primary" onClick={() => save(true)} disabled={busy}>
              <Send className="size-4" aria-hidden="true" />
              Save &amp; publish
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <ErrorNote>{error}</ErrorNote>
        {(askReason || published) && (
          <TextArea label={askReason ? 'Reason for correcting published marks (required)' : 'Reason for any corrections'} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        )}
        <ul className="divide-y divide-line">
          {students.map((st) => {
            const r = rows[st.id] ?? { obtained: '', absent: false, feedback: '' }
            const bad = r.obtained !== '' && (Number(r.obtained) < 0 || Number(r.obtained) > Number(a.max_marks) || Number.isNaN(Number(r.obtained)))
            return (
              <li key={st.id} className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_96px_auto_minmax(0,1.4fr)] sm:items-center">
                <span className="truncate font-medium">{st.display_name}</span>
                <input
                  className="input h-10"
                  inputMode="decimal"
                  value={r.obtained}
                  disabled={r.absent}
                  aria-invalid={bad || undefined}
                  aria-label={`Marks for ${st.display_name}`}
                  placeholder={`/ ${Number(a.max_marks)}`}
                  onChange={(e) => setRows({ ...rows, [st.id]: { ...r, obtained: e.target.value } })}
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={r.absent} onChange={(e) => setRows({ ...rows, [st.id]: { ...r, absent: e.target.checked, obtained: e.target.checked ? '' : r.obtained } })} />
                  Absent
                </label>
                <input className="input h-10" value={r.feedback} maxLength={2000} placeholder="Feedback (optional)" aria-label={`Feedback for ${st.display_name}`} onChange={(e) => setRows({ ...rows, [st.id]: { ...r, feedback: e.target.value } })} />
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
