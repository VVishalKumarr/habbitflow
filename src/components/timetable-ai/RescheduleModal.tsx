import { ArrowRight } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { DAY_SHORT, dayOfWeek } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import { FunctionError } from '../../lib/functions'
import { applyChange, movesToOps, timetableAi, type RescheduleResult } from '../../lib/timetableAi'
import { formatTime } from '../../lib/time'
import { useTrackerData } from '../../store/trackerData'
import { toast } from '../../store/ui'
import { usePrefs, useToday } from '../../store/view'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { AiNoteBox, DayChips } from './shared'

/** Event → displaced activities → suggested new times → before/after → confirm → save. */
export function RescheduleModal({ open, onClose, trackerId }: { open: boolean; onClose: () => void; trackerId: string }) {
  const { weekStart, timeFormat } = usePrefs()
  const today = useToday()
  const [label, setLabel] = useState('')
  const [days, setDays] = useState<number[]>([])
  const [wholeDay, setWholeDay] = useState(false)
  const [start, setStart] = useState('16:00')
  const [end, setEnd] = useState('18:00')
  const [res, setRes] = useState<RescheduleResult | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRes(null)
    setError(null)
    setSkip(new Set())
    setDays([dayOfWeek(today)])
  }, [open, today])

  const t = (s: string) => formatTime(s, timeFormat)

  const plan = async (e: FormEvent) => {
    e.preventDefault()
    if (!days.length) return setError('Choose at least one day.')
    if (!wholeDay && end <= start) return setError('The event must end after it starts.')
    setError(null)
    setBusy(true)
    try {
      setRes(await timetableAi.reschedule(trackerId, { label: label.trim() || 'Event', days, start: wholeDay ? null : start, end: wholeDay ? null : end }))
      setSkip(new Set())
    } catch (err) {
      setError((err as FunctionError).message)
    } finally {
      setBusy(false)
    }
  }

  const chosen = res?.moves.filter((m) => m.to && !skip.has(m.task_id)) ?? []

  const confirm = async () => {
    if (!res || !chosen.length) return
    setBusy(true)
    setError(null)
    try {
      await applyChange(trackerId, {
        base: res.version,
        source: 'ai_reschedule',
        summary: `Moved ${chosen.length} activit${chosen.length === 1 ? 'y' : 'ies'} for “${label.trim() || 'Event'}”`,
        ops: movesToOps(chosen),
      })
      await useTrackerData.getState().refresh()
      toast.success(`Moved ${chosen.length} activit${chosen.length === 1 ? 'y' : 'ies'}. You can undo this in History.`)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Reschedule for an event"
      subtitle={res ? 'Check the new times. Untick anything you want to leave where it is.' : 'Tell me what’s coming up, and I’ll find new times for what it displaces.'}
      footer={
        res ? (
          <>
            <button type="button" className="btn-secondary" onClick={() => setRes(null)} disabled={busy}>Back</button>
            <button type="button" className="btn-primary" onClick={confirm} disabled={busy || !chosen.length}>
              {busy && <Spinner className="size-4" />}
              Move {chosen.length} activit{chosen.length === 1 ? 'y' : 'ies'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" form="reschedule-form" className="btn-primary" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Find new times
            </button>
          </>
        )
      }>
      {error && <p className="mb-4 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">{error}</p>}
      {!res ? (
        <form id="reschedule-form" onSubmit={plan} className="space-y-4">
          <div>
            <label htmlFor="ev-label" className="field-label">What’s happening?</label>
            <input id="ev-label" className="input" placeholder="e.g. Football match, school trip, feeling ill" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="field-label">Day(s)</legend>
            <DayChips label="Event days" weekStart={weekStart} value={days} onChange={setDays} />
          </fieldset>
          <label className="flex items-center gap-3 text-[15px]">
            <input type="checkbox" className="size-5 accent-brand" checked={wholeDay} onChange={(e) => setWholeDay(e.target.checked)} />
            The whole day
          </label>
          {!wholeDay && (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-muted">From</span>
                <input type="time" className="input" aria-label="Event starts" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">To</span>
                <input type="time" className="input" aria-label="Event ends" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
          )}
          <p className="text-xs text-muted">Moves change your weekly timetable. You can undo them from History.</p>
        </form>
      ) : (
        <div className="space-y-4">
          {res.ai && <AiNoteBox note={res.ai} fallback="New times were suggested automatically instead." />}
          <p className="text-[15px]">{res.explanation}</p>
          {res.moves.length > 0 && (
            <ul className="space-y-2" aria-label="Proposed moves">
              {res.moves.map((m) => (
                <li key={m.task_id} className="rounded-xl border border-line p-3 text-sm">
                  <label className="flex items-start gap-3">
                    <input type="checkbox" className="mt-0.5 size-5 accent-brand" disabled={!m.to} checked={!!m.to && !skip.has(m.task_id)}
                      aria-label={`Move ${m.title}`}
                      onChange={(e) => setSkip((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.delete(m.task_id)
                        else n.add(m.task_id)
                        return n
                      })} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium break-words">{m.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
                        <span>Before: {DAY_SHORT[m.from.day]} {t(m.from.start)}</span>
                        <ArrowRight className="size-3.5" aria-hidden="true" />
                        <span className={m.to ? 'text-ink' : ''}>{m.to ? `After: ${DAY_SHORT[m.to.day]} ${t(m.to.start)}–${t(m.to.end)}` : 'Stays (no free time)'}</span>
                      </span>
                      {m.reason && <span className="mt-0.5 block text-xs text-muted">{m.reason}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}
