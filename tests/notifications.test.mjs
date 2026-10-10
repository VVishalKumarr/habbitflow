// Phase 8 tests: delivery queue, preferences, duplicate prevention, retries,
// device registration and the real notify-deliver function. Runs against the
// real project (the every-minute job is paused during the test).
//   node --env-file=.env tests/notifications.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, fn, individual, one, passedCount, test, URL as SB } from './helpers.mjs'

const suffix = Date.now().toString(36)
console.log('Notification delivery tests')

await adminSql(`select cron.alter_job(jobid, active := false) from cron.job where jobname = 'notify-deliver'`)
const W = await buildSchool(suffix)
const { s1, principal, instA } = W

const notify = (uid, kind, title = 'Hello', dedupe = null) =>
  adminSql(`select public.notify('${uid}', '${instA}', '${kind}', '${title}', 'Body text', '/school', ${dedupe ? `'${dedupe}'` : 'null'})`)
const deliveries = (uid) => adminSql(`select d.channel, d.status, d.reason, d.attempts, n.title from public.notification_deliveries d
                                       join public.notifications n on n.id = d.notification_id where d.user_id = '${uid}' order by n.created_at, d.channel`)
const claim = async () => (await adminSql(`select public.delivery_claim(100) r`))[0].r
const makeDue = (uid) => adminSql(`update public.notification_deliveries set next_attempt_at = now() - interval '1 second' where user_id = '${uid}' and status = 'pending'`)
const prefs = (c, kind, p) => one(c.from('notification_prefs').upsert({ user_id: c._uid, kind, in_app: true, email: !!p.email, push: !!p.push }).select('kind'))
const p256dh = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const auth = 'BTBZMqHH6r4Tts7J_aSIgg'

try {
  s1.c._uid = s1.id
  principal.c._uid = principal.id

  await test('nothing is queued unless the person turned that channel on for that kind', async () => {
    await notify(s1.id, 'announcement')
    assert.deepEqual(await deliveries(s1.id), [])
  })

  await test('turned on: one push now and one email 10 minutes later; duplicates never queue twice', async () => {
    await prefs(s1.c, 'marks_published', { email: true, push: true })
    await notify(s1.id, 'marks_published', 'Marks out', 'mk-1')
    await notify(s1.id, 'marks_published', 'Marks out', 'mk-1') // same dedupe key: ignored
    const d = await deliveries(s1.id)
    assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`), ['email:pending', 'push:pending'])
    const [{ gap }] = await adminSql(`select round(extract(epoch from (max(next_attempt_at) - min(next_attempt_at))) / 60) gap from public.notification_deliveries where user_id = '${s1.id}'`)
    assert.equal(Number(gap), 10)
  })

  await test('push with no devices is skipped; the email is then due and has an address', async () => {
    let c = await claim()
    assert.equal(c.length, 0, 'the email isn’t due yet')
    assert.deepEqual((await deliveries(s1.id)).find((x) => x.channel === 'push'), { channel: 'push', status: 'skipped', reason: 'no devices', attempts: 0, title: 'Marks out' })
    await makeDue(s1.id)
    c = await claim()
    assert.equal(c.length, 1)
    assert.equal(c[0].channel, 'email')
    assert.equal(c[0].email, `s1@${W.DOM_A}`, 'institutional login address')
    await adminSql(`select public.delivery_result('${c[0].id}', 'sent', null)`)
  })

  await test('email is skipped when already read in the app or delivered by push', async () => {
    await notify(s1.id, 'marks_published', 'Read already')
    await adminSql(`update public.notifications set read_at = now() where user_id = '${s1.id}' and title = 'Read already'`)
    await adminSql(`update public.notification_deliveries d set status = 'skipped' from public.notifications n where n.id = d.notification_id and n.title = 'Read already' and d.channel = 'push'`)
    await notify(s1.id, 'marks_published', 'Pushed already')
    await adminSql(`update public.notification_deliveries d set status = 'sent', sent_at = now() from public.notifications n where n.id = d.notification_id and n.title = 'Pushed already' and d.channel = 'push'`)
    await makeDue(s1.id)
    assert.equal((await claim()).length, 0)
    const d = await deliveries(s1.id)
    assert.equal(d.find((x) => x.title === 'Read already' && x.channel === 'email').reason, 'already read in the app')
    assert.equal(d.find((x) => x.title === 'Pushed already' && x.channel === 'email').reason, 'delivered by push')
  })

  await test('at most 6 emails an hour; the rest stay in the app', async () => {
    await adminSql(`insert into public.notification_deliveries (notification_id, user_id, channel, status, sent_at)
                    select n.id, n.user_id, 'push', 'sent', now() from public.notifications n where false`)
    for (let i = 0; i < 6; i++) await notify(s1.id, 'marks_published', `Burst ${i}`)
    await adminSql(`update public.notification_deliveries d set status = 'skipped' from public.notifications n where n.id = d.notification_id and n.title like 'Burst %' and d.channel = 'push'`)
    await makeDue(s1.id)
    const c = await claim()
    assert.equal(c.length, 6)
    for (const x of c.slice(0, 5)) await adminSql(`select public.delivery_result('${x.id}', 'sent', null)`)
    await adminSql(`select public.delivery_result('${c[5].id}', 'retry', 'test')`)
    await makeDue(s1.id)
    assert.equal((await claim()).length, 0, '1 earlier + 5 now = 6 sent this hour')
    assert.equal((await deliveries(s1.id)).find((x) => x.title === 'Burst 5' && x.channel === 'email').reason, 'email limit (6 per hour) — shown in the app')
  })

  await test('failures retry with backoff and fail after 3 attempts', async () => {
    const u = await individual(`ntf_${suffix}`)
    await adminSql(`insert into public.notifications (user_id, kind, title) values ('${u.id}', 'test', 'Retry me')`)
    await adminSql(`update public.notification_deliveries set status = 'skipped' where user_id = '${u.id}' and channel = 'email'`)
    await one(u.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: `https://push.example.invalid/${suffix}`, p_p256dh: p256dh, p_auth: auth, p_label: 'Test' }))
    for (let i = 1; i <= 3; i++) {
      await makeDue(u.id)
      const c = await claim()
      assert.equal(c.length, 1, `attempt ${i}`)
      assert.equal(c[0].attempt, i)
      await adminSql(`select public.delivery_result('${c[0].id}', 'retry', 'push service unavailable')`)
    }
    const d = (await deliveries(u.id)).find((x) => x.channel === 'push')
    assert.deepEqual([d.status, d.attempts], ['failed', 3])
    // personal account without a confirmed recovery email: no email address
    await adminSql(`insert into public.notifications (user_id, kind, title) values ('${u.id}', 'test', 'No address')`)
    await makeDue(u.id)
    await claim()
    assert.equal((await deliveries(u.id)).find((x) => x.title === 'No address' && x.channel === 'email').reason, 'no email address')
  })

  await test('devices: own rows only, validated, and a device moves to whoever registers it', async () => {
    const a = await individual(`ntfa_${suffix}`)
    const b = await individual(`ntfb_${suffix}`)
    const ep = `https://push.example.invalid/shared-${suffix}`
    await one(a.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: ep, p_p256dh: p256dh, p_auth: auth, p_label: 'Chrome' }))
    assert.equal((await one(b.c.from('push_subscriptions').select('id'))).length, 0)
    assert.equal((await one(a.c.from('push_subscriptions').select('device_label'))).length, 1)
    assert.ok((await a.c.from('push_subscriptions').select('endpoint')).error, 'endpoints are not readable by the app')
    await one(b.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: ep, p_p256dh: p256dh, p_auth: auth, p_label: 'Chrome' }))
    assert.equal((await one(a.c.from('push_subscriptions').select('id'))).length, 0, 'same browser, new account')
    assert.ok((await b.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: 'http://insecure.example', p_p256dh: p256dh, p_auth: auth, p_label: null })).error)
    assert.ok((await b.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: 'https://x.example/1', p_p256dh: 'short', p_auth: auth, p_label: null })).error)
    assert.ok((await b.c.from('notification_deliveries').insert({ notification_id: '00000000-0000-0000-0000-000000000000', user_id: b.id, channel: 'email' })).error)
    assert.ok((await b.c.rpc('delivery_claim', { p_limit: 1 })).error, 'server only')
    assert.ok((await b.c.rpc('delivery_result', { p_id: '00000000-0000-0000-0000-000000000000', p_status: 'sent' })).error)
  })

  await test('test notifications: every channel at once, 5 an hour', async () => {
    for (let i = 0; i < 5; i++) await one(principal.c.rpc('send_test_notification'))
    assert.match((await principal.c.rpc('send_test_notification')).error?.message ?? '', /5 test notifications/)
    const d = await deliveries(principal.id)
    assert.equal(d.filter((x) => x.channel === 'email').length, 5)
  })

  await test('the app learns which channels the server can use', async () => {
    const r = await fn('notifications', { action: 'config' }, s1.c)
    assert.equal(r.status, 200)
    assert.equal(r.body.web_push, true)
    assert.match(r.body.vapid_public_key, /^B[\w-]{86}$/)
    assert.equal(typeof r.body.email, 'boolean')
    assert.equal((await fn('notifications', { action: 'config' })).status, 401)
  })

  await test('the real sender: encrypted push to Google’s push service, dead device removed, email recorded honestly', async () => {
    const u = await individual(`ntfr_${suffix}`)
    // A well-formed subscription for a device that doesn't exist.
    await one(u.c.rpc('register_push_subscription', { p_kind: 'web', p_endpoint: `https://fcm.googleapis.com/fcm/send/fake${suffix}:APA91bH`, p_p256dh: p256dh, p_auth: auth, p_label: 'Ghost' }))
    await one(u.c.rpc('send_test_notification'))
    const [{ secret }] = await adminSql(`select decrypted_secret secret from vault.decrypted_secrets where name = 'notify_job_secret'`)
    assert.equal((await fetch(`${SB}/functions/v1/notify-deliver`, { method: 'POST', headers: { 'x-job-secret': 'wrong' } })).status, 403)
    const res = await fetch(`${SB}/functions/v1/notify-deliver`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': secret }, body: '{}' })
    assert.equal(res.status, 200, await res.text())
    const d = await deliveries(u.id)
    const push = d.find((x) => x.channel === 'push')
    const email = d.find((x) => x.channel === 'email')
    assert.equal(email.status, 'skipped')
    assert.match(email.reason, /no email address|isn’t set up/)
    assert.ok(['skipped', 'pending', 'failed'].includes(push.status), JSON.stringify(push))
    const subs = await adminSql(`select failures from public.push_subscriptions where user_id = '${u.id}'`)
    assert.ok(subs.length === 0 || subs[0].failures >= 1, 'the push service rejected the fake device')
    console.log(`    (push service answer → delivery ${push.status}: ${push.reason}; device ${subs.length ? 'kept, failures ' + subs[0].failures : 'removed'})`)
  })
} finally {
  await adminSql(`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'notify-deliver'`).catch(() => {})
  if (!process.env.KEEP) {
    await adminSql(`delete from auth.users where email like 'ntf%${suffix}%'`).catch(() => {})
    await cleanup(suffix)
  }
}
console.log(`\n${passedCount()} passed`)
