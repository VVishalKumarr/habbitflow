// Isolation follow-ups and study insights, against the real project.
// * subject teachers see only their subjects' academic records
// * role assignment rules (coordinators, subject teachers, self-promotion)
// * study insights: classification, missing data, who may see what
// * study plans: only study sessions, undoable
// * revoked access, parents, other institutions, personal data
//   node --env-file=.env tests/study-insights.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, client, fn, individual, one, passedCount, PASS, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('Isolation and study insights')

const W = await buildSchool(suffix)
const { owner, instA, instB, principal, principalB, coord, classT, subjT, s1, s2, maths, science, class10a, class10b } = W
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)

/** A published assessment with one mark for s1 (teacher = the subject's teacher). */
async function mark(teacher, subject, daysAgo, pct, kind = 'internal') {
  const a = await one(teacher.c.from('assessments').insert({
    institution_id: instA, class_id: class10a, subject_id: subject, teacher_id: teacher.membership,
    title: `Test ${subject === maths ? 'M' : 'S'} ${daysAgo}`, kind, max_marks: 50, assessment_date: iso(daysAgo), status: 'draft',
  }).select().single())
  await one(teacher.c.rpc('save_marks', { p_assessment: a.id, p_entries: [{ student_id: s1.membership, obtained: pct / 2 }] }))
  await one(teacher.c.rpc('publish_assessment', { p_assessment: a.id }))
  return a.id
}

try {
  const stranger = await individual(`stu_${suffix}`)
  // Maths (subject teacher): 72 → 64 → 55, falling. Science (class teacher): 85, 90.
  await mark(subjT, maths, 40, 72)
  await mark(subjT, maths, 25, 64)
  const lastMaths = await mark(subjT, maths, 10, 55)
  await mark(classT, science, 30, 85)
  await mark(classT, science, 12, 90)
  // A third subject with a teacher but no data.
  const art = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Art' }).select().single())).id
  await one(principal.c.from('teaching_assignments').insert({ institution_id: instA, class_id: class10a, subject_id: art, teacher_id: classT.membership }).select())

  // ------------------------------------------------------------------ subject scope
  await test('subject teachers see only their own subjects’ assessments and marks; class teachers see the whole class', async () => {
    const subjects = async (c) => new Set((await one(c.from('assessments').select('subject_id').eq('class_id', class10a))).map((r) => r.subject_id))
    assert.deepEqual([...(await subjects(subjT.c))], [maths])
    const ct = await subjects(classT.c)
    assert.ok(ct.has(maths) && ct.has(science), 'class teacher: all subjects of their class')
    const co = await subjects(coord.c)
    assert.ok(co.has(maths) && co.has(science), 'coordinator: their grade')
    const marks = await one(subjT.c.from('marks').select('assessment_id, assessments!inner(subject_id)').eq('student_id', s1.membership))
    assert.ok(marks.length === 3 && marks.every((m) => m.assessments.subject_id === maths), 'marks: Maths only')
  })

  await test('subject scope also holds in summaries, progress counts and exports', async () => {
    const sum = await one(subjT.c.rpc('academic_summary', { p_inst: instA, p_class: class10a, p_days: 120 }))
    assert.equal(sum.marks.marks, 3, 'only the three Maths marks count')
    const sumCt = await one(classT.c.rpc('academic_summary', { p_inst: instA, p_class: class10a, p_days: 120 }))
    assert.equal(sumCt.marks.marks, 5)
    const hwS = await one(classT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: science, teacher_id: classT.membership,
      title: 'Science HW', opens_at: new Date(Date.now() - 86400000).toISOString(), due_at: new Date(Date.now() + 3 * 86400000).toISOString() }).select().single())
    assert.deepEqual(await one(subjT.c.rpc('assignment_progress', { p_assignments: [hwS.id] })), [], 'no counts for another subject')
    assert.equal((await one(classT.c.rpc('assignment_progress', { p_assignments: [hwS.id] }))).length, 1)
  })

  // ------------------------------------------------------------------ roles
  await test('only the principal (or director) can make or remove a coordinator; changes carry a reason and notify the person', async () => {
    const byCoord = await coord.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'coordinator' })
    assert.ok(byCoord.error, 'coordinator cannot promote to coordinator')
    const byCt = await classT.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'coordinator' })
    assert.ok(byCt.error, 'class teacher cannot assign roles')
    const demote = await coord.c.rpc('update_member', { p_membership: coord.membership, p_name: null, p_external_id: null, p_role: 'subject_teacher' })
    assert.ok(demote.error, 'nobody changes their own role')
    const byB = await principalB.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'coordinator' })
    assert.ok(byB.error, 'principal of another school')
    await one(principal.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'coordinator', p_reason: 'Leads maths department' }))
    const [audit] = await adminSql(`select reason, old_value ->> 'role' old_role, new_value ->> 'role' new_role, actor_id from public.audit_log
                                     where record_type = 'institution_memberships' and record_id = '${subjT.membership}' and new_value ? 'role' order by created_at desc limit 1`)
    assert.deepEqual([audit.reason, audit.old_role, audit.new_role, audit.actor_id], ['Leads maths department', 'subject_teacher', 'coordinator', principal.id])
    const notes = await one(subjT.c.from('notifications').select('kind, body').eq('kind', 'role_changed'))
    assert.ok(notes.some((n) => /Coordinator/.test(n.body)))
    await one(principal.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'subject_teacher', p_reason: 'Back to teaching' }))
  })

  await test('coordinators assign subject teachers in their grades; class and subject teachers cannot; nobody but heads sets coordinator scopes', async () => {
    const extra = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Hindi' }).select().single())).id
    const row = { institution_id: instA, class_id: class10b, subject_id: extra, teacher_id: subjT.membership }
    assert.ok((await classT.c.from('teaching_assignments').insert(row).select()).error, 'class teacher')
    assert.ok((await subjT.c.from('teaching_assignments').insert(row).select()).error, 'subject teacher')
    await one(coord.c.from('teaching_assignments').insert(row).select())
    assert.ok((await coord.c.from('coordinator_scopes').insert({ institution_id: instA, coordinator_id: coord.membership, grade: '*' }).select()).error, 'coordinator widens own scope')
  })

  await test('only students start parent links', async () => {
    for (const who of [subjT, classT, coord, principal]) {
      const { error } = await who.c.rpc('request_guardian_link', { p_inst: instA, p_email: `p${suffix}@example.com`, p_name: 'P', p_relationship: 'mother' })
      assert.ok(error)
    }
  })

  // ------------------------------------------------------------------ insights
  let mine
  await test('insights: a falling subject needs attention, a strong one is strong, and missing data is never zero', async () => {
    mine = await one(s1.c.rpc('study_insights', { p_student: s1.membership }))
    assert.equal(mine.viewer, 'student')
    const by = Object.fromEntries(mine.subjects.map((s) => [s.subject, s]))
    assert.equal(by.Mathematics.status, 'needs_attention')
    assert.ok(by.Mathematics.reasons.some((r) => /fell over the last three/.test(r.text)), JSON.stringify(by.Mathematics.reasons))
    assert.ok(by.Mathematics.recommended_minutes > 0)
    assert.equal(by.Science.status, 'strong')
    assert.ok(by.Science.recommended_minutes <= 0)
    assert.equal(by.Art.status, 'insufficient_data')
    assert.equal(by.Art.indicator, null)
    assert.equal(by.Art.recommended_minutes, 0)
    assert.ok(by.Mathematics.analysed_at && Array.isArray(by.Mathematics.history))
  })

  await test('insights update when data changes (a corrected mark) and keep a history', async () => {
    const before = (await adminSql(`select count(*)::int n from public.study_insight_snapshots where student_id = '${s1.membership}'`))[0].n
    await one(subjT.c.rpc('save_marks', { p_assessment: lastMaths, p_entries: [{ student_id: s1.membership, obtained: 40 }], p_reason: 'Re-marked paper' }))
    const again = await one(s1.c.rpc('study_insights', { p_student: s1.membership }))
    const m = again.subjects.find((s) => s.subject === 'Mathematics')
    assert.ok(m.history.length >= 2, 'new snapshot after the correction')
    const after = (await adminSql(`select count(*)::int n from public.study_insight_snapshots where student_id = '${s1.membership}'`))[0].n
    assert.ok(after > before)
    // unchanged data: no new snapshot
    await one(s1.c.rpc('study_insights', { p_student: s1.membership }))
    assert.equal((await adminSql(`select count(*)::int n from public.study_insight_snapshots where student_id = '${s1.membership}'`))[0].n, after)
  })

  await test('insights: staff see only their subjects, other students and other schools are refused', async () => {
    const st = await one(subjT.c.rpc('study_insights', { p_student: s1.membership }))
    assert.deepEqual(st.subjects.map((s) => s.subject), ['Mathematics'])
    assert.equal(st.viewer, 'staff')
    assert.ok(!('confidence' in st.subjects[0].evidence), 'the student’s self-rating stays private')
    const ct = await one(classT.c.rpc('study_insights', { p_student: s1.membership }))
    assert.equal(ct.subjects.length, 3)
    for (const [who, c] of [['other student', s2.c], ['other school', principalB.c], ['personal account', stranger.c], ['platform owner', owner.c]]) {
      const { data, error } = await c.rpc('study_insights', { p_student: s1.membership })
      assert.ok(error && /NOT_ALLOWED/.test(error.message), `${who}: ${JSON.stringify(data)}`)
    }
    const { error: s2self } = await s2.c.rpc('study_insights', { p_student: s2.membership })
    assert.ok(!s2self, 'every student can see their own')
    const rows = await one(subjT.c.rpc('class_study_insights', { p_class: class10a }))
    assert.ok(rows.length && rows.every((r) => r.subject === 'Mathematics'))
    assert.ok((await principalB.c.rpc('class_study_insights', { p_class: class10a })).error)
    // (an earlier test has them teach Hindi in 10 B, so use a class they have nothing to do with)
    const class10c = (await one(principal.c.from('classes').insert({ institution_id: instA, grade: '10', section: 'C', name: '10 C' }).select().single())).id
    assert.ok((await subjT.c.rpc('class_study_insights', { p_class: class10c })).error, 'a class they don’t teach')
  })

  await test('insights tables are never readable directly', async () => {
    for (const c of [s1.c, subjT.c, principal.c, principalB.c]) {
      const { data, error } = await c.from('study_insight_snapshots').select('id')
      assert.ok(error || data.length === 0, 'no direct access')
    }
    assert.equal((await one(principalB.c.from('study_insight_rules').select('*').eq('institution_id', instA))).length, 0)
  })

  await test('confidence: only the student, only for their own subjects', async () => {
    await one(s1.c.rpc('set_subject_confidence', { p_inst: instA, p_subject: maths, p_confidence: 2 }))
    assert.ok((await subjT.c.rpc('set_subject_confidence', { p_inst: instA, p_subject: maths, p_confidence: 5 })).error)
    const hindi = (await one(principal.c.from('subjects').select('id').eq('name', 'Hindi').single())).id
    assert.ok((await s1.c.rpc('set_subject_confidence', { p_inst: instA, p_subject: hindi, p_confidence: 3 })).error, 'not in their class')
    assert.equal((await one(s2.c.from('subject_confidence').select('*'))).length, 0)
    const r = await one(s1.c.rpc('study_insights', { p_student: s1.membership }))
    assert.ok(r.subjects.find((s) => s.subject === 'Mathematics').reasons.some((x) => /confidence 2 out of 5/.test(x.text)))
  })

  await test('rules: only heads of the institution change them, with validation', async () => {
    assert.ok((await coord.c.rpc('set_study_rules', { p_inst: instA, p_rules: { attention_below: 40 } })).error)
    assert.ok((await principalB.c.rpc('set_study_rules', { p_inst: instA, p_rules: { attention_below: 40 } })).error)
    assert.ok((await principal.c.rpc('set_study_rules', { p_inst: instA, p_rules: { attention_below: 95 } })).error, 'out of range')
    assert.ok((await principal.c.rpc('set_study_rules', { p_inst: instA, p_rules: { evil: 1 } })).error, 'unknown key')
    const r = await one(principal.c.rpc('set_study_rules', { p_inst: instA, p_rules: { extra_minutes: { needs_attention: 90 } } }))
    assert.equal(r.extra_minutes.needs_attention, 90)
    assert.equal(r.extra_minutes.improving, 60, 'other defaults kept')
  })

  // ------------------------------------------------------------------ plans
  await test('study plans only add or re-label study sessions, in the student’s own timetable, and can be undone', async () => {
    const tracker = await one(s1.c.from('trackers').insert({ name: 'My week' }).select().single())
    const slot = await one(s1.c.from('time_slots').insert({ tracker_id: tracker.id, start_time: '17:00', end_time: '18:00' }).select().single())
    const study = await one(s1.c.from('tasks').insert({ tracker_id: tracker.id, time_slot_id: slot.id, day_of_week: 1, title: 'Study', category: 'study' }).select().single())
    const play = await one(s1.c.from('tasks').insert({ tracker_id: tracker.id, time_slot_id: slot.id, day_of_week: 2, title: 'Football', category: 'exercise' }).select().single())
    const version = async () => one(s1.c.rpc('timetable_version', { p_tracker: tracker.id }))
    const apply = async (c, ops) => c.rpc('apply_timetable_change', { p_tracker: tracker.id, p_new_name: null, p_base_version: await version(), p_source: 'ai_study_plan', p_summary: 'Study plan: test', p_ops: ops })
    assert.ok((await apply(s1.c, [{ op: 'delete_task', task: play.id }])).error, 'no deleting')
    assert.ok((await apply(s1.c, [{ op: 'update_task', task: play.id, title: 'Maths practice', category: 'study', description: null }])).error, 'no re-labelling non-study')
    assert.ok((await apply(s1.c, [{ op: 'add_task', slot: slot.id, day: 3, title: 'Gaming', category: 'personal', description: null }])).error, 'adds are study only')
    assert.ok((await apply(subjT.c, [{ op: 'update_task', task: study.id, title: 'x', category: 'study', description: null }])).error, 'not someone else’s timetable')
    const ok = await one(await apply(s1.c, [
      { op: 'update_task', task: study.id, title: 'Mathematics practice', category: 'study', description: 'Study plan: Mathematics needs attention.' },
      { op: 'add_task', slot: slot.id, day: 4, title: 'Mathematics practice', category: 'study', description: 'Study plan: Mathematics needs attention.' },
    ]))
    assert.equal((await one(s1.c.from('tasks').select('title').eq('id', study.id).single())).title, 'Mathematics practice')
    await one(s1.c.rpc('undo_timetable_change', { p_change: ok.change_id }))
    assert.equal((await one(s1.c.from('tasks').select('title').eq('id', study.id).single())).title, 'Study')
    assert.equal((await one(s1.c.from('tasks').select('id').eq('tracker_id', tracker.id))).length, 2)
    const hist = await one(s1.c.from('timetable_changes').select('source').eq('tracker_id', tracker.id))
    assert.ok(hist.some((h) => h.source === 'ai_study_plan'))
    // plan settings and the personal timetable stay private
    await one(s1.c.from('study_plan_settings').upsert({ mode: 'auto', tracker_id: tracker.id }, { onConflict: 'user_id' }).select())
    for (const c of [subjT.c, classT.c, principal.c]) {
      assert.equal((await one(c.from('study_plan_settings').select('*'))).length, 0)
      assert.equal((await one(c.from('tasks').select('id').eq('tracker_id', tracker.id))).length, 0)
    }
    const other = await one(s2.c.from('trackers').insert({ name: 'Not mine' }).select().single())
    assert.ok((await s1.c.from('study_plan_settings').upsert({ tracker_id: other.id }, { onConflict: 'user_id' }).select()).error, 'can’t point at someone else’s timetable')
  })

  await test('the study_advice function plans for the student only', async () => {
    const tracker = (await one(s1.c.from('trackers').select('id').eq('name', 'My week').single())).id
    const r = await fn('timetable-ai', { action: 'study_advice', student_id: s1.membership, tracker_id: tracker }, s1.c)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(Array.isArray(r.body.plan.changes) && typeof r.body.version === 'string')
    const staff = await fn('timetable-ai', { action: 'study_advice', student_id: s1.membership, tracker_id: tracker }, subjT.c)
    assert.ok(staff.status >= 400, 'staff can’t use a student’s timetable')
    const other = await fn('timetable-ai', { action: 'study_advice', student_id: s1.membership, tracker_id: tracker }, s2.c)
    assert.ok(other.status >= 400)
  })

  // ------------------------------------------------------------------ revocation, archive
  await test('suspending a teacher cuts their access to marks and insights at once', async () => {
    await one(principal.c.rpc('set_member_status', { p_membership: subjT.membership, p_status: 'suspended', p_reason: 'Test suspension' }))
    // fresh client: the old session was signed out
    const c = client()
    await c.auth.signInWithPassword({ email: `st@${W.DOM_A}`, password: PASS })
    assert.equal((await one(c.from('marks').select('id'))).length, 0)
    assert.ok((await c.rpc('study_insights', { p_student: s1.membership })).error)
    assert.ok((await c.rpc('class_study_insights', { p_class: class10a })).error)
    await one(principal.c.rpc('set_member_status', { p_membership: subjT.membership, p_status: 'active' }))
  })

  await test('a linked parent sees a summary for their child only (no raw results, no self-ratings)', async () => {
    const email = `parent${suffix}@example.com`
    const link = await one(s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: email, p_name: 'Parent', p_relationship: 'father' }))
    const ok = await fn('institution-invite', { action: 'approve_guardian', link_id: link }, classT.c)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const token = new globalThis.URL(ok.body.activation_link).searchParams.get('token')
    assert.equal((await fn('institution-activate', { action: 'activate', token, password: PASS })).status, 200)
    const parent = client()
    await parent.auth.signInWithPassword({ email, password: PASS })
    const r = await one(parent.rpc('study_insights', { p_student: s1.membership }))
    assert.equal(r.viewer, 'parent')
    assert.ok(r.subjects.length === 3 && r.subjects.every((x) => !x.evidence.assessments && !('confidence' in x.evidence)))
    assert.ok(r.subjects.every((x) => x.reasons.every((y) => !/You rated/.test(y.text))))
    assert.ok((await parent.rpc('study_insights', { p_student: s2.membership })).error, 'not their child')
    assert.ok((await parent.rpc('class_study_insights', { p_class: class10a })).error, 'no class view')
    assert.ok((await parent.rpc('request_guardian_link', { p_inst: instA, p_email: `x${suffix}@example.com`, p_name: 'X', p_relationship: 'other' })).error, 'parents can’t start links')
  })

  await test('class teachers of an archived class can no longer approve parent links', async () => {
    const link = await one(s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: `mum${suffix}@example.com`, p_name: 'Mum', p_relationship: 'mother' }))
    assert.equal(await one(classT.c.rpc('can_approve_guardian', { p_link: link })), true)
    await one(principal.c.from('classes').update({ archived: true }).eq('id', class10a).select('id'))
    assert.equal(await one(classT.c.rpc('can_approve_guardian', { p_link: link })), false)
    const r = await fn('institution-invite', { action: 'approve_guardian', link_id: link }, classT.c)
    assert.ok(r.status >= 400)
    await one(principal.c.from('classes').update({ archived: false }).eq('id', class10a).select('id'))
  })

  console.log(`\n${passedCount()} passed`)
} finally {
  await cleanup(suffix)
}
