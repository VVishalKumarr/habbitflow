import { Megaphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { uniqueGrades, useStructure } from '../../components/school/data'
import { ErrorNote, Loading, PageHeader, Panel, Pill, SelectField, TextArea } from '../../components/school/ui'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { formatDateTime, isHead, isStaff } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'

type Audience = 'everyone' | 'staff' | 'students' | 'parents' | 'students_parents'
const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'Everyone',
  staff: 'Staff only',
  students: 'Students',
  parents: 'Parents',
  students_parents: 'Students and parents',
}

interface Announcement {
  id: string
  title: string
  body: string
  audience: Audience
  grade: string | null
  class_id: string | null
  author_name: string | null
  created_at: string
}

export default function AnnouncementsPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const list = useLoad(async () => unwrap(await supabase.from('announcements').select('*').eq('institution_id', inst.institution_id).order('created_at', { ascending: false }).limit(100)) as Announcement[], [inst.institution_id])
  const [posting, setPosting] = useState(false)
  const canPost = isStaff(inst.role) && inst.role !== 'subject_teacher'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Announcements"
        description="School news for the people it concerns. Everyone it’s addressed to also gets a notification."
        actions={
          canPost && (
            <button type="button" className="btn-primary" onClick={() => setPosting(true)}>
              <Megaphone className="size-4" aria-hidden="true" />
              New announcement
            </button>
          )
        }
      />
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <Loading />
      ) : (list.data ?? []).length === 0 ? (
        <div className="card">
          <EmptyState icon={Megaphone} title="No announcements" message="Announcements from your school appear here." />
        </div>
      ) : (
        <div className="space-y-3">
          {(list.data ?? []).map((a) => (
            <Panel key={a.id}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{a.title}</h2>
                {isStaff(inst.role) && <Pill>{AUDIENCE_LABEL[a.audience]}</Pill>}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {a.author_name ?? 'School'} · {formatDateTime(a.created_at)}
              </p>
              <p className="mt-2 text-sm whitespace-pre-line">{a.body}</p>
            </Panel>
          ))}
        </div>
      )}
      {posting && <PostModal onClose={() => (setPosting(false), list.reload())} />}
    </div>
  )
}

function PostModal({ onClose }: { onClose: () => void }) {
  const { current } = useCurrentInstitution()
  const inst = current!
  const { data: s } = useStructure(inst.institution_id)
  const head = isHead(inst.role)
  const myScopes = (s?.scopes ?? []).filter((x) => x.coordinator_id === inst.membership_id).map((x) => x.grade)
  const classes = (s?.classes ?? []).filter((c) => !c.archived && (head || inst.role === 'coordinator' || c.class_teacher_id === inst.membership_id))
  const grades = uniqueGrades(s?.classes ?? []).filter((g) => head || myScopes.includes('*') || myScopes.includes(g))
  const wholeSchool = head || myScopes.includes('*')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<Audience>('students_parents')
  const [target, setTarget] = useState(wholeSchool ? 'all' : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = target || (wholeSchool ? 'all' : classes[0] ? `class:${classes[0].id}` : '')

  const post = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return setError('Add a title and a message.')
    if (!chosen) return setError('Choose who the announcement is for.')
    setBusy(true)
    const { error: err } = await supabase.rpc('post_announcement', {
      p_inst: inst.institution_id,
      p_title: title.trim(),
      p_body: body.trim(),
      p_audience: audience,
      p_grade: chosen.startsWith('grade:') ? chosen.slice(6) : null,
      p_class: chosen.startsWith('class:') ? chosen.slice(6) : null,
    })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    toast.success('Announcement posted.')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New announcement"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="post-ann" className="btn-primary" disabled={busy || !s}>
            {busy && <Spinner className="size-4" />}
            Post
          </button>
        </>
      }
    >
      <form id="post-ann" onSubmit={post} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        <TextArea label="Message" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Who" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
            {(Object.keys(AUDIENCE_LABEL) as Audience[])
              .filter((a) => a !== 'staff' || head)
              .map((a) => (
                <option key={a} value={a}>
                  {AUDIENCE_LABEL[a]}
                </option>
              ))}
          </SelectField>
          <SelectField label="Where" value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {wholeSchool && <option value="all">Whole institution</option>}
            {grades.map((g) => (
              <option key={g} value={`grade:${g}`}>
                Grade {g}
              </option>
            ))}
            {classes.map((c) => (
              <option key={c.id} value={`class:${c.id}`}>
                Class {c.name}
              </option>
            ))}
          </SelectField>
        </div>
      </form>
    </Modal>
  )
}
