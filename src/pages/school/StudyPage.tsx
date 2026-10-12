import { useEffect, useMemo, useState } from 'react'
import { gradeSort, useStructure } from '../../components/school/data'
import { GUIDANCE_NOTE, MyStudyInsights, StudentInsightsModal } from '../../components/school/StudyInsights'
import { ErrorNote, Loading, PageHeader, Panel, Pill, SelectField } from '../../components/school/ui'
import { isStaff } from '../../lib/institution'
import { loadClassInsights, STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from '../../lib/studyInsights'
import { fmtMin } from '../../lib/timetableAi'
import { useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'

/** Students: their subjects and study plan. Staff: a class, limited to the subjects they may see. */
export default function StudyPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  if (inst.role === 'student') {
    return (
      <div>
        <PageHeader title="Study insights" description="How each subject is going, why, and a study plan that gives more time where it helps." />
        <MyStudyInsights studentId={inst.membership_id} institutionId={inst.institution_id} />
      </div>
    )
  }
  if (!isStaff(inst.role)) return <ErrorNote>Study insights are for students and their teachers.</ErrorNote>
  return <ClassStudyView />
}

function ClassStudyView() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const { data: s, error, loading } = useStructure(inst.institution_id)
  const classes = useMemo(
    () => (s?.classes ?? []).filter((c) => !c.archived).sort((a, b) => gradeSort(a.grade, b.grade) || a.name.localeCompare(b.name)),
    [s],
  )
  const [classId, setClassId] = useState('')
  const [onlyAttention, setOnlyAttention] = useState(true)
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    if (!classId && classes.length) setClassId((classes.find((c) => c.class_teacher_id === inst.membership_id) ?? classes[0]).id)
  }, [classes, classId, inst.membership_id])
  const rows = useLoad(async () => (classId ? loadClassInsights(classId) : []), [classId])

  if (loading && !s) return <Loading />
  if (error || !s) return <ErrorNote>{error}</ErrorNote>

  const list = (rows.data ?? [])
    .filter((r) => !onlyAttention || r.status === 'needs_attention')
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.subject.localeCompare(b.subject) || a.student.localeCompare(b.student))
  const subjects = new Set((rows.data ?? []).map((r) => r.subject))

  return (
    <div className="space-y-5">
      <PageHeader title="Study insights" description="Subjects where students may need support, with the reasons. You only see the subjects you teach (class teachers: their whole class)." />
      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
              {!classes.length && <option value="">No classes</option>}
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          </div>
          <label className="flex h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-brand" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
            Only “needs attention”
          </label>
        </div>
        {rows.error && <div className="mt-4"><ErrorNote>{rows.error}</ErrorNote></div>}
        {rows.loading && !rows.data ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            {subjects.size === 0 ? 'No subjects you teach in this class have data yet.' : onlyAttention ? 'No student needs extra attention in your subjects here.' : 'Nothing to show.'}
          </p>
        ) : (
          <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Student</th>
                  <th className="py-2 pr-3 font-medium">Subject</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Why</th>
                  <th className="py-2 pr-3 font-medium">Suggested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((r) => (
                  <tr key={`${r.student_id}-${r.subject_id}`}>
                    <td className="py-2 pr-3">
                      <button type="button" className="text-left font-medium text-brand hover:underline" onClick={() => setOpen({ id: r.student_id, name: r.student })}>
                        {r.student}
                      </button>
                      {r.roll_no && <span className="text-muted"> · {r.roll_no}</span>}
                    </td>
                    <td className="py-2 pr-3">{r.subject}</td>
                    <td className="py-2 pr-3"><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
                    <td className="py-2 pr-3 text-muted">{r.top_reason ?? '—'}</td>
                    <td className="py-2 pr-3 tabular-nums text-muted">{r.recommended_minutes > 0 ? `+${fmtMin(r.recommended_minutes)}/wk` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-muted">{GUIDANCE_NOTE} Students choose whether to change their own study plan; you never see their personal timetable here.</p>
      </Panel>
      {open && <StudentInsightsModal studentId={open.id} student={open.name} onClose={() => setOpen(null)} />}
    </div>
  )
}
