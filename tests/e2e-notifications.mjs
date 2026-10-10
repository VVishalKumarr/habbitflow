// Browser test for Phase 8: notification settings, and real browser push in
// Google Chrome (subscribe → server sends → service worker shows it).
// Needs Google Chrome installed (Playwright channel "chrome"); without it the
// real-push step is reported as skipped.
// Run (dev server on 5173): BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-notifications.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { adminSql, buildSchool, cleanup, PASS, URL as SB } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const SHOTS = 'screenshots/notifications'
mkdirSync(SHOTS, { recursive: true })
const suffix = Date.now().toString(36)

let passed = 0
const failures = []
let page, ctx
async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
    await page?.screenshot({ path: `${SHOTS}/fail-${failures.length}.png`, fullPage: true }).catch(() => {})
  }
}
const errors = []
const toast = (text) => page.getByRole('status').getByText(text).first().waitFor({ timeout: 20000 })
const runSender = async () => {
  const [{ secret }] = await adminSql(`select decrypted_secret secret from vault.decrypted_secrets where name = 'notify_job_secret'`)
  const r = await fetch(`${SB}/functions/v1/notify-deliver`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': secret }, body: '{}' })
  assert.equal(r.status, 200, await r.text())
}

console.log('Notifications e2e')
let browser
try {
  const W = await buildSchool(suffix)
  // Push needs a normal (non-incognito) profile: a throwaway persistent one.
  const profile = mkdtempSync(join(tmpdir(), 'hf-push-'))
  let chrome = true
  try {
    // Headless Chrome never reaches Google's push service, so this runs a normal Chrome window placed off-screen.
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, args: ['--window-position=-32000,-32000'], viewport: { width: 1280, height: 900 } })
  } catch {
    chrome = false
    ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } })
  }
  browser = ctx
  await ctx.grantPermissions(['notifications'], { origin: BASE })
  page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
  await page.goto(`${BASE}/login/institution`)
  await page.getByLabel('Institutional email').fill(`s1@${W.DOM_A}`)
  await page.getByLabel('Password', { exact: true }).fill(PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/school$/, { timeout: 20000 })

  await step('settings: per-kind email and push switches are saved', async () => {
    await page.goto(`${BASE}/settings`)
    await page.getByRole('heading', { name: 'Notifications' }).waitFor()
    await page.getByText(`Sent to s1@${W.DOM_A}`).or(page.getByText('Email isn’t set up on the server yet')).first().waitFor()
    await page.getByLabel('New marks: email').check()
    await page.getByLabel('New marks: push').check()
    await page.waitForTimeout(800)
    const [p] = await adminSql(`select in_app, email, push from public.notification_prefs where user_id = '${W.s1.id}' and kind = 'marks_published'`)
    assert.deepEqual(p, { in_app: true, email: true, push: true })
    await page.screenshot({ path: `${SHOTS}/01-settings.png`, fullPage: true })
  })

  await step(`real browser push (${chrome ? 'Google Chrome' : 'Chromium — may not support push'}): subscribe, send, shown by the service worker`, async () => {
    await page.getByRole('button', { name: 'Turn on push here' }).click()
    await page.getByRole('status').getByText('Push notifications are on for this device.').first().waitFor({ timeout: 60000 })
    const subs = await adminSql(`select kind, endpoint, device_label from public.push_subscriptions where user_id = '${W.s1.id}'`)
    assert.equal(subs.length, 1)
    assert.match(subs[0].endpoint, /^https:\/\//)
    console.log(`    (endpoint host: ${new URL(subs[0].endpoint).host})`)
    await adminSql(`select public.notify('${W.s1.id}', '${W.instA}', 'marks_published', 'Maths marks are out', 'Unit test 1: 38 / 50', '/school/marks', null)`)
    await runSender()
    const [d] = await adminSql(`select d.status, d.reason from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                                 where d.user_id = '${W.s1.id}' and d.channel = 'push' and n.title = 'Maths marks are out'`)
    assert.equal(d.status, 'sent', `push service response: ${JSON.stringify(d)}`)
    // The service worker decrypted it and displayed it.
    const shown = await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      const list = (await reg?.getNotifications()) ?? []
      return list.map((n) => `${n.title} | ${n.body}`)
    }, null, { timeout: 30000, polling: 1000 }).then((h) => h.jsonValue()).catch(() => [])
    assert.deepEqual(shown, ['Maths marks are out | Unit test 1: 38 / 50'], 'notification displayed by the service worker')
    const [email] = await adminSql(`select d.next_attempt_at > now() + interval '5 minutes' later from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                                     where d.user_id = '${W.s1.id}' and d.channel = 'email' and n.title = 'Maths marks are out'`)
    assert.equal(email.later, true, 'email waits; it will be skipped because push arrived')
  })

  await step('recent deliveries are listed; turning push off removes this browser', async () => {
    await page.reload()
    await page.getByText('Recent emails and push').click()
    await page.getByRole('list', { name: 'Recent deliveries' }).getByText(/Push · Sent/).waitFor()
    await page.getByRole('button', { name: 'Turn off here' }).click()
    await toast('Push turned off for this browser.')
    assert.equal((await adminSql(`select count(*)::int n from public.push_subscriptions where user_id = '${W.s1.id}'`))[0].n, 0)
  })

  await step('no unexpected browser errors', async () => {
    assert.deepEqual(errors, [])
  })
} finally {
  await browser?.close()
  if (!process.env.KEEP) await cleanup(suffix)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
