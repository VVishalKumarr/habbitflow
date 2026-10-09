// End-to-end tests for institutions (Phase 1): platform owner console,
// invitation + activation, principal setup, teacher assignments, deadline
// calendar, student view, audit, and phone layouts.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-institution.mjs
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const REF = new globalThis.URL(URL).hostname.split('.')[0]
const SHOTS = 'screenshots/institution'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)
const DOM = `e2e${suffix}.example.edu`
const PASS = 'school-pass-1'
const INST = `Riverside School ${suffix}`

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

async function adminSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`admin sql ${r.status}: ${await r.text()}`)
  return r.json()
}

async function activateViaApi(link) {
  const token = new globalThis.URL(link).searchParams.get('token')
  const r = await fetch(`${URL}/functions/v1/institution-activate`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'activate', token, password: PASS }),
  })
  assert.equal(r.status, 200, await r.text())
}

const browser = await chromium.launch()
const errors = []
let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
let page = await ctx.newPage()
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
}
watch(page)
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 10000 })
const dialog = (name) => page.getByRole('dialog', { name })
const schoolNav = (name) => page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name, exact: true })

async function newSession(viewport = { width: 1440, height: 900 }) {
  await ctx.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  watch(page)
}
async function schoolLogin(email) {
  await page.goto(`${BASE}/login/institution`)
  await page.getByLabel('Institutional email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/school$/, { timeout: 15000 })
}
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}
/** Reads the one-time link shown when invitation email isn't configured. */
async function shownLink() {
  const code = page.locator('code').filter({ hasText: '/activate?token=' }).first()
  await code.waitFor({ timeout: 15000 })
  return (await code.textContent()).trim()
}

// ---- setup: an individual account that is platform owner ----
const owner = `owner_${suffix}`
{
  const c = createClient(URL, KEY, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signUp({ email: `${owner}@habitflow.local`, password: PASS, options: { data: { username: owner } } })
  if (error) throw error
  await adminSql(`insert into public.platform_admins (user_id, note) values ('${data.user.id}', 'e2e ${suffix}')`)
}

console.log('Institution e2e')
let principalLink, teacherLink, studentLink

try {
  await step('personal login offers the institution tab; institution login rejects usernames', async () => {
    await page.goto(`${BASE}/login`)
    await page.getByRole('tab', { name: 'Institution' }).click()
    await page.waitForURL(/\/login\/institution$/)
    await page.getByLabel('Institutional email').fill('someone@habitflow.local')
    await page.getByLabel('Password', { exact: true }).fill('whatever-123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Use the personal account login for usernames.').waitFor()
    await page.screenshot({ path: `${SHOTS}/01-institution-login.png` })
  })

  await step('platform owner creates an institution, approves addresses and invites the principal', async () => {
    await page.goto(`${BASE}/login`)
    await page.getByLabel('Username').fill(owner)
    await page.getByLabel('Password', { exact: true }).fill(PASS)
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.waitForURL(/\/dashboard/)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Platform admin' }).click()
    await page.getByRole('button', { name: 'New institution' }).click()
    await dialog('New institution').getByLabel('Name', { exact: true }).fill(INST)
    await dialog('New institution').getByRole('button', { name: 'Create' }).click()
    await page.getByRole('heading', { name: INST }).waitFor()
    await page.getByLabel('Email address or domain').fill(DOM)
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByText(`@${DOM}`).waitFor()
    await page.getByLabel('Email address or domain').fill(`principal@${DOM}`)
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByText(`principal@${DOM}`).first().waitFor()
    await page.getByLabel('Email address or domain').fill('gmail.com')
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByText(/Public email providers/).first().waitFor()
    await page.getByRole('button', { name: 'Invite principal / director' }).click()
    const d = dialog('Invite principal or director')
    await d.getByLabel('Full name').fill('Asha Rao')
    await d.getByLabel('Email').fill(`principal@${DOM}`)
    await d.getByRole('button', { name: 'Invite' }).click()
    principalLink = await shownLink()
    await page.screenshot({ path: `${SHOTS}/02-platform-admin.png`, fullPage: true })
    await d.getByRole('button', { name: 'Done' }).click()
  })

  await step('principal activates from the link and lands on the institution overview', async () => {
    await newSession()
    const token = new globalThis.URL(principalLink).searchParams.get('token')
    await page.goto(`${BASE}/activate?token=${token}`)
    await page.getByText(`invited Asha Rao as Principal`).waitFor()
    await page.getByLabel('Choose a password').fill(PASS)
    await page.getByLabel('Confirm password').fill(PASS)
    await page.getByRole('button', { name: 'Activate account' }).click()
    await page.waitForURL(/\/school$/, { timeout: 20000 })
    await page.getByRole('heading', { name: 'Institution overview' }).waitFor()
    await page.getByRole('link', { name: 'Audit history' }).waitFor()
    await page.screenshot({ path: `${SHOTS}/03-principal-overview.png`, fullPage: true })
    // the same link can't be used twice
    const p2 = await ctx.newPage()
    await p2.goto(`${BASE}/activate?token=${token}`)
    await p2.getByText(/already been used|invalid/).first().waitFor({ timeout: 15000 }).catch(async (e) => {
      await p2.screenshot({ path: `${SHOTS}/reuse-link.png` })
      throw e
    })
    await p2.close()
  })

  await step('principal sets up the year, subjects and a class', async () => {
    await schoolNav('Settings').click()
    await page.getByLabel('New academic year').fill('2026–27')
    await page.locator('form').filter({ hasText: 'New academic year' }).getByLabel('Starts').fill('2026-04-01')
    await page.locator('form').filter({ hasText: 'New academic year' }).getByLabel('Ends').fill('2027-03-31')
    await page.getByRole('button', { name: 'Add year' }).click()
    await toast('Academic year added.')
    await schoolNav('Classes & subjects').click()
    for (const sub of ['Mathematics', 'Science']) {
      await page.getByLabel('New subject').fill(sub)
      await page.getByRole('button', { name: 'Add subject' }).click()
      await page.getByText(sub, { exact: true }).waitFor()
    }
    await page.getByRole('button', { name: 'New class' }).click()
    await dialog('New class').getByLabel('Grade / year').fill('10')
    await dialog('New class').getByLabel('Section').fill('A')
    await dialog('New class').getByRole('button', { name: 'Create' }).click()
    await toast('Class created.')
    await page.getByRole('button', { name: /10 A/ }).waitFor()
  })

  await step('principal invites a teacher and a student; unapproved addresses are refused', async () => {
    await schoolNav('People').click()
    await page.getByRole('button', { name: 'Invite' }).click()
    let d = dialog('Invite someone')
    await d.getByLabel('Full name').fill('Ravi Teacher')
    await d.getByLabel('Institutional email').fill('ravi@not-approved.example.com')
    await d.getByLabel('Role').selectOption('subject_teacher')
    await d.getByRole('button', { name: 'Send invitation' }).click()
    await d.getByText(/approved list/).waitFor()
    await d.getByLabel('Institutional email').fill(`ravi@${DOM}`)
    await d.getByRole('button', { name: 'Send invitation' }).click()
    teacherLink = await shownLink()
    await dialog('Invitation created').getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Invite' }).click()
    d = dialog('Invite someone')
    await d.getByLabel('Full name').fill('Meera Student')
    await d.getByLabel('Institutional email').fill(`meera@${DOM}`)
    await d.getByLabel('Role').selectOption('student')
    await d.getByRole('button', { name: 'Send invitation' }).click()
    studentLink = await shownLink()
    await dialog('Invitation created').getByRole('button', { name: 'Done' }).click()
    await activateViaApi(teacherLink)
    await activateViaApi(studentLink)
    await page.reload()
    await page.getByText('Ravi Teacher').waitFor()
    await page.getByRole('tab', { name: /Invitations/ }).click()
    await page.getByText('Activated').first().waitFor()
    await page.screenshot({ path: `${SHOTS}/04-people.png`, fullPage: true })
  })

  await step('principal assigns the teacher and enrols the student', async () => {
    await schoolNav('Classes & subjects').click()
    await page.getByRole('button', { name: /10 A/ }).click()
    await page.getByLabel('Subject', { exact: true }).selectOption({ label: 'Mathematics' })
    await page.getByLabel('Teacher', { exact: true }).selectOption({ label: 'Ravi Teacher' })
    await page.getByRole('button', { name: 'Assign' }).click()
    await page.getByText('Mathematics · Ravi Teacher').waitFor()
    await page.getByLabel('Student to enrol').selectOption({ label: 'Meera Student' })
    await page.getByRole('button', { name: 'Enrol' }).click()
    await page.getByRole('heading', { name: 'Students (1)' }).waitFor()
    await page.screenshot({ path: `${SHOTS}/05-classes.png`, fullPage: true })
  })

  await step('principal schedules an exam that clashes with homework', async () => {
    await schoolNav('Calendar').click()
    await page.getByRole('button', { name: 'Add event' }).click()
    const d = dialog('Add event')
    await d.getByLabel('Title').fill('Maths unit test')
    const t = new Date(Date.now() + 5 * 86400000)
    const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    await d.getByLabel('Starts').fill(day)
    await d.getByLabel('Ends').fill(day)
    await d.getByLabel('Applies to').selectOption({ label: 'Grade 10' })
    await d.getByRole('button', { name: 'Save' }).click()
    await toast('Event added.')
  })

  await step('teacher signs in, sees only their class, and creates assignments (window rule enforced)', async () => {
    await newSession()
    await schoolLogin(`ravi@${DOM}`)
    await page.getByRole('heading', { name: 'Your teaching at a glance' }).waitFor()
    await schoolNav('Assignments').click()
    await page.getByRole('button', { name: 'New assignment' }).click()
    const d = dialog('New assignment')
    await d.getByLabel('Title').fill('Too long')
    const local = (offsetDays, h = 18) => {
      const t = new Date(Date.now() + offsetDays * 86400000)
      t.setHours(h, 0, 0, 0)
      const pad = (n) => String(n).padStart(2, '0')
      return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
    }
    await d.getByLabel('Submission opens').fill(local(0, 8))
    await d.getByLabel('Deadline').fill(local(45))
    await d.getByRole('button', { name: 'Create' }).click()
    await d.getByText(/longer than one calendar month/).waitFor()
    for (const title of ['Algebra worksheet', 'Geometry proofs', 'Statistics survey']) {
      if (title !== 'Algebra worksheet') {
        await page.getByRole('button', { name: 'New assignment' }).click()
      }
      const dd = dialog('New assignment')
      await dd.getByLabel('Title').fill(title)
      await dd.getByLabel('Submission opens').fill(local(0, 8))
      await dd.getByLabel('Deadline').fill(local(5))
      await dd.getByRole('button', { name: 'Create' }).click()
      await toast('Assignment created.')
    }
    await page.getByText('Statistics survey').waitFor()
    await page.screenshot({ path: `${SHOTS}/06-teacher-assignments.png`, fullPage: true })
    // teachers can't see the audit log or settings
    assert.equal(await page.getByRole('link', { name: 'Audit history' }).count(), 0)
  })

  await step('deadline calendar flags the heavy day and the exam clash', async () => {
    await schoolNav('Calendar').click()
    await page.getByRole('tab', { name: 'Cross-subject deadlines' }).click()
    await page.getByText('Heavy day').first().waitFor()
    await page.getByText('Deadline on exam day').first().waitFor()
    await page.screenshot({ path: `${SHOTS}/07-deadlines.png`, fullPage: true })
  })

  await step('student sees their assignments and calendar, but no admin areas', async () => {
    await newSession()
    await schoolLogin(`meera@${DOM}`)
    await page.getByRole('heading', { name: 'Your school week' }).waitFor()
    for (const name of ['People', 'Classes & subjects', 'Settings', 'Audit history']) {
      assert.equal(await page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name }).count(), 0, name)
    }
    await schoolNav('Assignments').click()
    await page.getByText('Geometry proofs').waitFor()
    await page.screenshot({ path: `${SHOTS}/08-student.png`, fullPage: true })
    // the personal timetable still works for institutional accounts
    await page.getByRole('link', { name: 'Timetable' }).first().click()
    await page.waitForURL(/\/dashboard/)
  })

  await step('phone layout: school pages have no horizontal overflow', async () => {
    await newSession({ width: 390, height: 844 })
    await schoolLogin(`principal@${DOM}`)
    for (const path of ['/school', '/school/calendar', '/school/calendar?view=deadlines', '/school/assignments', '/school/people', '/school/classes', '/school/settings', '/school/audit']) {
      await page.goto(`${BASE}${path}`)
      await page.locator('h1').first().waitFor()
      await page.waitForTimeout(400)
      await noOverflow(path)
    }
    await page.goto(`${BASE}/school/calendar`)
    await page.getByRole('button', { name: 'Today' }).waitFor()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/09-phone-calendar.png`, fullPage: true })
    await page.goto(`${BASE}/school/settings`)
    await page.getByRole('heading', { name: 'Role permissions' }).waitFor()
    await page.screenshot({ path: `${SHOTS}/10-phone-settings.png`, fullPage: true })
  })

  await step('audit history lists the changes', async () => {
    await page.goto(`${BASE}/school/audit`)
    await page.locator('li').getByText('Assignment', { exact: true }).first().waitFor()
    await page.locator('li').getByText('Calendar event', { exact: true }).first().waitFor()
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser.close()
  await adminSql(`
    delete from public.institutions where name = '${INST}';
    delete from public.audit_log where institution_id is not null and not exists (select 1 from public.institutions i where i.id = audit_log.institution_id);
    delete from public.audit_log where record_type in ('platform_admins', 'institutions') and (new_value ->> 'note' like '%${suffix}%' or new_value ->> 'name' = '${INST}' or old_value ->> 'name' = '${INST}');
    delete from auth.users where email like '%${suffix}%';
  `).catch((e) => console.error('cleanup failed', e.message))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
