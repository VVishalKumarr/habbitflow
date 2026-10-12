import { Info } from 'lucide-react'
import { Link } from 'react-router-dom'
import { resetsIn } from '../../lib/aiQuota'
import { CATEGORY_STYLE } from '../../lib/category'
import { DAY_SHORT, orderedDays } from '../../lib/dates'
import { DAYS, mins, type AiNote, type Busy, type Proposal } from '../../lib/timetableAi'
import { formatSlot } from '../../lib/time'
import type { TimeFormat } from '../../lib/types'

/** Toggle buttons for picking several values. */
export function Chips<T extends string | number>({
  options, value, onChange, label, render = String,
}: { options: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: string; render?: (v: T) => string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o)
        return (
          <button
            key={String(o)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={`min-h-9 rounded-full border px-3 text-sm font-medium transition-colors ${on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-subtle hover:text-ink'}`}
          >
            {render(o)}
          </button>
        )
      })}
    </div>
  )
}

export function DayChips({ value, onChange, label, weekStart }: { value: number[]; onChange: (v: number[]) => void; label: string; weekStart: number }) {
  return <Chips options={orderedDays(weekStart)} value={value} onChange={onChange} label={label} render={(d) => DAY_SHORT[d]} />
}

/** Why the AI part wasn't used, and what still works. */
export function AiNoteBox({ note, fallback }: { note: AiNote; fallback: string }) {
  const limited = ['quota_exceeded', 'feature_disabled', 'pool_exhausted', 'spend_cap', 'rate_limited', 'too_large'].includes(note.code)
  return (
    <div className="flex gap-2.5 rounded-xl bg-subtle px-3.5 py-3 text-sm" role="note">
      <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
      <p>
        {note.code === 'ai_not_configured' ? 'AI suggestions aren’t switched on yet.' : note.error}
        {limited && note.resets_at && note.code !== 'feature_disabled' && ` It resets ${resetsIn(note.resets_at)}.`} {fallback}
        {limited && !note.institution && (
          <>
            {' '}
            <Link to="/pro" className="font-medium text-brand hover:underline">
              Better AI and higher limits with Plus or Pro
            </Link>
          </>
        )}
        {limited && note.institution && ' Your school sets these limits.'}
      </p>
    </div>
  )
}

/** A proposed week, day by day (works on phones: no wide grid). */
export function ProposalPreview({ proposal, busy = [], timeFormat, weekStart }: { proposal: Proposal; busy?: Busy[]; timeFormat: TimeFormat; weekStart: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {orderedDays(weekStart).map((d) => {
        const items = [
          ...proposal.entries
            .filter((e) => e.day === d)
            .map((e) => ({ key: `e${e.slot}`, start: proposal.slots[e.slot].start, end: proposal.slots[e.slot].end, title: e.title, note: e.note, cat: e.category, school: false })),
          ...busy.filter((b) => b.day === d).map((b, i) => ({ key: `b${i}`, start: b.start, end: b.end, title: 'School', note: '', cat: null, school: true })),
        ].sort((a, b) => mins(a.start)! - mins(b.start)!)
        return (
          <section key={d} className="rounded-xl border border-line p-3" aria-label={DAYS[d]}>
            <h4 className="mb-2 text-sm font-semibold">{DAYS[d]}</h4>
            {items.length === 0 ? (
              <p className="text-sm text-muted">Free day</p>
            ) : (
              <ul className="space-y-1.5">
                {items.map((it) => (
                  <li key={it.key} className={`flex gap-2 text-sm ${it.school ? 'text-muted' : ''}`}>
                    <span className="w-[7.5rem] shrink-0 tabular-nums text-muted">{formatSlot({ start_time: it.start, end_time: it.end }, timeFormat)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {it.cat && <span className={`size-2 shrink-0 rounded-full ${CATEGORY_STYLE[it.cat].dot}`} aria-hidden="true" />}
                        <span className="break-words">{it.title}</span>
                      </span>
                      {it.note && <span className="block text-xs text-muted">{it.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
