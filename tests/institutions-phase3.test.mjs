// Phase 3 tests: guardian linking, parent access, announcements, messages and
// meeting requests, class timetables, goals/achievements, reminders.
// Run: node --env-file=.env tests/institutions-phase3.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, client, day, fn, one, PASS, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
const PARENT = `parent${suffix}@gmail-test.example.com`

console.log('Institution phase 3 tests')
try {
  const W = await buildSchool(suffix)
  const { instA, principal, principalB, coord, classT, subjT, s1, s2, maths, class10a, class10b } = W
  let linkId, parent, parentUser

  await test('students request a guardian link; nobody else can, and the link starts inactive', async () => {
    const { error: teacher } = await subjT.c.rpc('request_guardian_link', { p_inst: instA, p_email: PARENT, p_name: 'Priya Parent', p_relationship: 'mother' })
    assert.ok(teacher)
    const { error: own } = await s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: `s1@${W.DOM_A}`, p_name: 'Me', p_relationship: 'mother' })
    assert.match(own?.message ?? '', /own email/)
    linkId = await one(s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: PARENT, p_name: 'Priya Parent', p_relationship: 'mother' }))
    const { error: dup } = await s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: PARENT, p_name: 'Again', p_relationship: 'mother' })
    assert.match(dup?.message ?? '', /already asked/)
    const notes = await one(classT.c.from('notifications').select('kind'))
    assert.ok(notes.some((n) => n.kind === 'guardian_request'), 'class teacher told')
    const seen = await one(s2.c.from('guardian_links').select('id'))
    assert.equal(seen.length, 0, 'other students can’t see it')
  })

  await test('only the class teacher or student managers approve; the parent then activates', async () => {
    const bad = await fn('institution-invite', { action: 'approve_guardian', link_id: linkId }, subjT.c)
    assert.equal(bad.status, 400)
    const badB = await fn('institution-invite', { action: 'approve_guardian', link_id: linkId }, principalB.c)
    assert.equal(badB.status, 400)
    const ok = await fn('institution-invite', { action: 'approve_guardian', link_id: linkId }, classT.c)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const token = new globalThis.URL(ok.body.activation_link).searchParams.get('token')
    const preview = await fn('institution-activate', { action: 'inspect', token })
    assert.equal(preview.body.invitation.role, 'parent')
    const act = await fn('institution-activate', { action: 'activate', token, password: PASS })
    assert.equal(act.status, 200, JSON.stringify(act.body))
    parent = client()
    const { data } = await parent.auth.signInWithPassword({ email: PARENT, password: PASS })
    parentUser = data.user.id
    const link = await one(parent.from('guardian_links').select('status, relationship').eq('id', linkId).single())
    assert.deepEqual(link, { status: 'active', relationship: 'mother' })
    const mine = await one(parent.rpc('my_institutions'))
    assert.equal(mine[0].role, 'parent')
  })

  // data for the child
  await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Fractions', opens_at: day(-1), due_at: day(2) }).select())
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  await one(classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s1.membership, status: 'present' }] }))
  const asmt = await one(subjT.c.from('assessments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Quiz', kind: 'internal', max_marks: 20, assessment_date: today }).select().single())
  await one(subjT.c.rpc('save_marks', { p_assessment: asmt.id, p_entries: [{ student_id: s1.membership, obtained: 18, feedback: 'Great' }] }))

  await test('parents see their child’s homework, attendance and only published marks', async () => {
    const kids = await one(parent.rpc('guardian_children'))
    assert.equal(kids.length, 1)
    assert.equal(kids[0].name, 'Student One')
    let v = await one(parent.rpc('guardian_child_view', { p_student: s1.membership }))
    assert.equal(v.assignments[0].title, 'Fractions')
    assert.equal(v.assignments[0].status, 'not_submitted')
    assert.equal(v.attendance[0].status, 'present')
    assert.equal(v.marks.length, 0, 'draft marks hidden')
    await one(subjT.c.rpc('publish_assessment', { p_assessment: asmt.id }))
    v = await one(parent.rpc('guardian_child_view', { p_student: s1.membership }))
    assert.equal(Number(v.marks[0].obtained), 18)
    assert.equal(v.marks[0].grade, 'A2')
  })

  await test('parents cannot reach unrelated students or raw tables', async () => {
    const { error } = await parent.rpc('guardian_child_view', { p_student: s2.membership })
    assert.ok(error)
    for (const t of ['classes', 'assignments', 'submissions', 'attendance_records', 'marks', 'class_enrollments']) {
      assert.equal((await one(parent.from(t).select('id'))).length, 0, t)
    }
    const members = await one(parent.from('institution_memberships').select('role'))
    assert.ok(members.every((m) => m.role === 'parent'), 'no student/staff directory')
    const { error: req } = await parent.rpc('request_guardian_link', { p_inst: instA, p_email: 'x@example.com', p_name: 'x', p_relationship: 'other' })
    assert.ok(req)
  })

  await test('messages: parent ↔ child’s teacher only, private to the two of them', async () => {
    const contacts = await one(parent.rpc('guardian_contacts', { p_student: s1.membership }))
    const names = contacts.map((c) => c.name)
    assert.ok(names.includes('Subject Teacher') && names.includes('Class Teacher') && names.includes('Head A'))
    const { error: wrong } = await parent.rpc('start_conversation', { p_student: s1.membership, p_counterpart: s2.id, p_subject: 'x', p_body: 'x' })
    assert.ok(wrong, 'cannot message a student')
    const cid = await one(parent.rpc('start_conversation', { p_student: s1.membership, p_counterpart: subjT.id, p_subject: 'Maths help', p_body: 'How is she doing?' }))
    const told = await one(subjT.c.from('notifications').select('kind, link'))
    assert.ok(told.some((n) => n.kind === 'message' && n.link === `/school/messages?c=${cid}`), 'teacher is notified of a new conversation')
    const conv = await one(subjT.c.rpc('my_conversations'))
    assert.equal(conv[0].counterpart, 'Priya Parent')
    assert.equal((await one(principal.c.from('conversation_messages').select('id'))).length, 0, 'not even the principal reads private threads')
    assert.equal((await one(s1.c.from('conversations').select('id'))).length, 0)
    await one(subjT.c.rpc('send_message', { p_conversation: cid, p_body: 'Can we meet?', p_kind: 'meeting_request', p_meeting_at: day(3) }))
    const msgs = await one(parent.from('conversation_messages').select('id, kind, meeting_status').eq('conversation_id', cid).order('created_at'))
    assert.equal(msgs.length, 2)
    const { error: self } = await subjT.c.rpc('respond_meeting', { p_message: msgs[1].id, p_accept: true })
    assert.ok(self, 'sender can’t accept their own request')
    await one(parent.rpc('respond_meeting', { p_message: msgs[1].id, p_accept: true }))
    const notes = await one(subjT.c.from('notifications').select('kind'))
    assert.ok(notes.some((n) => n.kind === 'meeting_response'))
    // staff-initiated: teacher → guardian of a student they teach
    const gs = await one(classT.c.rpc('student_guardians', { p_student: s1.membership }))
    assert.equal(gs[0].name, 'Priya Parent')
    assert.equal((await one(classT.c.rpc('student_guardians', { p_student: s2.membership }))).length, 0)
  })

  await test('revoking a link cuts off the parent immediately (and their messages)', async () => {
    const { error } = await s1.c.rpc('close_guardian_link', { p_link: linkId, p_reason: '' })
    assert.match(error?.message ?? '', /reason/)
    await one(s1.c.rpc('close_guardian_link', { p_link: linkId, p_reason: 'Wrong person linked' }))
    const { error: view } = await parent.rpc('guardian_child_view', { p_student: s1.membership })
    assert.ok(view)
    assert.equal((await one(parent.from('conversations').select('id'))).length, 0)
    const audit = await one(principal.c.from('audit_log').select('reason').eq('record_type', 'guardian_links').eq('record_id', linkId).eq('action', 'update'))
    assert.ok(audit.some((a) => a.reason === 'Wrong person linked'))
  })

  await test('announcements reach the right audience only', async () => {
    const { error: st } = await subjT.c.rpc('post_announcement', { p_inst: instA, p_title: 'x', p_body: 'x', p_audience: 'everyone' })
    assert.ok(st, 'subject teachers cannot post')
    const { error: ct } = await classT.c.rpc('post_announcement', { p_inst: instA, p_title: 'x', p_body: 'x', p_audience: 'students', p_class: class10b })
    assert.ok(ct, 'class teachers only for their class')
    await one(classT.c.rpc('post_announcement', { p_inst: instA, p_title: '10 A trip', p_body: 'Bring a water bottle.', p_audience: 'students_parents', p_class: class10a }))
    await one(principal.c.rpc('post_announcement', { p_inst: instA, p_title: 'Staff meeting', p_body: 'Friday 3pm', p_audience: 'staff' }))
    const s1sees = (await one(s1.c.from('announcements').select('title'))).map((a) => a.title)
    assert.deepEqual(s1sees, ['10 A trip'])
    assert.equal((await one(s2.c.from('announcements').select('title'))).length, 0)
    const notes = await one(s1.c.from('notifications').select('kind'))
    assert.ok(notes.some((n) => n.kind === 'announcement'))
    assert.equal((await one(principalB.c.from('announcements').select('id'))).length, 0)
  })

  await test('class timetable: no overlapping periods; teacher double-booking is reported', async () => {
    await one(principal.c.from('class_periods').insert({ institution_id: instA, class_id: class10a, day_of_week: 1, start_time: '09:00', end_time: '09:45', subject_id: maths, teacher_id: subjT.membership }).select())
    const { error } = await principal.c.from('class_periods').insert({ institution_id: instA, class_id: class10a, day_of_week: 1, start_time: '09:30', end_time: '10:00', label: 'Assembly' })
    assert.match(error?.message ?? '', /overlaps/)
    await one(principal.c.from('class_periods').insert({ institution_id: instA, class_id: class10b, day_of_week: 1, start_time: '09:15', end_time: '10:00', subject_id: maths, teacher_id: subjT.membership }).select())
    const conflicts = await one(coord.c.rpc('timetable_conflicts', { p_inst: instA }))
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].teacher, 'Subject Teacher')
    const { error: stEdit } = await subjT.c.from('class_periods').insert({ institution_id: instA, class_id: class10a, day_of_week: 2, start_time: '09:00', end_time: '09:45', label: 'x' })
    assert.ok(stEdit, 'subject teachers can’t edit class timetables')
    assert.equal((await one(s1.c.from('class_periods').select('id'))).length, 1, 'students see their class timetable')
  })

  await test('goals are private; achievements come from real records', async () => {
    const g = await one(s1.c.from('student_goals').insert({ title: 'Read 5 books', category: 'personal' }).select().single())
    assert.equal((await one(s2.c.from('student_goals').select('id'))).length, 0)
    await one(s1.c.from('student_goals').update({ status: 'completed' }).eq('id', g.id))
    const done = await one(s1.c.from('student_goals').select('progress, completed_at').eq('id', g.id).single())
    assert.equal(done.progress, 100)
    const ach = await one(s1.c.rpc('my_achievements'))
    assert.ok(ach.find((a) => a.id === 'goal_done').earned)
    assert.ok(!ach.find((a) => a.id === 'first_accepted').earned)
  })

  await test('reminders: due-soon homework and exams tomorrow, never twice; preferences respected', async () => {
    await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Due tomorrow', opens_at: day(-1), due_at: new Date(Date.now() + 5 * 3600e3).toISOString() }).select())
    const tomorrow = new Date(Date.now() + 86400e3).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    await one(coord.c.from('calendar_events').insert({ institution_id: instA, kind: 'exam', title: 'Science exam', grade: '10', starts_on: tomorrow, ends_on: tomorrow }).select())
    await one(s2.c.from('notification_prefs').insert({ user_id: s2.id, kind: 'exam_reminder', in_app: false }).select())
    await adminSql('select public.send_reminders()')
    await adminSql('select public.send_reminders()')
    const s1n = await one(s1.c.from('notifications').select('kind, title'))
    assert.equal(s1n.filter((n) => n.title === 'Due soon: Due tomorrow').length, 1)
    assert.equal(s1n.filter((n) => n.title === 'Exam tomorrow: Science exam').length, 1)
    const s2n = await one(s2.c.from('notifications').select('kind'))
    assert.ok(!s2n.some((n) => n.kind === 'exam_reminder'), 'turned off by preference')
  })
} finally {
  await cleanup(suffix)
  await adminSql(`delete from auth.users where email = '${PARENT}'`).catch(() => {})
}
console.log(`\n${passedCount()} passed`)
