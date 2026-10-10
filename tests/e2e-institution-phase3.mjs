// End-to-end tests for Phase 3 screens: guardian request → approval →
// parent activation → parent dashboard, messages and meeting requests,
// announcements, class timetable, goals, phone layouts.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-institution-phase3.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, day, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/institution-p3'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)
const PARENT = `mum${suffix}@family-test.example.com`

let passed = 0
const failures = []
async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
    await page.screenshot({ path: `${SHOTS}/fail-${failures.length}.png`, fullPage: true }).catch(() => {})
  }
}

const browser = await chromium.launch()
const errors = []
let ctx, page
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 15000 })
const dialog = (name) => page.getByRole('dialog', { name })
const schoolNav = (name) => page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name, exact: true })
async function fresh(viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
}
async function login(email, viewport) {
  await fresh(viewport)
  await page.goto(`${BASE}/login/institution`)
  await page.getByLabel('Institutional email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/school$/, { timeout: 20000 })
}
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}

console.log('Institution phase 3 e2e')
let link
try {
  const W = await buildSchool(suffix)
  const { instA, DOM_A, principal, subjT, class10a, maths } = W
  await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Probability sheet', opens_at: day(-1), due_at: day(4) }).select())
  // today's period so the student overview has a timetable
  const dow = new Date().getDay()
  await one(principal.c.from('class_periods').insert({ institution_id: instA, class_id: class10a, day_of_week: dow, start_time: '08:00', end_time: '08:45', subject_id: maths, teacher_id: subjT.membership }).select())

  await step('student asks to link a parent', async () => {
    await login(`s1@${DOM_A}`)
    await page.getByText('Today at school').waitFor()
    await page.getByRole('button', { name: 'Add parent/guardian' }).click()
    const d = dialog('Add a parent or guardian')
    await d.getByLabel('Their name').fill('Meena Rao')
    await d.getByLabel('Their email address').fill(PARENT)
    await d.getByRole('button', { name: 'Send request' }).click()
    await toast('Request sent to your school for approval.')
    await page.getByText('Waiting for school approval').waitFor()
    await page.screenshot({ path: `${SHOTS}/01-student-guardians.png`, fullPage: true })
  })

  await step('class teacher approves and gets the one-time link (email not configured)', async () => {
    await login(`ct@${DOM_A}`)
    await schoolNav('Parents & guardians').click()
    await page.getByText('Meena Rao').waitFor()
    await page.getByRole('button', { name: 'Approve' }).click()
    const code = page.locator('code').filter({ hasText: '/activate?token=' }).first()
    await code.waitFor()
    link = (await code.textContent()).trim()
    await page.screenshot({ path: `${SHOTS}/02-approve.png`, fullPage: true })
  })

  await step('parent activates and sees only their child', async () => {
    await fresh()
    const token = new globalThis.URL(link).searchParams.get('token')
    await page.goto(`${BASE}/activate?token=${token}`)
    await page.getByText(/invited Meena Rao as Parent/).waitFor()
    await page.getByLabel('Choose a password').fill(PASS)
    await page.getByLabel('Confirm password').fill(PASS)
    await page.getByRole('button', { name: 'Activate account' }).click()
    await page.waitForURL(/\/school$/, { timeout: 20000 })
    await page.getByRole('heading', { name: 'Student One' }).waitFor()
    await page.getByText('Probability sheet').waitFor()
    await page.getByRole('heading', { name: 'Class timetable' }).waitFor()
    for (const name of ['Assignments', 'Attendance', 'Marks', 'People', 'Classes & subjects']) {
      assert.equal(await page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name, exact: true }).count(), 0, name)
    }
    await page.screenshot({ path: `${SHOTS}/03-parent-dashboard.png`, fullPage: true })
  })

  await step('parent messages the maths teacher', async () => {
    await schoolNav('Messages').click()
    await page.getByRole('button', { name: 'New message' }).click()
    const d = dialog('New message')
    await d.getByLabel('To').selectOption({ label: 'Subject Teacher — Mathematics' })
    await d.getByLabel('Subject').fill('Probability homework')
    await d.getByLabel('Message').fill('Meera found question 4 hard. Any tips?')
    await d.getByRole('button', { name: 'Send' }).click()
    await d.waitFor({ state: 'detached' })
    await page.getByRole('paragraph').filter({ hasText: 'Meera found question 4 hard. Any tips?' }).waitFor()
    await page.screenshot({ path: `${SHOTS}/04a-parent-sent.png`, fullPage: true })
  })

  await step('teacher replies with a meeting request; parent accepts', async () => {
    await login(`st@${DOM_A}`)
    await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click()
    await page.getByRole('menuitem', { name: /Probability homework/ }).click()
    await page.getByRole('paragraph').filter({ hasText: 'Meera found question 4 hard. Any tips?' }).waitFor()
    await page.getByLabel('Request a meeting').check()
    await page.getByLabel('Message').fill('Happy to explain — can we meet?')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText('Waiting for reply').waitFor()
    await fresh()
    await page.goto(`${BASE}/login/institution`)
    await page.getByLabel('Institutional email').fill(PARENT)
    await page.getByLabel('Password', { exact: true }).fill(PASS)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/school$/)
    await schoolNav('Messages').click()
    await page.getByRole('button', { name: /Probability homework/ }).click()
    await page.getByRole('button', { name: 'Accept' }).click()
    await page.getByText('accepted').waitFor()
    await page.screenshot({ path: `${SHOTS}/04-messages.png`, fullPage: true })
  })

  await step('class teacher posts a class announcement that the parent receives', async () => {
    await login(`ct@${DOM_A}`)
    await schoolNav('Announcements').click()
    await page.getByRole('button', { name: 'New announcement' }).click()
    const d = dialog('New announcement')
    await d.getByLabel('Title').fill('Science fair on Friday')
    await d.getByLabel('Message').fill('Projects due Thursday.')
    await d.getByRole('button', { name: 'Post' }).click()
    await toast('Announcement posted.')
    await fresh()
    await page.goto(`${BASE}/login/institution`)
    await page.getByLabel('Institutional email').fill(PARENT)
    await page.getByLabel('Password', { exact: true }).fill(PASS)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/school$/)
    await schoolNav('Announcements').click()
    await page.getByText('Science fair on Friday').waitFor()
  })

  await step('principal edits the class timetable', async () => {
    await login(`head@${DOM_A}`)
    await schoolNav('Classes & subjects').click()
    await page.getByRole('button', { name: /10 A/ }).click()
    await page.getByRole('heading', { name: 'Weekly timetable' }).waitFor()
    await page.getByLabel('Day', { exact: true }).selectOption({ label: 'Tue' })
    await page.getByLabel('Period label').fill('Assembly')
    await page.getByRole('button', { name: 'Add period' }).click()
    await page.getByText('Assembly').waitFor()
    await page.getByRole('heading', { name: 'Timetable conflicts' }).waitFor()
  })

  await step('student sets and completes a goal; the achievement is earned', async () => {
    await login(`s1@${DOM_A}`)
    await schoolNav('Goals').click()
    await page.getByRole('button', { name: 'New goal' }).click()
    await dialog('New goal').getByLabel('Goal').fill('Finish probability revision')
    await dialog('New goal').getByRole('button', { name: 'Add goal' }).click()
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByText('Completed', { exact: true }).waitFor()
    await page.waitForTimeout(800)
    const earned = page.locator('div').filter({ hasText: /^Goal reached/ }).first()
    await earned.waitFor()
    await page.screenshot({ path: `${SHOTS}/05-goals.png`, fullPage: true })
  })

  await step('phone layout: parent and messages pages have no horizontal overflow', async () => {
    await fresh({ width: 390, height: 844 })
    await page.goto(`${BASE}/login/institution`)
    await page.getByLabel('Institutional email').fill(PARENT)
    await page.getByLabel('Password', { exact: true }).fill(PASS)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/school$/)
    for (const path of ['/school', '/school/messages', '/school/announcements', '/school/calendar']) {
      await page.goto(`${BASE}${path}`)
      await page.locator('h1').first().waitFor()
      await page.waitForTimeout(500)
      await noOverflow(path)
    }
    await page.goto(`${BASE}/school`)
    await page.getByText('Probability sheet').waitFor()
    await page.screenshot({ path: `${SHOTS}/06-phone-parent.png`, fullPage: true })
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser.close()
  if (!process.env.KEEP) await cleanup(suffix)
  if (!process.env.KEEP) await adminSql(`delete from auth.users where email = '${PARENT}'`).catch(() => {})
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
