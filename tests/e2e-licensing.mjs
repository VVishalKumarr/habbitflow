// Browser tests for Phase 4: platform owner generates gift codes and an
// institution licence key, an individual redeems a code, a principal activates
// the licence, a student is covered, the owner revokes it.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-licensing.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, individual, PASS } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/licensing'
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
async function fresh(viewport = { width: 1440, height: 900 }) {
  await ctx?.close()
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
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
async function adminTab(name) {
  await page.goto(`${BASE}/admin`)
  await page.getByRole('tab', { name }).click()
}
async function noOverflow(label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  assert.ok(sw <= iw, `${label}: horizontal overflow ${sw} > ${iw}`)
}

console.log('Licensing e2e')
let gifts, licenceKey
try {
  const W = await buildSchool(suffix)
  const owner = `owner_${suffix}`
  const gina = `gina_${suffix}`
  await individual(gina)

  await step('platform owner generates two Plus gift codes and sees them once', async () => {
    await personal(owner)
    await adminTab('Codes')
    await page.getByRole('button', { name: 'Generate codes' }).click()
    const d = dialog('Generate codes')
    await d.getByLabel('Plan').selectOption({ label: 'Plus' })
    await d.getByLabel('Access length (days)').fill('30')
    await d.getByLabel('How many codes').fill('2')
    await d.getByLabel('Note (optional)').fill(`e2e ${suffix}`)
    await d.getByRole('button', { name: 'Generate' }).click()
    const shown = dialog('2 codes generated')
    gifts = (await shown.getByLabel('Generated codes').innerText()).trim().split('\n')
    assert.equal(gifts.length, 2)
    for (const g of gifts) assert.match(g, /^HFG-/)
    await page.screenshot({ path: `${SHOTS}/01-codes-generated.png`, fullPage: true })
    await shown.getByRole('button', { name: 'Done' }).click()
    await page.getByText(`e2e ${suffix}`).first().waitFor()
  })

  await step('platform owner generates an institution licence key for School A', async () => {
    await page.getByRole('button', { name: 'Generate codes' }).click()
    const d = dialog('Generate codes')
    await d.getByLabel('Type').selectOption({ label: 'Institution licence' })
    await d.getByLabel('Plan').selectOption({ label: 'Pro' })
    await d.getByLabel('Institution').selectOption({ label: `Test School A ${suffix}` })
    await d.getByText('1 year', { exact: true }).waitFor()
    await d.getByRole('button', { name: 'Generate' }).click()
    licenceKey = (await dialog('1 code generated').getByLabel('Generated codes').innerText()).trim()
    assert.match(licenceKey, /^HFI-/)
    await dialog('1 code generated').getByRole('button', { name: 'Done' }).click()
  })

  await step('pricing page advertises the AI timetable builder (shipped in Phase 6)', async () => {
    await page.goto(`${BASE}/pro`)
    await page.getByText('Everything in Free, plus:').first().waitFor()
    await page.getByText('AI timetable that asks your needs first').first().waitFor()
    await page.getByText('Up to 3 friends').first().waitFor()
  })

  await step('an individual redeems a gift code in Settings and gets Plus', async () => {
    await personal(gina)
    await page.goto(`${BASE}/settings`)
    await page.getByRole('button', { name: 'Redeem a code' }).click()
    const d = dialog('Redeem a code')
    await d.getByLabel('Code').fill(gifts[0].toLowerCase())
    await d.getByRole('button', { name: 'Redeem' }).click()
    await toast('Plus is active until')
    await page.getByText(/^Ends on /).waitFor()
    await page.screenshot({ path: `${SHOTS}/02-redeemed.png`, fullPage: true })
  })

  await step('the same code can’t be redeemed twice; a bad code gets a clear message', async () => {
    await page.getByRole('button', { name: 'Redeem a code' }).click()
    const d = dialog('Redeem a code')
    await d.getByLabel('Code').fill(gifts[0])
    await d.getByRole('button', { name: 'Redeem' }).click()
    await d.getByText('already been used').waitFor()
    await d.getByLabel('Code').fill('HFG-2222-3333-4444-5555')
    await d.getByRole('button', { name: 'Redeem' }).click()
    await d.getByText('That code isn’t valid').waitFor()
    await d.getByRole('button', { name: 'Cancel' }).click()
  })

  await step('principal activates the institution licence in School → Settings', async () => {
    await institutional(`head@${W.DOM_A}`)
    await page.getByRole('navigation', { name: 'Institution' }).getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('heading', { name: 'Licence' }).waitFor()
    await page.getByText('No licence', { exact: true }).waitFor()
    await page.getByLabel('Licence key').fill(licenceKey)
    await page.getByRole('button', { name: 'Activate' }).click()
    await toast('Licence activated.')
    await page.getByText('Active', { exact: true }).waitFor()
    await page.getByText(/valid until/).waitFor()
    await page.getByRole('heading', { name: 'Licence' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/03-licence-active.png`, fullPage: true })
  })

  await step('a student of the school is covered by the licence', async () => {
    await institutional(`s1@${W.DOM_A}`)
    await page.goto(`${BASE}/settings`)
    await page.getByText(`Through Test School A ${suffix}’s licence`).waitFor()
    await page.getByText('Pro', { exact: true }).first().waitFor()
  })

  await step('a month before expiry the principal is reminded and sees the warning', async () => {
    await adminSql(`update public.institution_licenses set starts_at = now() - interval '345 days', expires_at = now() + interval '20 days'
                    where institution_id = '${W.instA}' and status = 'active'`)
    await adminSql('select public.send_license_reminders()')
    await institutional(`head@${W.DOM_A}`)
    await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click()
    await page.getByRole('menuitem', { name: /Licence ends in a month/ }).click()
    await page.waitForURL(/\/school\/settings/)
    await page.getByText('Expiring soon', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'The licence ends in 20 days' }).waitFor()
    await page.getByRole('heading', { name: 'Licence' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/03b-expiring.png` })
  })

  await step('platform owner sees and revokes the licence; history records it', async () => {
    await personal(owner)
    await adminTab('Licences')
    await page.getByText(`Test School A ${suffix} · Pro`).waitFor()
    await page.getByRole('button', { name: 'Revoke' }).first().click()
    const d = dialog(`Revoke Test School A ${suffix}’s licence?`)
    await d.getByLabel('Reason').fill('e2e contract ended')
    await d.getByRole('button', { name: 'Revoke' }).click()
    await toast('Licence revoked.')
    await page.getByRole('tab', { name: 'History' }).click()
    await page.getByText('“e2e contract ended”').first().waitFor()
    await page.screenshot({ path: `${SHOTS}/04-history.png`, fullPage: true })
  })

  await step('phone layout: admin codes and settings have no horizontal overflow', async () => {
    await personal(owner, { width: 390, height: 844 })
    await adminTab('Codes')
    await page.getByText(`e2e ${suffix}`).first().waitFor()
    await noOverflow('admin codes')
    await page.goto(`${BASE}/settings`)
    await page.getByRole('button', { name: 'Redeem a code' }).waitFor()
    await noOverflow('settings')
    await page.screenshot({ path: `${SHOTS}/05-phone-settings.png`, fullPage: true })
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser.close()
  await adminSql(`delete from public.license_codes where note = 'e2e ${suffix}' or institution_id in (select id from public.institutions where name like '%${suffix}')`).catch(() => {})
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
