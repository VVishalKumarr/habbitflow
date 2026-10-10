// Browser tests for Phase 6: the timetable assistant on the dashboard —
// typed commands with confirmation, timetable check, rescheduling with
// before/after and undo, the AI builder (Plus) and its upgrade prompt (Free).
// Without ANTHROPIC_API_KEY the app falls back to its built-in command parser
// and automatic suggestions, which is what these steps exercise.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-ai-timetable.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, cleanup, individual, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/ai-timetable'
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
async function login(username, viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.waitForURL(/\/dashboard/)
}
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}
const panel = () => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Timetable assistant' }) })
async function command(text) {
  await panel().getByRole('textbox', { name: 'Command' }).fill(text)
  await panel().getByRole('button', { name: 'Send command' }).click()
}
const today = new Date().getDay()
const tomorrow = (today + 1) % 7
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

console.log('AI timetable e2e')
try {
  const ana = `ana_${suffix}`
  const a = await individual(ana)
  // A timetable with something today, in 16:00–17:00 and 17:00–18:00.
  await one(a.c.rpc('apply_timetable_change', {
    p_tracker: null, p_new_name: 'School week', p_base_version: null, p_source: 'ai_generate', p_summary: 'seed',
    p_ops: [
      { op: 'add_slot', ref: 'a', start: '16:00', end: '17:00' },
      { op: 'add_slot', ref: 'b', start: '17:00', end: '18:00' },
      { op: 'add_task', slot_ref: 'a', day: today, title: 'Reading', category: 'personal', description: null },
      { op: 'add_task', slot_ref: 'b', day: today, title: 'Physics practice', category: 'study', description: null },
    ],
  }))

  await step('a Free student sees the assistant; the AI builder offers an upgrade', async () => {
    await login(ana)
    await panel().waitFor()
    await panel().getByRole('button', { name: 'Build with AI' }).click()
    await page.getByRole('dialog').getByText(/AI timetable builder comes with Plus and Pro/).waitFor()
    await page.screenshot({ path: `${SHOTS}/01-upgrade.png` })
    await page.keyboard.press('Escape')
  })

  await step('a typed command is understood and only saved after Confirm', async () => {
    await command('add maths revision tomorrow 6 pm')
    const understood = panel().getByRole('status', { name: 'Understood command' })
    await understood.getByText(`I understood: Add “Maths revision” every ${DAYS[tomorrow]}`).waitFor({ timeout: 20000 })
    await panel().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/02-command-confirm.png` })
    const [{ n: before }] = await adminSql(`select count(*)::int n from public.tasks where user_id = '${a.id}'`)
    assert.equal(before, 2, 'nothing saved before confirming')
    await understood.getByRole('button', { name: 'Confirm' }).click()
    await toast('Done.')
    await understood.waitFor({ state: 'detached' })
    const [{ n }] = await adminSql(`select count(*)::int n from public.tasks where user_id = '${a.id}' and title = 'Maths revision' and day_of_week = ${tomorrow}`)
    assert.equal(n, 1)
  })

  await step('marking a task done and “what’s due” work from the command box', async () => {
    await command('mark reading done')
    await panel().getByText('I understood: Mark “Reading” done for today.').waitFor({ timeout: 20000 })
    await panel().getByRole('button', { name: 'Confirm' }).click()
    await panel().getByRole('status', { name: 'Understood command' }).waitFor({ state: 'detached' })
    await command("what's due today")
    await panel().getByText('Due today:').waitFor({ timeout: 20000 })
    await panel().getByText(/Physics practice/).waitFor()
    assert.equal(await panel().getByText(/: Reading$/).count(), 0, 'finished tasks are not listed')
    await panel().getByRole('button', { name: 'OK' }).click()
  })

  await step('the timetable check shows hours, findings and why there’s no AI advice', async () => {
    await panel().getByRole('button', { name: 'Check my timetable' }).click()
    const d = page.getByRole('dialog', { name: 'Timetable check' })
    await d.getByRole('heading', { name: /Time per week: \d h/ }).waitFor({ timeout: 30000 })
    await d.getByText(/AI suggestions aren’t switched on yet|Advice/).first().waitFor()
    await d.getByRole('heading', { name: 'Each day' }).waitFor()
    await page.screenshot({ path: `${SHOTS}/03-check.png` })
    await d.getByRole('button', { name: 'Close' }).last().click()
  })

  await step('rescheduling shows before/after, saves on confirm, and can be undone from History', async () => {
    await panel().getByRole('button', { name: 'Reschedule' }).click()
    const d = page.getByRole('dialog', { name: 'Reschedule for an event' })
    await d.getByLabel('What’s happening?').fill('Football match')
    await d.getByLabel('Event starts').fill('16:00')
    await d.getByLabel('Event ends').fill('18:00')
    await d.getByRole('button', { name: 'Find new times' }).click()
    await d.getByRole('list', { name: 'Proposed moves' }).waitFor({ timeout: 30000 })
    await d.getByText(/Before: .* 4:00 PM/).first().waitFor()
    await d.getByText(/After: /).first().waitFor()
    await page.screenshot({ path: `${SHOTS}/04-reschedule.png` })
    const [{ v: before }] = await adminSql(`select public.timetable_version(t.id) v from public.trackers t where t.user_id = '${a.id}'`)
    await d.getByRole('button', { name: /Move 2 activities/ }).click()
    await toast(/Moved 2 activities/)
    const [{ n }] = await adminSql(`select count(*)::int n from public.tasks k join public.time_slots s on s.id = k.time_slot_id
                                    where k.user_id = '${a.id}' and k.day_of_week = ${today} and s.start_time < '18:00' and s.end_time > '16:00'`)
    assert.equal(n, 0, 'nothing left during the event')
    await panel().getByRole('button', { name: 'History' }).click()
    const h = page.getByRole('dialog', { name: 'Timetable history' })
    await h.getByText('Moved 2 activities for “Football match”').waitFor()
    await page.screenshot({ path: `${SHOTS}/05-history.png` })
    await h.getByRole('button', { name: 'Undo' }).click()
    await toast('Change undone.')
    await h.getByText('Undid: Moved 2 activities for “Football match”').waitFor()
    const [{ v: after }] = await adminSql(`select public.timetable_version(t.id) v from public.trackers t where t.user_id = '${a.id}'`)
    assert.equal(after, before, 'exactly as before')
    await h.getByRole('button', { name: 'Close' }).last().click()
  })

  await step('a command can start a focus session (after confirming)', async () => {
    await command('start a 30 minute focus session on chemistry')
    await panel().getByText('I understood: Start a 30-minute focus session on “Chemistry”.').waitFor({ timeout: 20000 })
    await panel().getByRole('button', { name: 'Confirm' }).click()
    await page.waitForURL(/\/focus/)
    await page.getByRole('button', { name: /Pause/ }).first().waitFor()
    const timer = await page.evaluate(() => JSON.parse(localStorage.getItem('habitflow-pomodoro') ?? '{}'))
    assert.equal(timer.label, 'Chemistry')
    assert.equal(timer.settings.focus, 30)
    assert.ok(timer.endAt > Date.now())
  })

  await step('a Plus student answers the needs check (prefilled next time)', async () => {
    const bo = `bo_${suffix}`
    const b = await individual(bo)
    await adminSql(`insert into public.subscriptions (user_id, plan, provider, status, started_at, expires_at)
                    values ('${b.id}', 'plus', 'manual', 'active', now(), now() + interval '30 days')`)
    await login(bo)
    await panel().getByRole('button', { name: 'Build with AI' }).click()
    const d = page.getByRole('dialog', { name: 'Build a timetable with AI' })
    await d.getByRole('button', { name: 'Exam preparation' }).click()
    await d.getByLabel('Subjects that need more time').fill('Maths, Chemistry')
    await d.getByRole('button', { name: 'Mon' }).first().click()
    await d.getByLabel('School starts').fill('08:00')
    await d.getByLabel('School ends').fill('14:00')
    await d.getByRole('button', { name: 'Add a commitment' }).click()
    await d.getByLabel('Commitment 1 name').fill('Maths tuition')
    await d.getByRole('group', { name: 'Commitment 1 days' }).getByRole('button', { name: 'Wed' }).click()
    await d.getByLabel('Wake-up time').fill('06:30')
    await d.getByLabel('Sleep time').fill('22:30')
    await d.getByRole('button', { name: 'Evening', exact: true }).click()
    assert.equal(await d.getByRole('button', { name: 'Evening', exact: true }).getAttribute('aria-pressed'), 'true')
    await d.getByRole('button', { name: '2–3 hours' }).click()
    await page.screenshot({ path: `${SHOTS}/06-needs-check.png` })
    await d.getByRole('button', { name: 'Build my timetable' }).click()
    // Without an AI key: a clear message, the answers kept.
    await d.getByText(/isn’t switched on yet|Your proposed timetable/).first().waitFor({ timeout: 90000 })
    const [{ answers }] = await adminSql(`select answers from public.timetable_preferences where user_id = '${b.id}'`)
    assert.equal(answers.wake, '06:30')
    assert.deepEqual(answers.focus_subjects, ['Maths', 'Chemistry'])
    assert.equal(answers.commitments[0].label, 'Maths tuition')
    assert.equal(answers.best_focus, 'Evening')
    assert.deepEqual(answers.goals, ['Exam preparation'])
    await page.keyboard.press('Escape')
    await panel().getByRole('button', { name: 'Build with AI' }).click()
    await page.getByText('Your answers from last time are filled in').waitFor()
    assert.equal(await page.getByLabel('Wake-up time').inputValue(), '06:30')
    await page.keyboard.press('Escape')
  })

  await step('phone layout: the assistant and its dialogs have no horizontal overflow', async () => {
    await login(ana, { width: 390, height: 844 })
    await panel().scrollIntoViewIfNeeded()
    await noOverflow('dashboard')
    await page.screenshot({ path: `${SHOTS}/07-phone.png`, fullPage: true })
    await panel().getByRole('button', { name: 'Reschedule' }).click()
    await page.getByRole('dialog', { name: 'Reschedule for an event' }).getByRole('button', { name: 'Find new times' }).click()
    await page.getByRole('dialog', { name: 'Reschedule for an event' }).getByText(/Before:|Nothing in your timetable/).first().waitFor({ timeout: 30000 })
    await noOverflow('reschedule dialog')
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors.filter((e) => !/status of (429|503)/.test(e)), [])
  })
} finally {
  await browser.close()
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
