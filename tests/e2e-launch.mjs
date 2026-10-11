// End-to-end tests for the launch features (public site, account recovery,
// username/password changes, freemium gating, trial, exports, themes, sounds,
// assistant fallback, consent, leaderboard, deletion, responsive layout).
// Run: BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-launch.mjs
import assert from 'node:assert/strict'
import { mkdirSync, statSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)
let user = `launch_${suffix}`
const pass = 'launch-pass-1'
const newPass = 'launch-pass-2'

let passed = 0
const failures = []
async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 5).join('\n    ')}`)
    await page.screenshot({ path: `${SHOTS}/fail-${failures.length}.png` }).catch(() => {})
  }
}

const browser = await chromium.launch()
const errors = []
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 10000 })
const upgradeDialog = () => page.getByRole('dialog', { name: 'Upgrade to unlock' })
async function closeUpgrade() {
  await upgradeDialog().getByRole('button', { name: 'Maybe Later' }).click()
  await upgradeDialog().waitFor({ state: 'detached' })
}
/** Insert rows as the signed-in user (RLS applies), using the app's stored session. */
async function apiInsert(table, row) {
  return page.evaluate(
    async ({ table, row, url, key }) => {
      const token = JSON.parse(localStorage.getItem('habitflow-auth')).access_token
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(row),
      })
      return (await r.json())[0]
    },
    { table, row, url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_ANON_KEY },
  )
}
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}

console.log(`E2E (launch) as ${user} on ${BASE}`)

await step('landing page is public with CTAs and pricing from the database', async () => {
  await page.goto(`${BASE}/`)
  await page.getByRole('heading', { name: /Plan your week/ }).waitFor()
  await page.getByRole('link', { name: 'Create Free Account' }).first().waitFor()
  await page.getByRole('link', { name: 'Login' }).first().waitFor()
  await page.getByText('₹999').first().waitFor({ timeout: 10000 })
  await page.getByRole('radio', { name: 'Monthly' }).first().click()
  await page.getByText('₹129').first().waitFor()
  await page.screenshot({ path: `${SHOTS}/landing-1440.png`, fullPage: true })
})

await step('help articles are public and searchable', async () => {
  await page.goto(`${BASE}/help`)
  await page.getByLabel('Search help').fill('time slot')
  await page.getByRole('link', { name: /How to use the timetable/ }).click()
  await page.getByRole('heading', { name: 'Add a time slot' }).waitFor()
})

await step('privacy, terms and cookie settings', async () => {
  await page.goto(`${BASE}/privacy`)
  await page.getByRole('heading', { name: 'Privacy Policy', level: 1 }).waitFor()
  await page.getByText('not configured').first().waitFor() // placeholders, nothing invented
  await page.goto(`${BASE}/terms`)
  await page.getByRole('heading', { name: 'Terms of Service', level: 1 }).waitFor()
  await page.getByRole('contentinfo').getByRole('button', { name: 'Cookie Settings' }).click()
  const d = page.getByRole('dialog', { name: 'Privacy & Cookies' })
  await d.waitFor()
  assert.equal(await d.getByRole('switch', { name: /Analytics/ }).isDisabled(), true, 'not configured -> disabled')
  await d.getByRole('button', { name: 'Save Preferences' }).click()
  // No analytics/ads configured -> no banner and no ads anywhere
  assert.equal(await page.getByRole('region', { name: 'Cookie consent' }).count(), 0)
})

await step('forgot password: link from login, graceful when email is not configured', async () => {
  await page.goto(`${BASE}/login`)
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await page.getByRole('heading', { name: 'Forgot password' }).waitFor()
  await page.getByLabel('Username or Email').fill('nobody')
  await page.getByRole('button', { name: 'Send Password Reset Link' }).click()
  await page.getByRole('alert').getByText(/aren’t set up/).waitFor()
})

await step('reset link without a token is rejected', async () => {
  await page.goto(`${BASE}/reset-password?token_hash=bogus&type=recovery`)
  await page.getByRole('heading', { name: 'Link expired' }).waitFor()
  assert.ok(!page.url().includes('bogus'), 'token removed from the address bar')
})

await step('register with optional email (email not configured -> account still created)', async () => {
  await page.goto(`${BASE}/register`)
  await page.getByText('If you don\'t add an email, password recovery will not be available').waitFor()
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill(pass)
  await page.getByLabel('Confirm password').fill(pass)
  await page.getByLabel('Email (optional)').fill('not-an-email')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByText('Enter a valid email address, or leave it empty.').waitFor()
  await page.getByLabel('Email (optional)').fill('someone@example.com')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/dashboard/)
  await toast('recovery email wasn’t set')
})

await step('free plan: third tracker opens the upgrade dialog (data untouched)', async () => {
  for (const name of ['Tracker A', 'Tracker B']) {
    await page.getByRole('button', { name: /^(New tracker|Create tracker)$/ }).first().click()
    await page.getByRole('dialog').getByLabel(/name/i).fill(name)
    await page.getByRole('dialog').getByRole('button', { name: 'Create tracker' }).click()
    await page.getByRole('heading', { name, level: 1 }).waitFor()
  }
  await page.getByRole('button', { name: 'New tracker' }).click()
  await upgradeDialog().getByText('You’ve reached the free tracker limit.').waitFor()
  await page.screenshot({ path: `${SHOTS}/upgrade-modal-1440.png` })
  await closeUpgrade()
})

await step('free plan: 90-day range, colour themes, exports and sounds are Pro', async () => {
  // Give the current tracker a slot, a task for today and a completion so charts render.
  const trackers = await page.evaluate(
    async ({ url, key }) => {
      const token = JSON.parse(localStorage.getItem('habitflow-auth')).access_token
      const r = await fetch(`${url}/rest/v1/trackers?select=id,name&name=eq.Tracker%20B`, { headers: { apikey: key, Authorization: `Bearer ${token}` } })
      return r.json()
    },
    { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_ANON_KEY },
  )
  const slot = await apiInsert('time_slots', { tracker_id: trackers[0].id, start_time: '07:00', end_time: '08:00' })
  const dow = new Date().getDay()
  const task = await apiInsert('tasks', { tracker_id: trackers[0].id, time_slot_id: slot.id, day_of_week: dow, title: 'Morning run', category: 'exercise' })
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  await apiInsert('task_completions', { task_id: task.id, tracker_id: trackers[0].id, completion_date: today, completed: true })
  await page.goto(`${BASE}/progress`)
  await page.getByText('Morning run').first().waitFor()
  await page.getByRole('link', { name: 'Upgrade' }).waitFor() // plan loaded
  await page.getByRole('button', { name: /90D/ }).first().click()
  await upgradeDialog().waitFor()
  await closeUpgrade()
  await page.goto(`${BASE}/settings`)
  await page.getByRole('radio', { name: /Ocean/ }).click()
  await upgradeDialog().getByText('Custom themes need a paid plan.').waitFor()
  await upgradeDialog().getByText('Included in Plus and Pro.').waitFor()
  await closeUpgrade()
  await page.getByRole('button', { name: 'CSV export' }).click()
  await upgradeDialog().getByText('PDF/CSV export is a Pro feature.').waitFor()
  await closeUpgrade()
  await page.goto(`${BASE}/focus`)
  await page.getByRole('link', { name: 'Upgrade' }).waitFor() // plan loaded
  await page.getByRole('button', { name: /Rain/ }).click()
  await upgradeDialog().getByText('Focus sounds are a Pro feature.').waitFor()
  await closeUpgrade()
})

await step('AI assistant answers from help articles when AI is not configured', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: 'Open AI Assistant' }).click()
  const panel = page.getByRole('dialog', { name: 'AI Assistant' })
  await panel.getByText('Need help with your timetable?').waitFor()
  await panel.getByLabel('Ask a question').fill('How do I add a new time slot?')
  await panel.getByRole('button', { name: 'Send' }).click()
  await panel.getByText('Answering from the help articles').waitFor({ timeout: 15000 })
  await panel.getByRole('link', { name: 'How to use the timetable' }).waitFor()
  await page.screenshot({ path: `${SHOTS}/assistant-1440.png` })
  await panel.getByRole('button', { name: 'Close assistant' }).click()
})

await step('recovery email in Settings: needs password, graceful when email is not configured', async () => {
  await page.goto(`${BASE}/settings`)
  await page.getByText('Not set — password recovery is unavailable.').waitFor()
  await page.getByRole('button', { name: 'Add email' }).click()
  const d = page.getByRole('dialog', { name: 'Add Recovery Email' })
  await d.getByLabel('Email address').fill('me@example.com')
  await d.getByLabel('Current Password').fill(pass)
  await d.getByRole('button', { name: 'Send confirmation link' }).click()
  await d.getByText(/isn’t set up/).waitFor()
  await d.getByRole('button', { name: 'Cancel' }).click()
})

await step('change username (needs current password; same account)', async () => {
  await page.getByRole('button', { name: 'Change Username' }).click()
  const d = page.getByRole('dialog', { name: 'Change Username' })
  await d.getByLabel('New Username').fill(`${user}_x`)
  await d.getByLabel('Current Password').fill('wrong-password-9')
  await d.getByRole('button', { name: 'Change Username' }).click()
  await d.getByText('Current password is incorrect.').waitFor()
  await d.getByLabel('Current Password').fill(pass)
  await d.getByRole('button', { name: 'Change Username' }).click()
  await toast(`Your username is now “${user}_x”`)
  user = `${user}_x`
  await page.getByText(user, { exact: true }).first().waitFor()
})

await step('change password, then log in with new username + password', async () => {
  await page.getByRole('button', { name: 'Change password' }).click()
  const d = page.getByRole('dialog', { name: 'Change Password' })
  await d.getByLabel('Current Password').fill(pass)
  await d.getByLabel('New Password', { exact: true }).fill(newPass)
  await d.getByLabel('Confirm New Password').fill(newPass)
  await d.getByRole('button', { name: 'Change password' }).click()
  await toast('Your password has been changed.')
  await page.getByRole('button', { name: 'Log out' }).first().click()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill(newPass)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.waitForURL(/\/dashboard/)
  await page.getByRole('heading', { name: 'Tracker B', level: 1 }).waitFor()
})

await step('Pro page: start free trial (server-side), plan shows everywhere', async () => {
  await page.getByRole('link', { name: 'Upgrade' }).click()
  await page.getByRole('heading', { name: 'Choose your plan' }).waitFor()
  await page.getByRole('heading', { name: 'Plus', exact: true }).waitFor()
  await page.getByText('₹499').first().waitFor() // Plus, yearly (default)
  await page.getByText('Online payments aren’t available yet.').waitFor() // no fake checkout
  await page.getByRole('button', { name: /Start 7-day free trial/ }).click()
  await toast('Your Pro trial has started.')
  await page.getByText('You’re on a Pro trial').waitFor()
  await page.getByRole('link', { name: 'Pro trial' }).waitFor()
})

await step('Pro: third tracker, colour theme, 90-day stats, sounds', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: 'New tracker' }).click()
  await page.getByRole('dialog').getByLabel(/name/i).fill('Tracker C')
  await page.getByRole('dialog').getByRole('button', { name: 'Create tracker' }).click()
  await page.getByRole('heading', { name: 'Tracker C', level: 1 }).waitFor()
  await page.goto(`${BASE}/settings`)
  await page.getByRole('radio', { name: 'Ocean' }).click()
  await toast('Preferences saved.')
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'ocean', null, { timeout: 10000 })
  await page.screenshot({ path: `${SHOTS}/settings-ocean-1440.png`, fullPage: true })
  await page.goto(`${BASE}/progress?view=pomodoro`)
  await page.goto(`${BASE}/focus`)
  await page.getByRole('link', { name: 'Pro trial' }).waitFor() // plan loaded
  await page.getByRole('button', { name: /Rain/ }).click()
  assert.equal(await page.getByRole('button', { name: /Rain/ }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('slider', { name: 'Volume' }).fill('0.3')
  await page.getByRole('button', { name: /Rain/ }).click()
  assert.equal(await page.getByRole('button', { name: /Rain/ }).getAttribute('aria-pressed'), 'false')
})

await step('Pro: CSV and PDF exports download', async () => {
  await page.goto(`${BASE}/settings`)
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV export' }).click()])
  const csvPath = `${SHOTS}/export.csv`
  await dl.saveAs(csvPath)
  assert.ok(statSync(csvPath).size > 10)
  ;[dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'PDF report' }).click()])
  const pdfPath = `${SHOTS}/report.pdf`
  await dl.saveAs(pdfPath)
  assert.ok(statSync(pdfPath).size > 1000)
})

await step('Friends: leaderboard is opt-in', async () => {
  await page.goto(`${BASE}/friends`)
  await page.getByRole('heading', { name: 'This week’s leaderboard' }).waitFor()
  await page.getByRole('button', { name: 'Participate in leaderboards' }).click()
  await page.getByText('(you)').waitFor({ timeout: 10000 })
})

await step('no ads rendered (not configured)', async () => {
  await page.goto(`${BASE}/progress`)
  await page.waitForTimeout(800)
  assert.equal(await page.getByRole('complementary', { name: 'Advertisement' }).count(), 0)
})

const VIEWPORTS = [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [768, 1024],
  [430, 932],
  [390, 844],
  [375, 812],
]
const PAGES = ['/', '/pro', '/help', '/help/understanding-progress', '/privacy', '/terms', '/dashboard', '/progress', '/progress?view=pomodoro', '/focus', '/friends', '/settings']
for (const [w, h] of VIEWPORTS) {
  await step(`layout ${w}x${h}: no horizontal overflow (new pages, dialogs, assistant)`, async () => {
    await page.setViewportSize({ width: w, height: h })
    for (const p of PAGES) {
      await page.goto(`${BASE}${p}`)
      await page.waitForTimeout(500)
      await noOverflow(`${p} @${w}`)
    }
    await page.goto(`${BASE}/settings`)
    await page.getByRole('button', { name: 'Change Username' }).click()
    await noOverflow(`username dialog @${w}`)
    await page.keyboard.press('Escape')
    await page.goto(`${BASE}/dashboard`)
    await page.getByRole('button', { name: 'Open AI Assistant' }).click()
    await noOverflow(`assistant @${w}`)
    if (w === 390) await page.screenshot({ path: `${SHOTS}/assistant-390.png` })
    await page.getByRole('button', { name: 'Close assistant' }).click()
  })
}

await step('mobile screenshots of key new pages', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [p, n] of [['/pro', 'pro'], ['/settings', 'settings'], ['/friends', 'friends']]) {
    await page.goto(`${BASE}${p}`)
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/${n}-390.png`, fullPage: true })
  }
})

await step('delete account needs password and confirmation, then access is gone', async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${BASE}/settings`)
  await page.getByRole('button', { name: 'Delete account' }).click()
  const d = page.getByRole('dialog', { name: 'Delete Account' })
  await d.getByText('Deleting your account permanently removes your trackers, tasks, progress').waitFor()
  await d.getByLabel('Current Password').fill(newPass)
  await d.getByLabel(/Type “/).fill('wrong-name')
  await d.getByRole('button', { name: 'Delete forever' }).click()
  await d.getByText(/exactly to confirm/).waitFor()
  await d.getByLabel(/Type “/).fill(user)
  await d.getByRole('button', { name: 'Delete forever' }).click()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 20000 })
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill(newPass)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByText('Incorrect username or password.').waitFor()
})

await step('no unexpected browser errors', async () => {
  // Expected: 4xx/5xx from deliberately failing requests (limits, unconfigured email).
  const unexpected = errors.filter((e) => !/status of (400|401|403|404|503)|Failed to load resource/.test(e))
  assert.deepEqual(unexpected, [], unexpected.join(' | '))
})

await browser.close()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
