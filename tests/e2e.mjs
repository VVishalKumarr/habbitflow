// End-to-end UI test with Playwright against a running app.
// Run: BASE_URL=http://localhost:5173 node tests/e2e.mjs   (screenshots -> ./screenshots)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots'
mkdirSync(SHOTS, { recursive: true })
const user = `e2e_${Date.now().toString(36)}`
const pass = 'e2e-password-1'
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const todayName = DAYS[new Date().getDay()]

let passed = 0
const failures = []
async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 4).join('\n    ')}`)
    await page.screenshot({ path: `${SHOTS}/fail-${failures.length}.png` }).catch(() => {})
  }
}

const browser = await chromium.launch()
const errors = []
function watch(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
}
async function noOverflow(page, label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}
const toast = (page, text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 10000 })

console.log(`E2E as ${user} on ${BASE}`)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
watch(page)

await step('unauthenticated /dashboard redirects to login', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  assert.match(page.url(), /\/login$/)
  await page.screenshot({ path: `${SHOTS}/login-1440.png` })
})

await step('register validation errors', async () => {
  await page.getByRole('link', { name: 'Create an account' }).click()
  await page.getByRole('heading', { name: 'Create your account' }).waitFor()
  await page.getByLabel('Username').fill('ab')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('Confirm password').fill('different')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByText('Username must be at least 3 characters.').waitFor()
  await page.getByText('Password must be at least 8 characters.').waitFor()
  await page.getByText('Passwords do not match.').waitFor()
  await page.screenshot({ path: `${SHOTS}/register-errors-1440.png` })
})

await step('register succeeds and shows empty state', async () => {
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill(pass)
  await page.getByLabel('Confirm password').fill(pass)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByText('No trackers yet. Create your first routine').waitFor({ timeout: 15000 })
  await page.screenshot({ path: `${SHOTS}/empty-dashboard-1440.png` })
})

await step('create tracker', async () => {
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await page.getByRole('button', { name: 'Create tracker' }).last().click()
  await page.getByText('Tracker name is required.').waitFor()
  await page.getByLabel('Tracker name').fill('Home Routine')
  await page.getByRole('dialog').getByRole('button', { name: 'Create tracker' }).click()
  await page.getByRole('heading', { level: 1, name: 'Home Routine' }).waitFor()
  await page.getByText('Add your first time slot').waitFor()
})

await step('rename tracker', async () => {
  await page.getByRole('button', { name: 'Rename tracker' }).click()
  await page.getByLabel('New name').fill('My Home Routine')
  await page.getByRole('button', { name: 'Save name' }).click()
  await page.getByRole('heading', { level: 1, name: 'My Home Routine' }).waitFor()
})

async function addSlot(start, end) {
  await page.getByRole('button', { name: 'Add time slot' }).first().click()
  await page.getByLabel('Start', { exact: true }).fill(start)
  await page.getByLabel('End', { exact: true }).fill(end)
  await page.getByRole('dialog').getByRole('button', { name: 'Add time slot' }).click()
}

await step('add time slots (arbitrary lengths)', async () => {
  await addSlot('17:00', '18:00')
  await page.getByRole('row', { name: /5:00 PM/ }).waitFor()
  await addSlot('18:00', '19:30')
  await page.getByRole('row', { name: /6:00 PM/ }).waitFor()
  await addSlot('19:30', '20:00')
  await page.getByRole('row', { name: /7:30 PM/ }).waitFor()
})

await step('overlapping / invalid slot shows validation', async () => {
  await page.getByRole('button', { name: 'Add time slot' }).first().click()
  await page.getByLabel('Start', { exact: true }).fill('17:30')
  await page.getByLabel('End', { exact: true }).fill('18:30')
  await page.getByRole('dialog').getByRole('button', { name: 'Add time slot' }).click()
  await page.getByText(/Overlaps with/).waitFor()
  await page.getByLabel('Start', { exact: true }).fill('21:00')
  await page.getByLabel('End', { exact: true }).fill('20:00')
  await page.getByRole('dialog').getByRole('button', { name: 'Add time slot' }).click()
  await page.getByText('End time must be after start time.').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
})

await step('edit a time slot', async () => {
  await page.getByRole('button', { name: /Edit time slot 7:30 PM/ }).click()
  await page.getByLabel('End', { exact: true }).fill('20:30')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('row', { name: /8:30 PM/ }).waitFor()
})

async function addTaskAt(day, time, title, category) {
  await page.getByRole('button', { name: `Add task on ${day} ${time}` }).click()
  await page.getByLabel('Task name').fill(title)
  if (category) await page.getByRole('dialog').getByText(category, { exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add task' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}

await step('add tasks to timetable cells', async () => {
  await page.getByRole('button', { name: `Add task on Monday 5:00 PM` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add task' }).click()
  await page.getByText('Task name is required.').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await addTaskAt(todayName, '5:00 PM', 'Study Mathematics', 'Study')
  await addTaskAt(todayName, '6:00 PM', 'Exercise', 'Exercise')
  await addTaskAt(todayName, '7:30 PM', 'Reading', 'Personal')
  await addTaskAt(DAYS[(new Date().getDay() + 1) % 7], '6:00 PM', 'Exercise', 'Exercise')
  await page.getByRole('checkbox', { name: /Study Mathematics/ }).first().waitFor()
})

const studyCheck = () => page.getByRole('table').getByRole('checkbox', { name: /Study Mathematics/ })

await step('tick a task; today progress updates', async () => {
  await studyCheck().click()
  await page.getByRole('table').getByRole('checkbox', { name: 'Study Mathematics: completed' }).waitFor()
  await page.getByText('1 / 3 done').waitFor()
  await page.getByText('33%').first().waitFor()
  // Today panel reflects the same state.
  assert.equal(await page.getByRole('region', { name: /Today —/ }).getByRole('checkbox', { name: /Study Mathematics/ }).getAttribute('aria-checked'), 'true')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/dashboard-1440.png`, fullPage: true })
})

await step('refresh: tracker, slots, tasks and completion persist', async () => {
  await page.reload()
  await page.getByRole('heading', { level: 1, name: 'My Home Routine' }).waitFor()
  await page.getByRole('table').getByRole('checkbox', { name: 'Study Mathematics: completed' }).waitFor()
  await page.getByRole('table').getByRole('checkbox', { name: 'Exercise: not completed' }).first().waitFor()
})

await step('completion is per date: previous week is independent', async () => {
  await page.getByRole('button', { name: 'Previous week' }).click()
  await page.getByRole('table').getByRole('checkbox', { name: 'Study Mathematics: not completed' }).waitFor()
  await page.getByRole('table').getByRole('checkbox', { name: /Exercise/ }).first().click()
  await page.getByRole('table').getByRole('checkbox', { name: 'Exercise: completed' }).first().waitFor()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('table').getByRole('checkbox', { name: 'Study Mathematics: completed' }).waitFor()
  assert.equal(await page.getByRole('table').getByRole('checkbox', { name: 'Exercise: completed' }).count(), 0)
})

await step('task options: mark complete, edit, duplicate', async () => {
  await page.getByRole('table').getByRole('button', { name: 'Reading' }).click()
  await page.getByRole('button', { name: 'Mark complete' }).click()
  await page.getByRole('table').getByRole('checkbox', { name: 'Reading: completed' }).waitFor()
  await page.getByRole('table').getByRole('button', { name: 'Reading' }).click()
  await page.getByRole('button', { name: 'Edit or move task' }).click()
  await page.getByLabel('Task name').fill('Reading 20 pages')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('table').getByRole('button', { name: 'Reading 20 pages' }).waitFor()
  await page.getByRole('table').getByRole('button', { name: 'Reading 20 pages' }).click()
  await page.getByRole('button', { name: 'Duplicate to another day' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Duplicate' }).click()
  await toast(page, /Duplicated to/)
  assert.equal(await page.getByRole('table').getByRole('button', { name: 'Reading 20 pages' }).count(), 2)
})

await step('delete task requires confirmation', async () => {
  await page.getByRole('table').getByRole('button', { name: 'Reading 20 pages' }).nth(1).click()
  await page.getByRole('button', { name: 'Delete task' }).click()
  await page.getByText(/will be removed from every/).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete task' }).click()
  await toast(page, 'Task deleted.')
  assert.equal(await page.getByRole('table').getByRole('button', { name: 'Reading 20 pages' }).count(), 1)
})

await step('keyboard: Escape closes dialogs', async () => {
  await page.getByRole('button', { name: 'New tracker' }).click()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
})

await step('progress page shows stats and charts', async () => {
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Progress' }).click()
  await page.getByText('Overall completion').waitFor({ timeout: 15000 })
  await page.getByText('Completed today').waitFor()
  await page.locator('.recharts-surface').first().waitFor()
  const charts = await page.locator('.recharts-surface').count()
  assert.ok(charts >= 3, `expected >=3 charts, got ${charts}`)
  await page.getByText('2 / 3').first().waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/progress-1440.png`, fullPage: true })
})

await step('task detail from statistics', async () => {
  await page.getByRole('button', { name: /^Study Mathematics: 100% completed/ }).click()
  await page.getByRole('dialog').getByText('Completion rate', { exact: true }).waitFor()
  await page.getByRole('dialog').getByText('1 / 1 days').waitFor()
  await page.screenshot({ path: `${SHOTS}/task-detail-1440.png` })
  await page.keyboard.press('Escape')
})

await step('second tracker is independent; switching works', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: 'New tracker' }).click()
  await page.getByLabel('Tracker name').fill('Vacation Routine')
  await page.getByRole('dialog').getByRole('button', { name: 'Create tracker' }).click()
  await page.getByRole('heading', { level: 1, name: 'Vacation Routine' }).waitFor()
  await page.getByText('Add your first time slot').waitFor()
  await page.getByRole('button', { name: 'Switch tracker' }).click()
  await page.getByRole('menuitem', { name: 'My Home Routine' }).click()
  await page.getByRole('heading', { level: 1, name: 'My Home Routine' }).waitFor()
  await page.getByRole('table').getByRole('checkbox', { name: 'Study Mathematics: completed' }).waitFor()
})

await step('delete tracker with confirmation', async () => {
  await page.getByRole('button', { name: 'Switch tracker' }).click()
  await page.getByRole('menuitem', { name: 'Vacation Routine' }).click()
  await page.getByRole('heading', { level: 1, name: 'Vacation Routine' }).waitFor()
  await page.getByRole('button', { name: 'Delete tracker' }).click()
  await page.getByText(/Are you sure you want to delete/).waitFor()
  await page.getByText(/All tasks and progress data for this tracker will be deleted/).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tracker' }).click()
  await page.getByRole('heading', { level: 1, name: 'My Home Routine' }).waitFor()
})

await step('settings: 24h format + dark mode persist', async () => {
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: '24-hour' }).click()
  await page.getByRole('radio', { name: 'Dark' }).click()
  await page.getByRole('radio', { name: 'Monday' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/settings-dark-1440.png`, fullPage: true })
  await page.reload()
  await page.getByRole('radio', { name: '24-hour' }).and(page.locator('[aria-checked="true"]')).waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('dark')))
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('row', { name: /17:00/ }).waitFor()
  const firstDay = await page.getByRole('columnheader').nth(1).innerText()
  assert.match(firstDay, /MON/i)
  await page.screenshot({ path: `${SHOTS}/dashboard-dark-1440.png`, fullPage: true })
  await page.goto(`${BASE}/settings`)
  await page.getByRole('radio', { name: 'Light' }).click()
  await page.getByRole('radio', { name: '12-hour' }).click()
  await page.getByRole('radio', { name: 'Sunday' }).click()
  await page.waitForTimeout(800)
})

await step('logout, protected route blocked, login again', async () => {
  await page.getByRole('button', { name: 'Log out' }).click()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  await page.goto(`${BASE}/progress`)
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByText('Incorrect username or password.').waitFor()
  await page.getByLabel('Password', { exact: true }).fill(pass)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('heading', { level: 1, name: 'My Home Routine' }).waitFor({ timeout: 15000 })
})

// ---- Responsive checks ----------------------------------------------------
const SIZES = [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [768, 1024],
  [430, 932],
  [390, 844],
  [375, 812],
]
for (const [w, h] of SIZES) {
  await step(`layout ${w}x${h}: no horizontal overflow on all pages`, async () => {
    await page.setViewportSize({ width: w, height: h })
    for (const route of ['dashboard', 'progress', 'settings']) {
      await page.goto(`${BASE}/${route}`)
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      await page.waitForTimeout(500)
      await noOverflow(page, `${route} @${w}`)
      if (w === 1920 || w === 768 || w === 390) await page.screenshot({ path: `${SHOTS}/${route}-${w}.png`, fullPage: true })
    }
  })
}

await step('mobile: day view, swipe, tick, bottom nav, modal fits', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('tablist', { name: 'Day of week' }).waitFor()
  assert.equal(await page.getByRole('table').isVisible().catch(() => false), false, 'desktop table should be hidden')
  const card = page.getByRole('checkbox', { name: /Exercise/ }).first()
  await card.click()
  await page.getByRole('checkbox', { name: 'Exercise: completed' }).first().waitFor()
  await card.click()
  await page.getByRole('tab', { name: new RegExp(`^${DAYS[(new Date().getDay() + 2) % 7]}`) }).click()
  await page.getByRole('button', { name: 'Add task' }).first().click()
  const box = await page.getByRole('dialog').boundingBox()
  assert.ok(box && box.width <= 390 && box.y >= 0, 'modal should fit the screen')
  await page.screenshot({ path: `${SHOTS}/mobile-add-task-390.png` })
  await page.keyboard.press('Escape')
  // Tap targets in the bottom nav are at least 44px tall.
  const navBox = await page.getByRole('navigation', { name: 'Main' }).last().getByRole('link', { name: 'Progress' }).boundingBox()
  assert.ok(navBox.height >= 44)
})

await step('settings: delete account removes access', async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${BASE}/settings`)
  await page.getByRole('button', { name: 'Delete account' }).click()
  await page.getByRole('dialog').getByLabel('Current Password').fill(pass)
  await page.getByLabel(/Type “/).fill(user)
  await page.getByRole('button', { name: 'Delete forever' }).click()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 15000 })
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password', { exact: true }).fill(pass)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByText('Incorrect username or password.').waitFor()
})

await browser.close()
const relevant = errors.filter((e) => !/400|401|Failed to load resource/.test(e))
if (relevant.length) console.log('\nBrowser errors:\n  ' + relevant.join('\n  '))
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length || relevant.length) process.exitCode = 1
