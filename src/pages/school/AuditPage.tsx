import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useStructure } from '../../components/school/data'
import { ErrorNote, Loading, PageHeader, Panel, Pill, SelectField } from '../../components/school/ui'
import { formatDateTime, type AuditEntry } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'

const TYPE_LABEL: Record<string, string> = {
  institutions: 'Institution',
  institution_memberships: 'Membership',
  institution_invitations: 'Invitation',
  institution_email_allowlist: 'Approved emails',
  institution_role_permissions: 'Permissions',
  academic_years: 'Academic year',
  terms: 'Term',
  subjects: 'Subject',
  classes: 'Class',
  class_enrollments: 'Enrolment',
  teaching_assignments: 'Subject teacher',
  coordinator_scopes: 'Coordinator scope',
  calendar_events: 'Calendar event',
  assignments: 'Assignment',
  deadline_change_requests: 'Deadline change',
}

const PAGE = 50

/** Read-only, append-only history of changes in this institution. */
export default function AuditPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const [type, setType] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<number | null>(null)
  const { data: s } = useStructure(inst.institution_id)
  const { data, error, loading } = useLoad(async () => {
    let q = supabase.from('audit_log').select('*').eq('institution_id', inst.institution_id).order('created_at', { ascending: false }).limit(limit)
    if (type) q = q.eq('record_type', type)
    return unwrap(await q) as AuditEntry[]
  }, [inst.institution_id, type, limit])

  const actor = (id: string | null) => (id ? s?.members.find((m) => m.user_id === id)?.display_name ?? 'Another user' : 'System')

  return (
    <div className="space-y-5">
      <PageHeader title="Audit history" description="Every change to people, classes, the calendar, assignments and settings. Entries can’t be edited or deleted." />
      <div className="sm:w-64">
        <SelectField label="Record type" value={type} onChange={(e) => (setType(e.target.value), setLimit(PAGE))}>
          <option value="">All</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading && !data ? (
        <Loading />
      ) : (
        <Panel>
          {data?.length === 0 && <p className="py-6 text-center text-sm text-muted">No history yet.</p>}
          <ul className="divide-y divide-line">
            {(data ?? []).map((e) => (
              <li key={e.id}>
                <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-3 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span className="w-40 shrink-0 text-sm text-muted">{formatDateTime(e.created_at)}</span>
                  <Pill tone={e.action === 'delete' ? 'danger' : e.action === 'insert' ? 'success' : 'brand'}>{e.action === 'insert' ? 'created' : e.action === 'delete' ? 'deleted' : 'changed'}</Pill>
                  <span className="text-sm font-medium">{TYPE_LABEL[e.record_type] ?? e.record_type}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">
                    by {actor(e.actor_id)}
                    {e.reason && ` · “${e.reason}”`}
                  </span>
                  <ChevronDown className={`size-4 text-muted transition-transform ${open === e.id ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {open === e.id && (
                  <div className="mb-3 grid gap-2 sm:grid-cols-2">
                    <Diff title="Before" value={e.old_value} />
                    <Diff title="After" value={e.new_value} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {data && data.length === limit && (
            <button type="button" className="btn-secondary mt-3 w-full" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          )}
        </Panel>
      )}
    </div>
  )
}

function Diff({ title, value }: { title: string; value: Record<string, unknown> | null }) {
  return (
    <div className="min-w-0 rounded-xl bg-subtle p-3">
      <p className="mb-1 text-xs font-semibold text-muted">{title}</p>
      {value ? (
        <dl className="space-y-0.5 text-xs">
          {Object.entries(value).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 text-muted">{k}</dt>
              <dd className="min-w-0 break-words">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted">—</p>
      )}
    </div>
  )
}
