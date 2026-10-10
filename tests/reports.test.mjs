// Phase 7 tests: development scores, programmes, exports, CSV import and the
// academic-year transition. Runs against the real project.
//   node --env-file=.env tests/reports.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, client, day, fn, one, PASS, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('Reports, programmes, import/export tests')

const W = await buildSchool(suffix)
const { instA, principal, coord, classT, subjT, s1, s2, class10a, class10b, maths, science, DOM_A } = W

const calc = (c, student) => c.rpc('calculate_development_score', { p_student: student })
const settings = (s) => principal.c.from('institutions').update({ settings: s }).eq('id', instA).select('id')

try {
  // ---- data for s1 (10 A): 20 attendance days, 4 homework, 3 published marks ----
  await adminSql(`
    insert into public.attendance_records (institution_id, class_id, session_date, period, student_id, status)
    select '${instA}', '${class10a}', current_date - g, 0, '${s1.membership}', case when g % 10 = 0 then 'absent' when g % 7 = 0 then 'late' else 'present' end
      from generate_series(1, 20) g;
    insert into public.assignments (institution_id, class_id, subject_id, teacher_id, title, opens_at, due_at)
    select '${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'HW ' || g, now() - interval '20 days', now() - (g || ' days')::interval
      from generate_series(1, 4) g;
    insert into public.submissions (institution_id, assignment_id, student_id, status, attempt, first_submitted_at, last_submitted_at, is_late)
    select a.institution_id, a.id, '${s1.membership}', case when a.title = 'HW 4' then 'not_submitted' else 'accepted' end, 1, now(), now(), a.title = 'HW 3'
      from public.assignments a where a.class_id = '${class10a}' and a.title like 'HW %';
    insert into public.assessments (institution_id, class_id, subject_id, teacher_id, title, kind, max_marks, assessment_date, status, published_at)
    values ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Test 1', 'internal', 50, current_date - 10, 'published', now()),
           ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Test 2', 'internal', 50, current_date - 5, 'published', now()),
           ('${instA}', '${class10a}', '${science}', '${classT.membership}', 'Lab', 'practical', 20, current_date - 3, 'draft', null);
    insert into public.marks (institution_id, assessment_id, student_id, obtained)
    select a.institution_id, a.id, '${s1.membership}', case a.title when 'Test 1' then 40 when 'Test 2' then 30 else 20 end
      from public.assessments a where a.class_id = '${class10a}';
  `)

  let first
  await test('development score: weighted, explained; components without data left out', async () => {
    first = await one(calc(classT.c, s1.membership))
    const c = first.components
    assert.equal(c.academic.has_data, true)
    assert.equal(Number(c.academic.detail.average_pct), 70, 'draft marks are not counted')
    assert.equal(c.homework.has_data, true)
    assert.equal(Number(c.homework.score), Number(((1 + 1 + 0.6 + 0) / 4).toFixed(3)))
    assert.equal(c.attendance.has_data, true)
    assert.equal(c.planning.has_data, false)
    assert.equal(c.planning.detail.shared, false)
    assert.equal(c.extracurricular.has_data, false)
    // academic .70*35 + homework .65*20 + attendance ~ * 15 over 70 weight
    const att = Number(c.attendance.score)
    const expected = Math.round((1 + 9 * (0.7 * 35 + 0.65 * 20 + att * 15) / 70) * 10) / 10
    assert.equal(Number(first.score), expected)
    assert.equal(first.insufficient, false)
    assert.equal(c.academic.weight, 35)
  })

  await test('too little data gives “insufficient data”, never a low score', async () => {
    const r = await one(calc(classT.c, s2.membership).then((x) => x.error ? x : x)) // s2 isn't in classT's class
      .catch((e) => e)
    assert.match(String(r.message ?? ''), /NOT_ALLOWED/)
    const own = await one(calc(s2.c, s2.membership))
    assert.equal(own.insufficient, true)
    assert.equal(own.score, null)
  })

  await test('who can calculate and read reports', async () => {
    assert.match((await calc(subjT.c, s1.membership)).error?.message ?? '', /NOT_ALLOWED/, 'subject teachers have no view_reports')
    assert.match((await calc(s2.c, s1.membership)).error?.message ?? '', /NOT_ALLOWED/)
    await one(calc(s1.c, s1.membership))
    await one(calc(principal.c, s1.membership))
    assert.equal((await one(s2.c.from('development_scores').select('id').eq('student_id', s1.membership))).length, 0)
    assert.ok((await one(s1.c.from('development_scores').select('id').eq('student_id', s1.membership))).length >= 1)
    const again = await one(calc(classT.c, s1.membership))
    assert.equal(again.id, first.id, 'a repeat within 10 minutes returns the stored result')
    assert.ok((await s1.c.from('development_scores').insert({ institution_id: instA, student_id: s1.membership, period_from: '2026-01-01', period_to: '2026-01-02', score: 10, insufficient: false, components: {}, weights: {} })).error)
    assert.ok((await s1.c.rpc('compute_development', { p_student: s1.membership, p_from: '2026-01-01', p_to: '2026-02-01' })).error)
  })

  await test('weights are configurable and validated', async () => {
    assert.ok((await settings({ development_weights: { academic: 50, homework: 20, attendance: 15, planning: 15, extracurricular: 15 } })).error, 'must add up to 100')
    assert.ok((await settings({ development_weights: { academic: 100 } })).error, 'all five keys')
    await one(settings({ development_weights: { academic: 60, homework: 20, attendance: 20, planning: 0, extracurricular: 0 } }))
    await adminSql(`delete from public.development_scores where student_id = '${s1.membership}'`)
    const r = await one(calc(classT.c, s1.membership))
    assert.equal(r.weights.academic, 60)
    await one(settings({}))
    await adminSql(`delete from public.development_scores where student_id = '${s1.membership}'`)
  })

  let prog
  await test('programmes: who creates them, who sees them, join and check in', async () => {
    prog = (await one(coord.c.from('development_programmes').insert({ institution_id: instA, title: 'Reading habit', grade: '10', weekly_target: 3, starts_on: day(-7).slice(0, 10) }).select().single())).id
    const own = await classT.c.from('development_programmes').insert({ institution_id: instA, title: '10 A chess club', class_id: class10a, category: 'skill' }).select('id')
    assert.ok(!own.error, own.error?.message)
    assert.ok((await subjT.c.from('development_programmes').insert({ institution_id: instA, title: 'x', grade: '10' }).select('id')).error, 'no manage_programmes')
    assert.ok((await classT.c.from('development_programmes').insert({ institution_id: instA, title: 'x', class_id: class10b }).select('id')).error, 'not their class')
    const s2sees = await one(s2.c.rpc('programmes_overview', { p_inst: instA }))
    assert.deepEqual(s2sees.map((p) => p.title), ['Reading habit'], '10 B sees the grade programme, not 10 A’s club')
    await one(s1.c.rpc('join_programme', { p_programme: prog }))
    await one(s1.c.rpc('programme_checkin', { p_programme: prog }))
    await one(s1.c.rpc('programme_checkin', { p_programme: prog, p_day: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), p_note: 'Ch. 3' }))
    assert.ok((await s1.c.rpc('programme_checkin', { p_programme: prog, p_day: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) })).error, 'not in the future')
    assert.ok((await s2.c.rpc('programme_checkin', { p_programme: prog })).error, 'join first')
    assert.ok((await s1.c.rpc('join_programme', { p_programme: own.data[0].id })).error === null)
    assert.ok((await s2.c.rpc('join_programme', { p_programme: own.data[0].id })).error, 'not their class')
    const mine = (await one(s1.c.rpc('programmes_overview', { p_inst: instA }))).find((p) => p.id === prog)
    assert.equal(mine.joined, true)
    assert.equal(mine.my_checked_in_today, true)
    const staff = (await one(coord.c.rpc('programmes_overview', { p_inst: instA }))).find((p) => p.id === prog)
    assert.equal(staff.members, 1)
    const members = await one(classT.c.rpc('programme_members_report', { p_programme: prog }))
    assert.equal(members[0].checkins_4w, 2)
    assert.equal((await one(s2.c.rpc('programme_members_report', { p_programme: prog }))).length, 0, 'students can’t list members')
    assert.equal((await one(s2.c.from('programme_checkins').select('id'))).length, 0)
  })

  await test('extracurricular and (shared) planning count; unhealthy schedules are capped', async () => {
    let r = await one(calc(s1.c, s1.membership))
    assert.equal(r.components.extracurricular.has_data, true)
    assert.equal(r.components.extracurricular.detail.programmes, 2)
    // a personal timetable with a late-night slot, ticked every day
    await one(s1.c.rpc('apply_timetable_change', {
      p_tracker: null, p_new_name: 'Week', p_base_version: null, p_source: 'voice', p_summary: 'seed',
      p_ops: [{ op: 'add_slot', ref: 'a', start: '23:00', end: '23:45' }, ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ op: 'add_task', slot_ref: 'a', day: d, title: 'Revise', category: 'study', description: null }))],
    }))
    await adminSql(`insert into public.task_completions (task_id, tracker_id, user_id, completion_date, completed)
                    select t.id, t.tracker_id, t.user_id, d::date, true from public.tasks t, generate_series(current_date - 27, current_date, interval '1 day') d
                     where t.user_id = '${s1.id}' and t.day_of_week = extract(dow from d)::int`)
    await adminSql(`delete from public.development_scores where student_id = '${s1.membership}'`)
    r = await one(calc(s1.c, s1.membership))
    assert.equal(r.components.planning.has_data, false, 'not shared yet')
    await one(s1.c.from('profiles').update({ share_habits_with_school: true }).eq('id', s1.id).select('id'))
    await adminSql(`delete from public.development_scores where student_id = '${s1.membership}'`)
    r = await one(calc(s1.c, s1.membership))
    assert.equal(r.components.planning.has_data, true)
    assert.equal(r.components.planning.detail.healthy, false)
    assert.equal(Number(r.components.planning.score), 0.6, 'ticked everything, but late nights are capped')
  })

  await test('class report and calculating a whole class', async () => {
    assert.equal(await one(classT.c.rpc('calculate_class_development', { p_class: class10a })), 1)
    const rep = await one(classT.c.rpc('class_report', { p_class: class10a }))
    assert.equal(rep.class, '10 A')
    assert.equal(rep.students.length, 1)
    assert.ok(rep.students[0].latest.score)
    assert.ok(rep.students[0].attendance_rate > 0.8)
    assert.match((await classT.c.rpc('class_report', { p_class: class10b })).error?.message ?? '', /NOT_ALLOWED/)
    assert.match((await subjT.c.rpc('class_report', { p_class: class10a })).error?.message ?? '', /NOT_ALLOWED/)
  })

  await test('exports return only visible classes and are logged', async () => {
    const from = day(-60).slice(0, 10)
    const to = day(1).slice(0, 10)
    const att = await one(principal.c.rpc('export_attendance', { p_inst: instA, p_class: null, p_from: from, p_to: to }))
    assert.equal(att.length, 20)
    assert.equal(att[0].student, 'Student One')
    const marks = await one(classT.c.rpc('export_marks', { p_inst: instA, p_class: null, p_from: from, p_to: to }))
    assert.equal(marks.length, 3, 'class teacher sees all marks of their class incl. drafts')
    assert.ok(marks.every((m) => m.class === '10 A'))
    assert.match((await subjT.c.rpc('export_marks', { p_inst: instA, p_class: null, p_from: from, p_to: to })).error?.message ?? '', /NOT_ALLOWED/)
    assert.match((await s1.c.rpc('export_attendance', { p_inst: instA, p_class: null, p_from: from, p_to: to })).error?.message ?? '', /NOT_ALLOWED/)
    const hw = await one(principal.c.rpc('export_assignments', { p_inst: instA, p_class: class10a, p_from: from, p_to: to }))
    assert.equal(hw.length, 4)
    assert.equal(hw.find((h) => h.title === 'HW 4').missing, 1)
    const dev = await one(principal.c.rpc('export_development', { p_inst: instA, p_class: null }))
    assert.ok(dev.find((d) => d.student === 'Student One').score)
    await one(principal.c.rpc('log_export', { p_inst: instA, p_kind: 'attendance', p_rows: 20, p_filters: { from } }))
    const [{ n }] = await adminSql(`select count(*)::int n from public.audit_log where institution_id = '${instA}' and action = 'export'`)
    assert.equal(n, 1)
  })

  // ---- import ----
  await test('people import preview: row errors, duplicates, existing accounts, permissions', async () => {
    const rows = [
      { email: `new1@${DOM_A}`, name: 'New One', external_id: 'A-100', class: '10 A' },
      { email: 'not-an-email', name: 'Bad' },
      { email: `new1@${DOM_A}`, name: 'Dup' },
      { email: 'x@elsewhere.org', name: 'Outside' },
      { email: `new2@${DOM_A}`, name: 'No Class', class: '12 Z' },
      { email: `s2@${DOM_A}`, name: 'Student Two', class: '10 A' },
      { email: `s1@${DOM_A}`, name: 'Student One', class: '10 A' },
      { email: `new3@${DOM_A}`, name: '', external_id: 'A-100' },
    ]
    const res = await one(principal.c.rpc('import_check_people', { p_inst: instA, p_role: 'student', p_rows: rows }))
    const st = res.map((r) => `${r.status}:${r.action}`)
    assert.deepEqual(st, ['ok:invite', 'error:none', 'error:none', 'error:none', 'error:none', 'ok:enrol', 'skip:none', 'error:none'])
    assert.match(res[2].messages[0], /Duplicate email/)
    assert.match(res[3].messages.join(), /approved list/)
    assert.match(res[4].messages.join(), /not found/)
    assert.match(res[7].messages.join(), /Duplicate admission/)
    const denied = await one(coord.c.rpc('import_check_people', { p_inst: instA, p_role: 'student', p_rows: rows.slice(0, 1) }))
    assert.match(denied[0].messages[0], /permission to import/, 'coordinators lack import_export by default')
    const staff = await one(principal.c.rpc('import_check_people', { p_inst: instA, p_role: 'principal', p_rows: rows.slice(0, 1) }))
    assert.equal(staff[0].status, 'error', 'heads can’t be imported')
  })

  await test('people import: invites (role from the request), enrols existing students, activation enrols in the class', async () => {
    const r = await fn('institution-invite', {
      action: 'bulk_import', institution_id: instA, role: 'student', file_name: 'students.csv', first_row: 1,
      rows: [
        { email: `new1@${DOM_A}`, name: 'New One', external_id: 'A-100', class: '10 A' },
        { email: `s2@${DOM_A}`, name: 'Student Two', class: '10 A' },
        { email: 'bad', name: 'Bad' },
      ],
    }, principal.c)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.results.map((x) => x.status), ['done', 'done', 'error'])
    assert.equal(r.body.results[1].action, 'enrolled')
    const enrolled = await adminSql(`select count(*)::int n from public.class_enrollments where class_id = '${class10a}' and student_id = '${s2.membership}'`)
    assert.equal(enrolled[0].n, 1)
    const link = r.body.results[0].activation_link
    assert.ok(link, 'manual-link mode returns the link')
    const act = await fn('institution-activate', { action: 'activate', token: new URL(link).searchParams.get('token'), password: PASS })
    assert.equal(act.status, 200, JSON.stringify(act.body))
    const [m] = await adminSql(`select m.role, m.external_id, (select count(*)::int from public.class_enrollments e where e.student_id = m.id and e.class_id = '${class10a}') n
                                 from public.institution_memberships m join auth.users u on u.id = m.user_id where u.email = 'new1@${DOM_A}'`)
    assert.deepEqual(m, { role: 'student', external_id: 'A-100', n: 1 })
    const [run] = await adminSql(`select kind, total, created, failed from public.import_runs where institution_id = '${instA}' and kind = 'students'`)
    assert.deepEqual(run, { kind: 'students', total: 3, created: 2, failed: 1 })
    const deny = await fn('institution-invite', { action: 'bulk_import', institution_id: instA, role: 'student', rows: [{ email: `new5@${DOM_A}`, name: 'X' }] }, classT.c)
    assert.equal(deny.body.results[0].status, 'error', 'class teacher has no import_export')
    const head = await fn('institution-invite', { action: 'bulk_import', institution_id: instA, role: 'principal', rows: [{ email: `new6@${DOM_A}`, name: 'X' }] }, principal.c)
    assert.equal(head.status, 400)
  })

  await test('classes and subject-teacher import: preview, commit, duplicates, unknown teachers', async () => {
    const rows = [
      { name: '11 A', grade: '11', section: 'A', class_teacher: `ct@${DOM_A}` },
      { name: '11 B', grade: '11', section: 'B', class_teacher: 'nobody@x.org' },
      { name: '10 A', grade: '10' },
      { name: '11 A', grade: '11' },
    ]
    const pre = await one(principal.c.rpc('import_classes', { p_inst: instA, p_rows: rows }))
    assert.deepEqual(pre.map((r) => r.status), ['ok', 'error', 'skip', 'error'], JSON.stringify(pre))
    assert.equal((await adminSql(`select count(*)::int n from public.classes where institution_id = '${instA}' and name = '11 A'`))[0].n, 0, 'preview writes nothing')
    const done = await one(principal.c.rpc('import_classes', { p_inst: instA, p_rows: rows, p_commit: true, p_file: 'classes.csv' }))
    assert.deepEqual(done.map((r) => r.status), ['done', 'error', 'skip', 'error'])
    assert.ok((await coord.c.rpc('import_classes', { p_inst: instA, p_rows: rows })).error, 'no import_export')
    const t = [
      { class: '11 A', subject: 'Mathematics', teacher: `st@${DOM_A}` },
      { class: '11 A', subject: 'History', teacher: `ct@${DOM_A}` },
      { class: '10 A', subject: 'Mathematics', teacher: `st@${DOM_A}` },
      { class: '11 A', subject: 'Art', teacher: 'ghost@x.org' },
    ]
    const tp = await one(principal.c.rpc('import_teaching', { p_inst: instA, p_rows: t }))
    assert.deepEqual(tp.map((r) => r.status), ['ok', 'ok', 'skip', 'error'])
    assert.match(tp[1].messages.join(), /New subject “History”/)
    await one(principal.c.rpc('import_teaching', { p_inst: instA, p_rows: t, p_commit: true, p_file: 'teachers.csv' }))
    const [{ n }] = await adminSql(`select count(*)::int n from public.subjects where institution_id = '${instA}' and name = 'History'`)
    assert.equal(n, 1)
    const runs = await adminSql(`select kind from public.import_runs where institution_id = '${instA}' order by created_at`)
    assert.deepEqual(runs.map((x) => x.kind), ['students', 'students', 'classes', 'teaching'], 'refused attempts are logged too')
  })

  await test('academic-year transition: only heads, every class decided, history kept', async () => {
    await one(principal.c.from('academic_years').insert({ institution_id: instA, name: '2026-27', starts_on: '2026-04-01', ends_on: '2027-03-31', is_current: true }).select('id'))
    await adminSql(`update public.classes set academic_year_id = (select id from public.academic_years where institution_id = '${instA}' and is_current) where institution_id = '${instA}'`)
    assert.match((await coord.c.rpc('year_transition_preview', { p_inst: instA })).error?.message ?? '', /NOT_ALLOWED/)
    const pre = await one(principal.c.rpc('year_transition_preview', { p_inst: instA }))
    const a = pre.classes.find((c) => c.name === '10 A')
    assert.equal(a.suggested_action, 'promote')
    assert.equal(a.suggested_name, '11 A')
    assert.equal(pre.classes.find((c) => c.name === '11 A').suggested_action, 'graduate')
    const plan = pre.classes.map((c) => ({ class_id: c.id, action: c.suggested_action, grade: c.suggested_grade, name: c.suggested_name }))
    assert.match((await principal.c.rpc('year_transition', { p_inst: instA, p_name: '2027-28', p_starts: '2027-04-01', p_ends: '2028-03-31', p_plan: plan.slice(1) })).error?.message ?? '', /every class/)
    const r = await one(principal.c.rpc('year_transition', { p_inst: instA, p_name: '2027-28', p_starts: '2027-04-01', p_ends: '2028-03-31', p_plan: plan, p_copy_teachers: true }))
    assert.equal(r.archived_classes, pre.classes.length)
    const [newA] = await adminSql(`select c.id, c.class_teacher_id, (select count(*)::int from public.class_enrollments e where e.class_id = c.id) students,
                                     (select count(*)::int from public.teaching_assignments t where t.class_id = c.id) teachers
                                     from public.classes c where c.institution_id = '${instA}' and c.name = '11 A' and not c.archived`)
    assert.equal(newA.students, 3, '10 A’s students moved up')
    assert.equal(newA.class_teacher_id, classT.membership)
    assert.ok(newA.teachers >= 2)
    const old = await adminSql(`select archived, (select count(*)::int from public.class_enrollments e where e.class_id = c.id) n from public.classes c where c.id = '${class10a}'`)
    assert.deepEqual(old[0], { archived: true, n: 3 }, 'old class archived, enrolments kept')
    const [{ att }] = await adminSql(`select count(*)::int att from public.attendance_records where class_id = '${class10a}'`)
    assert.equal(att, 20, 'attendance history preserved')
    const years = await adminSql(`select name, is_current, archived from public.academic_years where institution_id = '${instA}' order by starts_on`)
    assert.deepEqual(years, [{ name: '2026-27', is_current: false, archived: true }, { name: '2027-28', is_current: true, archived: false }])
    assert.match((await principal.c.rpc('year_transition', { p_inst: instA, p_name: '2027-28', p_starts: '2028-04-01', p_ends: '2029-03-31', p_plan: [] })).error?.message ?? '', /already exists/)
    void client
  })
} finally {
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
