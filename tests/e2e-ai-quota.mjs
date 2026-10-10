// Browser tests for Phase 5: students see their AI quotas, a student who
// reaches a limit gets a clear message with the reset time, the principal sets
// school limits, the platform owner sees usage and sets a credit pool.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-ai-quota.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, individual, one, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/ai-quota'
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
async function fresh(viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  // the assistant's 429 is expected in this test
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
}
async function personal(username, viewport) {
  await fresh(viewport)
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.waitForURL(/\/dashboard/)
}
async function institutional(email) {
  await fresh()
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
const aiSection = () => page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI usage' }) })

console.log('AI quota e2e')
try {
  const W = await buildSchool(suffix)
  const kim = `kim_${suffix}`
  const k = await individual(kim)
  const key = (await one(W.owner.c.rpc('platform_generate_codes', { p_kind: 'institution', p_plan: 'pro', p_count: 1, p_duration_days: 365, p_institution: W.instA })))[0].code
  await one(W.principal.c.rpc('activate_institution_license', { p_inst: W.instA, p_code: key }))

  await step('a Free student sees each AI feature’s allowance in Settings', async () => {
    await personal(kim)
    await page.goto(`${BASE}/settings`)
    const s = aiSection()
    await s.getByText('0 of 10 used today').first().waitFor()
    await s.getByText('Not included in your plan').first().waitFor()
    await s.getByRole('link', { name: 'Higher limits with Plus or Pro' }).waitFor()
    await s.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/01-usage.png` })
  })

  await step('at the limit, the assistant explains it and when it resets', async () => {
    await adminSql(`select public.ai_finish((public.ai_begin('${k.id}', 'chat', null, 10) ->> 'usage_id')::uuid, true, 100, 50, null, 'test', null)
                    from generate_series(1, 10)`)
    await page.reload()
    await aiSection().getByText('10 of 10 used today').waitFor()
    await aiSection().getByText(/Limit reached\. Resets in/).waitFor()
    await page.getByRole('button', { name: 'Open AI Assistant' }).click()
    const panel = page.getByRole('dialog', { name: 'AI Assistant' })
    await panel.getByLabel('Ask a question').fill('How do I add a new time slot?')
    await panel.getByRole('button', { name: 'Send' }).click()
    await panel.getByText(/You’ve used all 10 .* requests for this day\. It resets in/).waitFor({ timeout: 15000 })
    await panel.getByText(/Higher limits come with Plus and Pro/).waitFor()
    await page.screenshot({ path: `${SHOTS}/02-assistant-limit.png` })
  })

  await step('a licensed student sees the school’s allowance', async () => {
    await institutional(`s1@${W.DOM_A}`)
    await page.goto(`${BASE}/settings`)
    await aiSection().getByText('0 of 20 used this month').first().waitFor()
    await aiSection().getByText(`Your limits combine your own plan with Test School A ${suffix}’s`).waitFor()
  })

  await step('the principal lowers a limit and can’t exceed the platform’s', async () => {
    await institutional(`head@${W.DOM_A}`)
    await page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('heading', { name: 'AI features' }).waitFor()
    const input = page.getByLabel('Homework and study planning limit per student')
    await input.fill('25')
    await page.getByText('Choose 0 to 20').waitFor()
    await input.fill('5')
    const row = page.locator('li, div').filter({ has: input }).last()
    await row.getByRole('button', { name: 'Save' }).click()
    await toast('Homework and study planning saved.')
    await page.getByRole('heading', { name: 'AI features' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/03-school-ai.png` })
    const [r] = await adminSql(`select max_requests from public.institution_ai_quotas where institution_id = '${W.instA}' and feature = 'study_plan'`)
    assert.equal(r.max_requests, 5)
  })

  await step('the platform owner sees usage and sets a school credit pool', async () => {
    await personal(`owner_${suffix}`)
    await page.goto(`${BASE}/admin`)
    await page.getByRole('tab', { name: 'AI' }).click()
    await page.getByRole('heading', { name: 'This month', exact: true }).waitFor()
    await page.getByText('Cost (estimate)').waitFor()
    await page.getByText(kim).waitFor()
    const inst = page.locator('li, div').filter({ hasText: `Test School A ${suffix}` }).filter({ has: page.getByRole('button', { name: 'Credit pool' }) }).last()
    await inst.getByRole('button', { name: 'Credit pool' }).click()
    const d = page.getByRole('dialog', { name: `Test School A ${suffix}: shared AI credits` })
    await d.getByLabel('Pool').selectOption('on')
    await d.getByLabel('Requests per month').fill('500')
    await d.getByRole('button', { name: 'Save' }).click()
    await toast('Credit pool saved.')
    await page.screenshot({ path: `${SHOTS}/04-admin-ai.png`, fullPage: true })
  })

  await step('phone layout: settings and the AI admin tab have no horizontal overflow', async () => {
    await personal(`owner_${suffix}`, { width: 390, height: 844 })
    await page.goto(`${BASE}/admin`)
    await page.getByRole('tab', { name: 'AI' }).click()
    await page.getByRole('heading', { name: 'Features and limits per plan' }).waitFor()
    await noOverflow('admin ai')
    await page.goto(`${BASE}/settings`)
    await aiSection().getByText('AI help assistant (text)').waitFor()
    await noOverflow('settings')
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors.filter((e) => !/status of 429/.test(e)), [])
  })
} finally {
  await browser.close()
  await adminSql(`delete from public.license_codes where institution_id in (select id from public.institutions where name like '%${suffix}')`).catch(() => {})
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
