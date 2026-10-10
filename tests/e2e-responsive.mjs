// Phase 9 responsive pass: every page, for every role, at phone (390),
// tablet (768) and desktop (1440) widths. Fails on horizontal overflow (and
// names the elements sticking out) or browser errors. Phone screenshots go
// to screenshots/responsive/ for review.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-responsive.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, day, fn, individual, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/responsive'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)
const WIDTHS = [[390, 844], [768, 1024], [1440, 900]]

const problems = []
const errors = []
let checked = 0

async function overflow(page) {
  return page.evaluate(() => {
    const iw = window.innerWidth
    if (document.documentElement.scrollWidth <= iw) return null
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width && r.right > iw + 1 && getComputedStyle(el).position !== 'fixed') {
        // skip children of an element already reported or of horizontal scrollers
        let p = el.parentElement
        let scroller = false
        while (p) {
          const s = getComputedStyle(p)
          if (/(auto|scroll|hidden)/.test(s.overflowX) && p !== document.body && p !== document.documentElement) { scroller = true; break }
          p = p.parentElement
        }
        if (scroller) continue
        out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].slice(0, 3).join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}" right=${Math.round(r.right)}`)
        if (out.length >= 3) break
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, iw, out }
  })
}

async function crawl(browser, label, login, routes) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(label)) return
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${label}: pageerror ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text()) && errors.push(`${label}: ${m.text().slice(0, 160)}`))
  if (login) await login(page)
  for (const route of routes) {
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h })
      await page.goto(`${BASE}${route}`)
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(400)
      const o = await overflow(page)
      checked++
      if (o) problems.push(`${label} ${route} @${w}: ${o.scrollWidth} > ${o.iw} — ${o.out.join(' ; ')}`)
      if (w === 390) await page.screenshot({ path: `${SHOTS}/${label}${route.replace(/\//g, '_') || '_home'}.png`, fullPage: true })
    }
  }
  await ctx.close()
}

const institutional = (email) => async (page) => {
  await page.goto(`${BASE}/login/institution`)
  await page.getByLabel('Institutional email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/school$/, { timeout: 20000 })
}
const personal = (username) => async (page) => {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
}

console.log('Responsive pass')
const browser = await chromium.launch()
try {
  // ---- realistic data ----
  const W = await buildSchool(suffix)
  const { instA, class10a, maths, science, subjT, classT, s1, owner, DOM_A } = W
  await adminSql(`
    insert into public.academic_years (institution_id, name, starts_on, ends_on, is_current) values ('${instA}', '2026–27', '2026-04-01', '2027-03-31', true);
    insert into public.class_periods (institution_id, class_id, day_of_week, start_time, end_time, subject_id, label)
    select '${instA}', '${class10a}', d, t, t + interval '45 minutes', case when t < '10:00' then '${maths}'::uuid else '${science}'::uuid end, null
      from generate_series(1, 5) d, (values (time '08:00'), (time '09:00'), (time '10:00')) x(t);
    insert into public.assignments (institution_id, class_id, subject_id, teacher_id, title, opens_at, due_at)
    select '${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Chapter ' || g || ': a fairly long assignment title for wrapping checks', now() - interval '3 days', now() + (g || ' days')::interval
      from generate_series(1, 4) g;
    insert into public.attendance_records (institution_id, class_id, session_date, period, student_id, status)
    select '${instA}', '${class10a}', current_date - g, 0, '${s1.membership}', case when g % 5 = 0 then 'absent' else 'present' end from generate_series(1, 12) g;
    insert into public.assessments (institution_id, class_id, subject_id, teacher_id, title, kind, max_marks, assessment_date, status, published_at)
    values ('${instA}', '${class10a}', '${maths}', '${subjT.membership}', 'Unit test 1', 'internal', 50, current_date - 6, 'published', now());
    insert into public.marks (institution_id, assessment_id, student_id, obtained)
    select a.institution_id, a.id, '${s1.membership}', 41 from public.assessments a where a.class_id = '${class10a}';
    insert into public.calendar_events (institution_id, kind, title, starts_on, ends_on, class_id)
    values ('${instA}', 'exam', 'Half-yearly mathematics examination', current_date + 5, current_date + 5, '${class10a}');
  `)
  await one(classT.c.from('development_programmes').insert({ institution_id: instA, title: 'Daily reading for twenty minutes', class_id: class10a }).select('id'))
  await one(s1.c.rpc('calculate_development_score', { p_student: s1.membership }))
  await one(classT.c.rpc('post_announcement', { p_inst: instA, p_audience: 'everyone', p_title: 'Sports day on Friday', p_body: 'Wear house colours.', p_class: class10a, p_grade: null })).catch(() => {})
  // a parent
  const PARENT = `parent${suffix}@gmail-test.example.com`
  const linkId = await one(s1.c.rpc('request_guardian_link', { p_inst: instA, p_email: PARENT, p_name: 'Priya Parent', p_relationship: 'mother' }))
  const ok = await fn('institution-invite', { action: 'approve_guardian', link_id: linkId }, classT.c)
  const token = new URL(ok.body.activation_link).searchParams.get('token')
  await fn('institution-activate', { action: 'activate', token, password: PASS })
  // a personal user with a timetable
  const kim = `resp_${suffix}`
  const k = await individual(kim)
  await one(k.c.rpc('apply_timetable_change', {
    p_tracker: null, p_new_name: 'Exam preparation timetable', p_base_version: null, p_source: 'voice', p_summary: 'seed',
    p_ops: [
      { op: 'add_slot', ref: 'a', start: '06:30', end: '07:30' }, { op: 'add_slot', ref: 'b', start: '17:00', end: '18:30' },
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ op: 'add_task', slot_ref: d % 2 ? 'a' : 'b', day: d, title: 'Revision: quadratic equations and graphs', category: 'study', description: null })),
    ],
  }))

  const school = ['/school', '/school/calendar', '/school/assignments', '/school/attendance', '/school/marks', '/school/announcements', '/school/messages',
    '/school/people', '/school/classes', '/school/guardians', '/school/reports', '/school/programmes']
  await crawl(browser, 'public', null, ['/', '/login', '/register', '/login/institution', '/forgot-password', '/pro', '/help', '/help/timetable-assistant', '/privacy', '/terms'])
  await crawl(browser, 'personal', personal(kim), ['/dashboard', '/progress', '/focus', '/friends', '/settings', '/pro', '/goals'])
  await crawl(browser, 'owner', personal(`owner_${suffix}`), ['/admin'])
  await crawl(browser, 'principal', institutional(`head@${DOM_A}`), [...school, '/school/settings', '/school/audit', '/school/import'])
  await crawl(browser, 'coordinator', institutional(`coord@${DOM_A}`), school)
  await crawl(browser, 'classteacher', institutional(`ct@${DOM_A}`), [...school, '/dashboard', '/settings'])
  await crawl(browser, 'subjectteacher', institutional(`st@${DOM_A}`), ['/school', '/school/assignments', '/school/attendance', '/school/marks', '/school/classes'])
  await crawl(browser, 'student', institutional(`s1@${DOM_A}`), ['/school', '/school/calendar', '/school/assignments', '/school/attendance', '/school/marks',
    '/school/announcements', '/school/goals', '/school/programmes', '/dashboard', '/progress', '/settings'])
  await crawl(browser, 'parent', institutional(PARENT), ['/school', '/school/calendar', '/school/announcements', '/school/messages', '/settings'])
  void owner
} finally {
  await browser.close()
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`  ${checked} page × width checks`)
for (const p of problems) console.log(`  ✗ overflow: ${p}`)
for (const e of [...new Set(errors)]) console.log(`  ✗ error: ${e}`)
if (!problems.length && !errors.length) console.log('  ✓ no horizontal overflow and no browser errors')
assert.ok(true)
if (problems.length || errors.length) process.exitCode = 1
