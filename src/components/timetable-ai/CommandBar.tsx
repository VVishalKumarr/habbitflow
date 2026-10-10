import { Check, Mic, Send, Square, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { quotaMessage, QUOTA_CODES } from '../../lib/aiQuota'
import { addDays, DAY_NAMES, dayOfWeek, type ISODate } from '../../lib/dates'
import { friendlyError } from '../../lib/errors'
import { FunctionError } from '../../lib/functions'
import { useSpeech } from '../../lib/speech'
import {
  applyChange, freeCells, loadContext, localCommand, matchTask, mins, movesToOps, planMoves, timetableAi, timetableVersion,
  type Command, type Op,
} from '../../lib/timetableAi'
import { formatTime } from '../../lib/time'
import { completionKey } from '../../lib/types'
import { usePomodoro } from '../../store/pomodoro'
import { useTrackerData } from '../../store/trackerData'
import { toast } from '../../store/ui'
import { usePrefs, useToday } from '../../store/view'
import { Spinner } from '../ui/Spinner'

interface Plan {
  /** what the assistant understood, in words */
  text: string
  /** extra lines (e.g. which tasks move) */
  details?: string[]
  /** null = nothing to confirm (information or a problem) */
  run: (() => Promise<string | void>) | null
}

const PAGE_PATH = { timetable: '/dashboard', progress: '/progress', focus: '/focus', friends: '/friends', settings: '/settings', school: '/school', goals: '/goals', help: '/help', assistant: '/dashboard' } as const

/** Most recent date (today or earlier) that falls on weekday `dow`. */
const lastDate = (today: ISODate, dow: number) => addDays(today, -((dayOfWeek(today) - dow + 7) % 7))

/** Typed or spoken command → one action, shown for confirmation before anything changes. */
export function CommandBar({ trackerId }: { trackerId: string | null }) {
  const navigate = useNavigate()
  const today = useToday()
  const { timeFormat } = usePrefs()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const t = (s: string) => formatTime(s, timeFormat)

  const speech = useSpeech((heard) => {
    setText(heard)
    understand(heard)
  })

  /** Turns a command into what will happen, using the current timetable. */
  const resolve = async (c: Command): Promise<Plan> => {
    const { slots, tasks, completions } = useTrackerData.getState()
    const needTimetable = (): Plan => ({ text: 'Create or select a timetable first.', run: null })
    switch (c.type) {
      case 'unknown':
        return { text: c.reason, run: null }
      case 'open':
        return { text: `Open ${c.page === 'assistant' ? 'the timetable assistant' : c.page}.`, run: async () => void navigate(PAGE_PATH[c.page]) }
      case 'start_focus':
        return {
          text: `Start a ${c.minutes}-minute focus session${c.label !== 'Focus' ? ` on “${c.label}”` : ''}.`,
          run: async () => {
            const p = usePomodoro.getState()
            if (p.startedAt) return 'A timer is already running — finish or discard it on the Focus page first.'
            p.setMode('focus')
            p.updateSettings({ focus: c.minutes })
            p.setLabel(c.label)
            usePomodoro.getState().start()
            navigate('/focus')
          },
        }
      case 'whats_due': {
        const days = c.range === 'today' ? 1 : 7
        const dates = Array.from({ length: days }, (_, i) => addDays(today, i))
        const lines: string[] = []
        for (const d of dates) {
          for (const k of tasks.filter((x) => x.day_of_week === dayOfWeek(d) && !completions[completionKey(x.id, d)])) {
            const s = slots.find((x) => x.id === k.time_slot_id)
            lines.push(`${d === today ? 'Today' : DAY_NAMES[dayOfWeek(d)]} ${s ? t(s.start_time) : ''}: ${k.title}`)
          }
        }
        const ctx = await loadContext().catch(() => null)
        const until = new Date(`${addDays(today, days)}T00:00:00`).getTime()
        for (const dl of ctx?.deadlines ?? []) {
          if (new Date(dl.due_at).getTime() < until) lines.push(`Homework due ${new Date(dl.due_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${dl.subject ? `${dl.subject} — ` : ''}${dl.title}`)
        }
        return { text: lines.length ? `Due ${c.range === 'today' ? 'today' : 'in the next 7 days'}:` : `Nothing left to do ${c.range === 'today' ? 'today' : 'this week'}.`, details: lines.slice(0, 12), run: null }
      }
      case 'mark_done': {
        if (!trackerId) return needTimetable()
        const date = lastDate(today, c.day)
        const task = matchTask(c.task, tasks.filter((x) => x.day_of_week === c.day))
        if (!task) return { text: `I couldn’t find “${c.task}” on ${date === today ? 'today’s' : `${DAY_NAMES[c.day]}’s`} timetable.`, run: null }
        if (completions[completionKey(task.id, date)]) return { text: `“${task.title}” is already marked done.`, run: null }
        return { text: `Mark “${task.title}” done for ${date === today ? 'today' : DAY_NAMES[c.day]}.`, run: async () => useTrackerData.getState().setCompleted(task.id, date, true) }
      }
      case 'add_task': {
        if (!trackerId) return needTimetable()
        const a = mins(c.start)!
        const b = mins(c.end)!
        const exact = slots.find((s) => mins(s.start_time) === a && mins(s.end_time) === b)
        const near = slots.filter((s) => mins(s.start_time)! < b && a < mins(s.end_time)!)
        let ops: Op[]
        let where: string
        if (exact) {
          ops = [{ op: 'add_task', slot: exact.id, day: c.day, title: c.title, category: c.category, description: null }]
          where = `${t(exact.start_time)}–${t(exact.end_time)}`
        } else if (near.length === 1 && Math.abs(mins(near[0].start_time)! - a) <= 30) {
          ops = [{ op: 'add_task', slot: near[0].id, day: c.day, title: c.title, category: c.category, description: null }]
          where = `your ${t(near[0].start_time)}–${t(near[0].end_time)} slot`
        } else if (near.length) {
          return { text: `${t(c.start)}–${t(c.end)} overlaps your ${near.map((s) => `${t(s.start_time)}–${t(s.end_time)}`).join(', ')} time slot. Say a time that matches a slot, or a free time.`, run: null }
        } else {
          ops = [{ op: 'add_slot', ref: 'n', start: c.start, end: c.end }, { op: 'add_task', slot_ref: 'n', day: c.day, title: c.title, category: c.category, description: null }]
          where = `${t(c.start)}–${t(c.end)} (new time slot)`
        }
        return {
          text: `Add “${c.title}” every ${DAY_NAMES[c.day]}, ${where}.`,
          run: async () => {
            await applyChange(trackerId, { base: await timetableVersion(trackerId), source: 'voice', summary: `Added “${c.title}” on ${DAY_NAMES[c.day]}`, ops })
            await useTrackerData.getState().refresh()
          },
        }
      }
      case 'move_unfinished':
      case 'move_task': {
        if (!trackerId) return needTimetable()
        const to = c.to_day
        let moving
        if (c.type === 'move_unfinished') {
          const date = lastDate(today, c.from_day)
          moving = tasks.filter((x) => x.day_of_week === c.from_day && !completions[completionKey(x.id, date)])
          if (!moving.length) return { text: `Everything on ${date === today ? 'today’s' : `${DAY_NAMES[c.from_day]}’s`} timetable is done — nothing to move.`, run: null }
        } else {
          const task = matchTask(c.task, tasks)
          if (!task) return { text: `I couldn’t find “${c.task}” in this timetable.`, run: null }
          moving = [task]
        }
        let cells = freeCells(slots, tasks, null, [], [to])
        if (c.type === 'move_task' && c.start) cells = cells.filter((x) => x.start === c.start).concat(cells.filter((x) => x.start !== c.start))
        const moves = planMoves(slots, moving, cells, { days: [to] }).map((m) => (m.to && m.to.day !== to ? { ...m, to: null } : m))
        const ok = moves.filter((m) => m.to)
        const details = moves.map((m) => (m.to ? `${m.title}: ${DAY_NAMES[m.from.day].slice(0, 3)} ${t(m.from.start)} → ${DAY_NAMES[to].slice(0, 3)} ${t(m.to.start)}` : `${m.title}: no free slot on ${DAY_NAMES[to]} — stays`))
        if (!ok.length) return { text: `There’s no free time slot on ${DAY_NAMES[to]} to move ${moving.length === 1 ? 'it' : 'them'} to.`, details, run: null }
        return {
          text: `Move ${ok.length} activit${ok.length === 1 ? 'y' : 'ies'} to ${DAY_NAMES[to]}. This changes your weekly timetable (undo it in History).`,
          details,
          run: async () => {
            await applyChange(trackerId, { base: await timetableVersion(trackerId), source: 'voice', summary: `Moved ${ok.length} activit${ok.length === 1 ? 'y' : 'ies'} to ${DAY_NAMES[to]}`, ops: movesToOps(ok) })
            await useTrackerData.getState().refresh()
          },
        }
      }
    }
  }

  async function understand(input: string) {
    const q = input.trim()
    if (!q || busy) return
    setBusy(true)
    setPlan(null)
    setNote(null)
    let cmd: Command
    try {
      cmd = await timetableAi.command(q)
    } catch (e) {
      const err = e as FunctionError
      // Without the AI (limit reached, not configured, offline) the built-in parser still handles common phrasings.
      if (QUOTA_CODES.has(err.code ?? '')) setNote(quotaMessage(err))
      else if (err.code !== 'ai_not_configured' && err.status !== 0 && err.status !== 404 && err.status !== 503) {
        setBusy(false)
        setNote(err.message)
        return
      }
      cmd = localCommand(q, dayOfWeek(today))
    }
    try {
      const p = await resolve(cmd)
      // Opening a page changes nothing: do it straight away.
      if (cmd.type === 'open' && p.run) {
        await p.run()
        setText('')
      } else setPlan(p)
    } catch (e) {
      setNote(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!plan?.run) return
    setBusy(true)
    try {
      const msg = await plan.run()
      if (typeof msg === 'string') toast.error(msg)
      else toast.success('Done.')
      setPlan(null)
      setText('')
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    understand(text)
  }

  const listening = speech.state === 'listening'

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor="ai-command" className="sr-only">Command</label>
        <input id="ai-command" className="input flex-1" placeholder={listening ? 'Listening…' : 'e.g. add maths revision tomorrow 6 pm'} value={listening && speech.interim ? speech.interim : text}
          maxLength={300} autoComplete="off" onChange={(e) => setText(e.target.value)} />
        {speech.supported && (
          <button type="button" onClick={listening ? speech.stop : speech.start} disabled={busy}
            className={`icon-btn size-11 border border-line ${listening ? 'border-danger bg-danger-soft text-danger' : ''}`}
            aria-label={listening ? 'Stop listening' : 'Speak a command'} aria-pressed={listening}>
            {listening ? <Square className="size-4" aria-hidden="true" /> : <Mic className="size-5" aria-hidden="true" />}
          </button>
        )}
        <button type="submit" className="icon-btn size-11 bg-brand text-white hover:bg-brand-hover hover:text-white" disabled={busy || !text.trim()} aria-label="Send command">
          {busy ? <Spinner className="size-4" /> : <Send className="size-4" aria-hidden="true" />}
        </button>
      </form>
      {listening && <p className="text-xs text-muted" role="status">Listening — tap the square to stop. Audio isn’t sent to HabitFlow.</p>}
      {speech.error && <p className="text-sm text-danger" role="alert">{speech.error}</p>}
      {note && <p className="rounded-xl bg-subtle px-3.5 py-2.5 text-sm" role="status">{note}</p>}
      {plan && (
        <div className="rounded-xl border border-line p-3.5 text-sm" role="status" aria-label="Understood command">
          <p className="font-medium">{plan.run ? `I understood: ${plan.text}` : plan.text}</p>
          {plan.details && plan.details.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
              {plan.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {plan.run && (
              <button type="button" className="btn-primary h-9 min-h-9" onClick={confirm} disabled={busy}>
                <Check className="size-4" aria-hidden="true" />
                Confirm
              </button>
            )}
            <button type="button" className="btn-secondary h-9 min-h-9" onClick={() => setPlan(null)} disabled={busy}>
              <X className="size-4" aria-hidden="true" />
              {plan.run ? 'Cancel' : 'OK'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
