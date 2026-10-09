// Shared helpers for the institution test suites (run against the real project).
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'

export const URL = process.env.VITE_SUPABASE_URL
export const KEY = process.env.VITE_SUPABASE_ANON_KEY
export const REF = new globalThis.URL(URL).hostname.split('.')[0]
export const PASS = 'correct-horse-9'
export const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

let passed = 0
export async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack?.split('\n').slice(0, 3).join('\n    ') ?? e.message}`)
    process.exitCode = 1
  }
}
export const passedCount = () => passed

/** Server-side SQL through the Management API (setup, time travel, cleanup). */
export async function adminSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`admin sql ${r.status}: ${await r.text()}`)
  return r.json()
}

/** Calls an Edge Function as the given client (or anonymously). body may be FormData. */
export async function fn(name, body, c, headers = {}) {
  const token = c ? (await c.auth.getSession()).data.session?.access_token : null
  const isForm = body instanceof FormData
  const r = await fetch(`${URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: isForm ? body : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

export async function one(q) {
  const { data, error } = await q
  if (error) throw error
  return data
}

export async function individual(username) {
  const c = client()
  const { data, error } = await c.auth.signUp({ email: `${username}@habitflow.local`, password: PASS, options: { data: { username } } })
  if (error) throw error
  return { c, id: data.user.id }
}

/** Invite through the server function, activate through the public link, log in. */
export async function onboard(inviter, inst, email, role, name) {
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

/**
 * A ready-made school: institution A (principal, coordinator for grade 10,
 * class teacher of 10 A who teaches Science, subject teacher of Maths in 10 A,
 * student s1 in 10 A, student s2 in 10 B) and institution B with a principal.
 */
export async function buildSchool(suffix) {
  const DOM_A = `a${suffix}.example.edu`
  const DOM_B = `b${suffix}.example.edu`
  const owner = await individual(`owner_${suffix}`)
  await adminSql(`insert into public.platform_admins (user_id, note) values ('${owner.id}', 'test owner ${suffix}')`)
  const instA = await one(owner.c.rpc('platform_create_institution', { p_name: `Test School A ${suffix}`, p_kind: 'school', p_timezone: 'Asia/Kolkata' }))
  const instB = await one(owner.c.rpc('platform_create_institution', { p_name: `Test School B ${suffix}`, p_kind: 'school', p_timezone: 'UTC' }))
  await one(owner.c.from('institution_email_allowlist').insert([
    { institution_id: instA, kind: 'domain', value: DOM_A },
    { institution_id: instA, kind: 'email', value: `head@${DOM_A}` },
    { institution_id: instB, kind: 'email', value: `head@${DOM_B}` },
  ]).select())
  const principal = await onboard(owner.c, instA, `head@${DOM_A}`, 'principal', 'Head A')
  const principalB = await onboard(owner.c, instB, `head@${DOM_B}`, 'principal', 'Head B')
  const coord = await onboard(principal.c, instA, `coord@${DOM_A}`, 'coordinator', 'Coordinator')
  const classT = await onboard(principal.c, instA, `ct@${DOM_A}`, 'class_teacher', 'Class Teacher')
  const subjT = await onboard(principal.c, instA, `st@${DOM_A}`, 'subject_teacher', 'Subject Teacher')
  const s1 = await onboard(principal.c, instA, `s1@${DOM_A}`, 'student', 'Student One')
  const s2 = await onboard(principal.c, instA, `s2@${DOM_A}`, 'student', 'Student Two')

  const maths = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Mathematics' }).select().single())).id
  const science = (await one(principal.c.from('subjects').insert({ institution_id: instA, name: 'Science' }).select().single())).id
  const class10a = (await one(principal.c.from('classes').insert({ institution_id: instA, grade: '10', section: 'A', name: '10 A', class_teacher_id: classT.membership }).select().single())).id
  const class10b = (await one(principal.c.from('classes').insert({ institution_id: instA, grade: '10', section: 'B', name: '10 B' }).select().single())).id
  await one(principal.c.from('coordinator_scopes').insert({ institution_id: instA, coordinator_id: coord.membership, grade: '10' }).select())
  await one(principal.c.from('class_enrollments').insert([
    { institution_id: instA, class_id: class10a, student_id: s1.membership },
    { institution_id: instA, class_id: class10b, student_id: s2.membership },
  ]).select())
  await one(principal.c.from('teaching_assignments').insert([
    { institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership },
    { institution_id: instA, class_id: class10a, subject_id: science, teacher_id: classT.membership },
  ]).select())
  return { owner, instA, instB, DOM_A, principal, principalB, coord, classT, subjT, s1, s2, maths, science, class10a, class10b }
}

/** Fires the scheduled retention job exactly as pg_cron does, then waits for it. */
export async function runRetentionJob() {
  await adminSql(`select net.http_post(
    url := '${URL}/functions/v1/homework-retention',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-secret',
               (select decrypted_secret from vault.decrypted_secrets where name = 'homework_retention_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)`)
  await new Promise((r) => setTimeout(r, 9000))
}

export async function cleanup(suffix) {
  // Homework objects can only be deleted through the Storage API: move the test
  // assignments' deadlines into the past and let the retention job remove them.
  await adminSql(`
    update public.submissions s set last_submitted_at = now() - interval '40 days', reviewed_at = now() - interval '40 days'
      from public.institutions i where i.id = s.institution_id and i.name like '%${suffix}';
    update public.assignments a set opens_at = now() - interval '50 days', due_at = now() - interval '40 days', retention_hold = false, retention_hold_reason = null
      from public.institutions i where i.id = a.institution_id and i.name like '%${suffix}';
  `).catch(() => {})
  const left = await adminSql(`select count(*)::int n from public.submission_files f join public.institutions i on i.id = f.institution_id
                               where i.name like '%${suffix}' and f.deleted_at is null`).catch(() => [{ n: 0 }])
  if (left[0].n > 0) await runRetentionJob().catch(() => {})
  await adminSql(`
    delete from public.institutions where name like '%${suffix}';
    delete from public.audit_log where institution_id is not null and not exists (select 1 from public.institutions i where i.id = audit_log.institution_id);
    delete from public.audit_log where record_type = 'platform_admins' and new_value ->> 'note' like '%${suffix}%';
    delete from public.homework_file_deletions where not exists (select 1 from public.institutions i where i.id = homework_file_deletions.institution_id);
    delete from auth.users where email like '%${suffix}%';
  `).catch((e) => console.error('cleanup failed', e.message))
}

export const day = (offsetDays, hour) => {
  const d = new Date(Date.now() + offsetDays * 86400000)
  if (hour !== undefined) d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString()
}
