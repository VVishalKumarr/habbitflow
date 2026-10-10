import { Download, FileUp, History, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { ErrorNote, List, PageHeader, Panel, Pill, Row, SelectField } from '../../components/school/ui'
import { Spinner } from '../../components/ui/Spinner'
import { downloadCsv, mapColumns, parseCsv } from '../../lib/csv'
import { friendlyError } from '../../lib/errors'
import { callFunction, FunctionError } from '../../lib/functions'
import { ROLE_LABEL, type MyInstitution } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

type Kind = 'students' | 'staff' | 'classes' | 'teaching'

const FIELDS: Record<Kind, Record<string, string[]>> = {
  students: { email: ['email', 'email address', 'e-mail'], name: ['name', 'full name', 'student name', 'student'], external_id: ['admission no', 'admission number', 'roll id', 'student id', 'id'], class: ['class', 'class name', 'section'] },
  staff: { email: ['email', 'email address', 'e-mail'], name: ['name', 'full name', 'teacher', 'staff name'], external_id: ['staff no', 'staff number', 'employee id', 'id'] },
  classes: { name: ['name', 'class', 'class name'], grade: ['grade', 'standard', 'year'], section: ['section', 'division'], class_teacher: ['class teacher', 'class teacher email', 'teacher'] },
  teaching: { class: ['class', 'class name'], subject: ['subject'], teacher: ['teacher', 'teacher email', 'staff no', 'email'] },
}
const REQUIRED: Record<Kind, string[]> = { students: ['email', 'name'], staff: ['email', 'name'], classes: ['name', 'grade'], teaching: ['class', 'subject', 'teacher'] }
const TEMPLATES: Record<Kind, { header: string[]; example: string[] }> = {
  students: { header: ['Name', 'Email', 'Admission no', 'Class'], example: ['Asha Verma', 'asha.verma@yourschool.edu', 'A-1042', '10 A'] },
  staff: { header: ['Name', 'Email', 'Staff no'], example: ['Ravi Kumar', 'ravi.kumar@yourschool.edu', 'T-207'] },
  classes: { header: ['Name', 'Grade', 'Section', 'Class teacher'], example: ['10 A', '10', 'A', 'ravi.kumar@yourschool.edu'] },
  teaching: { header: ['Class', 'Subject', 'Teacher'], example: ['10 A', 'Mathematics', 'ravi.kumar@yourschool.edu'] },
}
const TABS: { kind: Kind; label: string }[] = [
  { kind: 'students', label: 'Students' },
  { kind: 'staff', label: 'Teachers & staff' },
  { kind: 'classes', label: 'Classes' },
  { kind: 'teaching', label: 'Subject teachers' },
]
const STAFF_ROLES = ['subject_teacher', 'class_teacher', 'coordinator'] as const

interface RowResult {
  row: number
  status: 'ok' | 'skip' | 'error' | 'done'
  action?: string
  messages: string[]
  activation_link?: string
}
interface Parsed {
  file: string
  records: { [field: string]: string | number; row: number }[]
  unknown: string[]
  ignoredRole: boolean
}

const STATUS = { ok: ['Ready', 'brand'], done: ['Done', 'success'], skip: ['Skipped', 'muted'], error: ['Error', 'danger'] } as const

export default function ImportPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const [kind, setKind] = useState<Kind>('students')
  const [imports, setImports] = useState(0)
  return (
    <div className="space-y-5">
      <PageHeader title="Import from CSV" description="Add many students, staff, classes or subject teachers at once. Check the preview first — nothing changes until you choose Import." />
      <div role="tablist" aria-label="What to import" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.kind} role="tab" type="button" aria-selected={kind === t.kind} onClick={() => setKind(t.kind)}
            className={`min-h-9 rounded-full border px-3.5 text-sm font-medium ${kind === t.kind ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-subtle'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <Importer key={kind} kind={kind} inst={inst} onImported={() => setImports((n) => n + 1)} />
      <PastImports inst={inst.institution_id} version={imports} />
    </div>
  )
}

function Importer({ kind, inst, onImported }: { kind: Kind; inst: MyInstitution; onImported: () => void }) {
  const [role, setRole] = useState<(typeof STAFF_ROLES)[number]>('subject_teacher')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [preview, setPreview] = useState<RowResult[] | null>(null)
  const [results, setResults] = useState<RowResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const people = kind === 'students' || kind === 'staff'
  const roleFor = kind === 'students' ? 'student' : role

  const reset = () => {
    setParsed(null)
    setPreview(null)
    setResults(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const check = async (p: Parsed, r = roleFor) => {
    setBusy('preview')
    setError(null)
    setResults(null)
    try {
      const rows = p.records.map(({ row: _row, ...rest }) => rest)
      let res: RowResult[]
      if (people) res = unwrap(await supabase.rpc('import_check_people', { p_inst: inst.institution_id, p_role: r, p_rows: rows })) as RowResult[]
      else res = unwrap(await supabase.rpc(kind === 'classes' ? 'import_classes' : 'import_teaching', { p_inst: inst.institution_id, p_rows: rows, p_commit: false })) as RowResult[]
      // server rows are 1-based positions; show the file's line numbers
      setPreview(res.map((x, i) => ({ ...x, row: p.records[i].row })))
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    reset()
    if (f.size > 2_000_000) return setError('The file is larger than 2 MB. Split it into smaller files.')
    const rows = parseCsv(await f.text())
    if (rows.length < 2) return setError('The file needs a header row and at least one data row.')
    const { records, found, unknown } = mapColumns(rows, FIELDS[kind] as Record<string, string[]>)
    const missing = REQUIRED[kind].filter((k) => !found.includes(k))
    if (missing.length) return setError(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download the template to see the expected columns.`)
    const ignoredRole = people && unknown.some((h) => /^role$/i.test(h.trim()))
    const p: Parsed = { file: f.name, records: records.map((r, i) => ({ ...r, row: i + 2 })), unknown: unknown.filter((h) => !/^role$/i.test(h.trim())), ignoredRole }
    if (p.records.length > (kind === 'classes' ? 500 : 2000)) return setError(`Too many rows (${p.records.length}). Split the file.`)
    setParsed(p)
    check(p)
  }

  const commit = async () => {
    if (!parsed || !preview) return
    setBusy('import')
    setError(null)
    try {
      if (people) {
        const ready = parsed.records.filter((_, i) => preview[i].status === 'ok')
        const out: RowResult[] = preview.filter((x) => x.status !== 'ok').map((x) => ({ ...x }))
        for (let i = 0; i < ready.length; i += 50) {
          const batch = ready.slice(i, i + 50)
          const r = await callFunction<{ results: RowResult[] }>('institution-invite', {
            action: 'bulk_import', institution_id: inst.institution_id, role: roleFor, file_name: parsed.file, first_row: batch[0].row, rows: batch,
          })
          out.push(...r.results)
        }
        setResults(out.sort((a, b) => a.row - b.row))
      } else {
        const rows = parsed.records.map(({ row: _row, ...rest }) => rest)
        const res = unwrap(await supabase.rpc(kind === 'classes' ? 'import_classes' : 'import_teaching', { p_inst: inst.institution_id, p_rows: rows, p_commit: true, p_file: parsed.file })) as RowResult[]
        setResults(res.map((x, i) => ({ ...x, row: parsed.records[i].row })))
      }
      toast.success('Import finished.')
      onImported()
    } catch (e) {
      setError(e instanceof FunctionError ? e.message : friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  const shown = results ?? preview
  const counts = (shown ?? []).reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>)
  const ready = preview?.filter((r) => r.status === 'ok').length ?? 0
  const links = results?.filter((r) => r.activation_link) ?? []

  return (
    <Panel
      title={TABS.find((t) => t.kind === kind)!.label}
      description={{
        students: 'Each student gets an activation email (their address must be on the approved list). With a Class column they’re enrolled when they activate; students who already have an account are just enrolled.',
        staff: 'Choose the role for everyone in the file — a role column in the file is ignored. Assign classes and subjects after they join (or with the Subject teachers import).',
        classes: 'Creates classes in the current academic year. Classes that already exist are skipped. Class teacher: their email or staff number.',
        teaching: 'Assigns teachers to subjects in classes. Subjects that don’t exist yet are created. Teacher: email or staff number.',
      }[kind]}
      actions={
        <button type="button" className="btn-secondary" onClick={() => downloadCsv(`template-${kind}.csv`, TEMPLATES[kind].header, [TEMPLATES[kind].example])}>
          <Download className="size-4" aria-hidden="true" /> Template
        </button>
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {kind === 'staff' && (
          <div className="sm:w-56">
            <SelectField label="Role for everyone in the file" value={role} onChange={(e) => { const r = e.target.value as typeof role; setRole(r); if (parsed) check(parsed, r) }}>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </SelectField>
          </div>
        )}
        <label className="btn-secondary cursor-pointer">
          <FileUp className="size-4" aria-hidden="true" />
          Choose CSV file
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} aria-label="CSV file" />
        </label>
        {parsed && <span className="text-sm text-muted">{parsed.file} · {parsed.records.length} rows</span>}
      </div>

      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      {parsed?.ignoredRole && <p className="mt-3 text-sm text-muted">The file’s Role column is ignored — everyone is imported as {ROLE_LABEL[roleFor as keyof typeof ROLE_LABEL]}.</p>}
      {parsed && parsed.unknown.length > 0 && <p className="mt-2 text-sm text-muted">Ignored columns: {parsed.unknown.join(', ')}</p>}
      {busy === 'preview' && <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status"><Spinner className="size-4" /> Checking every row…</p>}

      {shown && (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Summary">
            <span className="text-sm font-medium">{results ? 'Result:' : 'Preview:'}</span>
            {(['ok', 'done', 'skip', 'error'] as const).filter((k) => counts[k]).map((k) => (
              <Pill key={k} tone={STATUS[k][1]}>{counts[k]} {STATUS[k][0].toLowerCase()}</Pill>
            ))}
          </div>
          <div className="-mx-4 max-h-[28rem] overflow-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Line</th>
                  <th className="py-2 pr-3 font-medium">{people ? 'Person' : kind === 'classes' ? 'Class' : 'Assignment'}</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((r) => {
                  const rec = parsed?.records.find((x) => x.row === r.row)
                  const label = rec ? (people ? `${rec.name} <${rec.email}>` : kind === 'classes' ? `${rec.name} (grade ${rec.grade})` : `${rec.class} · ${rec.subject} · ${rec.teacher}`) : ''
                  return (
                    <tr key={r.row}>
                      <td className="py-2 pr-3 tabular-nums text-muted">{r.row}</td>
                      <td className="py-2 pr-3 break-all">{label}</td>
                      <td className="py-2 pr-3"><Pill tone={STATUS[r.status][1]}>{r.status === 'done' && r.action === 'enrolled' ? 'Enrolled' : r.status === 'done' && r.action === 'invited' ? 'Invited' : STATUS[r.status][0]}</Pill></td>
                      <td className="py-2 text-muted">{r.messages?.join(' ') || (r.status === 'ok' ? (r.action === 'enrol' ? 'Will be enrolled.' : people ? 'Will be invited.' : 'Will be created.') : '')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!results && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={commit} disabled={!ready || !!busy}>
                {busy === 'import' ? <Spinner className="size-4" /> : <Upload className="size-4" aria-hidden="true" />}
                Import {ready} row{ready === 1 ? '' : 's'}
              </button>
              <button type="button" className="btn-secondary" onClick={reset} disabled={!!busy}>Cancel</button>
              {counts.error > 0 && <p className="self-center text-sm text-muted">Rows with errors are left out — fix them and import the file again.</p>}
            </div>
          )}
          {results && (
            <div className="flex flex-wrap gap-2">
              {links.length > 0 && (
                <button type="button" className="btn-primary"
                  onClick={() => downloadCsv(`activation-links-${kind}.csv`, ['Line', 'Name', 'Email', 'Activation link'], links.map((l) => {
                    const rec = parsed?.records.find((x) => x.row === l.row)
                    return [l.row, rec?.name, rec?.email, l.activation_link]
                  }))}>
                  <Download className="size-4" aria-hidden="true" /> Activation links ({links.length})
                </button>
              )}
              <button type="button" className="btn-secondary" onClick={reset}>Import another file</button>
              {links.length > 0 && <p className="w-full text-sm text-muted">Email isn’t set up, so give each person their own link privately. Links work once and expire in 7 days.</p>}
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

function PastImports({ inst, version }: { inst: string; version: number }) {
  const { data } = useLoad(
    async () => unwrap(await supabase.from('import_runs').select('id, kind, file_name, total, created, skipped, failed, created_at').eq('institution_id', inst).order('created_at', { ascending: false }).limit(10)) as {
      id: string; kind: string; file_name: string | null; total: number; created: number; skipped: number; failed: number; created_at: string
    }[],
    [inst, version],
  )
  if (!data?.length) return null
  return (
    <Panel title="Recent imports" actions={<History className="size-4 text-muted" aria-hidden="true" />}>
      <List>
        {data.map((r) => (
          <Row key={r.id} className="py-2">
            <span className="flex-1 text-sm break-all">{r.file_name ?? r.kind} <span className="text-muted">· {new Date(r.created_at).toLocaleString()}</span></span>
            <span className="text-sm text-muted">{r.created} added · {r.skipped} skipped · {r.failed} errors</span>
          </Row>
        ))}
      </List>
    </Panel>
  )
}
