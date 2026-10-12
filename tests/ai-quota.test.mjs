// Phase 5 tests: per-student AI quotas, counting rules, institutions, pools,
// cost controls and bypass attempts. Runs against the real project.
//   node --env-file=.env tests/ai-quota.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, fn, individual, one, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
const NOTE = `ai test ${suffix}`
console.log('AI quota tests')

const W = await buildSchool(suffix)
const { owner, instA, principal, coord, s1, s2 } = W

const begin = async (id, feature = 'chat', rid = null, chars = 10) =>
  (await adminSql(`select public.ai_begin('${id}', '${feature}', ${rid ? `'${rid}'` : 'null'}, ${chars}) r`))[0].r
const finish = (usage, ok = true) => adminSql(`select public.ai_finish('${usage}', ${ok}, 120, 80, null, 'test-model', null)`)
/** n successful requests in one statement */
const consume = (id, feature, n) =>
  adminSql(`select public.ai_finish((public.ai_begin('${id}', '${feature}', null, 10) ->> 'usage_id')::uuid, true, 100, 50, null, 'test', null)
            from generate_series(1, ${n})`)
const usage = async (c, feature) => (await one(c.rpc('my_ai_usage'))).find((u) => u.feature === feature)
const gift = async (plan, days = 30) =>
  (await one(owner.c.rpc('platform_generate_codes', { p_kind: 'gift', p_plan: plan, p_count: 1, p_duration_days: days, p_note: NOTE })))[0].code

try {
  const u1 = await individual(`aiu1_${suffix}`)
  const u2 = await individual(`aiu2_${suffix}`)
  const u3 = await individual(`aiu3_${suffix}`)
  const u4 = await individual(`aiu4_${suffix}`)

  await test('quotas can’t be bypassed or edited from the browser', async () => {
    for (const c of [u1.c, s1.c, principal.c]) {
      assert.ok((await c.rpc('ai_begin', { p_user: u1.id, p_feature: 'chat' })).error, 'ai_begin is server-only')
      assert.ok((await c.rpc('ai_finish', { p_usage: '00000000-0000-0000-0000-000000000000', p_ok: false })).error)
      assert.ok((await c.rpc('platform_set_ai_quota', { p_plan_key: 'free', p_feature: 'chat', p_enabled: true, p_max_requests: null })).error)
      assert.ok((await c.rpc('platform_update_ai_settings', { p: { hourly_burst: 1000 } })).error)
    }
    const ins = await u1.c.from('ai_usage').insert({ user_id: u1.id, feature: 'chat', plan_key: 'pro', period_start: new Date().toISOString(), status: 'refunded' }).select('id')
    assert.ok(ins.error)
    const upd = await u1.c.from('ai_plan_quotas').update({ max_requests: null }).eq('plan_key', 'free').select('feature')
    assert.ok(upd.error || upd.data.length === 0)
    assert.ok((await s1.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'chat', p_enabled: true, p_max_requests: 50 })).error)
    assert.ok((await coord.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'chat', p_enabled: true, p_max_requests: 50 })).error)
  })

  await test('each plan gets its own limits; disabled features are refused', async () => {
    const free = await usage(u1.c, 'chat')
    assert.equal(free.limit, 5)
    assert.equal(free.used, 0)
    assert.equal(free.period, 'month')
    const gen = await usage(u1.c, 'timetable_generate')
    assert.equal(gen.enabled, false)
    assert.equal(gen.upgrade_available, true)
    const r = await begin(u1.id, 'timetable_generate')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'feature_disabled')
    await one(u2.c.rpc('redeem_code', { p_code: await gift('plus') }))
    assert.equal((await usage(u2.c, 'chat')).limit, 60)
    assert.equal((await usage(u2.c, 'timetable_generate')).limit, 3)
    await one(u3.c.rpc('redeem_code', { p_code: await gift('pro') }))
    assert.equal((await usage(u3.c, 'chat')).limit, 150)
  })

  await test('usage is per student: one student’s use never touches another’s', async () => {
    await consume(u1.id, 'chat', 5)
    const r = await begin(u1.id)
    assert.equal(r.code, 'quota_exceeded')
    assert.equal(r.limit, 5)
    assert.ok(new Date(r.resets_at) > new Date())
    assert.equal((await usage(u1.c, 'chat')).remaining, 0)
    assert.equal((await usage(u4.c, 'chat')).used, 0)
    const ok = await begin(u4.id)
    assert.equal(ok.ok, true)
    await finish(ok.usage_id)
  })

  await test('failures are refunded, refusals don’t count, retries aren’t charged twice', async () => {
    const before = (await usage(u4.c, 'chat')).used
    const rid = `retry-${suffix}`
    const a = await begin(u4.id, 'chat', rid)
    await finish(a.usage_id, false)
    assert.equal((await usage(u4.c, 'chat')).used, before, 'refunded')
    const b = await begin(u4.id, 'chat', rid)
    assert.equal(b.ok, true, 'retry after a failure is allowed')
    await finish(b.usage_id, true)
    const c = await begin(u4.id, 'chat', rid)
    assert.equal(c.code, 'duplicate')
    assert.equal((await usage(u4.c, 'chat')).used, before + 1)
    const big = await begin(u4.id, 'chat', null, 999999)
    assert.equal(big.code, 'too_large')
    assert.equal((await usage(u4.c, 'chat')).used, before + 1, 'refusal not counted')
  })

  await test('quotas reset when the period ends', async () => {
    await adminSql(`update public.ai_usage set period_start = period_start - interval '1 month', created_at = created_at - interval '1 month'
                    where user_id = '${u1.id}' and feature = 'chat'`)
    assert.equal((await usage(u1.c, 'chat')).used, 0)
    const r = await begin(u1.id)
    assert.equal(r.ok, true)
    await finish(r.usage_id)
  })

  await test('simultaneous requests can’t exceed the limit', async () => {
    await consume(u4.id, 'chat', 5 - (await usage(u4.c, 'chat')).used - 3)
    assert.equal((await usage(u4.c, 'chat')).remaining, 3)
    const results = await Promise.all(Array.from({ length: 8 }, () => begin(u4.id)))
    assert.equal(results.filter((r) => r.ok).length, 3)
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'quota_exceeded'))
  })

  // Institution licence for school A
  const key = (await one(owner.c.rpc('platform_generate_codes', { p_kind: 'institution', p_plan: 'pro', p_count: 1, p_duration_days: 365, p_institution: instA, p_note: NOTE })))[0].code
  await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: key }))

  await test('licensed students get the institution’s allowance; personal first, then the school', async () => {
    const sp = await usage(s1.c, 'study_plan')
    assert.equal(sp.enabled, true, 'not on Free, but on the institution')
    assert.equal(sp.limit, 8)
    assert.equal(sp.institution_name, `Test School A ${suffix}`)
    const chat = await usage(s1.c, 'chat')
    assert.equal(chat.limit, 40, 'the more generous of Free (5) and institution (40)')
    const first = await begin(s1.id, 'chat')
    assert.equal(first.charged_to, 'personal')
    await finish(first.usage_id)
    const plan = await begin(s1.id, 'study_plan')
    assert.equal(plan.charged_to, 'institution')
    await finish(plan.usage_id)
  })

  await test('the school can lower or switch off features, never exceed the platform limit', async () => {
    const { error } = await principal.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'study_plan', p_enabled: true, p_max_requests: 9 })
    assert.match(error?.message ?? '', /0 to 8/)
    await one(principal.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'study_plan', p_enabled: true, p_max_requests: 1 }))
    assert.equal((await usage(s1.c, 'study_plan')).limit, 1)
    assert.equal((await begin(s1.id, 'study_plan')).code, 'quota_exceeded')
    await one(principal.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'study_plan', p_enabled: false, p_max_requests: null }))
    const off = await begin(s2.id, 'study_plan')
    assert.equal(off.code, 'feature_disabled')
    assert.match(off.error, /school/)
    await one(principal.c.rpc('institution_set_ai_quota', { p_inst: instA, p_feature: 'study_plan', p_enabled: true, p_max_requests: null }))
    const audit = await one(principal.c.from('audit_log').select('action').eq('record_type', 'ai_quota'))
    assert.equal(audit.length, 3)
  })

  await test('a shared institution pool is tracked alongside each student’s own limit', async () => {
    const used = (await one(principal.c.rpc('institution_ai_overview', { p_inst: instA }))).pool
    assert.equal(used, null, 'no pool until the platform owner enables one')
    await one(owner.c.rpc('platform_set_ai_pool', { p_inst: instA, p_enabled: true, p_monthly_requests: 2, p_monthly_token_cap: null }))
    const r = await begin(s2.id, 'study_plan')
    assert.equal(r.ok, true, 'one credit left (s1 used one)')
    await finish(r.usage_id)
    const no = await begin(s2.id, 'study_plan')
    assert.equal(no.code, 'pool_exhausted')
    const ov = await one(principal.c.rpc('institution_ai_overview', { p_inst: instA }))
    assert.equal(ov.pool.used_requests, 2)
    assert.equal(ov.pool.monthly_requests, 2)
    // personal allowance is unaffected by the pool
    assert.equal((await begin(s2.id, 'chat')).charged_to, 'personal')
  })

  await test('institution overview shows counts per student and feature to heads only', async () => {
    const ov = await one(principal.c.rpc('institution_ai_overview', { p_inst: instA }))
    const names = ov.students.map((s) => s.name)
    assert.ok(names.includes('Student One') && names.includes('Student Two'))
    assert.ok(ov.features.find((f) => f.feature === 'study_plan').used_this_period >= 2)
    assert.ok((await coord.c.rpc('institution_ai_overview', { p_inst: instA })).error)
    assert.ok((await s1.c.rpc('institution_ai_overview', { p_inst: instA })).error)
  })

  await test('expired or revoked licence: back to the personal plan', async () => {
    const lic = (await one(owner.c.rpc('platform_licenses'))).find((l) => l.institution_id === instA)
    await one(owner.c.rpc('platform_revoke_license', { p_license: lic.id, p_reason: 'ai test' }))
    assert.equal((await usage(s1.c, 'study_plan')).enabled, false)
    assert.equal((await usage(s1.c, 'chat')).limit, 5)
  })

  await test('upgrades and downgrades apply at once', async () => {
    await one(u1.c.rpc('redeem_code', { p_code: await gift('pro') }))
    assert.equal((await usage(u1.c, 'chat')).limit, 150)
    await adminSql(`update public.subscriptions set expires_at = now() - interval '1 second' where user_id = '${u1.id}'`)
    assert.equal((await usage(u1.c, 'chat')).limit, 5)
  })

  await test('usage history is the student’s own and read-only', async () => {
    const mine = await one(s1.c.from('ai_usage').select('feature, status, charged_to'))
    assert.ok(mine.length >= 2 && mine.every((r) => r.feature))
    const ids = (await adminSql(`select id from public.ai_usage where user_id = '${s2.id}' limit 1`))[0].id
    assert.equal((await one(s1.c.from('ai_usage').select('id').eq('id', ids))).length, 0, 'other students’ rows invisible')
    const upd = await s1.c.from('ai_usage').update({ status: 'refunded' }).eq('status', 'succeeded').select('id')
    assert.ok(upd.error || upd.data.length === 0)
    const del = await s1.c.from('ai_usage').delete().eq('status', 'succeeded').select('id')
    assert.ok(del.error || del.data.length === 0)
  })

  await test('platform switches: a feature turned off globally is refused for everyone', async () => {
    await one(owner.c.rpc('platform_set_ai_feature', { p_feature: 'reschedule', p_enabled: false, p_period: 'month' }))
    try {
      assert.equal((await begin(u3.id, 'reschedule')).code, 'feature_disabled')
    } finally {
      await one(owner.c.rpc('platform_set_ai_feature', { p_feature: 'reschedule', p_enabled: true, p_period: 'month' }))
    }
    assert.equal((await begin(u3.id, 'reschedule')).ok, true)
    const ov = await one(owner.c.rpc('platform_ai_overview'))
    assert.ok(ov.month.requests > 0)
    assert.ok(ov.quotas.length >= 24)
    assert.ok((await principal.c.rpc('platform_ai_overview')).error)
  })

  await test('the assistant endpoint enforces the quota and returns a structured refusal', async () => {
    const r = await fn('assistant', { question: 'How do I add a task?', page: '/dashboard' }, u4.c)
    assert.equal(r.status, 429)
    assert.equal(r.body.code, 'quota_exceeded')
    assert.ok(r.body.resets_at)
    assert.equal(r.body.limit, 5)
    const fresh = await individual(`aiu5_${suffix}`)
    const ok = await fn('assistant', { question: 'How do I add a task?', page: '/dashboard', request_id: `fresh-${suffix}` }, fresh.c)
    if (ok.status === 503) {
      assert.equal(ok.body.code, 'ai_not_configured')
      assert.equal((await usage(fresh.c, 'chat')).used, 0, 'not configured: refunded, not counted')
    } else {
      assert.equal(ok.status, 200)
      assert.equal(ok.body.quota.used, 1)
    }
    const anon = await fn('assistant', { question: 'hi', page: '/' })
    assert.equal(anon.status, 401)
  })
} finally {
  await adminSql(`delete from public.license_codes where note = '${NOTE}'`).catch(() => {})
  await adminSql(`delete from public.audit_log where record_type in ('ai_feature', 'license_code', 'institution_license', 'ai_pool') and created_at > now() - interval '1 hour'
                  and (reason = '${NOTE}' or reason = 'ai test' or record_id = 'reschedule')`).catch(() => {})
  await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
