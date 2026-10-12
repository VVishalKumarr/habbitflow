// Timetable rules shared by the timetable-ai Edge Function and the app.
// Pure TypeScript, no imports: runs in Deno, the browser and Node (tests).
//
// A personal timetable is a list of time slots (rows shared by every day of
// the week; slots never overlap) and tasks placed in a (slot, day) cell.
// Everything the AI proposes is checked here before anyone sees it, and the
// numbers in an evaluation are computed here, never by the model.

export type Category = 'study' | 'exercise' | 'work' | 'personal' | 'other'
export const CATEGORIES: Category[] = ['study', 'exercise', 'work', 'personal', 'other']
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface Slot {
  id: string
  start_time: string
  end_time: string
}
export interface Task {
  id: string
  time_slot_id: string
  day_of_week: number
  title: string
  category: string
  description?: string | null
}
/** A fixed commitment on one weekday: a school period, tuition, sleep… */
export interface Busy {
  day: number
  start: string
  end: string
  label: string
}

export interface ProposalSlot {
  start: string
  end: string
}
export interface ProposalEntry {
  /** index into slots */
  slot: number
  day: number
  title: string
  category: Category
  note: string
}
export interface Proposal {
  slots: ProposalSlot[]
  entries: ProposalEntry[]
}

export const MAX_SLOTS = 24
export const MAX_ENTRIES = 168

/** "HH:MM[:SS]" → minutes since midnight, or null when invalid. */
export function mins(t: unknown): number | null {
  if (typeof t !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) return null
  return h * 60 + mm
}
export const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 < b2 && b1 < a2
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export interface Dropped {
  what: string
  reason: string
}

/**
 * Checks and repairs a proposal from the model: valid times, slots that don't
 * overlap, one entry per cell, nothing during fixed commitments or outside
 * waking hours. Returns the cleaned proposal and what was removed and why.
 */
export function validateProposal(
  raw: unknown,
  opts: { busy?: Busy[]; wake?: string | null; sleep?: string | null; existing?: Slot[] } = {},
): { proposal: Proposal; dropped: Dropped[] } {
  const dropped: Dropped[] = []
  const r = (raw ?? {}) as { slots?: unknown; entries?: unknown }
  const rawSlots = Array.isArray(r.slots) ? r.slots : []
  const rawEntries = Array.isArray(r.entries) ? r.entries : []
  const wake = mins(opts.wake ?? '') ?? 0
  const sleepRaw = mins(opts.sleep ?? '')
  // Sleep after midnight (e.g. 00:30) means "no limit before midnight".
  const sleep = sleepRaw === null || sleepRaw < wake ? 24 * 60 : sleepRaw

  // Slots: valid, inside waking hours, no overlap with each other or with
  // slots already in the timetable (when adding to one).
  const taken = (opts.existing ?? []).map((s) => [mins(s.start_time)!, mins(s.end_time)!] as const)
  const slotMap = new Map<number, number>()
  const slots: ProposalSlot[] = []
  const order = rawSlots
    .map((s, i) => ({ i, a: mins((s as ProposalSlot)?.start), b: mins((s as ProposalSlot)?.end) }))
    .sort((x, y) => (x.a ?? 0) - (y.a ?? 0))
  for (const { i, a, b } of order) {
    if (a === null || b === null || b <= a) {
      dropped.push({ what: `Time slot ${i + 1}`, reason: 'invalid time' })
      continue
    }
    if (b - a < 10 || b - a > 240) {
      dropped.push({ what: `${hhmm(a)}–${hhmm(b)}`, reason: 'slots must be 10 minutes to 4 hours long' })
      continue
    }
    if (a < wake || b > sleep) {
      dropped.push({ what: `${hhmm(a)}–${hhmm(b)}`, reason: 'outside your waking hours' })
      continue
    }
    if (taken.some(([x, y]) => overlaps(a, b, x, y))) {
      dropped.push({ what: `${hhmm(a)}–${hhmm(b)}`, reason: 'overlaps another time slot' })
      continue
    }
    if (slots.length >= MAX_SLOTS) {
      dropped.push({ what: `${hhmm(a)}–${hhmm(b)}`, reason: `at most ${MAX_SLOTS} time slots` })
      continue
    }
    taken.push([a, b])
    slotMap.set(i, slots.length)
    slots.push({ start: hhmm(a), end: hhmm(b) })
  }
  // keep slots in time order
  const sortedIdx = slots.map((s, i) => ({ s, i })).sort((x, y) => mins(x.s.start)! - mins(y.s.start)!)
  const remap = new Map(sortedIdx.map((x, n) => [x.i, n]))
  const finalSlots = sortedIdx.map((x) => x.s)

  const busy = opts.busy ?? []
  const cells = new Set<string>()
  const entries: ProposalEntry[] = []
  for (const e of rawEntries as Partial<ProposalEntry>[]) {
    const title = clean(e?.title, 100)
    const day = Number(e?.day)
    const si = slotMap.get(Number(e?.slot))
    if (!title || !Number.isInteger(day) || day < 0 || day > 6) {
      dropped.push({ what: title || 'An activity', reason: 'missing title or day' })
      continue
    }
    if (si === undefined) {
      dropped.push({ what: `${title} (${DAYS[day]})`, reason: 'its time slot was removed' })
      continue
    }
    const slot = remap.get(si)!
    const a = mins(finalSlots[slot].start)!
    const b = mins(finalSlots[slot].end)!
    const clash = busy.find((x) => x.day === day && overlaps(a, b, mins(x.start) ?? 0, mins(x.end) ?? 0))
    if (clash) {
      dropped.push({ what: `${title} (${DAYS[day]} ${finalSlots[slot].start})`, reason: `clashes with ${clash.label}` })
      continue
    }
    const key = `${slot}|${day}`
    if (cells.has(key)) {
      dropped.push({ what: `${title} (${DAYS[day]} ${finalSlots[slot].start})`, reason: 'two activities at the same time' })
      continue
    }
    if (entries.length >= MAX_ENTRIES) {
      dropped.push({ what: title, reason: `at most ${MAX_ENTRIES} activities` })
      continue
    }
    cells.add(key)
    entries.push({
      slot,
      day,
      title,
      category: CATEGORIES.includes(e?.category as Category) ? (e!.category as Category) : 'other',
      note: clean(e?.note, 200),
    })
  }
  // Drop slots nothing ended up in.
  const used = [...new Set(entries.map((e) => e.slot))].sort((x, y) => x - y)
  const keep = new Map(used.map((s, n) => [s, n]))
  return {
    proposal: { slots: used.map((s) => finalSlots[s]), entries: entries.map((e) => ({ ...e, slot: keep.get(e.slot)! })) },
    dropped,
  }
}

export type Op =
  | { op: 'add_slot'; ref: string; start: string; end: string }
  | { op: 'add_task'; slot?: string; slot_ref?: string; day: number; title: string; category: Category | string; description: string | null }
  | { op: 'move_task'; task: string; slot?: string; slot_ref?: string; day: number }
  | { op: 'update_task'; task: string; title: string; category: Category | string; description: string | null }
  | { op: 'delete_task'; task: string }

/** Steps that create a proposal in an (empty) timetable, for apply_timetable_change(). */
export function proposalToOps(p: Proposal): Op[] {
  const ops: Op[] = p.slots.map((s, i) => ({ op: 'add_slot', ref: `s${i}`, start: s.start, end: s.end }))
  for (const e of p.entries) {
    ops.push({ op: 'add_task', slot_ref: `s${e.slot}`, day: e.day, title: e.title, category: e.category, description: e.note || null })
  }
  return ops
}

// ---------------------------------------------------------------------------
// Evaluation: numbers and findings computed from the timetable itself.
// ---------------------------------------------------------------------------
export interface Finding {
  kind: 'overloaded_day' | 'no_breaks' | 'late_night' | 'school_clash' | 'exam_unprepared' | 'deadline_day' | 'no_rest' | 'unused_slot' | 'no_study'
  severity: 'high' | 'medium' | 'low'
  day?: number
  message: string
}
export interface Evaluation {
  total_minutes: number
  by_category: Record<Category, number>
  by_day: { day: number; minutes: number; study: number; tasks: number }[]
  free_cells: number
  empty_slots: string[]
  findings: Finding[]
}
export interface EvalContext {
  busy?: Busy[]
  /** upcoming exams: subject/title and first day (YYYY-MM-DD) */
  exams?: { title: string; subject?: string | null; starts_on: string }[]
  deadlines?: { title: string; subject?: string | null; due_at: string }[]
  /** today's YYYY-MM-DD, to say how far away exams are */
  today?: string
  sleep?: string | null
}

export const OVERLOAD_MINUTES = 6 * 60
export const LONG_STRETCH_MINUTES = 180

export function evaluateTimetable(slots: Slot[], tasks: Task[], ctx: EvalContext = {}): Evaluation {
  const slotById = new Map(slots.map((s) => [s.id, s]))
  const dur = (s: Slot) => (mins(s.end_time) ?? 0) - (mins(s.start_time) ?? 0)
  const by_category = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  const by_day = Array.from({ length: 7 }, (_, day) => ({ day, minutes: 0, study: 0, tasks: 0 }))
  const findings: Finding[] = []
  // count each cell once even if several tasks share it
  const cellCat = new Map<string, Task>()
  for (const t of tasks) {
    const s = slotById.get(t.time_slot_id)
    if (!s) continue
    const key = `${t.time_slot_id}|${t.day_of_week}`
    by_day[t.day_of_week].tasks++
    if (cellCat.has(key)) continue
    cellCat.set(key, t)
    const m = dur(s)
    const cat = (CATEGORIES.includes(t.category as Category) ? t.category : 'other') as Category
    by_category[cat] += m
    by_day[t.day_of_week].minutes += m
    if (cat === 'study') by_day[t.day_of_week].study += m
  }
  const total_minutes = Object.values(by_category).reduce((a, b) => a + b, 0)
  const free_cells = slots.length * 7 - cellCat.size
  const empty_slots = slots
    .filter((s) => !tasks.some((t) => t.time_slot_id === s.id))
    .map((s) => `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`)

  const sorted = [...slots].sort((a, b) => (mins(a.start_time) ?? 0) - (mins(b.start_time) ?? 0))
  const sleepAt = mins(ctx.sleep ?? '')
  for (let d = 0; d < 7; d++) {
    const day = by_day[d]
    if (day.minutes > OVERLOAD_MINUTES) {
      findings.push({ kind: 'overloaded_day', severity: 'high', day: d, message: `${DAYS[d]} has ${fmtMin(day.minutes)} planned outside school — more than ${fmtMin(OVERLOAD_MINUTES)}.` })
    }
    // back-to-back stretches with no gap
    let run = 0
    let prevEnd = -1
    let worst = 0
    for (const s of sorted) {
      if (!cellCat.has(`${s.id}|${d}`)) {
        run = 0
        prevEnd = -1
        continue
      }
      const a = mins(s.start_time)!
      run = prevEnd === a ? run + dur(s) : dur(s)
      prevEnd = mins(s.end_time)!
      worst = Math.max(worst, run)
    }
    if (worst >= LONG_STRETCH_MINUTES) {
      findings.push({ kind: 'no_breaks', severity: 'medium', day: d, message: `${DAYS[d]} has ${fmtMin(worst)} of activities back to back with no break.` })
    }
    const late = sorted.filter((s) => cellCat.has(`${s.id}|${d}`) && (mins(s.end_time)! > (sleepAt && sleepAt > 12 * 60 ? sleepAt : 23 * 60) || mins(s.start_time)! < 5 * 60))
    if (late.length) {
      findings.push({ kind: 'late_night', severity: 'medium', day: d, message: `${DAYS[d]}: ${late.map((s) => s.start_time.slice(0, 5)).join(', ')} cuts into sleep time.` })
    }
    for (const b of (ctx.busy ?? []).filter((x) => x.day === d)) {
      const clash = sorted.find((s) => cellCat.has(`${s.id}|${d}`) && overlaps(mins(s.start_time)!, mins(s.end_time)!, mins(b.start) ?? 0, mins(b.end) ?? 0))
      if (clash) {
        findings.push({ kind: 'school_clash', severity: 'high', day: d, message: `${DAYS[d]} ${clash.start_time.slice(0, 5)}: “${cellCat.get(`${clash.id}|${d}`)!.title}” clashes with ${b.label}.` })
      }
    }
  }
  if (by_day.every((d) => d.minutes > 0) && by_category.personal + by_category.exercise === 0) {
    findings.push({ kind: 'no_rest', severity: 'medium', message: 'Every day is planned and there’s no free, personal or exercise time. Keep at least one lighter day.' })
  }
  if (tasks.length && by_category.study === 0) {
    findings.push({ kind: 'no_study', severity: 'low', message: 'There’s no study time in this timetable.' })
  }
  const studyTitles = tasks.filter((t) => t.category === 'study').map((t) => t.title.toLowerCase())
  for (const e of ctx.exams ?? []) {
    const subject = (e.subject ?? e.title).toLowerCase()
    const key = subject.split(/\s+/)[0]
    const days = ctx.today ? Math.round((Date.parse(e.starts_on) - Date.parse(ctx.today)) / 86400000) : null
    if (days !== null && (days < 0 || days > 21)) continue
    if (!studyTitles.some((t) => t.includes(key) || (key.length > 4 && t.includes(key.slice(0, 4))))) {
      findings.push({ kind: 'exam_unprepared', severity: 'high', message: `${e.subject ?? e.title} exam ${days === null ? 'soon' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} — no revision for it in this timetable.` })
    }
  }
  const dueByDay = new Map<number, number>()
  for (const dl of ctx.deadlines ?? []) {
    const d = new Date(dl.due_at).getDay()
    dueByDay.set(d, (dueByDay.get(d) ?? 0) + 1)
  }
  for (const [d, n] of dueByDay) {
    if (n >= 2 && by_day[d].study < 60) {
      findings.push({ kind: 'deadline_day', severity: 'medium', day: d, message: `${n} pieces of homework are due on ${DAYS[d]}, but there’s less than an hour of study before then that day.` })
    }
  }
  if (empty_slots.length) {
    findings.push({ kind: 'unused_slot', severity: 'low', message: `Unused time slots: ${empty_slots.join(', ')}.` })
  }
  return { total_minutes, by_category, by_day, free_cells, empty_slots, findings }
}

export function fmtMin(m: number): string {
  const h = Math.floor(m / 60)
  const r = m % 60
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`
}

// ---------------------------------------------------------------------------
// Rescheduling: which tasks an event displaces, and where they could go.
// ---------------------------------------------------------------------------
export interface RescheduleEvent {
  label: string
  days: number[]
  /** null = the whole day */
  start: string | null
  end: string | null
}
export interface Candidate {
  id: string
  slot_id: string
  day: number
  start: string
  end: string
}
export interface Move {
  task_id: string
  title: string
  from: { slot_id: string; day: number; start: string; end: string }
  /** null = no free time found: leave it where it is */
  to: Candidate | null
  reason: string
}

export function affectedTasks(slots: Slot[], tasks: Task[], ev: RescheduleEvent, only?: (t: Task) => boolean): Task[] {
  const a = mins(ev.start ?? '') ?? 0
  const b = mins(ev.end ?? '') ?? 24 * 60
  const slotById = new Map(slots.map((s) => [s.id, s]))
  return tasks
    .filter((t) => ev.days.includes(t.day_of_week))
    .filter((t) => {
      const s = slotById.get(t.time_slot_id)
      return s && overlaps(mins(s.start_time)!, mins(s.end_time)!, a, b)
    })
    .filter((t) => (only ? only(t) : true))
}

/** Empty cells a displaced task could move to (not in the event, not during fixed commitments). */
export function freeCells(slots: Slot[], tasks: Task[], ev: RescheduleEvent | null, busy: Busy[] = [], days: number[] = [0, 1, 2, 3, 4, 5, 6]): Candidate[] {
  const full = new Set(tasks.map((t) => `${t.time_slot_id}|${t.day_of_week}`))
  const a = mins(ev?.start ?? '') ?? 0
  const b = mins(ev?.end ?? '') ?? 24 * 60
  const out: Candidate[] = []
  for (const d of days) {
    for (const s of slots) {
      const s1 = mins(s.start_time)!
      const s2 = mins(s.end_time)!
      if (full.has(`${s.id}|${d}`)) continue
      if (ev && ev.days.includes(d) && overlaps(s1, s2, a, b)) continue
      if (busy.some((x) => x.day === d && overlaps(s1, s2, mins(x.start) ?? 0, mins(x.end) ?? 0))) continue
      out.push({ id: `${s.id}|${d}`, slot_id: s.id, day: d, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) })
    }
  }
  return out
}

/**
 * Plan without AI: free cells closest in time — same time on a nearby day
 * first, then any time on the nearest day. Pairs are chosen best-first across
 * all tasks, so one task can't take the cell that suits another far better.
 */
export function planMoves(slots: Slot[], displaced: Task[], candidates: Candidate[], prefer: { days?: number[] } = {}): Move[] {
  const slotById = new Map(slots.map((s) => [s.id, s]))
  const info = displaced.map((t) => {
    const s = slotById.get(t.time_slot_id)!
    return { t, from: { slot_id: s.id, day: t.day_of_week, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }, want: mins(s.end_time)! - mins(s.start_time)! }
  })
  const score = (x: (typeof info)[number], c: Candidate) => {
    const dayGap = prefer.days?.length ? (prefer.days.includes(c.day) ? 0 : 10) : (c.day - x.t.day_of_week + 7) % 7 // later in the week first
    const timeGap = Math.abs(mins(c.start)! - mins(x.from.start)!) / 60
    const fit = mins(c.end)! - mins(c.start)! >= x.want ? 0 : 2
    return dayGap * 3 + timeGap + fit
  }
  const pairs = info.flatMap((x, i) => candidates.map((c, j) => ({ i, j, s: score(x, c) }))).sort((a, b) => a.s - b.s || a.i - b.i)
  const chosen = new Map<number, Candidate>()
  const usedCells = new Set<number>()
  for (const p of pairs) {
    if (chosen.has(p.i) || usedCells.has(p.j)) continue
    chosen.set(p.i, candidates[p.j])
    usedCells.add(p.j)
  }
  return info.map((x, i) => {
    const to = chosen.get(i) ?? null
    if (!to) return { task_id: x.t.id, title: x.t.title, from: x.from, to: null, reason: 'No free time slot found — it stays where it is.' }
    return { task_id: x.t.id, title: x.t.title, from: x.from, to, reason: to.start === x.from.start ? 'Same time, different day.' : 'Nearest free time.' }
  })
}

export const movesToOps = (moves: Move[]): Op[] =>
  moves.filter((m) => m.to).map((m) => ({ op: 'move_task', task: m.task_id, slot: m.to!.slot_id, day: m.to!.day }))

// ---------------------------------------------------------------------------
// Commands (voice or typed): the one action the AI may map a phrase to.
// ---------------------------------------------------------------------------
export const PAGES = ['timetable', 'progress', 'focus', 'friends', 'settings', 'school', 'goals', 'help', 'assistant'] as const
export type Page = (typeof PAGES)[number]

export type Command =
  | { type: 'add_task'; title: string; day: number; start: string; end: string; category: Category }
  | { type: 'move_unfinished'; from_day: number; to_day: number }
  | { type: 'move_task'; task: string; to_day: number; start: string | null }
  | { type: 'start_focus'; minutes: number; label: string }
  | { type: 'mark_done'; task: string; day: number }
  | { type: 'whats_due'; range: 'today' | 'week' }
  | { type: 'open'; page: Page }
  | { type: 'unknown'; reason: string }

/** Validates a command from the model (or the local parser); anything off becomes 'unknown'. */
export function normalizeCommand(raw: unknown): Command {
  const c = (raw ?? {}) as Record<string, unknown>
  const day = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6 ? (v as number) : null)
  const unknown = (reason: string): Command => ({ type: 'unknown', reason })
  switch (c.type) {
    case 'add_task': {
      const title = clean(c.title, 100)
      const d = day(c.day)
      const a = mins(c.start)
      let b = mins(c.end)
      if (a !== null && b === null) b = Math.min(a + 60, 24 * 60)
      if (!title || d === null || a === null || b === null || b <= a || b - a > 240) return unknown('I need a title, a day and a time for the new task.')
      return { type: 'add_task', title, day: d, start: hhmm(a), end: hhmm(b), category: CATEGORIES.includes(c.category as Category) ? (c.category as Category) : 'other' }
    }
    case 'move_unfinished': {
      const f = day(c.from_day)
      const t = day(c.to_day)
      if (f === null || t === null || f === t) return unknown('Which day should the tasks move to?')
      return { type: 'move_unfinished', from_day: f, to_day: t }
    }
    case 'move_task': {
      const task = clean(c.task, 100)
      const t = day(c.to_day)
      if (!task || t === null) return unknown('Which task, and to which day?')
      const a = mins(c.start)
      return { type: 'move_task', task, to_day: t, start: a === null ? null : hhmm(a) }
    }
    case 'start_focus': {
      const m = Math.round(Number(c.minutes))
      return { type: 'start_focus', minutes: Number.isFinite(m) && m >= 1 && m <= 180 ? m : 25, label: clean(c.label, 100) || 'Focus' }
    }
    case 'mark_done': {
      const task = clean(c.task, 100)
      const d = day(c.day)
      if (!task || d === null) return unknown('Which task should I mark done?')
      return { type: 'mark_done', task, day: d }
    }
    case 'whats_due':
      return { type: 'whats_due', range: c.range === 'today' ? 'today' : 'week' }
    case 'open':
      return PAGES.includes(c.page as Page) ? { type: 'open', page: c.page as Page } : unknown('I can open the timetable, progress, focus, friends, goals, settings or help.')
    default:
      return unknown(clean(c.reason, 200) || 'Sorry, I didn’t understand that.')
  }
}

/** Best match for a spoken task name among the timetable's tasks (null if nothing is close). */
export function matchTask<T extends { title: string }>(query: string, tasks: T[]): T | null {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()
  if (!q) return null
  const words = q.split(/\s+/)
  let best: T | null = null
  let bestScore = 0
  for (const t of tasks) {
    const title = t.title.toLowerCase()
    let score = title === q ? 100 : title.includes(q) ? 50 : 0
    score += words.filter((w) => w.length > 2 && title.includes(w)).length * 10
    if (score > bestScore) {
      best = t
      bestScore = score
    }
  }
  return bestScore >= 10 ? best : null
}

// ---------------------------------------------------------------------------
// Offline command parser: used when the AI isn't available. Handles the
// common phrasings; anything else asks the student to rephrase.
// ---------------------------------------------------------------------------
const DAY_WORDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function dayIn(text: string, todayDow: number): number | null {
  if (/\btoday\b|\btonight\b/.test(text)) return todayDow
  if (/\btomorrow\b/.test(text)) return (todayDow + 1) % 7
  const i = DAY_WORDS.findIndex((d) => new RegExp(`\\b${d}|\\b${d.slice(0, 3)}\\b`).test(text))
  return i === -1 ? null : i
}

function timesIn(text: string): string[] {
  const out: string[] = []
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\b|$)/g
  for (const m of text.matchAll(re)) {
    // ignore durations ("25 minutes") and dates
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 5)
    if (/^\s*-?\s*min|^\s*h(ou)?r/.test(after)) continue
    let h = Number(m[1])
    const mm = Number(m[2] ?? 0)
    if (h > 23 || mm > 59) continue
    const ap = m[3]?.[0]
    if (ap === 'p' && h < 12) h += 12
    if (ap === 'a' && h === 12) h = 0
    if (!ap && !m[2] && h >= 1 && h <= 6) h += 12 // "at 6" usually means 6 pm
    if (!ap && !m[2] && !/\bat\b|\bfrom\b|\bto\b|-/.test(text)) continue
    out.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`)
  }
  return out
}

function guessCategory(title: string): Category {
  if (/revis|study|homework|math|science|physics|chem|bio|english|history|geograph|read|essay|exam|practice paper/.test(title)) return 'study'
  if (/run|gym|football|cricket|swim|yoga|walk|workout|exercise|sport|basketball|badminton|tennis|cycle/.test(title)) return 'exercise'
  if (/job|work|shift/.test(title)) return 'work'
  if (/chores|family|friends|meditat|relax|music|tv|game|free time/.test(title)) return 'personal'
  return 'other'
}

export function localCommand(input: string, todayDow: number): Command {
  const text = input.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()
  const page = PAGES.find((p) => new RegExp(`\\b${p}\\b`).test(text))
  if (/^(open|show|go to|take me to)\b/.test(text) && page) return { type: 'open', page: page as Page }
  if (/\b(focus|pomodoro|timer)\b/.test(text) && /\b(start|begin|set)\b/.test(text)) {
    const m = /(\d{1,3})\s*-?\s*min/.exec(text)
    const on = /\b(?:on|for)\s+(?!\d)([a-z][\w\s]{1,40})$/.exec(text)
    return normalizeCommand({ type: 'start_focus', minutes: m ? Number(m[1]) : 25, label: on ? cap(on[1]) : 'Focus' })
  }
  if (/what'?s due|what is due|due (this|today)|deadlines?\b/.test(text)) return { type: 'whats_due', range: /\btoday\b/.test(text) ? 'today' : 'week' }
  const done = /^(?:mark|tick|check off|complete|finish(?:ed)?|i (?:have )?(?:finished|done|completed))\s+(?:my\s+)?(.+?)(?:\s+as)?(?:\s+(?:done|complete|completed|finished))?(?:\s+today)?$/.exec(text)
  if (done && !/^(?:all|everything)$/.test(done[1])) return normalizeCommand({ type: 'mark_done', task: done[1], day: todayDow })
  const moveAll = /^(?:move|shift|push)\s+(?:all\s+)?(today'?s?|tomorrow'?s?|\w+day'?s?)\s+(?:unfinished|remaining|undone|pending|incomplete|left over)?\s*(?:tasks|activities|work|things)\s+to\s+(.+)$/.exec(text)
  if (moveAll) return normalizeCommand({ type: 'move_unfinished', from_day: dayIn(moveAll[1].replace(/'?s$/, ''), todayDow), to_day: dayIn(moveAll[2], todayDow) })
  const move = /^(?:move|shift|reschedule)\s+(?:my\s+)?(.+?)\s+to\s+(.+)$/.exec(text)
  if (move) return normalizeCommand({ type: 'move_task', task: move[1], to_day: dayIn(move[2], todayDow), start: timesIn(move[2])[0] ?? null })
  const add = /^(?:add|schedule|put|plan|create)\s+(?:a\s+|an\s+)?(.+)$/.exec(text)
  if (add) {
    const times = timesIn(add[1])
    const d = dayIn(add[1], todayDow)
    const title = add[1]
      .replace(/\b(?:every\s+)?(?:on\s+)?(?:today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g, '')
      .replace(/\b(?:at|from|to|until|till|-)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/g, '')
      .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/g, '')
      .replace(/\s+(?:in|to)\s+my\s+timetable\b|\s+(?:at|on|for)\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return normalizeCommand({ type: 'add_task', title: cap(title), day: d, start: times[0] ?? null, end: times[1] ?? null, category: guessCategory(title) })
  }
  if (page && /\b(open|show)\b/.test(text)) return { type: 'open', page: page as Page }
  return { type: 'unknown', reason: 'Sorry, I didn’t catch that. Try “add maths revision tomorrow 6 pm” or “start a 25-minute focus session”.' }
}

const cap = (s: string) => (s ? s.trim().charAt(0).toUpperCase() + s.trim().slice(1) : s)

// ---------------------------------------------------------------------------
// Study plans: extra time for subjects that need attention, from the
// school's study insights. Only study sessions in the student's personal
// timetable are touched: general study sessions are given a subject, time
// beyond the essentials is taken from strong subjects, and new sessions go
// into free cells within the daily study limit. School periods, fixed
// commitments and every other activity stay where they are.
// ---------------------------------------------------------------------------
export type InsightStatus = 'needs_attention' | 'improving' | 'on_track' | 'strong' | 'insufficient_data'
export interface SubjectInsight {
  subject_id: string
  subject: string
  status: InsightStatus
  recommended_minutes: number
  reasons: { kind: 'concern' | 'strength' | 'info'; text: string }[]
  evidence?: { exam?: { title: string; starts_on: string } | null }
}
export interface StudyPlanOptions {
  busy?: Busy[]
  /** most study minutes on one day (existing + added) */
  maxDailyStudy: number
  wake?: string | null
  sleep?: string | null
}
export interface StudyPlanChange {
  kind: 'relabel' | 'add'
  task_id?: string
  slot_id: string
  day: number
  start: string
  end: string
  minutes: number
  subject: string
  from_title?: string
  title: string
  reason: string
}
export interface StudyPlan {
  changes: StudyPlanChange[]
  ops: Op[]
  /** what was traded for what, and what couldn't be done */
  tradeoffs: string[]
  /** time that couldn't be found, and why */
  unmet: { subject: string; minutes: number; why: string }[]
  summary: string
  /** identifies the insights the plan was made for (auto mode applies each once) */
  signature: string
}

/** Session lengths the plan adds: long enough to be useful, short enough to focus. */
export const STUDY_BLOCK_MIN = 20
export const STUDY_BLOCK_MAX = 90
export const PLAN_MARK = 'Study plan'

const ALIASES: Record<string, string[]> = {
  mathematics: ['maths', 'math'],
  biology: ['bio'],
  chemistry: ['chem'],
  physics: ['phys'],
  english: ['eng'],
  science: ['sci'],
  geography: ['geo'],
  history: ['hist'],
  'computer science': ['computer', 'computing', 'cs', 'coding'],
  economics: ['eco', 'econ'],
  accountancy: ['accounts'],
  'social science': ['social studies', 'sst'],
}
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)

/** Does an activity title mention this subject (name, first word, or a common short form)? */
export function mentionsSubject(title: string, subject: string): boolean {
  const t = ` ${words(title).join(' ')} `
  const s = words(subject).join(' ')
  if (!s) return false
  const names = new Set([s, ...(ALIASES[s] ?? [])])
  const first = s.split(' ')[0]
  if (first.length >= 4) names.add(first)
  for (const [full, short] of Object.entries(ALIASES)) if (short.includes(s)) names.add(full)
  return [...names].some((n) => t.includes(` ${n} `))
}

const GENERAL = /^(self[\s-]?)?(study|studies|revision|revise|homework|practice|reading|prep|preparation|school ?work)(\s+(time|session|block))?$/i

/** Short stable hash for signatures (not for security). */
const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

export function insightSignature(insights: SubjectInsight[]): string {
  return hash(insights.map((i) => `${i.subject_id}:${i.status}:${i.recommended_minutes}`).sort().join(','))
}

const STATUS_TEXT: Record<InsightStatus, string> = {
  needs_attention: 'needs attention',
  improving: 'is improving — keep it going',
  on_track: 'is on track',
  strong: 'is strong',
  insufficient_data: 'has an exam coming up',
}

export function planStudyBoost(slots: Slot[], tasks: Task[], insights: SubjectInsight[], opts: StudyPlanOptions): StudyPlan {
  const slotById = new Map(slots.map((s) => [s.id, s]))
  const dur = (s: Slot) => mins(s.end_time)! - mins(s.start_time)!
  const sorted = slots.filter((s) => mins(s.start_time) !== null && mins(s.end_time) !== null)
    .sort((a, b) => mins(a.start_time)! - mins(b.start_time)!)
  const cell = (slotId: string, day: number) => `${slotId}|${day}`
  const occupied = new Map<string, Task>()
  for (const t of tasks) {
    const key = cell(t.time_slot_id, t.day_of_week)
    if (slotById.has(t.time_slot_id) && !occupied.has(key)) occupied.set(key, t)
  }

  // Minutes per day: everything, and study only (each cell once).
  const dayTotal: number[] = Array(7).fill(0)
  const dayStudy: number[] = Array(7).fill(0)
  for (const t of occupied.values()) {
    const m = dur(slotById.get(t.time_slot_id)!)
    dayTotal[t.day_of_week] += m
    if (t.category === 'study') dayStudy[t.day_of_week] += m
  }
  const subjectOf = (t: Task) => insights.find((i) => mentionsSubject(t.title, i.subject)) ?? null
  const studyCells = [...occupied.values()].filter((t) => t.category === 'study')
  const general = studyCells.filter((t) => GENERAL.test(t.title.trim()) && !subjectOf(t))
  // subject → minutes per day, to spread a subject over the week
  const perSubjectDay = new Map<string, number[]>()
  const subjDay = (id: string) => {
    if (!perSubjectDay.has(id)) perSubjectDay.set(id, Array(7).fill(0))
    return perSubjectDay.get(id)!
  }
  for (const t of studyCells) {
    const i = subjectOf(t)
    if (i) subjDay(i.subject_id)[t.day_of_week] += dur(slotById.get(t.time_slot_id)!)
  }

  // needs attention first, then an exam coming up, then improving; more minutes first within each
  const priority = (i: SubjectInsight) =>
    (i.status === 'needs_attention' ? 0 : i.evidence?.exam ? 1 : i.status === 'improving' ? 2 : 3) * 1000 - i.recommended_minutes
  const needs = insights.filter((i) => i.recommended_minutes > 0).sort((a, b) => priority(a) - priority(b))
  const remaining = new Map(needs.map((i) => [i.subject_id, i.recommended_minutes]))
  const changes: StudyPlanChange[] = []
  const tradeoffs: string[] = []
  const used = new Set<string>()

  const reasonFor = (i: SubjectInsight) => {
    const concern = i.reasons.find((r) => r.kind === 'concern') ?? i.reasons[0]
    const exam = i.evidence?.exam ? ` Exam “${i.evidence.exam.title}” is coming up.` : ''
    return `${i.subject} ${STATUS_TEXT[i.status]}.${concern ? ` ${concern.text}` : ''}${exam}`.slice(0, 300)
  }
  const titleFor = (i: SubjectInsight) => `${i.subject} ${i.evidence?.exam ? 'revision' : 'practice'}`.slice(0, 100)
  // For a subject: the day with least of that subject, then least study overall.
  const best = <T extends { day: number }>(i: SubjectInsight, cands: T[]) =>
    [...cands].sort((a, b) => subjDay(i.subject_id)[a.day] - subjDay(i.subject_id)[b.day] || dayStudy[a.day] - dayStudy[b.day] || a.day - b.day)[0]

  const relabel = (t: Task, i: SubjectInsight, why: string) => {
    const s = slotById.get(t.time_slot_id)!
    const m = dur(s)
    changes.push({
      kind: 'relabel', task_id: t.id, slot_id: s.id, day: t.day_of_week, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), minutes: m,
      subject: i.subject, from_title: t.title, title: titleFor(i), reason: why,
    })
    used.add(cell(s.id, t.day_of_week))
    subjDay(i.subject_id)[t.day_of_week] += m
    remaining.set(i.subject_id, (remaining.get(i.subject_id) ?? 0) - m)
  }

  // 1. General study sessions get a subject; at least half stay general (homework time).
  let generalLeft = general.length - Math.ceil(general.length / 2)
  for (const i of needs) {
    while ((remaining.get(i.subject_id) ?? 0) > 10 && generalLeft > 0) {
      const pick = best(i, general.filter((t) => !used.has(cell(t.time_slot_id, t.day_of_week))).map((t) => ({ t, day: t.day_of_week })))
      if (!pick) break
      relabel(pick.t, i, reasonFor(i))
      generalLeft--
    }
  }
  const relabelled = changes.length
  if (relabelled) {
    tradeoffs.push(`${relabelled} general study session${relabelled === 1 ? ' now focuses' : 's now focus'} on a subject; ${general.length - relabelled} stay${general.length - relabelled === 1 ? 's' : ''} free for homework.`)
  }

  // 2. Time from strong subjects, keeping at least one session each (essential revision).
  for (const strong of insights.filter((i) => i.status === 'strong' && i.recommended_minutes < 0)) {
    let release = -strong.recommended_minutes
    const own = studyCells
      .filter((t) => subjectOf(t)?.subject_id === strong.subject_id && !used.has(cell(t.time_slot_id, t.day_of_week)))
      .sort((a, b) => b.day_of_week - a.day_of_week)
    for (const t of own.slice(1)) {
      const m = dur(slotById.get(t.time_slot_id)!)
      if (release < m / 2) break
      const target = needs.find((i) => (remaining.get(i.subject_id) ?? 0) > 10)
      if (!target) break
      relabel(t, target, `${reasonFor(target)} ${strong.subject} is strong, so this session moves to ${target.subject}.`)
      subjDay(strong.subject_id)[t.day_of_week] -= m
      tradeoffs.push(`${fmtMin(m)} on ${DAYS[t.day_of_week]} moves from ${strong.subject} (strong) to ${target.subject}; ${strong.subject} keeps its other sessions.`)
      release -= m
    }
  }

  // 3. New sessions in free cells, within the limits.
  const sleepAt = mins(opts.sleep ?? '')
  const wakeAt = mins(opts.wake ?? '')
  const busy = opts.busy ?? []
  const touching = (a: Slot, b: Slot) => a.end_time.slice(0, 5) === b.start_time.slice(0, 5)
  const stretch = (slot: Slot, day: number) => {
    // length of the back-to-back run this cell would join
    const idx = sorted.findIndex((s) => s.id === slot.id)
    let run = dur(slot)
    for (let k = idx - 1; k >= 0 && occupied.has(cell(sorted[k].id, day)) && touching(sorted[k], sorted[k + 1]); k--) run += dur(sorted[k])
    for (let k = idx + 1; k < sorted.length && occupied.has(cell(sorted[k].id, day)) && touching(sorted[k - 1], sorted[k]); k++) run += dur(sorted[k])
    return run
  }
  const blockedWhy: Record<string, string> = {}
  for (const i of needs) {
    while ((remaining.get(i.subject_id) ?? 0) > 10) {
      const cands: { slot: Slot; day: number }[] = []
      let blocked = ''
      for (let d = 0; d < 7; d++) {
        for (const s of sorted) {
          const key = cell(s.id, d)
          if (occupied.has(key) || used.has(key)) continue
          const a = mins(s.start_time)!
          const b = mins(s.end_time)!
          if (b - a < STUDY_BLOCK_MIN || b - a > STUDY_BLOCK_MAX) {
            blocked ||= `the free time slots aren’t ${STUDY_BLOCK_MIN}–${STUDY_BLOCK_MAX} minutes long`
            continue
          }
          if (busy.some((x) => x.day === d && overlaps(a, b, mins(x.start) ?? 0, mins(x.end) ?? 0))) {
            blocked ||= 'the free time clashes with school or fixed commitments'
            continue
          }
          if ((wakeAt !== null && a < wakeAt) || (sleepAt !== null && sleepAt > 12 * 60 && b > sleepAt) || b > 23 * 60 || a < 5 * 60) {
            blocked ||= 'the free time is outside your waking hours'
            continue
          }
          if (dayStudy[d] + (b - a) > opts.maxDailyStudy) {
            blocked = `your daily study limit of ${fmtMin(opts.maxDailyStudy)} is reached on the days with free time`
            continue
          }
          if (dayTotal[d] + (b - a) > OVERLOAD_MINUTES) {
            blocked ||= `the days with free time already have ${fmtMin(OVERLOAD_MINUTES)} planned`
            continue
          }
          if (stretch(s, d) >= LONG_STRETCH_MINUTES) {
            blocked ||= 'it would leave no break between activities'
            continue
          }
          // at most one added session of a subject per day
          if (changes.some((c) => c.kind === 'add' && c.subject === i.subject && c.day === d)) continue
          cands.push({ slot: s, day: d })
        }
      }
      const pick = best(i, cands)
      if (!pick) {
        blockedWhy[i.subject_id] = blocked || 'there is no free time in this timetable'
        break
      }
      const m = dur(pick.slot)
      const key = cell(pick.slot.id, pick.day)
      changes.push({
        kind: 'add', slot_id: pick.slot.id, day: pick.day, start: pick.slot.start_time.slice(0, 5), end: pick.slot.end_time.slice(0, 5), minutes: m,
        subject: i.subject, title: titleFor(i), reason: reasonFor(i),
      })
      used.add(key)
      occupied.set(key, { id: `new:${key}`, time_slot_id: pick.slot.id, day_of_week: pick.day, title: titleFor(i), category: 'study' })
      dayStudy[pick.day] += m
      dayTotal[pick.day] += m
      subjDay(i.subject_id)[pick.day] += m
      remaining.set(i.subject_id, (remaining.get(i.subject_id) ?? 0) - m)
    }
  }

  const unmet = needs
    .filter((i) => (remaining.get(i.subject_id) ?? 0) > 10)
    .map((i) => ({ subject: i.subject, minutes: remaining.get(i.subject_id)!, why: blockedWhy[i.subject_id] ?? 'there is no more flexible study time' }))
  for (const u of unmet) {
    tradeoffs.push(`${u.subject} still needs about ${fmtMin(u.minutes)} a week, but ${u.why}. Add a ${STUDY_BLOCK_MIN}–${STUDY_BLOCK_MAX} minute time slot on a lighter day, or swap a non-study activity yourself.`)
  }

  const bySubject = new Map(insights.map((i) => [i.subject, i]))
  const ops: Op[] = changes.map((c) => {
    const description = `${PLAN_MARK}: ${reasonFor(bySubject.get(c.subject)!)}`.slice(0, 500)
    return c.kind === 'relabel'
      ? { op: 'update_task', task: c.task_id!, title: c.title, category: 'study', description }
      : { op: 'add_task', slot: c.slot_id, day: c.day, title: c.title, category: 'study', description }
  })
  const added = changes.reduce((n, c) => n + (c.kind === 'add' ? c.minutes : 0), 0)
  const subjects = [...new Set(changes.map((c) => c.subject))]
  const summary = changes.length
    ? `Study plan: more time for ${subjects.join(', ')}${added ? ` (+${fmtMin(added)} a week)` : ' (no extra hours)'}.`.slice(0, 300)
    : 'Study plan: no changes needed.'
  return { changes, ops, tradeoffs, unmet, summary, signature: insightSignature(insights) }
}

/** Merge each day's class periods into one "school" block per continuous stretch (gaps ≤ 30 min). */
export function schoolBlocks(periods: { day: number; start: string; end: string }[]): Busy[] {
  const out: Busy[] = []
  for (let d = 0; d < 7; d++) {
    const ps = periods.filter((p) => p.day === d).sort((a, b) => mins(a.start)! - mins(b.start)!)
    for (const p of ps) {
      const last = out[out.length - 1]
      if (last && last.day === d && mins(p.start)! - mins(last.end)! <= 30) last.end = mins(p.end)! > mins(last.end)! ? p.end : last.end
      else out.push({ day: d, start: p.start, end: p.end, label: 'school' })
    }
  }
  return out
}

/** How many of the study plan's sessions the student ticked off (their own data; never shown to staff). */
export function planAdherence(
  tasks: Task[],
  completions: { task_id: string; completion_date: string; completed: boolean }[],
  fromISO: string,
  toISO: string,
) {
  const planned = tasks.filter((t) => t.category === 'study' && (t.description ?? '').startsWith(PLAN_MARK))
  if (!planned.length) return null
  let scheduled = 0
  const from = Date.parse(`${fromISO}T12:00:00Z`)
  const to = Date.parse(`${toISO}T12:00:00Z`)
  for (let t = from; t <= to; t += 86400000) {
    const dow = new Date(t).getUTCDay()
    scheduled += planned.filter((p) => p.day_of_week === dow).length
  }
  const ids = new Set(planned.map((p) => p.id))
  const done = completions.filter((c) => c.completed && ids.has(c.task_id) && c.completion_date >= fromISO && c.completion_date <= toISO).length
  return { sessions: planned.length, scheduled, done, rate: scheduled ? Math.round((done / scheduled) * 100) : null }
}
