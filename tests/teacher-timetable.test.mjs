// Class teachers edit timetables: the class timetable (manage_timetable) and
// the personal timetables of students in their class (edit_student_timetables).
// Runs against the real project.
//   node --env-file=.env tests/teacher-timetable.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, one, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('Teacher timetable tests')

const W = await buildSchool(suffix)
const { instA, principal, principalB, coord, classT, subjT, s1, s2, class10a, class10b, maths } = W

const period = (c, cls, day, start, end) =>
  c.from('class_periods').insert({ institution_id: instA, class_id: cls, day_of_week: day, start_time: start, end_time: end, label: 'Study hall' }).select('id')
const teacherApply = (c, student, tracker, ops, base, extra = {}) =>
  c.rpc('teacher_apply_timetable_change', { p_student: student, p_tracker: tracker, p_new_name: extra.name ?? null, p_base_version: base, p_summary: extra.summary ?? 'Teacher change', p_ops: ops })
const view = (c, student) => c.rpc('teacher_student_timetables', { p_student: student })
const setPerm = (perm, allowed) =>
  allowed === null
    ? principal.c.from('institution_role_permissions').delete().match({ institution_id: instA, role: 'class_teacher', permission: perm })
    : principal.c.from('institution_role_permissions').upsert({ institution_id: instA, role: 'class_teacher', permission: perm, allowed })

try {
  // s1 (10 A) has a personal timetable; s2 (10 B) too.
  const t1 = await one(s1.c.rpc('apply_timetable_change', {
    p_tracker: null, p_new_name: 'My week', p_base_version: null, p_source: 'voice', p_summary: 'seed',
    p_ops: [{ op: 'add_slot', ref: 'a', start: '17:00', end: '18:00' }, { op: 'add_task', slot_ref: 'a', day: 1, title: 'Reading', category: 'personal', description: null }],
  }))
  const t2 = await one(s2.c.rpc('apply_timetable_change', {
    p_tracker: null, p_new_name: 'B week', p_base_version: null, p_source: 'voice', p_summary: 'seed',
    p_ops: [{ op: 'add_slot', ref: 'a', start: '17:00', end: '18:00' }, { op: 'add_task', slot_ref: 'a', day: 1, title: 'Football', category: 'exercise', description: null }],
  }))
  const reading = (await one(s1.c.from('tasks').select('id').eq('tracker_id', t1.tracker_id)))[0].id
  await one(s1.c.from('task_completions').insert({ task_id: reading, tracker_id: t1.tracker_id, completion_date: '2026-10-05', completed: true }).select('id'))

  await test('class teacher edits their own class timetable by default; not other classes', async () => {
    await one(period(classT.c, class10a, 1, '14:00', '14:45'))
    const other = await period(classT.c, class10b, 1, '14:00', '14:45')
    assert.ok(other.error || other.data.length === 0, '10 B is not their class')
    const sub = await period(subjT.c, class10a, 2, '14:00', '14:45')
    assert.ok(sub.error || sub.data.length === 0, 'subject teachers can’t')
    await one(period(coord.c, class10b, 2, '14:00', '14:45'))
    // still can't edit the class itself without manage_classes
    const cls = await classT.c.from('classes').update({ name: 'Renamed' }).eq('id', class10a).select('id')
    assert.ok(cls.error || cls.data.length === 0)
  })

  await test('the principal can switch class-timetable editing off', async () => {
    await one(setPerm('manage_timetable', false).select('permission'))
    const r = await period(classT.c, class10a, 3, '14:00', '14:45')
    assert.ok(r.error || r.data.length === 0)
    await one(setPerm('manage_timetable', null).select('permission'))
    await one(period(classT.c, class10a, 3, '14:00', '14:45'))
  })

  await test('class teacher sees their student’s timetable (activities only, no ticks); not other students', async () => {
    const v = await one(view(classT.c, s1.membership))
    assert.equal(v.student, 'Student One')
    assert.equal(v.timetables.length, 1)
    assert.equal(v.timetables[0].tasks[0].title, 'Reading')
    assert.ok(!JSON.stringify(v).includes('2026-10-05'), 'no completions')
    for (const [c, who] of [[classT.c, s2.membership], [subjT.c, s1.membership], [coord.c, s1.membership], [principalB.c, s1.membership], [s2.c, s1.membership], [s1.c, s1.membership]]) {
      assert.match((await view(c, who)).error?.message ?? '', /NOT_ALLOWED/)
    }
    assert.ok((await classT.c.rpc('student_timetable_owner', { p_student: s1.membership })).error, 'helper is server-only')
    assert.deepEqual(await one(classT.c.rpc('my_editable_students')), [s1.membership])
    assert.deepEqual(await one(subjT.c.rpc('my_editable_students')), [])
  })

  let change
  await test('a teacher’s edit is saved, attributed, audited and the student is notified', async () => {
    const v = (await one(view(classT.c, s1.membership))).timetables[0]
    change = await one(teacherApply(classT.c, s1.membership, v.id, [
      { op: 'add_slot', ref: 'n', start: '18:00', end: '19:00' },
      { op: 'add_task', slot_ref: 'n', day: 2, title: 'Maths revision', category: 'study', description: 'Chapter 4' },
      { op: 'update_task', task: reading, title: 'Reading – novel', category: 'study', description: null },
    ], v.version, { summary: 'Added Maths revision on Tuesday' }))
    const tasks = await one(s1.c.from('tasks').select('title, category').eq('tracker_id', t1.tracker_id).order('title'))
    assert.deepEqual(tasks.map((t) => t.title), ['Maths revision', 'Reading – novel'])
    const [h] = await one(s1.c.from('timetable_changes').select('source, actor_name, summary').eq('id', change.change_id))
    assert.deepEqual(h, { source: 'teacher', actor_name: 'Class Teacher', summary: 'Added Maths revision on Tuesday' })
    const notes = await one(s1.c.from('notifications').select('kind, body').eq('kind', 'timetable_changed'))
    assert.equal(notes.length, 1)
    assert.match(notes[0].body, /Class Teacher changed “My week”: Added Maths revision on Tuesday/)
    const audit = await adminSql(`select action, actor_id from public.audit_log where record_type = 'student_timetable' and record_id = '${t1.tracker_id}'`)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].actor_id, classT.id)
    // the completion on Reading survived the rename
    assert.equal((await one(s1.c.from('task_completions').select('id').eq('task_id', reading))).length, 1)
  })

  await test('the student can undo the teacher’s change', async () => {
    await one(s1.c.rpc('undo_timetable_change', { p_change: change.change_id }))
    const tasks = await one(s1.c.from('tasks').select('title').eq('tracker_id', t1.tracker_id))
    assert.deepEqual(tasks.map((t) => t.title), ['Reading'])
    assert.equal((await one(s1.c.from('time_slots').select('id').eq('tracker_id', t1.tracker_id))).length, 1)
  })

  await test('stale edits, other students’ timetables and forged sources are refused', async () => {
    const v = (await one(view(classT.c, s1.membership))).timetables[0]
    assert.match((await teacherApply(classT.c, s1.membership, v.id, [{ op: 'delete_task', task: reading }], 'old-version')).error?.message ?? '', /STALE_TIMETABLE/)
    // s1's membership with s2's timetable / task
    assert.match((await teacherApply(classT.c, s1.membership, t2.tracker_id, [{ op: 'delete_task', task: reading }], v.version)).error?.message ?? '', /unknown timetable/)
    const football = (await one(s2.c.from('tasks').select('id').eq('tracker_id', t2.tracker_id)))[0].id
    assert.match((await teacherApply(classT.c, s1.membership, v.id, [{ op: 'delete_task', task: football }], v.version)).error?.message ?? '', /unknown task/)
    assert.match((await teacherApply(classT.c, s2.membership, t2.tracker_id, [{ op: 'delete_task', task: football }], 'x')).error?.message ?? '', /NOT_ALLOWED/)
    assert.match((await teacherApply(subjT.c, s1.membership, v.id, [{ op: 'delete_task', task: reading }], v.version)).error?.message ?? '', /NOT_ALLOWED/)
    // students can't record teacher changes through their own function
    const forged = await s1.c.rpc('apply_timetable_change', { p_tracker: v.id, p_new_name: null, p_base_version: v.version, p_source: 'teacher', p_summary: 'x', p_ops: [{ op: 'delete_task', task: reading }] })
    assert.match(forged.error?.message ?? '', /unknown source/)
    assert.equal((await one(s2.c.from('tasks').select('id').eq('tracker_id', t2.tracker_id))).length, 1)
  })

  await test('a teacher can create a first timetable for a student', async () => {
    await adminSql(`delete from public.trackers where id = '${t1.tracker_id}'`)
    const r = await one(teacherApply(classT.c, s1.membership, null, [
      { op: 'add_slot', ref: 'a', start: '16:00', end: '17:00' },
      { op: 'add_task', slot_ref: 'a', day: 3, title: 'Homework', category: 'study', description: null },
    ], null, { name: 'Study plan', summary: 'Created a study plan' }))
    const mine = await one(s1.c.from('trackers').select('id, name'))
    assert.deepEqual(mine.map((t) => t.name), ['Study plan'])
    assert.equal(mine[0].id, r.tracker_id)
  })

  await test('switching the permission off, leaving the class or suspension removes access', async () => {
    await one(setPerm('edit_student_timetables', false).select('permission'))
    assert.match((await view(classT.c, s1.membership)).error?.message ?? '', /NOT_ALLOWED/)
    assert.deepEqual(await one(classT.c.rpc('my_editable_students')), [])
    await one(setPerm('edit_student_timetables', null).select('permission'))
    await one(view(classT.c, s1.membership))
    await adminSql(`update public.classes set archived = true where id = '${class10a}'`)
    assert.match((await view(classT.c, s1.membership)).error?.message ?? '', /NOT_ALLOWED/)
    await adminSql(`update public.classes set archived = false where id = '${class10a}'`)
    await adminSql(`update public.institution_memberships set status = 'suspended' where id = '${classT.membership}'`)
    assert.match((await view(classT.c, s1.membership)).error?.message ?? '', /NOT_ALLOWED/)
    await adminSql(`update public.institution_memberships set status = 'active' where id = '${classT.membership}'`)
    void maths
  })
} finally {
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
