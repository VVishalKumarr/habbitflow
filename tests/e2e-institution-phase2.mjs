// End-to-end tests for Phase 2 screens: homework upload and review,
// notifications, attendance register and corrections, marks, student views,
// phone layouts.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-institution-phase2.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { buildSchool, cleanup, day, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/institution-p2'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)

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
async function login(email, viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
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
const pdfFile = { name: 'algebra.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n') }

console.log('Institution phase 2 e2e')
let W
try {
  W = await buildSchool(suffix)
  const { instA, DOM_A, subjT, class10a, maths } = W
  await one(subjT.c.from('assignments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Quadratic equations', opens_at: day(-1), due_at: day(3) }).select())

  await step('student uploads homework; oversize files are refused with a clear message', async () => {
    await login(`s1@${DOM_A}`)
    await schoolNav('Assignments').click()
    await page.getByText('Quadratic equations').waitFor()
    const big = { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([pdfFile.buffer, Buffer.alloc(4 * 1024 * 1024)]) }
    await page.locator('input[type=file]').setInputFiles(big)
    await page.getByText('larger than 4 MB').waitFor()
    await page.locator('input[type=file]').setInputFiles(pdfFile)
    await toast('Submitted. Your teacher will review it.')
    await page.getByText('Submitted', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'algebra.pdf', exact: true }).waitFor()
    await page.screenshot({ path: `${SHOTS}/01-student-submitted.png`, fullPage: true })
  })

  await step('teacher reviews: resubmission needs feedback, then the student is told', async () => {
    await login(`st@${DOM_A}`)
    await schoolNav('Assignments').click()
    await page.getByRole('button', { name: /Submissions 1\/1/ }).click()
    await dialog('Quadratic equations').getByRole('button', { name: 'Review' }).click()
    const d = dialog('Review: Student One')
    await d.getByRole('button', { name: 'Request resubmission' }).click()
    await d.getByText(/what to change/).waitFor()
    await d.getByLabel('Feedback for the student').fill('Show the discriminant step.')
    await d.getByRole('button', { name: 'Request resubmission' }).click()
    await toast('Marked as resubmission requested.')
    await dialog('Quadratic equations').getByText('Resubmission requested').waitFor()
    await page.screenshot({ path: `${SHOTS}/02-teacher-review.png`, fullPage: true })
  })

  await step('student sees the feedback and a notification, and uploads a new version', async () => {
    await login(`s1@${DOM_A}`)
    await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click()
    await page.getByRole('menuitem', { name: /needs changes/ }).click()
    await page.waitForURL(/\/school\/assignments/)
    await page.getByText('Show the discriminant step.').waitFor()
    await page.locator('input[type=file]').setInputFiles({ ...pdfFile, name: 'algebra-v2.pdf' })
    await toast('Submitted. Your teacher will review it.')
    await page.getByText('attempt 2').waitFor()
  })

  await step('class teacher takes the register and a correction asks for a reason', async () => {
    await login(`ct@${DOM_A}`)
    await schoolNav('Attendance').click()
    await page.getByRole('button', { name: 'All present' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await toast('Saved 1 record.')
    await page.getByRole('radio', { name: 'Absent' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const d = dialog('Reason for the correction')
    await d.getByLabel('Why is this record changing?').fill('Left at 10am, parent called')
    await d.getByRole('button', { name: 'Save correction' }).click()
    await toast('Saved 1 record.')
    await page.screenshot({ path: `${SHOTS}/03-register.png`, fullPage: true })
  })

  await step('subject teacher enters marks (validated) and publishes', async () => {
    await login(`st@${DOM_A}`)
    await schoolNav('Marks').click()
    await page.getByRole('button', { name: 'New assessment' }).click()
    await dialog('New assessment').getByLabel('Title').fill('Unit test 1')
    await dialog('New assessment').getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: 'Enter marks' }).click()
    const d = dialog('Unit test 1')
    await d.getByLabel('Marks for Student One').fill('60')
    await d.getByRole('button', { name: 'Save & publish' }).click()
    await d.getByText('Marks must be between 0 and 50.').waitFor()
    await d.getByLabel('Marks for Student One').fill('43')
    await d.getByLabel('Feedback for Student One').fill('Careful with signs')
    await d.getByRole('button', { name: 'Save & publish' }).click()
    await toast('Published. 1 student notified.')
    await page.getByText(/Average 43\.0/).waitFor()
  })

  await step('student sees marks, attendance and real figures on the overview', async () => {
    await login(`s1@${DOM_A}`)
    await page.getByText('Your progress').waitFor()
    await page.getByText('43 / 50').count() // overview doesn't list marks; check pages below
    await schoolNav('Marks').click()
    await page.getByText('43 / 50').waitFor()
    await page.getByText('“Careful with signs”').waitFor()
    await schoolNav('Attendance').click()
    await page.getByText('Absent', { exact: true }).first().waitFor()
    await page.screenshot({ path: `${SHOTS}/04-student-attendance.png`, fullPage: true })
    await schoolNav('Overview').click()
    await page.getByText('86%').waitFor()
    await page.screenshot({ path: `${SHOTS}/05-student-overview.png`, fullPage: true })
  })

  await step('another student sees none of it', async () => {
    await login(`s2@${DOM_A}`)
    await schoolNav('Marks').click()
    await page.getByText('No published marks yet.').waitFor()
    await schoolNav('Assignments').click()
    await page.getByText('No assignments').waitFor()
  })

  await step('phone layout: Phase 2 pages have no horizontal overflow', async () => {
    for (const who of [`st@${DOM_A}`, `s1@${DOM_A}`]) {
      await login(who, { width: 390, height: 844 })
      for (const path of ['/school/assignments', '/school/attendance', '/school/marks', '/school']) {
        await page.goto(`${BASE}${path}`)
        await page.locator('h1').first().waitFor()
        await page.waitForTimeout(500)
        await noOverflow(`${who} ${path}`)
      }
    }
    await page.goto(`${BASE}/school/assignments`)
    await page.getByText('Quadratic equations').waitFor()
    await page.screenshot({ path: `${SHOTS}/06-phone-student-assignments.png`, fullPage: true })
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser.close()
  await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
