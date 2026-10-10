import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { CATEGORY_STYLE } from '../../lib/category'
import { DAY_NAMES, DAY_SHORT, orderedDays } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import { supabase } from '../../lib/supabase'
import { CATEGORIES, mins, type Category, type Op } from '../../lib/timetableAi'
import { formatSlot, formatTime } from '../../lib/time'
import { toast } from '../../store/ui'
import { usePrefs } from '../../store/view'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

interface Slot {
  id: string
  start_time: string
  end_time: string
}
interface Task {
  id: string
  time_slot_id: string
  day_of_week: number
  title: string
  category: Category
  description: string | null
}
interface Timetable {
  id: string
  name: string
  version: string
  slots: Slot[]
  tasks: Task[]
  history: { summary: string; source: string; actor_name: string | null; undone: boolean; created_at: string }[]
}
interface Data {
  student: string
  timetables: Timetable[]
}

interface Draft {
  id: string | null
  title: string
  category: Category
  description: string
  day: number
  start: string
  end: string
}
const EMPTY: Draft = { id: null, title: '', category: 'study', description: '', day: 1, start: '17:00', end: '18:00' }

/**
 * A class teacher's view of one student's personal timetables: activities
 * only (never ticks or progress). Each save is one recorded change; the
 * student is notified and can undo it.
 */
export function StudentTimetableModal({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const { weekStart, timeFormat } = usePrefs()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [newName, setNewName] = useState('Timetable')
  const [busy, setBusy] = useState(false)
  const t = (s: string) => formatTime(s, timeFormat)

  const load = async (keep?: string) => {
    const { data: d, error: e } = await supabase.rpc('teacher_student_timetables', { p_student: studentId })
    if (e) return setError(friendlyError(e))
    const res = d as Data
    setData(res)
    setSelected(keep ?? res.timetables[0]?.id ?? null)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId])

  const tt = data?.timetables.find((x) => x.id === selected) ?? null

  const save = async (ops: Op[], summary: string) => {
    setBusy(true)
    try {
      const { data: r, error: e } = await supabase.rpc('teacher_apply_timetable_change', {
        p_student: studentId,
        p_tracker: tt?.id ?? null,
        p_new_name: tt ? null : newName.trim(),
        p_base_version: tt?.version ?? null,
        p_summary: summary.slice(0, 300),
        p_ops: ops,
      })
      if (e) throw e
      toast.success(`Saved. ${data?.student ?? 'The student'} has been notified.`)
      setDraft(null)
      await load((r as { tracker_id: string }).tracker_id)
    } catch (e) {
      toast.error(friendlyError(e))
      // a stale view is refreshed so the next try works on current data
      if (/changed after/.test(friendlyError(e))) await load(tt?.id)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    const title = draft.title.trim()
    if (!title) return toast.error('Give the activity a name.')
    if (!tt && !newName.trim()) return toast.error('Give the new timetable a name.')
    const a = mins(draft.start)
    const b = mins(draft.end)
    if (a === null || b === null || b <= a) return toast.error('The end time must be after the start time.')
    const slots = tt?.slots ?? []
    const exact = slots.find((s) => mins(s.start_time) === a && mins(s.end_time) === b)
    const clash = slots.find((s) => s !== exact && mins(s.start_time)! < b && a < mins(s.end_time)!)
    if (!exact && clash) return toast.error(`${t(draft.start)}–${t(draft.end)} overlaps the ${t(clash.start_time)}–${t(clash.end_time)} time slot. Use that slot's times or a free time.`)
    const ops: Op[] = []
    const slotRef = exact ? { slot: exact.id } : { slot_ref: 'n' }
    if (!exact) ops.push({ op: 'add_slot', ref: 'n', start: draft.start, end: draft.end })
    const when = `${DAY_NAMES[draft.day]} ${t(draft.start)}–${t(draft.end)}`
    if (!draft.id) {
      ops.push({ op: 'add_task', ...slotRef, day: draft.day, title, category: draft.category, description: draft.description.trim() || null })
      return save(ops, `Added “${title}” on ${when}`)
    }
    const old = tt!.tasks.find((x) => x.id === draft.id)!
    const oldSlot = tt!.slots.find((s) => s.id === old.time_slot_id)
    if (old.title !== title || old.category !== draft.category || (old.description ?? '') !== draft.description.trim()) {
      ops.push({ op: 'update_task', task: old.id, title, category: draft.category, description: draft.description.trim() || null })
    }
    if (old.day_of_week !== draft.day || exact?.id !== old.time_slot_id) {
      ops.push({ op: 'move_task', task: old.id, ...slotRef, day: draft.day })
    }
    if (!ops.length) return setDraft(null)
    const moved = ops.some((o) => o.op === 'move_task')
    return save(ops, moved ? `Moved “${title}” from ${DAY_NAMES[old.day_of_week]} ${oldSlot ? t(oldSlot.start_time) : ''} to ${when}` : `Edited “${title}” (${when})`)
  }

  const remove = (task: Task) => {
    const s = tt!.slots.find((x) => x.id === task.time_slot_id)
    if (!window.confirm(`Remove “${task.title}” from ${data?.student}’s timetable?`)) return
    save([{ op: 'delete_task', task: task.id }], `Removed “${task.title}” on ${DAY_NAMES[task.day_of_week]}${s ? ` ${t(s.start_time)}` : ''}`)
  }

  const edit = (task: Task) => {
    const s = tt!.slots.find((x) => x.id === task.time_slot_id)!
    setDraft({ id: task.id, title: task.title, category: task.category, description: task.description ?? '', day: task.day_of_week, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) })
  }

  return (
    <Modal open onClose={onClose} size="lg" title={data ? `${data.student}’s timetable` : 'Student timetable'}
      subtitle="Personal timetable. The student is notified of every change and can undo it. Ticks and progress stay private."
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {error && <p className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">{error}</p>}
      {!data && !error && <p className="flex justify-center py-10"><Spinner /></p>}
      {data && (
        <div className="space-y-5">
          {data.timetables.length > 1 && (
            <label className="block text-sm">
              <span className="field-label">Timetable</span>
              <select className="input" value={selected ?? ''} onChange={(e) => { setSelected(e.target.value); setDraft(null) }}>
                {data.timetables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          {data.timetables.length === 0 && (
            <p className="text-sm text-muted">{data.student} has no personal timetable yet. Add an activity to create one.</p>
          )}

          {tt && (
            <div className="grid gap-3 sm:grid-cols-2">
              {orderedDays(weekStart).map((d) => {
                const items = tt.tasks
                  .filter((k) => k.day_of_week === d)
                  .map((k) => ({ k, s: tt.slots.find((s) => s.id === k.time_slot_id)! }))
                  .sort((x, y) => mins(x.s.start_time)! - mins(y.s.start_time)!)
                return (
                  <section key={d} className="rounded-xl border border-line p-3" aria-label={DAY_NAMES[d]}>
                    <h4 className="mb-2 text-sm font-semibold">{DAY_NAMES[d]}</h4>
                    {items.length === 0 ? <p className="text-sm text-muted">Nothing planned</p> : (
                      <ul className="space-y-1">
                        {items.map(({ k, s }) => (
                          <li key={k.id} className="flex items-center gap-2 text-sm">
                            <span className="w-[7.5rem] shrink-0 text-muted tabular-nums">{formatSlot(s, timeFormat)}</span>
                            <span className={`size-2 shrink-0 rounded-full ${CATEGORY_STYLE[k.category].dot}`} aria-hidden="true" />
                            <span className="min-w-0 flex-1 break-words">{k.title}</span>
                            <button type="button" className="icon-btn size-8" onClick={() => edit(k)} aria-label={`Edit ${k.title} on ${DAY_NAMES[d]}`} disabled={busy}>
                              <Pencil className="size-3.5" />
                            </button>
                            <button type="button" className="icon-btn size-8 hover:text-danger" onClick={() => remove(k)} aria-label={`Remove ${k.title} on ${DAY_NAMES[d]}`} disabled={busy}>
                              <Trash2 className="size-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          )}

          {!draft ? (
            <button type="button" className="btn-secondary" onClick={() => setDraft({ ...EMPTY })} disabled={busy}>
              <Plus className="size-4" aria-hidden="true" />
              Add activity
            </button>
          ) : (
            <form onSubmit={submit} className="space-y-3 rounded-xl border border-line p-3.5" aria-label={draft.id ? 'Edit activity' : 'Add activity'}>
              <h3 className="text-sm font-semibold">{draft.id ? 'Edit activity' : 'Add activity'}</h3>
              {!tt && (
                <label className="block text-sm">
                  <span className="field-label">New timetable name</span>
                  <input className="input" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />
                </label>
              )}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <label className="text-sm">
                  <span className="field-label">Activity</span>
                  <input className="input" value={draft.title} maxLength={100} placeholder="e.g. Maths revision" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </label>
                <label className="text-sm">
                  <span className="field-label">Category</span>
                  <select className="input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_STYLE[c].label}</option>)}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <label className="text-sm">
                  <span className="field-label">Day</span>
                  <select className="input" value={draft.day} onChange={(e) => setDraft({ ...draft, day: Number(e.target.value) })}>
                    {orderedDays(weekStart).map((d) => <option key={d} value={d}>{DAY_SHORT[d]}</option>)}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="field-label">From</span>
                  <input type="time" className="input" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
                </label>
                <label className="text-sm">
                  <span className="field-label">To</span>
                  <input type="time" className="input" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
                </label>
              </div>
              {tt && tt.slots.length > 0 && (
                <p className="text-xs text-muted">Existing time slots: {tt.slots.map((s) => `${t(s.start_time)}–${t(s.end_time)}`).join(', ')}</p>
              )}
              <label className="block text-sm">
                <span className="field-label">Note for the student <span className="font-normal text-muted">(optional)</span></span>
                <input className="input" value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy && <Spinner className="size-4" />}
                  Save
                </button>
                <button type="button" className="btn-secondary" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
              </div>
            </form>
          )}

          {tt && tt.history.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">Recent changes</h3>
              <ul className="space-y-1 text-sm">
                {tt.history.map((h, i) => (
                  <li key={i} className={h.undone ? 'text-muted line-through' : ''}>
                    {h.summary} <span className="text-xs text-muted">· {h.source === 'teacher' ? (h.actor_name ?? 'Class teacher') : h.source === 'undo' ? 'student undid' : 'student'} · {new Date(h.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}
