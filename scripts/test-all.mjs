// Runs every test suite and prints a summary.
//   node --env-file=.env scripts/test-all.mjs                 (unit + backend)
//   BASE_URL=http://localhost:5173 node --env-file=.env scripts/test-all.mjs --e2e   (also browser tests; start `npm run dev` first)
// Backend and browser tests run against the real Supabase project and clean up
// after themselves. e2e-notifications opens a Google Chrome window off-screen.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const unit = ['timetable-core.test.mjs', 'study-plan.test.mjs', 'webpush.test.mjs', 'local-db.test.mjs']
const backend = readdirSync('tests').filter((f) => f.endsWith('.test.mjs') && !unit.includes(f)).sort()
const e2e = process.argv.includes('--e2e') ? readdirSync('tests').filter((f) => f.startsWith('e2e') && f.endsWith('.mjs')).sort() : []

const results = []
for (const file of [...unit, ...backend, ...e2e]) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [`tests/${file}`], { encoding: 'utf8', env: process.env, timeout: 20 * 60_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const passed = (out.match(/^\s*✓/gm) ?? []).length
  const failed = (out.match(/^\s*✗/gm) ?? []).length
  const ok = r.status === 0 && failed === 0
  results.push({ file, ok, passed, failed, seconds: Math.round((Date.now() - started) / 1000) })
  console.log(`${ok ? '✓' : '✗'} ${file.padEnd(34)} ${String(passed).padStart(3)} passed ${failed ? `${failed} failed` : ''} (${results.at(-1).seconds}s)`)
  if (!ok) console.log(out.split('\n').filter((l) => /✗|Error|assert/i.test(l)).slice(0, 8).map((l) => `    ${l}`).join('\n'))
}
const total = results.reduce((n, r) => n + r.passed, 0)
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length} suites, ${total} checks passed${bad.length ? `, ${bad.length} suite(s) failed: ${bad.map((r) => r.file).join(', ')}` : ', all green'}`)
if (bad.length) process.exitCode = 1
