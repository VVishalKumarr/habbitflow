// Study plan unit tests: how study insights turn into timetable changes
// (no network). Run: node tests/study-plan.test.mjs
import assert from 'node:assert/strict'
import {
  insightSignature, mentionsSubject, planAdherence, planStudyBoost, schoolBlocks, STUDY_BLOCK_MAX,
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
console.log('Study plans')

const slot = (id, start, end) => ({ id, start_time: `${start}:00`, end_time: `${end}:00` })
let n = 0
const task = (slotId, day, title, category = 'study', description = null) => ({ id: `t${++n}`, time_slot_id: slotId, day_of_week: day, title, category, description })
const insight = (subject, status, minutes, extra = {}) => ({
  subject_id: `id-${subject}`, subject, status, recommended_minutes: minutes,
  reasons: [{ kind: status === 'needs_attention' ? 'concern' : 'info', text: `${subject} reason.` }], evidence: { exam: null }, ...extra,
})
const school = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '14:00', label: 'school' }))
const slots = [slot('a', '16:00', '17:00'), slot('b', '17:00', '18:00'), slot('c', '18:30', '19:30'), slot('d', '20:00', '21:00')]

test('subject names match common short forms, not unrelated words', () => {
  assert.ok(mentionsSubject('Maths homework', 'Mathematics'))
  assert.ok(mentionsSubject('math practice', 'Mathematics'))
  assert.ok(mentionsSubject('Bio revision', 'Biology'))
  assert.ok(mentionsSubject('Computer project', 'Computer Science'))
  assert.ok(mentionsSubject('Physics', 'physics'))
  assert.ok(!mentionsSubject('Aftermath of the war', 'Mathematics'))
  assert.ok(!mentionsSubject('Study', 'English'))
})

test('nothing changes when no subject needs more time', () => {
  const plan = planStudyBoost(slots, [task('a', 1, 'Study')], [insight('Maths', 'on_track', 0), insight('English', 'strong', 0)], { maxDailyStudy: 180 })
  assert.equal(plan.changes.length, 0)
  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary, 'Study plan: no changes needed.')
})

test('general study sessions get the weak subject first, and at least half stay free for homework', () => {
  const tasks = [task('a', 1, 'Study'), task('a', 2, 'Homework'), task('a', 3, 'Self study'), task('a', 4, 'Revision')]
  const plan = planStudyBoost(slots, tasks, [insight('Physics', 'needs_attention', 120)], { maxDailyStudy: 180, busy: school })
  const relabels = plan.changes.filter((c) => c.kind === 'relabel')
  assert.equal(relabels.length, 2, 'two of four general sessions')
  assert.ok(relabels.every((c) => c.title === 'Physics practice'))
  assert.equal(plan.changes.length, 2, 'two 60-minute relabels cover 120 minutes; no extra hours')
  assert.ok(plan.ops.every((o) => o.op === 'update_task' && o.category === 'study' && o.description.startsWith('Study plan:')))
  assert.match(plan.summary, /no extra hours/)
  assert.ok(plan.tradeoffs.some((t) => /stay free for homework/.test(t)))
})

test('new sessions go into free cells outside school, within the daily limit, at most one per subject per day', () => {
  const tasks = [task('a', 1, 'Football', 'exercise')]
  const plan = planStudyBoost(slots, tasks, [insight('Chemistry', 'needs_attention', 180)], { maxDailyStudy: 60, busy: school })
  const adds = plan.changes.filter((c) => c.kind === 'add')
  assert.equal(adds.length, 3)
  assert.equal(new Set(adds.map((c) => c.day)).size, 3, 'spread over three days')
  for (const c of adds) assert.ok(c.minutes >= 20 && c.minutes <= STUDY_BLOCK_MAX)
  assert.ok(!plan.changes.some((c) => c.task_id), 'the football task is untouched')
})

test('never double-books, never touches non-study activities, never exceeds the daily limit', () => {
  const tasks = [task('a', 1, 'Piano lesson', 'personal'), task('b', 1, 'Maths homework'), task('c', 1, 'Dinner', 'personal')]
  const plan = planStudyBoost(slots, tasks, [insight('Maths', 'needs_attention', 600)], { maxDailyStudy: 120, busy: [] })
  const taken = new Set(tasks.map((t) => `${t.time_slot_id}|${t.day_of_week}`))
  for (const c of plan.changes) {
    assert.equal(c.kind, 'add')
    assert.ok(!taken.has(`${c.slot_id}|${c.day}`), 'empty cells only')
  }
  // Monday already has 60 min of study; the limit is 120, so at most one more hour there.
  assert.ok(plan.changes.filter((c) => c.day === 1).length <= 1)
  assert.ok(plan.unmet.length === 1 && plan.unmet[0].subject === 'Maths', 'the rest is reported, not forced in')
  assert.match(plan.tradeoffs.at(-1), /still needs about/)
})

test('fixed commitments and late nights are never used', () => {
  const late = [slot('x', '22:30', '23:30'), slot('y', '18:00', '19:00')]
  const busy = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '18:00', end: '19:00', label: 'tuition' }))
  const plan = planStudyBoost(late, [], [insight('History', 'needs_attention', 120)], { maxDailyStudy: 180, busy, sleep: '22:00' })
  assert.equal(plan.changes.length, 0)
  assert.equal(plan.unmet[0].minutes, 120)
  assert.match(plan.unmet[0].why, /tuition|school or fixed commitments|waking hours/)
})

test('strong subjects give time to weak ones but keep at least one session', () => {
  const tasks = [task('a', 1, 'English reading'), task('a', 2, 'English essay'), task('a', 3, 'English grammar')]
  const plan = planStudyBoost(slots, tasks, [insight('English', 'strong', -120), insight('Maths', 'needs_attention', 120)], { maxDailyStudy: 0, busy: school })
  const moved = plan.changes.filter((c) => c.kind === 'relabel')
  assert.equal(moved.length, 2)
  assert.ok(moved.every((c) => /English/.test(c.from_title) && c.subject === 'Maths'))
  assert.ok(plan.tradeoffs.some((t) => /moves from English \(strong\) to Maths/.test(t)))
})

test('long or overloaded stretches are avoided (breaks between activities)', () => {
  const s = [slot('p', '15:00', '16:00'), slot('q', '16:00', '17:00'), slot('r', '17:00', '18:00')]
  const tasks = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [task('p', d, 'Tuition', 'work'), task('r', d, 'Sports', 'exercise')])
  const plan = planStudyBoost(s, tasks, [insight('Maths', 'needs_attention', 60)], { maxDailyStudy: 600 })
  assert.equal(plan.changes.length, 0, 'filling q would make three hours back to back')
  assert.match(plan.unmet[0].why, /no break/)
})

test('an exam makes the session a revision session and puts that subject first', () => {
  const plan = planStudyBoost(slots, [], [
    insight('Biology', 'on_track', 60, { evidence: { exam: { title: 'Biology unit test', starts_on: '2026-11-02' } } }),
    insight('Maths', 'improving', 60),
  ], { maxDailyStudy: 60, busy: school })
  assert.equal(plan.changes[0].title, 'Biology revision')
  assert.match(plan.changes[0].reason, /Biology unit test/)
})

test('insufficient data is never treated as weak (no time added without an exam)', () => {
  const plan = planStudyBoost(slots, [task('a', 1, 'Study')], [insight('Art', 'insufficient_data', 0)], { maxDailyStudy: 180 })
  assert.equal(plan.changes.length, 0)
})

test('the signature changes only when statuses or minutes change', () => {
  const a = [insight('Maths', 'needs_attention', 120), insight('English', 'strong', -30)]
  assert.equal(insightSignature(a), insightSignature([...a].reverse()))
  assert.notEqual(insightSignature(a), insightSignature([insight('Maths', 'improving', 60), a[1]]))
})

test('school periods merge into blocks', () => {
  const blocks = schoolBlocks([
    { day: 1, start: '08:00', end: '08:45' }, { day: 1, start: '08:45', end: '09:30' }, { day: 1, start: '10:00', end: '10:45' }, { day: 1, start: '13:00', end: '13:45' },
  ])
  assert.deepEqual(blocks.map((b) => `${b.start}-${b.end}`), ['08:00-10:45', '13:00-13:45'])
})

test('adherence counts only study-plan sessions the student ticked', () => {
  const tasks = [task('a', 1, 'Maths practice', 'study', 'Study plan: x'), task('b', 3, 'Maths practice', 'study', 'Study plan: y'), task('c', 1, 'Football', 'exercise')]
  // 2026-10-05 is a Monday; 05–11 Oct has one Monday and one Wednesday
  const r = planAdherence(tasks, [
    { task_id: tasks[0].id, completion_date: '2026-10-05', completed: true },
    { task_id: tasks[2].id, completion_date: '2026-10-05', completed: true },
  ], '2026-10-05', '2026-10-11')
  assert.deepEqual(r, { sessions: 2, scheduled: 2, done: 1, rate: 50 })
  assert.equal(planAdherence([tasks[2]], [], '2026-10-05', '2026-10-11'), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
