// Browser test: a class teacher edits the class timetable and a student's
// personal timetable; the student is notified, sees who changed it and undoes it.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-teacher-timetable.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/teacher-timetable'
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
async function institutional(email, viewport = { width: 1440, height: 900 }) {
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
const schoolNav = (name) => page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name, exact: true })

console.log('Teacher timetable e2e')
try {
  const W = await buildSchool(suffix)
  await one(W.s1.c.rpc('apply_timetable_change', {
    p_tracker: null, p_new_name: 'My week', p_base_version: null, p_source: 'voice', p_summary: 'seed',
    p_ops: [{ op: 'add_slot', ref: 'a', start: '17:00', end: '18:00' }, { op: 'add_task', slot_ref: 'a', day: 1, title: 'Reading', category: 'personal', description: null }],
  }))

  await step('the class teacher adds a period to their class timetable', async () => {
    await institutional(`ct@${W.DOM_A}`)
    await schoolNav('Classes & subjects').click()
    await page.getByRole('button', { name: /10 A/ }).click()
    await page.getByLabel('Period subject').selectOption({ label: 'Science' })
    await page.getByRole('button', { name: 'Add period' }).click()
    await page.getByText('Science').nth(1).waitFor()
    const [{ n }] = await adminSql(`select count(*)::int n from public.class_periods where class_id = '${W.class10a}'`)
    assert.equal(n, 1)
  })

  await step('…and edits a student’s personal timetable (no ticks shown)', async () => {
    await page.getByRole('button', { name: 'Timetable of Student One' }).click()
    const d = page.getByRole('dialog', { name: 'Student One’s timetable' })
    await d.getByText('Reading').waitFor()
    await d.getByRole('button', { name: 'Add activity' }).click()
    const f = d.getByRole('form', { name: 'Add activity' })
    await f.getByLabel('Activity').fill('Maths revision')
    await f.getByLabel('Day').selectOption({ label: 'Tue' })
    await f.getByLabel('From').fill('18:00')
    await f.getByLabel('To').fill('19:00')
    await f.getByLabel(/Note for the student/).fill('Chapter 4 exercises')
    await page.screenshot({ path: `${SHOTS}/01-teacher-add.png` })
    await f.getByRole('button', { name: 'Save' }).click()
    await toast('Saved. Student One has been notified.')
    await d.getByRole('button', { name: 'Edit Reading on Monday' }).click()
    const e = d.getByRole('form', { name: 'Edit activity' })
    await e.getByLabel('Activity').fill('Reading – novel')
    await e.getByRole('button', { name: 'Save' }).click()
    await toast('Saved. Student One has been notified.')
    await d.getByText('Recent changes').waitFor()
    await d.getByText('Edited “Reading – novel”').waitFor()
    await page.screenshot({ path: `${SHOTS}/02-teacher-view.png` })
    assert.equal(await page.getByRole('button', { name: 'Timetable of Student Two' }).count(), 0)
  })

  await step('a subject teacher has no timetable buttons and can’t edit periods', async () => {
    await institutional(`st@${W.DOM_A}`)
    await schoolNav('Classes & subjects').click()
    await page.getByRole('button', { name: /10 A/ }).click()
    await page.getByRole('heading', { name: 'Weekly timetable' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add period' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^Timetable of / }).count(), 0)
  })

  await step('the student is notified, sees who changed it, and can undo it', async () => {
    await institutional(`s1@${W.DOM_A}`)
    await page.getByRole('button', { name: /Notifications/ }).click()
    await page.getByText('Your class teacher changed your timetable').first().waitFor()
    await page.goto(`${BASE}/dashboard`)
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Timetable assistant' }) })
    await panel.getByRole('button', { name: 'History' }).click()
    const h = page.getByRole('dialog', { name: 'Timetable history' })
    await h.getByText(/Edited “Reading – novel”/).waitFor()
    await h.getByText('Your class teacher, Class Teacher').first().waitFor()
    await page.screenshot({ path: `${SHOTS}/03-student-history.png` })
    await h.getByRole('button', { name: 'Undo' }).click()
    await toast('Change undone.')
    const [{ title }] = await adminSql(`select title from public.tasks k join public.trackers t on t.id = k.tracker_id
                                        where t.user_id = '${W.s1.id}' and k.day_of_week = 1`)
    assert.equal(title, 'Reading')
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser.close()
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
