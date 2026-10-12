// Phase 9 security review: attacks against the real project.
// * cross-institution ID tampering (every institution-scoped table and RPC)
// * role self-escalation
// * entitlement forging
// * storage access
// * database-wide checks (RLS everywhere, definer functions pinned, no
//   client-callable server-only functions)
//   node --env-file=.env tests/security-review.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, client, day, fn, individual, one, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('Security review')

const W = await buildSchool(suffix)
const { owner, instA, instB, principal, principalB, coord, classT, subjT, s1, s2, class10a, maths } = W
const ZERO = '00000000-0000-0000-0000-000000000000'
const pdf = () => new TextEncoder().encode('%PDF-1.4\n% security review\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

const TABLES = ('academic_years,ai_usage,announcements,assessments,assignments,attendance_records,audit_log,calendar_events,class_enrollments,' +
  'class_periods,classes,code_redemptions,conversations,coordinator_scopes,deadline_change_requests,development_programmes,development_scores,' +
  'guardian_links,homework_file_deletions,import_runs,institution_ai_pools,institution_ai_quotas,institution_email_allowlist,institution_invitations,' +
  'institution_licenses,institution_memberships,institution_role_permissions,license_codes,marks,notifications,programme_checkins,programme_members,' +
  'study_insight_rules,study_insight_snapshots,subject_confidence,subjects,submission_files,submission_reviews,submissions,teaching_assignments,terms').split(',')

try {
  const stranger = await individual(`sec_${suffix}`)
  // ---- data in institution A ----
  const hw = await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Secret HW', opens_at: day(-1), due_at: day(3) }).select().single())
  const f = new FormData()
  f.append('action', 'upload')
  f.append('assignment_id', hw.id)
  f.append('file', new Blob([pdf()], { type: 'application/pdf' }), 'work.pdf')
  const up = await fn('homework', f, s1.c)
  assert.equal(up.status, 200, JSON.stringify(up.body))
  await one(classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: day(0).slice(0, 10), p_period: 0, p_entries: [{ student_id: s1.membership, status: 'present' }] }))
  await one(principal.c.from('announcements').insert({ institution_id: instA, title: 'Staff only', body: 'x', audience: 'staff' }).select('id')).catch(() => null)
  await one(coord.c.from('development_programmes').insert({ institution_id: instA, title: 'A programme', grade: '10' }).select('id'))
  await one(s1.c.rpc('calculate_development_score', { p_student: s1.membership }))

  const attackers = [['principal of another school', principalB.c], ['personal account', stranger.c], ['student in the same school', s2.c]]

  await test('cross-institution: no institution-scoped table leaks rows of school A', async () => {
    const leaks = []
    for (const [who, c] of attackers.slice(0, 2)) {
      for (const t of TABLES) {
        const { data, error } = await c.from(t).select('*').eq('institution_id', instA).limit(1)
        if (!error && data.length) leaks.push(`${who}: ${t}`)
      }
    }
    assert.deepEqual(leaks, [])
  })

  await test('cross-institution: updates and deletes on school A rows affect nothing', async () => {
    const changed = []
    for (const t of ['classes', 'assignments', 'attendance_records', 'institution_memberships', 'subjects', 'development_programmes', 'academic_years']) {
      const u = await principalB.c.from(t).update({ updated_at: new Date().toISOString() }).eq('institution_id', instA).select('id')
      if (!u.error && u.data.length) changed.push(`update ${t}`)
      const d = await principalB.c.from(t).delete().eq('institution_id', instA).select('id')
      if (!d.error && d.data.length) changed.push(`delete ${t}`)
    }
    assert.deepEqual(changed, [])
    const [{ n }] = await adminSql(`select count(*)::int n from public.classes where institution_id = '${instA}'`)
    assert.equal(n, 2)
  })

  await test('cross-institution: IDs from school A can’t be used in school B', async () => {
    // B's head tries to enrol A's student / attach A's class or subject into B rows
    const cls = await principalB.c.from('classes').insert({ institution_id: instB, grade: '1', name: 'B1' }).select().single()
    assert.ok(!cls.error, cls.error?.message)
    const enrol = await principalB.c.from('class_enrollments').insert({ institution_id: instB, class_id: cls.data.id, student_id: s1.membership }).select('id')
    assert.ok(enrol.error, 'student of A into class of B')
    const enrolA = await principalB.c.from('class_enrollments').insert({ institution_id: instA, class_id: class10a, student_id: s2.membership }).select('id')
    assert.ok(enrolA.error, 'writing into A')
    const hwB = await principalB.c.from('assignments').insert({ institution_id: instB, class_id: cls.data.id, subject_id: maths, teacher_id: principalB.membership, title: 'x', opens_at: day(0), due_at: day(2) }).select('id')
    assert.ok(hwB.error, 'subject of A in B')
    const move = await principalB.c.from('classes').update({ institution_id: instA }).eq('id', cls.data.id).select('id')
    assert.ok(move.error || move.data.length === 0, 'rows never move between institutions')
  })

  await test('cross-institution: RPCs with school A’s IDs refuse or return nothing', async () => {
    const calls = [
      ['institution_overview', { p_inst: instA }],
      ['academic_summary', { p_inst: instA }],
      ['deadline_calendar', { p_inst: instA, p_from: day(-1).slice(0, 10), p_to: day(10).slice(0, 10) }],
      ['class_report', { p_class: class10a }],
      ['calculate_development_score', { p_student: s1.membership }],
      ['calculate_class_development', { p_class: class10a }],
      ['export_attendance', { p_inst: instA, p_class: null, p_from: day(-5).slice(0, 10), p_to: day(1).slice(0, 10) }],
      ['export_marks', { p_inst: instA, p_class: null, p_from: day(-5).slice(0, 10), p_to: day(1).slice(0, 10) }],
      ['export_development', { p_inst: instA, p_class: null }],
      ['programmes_overview', { p_inst: instA }],
      ['teacher_student_timetables', { p_student: s1.membership }],
      ['year_transition_preview', { p_inst: instA }],
      ['import_classes', { p_inst: instA, p_rows: [{ name: 'Evil', grade: '9' }], p_commit: true }],
      ['institution_ai_overview', { p_inst: instA }],
      ['institution_license_status', { p_inst: instA }],
      ['guardian_child_view', { p_student: s1.membership }],
      ['timetable_conflicts', { p_inst: instA }],
    ]
    const leaks = []
    for (const [name, args] of calls) {
      for (const [who, c] of attackers.slice(0, 2)) {
        const { data, error } = await c.rpc(name, args)
        const empty = data === null || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && data && Object.keys(data).length === 0)
        if (!error && !empty) leaks.push(`${who}: ${name} → ${JSON.stringify(data).slice(0, 80)}`)
      }
    }
    // A people-import preview may answer, but only with refusals.
    const imp = await one(principalB.c.rpc('import_check_people', { p_inst: instA, p_role: 'student', p_rows: [{ email: `x@${W.DOM_A}`, name: 'X' }] }))
    assert.equal(imp[0].status, 'error')
    assert.deepEqual(leaks, [], leaks.join(' || '))
    assert.equal((await adminSql(`select count(*)::int n from public.classes where name = 'Evil'`))[0].n, 0)
  })

  await test('sweep: every client-callable function, called by outsiders with school A’s IDs, refuses or returns nothing', async () => {
    const fns = await adminSql(`select p.proname name, coalesce(p.proargnames, '{}') args, array(select format_type(t, null) from unnest(p.proargtypes) t) types, p.pronargs n
                                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype and p.prokind = 'f'
                                  and has_function_privilege('authenticated', p.oid, 'execute')
                                order by 1`)
    const prog = (await adminSql(`select id from public.development_programmes where institution_id = '${instA}' limit 1`))[0].id
    const sub = (await adminSql(`select id from public.submissions where institution_id = '${instA}' limit 1`))[0].id
    const file = (await adminSql(`select id from public.submission_files where institution_id = '${instA}' limit 1`))[0].id
    const score = (await adminSql(`select id from public.development_scores where institution_id = '${instA}' limit 1`))[0].id
    const ids = { p_inst: instA, p_class: class10a, p_student: s1.membership, p_member: s1.membership, p_membership: s1.membership, p_assignment: hw.id,
      p_programme: prog, p_submission: sub, p_file: file, p_id: s1.membership, p_score: score, p_subject: maths, p_teacher: subjT.membership }
    const value = (name, type) => {
      if (type === 'uuid') return ids[name] ?? ZERO
      if (type === 'uuid[]') return [hw.id]
      if (type === 'date') return day(0).slice(0, 10)
      if (type === 'timestamp with time zone') return day(0)
      if (/int|numeric/.test(type)) return 1
      if (type === 'boolean') return name === 'p_commit'
      if (type === 'jsonb' || type === 'json') return /rows|plan|ops|entries/.test(name) ? [{ name: 'Evil', grade: '9', class_id: class10a, student_id: s1.membership, status: 'absent', op: 'delete_task', task: ZERO }] : {}
      if (type === 'text[]') return ['x']
      return 'x'
    }
    // Answers that are fine for anyone (own data, or nothing about school A).
    const OK = new Set(['my_entitlements', 'my_account', 'my_institutions', 'my_ai_usage', 'my_notification_channels', 'my_achievements', 'my_timetable_context',
      'my_redemptions', 'my_editable_students', 'list_friends', 'guardian_children', 'my_conversations', 'friends_leaderboard', 'is_platform_admin',
      'is_staff_role', 'plans_public', 'start_trial', 'event_applies', 'all_permissions', 'locked_permissions', 'default_role_permissions'])
    const before = await adminSql(`select (select count(*) from public.audit_log where institution_id = '${instA}')::int audit,
                                          (select count(*) from public.classes where institution_id = '${instA}')::int classes,
                                          (select count(*) from public.class_enrollments where institution_id = '${instA}')::int enrol,
                                          (select count(*) from public.attendance_records where institution_id = '${instA}')::int att,
                                          (select count(*) from public.academic_years where institution_id = '${instA}')::int years`)
    const leaks = []
    let called = 0
    for (const f of fns) {
      if (OK.has(f.name) || ['delete_account', 'delete_account_confirmed', 'send_test_notification', 'change_username'].includes(f.name)) continue
      const args = {}
      f.types.forEach((t, i) => { if (f.args[i]) args[f.args[i]] = value(f.args[i], t) })
      for (const [who, c] of [['other school', principalB.c], ['personal', stranger.c]]) {
        const { data, error } = await c.rpc(f.name, args)
        called++
        const empty = data === null || data === false || data === 0 || (Array.isArray(data) && data.length === 0) ||
          (typeof data === 'object' && data && Object.keys(data).length === 0)
        // An import preview may answer, but only with refusals.
        const onlyRefusals = Array.isArray(data) && data.every((r) => r && r.status === 'error')
        if (!error && !empty && !onlyRefusals) leaks.push(`${f.name} (${who}): ${JSON.stringify(data).slice(0, 70)}`)
      }
    }
    const after = await adminSql(`select (select count(*) from public.audit_log where institution_id = '${instA}')::int audit,
                                         (select count(*) from public.classes where institution_id = '${instA}')::int classes,
                                         (select count(*) from public.class_enrollments where institution_id = '${instA}')::int enrol,
                                         (select count(*) from public.attendance_records where institution_id = '${instA}')::int att,
                                         (select count(*) from public.academic_years where institution_id = '${instA}')::int years`)
    console.log(`    (${fns.length} functions, ${called} calls)`)
    assert.deepEqual(after, before, 'school A unchanged')
    assert.deepEqual(leaks, [], leaks.join(' || '))
  })

  await test('cross-institution: the institution functions refuse other schools', async () => {
    const inv = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `evil@${W.DOM_A}`, role: 'student', display_name: 'Evil' }, principalB.c)
    assert.equal(inv.status, 400)
    const bulk = await fn('institution-invite', { action: 'bulk_import', institution_id: instA, role: 'student', rows: [{ email: `evil2@${W.DOM_A}`, name: 'Evil' }] }, principalB.c)
    assert.equal(bulk.body.results[0].status, 'error')
    const url = await fn('homework', { action: 'url', file_id: up.body.file_id ?? ZERO }, principalB.c)
    assert.notEqual(url.status, 200)
  })

  await test('role self-escalation is impossible', async () => {
    const attempts = [
      ['student promotes own membership', s1.c.from('institution_memberships').update({ role: 'principal' }).eq('id', s1.membership).select('id')],
      ['student un-suspends / edits own status', s1.c.from('institution_memberships').update({ status: 'active', display_name: 'Boss' }).eq('id', s1.membership).select('id')],
      ['class teacher grants own role manage_staff', classT.c.from('institution_role_permissions').upsert({ institution_id: instA, role: 'class_teacher', permission: 'manage_staff', allowed: true }).select('role')],
      ['class teacher grants own role import_export', classT.c.from('institution_role_permissions').upsert({ institution_id: instA, role: 'class_teacher', permission: 'import_export', allowed: true }).select('role')],
      ['coordinator widens own scope', coord.c.from('coordinator_scopes').insert({ institution_id: instA, coordinator_id: coord.membership, grade: '*' }).select('id')],
      ['subject teacher makes self class teacher', subjT.c.from('classes').update({ class_teacher_id: subjT.membership }).eq('id', class10a).select('id')],
      ['student becomes platform owner', s1.c.from('platform_admins').insert({ user_id: s1.id, note: 'me' }).select('user_id')],
      ['personal account turns institutional', stranger.c.from('profiles').update({ account_type: 'institutional' }).eq('id', stranger.id).select('id')],
      ['principal edits allowlist of another school', principalB.c.from('institution_email_allowlist').insert({ institution_id: instA, kind: 'domain', value: 'evil.org' }).select('id')],
      ['head of B joins A by membership insert', principalB.c.from('institution_memberships').insert({ institution_id: instA, user_id: principalB.id, role: 'principal', display_name: 'x' }).select('id')],
    ]
    const ok = []
    for (const [name, q] of attempts) {
      const { data, error } = await q
      if (!error && data?.length) ok.push(name)
    }
    assert.deepEqual(ok, [])
    const inviteHead = await fn('institution-invite', { action: 'invite', institution_id: instA, email: `newhead@${W.DOM_A}`, role: 'principal', display_name: 'x' }, principal.c)
    assert.equal(inviteHead.status, 400, 'only the platform owner invites heads')
    assert.ok((await s1.c.rpc('platform_create_institution', { p_name: 'Mine', p_kind: 'school', p_timezone: 'UTC' })).error)
    const [m] = await adminSql(`select role from public.institution_memberships where id = '${s1.membership}'`)
    assert.equal(m.role, 'student')
  })

  await test('entitlements can’t be forged from the browser', async () => {
    const c = stranger.c
    const attempts = [
      ['insert subscription', c.from('subscriptions').insert({ user_id: stranger.id, provider: 'manual', plan: 'pro', status: 'active' }).select('id')],
      ['edit plan prices/features', c.from('plans').update({ features: ['csv_export'] }).eq('id', 'free').select('id')],
      ['create licence code', c.from('license_codes').insert({ kind: 'gift', plan: 'pro', code_hash: 'a'.repeat(64), last4: 'AAAA' }).select('id')],
      ['record a redemption', c.from('code_redemptions').insert({ code_id: ZERO, user_id: stranger.id }).select('id')],
      ['raise AI quota', c.from('ai_plan_quotas').update({ max_requests: null }).eq('plan_key', 'free').select('feature')],
      ['erase AI usage', c.from('ai_usage').delete().eq('user_id', stranger.id).select('id')],
      ['write a development score', c.from('development_scores').insert({ institution_id: instA, student_id: s1.membership, period_from: '2026-01-01', period_to: '2026-01-02', score: 10, insufficient: false, components: {}, weights: {} }).select('id')],
      ['activate institution licence on B for A', principalB.c.from('institution_licenses').insert({ institution_id: instA, plan: 'pro' }).select('id')],
    ]
    const ok = []
    for (const [name, q] of attempts) {
      const { data, error } = await q
      if (!error && data?.length) ok.push(name)
    }
    assert.deepEqual(ok, [])
    const theme = await c.from('profiles').update({ accent_theme: 'ocean' }).eq('id', stranger.id).select('id')
    assert.match(theme.error?.message ?? '', /PRO_REQUIRED/)
    const ent = await one(c.rpc('my_entitlements'))
    assert.equal(ent.plan, 'free')
    for (const name of ['platform_generate_codes', 'platform_grant_plan', 'platform_update_plan', 'platform_set_ai_quota', 'ai_begin', 'claim_code', 'generate_license_codes']) {
      assert.ok((await c.rpc(name, {})).error, `${name} must refuse`)
    }
  })

  await test('storage: homework files only through short-lived links for allowed people', async () => {
    const [{ storage_path: path }] = await adminSql(`select storage_path from public.submission_files where institution_id = '${instA}' limit 1`)
    for (const c of [s1.c, s2.c, principalB.c, stranger.c, client()]) {
      assert.ok((await c.storage.from('homework').download(path)).error, 'no direct download, not even the owner')
      assert.ok(!(await c.storage.from('homework').list(instA)).data?.length)
      assert.ok((await c.storage.from('homework').upload(`${instA}/evil.pdf`, pdf(), { contentType: 'application/pdf' })).error)
      assert.ok(!(await c.storage.listBuckets()).data?.some((b) => b.public))
    }
    const fileId = (await adminSql(`select id from public.submission_files where storage_path = '${path}'`))[0].id
    assert.equal((await fn('homework', { action: 'url', file_id: fileId }, s2.c)).status, 404)
    const own = await fn('homework', { action: 'url', file_id: fileId }, s1.c)
    assert.equal(own.status, 200)
    assert.match(own.body.url, /token=/)
    assert.equal((await fn('homework', { action: 'url', file_id: fileId })).status, 401)
  })

  await test('database-wide: RLS on every table, definer functions pinned, server-only functions not callable', async () => {
    const noRls = await adminSql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`)
    assert.deepEqual(noRls, [])
    const unpinned = await adminSql(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.prosecdef
                                        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%')`)
    assert.deepEqual(unpinned, [])
    const serverOnly = ['ai_begin', 'ai_finish', 'compute_development', 'import_person', 'record_import', 'delivery_claim', 'delivery_result',
      'push_subscription_result', 'tt_apply_ops', 'student_timetable_owner', 'create_invitation', 'claim_code', 'notify', 'has_feature',
      'plan_of', 'delivery_email', 'development_weekly_job', 'homework_retention_candidates', 'send_reminders', 'send_license_reminders']
    const callable = await adminSql(`select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.proname = any (array['${serverOnly.join("','")}'])
                                        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`)
    assert.deepEqual(callable, [])
    const anon = await adminSql(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`)
    assert.deepEqual(anon.map((x) => x.proname), ['confirm_recovery_email'], 'only the signed-out email confirmation')
  })

  void owner
} finally {
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
