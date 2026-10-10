// Phase 6 unit tests: the timetable rules every AI answer passes through
// (no network). Run: node tests/timetable-core.test.mjs
import assert from 'node:assert/strict'
import {
  affectedTasks, evaluateTimetable, freeCells, localCommand, matchTask, movesToOps, normalizeCommand, planMoves, proposalToOps, validateProposal,
} from '../supabase/functions/_shared/timetable-core.ts'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
  }
}
console.log('Timetable core')

const school = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '14:00', label: 'school' }))

test('a valid proposal passes unchanged (slots sorted, unused slots removed)', () => {
  const { proposal, dropped } = validateProposal({
    slots: [{ start: '18:00', end: '19:00' }, { start: '16:00', end: '17:00' }, { start: '20:00', end: '20:30' }],
    entries: [
      { slot: 0, day: 1, title: 'Maths revision', category: 'study', note: '' },
      { slot: 1, day: 1, title: 'Football', category: 'exercise', note: 'bring water' },
    ],
  }, { busy: school })
  assert.deepEqual(dropped, [])
  assert.deepEqual(proposal.slots, [{ start: '16:00', end: '17:00' }, { start: '18:00', end: '19:00' }])
  assert.equal(proposal.entries.find((e) => e.title === 'Football').slot, 0)
  assert.equal(proposal.entries.find((e) => e.title === 'Maths revision').slot, 1)
})

test('overlapping slots, school clashes, double-booked cells and bad values are removed with reasons', () => {
  const { proposal, dropped } = validateProposal({
    slots: [{ start: '13:00', end: '15:00' }, { start: '14:30', end: '15:30' }, { start: '16:00', end: '17:00' }, { start: '25:00', end: '26:00' }, { start: '17:00', end: '17:05' }],
    entries: [
      { slot: 0, day: 2, title: 'During school', category: 'study', note: '' },
      { slot: 0, day: 0, title: 'Sunday is free', category: 'study', note: '' },
      { slot: 2, day: 3, title: 'A', category: 'study', note: '' },
      { slot: 2, day: 3, title: 'B', category: 'study', note: '' },
      { slot: 1, day: 3, title: 'Lost slot', category: 'study', note: '' },
      { slot: 2, day: 9, title: 'Bad day', category: 'study', note: '' },
      { slot: 2, day: 4, title: 'x'.repeat(300), category: 'gaming', note: '' },
    ],
  }, { busy: school })
  const reasons = dropped.map((d) => d.reason).join(' | ')
  assert.match(reasons, /overlaps another time slot/)
  assert.match(reasons, /invalid time/)
  assert.match(reasons, /10 minutes to 4 hours/)
  assert.match(reasons, /clashes with school/)
  assert.match(reasons, /two activities at the same time/)
  assert.match(reasons, /time slot was removed/)
  assert.match(reasons, /missing title or day/)
  assert.deepEqual(proposal.entries.map((e) => e.title.slice(0, 6)).sort(), ['A', 'Sunday', 'xxxxxx'])
  const long = proposal.entries.find((e) => e.title.startsWith('x'))
  assert.equal(long.title.length, 100)
  assert.equal(long.category, 'other')
})

test('waking hours are respected and existing slots are never overlapped', () => {
  const { proposal, dropped } = validateProposal({
    slots: [{ start: '05:00', end: '06:00' }, { start: '22:00', end: '23:00' }, { start: '19:00', end: '20:00' }, { start: '17:00', end: '18:00' }],
    entries: [0, 1, 2, 3].map((slot) => ({ slot, day: 6, title: `S${slot}`, category: 'study', note: '' })),
  }, { wake: '06:30', sleep: '22:00', existing: [{ id: 'x', start_time: '17:30:00', end_time: '18:30:00' }] })
  assert.deepEqual(proposal.entries.map((e) => e.title), ['S2'])
  assert.equal(dropped.filter((d) => d.reason === 'outside your waking hours').length, 2)
  assert.equal(dropped.filter((d) => d.reason === 'overlaps another time slot').length, 1)
})

test('garbage from the model never throws', () => {
  for (const raw of [null, undefined, 'text', 42, { slots: 'x', entries: {} }, { slots: [null], entries: [null] }]) {
    const { proposal } = validateProposal(raw)
    assert.deepEqual(proposal, { slots: [], entries: [] })
  }
})

test('a proposal becomes add_slot / add_task steps', () => {
  const ops = proposalToOps({ slots: [{ start: '16:00', end: '17:00' }], entries: [{ slot: 0, day: 2, title: 'Read', category: 'study', note: '' }] })
  assert.deepEqual(ops, [
    { op: 'add_slot', ref: 's0', start: '16:00', end: '17:00' },
    { op: 'add_task', slot_ref: 's0', day: 2, title: 'Read', category: 'study', description: null },
  ])
})

const slots = [
  { id: 'a', start_time: '15:00:00', end_time: '17:00:00' },
  { id: 'b', start_time: '17:00:00', end_time: '19:00:00' },
  { id: 'c', start_time: '19:00:00', end_time: '21:00:00' },
  { id: 'd', start_time: '23:00:00', end_time: '23:45:00' },
  { id: 'e', start_time: '06:00:00', end_time: '06:30:00' },
]
const task = (id, slot, day, title, category = 'study') => ({ id, time_slot_id: slot, day_of_week: day, title, category })

test('evaluation: hours per category and day, overload, no breaks, late nights, clashes, exams, unused slots', () => {
  const tasks = [
    task('1', 'a', 1, 'Maths'), task('2', 'b', 1, 'Physics'), task('3', 'c', 1, 'Chemistry'), task('4', 'd', 1, 'Biology'),
    task('5', 'a', 2, 'Gym', 'exercise'), task('5b', 'a', 2, 'Also gym', 'exercise'),
  ]
  const ev = evaluateTimetable(slots, tasks, {
    busy: [{ day: 2, start: '08:00', end: '15:30', label: 'school' }],
    exams: [{ title: 'History test', subject: 'History', starts_on: '2026-10-20' }, { title: 'Maths', subject: 'Mathematics', starts_on: '2026-10-21' }, { title: 'Old', subject: 'Art', starts_on: '2026-12-25' }],
    today: '2026-10-12',
  })
  assert.equal(ev.by_day[1].minutes, 6 * 60 + 45)
  assert.equal(ev.by_category.exercise, 120, 'a cell with two tasks counts once')
  assert.equal(ev.total_minutes, 6 * 60 + 45 + 120)
  const kinds = ev.findings.map((f) => f.kind)
  for (const k of ['overloaded_day', 'no_breaks', 'late_night', 'school_clash', 'exam_unprepared', 'unused_slot']) assert.ok(kinds.includes(k), `missing ${k}: ${kinds}`)
  const exams = ev.findings.filter((f) => f.kind === 'exam_unprepared').map((f) => f.message).join(' ')
  assert.match(exams, /History exam in 8 days/)
  assert.doesNotMatch(exams, /Mathematics/, 'Maths revision counts for Mathematics')
  assert.doesNotMatch(exams, /Art/, 'exams far away are ignored')
  assert.deepEqual(ev.empty_slots, ['06:00–06:30'])
})

test('evaluation of a balanced week finds nothing serious', () => {
  const ev = evaluateTimetable(slots.slice(0, 2), [task('1', 'a', 1, 'Maths'), task('2', 'b', 3, 'Run', 'exercise'), task('3', 'a', 5, 'Read')], {})
  assert.deepEqual(ev.findings.filter((f) => f.severity !== 'low'), [])
})

test('rescheduling: affected tasks, free cells outside the event, nearest-time plan, steps', () => {
  const tasks = [task('1', 'a', 6, 'Maths'), task('2', 'b', 6, 'Physics'), task('3', 'c', 6, 'Reading'), task('4', 'a', 0, 'Sunday maths')]
  const event = { label: 'Football match', days: [6], start: '16:00', end: '18:00' }
  const hit = affectedTasks(slots, tasks, event)
  assert.deepEqual(hit.map((t) => t.id).sort(), ['1', '2'])
  const cells = freeCells(slots, tasks, event, [{ day: 1, start: '08:00', end: '23:59', label: 'school' }])
  assert.ok(!cells.some((c) => c.day === 6 && (c.slot_id === 'a' || c.slot_id === 'b')), 'nothing during the event')
  assert.ok(!cells.some((c) => c.id === 'a|0'), 'occupied cells are not free')
  assert.ok(!cells.some((c) => c.day === 1 && ['a', 'b', 'c', 'd'].includes(c.slot_id)), 'nothing during fixed commitments')
  const moves = planMoves(slots, hit, cells)
  assert.equal(moves.length, 2)
  assert.ok(moves.every((m) => m.to))
  assert.notEqual(moves[0].to.id, moves[1].to.id, 'each free cell used once')
  const physics = moves.find((m) => m.task_id === '2')
  assert.equal(physics.to.slot_id, 'b', 'same time on another day first')
  assert.deepEqual(movesToOps(moves).map((o) => o.op), ['move_task', 'move_task'])
})

test('rescheduling with no free time leaves tasks where they are', () => {
  const moves = planMoves(slots, [task('1', 'a', 6, 'Maths')], [])
  assert.equal(moves[0].to, null)
  assert.deepEqual(movesToOps(moves), [])
})

test('commands from the model are validated; anything off becomes "unknown"', () => {
  assert.deepEqual(normalizeCommand({ type: 'add_task', title: ' Maths  revision ', day: 1, start: '18:00', end: null, category: 'study' }),
    { type: 'add_task', title: 'Maths revision', day: 1, start: '18:00', end: '19:00', category: 'study' })
  assert.equal(normalizeCommand({ type: 'add_task', title: 'x', day: 9, start: '18:00' }).type, 'unknown')
  assert.equal(normalizeCommand({ type: 'add_task', title: 'x', day: 1, start: '18:00', end: '17:00' }).type, 'unknown')
  assert.equal(normalizeCommand({ type: 'delete_account' }).type, 'unknown')
  assert.equal(normalizeCommand({ type: 'open', page: 'admin' }).type, 'unknown')
  assert.deepEqual(normalizeCommand({ type: 'start_focus', minutes: 9999, label: '' }), { type: 'start_focus', minutes: 25, label: 'Focus' })
  assert.equal(normalizeCommand({ type: 'move_unfinished', from_day: 2, to_day: 2 }).type, 'unknown')
  assert.equal(normalizeCommand(null).type, 'unknown')
})

test('offline parser handles the example phrases (today = Wednesday)', () => {
  const W = 3
  assert.deepEqual(localCommand('Add maths revision tomorrow 6 pm', W), { type: 'add_task', title: 'Maths revision', day: 4, start: '18:00', end: '19:00', category: 'study' })
  assert.deepEqual(localCommand('add football on Saturday from 4 pm to 6 pm', W), { type: 'add_task', title: 'Football', day: 6, start: '16:00', end: '18:00', category: 'exercise' })
  assert.deepEqual(localCommand("Move today's unfinished tasks to Saturday", W), { type: 'move_unfinished', from_day: 3, to_day: 6 })
  assert.deepEqual(localCommand('start a 25-minute focus session', W), { type: 'start_focus', minutes: 25, label: 'Focus' })
  assert.deepEqual(localCommand('start a 40 minute focus timer on chemistry', W), { type: 'start_focus', minutes: 40, label: 'Chemistry' })
  assert.deepEqual(localCommand('mark reading done', W), { type: 'mark_done', task: 'reading', day: 3 })
  assert.deepEqual(localCommand("what's due this week?", W), { type: 'whats_due', range: 'week' })
  assert.deepEqual(localCommand('open my timetable', W), { type: 'open', page: 'timetable' })
  assert.deepEqual(localCommand('move physics to friday', W), { type: 'move_task', task: 'physics', to_day: 5, start: null })
  assert.equal(localCommand('delete my account', W).type, 'unknown')
})

test('spoken task names match the right task', () => {
  const ts = [{ title: 'Reading – novel' }, { title: 'Maths revision' }, { title: 'Evening walk' }]
  assert.equal(matchTask('reading', ts).title, 'Reading – novel')
  assert.equal(matchTask('my maths', ts).title, 'Maths revision')
  assert.equal(matchTask('guitar', ts), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
