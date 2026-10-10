// AI timetable assistant.
// POST { action, request_id?, ... }  (signed in)
//   generate   { answers }                 → proposal (needs ai_guided_timetable; metered 'timetable_generate')
//   evaluate   { tracker_id }              → numbers + findings (always) and advice (metered 'timetable_evaluate')
//   reschedule { tracker_id, event }       → moves for displaced tasks (metered 'reschedule'; greedy plan without AI)
//   command    { text, today, now }        → one app action (metered 'voice_command')
// Nothing is saved here: the app shows the proposal and saves it with
// apply_timetable_change() only after the student confirms.
// The model gets the minimum: timetable titles/times, the student's answers,
// class period times and subjects, deadline/exam titles and dates. Never
// names, emails, the school's name, marks or attendance.
import Anthropic from 'npm:@anthropic-ai/sdk'
import { beginAi, finishAi, quotaInfo, quotaResponse, requestId, type AiFeature, type QuotaGranted, type QuotaRefused } from '../_shared/ai-quota.ts'
import { adminClient, env, json, preflight, rateLimited, readJson, userFromRequest } from '../_shared/http.ts'
import {
  affectedTasks, CATEGORIES, DAYS, evaluateTimetable, freeCells, mins, normalizeCommand, planMoves, validateProposal,
  type Busy, type Move, type RescheduleEvent, type Slot, type Task,
} from '../_shared/timetable-core.ts'

const MODEL = env('AI_MODEL') || 'claude-opus-5-5'
// A whole week as JSON plus the model's reasoning doesn't fit in the chat
// answer limit, so generation has its own floor.
const GENERATE_MIN_TOKENS = 12000

type Json = Record<string, unknown>
type Ctx = {
  student: boolean
  periods: { day: number; start: string; end: string; subject: string | null }[]
  deadlines: { title: string; subject: string | null; kind: string; due_at: string }[]
  exams: { title: string; subject: string | null; starts_on: string; ends_on: string; start: string | null; end: string | null }[]
  holidays: { title: string; starts_on: string; ends_on: string }[]
}

class AiFailure extends Error {
  constructor(public code: string, message: string, public status = 503) {
    super(message)
  }
}

/** One metered model call with a JSON-schema answer. Refunds on any failure. */
async function askModel(q: QuotaGranted, opts: { system: string; user: string; schema: Json; effort: 'low' | 'medium'; maxTokens: number }): Promise<Json> {
  if (!env('ANTHROPIC_API_KEY')) {
    await finishAi(q.usage_id, false, { error: 'not configured' })
    throw new AiFailure('ai_not_configured', 'The AI assistant isn’t configured.')
  }
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 0, timeout: 120_000 })
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: opts.user }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming)
    const u = response.usage
    const measured = {
      tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokensOut: u.output_tokens,
      model: response.model,
    }
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      await finishAi(q.usage_id, false, { ...measured, error: String(response.stop_reason) })
      throw new AiFailure('ai_unavailable', response.stop_reason === 'refusal' ? 'The AI couldn’t help with this request.' : 'The answer was too long. Try asking for less.')
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    let parsed: Json
    try {
      parsed = JSON.parse(text) as Json
    } catch {
      await finishAi(q.usage_id, false, { ...measured, error: 'invalid json' })
      throw new AiFailure('ai_unavailable', 'The AI gave an unreadable answer. Please try again.')
    }
    await finishAi(q.usage_id, true, measured)
    return parsed
  } catch (e) {
    if (e instanceof AiFailure) throw e
    await finishAi(q.usage_id, false, { error: e instanceof Error ? e.message : String(e) })
    if (e instanceof Anthropic.RateLimitError) throw new AiFailure('ai_unavailable', 'The AI is busy right now. Please try again shortly.')
    if (e instanceof Anthropic.APIError) console.error('timetable-ai API error', e.status, e.message)
    else console.error('timetable-ai error', String(e))
    throw new AiFailure('ai_unavailable', 'The AI is unavailable right now.')
  }
}

/** Refusals and failures as a value, so evaluate/reschedule can still answer without AI. */
type AiOutcome = { ok: true; data: Json; quota: QuotaGranted } | { ok: false; refused?: QuotaRefused; code: string; error: string; status: number }

async function metered(userId: string, feature: AiFeature, rid: string, inputChars: number, call: (q: QuotaGranted) => Promise<Json>): Promise<AiOutcome> {
  const q = await beginAi(userId, feature, rid, inputChars)
  if (!q.ok) return { ok: false, refused: q, code: q.code, error: q.error, status: 429 }
  try {
    return { ok: true, data: await call(q), quota: q }
  } catch (e) {
    const f = e instanceof AiFailure ? e : new AiFailure('ai_unavailable', 'The AI is unavailable right now.')
    return { ok: false, code: f.code, error: f.message, status: f.status }
  }
}
const aiNote = (o: AiOutcome) => (o.ok ? null : { ...(o.refused ?? {}), code: o.code, error: o.error })

// ---------------------------------------------------------------------------
const day = (n: number) => DAYS[n]
const t5 = (t: string) => t.slice(0, 5)

function schoolBusy(ctx: Ctx): Busy[] {
  // Merge each day's periods into one "school" block per continuous stretch (gaps ≤ 30 min).
  const out: Busy[] = []
  for (let d = 0; d < 7; d++) {
    const ps = ctx.periods.filter((p) => p.day === d).sort((a, b) => mins(a.start)! - mins(b.start)!)
    for (const p of ps) {
      const last = out[out.length - 1]
      if (last && last.day === d && mins(p.start)! - mins(last.end)! <= 30) last.end = mins(p.end)! > mins(last.end)! ? p.end : last.end
      else out.push({ day: d, start: p.start, end: p.end, label: 'school' })
    }
  }
  return out
}

interface Answers {
  goals?: string[]
  focus_subjects?: string[]
  commitments?: { label: string; days: number[]; start: string; end: string }[]
  wake?: string
  sleep?: string
  school_days?: number[]
  school_start?: string
  school_end?: string
  best_focus?: string
  study_hours?: string
  keep?: string
  drop?: string
  extra?: string
}

function cleanAnswers(raw: unknown): Answers {
  const a = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : undefined)
  const list = (v: unknown, n = 8) => (Array.isArray(v) ? v.map((x) => str(x, 60)).filter((x): x is string => !!x).slice(0, n) : undefined)
  const days = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : undefined)
  const time = (v: unknown) => (mins(v) !== null ? t5(String(v).padStart(5, '0')) : undefined)
  const commitments = Array.isArray(a.commitments)
    ? a.commitments
        .map((c) => {
          const x = c as Record<string, unknown>
          return { label: str(x.label, 60) ?? '', days: days(x.days) ?? [], start: time(x.start) ?? '', end: time(x.end) ?? '' }
        })
        .filter((c) => c.label && c.days.length && c.start && c.end && mins(c.end)! > mins(c.start)!)
        .slice(0, 10)
    : undefined
  return {
    goals: list(a.goals), focus_subjects: list(a.focus_subjects), commitments,
    wake: time(a.wake), sleep: time(a.sleep), school_days: days(a.school_days), school_start: time(a.school_start), school_end: time(a.school_end),
    best_focus: str(a.best_focus, 40), study_hours: str(a.study_hours, 40), keep: str(a.keep), drop: str(a.drop), extra: str(a.extra, 500),
  }
}

// ---------------------------------------------------------------------------
const GENERATE_SYSTEM = `You build weekly personal timetables for students in HabitFlow, a habit tracker.

The timetable is a grid: a list of time slots (rows, the same for every day of the week, never overlapping) and activities placed in a (slot, day) cell. Days are numbers: 0 = Sunday … 6 = Saturday. Times are 24-hour "HH:MM".

Rules:
- Never place anything during school, fixed commitments, or outside the student's waking hours. These are listed as busy times; the app removes anything that clashes.
- Include the student's fixed commitments (tuition, sports, chores) as activities in their own slots so the timetable is complete, unless they fall in school time.
- Leave real breaks: at most about 2 hours of back-to-back activities; add meals, rest or free time where it helps. Keep total planned time outside school realistic (usually under 5 hours on school days).
- Give more time to the subjects and goals the student says matter most, and to subjects with exams or deadlines coming up; put demanding study at their best focus time.
- Keep one lighter day. Respect what they want to keep or drop.
- Activity titles are short and specific ("Maths revision: algebra", "Football practice", "Free time"). category is one of study, exercise, work, personal, other. note is a short tip or empty.
- If something they asked for can't fit (too many hours, clashes, impossible times), still build the best timetable you can and explain what couldn't fit in "impossible".
- "choices" explains in plain language what you chose to include and why (3–6 items). "summary" is one or two sentences.`

const GENERATE_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['timetable_name', 'summary', 'choices', 'impossible', 'slots', 'entries'],
  properties: {
    timetable_name: { type: 'string' },
    summary: { type: 'string' },
    choices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'why'], properties: { what: { type: 'string' }, why: { type: 'string' } } } },
    impossible: { type: 'array', items: { type: 'string' } },
    slots: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } } },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'day', 'title', 'category', 'note'],
        properties: { slot: { type: 'integer' }, day: { type: 'integer' }, title: { type: 'string' }, category: { type: 'string', enum: CATEGORIES }, note: { type: 'string' } },
      },
    },
  },
}

const EVALUATE_SYSTEM = `You review a student's weekly timetable in HabitFlow and give short, kind, practical advice.

You get the timetable, numbers already computed by the app (minutes per category and per day) and findings the app detected. Don't recalculate or contradict the numbers. Base advice on them: overloaded days, missing breaks, late nights, clashes with school, exams without revision, unused time. Suggest concrete changes ("Move Thursday's 21:00 study to the free 17:00 slot"). Never praise a schedule that leaves no time for sleep, meals or rest. Plain language for a teenager; no headings.

"summary": one or two sentences overall. "advice": 2–6 items, most important first.`

const EVALUATE_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'advice'],
  properties: {
    summary: { type: 'string' },
    advice: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } } },
  },
}

const RESCHEDULE_SYSTEM = `You help a student in HabitFlow move activities that an event displaces in their weekly timetable.

You get the event, the displaced activities and the free cells (ids) they could move to. For each displaced activity choose one free cell id, or null to leave it where it is. Use each cell at most once. Prefer: the same time on a nearby day, keeping study before the related deadline/exam, not stacking more than about 2 hours back to back, not making one day much heavier than others, and not late at night. "explanation": one or two sentences on the overall plan. Each "reason" is a few words.`

const RESCHEDULE_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'moves'],
  properties: {
    explanation: { type: 'string' },
    moves: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['task_id', 'cell', 'reason'], properties: { task_id: { type: 'string' }, cell: { type: ['string', 'null'] }, reason: { type: 'string' } } },
    },
  },
}

const COMMAND_SYSTEM = `You turn one short spoken or typed instruction from a student into exactly one HabitFlow action. You never perform it; the app shows it to the student to confirm.

Actions (fill every field of the chosen action; days are 0 = Sunday … 6 = Saturday, resolve "today", "tomorrow", weekday names from the date given; times are 24-hour "HH:MM"):
- add_task: add a weekly activity. title, day, start, end (if no end is said, one hour after start), category (study, exercise, work, personal, other).
- move_unfinished: move the not-yet-done activities of one day to another day. from_day, to_day.
- move_task: move one activity (task = its name as said) to another day, optionally a start time (or null).
- start_focus: start a focus timer. minutes (default 25), label (what they'll work on, or "Focus").
- mark_done: mark one activity done. task (its name as said), day (usually today).
- whats_due: list what's due. range "today" or "week".
- open: open a page. page is one of timetable, progress, focus, friends, settings, school, goals, help, assistant.
- unknown: anything else, or something unclear or not allowed (deleting accounts, changing passwords, messaging people, payments, editing school timetables or marks). reason: one short sentence telling the student what you can do.

Answer with the action object only, in "action".`

const COMMAND_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'title', 'day', 'start', 'end', 'category', 'from_day', 'to_day', 'task', 'minutes', 'label', 'range', 'page', 'reason'],
      properties: {
        type: { type: 'string', enum: ['add_task', 'move_unfinished', 'move_task', 'start_focus', 'mark_done', 'whats_due', 'open', 'unknown'] },
        title: { type: ['string', 'null'] },
        day: { type: ['integer', 'null'] },
        start: { type: ['string', 'null'] },
        end: { type: ['string', 'null'] },
        category: { type: ['string', 'null'] },
        from_day: { type: ['integer', 'null'] },
        to_day: { type: ['integer', 'null'] },
        task: { type: ['string', 'null'] },
        minutes: { type: ['integer', 'null'] },
        label: { type: ['string', 'null'] },
        range: { type: ['string', 'null'] },
        page: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
      },
    },
  },
}

// ---------------------------------------------------------------------------
async function loadTimetable(client: ReturnType<typeof adminClient>, trackerId: unknown) {
  if (typeof trackerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(trackerId)) return null
  // The caller's own client: RLS returns nothing for someone else's timetable.
  const [tr, sl, tk, ver] = await Promise.all([
    client.from('trackers').select('id, name').eq('id', trackerId).maybeSingle(),
    client.from('time_slots').select('id, start_time, end_time').eq('tracker_id', trackerId),
    client.from('tasks').select('id, time_slot_id, day_of_week, title, category, description').eq('tracker_id', trackerId),
    client.rpc('timetable_version', { p_tracker: trackerId }),
  ])
  if (tr.error || !tr.data || sl.error || tk.error) return null
  return { tracker: tr.data as { id: string; name: string }, slots: sl.data as Slot[], tasks: tk.data as Task[], version: ver.data as string }
}

const timetableText = (slots: Slot[], tasks: Task[]) => {
  const byId = new Map(slots.map((s) => [s.id, s]))
  return [...tasks]
    .sort((a, b) => a.day_of_week - b.day_of_week || (mins(byId.get(a.time_slot_id)?.start_time) ?? 0) - (mins(byId.get(b.time_slot_id)?.start_time) ?? 0))
    .map((t) => {
      const s = byId.get(t.time_slot_id)
      return s ? `${day(t.day_of_week)} ${t5(s.start_time)}–${t5(s.end_time)} [${t.category}] ${t.title.slice(0, 60)}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

const contextText = (ctx: Ctx, busy: Busy[]) => {
  const lines: string[] = []
  if (busy.length) lines.push('School hours:\n' + busy.filter((b) => b.label === 'school').map((b) => `${day(b.day)} ${b.start}–${b.end}`).join('\n'))
  if (ctx.periods.length) {
    const subjects = [...new Set(ctx.periods.map((p) => p.subject).filter(Boolean))]
    if (subjects.length) lines.push(`School subjects: ${subjects.join(', ')}`)
  }
  if (ctx.deadlines.length) lines.push('Homework due:\n' + ctx.deadlines.map((d) => `${d.due_at.slice(0, 10)} ${d.subject}: ${d.title.slice(0, 60)}`).join('\n'))
  if (ctx.exams.length) lines.push('Exams:\n' + ctx.exams.map((e) => `${e.starts_on}${e.ends_on !== e.starts_on ? ` to ${e.ends_on}` : ''} ${e.subject ?? e.title}`).join('\n'))
  if (ctx.holidays.length) lines.push('Holidays:\n' + ctx.holidays.map((h) => `${h.starts_on}${h.ends_on !== h.starts_on ? ` to ${h.ends_on}` : ''} ${h.title}`).join('\n'))
  return lines.join('\n\n')
}

const EMPTY_CTX: Ctx = { student: false, periods: [], deadlines: [], exams: [], holidays: [] }

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  const body = await readJson<Json>(req)
  if (!body || typeof body !== 'object') return json(req, { error: 'Invalid request.' }, 400)
  const userId = who.user.id
  const rid = requestId(body.request_id)

  if (await rateLimited(userId, 'ai_calls', 240, 3600)) {
    return json(req, { error: 'Too many requests. Please try again a bit later.', code: 'rate_limited' }, 429)
  }
  const today = typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10)
  const loadCtx = async (): Promise<Ctx> => {
    const { data } = await who.client.rpc('my_timetable_context')
    return { ...EMPTY_CTX, ...((data as Ctx) ?? {}) }
  }

  switch (body.action) {
    // -----------------------------------------------------------------------
    case 'generate': {
      const { data: allowed } = await adminClient().rpc('has_feature', { p_user: userId, p_feature: 'ai_guided_timetable' })
      if (!allowed) {
        return json(req, { error: 'The AI timetable builder comes with Plus and Pro.', code: 'feature_disabled', feature: 'timetable_generate' }, 403)
      }
      const answers = cleanAnswers(body.answers)
      const ctx = await loadCtx()
      const busy = schoolBusy(ctx)
      if (!busy.length && answers.school_days?.length && answers.school_start && answers.school_end && mins(answers.school_end)! > mins(answers.school_start)!) {
        for (const d of answers.school_days) busy.push({ day: d, start: answers.school_start, end: answers.school_end, label: 'school' })
      }
      for (const c of answers.commitments ?? []) for (const d of c.days) busy.push({ day: d, start: c.start, end: c.end, label: c.label })
      const answersText = JSON.stringify(answers)
      const user = [
        `Today: ${today} (${day(new Date(today + 'T12:00:00Z').getUTCDay())}).`,
        `The student's answers:\n${answersText}`,
        contextText(ctx, busy),
        busy.length ? 'Busy times (nothing may be placed here except the commitment itself in its own slot):\n' + busy.map((b) => `${day(b.day)} ${b.start}–${b.end} ${b.label}`).join('\n') : '',
      ].filter(Boolean).join('\n\n')

      const q = await beginAi(userId, 'timetable_generate', rid, answersText.length)
      if (!q.ok) return quotaResponse(req, q)
      let out: Json
      try {
        out = await askModel(q, { system: GENERATE_SYSTEM, user, schema: GENERATE_SCHEMA, effort: 'medium', maxTokens: Math.max(q.max_output_tokens, GENERATE_MIN_TOKENS) })
      } catch (e) {
        const f = e as AiFailure
        return json(req, { error: f.message, code: f.code }, f.status)
      }
      // Commitments themselves may sit in their busy time; school may not.
      const blocking = busy.filter((b) => b.label === 'school')
      const { proposal, dropped } = validateProposal(out, { busy: blocking, wake: answers.wake, sleep: answers.sleep })
      // An activity during a commitment is only fine if it *is* that commitment.
      const commitments = busy.filter((b) => b.label !== 'school')
      const kept = proposal.entries.filter((e) => {
        const s = proposal.slots[e.slot]
        const clash = commitments.find((c) => c.day === e.day && mins(s.start)! < mins(c.end)! && mins(c.start)! < mins(s.end)!)
        if (clash && !e.title.toLowerCase().includes(clash.label.toLowerCase().split(' ')[0])) {
          dropped.push({ what: `${e.title} (${day(e.day)} ${s.start})`, reason: `clashes with ${clash.label}` })
          return false
        }
        return true
      })
      const final = validateProposal({ slots: proposal.slots, entries: kept }, {}).proposal
      const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
      return json(req, {
        name: str(out.timetable_name, 60) || 'My AI timetable',
        summary: str(out.summary, 600),
        choices: (Array.isArray(out.choices) ? out.choices : []).slice(0, 8).map((c) => ({ what: str((c as Json).what, 120), why: str((c as Json).why, 300) })),
        impossible: (Array.isArray(out.impossible) ? out.impossible : []).slice(0, 6).map((x) => str(x, 300)).filter(Boolean),
        proposal: final,
        dropped,
        busy: busy.filter((b) => b.label === 'school'),
        quota: quotaInfo(q),
      })
    }

    // -----------------------------------------------------------------------
    case 'evaluate': {
      const tt = await loadTimetable(who.client, body.tracker_id)
      if (!tt) return json(req, { error: 'Timetable not found.' }, 404)
      const ctx = await loadCtx()
      const busy = schoolBusy(ctx)
      const prefs = await who.client.from('timetable_preferences').select('answers').maybeSingle()
      const sleep = (prefs.data?.answers as Answers | undefined)?.sleep ?? null
      const evaluation = evaluateTimetable(tt.slots, tt.tasks, { busy, exams: ctx.exams, deadlines: ctx.deadlines, today, sleep })
      if (!tt.tasks.length) return json(req, { evaluation, advice: null, ai: { code: 'empty', error: 'Add some activities first, then check your timetable.' } })
      const listing = timetableText(tt.slots, tt.tasks)
      const user = [
        `Timetable:\n${listing}`,
        `Numbers (minutes): ${JSON.stringify({ total: evaluation.total_minutes, by_category: evaluation.by_category, by_day: evaluation.by_day.map((d) => ({ day: day(d.day), minutes: d.minutes, study: d.study })) })}`,
        evaluation.findings.length ? `Findings:\n${evaluation.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}` : 'Findings: none',
        contextText(ctx, busy),
      ].filter(Boolean).join('\n\n')
      const o = await metered(userId, 'timetable_evaluate', rid, listing.length, (q) =>
        askModel(q, { system: EVALUATE_SYSTEM, user, schema: EVALUATE_SCHEMA, effort: 'low', maxTokens: q.max_output_tokens }))
      const advice = o.ok
        ? {
            summary: String(o.data.summary ?? '').slice(0, 600),
            items: (Array.isArray(o.data.advice) ? o.data.advice : []).slice(0, 6).map((a) => ({ title: String((a as Json).title ?? '').slice(0, 120), detail: String((a as Json).detail ?? '').slice(0, 400) })),
          }
        : null
      return json(req, { evaluation, advice, ai: aiNote(o), quota: o.ok ? quotaInfo(o.quota) : undefined })
    }

    // -----------------------------------------------------------------------
    case 'reschedule': {
      const tt = await loadTimetable(who.client, body.tracker_id)
      if (!tt) return json(req, { error: 'Timetable not found.' }, 404)
      const e = (body.event ?? {}) as Json
      const days = Array.isArray(e.days) ? [...new Set(e.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : []
      const wholeDay = !e.start || !e.end
      const event: RescheduleEvent = {
        label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 80) : 'Event',
        days,
        start: wholeDay ? null : mins(e.start) !== null ? t5(String(e.start)) : null,
        end: wholeDay ? null : mins(e.end) !== null ? t5(String(e.end)) : null,
      }
      if (!days.length || (!wholeDay && (!event.start || !event.end || mins(event.end)! <= mins(event.start)!))) {
        return json(req, { error: 'Choose the day(s) and a valid time for the event.' }, 400)
      }
      const ctx = await loadCtx()
      const busy = schoolBusy(ctx)
      const displaced = affectedTasks(tt.slots, tt.tasks, event)
      const base = { version: tt.version, event, displaced: displaced.length }
      if (!displaced.length) return json(req, { ...base, moves: [], explanation: 'Nothing in your timetable is affected by this event.', ai: null })
      const candidates = freeCells(tt.slots, tt.tasks, event, busy)
      const greedy = planMoves(tt.slots, displaced, candidates)
      if (!candidates.length) return json(req, { ...base, moves: greedy, explanation: 'There’s no free time in your timetable to move these to.', ai: null })

      const listing = displaced.map((t) => {
        const s = tt.slots.find((x) => x.id === t.time_slot_id)!
        return `${t.id}: ${day(t.day_of_week)} ${t5(s.start_time)}–${t5(s.end_time)} [${t.category}] ${t.title.slice(0, 60)}`
      }).join('\n')
      const cells = candidates.slice(0, 120).map((c) => `${c.id}: ${day(c.day)} ${c.start}–${c.end}`).join('\n')
      const user = [
        `Event: ${event.label}, ${days.map(day).join(', ')}${wholeDay ? ' (whole day)' : ` ${event.start}–${event.end}`}.`,
        `Displaced activities:\n${listing}`,
        `Free cells:\n${cells}`,
        `Rest of the timetable:\n${timetableText(tt.slots, tt.tasks)}`,
        contextText(ctx, busy),
      ].filter(Boolean).join('\n\n')
      const o = await metered(userId, 'reschedule', rid, event.label.length + 40, (q) =>
        askModel(q, { system: RESCHEDULE_SYSTEM, user, schema: RESCHEDULE_SCHEMA, effort: 'low', maxTokens: q.max_output_tokens }))
      if (!o.ok) return json(req, { ...base, moves: greedy, explanation: 'Suggested automatically: each activity goes to the nearest free time.', ai: aiNote(o) })

      // Accept only real displaced tasks and real free cells, each cell once; fall back per task.
      const byCell = new Map(candidates.map((c) => [c.id, c]))
      const used = new Set<string>()
      const chosen = new Map<string, { cell: string | null; reason: string }>()
      for (const m of (Array.isArray(o.data.moves) ? o.data.moves : []) as Json[]) {
        const tid = String(m.task_id ?? '')
        const cell = typeof m.cell === 'string' && byCell.has(m.cell) && !used.has(m.cell) ? m.cell : null
        if (!displaced.some((t) => t.id === tid) || chosen.has(tid)) continue
        if (cell) used.add(cell)
        chosen.set(tid, { cell, reason: String(m.reason ?? '').slice(0, 120) })
      }
      const moves: Move[] = greedy.map((g) => {
        const c = chosen.get(g.task_id)
        if (!c) return g.to && !used.has(g.to.id) ? (used.add(g.to.id), g) : { ...g, to: null, reason: 'No free time slot found — it stays where it is.' }
        return { ...g, to: c.cell ? byCell.get(c.cell)! : null, reason: c.reason || (c.cell ? 'Moved.' : 'Stays where it is.') }
      })
      return json(req, { ...base, moves, explanation: String(o.data.explanation ?? '').slice(0, 400), ai: null, quota: quotaInfo(o.quota) })
    }

    // -----------------------------------------------------------------------
    case 'command': {
      const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
      if (!text) return json(req, { error: 'Say or type a command first.' }, 400)
      const now = typeof body.now === 'string' && mins(body.now) !== null ? t5(body.now) : ''
      const weekday = day(new Date(today + 'T12:00:00Z').getUTCDay())
      const q = await beginAi(userId, 'voice_command', rid, text.length)
      if (!q.ok) return quotaResponse(req, q)
      try {
        const out = await askModel(q, {
          system: COMMAND_SYSTEM,
          user: `Today is ${weekday} ${today}${now ? `, ${now}` : ''}.\nInstruction: ${text}`,
          schema: COMMAND_SCHEMA,
          effort: 'low',
          maxTokens: q.max_output_tokens,
        })
        return json(req, { command: normalizeCommand(out.action), quota: quotaInfo(q) })
      } catch (e) {
        const f = e as AiFailure
        return json(req, { error: f.message, code: f.code }, f.status)
      }
    }

    default:
      return json(req, { error: 'Unknown action.' }, 400)
  }
})

