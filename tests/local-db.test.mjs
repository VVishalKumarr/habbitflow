// Database rules on a real Postgres (PGlite, in-process; no network or keys).
// Loads supabase/schema.sql with small stand-ins for Supabase's auth/storage/
// cron schemas, then calls the functions and reads the tables as different
// users with Row Level Security on: institution isolation, subject scope,
// role assignment, study insights and study plans.
// Run: node tests/local-db.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

console.log('Local database (PGlite)')
const db = new PGlite()
const prelude = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage; create schema extensions; create schema cron;
create function extensions.digest(text, text) returns bytea language sql immutable as $$ select sha256(convert_to($1, 'utf8')) $$;
create function extensions.digest(bytea, text) returns bytea language sql immutable as $$ select sha256($1) $$;
create function extensions.gen_random_bytes(int) returns bytea language sql as $$ select decode(md5(random()::text) || md5(random()::text), 'hex') $$;
create function extensions.crypt(text, text) returns text language sql as $$ select md5($1 || $2) $$;
create function extensions.gen_salt(text) returns text language sql as $$ select 'salt' $$;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}',
  created_at timestamptz default now(), updated_at timestamptz default now(), email_confirmed_at timestamptz, encrypted_password text, last_sign_in_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz, phone text, is_anonymous boolean default false);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid);
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text, identity_data jsonb, provider_id text, email text,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table cron.job (jobid bigserial, jobname text, schedule text, command text);
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
create function cron.unschedule(text) returns boolean language sql as $$ select true $$;
`
await db.exec(prelude)

/** Splits SQL into statements ($$ bodies, quotes and comments aware). */
function split(sql) {
  const out = []; let cur = ''; let i = 0; let dollar = null; let q = false
  while (i < sql.length) {
    const c = sql[i]
    if (!dollar && !q && c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); cur += sql.slice(i, e === -1 ? sql.length : e); i = e === -1 ? sql.length : e; continue }
    if (!q) { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40)); if (m) { if (!dollar) dollar = m[0]; else if (dollar === m[0]) dollar = null; cur += m[0]; i += m[0].length; continue } }
    if (!dollar && c === "'") q = !q
    if (!dollar && !q && c === ';') { out.push(cur + ';'); cur = ''; i++; continue }
    cur += c; i++
  }
  if (cur.trim()) out.push(cur)
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim() !== ';' && s.replace(/--[^\n]*/g, '').trim())
}

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8').replace(/create extension if not exists pg_(net|cron)[^;]*;/gi, '')
for (const st of split(schema)) {
  try {
    await db.exec(st)
  } catch (e) {
    console.log(`  ✗ schema.sql loads
    ${e.message}
    ${st.slice(0, 200)}`)
    process.exit(1)
  }
}
console.log('  ✓ schema.sql loads')

let passed = 0
const fails = []
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name) } catch (e) { fails.push(name); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]) }
}
const q = async (sql, params) => (await db.query(sql, params)).rows
/** Run as a signed-in user: role authenticated, auth.uid() = user. */
async function as(user, sql, params) {
  await db.exec(`set role authenticated`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user])
  try { return (await db.query(sql, params)).rows } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`) }
}
const fails_ = async (p) => { try { await p } catch (e) { return e.message } throw new Error('expected an error') }

// ---------------------------------------------------------------- setup (as owner, triggers that need a real sign-up off)
await db.exec(`set session_replication_role = replica`)
const U = {}
for (const k of ['P', 'C', 'CT', 'ST', 'S1', 'S2', 'PB', 'X', 'PAR']) {
  U[k] = (await q(`insert into auth.users (email) values ($1) returning id`, [`${k.toLowerCase()}@test.example`]))[0].id
}
const A = (await q(`insert into public.institutions (name) values ('School A') returning id`))[0].id
const B = (await q(`insert into public.institutions (name) values ('School B') returning id`))[0].id
const M = {}
for (const [k, inst, role] of [['P', A, 'principal'], ['C', A, 'coordinator'], ['CT', A, 'class_teacher'], ['ST', A, 'subject_teacher'], ['S1', A, 'student'], ['S2', A, 'student'], ['PB', B, 'principal'], ['PAR', A, 'parent']]) {
  M[k] = (await q(`insert into public.institution_memberships (institution_id, user_id, role, display_name) values ($1, $2, $3, $4) returning id`, [inst, U[k], role, k]))[0].id
}
const subj = async (name) => (await q(`insert into public.subjects (institution_id, name) values ($1, $2) returning id`, [A, name]))[0].id
const maths = await subj('Mathematics'); const science = await subj('Science'); const art = await subj('Art')
const c10a = (await q(`insert into public.classes (institution_id, grade, section, name, class_teacher_id) values ($1, '10', 'A', '10 A', $2) returning id`, [A, M.CT]))[0].id
const c10b = (await q(`insert into public.classes (institution_id, grade, section, name) values ($1, '10', 'B', '10 B') returning id`, [A]))[0].id
await q(`insert into public.class_enrollments (institution_id, class_id, student_id) values ($1, $2, $3), ($1, $4, $5)`, [A, c10a, M.S1, c10b, M.S2])
await q(`insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id) values ($1, $2, $3, $4), ($1, $2, $5, $6), ($1, $2, $7, $6)`, [A, c10a, maths, M.ST, science, M.CT, art])
await q(`insert into public.coordinator_scopes (institution_id, coordinator_id, grade) values ($1, $2, '10')`, [A, M.C])
const assess = async (subject, teacher, daysAgo, pct, kind = 'internal') => {
  const id = (await q(`insert into public.assessments (institution_id, class_id, subject_id, teacher_id, title, kind, max_marks, assessment_date, status, published_at)
                       values ($1, $2, $3, $4, $5, $6, 50, current_date - $7::int, 'published', now()) returning id`, [A, c10a, subject, teacher, `T${daysAgo}`, kind, daysAgo]))[0].id
  await q(`insert into public.marks (institution_id, assessment_id, student_id, obtained) values ($1, $2, $3, $4)`, [A, id, M.S1, pct / 2])
  return id
}
await assess(maths, M.ST, 40, 72); await assess(maths, M.ST, 25, 64); const lastM = await assess(maths, M.ST, 10, 55)
await assess(science, M.CT, 30, 85); await assess(science, M.CT, 12, 90)
await q(`insert into public.guardian_links (institution_id, student_id, guardian_email, guardian_name, relationship, requested_by, status, guardian_user_id)
         values ($1, $2, 'par@test.example', 'Par', 'mother', $3, 'active', $4)`, [A, M.S1, U.S1, U.PAR])
await db.exec(`set session_replication_role = origin`)

// ---------------------------------------------------------------- subject scope
await test('subject teacher sees only Maths assessments and marks; class teacher and coordinator see all', async () => {
  const subjects = async (u) => new Set((await as(u, `select subject_id from public.assessments`)).map((r) => r.subject_id))
  assert.deepEqual([...(await subjects(U.ST))], [maths])
  const ct = await subjects(U.CT); assert.ok(ct.has(maths) && ct.has(science))
  const co = await subjects(U.C); assert.ok(co.has(maths) && co.has(science))
  assert.equal((await as(U.ST, `select count(*)::int n from public.marks`))[0].n, 3)
  assert.equal((await as(U.CT, `select count(*)::int n from public.marks`))[0].n, 5)
  assert.equal((await as(U.PB, `select count(*)::int n from public.marks`))[0].n, 0)
  assert.equal((await as(U.S2, `select count(*)::int n from public.marks`))[0].n, 0)
})
await test('academic_summary and export_marks follow subject scope', async () => {
  const st = (await as(U.ST, `select public.academic_summary($1, $2, 120) r`, [A, c10a]))[0].r
  assert.equal(st.marks.marks, 3)
  const ct = (await as(U.CT, `select public.academic_summary($1, $2, 120) r`, [A, c10a]))[0].r
  assert.equal(ct.marks.marks, 5)
  assert.equal((await as(U.P, `select count(*)::int n from public.export_marks($1, null, current_date - 100, current_date)`, [A]))[0].n, 5)
  assert.match(await fails_(as(U.ST, `select * from public.export_marks($1, null, current_date - 100, current_date)`, [A])), /NOT_ALLOWED/)
})

// ---------------------------------------------------------------- insights
let ins
await test('student: Maths needs attention (falling), Science strong, Art not enough data', async () => {
  ins = (await as(U.S1, `select public.study_insights($1) r`, [M.S1]))[0].r
  const by = Object.fromEntries(ins.subjects.map((s) => [s.subject, s]))
  assert.equal(ins.viewer, 'student')
  assert.equal(by.Mathematics.status, 'needs_attention', JSON.stringify(by.Mathematics))
  assert.ok(by.Mathematics.reasons.some((r) => /fell over the last three assessments: 72.0% → 64.0% → 55.0%/.test(r.text)), JSON.stringify(by.Mathematics.reasons))
  assert.equal(by.Mathematics.recommended_minutes, 120)
  assert.equal(by.Science.status, 'strong', JSON.stringify(by.Science))
  assert.equal(by.Science.recommended_minutes, -30)
  assert.equal(by.Art.status, 'insufficient_data')
  assert.equal(by.Art.indicator, null)
  assert.ok(by.Mathematics.evidence.revisit.length >= 0 && by.Mathematics.analysed_at && by.Mathematics.history.length === 1)
})
await test('snapshots: none added when nothing changed; one added after a correction (improving)', async () => {
  const n0 = (await q(`select count(*)::int n from public.study_insight_snapshots`))[0].n
  await as(U.S1, `select public.study_insights($1)`, [M.S1])
  assert.equal((await q(`select count(*)::int n from public.study_insight_snapshots`))[0].n, n0)
  await q(`update public.marks set obtained = 40 where assessment_id = $1`, [lastM])
  const r = (await as(U.S1, `select public.study_insights($1) r`, [M.S1]))[0].r
  const m = r.subjects.find((s) => s.subject === 'Mathematics')
  assert.equal(m.status, 'improving', JSON.stringify(m))
  assert.equal(m.history.length, 2)
  await q(`update public.marks set obtained = 27.5 where assessment_id = $1`, [lastM])
})
await test('staff by subject; parents summary; everyone else refused', async () => {
  const st = (await as(U.ST, `select public.study_insights($1) r`, [M.S1]))[0].r
  assert.deepEqual(st.subjects.map((s) => s.subject), ['Mathematics'])
  assert.ok(!('confidence' in st.subjects[0].evidence))
  const ct = (await as(U.CT, `select public.study_insights($1) r`, [M.S1]))[0].r
  assert.equal(ct.subjects.length, 3)
  const par = (await as(U.PAR, `select public.study_insights($1) r`, [M.S1]))[0].r
  assert.equal(par.viewer, 'parent')
  assert.ok(par.subjects.every((s) => !s.evidence.assessments))
  for (const u of [U.S2, U.PB, U.X]) assert.match(await fails_(as(u, `select public.study_insights($1)`, [M.S1])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.PAR, `select public.study_insights($1)`, [M.S2])), /NOT_ALLOWED/)
})
await test('class view: subject teacher gets Maths rows only; other class/school refused', async () => {
  const rows = await as(U.ST, `select * from public.class_study_insights($1)`, [c10a])
  assert.ok(rows.length === 1 && rows[0].subject === 'Mathematics' && rows[0].status === 'needs_attention', JSON.stringify(rows))
  assert.ok(rows[0].top_reason)
  assert.equal((await as(U.CT, `select * from public.class_study_insights($1)`, [c10a])).length, 3)
  assert.match(await fails_(as(U.ST, `select * from public.class_study_insights($1)`, [c10b])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.PB, `select * from public.class_study_insights($1)`, [c10a])), /NOT_ALLOWED/)
})
await test('confidence: student only, own subjects; it shows in their reasons', async () => {
  await as(U.S1, `select public.set_subject_confidence($1, $2, 2)`, [A, maths])
  assert.match(await fails_(as(U.ST, `select public.set_subject_confidence($1, $2, 4)`, [A, maths])), /NOT_ALLOWED/)
  const hindi = await subj('Hindi')
  assert.match(await fails_(as(U.S1, `select public.set_subject_confidence($1, $2, 4)`, [A, hindi])), /NOT_ALLOWED/)
  const r = (await as(U.S1, `select public.study_insights($1) r`, [M.S1]))[0].r
  const m = r.subjects.find((s) => s.subject === 'Mathematics')
  assert.ok(m.reasons.some((x) => /confidence 2 out of 5/.test(x.text)))
  assert.equal(m.recommended_minutes, 150, '+30 for low confidence')
  assert.equal((await as(U.S2, `select count(*)::int n from public.subject_confidence`))[0].n, 0)
})
await test('rules: heads only, validated, deep-merged', async () => {
  assert.match(await fails_(as(U.C, `select public.set_study_rules($1, '{"attention_below": 40}')`, [A])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.PB, `select public.set_study_rules($1, '{"attention_below": 40}')`, [A])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.P, `select public.set_study_rules($1, '{"attention_below": 95}')`, [A])), /attention_below/)
  assert.match(await fails_(as(U.P, `select public.set_study_rules($1, '{"evil": 1}')`, [A])), /Unknown rule/)
  const r = (await as(U.P, `select public.set_study_rules($1, '{"extra_minutes": {"needs_attention": 90}}') r`, [A]))[0].r
  assert.equal(r.extra_minutes.needs_attention, 90); assert.equal(r.extra_minutes.improving, 60)
  assert.equal((await q(`select count(*)::int n from public.audit_log where record_type = 'study_insight_rules'`))[0].n, 1, 'audited')
  await q(`delete from public.study_insight_rules`)
})

// ---------------------------------------------------------------- roles
await test('only heads change roles; reason audited; person notified; nobody changes their own', async () => {
  assert.match(await fails_(as(U.C, `select public.update_member($1, null, null, 'coordinator')`, [M.ST])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.CT, `select public.update_member($1, null, null, 'coordinator')`, [M.ST])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.PB, `select public.update_member($1, null, null, 'coordinator')`, [M.ST])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.P, `select public.update_member($1, null, null, 'coordinator')`, [M.P])), /NOT_ALLOWED|own|Roles can only/)
  await as(U.P, `select public.update_member($1, null, null, 'coordinator', 'Leads maths')`, [M.ST])
  const [a] = await q(`select reason, old_value ->> 'role' o, new_value ->> 'role' n from public.audit_log where record_type = 'institution_memberships' and record_id = $1 and new_value ? 'role' order by created_at desc limit 1`, [M.ST])
  assert.deepEqual([a.reason, a.o, a.n], ['Leads maths', 'subject_teacher', 'coordinator'])
  assert.equal((await as(U.ST, `select count(*)::int n from public.notifications where kind = 'role_changed'`))[0].n, 1)
  await as(U.P, `select public.update_member($1, null, null, 'subject_teacher', 'Back')`, [M.ST])
  // 4-argument calls (older app) still work
  await as(U.P, `select public.update_member($1, 'ST renamed', null, null)`, [M.ST])
})
await test('coordinators assign subject teachers in scope; class/subject teachers cannot; scopes are heads-only', async () => {
  const hindi = (await q(`select id from public.subjects where name = 'Hindi'`))[0].id
  assert.ok(await fails_(as(U.CT, `insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id) values ($1, $2, $3, $4)`, [A, c10b, hindi, M.ST])))
  assert.ok(await fails_(as(U.ST, `insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id) values ($1, $2, $3, $4)`, [A, c10b, hindi, M.ST])))
  await as(U.C, `insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id) values ($1, $2, $3, $4)`, [A, c10b, hindi, M.ST])
  assert.ok(await fails_(as(U.C, `insert into public.coordinator_scopes (institution_id, coordinator_id, grade) values ($1, $2, '*')`, [A, M.C])))
})
await test('suspension blocks marks and insights at once', async () => {
  await as(U.P, `select public.set_member_status($1, 'suspended', 'Test')`, [M.ST])
  assert.equal((await as(U.ST, `select count(*)::int n from public.marks`))[0].n, 0)
  assert.match(await fails_(as(U.ST, `select public.study_insights($1)`, [M.S1])), /NOT_ALLOWED/)
  assert.match(await fails_(as(U.ST, `select public.set_member_status($1, 'active')`, [M.ST])), /NOT_ALLOWED/)
  await as(U.P, `select public.set_member_status($1, 'active')`, [M.ST])
})
await test('archived class: its class teacher can no longer approve parent links', async () => {
  const link = (await q(`insert into public.guardian_links (institution_id, student_id, guardian_email, guardian_name, relationship, requested_by)
                         values ($1, $2, 'x@test.example', 'X', 'father', $3) returning id`, [A, M.S1, U.S1]))[0].id
  assert.equal((await as(U.CT, `select public.can_approve_guardian($1) r`, [link]))[0].r, true)
  await q(`update public.classes set archived = true where id = $1`, [c10a])
  assert.equal((await as(U.CT, `select public.can_approve_guardian($1) r`, [link]))[0].r, false)
  await q(`update public.classes set archived = false where id = $1`, [c10a])
})

// ---------------------------------------------------------------- plans
await test('study plans: only add/re-label study sessions; undo restores', async () => {
  const tr = (await as(U.S1, `insert into public.trackers (name) values ('Week') returning id`))[0].id
  const sl = (await as(U.S1, `insert into public.time_slots (tracker_id, start_time, end_time) values ($1, '17:00', '18:00') returning id`, [tr]))[0].id
  const study = (await as(U.S1, `insert into public.tasks (tracker_id, time_slot_id, day_of_week, title, category) values ($1, $2, 1, 'Study', 'study') returning id`, [tr, sl]))[0].id
  const play = (await as(U.S1, `insert into public.tasks (tracker_id, time_slot_id, day_of_week, title, category) values ($1, $2, 2, 'Football', 'exercise') returning id`, [tr, sl]))[0].id
  const apply = (u, ops) => as(u, `select public.apply_timetable_change($1, null, public.timetable_version($1), 'ai_study_plan', 'Study plan: test', $2::jsonb) r`, [tr, JSON.stringify(ops)])
  assert.match(await fails_(apply(U.S1, [{ op: 'delete_task', task: play }])), /study plan can only/)
  assert.match(await fails_(apply(U.S1, [{ op: 'update_task', task: play, title: 'M', category: 'study', description: null }])), /study plan can only/)
  assert.match(await fails_(apply(U.S1, [{ op: 'add_task', slot: sl, day: 3, title: 'Gaming', category: 'personal', description: null }])), /study plan can only/)
  assert.ok(await fails_(apply(U.ST, [{ op: 'update_task', task: study, title: 'x', category: 'study', description: null }])))
  const r = (await apply(U.S1, [
    { op: 'update_task', task: study, title: 'Mathematics practice', category: 'study', description: 'Study plan: x' },
    { op: 'add_task', slot: sl, day: 4, title: 'Mathematics practice', category: 'study', description: 'Study plan: x' },
  ]))[0].r
  assert.equal((await as(U.S1, `select title from public.tasks where id = $1`, [study]))[0].title, 'Mathematics practice')
  await as(U.S1, `select public.undo_timetable_change($1)`, [r.change_id])
  assert.equal((await as(U.S1, `select title from public.tasks where id = $1`, [study]))[0].title, 'Study')
  assert.equal((await as(U.S1, `select count(*)::int n from public.tasks where tracker_id = $1`, [tr]))[0].n, 2)
  // settings are private and can't point at someone else's timetable
  await as(U.S1, `insert into public.study_plan_settings (mode, tracker_id) values ('auto', $1)`, [tr])
  assert.equal((await as(U.CT, `select count(*)::int n from public.study_plan_settings`))[0].n, 0)
  const other = (await as(U.S2, `insert into public.trackers (name) values ('Other') returning id`))[0].id
  assert.ok(await fails_(as(U.S1, `update public.study_plan_settings set tracker_id = $1`, [other])))
  assert.equal((await as(U.CT, `select count(*)::int n from public.tasks where tracker_id = $1`, [tr]))[0].n, 0, 'teachers never see the personal timetable')
})
await test('direct reads of the new tables are closed', async () => {
  for (const u of [U.S1, U.ST, U.P, U.PB]) assert.match(await fails_(as(u, `select count(*)::int n from public.study_insight_snapshots`)), /permission denied/)
  assert.equal((await as(U.PB, `select count(*)::int n from public.study_insight_rules where institution_id = $1`, [A]))[0].n, 0)
  assert.equal((await as(U.PB, `select public.study_rules($1) r`, [A]))[0].r, null, 'other school')
  assert.equal((await as(U.S1, `select public.study_rules($1) r`, [A]))[0].r, null, 'students get rules with their insights')
  assert.equal((await as(U.CT, `select public.study_rules($1) r`, [A]))[0].r.attention_below, 50)
  assert.match(await fails_(as(U.CT, `select public.study_rules_for($1)`, [A])), /permission denied/)
  assert.match(await fails_(as(U.CT, `select public.compute_study_insights($1)`, [M.S1])), /permission denied/)
  assert.match(await fails_(as(U.CT, `select public.deny('x', null, 'y')`)), /permission denied/)
})

console.log(`\n${passed} passed, ${fails.length} failed${fails.length ? ': ' + fails.join('; ') : ''}`)
if (fails.length) process.exitCode = 1
