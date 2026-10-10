// Browser tests for Phase 7: CSV import with preview, programmes (create,
// join, check in), development reports (student and class), PDF and CSV
// downloads, development weights and the academic-year transition.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-reports.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/reports'
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
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 20000 })
async function institutional(email, viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport, acceptDownloads: true })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
  await page.goto(`${BASE}/login/institution`)
  await page.getByLabel('Institutional email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/school$/, { timeout: 20000 })
}
const nav = (name) => page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name, exact: true })
const csvFile = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}

console.log('Reports e2e')
try {
  const W = await buildSchool(suffix)
  const { instA, class10a, maths, subjT, s1, DOM_A } = W
  await adminSql(`
    insert into public.academic_years (institution_id, name, starts_on, ends_on, is_current) values ('${instA}', '2026–27', '2026-04-01', '2027-03-31', true);
    update public.classes set academic_year_id = (select id from public.academic_years where institution_id = '${instA}') where institution_id = '${instA}';
    insert into public.attendance_records (institution_id, class_id, session_date, period, student_id, status)
    select '${instA}', '${class10a}', current_date - g, 0, '${s1.membership}', case when g % 6 = 0 then 'absent' else 'present' end from generate_series(1, 15) g;
    insert into public.assessments (institution_id, class_id, subject_id, teacher_id, title, kind, max_marks, assessment_date, status, published_at)
    values ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Unit 1', 'internal', 50, current_date - 9, 'published', now()),
           ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Unit 2', 'internal', 50, current_date - 4, 'published', now());
    insert into public.marks (institution_id, assessment_id, student_id, obtained)
    select a.institution_id, a.id, '${s1.membership}', 38 from public.assessments a where a.class_id = '${class10a}';
  `)

  await step('the principal imports students from CSV: preview with row errors, then import', async () => {
    await institutional(`head@${DOM_A}`)
    await nav('Import').click()
    await page.getByRole('heading', { name: 'Import from CSV' }).waitFor()
    await page.getByLabel('CSV file').setInputFiles(csvFile('students.csv',
      `Name,Email,Admission no,Class,Role\nNew Student,new.student@${DOM_A},A-501,10 A,principal\nBroken,not-an-email,,,\nStudent Two,s2@${DOM_A},,10 A,\n`))
    await page.getByRole('status', { name: 'Summary' }).getByText('2 ready').waitFor({ timeout: 20000 })
    await page.getByText('1 error').waitFor()
    await page.getByText('The file’s Role column is ignored').waitFor()
    await page.getByText('Invalid email address.').waitFor()
    await page.screenshot({ path: `${SHOTS}/01-import-preview.png`, fullPage: true })
    await page.getByRole('button', { name: 'Import 2 rows' }).click()
    await page.getByText('Result:').waitFor({ timeout: 30000 })
    await page.getByText('Invited', { exact: true }).waitFor()
    await page.getByText('Enrolled', { exact: true }).waitFor()
    const dl = page.waitForEvent('download')
    await page.getByRole('button', { name: /Activation links \(1\)/ }).click()
    const file = readFileSync(await (await dl).path(), 'utf8')
    assert.match(file, /new\.student@/)
    const [inv] = await adminSql(`select role, class_id from public.institution_invitations where email = 'new.student@${DOM_A}'`)
    assert.deepEqual(inv, { role: 'student', class_id: class10a })
    await page.getByText('Recent imports').waitFor()
  })

  await step('…and classes, with existing ones skipped', async () => {
    await page.getByRole('tab', { name: 'Classes' }).click()
    await page.getByLabel('CSV file').setInputFiles(csvFile('classes.csv', `Name,Grade,Section,Class teacher\n9 A,9,A,ct@${DOM_A}\n10 A,10,A,\n`))
    await page.getByRole('status', { name: 'Summary' }).getByText('1 ready').waitFor({ timeout: 20000 })
    await page.getByText('A class with this name already exists.').waitFor()
    await page.getByRole('button', { name: 'Import 1 row' }).click()
    await page.getByRole('status', { name: 'Summary' }).getByText('1 done').waitFor({ timeout: 20000 })
  })

  await step('a class teacher creates a programme for their class; a student joins and checks in', async () => {
    await institutional(`ct@${DOM_A}`)
    await nav('Programmes').click()
    await page.getByRole('button', { name: 'New programme' }).click()
    const d = page.getByRole('dialog', { name: 'New programme' })
    await d.getByLabel('Title').fill('Daily reading')
    await d.getByLabel('Open to').selectOption({ label: '10 A' })
    await d.getByLabel('Check-ins per week').selectOption('5')
    await d.getByRole('button', { name: 'Save' }).click()
    await toast('Programme created.')
    await institutional(`s1@${DOM_A}`)
    await nav('Programmes').click()
    const card = page.getByRole('region', { name: 'Daily reading' })
    await card.getByRole('button', { name: 'Join' }).click()
    await toast('You joined Daily reading.')
    await card.getByRole('button', { name: 'Check in today' }).click()
    await toast('Checked in for today.')
    await card.getByText('This week: 1 of 5').waitFor()
    await page.screenshot({ path: `${SHOTS}/02-programmes-student.png` })
  })

  await step('the student opens their development report and chooses to share habits', async () => {
    await nav('Overview').click()
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your development' }) })
    await card.getByRole('button', { name: 'Open my report' }).click()
    const d = page.getByRole('dialog', { name: 'Development: Student One' })
    await d.getByRole('button', { name: 'Calculate' }).click()
    await d.getByRole('list', { name: 'Score components' }).waitFor({ timeout: 20000 })
    await d.getByText('Academic results').waitFor()
    await d.getByText('Not shared — the student hasn’t chosen').waitFor()
    await d.getByText('How to improve').waitFor()
    await page.screenshot({ path: `${SHOTS}/03-student-report.png` })
    const dl = page.waitForEvent('download')
    await d.getByRole('button', { name: 'Download PDF' }).click()
    assert.match((await dl).suggestedFilename(), /^development-Student_One-.*\.pdf$/)
    await (await dl).saveAs(`${SHOTS}/student-report.pdf`)
    await d.getByRole('button', { name: 'Close dialog' }).click()
    await card.getByLabel(/Share my habit consistency/).check()
    await toast('Your habit consistency now counts')
    const [p] = await adminSql(`select share_habits_with_school s from public.profiles where id = '${s1.id}'`)
    assert.equal(p.s, true)
  })

  await step('the class teacher sees the class report, calculates scores, downloads PDF and CSV', async () => {
    await institutional(`ct@${DOM_A}`)
    await nav('Reports').click()
    await page.getByRole('heading', { name: 'Class report' }).waitFor()
    await page.getByLabel('Class', { exact: true }).first().selectOption({ label: '10 A' })
    await page.getByRole('row').filter({ hasText: 'Student One' }).waitFor()
    await page.getByRole('button', { name: 'Calculate scores' }).click()
    await toast(/Calculated \d+ student/)
    const row = page.getByRole('row').filter({ hasText: 'Student One' })
    await row.getByText(/^\d+\.\d$/).waitFor()
    await page.screenshot({ path: `${SHOTS}/04-class-report.png`, fullPage: true })
    let dl = page.waitForEvent('download')
    await page.getByRole('button', { name: 'PDF', exact: true }).click()
    assert.match((await dl).suggestedFilename(), /^class-report-10_A\.pdf$/)
    await (await dl).saveAs(`${SHOTS}/class-report.pdf`)
    await page.getByLabel('Data').selectOption('attendance')
    dl = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download CSV' }).click()
    const csv = readFileSync(await (await dl).path(), 'utf8')
    assert.match(csv, /"Date","Class","Subject"/)
    assert.equal(csv.trim().split('\r\n').length, 16, 'header + 15 records')
    await toast('Exported 15 rows.')
    await row.getByRole('button', { name: 'Student One' }).click()
    await page.getByRole('dialog', { name: 'Development: Student One' }).getByRole('list', { name: 'Score components' }).waitFor()
  })

  await step('the principal sets development weights and starts the next academic year', async () => {
    await institutional(`head@${DOM_A}`)
    await nav('Settings').click()
    await page.getByRole('heading', { name: 'Development score weights' }).waitFor()
    await page.getByLabel('Academic results (%)').fill('45')
    await page.getByText('Total: 110% — must be 100%').waitFor()
    await page.getByLabel('Extracurricular & skills (%)').fill('5')
    await page.getByRole('button', { name: 'Save weights' }).click()
    await toast('Weights saved.')
    await page.getByRole('button', { name: 'Start next academic year' }).click()
    const d = page.getByRole('dialog', { name: 'Start the next academic year' })
    assert.equal(await d.getByLabel('New year').inputValue(), '2027–28')
    assert.equal(await d.getByLabel('9 A new class name').inputValue(), '10 A')
    assert.equal(await d.getByLabel('What happens to 10 A').inputValue(), 'graduate', 'top grade graduates by default')
    await d.getByLabel('What happens to 10 A').selectOption('promote')
    await d.getByLabel('10 A new class name').fill('11 A')
    await page.screenshot({ path: `${SHOTS}/05-year-transition.png` })
    await d.getByRole('button', { name: 'Start new year' }).click()
    await d.getByText('Tick the confirmation box first.').waitFor()
    await d.getByLabel(/I understand/).check()
    await d.getByRole('button', { name: 'Start new year' }).click()
    await toast(/2027–28 started/)
    const [c] = await adminSql(`select count(*)::int n from public.classes where institution_id = '${instA}' and name = '11 A' and not archived`)
    assert.equal(c.n, 1)
  })

  await step('phone layout: reports, import and programmes have no horizontal overflow', async () => {
    await institutional(`ct@${DOM_A}`, { width: 390, height: 844 })
    for (const p of ['reports', 'programmes']) {
      await page.goto(`${BASE}/school/${p}`)
      await page.getByRole('heading', { level: 1 }).waitFor()
      await page.waitForTimeout(800)
      await noOverflow(p)
    }
    await institutional(`head@${DOM_A}`, { width: 390, height: 844 })
    await page.goto(`${BASE}/school/import`)
    await page.getByRole('heading', { name: 'Import from CSV' }).waitFor()
    await noOverflow('import')
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
