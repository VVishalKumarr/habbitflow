import { useEffect, useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { toast } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { ErrorNote, Loading } from './ui'

interface PreviewClass {
  id: string
  name: string
  grade: string
  section: string | null
  students: number
  class_teacher: string | null
  suggested_action: 'promote' | 'repeat' | 'graduate'
  suggested_grade: string
  suggested_name: string
}
interface Preview {
  year: { id: string; name: string; starts_on: string; ends_on: string } | null
  classes: PreviewClass[]
}
type Plan = { class_id: string; action: 'promote' | 'repeat' | 'graduate'; grade: string; name: string }

const nextYearName = (n?: string) => {
  const m = n?.match(/(\d{4})\D+(\d{2,4})/)
  if (!m) return ''
  const a = Number(m[1]) + 1
  return `${a}–${String(a + 1).slice(m[2].length === 2 ? 2 : 0)}`
}
const plusYear = (d?: string) => (d ? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}` : '')

/** Year-end: each class moves up, repeats or graduates; students carried over; old year and classes archived. */
export function YearTransitionModal({ inst, onClose, onDone }: { inst: string; onClose: () => void; onDone: () => void }) {
  const { data, error, loading } = useLoad(async () => unwrap(await supabase.rpc('year_transition_preview', { p_inst: inst })) as Preview, [inst])
  const [name, setName] = useState('')
  const [starts, setStarts] = useState('')
  const [ends, setEnds] = useState('')
  const [plan, setPlan] = useState<Plan[]>([])
  const [copy, setCopy] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    setName(nextYearName(data.year?.name))
    setStarts(plusYear(data.year?.starts_on))
    setEnds(plusYear(data.year?.ends_on))
    setPlan(data.classes.map((c) => ({ class_id: c.id, action: c.suggested_action, grade: c.suggested_grade, name: c.suggested_name })))
  }, [data])

  const set = (id: string, patch: Partial<Plan>) => setPlan((p) => p.map((x) => (x.class_id === id ? { ...x, ...patch } : x)))
  const moved = data ? plan.filter((p) => p.action !== 'graduate').reduce((n, p) => n + (data.classes.find((c) => c.id === p.class_id)?.students ?? 0), 0) : 0
  const graduating = data ? plan.filter((p) => p.action === 'graduate').reduce((n, p) => n + (data.classes.find((c) => c.id === p.class_id)?.students ?? 0), 0) : 0

  const run = async () => {
    setErr(null)
    if (!name.trim() || !starts || !ends) return setErr('Enter the new year’s name and dates.')
    if (plan.some((p) => p.action === 'promote' && (!p.grade.trim() || !p.name.trim()))) return setErr('Every class moving up needs a new grade and name.')
    if (!confirm) return setErr('Tick the confirmation box first.')
    setBusy(true)
    try {
      const r = unwrap(await supabase.rpc('year_transition', { p_inst: inst, p_name: name.trim(), p_starts: starts, p_ends: ends, p_plan: plan, p_copy_teachers: copy })) as {
        new_classes: number; students_moved: number; graduated: number
      }
      toast.success(`${name.trim()} started: ${r.new_classes} classes, ${r.students_moved} students moved, ${r.graduated} graduated.`)
      onDone()
      onClose()
    } catch (e) {
      setErr(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Start the next academic year"
      subtitle="Creates new classes for the new year and moves students into them. Old classes, enrolments, attendance, marks and homework stay readable; nothing is deleted."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={run} disabled={busy || !data}>{busy && <Spinner className="size-4" />}Start new year</button>
        </>
      }>
      {loading && !data && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (
        <div className="space-y-5">
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="field-label">New year</span>
              <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="2027–28" />
            </label>
            <label className="text-sm">
              <span className="field-label">Starts</span>
              <input type="date" className="input" value={starts} onChange={(e) => setStarts(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="field-label">Ends</span>
              <input type="date" className="input" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} />
            </label>
          </div>
          {data.year && <p className="text-sm text-muted">The current year, {data.year.name}, will be archived.</p>}
          {data.classes.length === 0 ? (
            <p className="text-sm text-muted">There are no classes to move.</p>
          ) : (
            <ul className="divide-y divide-line" aria-label="Classes">
              {data.classes.map((c) => {
                const p = plan.find((x) => x.class_id === c.id)
                if (!p) return null
                return (
                  <li key={c.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,10rem)_9rem_minmax(0,1fr)] sm:items-center">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-muted">{c.students} student{c.students === 1 ? '' : 's'}{c.class_teacher ? ` · ${c.class_teacher}` : ''}</p>
                    </div>
                    <select className="input h-10 text-sm" value={p.action} aria-label={`What happens to ${c.name}`}
                      onChange={(e) => set(c.id, { action: e.target.value as Plan['action'] })}>
                      <option value="promote">Move up</option>
                      <option value="repeat">Same grade again</option>
                      <option value="graduate">Graduate</option>
                    </select>
                    {p.action === 'promote' ? (
                      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                        <input className="input h-10 text-sm" value={p.grade} maxLength={30} aria-label={`${c.name} new grade`} onChange={(e) => set(c.id, { grade: e.target.value })} />
                        <input className="input h-10 text-sm" value={p.name} maxLength={60} aria-label={`${c.name} new class name`} onChange={(e) => set(c.id, { name: e.target.value })} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted">{p.action === 'repeat' ? `New ${c.name} for the new year, same students.` : 'Class archived; students keep their accounts.'}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 accent-brand" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            <span>Keep the same class teachers and subject teachers in the new classes <span className="block text-xs text-muted">You can change them afterwards in Classes & subjects.</span></span>
          </label>
          <label className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 accent-brand" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I understand: {moved} students move to new classes, {graduating} graduate, and this year’s classes become read-only history. This can’t be undone automatically.</span>
          </label>
        </div>
      )}
    </Modal>
  )
}
