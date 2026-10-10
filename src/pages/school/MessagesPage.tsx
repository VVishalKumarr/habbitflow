import { CalendarClock, ChevronLeft, MessageSquarePlus, Send } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorNote, Loading, PageHeader, Panel, Pill, SelectField, TextArea } from '../../components/school/ui'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import { formatDateTime, ROLE_LABEL, toLocalInput, type InstRole } from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useAuth } from '../../store/auth'
import { useCurrentInstitution } from '../../store/institution'
import { toast } from '../../store/ui'
import { useStructure } from '../../components/school/data'

interface Conversation {
  id: string
  institution_id: string
  subject: string
  student: string
  counterpart: string | null
  counterpart_role: string | null
  i_am_guardian: boolean
  last_message_at: string
  last_body: string | null
  unread: boolean
}

interface Message {
  id: string
  sender_id: string | null
  kind: 'text' | 'meeting_request'
  body: string
  meeting_at: string | null
  meeting_status: 'proposed' | 'accepted' | 'declined' | null
  created_at: string
}

/** Parent–teacher messages. Each thread is visible only to its parent and staff member. */
export default function MessagesPage() {
  const { current } = useCurrentInstitution()
  const inst = current!
  const [params, setParams] = useSearchParams()
  const selected = params.get('c')
  const list = useLoad(async () => (unwrap(await supabase.rpc('my_conversations')) as Conversation[]).filter((c) => c.institution_id === inst.institution_id), [inst.institution_id])
  const [starting, setStarting] = useState(false)
  const conv = list.data?.find((c) => c.id === selected)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Messages"
        description="Between parents and their child’s teachers. Only the two people in a conversation can read it."
        actions={
          <button type="button" className="btn-primary" onClick={() => setStarting(true)}>
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            New message
          </button>
        }
      />
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <Loading />
      ) : (list.data ?? []).length === 0 ? (
        <div className="card">
          <EmptyState icon={MessageSquarePlus} title="No conversations yet" message={inst.role === 'parent' ? 'Message your child’s class teacher or subject teachers.' : 'Start a conversation with a student’s parent or guardian.'} />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Panel className={`p-2 sm:p-2 ${conv ? 'hidden lg:block' : ''}`}>
            <ul>
              {(list.data ?? []).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setParams({ c: c.id })}
                    className={`flex w-full flex-col items-start rounded-xl px-3 py-2.5 text-left ${c.id === selected ? 'bg-brand-soft' : 'hover:bg-subtle'}`}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{c.subject}</span>
                      {c.unread && <span className="size-2 rounded-full bg-brand" aria-label="Unread" />}
                    </span>
                    <span className="w-full truncate text-xs text-muted">
                      {c.counterpart} · about {c.student}
                    </span>
                    {c.last_body && <span className="w-full truncate text-sm text-muted">{c.last_body}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {conv ? (
            <Thread conv={conv} onBack={() => setParams({})} onChange={list.reload} />
          ) : (
            <Panel className="hidden lg:block">
              <p className="py-10 text-center text-sm text-muted">Choose a conversation.</p>
            </Panel>
          )}
        </div>
      )}
      {starting && <NewConversation onClose={() => setStarting(false)} onStarted={(id) => (list.reload(), setParams({ c: id }))} />}
    </div>
  )
}

function Thread({ conv, onBack, onChange }: { conv: Conversation; onBack: () => void; onChange: () => void }) {
  const me = useAuth((s) => s.session?.user.id)
  const { data, reload } = useLoad(async () => unwrap(await supabase.from('conversation_messages').select('*').eq('conversation_id', conv.id).order('created_at')) as Message[], [conv.id])
  const [body, setBody] = useState('')
  const [meeting, setMeeting] = useState(false)
  const [when, setWhen] = useState(toLocalInput(new Date(Date.now() + 2 * 86400000)))
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
    // Opening a thread marks its notifications read.
    supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('link', `/school/messages?c=${conv.id}`).is('read_at', null).then(() => onChange())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.length, conv.id])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    const { error } = await supabase.rpc('send_message', {
      p_conversation: conv.id,
      p_body: body.trim(),
      p_kind: meeting ? 'meeting_request' : 'text',
      p_meeting_at: meeting ? new Date(when).toISOString() : null,
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setBody('')
    setMeeting(false)
    reload()
  }
  const respond = async (id: string, accept: boolean) => {
    const { error } = await supabase.rpc('respond_meeting', { p_message: id, p_accept: accept })
    if (error) toast.error(friendlyError(error))
    reload()
  }

  return (
    <Panel className="flex min-h-[60vh] flex-col">
      <div className="mb-3 flex items-start gap-2 border-b border-line pb-3">
        <button type="button" className="icon-btn -ml-2 lg:hidden" onClick={onBack} aria-label="Back to conversations">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{conv.subject}</h2>
          <p className="truncate text-sm text-muted">
            With {conv.counterpart}
            {conv.counterpart_role && conv.counterpart_role !== 'parent' ? ` (${ROLE_LABEL[conv.counterpart_role as InstRole]})` : ' (parent/guardian)'} · about {conv.student}
          </p>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto">
        {(data ?? []).map((m) => {
          const mine = m.sender_id === me
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${mine ? 'bg-brand text-white' : 'bg-subtle'}`}>
                {m.kind === 'meeting_request' && (
                  <p className={`mb-1 flex items-center gap-1.5 font-semibold ${mine ? '' : 'text-brand-ink'}`}>
                    <CalendarClock className="size-4" aria-hidden="true" />
                    Meeting request · {formatDateTime(m.meeting_at!)}
                  </p>
                )}
                <p className="whitespace-pre-line">{m.body}</p>
                {m.kind === 'meeting_request' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {m.meeting_status === 'proposed' && !mine ? (
                      <>
                        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => respond(m.id, true)}>
                          Accept
                        </button>
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => respond(m.id, false)}>
                          Decline
                        </button>
                      </>
                    ) : (
                      <Pill tone={m.meeting_status === 'accepted' ? 'success' : m.meeting_status === 'declined' ? 'danger' : 'muted'}>
                        {m.meeting_status === 'proposed' ? 'Waiting for reply' : m.meeting_status}
                      </Pill>
                    )}
                  </div>
                )}
                <p className={`mt-1 text-[11px] ${mine ? 'text-white/75' : 'text-muted'}`}>{formatDateTime(m.created_at)}</p>
              </div>
            </div>
          )
        })}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="mt-3 space-y-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={meeting} onChange={(e) => setMeeting(e.target.checked)} />
          Request a meeting
        </label>
        {meeting && <Field label="Proposed date and time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
        <div className="flex items-end gap-2">
          <textarea
            className="input h-auto min-h-11 flex-1 py-2.5"
            rows={2}
            maxLength={4000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write a message…"
            aria-label="Message"
          />
          <button type="submit" className="btn-primary h-11" disabled={busy || !body.trim()} aria-label="Send">
            {busy ? <Spinner className="size-4" /> : <Send className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </form>
    </Panel>
  )
}

function NewConversation({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const { current } = useCurrentInstitution()
  const inst = current!
  const parent = inst.role === 'parent'
  const kids = useLoad(async () => (parent ? (unwrap(await supabase.rpc('guardian_children')) as { student_id: string; name: string; institution_id: string }[]).filter((k) => k.institution_id === inst.institution_id) : []), [parent])
  const structure = useStructure(parent ? undefined : inst.institution_id)
  const [student, setStudent] = useState('')
  const [counterpart, setCounterpart] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const students = parent
    ? (kids.data ?? []).map((k) => ({ id: k.student_id, name: k.name }))
    : (structure.data?.members ?? []).filter((m) => m.role === 'student' && m.status === 'active').map((m) => ({ id: m.id, name: m.display_name }))
  const chosen = student || students[0]?.id || ''
  const people = useLoad(async () => {
    if (!chosen) return []
    if (parent) return (unwrap(await supabase.rpc('guardian_contacts', { p_student: chosen })) as { user_id: string; name: string; detail: string | null }[]).map((p) => ({ id: p.user_id, label: `${p.name}${p.detail ? ` — ${p.detail}` : ''}` }))
    return (unwrap(await supabase.rpc('student_guardians', { p_student: chosen })) as { user_id: string; name: string; relationship: string }[]).map((p) => ({ id: p.user_id, label: `${p.name} (${p.relationship})` }))
  }, [chosen])
  const target = counterpart || people.data?.[0]?.id || ''

  const start = async (e: FormEvent) => {
    e.preventDefault()
    if (!target) return setError(parent ? 'Choose a teacher.' : 'This student has no linked parent you can message.')
    if (!subject.trim() || !body.trim()) return setError('Add a subject and a message.')
    setBusy(true)
    const { data, error: err } = await supabase.rpc('start_conversation', { p_student: chosen, p_counterpart: target, p_subject: subject.trim(), p_body: body.trim() })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    onStarted(data as string)
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New message"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-conv" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Send
          </button>
        </>
      }
    >
      <form id="new-conv" onSubmit={start} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <SelectField label={parent ? 'Child' : 'About student'} value={chosen} onChange={(e) => (setStudent(e.target.value), setCounterpart(''))}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={parent ? 'To' : 'To parent/guardian'} value={target} onChange={(e) => setCounterpart(e.target.value)}>
          {(people.data ?? []).length === 0 && <option value="">{people.loading ? 'Loading…' : 'Nobody available'}</option>}
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </SelectField>
        <Field label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
        <TextArea label="Message" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
      </form>
    </Modal>
  )
}
