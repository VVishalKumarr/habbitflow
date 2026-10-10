// Phase 6 tests: saving AI changes, history and undo, what the AI may know,
// and the timetable-ai function (gating, metering, refunds). Runs against the
// real project. Without ANTHROPIC_API_KEY the model calls are refused as
// 'ai_not_configured' and refunded; everything else is fully exercised.
//   node --env-file=.env tests/timetable-ai.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, day, fn, individual, one, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('AI timetable tests')

const W = await buildSchool(suffix)
const { owner, instA, principal, s1, s2, maths, class10a, subjT } = W

const apply = (c, tracker, ops, base = null, extra = {}) =>
  c.rpc('apply_timetable_change', { p_tracker: tracker, p_new_name: extra.name ?? null, p_base_version: base, p_source: extra.source ?? 'voice', p_summary: extra.summary ?? 'test change', p_ops: ops })
const version = async (c, t) => one(c.rpc('timetable_version', { p_tracker: t }))
const usageRows = (id, feature) => adminSql(`select status from public.ai_usage where user_id = '${id}' and feature = '${feature}' order by created_at`)
const gift = async (plan) => (await one(owner.c.rpc('platform_generate_codes', { p_kind: 'gift', p_plan: plan, p_count: 1, p_duration_days: 30, p_note: `tt ${suffix}` })))[0].code
const NEW_WEEK = [
  { op: 'add_slot', ref: 's0', start: '16:00', end: '17:00' },
  { op: 'add_slot', ref: 's1', start: '17:00', end: '18:00' },
  { op: 'add_task', slot_ref: 's0', day: 6, title: 'Maths revision', category: 'study', description: null },
  { op: 'add_task', slot_ref: 's1', day: 6, title: 'Physics', category: 'study', description: 'chapter 3' },
  { op: 'add_task', slot_ref: 's0', day: 1, title: 'Reading', category: 'personal', description: null },
]

try {
  const u1 = await individual(`ttu1_${suffix}`)
  const u2 = await individual(`ttu2_${suffix}`)
  let tracker
  let slots
  let tasks

  await test('a confirmed proposal is saved as a new timetable in one step, with history', async () => {
    const r = await one(apply(u1.c, null, NEW_WEEK, null, { name: 'AI week', source: 'ai_generate', summary: 'Created AI week' }))
    tracker = r.tracker_id
    slots = await one(u1.c.from('time_slots').select('id, start_time').eq('tracker_id', tracker).order('start_time'))
    tasks = await one(u1.c.from('tasks').select('id, title, day_of_week, time_slot_id').eq('tracker_id', tracker))
    assert.equal(slots.length, 2)
    assert.equal(tasks.length, 3)
    assert.equal(r.version, await version(u1.c, tracker))
    const [h] = await one(u1.c.from('timetable_changes').select('source, summary, inverse').eq('tracker_id', tracker))
    assert.equal(h.source, 'ai_generate')
    assert.equal(h.inverse, null, 'a new timetable is deleted normally, not undone')
  })

  await test('a failing step saves nothing (one transaction)', async () => {
    const before = await version(u1.c, tracker)
    const res = await apply(u1.c, tracker, [
      { op: 'add_task', slot: slots[0].id, day: 2, title: 'Fine', category: 'study', description: null },
      { op: 'add_slot', ref: 'x', start: '16:30', end: '17:30' }, // overlaps
    ], before)
    assert.ok(res.error)
    assert.equal(await version(u1.c, tracker), before)
    const bad = await apply(u1.c, tracker, [{ op: 'add_task', slot: slots[0].id, day: 2, title: 'x', category: 'gaming', description: null }], before)
    assert.ok(bad.error)
    assert.equal(await version(u1.c, tracker), before)
  })

  await test('a proposal made for an older version is refused (STALE_TIMETABLE)', async () => {
    const old = await version(u1.c, tracker)
    await one(u1.c.from('tasks').update({ title: 'Reading – novel' }).eq('id', tasks.find((t) => t.title === 'Reading').id).select('id'))
    const res = await apply(u1.c, tracker, [{ op: 'move_task', task: tasks[0].id, slot: slots[0].id, day: 0 }], old)
    assert.match(res.error?.message ?? '', /STALE_TIMETABLE/)
    assert.match((await apply(u1.c, tracker, [{ op: 'delete_task', task: tasks[0].id }], null)).error?.message ?? '', /STALE_TIMETABLE/, 'base version required')
  })

  await test('nobody can change or read someone else’s timetable through these functions', async () => {
    const v = await version(u1.c, tracker)
    assert.equal(await version(u2.c, tracker), null)
    assert.match((await apply(u2.c, tracker, [{ op: 'delete_task', task: tasks[0].id }], v)).error?.message ?? '', /unknown timetable/)
    // u2's own timetable, but steps pointing at u1's task / slot
    const mine = await one(apply(u2.c, null, [{ op: 'add_slot', ref: 'a', start: '10:00', end: '11:00' }, { op: 'add_task', slot_ref: 'a', day: 1, title: 'Mine', category: 'study', description: null }], null, { name: 'U2' }))
    const mv = await version(u2.c, mine.tracker_id)
    assert.match((await apply(u2.c, mine.tracker_id, [{ op: 'delete_task', task: tasks[0].id }], mv)).error?.message ?? '', /unknown task/)
    assert.match((await apply(u2.c, mine.tracker_id, [{ op: 'add_task', slot: slots[0].id, day: 1, title: 'x', category: 'study', description: null }], mv)).error?.message ?? '', /unknown time slot/)
    assert.match((await apply(u2.c, mine.tracker_id, [{ op: 'drop_table' }], mv)).error?.message ?? '', /unknown step/)
    assert.match((await apply(u2.c, mine.tracker_id, [{ op: 'delete_task', task: tasks[0].id }], mv, { source: 'undo' })).error?.message ?? '', /unknown source/)
    const still = await one(u1.c.from('tasks').select('id').eq('tracker_id', tracker))
    assert.equal(still.length, 3)
    assert.equal((await one(u2.c.from('timetable_changes').select('id').eq('tracker_id', tracker))).length, 0)
    assert.ok((await apply(client0(), null, NEW_WEEK, null, { name: 'anon' })).error, 'signed out')
  })

  await test('history is append-only for the student', async () => {
    const ins = await u1.c.from('timetable_changes').insert({ user_id: u1.id, tracker_id: tracker, source: 'voice', summary: 'forged', ops: [], after_version: 'x' }).select('id')
    assert.ok(ins.error)
    const upd = await u1.c.from('timetable_changes').update({ summary: 'edited' }).eq('tracker_id', tracker).select('id')
    assert.ok(upd.error || upd.data.length === 0)
    const del = await u1.c.from('timetable_changes').delete().eq('tracker_id', tracker).select('id')
    assert.ok(del.error || del.data.length === 0)
  })

  await test('rescheduling moves are undone exactly; only the newest change, only if nothing was edited since', async () => {
    const v0 = await version(u1.c, tracker)
    const maths = tasks.find((t) => t.title === 'Maths revision')
    const phys = tasks.find((t) => t.title === 'Physics')
    const a = await one(apply(u1.c, tracker, [{ op: 'move_task', task: maths.id, slot: slots[0].id, day: 0 }], v0, { source: 'ai_reschedule', summary: 'Moved maths' }))
    const b = await one(apply(u1.c, tracker, [
      { op: 'add_slot', ref: 'n', start: '19:00', end: '20:00' },
      { op: 'add_task', slot_ref: 'n', day: 2, title: 'Guitar', category: 'personal', description: null },
      { op: 'move_task', task: phys.id, slot: slots[1].id, day: 0 },
    ], a.version, { summary: 'Added guitar' }))
    assert.match((await u1.c.rpc('undo_timetable_change', { p_change: a.change_id })).error?.message ?? '', /newer changes first/)
    await one(u1.c.rpc('undo_timetable_change', { p_change: b.change_id }))
    assert.equal(await version(u1.c, tracker), a.version, 'back to exactly the state before')
    assert.match((await u1.c.rpc('undo_timetable_change', { p_change: b.change_id })).error?.message ?? '', /can’t be undone/)
    assert.match((await u2.c.rpc('undo_timetable_change', { p_change: a.change_id })).error?.message ?? '', /unknown change/)
    // edit after the change → undo refused, data untouched
    await one(u1.c.from('tasks').update({ title: 'Maths – algebra' }).eq('id', maths.id).select('id'))
    const edited = await version(u1.c, tracker)
    assert.match((await u1.c.rpc('undo_timetable_change', { p_change: a.change_id })).error?.message ?? '', /edited after this change/)
    assert.equal(await version(u1.c, tracker), edited)
    const hist = await one(u1.c.from('timetable_changes').select('source, undone_at, undo_of').eq('tracker_id', tracker).order('created_at'))
    assert.deepEqual(hist.map((h) => h.source), ['ai_generate', 'ai_reschedule', 'voice', 'undo'])
    assert.ok(hist[2].undone_at)
  })

  await test('saved needs-check answers are private', async () => {
    await one(u1.c.from('timetable_preferences').upsert({ answers: { wake: '06:30', goals: ['Fitness'] } }, { onConflict: 'user_id' }).select('user_id'))
    assert.equal((await one(u2.c.from('timetable_preferences').select('answers'))).length, 0)
    assert.equal((await one(u1.c.from('timetable_preferences').select('answers').single())).answers.wake, '06:30')
    assert.ok((await u2.c.from('timetable_preferences').insert({ user_id: u1.id, answers: {} })).error)
    const big = await u1.c.from('timetable_preferences').upsert({ answers: { extra: 'x'.repeat(20000) } }, { onConflict: 'user_id' })
    assert.ok(big.error, 'size limited')
  })

  await test('the AI context: the student’s own class periods, deadlines and exams; nothing for others', async () => {
    await adminSql(`
      insert into public.class_periods (institution_id, class_id, day_of_week, start_time, end_time, subject_id, label) values
        ('${instA}', '${class10a}', 1, '08:00', '09:00', '${maths}', null), ('${instA}', '${class10a}', 1, '09:00', '13:30', null, 'Block');
      insert into public.assignments (institution_id, class_id, subject_id, teacher_id, title, opens_at, due_at)
        values ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Algebra sheet', now(), '${day(3, 10)}');
      insert into public.calendar_events (institution_id, kind, title, starts_on, ends_on, class_id, subject_id)
        values ('${instA}', 'exam', 'Unit test', current_date + 5, current_date + 5, '${class10a}', '${maths}');
    `)
    const c1 = await one(s1.c.rpc('my_timetable_context'))
    assert.equal(c1.student, true)
    assert.equal(c1.periods.length, 2)
    assert.equal(c1.periods[0].subject, 'Mathematics')
    assert.equal(c1.deadlines[0].title, 'Algebra sheet')
    assert.equal(c1.exams[0].subject, 'Mathematics')
    const c2 = await one(s2.c.rpc('my_timetable_context'))
    assert.equal(c2.periods.length + c2.deadlines.length + c2.exams.length, 0, '10 B sees nothing of 10 A')
    const cu = await one(u1.c.rpc('my_timetable_context'))
    assert.equal(cu.student, false)
  })

  // ---- the Edge Function ----
  await test('the function needs a signed-in user', async () => {
    assert.equal((await fn('timetable-ai', { action: 'evaluate', tracker_id: tracker })).status, 401)
    assert.equal((await fn('timetable-ai', { action: 'nope' }, u1.c)).status, 400)
  })

  await test('Free plan: AI timetable builder refused before anything is charged', async () => {
    const r = await fn('timetable-ai', { action: 'generate', answers: {} }, u1.c)
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'feature_disabled')
    assert.equal((await usageRows(u1.id, 'timetable_generate')).length, 0)
  })

  await test('evaluation always returns the computed numbers; the AI part is refunded when unavailable', async () => {
    const r = await fn('timetable-ai', { action: 'evaluate', tracker_id: tracker, request_id: `ev-${suffix}` }, u1.c)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.evaluation.by_day.length, 7)
    assert.ok(r.body.evaluation.total_minutes > 0)
    if (r.body.advice === null) {
      assert.equal(r.body.ai.code, 'ai_not_configured')
      assert.deepEqual((await usageRows(u1.id, 'timetable_evaluate')).map((x) => x.status), ['refunded'])
    } else {
      assert.deepEqual((await usageRows(u1.id, 'timetable_evaluate')).map((x) => x.status), ['succeeded'])
    }
    assert.equal((await fn('timetable-ai', { action: 'evaluate', tracker_id: tracker }, u2.c)).status, 404, 'someone else’s timetable')
  })

  await test('rescheduling: displaced activities get valid free cells; never saved by the function', async () => {
    const v = await version(u1.c, tracker)
    const r = await fn('timetable-ai', { action: 'reschedule', tracker_id: tracker, event: { label: 'Match', days: [0, 6], start: '15:30', end: '18:00' } }, u1.c)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.version, v)
    assert.equal(r.body.displaced, 2)
    for (const m of r.body.moves) {
      assert.ok(m.to, 'free time exists')
      assert.ok(!([0, 6].includes(m.to.day) && m.to.start < '18:00' && m.to.end > '15:30'), 'not during the event')
    }
    assert.equal(await version(u1.c, tracker), v, 'nothing changed until confirmed')
    const bad = await fn('timetable-ai', { action: 'reschedule', tracker_id: tracker, event: { days: [], start: '10:00', end: '09:00' } }, u1.c)
    assert.equal(bad.status, 400)
    // confirm what was proposed
    const moved = await one(apply(u1.c, tracker, r.body.moves.map((m) => ({ op: 'move_task', task: m.task_id, slot: m.to.slot_id, day: m.to.day })), r.body.version, { source: 'ai_reschedule' }))
    assert.ok(moved.change_id)
  })

  await test('commands: metered as voice commands and refunded when the AI is unavailable; quota limits refuse', async () => {
    const r = await fn('timetable-ai', { action: 'command', text: 'add maths revision tomorrow 6 pm', today: '2026-10-14', request_id: `cmd-${suffix}` }, u1.c)
    if (r.status === 200) {
      assert.equal(r.body.command.type, 'add_task')
    } else {
      assert.equal(r.status, 503)
      assert.equal(r.body.code, 'ai_not_configured')
      assert.deepEqual((await usageRows(u1.id, 'voice_command')).map((x) => x.status), ['refunded'])
    }
    await adminSql(`select public.ai_finish((public.ai_begin('${u2.id}', 'voice_command', null, 10) ->> 'usage_id')::uuid, true, 10, 10, null, 'test', null) from generate_series(1, 10)`)
    const lim = await fn('timetable-ai', { action: 'command', text: 'open progress' }, u2.c)
    assert.equal(lim.status, 429)
    assert.equal(lim.body.code, 'quota_exceeded')
    assert.ok(lim.body.resets_at)
  })

  await test('Plus plan and licensed school students may use the builder', async () => {
    await one(u2.c.rpc('redeem_code', { p_code: await gift('plus') }))
    const r = await fn('timetable-ai', { action: 'generate', answers: { wake: '06:30', sleep: '22:00', goals: ['Fitness'] }, request_id: `gen-${suffix}` }, u2.c)
    assert.notEqual(r.status, 403, JSON.stringify(r.body))
    if (r.status === 200) assert.ok(Array.isArray(r.body.proposal.entries))
    else assert.equal(r.body.code, 'ai_not_configured')
    const key = (await one(owner.c.rpc('platform_generate_codes', { p_kind: 'institution', p_plan: 'pro', p_count: 1, p_duration_days: 365, p_institution: instA })))[0].code
    await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: key }))
    const s = await fn('timetable-ai', { action: 'generate', answers: {} }, s1.c)
    assert.notEqual(s.status, 403, JSON.stringify(s.body))
  })
} finally {
  await adminSql(`delete from public.license_codes where note = 'tt ${suffix}' or institution_id in (select id from public.institutions where name like '%${suffix}')`).catch(() => {})
  if (!process.env.KEEP) await cleanup(suffix)
}

function client0() {
  return { rpc: (...a) => import('./helpers.mjs').then((h) => h.client().rpc(...a)) }
}
console.log(`\n${passedCount()} passed`)
