import { AlertTriangle, Lightbulb } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CATEGORY_STYLE } from '../../lib/category'
import { DAY_SHORT, orderedDays } from '../../lib/dates'
import { FunctionError } from '../../lib/functions'
import { CATEGORIES, fmtMin, timetableAi, type EvaluateResult } from '../../lib/timetableAi'
import { usePrefs } from '../../store/view'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { AiNoteBox } from './shared'

const SEVERITY = { high: 'text-danger', medium: 'text-ink', low: 'text-muted' } as const

/** Numbers and findings come from the app; the advice from the AI (when available). Read-only. */
export function CheckTimetableModal({ open, onClose, trackerId }: { open: boolean; onClose: () => void; trackerId: string }) {
  const { weekStart } = usePrefs()
  const [res, setRes] = useState<EvaluateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRes(null)
    setError(null)
    timetableAi.evaluate(trackerId).then(setRes, (e: FunctionError) => setError(e.message))
  }, [open, trackerId])

  const ev = res?.evaluation
  const maxDay = ev ? Math.max(60, ...ev.by_day.map((d) => d.minutes)) : 60

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Timetable check" subtitle="How your week is balanced, and what could be better."
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {!res && !error && (
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
          <Spinner className="size-5" /> Checking your timetable…
        </p>
      )}
      {error && <p className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">{error}</p>}
      {res && ev && (
        <div className="space-y-6">
          {res.advice ? (
            <section aria-labelledby="advice-h">
              <h3 id="advice-h" className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Lightbulb className="size-4 text-brand" aria-hidden="true" /> Advice
              </h3>
              {res.advice.summary && <p className="mb-3 text-[15px]">{res.advice.summary}</p>}
              <ol className="space-y-2.5">
                {res.advice.items.map((a, i) => (
                  <li key={i} className="rounded-xl border border-line px-3.5 py-2.5 text-sm">
                    <p className="font-medium">{a.title}</p>
                    <p className="text-muted">{a.detail}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            res.ai && <AiNoteBox note={res.ai} fallback="Here’s what the app found on its own:" />
          )}

          <section aria-labelledby="findings-h">
            <h3 id="findings-h" className="mb-2 text-sm font-semibold">Found in your timetable</h3>
            {ev.findings.length === 0 ? (
              <p className="text-sm text-muted">No problems found: no overloaded days, clashes or late nights.</p>
            ) : (
              <ul className="space-y-1.5">
                {ev.findings.map((f, i) => (
                  <li key={i} className={`flex gap-2 text-sm ${SEVERITY[f.severity]}`}>
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="hours-h">
            <h3 id="hours-h" className="mb-2 text-sm font-semibold">Time per week: {fmtMin(ev.total_minutes)}</h3>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CATEGORIES.map((c) => (
                <li key={c} className="flex items-center gap-2 rounded-xl bg-subtle px-3 py-2 text-sm">
                  <span className={`size-2.5 rounded-full ${CATEGORY_STYLE[c].dot}`} aria-hidden="true" />
                  <span className="flex-1">{CATEGORY_STYLE[c].label}</span>
                  <span className="tabular-nums text-muted">{fmtMin(ev.by_category[c])}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="days-h">
            <h3 id="days-h" className="mb-2 text-sm font-semibold">Each day</h3>
            <ul className="space-y-1.5">
              {orderedDays(weekStart).map((d) => {
                const day = ev.by_day[d]
                return (
                  <li key={d} className="flex items-center gap-3 text-sm">
                    <span className="w-9 shrink-0 text-muted">{DAY_SHORT[d]}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                      <span className={`block h-full rounded-full ${day.minutes > 360 ? 'bg-danger' : 'bg-brand'}`} style={{ width: `${(day.minutes / maxDay) * 100}%` }} />
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums">{day.minutes ? fmtMin(day.minutes) : 'free'}</span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-xs text-muted">{ev.free_cells} empty places in your time slots this week.</p>
          </section>
        </div>
      )}
    </Modal>
  )
}
