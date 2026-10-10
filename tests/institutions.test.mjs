// Phase 1 institutional security tests, against the real Supabase project.
// Run: node --env-file=.env tests/institutions.test.mjs
// Needs SUPABASE_ACCESS_TOKEN in .env (only to make a test user platform
// owner and to clean up afterwards). Everything else goes through the same
// public API and server functions the app uses.
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const REF = new globalThis.URL(URL).hostname.split('.')[0]
const ADMIN_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const suffix = Date.now().toString(36)
const PASS = 'correct-horse-9'
const DOM_A = `a${suffix}.example.edu`
const DOM_B = `b${suffix}.example.edu`
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack?.split('\n').slice(0, 3).join('\n    ') ?? e.message}`)
    process.exitCode = 1
  }
}

async function adminSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`admin sql ${r.status}: ${await r.text()}`)
  return r.json()
}

async function fn(name, body, c) {
  const token = c ? (await c.auth.getSession()).data.session?.access_token : null
  const r = await fetch(`${URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function individual(username) {
  const c = client()
  const { data, error } = await c.auth.signUp({ email: `${username}@habitflow.local`, password: PASS, options: { data: { username } } })
  if (error) throw error
  return { c, id: data.user.id }
}

/** Invite through the server function, activate through the public link, then log in. */
async function onboard(inviter, inst, email, role, name) {
  const inv = await fn('institution-invite', { action: 'invite', institution_id: inst, email, role, display_name: name }, inviter)
  assert.equal(inv.status, 200, `invite ${email}: ${JSON.stringify(inv.body)}`)
  const token = new globalThis.URL(inv.body.activation_link).searchParams.get('token')
  const act = await fn('institution-activate', { action: 'activate', token, password: PASS })
  assert.equal(act.status, 200, `activate ${email}: ${JSON.stringify(act.body)}`)
  const c = client()
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASS })
  if (error) throw error
  const { data: mine } = await c.rpc('my_institutions')
  return { c, id: data.user.id, token, membership: mine.find((m) => m.institution_id === inst)?.membership_id }
}

const one = async (q) => {
  const { data, error } = await q
  if (error) throw error
  return data
}

console.log('Institution tests')
const owner = await individual(`owner_${suffix}`)
const nobody = await individual(`nobody_${suffix}`)
await adminSql(`insert into public.platform_admins (user_id, note) values ('${owner.id}', 'test owner ${suffix}')`)
let instA, instB
let principal, principalB, coord, classT, subjT, stud1, stud2
let year, maths, science, class10a, class11a, class10b

try {
  await test('public sign-up with a real email address is rejected', async () => {
    const { error } = await client().auth.signUp({ email: `x${suffix}@${DOM_A}`, password: PASS })
    assert.ok(error, 'expected rejection')
    const { error: e2 } = await client().auth.signUp({
      email: `y${suffix}@${DOM_A}`,
      password: PASS,
      options: { data: { activation_token: 'A'.repeat(43) } },
    })
    assert.ok(e2, 'a made-up activation token is refused')
  })

  await test('only the platform owner can create institutions', async () => {
    const { error } = await nobody.c.rpc('platform_create_institution', { p_name: 'Hack School', p_kind: 'school', p_timezone: 'UTC' })
    assert.match(error?.message ?? '', /platform owner/)
    instA = await one(owner.c.rpc('platform_create_institution', { p_name: `Test School A ${suffix}`, p_kind: 'school', p_timezone: 'Asia/Kolkata' }))
    instB = await one(owner.c.rpc('platform_create_institution', { p_name: `Test School B ${suffix}`, p_kind: 'college', p_timezone: 'UTC' }))
    assert.ok(instA && instB)
  })

  await test('allowlist: only the platform owner writes; public mail domains refused', async () => {
    const { error } = await nobody.c.from('institution_email_allowlist').insert({ institution_id: instA, kind: 'domain', value: DOM_A })
    assert.ok(error)
    const { error: gmail } = await owner.c.from('institution_email_allowlist').insert({ institution_id: instA, kind: 'domain', value: 'gmail.com' })
    assert.match(gmail?.message ?? '', /Public email providers/)
    await one(owner.c.from('institution_email_allowlist').insert([
      { institution_id: instA, kind: 'domain', value: DOM_A },
      { institution_id: instB, kind: 'domain', value: DOM_B },
    ]).select())
  })

  await test('a domain match alone cannot make someone principal', async () => {
    const r = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `head@${DOM_A}`, role: 'principal', display_name: 'Head' }, owner.c)
    assert.equal(r.status, 400)
    assert.match(r.body.error, /exact address/)
  })

  await test('non-members cannot invite; unapproved addresses are refused', async () => {
    const r = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `t@${DOM_A}`, role: 'subject_teacher', display_name: 'T' }, nobody.c)
    assert.equal(r.status, 400)
    const r2 = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `t@evil.example.com`, role: 'subject_teacher', display_name: 'T' }, owner.c)
    assert.match(r2.body.error, /approved list/)
    const r3 = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `t@${DOM_A}`, role: 'subject_teacher', display_name: 'T' })
    assert.equal(r3.status, 401)
  })

  await test('principal: exact allowlist → invitation → activation → email login', async () => {
    await one(owner.c.from('institution_email_allowlist').insert([
      { institution_id: instA, kind: 'email', value: `head@${DOM_A}` },
      { institution_id: instB, kind: 'email', value: `head@${DOM_B}` },
    ]).select())
    principal = await onboard(owner.c, instA, `head@${DOM_A}`, 'principal', 'Dr. Head A')
    principalB = await onboard(owner.c, instB, `head@${DOM_B}`, 'principal', 'Dr. Head B')
    const profile = await one(principal.c.from('profiles').select('account_type, display_name').single())
    assert.equal(profile.account_type, 'institutional')
    const mine = await one(principal.c.rpc('my_institutions'))
    assert.equal(mine.length, 1)
    assert.equal(mine[0].role, 'principal')
    assert.ok(mine[0].permissions.includes('manage_license'))
  })

  await test('activation links work once and can’t be guessed', async () => {
    const again = await fn('institution-activate', { action: 'activate', token: principal.token, password: PASS })
    assert.ok([404, 410].includes(again.status), `used link refused (${again.status})`)
    const bad = await fn('institution-activate', { action: 'inspect', token: 'x'.repeat(43) })
    assert.equal(bad.status, 404)
  })

  await test('principals cannot invite another principal; staff and students are invited', async () => {
    const r = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `head2@${DOM_A}`, role: 'director', display_name: 'X' }, principal.c)
    assert.match(r.body.error, /not allowed/)
    coord = await onboard(principal.c, instA, `coord@${DOM_A}`, 'coordinator', 'Ms. Coordinator')
    classT = await onboard(principal.c, instA, `ct@${DOM_A}`, 'class_teacher', 'Mr. Class')
    subjT = await onboard(principal.c, instA, `st@${DOM_A}`, 'subject_teacher', 'Ms. Subject')
    stud1 = await onboard(principal.c, instA, `s1@${DOM_A}`, 'student', 'Student One')
    stud2 = await onboard(principal.c, instA, `s2@${DOM_A}`, 'student', 'Student Two')
  })

  await test('coordinators can invite students but not staff', async () => {
    const r = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `t9@${DOM_A}`, role: 'subject_teacher', display_name: 'T9' }, coord.c)
    assert.match(r.body.error, /not allowed/)
    const ok = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `s9@${DOM_A}`, role: 'student', display_name: 'S9' }, coord.c)
    assert.equal(ok.status, 200)
    await one(coord.c.rpc('revoke_invitation', { p_invitation: ok.body.id }))
    const act = await fn('institution-activate', { action: 'inspect', token: new globalThis.URL(ok.body.activation_link).searchParams.get('token') })
    assert.notEqual(act.status, 200, 'revoked link must not work')
  })

  await test('nobody can raise their own role or permissions', async () => {
    const { error: e1 } = await stud1.c.from('institution_memberships').update({ role: 'principal' }).eq('id', stud1.membership)
    assert.ok(e1, 'direct update refused')
    const { error: e2 } = await coord.c.rpc('update_member', { p_membership: coord.membership, p_name: null, p_external_id: null, p_role: 'class_teacher' })
    assert.ok(e2, 'coordinator cannot administer staff')
    const { error: e3 } = await coord.c.from('institution_role_permissions').insert({ institution_id: instA, role: 'coordinator', permission: 'view_audit', allowed: true })
    assert.ok(e3, 'only heads edit permissions')
    const { error: e4 } = await principal.c.from('institution_role_permissions').insert({ institution_id: instA, role: 'coordinator', permission: 'manage_staff', allowed: true })
    assert.ok(e4, 'locked permissions cannot be granted')
    const { error: e5 } = await stud1.c.from('institution_memberships').insert({ institution_id: instB, user_id: stud1.id, role: 'principal', display_name: 'x' })
    assert.ok(e5)
    const { error: e6 } = await principal.c.rpc('update_member', { p_membership: subjT.membership, p_name: null, p_external_id: null, p_role: 'principal' })
    assert.match(e6?.message ?? '', /Roles can only change/)
  })

  await test('institutional login address cannot be changed by the user', async () => {
    const { error } = await stud1.c.auth.updateUser({ email: `other${suffix}@${DOM_A}` })
    assert.ok(error)
  })

  await test('academic structure: heads set years; coordinators manage only their grades', async () => {
    year = (await one(principal.c.from('academic_years').insert({ institution_id: instA, name: '2026–27', starts_on: '2026-04-01', ends_on: '2027-03-31', is_current: true }).select().single())).id
    const { error: ey } = await coord.c.from('academic_years').insert({ institution_id: instA, name: 'x', starts_on: '2026-04-01', ends_on: '2027-03-31' })
    assert.ok(ey)
    maths = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Mathematics', code: 'MATH' }).select().single())).id
    science = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Science' }).select().single())).id
    class10a = (await one(principal.c.from('classes').insert({ institution_id: instA, academic_year_id: year, grade: '10', section: 'A', name: '10 A', class_teacher_id: classT.membership }).select().single())).id
    class11a = (await one(principal.c.from('classes').insert({ institution_id: instA, academic_year_id: year, grade: '11', section: 'A', name: '11 A' }).select().single())).id
    await one(principal.c.from('coordinator_scopes').insert({ institution_id: instA, coordinator_id: coord.membership, grade: '10' }).select())
    class10b = (await one(coord.c.from('classes').insert({ institution_id: instA, grade: '10', section: 'B', name: '10 B' }).select().single())).id
    const { error: e11 } = await coord.c.from('classes').insert({ institution_id: instA, grade: '11', section: 'B', name: '11 B' })
    assert.ok(e11, 'grade 11 is outside the coordinator’s scope')
    const visible = await one(coord.c.from('classes').select('name'))
    assert.deepEqual(visible.map((c) => c.name).sort(), ['10 A', '10 B'])
    await one(coord.c.from('class_enrollments').insert([
      { institution_id: instA, class_id: class10a, student_id: stud1.membership },
      { institution_id: instA, class_id: class10b, student_id: stud2.membership },
    ]).select())
    await one(coord.c.from('teaching_assignments').insert([
      { institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership },
      { institution_id: instA, class_id: class10a, subject_id: science, teacher_id: classT.membership },
    ]).select())
    const { error: eStud } = await coord.c.from('class_enrollments').insert({ institution_id: instA, class_id: class10a, student_id: subjT.membership })
    assert.match(eStud?.message ?? '', /Only students/)
  })

  await test('tenant isolation: another institution sees and changes nothing', async () => {
    for (const t of ['classes', 'subjects', 'institution_memberships', 'academic_years', 'class_enrollments', 'assignments', 'institution_invitations', 'audit_log']) {
      const rows = await one(principalB.c.from(t).select('id').eq('institution_id', instA))
      assert.equal(rows.length, 0, `${t} leaked`)
    }
    const { error } = await principalB.c.from('classes').insert({ institution_id: instA, grade: '9', name: '9 X' })
    assert.ok(error)
    const { data: upd } = await principalB.c.from('classes').update({ name: 'pwned' }).eq('id', class10a).select()
    assert.equal(upd?.length ?? 0, 0)
    const { error: e2 } = await principalB.c.rpc('institution_overview', { p_inst: instA })
    assert.ok(e2)
    const { error: e3 } = await principalB.c.rpc('set_member_status', { p_membership: stud1.membership, p_status: 'suspended', p_reason: 'hack' })
    assert.ok(e3)
    // A class in B can't point at A's records.
    const bClass = await one(principalB.c.from('classes').insert({ institution_id: instB, grade: '1', name: '1 B' }).select().single())
    const { error: e4 } = await principalB.c.from('class_enrollments').insert({ institution_id: instB, class_id: bClass.id, student_id: stud1.membership })
    assert.ok(e4, 'cross-institution enrolment refused')
    const { error: e5 } = await principalB.c.from('classes').update({ institution_id: instA }).eq('id', bClass.id)
    assert.ok(e5, 'institution_id cannot change')
  })

  await test('students see their own class and staff, never other students', async () => {
    const classes = await one(stud1.c.from('classes').select('name'))
    assert.deepEqual(classes.map((c) => c.name), ['10 A'])
    const members = await one(stud1.c.from('institution_memberships').select('display_name, role'))
    assert.ok(members.some((m) => m.display_name === 'Student One'))
    assert.ok(!members.some((m) => m.display_name === 'Student Two'))
    assert.ok(members.some((m) => m.role === 'principal'))
    const inv = await one(stud1.c.from('institution_invitations').select('id'))
    assert.equal(inv.length, 0)
  })

  await test('teachers see only students in classes they teach', async () => {
    const seen = await one(subjT.c.from('institution_memberships').select('display_name').eq('role', 'student'))
    assert.deepEqual(seen.map((m) => m.display_name), ['Student One'])
  })

  await test('platform owner sees institution heads, not students', async () => {
    const seen = await one(owner.c.from('institution_memberships').select('role').eq('institution_id', instA))
    assert.ok(seen.length > 0 && seen.every((m) => ['principal', 'director'].includes(m.role)))
    const classes = await one(owner.c.from('classes').select('*').eq('institution_id', instA))
    assert.equal(classes.length, 0)
  })

  const day = (offset) => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + offset)
    d.setUTCHours(10, 0, 0, 0)
    return d
  }
  const iso = (d) => d.toISOString()
  const dateOnly = (d) => d.toISOString().slice(0, 10)
  let assignmentId

  await test('assignments: only for subjects you teach, window ≤ 1 month, start before deadline', async () => {
    const base = { institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Algebra 1' }
    const a = await one(subjT.c.from('assignments').insert({ ...base, opens_at: iso(day(0)), due_at: iso(day(5)) }).select().single())
    assignmentId = a.id
    assert.equal(a.review_retention_days, 7)
    const { error: tooLong } = await subjT.c.from('assignments').insert({ ...base, opens_at: iso(day(0)), due_at: iso(day(40)) })
    assert.ok(tooLong, 'window over one month refused')
    const { error: backwards } = await subjT.c.from('assignments').insert({ ...base, opens_at: iso(day(5)), due_at: iso(day(1)) })
    assert.ok(backwards, 'start after deadline refused')
    const { error: notTaught } = await subjT.c.from('assignments').insert({ ...base, subject_id: science, opens_at: iso(day(0)), due_at: iso(day(5)) })
    assert.ok(notTaught, 'not their subject')
    const { error: student } = await stud1.c.from('assignments').insert({ ...base, teacher_id: stud1.membership, opens_at: iso(day(0)), due_at: iso(day(5)) })
    assert.ok(student, 'students cannot create assignments')
    const { error: ret } = await subjT.c.from('assignments').update({ review_retention_days: 14 }).eq('id', a.id)
    assert.match(ret?.message ?? '', /coordinators/)
  })

  await test('homework retention: coordinators only, never above 14 days', async () => {
    const { error: e1 } = await subjT.c.rpc('set_homework_retention', { p_inst: instA, p_days: 3 })
    assert.ok(e1)
    const { error: e2 } = await coord.c.rpc('set_homework_retention', { p_inst: instA, p_days: 15 })
    assert.match(e2?.message ?? '', /14/)
    await one(coord.c.rpc('set_homework_retention', { p_inst: instA, p_days: 10 }))
    const { error: e3 } = await principal.c.from('institutions').update({ settings: { homework_retention_days: 30 } }).eq('id', instA)
    assert.match(e3?.message ?? '', /0 to 14/)
  })

  await test('students see published work for their class only', async () => {
    await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Draft', status: 'draft', opens_at: iso(day(0)), due_at: iso(day(5)) }).select())
    const s1 = await one(stud1.c.from('assignments').select('title'))
    assert.deepEqual(s1.map((a) => a.title), ['Algebra 1'])
    const s2 = await one(stud2.c.from('assignments').select('title'))
    assert.equal(s2.length, 0)
  })

  await test('cross-subject calendar flags overlapping deadlines, heavy days and exam clashes', async () => {
    await one(classT.c.from('assignments').insert([
      { institution_id: instA, class_id: class10a, subject_id: science, teacher_id: classT.membership, title: 'Lab report', opens_at: iso(day(0)), due_at: iso(day(5)) },
      { institution_id: instA, class_id: class10a, subject_id: science, teacher_id: classT.membership, title: 'Worksheet', opens_at: iso(day(0)), due_at: iso(day(5)) },
    ]).select())
    const { error: notAllowed } = await subjT.c.from('calendar_events').insert({ institution_id: instA, kind: 'exam', title: 'Hack exam', starts_on: dateOnly(day(5)), ends_on: dateOnly(day(5)) })
    assert.ok(notAllowed, 'subject teachers do not manage the calendar')
    await one(coord.c.from('calendar_events').insert({ institution_id: instA, kind: 'exam', title: 'Maths unit test', grade: '10', subject_id: maths, starts_on: dateOnly(day(5)), ends_on: dateOnly(day(5)) }).select())
    const { error: wide } = await coord.c.from('calendar_events').insert({ institution_id: instA, kind: 'holiday', title: 'Holiday', starts_on: dateOnly(day(6)), ends_on: dateOnly(day(6)) })
    assert.ok(wide, 'institution-wide events need an all-grades coordinator or a head')
    await one(principal.c.from('calendar_events').insert({ institution_id: instA, kind: 'holiday', title: 'Founders Day', starts_on: dateOnly(day(8)), ends_on: dateOnly(day(8)) }).select())
    await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Holiday homework', opens_at: iso(day(1)), due_at: iso(day(8)) }).select())

    const rows = await one(coord.c.rpc('deadline_calendar', { p_inst: instA, p_from: dateOnly(day(0)), p_to: dateOnly(day(20)) }))
    const d5 = rows.find((r) => r.day === dateOnly(day(5)) && r.class_name === '10 A')
    assert.ok(d5, 'day with deadlines present')
    assert.equal(d5.deadline_count, 3)
    assert.equal(d5.exam_count, 1)
    for (const f of ['overlapping_deadlines', 'heavy_day', 'exam_conflict']) assert.ok(d5.flags.includes(f), f)
    const d8 = rows.find((r) => r.day === dateOnly(day(8)) && r.class_name === '10 A')
    assert.ok(d8?.flags.includes('holiday'), 'deadline on a holiday is flagged')
    // 10 B gets the grade-10 exam but has no deadlines
    const b = rows.find((r) => r.class_name === '10 B')
    assert.ok(b && b.deadline_count === 0 && b.exam_count === 1)
    // a student only sees their class
    const mine = await one(stud2.c.rpc('deadline_calendar', { p_inst: instA, p_from: dateOnly(day(0)), p_to: dateOnly(day(20)) }))
    assert.ok(mine.every((r) => r.class_name === '10 B'))
    const filtered = await one(coord.c.rpc('deadline_calendar', { p_inst: instA, p_from: dateOnly(day(0)), p_to: dateOnly(day(20)), p_subject: science }))
    assert.ok(filtered.every((r) => r.deadlines.every((d) => d.subject === 'Science')))
    const ov = await one(coord.c.rpc('institution_overview', { p_inst: instA }))
    assert.ok(ov.conflicts_30d >= 2)
    assert.equal(ov.students, 2)
  })

  await test('deadline changes need approval and are audited', async () => {
    const req = await one(coord.c.from('deadline_change_requests').insert({ institution_id: instA, assignment_id: assignmentId, proposed_due_at: iso(day(7)), reason: 'Clashes with unit test' }).select().single())
    const { error: e1 } = await stud1.c.rpc('decide_deadline_change', { p_request: req.id, p_approve: true })
    assert.ok(e1)
    await one(subjT.c.rpc('decide_deadline_change', { p_request: req.id, p_approve: true, p_note: 'ok' }))
    const a = await one(subjT.c.from('assignments').select('due_at').eq('id', assignmentId).single())
    assert.equal(new Date(a.due_at).toISOString(), iso(day(7)))
    const audit = await one(principal.c.from('audit_log').select('action, old_value, new_value, reason').eq('record_type', 'assignments').eq('record_id', assignmentId))
    assert.ok(audit.some((x) => x.action === 'update' && x.new_value?.due_at && x.old_value?.due_at && x.reason === 'Clashes with unit test'))
  })

  await test('suspension blocks institutional data at once; reactivation restores it', async () => {
    const { error: noReason } = await principal.c.rpc('set_member_status', { p_membership: subjT.membership, p_status: 'suspended', p_reason: '' })
    assert.ok(noReason)
    const { error: self } = await principal.c.rpc('set_member_status', { p_membership: principal.membership, p_status: 'suspended', p_reason: 'test' })
    assert.ok(self)
    await one(principal.c.rpc('set_member_status', { p_membership: subjT.membership, p_status: 'suspended', p_reason: 'Policy review' }))
    // Session revoked server-side; the old access token (≤1h) no longer reaches any data.
    const classes = await one(subjT.c.from('classes').select('*'))
    assert.equal(classes.length, 0)
    const mine = await one(subjT.c.rpc('my_institutions'))
    assert.equal(mine[0].status, 'suspended')
    assert.deepEqual(mine[0].permissions, [])
    await one(principal.c.rpc('set_member_status', { p_membership: subjT.membership, p_status: 'active' }))
    const fresh = client()
    await fresh.auth.signInWithPassword({ email: `st@${DOM_A}`, password: PASS })
    assert.equal((await one(fresh.from('classes').select('id'))).length, 1)
  })

  await test('audit history: heads read it, nobody edits or deletes it', async () => {
    const rows = await one(principal.c.from('audit_log').select('id, action, record_type, actor_id').eq('institution_id', instA).limit(200))
    assert.ok(rows.length > 10)
    assert.ok(rows.some((r) => r.record_type === 'institution_memberships' && r.action === 'update'))
    const none = await one(stud1.c.from('audit_log').select('id'))
    assert.equal(none.length, 0)
    const { data: upd } = await principal.c.from('audit_log').update({ action: 'x' }).eq('id', rows[0].id).select()
    assert.ok(!upd?.length)
    const { data: del } = await principal.c.from('audit_log').delete().eq('id', rows[0].id).select()
    assert.ok(!del?.length)
    const tokens = await adminSql(`select count(*)::int n from public.audit_log where institution_id = '${instA}' and (old_value ? 'token_hash' or new_value ? 'token_hash')`)
    assert.equal(tokens[0].n, 0, 'no token hashes in the audit log')
  })

  await test('permission overrides apply to the role (class teacher gains manage_students)', async () => {
    const before = await one(classT.c.rpc('my_permissions', { p_inst: instA }))
    assert.ok(!before.includes('manage_students'))
    await one(principal.c.from('institution_role_permissions').insert({ institution_id: instA, role: 'class_teacher', permission: 'manage_students', allowed: true }).select())
    const after = await one(classT.c.rpc('my_permissions', { p_inst: instA }))
    assert.ok(after.includes('manage_students'))
  })

  await test('anonymous clients get nothing', async () => {
    const anon = client()
    for (const t of ['institutions', 'institution_memberships', 'classes', 'assignments', 'audit_log', 'institution_email_allowlist']) {
      const { data } = await anon.from(t).select('*')
      assert.ok(!data?.length, t)
    }
    const { error } = await anon.rpc('my_institutions')
    assert.ok(error)
  })
} finally {
  // Clean up: test institutions, their audit rows and all test accounts.
  await adminSql(`
    delete from public.institutions where name like '%${suffix}';
    delete from public.audit_log where institution_id is not null and not exists (select 1 from public.institutions i where i.id = audit_log.institution_id);
    delete from public.audit_log where record_type = 'platform_admins' and new_value ->> 'note' like '%${suffix}%';
    delete from auth.users where email like '%${suffix}%';
  `).catch((e) => console.error('cleanup failed', e.message))
}

console.log(`\n${passed} passed`)
