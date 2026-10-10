// End-to-end test for the Focus timer, Pomodoro progress and Friends pages.
// Run: node --env-file=.env tests/e2e-social.mjs   (BASE_URL defaults to http://localhost:5173; screenshots -> ./screenshots)
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)
const me = `pomo_${suffix}`
const buddy = `buddy_${suffix}`
const pass = 'e2e-password-1'

let passed = 0
const failures = []
async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`)
  }
}

// The friend is created through the API so the UI test only drives one account.
const api = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const { error: signUpError } = await api.auth.signUp({ email: `${buddy}@habitflow.local`, password: pass, options: { data: { username: buddy } } })
if (signUpError) throw signUpError

const browser = await chromium.launch()
const errors = []
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
page.on('response', (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.request().method()} ${r.url().split('?')[0]}`))
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 10000 })
async function noOverflow(label) {
  const { sw, iw, wide } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}`),
  }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw} (${wide.join(', ')})`)
}

console.log(`E2E (focus + friends) as ${me} on ${BASE}`)

await step('register', async () => {
  await page.goto(`${BASE}/register`)
  await page.getByLabel('Username').fill(me)
  await page.getByLabel('Password', { exact: true }).fill(pass)
  await page.getByLabel('Confirm password').fill(pass)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/dashboard/)
})

await step('focus page requires a task name before starting', async () => {
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Focus' }).click()
  await page.getByRole('heading', { name: 'Focus timer' }).waitFor()
  assert.equal(await page.getByRole('timer').textContent(), '25:00')
  await page.getByRole('button', { name: 'Start' }).click()
  await toast('Name the task you are focusing on first.')
})

await step('timer runs, pauses and shows in the header on other pages', async () => {
  await page.getByLabel('What are you working on?').fill('Physics homework')
  await page.getByRole('button', { name: 'Start' }).click()
  await page.waitForTimeout(2200)
  const t = await page.getByRole('timer').textContent()
  assert.ok(t < '25:00', `timer did not count down (${t})`)
  assert.equal(await page.getByRole('radio', { name: 'Short break' }).isDisabled(), true)
  await page.screenshot({ path: `${SHOTS}/focus-running-1440.png` })
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Dashboard' }).click()
  const pill = page.getByRole('link', { name: /Focus timer, \d\d:\d\d left/ })
  await pill.waitFor()
  await pill.click()
  await page.getByRole('button', { name: 'Pause' }).click()
  await page.getByRole('button', { name: 'Resume' }).waitFor()
  await page.getByRole('button', { name: 'Discard' }).click()
  assert.equal(await page.getByRole('timer').textContent(), '25:00')
})

await step('a finished focus session is saved and moves to a break', async () => {
  // Pretend the timer was started 25 minutes ago and is about to end.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('habitflow-pomodoro'))
    const now = Date.now()
    localStorage.setItem(
      'habitflow-pomodoro',
      JSON.stringify({ ...s, mode: 'focus', label: 'Physics homework', endAt: now + 1500, startedAt: new Date(now - 25 * 60_000).toISOString() }),
    )
  })
  await page.reload()
  await toast('Focus session done')
  await page.getByRole('radio', { name: 'Short break', checked: true }).waitFor()
  await page.getByText('No focus sessions yet today.').waitFor({ state: 'detached' })
  await page.getByRole('region', { name: 'Today' }).getByText('Physics homework').waitFor()
  await page.getByRole('button', { name: 'Skip break' }).click()
  await page.getByRole('radio', { name: 'Focus', checked: true }).waitFor()
})

await step('progress has separate Timetable and Pomodoro tabs', async () => {
  await page.goto(`${BASE}/progress`)
  await page.getByRole('tab', { name: 'Timetable', selected: true }).waitFor()
  await page.getByRole('tab', { name: 'Pomodoro' }).click()
  await page.getByRole('heading', { name: 'Focus time' }).waitFor()
  await page.getByText('25m').first().waitFor()
  await page.getByRole('heading', { name: 'By task' }).waitFor()
  await page.screenshot({ path: `${SHOTS}/progress-pomodoro-1440.png`, fullPage: true })
})

await step('friend request validation', async () => {
  await page.goto(`${BASE}/friends`)
  await page.getByRole('heading', { name: 'Friends', exact: true }).waitFor()
  await page.getByLabel('Friend’s username').fill(me)
  await page.getByRole('button', { name: 'Send request' }).click()
  await page.getByText('That’s you!').waitFor()
  await page.getByLabel('Friend’s username').fill(`ghost_${suffix}`)
  await page.getByRole('button', { name: 'Send request' }).click()
  await page.getByText('No user with that username.').waitFor()
})

await step('send request, friend accepts, compare', async () => {
  await page.getByLabel('Friend’s username').fill(buddy.toUpperCase())
  await page.getByRole('button', { name: 'Send request' }).click()
  await toast('Friend request sent.')
  await page.getByText('Waiting for them to accept').waitFor()

  // Buddy logs a focus session and accepts.
  await api.auth.signInWithPassword({ email: `${buddy}@habitflow.local`, password: pass })
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const now = new Date()
  let r = await api.from('pomodoro_sessions').insert({
    label: 'Reading', planned_minutes: 50, focus_seconds: 3000, completed: true, session_date: today,
    started_at: new Date(now - 3_000_000).toISOString(), ended_at: now.toISOString(),
  })
  assert.ifError(r.error)
  const list = await api.rpc('list_friends')
  r = await api.rpc('respond_friend_request', { p_id: list.data[0].id, p_accept: true })
  assert.ifError(r.error)

  await page.reload()
  await page.getByRole('button', { name: 'Compare' }).click()
  await page.getByRole('heading', { name: `You vs ${buddy}` }).waitFor()
  await page.getByRole('heading', { name: 'Pomodoro' }).waitFor()
  await page.getByRole('heading', { name: 'Timetable' }).waitFor()
  await page.getByText('50m').first().waitFor()
  await page.getByText(`${buddy} leads`).first().waitFor()
  await page.getByRole('button', { name: '30D' }).click()
  await page.getByText('Focus time over the last 30 days').waitFor()
  await page.screenshot({ path: `${SHOTS}/compare-1440.png`, fullPage: true })
})

await step('phone layout: no horizontal overflow, 5 tabs', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of ['/focus', '/progress?view=pomodoro', '/friends', new URL(page.url()).pathname]) {
    await page.goto(`${BASE}/#${path}`)
    await page.waitForTimeout(800)
    if (path.startsWith('/friends/')) await page.screenshot({ path: `${SHOTS}/compare-390.png`, fullPage: true })
    await noOverflow(path)
  }
  await page.goto(`${BASE}/focus`)
  await page.getByRole('timer').waitFor()
  await page.screenshot({ path: `${SHOTS}/focus-390.png`, fullPage: true })
  const tabs = await page.locator('nav[aria-label="Main"]').last().getByRole('link').count()
  assert.equal(tabs, 5)
})

await step('unfriend', async () => {
  await page.goto(`${BASE}/friends`)
  await page.getByRole('button', { name: `Remove ${buddy}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
  await toast(`${buddy} removed.`)
  await page.getByText('No friends yet').waitFor()
})

await step('no console errors', async () => {
  // The unknown-username check deliberately gets a 400 from send_friend_request.
  const unexpected = errors.filter((e) => !/send_friend_request|status of 400/.test(e))
  assert.deepEqual(unexpected, [], unexpected.join(' | '))
})

// Cleanup: delete both accounts.
await api.rpc('delete_account')
const own = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
await own.auth.signInWithPassword({ email: `${me}@habitflow.local`, password: pass })
await own.rpc('delete_account')
await browser.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
