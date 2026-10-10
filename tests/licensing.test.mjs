// Phase 4 tests: entitlements, gift codes, individual licence codes, institution
// licences, friend limits, platform-owner controls. Runs against the real project.
//   node --env-file=.env tests/licensing.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, client, fn, individual, one, PASS, passedCount, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
const NOTE = `test ${suffix}`
console.log('Licensing tests')

const W = await buildSchool(suffix)
const { owner, instA, instB, principal, principalB, coord, s1, classT } = W

/** Generates codes as the platform owner and returns the plaintext list. */
async function codes(opts) {
  const rows = await one(owner.c.rpc('platform_generate_codes', { p_note: NOTE, ...opts }))
  return rows.map((r) => r.code)
}
const ent = async (c) => one(c.rpc('my_entitlements'))
const friendErr = (e) => /PLAN_LIMIT:friends/.test(e?.message ?? '')

try {
  const alice = await individual(`alice_${suffix}`)
  const bob = await individual(`bob_${suffix}`)
  const carol = await individual(`carol_${suffix}`)
  const dave = await individual(`dave_${suffix}`)
  const erin = await individual(`erin_${suffix}`)

  await test('nobody but the platform owner can generate, list or revoke codes', async () => {
    for (const c of [alice.c, principal.c, s1.c]) {
      const { error } = await c.rpc('platform_generate_codes', { p_kind: 'gift', p_plan: 'pro', p_count: 1, p_duration_days: 30 })
      assert.ok(error, 'generate refused')
      assert.ok((await c.rpc('platform_codes')).error, 'list refused')
      assert.ok((await c.rpc('platform_licenses')).error)
      assert.ok((await c.rpc('platform_grant_plan', { p_username: `alice_${suffix}`, p_plan: 'pro', p_days: 30, p_note: 'self' })).error)
      assert.ok((await c.rpc('platform_update_plan', { p_plan: 'free', p_limits: { friends: 99 }, p_features: ['csv_export'] })).error)
    }
    const { error: anon } = await client().rpc('redeem_code', { p_code: 'HFG-AAAA-AAAA-AAAA-AAAA' })
    assert.ok(anon)
  })

  await test('users can’t write subscriptions, codes, licences or redemptions directly', async () => {
    const tries = [
      alice.c.from('subscriptions').insert({ user_id: alice.id, provider: 'gift', plan: 'pro', status: 'active' }),
      alice.c.from('license_codes').insert({ kind: 'gift', code_hash: 'a'.repeat(64), code_hint: 'AAAA', plan: 'pro', duration_days: 30 }),
      principal.c.from('institution_licenses').insert({ institution_id: instA, plan: 'pro', starts_at: new Date().toISOString(), expires_at: '2099-01-01' }),
      alice.c.from('code_redemptions').insert({ code_id: '00000000-0000-0000-0000-000000000000', user_id: alice.id }),
      alice.c.from('plans').update({ limits: { friends: null } }).eq('id', 'free'),
    ]
    for (const t of tries) {
      const { error, data } = await t.select()
      assert.ok(error || (data ?? []).length === 0, 'write refused')
    }
    for (const t of ['license_codes', 'institution_licenses', 'code_redemptions']) {
      const { data, error } = await alice.c.from(t).select('id')
      assert.ok(error || data.length === 0, `${t} not readable`)
    }
    assert.equal((await ent(alice.c)).plan, 'free')
  })

  await test('codes are random, shown once and stored only as hashes', async () => {
    const list = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 20, p_duration_days: 30 })
    assert.equal(new Set(list).size, 20)
    for (const c of list) assert.match(c, /^HFG-[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/)
    const stored = await adminSql(`select code_hash, code_hint from public.license_codes where note = '${NOTE}'`)
    const dump = JSON.stringify(stored)
    for (const c of list) assert.ok(!dump.includes(c) && !dump.includes(c.replaceAll('-', '')), 'plaintext never stored')
    const listed = await one(owner.c.rpc('platform_codes', { p_kind: 'gift' }))
    assert.ok(listed.every((r) => !('code_hash' in r)))
  })

  await test('gift code grants Plus for its period; codes for the same plan stack', async () => {
    const [a, b] = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 2, p_duration_days: 30 })
    const res = await one(alice.c.rpc('redeem_code', { p_code: a.toLowerCase().replaceAll('-', ' ') }))
    assert.equal(res.plan, 'plus')
    assert.equal(res.redeemed.plan_name, 'Plus')
    assert.equal(res.limits.friends, 3)
    assert.ok(res.features.includes('ai_guided_timetable'))
    const first = new Date(res.expires_at)
    assert.ok(Math.abs(first - Date.now() - 30 * 864e5) < 120e3)
    const again = await one(alice.c.rpc('redeem_code', { p_code: b }))
    assert.ok(Math.abs(new Date(again.expires_at) - first - 30 * 864e5) < 120e3, 'second code starts when the first ends')
    const mine = await one(alice.c.rpc('my_redemptions'))
    assert.equal(mine.length, 2)
  })

  await test('bad, used, expired, revoked and wrong-kind codes are refused with clear messages', async () => {
    const msg = async (c, code) => (await c.rpc('redeem_code', { p_code: code })).error?.message ?? 'OK'
    assert.match(await msg(bob.c, 'HFG-2222-3333-4444-5555'), /isn’t valid/)
    const [single] = await codes({ p_kind: 'gift', p_plan: 'pro', p_count: 1, p_duration_days: 7 })
    await one(bob.c.rpc('redeem_code', { p_code: single }))
    assert.match(await msg(bob.c, single), /already been used/)
    const [multi] = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 1, p_duration_days: 7, p_max_redemptions: 5 })
    await one(carol.c.rpc('redeem_code', { p_code: multi }))
    assert.match(await msg(carol.c, multi), /already redeemed this code/)
    const [late] = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 1, p_duration_days: 7, p_redeem_by: new Date(Date.now() + 3600e3).toISOString() })
    await adminSql(`update public.license_codes set redeem_by = now() - interval '1 minute' where note = '${NOTE}' and redeem_by is not null`)
    assert.match(await msg(dave.c, late), /expired/)
    const [gone] = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 1, p_duration_days: 7 })
    const id = (await one(owner.c.rpc('platform_codes', { p_kind: 'gift' })))[0].id
    await one(owner.c.rpc('platform_revoke_code', { p_code: id, p_reason: 'leaked online' }))
    assert.match(await msg(dave.c, gone), /withdrawn/)
    const [key] = await codes({ p_kind: 'institution', p_plan: 'pro', p_count: 1, p_duration_days: 365, p_institution: instA })
    assert.match(await msg(dave.c, key), /institution licence key/)
    assert.equal((await ent(dave.c)).plan, 'free')
  })

  await test('simultaneous redemptions can’t exceed a code’s limit', async () => {
    const [code] = await codes({ p_kind: 'gift', p_plan: 'plus', p_count: 1, p_duration_days: 7, p_max_redemptions: 2 })
    const racers = await Promise.all([1, 2, 3, 4, 5].map((i) => individual(`race${i}_${suffix}`)))
    const results = await Promise.all(racers.map((r) => r.c.rpc('redeem_code', { p_code: code })))
    assert.equal(results.filter((r) => !r.error).length, 2)
    const [row] = await adminSql(`select redemption_count from public.license_codes where code_hash = public.code_hash('${code}')`)
    assert.equal(row.redemption_count, 2)
  })

  await test('revoking with “end access” removes the plan already granted', async () => {
    const [code] = await codes({ p_kind: 'individual', p_plan: 'pro', p_count: 1, p_duration_days: 365 })
    await one(erin.c.rpc('redeem_code', { p_code: code }))
    assert.equal((await ent(erin.c)).plan, 'pro')
    const id = (await one(owner.c.rpc('platform_codes', { p_kind: 'individual' })))[0].id
    const who = await one(owner.c.rpc('platform_code_redemptions', { p_code: id }))
    assert.equal(who[0].who, `erin_${suffix}`)
    await one(owner.c.rpc('platform_revoke_code', { p_code: id, p_reason: 'refunded', p_end_access: true }))
    assert.equal((await ent(erin.c)).plan, 'free')
  })

  await test('friend limits: Free 1, Plus 3, Pro unlimited; nobody loses friends on downgrade', async () => {
    const pals = await Promise.all([1, 2, 3, 4, 5].map((i) => individual(`pal${i}_${suffix}`)))
    const send = (c, i) => c.rpc('send_friend_request', { p_username: `pal${i}_${suffix}` })
    // dave is Free
    assert.ok(!(await send(dave.c, 1)).error)
    assert.ok(friendErr((await send(dave.c, 2)).error), 'free: second friend refused')
    // carol is Plus (multi-use gift above)
    for (const i of [1, 2, 3]) assert.ok(!(await send(carol.c, i)).error, `plus friend ${i}`)
    assert.ok(friendErr((await send(carol.c, 4)).error), 'plus: fourth refused')
    // bob is Pro
    for (const i of [1, 2, 3, 4, 5]) assert.ok(!(await send(bob.c, i)).error, `pro friend ${i}`)
    // bob's Pro ends: his 5 requests stay, he just can't add more
    await adminSql(`update public.subscriptions set expires_at = now() - interval '1 second' where user_id = '${bob.id}'`)
    assert.equal((await ent(bob.c)).plan, 'free')
    assert.equal((await one(bob.c.rpc('list_friends'))).length, 5)
    const extra = await individual(`pal6_${suffix}`)
    assert.ok(friendErr((await bob.c.rpc('send_friend_request', { p_username: `pal6_${suffix}` })).error))
    void extra
  })

  let keyA
  await test('only a head of the right institution can activate its licence key', async () => {
    ;[keyA] = await codes({ p_kind: 'institution', p_plan: 'pro', p_count: 1, p_duration_days: 365, p_institution: instA, p_grace_days: 7 })
    const try_ = async (c, inst) => (await c.rpc('activate_institution_license', { p_inst: inst, p_code: keyA })).error?.message ?? 'OK'
    assert.match(await try_(coord.c, instA), /principal or director/)
    assert.match(await try_(s1.c, instA), /principal or director/)
    assert.match(await try_(principalB.c, instB), /different institution/)
    assert.match(await try_(principalB.c, instA), /principal or director/)
    const [gift] = await codes({ p_kind: 'gift', p_plan: 'pro', p_count: 1, p_duration_days: 7 })
    assert.match((await principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: gift })).error.message, /personal code/)
    const lic = await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: keyA }))
    assert.equal(lic.plan, 'pro')
    assert.match(await try_(principal.c, instA), /already been used/)
    const status = await one(principal.c.rpc('institution_license_status', { p_inst: instA }))
    assert.equal(status.state, 'active')
    assert.equal(status.history.length, 1)
    assert.ok((await coord.c.rpc('institution_license_status', { p_inst: instA })).error, 'coordinator can’t view licence')
  })

  await test('licensed institution: staff and students get the plan (unlimited friends); other schools don’t', async () => {
    for (const m of [s1, classT, principal]) {
      const e = await ent(m.c)
      assert.equal(e.plan, 'pro')
      assert.equal(e.source, 'institution')
      assert.equal(e.institution_name, `Test School A ${suffix}`)
      assert.equal(e.limits.friends, null)
      assert.equal(e.limits.trackers, null)
    }
    assert.equal((await ent(principalB.c)).plan, 'free')
    // institution access never adds permissions
    assert.ok((await s1.c.rpc('platform_codes')).error)
    const { data: perms } = await s1.c.rpc('my_permissions', { p_inst: instA })
    assert.ok(!(perms ?? []).includes('manage_students'))
  })

  await test('suspended members lose institutional entitlements', async () => {
    await one(principal.c.rpc('set_member_status', { p_membership: W.s2.membership, p_status: 'suspended', p_reason: 'test' }))
    const [row] = await adminSql(`select public.plan_of('${W.s2.id}') p`)
    assert.equal(row.p, 'free')
  })

  await test('expiry: features continue through the grace period, then stop; records stay', async () => {
    await adminSql(`update public.institution_licenses set starts_at = now() - interval '370 days', expires_at = now() - interval '2 days'
                    where institution_id = '${instA}'`)
    assert.equal((await ent(s1.c)).plan, 'pro')
    assert.equal((await ent(s1.c)).grace, true)
    assert.equal((await one(principal.c.rpc('institution_license_status', { p_inst: instA }))).state, 'grace')
    await adminSql(`update public.institution_licenses set expires_at = now() - interval '8 days' where institution_id = '${instA}'`)
    assert.equal((await ent(s1.c)).plan, 'free')
    assert.equal((await one(principal.c.rpc('institution_license_status', { p_inst: instA }))).state, 'expired')
    const classes = await one(principal.c.from('classes').select('id'))
    assert.ok(classes.length >= 2, 'academic records untouched')
  })

  await test('renewal and revocation: a new key restores access; revoking cuts it at once', async () => {
    const [key2] = await codes({ p_kind: 'institution', p_plan: 'plus', p_count: 1, p_duration_days: 30, p_institution: instA })
    await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: key2 }))
    assert.equal((await ent(s1.c)).plan, 'plus')
    const lic = (await one(owner.c.rpc('platform_licenses'))).find((l) => l.institution_id === instA && l.state === 'active')
    await one(owner.c.rpc('platform_revoke_license', { p_license: lic.id, p_reason: 'contract ended' }))
    assert.equal((await ent(s1.c)).plan, 'free')
    const audit = await one(owner.c.rpc('platform_license_audit'))
    assert.ok(audit.some((a) => a.action === 'revoke' && a.record_type === 'institution_license'))
    const instAudit = await one(principal.c.from('audit_log').select('action, record_type').eq('record_type', 'institution_license'))
    assert.ok(instAudit.some((a) => a.action === 'activate'))
  })

  await test('personal plan and school licence combine: the best of both applies', async () => {
    const [key3] = await codes({ p_kind: 'institution', p_plan: 'plus', p_count: 1, p_duration_days: 30, p_institution: instA })
    await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: key3 }))
    const [pro] = await codes({ p_kind: 'gift', p_plan: 'pro', p_count: 1, p_duration_days: 7 })
    await one(s1.c.rpc('redeem_code', { p_code: pro }))
    const e = await ent(s1.c)
    assert.equal(e.plan, 'pro')
    assert.equal(e.source, 'subscription')
    assert.ok(e.features.includes('csv_export') && e.features.includes('ai_guided_timetable'))
  })

  await test('institution licences last one year; heads and the owner are reminded 30 and 7 days before; renewal stops reminders', async () => {
    const st = await one(principal.c.rpc('institution_license_status', { p_inst: instA }))
    const days = (new Date(st.expires_at) - Date.now()) / 864e5
    assert.ok(days > 364 && days < 367, `one year, got ${days}`)
    const listed = (await one(owner.c.rpc('platform_codes', { p_kind: 'institution' })))[0]
    assert.equal(listed.duration_days, 365, 'length passed in is ignored for institutions')

    const reminders = async (c) => (await one(c.from('notifications').select('title, link').eq('kind', 'license_expiring')))
    const run = () => adminSql('select public.send_license_reminders()')
    await adminSql(`update public.institution_licenses set starts_at = now() - interval '345 days', expires_at = now() + interval '20 days'
                    where institution_id = '${instA}' and status = 'active'`)
    const soon = await one(principal.c.rpc('institution_license_status', { p_inst: instA }))
    assert.equal(soon.state, 'expiring')
    assert.equal(soon.days_left, 20)
    await run()
    await run()
    const head = await reminders(principal.c)
    assert.equal(head.length, 1, 'once, not twice')
    assert.match(head[0].title, /ends in a month/)
    assert.equal(head[0].link, '/school/settings')
    assert.equal((await reminders(owner.c)).filter((n) => n.title.includes(`Test School A ${suffix}`)).length, 1, 'owner reminded')
    assert.equal((await reminders(coord.c)).length, 0, 'coordinator not reminded')
    assert.equal((await reminders(s1.c)).length, 0, 'students not reminded')
    assert.equal((await reminders(principalB.c)).length, 0, 'other schools not reminded')

    await adminSql(`update public.institution_licenses set expires_at = now() + interval '5 days' where institution_id = '${instA}' and status = 'active'`)
    await run()
    assert.equal((await reminders(principal.c)).length, 2)
    assert.ok((await reminders(principal.c)).some((n) => /under a week/.test(n.title)))

    const [renewal] = await codes({ p_kind: 'institution', p_plan: 'plus', p_count: 1, p_duration_days: 365, p_institution: instA })
    await one(principal.c.rpc('activate_institution_license', { p_inst: instA, p_code: renewal }))
    const renewed = await one(principal.c.rpc('institution_license_status', { p_inst: instA }))
    assert.equal(renewed.state, 'active')
    assert.equal(renewed.renewal_scheduled, true)
    const total = (new Date(renewed.expires_at) - Date.now()) / 864e5
    assert.ok(total > 369 && total < 372, `renewal starts when the current licence ends, got ${total}`)
    await adminSql(`update public.institution_licenses set expires_at = now() + interval '1 day'
                    where institution_id = '${instA}' and status = 'active' and starts_at <= now()`)
    await run()
    assert.equal((await reminders(principal.c)).length, 2, 'no reminders once renewed')
    assert.equal((await ent(s1.c)).limits.friends, null, 'still covered')
  })

  await test('platform owner: manual grants, account lookup and plan limits (audited)', async () => {
    const sid = await one(owner.c.rpc('platform_grant_plan', { p_username: `dave_${suffix}`, p_plan: 'plus', p_days: 14, p_note: 'support goodwill' }))
    assert.equal((await ent(dave.c)).plan, 'plus')
    const look = await one(owner.c.rpc('platform_user_plan', { p_username: `dave_${suffix}` }))
    assert.equal(look.plan, 'plus')
    await one(owner.c.rpc('platform_end_subscription', { p_subscription: sid, p_reason: 'test over' }))
    assert.equal((await ent(dave.c)).plan, 'free')
    const { error } = await owner.c.rpc('platform_update_plan', { p_plan: 'free', p_limits: { friends: null, trackers: 2, history_days: 30 }, p_features: ['basic_statistics'] })
    assert.match(error?.message ?? '', /needs a number/)
    const { error: bad } = await owner.c.rpc('platform_update_plan', { p_plan: 'free', p_limits: { friends: -1 }, p_features: [] })
    assert.ok(bad)
  })
} finally {
  await adminSql(`delete from public.license_codes where note = '${NOTE}'`).catch(() => {})
  await adminSql(`delete from public.audit_log where record_type in ('license_code', 'subscription') and (reason = '${NOTE}' or reason in ('support goodwill', 'test over', 'leaked online', 'refunded'))`).catch(() => {})
  await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
void PASS
void fn
