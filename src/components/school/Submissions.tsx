import { CheckCircle2, ExternalLink, FileText, Lock, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { callFunction } from '../../lib/functions'
import { formatDateTime, type Assignment, type Membership } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { toast } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { ErrorNote, List, Loading, Pill, Row, TextArea } from './ui'

export type SubmissionStatus = 'not_submitted' | 'submitted' | 'under_review' | 'accepted' | 'resubmission_requested' | 'rejected'

export interface Submission {
  id: string
  assignment_id: string
  student_id: string
  status: SubmissionStatus
  attempt: number
  first_submitted_at: string | null
  last_submitted_at: string | null
  is_late: boolean
  reviewed_at: string | null
  feedback: string | null
}

interface SubmissionFile {
  id: string
  submission_id: string
  attempt: number
  file_name: string
  mime_type: string
  size_bytes: number
  uploaded_at: string
  deleted_at: string | null
  deletion_reason: string | null
}

interface Review {
  id: string
  submission_id: string
  status: SubmissionStatus
  comment: string | null
  attempt: number
  created_at: string
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  not_submitted: 'Not submitted',
  submitted: 'Submitted',
  under_review: 'Under review',
  accepted: 'Accepted',
  resubmission_requested: 'Resubmission requested',
  rejected: 'Not accepted',
}

export const STATUS_TONE: Record<SubmissionStatus, 'muted' | 'brand' | 'success' | 'danger' | 'warning'> = {
  not_submitted: 'muted',
  submitted: 'brand',
  under_review: 'brand',
  accepted: 'success',
  resubmission_requested: 'warning',
  rejected: 'danger',
}

const MAX_BYTES = 4 * 1024 * 1024
const EXT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' } as const
const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

async function openFile(id: string) {
  // Open the tab first so pop-up blockers allow it, then point it at the signed URL.
  const tab = window.open('', '_blank')
  try {
    const { url } = await callFunction<{ url: string }>('homework', { action: 'url', file_id: id })
    if (tab) tab.location.href = url
    else window.location.href = url
  } catch (e) {
    tab?.close()
    toast.error((e as Error).message)
  }
}

function FileList({ files, removable, onRemoved }: { files: SubmissionFile[]; removable?: boolean; onRemoved?: () => void }) {
  const remove = async (id: string) => {
    try {
      await callFunction('homework', { action: 'remove', file_id: id })
      onRemoved?.()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  if (files.length === 0) return null
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 text-sm">
          <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
          {f.deleted_at ? (
            <span className="min-w-0 flex-1 truncate text-muted line-through" title="Deleted after the review period">
              {f.file_name}
            </span>
          ) : (
            <button type="button" className="min-w-0 flex-1 truncate text-left text-brand hover:underline" onClick={() => openFile(f.id)}>
              {f.file_name}
              <ExternalLink className="ml-1 inline size-3" aria-hidden="true" />
            </button>
          )}
          <span className="shrink-0 text-xs text-muted">
            {size(f.size_bytes)}
            {f.attempt > 1 && ` · attempt ${f.attempt}`}
          </span>
          {removable && !f.deleted_at && (
            <button type="button" className="icon-btn size-8" onClick={() => remove(f.id)} aria-label={`Remove ${f.file_name}`}>
              <Trash2 className="size-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The student's side of one assignment: status, files, upload, teacher feedback. */
export function StudentSubmission({ assignment }: { assignment: Assignment }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data, reload } = useLoad(async () => {
    const sub = unwrap(await supabase.from('submissions').select('*').eq('assignment_id', assignment.id).maybeSingle()) as Submission | null
    if (!sub) return { sub: null, files: [] as SubmissionFile[], reviews: [] as Review[] }
    const [files, reviews] = await Promise.all([
      supabase.from('submission_files').select('id, submission_id, attempt, file_name, mime_type, size_bytes, uploaded_at, deleted_at, deletion_reason').eq('submission_id', sub.id).order('uploaded_at'),
      supabase.from('submission_reviews').select('*').eq('submission_id', sub.id).order('created_at', { ascending: false }),
    ])
    return { sub, files: unwrap(files) as SubmissionFile[], reviews: unwrap(reviews) as Review[] }
  }, [assignment.id])

  const sub = data?.sub
  const status: SubmissionStatus = sub?.status ?? 'not_submitted'
  const now = Date.now()
  const opens = new Date(assignment.opens_at).getTime()
  const closedLate = now > new Date(assignment.due_at).getTime() && assignment.late_policy === 'reject'
  const canUpload = assignment.status === 'published' && now >= opens && !closedLate && ['not_submitted', 'submitted', 'resubmission_requested'].includes(status)
  const accept = assignment.allowed_types.map((t) => (t === 'jpg' ? '.jpg,.jpeg' : `.${t}`)).join(',')

  const upload = async (list: FileList | null) => {
    setError(null)
    const file = list?.[0]
    if (input.current) input.current.value = ''
    if (!file) return
    const ext = file.name.toLowerCase().split('.').pop()?.replace('jpeg', 'jpg') as keyof typeof EXT_MIME | undefined
    if (!ext || !(ext in EXT_MIME) || !assignment.allowed_types.includes(ext)) {
      return setError(`Choose a ${assignment.allowed_types.map((t) => t.toUpperCase()).join(', ')} file.`)
    }
    if (file.size > MAX_BYTES) return setError('That file is larger than 4 MB. Compress it or split it into parts.')
    if (file.size === 0) return setError('That file is empty.')
    const form = new FormData()
    form.append('action', 'upload')
    form.append('assignment_id', assignment.id)
    form.append('file', file, file.name)
    setBusy(true)
    try {
      const r = await callFunction<{ late: boolean }>('homework', form)
      toast.success(r.late ? 'Submitted (after the deadline — marked late).' : 'Submitted. Your teacher will review it.')
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Files the student removed themselves aren't shown; files deleted after the review period are, struck through.
  const currentFiles = (data?.files ?? []).filter((f) => f.deletion_reason !== 'removed by student')

  if (!data) {
    return (
      <div className="mt-3 flex justify-center rounded-xl bg-subtle/60 p-4 text-muted">
        <Spinner className="size-4" />
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl bg-subtle/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
        {sub?.is_late && <Pill tone="warning">Late</Pill>}
        {sub?.last_submitted_at && <span className="text-xs text-muted">Last upload {formatDateTime(sub.last_submitted_at)}</span>}
      </div>
      {sub?.feedback && status !== 'submitted' && (
        <p className="rounded-lg bg-surface p-2.5 text-sm">
          <span className="font-medium">Teacher’s feedback: </span>
          {sub.feedback}
        </p>
      )}
      <FileList files={currentFiles} removable={status === 'submitted'} onRemoved={reload} />
      <ErrorNote>{error}</ErrorNote>
      {canUpload ? (
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept={accept} className="sr-only" id={`file-${assignment.id}`} onChange={(e) => upload(e.target.files)} disabled={busy} />
          <label htmlFor={`file-${assignment.id}`} className={`btn-secondary cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            {busy ? <Spinner className="size-4" /> : <Upload className="size-4" aria-hidden="true" />}
            {status === 'resubmission_requested' ? 'Upload new version' : status === 'submitted' ? 'Add another file' : 'Upload work'}
          </label>
          <span className="text-xs text-muted">{assignment.allowed_types.map((t) => t.toUpperCase()).join(', ')} · up to 4 MB · max 5 files</span>
        </div>
      ) : (
        status === 'not_submitted' && (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Lock className="size-4" aria-hidden="true" />
            {now < opens ? `Submissions open ${formatDateTime(assignment.opens_at)}.` : closedLate ? 'The deadline has passed.' : 'Submissions are closed.'}
          </p>
        )
      )}
      <p className="text-xs text-muted">Teacher-set work is completed when your teacher accepts it — it can’t be ticked off by hand.</p>
    </div>
  )
}

/** Teacher view: every enrolled student's submission for one assignment, with review actions. */
export function SubmissionsModal({ assignment, students, canHold, onClose }: { assignment: Assignment; students: Membership[]; canHold: boolean; onClose: () => void }) {
  const { data, loading, error, reload } = useLoad(async () => {
    const subs = unwrap(await supabase.from('submissions').select('*').eq('assignment_id', assignment.id)) as Submission[]
    const ids = subs.map((s) => s.id)
    const files = ids.length
      ? (unwrap(await supabase.from('submission_files').select('id, submission_id, attempt, file_name, mime_type, size_bytes, uploaded_at, deleted_at, deletion_reason').in('submission_id', ids).order('uploaded_at')) as SubmissionFile[])
      : []
    return { subs, files }
  }, [assignment.id])
  const [reviewing, setReviewing] = useState<Submission | null>(null)
  const [hold, setHold] = useState(false)

  const rows = students
    .map((m) => ({ m, sub: data?.subs.find((s) => s.student_id === m.id) ?? null }))
    .sort((a, b) => a.m.display_name.localeCompare(b.m.display_name))
  const submitted = rows.filter((r) => r.sub && r.sub.status !== 'not_submitted').length

  return (
    <Modal open onClose={onClose} size="lg" title={assignment.title} subtitle={`${submitted} of ${students.length} submitted · due ${formatDateTime(assignment.due_at)}`}>
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <ErrorNote>{error}</ErrorNote>
          {canHold && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm">
              <span className="flex-1">
                {assignment.retention_hold ? (
                  <>
                    <strong>Retention hold:</strong> files are kept past the {assignment.review_retention_days}-day interval ({assignment.retention_hold_reason}).
                  </>
                ) : (
                  <>Files are deleted {assignment.review_retention_days} days after the deadline (or the last upload).</>
                )}
              </span>
              <button type="button" className="btn-ghost h-9 px-3" onClick={() => setHold(true)}>
                {assignment.retention_hold ? 'Release hold' : 'Place hold'}
              </button>
            </div>
          )}
          <List empty="No students are enrolled in this class.">
            {rows.map(({ m, sub }) => (
              <Row key={m.id} className="items-start sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{m.display_name}</p>
                  {sub?.last_submitted_at && (
                    <p className="text-xs text-muted">
                      Submitted {formatDateTime(sub.last_submitted_at)}
                      {sub.attempt > 1 && ` · attempt ${sub.attempt}`}
                    </p>
                  )}
                  <div className="mt-1">
                    <FileList files={(data?.files ?? []).filter((f) => f.submission_id === sub?.id && f.deletion_reason !== 'removed by student')} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={STATUS_TONE[sub?.status ?? 'not_submitted']}>{STATUS_LABEL[sub?.status ?? 'not_submitted']}</Pill>
                  {sub?.is_late && <Pill tone="warning">Late</Pill>}
                  {sub && sub.status !== 'not_submitted' && (
                    <button type="button" className="btn-secondary h-9 px-3" onClick={() => setReviewing(sub)}>
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Review
                    </button>
                  )}
                </div>
              </Row>
            ))}
          </List>
        </div>
      )}
      {reviewing && <ReviewModal sub={reviewing} name={students.find((s) => s.id === reviewing.student_id)?.display_name ?? ''} onClose={() => (setReviewing(null), reload())} />}
      {hold && <HoldModal assignment={assignment} onClose={() => (setHold(false), onClose())} />}
    </Modal>
  )
}

function ReviewModal({ sub, name, onClose }: { sub: Submission; name: string; onClose: () => void }) {
  const [comment, setComment] = useState(sub.feedback ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const decide = async (status: SubmissionStatus) => {
    setBusy(status)
    setError(null)
    const { error: err } = await supabase.rpc('review_submission', { p_submission: sub.id, p_status: status, p_comment: comment.trim() || null })
    setBusy(null)
    if (err) return setError(friendlyError(err))
    toast.success(`Marked as ${STATUS_LABEL[status].toLowerCase()}.`)
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={`Review: ${name}`} subtitle={`Attempt ${sub.attempt}${sub.is_late ? ' · submitted late' : ''}`}>
      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <TextArea label="Feedback for the student" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} hint="Required when asking for a resubmission or not accepting the work." />
        <div className="flex flex-wrap gap-2">
          {(['accepted', 'resubmission_requested', 'under_review', 'rejected'] as SubmissionStatus[]).map((s) => (
            <button key={s} type="button" className={s === 'accepted' ? 'btn-primary' : s === 'rejected' ? 'btn-ghost text-danger' : 'btn-secondary'} onClick={() => decide(s)} disabled={!!busy}>
              {busy === s && <Spinner className="size-4" />}
              {s === 'accepted' ? 'Accept' : s === 'resubmission_requested' ? 'Request resubmission' : s === 'under_review' ? 'Mark under review' : 'Don’t accept'}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function HoldModal({ assignment, onClose }: { assignment: Assignment; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const { error: err } = await supabase.rpc('set_retention_hold', { p_assignment: assignment.id, p_hold: !assignment.retention_hold, p_reason: reason })
    if (err) return setError(friendlyError(err))
    toast.success(assignment.retention_hold ? 'Hold released.' : 'Files will be kept until the hold is released.')
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={assignment.retention_hold ? 'Release retention hold' : 'Keep these files longer'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save}>
            {assignment.retention_hold ? 'Release' : 'Place hold'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {assignment.retention_hold
            ? 'Files become eligible for deletion again under the normal interval.'
            : 'Use only when policy requires keeping the files (for example an open appeal). The reason is kept in the audit history.'}
        </p>
        <ErrorNote>{error}</ErrorNote>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  )
}
