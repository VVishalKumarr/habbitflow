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
