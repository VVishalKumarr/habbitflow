// Security + behaviour tests for accounts, plans, payments, exports, friends
// and server functions, against the real Supabase project.
// Run: node --env-file=.env tests/launch-security.test.mjs
// Needs SUPABASE_ACCESS_TOKEN in .env (used only to simulate server-side
// actions such as a verified payment or a confirmation email being sent).
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const REF = new globalThis.URL(URL).hostname.split('.')[0]
const ADMIN_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const DOMAIN = 'habitflow.local'
const suffix = Date.now().toString(36)
const PASS = 'correct-horse-9'
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

/** Server-side SQL (stands in for payment webhooks / email sending). */
async function adminSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`admin sql ${r.status}: ${await r.text()}`)
  return r.json()
}

async function signUp(username) {
  const c = client()
  const { data, error } = await c.auth.signUp({ email: `${username}@${DOMAIN}`, password: PASS, options: { data: { username } } })
  if (error) throw error
  return { c, id: data.user.id, username, token: data.session.access_token }
}

async function fn(name, body, token) {
  const r = await fetch(`${URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const ent = async (u) => (await u.c.rpc('my_entitlements')).data

console.log('HabitFlow launch security tests')
const alice = await signUp(`la_${suffix}`)
const bob = await signUp(`lb_${suffix}`)
const carol = await signUp(`lc_${suffix}`)
const users = [alice, bob, carol]

// ---------------------------------------------------------------- plans
await test('plans are public, read-only', async () => {
  const { data } = await client().from('plans').select('id, prices, limits').order('rank')
  assert.deepEqual(data.map((p) => p.id), ['free', 'plus', 'pro'])
  assert.equal(data[1].prices.IN.currency, 'INR')
  assert.equal(data[1].prices.default.currency, 'USD')
  const r = await alice.c.from('plans').update({ price_monthly: 1 }).eq('id', 'pro').select()
  assert.ok(r.error || r.data.length === 0, 'users must not change prices')
})

await test('new account is FREE with server limits', async () => {
  const e = await ent(alice)
  assert.equal(e.state, 'FREE')
  assert.equal(e.plan, 'free')
  assert.equal(e.limits.trackers, 2)
  assert.ok(!e.features.includes('csv_export'))
})

let aTrackers = []
await test('free tracker limit enforced by the database', async () => {
  for (const name of ['One', 'Two']) {
    const r = await alice.c.from('trackers').insert({ name }).select().single()
    assert.ifError(r.error)
    aTrackers.push(r.data)
  }
  const r = await alice.c.from('trackers').insert({ name: 'Three' })
  assert.match(r.error?.message ?? '', /PLAN_LIMIT:trackers/)
  const { data } = await alice.c.from('trackers').select('id')
  assert.equal(data.length, 2, 'existing trackers untouched')
})

await test('cannot fake Pro: no writes to subscriptions', async () => {
  let r = await alice.c.from('subscriptions').insert({ user_id: alice.id, provider: 'manual', plan: 'pro', status: 'active' })
  assert.ok(r.error, 'insert must fail')
  r = await alice.c.from('subscriptions').update({ status: 'active' }).eq('user_id', alice.id).select()
  assert.ok(r.error || r.data.length === 0)
  r = await alice.c.rpc('plan_of', { p_user: alice.id })
  assert.ok(r.error, 'internal plan_of not callable')
  r = await alice.c.rpc('has_feature', { p_user: alice.id, p_feature: 'csv_export' })
  assert.ok(r.error, 'internal has_feature not callable')
  assert.equal((await ent(alice)).plan, 'free')
})

await test('free user cannot set a Pro theme, export, or view 90-day comparisons', async () => {
  let r = await alice.c.from('profiles').update({ accent_theme: 'ocean' }).eq('id', alice.id)
  assert.match(r.error?.message ?? '', /PRO_REQUIRED:custom_themes/)
  r = await alice.c.rpc('export_timetable', { p_from: '2026-09-01', p_to: '2026-09-30' })
  assert.match(r.error?.message ?? '', /PRO_REQUIRED/)
  r = await alice.c.rpc('compare_progress', { p_friend: alice.id, p_from: '2026-07-01', p_to: '2026-09-28' })
  assert.match(r.error?.message ?? '', /PRO_REQUIRED/)
  r = await alice.c.rpc('compare_progress', { p_friend: alice.id, p_from: '2026-09-01', p_to: '2026-09-28' })
  assert.ifError(r.error)
  r = await alice.c.rpc('friends_leaderboard', {})
  assert.match(r.error?.message ?? '', /PRO_REQUIRED/)
})

await test('profile can’t be pointed at another user or change protected columns', async () => {
  const r = await alice.c.from('profiles').update({ username: 'admin' }).eq('id', alice.id)
  assert.ok(r.error)
  const r2 = await alice.c.from('profiles').update({ share_progress: false }).eq('id', bob.id).select()
  assert.ok(r2.error || r2.data.length === 0, 'cannot edit another profile')
})

// ---------------------------------------------------------------- trial & pro
await test('trial: one per account, unlocks Pro, then limits lift', async () => {
  let r = await bob.c.rpc('start_trial')
  assert.ifError(r.error)
  assert.equal(r.data.state, 'TRIAL')
  assert.equal(r.data.plan, 'pro')
  assert.ok(r.data.features.includes('unlimited_trackers'))
  r = await bob.c.rpc('start_trial')
  assert.match(r.error?.message ?? '', /already been used/)
  for (const name of ['1', '2', '3']) assert.ifError((await bob.c.from('trackers').insert({ name })).error)
  r = await bob.c.from('profiles').update({ accent_theme: 'forest' }).eq('id', bob.id)
  assert.ifError(r.error)
})

await test('expired Pro keeps data but free limits return', async () => {
  await adminSql(`update public.subscriptions set expires_at = now() - interval '1 minute' where user_id = '${bob.id}'`)
  const e = await ent(bob)
  assert.equal(e.state, 'EXPIRED')
  const { data } = await bob.c.from('trackers').select('id')
  assert.equal(data.length, 3, 'nothing deleted')
  const r = await bob.c.from('trackers').insert({ name: '4' })
  assert.match(r.error?.message ?? '', /PLAN_LIMIT/)
})

await test('Plus plan: no ads and unlimited trackers, but no Pro-only exports', async () => {
  const dave = await signUp(`ld_${suffix}`)
  users.push(dave)
  await adminSql(`insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at) values ('${dave.id}', 'manual', 'plus', 'active', now(), now() + interval '30 days')`)
  const e = await ent(dave)
  assert.equal(e.plan, 'plus')
  assert.equal(e.state, 'ACTIVE')
  assert.ok(e.features.includes('no_ads') && e.features.includes('custom_themes'))
  for (const name of ['1', '2', '3']) assert.ifError((await dave.c.from('trackers').insert({ name })).error)
  assert.ifError((await dave.c.from('profiles').update({ accent_theme: 'sunset' }).eq('id', dave.id)).error)
  const r = await dave.c.rpc('export_timetable', { p_from: '2026-09-01', p_to: '2026-09-30' })
  assert.match(r.error?.message ?? '', /PRO_REQUIRED/)
  // Plus and Pro at the same time: the higher plan wins
  await adminSql(`insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at) values ('${dave.id}', 'manual', 'pro', 'active', now(), now() + interval '30 days')`)
  assert.equal((await ent(dave)).plan, 'pro')
})

let aTask
await test('Pro (server-granted) export returns only own rows', async () => {
  await adminSql(`insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at) values ('${alice.id}', 'manual', 'pro', 'active', now(), now() + interval '30 days')`)
  assert.equal((await ent(alice)).state, 'ACTIVE')
  assert.equal((await ent(alice)).plan, 'pro')
  const t = aTrackers[0]
  const slot = (await alice.c.from('time_slots').insert({ tracker_id: t.id, start_time: '08:00', end_time: '09:00' }).select().single()).data
  aTask = (await alice.c.from('tasks').insert({ tracker_id: t.id, time_slot_id: slot.id, day_of_week: 1, title: 'Secret plan', description: 'private note' }).select().single()).data
  await alice.c.from('task_completions').upsert({ task_id: aTask.id, tracker_id: t.id, completion_date: '2026-09-21', completed: true }, { onConflict: 'task_id,completion_date' })
  // Bob adds a task too; it must never appear in Alice's export
  const bt = (await bob.c.from('trackers').select('id').limit(1).single()).data
  const bs = (await bob.c.from('time_slots').insert({ tracker_id: bt.id, start_time: '08:00', end_time: '09:00' }).select().single()).data
  await bob.c.from('tasks').insert({ tracker_id: bt.id, time_slot_id: bs.id, day_of_week: 1, title: 'Bob task' })
  const r = await alice.c.rpc('export_timetable', { p_from: '2026-09-14', p_to: '2026-09-28', p_tz: 'UTC' })
  assert.ifError(r.error)
  assert.ok(r.data.length >= 1)
  assert.ok(r.data.every((x) => x.task !== 'Bob task'))
  assert.ok(r.data.some((x) => x.task === 'Secret plan' && x.completed))
  const big = await alice.c.rpc('export_timetable', { p_from: '2020-01-01', p_to: '2026-09-28' })
  assert.ok(big.error, 'range capped')
})

await test('users can read only their own subscription rows', async () => {
  const { data } = await bob.c.from('subscriptions').select('user_id')
  assert.ok(data.every((r) => r.user_id === bob.id))
  const { data: anon } = await client().from('subscriptions').select('*')
  assert.equal((anon ?? []).length, 0)
})

// ---------------------------------------------------------------- friends
await test('friend privacy: sharing off blocks comparison; leaderboard is opt-in only', async () => {
  let r = await alice.c.rpc('send_friend_request', { p_username: bob.username })
  assert.equal(r.data, 'sent')
  const { data: reqs } = await bob.c.rpc('list_friends')
  assert.ifError((await bob.c.rpc('respond_friend_request', { p_id: reqs[0].id, p_accept: true })).error)

  await bob.c.from('profiles').update({ share_progress: false }).eq('id', bob.id)
  r = await alice.c.rpc('compare_progress', { p_friend: bob.id, p_from: '2026-09-15', p_to: '2026-09-21' })
  assert.match(r.error?.message ?? '', /isn't sharing/)
  const { data: fl } = await alice.c.rpc('list_friends')
  assert.equal(fl[0].shares_progress, false)
  await bob.c.from('profiles').update({ share_progress: true }).eq('id', bob.id)

  r = await alice.c.rpc('friends_leaderboard', { p_tz: 'UTC' })
  assert.match(r.error?.message ?? '', /Turn on leaderboard/)
  await alice.c.from('profiles').update({ leaderboard_opt_in: true }).eq('id', alice.id)
  r = await alice.c.rpc('friends_leaderboard', { p_tz: 'UTC' })
  assert.ifError(r.error)
  assert.deepEqual(r.data.map((x) => x.username), [alice.username], 'Bob has not opted in')
  assert.ok(!JSON.stringify(r.data).includes('Secret plan'), 'no task names')
  await bob.c.from('profiles').update({ leaderboard_opt_in: true }).eq('id', bob.id)
  r = await alice.c.rpc('friends_leaderboard', { p_tz: 'UTC' })
  assert.equal(r.data.length, 2)
  r = await carol.c.rpc('compare_progress', { p_friend: alice.id, p_from: '2026-09-15', p_to: '2026-09-21' })
  assert.ok(r.error, 'non-friends cannot compare')
})

await test('free friend limit enforced (counting sent requests)', async () => {
  // Carol (free): up to the Free plan's limit (read from the server), then refused
  const max = (await carol.c.rpc('my_entitlements')).data.limits.friends
  assert.ok(Number.isInteger(max) && max >= 1)
  const extra = []
  for (let i = 0; i < max; i++) extra.push(await signUp(`lx${i}_${suffix}`))
  users.push(...extra)
  for (const u of extra) assert.equal((await carol.c.rpc('send_friend_request', { p_username: u.username })).data, 'sent')
  const r = await carol.c.rpc('send_friend_request', { p_username: alice.username })
  assert.match(r.error?.message ?? '', /PLAN_LIMIT:friends/)
})

// ---------------------------------------------------------------- account
await test('recovery email data is not readable directly; my_account works', async () => {
  const r = await alice.c.from('account_private').select('*')
  assert.ok(r.error || r.data.length === 0)
  const { data } = await alice.c.rpc('my_account')
  assert.equal(data.username, alice.username)
  assert.equal(data.recovery_email, null)
})

await test('recovery email confirmation token: invalid rejected, valid works once', async () => {
  let r = await client().rpc('confirm_recovery_email', { p_token: 'x'.repeat(40) })
  assert.ok(r.error)
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  await adminSql(
    `insert into public.account_private (user_id, pending_email, pending_token_hash, pending_expires_at) values ('${alice.id}', 'alice@example.com', '${hash}', now() + interval '1 day') on conflict (user_id) do update set pending_email = excluded.pending_email, pending_token_hash = excluded.pending_token_hash, pending_expires_at = excluded.pending_expires_at`,
  )
  r = await client().rpc('confirm_recovery_email', { p_token: token })
  assert.ifError(r.error)
  assert.equal(r.data, 'alice@example.com')
  r = await client().rpc('confirm_recovery_email', { p_token: token })
  assert.ok(r.error, 'single use')
  const { data } = await alice.c.rpc('my_account')
  assert.equal(data.recovery_email, 'alice@example.com')
  assert.equal(data.email_verified, true)
})

await test('expired confirmation token is rejected', async () => {
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  await adminSql(
    `update public.account_private set pending_email = 'new@example.com', pending_token_hash = '${hash}', pending_expires_at = now() - interval '1 minute' where user_id = '${alice.id}'`,
  )
  const r = await client().rpc('confirm_recovery_email', { p_token: token })
  assert.ok(r.error)
  const { data } = await alice.c.rpc('my_account')
  assert.equal(data.recovery_email, 'alice@example.com', 'verified email kept')
})

await test('remove recovery email requires the password', async () => {
  let r = await alice.c.rpc('remove_recovery_email', { p_password: 'wrong-pass-1' })
  assert.equal(r.data, false)
  r = await alice.c.rpc('remove_recovery_email', { p_password: PASS })
  assert.equal(r.data, true)
  assert.equal((await alice.c.rpc('my_account')).data.recovery_email, null)
})

await test('change username: validated, unique, needs password, keeps all data', async () => {
  let r = await alice.c.rpc('change_username', { p_new: 'bad name!', p_password: PASS })
  assert.ok(r.error)
  r = await alice.c.rpc('change_username', { p_new: bob.username, p_password: PASS })
  assert.match(r.error?.message ?? '', /taken/)
  r = await alice.c.rpc('change_username', { p_new: `la2_${suffix}`, p_password: 'wrong-pass-1' })
  assert.equal(r.data.ok, false)
  r = await alice.c.rpc('change_username', { p_new: `LA2_${suffix}`, p_password: PASS })
  assert.equal(r.data.ok, true)
  assert.equal(r.data.username, `la2_${suffix}`)
  // log in with the new name; the old one no longer works
  const fresh = client()
  const login = await fresh.auth.signInWithPassword({ email: `la2_${suffix}@${DOMAIN}`, password: PASS })
  assert.ifError(login.error)
  assert.equal(login.data.user.id, alice.id, 'same account')
  const old = await client().auth.signInWithPassword({ email: `${alice.username}@${DOMAIN}`, password: PASS })
  assert.ok(old.error)
  const { data: t } = await fresh.from('trackers').select('id')
  assert.equal(t.length, 2, 'trackers kept')
  const { data: f } = await fresh.rpc('list_friends')
  assert.ok(f.some((x) => x.username === bob.username), 'friendships kept')
  assert.equal((await fresh.rpc('my_entitlements')).data.plan, 'pro', 'plan kept')
  // friends see the new name
  const { data: bf } = await bob.c.rpc('list_friends')
  assert.ok(bf.some((x) => x.username === `la2_${suffix}`))
  alice.username = `la2_${suffix}`
})

await test('wrong-password attempts lock out after 5 tries', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await carol.c.rpc('check_password', { p_password: `nope-${i}-xxxx` })).data, false)
  const r = await carol.c.rpc('check_password', { p_password: PASS })
  assert.match(r.error?.message ?? '', /Too many attempts/)
  await adminSql(`delete from public.rate_events where key = '${carol.id}'`)
})

await test('anonymous users get nothing from private RPCs', async () => {
  for (const [name, args] of [
    ['my_entitlements', {}],
    ['my_account', {}],
    ['check_password', { p_password: 'x' }],
    ['export_timetable', { p_from: '2026-09-01', p_to: '2026-09-02' }],
    ['friends_leaderboard', {}],
    ['start_trial', {}],
  ]) {
    const r = await client().rpc(name, args)
    assert.ok(r.error || r.data == null, `${name} should fail for anon`)
  }
  const { data } = await client().from('trackers').select('*')
  assert.equal((data ?? []).length, 0)
})

// ---------------------------------------------------------------- server functions
await test('functions: not-configured features fail gracefully', async () => {
  let r = await fn('password-reset', { identifier: 'someone' })
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'email_not_configured')
  r = await fn('account-email', { email: 'a@example.com', password: PASS }, bob.token)
  assert.equal(r.status, 503)
  r = await fn('assistant', { question: 'How do I add a task?', page: '/dashboard' }, bob.token)
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'ai_not_configured')
  r = await fn('google-play-verify', { purchaseToken: 'x' }, bob.token)
  assert.equal(r.status, 503)
})

await test('functions: payment endpoints require login and valid signatures', async () => {
  let r = await fn('billing', { action: 'create', interval: 'monthly' })
  assert.equal(r.status, 401, 'no login')
  r = await fn('billing', { action: 'create', interval: 'monthly' }, 'not-a-real-token')
  assert.equal(r.status, 401)
  const res = await fetch(`${URL}/functions/v1/razorpay-webhook`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', 'x-razorpay-signature': 'forged' },
    body: JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_x', status: 'active', notes: { user_id: carol.id } } } } }),
  })
  assert.equal(res.status, 401, 'forged webhook rejected')
  assert.equal((await ent(carol)).plan, 'free', 'no Pro from a fake payment')
})

await test('functions: delete-account needs the right password, then removes everything', async () => {
  let r = await fn('delete-account', { password: 'wrong-pass-1' }, carol.token)
  assert.equal(r.status, 403)
  r = await fn('delete-account', { password: PASS }, carol.token)
  assert.equal(r.status, 200)
  const login = await client().auth.signInWithPassword({ email: `${carol.username}@${DOMAIN}`, password: PASS })
  assert.ok(login.error, 'account gone')
  const rows = await adminSql(`select (select count(*) from public.friendships where requester_id = '${carol.id}' or addressee_id = '${carol.id}') f, (select count(*) from public.profiles where id = '${carol.id}') p`)
  assert.equal(Number(rows[0].f) + Number(rows[0].p), 0, 'data cascaded')
})

// ---------------------------------------------------------------- cleanup
for (const u of users.filter((u) => u !== carol)) {
  const c = client()
  const email = u === alice ? `${alice.username}@${DOMAIN}` : `${u.username}@${DOMAIN}`
  await c.auth.signInWithPassword({ email, password: PASS })
  // Pro test users have a (manual) subscription; the confirmed RPC refuses only paid providers.
  const r = await c.rpc('delete_account_confirmed', { p_password: PASS })
  if (r.error || !r.data) console.error('cleanup failed for', u.username, r.error?.message)
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
