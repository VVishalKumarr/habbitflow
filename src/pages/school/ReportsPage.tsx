import { Download, FileDown, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { StudentReportModal } from '../../components/school/Development'
import { gradeSort, useStructure } from '../../components/school/data'
import { ErrorNote, Loading, PageHeader, Panel, Pill, SelectField } from '../../components/school/ui'
import { Spinner } from '../../components/ui/Spinner'
import { downloadCsv } from '../../lib/csv'
import { addDays, todayISO } from '../../lib/dates'
import { COMPONENT_LABEL, COMPONENTS, componentPct } from '../../lib/development'
import { friendlyError } from '../../lib/errors'
import { classReportPdf, type ClassReport } from '../../lib/reportPdf'
import { supabase } from '../../lib/supabase'
import { unwrap } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) * 100)}%`)

type Dataset = 'attendance' | 'marks' | 'assignments' | 'development' | 'class_report'
const DATASETS: { value: Dataset; label: string; dated: boolean }[] = [
  { value: 'attendance', label: 'Attendance records', dated: true },
  { value: 'marks', label: 'Marks (all assessments)', dated: true },
  { value: 'assignments', label: 'Assignments and hand-in rates', dated: true },
  { value: 'development', label: 'Development scores (latest)', dated: false },
  { value: 'class_report', label: 'Class report (one class)', dated: false },
]

export default function ReportsPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const { data: s, error, loading } = useStructure(inst.institution_id)
  const classes = (s?.classes ?? []).filter((c) => !c.archived).sort((a, b) => gradeSort(a.grade, b.grade) || a.name.localeCompare(b.name))
  const [classId, setClassId] = useState('')
  const [report, setReport] = useState<ClassReport | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openStudent, setOpenStudent] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    // start with the class I'm class teacher of, else the first one I can see
    if (!classId && classes.length) setClassId((classes.find((c) => c.class_teacher_id === inst.membership_id) ?? classes[0]).id)
  }, [classes, classId, inst.membership_id])

  const loadReport = async (id = classId) => {
    if (!id) return
    setReportError(null)
    try {
      setReport(unwrap(await supabase.rpc('class_report', { p_class: id })) as ClassReport)
    } catch (e) {
      setReport(null)
      setReportError(friendlyError(e))
    }
  }
  useEffect(() => {
    if (classId && can('view_reports')) loadReport(classId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId])

  const calculateAll = async () => {
    setBusy(true)
    try {
      const n = unwrap(await supabase.rpc('calculate_class_development', { p_class: classId })) as number
      toast.success(`Calculated ${n} student${n === 1 ? '' : 's'}.`)
      await loadReport()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading && !s) return <Loading />
  if (error || !s) return <ErrorNote>{error}</ErrorNote>
  const className = classes.find((c) => c.id === classId)?.name

  return (
    <div className="space-y-5">
      <PageHeader title="Reports" description="Development scores (1–10), class reports and data exports for the classes you can see." />

      {can('view_reports') && (
        <Panel
          title="Class report"
          description="Latest development score per student and its parts (last 90 days). Scores are recalculated weekly; you can also calculate them now. The PDF and CSV add attendance and hand-in rates."
          actions={
            report && (
              <>
                <button type="button" className="btn-secondary" onClick={calculateAll} disabled={busy}>
                  {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                  Calculate scores
                </button>
                <button type="button" className="btn-secondary" onClick={() => classReportPdf(report, inst.name).catch((e) => toast.error(friendlyError(e)))}>
                  <FileDown className="size-4" aria-hidden="true" />
                  PDF
                </button>
              </>
            )
          }
        >
          <div className="mb-4 max-w-xs">
            <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
              {classes.length === 0 && <option value="">No classes</option>}
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          </div>
          {reportError && <ErrorNote>{reportError}</ErrorNote>}
          {report && (report.students.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No students in this class.</p>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-medium">Student</th>
                    <th className="py-2 pr-3 font-medium">Score</th>
                    {COMPONENTS.map((k) => <th key={k} className="py-2 pr-3 font-medium" title={COMPONENT_LABEL[k]}>{COMPONENT_LABEL[k].split(' ')[0]}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.students.map((st) => (
                    <tr key={st.student_id}>
                      <td className="py-2 pr-3">
                        <button type="button" className="text-left font-medium text-brand hover:underline" onClick={() => setOpenStudent({ id: st.student_id, name: st.name })}>
                          {st.name}
                        </button>
                        {st.roll_no && <span className="text-muted"> · {st.roll_no}</span>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {!st.latest ? <Pill>Not yet</Pill> : st.latest.score === null ? <Pill tone="warning">Too little data</Pill> : <span className="font-semibold">{Number(st.latest.score).toFixed(1)}</span>}
                      </td>
                      {COMPONENTS.map((k) => <td key={k} className="py-2 pr-3 tabular-nums text-muted">{componentPct(st.latest?.components?.[k])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </Panel>
      )}

      <ExportPanel inst={inst.institution_id} classes={classes} />

      {openStudent && (
        <StudentReportModal studentId={openStudent.id} student={openStudent.name} className={className} institution={inst.name} onClose={() => { setOpenStudent(null); loadReport() }} />
      )}
    </div>
  )
}

function ExportPanel({ inst, classes }: { inst: string; classes: { id: string; name: string }[] }) {
  const [dataset, setDataset] = useState<Dataset>('attendance')
  const [classId, setClassId] = useState('')
  const [from, setFrom] = useState(addDays(todayISO(), -30))
  const [to, setTo] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const ds = DATASETS.find((d) => d.value === dataset)!
  const needsClass = dataset === 'class_report'

  const run = async () => {
    if (needsClass && !classId) return toast.error('Choose a class for the class report.')
    if (ds.dated && (!from || !to || to < from)) return toast.error('Check the dates.')
    setBusy(true)
    try {
      const cls = classId || null
      const name = classes.find((c) => c.id === classId)?.name.replace(/[^\w-]+/g, '_') ?? 'all'
      let header: string[] = []
      let rows: unknown[][] = []
      if (dataset === 'attendance') {
        const d = unwrap(await supabase.rpc('export_attendance', { p_inst: inst, p_class: cls, p_from: from, p_to: to })) as Record<string, unknown>[]
        header = ['Date', 'Class', 'Subject', 'Period', 'Student', 'Admission no', 'Status', 'Note', 'Correction reason']
        rows = d.map((r) => [r.session_date, r.class, r.subject, r.period, r.student, r.admission_no, r.status, r.note, r.corrected])
      } else if (dataset === 'marks') {
        const d = unwrap(await supabase.rpc('export_marks', { p_inst: inst, p_class: cls, p_from: from, p_to: to })) as Record<string, unknown>[]
        header = ['Date', 'Class', 'Subject', 'Assessment', 'Type', 'Status', 'Max marks', 'Student', 'Admission no', 'Marks', 'Absent', 'Percentage', 'Grade', 'Feedback']
        rows = d.map((r) => [r.assessment_date, r.class, r.subject, r.assessment, r.kind, r.status, r.max_marks, r.student, r.admission_no, r.obtained, r.absent ? 'yes' : '', r.percentage, r.grade, r.feedback])
      } else if (dataset === 'assignments') {
        const d = unwrap(await supabase.rpc('export_assignments', { p_inst: inst, p_class: cls, p_from: from, p_to: to })) as Record<string, unknown>[]
        header = ['Class', 'Subject', 'Teacher', 'Title', 'Type', 'Status', 'Opens', 'Due', 'Students', 'Submitted', 'On time', 'Accepted', 'Missing']
        rows = d.map((r) => [r.class, r.subject, r.teacher, r.title, r.kind, r.status, r.opens_at, r.due_at, r.students, r.submitted, r.on_time, r.accepted, r.missing])
      } else if (dataset === 'development') {
        const d = unwrap(await supabase.rpc('export_development', { p_inst: inst, p_class: cls })) as Record<string, unknown>[]
        header = ['Class', 'Student', 'Admission no', 'Calculated', 'From', 'To', 'Score', 'Insufficient data', ...COMPONENTS.map((k) => `${COMPONENT_LABEL[k]} (0-1)`)]
        rows = d.map((r) => [r.class, r.student, r.admission_no, r.calculated_at, r.period_from, r.period_to, r.score, r.insufficient ? 'yes' : '', r.academic, r.homework, r.attendance, r.planning, r.extracurricular])
      } else {
        const r = unwrap(await supabase.rpc('class_report', { p_class: classId })) as ClassReport
        header = ['Roll no', 'Student', 'Admission no', 'Score', 'Attendance', 'Homework handed in', 'Marks %', ...COMPONENTS.map((k) => COMPONENT_LABEL[k])]
        rows = r.students.map((st) => [st.roll_no, st.name, st.external_id, st.latest?.score ?? '', pct(st.attendance_rate), pct(st.homework_rate), st.marks_pct ?? '', ...COMPONENTS.map((k) => componentPct(st.latest?.components?.[k]))])
      }
      await downloadCsv(`${dataset}-${name}${ds.dated ? `-${from}-to-${to}` : ''}.csv`, header, rows)
      await supabase.rpc('log_export', { p_inst: inst, p_kind: dataset, p_rows: rows.length, p_filters: { class: cls, from: ds.dated ? from : null, to: ds.dated ? to : null } })
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}.`)
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Export CSV" description="Opens in Excel, Google Sheets or Numbers. Only classes you can see are included. Exports are recorded in the audit history.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField label="Data" value={dataset} onChange={(e) => setDataset(e.target.value as Dataset)}>
          {DATASETS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </SelectField>
        <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
          {!needsClass && <option value="">All my classes</option>}
          {needsClass && <option value="">Choose…</option>}
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        {ds.dated && (
          <>
            <label className="text-sm">
              <span className="field-label">From</span>
              <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="field-label">To</span>
              <input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
      </div>
      <button type="button" className="btn-primary mt-4" onClick={run} disabled={busy}>
        {busy ? <Spinner className="size-4" /> : <Download className="size-4" aria-hidden="true" />}
        Download CSV
      </button>
    </Panel>
  )
}
